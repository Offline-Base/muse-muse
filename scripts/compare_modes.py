"""Score the running model in each way the router can use it, on the same untouched items.

    uv run python -m scripts.compare_modes --name NAME [--set eval/fresh_200_b.jsonl] [--limit N]

Needs the model servers running (scripts/start.sh) and DEVICE_ONLY=1. Writes one eval report per
mode, and eval/reports/modes_NAME.md with the table. All items are invented.
"""

from __future__ import annotations

import argparse
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from base.config import load_settings

REPORTS = Path(__file__).resolve().parent.parent / "eval" / "reports"
MODES = {
    "rules": ("Rules in code", {"DREAMING_BACKEND": "rules"}),
    "tighten": ("Prompt, stricter only", {"DREAMING_BACKEND": "prompt", "ROUTER_TRUST": "tighten"}),
    "decide": ("Prompt, model decides", {"DREAMING_BACKEND": "prompt", "ROUTER_TRUST": "decide"}),
}
_SUMMARY = re.compile(r"accuracy ([\d.]+)%, agreement [\d.]+%, approval requests (\d+), leaks (\d+), errors (\d+), fallbacks (\d+)")


def parse_summary(output: str) -> dict[str, str] | None:
    found = _SUMMARY.findall(output)
    if not found:
        return None
    accuracy, asked, leaks, errors, fallbacks = found[-1]
    return {"accuracy": accuracy, "asked": asked, "leaks": leaks, "errors": errors, "fallbacks": fallbacks}


def table(rows: list[tuple[str, dict[str, str] | None]]) -> list[str]:
    lines = ["| Mode | Agreement | Approval requests | Leaks | Errors or fallbacks |", "|---|---|---|---|---|"]
    for label, r in rows:
        if r is None:
            lines.append(f"| {label} | did not finish | | | |")
        else:
            lines.append(f"| {label} | {r['accuracy']}% | {r['asked']} | {r['leaks']} | {int(r['errors']) + int(r['fallbacks'])} |")
    return lines


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", required=True, help="a short name for the model, used in the report names")
    p.add_argument("--set", default="eval/fresh_200_b.jsonl")
    p.add_argument("--limit", type=int)
    args = p.parse_args(argv)
    settings = load_settings()
    if not settings.device_only:
        p.error("this needs DEVICE_ONLY=1, so that no text leaves this device")
    rows = []
    for mode, (label, env) in MODES.items():
        cmd = [sys.executable, "-m", "eval.run_eval", "--set", args.set, "--name", f"modes_{args.name}_{mode}",
               "--device-label", f"{args.name}, {label}"]  # fmt: skip
        if args.limit:
            cmd += ["--limit", str(args.limit)]
        print(f"Running: {label}", flush=True)
        done = subprocess.run(cmd, env={**os.environ, **env}, capture_output=True, text=True)
        rows.append((label, parse_summary(done.stdout + done.stderr)))
    command = "uv run python -m scripts.compare_modes " + " ".join(shlex.quote(a) for a in (argv if argv is not None else sys.argv[1:]))
    lines = [
        f"# Router modes: {args.name}", "", f"Command: `{command}`", "",
        f"Date: {datetime.now():%Y-%m-%d %H:%M}. Model: {settings.answer_model}. Items: {args.set}"
        + (f", first {args.limit}" if args.limit else "") + ". All invented.", "",
        *table(rows), "",
    ]  # fmt: skip
    text = "\n".join(lines)
    (REPORTS / f"modes_{args.name}.md").write_text(text)
    print(text)
    return 0 if all(r is not None for _l, r in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
