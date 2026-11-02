#!/usr/bin/env python3
"""Checks training rows against the sealed hero test, standard library only. Exit 1 on any hit.

    python3 eval/hero/check_overlap.py train.json [eval/hero/sealed.jsonl]

train.json is a list of {"messages": [...]} rows. A hit is a sealed prompt or answer inside a row, a sealed person's full name, either
half of a sealed person's rare name pool (make_sealed.FIRST and LAST), a phone in the sealed range 555-0150 to 555-0199, or a sealed email.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_sealed import FIRST, LAST  # noqa: E402

PHONE = re.compile(r"555\D{0,3}01\D{0,2}([5-9]\d)(?!\d)")


def hits(text, words, sealed_texts, emails):
    found = []
    low = text.lower()
    for s in sealed_texts:
        if s in low:
            found.append("sealed text")
            break
    found += [w for w in re.findall(r"[a-z][a-z'-]+", low) if w in words]
    if PHONE.search(text):
        found.append("sealed phone range")
    found += [e for e in emails if e in low]
    return found


def main():
    train = json.load(open(sys.argv[1]))
    sealed = [json.loads(line) for line in open(sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "sealed.jsonl"))]
    words = {w.lower() for w in FIRST} | {p.lower() for n in LAST for p in [n] + n.split("-")}
    texts = []
    emails = set()
    for item in sealed:
        body = item["prompt"].split("\n\n", 1)[1].lower()
        texts.append(body)
        texts.append(item["reference"].lower())
        emails |= {p["value"].lower() for p in item["private"] if p["kind"] == "email"}
    bad = 0
    for i, row in enumerate(train):
        text = "\n".join(m["content"] for m in row["messages"])
        found = hits(text, words, texts, emails)
        if found:
            bad += 1
            print(i, sorted(set(found))[:5])
    print(json.dumps({"rows": len(train), "rows_with_hits": bad}))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
