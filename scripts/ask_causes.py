"""Why the router asked: count one eval run's approval requests by the router's reason code.

    uv run python -m scripts.ask_causes --raw eval/reports/raw/NAME.jsonl [--set ITEMS.jsonl]
        [--name NAME] [--out eval/reports]

Reads the raw rows eval/run_eval.py wrote (ids, decisions and fixed reason codes; never request or
result text). An approval request (decision ask_user) is wanted when the item's expected decision
is ask_user and needless otherwise. Each needless one is counted under its code and its expected
decision, so the buckets add up to the needless asks. Missed asks (expected ask_user, shared) and
refusals shared (expected refuse, shared) are counted beside them. With --set (the run's items),
needless asks are also counted by the kind the connector sends (run_eval.production_labels).
Rows from a raw file written before the codes existed count as "not recorded".

Writes eval/reports/ask_causes_NAME.md (NAME defaults to the raw file's name) with the command at
the top. Counts only. No model calls.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from base.types import DECISIONS
from eval import run_eval

NOT_RECORDED = "not recorded"
SHARED = ("share_tagged", "share_summary")
# What each code means, by the part before ":" (the part after it is a rule id, topic or kind).
CODE_TEXT = {
    "unknown_person_title": "a document list whose titles name someone the roster does not know",
    "policy_default": "no policy rule matched, so the policy's default applied",
    "policy_rule": "the policy rule named after the colon",
    "outside_class": "the request names a destination outside the class",
    "identifier": "the result or the request holds an identifier of that kind (digits: a long number)",
    "identifier_topic": "an identifier the policy counts as a never-share topic",
    "request_topic": "a never-share topic named only in Muse's request",
    "ask_first": "a never-share topic the policy asks about instead of refusing",
    "blocked": "a never-share topic in the result",
    "learned": "a rule the user taught",
    "practice": "a practice default learned from invented data",
    "model": "the router model chose it",
    "fallback": "the router could not decide",
    "compliance": "a privacy toggle",
    "pre_approved": "a policy rule marked pre-approved",
    "rule_kind": "a kind that is always shared tagged (document lists, dreaming reports)",
    "sensitive_record": "a sensitive record",
    "contact": "a request for contact details",
    "narrowed": "a request that singles out one person",
    NOT_RECORDED: "the raw file is older than the reason codes",
}


@dataclass
class Causes:
    n: int = 0
    asks: int = 0
    wanted: int = 0
    needless: int = 0
    missed_asks: int = 0
    refuse_shared: int = 0
    not_in_set: int = 0
    needless_by: Counter = field(default_factory=Counter)  # (code, expected) -> asks
    wanted_by: Counter = field(default_factory=Counter)  # code -> asks
    needless_kinds: Counter = field(default_factory=Counter)  # (code, production kind) -> asks


def cause(row: Mapping) -> str:
    """The row's reason code, "fallback" for an older fallback row, else NOT_RECORDED."""
    code = row.get("code")
    if code:
        return str(code)
    return "fallback" if row.get("fallback") else NOT_RECORDED


def count(rows: Iterable[Mapping], kinds: Mapping[str, str] | None = None) -> Causes:
    """Every ask counted once: wanted under its code, needless under (code, expected decision) and,
    with `kinds` (item id -> production kind), under (code, kind)."""
    out = Causes()
    for r in rows:
        out.n += 1
        expected, decision = r.get("expected"), r.get("decision")
        if decision in SHARED:
            out.missed_asks += expected == "ask_user"
            out.refuse_shared += expected == "refuse"
        if decision != "ask_user":
            continue
        out.asks += 1
        code = cause(r)
        if expected == "ask_user":
            out.wanted += 1
            out.wanted_by[code] += 1
            continue
        out.needless += 1
        out.needless_by[(code, str(expected))] += 1
        if kinds is not None:
            kind = kinds.get(str(r.get("id")))
            out.not_in_set += kind is None
            out.needless_kinds[(code, kind or "unknown")] += 1
    return out


def production_kinds(items: Iterable[Mapping]) -> dict[str, str]:
    """Item id -> the result kind the connector would send for it."""
    return {str(i["id"]): run_eval.production_labels(i)[0] for i in items}


def code_text(code: str) -> str:
    return CODE_TEXT.get(code, CODE_TEXT.get(code.split(":", 1)[0], "see docs/CONTRACTS.md (Router)"))


def render(c: Causes, *, name: str, command: str, raw_label: str, set_label: str = "") -> str:
    columns = [d for d in DECISIONS if d != "ask_user"]
    columns += sorted({e for _code, e in c.needless_by} - set(columns))
    codes = sorted({code for code, _e in c.needless_by}, key=lambda k: (-sum(c.needless_by[(k, e)] for e in columns), k))
    lines = [
        f"# Why the router asked: {name}",
        "",
        f"Command: `{command}`",
        "",
        f"Rows: {raw_label} (ids, decisions and reason codes only)."
        + (f" Items: {set_label}." if set_label else "")
        + f" Written {datetime.now().strftime('%Y-%m-%d %H:%M')}. Counts only, no request or result text.",
        "",
        "| Count | Value |",
        "|---|---|",
        f"| Items | {c.n} |",
        f"| Approval requests | {c.asks} |",
        f"| Wanted (expected ask_user) | {c.wanted} |",
        f"| Needless (expected anything else) | {c.needless} |",
        f"| Missed asks (expected ask_user, shared) | {c.missed_asks} |",
        f"| Refusals shared (expected refuse, shared) | {c.refuse_shared} |",
        "",
        "## Needless approval requests by reason code",
        "",
        "Rows are the code of what decided the ask, columns the item's expected decision. The total is the "
        "needless count above.",
        "",
        "| Code | " + " | ".join(columns) + " | Total |",
        "|---|" + "---|" * (len(columns) + 1),
    ]
    for code in codes:
        cells = [c.needless_by[(code, e)] for e in columns]
        lines.append(f"| {code} | " + " | ".join(map(str, cells)) + f" | {sum(cells)} |")
    totals = [sum(c.needless_by[(k, e)] for k in codes) for e in columns]
    lines.append("| Total | " + " | ".join(map(str, totals)) + f" | {sum(totals)} |")

    lines += ["", "## Wanted approval requests by reason code", "", "| Code | Asks |", "|---|---|"]
    lines += [f"| {code} | {k} |" for code, k in sorted(c.wanted_by.items(), key=lambda x: (-x[1], x[0]))]
    lines.append(f"| Total | {c.wanted} |")

    if c.needless_kinds:
        kinds = sorted({kind for _code, kind in c.needless_kinds})
        lines += [
            "",
            "## Needless approval requests by reason code and result kind",
            "",
            "The kind the connector sends for the item (eval/run_eval.py production_labels)."
            + (f" {c.not_in_set} asked items were not in the item set (kind unknown)." if c.not_in_set else ""),
            "",
            "| Code | " + " | ".join(kinds) + " | Total |",
            "|---|" + "---|" * (len(kinds) + 1),
        ]
        for code in codes:
            cells = [c.needless_kinds[(code, kind)] for kind in kinds]
            lines.append(f"| {code} | " + " | ".join(map(str, cells)) + f" | {sum(cells)} |")

    seen = sorted(set(codes) | set(c.wanted_by))
    lines += ["", "## What the codes mean", "", "| Code | Meaning |", "|---|---|"]
    lines += [f"| {code} | {code_text(code)} |" for code in seen]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = argparse.ArgumentParser(prog="python -m scripts.ask_causes", description=__doc__.split("\n")[0])
    p.add_argument("--raw", required=True, type=Path, help="raw rows from eval/run_eval.py (eval/reports/raw/NAME.jsonl)")
    p.add_argument("--set", type=Path, help="the run's items, to count needless asks by result kind")
    p.add_argument("--name", help="report name (default: the raw file's name)")
    p.add_argument("--out", type=Path, default=run_eval.REPORTS_DIR, help="reports folder")
    args = p.parse_args(argv)
    name = args.name or args.raw.stem
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name):
        p.error("--name may use letters, digits, dot, dash and underscore only")
    if not args.raw.is_file():
        p.error(f"no raw rows at {args.raw}")
    if args.set is not None and not args.set.is_file():
        p.error(f"no items at {args.set}")

    rows = run_eval.load_items(args.raw)
    kinds = production_kinds(run_eval.load_items(args.set)) if args.set else None
    c = count(rows, kinds)
    text = render(
        c,
        name=name,
        command=run_eval.command_line("scripts.ask_causes", argv),
        raw_label=run_eval.display_path(args.raw),
        set_label=run_eval.display_path(args.set) if args.set else "",
    )
    args.out.mkdir(parents=True, exist_ok=True)
    path = args.out / f"ask_causes_{name}.md"
    path.write_text(text)
    print(f"{c.asks} approval requests: {c.wanted} wanted, {c.needless} needless; wrote {run_eval.display_path(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
