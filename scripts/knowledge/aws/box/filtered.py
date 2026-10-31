"""Runs on the filter machine (filtered_box.py): reads the public research and court data and keeps only the 2026 window.

    filtered.py all [--shutdown] [--pubmed-email ADDRESS]    every lane as its own process, then terminate the machine
    filtered.py <lane> [--sample N] [--out PREFIX]           one lane; a sample writes under --out for reading by hand

Lanes: pmc, openalex, courtlistener, arxiv, biorxiv, medrxiv, pubmed. Each one fails alone and resumes from markers under
knowledge/filtered/_progress/. knowledge/filtered/status.json says where everything stands.

pubmed only runs when given a contact address: NLM asks for a valid email as the FTP password, and the HTTPS host's
robots.txt disallows everything, so it stays off until the owner has decided both.
"""

import argparse
import asyncio
import csv
import ftplib
import gzip
import io
import json
import multiprocessing
import os
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.config import Config

BUCKET = "muse-knowledge-916979311153"
ROOT = "knowledge/filtered"
TMP = "/opt/muse/tmp"
LOGS = "/opt/muse/logs"
START, END = "2026-01-04", "2026-10-29"
USER_AGENT = "MuseMuse-knowledge/0.1 (https://offlinebase.com)"
PRIVATE = "Private. Nothing here is published until a release is reviewed."
LANES = ["pmc", "courtlistener", "openalex", "arxiv", "biorxiv", "medrxiv"]
clients = {}
clients_lock = threading.Lock()


def s3():
    """One client per process and thread: boto3 clients don't survive a fork."""
    key = (os.getpid(), threading.get_ident())
    if key not in clients:
        with clients_lock:
            clients[key] = boto3.client("s3", region_name="us-east-1", config=Config(max_pool_connections=64, retries={"max_attempts": 10, "mode": "standard"}))
    return clients[key]


def put(key, body):
    s3().put_object(Bucket=BUCKET, Key=f"{ROOT}/{key}", Body=body)


def put_json(key, data):
    put(key, json.dumps(data, indent=1).encode())


def get_json(key):
    try:
        return json.load(s3().get_object(Bucket=BUCKET, Key=f"{ROOT}/{key}")["Body"])
    except s3().exceptions.NoSuchKey:
        return None


def upload(path, key):
    s3().upload_file(path, BUCKET, f"{ROOT}/{key}")
    os.remove(path)


def mark(lane, item, data):
    put_json(f"_progress/{lane}/{item}.json", data)


def progress(lane):
    """Every finished item of a lane: {item: what it recorded}."""
    keys = []
    for page in s3().get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=f"{ROOT}/_progress/{lane}/"):
        keys += [o["Key"] for o in page.get("Contents", [])]
    def one(key):
        return key.rsplit("/", 1)[1][:-5], json.load(s3().get_object(Bucket=BUCKET, Key=key)["Body"])
    with ThreadPoolExecutor(16) as pool:
        return dict(pool.map(one, keys))


def say(lane, **fields):
    fields = {"lane": lane, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **fields}
    put_json(f"_status/{lane}.json", fields)
    print(json.dumps(fields)[:1500], flush=True)


def add(total, counts):
    for k, v in counts.items():
        total[k] = total.get(k, 0) + v
    return total


def safe(code):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", code or "unknown").strip("-") or "unknown"


class Shards:
    """gzip JSONL, one file per license folder, named after the input item so a rerun overwrites rather than doubles."""

    def __init__(self, dataset, item):
        self.dataset, self.item, self.files = dataset, item, {}
        os.makedirs(TMP, exist_ok=True)

    def write(self, code, record):
        code = safe(code)
        if code not in self.files:
            path = f"{TMP}/{self.dataset}-{self.item}-{code}.jsonl.gz"
            self.files[code] = (path, gzip.open(path, "wt", encoding="utf8", compresslevel=6))
        self.files[code][1].write(json.dumps(record) + "\n")

    def close(self):
        for code, (path, f) in self.files.items():
            f.close()
            upload(path, f"{self.dataset}/{code}/{self.item}.jsonl.gz")


# PMC open access


PMC_URL = "https://pmc-oa-opendata.s3.us-east-1.amazonaws.com/"
PMC_BATCH = 20000
PMC_RATE = 300
PMC_WORKERS = 8
MONTHS = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}
CITE_DATE = re.compile(r"(?:^|\. |Epub |[Oo]nline:? )(20\d\d)(?: ([A-Z][a-z]{2}))?(?:[-/ ][A-Z][a-z]{2})?(?: (\d{1,2}))?\b")


def pmc_date(citation):
    """The first 2026 date in a citation like 'Cureus. 2026 Feb 16;18(2):e103745' or '...2027 Jan;1(1):2. Epub 2026 Dec 3', or None."""
    for m in CITE_DATE.finditer(citation or ""):
        if m.group(1) == "2026":
            month = MONTHS.get(m.group(2) or "")
            if not month:
                return "2026"
            return f"2026-{month:02d}-{int(m.group(3)):02d}" if m.group(3) else f"2026-{month:02d}"
    return None


def pmc_jats_date(jats):
    """Author manuscripts' citations only say 'Available in PMC <date>', so their publication date comes from the JATS."""
    for tag, body in re.findall(r"<pub-date\b([^>]*)>(.*?)</pub-date>", jats, re.S):
        if "pmc-release" in tag or "nihms" in tag:
            continue
        year = re.search(r"<year>(\d{4})</year>", body)
        if year and year.group(1) == "2026":
            month, day = re.search(r"<month>(\d+)</month>", body), re.search(r"<day>(\d+)</day>", body)
            if not month:
                return "2026"
            return f"2026-{int(month.group(1)):02d}-{int(day.group(1)):02d}" if day else f"2026-{int(month.group(1)):02d}"
    return None


def pmc_plan():
    plan = get_json("_progress/pmc-plan.json")
    if not plan:
        base = "inventory-reports/pmc-oa-opendata/metadata/"
        days = s3().list_objects_v2(Bucket="pmc-oa-opendata", Prefix=base, Delimiter="/")["CommonPrefixes"]
        day = sorted(p["Prefix"] for p in days if re.search(r"/\d{4}-\d\d-\d\dT", p["Prefix"]))[-1]
        plan = {"inventory": day}
        put_json("_progress/pmc-plan.json", plan)
    manifest = json.load(s3().get_object(Bucket="pmc-oa-opendata", Key=plan["inventory"] + "manifest.json")["Body"])
    latest = {}
    for f in manifest["files"]:
        body = gzip.decompress(s3().get_object(Bucket="pmc-oa-opendata", Key=f["key"])["Body"].read())
        for m in re.finditer(rb"metadata/PMC(\d+)\.(\d+)\.json", body):
            n, v = int(m.group(1)), int(m.group(2))
            if v > latest.get(n, 0):
                latest[n] = v
    return plan["inventory"], sorted(latest.items(), reverse=True)


async def pmc_get(session, pace, key):
    import aiohttp
    for attempt in range(8):
        now = time.monotonic()
        slot = max(pace[0], now)
        pace[0] = slot + 1 / PMC_RATE
        if slot > now:
            await asyncio.sleep(slot - now)
        try:
            async with session.get(PMC_URL + key) as r:
                if r.status == 200:
                    return await r.read()
                if r.status == 404:
                    return None
                err = f"HTTP {r.status}"
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            err = repr(e)
        await asyncio.sleep(min(60, 2 ** attempt))
    raise IOError(f"{key}: {err}")


async def pmc_scan(item, ids, shards):
    import aiohttp
    counts = {"scanned": 0, "kept": 0, "no_text": 0}
    licenses, failed = {}, []
    pace = [0.0]
    gate = asyncio.Semaphore(48)

    async def one(n, v, session):
        async with gate:
            try:
                raw = await pmc_get(session, pace, f"metadata/PMC{n}.{v}.json")
                counts["scanned"] += 1
                if raw is None:
                    return
                meta = json.loads(raw)
                date = pmc_date(meta.get("citation"))
                listed = re.search(r"Available in PMC (20\d\d)", meta.get("citation") or "")
                if not date and not (listed and listed.group(1) >= "2026" and meta.get("xml_url")):
                    return
                def path(u):
                    return (u or "").replace("s3://pmc-oa-opendata/", "").split("?")[0]
                jats = await pmc_get(session, pace, path(meta.get("xml_url"))) if meta.get("xml_url") else None
                date = date or pmc_jats_date((jats or b"").decode("utf8", "replace"))
                if not date:
                    return
                text = await pmc_get(session, pace, path(meta.get("text_url"))) if meta.get("text_url") else None
            except Exception as err:
                failed.append(f"PMC{n}.{v}: {str(err)[:120]}")
                return
        if text is None and jats is None:
            counts["no_text"] += 1
        code = meta.get("license_code") or "unknown"
        keep = {k: meta.get(k) for k in ("pmcid", "version", "pmid", "doi", "mid", "title", "citation", "license_code", "is_pmc_openaccess", "is_manuscript", "is_historical_ocr", "is_retracted")}
        keep["pub_date"] = date
        keep["text"] = text.decode("utf8", "replace") if text else None
        keep["jats"] = jats.decode("utf8", "replace") if jats else None
        shards.write(code, keep)
        counts["kept"] += 1
        licenses[safe(code)] = licenses.get(safe(code), 0) + 1

    async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=48), timeout=aiohttp.ClientTimeout(total=180), headers={"User-Agent": USER_AGENT}) as session:
        await asyncio.gather(*(one(n, v, session) for n, v in ids))
    return counts, licenses, failed


def pmc_batch(job):
    item, ids = job
    shards = Shards("pmc", item)
    counts, licenses, failed = asyncio.run(pmc_scan(item, ids, shards))
    shards.close()
    if len(failed) > 20:
        raise IOError(f"{item}: {len(failed)} failures, first: {failed[0]}")
    result = {**counts, "licenses": licenses, "failed": failed}
    mark("pmc", item, result)
    return item, result


def pmc_lane(a):
    put_json("pmc/MANIFEST.json", {
        "dataset": "PubMed Central open access articles with 2026 publication dates",
        "source": "s3://pmc-oa-opendata/ (https://www.ncbi.nlm.nih.gov/pmc/tools/pmcaws/)",
        "license": "Per article: the folder name is that article's license_code from its own metadata JSON (spaces become dashes). unknown/ is a null license_code: never treat it as CC BY. TDM marks author manuscripts (text mining and fair use only).",
        "selection": "Newest version of each article whose citation carries a 2026 date, in print or online; author manuscripts use the pub-date in their JATS instead, since their citations only give the date PMC listed them. pub_date is the first 2026 date found, so narrow to Jan 4 to Oct 29 downstream. Retracted articles are kept and flagged.",
        "format": "gzip JSONL: pmcid, version, pmid, doi, title, citation, pub_date, license_code, flags, text (plain), jats (XML). The article's own text keeps its license.",
        "note": PRIVATE,
    })
    inventory, ids = pmc_plan()
    say("pmc", state="running", inventory=inventory, articles=len(ids))
    if a.sample:
        ids = ids[:a.sample]
    done = progress("pmc")
    jobs = [(f"batch-{i // PMC_BATCH:05d}", ids[i:i + PMC_BATCH]) for i in range(0, len(ids), PMC_BATCH)]
    total_batches = len(jobs)
    jobs = [j for j in jobs if j[0] not in done]
    counts, licenses = {}, {}
    for r in done.values():
        add(counts, {k: r[k] for k in ("scanned", "kept", "no_text")})
        add(licenses, r["licenses"])
    errors = []
    with multiprocessing.get_context("fork").Pool(PMC_WORKERS) as pool:
        running = pool.imap_unordered(pmc_batch_safe, jobs)
        for item, r in running:
            if "error" in r:
                errors.append(f"{item}: {r['error']}")
            else:
                done[item] = r
                add(counts, {k: r[k] for k in ("scanned", "kept", "no_text")})
                add(licenses, r["licenses"])
            say("pmc", state="running", inventory=inventory, articles=len(ids), batchesDone=len(done), batches=total_batches, errors=errors[-5:], **counts, licenses=licenses)
    if errors:
        raise RuntimeError(f"{len(errors)} batches failed: {errors[0]}")
    say("pmc", state="done", inventory=inventory, articles=len(ids), batchesDone=len(done), **counts, licenses=licenses)


def pmc_batch_safe(job):
    try:
        return pmc_batch(job)
    except Exception as err:
        return job[0], {"error": str(err)[:300]}


# OpenAlex


OA_COLUMNS = ["id", "doi", "title", "ids", "publication_date", "publication_year", "language", "type", "primary_location", "best_oa_location", "open_access", "authorships.list.element.institutions", "authors_count", "primary_topic", "topics", "keywords", "mesh", "funders", "abstract_inverted_index", "is_retracted", "is_paratext", "cited_by_count", "created_date", "updated_date"]
OA_WORKERS = 12


def oa_abstract(raw):
    if not raw:
        return None
    try:
        index = json.loads(raw)
        words = {}
        for word, places in index.items():
            for place in places:
                words[place] = word
        return " ".join(words[i] for i in sorted(words))
    except (ValueError, AttributeError, TypeError):
        return None


def oa_institutions(authorships):
    """Each author's institutions, once per work. The work-level institutions column is empty in this snapshot, and author names stay out."""
    seen = {}
    for author in authorships or []:
        for inst in author.get("institutions") or []:
            seen.setdefault(inst.get("id") or inst.get("display_name"), {k: inst.get(k) for k in ("id", "display_name", "ror", "country_code", "type")})
    return list(seen.values())


def oa_flatten(t):
    import pyarrow as pa
    import pyarrow.compute as pc
    institution = pa.struct([(k, pa.string()) for k in ("id", "display_name", "ror", "country_code", "type")])

    def whole(name):
        return t.column(name).combine_chunks()

    def leaf(name, path):
        return pc.struct_field(whole(name), path)

    out = {
        "id": whole("id"), "doi": whole("doi"), "title": whole("title"),
        "pmid": pc.map_lookup(whole("ids"), "pmid", "first"), "pmcid": pc.map_lookup(whole("ids"), "pmcid", "first"),
        "publication_date": whole("publication_date"), "publication_year": whole("publication_year"),
        "language": whole("language"), "type": whole("type"),
        "venue": leaf("primary_location", ["source", "display_name"]), "venue_issn_l": leaf("primary_location", ["source", "issn_l"]),
        "publisher": leaf("primary_location", ["source", "host_organization_name"]),
        "is_oa": leaf("open_access", ["is_oa"]), "oa_status": leaf("open_access", ["oa_status"]), "oa_url": leaf("open_access", ["oa_url"]),
        "oa_license": leaf("best_oa_location", ["license"]),
        "institutions": pa.array([oa_institutions(x) for x in whole("authorships").to_pylist()], type=pa.list_(institution)),
        "authors_count": whole("authors_count"), "primary_topic": whole("primary_topic"), "topics": whole("topics"),
        "keywords": whole("keywords"), "mesh": whole("mesh"), "funders": whole("funders"),
        "abstract": pa.array([oa_abstract(x) for x in whole("abstract_inverted_index").to_pylist()], type=pa.string()),
        "is_retracted": whole("is_retracted"), "is_paratext": whole("is_paratext"), "cited_by_count": whole("cited_by_count"),
        "created_date": whole("created_date"), "updated_date": whole("updated_date"),
    }
    return pa.table(out)


def oa_file(url):
    import datetime
    import pyarrow.compute as pc
    import pyarrow.fs as pafs
    import pyarrow.parquet as pq

    m = re.search(r"updated_date=([\d-]+)/(part_\d+)", url)
    item = f"{m.group(1)}-{m.group(2)}"
    try:
        lo, hi = datetime.date.fromisoformat(START), datetime.date.fromisoformat(END)
        fs = pafs.S3FileSystem(anonymous=True, region="us-east-1", connect_timeout=30, request_timeout=120)
        pf = pq.ParquetFile(url[5:], filesystem=fs)
        column = [i for i in range(pf.metadata.num_columns) if pf.metadata.row_group(0).column(i).path_in_schema == "publication_date"][0]
        os.makedirs(TMP, exist_ok=True)
        path = f"{TMP}/openalex-{item}.parquet"
        writer, rows, seen, status = None, 0, 0, {}
        for g in range(pf.metadata.num_row_groups):
            md = pf.metadata.row_group(g)
            seen += md.num_rows
            stats = md.column(column).statistics
            if stats is not None and stats.has_min_max and (stats.max < lo or stats.min > hi):
                continue
            dates = pf.read_row_group(g, columns=["publication_date"]).column(0)
            mask = pc.and_(pc.greater_equal(dates, pa_date(lo)), pc.less_equal(dates, pa_date(hi)))
            if not pc.any(mask).as_py():
                continue
            out = oa_flatten(pf.read_row_group(g, columns=OA_COLUMNS).filter(mask))
            if writer is None:
                writer = pq.ParquetWriter(path, out.schema, compression="zstd")
            writer.write_table(out)
            rows += out.num_rows
            for row in out.column("oa_status").value_counts().to_pylist():
                key = row["values"] or "none"
                status[key] = status.get(key, 0) + row["counts"]
        if writer:
            writer.close()
            upload(path, f"openalex/{item}.parquet")
        result = {"seen": seen, "kept": rows, "oaStatus": status}
        mark("openalex-v2", item, result)
        return item, result
    except Exception as err:
        return item, {"error": repr(err)[:300]}


def pa_date(d):
    import pyarrow as pa
    return pa.scalar(d, type=pa.date32())


def openalex_lane(a):
    put_json("openalex/MANIFEST.json", {
        "dataset": "OpenAlex works with publication_date from 2026-01-04 to 2026-10-29",
        "source": "s3://openalex/data/parquet/works/ (snapshot 2026-10-14, https://help.openalex.org/access/snapshot/)",
        "license": "CC0 for OpenAlex's metadata. Abstracts belong to their publishers: training-only, never in a public release.",
        "selection": "Row-level filter on publication_date. Abstracts are rebuilt from the inverted index. institutions is the distinct set across the authors' institutions; author names are not kept.",
        "format": "Parquet (zstd), one part per source file.",
        "note": PRIVATE,
    })
    manifest = json.load(s3().get_object(Bucket="openalex", Key="data/parquet/manifest.json")["Body"])
    works = [e for e in manifest["entities"] if e["entity"] == "works"][0]
    urls = [f["url"] for f in works["files"]]
    urls.sort(key=lambda u: u, reverse=True)
    if a.sample:
        urls = urls[:a.sample]
    done = progress("openalex-v2")
    jobs = [u for u in urls if "%s-%s" % re.search(r"updated_date=([\d-]+)/(part_\d+)", u).groups() not in done]
    total, status = {}, {}
    for r in done.values():
        add(total, {"seen": r["seen"], "kept": r["kept"]})
        add(status, r["oaStatus"])
    say("openalex", state="running", snapshot=manifest["date"], files=len(urls), filesDone=len(done))
    errors = []
    with multiprocessing.get_context("fork").Pool(OA_WORKERS, maxtasksperchild=20) as pool:
        for item, r in pool.imap_unordered(oa_file, jobs):
            if "error" in r:
                errors.append(f"{item}: {r['error']}")
            else:
                done[item] = r
                add(total, {"seen": r["seen"], "kept": r["kept"]})
                add(status, r["oaStatus"])
            say("openalex", state="running", snapshot=manifest["date"], files=len(urls), filesDone=len(done), errors=errors[-5:], **total, oaStatus=status)
    if errors:
        raise RuntimeError(f"{len(errors)} files failed: {errors[0]}")
    say("openalex", state="done", snapshot=manifest["date"], files=len(urls), filesDone=len(done), **total, oaStatus=status)


# CourtListener


CL_URL = "https://com-courtlistener-storage.s3.us-west-2.amazonaws.com/bulk-data/"
CL_SNAPSHOT = "2026-09-30"
CL_CLUSTER = ["id", "date_filed", "date_filed_is_approximate", "case_name", "case_name_short", "case_name_full", "judges", "slug", "scdb_id", "source", "procedural_history", "nature_of_suit", "posture", "syllabus", "headnotes", "summary", "disposition", "history", "citation_count", "precedential_status", "docket_id", "date_modified", "blocked"]
CL_OPINION = ["id", "cluster_id", "type", "author_str", "per_curiam", "joined_by_str", "page_count", "download_url", "local_path", "sha1", "extracted_by_ocr", "date_modified", "plain_text", "html", "html_with_citations"]
CL_PART_BYTES = 512 * 1024 * 1024


def cl_rows(name, limit=0):
    """Stream one bulk CSV. Postgres wrote it with backslash escapes, and fields can run to many megabytes."""
    csv.field_size_limit(2 ** 31 - 1)
    url = f"{CL_URL}{name}-{CL_SNAPSHOT}.csv.bz2"
    # No curl --retry: a retry mid-stream would repeat the file on stdout. A broken stream fails the lane, and it resumes.
    cmd = f"set -o pipefail; curl -sSfL --speed-limit 1000 --speed-time 600 {url} | /opt/muse/venv/bin/ibzip2 -dc -P 12"
    proc = subprocess.Popen(["bash", "-c", cmd], stdout=subprocess.PIPE)
    text = io.TextIOWrapper(proc.stdout, encoding="utf8", errors="replace", newline="")
    reader = csv.reader(text, escapechar="\\", doublequote=False)
    header = next(reader)
    count = 0
    for row in reader:
        count += 1
        yield count, dict(zip(header, row))
        if limit and count >= limit:
            proc.kill()
            proc.wait()
            return
    proc.wait()
    if proc.returncode != 0:
        raise IOError(f"{name}: stream ended with exit code {proc.returncode} after {count} rows")


def cl_part(rows, columns, name):
    import pyarrow as pa
    import pyarrow.parquet as pq
    table = pa.table({c: pa.array([r.get(c) or None for r in rows], type=pa.string()) for c in columns})
    os.makedirs(TMP, exist_ok=True)
    path = f"{TMP}/{name.replace('/', '-')}"
    pq.write_table(table, path, compression="zstd", row_group_size=max(len(rows), 1))
    upload(path, f"courtlistener/{name}")


def courtlistener_lane(a):
    import pyarrow.parquet as pq
    put_json("courtlistener/MANIFEST.json", {
        "dataset": "CourtListener opinions with date_filed from 2026-01-04 to 2026-10-29",
        "source": f"s3://com-courtlistener-storage/bulk-data/ (snapshot {CL_SNAPSHOT}, https://www.courtlistener.com/help/api/bulk-data/)",
        "license": "Public Domain Mark on the bulk files. Free Law Project is the source.",
        "selection": "date_filed is on the opinion cluster, so clusters are filtered first and opinions joined on cluster_id. The snapshot stops at Sept 30, 2026. Dockets are not read, so court comes from a later join on docket_id.",
        "privacy": "Opinions name parties. The attorneys column is dropped; blocked marks rows CourtListener hides from search engines. Plan rule: no private individuals from court records, so filter before building facts.",
        "format": "clusters.parquet and opinions/part-*.parquet (zstd), all columns as strings.",
        "note": PRIVATE,
    })
    limit = a.sample or 0
    done = progress("courtlistener")
    clusters = {}
    if "clusters" in done:
        table = pq.read_table(_local_copy("courtlistener/clusters.parquet"), columns=["id", "date_filed", "case_name"])
        clusters = {int(i): (d, c) for i, d, c in zip(*[table.column(n).to_pylist() for n in ("id", "date_filed", "case_name")])}
    else:
        rows, count = [], 0
        say("courtlistener", state="running", step="clusters")
        for count, row in cl_rows("opinion-clusters", 0):
            if START <= row.get("date_filed", "") <= END:
                rows.append(row)
            if count % 1000000 == 0:
                say("courtlistener", state="running", step="clusters", clustersScanned=count, clustersKept=len(rows))
        cl_part(rows, CL_CLUSTER, "clusters.parquet")
        clusters = {int(r["id"]): (r["date_filed"], r["case_name"]) for r in rows}
        mark("courtlistener", "clusters", {"scanned": count, "kept": len(rows)})
        done["clusters"] = {"scanned": count, "kept": len(rows)}
    state = done.get("opinions", {"rows": 0, "parts": 0, "kept": 0, "complete": False})
    if not state.get("complete"):
        buffer, size, last = [], 0, 0
        extra = ["date_filed", "case_name"]
        def flush(rows_read):
            nonlocal buffer, size
            cl_part(buffer, CL_OPINION + extra, f"opinions/part-{state['parts']:05d}.parquet")
            state.update(rows=rows_read, parts=state["parts"] + 1, kept=state["kept"] + len(buffer))
            mark("courtlistener", "opinions", state)
            buffer, size = [], 0
        for count, row in cl_rows("opinions", limit):
            last = count
            if count <= state["rows"]:
                continue
            hit = clusters.get(int(row["cluster_id"])) if row.get("cluster_id", "").isdigit() else None
            if hit:
                row["date_filed"], row["case_name"] = hit
                buffer.append({c: row.get(c) for c in CL_OPINION + extra})
                size += sum(len(row.get(c) or "") for c in ("plain_text", "html", "html_with_citations"))
            if buffer and (size >= CL_PART_BYTES or count % 2000000 == 0):
                flush(count)
            if count % 500000 == 0:
                say("courtlistener", state="running", step="opinions", clustersKept=len(clusters), opinionsScanned=count, opinionsKept=state["kept"] + len(buffer))
        if buffer:
            flush(last)
        state.update(rows=last, complete=not limit)
        mark("courtlistener", "opinions", state)
    say("courtlistener", state="done" if state.get("complete") else "sampled", clustersKept=len(clusters), opinionsScanned=state["rows"], opinionsKept=state["kept"], parts=state["parts"])


def _local_copy(key):
    os.makedirs(TMP, exist_ok=True)
    path = f"{TMP}/copy-{key.replace('/', '-')}"
    s3().download_file(BUCKET, f"{ROOT}/{key}", path)
    return path


# arXiv


OAI = "https://oaipmh.arxiv.org/oai"
OAI_GAP = 5
ARXIV_WORKERS = 8
ARXIV_KEEP = (("creativecommons.org/licenses/by/", "cc-by"), ("creativecommons.org/licenses/by-sa/", "cc-by-sa"), ("creativecommons.org/publicdomain/zero/", "cc0"))
OAI_NS = {"o": "http://www.openarchives.org/OAI/2.0/", "a": "http://arxiv.org/OAI/arXiv/"}
arxiv_allowed = {}


def oai_get(params):
    """One request at a time, five seconds apart (arXiv asks for at least three), honoring Retry-After."""
    url = OAI + "?" + urllib.parse.urlencode(params)
    for attempt in range(8):
        time.sleep(OAI_GAP)
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=180).read()
        except urllib.error.HTTPError as err:
            if err.code not in (429, 503) or attempt == 7:
                raise
            time.sleep(int(err.headers.get("Retry-After") or 0) or 60 * (attempt + 1))
        except urllib.error.URLError:
            if attempt == 7:
                raise
            time.sleep(60)


def arxiv_code(url):
    for piece, code in ARXIV_KEEP:
        if piece in (url or ""):
            return code
    return None


def arxiv_month(month, pages=0):
    """(id, license url, created) for every 26xx paper whose record changed in this month, one OAI list at a time."""
    start = f"{month}-01"
    year, mo = int(month[:4]), int(month[5:])
    until = f"{year + mo // 12}-{mo % 12 + 1:02d}-01"
    params = {"verb": "ListRecords", "metadataPrefix": "arXiv", "from": start, "until": until}
    records, count = [], 0
    while params:
        root = ET.fromstring(oai_get(params))
        error = root.find("o:error", OAI_NS)
        if error is not None:
            if error.get("code") == "noRecordsMatch":
                break
            raise IOError(f"OAI error {error.get('code')}: {error.text}")
        for rec in root.iterfind("o:ListRecords/o:record", OAI_NS):
            meta = rec.find("o:metadata/a:arXiv", OAI_NS)
            if meta is None:
                continue
            paper = meta.findtext("a:id", "", OAI_NS)
            if re.match(r"26\d\d\.\d+", paper):
                records.append({"id": paper, "license": meta.findtext("a:license", None, OAI_NS), "created": meta.findtext("a:created", None, OAI_NS)})
        count += 1
        token = root.findtext("o:ListRecords/o:resumptionToken", "", OAI_NS).strip()
        params = {"verb": "ListRecords", "resumptionToken": token} if token and not (pages and count >= pages) else None
        if count % 20 == 0:
            print(json.dumps({"oaiMonth": month, "pages": count, "records": len(records)}), flush=True)
    return records


def arxiv_tar(name):
    item = os.path.basename(name)[:-4]
    try:
        counts, licenses = {"papers": 0, "other_license": 0, "pdf_only": 0, "kept": 0, "no_tex": 0}, {}
        body = s3().get_object(Bucket="arxiv", Key=name, RequestPayer="requester")["Body"]
        shards = Shards("arxiv", item)
        with tarfile.open(fileobj=body, mode="r|") as tar:
            for m in tar:
                base = os.path.basename(m.name)
                match = re.match(r"(\d{4}\.\d+)", base)
                if not m.isfile() or not match:
                    continue
                counts["papers"] += 1
                paper = arxiv_allowed.get(match.group(1))
                if not paper:
                    counts["other_license"] += 1
                    continue
                if base.endswith(".pdf"):
                    counts["pdf_only"] += 1
                    continue
                tex = arxiv_tex(tar.extractfile(m).read())
                if not tex:
                    counts["no_tex"] += 1
                    continue
                code = arxiv_code(paper["license"])
                shards.write(code, {"id": match.group(1), "license": paper["license"], "license_code": code, "created": paper["created"], "tex": tex, "source_tar": name})
                counts["kept"] += 1
                licenses[code] = licenses.get(code, 0) + 1
        shards.close()
        result = {**counts, "licenses": licenses}
        mark("arxiv", item, result)
        return item, result
    except Exception as err:
        return item, {"error": repr(err)[:300]}


def arxiv_tex(blob):
    """A paper's member is a gzip of either one TeX file or a tar of the source tree. Text only; figures are dropped."""
    try:
        raw = gzip.decompress(blob)
    except OSError:
        return None
    try:
        out = {}
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as inner:
            for m in inner:
                if m.isfile() and m.name.lower().endswith((".tex", ".ltx", ".bbl")) and m.size < 20 * 1024 * 1024:
                    out[m.name] = inner.extractfile(m).read().decode("utf8", "replace")
        return out
    except tarfile.TarError:
        return {"main.tex": raw.decode("utf8", "replace")} if raw[:4] != b"%PDF" else None


def arxiv_lane(a):
    put_json("arxiv/MANIFEST.json", {
        "dataset": "arXiv LaTeX source for 2026 papers whose metadata license is CC BY, CC BY-SA or CC0",
        "source": "s3://arxiv/src/ (requester pays), license field from https://oaipmh.arxiv.org/oai (metadataPrefix=arXiv)",
        "license": "Per paper: the folder is the license code and each record holds arXiv's license URL. Papers under arXiv's default license and CC NC or ND are not copied.",
        "selection": "Papers with 26xx identifiers in the monthly tars. PDF-only submissions are counted, not parsed. Figures are dropped. _licenses/ holds id, license and created date for every 26xx paper, CC0 metadata.",
        "note": PRIVATE,
    })
    done = progress("arxiv-licenses")
    months = [f"2026-{m:02d}" for m in range(1, int(time.strftime("%m")) + 1)]
    if a.sample:
        months = months[:1]
    say("arxiv", state="running", step="licenses", monthsDone=len(done), months=len(months))
    for month in months:
        if month in done:
            continue
        records = arxiv_month(month, pages=a.sample or 0)
        put(f"arxiv/_licenses/{month}.jsonl.gz", gzip.compress("".join(json.dumps(r) + "\n" for r in records).encode()))
        mark("arxiv-licenses", month, {"records": len(records)})
        done[month] = {"records": len(records)}
        say("arxiv", state="running", step="licenses", monthsDone=len(done), months=len(months), recordsSoFar=sum(d["records"] for d in done.values()))
    # A paper changed twice appears under both months; the later month has its current license.
    papers = {}
    for month in months:
        body = s3().get_object(Bucket=BUCKET, Key=f"{ROOT}/arxiv/_licenses/{month}.jsonl.gz")["Body"].read()
        for line in gzip.decompress(body).decode().splitlines():
            r = json.loads(line)
            papers[r["id"]] = r
    license_counts = {}
    for r in papers.values():
        k = r["license"] or "none"
        license_counts[k] = license_counts.get(k, 0) + 1
    global arxiv_allowed
    arxiv_allowed = {k: v for k, v in papers.items() if arxiv_code(v["license"])}
    manifest = s3().get_object(Bucket="arxiv", Key="src/arXiv_src_manifest.xml", RequestPayer="requester")["Body"].read().decode()
    names = sorted(re.findall(r"<filename>(src/arXiv_src_26\d\d_\d+\.tar)</filename>", manifest))
    if a.sample:
        names = names[:1]
    finished = progress("arxiv")
    jobs = [n for n in names if os.path.basename(n)[:-4] not in finished]
    counts, licenses = {}, {}
    def tally(r):
        add(counts, {k: v for k, v in r.items() if k != "licenses"})
        add(licenses, r["licenses"])
    for r in finished.values():
        tally(r)
    base = dict(step="tars", tars=len(names), paperLicenses=license_counts, eligible=len(arxiv_allowed))
    say("arxiv", state="running", tarsDone=len(finished), **base)
    errors = []
    with multiprocessing.get_context("fork").Pool(ARXIV_WORKERS) as pool:
        for item, r in pool.imap_unordered(arxiv_tar, jobs):
            if "error" in r:
                errors.append(f"{item}: {r['error']}")
            else:
                finished[item] = r
                tally(r)
            say("arxiv", state="running", tarsDone=len(finished), errors=errors[-5:], **counts, keptByLicense=licenses, **base)
    if errors:
        raise RuntimeError(f"{len(errors)} tars failed: {errors[0]}")
    say("arxiv", state="done", tarsDone=len(finished), **counts, keptByLicense=licenses, **base)


# bioRxiv and medRxiv


RXIV_BATCH = 500
RXIV_THREADS = 24
RXIV_MONTHS = "January February March April May June July August September October November December".split()


class RangeFile(io.RawIOBase):
    """Just enough of a seekable file over S3 ranges for zipfile, so a paper's figures and PDF are never downloaded."""

    def __init__(self, bucket, key, size):
        self.bucket, self.key, self.size, self.pos = bucket, key, size, 0
        self.block, self.block_start = b"", 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        if not (self.block_start <= self.pos and self.pos + n <= self.block_start + len(self.block)):
            start, end = self.pos, min(self.size, self.pos + max(n, 256 * 1024))
            self.block = s3().get_object(Bucket=self.bucket, Key=self.key, Range=f"bytes={start}-{end - 1}", RequestPayer="requester")["Body"].read()
            self.block_start = start
        out = self.block[self.pos - self.block_start:self.pos - self.block_start + n]
        self.pos += len(out)
        return out

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


def rxiv_license(jats):
    block = re.search(r"<permissions>.*?</permissions>", jats, re.S)
    block = block.group(0) if block else ""
    license_tag = re.search(r"<license\b[^>]*>", block)
    url = re.search(r'href="([^"]+)"', license_tag.group(0)).group(1) if license_tag and 'href="' in license_tag.group(0) else None
    text = re.sub(r"<[^>]+>", " ", re.search(r"<license\b.*?</license>", block, re.S).group(0)) if license_tag and "</license>" in block else ""
    text = re.sub(r"\s+", " ", text).strip()
    hay = (url or "").lower() + " " + text.lower()
    found = re.search(r"licenses/(by(?:-[a-z]{2})*)/", hay)
    if found:
        code = "cc-" + found.group(1)
    elif "publicdomain/zero" in hay or "cc0" in hay:
        code = "cc0"
    elif "no reuse" in hay or "all rights reserved" in hay or "granted biorxiv a license" in hay or "granted medrxiv a license" in hay or "the copyright holder" in hay:
        code = "no-reuse"
    else:
        code = "unknown"
    return code, url, text[:1000]


def rxiv_paper(bucket, key, size):
    with zipfile.ZipFile(io.BufferedReader(RangeFile(bucket, key, size), 256 * 1024)) as z:
        names = [i for i in z.infolist() if i.filename.startswith("content/") and i.filename.lower().endswith(".xml")]
        if not names:
            return None
        jats = z.read(max(names, key=lambda i: i.file_size)).decode("utf8", "replace")
    title = re.search(r"<article-title[^>]*>(.*?)</article-title>", jats, re.S)
    doi = re.search(r'<article-id pub-id-type="doi">([^<]+)<', jats)
    code, url, text = rxiv_license(jats)
    return code, {
        "key": key, "doi": doi.group(1) if doi else None, "title": re.sub(r"<[^>]+>", "", title.group(1)).strip() if title else None,
        "version": (re.search(r'<article-version[^>]*>([^<]+)<', jats) or [None, None])[1],
        "license_code": code, "license_url": url, "license_text": text, "jats": jats,
    }


def rxiv_batch(lane, bucket, item, objects):
    shards = Shards(lane, item)
    counts, licenses, failed = {"papers": 0, "kept": 0, "no_jats": 0}, {}, []
    write = threading.Lock()

    def one(obj):
        try:
            r = rxiv_paper(bucket, obj["Key"], obj["Size"])
        except Exception as err:
            failed.append(f"{obj['Key']}: {str(err)[:120]}")
            return
        with write:
            counts["papers"] += 1
            if r is None:
                counts["no_jats"] += 1
                return
            shards.write(r[0], r[1])
            counts["kept"] += 1
            licenses[r[0]] = licenses.get(r[0], 0) + 1

    with ThreadPoolExecutor(RXIV_THREADS) as pool:
        list(pool.map(one, objects))
    shards.close()
    if len(failed) > 10:
        raise IOError(f"{item}: {len(failed)} failures, first: {failed[0]}")
    result = {**counts, "licenses": licenses, "failed": failed}
    mark(lane, item, result)
    return result


def rxiv_lane(lane, a):
    bucket = f"{lane}-src-monthly"
    put_json(f"{lane}/MANIFEST.json", {
        "dataset": f"{lane} JATS XML for papers deposited in 2026",
        "source": f"s3://{bucket}/Current_Content/<Month>_2026/ (requester pays)",
        "license": "Per paper, from the license block in that paper's own JATS: the folder is the code. no-reuse means the authors kept their rights and granted only the preprint server a license; unknown means the JATS gave no clear answer. Only CC BY and CC0 can ever go public.",
        "selection": "Monthly deposit folders for 2026 (October's folder doesn't exist yet). Each deposit is one version, so a paper can appear more than once. Figures and PDFs are not read.",
        "note": PRIVATE,
    })
    months = [f"{m}_2026" for m in RXIV_MONTHS]
    jobs = []
    for month in months:
        objects = []
        for page in s3().get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=f"Current_Content/{month}/", RequestPayer="requester"):
            objects += [{"Key": o["Key"], "Size": o["Size"]} for o in page.get("Contents", []) if o["Key"].endswith(".meca")]
        jobs += [(f"{month}-{i // RXIV_BATCH:04d}", objects[i:i + RXIV_BATCH]) for i in range(0, len(objects), RXIV_BATCH)]
    if a.sample:
        jobs = [(jobs[0][0], jobs[0][1][:a.sample])]
    done = progress(lane)
    counts, licenses = {}, {}
    for r in done.values():
        add(counts, {k: r[k] for k in ("papers", "kept", "no_jats")})
        add(licenses, r["licenses"])
    errors = []
    say(lane, state="running", batches=len(jobs), batchesDone=len(done))
    for item, objects in jobs:
        if item in done:
            continue
        try:
            r = rxiv_batch(lane, bucket, item, objects)
        except Exception as err:
            errors.append(f"{item}: {str(err)[:300]}")
            continue
        done[item] = r
        add(counts, {k: r[k] for k in ("papers", "kept", "no_jats")})
        add(licenses, r["licenses"])
        say(lane, state="running", batches=len(jobs), batchesDone=len(done), errors=errors[-5:], **counts, keptByLicense=licenses)
    if errors:
        raise RuntimeError(f"{len(errors)} batches failed: {errors[0]}")
    say(lane, state="done", batches=len(jobs), batchesDone=len(done), **counts, keptByLicense=licenses)


# PubMed


PUBMED_CREDIT = "Courtesy of the U.S. National Library of Medicine. This product uses publicly available data from the U.S. National Library of Medicine (NLM). NLM does not endorse or recommend any products or services."
PUBMED_CURRENCY = "This data does not reflect the most current or accurate data available from NLM; it is a snapshot of PubMed baseline and daily update files."


def pubmed_parse(stream, source):
    """Records with a 2026 article or journal date, plus the PMIDs this file deletes. The source file number makes last write win."""
    records, deleted = [], []
    for _, el in ET.iterparse(stream):
        if el.tag == "DeleteCitation":
            deleted += [p.text for p in el.iter("PMID")]
        if el.tag != "PubmedArticle":
            continue
        cite = el.find("MedlineCitation")
        art = cite.find("Article")
        dates = [d.findtext("Year") for d in art.findall("ArticleDate")]
        pub = art.find("Journal/JournalIssue/PubDate")
        dates.append(pub.findtext("Year") or pub.findtext("MedlineDate", "")[:4])
        if "2026" in dates:
            ids = {i.get("IdType"): i.text for i in el.findall("PubmedData/ArticleIdList/ArticleId")}
            mesh = [{"descriptor": h.findtext("DescriptorName"), "ui": h.find("DescriptorName").get("UI"), "major": h.find("DescriptorName").get("MajorTopicYN") == "Y", "qualifiers": [q.text for q in h.findall("QualifierName")]} for h in cite.findall("MeshHeadingList/MeshHeading")]
            printed = " ".join(x.strip() for x in pub.itertext() if x.strip())
            records.append({
                "pmid": cite.findtext("PMID"), "version": cite.find("PMID").get("Version"), "doi": ids.get("doi"), "pmcid": ids.get("pmc"),
                "title": "".join(art.find("ArticleTitle").itertext()) if art.find("ArticleTitle") is not None else None,
                "abstract": "\n".join("".join(a.itertext()) for a in art.findall("Abstract/AbstractText")) or None,
                "journal": art.findtext("Journal/Title"), "journal_iso": art.findtext("Journal/ISOAbbreviation"), "pub_date": printed,
                "article_dates": [dict(zip(("year", "month", "day"), (d.findtext("Year"), d.findtext("Month"), d.findtext("Day")))) for d in art.findall("ArticleDate")],
                "languages": [x.text for x in art.findall("Language")], "publication_types": [x.text for x in art.findall("PublicationTypeList/PublicationType")],
                "mesh": mesh, "source_file": source,
            })
        el.clear()
    return records, deleted


def pubmed_lane(a):
    import pyarrow as pa
    import pyarrow.parquet as pq
    put_json("pubmed/MANIFEST.json", {
        "dataset": "PubMed citations with 2026 dates: metadata and MeSH",
        "source": "ftp://ftp.ncbi.nlm.nih.gov/pubmed/ (baseline pubmed26n0001 to n1334 and daily update files)",
        "license": "NLM terms: https://www.nlm.nih.gov/databases/download/terms_and_conditions.html. Metadata and MeSH publishable with the credit below. Abstracts may be copyrighted: training-only.",
        "credit": PUBMED_CREDIT,
        "currency": PUBMED_CURRENCY,
        "selection": "One part per input file. Later files revise earlier ones: keep the row with the highest source_file per pmid, and remove pmids in deleted/.",
        "note": PRIVATE,
    })
    if a.fixture:
        records, deleted = pubmed_parse(gzip.open(a.fixture), "fixture")
        print(json.dumps({"records": records, "deleted": deleted}, indent=1)[:3000])
        return
    ftp = ftplib.FTP("ftp.ncbi.nlm.nih.gov", timeout=300)
    ftp.login("anonymous", a.pubmed_email)
    names = []
    for folder in ("baseline", "updatefiles"):
        names += [f"pubmed/{folder}/{os.path.basename(n)}" for n in sorted(ftp.nlst(f"pubmed/{folder}")) if n.endswith(".xml.gz")]
    if a.sample:
        names = names[-a.sample:]
    done = progress("pubmed")
    kept = sum(r["kept"] for r in done.values())
    os.makedirs(TMP, exist_ok=True)
    for name in names:
        item = os.path.basename(name)[:-7]
        if item in done:
            continue
        path = f"{TMP}/{item}.xml.gz"
        with open(path, "wb") as f:
            ftp.retrbinary(f"RETR {name}", f.write)
        records, deleted = pubmed_parse(gzip.open(path), item)
        os.remove(path)
        if records:
            part = f"{TMP}/{item}.parquet"
            pq.write_table(pa.Table.from_pylist(records), part, compression="zstd")
            upload(part, f"pubmed/{item}.parquet")
        if deleted:
            put(f"pubmed/deleted/{item}.json", json.dumps(deleted).encode())
        mark("pubmed", item, {"kept": len(records), "deleted": len(deleted)})
        done[item] = {"kept": len(records)}
        kept += len(records)
        say("pubmed", state="running", files=len(names), filesDone=len(done), kept=kept)
    say("pubmed", state="done", files=len(names), filesDone=len(done), kept=kept)


# The supervisor


def merge_status(supervisor):
    lanes = {}
    for lane in LANES + ["pubmed"]:
        lanes[lane] = get_json(f"_status/{lane}.json") or {"state": "not started"}
        if lane in supervisor:
            lanes[lane]["supervisor"] = supervisor[lane]
    put_json("status.json", {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "lanes": lanes})


def upload_logs():
    for name in os.listdir(LOGS) if os.path.isdir(LOGS) else []:
        s3().upload_file(f"{LOGS}/{name}", BUCKET, f"{ROOT}/_logs/{name}")


def supervise(a):
    """Each lane runs in its own process and gets a few restarts; a lane that keeps failing doesn't touch the others."""
    os.makedirs(LOGS, exist_ok=True)
    lanes = list(LANES)
    supervisor = {lane: {"tries": 0} for lane in lanes}
    if a.pubmed_email:
        lanes.append("pubmed")
        supervisor["pubmed"] = {"tries": 0}
    else:
        put_json("_status/pubmed.json", {"lane": "pubmed", "state": "skipped", "reason": "ftp.ncbi.nlm.nih.gov robots.txt is Disallow: / over HTTPS, and NLM's FTP asks for a valid email password. Awaiting the owner on both."})
    running = {}
    tick = 0
    while True:
        for lane in lanes:
            info = supervisor[lane]
            if lane in running and running[lane].poll() is not None:
                code = running.pop(lane).returncode
                info["lastExit"] = code
                info["state"] = "done" if code == 0 else "crashed"
            if lane not in running and info.get("state") != "done" and info["tries"] < 5 and time.time() >= info.get("next", 0):
                info["tries"] += 1
                info["next"] = time.time() + 120
                info["state"] = "running"
                log = open(f"{LOGS}/{lane}.log", "ab")
                cmd = [sys.executable, os.path.abspath(__file__), lane] + (["--pubmed-email", a.pubmed_email] if lane == "pubmed" else [])
                running[lane] = subprocess.Popen(cmd, stdout=log, stderr=log)
        merge_status(supervisor)
        if tick % 5 == 0:
            upload_logs()
        tick += 1
        if not running and all(supervisor[lane].get("state") == "done" or supervisor[lane]["tries"] >= 5 for lane in lanes):
            break
        time.sleep(60)
    merge_status(supervisor)
    upload_logs()
    if a.shutdown:
        subprocess.run(["shutdown", "-h", "now"])


def main():
    global ROOT, TMP
    p = argparse.ArgumentParser()
    p.add_argument("lane", choices=LANES + ["pubmed", "all"])
    p.add_argument("--sample", type=int, default=0)
    p.add_argument("--out")
    p.add_argument("--shutdown", action="store_true")
    p.add_argument("--pubmed-email")
    p.add_argument("--fixture")
    a = p.parse_args()
    if a.sample and not a.out:
        sys.exit("a sample must go under --out so it can't be mistaken for the real thing")
    if a.out:
        ROOT = a.out
        TMP = f"{TMP}/{a.lane}-sample"
    try:
        if a.lane == "all":
            supervise(a)
        elif a.lane == "pmc":
            pmc_lane(a)
        elif a.lane == "openalex":
            openalex_lane(a)
        elif a.lane == "courtlistener":
            courtlistener_lane(a)
        elif a.lane == "arxiv":
            arxiv_lane(a)
        elif a.lane in ("biorxiv", "medrxiv"):
            rxiv_lane(a.lane, a)
        elif a.lane == "pubmed":
            pubmed_lane(a)
    except Exception as err:
        traceback.print_exc()
        say(a.lane, state="failed", error=repr(err)[:500])
        sys.exit(1)
    finally:
        if a.out:
            shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    main()
