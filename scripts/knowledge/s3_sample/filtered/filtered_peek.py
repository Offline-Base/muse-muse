"""Reconnaissance: prints the shape of a few rows from each raw set, so the writers filter on what is really there."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from filtered_common import ROOT, RangeFile, get_all, gz_head_lines, listing  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402


def peek_gz(prefix, n=3, mb=6):
    files = [o for o in listing(prefix) if o["key"].endswith(".gz")]
    o = files[len(files) // 2]
    print("FILE", o)
    for i, r in enumerate(gz_head_lines("peek", o["key"], o["size"], mb * 1024 * 1024)):
        if i >= n:
            break
        j = r.get("jats") or ""
        print({k: (v if k not in ("jats", "text", "license_text") else (v or "")[:150]) for k, v in r.items()})
        print("  ARTICLE", re.findall(r"<article\b[^>]*article-type=\"([^\"]*)\"", j)[:1])
        print("  PUBDATES", re.findall(r"<pub-date\b[^>]*>.*?</pub-date>", j, re.S)[:4])
        print("  HISTORY", re.findall(r"<history>.*?</history>", j, re.S)[:1])
        print("  ABS", (re.findall(r"<abstract\b.*?</abstract>", j, re.S) or [""])[0][:500])
        print("  DOI", re.findall(r'<article-id pub-id-type="doi">([^<]+)<', j)[:1])


for prefix in sys.argv[1:] or ["pmc", "bio", "oa", "cl"]:
    if prefix == "pmc":
        peek_gz(f"{ROOT}/pmc/CC-BY/")
    if prefix == "bio":
        peek_gz(f"{ROOT}/biorxiv/cc-by/")
        peek_gz(f"{ROOT}/medrxiv/cc-by/")
    if prefix == "oa":
        files = [o for o in listing(f"{ROOT}/openalex/") if o["key"].endswith(".parquet") and o["size"] > 3_000_000]
        print(len(files), "files over 3MB")
        o = files[len(files) // 2]
        pf = pq.ParquetFile(RangeFile("peek", o["key"], o["size"]))
        print(o, pf.metadata.num_rows, pf.metadata.num_row_groups)
        cols = ["id", "doi", "title", "publication_date", "language", "type", "venue", "publisher", "oa_status", "oa_license", "abstract", "is_retracted", "is_paratext", "created_date", "updated_date"]
        t = pf.read_row_group(0, columns=cols).slice(0, 2000).to_pylist()
        have = [r for r in t if r["abstract"]]
        print(len(t), "with abstract", len(have))
        for r in have[:6]:
            r["abstract"] = r["abstract"][:220]
            print(r)
    if prefix == "cl":
        o = next(x for x in listing(f"{ROOT}/courtlistener/") if x["key"].endswith("clusters.parquet"))
        pf = pq.ParquetFile(RangeFile("peek", o["key"], o["size"]))
        print(pf.schema_arrow.names, pf.metadata.num_rows)
        for r in pf.read_row_group(0).slice(5000, 3).to_pylist():
            print({k: (v[:120] if isinstance(v, str) else v) for k, v in r.items()})
        parts = [x for x in listing(f"{ROOT}/courtlistener/opinions/")]
        o = parts[3]
        pf = pq.ParquetFile(RangeFile("peek", o["key"], o["size"]))
        md = pf.metadata
        print(o, md.num_rows, md.num_row_groups)
        for i in range(md.num_columns):
            c = md.row_group(0).column(i)
            print(c.path_in_schema, c.total_compressed_size)
