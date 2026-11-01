"""A time model on top of the simulated persona study: every figure is simulated and an assumption.

    uv run python -m scripts.time_model [--study eval/reports/sim] [--assumptions eval/reports/sim/assumptions.yaml]
        [--out eval/reports/sim/time_model.md]

Reads <study>/<persona>/seed-*/nights.csv for the 7 planned personas (not eval/reports/sim/smoke, and
not the fix ablation, which is another configuration) and the assumptions file. With no finished
run it reports nothing and writes nothing. It says how many of the 21 planned runs it used, and names
every folder it left out and why: a run with a stopped.md, one without all its nights, or a folder
whose name is not seed-N or seed-N-rerun.

For each run, unneeded asks per simulated item are taken over the first 3 and the last 3 days
(`first_and_last_days`). For each of the 3 x 3 x 3 assumed values of seconds per card, results per
day and school days:

    hours = asks per item x results per day x school days x seconds per card / 3600
    hours saved = hours at the first days' rate - hours at the last days' rate

and hours saved stop at the published limit in the assumptions file. This does not measure anyone's
time. The author's own timing of 20 clicks is printed apart, labeled "measured by the author", and
never enters the simulated numbers.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from dataclasses import dataclass
from itertools import product
from pathlib import Path

import yaml

from eval.run_eval import REPORTS_DIR, command_line, display_path
from scripts.study_summary import PLANNED, SEED_DIR, seeds_for, span

ROOT = Path(__file__).resolve().parent.parent
STUDY = REPORTS_DIR / "sim"
ASSUMPTIONS = STUDY / "assumptions.yaml"
PERSONAS = ROOT / "eval" / "personas"
NIGHTS = 10
AXES = ("seconds_per_card", "results_per_day", "school_days")
LABEL = "Simulated users, invented items, no real users. Every figure is simulated and an assumption, not a measurement."


class AssumptionError(ValueError):
    """The assumptions file is malformed. The message names the field."""


@dataclass(frozen=True)
class Rates:
    """Asks per simulated item in one run, first days and last days."""

    persona: str
    seed: int
    unneeded_first: float
    unneeded_last: float
    asks_first: float
    asks_last: float


def load_assumptions(path: Path, personas: Path = PERSONAS) -> dict:
    """The assumptions, checked: three values on each axis, and the middle seconds per card is the
    number the persona files state, so the two can never quietly differ."""
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict):
        raise AssumptionError(f"{path.name}: must be a mapping")
    for axis in AXES:
        values = (data.get(axis) or {}).get("values")
        if (
            not isinstance(values, list)
            or len(values) != 3
            or not all(isinstance(v, (int, float)) and v > 0 for v in values)
        ):
            raise AssumptionError(f"{path.name}: {axis}.values must be three positive numbers")
    stated = {
        yaml.safe_load(p.read_text()).get("behavior", {}).get("seconds_per_card")
        for p in personas.glob("*/persona.yaml")
    }
    middle = data["seconds_per_card"]["values"][1]
    if stated - {middle}:
        raise AssumptionError(
            f"{path.name}: the middle seconds_per_card is {middle}, the persona files say {sorted(stated)}"
        )
    window = data.get("first_and_last_days")
    if not isinstance(window, int) or not 1 <= window <= NIGHTS // 2:
        raise AssumptionError(
            f"{path.name}: first_and_last_days must be a whole number from 1 to {NIGHTS // 2}"
        )
    timing = data.get("measured_by_author") or {}
    if timing.get("label") != "measured by the author" or timing.get("clicks") != 20:
        raise AssumptionError(
            f'{path.name}: measured_by_author needs label "measured by the author" and clicks 20'
        )
    total = timing.get("total_seconds")
    if total is not None and (not isinstance(total, (int, float)) or total <= 0):
        raise AssumptionError(
            f"{path.name}: measured_by_author.total_seconds must be empty or a positive number"
        )
    for cap in data.get("caps") or []:
        if not all(cap.get(k) for k in ("id", "figure", "title", "url")):
            raise AssumptionError(f"{path.name}: a cap needs id, figure, title and url")
        if cap.get("used") and not (
            isinstance(cap.get("hours_per_week"), (int, float)) and cap["hours_per_week"] > 0
        ):
            raise AssumptionError(f"{path.name}: cap {cap['id']} is used but has no hours_per_week")
    return data


def items_that_day(row: dict) -> int:
    """Items dealt that day, from nights.csv's day_mix ("share_tagged:5 ask_user:3")."""
    return sum(int(n) for n in re.findall(r":(\d+)", row.get("day_mix") or ""))


def read_rates(path: Path, persona: str, seed: int, window: int) -> Rates | None:
    """Rates from one nights.csv, or None for a run without all its nights (it gives no rate)."""
    with path.open(newline="") as f:
        days = [r for r in csv.DictReader(f) if int(r["night"]) >= 1]
    if len(days) != NIGHTS or any(not items_that_day(r) for r in days):
        return None
    first, last = days[:window], days[-window:]

    def rate(rows: list[dict], key: str) -> float:
        return sum(int(float(r[key] or 0)) for r in rows) / sum(items_that_day(r) for r in rows)

    return Rates(
        persona, seed, rate(first, "unneeded_requests"), rate(last, "unneeded_requests"),
        rate(first, "approval_requests"), rate(last, "approval_requests"),
    )  # fmt: skip


def read_study(study: Path, window: int) -> tuple[list[Rates], list[str]]:
    """The usable runs, and every folder left out with why (only planned seeds of the 7 personas).
    A run with a stopped.md never gives a rate, however many nights its nights.csv has."""
    rates, skipped = [], []
    for persona in PLANNED:
        folders = [
            f for f in sorted((study / persona).glob("*")) if f.is_dir() and not f.name.startswith(".")
        ]
        skipped += [
            f"{persona} {f.name} (its name is not seed-N or seed-N-rerun)"
            for f in folders
            if not SEED_DIR.match(f.name)
        ]
        for seed in seeds_for(persona):
            used = False
            for folder in folders:
                m = SEED_DIR.match(folder.name)
                if not m or int(m.group(1)) != seed:
                    continue
                name = f"{persona} seed {seed}" + (" re-run" if m.group(2) else "")
                rate = None
                if (folder / "stopped.md").is_file():
                    why = "stopped"
                elif not (folder / "nights.csv").is_file():
                    why = "no nights.csv"
                else:
                    rate = read_rates(folder / "nights.csv", persona, seed, window)
                    why = "without all its nights"
                if rate is None:
                    skipped.append(f"{name} ({why})")
                elif used:
                    skipped.append(f"{name} (the seed already has a run)")
                else:
                    rates.append(rate)
                    used = True
    return rates, skipped


def hours(rate: float, seconds: float, results: float, days: float) -> float:
    return rate * results * days * seconds / 3600


def cap_hours(assumptions: dict, days: float) -> float | None:
    """The tightest used limit over the school year, in hours, or None when no limit is used."""
    per_week = [c["hours_per_week"] for c in assumptions.get("caps") or [] if c.get("used")]
    return min(per_week) * days / assumptions.get("school_days_per_week", 5) if per_week else None


def saved(
    rate: Rates, seconds: float, results: float, days: float, limit: float | None
) -> tuple[float, bool]:
    """Hours saved over a school year (negative when the last days asked more), and whether the limit cut it."""
    value = hours(rate.unneeded_first - rate.unneeded_last, seconds, results, days)
    return (limit, True) if limit is not None and value > limit else (value, False)


def render(rates: list[Rates], skipped: list[str], assumptions: dict, *, command: str) -> str:
    planned = sum(len(seeds_for(p)) for p in PLANNED)
    personas = [p for p in PLANNED if any(r.persona == p for r in rates)]
    window = assumptions["first_and_last_days"]
    lines = [
        "# Time model (simulated, assumption)",
        "",
        LABEL,
        "",
        f"Command: `{command}`",
        "",
        f"Simulated runs used: {len(rates)} of {planned} planned."
        + (f" Left out: {'; '.join(skipped)}." if skipped else ""),
        "",
        "This does not show that anyone saves this time. The personas are policy files with seeded habits, the items are "
        "invented, and it assumes every card takes the same time, that a rate seen over simulated days holds all year, and "
        "that asks grow in step with results. A card a persona never answers is counted as if it were read.",
        "",
        "## Assumptions behind the simulated numbers",
        "",
        "| Input (assumption) | Values | Why |",
        "|---|---|---|",
    ]
    lines += [
        f"| {axis} | {', '.join(f'{v:g}' for v in assumptions[axis]['values'])} | {assumptions[axis]['why']} |"
        for axis in AXES
    ]
    lines += [
        f"| first and last days compared | {window} | Unneeded asks per item over the first {window} and the last {window} simulated days. |",
        f"| school days per week | {assumptions.get('school_days_per_week', 5)} | Only used to turn a weekly limit into a yearly one. |",
        "",
        "## Published figures that limit it",
        "",
        "| Figure | Source | Read | Why | In the model |",
        "|---|---|---|---|---|",
    ]
    for cap in assumptions.get("caps") or []:
        used = f"yes, {cap['hours_per_week']:g} hours a week" if cap.get("used") else "no, left out"
        source = f"{cap['title']}, {cap.get('publisher', '')}, {cap['url']}"
        if cap.get("secondary"):
            source += f"; secondary: {cap['secondary']}"
        lines.append(
            f"| {_cell(cap['figure'])} | {_cell(source)} | {_cell(cap.get('read', ''))} | {_cell(cap.get('why', ''))} | {used} |"
        )
    lines += [
        "",
        "## Asks per simulated item, first and last days",
        "",
        f"Simulated and an assumption: days 1 to {window} against the last {window} days of each run, from nights.csv, assuming "
        "each window speaks for its part of a year.",
        "",
        "| Simulated persona | Seed | Unneeded asks per item, first days (simulated, assumption) | Last days (simulated, assumption) "
        "| All asks per item, first days (simulated, assumption) | Last days (simulated, assumption) |",
        "|---|---|---|---|---|---|",
    ]
    lines += [
        f"| {r.persona} | {r.seed} | {r.unneeded_first:.3f} | {r.unneeded_last:.3f} | {r.asks_first:.3f} | {r.asks_last:.3f} |"
        for r in rates
    ]
    cols = " | ".join(f"{p} (simulated, assumption)" for p in personas)
    lines += [
        "",
        "## Hours saved per teacher per school year, 3 x 3 x 3",
        "",
        "Simulated and an assumption: the fall in unneeded asks turned into hours for every combination of the assumed "
        "values. Each cell is the smallest and largest over a persona's seeds. A negative number means the last days asked more. "
        '"limit" means the number reached the published limit above and stops there.',
        "",
        f"| Seconds per card (assumption) | Results per day (assumption) | School days (assumption) | Limit in hours (published figure x assumed days, an assumption) | {cols} |",
        "|---|---|---|---|" + "---|" * len(personas),
    ]
    for seconds, results, days in product(*(assumptions[a]["values"] for a in AXES)):
        limit = cap_hours(assumptions, days)
        cells = [
            _range_cell([saved(r, seconds, results, days, limit) for r in rates if r.persona == p])
            for p in personas
        ]
        limit_cell = f"{limit:.0f}" if limit is not None else "none"
        lines.append(f"| {seconds:g} | {results:g} | {days:g} | {limit_cell} | " + " | ".join(cells) + " |")
    lines += ["", *author_lines(assumptions), ""]
    return "\n".join(lines)


def author_lines(assumptions: dict) -> list[str]:
    timing = assumptions["measured_by_author"]
    total = timing.get("total_seconds")
    per_click = f"{total / timing['clicks']:.1f}" if total else "empty"
    head = [
        "## Seconds per card, measured by the author",
        "",
        "One person timing their own clicks, not a study and not a user. Kept out of every simulated number above. "
        + ("" if total else "Not done yet."),
        "",
        "| Clicks | Total seconds | Seconds per click | Label |",
        "|---|---|---|---|",
        f"| {timing['clicks']} | {total if total else 'empty'} | {per_click} | {timing['label']} |",
    ]
    return head


def _cell(text: str) -> str:
    return " ".join(str(text).split()).replace("|", "/")


def _range_cell(values: list[tuple[float, bool]]) -> str:
    text = span([round(v, 1) for v, _ in values])
    return text + (" (limit)" if any(hit for _, hit in values) else "")


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = argparse.ArgumentParser(prog="python -m scripts.time_model", description=__doc__.split("\n")[0])
    p.add_argument("--study", type=Path, default=STUDY)
    p.add_argument("--assumptions", type=Path, default=ASSUMPTIONS)
    p.add_argument("--out", type=Path, help="default: time_model.md in --study")
    args = p.parse_args(argv)
    try:
        assumptions = load_assumptions(args.assumptions)
    except AssumptionError as exc:
        p.error(str(exc))
    rates, skipped = read_study(args.study, assumptions["first_and_last_days"])
    if not rates:
        print(
            f"No finished simulated study run under {display_path(args.study)}: reporting nothing, nothing written."
        )
        return 0
    out = args.out or args.study / "time_model.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(rates, skipped, assumptions, command=command_line("scripts.time_model", argv)))
    print(
        f"Wrote {display_path(out)} from {len(rates)} simulated runs. Every figure is simulated and an assumption."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
