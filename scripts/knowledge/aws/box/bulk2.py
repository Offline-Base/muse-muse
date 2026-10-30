"""Runs on the collector machine beside bulk.py: mirrors the remaining open bulk datasets into S3, with no connection to
dumps.wikimedia.org (pageviews and clickstream come from the your.org mirror that Wikimedia lists).

    python3 bulk2.py <bucket> --plan                    sizes and dates only, nothing copied
    python3 bulk2.py <bucket> --only cisa-kev,gdelt --limit 1    a small sample
    python3 bulk2.py <bucket>                           everything

One file at a time per host. Files of known size stream straight to S3 and are checked against that size afterwards. Files
of unknown size go through local disk, so a broken download never lands in the bucket and "already there" can be trusted.
A restart skips what's done. Progress is in knowledge/raw/status2.json, and each dataset has a MANIFEST.json.
"""

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser

PREFIX = "knowledge/raw"
USER_AGENT = "MuseMuse-knowledge/0.1 (https://offlinebase.com)"
AI_CRAWLERS = ("GPTBot", "CCBot", "ClaudeBot", "Google-Extended", "Meta-ExternalAgent", "Bytespider")
TMP = "/opt/muse/tmp2"
TODAY = time.strftime("%Y%m%d", time.gmtime())
WINDOW = ("20260104", "20261029")
DATASET_LIMIT = 200e9
GKG_LIMIT = 500e9
MIRROR = "https://dumps.wikimedia.your.org"
FISCAL = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service"

NOT_RUN = {
    "cftc": "www.cftc.gov robots.txt sets Content-Signal ai-train=no as a condition of access. Files exist (deacot2026.zip and others). Owner decides; the Public Reporting API was not used as a way around it.",
    "usaspending": "The D&B limitation says users shall not access D&B Open Data (business name, address) in bulk and bars systematic harvesting; the monthly archive carries those columns. Owner decides.",
    "legiscan": "Needs an account.",
    "google-patents": "BigQuery only.",
    "common-corpus": "Report only, per the task.",
}

status = {"started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "planned": {}, "done": 0, "already": 0, "bytes": 0, "active": {}, "failed": [], "skipped": [{"dataset": k, "reason": v} for k, v in NOT_RUN.items()], "blocked": {}, "gdelt": {}, "finished": False}
lock = threading.Lock()
slots = threading.Semaphore(6)
saved_at = [0]
robots = {}


def fetch(url, headers=None):
    time.sleep(1)
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})}), timeout=180)


def text(url, headers=None):
    return fetch(url, headers).read().decode("utf8", "replace")


def head(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    return int(urllib.request.urlopen(req, timeout=120).headers.get("Content-Length") or 0)


def file(url, key, size=0, **extra):
    return {"url": url, "key": key, "size": size, **extra}


def sized(url, key):
    return file(url, key, head(url))


def refused(url):
    """Why this site asks us not to fetch this URL, or None. Takes the strictest answer across the AI-training crawlers."""
    parts = urllib.parse.urlsplit(url)
    host = parts.netloc
    if host not in robots:
        try:
            robots[host] = text(f"https://{host}/robots.txt")
        except Exception:
            robots[host] = ""
    body = robots[host]
    if re.search(r"content-signal:[^\n]*ai-train=no", body, re.I):
        return "robots.txt Content-Signal ai-train=no"
    rp = urllib.robotparser.RobotFileParser()
    rp.parse(body.splitlines())
    path = parts.path + (f"?{parts.query}" if parts.query else "")
    for agent in (USER_AGENT,) + AI_CRAWLERS:
        if not rp.can_fetch(agent, path):
            return f"robots.txt disallows {agent}"
    return None


def openstates():
    return [sized("https://data.openstates.org/postgres/monthly/2026-10-public.pgdump", "openstates/2026-10-public.pgdump")]


def musicbrainz():
    base = "https://data.metabrainz.org/pub/musicbrainz/data/json-dumps/"
    latest = text(base + "LATEST").strip()
    names = re.findall(r'href="([^"]+\.tar\.xz)"', text(f"{base}{latest}/")) + ["SHA256SUMS"]
    return [sized(f"{base}{latest}/{n}", f"musicbrainz/{latest}/{n}") for n in names]


def discogs():
    stamp = "discogs_20261001"
    get = lambda n: f"https://data.discogs.com/?download=data%2F2026%2F{n}"
    sums = {name: digest for digest, name in re.findall(r"^(\w{64})\s+(\S+)$", text(get(f"{stamp}_CHECKSUM.txt")), re.M)}
    return [file(get(f"{stamp}_CHECKSUM.txt"), f"discogs/{stamp}/{stamp}_CHECKSUM.txt")] + [file(get(n), f"discogs/{stamp}/{n}", sha256=d) for n, d in sums.items()]


def openlibrary():
    base = "https://archive.org/download/ol_dump_2026-09-30/"
    return [sized(base + n, f"openlibrary/2026-09-30/{n}") for n in ("ol_dump_editions_2026-09-30.txt.gz", "ol_dump_works_2026-09-30.txt.gz")]


def kaikki():
    return [sized("https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz", "kaikki/raw-wiktextract-data.jsonl.gz")]


def mirror_names(url):
    return re.findall(r'title="([^"]+)">[^<]+</a></td><td class="size">', text(url))


def pageviews():
    files = []
    for month in range(1, 11):
        base = f"{MIRROR}/other/pageview_complete/monthly/2026/2026-{month:02d}/"
        try:
            names = mirror_names(base)
        except urllib.error.HTTPError:
            continue
        files += [sized(base + n, f"pageviews/2026-{month:02d}/{n}") for n in names if n.endswith(".bz2")]
    return files


def clickstream():
    files = []
    for month in range(1, 10):
        base = f"{MIRROR}/other/clickstream/2026-{month:02d}/"
        files += [sized(base + n, f"clickstream/2026-{month:02d}/{n}") for n in mirror_names(base) if n.endswith(".gz")]
    return files


def gleif():
    data = json.load(fetch("https://goldencopy.gleif.org/api/v2/golden-copies/publishes/latest"))["data"]
    day = data["publish_date"][:10]
    return [file(data[t]["full_file"]["csv"]["url"], f"gleif/{day}/{data[t]['full_file']['csv']['url'].rsplit('/', 1)[1]}", data[t]["full_file"]["csv"]["size"]) for t in ("lei2", "rr")]


def osv():
    return [file("https://osv-vulnerabilities.storage.googleapis.com/all.zip", f"osv/all-{TODAY}.zip")]


def zipball(repo, name):
    return file(f"https://api.github.com/repos/{repo}/zipball", f"{name}/{repo.replace('/', '-')}-{TODAY}.zip")


def github_advisories():
    return [zipball("github/advisory-database", "github-advisories")]


def cvelist():
    return [zipball("CVEProject/cvelistV5", "cvelist")]


def cisa_kev():
    return [file("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", f"cisa-kev/known_exploited_vulnerabilities-{TODAY}.json")]


def openfootball():
    return [zipball("openfootball/worldcup.json", "openfootball"), zipball("openfootball/football.json", "openfootball")]


def cricsheet():
    return [sized("https://cricsheet.org/downloads/all_json.zip", f"cricsheet/all_json-{TODAY}.zip")]


def nflverse():
    assets = json.load(fetch("https://api.github.com/repos/nflverse/nflverse-data/releases/tags/pbp"))["assets"]
    return [file(a["url"], f"nflverse/{a['name']}", a["size"], headers=["Accept: application/octet-stream"]) for a in assets if a["name"] in ("play_by_play_2026.parquet", "play_by_play_2025.parquet")]


def retrosheet():
    return [sized("https://www.retrosheet.org/downloads/alldata.zip", "retrosheet/alldata.zip"), sized("https://www.retrosheet.org/events/2025eve.zip", "retrosheet/2025eve.zip")]


def nass():
    names = set(re.findall(r'href="/datasets/(qs\.[a-z_]+_\d{8}\.txt\.gz)"', text("https://www.nass.usda.gov/datasets/")))
    return [sized(f"https://www.nass.usda.gov/datasets/{n}", f"nass/{n}") for n in sorted(names)]


def bts():
    files = []
    for month in range(1, 11):
        name = f"On_Time_Reporting_Carrier_On_Time_Performance_1987_present_2026_{month}.zip"
        try:
            files.append(sized(f"https://www.transtats.bts.gov/PREZIP/{name}", f"bts-ontime/{name}"))
        except urllib.error.HTTPError as err:
            if err.code != 404:
                raise
    return files


def treasury():
    files = []
    for kind in ("daily_treasury_yield_curve", "daily_treasury_real_yield_curve", "daily_treasury_bill_rates", "daily_treasury_long_term_rate", "daily_treasury_real_long_term"):
        files.append(file(f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type={kind}&field_tdr_date_value=2026&page&_format=csv", f"treasury/rates/{kind}-2026-{TODAY}.csv"))
    for series in ("v2/accounting/od/debt_to_penny", "v2/accounting/od/avg_interest_rates", "v1/accounting/dts/operating_cash_balance", "v1/accounting/dts/deposits_withdrawals_operating_cash", "v1/accounting/od/auctions_query", "v1/accounting/od/rates_of_exchange", "v1/accounting/mts/mts_table_5"):
        query = f"{FISCAL}/{series}?filter=record_date:gte:2026-01-01"
        count = json.load(fetch(f"{query}&page[size]=1"))["meta"]["total-count"]
        for page in range(1, count // 10000 + 2):
            files.append(file(f"{query}&format=csv&page[size]=10000&page[number]={page}", f"treasury/fiscal/{series.rsplit('/', 1)[1]}/{TODAY}-page-{page}.csv"))
    return files


def worldbank():
    page = text("https://www.worldbank.org/en/research/commodity-markets")
    urls = set(re.findall(r'href="(https://thedocs\.worldbank\.org/[^"]*(?:CMO-Historical-Data-(?:Monthly|Annual)\.xlsx|CMO-Pink-Sheet-[^"]*\.pdf))"', page))
    if not urls:
        raise RuntimeError("no Pink Sheet links on the commodity markets page")
    return [file(u, f"worldbank-pinksheet/{TODAY}/{u.rsplit('/', 1)[1]}") for u in sorted(urls)]


def hf_tree(repo, path):
    files, url = [], f"https://huggingface.co/api/datasets/{repo}/tree/main/{path}?recursive=1&limit=1000"
    while url:
        res = fetch(url)
        files += [f for f in json.load(res) if f.get("type") == "file"]
        m = re.search(r'<([^>]+)>;\s*rel="next"', res.headers.get("Link") or "")
        url = m.group(1) if m else None
    return files


def hf(repo, name, paths):
    files = [file(f"https://huggingface.co/datasets/{repo}/resolve/main/README.md", f"{name}/README.md")] if paths != [""] else []
    for path in paths:
        try:
            tree = hf_tree(repo, path)
        except urllib.error.HTTPError as err:
            if err.code != 404:
                raise
            continue
        files += [file(f"https://huggingface.co/datasets/{repo}/resolve/main/{urllib.parse.quote(f['path'])}", f"{name}/{f['path']}", f["size"]) for f in tree if f["path"] != ".gitattributes"]
    return files


def epoch():
    names = set(re.findall(r'href="(/data/[^"]+\.(?:zip|csv|csv\.gz))"', text("https://epoch.ai/data/")))
    return [file(f"https://epoch.ai{n}", f"epoch/{TODAY}{n[5:]}") for n in sorted(names)]


def models_dev():
    return [file("https://models.dev/api.json", f"models-dev/api-{TODAY}.json")]


def homebrew():
    return [file("https://formulae.brew.sh/api/formula.json", f"homebrew/formula-{TODAY}.json")]


def so_survey():
    base = "https://media.githubusercontent.com/media/StackExchange/Survey/refs/heads/main/packages/archive/2026/"
    return [sized(base + n, f"stackoverflow-survey/2026/{n}") for n in ("survey_results_public.csv", "survey_results_schema.csv")]


def nobel():
    return [file("https://api.nobelprize.org/2.1/nobelPrizes?limit=1000", f"nobel/nobelPrizes-{TODAY}.json"), file("https://api.nobelprize.org/2.1/laureates?limit=2000", f"nobel/laureates-{TODAY}.json")]


def months(fmt, last):
    return [fmt.format(m) for m in range(1, last + 1)]


DATASETS = [
    ("openstates", openstates, "Public domain dedication (Open States)", "https://open.pluralpolicy.com/data/", ""),
    ("musicbrainz", musicbrainz, "CC0 for core data; supplementary data CC BY-NC-SA 3.0", "https://musicbrainz.org/doc/About/Data_License", "JSON entities embed annotation, tags, genres and ratings, which the licence page puts outside CC0: strip them before anything is published. MetaBrainz asks companies with revenue to pick a paid support tier."),
    ("discogs", discogs, "CC0", "https://data.discogs.com/", ""),
    ("openlibrary", openlibrary, "No license declared. Internet Archive asserts no new rights and warns of possible existing rights.", "https://openlibrary.org/developers/licensing", "Not CC0. Bibliographic facts are low risk; free-text fields such as descriptions need care."),
    ("kaikki", kaikki, "CC BY-SA 4.0 and GFDL (Wiktionary)", "https://kaikki.org/dictionary/rawdata.html", "English Wiktionary edition, extracted by wiktextract."),
    ("pageviews", pageviews, "CC0", "https://dumps.wikimedia.org/other/pageview_complete/", "Copied from the your.org mirror. 2026-10 isn't published until after the month ends."),
    ("clickstream", clickstream, "CC0", "https://dumps.wikimedia.org/other/clickstream/", "Copied from the your.org mirror."),
    ("gleif", gleif, "CC0", "https://www.gleif.org/en/lei-data/gleif-golden-copy", "LEI2 and RR full files, CSV."),
    ("osv", osv, "Per source; Chainguard and Wolfi records are CC BY-NC-ND", "https://google.github.io/osv.dev/data/", "Drop Chainguard and Wolfi records from anything published."),
    ("github-advisories", github_advisories, "CC BY 4.0", "https://github.com/github/advisory-database", "Repository archive through the GitHub API."),
    ("cvelist", cvelist, "CVE Program terms of use", "https://github.com/CVEProject/cvelistV5", "Repository archive through the GitHub API."),
    ("cisa-kev", cisa_kev, "CC0 (CISA catalog); license not rechecked in this run", "https://www.cisa.gov/known-exploited-vulnerabilities-catalog", ""),
    ("openfootball", openfootball, "CC0", "https://github.com/openfootball", "Repository archives through the GitHub API."),
    ("cricsheet", cricsheet, "ODC-BY", "https://cricsheet.org/register/", "Attribution required."),
    ("nflverse", nflverse, "CC BY 4.0; data originates with the NFL", "https://github.com/nflverse/nflverse-data", "Release assets through the GitHub API, since github.com's robots.txt points automated clients there."),
    ("retrosheet", retrosheet, "Any use with Retrosheet's credit line", "https://www.retrosheet.org/notice.txt", "Latest season is 2025; 2026 isn't out."),
    ("nass", nass, "Public domain, with a credit request", "https://www.nass.usda.gov/Data_and_Statistics/Citation_Request/index.php", "Required notice: This product uses the NASS API but is not endorsed or certified by NASS."),
    ("bts-ontime", bts, "Public domain", "https://www.transtats.bts.gov/", "Months that exist so far."),
    ("treasury", treasury, "Public domain (US government)", "https://fiscaldata.treasury.gov/", "Records from 2026-01-01 on. Fiscal Data CSVs are paged at 10,000 rows."),
    ("worldbank-pinksheet", worldbank, "CC BY 4.0 by the Data Catalog default; own record unverified", "https://www.worldbank.org/en/research/commodity-markets", "Credits third parties (Bloomberg, S&P Global, Urner Barry) and pages are stamped Official Use Only. General World Bank terms are non-commercial outside the Data Catalog."),
    ("forecastbench", lambda: hf("forecastingresearch/forecastbench-datasets", "forecastbench", [""]), "CC BY-SA 4.0", "https://huggingface.co/datasets/forecastingresearch/forecastbench-datasets", "Evaluation only. Rows come from Metaculus, FRED and others that bar AI training: drop them before any use, and use only resolved outcomes as facts."),
    ("lmarena", lambda: hf("lmarena-ai/leaderboard-dataset", "lmarena", [""]), "CC BY 4.0", "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset", ""),
    ("epoch", epoch, "CC BY (credit source and authors)", "https://epoch.ai/data/", "Citations are on each dataset's page."),
    ("models-dev", models_dev, "MIT", "https://models.dev/", ""),
    ("homebrew", homebrew, "BSD-2-Clause", "https://formulae.brew.sh/", ""),
    ("stackoverflow-survey", so_survey, "ODbL 1.0 (data), DbCL 1.0 (contents)", "https://survey.stackoverflow.co/", "Share-alike. Separate from the Stack Exchange dumps, which stay out."),
    ("nobel", nobel, "CC0 metadata", "https://www.nobelprize.org/about/terms-of-use-for-api-nobelprize-org-and-data-nobelprize-org/", ""),
    ("fine-news", lambda: hf("ksolovev/fine-news", "fine-news", months("data/2026-{:02d}", 10)), "No license stated; article text belongs to publishers", "https://huggingface.co/datasets/ksolovev/fine-news", "Private, training only. 2026 partitions only."),
    ("ccnews-plus", lambda: hf("AbedGarra/ccnews2024plus", "ccnews-plus", months("2026_{:02d}", 10)), "No license stated; article text belongs to publishers", "https://huggingface.co/datasets/AbedGarra/ccnews2024plus", "Private, training only. 2026 monthly sets only."),
    ("forecast-news", lambda: hf("shash42/forecast-news", "forecast-news", ["2026"]), "Tagged Apache-2.0; article text belongs to publishers", "https://huggingface.co/datasets/shash42/forecast-news", "Private, training only. 2026 only."),
]
LICENSE_GDELT = "Free to use and redistribute, citing GDELT with a link to https://www.gdeltproject.org/"


def aws(*args, stdin=None):
    return subprocess.run(["aws", *args], input=stdin, capture_output=True, text=True)


def in_bucket(bucket, key):
    r = aws("s3api", "head-object", "--bucket", bucket, "--key", f"{PREFIX}/{key}", "--query", "ContentLength", "--output", "text")
    return int(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip().isdigit() else None


def put_json(bucket, key, data):
    aws("s3", "cp", "-", f"s3://{bucket}/{PREFIX}/{key}", stdin=json.dumps(data, indent=1))


def save_status(bucket, force=False):
    with lock:
        if not force and time.time() - saved_at[0] < 15:
            return
        saved_at[0] = time.time()
        body = {**status, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    put_json(bucket, "status2.json", body)


def curl_error(stderr):
    m = re.search(r"error: (\d{3})", stderr)
    return int(m.group(1)) if m else 0


def curl_args(f):
    args = f"curl -gsSfL --connect-timeout 30 --speed-limit 4096 --speed-time 300 -A {shlex.quote(USER_AGENT)}"
    for h in f.get("headers", []):
        args += f" -H {shlex.quote(h)}"
    return f"{args} {shlex.quote(f['url'])}"


def stream(bucket, f):
    """No curl --retry: a retry after partial output would append to the pipe. A failed try is redone from the start here."""
    dest = shlex.quote(f"s3://{bucket}/{PREFIX}/{f['key']}")
    r = subprocess.run(["bash", "-c", f"set -o pipefail; {curl_args(f)} | aws s3 cp - {dest} --expected-size {f['size']} --storage-class STANDARD_IA"], capture_output=True, text=True)
    if r.returncode:
        return r.stderr[-300:]
    have = in_bucket(bucket, f["key"])
    return None if have == f["size"] else f"size {have}, expected {f['size']}"


def through_disk(bucket, f):
    path = os.path.join(TMP, hashlib.sha1(f["key"].encode()).hexdigest())
    try:
        r = subprocess.run(["bash", "-c", f"{curl_args(f)} -o {shlex.quote(path)}"], capture_output=True, text=True)
        if r.returncode:
            return r.stderr[-300:]
        with open(path, "rb") as fh:
            start = fh.read(300).lower()
        if b"<html" in start or b"<!doctype" in start:
            return "got an HTML page instead of the file"
        if f.get("sha256"):
            digest = subprocess.run(["sha256sum", path], capture_output=True, text=True).stdout.split()[0]
            if digest != f["sha256"]:
                return f"sha256 {digest}, expected {f['sha256']}"
        f["size"] = os.path.getsize(path)
        r = aws("s3", "cp", path, f"s3://{bucket}/{PREFIX}/{f['key']}", "--storage-class", "STANDARD_IA", "--only-show-errors")
        return r.stderr[-300:] if r.returncode else None
    finally:
        if os.path.exists(path):
            os.remove(path)


def transfer(bucket, f, host):
    """True to carry on with this host, False when the host has refused us."""
    have = in_bucket(bucket, f["key"])
    if have is not None and (not f["size"] or have == f["size"]):
        f["state"], f["size"] = "already", have
        with lock:
            status["already"] += 1
            status["bytes"] += have
        return True
    error = None
    for attempt in range(3):
        with slots:
            with lock:
                status["active"][host] = f["key"]
            save_status(bucket)
            error = stream(bucket, f) if f["size"] else through_disk(bucket, f)
            with lock:
                status["active"].pop(host, None)
        if error is None:
            f["state"] = "done"
            with lock:
                status["done"] += 1
                status["bytes"] += f["size"]
            save_status(bucket)
            return True
        code = curl_error(error)
        if code in (401, 403):
            f["state"] = "failed"
            with lock:
                status["blocked"][host] = {"code": code, "key": f["key"]}
                status["failed"].append({"key": f["key"], "error": error})
            return False
        if code == 404:
            break
        time.sleep((300 if code == 429 else 60) * (attempt + 1))
    f["state"] = "failed"
    with lock:
        status["failed"].append({"key": f["key"], "error": error})
    save_status(bucket)
    return True


def host_lane(bucket, host, files):
    for f in files:
        if not transfer(bucket, f, host):
            with lock:
                status["skipped"].append({"host": host, "reason": "host refused us; rest of its files skipped", "files": sum(1 for x in files if "state" not in x)})
            break


def gdelt_plan(limit):
    """Rows from GDELT 2.0's own file lists (size, md5, url), kept to the window. GKG only if under the limit."""
    rows = []
    for name in ("masterfilelist.txt", "masterfilelist-translation.txt"):
        for line in text(f"http://data.gdeltproject.org/gdeltv2/{name}").splitlines():
            parts = line.split()
            if len(parts) != 3 or not parts[0].isdigit():
                continue
            base = parts[2].rsplit("/", 1)[1]
            day = base[:8]
            if not day.isdigit() or not WINDOW[0] <= day <= WINDOW[1]:
                continue
            kind = next((k for k in ("export", "mentions", "gkg") if f".{k}." in base), None)
            if kind:
                rows.append({"size": int(parts[0]), "md5": parts[1], "url": parts[2], "name": base, "day": day, "kind": kind, "lang": "translation" if ".translation." in base else "english"})
    totals = {}
    for r in rows:
        k = f"{r['lang']}-{r['kind']}"
        totals[k] = totals.get(k, 0) + r["size"]
    gkg = totals.get("english-gkg", 0) + totals.get("translation-gkg", 0)
    english_gkg = totals.get("english-gkg", 0)
    keep = "all" if gkg < GKG_LIMIT else "english" if english_gkg < GKG_LIMIT else "none"
    rows = [r for r in rows if r["kind"] != "gkg" or keep == "all" or (keep == "english" and r["lang"] == "english")]
    days = sorted({r["day"] for r in rows})
    if limit:
        days = days[:limit]
        rows = [r for r in rows if r["day"] in days]
    return rows, days, {"totalsGB": {k: round(v / 1e9, 1) for k, v in sorted(totals.items())}, "gkgKept": keep, "files": len(rows), "days": len(days), "gb": round(sum(r["size"] for r in rows) / 1e9, 1)}


def bucket_day(bucket, day):
    r = aws("s3api", "list-objects-v2", "--bucket", bucket, "--prefix", f"{PREFIX}/gdelt/v2/{day}/", "--query", "Contents[].[Key,Size]", "--output", "json")
    return {k.rsplit("/", 1)[1]: s for k, s in (json.loads(r.stdout or "null") or [])}


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def gdelt_day(bucket, day, rows):
    """A day's missing files through one curl connection, checked against GDELT's md5s, then up to S3. Returns (got, missing names)."""
    have = bucket_day(bucket, day)
    want = [r for r in rows if have.get(r["name"]) != r["size"]]
    if not want:
        return 0, []
    folder = os.path.join(TMP, "gdelt", day)
    os.makedirs(folder, exist_ok=True)
    good = []
    try:
        for _ in range(2):
            todo = [r for r in want if r not in good]
            if not todo:
                break
            conf = os.path.join(TMP, "gdelt", f"{day}.conf")
            with open(conf, "w") as fh:
                for r in todo:
                    fh.write(f'url = "{r["url"]}"\noutput = "{os.path.join(folder, r["name"])}"\n')
            subprocess.run(["curl", "-gsSfL", "--connect-timeout", "30", "--speed-limit", "4096", "--speed-time", "120", "--retry", "2", "--retry-delay", "10", "-A", USER_AGENT, "-K", conf], capture_output=True, text=True)
            for r in todo:
                path = os.path.join(folder, r["name"])
                if os.path.exists(path):
                    if md5_of(path) == r["md5"]:
                        good.append(r)
                    else:
                        os.remove(path)
        if good:
            r = aws("s3", "cp", folder, f"s3://{bucket}/{PREFIX}/gdelt/v2/{day}/", "--recursive", "--storage-class", "STANDARD_IA", "--only-show-errors")
            if r.returncode:
                return 0, [x["name"] for x in want]
        return len(good), [r["name"] for r in want if r not in good]
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def gdelt_lane(bucket, rows, days):
    by_day = {}
    for r in rows:
        by_day.setdefault(r["day"], []).append(r)
    missing, bad_days = [], 0
    for day in days:
        with slots:
            with lock:
                status["active"]["data.gdeltproject.org"] = f"gdelt/v2/{day}"
            got, gone = gdelt_day(bucket, day, by_day[day])
            with lock:
                status["active"].pop("data.gdeltproject.org", None)
        missing += gone
        bad_days = bad_days + 1 if len(gone) > len(by_day[day]) / 2 else 0
        with lock:
            status["gdelt"].update({"doneThrough": day, "missing": len(missing), "missingSample": missing[-20:]})
            status["done"] += got
            status["bytes"] += sum(r["size"] for r in by_day[day] if r["name"] not in gone)
        save_status(bucket)
        if bad_days >= 3:
            with lock:
                status["blocked"]["data.gdeltproject.org"] = {"code": 0, "key": f"three bad days in a row, stopped at {day}"}
            break


def main():
    p = argparse.ArgumentParser()
    p.add_argument("bucket")
    p.add_argument("--plan", action="store_true")
    p.add_argument("--only", default="")
    p.add_argument("--limit", type=int, default=0)
    a = p.parse_args()
    only = set(filter(None, a.only.split(",")))
    os.makedirs(os.path.join(TMP, "gdelt"), exist_ok=True)

    plans, lanes = {}, {}
    for name, build, license_text, source, note in DATASETS:
        if only and name not in only:
            continue
        try:
            files = build()
        except Exception as err:
            status["failed"].append({"dataset": name, "error": str(err)[:300]})
            continue
        ok = []
        for f in files:
            why = refused(f["url"])
            if why:
                status["skipped"].append({"dataset": name, "key": f["key"], "reason": why})
            else:
                ok.append(f)
        if a.limit:
            ok = ok[:a.limit]
        total = sum(f["size"] for f in ok)
        status["planned"][name] = {"files": len(ok), "knownGB": round(total / 1e9, 2), "unknownSize": sum(1 for f in ok if not f["size"])}
        if total > DATASET_LIMIT:
            status["skipped"].append({"dataset": name, "reason": f"{total / 1e9:.0f} GB is over the limit"})
            continue
        plans[name] = {"files": ok, "license": license_text, "source": source, "note": note}
        for f in ok:
            lanes.setdefault(urllib.parse.urlsplit(f["url"]).netloc, []).append(f)

    rows, days = [], []
    if not only or "gdelt" in only:
        try:
            rows, days, summary = gdelt_plan(a.limit)
            status["planned"]["gdelt"] = summary
        except Exception as err:
            status["failed"].append({"dataset": "gdelt", "error": str(err)[:300]})

    if a.plan:
        print(json.dumps(status, indent=1))
        put_json(a.bucket, "plan2.json", status)
        return

    save_status(a.bucket, force=True)
    threads = [threading.Thread(target=host_lane, args=(a.bucket, h, fs)) for h, fs in lanes.items()]
    if rows:
        window = "\n".join(f"{r['size']}\t{r['md5']}\t{r['url']}" for r in rows)
        aws("s3", "cp", "-", f"s3://{a.bucket}/{PREFIX}/gdelt/v2/window-files.tsv", stdin=window)
        put_json(a.bucket, "gdelt/MANIFEST.json", {"name": "gdelt", "license": LICENSE_GDELT, "source": "http://data.gdeltproject.org/gdeltv2/masterfilelist.txt", "note": "GDELT 2.0 15-minute files for the window, English and translated. Linked article text isn't covered. Layout: gdelt/v2/<day>/<file>; md5s in v2/window-files.tsv.", "window": WINDOW, "plan": status["planned"]["gdelt"], "retrieved": TODAY})
        threads.append(threading.Thread(target=gdelt_lane, args=(a.bucket, rows, days)))
    for t in threads:
        t.start()
    for name, plan in plans.items():
        put_json(a.bucket, f"{name}/MANIFEST.json", manifest(name, plan))
    for t in threads:
        t.join()
    for name, plan in plans.items():
        put_json(a.bucket, f"{name}/MANIFEST.json", manifest(name, plan))
    status["finished"] = True
    save_status(a.bucket, force=True)
    print("bulk2 done", status["done"], "already", status["already"], "failed", len(status["failed"]))


def manifest(name, plan):
    return {"name": name, "license": plan["license"], "source": plan["source"], "note": plan["note"], "retrieved": TODAY, "visibility": "private until a release is reviewed", "files": [{"key": f"{PREFIX}/{f['key']}", "url": f["url"], "size": f["size"], "state": f.get("state", "pending")} for f in plan["files"]]}


if __name__ == "__main__":
    main()
