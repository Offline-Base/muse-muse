"""Reads a seeded sample of one S3 news set and writes filtered candidates (not yet robots-checked) as JSONL.

    python -I read_set.py SET OUT_DIR [--rgs N]    SET: ccnews, infini, fine, plus, forecast

Only ranged reads: Parquet row groups or the first bytes of a .jsonl.gz, so the Mac pulls a small part of each set.
"""

import argparse
import collections
import concurrent.futures
import json
import os
import random
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pyarrow.parquet as pq  # noqa: E402

import news_common as C  # noqa: E402
from s3io import BUCKET, RangedFile, count, list_objects, pulled, s3  # noqa: E402

SEED = 20261030
THREADS = 6


def emit(out, stats, *, set_name, url, title, text, language, source_words, published, crawl, needs_proof, date_field, extra=None):
    got = C.judge(url=url, title=title, full_text=text, language=language, source_words=source_words, stats=stats, published=published, crawl=crawl, needs_proof=needs_proof)
    if not got:
        return
    t, passage, iso = got
    out.append({"set": set_name, "url": url, "domain": C.domain_of(url), "title": t, "date": iso, "language": language, "text": passage, "source_words": source_words, "date_field": date_field, "crawl": str(crawl)[:19], **(extra or {})})


def read_ccnews(args, rng):
    tasks = []
    for month in range(1, 11):
        objs = [o for o in list_objects(f"knowledge/news/ccnews/2026-{month:02d}/") if o[0].endswith(".parquet")]
        objs.sort()
        rng.shuffle(objs)
        n = args.rgs * (4 if month >= 9 else 1)
        for key, size in objs[:n]:
            tasks.append((key, size, rng.random()))
    cols = ["url", "domain", "title", "text", "language", "published", "date_source", "fetch_time", "words", "optout_noai_meta", "optout_tdm_meta", "optout_tdm_header", "optout_noai_header", "optout_usage_header"]

    def one(task):
        key, size, r = task
        out, stats = [], collections.Counter()
        pf = pq.ParquetFile(RangedFile(key, size))
        rg = int(r * pf.metadata.num_row_groups)
        for row in pf.read_row_group(rg, columns=cols).to_pylist():
            stats["rows_read"] += 1
            if any(row[k] for k in ("optout_noai_meta", "optout_tdm_meta", "optout_tdm_header", "optout_noai_header", "optout_usage_header")):
                stats["optout_flag"] += 1
                continue
            if row["date_source"] not in ("article:published_time", "json-ld"):
                stats["date_source_htmldate"] += 1
                continue
            emit(out, stats, set_name="ccnews", url=row["url"], title=row["title"], text=row["text"] or "", language=row["language"], source_words=row["words"], published=row["published"], crawl=row["fetch_time"], needs_proof=False, date_field=row["date_source"])
        return out, stats

    return tasks, one


def read_infini(args, rng):
    tasks = []
    for month in range(1, 5):
        objs = [o for o in list_objects(f"knowledge/raw/news/infini-news/data/year=2026/month={month:02d}/") if o[0].endswith(".parquet")]
        objs.sort()
        rng.shuffle(objs)
        tasks += objs[: args.rgs]
    cols = ["url", "title", "text", "publish_date", "warc_date", "language", "language_short", "language_iso639_3", "language_score"]

    def one(task):
        out, stats = [], collections.Counter()
        for row in pq.ParquetFile(RangedFile(*task)).read(columns=cols).to_pylist():
            stats["rows_read"] += 1
            lang = (row["language"] or "").lower().split("_")[0].split("-")[0]
            lang = {"eng": "en", "spa": "es", "fra": "fr", "deu": "de", "ita": "it", "por": "pt", "nld": "nl", "rus": "ru", "tur": "tr", "ind": "id", "pol": "pl", "ara": "ar", "arb": "ar", "hin": "hi"}.get(lang, lang)
            emit(out, stats, set_name="infini", url=row["url"] or "", title=row["title"], text=row["text"] or "", language=lang, source_words=C.words(row["text"] or ""), published=row["publish_date"], crawl=row["warc_date"], needs_proof=True, date_field="publish_date")
        return out, stats

    return tasks, one


FINE_LANGS = {"eng_Latn": "en", "spa_Latn": "es", "fra_Latn": "fr", "deu_Latn": "de", "ita_Latn": "it", "por_Latn": "pt", "rus_Cyrl": "ru", "tur_Latn": "tr"}


def read_fine(args, rng):
    tasks = []
    for month in range(1, 5):
        for label, lang in FINE_LANGS.items():
            for key, size in sorted(o for o in list_objects(f"knowledge/raw/fine-news/data/2026-{month:02d}/{label}/") if o[0].endswith(".parquet")):
                n = args.rgs if lang == "en" else 1
                tasks += [(key, size, lang, rng.random()) for _ in range(n)]
    fields = ["url", "title", "publish_date", "warc_date", "publication_status"]
    cols = ["text"] + [f"metadata.{f}" for f in fields]

    def one(task):
        key, size, lang, r = task
        out, stats = [], collections.Counter()
        pf = pq.ParquetFile(RangedFile(key, size))
        rg = int(r * pf.metadata.num_row_groups)
        for row in pf.read_row_group(rg, columns=cols).to_pylist():
            stats["rows_read"] += 1
            m = row["metadata"]
            if m["publication_status"] != "not_after_capture":
                stats["publication_status_not_ok"] += 1
                continue
            emit(out, stats, set_name="fine", url=m["url"] or "", title=m["title"], text=row["text"] or "", language=lang, source_words=C.words(row["text"] or ""), published=m["publish_date"], crawl=m["warc_date"], needs_proof=True, date_field="metadata.publish_date")
        return out, stats

    return tasks, one


def read_forecast(args, rng):
    objs = sorted(o for o in list_objects("knowledge/raw/forecast-news/2026/") if o[0].endswith(".parquet"))
    by_month = collections.defaultdict(list)
    for o in objs:
        by_month[o[0].split("/")[4]].append(o)
    tasks = []
    for m in sorted(by_month):
        rng.shuffle(by_month[m])
        tasks += by_month[m][: args.rgs]

    def one(task):
        out, stats = [], collections.Counter()
        folder = "-".join(task[0].split("/")[3:6])
        for row in pq.ParquetFile(RangedFile(*task)).read(columns=["title", "date_publish", "url", "content"]).to_pylist():
            stats["rows_read"] += 1
            text = row["content"] or ""
            lang = "en" if C.looks_english(text[:2000]) else "other"
            emit(out, stats, set_name="forecast", url=row["url"] or "", title=row["title"], text=text, language=lang, source_words=C.words(text), published=row["date_publish"], crawl=folder, needs_proof=False, date_field="date_publish")
        return out, stats

    return tasks, one


def read_plus(args, rng):
    tasks = []
    for month in range(1, 9):
        objs = [o for o in list_objects(f"knowledge/raw/ccnews-plus/2026_{month:02d}/") if o[0].endswith(".jsonl.gz")]
        objs.sort()
        rng.shuffle(objs)
        tasks += objs[: args.rgs]

    def one(task):
        key, size = task
        out, stats = [], collections.Counter()
        n = min(size, 4 * 1024 * 1024)
        body = s3.get_object(Bucket=BUCKET, Key=key, Range=f"bytes=0-{n - 1}")["Body"].read()
        count(len(body))
        data = zlib.decompressobj(31).decompress(body)
        lines = data.split(b"\n")
        if n < size:
            lines = lines[:-1]
        for line in lines:
            if not line.strip():
                continue
            stats["rows_read"] += 1
            row = json.loads(line)
            m = row["metadata"]
            emit(out, stats, set_name="plus", url=m.get("url") or "", title=m.get("title"), text=row.get("text") or "", language="en", source_words=C.words(row.get("text") or ""), published=m.get("date"), crawl=m.get("warc_date"), needs_proof=True, date_field="metadata.date")
        return out, stats

    return tasks, one


def main():
    p = argparse.ArgumentParser()
    p.add_argument("set", choices=["ccnews", "infini", "fine", "plus", "forecast"])
    p.add_argument("out")
    p.add_argument("--rgs", type=int, required=True, help="row groups, files or days per month")
    a = p.parse_args()
    rng = random.Random(SEED)
    tasks, one = {"ccnews": read_ccnews, "infini": read_infini, "fine": read_fine, "plus": read_plus, "forecast": read_forecast}[a.set](a, rng)
    os.makedirs(a.out, exist_ok=True)
    stats, rows = collections.Counter(), []
    with concurrent.futures.ThreadPoolExecutor(THREADS) as pool:
        for i, (out, st) in enumerate(pool.map(one, tasks)):
            rows += out
            stats.update(st)
            if i % 10 == 0:
                print(a.set, i, "/", len(tasks), "passed", stats["passed"], "pulled MB", pulled[0] // 2**20, flush=True)
    with open(f"{a.out}/{a.set}.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    json.dump({"stats": stats, "bytes": pulled[0], "tasks": len(tasks), "rgs": a.rgs}, open(f"{a.out}/{a.set}.stats.json", "w"), indent=1)
    print(a.set, "done", len(rows), "bytes", pulled[0], dict(stats.most_common(30)))


if __name__ == "__main__":
    main()
