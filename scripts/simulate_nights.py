"""Simulate school days and nights: does dreaming cut the approval requests without leaking?

    uv run python -m scripts.simulate_nights --nights 5 --per-day 20 [--home DIR] [--synthetic PATH|none]

Night 0 scores the router on the holdout with no learned rules. Each day sends a fixed, seeded
pick of the non-holdout eval items through egress, spread evenly over the four expected
decisions so every day has items of each kind, and the simulated teacher
(eval/user_policy.yaml) answers every approval request. Each night runs dreaming. Writes
eval/reports/nights.csv and eval/reports/nights.md. All items are invented.

Approval requests are split into wanted (the teacher's policy says to ask about that item) and
unneeded (the policy would have shared or refused it without asking). Only the unneeded ones
can go away with learning.
"""

from __future__ import annotations

import argparse
import csv
import random
import sys
import tempfile
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

from base.config import load_settings
from base.dreaming.night import NightRunner
from base.types import DECISIONS
from eval import run_eval

EVAL_DIR = run_eval.EVAL_DIR
FIELDS = (
    "night", "approval_requests", "accuracy", "agreement", "leaks", "kept", "seconds",
    "wanted_requests", "unneeded_requests", "day_mix", *(f"acc_{d}" for d in DECISIONS),
    "day_leaks", "user_rules", "practice_rules",
)  # fmt: skip


def pick_items(items: list[dict], day: int, per_day: int) -> list[dict]:
    """Day `day` (from 1) takes `per_day` items, dealt round robin over the expected decisions so
    each day covers every decision. Each decision's items are walked once per cycle, each cycle
    in its own seeded shuffle. Same inputs, same picks."""
    groups: dict = {}
    for item in items:
        groups.setdefault(item.get("expected"), []).append(item)
    keys = sorted(groups, key=lambda k: (DECISIONS.index(k) if k in DECISIONS else len(DECISIONS), str(k)))
    picks = []
    for slot in range((day - 1) * per_day, day * per_day):
        key = keys[slot % len(keys)]
        group = groups[key]
        cycle, index = divmod(slot // len(keys), len(group))
        order = list(range(len(group)))
        random.Random(f"{1000 + cycle}:{key}").shuffle(order)
        picks.append(group[order[index]])
    return picks


def run_day(services, items: list[dict], day: int, per_day: int) -> dict:
    """Release the day's items; the simulated teacher answers each approval request.

    Every text Muse would get that day is leak-checked, including what an approval releases.
    Returns the request counts (all, wanted, unneeded), the day's leaks and its mix of expected
    decisions.
    """
    asked = wanted = leaks = 0
    picks = pick_items(items, day, per_day)
    roster_values = run_eval._roster_values(getattr(services, "roster", None))
    resolve = getattr(services.egress, "resolve", None)
    for item in picks:
        released = run_eval.release_item(services, item, tool="simulation", day=day)
        texts = [released.text or ""]
        if released.status == "waiting" and released.approval_id is not None:
            asked += 1
            wanted += services.policy.wants(item) == "ask_user"
            approve, remember = services.policy.answer(item)
            services.approvals.decide(released.approval_id, approve, remember, by="policy_sim")
            if approve and callable(resolve):
                texts.append(resolve(released.approval_id).text or "")
        leaks += any(run_eval.find_leaks(services, t, item, roster_values) for t in texts)
    mix = Counter(i.get("expected") for i in picks)
    day_mix = " ".join(f"{d}:{mix[d]}" for d in DECISIONS if mix[d])
    return {"asked": asked, "wanted": wanted, "unneeded": asked - wanted, "day_mix": day_mix, "leaks": leaks}


def rule_counts(settings) -> tuple[int, int]:
    """(rules learned from the teacher's answers, practice-default rules) in the rules file in place."""
    from base.dreaming import train

    path = settings.paths.router_prompt
    rules = train.read_rules(path.read_text()) if path.is_file() else []
    user = sum(r.source == "user" for r in rules)
    return user, len(rules) - user


def simulate(
    settings,
    *,
    nights: int,
    per_day: int,
    home: Path,
    tasks_path: Path,
    holdout_path: Path,
    synthetic_path: Path | None,
    raw_dir: Path | None = None,
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
    rows = [
        _row(0, "", baseline.accuracy, baseline.agreement, baseline.leaks, "", time.monotonic() - started)
        | _categories(baseline.category_accuracy())
    ]
    for night in range(1, nights + 1):
        day = run_day(services, day_items, night, per_day)
        runner = NightRunner(services, holdout_path=holdout_path, synthetic_path=synthetic_path or "")
        runner.raw_dir = raw_dir
        r = runner.run_night()
        accuracy = r.accuracy_after if r.kept else r.accuracy_before
        agreement = r.agreement_after if r.kept else r.agreement_before
        row = _row(night, day["asked"], accuracy, agreement, r.leaks, "yes" if r.kept else "no", r.seconds)
        user_rules, practice_rules = rule_counts(sim_settings)
        row |= {
            "wanted_requests": day["wanted"],
            "unneeded_requests": day["unneeded"],
            "day_mix": day["day_mix"],
            "day_leaks": day["leaks"],
            "user_rules": user_rules,
            "practice_rules": practice_rules,
        }
        rows.append(row | _categories(getattr(r, "categories", None) or {}))
        _close(services)
        services = run_eval.services_for(settings, home)  # fresh services pick up the kept rules
    _close(services)
    return rows


def write_outputs(
    rows: list[dict],
    out_dir: Path,
    *,
    command: str,
    settings,
    items: int,
    holdout: int,
    practice: str = "none (learning only from the simulated teacher's answers)",
) -> None:
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
        f"| Practice data | {practice} |",
        "| Router inputs | as the connector sends them (no hand-labeled topics; see eval/run_eval.py) |",
        "",
        "Each day the simulated teacher answers every approval request. Each night the router learns",
        "from those answers and is scored on the holdout items, which it never trains on. Approval",
        "requests are for the day before each night; accuracy, agreement and leaks are for the rules",
        "in place after it. Night 0 is the router with no learned rules.",
        "",
        "The holdout is never trained on, but it is selected on: the dreaming gate scores the current",
        "and the new rules on these same items and keeps the better ones, so each night's number is the",
        "better of two runs on the set that chose it. Treat night-over-night gains as an upper bound.",
        "Day leaks count every text Muse would get that day, including what an approval releases.",
        "",
        "Each day's items are dealt evenly over the four expected decisions. Wanted requests are",
        "items the teacher's policy says to ask about; unneeded ones are items it would have shared",
        "or refused without asking. Only unneeded requests can go away with learning.",
        "",
        "| Night | Approval requests that day | Accuracy | Agreement | Leaks | Kept | Seconds | Wanted | Unneeded "
        "| Day leaks | Rules from answers | Practice rules |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['night']} | {_dash(r['approval_requests'])} "
            f"| {float(r['accuracy']) * 100:.1f}% | {float(r['agreement']) * 100:.1f}% | {r['leaks']} "
            f"| {r['kept'] or '-'} | {r['seconds']} "
            f"| {_dash(r.get('wanted_requests', ''))} | {_dash(r.get('unneeded_requests', ''))} "
            f"| {_dash(r.get('day_leaks', ''))} | {_dash(r.get('user_rules', ''))} | {_dash(r.get('practice_rules', ''))} |"
        )
    cats = [d for d in DECISIONS if any(r.get(f"acc_{d}", "") != "" for r in rows)]
    if cats:
        lines += [
            "",
            "Holdout accuracy by expected decision, for the rules in place after each night:",
            "",
            "| Night | " + " | ".join(cats) + " |",
            "|---|" + "---|" * len(cats),
        ]
        for r in rows:
            cells = [_pct_cell(r.get(f"acc_{d}", "")) for d in cats]
            lines.append(f"| {r['night']} | " + " | ".join(cells) + " |")
    mixes = [(r["night"], r.get("day_mix", "")) for r in rows if r.get("day_mix")]
    if mixes:
        lines += [
            "",
            "Items per expected decision each day: " + "; ".join(f"day {n} {m}" for n, m in mixes) + ".",
        ]
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
    p.add_argument(
        "--synthetic",
        default="none",
        help="practice data for dreaming, or none (the default). eval/synthetic.jsonl is labeled with the "
        "simulated teacher's own policy, so a run with it is an ablation, not learning from her answers",
    )
    p.add_argument("--out", type=Path, default=run_eval.REPORTS_DIR)
    args = p.parse_args(argv)
    if args.home and args.home.exists() and any(args.home.iterdir()):
        p.error("--home must be an empty or new folder, so the simulation starts fresh")

    settings = settings or load_settings()
    synthetic = None if str(args.synthetic).lower() == "none" else Path(args.synthetic)
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
            synthetic_path=synthetic,
            raw_dir=args.out / "raw" / "nights",
        )
    holdout_ids = {i["id"] for i in run_eval.load_items(args.holdout)}
    day_n = sum(1 for i in run_eval.load_items(args.tasks) if i["id"] not in holdout_ids)
    practice = (
        "none (learning only from the simulated teacher's answers)"
        if synthetic is None
        else f"{run_eval.display_path(synthetic)} (labeled with the teacher's own policy: an ablation)"
    )
    write_outputs(
        rows, args.out, command=command, settings=settings, items=day_n, holdout=len(holdout_ids), practice=practice
    )
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
        "wanted_requests": "",
        "unneeded_requests": "",
        "day_mix": "",
        "day_leaks": "",
        "user_rules": "",
        "practice_rules": "",
    }


def _categories(accuracy: dict) -> dict:
    return {f"acc_{d}": round(accuracy[d], 4) if d in accuracy else "" for d in DECISIONS}


def _dash(value) -> str:
    return "-" if value == "" or value is None else str(value)


def _pct_cell(value) -> str:
    return "-" if value == "" or value is None else f"{float(value) * 100:.0f}%"


def _close(services) -> None:
    close = getattr(services, "close", None)
    if callable(close):
        close()


if __name__ == "__main__":
    raise SystemExit(main())
