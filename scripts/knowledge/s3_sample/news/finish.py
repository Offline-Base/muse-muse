"""Last pass from reading the final sample, then writes the set files. python3 finish.py FROM_DIR TO_DIR"""
import json
import re
import sys

BAD = re.compile(r"ITALPRESS|Zonebourse|Get all the top news|Blog posted by")
for s in ["ccnews", "infini-news", "fine-news", "ccnews-plus", "forecast-news"]:
    rows = [json.loads(l) for l in open(f"{sys.argv[1]}/s3-{s}.jsonl")]
    keep = [r for r in rows if len(r["text"].split()) <= 210 and not BAD.search(r["text"]) and "wired-gov.net" not in r["url"] and "italpress.com" not in r["url"]]
    with open(f"{sys.argv[2]}/s3-{s}.jsonl", "w") as f:
        for r in keep:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(s, len(rows), "->", len(keep))
