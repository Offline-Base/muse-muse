"""After the CC-NEWS extraction: fetches robots.txt once for every domain seen, plus /.well-known/tdmrep.json, and writes
a table of which domains opt out of AI training to knowledge/news/ccnews-optout/domains.parquet.

    python3 ccnews_optout.py BUCKET [--deadline EPOCH] [--limit N]

Excluded domains must not reach training. `excluded` fails closed: a whole-site block of a named crawler, ai-train=no,
train-ai=n, a declared RSL license, a TDMRep reservation, or a robots.txt we could not read (RFC 9309 treats a server
error as a full disallow; a 401 or 403 is treated as a block too). `excluded_reasons` says which, so a review can relax
any of them. A partial block is not an exclusion: `partial_block_agents` names the agents and `robots_txt` keeps the
text, so the page-level test can run later. Progress is saved in parts, so a re-run carries on.
"""

import argparse
import collections
import concurrent.futures
import json
import os
import random
import re
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request

import boto3
import botocore.config
import botocore.exceptions
import pyarrow as pa
import pyarrow.fs
import pyarrow.parquet as pq

ARTICLES = "knowledge/news/ccnews"
OUT = "knowledge/news/ccnews-optout"
USER_AGENT = "MuseMuse-knowledge/0.1 (https://offlinebase.com)"
AGENTS = ["CCBot", "GPTBot", "Google-Extended", "ClaudeBot", "Applebot-Extended", "Meta-ExternalAgent", "Bytespider"]
MAX_BYTES = 512 * 1024
TIMEOUT = 15
THREADS = 200
PART_SIZE = 5000
SHORT_SECOND_LEVEL = {"co", "com", "org", "net", "ac", "gov", "edu", "ne", "or", "go"}
CLIENT = botocore.config.Config(region_name="us-east-1", retries={"mode": "standard", "max_attempts": 6}, max_pool_connections=64)
TLS = ssl.create_default_context()
HERE = os.path.dirname(os.path.abspath(__file__))

columns = [("domain", pa.string()), ("articles", pa.int64()), ("robots_url", pa.string()), ("robots_status", pa.int32()), ("robots_error", pa.string())]
columns += [(f"blocks_{a.lower().replace('-', '_')}", pa.bool_()) for a in AGENTS]
columns += [("partial_block_agents", pa.string()), ("content_signal_no", pa.bool_()), ("content_usage_no", pa.bool_()), ("rsl_license", pa.string()),
            ("tdmrep_status", pa.int32()), ("tdmrep_reserved", pa.bool_()), ("excluded", pa.bool_()), ("excluded_reasons", pa.string()), ("robots_txt", pa.string()), ("fetched_at", pa.string())]
SCHEMA = pa.schema(columns)


def get(url):
    """(status, text, error). Status is None when the server could not be reached at all."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/plain,application/json,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=TLS) as r:
            return r.status, r.read(MAX_BYTES).decode("utf8", "replace"), None
    except urllib.error.HTTPError as err:
        return err.code, "", None
    except (urllib.error.URLError, socket.timeout, TimeoutError, OSError, ValueError, Exception) as err:
        return None, "", repr(err)[:200]


def parse_robots(text):
    """Groups of (agents, rules), plus every Content-Signal, Content-Usage and License line anywhere in the file."""
    groups, agents, rules, extras = [], [], [], collections.defaultdict(list)
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key, value = key.strip().lower(), value.strip()
        if key == "user-agent":
            if rules:
                groups.append((agents, rules))
                agents, rules = [], []
            agents.append(value.lower())
        elif key in ("allow", "disallow"):
            rules.append((key, value))
        elif key in ("content-signal", "content-usage", "license"):
            extras[key].append(value)
    if agents:
        groups.append((agents, rules))
    return groups, extras


def verdict(groups, agent):
    """('whole', 'partial' or None) for this agent. Named groups win over the wildcard, as RFC 9309 says."""
    name = agent.lower()
    named = [r for a, rules in groups if name in a for r in rules]
    rules = named or [r for a, rules in groups if "*" in a for r in rules]
    disallow = [v for k, v in rules if k == "disallow" and v]
    allow_all = any(k == "allow" and v in ("/", "/*") for k, v in rules)
    if any(v in ("/", "/*") for v in disallow) and not allow_all:
        return "whole"
    return "partial" if disallow else None


def tdm_reserved(text):
    try:
        rules = json.loads(text)
    except ValueError:
        return False
    rules = rules if isinstance(rules, list) else [rules]
    return any(isinstance(r, dict) and str(r.get("tdm-reservation")) == "1" for r in rules)


def check(domain, articles):
    row = {"domain": domain, "articles": articles, "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    url = f"https://{domain}/robots.txt"
    status, text, error = get(url)
    if status is None:
        url = f"http://{domain}/robots.txt"
        status, text, error = get(url)
    row.update(robots_url=url, robots_status=status, robots_error=error, robots_txt=text if status == 200 else None)
    reasons, partial = [], []
    groups, extras = parse_robots(text) if status == 200 else ([], {})
    for agent in AGENTS:
        v = verdict(groups, agent)
        row[f"blocks_{agent.lower().replace('-', '_')}"] = v == "whole"
        if v == "whole":
            reasons.append(f"robots:{agent}")
        elif v == "partial" and any(agent.lower() in a for a, _ in groups):
            partial.append(agent)
    row["partial_block_agents"] = ",".join(partial) or None
    row["content_signal_no"] = any(re.search(r"ai-train\s*=\s*no\b", v, re.I) for v in extras.get("content-signal", []))
    row["content_usage_no"] = any(re.search(r"train-ai\s*=\s*n\b", v, re.I) for v in extras.get("content-usage", []))
    row["rsl_license"] = next(iter(extras.get("license", [])), None)
    if row["content_signal_no"]:
        reasons.append("content-signal")
    if row["content_usage_no"]:
        reasons.append("content-usage")
    if row["rsl_license"]:
        reasons.append("rsl")
    if status is None or status >= 500:
        reasons.append("robots-unreachable")
    elif status in (401, 403):
        reasons.append("robots-forbidden")
    tdm_status, tdm_text, _ = get(f"https://{domain}/.well-known/tdmrep.json")
    row["tdmrep_status"], row["tdmrep_reserved"] = tdm_status, tdm_status == 200 and tdm_reserved(tdm_text)
    if row["tdmrep_reserved"]:
        reasons.append("tdmrep")
    row["excluded"], row["excluded_reasons"] = bool(reasons), ",".join(reasons) or None
    return row


def parent(domain):
    parts = domain.split(".")
    keep = 3 if len(parts) >= 3 and parts[-2] in SHORT_SECOND_LEVEL else 2
    return ".".join(parts[-keep:])


def list_keys(s3, bucket, prefix):
    keys = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        keys += [o["Key"] for o in page.get("Contents", [])]
    return keys


def domain_counts(s3, bucket):
    """Reads only the domain column from each month's Parquet files."""
    keys = [k for k in list_keys(s3, bucket, f"{ARTICLES}/2026-") if k.endswith(".parquet")]
    fs = pyarrow.fs.S3FileSystem(region="us-east-1")

    def one(key):
        with fs.open_input_file(f"{bucket}/{key}") as f:
            return collections.Counter(pq.ParquetFile(f).read(columns=["domain"]).column("domain").to_pylist())

    total = collections.Counter()
    with concurrent.futures.ThreadPoolExecutor(32) as pool:
        for c in pool.map(one, keys):
            total.update(c)
    print(len(keys), "article files,", len(total), "domains", flush=True)
    return total


def main():
    p = argparse.ArgumentParser()
    p.add_argument("bucket")
    p.add_argument("--deadline", type=float, default=time.time() + 6 * 3600)
    p.add_argument("--limit", type=int)
    p.add_argument("--out", default=OUT)
    a = p.parse_args()
    s3 = boto3.client("s3", config=CLIENT)
    socket.setdefaulttimeout(TIMEOUT)
    counts = domain_counts(s3, a.bucket)
    fs = pyarrow.fs.S3FileSystem(region="us-east-1")
    part_keys = [k for k in list_keys(s3, a.bucket, f"{a.out}/parts/") if k.endswith(".parquet")]
    seen = set()
    for key in part_keys:
        with fs.open_input_file(f"{a.bucket}/{key}") as f:
            seen.update(pq.ParquetFile(f).read(columns=["domain"]).column("domain").to_pylist())
    todo = [d for d in counts if d not in seen]
    random.shuffle(todo)
    if a.limit:
        todo = todo[:a.limit]
    # Sites sharing a parent domain (subdomains of one host) go one at a time, so no host gets a burst.
    by_parent = collections.defaultdict(list)
    for d in todo:
        by_parent[parent(d)].append(d)
    print(len(todo), "domains to check,", len(seen), "already done,", len(by_parent), "parents", flush=True)

    rows, lock = [], threading.Lock()
    part = [len(part_keys)]

    def flush(force=False):
        with lock:
            if not rows or (len(rows) < PART_SIZE and not force):
                return
            batch = rows[:]
            rows.clear()
            n = part[0]
            part[0] += 1
        path = f"{HERE}/optout-{n}.parquet"
        pq.write_table(pa.Table.from_pylist(batch, schema=SCHEMA), path, compression="zstd")
        s3.upload_file(path, a.bucket, f"{a.out}/parts/part-{n:05d}.parquet")
        os.remove(path)
        print(time.strftime("%H:%M:%S"), "saved part", n, flush=True)

    def work(group):
        for domain in group:
            if time.time() > a.deadline - 600:
                return
            row = check(domain, counts[domain])
            with lock:
                rows.append(row)
            flush()

    with concurrent.futures.ThreadPoolExecutor(THREADS) as pool:
        list(pool.map(work, by_parent.values()))
    flush(True)
    if a.limit or time.time() > a.deadline - 600:
        print("stopped before the end: no final table written")
        return

    part_keys = [k for k in list_keys(s3, a.bucket, f"{a.out}/parts/") if k.endswith(".parquet")]
    tables = []
    for key in part_keys:
        with fs.open_input_file(f"{a.bucket}/{key}") as f:
            tables.append(pq.ParquetFile(f).read())
    table = pa.concat_tables(tables).sort_by("domain")
    pq.write_table(table, f"{HERE}/domains.parquet", compression="zstd")
    s3.upload_file(f"{HERE}/domains.parquet", a.bucket, f"{a.out}/domains.parquet")
    summary = {"domains": table.num_rows, "excluded": table.column("excluded").to_pylist().count(True), "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    s3.put_object(Bucket=a.bucket, Key=f"{a.out}/_SUCCESS", Body=json.dumps(summary).encode())
    print("finished", summary, flush=True)


if __name__ == "__main__":
    main()
