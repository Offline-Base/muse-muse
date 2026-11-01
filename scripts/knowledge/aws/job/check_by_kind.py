"""Refuses a training set whose make-up is off its plan: the queue (job/queue_b2.sh) runs this before every launch.

Three checks, counts only (rows are read as JSON for their metadata, never printed; reasoning text is never looked at):
1. The set's report by_kind (report["set"]["by_kind"], or report["by_kind"]) against the plan's table: each table entry within
   --tol (default 2%) of its planned count, relative to that count. A table key may join kinds with "+", for the plan's
   combined rows ("false_premise+after_cutoff+unknowable"). A kind the report has and the table doesn't is a failure, as is a
   planned total the report misses.
2. The training file's own rows, counted by --key, against the report's by_kind, exactly: a report that doesn't describe the
   file it sits beside is no check at all.
3. The file's row count against the report's records, when the report gives one.
--key kind reads each row's "kind" field (assemble_stage_b.py's sets). --key dose_group counts the dose set's source groups
(dose_group() below, which make_dose_set.py also uses). Exit 0 only when all pass; the last line says PASS or FAIL.

  python3 check_by_kind.py --train DIR/train.jsonl --report DIR/report.json --table TABLE.json [--key kind] [--tol 0.02]

TABLE.json: {"by_kind": {"reasoning": 18000, ...}, "total": 60000} or the by_kind object alone. Standard library only.
"""

import argparse
import collections
import hashlib
import json
import re
import sys

FACT = re.compile(r"^(source|event|article):")
# The dose test's four groups (plan, "Dose test"), by source kind. Meta comes first, so its first-party AI sources stay Meta.
META = re.compile(r"^(meta-|gap-meta-|gap-hf-facebook|us-sec-meta|github-meta-)")
AI_FIRST_PARTY = re.compile(r"^(pytorch-blog|hf-card|gap-hf-|models-dev|sdk-changelog|epoch|lmarena|github-|anthropic-release-notes|google-ai-changelog)")
CCNEWS = re.compile(r"^s3-ccnews")
GROUPS = ("meta", "ai_first_party", "events", "ccnews")


def source_kind(source):
    """assemble-dataset.ts's group(): a record id's prefix for collected sources, else the passage kind (stage_b_lib.source_kind)."""
    return source.split(":")[1] if source.startswith("source:") else source.split(":")[0]


def dose_group(source):
    """The dose group of a stage 1 or stage 2 fact row's source (its passage id), or None for every other row."""
    if not FACT.match(source or ""):
        return None
    kind = source_kind(source)
    if META.match(kind):
        return "meta"
    if AI_FIRST_PARTY.match(kind):
        return "ai_first_party"
    if kind == "event":
        return "events"
    if CCNEWS.match(kind):
        return "ccnews"
    return None


def count_file(path, key):
    counts, n, h = collections.Counter(), 0, hashlib.sha256()
    with open(path, "rb") as f:
        for line in f:
            h.update(line)
            if not line.strip():
                continue
            n += 1
            row = json.loads(line)
            counts[row.get("kind") if key == "kind" else dose_group(row.get("source") or "")] += 1
    return n, counts, h.hexdigest()


def check(by_kind, table, tol, file_counts=None, records=None, file_rows=None):
    """(ok, lines). Pure, so the queue's rule can be tested on its own."""
    lines, ok = [], True
    want = table.get("by_kind", table) if isinstance(table, dict) else {}
    total = table.get("total") if isinstance(table, dict) and "by_kind" in table else None
    covered = set()
    for key, planned in want.items():
        kinds = key.split("+")
        covered.update(kinds)
        got = sum(by_kind.get(k, 0) for k in kinds)
        off = abs(got - planned) / max(planned, 1)
        good = off <= tol
        ok &= good
        lines.append(f"{'ok  ' if good else 'FAIL'} {key}: {got} against {planned} planned ({off:.1%} off, limit {tol:.0%})")
    for k, n in sorted(by_kind.items()):
        if k not in covered and n:
            ok = False
            lines.append(f"FAIL {k}: {n} rows of a kind the table doesn't plan")
    have = sum(by_kind.values())
    if total is not None:
        off = abs(have - total) / max(total, 1)
        good = off <= tol
        ok &= good
        lines.append(f"{'ok  ' if good else 'FAIL'} total: {have} against {total} planned ({off:.1%} off)")
    if file_counts is not None:
        mine = {str(k): v for k, v in file_counts.items()}
        theirs = {str(k): v for k, v in by_kind.items() if v}
        good = mine == theirs
        ok &= good
        lines.append(f"{'ok  ' if good else 'FAIL'} the file's own rows by kind {'match' if good else 'differ from'} the report"
                     + ("" if good else f": file {dict(sorted(mine.items()))}, report {dict(sorted(theirs.items()))}"))
    if records is not None and file_rows is not None:
        good = records == file_rows
        ok &= good
        lines.append(f"{'ok  ' if good else 'FAIL'} rows: {file_rows} in the file, {records} in the report")
    return ok, lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--table", required=True)
    ap.add_argument("--key", choices=["kind", "dose_group"], default="kind")
    ap.add_argument("--tol", type=float, default=0.02)
    a = ap.parse_args()
    with open(a.report) as f:
        report = json.load(f)
    with open(a.table) as f:
        table = json.load(f)
    s = report.get("set") or {}
    by_kind = s.get("by_kind") or report.get("by_kind")
    if not isinstance(by_kind, dict):
        print(f"FAIL {a.report} has no by_kind")
        sys.exit(1)
    rows, counts, sha = count_file(a.train, a.key)
    ok, lines = check(by_kind, table, a.tol, counts, s.get("records", report.get("records")), rows)
    for line in lines:
        print(line)
    print(f"{'PASS' if ok else 'FAIL'} {a.train}: {rows} rows, sha256 {sha}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
