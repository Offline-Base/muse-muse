"""Simulate school days and nights: does dreaming cut the approval requests without leaking?

    uv run python -m scripts.simulate_nights --nights 5 --per-day 20 [--home DIR]

Night 0 scores the router on the holdout with no learned rules. Each day sends a fixed, seeded
pick of the non-holdout eval items through egress, and the simulated teacher
(eval/user_policy.yaml) answers every approval request. Each night runs dreaming. Writes
eval/reports/nights.csv and eval/reports/nights.md. All items are invented.
"""

from __future__ import annotations

import argparse
import csv
import random
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

from base.config import load_settings
from base.dreaming.night import NightRunner
from eval import run_eval

EVAL_DIR = run_eval.EVAL_DIR
FIELDS = ("night", "approval_requests", "accuracy", "agreement", "leaks", "kept", "seconds")


def pick_items(items: list[dict], day: int, per_day: int) -> list[dict]:
    """Day `day` (from 1) takes the next `per_day` items of a walk that visits every item once per
    cycle, each cycle in its own seeded shuffle. Same inputs, same picks."""
    n = len(items)
    picks = []
    for pos in range((day - 1) * per_day, day * per_day):
        cycle, index = divmod(pos, n)
        order = list(range(n))
        random.Random(1000 + cycle).shuffle(order)
        picks.append(items[order[index]])
    return picks


def run_day(services, items: list[dict], day: int, per_day: int) -> int:
    """Release the day's items; the simulated teacher answers each approval request. Returns the count."""
    asked = 0
    for item in pick_items(items, day, per_day):
        released = run_eval.release_item(services, item, tool="simulation", day=day)
        if released.status == "waiting" and released.approval_id is not None:
            asked += 1
            approve, remember = services.policy.answer(item)
            services.approvals.decide(released.approval_id, approve, remember, by="policy_sim")
    return asked


def simulate(
    settings,
    *,
    nights: int,
    per_day: int,
    home: Path,
    tasks_path: Path,
    holdout_path: Path,
    synthetic_path: Path,
) -> list[dict]:
    items = run_eval.load_items(tasks_path)
    holdout = run_eval.load_items(holdout_path)
    holdout_ids = {i["id"] for i in holdout}
    day_items = [i for i in items if i["id"] not in holdout_ids]
    if not day_items or not holdout:
        raise SystemExit("Need non-holdout items in --tasks and items in --holdout.")

    services = run_eval.services_for(settings, home)
    sim_settings = services.settings
    started = time.monotonic()
    baseline = run_eval.evaluate(sim_settings, holdout, rules_path=None, name="night-0")
    rows = [_row(0, "", baseline.accuracy, baseline.agreement, baseline.leaks, "", time.monotonic() - started)]
    for night in range(1, nights + 1):
        asked = run_day(services, day_items, night, per_day)
        runner = NightRunner(services, holdout_path=holdout_path, synthetic_path=synthetic_path)
        r = runner.run_night()
        accuracy = r.accuracy_after if r.kept else r.accuracy_before
        agreement = r.agreement_after if r.kept else r.agreement_before
        rows.append(_row(night, asked, accuracy, agreement, r.leaks, "yes" if r.kept else "no", r.seconds))
        _close(services)
        services = run_eval.services_for(settings, home)  # fresh services pick up the kept rules
    _close(services)
    return rows


def write_outputs(rows: list[dict], out_dir: Path, *, command: str, settings, items: int, holdout: int) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "nights.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    lines = [
        "# Nights of dreaming (simulated)",
        "",
        f"Command: `{command}`",
        "",
        "| Field | Value |",
        "|---|---|",
        f"| Device | {settings.device} |",
        f"| Backend | {settings.glimmer_backend} |",
        f"| Model | {settings.router_model} |",
        f"| Dreaming backend | {settings.dreaming_backend} |",
        f"| Date | {datetime.now().strftime('%Y-%m-%d %H:%M')} |",
        f"| Day items | {items} (holdout excluded) |",
        f"| Holdout items | {holdout} |",
        "",
        "Each day the simulated teacher answers every approval request. Each night the router learns",
        "from those answers and is scored on the holdout items, which it never trains on. Approval",
        "requests are for the day before each night; accuracy, agreement and leaks are for the rules",
        "in place after it. Night 0 is the router with no learned rules.",
        "",
        "| Night | Approval requests that day | Accuracy | Agreement | Leaks | Kept | Seconds |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['night']} | {r['approval_requests'] if r['approval_requests'] != '' else '-'} "
            f"| {float(r['accuracy']) * 100:.1f}% | {float(r['agreement']) * 100:.1f}% | {r['leaks']} "
            f"| {r['kept'] or '-'} | {r['seconds']} |"
        )
    (out_dir / "nights.md").write_text("\n".join(lines) + "\n")


def format_table(rows: list[dict]) -> str:
    out = [f"{'night':>5} {'asked':>5} {'accuracy':>8} {'agree':>6} {'leaks':>5} {'kept':>4} {'sec':>6}"]
    for r in rows:
        asked = "-" if r["approval_requests"] == "" else str(r["approval_requests"])
        out.append(
            f"{r['night']:>5} {asked:>5} {float(r['accuracy']) * 100:>7.1f}% "
            f"{float(r['agreement']) * 100:>5.1f}% {r['leaks']:>5} {r['kept'] or '-':>4} {r['seconds']:>6}"
        )
    return "\n".join(out)


def main(argv: list[str] | None = None, settings=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = argparse.ArgumentParser(prog="python -m scripts.simulate_nights", description=__doc__.split("\n")[0])
    p.add_argument("--nights", type=int, default=5)
    p.add_argument("--per-day", type=int, default=20)
    p.add_argument("--home", type=Path, help="empty folder to keep the simulated device home in")
    p.add_argument("--tasks", type=Path, default=EVAL_DIR / "tasks.jsonl")
    p.add_argument("--holdout", type=Path, default=EVAL_DIR / "holdout.jsonl")
    p.add_argument("--synthetic", type=Path, default=EVAL_DIR / "synthetic.jsonl")
    p.add_argument("--out", type=Path, default=run_eval.REPORTS_DIR)
    args = p.parse_args(argv)
    if args.home and args.home.exists() and any(args.home.iterdir()):
        p.error("--home must be an empty or new folder, so the simulation starts fresh")

    settings = settings or load_settings()
    command = run_eval.command_line("scripts.simulate_nights", argv)
    with tempfile.TemporaryDirectory(prefix="base-sim-") as tmp:
        home = args.home or Path(tmp) / "home"
        rows = simulate(
            settings,
            nights=args.nights,
            per_day=args.per_day,
            home=home,
            tasks_path=args.tasks,
            holdout_path=args.holdout,
            synthetic_path=args.synthetic,
        )
    holdout_ids = {i["id"] for i in run_eval.load_items(args.holdout)}
    day_n = sum(1 for i in run_eval.load_items(args.tasks) if i["id"] not in holdout_ids)
    write_outputs(rows, args.out, command=command, settings=settings, items=day_n, holdout=len(holdout_ids))
    print(format_table(rows))
    print(f"Wrote nights.csv and nights.md in {run_eval.display_path(args.out)}")
    return 0


def _row(night, asked, accuracy, agreement, leaks, kept, seconds) -> dict:
    return {
        "night": night,
        "approval_requests": asked,
        "accuracy": round(accuracy, 4),
        "agreement": round(agreement, 4),
        "leaks": leaks,
        "kept": kept,
        "seconds": round(seconds, 1),
    }


def _close(services) -> None:
    close = getattr(services, "close", None)
    if callable(close):
        close()


if __name__ == "__main__":
    raise SystemExit(main())
