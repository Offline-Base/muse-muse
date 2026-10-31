"""The toggles' tagging, scored on invented sentences, with the rules alone or the device's model too.

    uv run python -m eval.run_compliance --name compliance [--model]

Each item in eval/compliance.jsonl has one value that must not survive tagging. "clean" items have
nothing private, so any change to them is over-redaction. Writes eval/reports/NAME.md with the command.
"""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

from base import compliance, guard
from base.config import load_settings
from base.guard import Redaction, TagMap, load_roster
from base.local_llm import LocalLLM

EVAL_DIR = Path(__file__).resolve().parent
STRUCTURED = ("date", "age", "url", "ip", "record")  # found by exact patterns: the bar is zero misses


def score(items: list[dict], roster, profiles: list[str], names=None) -> tuple[Counter, Counter, list[str], list[str]]:
    red = Redaction(extra_kinds=compliance.extra_kinds(profiles))
    totals, misses, missed, over = Counter(), Counter(), [], []
    for item in items:
        out = guard.tag(item["text"], roster, TagMap(None), llm_names=names, redaction=red).text
        kind = item["kind"]
        totals[kind] += 1
        if kind == "clean":
            if out != item["text"]:
                misses[kind] += 1
                over.append(item["id"])
        elif item["value"].lower() in out.lower():
            misses[kind] += 1
            missed.append(item["id"])
    return totals, misses, missed, over


def report(name: str, items: list[dict], roster, names=None) -> tuple[str, int]:
    command = "uv run python -m eval.run_compliance " + " ".join(shlex.quote(a) for a in sys.argv[1:])
    lines = [
        f"# Tagging report: {name}", "", f"Command: `{command}`", "", f"Date: {datetime.now():%Y-%m-%d %H:%M}", "",
        f"Invented sentences, scored with {'the rules and LFM3-VL-2B on this device' if names else 'the rules alone (no model)'}. "
        "A miss means the private value survived. This set was used while the rules were written, so "
        "expect more misses on new text. It is not a legal measure of de-identification.", "",
    ]  # fmt: skip
    failed = 0
    # COPPA and FERPA tag the same kinds, so with a model only the widest toggle is run.
    for profile in ("hipaa",) if names else ("ferpa", "coppa", "hipaa"):
        totals, misses, missed, over = score(items, roster, [profile], names)
        lines += [f"## {profile.upper()}", "", "| Kind | Items | Missed |", "|---|---|---|"]
        for kind in [*STRUCTURED, "place", "detail"]:
            if kind == "age" and "age" not in compliance.extra_kinds([profile]):
                lines.append(f"| age | {totals[kind]} | not tagged by this toggle |")
                continue
            lines.append(f"| {kind} | {totals[kind]} | {misses[kind]} |")
            if kind in STRUCTURED:
                failed += misses[kind]
        lines += [
            f"| clean sentences changed (over-redaction) | {totals['clean']} | {misses['clean']} |", "",
            f"Missed: {', '.join(i for i in missed if not (i.startswith('age') and profile != 'hipaa')) or 'none'}", "",
            f"Changed clean sentences: {', '.join(over) or 'none'}", "",
        ]  # fmt: skip
    return "\n".join(lines) + "\n", failed


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--name", required=True)
    p.add_argument("--set", type=Path, default=EVAL_DIR / "compliance.jsonl")
    p.add_argument("--out", type=Path, default=EVAL_DIR / "reports")
    p.add_argument("--model", action="store_true", help="add the device model's pass (needs the local server)")
    args = p.parse_args()
    items = [json.loads(line) for line in args.set.read_text().splitlines() if line.strip()]
    names = None
    if args.model:
        settings = load_settings()
        if not settings.device_only:
            p.error("--model needs DEVICE_ONLY=1, so that no text leaves this device")
        names = LocalLLM(settings, role="checker").llm_details
    text, failed = report(args.name, items, load_roster(EVAL_DIR / "roster.json"), names)
    (args.out / f"{args.name}.md").write_text(text)
    print(text)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
