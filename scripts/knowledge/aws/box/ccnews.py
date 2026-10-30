"""Runs on each CC-NEWS machine (ccnews_fleet.py): pulls WARC paths from a queue, reads each WARC from Common Crawl's
bucket and writes the articles it finds to our bucket as Parquet.

    python3 ccnews.py BUCKET QUEUE_URL --deadline EPOCH [--asg NAME] [--procs N] [--no-optout]
    python3 ccnews.py BUCKET --sample crawl-data/CC-NEWS/.../x.warc.gz --max-records 3000    (a local test: no queue)

A finished WARC gets a marker under _done/, so a restarted or interrupted machine skips it. A WARC stays invisible in
the queue while its worker is alive and comes back about 30 minutes after that worker dies. The WARC is only ever held
on this machine's disk while it is being read. When the queue is empty, one machine runs ccnews_optout.py, then all
of them terminate.
"""

import os

# py3langid's numpy would otherwise spin up a thread per core in every worker.
os.environ.update(OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1", MKL_NUM_THREADS="1")

import argparse
import collections
import json
import multiprocessing
import re
import resource
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

import boto3
import botocore.config
import botocore.exceptions
import pyarrow as pa
import pyarrow.parquet as pq
import py3langid
import trafilatura
import trafilatura.meta
from warcio.archiveiterator import ArchiveIterator

CC_BUCKET = "commoncrawl"
PREFIX = "knowledge/news/ccnews"
OPTOUT_PREFIX = "knowledge/news/ccnews-optout"
FIRST_DAY, LAST_DAY = "2026-01-04", "2026-10-29"
MIN_WORDS = 80
MAX_PAGE_BYTES = 3 * 1024 * 1024
VISIBILITY = 1800
RECORD_SECONDS = 30
STALL_SECONDS = 900
RECYCLE_AFTER = 8
WORK = "/opt/muse/work"
CLIENT = botocore.config.Config(region_name="us-east-1", retries={"mode": "adaptive", "max_attempts": 12}, max_pool_connections=8)

SCHEMA = pa.schema([
    ("url", pa.string()), ("domain", pa.string()), ("title", pa.string()), ("text", pa.string()), ("language", pa.string()),
    ("published", pa.string()), ("date_source", pa.string()), ("warc_file", pa.string()), ("fetch_time", pa.string()),
    ("words", pa.int32()), ("optout_noai_meta", pa.bool_()), ("optout_tdm_meta", pa.bool_()), ("optout_tdm_header", pa.bool_()),
    ("optout_noai_header", pa.bool_()), ("optout_usage_header", pa.string()),
])

# Sources the plan never uses, plus mastodon.social (its robots.txt bans LLM training by name; see the claim check).
NEVER = {
    "stackexchange.com", "stackoverflow.com", "superuser.com", "serverfault.com", "askubuntu.com", "mathoverflow.net",
    "fred.stlouisfed.org", "imf.org", "themoviedb.org", "imdb.com", "sports-reference.com", "baseball-reference.com",
    "basketball-reference.com", "pro-football-reference.com", "hockey-reference.com", "fbref.com", "statsapi.mlb.com",
    "stats.nba.com", "api-web.nhle.com", "statsapi.web.nhl.com", "boxofficemojo.com", "openai.com", "reddit.com", "redd.it",
    "x.com", "twitter.com", "youtube.com", "youtu.be", "tiktok.com", "instagram.com", "facebook.com", "fb.com", "bsky.app",
    "binance.com", "coingecko.com", "finance.yahoo.com", "finance.yahoo.co.jp", "emdat.be", "jolpi.ca", "openf1.org",
    "statsbomb.com", "igdb.com", "prnewswire.com", "prnewswire.co.uk", "manifold.markets", "metaculus.com",
    "legisquebec.gouv.qc.ca", "exa.ai", "mastodon.social",
}
WIRE_DOMAINS = {
    "apnews.com", "ap.org", "reuters.com", "afp.com", "dpa.com", "dpa-international.com", "dpa-news.com", "efe.com",
    "agenciaefe.es", "kyodonews.net", "kyodonews.jp", "xinhuanet.com", "xinhuanews.com", "news.cn", "xinhua.net",
}
WIRE_NAMES = r"AP|Reuters|AFP|dpa|DPA|EFE|Kyodo|Xinhua"
WIRE_FULL = r"(?:The )?Associated Press|Reuters|Thomson Reuters|AFP|Agence France[- ]Presse|dpa|Deutsche Presse-Agentur|EFE|Agencia EFE|Kyodo(?: News)?|Xinhua(?: News Agency)?"
DATELINE = re.compile(rf"^[^\n]{{0,80}}?\((?:{WIRE_NAMES})\)\s*[-–—:.]")
BYLINE = re.compile(rf"^\s*(?:By\s+)?(?:{WIRE_FULL})\s*(?:\n|$)", re.I)
AUTHOR = re.compile(rf"^\s*(?:By\s+)?(?:{WIRE_FULL}|AP)(?:\s+(?:staff|news|wire|writers?|reporters?))?\s*$", re.I)
TRAILER = re.compile(r"(?:copyright|©)\s*(?:©\s*)?\d{4}\s+(?:The\s+)?(?:Associated Press|Reuters|Thomson Reuters|AFP|Agence France|dpa|EFE|Kyodo|Xinhua)"
                     r"|\(Reporting by [^)]{3,300}Editing by"
                     r"|\bThe Associated Press\. All rights reserved", re.I)

META_DATE = [re.compile(r"""<meta\b[^>]*\b(?:property|name)\s*=\s*["']article:published_time["'][^>]*\bcontent\s*=\s*["']([^"']{8,40})""", re.I),
             re.compile(r"""<meta\b[^>]*\bcontent\s*=\s*["']([^"']{8,40})["'][^>]*\b(?:property|name)\s*=\s*["']article:published_time["']""", re.I)]
JSONLD_DATE = re.compile(r'"datePublished"\s*:\s*"([^"]{8,40})"')
ISO_DAY = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
META_TAGS = re.compile(r"<meta\b[^>]*>", re.I)
CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯฀-໿ក-៿က-႟]")
DATE_PARAMS = {"extensive_search": False, "original_date": True, "outputformat": "%Y-%m-%d", "min_date": "1995-01-01", "max_date": "2026-12-31"}


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


def domain_of(url):
    host = (urllib.parse.urlsplit(url).hostname or "").lower().rstrip(".")
    return host[4:] if host.startswith("www.") else host


def listed(host, names):
    parts = host.split(".")
    return any(".".join(parts[i:]) in names for i in range(len(parts) - 1))


def word_count(text):
    """Whitespace words, plus one per two characters of scripts written without spaces, so Chinese or Thai can reach 80."""
    return len(text.split()) + len(CJK.findall(text)) // 2


def quick_date(head):
    """(day, source) from article:published_time or JSON-LD datePublished, without parsing the page."""
    for pattern in META_DATE:
        m = pattern.search(head)
        if m and ISO_DAY.match(m.group(1).strip()):
            return m.group(1).strip()[:10], "article:published_time"
    m = JSONLD_DATE.search(head)
    if m and ISO_DAY.match(m.group(1).strip()):
        return m.group(1).strip()[:10], "json-ld"
    return None, None


def page_optout(head):
    """Opt-out signals in the page's own meta tags: (noai, tdm-reservation)."""
    noai = tdm = False
    for tag in META_TAGS.findall(head):
        low = tag.lower()
        if re.search(r"""name\s*=\s*["']?(?:robots|[a-z-]*bot)["']?""", low) and re.search(r"\bnoai\b", low):
            noai = True
        if "tdm-reservation" in low and re.search(r"""content\s*=\s*["']?\s*1""", low):
            tdm = True
    return noai, tdm


def header_optout(headers):
    tdm = (headers.get_header("tdm-reservation") or "").strip() == "1"
    noai = bool(re.search(r"\bnoai\b", (headers.get_header("x-robots-tag") or "").lower()))
    usage = "; ".join(v for v in (headers.get_header("content-usage"), headers.get_header("content-signal")) if v)
    return tdm, noai, usage or None


def is_wire_text(text, author):
    if author and AUTHOR.match(author):
        return True
    return bool(DATELINE.match(text[:200]) or BYLINE.match(text[:120]) or TRAILER.search(text[-500:]))


class RecordTimeout(Exception):
    pass


def on_alarm(*_):
    raise RecordTimeout()


def parse_record(rec, warc_file, stats):
    """One WARC record to one output row, or None with the reason counted."""
    if rec.rec_type != "response":
        return None
    stats["responses"] += 1
    url = rec.rec_headers.get_header("WARC-Target-URI") or ""
    if rec.http_headers is None or rec.http_headers.get_statuscode() != "200":
        stats["skip_status"] += 1
        return None
    ctype = (rec.http_headers.get_header("content-type") or rec.rec_headers.get_header("WARC-Identified-Payload-Type") or "").lower()
    if "html" not in ctype:
        stats["skip_not_html"] += 1
        return None
    host = domain_of(url)
    if not host or listed(host, NEVER):
        stats["skip_never_list"] += 1
        return None
    if listed(host, WIRE_DOMAINS):
        stats["skip_wire_domain"] += 1
        return None
    raw = rec.content_stream().read(MAX_PAGE_BYTES + 1)
    if len(raw) > MAX_PAGE_BYTES:
        stats["skip_too_big"] += 1
        return None
    stats["html_pages"] += 1
    head = raw[:300000].decode("latin-1")
    published, source = quick_date(head)
    if published and not FIRST_DAY <= published <= LAST_DAY:
        stats["skip_out_of_window"] += 1
        return None
    doc = trafilatura.bare_extraction(raw, url=url, fast=True, include_comments=False, include_tables=False, with_metadata=True, date_extraction_params=DATE_PARAMS)
    if doc is None or not doc.text:
        stats["skip_no_text"] += 1
        return None
    if not published and doc.date:
        published, source = str(doc.date)[:10], "htmldate"
    if not published:
        stats["skip_no_date"] += 1
        return None
    if not FIRST_DAY <= published <= LAST_DAY:
        stats["skip_out_of_window"] += 1
        return None
    text = doc.text.strip()
    words = word_count(text)
    if words < MIN_WORDS:
        stats["skip_short"] += 1
        return None
    if is_wire_text(text, doc.author):
        stats["skip_wire_byline"] += 1
        return None
    noai_meta, tdm_meta = page_optout(head)
    tdm_header, noai_header, usage = header_optout(rec.http_headers)
    return {
        "url": url, "domain": host, "title": doc.title, "text": text, "language": py3langid.classify(text[:3000])[0],
        "published": published, "date_source": source, "warc_file": warc_file, "fetch_time": rec.rec_headers.get_header("WARC-Date"),
        "words": words, "optout_noai_meta": noai_meta, "optout_tdm_meta": tdm_meta, "optout_tdm_header": tdm_header,
        "optout_noai_header": noai_header, "optout_usage_header": usage,
    }


def download(s3, key, path, beat):
    """One GET per WARC (a dropped connection carries on from where it stopped), so Common Crawl sees very few requests."""
    done = 0
    size = None
    with open(path, "wb") as f:
        for attempt in range(8):
            try:
                args = {"Range": f"bytes={done}-"} if done else {}
                r = s3.get_object(Bucket=CC_BUCKET, Key=key, **args)
                size = size or r["ContentLength"]
                for chunk in r["Body"].iter_chunks(1024 * 1024):
                    f.write(chunk)
                    done += len(chunk)
                    beat()
                if done >= size:
                    return size
            except (botocore.exceptions.BotoCoreError, botocore.exceptions.ClientError, OSError) as err:
                log("download retry", key, attempt, str(err)[:200])
                time.sleep(min(300, 5 * 2 ** attempt))
    raise RuntimeError(f"could not download {key}")


def process_warc(s3, bucket, key, beat, max_records=None, out_dir=None):
    """Extract one WARC to Parquet in our bucket. Returns the stats that go in its marker."""
    started, cpu_start = time.time(), time.process_time()
    month = key.split("/")[3]
    name = key.rsplit("/", 1)[1]
    stem = name.replace(".warc.gz", "")
    work = out_dir or f"{WORK}/{os.getpid()}"
    os.makedirs(work, exist_ok=True)
    local, parquet = f"{work}/{name}", f"{work}/{stem}.parquet"
    size = download(s3, key, local, beat)
    stats = collections.Counter(warc_bytes=size)
    seen, rows, writer = set(), [], None
    signal.signal(signal.SIGALRM, on_alarm)
    try:
        with open(local, "rb") as f:
            for rec in ArchiveIterator(f):
                stats["records"] += 1
                if max_records and stats["records"] > max_records:
                    break
                beat()
                url = rec.rec_headers.get_header("WARC-Target-URI")
                if rec.rec_type == "response" and url in seen:
                    stats["skip_repeat_url"] += 1
                    continue
                signal.setitimer(signal.ITIMER_REAL, RECORD_SECONDS)
                try:
                    row = parse_record(rec, name, stats)
                except RecordTimeout:
                    stats["skip_timeout"] += 1
                    row = None
                except Exception as err:
                    stats["skip_error"] += 1
                    if stats["skip_error"] <= 3:
                        log("record error", url, repr(err)[:300])
                    row = None
                finally:
                    signal.setitimer(signal.ITIMER_REAL, 0)
                if rec.rec_type == "response":
                    seen.add(url)
                if row:
                    rows.append(row)
                    stats["articles"] += 1
                    stats["article_chars"] += len(row["text"])
                if len(rows) >= 2000:
                    writer = writer or pq.ParquetWriter(parquet, SCHEMA, compression="zstd")
                    writer.write_table(pa.Table.from_pylist(rows, schema=SCHEMA))
                    rows = []
        if rows:
            writer = writer or pq.ParquetWriter(parquet, SCHEMA, compression="zstd")
            writer.write_table(pa.Table.from_pylist(rows, schema=SCHEMA))
        if writer:
            writer.close()
            stats["parquet_bytes"] = os.path.getsize(parquet)
            if bucket:
                s3.upload_file(parquet, bucket, f"{PREFIX}/2026-{month}/{stem}.parquet")
        stats["seconds"] = round(time.time() - started, 1)
        stats["cpu_seconds"] = round(time.process_time() - cpu_start, 1)
        return dict(stats), month, stem
    finally:
        os.path.exists(local) and os.remove(local)
        if bucket:
            os.path.exists(parquet) and os.remove(parquet)
        trafilatura.meta.reset_caches()


def marker_key(key):
    month, stem = key.split("/")[3], key.rsplit("/", 1)[1].replace(".warc.gz", "")
    return f"{PREFIX}/_done/2026-{month}/{stem}.json"


def has_marker(s3, bucket, key):
    try:
        s3.head_object(Bucket=bucket, Key=marker_key(key))
        return True
    except botocore.exceptions.ClientError:
        return False


def worker(bucket, queue, deadline):
    """Pulls WARCs until the queue looks empty, the deadline nears, or it has done a few (a fresh process keeps memory flat)."""
    s3, sqs = boto3.client("s3", config=CLIENT), boto3.client("sqs", config=CLIENT)
    for _ in range(RECYCLE_AFTER):
        if time.time() > deadline - 900:
            return
        msgs = sqs.receive_message(QueueUrl=queue, MaxNumberOfMessages=1, WaitTimeSeconds=20, VisibilityTimeout=VISIBILITY).get("Messages", [])
        if not msgs:
            return
        handle, key = msgs[0]["ReceiptHandle"], msgs[0]["Body"]
        if has_marker(s3, bucket, key):
            sqs.delete_message(QueueUrl=queue, ReceiptHandle=handle)
            continue
        state = {"beat": time.time()}
        stop = threading.Event()

        def keep_alive():
            while not stop.wait(300):
                if time.time() - state["beat"] > STALL_SECONDS:
                    log("stalled, restarting worker on", key)
                    os._exit(3)
                try:
                    sqs.change_message_visibility(QueueUrl=queue, ReceiptHandle=handle, VisibilityTimeout=VISIBILITY)
                except Exception as err:
                    log("visibility", str(err)[:200])

        thread = threading.Thread(target=keep_alive, daemon=True)
        thread.start()
        try:
            stats, _, _ = process_warc(s3, bucket, key, lambda: state.__setitem__("beat", time.time()))
            stats["warc"], stats["at"] = key, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            s3.put_object(Bucket=bucket, Key=marker_key(key), Body=json.dumps(stats).encode(), ContentType="application/json")
            sqs.delete_message(QueueUrl=queue, ReceiptHandle=handle)
            log("done", key, stats.get("articles", 0), "articles", stats["seconds"], "s")
        except Exception as err:
            # Left in the queue: it comes back after the visibility timeout and goes to the dead-letter queue after 4 tries.
            log("failed", key, repr(err)[:500])
        finally:
            stop.set()


def imds(path):
    token = urllib.request.urlopen(urllib.request.Request("http://169.254.169.254/latest/api/token", method="PUT", headers={"X-aws-ec2-metadata-token-ttl-seconds": "300"}), timeout=5).read().decode()
    return urllib.request.urlopen(urllib.request.Request(f"http://169.254.169.254/latest/meta-data/{path}", headers={"X-aws-ec2-metadata-token": token}), timeout=5).read().decode()


def queue_counts(sqs, queue):
    a = sqs.get_queue_attributes(QueueUrl=queue, AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"])["Attributes"]
    return int(a["ApproximateNumberOfMessages"]), int(a["ApproximateNumberOfMessagesNotVisible"]) + int(a["ApproximateNumberOfMessagesDelayed"])


def drained(sqs, queue):
    """SQS counts are approximate, so the queue must read empty three times in a row."""
    for _ in range(3):
        if sum(queue_counts(sqs, queue)):
            return False
        time.sleep(20)
    return True


def fleet_size(asg):
    if not asg:
        return 1
    g = boto3.client("autoscaling", config=CLIENT).describe_auto_scaling_groups(AutoScalingGroupNames=[asg])["AutoScalingGroups"]
    return g[0]["DesiredCapacity"] if g else 0


def run_optout(bucket, deadline):
    """One machine takes a claim in S3 and runs the robots.txt pass. The claim is refreshed every 30 seconds, so a later
    machine can take over a claim that has stopped moving (its machine was reclaimed)."""
    s3 = boto3.client("s3", config=CLIENT)
    claim, success = f"{OPTOUT_PREFIX}/_claim.json", f"{OPTOUT_PREFIX}/_SUCCESS"
    me = imds("instance-id")

    def exists():
        try:
            s3.head_object(Bucket=bucket, Key=success)
            return True
        except botocore.exceptions.ClientError:
            return False

    if exists():
        return
    body = lambda: json.dumps({"instance": me, "at": time.time()}).encode()
    try:
        etag = s3.head_object(Bucket=bucket, Key=claim)["ETag"]
    except botocore.exceptions.ClientError:
        etag = None
    try:
        if etag is None:
            s3.put_object(Bucket=bucket, Key=claim, Body=body(), IfNoneMatch="*")
        else:
            time.sleep(90)
            if s3.head_object(Bucket=bucket, Key=claim)["ETag"] != etag:
                log("another machine holds the opt-out claim")
                return
            s3.put_object(Bucket=bucket, Key=claim, Body=body(), IfMatch=etag)
    except botocore.exceptions.ClientError as err:
        log("lost the opt-out claim", str(err)[:200])
        return
    stop = threading.Event()

    def refresh():
        while not stop.wait(30):
            try:
                s3.put_object(Bucket=bucket, Key=claim, Body=body())
            except Exception as err:
                log("claim refresh", str(err)[:200])

    threading.Thread(target=refresh, daemon=True).start()
    log("running the opt-out pass")
    code = subprocess.call([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "ccnews_optout.py"), bucket, "--deadline", str(deadline)])
    log("opt-out pass exited", code)
    stop.set()


def supervise(args):
    os.makedirs(WORK, exist_ok=True)
    me = imds("instance-id")
    s3, sqs = boto3.client("s3", config=CLIENT), boto3.client("sqs", config=CLIENT)
    procs = args.procs or os.cpu_count()
    workers = []
    last_status = 0
    leave_reason = "deadline"
    while time.time() < args.deadline - 300:
        workers = [p for p in workers if p.is_alive()]
        visible, in_flight = queue_counts(sqs, args.queue)
        if visible:
            while len(workers) < procs:
                p = multiprocessing.Process(target=worker, args=(args.bucket, args.queue, args.deadline))
                p.start()
                workers.append(p)
        if time.time() - last_status > 120:
            last_status = time.time()
            s3.put_object(Bucket=args.bucket, Key=f"{PREFIX}/_status/{me}.json", Body=json.dumps({"instance": me, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "workers": len(workers), "visible": visible, "inFlight": in_flight}).encode())
        if not workers and not visible:
            if not in_flight and drained(sqs, args.queue):
                leave_reason = "queue empty"
                break
            if in_flight and fleet_size(args.asg) > 1:
                leave_reason = "nothing left for this machine"
                break
        time.sleep(30)
    log("leaving:", leave_reason)
    for p in workers:
        p.terminate()
    if leave_reason == "queue empty" and not args.no_optout:
        run_optout(args.bucket, args.deadline)
    if args.asg:
        try:
            boto3.client("autoscaling", config=CLIENT).terminate_instance_in_auto_scaling_group(InstanceId=me, ShouldDecrementDesiredCapacity=True)
        except Exception as err:
            log("could not leave the group", str(err)[:300])


def sample(args):
    """Runs on a test machine: one WARC, in this process, with the rows printed."""
    s3 = boto3.client("s3", config=CLIENT)
    out = "/tmp/ccnews-sample"
    stats, month, stem = process_warc(s3, args.bucket if args.upload else None, args.sample, lambda: None, args.max_records, out)
    print(json.dumps(stats, indent=1))
    path = f"{out}/{stem}.parquet"
    if os.path.exists(path):
        table = pq.read_table(path)
        print("rows", table.num_rows, "bytes", os.path.getsize(path))
        for row in table.slice(0, args.show).to_pylist():
            row["text"] = row["text"][:300]
            print(json.dumps(row, ensure_ascii=False))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("bucket")
    p.add_argument("queue", nargs="?")
    p.add_argument("--deadline", type=float, default=time.time() + 3600)
    p.add_argument("--asg")
    p.add_argument("--procs", type=int)
    p.add_argument("--no-optout", action="store_true")
    p.add_argument("--sample")
    p.add_argument("--max-records", type=int)
    p.add_argument("--show", type=int, default=10)
    p.add_argument("--upload", action="store_true")
    a = p.parse_args()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if a.sample:
        sample(a)
    else:
        supervise(a)
