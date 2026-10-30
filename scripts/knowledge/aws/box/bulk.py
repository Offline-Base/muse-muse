"""Runs on the collector machine (collector.py): streams the large open files straight into S3, with no local copy.

Lanes run side by side, one file at a time per lane, so Wikimedia sees at most two connections. A file already in the
bucket at the right size is skipped, so a restart carries on. status.json in the bucket says what's done.
"""

import json
import re
import shlex
import subprocess
import sys
import threading
import time
import urllib.request

BUCKET = sys.argv[1]
PREFIX = "knowledge/raw"
USER_AGENT = "MuseMuse-knowledge/0.1 (https://offlinebase.com)"
DUMPS = "https://dumps.wikimedia.org"
INCR_FROM = 20261001
status = {"done": [], "failed": [], "active": {}, "bytes": 0}
lock = threading.Lock()


def fetch(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=120).read().decode("utf8", "replace")


def listing(url):
    """(name, bytes) for each file in an nginx directory listing; sizes are as the listing gives them."""
    out = []
    for m in re.finditer(r'<a href="([^"?/][^"/]*)">[^<]*</a>\s+\S+\s+\S+\s+(\d+)', fetch(url)):
        out.append((m.group(1), int(m.group(2))))
    return out


def subdirs(url):
    return [m.group(1) for m in re.finditer(r'<a href="([^"./][^"/]*)/">', fetch(url))]


def wikimedia_lane():
    files = []
    for wiki in ("enwiki", "wikidatawiki"):
        for day in subdirs(f"{DUMPS}/other/incr/{wiki}/"):
            if day.isdigit() and int(day) >= INCR_FROM:
                for name, size in listing(f"{DUMPS}/other/incr/{wiki}/{day}/"):
                    if "pages-meta-hist-incr" in name:
                        files.append((f"{DUMPS}/other/incr/{wiki}/{day}/{name}", f"wikimedia/incr/{wiki}/{day}/{name}", size))
    return files


def wikimedia_bulk():
    files = []
    base = f"{DUMPS}/other/mediawiki_content_history/enwiki/2026-10-01/xml/7z/"
    files += [(base + n, f"wikimedia/content_history/enwiki/2026-10-01/{n}", s) for n, s in listing(base) if n.endswith(".7z")]
    cirrus = [d for d in subdirs(f"{DUMPS}/other/cirrus_search_index/") if d.isdigit()]
    if cirrus:
        day = max(cirrus)
        base = f"{DUMPS}/other/cirrus_search_index/{day}/index_name=enwiki_content/"
        files += [(base + n, f"wikimedia/cirrus/{day}/enwiki_content/{n}", s) for n, s in listing(base)]
    return files


def single(url, key):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    size = int(urllib.request.urlopen(req, timeout=120).headers.get("Content-Length") or 0)
    return (url, key, size)


def small_lane():
    """Files that aren't split: Wikidata, then a month of edit history per month of the window."""
    files = [single(f"{DUMPS}/wikidatawiki/entities/latest-all.json.bz2", "wikimedia/wikidata/latest-all-20261030.json.bz2")]
    for month in ("2026-09",):
        base = f"{DUMPS}/other/mediawiki_history/{month}/enwiki/"
        files += [(base + n, f"wikimedia/mediawiki_history/{month}/enwiki/{n}", s) for n, s in listing(base)]
    return files


def hf_lane():
    files, url = [], "https://huggingface.co/api/datasets/ruggsea/infini-news-corpus/tree/main?recursive=1&limit=1000"
    while url:
        res = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=120)
        for f in json.load(res):
            if f.get("type") == "file" and "2026" in f["path"]:
                files.append((f"https://huggingface.co/datasets/ruggsea/infini-news-corpus/resolve/main/{f['path']}", f"news/infini-news/{f['path']}", f["size"]))
        link = res.headers.get("Link") or ""
        m = re.search(r'<([^>]+)>;\s*rel="next"', link)
        url = m.group(1) if m else None
    return files


def in_bucket(key):
    r = subprocess.run(["aws", "s3api", "head-object", "--bucket", BUCKET, "--key", f"{PREFIX}/{key}", "--query", "ContentLength", "--output", "text"], capture_output=True, text=True)
    return int(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip().isdigit() else None


def save_status():
    with lock:
        body = json.dumps({**status, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    subprocess.run(["aws", "s3", "cp", "-", f"s3://{BUCKET}/{PREFIX}/status.json"], input=body, text=True, capture_output=True)


def lane(name, build):
    try:
        files = build()
    except Exception as err:
        with lock:
            status["failed"].append({"lane": name, "error": str(err)[:300]})
        save_status()
        return
    for url, key, size in files:
        have = in_bucket(key)
        if have is not None and (not size or have == size):
            with lock:
                status["done"].append(key)
                status["bytes"] += have
            continue
        with lock:
            status["active"][name] = key
        save_status()
        cmd = f"set -o pipefail; curl -sSfL --retry 5 --retry-delay 20 -A {shlex.quote(USER_AGENT)} {shlex.quote(url)} | aws s3 cp - {shlex.quote(f's3://{BUCKET}/{PREFIX}/{key}')} --expected-size {max(size, 1)} --storage-class STANDARD_IA"
        r = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True)
        with lock:
            if r.returncode == 0:
                status["done"].append(key)
                status["bytes"] += size
            else:
                status["failed"].append({"key": key, "error": r.stderr[-300:]})
            status["active"].pop(name, None)
        save_status()


threads = [threading.Thread(target=lane, args=a) for a in (("incr", wikimedia_lane), ("wikimedia", lambda: small_lane() + wikimedia_bulk()), ("news", hf_lane))]
for t in threads:
    t.start()
for t in threads:
    t.join()
save_status()
print("bulk done", len(status["done"]), "failed", len(status["failed"]))
