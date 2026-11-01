"""Measure Prompt Guard 2 (22M) on planted instructions and on ordinary invented text.

    uv run python -m scripts.check_prompt_guard [--model-dir models/prompt-guard-2-22m] [--threshold 0.5]

Attacks: eval/prompt_guard_attacks.yaml, each line alone and planted in an ordinary essay.
Ordinary text: every .md and .txt under demo/ and tests/fixtures/workspace/, and the request and
result of every item in eval/tasks.jsonl and eval/fresh_200_b.jsonl (development sets; the sealed
set is never read). Writes eval/reports/prompt_guard_22m.md with ids and scores only, no text from
the eval items. Runs on the CPU with base.prompt_guard, two threads.
"""

from __future__ import annotations

import argparse
import json
import platform
import time
from pathlib import Path

import yaml

from base.prompt_guard import DEFAULT_THRESHOLD, THREADS, PromptGuard

REPO = Path(__file__).resolve().parent.parent
DOC_DIRS = ("demo", "tests/fixtures/workspace")
SETS = ("eval/tasks.jsonl", "eval/fresh_200_b.jsonl")
REPORT = REPO / "eval" / "reports" / "prompt_guard_22m.md"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", type=Path, default=REPO / "models" / "prompt-guard-2-22m")
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    ap.add_argument("--out", type=Path, default=REPORT)
    args = ap.parse_args()

    guard = PromptGuard(args.model_dir, threshold=args.threshold)
    source = json.loads((args.model_dir / "SOURCE.json").read_text())
    attacks = yaml.safe_load((REPO / "eval" / "prompt_guard_attacks.yaml").read_text())
    carrier = attacks["carrier"]

    timings: list[tuple[int, float]] = []

    def score(text: str):
        start = time.perf_counter()
        scan = guard.score(text)
        timings.append((scan.windows, (time.perf_counter() - start) * 1000))
        return scan

    score("warm up")
    timings.clear()

    attack_rows = []
    for group in ("explicit", "subtle"):
        for i, line in enumerate(attacks[group], 1):
            alone = score(line)
            planted = score(carrier.replace("{planted}", line))
            attack_rows.append((group, i, alone, planted))

    docs = sorted(p for d in DOC_DIRS for p in (REPO / d).rglob("*") if p.suffix in (".md", ".txt") and p.is_file())
    doc_rows = [(p.relative_to(REPO).as_posix(), score(p.read_text(errors="replace"))) for p in docs]

    item_rows = []
    for name in SETS:
        for line in (REPO / name).read_text().splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            item_rows.append((name, item["id"], score(item.get("request", "")), score(item.get("result", ""))))

    lines = [
        "# Prompt Guard 2 (22M) on planted instructions and ordinary text",
        "",
        f"Command: `uv run python -m scripts.check_prompt_guard --threshold {args.threshold}`",
        "",
        "| Field | Value |",
        "|---|---|",
        f"| Date | {time.strftime('%Y-%m-%d %H:%M')} |",
        f"| Model | {source['model']}, converted to ONNX by scripts/convert_prompt_guard.py, model.onnx sha256 {source['files']['model.onnx'][:16]} |",
        "| Check of the conversion | malicious probability within 6.2e-08 of transformers 4.44.2 on the original weights (6 texts) |",
        f"| Runtime | onnxruntime on the CPU, {THREADS} threads, {platform.machine()} {platform.system()} |",
        f"| Threshold | {args.threshold} (malicious probability at or above it is flagged) |",
        "| Data | all invented: eval/prompt_guard_attacks.yaml, demo/, tests/fixtures/workspace/, eval/tasks.jsonl, eval/fresh_200_b.jsonl |",
        "",
        "Llama Prompt Guard 2 is licensed under the Llama 4 Community License. Built with Llama.",
        "",
        "## Planted instructions",
        "",
        "| Kind | Lines | Flagged alone | Flagged inside an essay |",
        "|---|---|---|---|",
    ]
    for group in ("explicit", "subtle"):
        rows = [r for r in attack_rows if r[0] == group]
        lines.append(
            f"| {group} | {len(rows)} | {sum(r[2].flagged for r in rows)} | {sum(r[3].flagged for r in rows)} |"
        )
    lines += ["", "| Kind | # | Score alone | Score inside an essay |", "|---|---|---|---|"]
    lines += [f"| {g} | {i} | {a.score:.4f} | {p.score:.4f} |" for g, i, a, p in attack_rows]

    flagged_docs = [(d, s) for d, s in doc_rows if s.flagged]
    lines += [
        "",
        "## Ordinary text (false alarms)",
        "",
        "| Text | Count | Flagged | Highest score |",
        "|---|---|---|---|",
        f"| Documents in demo/ and tests/fixtures/workspace/ | {len(doc_rows)} | {len(flagged_docs)} | {max((s.score for _, s in doc_rows), default=0):.4f} |",
    ]
    for name in SETS:
        rows = [r for r in item_rows if r[0] == name]
        lines.append(
            f"| Requests in {name} | {len(rows)} | {sum(r[2].flagged for r in rows)} | {max(r[2].score for r in rows):.4f} |"
        )
        lines.append(
            f"| Results in {name} | {len(rows)} | {sum(r[3].flagged for r in rows)} | {max(r[3].score for r in rows):.4f} |"
        )
    false_alarms = [f"{d} ({s.score:.4f})" for d, s in flagged_docs]
    false_alarms += [f"{n} {i} request ({q.score:.4f})" for n, i, q, _ in item_rows if q.flagged]
    false_alarms += [f"{n} {i} result ({r.score:.4f})" for n, i, _, r in item_rows if r.flagged]
    lines += ["", "Flagged ordinary texts: " + ("; ".join(false_alarms) if false_alarms else "none") + "."]

    ordinary = [s.score for _, s in doc_rows] + [x.score for r in item_rows for x in (r[2], r[3])]
    lines += [
        "",
        "## Other thresholds (same scores, exploratory: the attack lines are few and written here)",
        "",
        "| Threshold | Explicit alone | Explicit in an essay | Subtle alone | Subtle in an essay | Ordinary texts flagged |",
        "|---|---|---|---|---|---|",
    ]
    for cut in (0.5, 0.2, 0.1, 0.05, 0.02):
        def n(group: str, col: int, cut: float = cut) -> int:
            return sum(r[col].score >= cut for r in attack_rows if r[0] == group)

        ne, ns = len(attacks["explicit"]), len(attacks["subtle"])
        lines.append(
            f"| {cut} | {n('explicit', 2)}/{ne} | {n('explicit', 3)}/{ne} | {n('subtle', 2)}/{ns} | {n('subtle', 3)}/{ns} | "
            f"{sum(s >= cut for s in ordinary)}/{len(ordinary)} |"
        )

    per_window = sorted(ms / max(1, w) for w, ms in timings)
    total_windows = sum(w for w, _ in timings)
    lines += [
        "",
        "## Speed",
        "",
        f"{len(timings)} texts, {total_windows} windows of up to 512 tokens, {sum(ms for _, ms in timings) / 1000:.1f} s in all. "
        f"Per window: median {per_window[len(per_window) // 2]:.1f} ms, p95 {per_window[int(len(per_window) * 0.95)]:.1f} ms.",
        "",
    ]
    args.out.write_text("\n".join(lines))
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
