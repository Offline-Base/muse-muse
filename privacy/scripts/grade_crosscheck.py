"""Cross-check Glimmer's essay grades with Muse Spark 1.3, until a teacher's spot-check exists.

    uv run python -m scripts.grade_crosscheck [--effort low] [--max-calls 30] [--max-usd 0.50]

Spark grades each invented essay in demo/essays against demo/rubric.md with the agent's own
grading step (base/workspace/agent.py: GRADE_SYSTEM, GRADE_SCHEMA, the teacher's instructions, the
rubric and one essay), on the model view the agent gives Glimmer: roster names and identifiers
swapped for tags. base/spark.py refuses anything else. Glimmer's side is run A in
eval/reports/raw/grading_spotcheck.jsonl (the first-day cloud grading run, the same prompt on
tagged essays); an essay missing there is graded by Glimmer now with the same messages. Spark is a
second opinion, not ground truth. Writes eval/reports/grading_crosscheck.md and
raw/grading_crosscheck.jsonl (scores only). Invented data only.
"""

from __future__ import annotations

import argparse
import json
import shlex
import statistics
import sys
from datetime import datetime
from pathlib import Path

from base import guard
from base.config import REPO_ROOT, load_settings
from base.local_llm import parse_json
from base.workspace.agent import (
    CRITERIA,
    GRADE_SCHEMA,
    GRADE_SYSTEM,
    MAX_DOC_CHARS,
    MAX_TOKENS,
    StepError,
    clean_grade,
    clip,
)

# What Muse asked for in the cloud grading runs (tests/test_e2e.py, eval/reports/e2e_cloud*.md).
GRADE_INSTRUCTIONS = "Grade each essay against rubric.md and write feedback for each student."
SPOTCHECK = REPO_ROOT / "eval" / "reports" / "raw" / "grading_spotcheck.jsonl"
# A third-party price list's Spark rates (eval/reports/synthetic.md), not Meta's page: an estimate.
USD_PER_PROMPT_TOKEN, USD_PER_COMPLETION_TOKEN = 1.25e-6, 4.25e-6


def grade_messages(essay: str, rubric: str) -> list[dict]:
    """The agent's grading step for one essay, both texts already in the model view."""
    return [
        {"role": "system", "content": GRADE_SYSTEM},
        {"role": "user", "content": f"Teacher's instructions:\n{GRADE_INSTRUCTIONS}\n\nRubric:\n{rubric}\n\n"
                                    f"Essay:\n{essay}"},
    ]  # fmt: skip


def spotcheck_runs(path: Path, run: str = "run_a") -> dict[str, dict]:
    """essay path -> one run's {scores, total} from the spot-check file, criteria lowercased."""
    if not path.is_file():
        return {}
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return {r["essay"]: {"scores": {k.lower(): v for k, v in r[run]["scores"].items()}, "total": r[run]["total"]}
            for r in rows if r.get(run)}  # fmt: skip


def compare(pairs: list[tuple[dict, dict]]) -> dict:
    """Agreement between (glimmer, spark) grades. diff is Spark minus Glimmer."""
    diffs = [s["total"] - g["total"] for g, s in pairs]
    crit = [(g["scores"][c], s["scores"][c]) for g, s in pairs for c in CRITERIA]
    return {
        "n": len(pairs),
        "same_total": sum(d == 0 for d in diffs),
        "total_within_1": sum(abs(d) <= 1 for d in diffs),
        "criteria": len(crit),
        "criteria_same": sum(a == b for a, b in crit),
        "criteria_within_1": sum(abs(a - b) <= 1 for a, b in crit),
        "mad": round(statistics.mean(abs(d) for d in diffs), 2) if diffs else None,
        "mean_diff": round(statistics.mean(diffs), 2) if diffs else None,
        "spark_lower": sum(d < 0 for d in diffs),
        "spark_higher": sum(d > 0 for d in diffs),
        "by_criterion": {c: round(statistics.mean(s["scores"][c] - g["scores"][c] for g, s in pairs), 2)
                         for c in CRITERIA} if pairs else {},  # fmt: skip
    }


def harsher(stats: dict) -> str:
    d = stats["mean_diff"]
    if d is None:
        return "not measured"
    if d == 0:
        return "neither (same mean total)"
    who = "Spark" if d < 0 else "Glimmer"
    return f"{who}, by {abs(d):.2f} points per essay on average"


def main(argv: list[str] | None = None, settings=None, spark=None, glimmer_llm=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--essays", type=Path, default=REPO_ROOT / "demo" / "essays")
    ap.add_argument("--rubric", type=Path, default=REPO_ROOT / "demo" / "rubric.md")
    ap.add_argument("--glimmer", type=Path, default=SPOTCHECK, help="Glimmer's scores (grading_spotcheck.jsonl)")
    ap.add_argument("--effort", default="low", help="Spark reasoning effort (Glimmer graded at low)")
    ap.add_argument("--max-calls", type=int, default=30, help="Spark API calls at most (cache hits are free)")
    ap.add_argument("--max-usd", type=float, default=0.50, help="stop once the estimated Spark spend reaches this")
    ap.add_argument("--name", default="grading_crosscheck")
    ap.add_argument("--out", type=Path, default=REPO_ROOT / "eval" / "reports")
    args = ap.parse_args(argv)
    command = ("uv run python -m scripts.grade_crosscheck " + shlex.join(argv if argv is not None else sys.argv[1:])).rstrip()

    settings = settings or load_settings()
    roster = guard.load_roster(settings.roster_path)
    if spark is None:
        from base.spark import Spark

        spark = Spark(settings, roster)
    tagmap = guard.TagMap(seed=0)  # in memory: tags only need to agree within this run

    def view(text: str) -> str:  # the agent's model view
        return guard.tag(clip(text, MAX_DOC_CHARS), roster, tagmap).text

    rubric = view(args.rubric.read_text())
    essays = sorted(p for p in args.essays.glob("*.md") if p.name not in ("rubric.md", "README.md"))
    known = spotcheck_runs(args.glimmer)
    usage = {"api_calls": 0, "cache_hits": 0, "prompt_tokens": 0, "completion_tokens": 0, "reasoning_tokens": 0}
    rows = []
    for path in essays:
        key = path.relative_to(REPO_ROOT).as_posix() if path.is_relative_to(REPO_ROOT) else path.name
        messages = grade_messages(view(path.read_text()), rubric)
        row = {"essay": key, "glimmer": known.get(key), "glimmer_source": "spotcheck run A", "spark": None, "spark_error": None}
        if row["glimmer"] is None:
            row["glimmer_source"] = "graded now"
            row["glimmer"] = _glimmer_now(glimmer_llm, settings, messages)
        for attempt in (1, 2):  # one retry for a reply that is not a usable grade, as the agent does
            if usage["api_calls"] >= args.max_calls or _usd(usage) >= args.max_usd:
                row["spark_error"] = "budget"
                break
            try:  # the retry skips Spark's cache, which would hand back the same reply
                result = spark.chat(messages, json_schema=GRADE_SCHEMA, effort=args.effort, cache=attempt == 1)
            except Exception as exc:  # a refusal, an HTTP error: recorded, never scored
                row["spark_error"] = type(exc).__name__
                break
            _count(usage, result)
            try:
                grade = clean_grade(parse_json(result.content))
            except (ValueError, StepError):
                row["spark_error"] = "bad_reply"
                continue
            row["spark"], row["spark_error"] = {"scores": grade["scores"], "total": grade["total"]}, None
            break
        rows.append(row)

    lines = render(rows, usage, args, settings, command)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"{args.name}.md").write_text("\n".join(lines))
    raw = args.out / "raw" / f"{args.name}.jsonl"
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_text("".join(json.dumps(r) + "\n" for r in rows))
    print("\n".join(lines))
    return 0 if all(r["spark"] and r["glimmer"] for r in rows) else 1


def _glimmer_now(llm, settings, messages: list[dict]) -> dict | None:
    if llm is None:
        from base.local_llm import LocalLLM

        llm = LocalLLM(settings, "answer")
    try:
        grade = clean_grade(llm.chat_json(messages, GRADE_SCHEMA, max_tokens=MAX_TOKENS, synthetic=True))
    except Exception:  # left out of the comparison and counted in the report
        return None
    return {"scores": grade["scores"], "total": grade["total"]}


def _count(usage: dict, result) -> None:
    if getattr(result, "cached", False):
        usage["cache_hits"] += 1
        return
    u = getattr(result, "usage", None) or {}
    usage["api_calls"] += 1
    usage["prompt_tokens"] += int(u.get("prompt_tokens") or 0)
    usage["completion_tokens"] += int(u.get("completion_tokens") or 0)
    usage["reasoning_tokens"] += int((u.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0)


def _usd(usage: dict) -> float:
    return usage["prompt_tokens"] * USD_PER_PROMPT_TOKEN + usage["completion_tokens"] * USD_PER_COMPLETION_TOKEN


def render(rows: list[dict], usage: dict, args, settings, command: str) -> list[str]:
    pairs = [(r["glimmer"], r["spark"]) for r in rows if r["glimmer"] and r["spark"]]
    stats = compare(pairs)
    run_b = spotcheck_runs(args.glimmer, "run_b")
    both = [(r["glimmer"], run_b[r["essay"]]) for r in rows if r["glimmer_source"] == "spotcheck run A" and r["essay"] in run_b]
    baseline = compare(both) if both else None
    missing = [r["essay"].rsplit("/", 1)[-1] for r in rows if not (r["glimmer"] and r["spark"])]
    fresh = sum(r["glimmer_source"] == "graded now" for r in rows)
    lines = [
        "# Grading cross-check: Muse Spark 1.3 against Glimmer",
        "",
        f"Command: `{command}`",
        "",
        f"Date: {datetime.now().strftime('%Y-%m-%d %H:%M')}. Spark: `{settings.spark_model}` through the Meta Model API, "
        f"reasoning effort {args.effort}. Glimmer: run A of `{_display(args.glimmer)}` ({len(rows) - fresh} essays"
        + (f"; {fresh} graded now by `{settings.answer_model}` on {settings.glimmer_backend}" if fresh else "")
        + "), the first-day cloud grading run, reasoning low. Both models got the same messages: the agent's "
        "grading prompt and schema, the teacher's instructions, the rubric and one essay, with roster names and "
        "identifiers swapped for tags. Every essay and student is invented (`demo/essays/`, `eval/roster.json`).",
        "",
        "**Spark is a second opinion, not ground truth.** Two models agreeing does not make either one right, and "
        "a gap does not say which one is wrong. The teacher's spot-check in `grading_spotcheck.md` is still the "
        "grading-quality number; this page only says how much a second Meta model agrees with Glimmer until then.",
        "",
        "## Agreement",
        "",
        "| Measure | Spark against Glimmer | Glimmer run A against run B (same model twice) |",
        "|---|---|---|",
    ]
    rows_table = [
        ("Essays compared", "n", None),
        ("Same total", "same_total", "n"),
        ("Totals within 1 point", "total_within_1", "n"),
        ("Same score on a criterion", "criteria_same", "criteria"),
        ("Criterion scores within 1 point", "criteria_within_1", "criteria"),
    ]
    for label, key, of in rows_table:
        cells = [_cell(s, key, of) for s in (stats, baseline)]
        lines.append(f"| {label} | {cells[0]} | {cells[1]} |")
    lines += [
        f"| Mean absolute difference in total (of 16) | {_num(stats['mad'])} | {_num(baseline and baseline['mad'])} |",
        f"| Mean total, Spark minus Glimmer | {_num(stats['mean_diff'])} | |",
        f"| Essays Spark scored lower / higher / the same | {stats['spark_lower']} / {stats['spark_higher']} / "
        f"{stats['same_total']} | |",
        "",
        f"Harsher grader: {harsher(stats)}.",
        "",
        "Mean difference per criterion, Spark minus Glimmer: "
        + ", ".join(f"{c} {v:+.2f}" for c, v in stats["by_criterion"].items()) + "." if pairs else "No essay was scored by both.",
        "",
        "## Per essay",
        "",
        "| Essay | Glimmer total | Spark total | Spark minus Glimmer | Glimmer " + " / ".join(CRITERIA) + " | Spark "
        + " / ".join(CRITERIA) + " |",
        "|---|---:|---:|---:|---|---|",
    ]
    for r in rows:
        g, s = r["glimmer"], r["spark"]
        name = r["essay"].rsplit("/", 1)[-1].removesuffix(".md")
        lines.append(
            f"| {name} | {g['total'] if g else 'n/a'} | {s['total'] if s else r['spark_error'] or 'n/a'} "
            f"| {s['total'] - g['total'] if g and s else ''} | {_crit(g)} | {_crit(s)} |"
        )
    cost = _usd(usage)
    lines += [
        "",
        "## Spark usage",
        "",
        f"From the response usage fields: {usage['api_calls']} API calls (at most {args.max_calls}), {usage['cache_hits']} "
        f"answered from the local cache, {usage['prompt_tokens']} prompt and {usage['completion_tokens']} completion "
        f"tokens, {usage['reasoning_tokens']} of them reasoning. Estimated ${cost:.2f} at $1.25 and $4.25 per million "
        "tokens (a third-party price list, as in `synthetic.md`; not Meta's own page).",
        "",
    ]
    if missing:
        lines += [f"Not compared ({len(missing)}): " + ", ".join(missing) + ".", ""]
    lines += [f"Raw rows: raw/{args.name}.jsonl next to this report (scores only, no feedback text).", ""]
    return lines


def _cell(stats: dict | None, key: str, of: str | None) -> str:
    if not stats or not stats["n"]:
        return "n/a"
    return f"{stats[key]} of {stats[of]}" if of else str(stats[key])


def _num(value) -> str:
    return "n/a" if value is None else f"{value:.2f}"


def _crit(grade: dict | None) -> str:
    return " / ".join(str(grade["scores"][c]) for c in CRITERIA) if grade else ""


def _display(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.name


if __name__ == "__main__":
    raise SystemExit(main())
