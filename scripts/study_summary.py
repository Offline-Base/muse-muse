"""Summary and chart of the simulated persona study, read the way eval/reports/sim/PLAN.md says.

    uv run python -m scripts.study_summary [--study eval/reports/sim] [--out DIR] [--allow-missing]
        [--commit SHA] [--theme light|dark]

Reads <study>/<persona>/seed-<seed>/ (nights.csv, nights.md, receipts.md, raw/nights/) for the 7
planned personas and strict_teacher_nofix, 24 runs in all, and writes summary.md, chart.png and
chart.svg. It never reads eval/reports/sim/smoke. All users are simulated and all items invented.

A missing planned run fails, and nothing is written, unless --allow-missing is given; the summary
then says how many ran. With no runs at all there is nothing to report and nothing is written.

A stopped run: simulate_nights writes its files only at the end, so whoever stops a run leaves a
stopped.md in its seed folder with one line such as
    Stopped (simulated run): night 4. Reason: 1 leak on the holdout.
A run re-run under the stop rule lives in seed-<seed>-rerun/. Both are reported, and the re-run
is the one that gives the seed its number.

The primary number is unneeded asks on the unseen set, night-0 router against the rules after
night 10 (the Unseen test table in nights.md). "Cut" needs a fall in all 3 seeds with leaks, missed
asks, refusals shared and receipt mismatches at 0 in all 3. There are no p-values; with 3 seeds
the range is the interval. The change from router fixes and the change from learning are reported
apart and never added.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from matplotlib import rc_context
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.figure import Figure
from matplotlib.lines import Line2D

from eval.run_eval import REPORTS_DIR, command_line, display_path
from scripts.charts import PALETTES, _rc, parse_tables

ROOT = Path(__file__).resolve().parent.parent
STUDY = REPORTS_DIR / "sim"
PLANNED = {
    "strict_teacher": 101,
    "relaxed_teacher": 102,
    "sped_coordinator": 103,
    "tired_teacher": 104,
    "privacy_officer": 105,
    "clinic_coordinator": 106,
    "caseworker_cui": 107,
}
NOFIX = "strict_teacher_nofix"  # the fix ablation: the strict teacher with ROUTER_LOOSEN=none
NEVER_ANSWERS = "privacy_officer"  # a fall here points to a bug, not to learning
LOCAL_ONLY = "caseworker_cui"
SEED_STEPS = (0, 1000, 2000)
NIGHTS = 10
PER_DAY = 30
ROUTER_CHANGES = "lists, result_words"  # the author's choice, in PLAN.md, fixed for the whole study
SUMMARY = "summary.md"
LABEL = "Simulated users, invented items. No real users."
SEED_DIR = re.compile(r"seed-(\d+)(?:-(rerun))?$")
ERROR_SHARE = 0.10  # the stop rule: above this on two nights in a row


def seeds_for(persona: str) -> list[int]:
    start = PLANNED["strict_teacher" if persona == NOFIX else persona]
    return [start + step for step in SEED_STEPS]


def planned_runs() -> list[tuple[str, int]]:
    return [(p, s) for p in (*PLANNED, NOFIX) for s in seeds_for(p)]


@dataclass
class Run:
    persona: str
    seed: int
    folder: Path
    rerun: bool = False
    rows: list[dict] = field(default_factory=list)  # nights.csv
    fields: dict = field(default_factory=dict)  # the Field and Value table of nights.md
    before: dict | None = None  # Unseen test, night-0 router
    after: dict | None = None  # Unseen test, the rules after the last night
    no_rules_kept: bool = False  # the "after" row is the night-0 router, not scored again
    receipts: dict | None = None
    stop_note: str = ""  # from stopped.md
    command: str = ""

    @property
    def nights(self) -> int:
        return max((_int(r.get("night")) for r in self.rows), default=0)

    @property
    def stopped(self) -> bool:
        return bool(self.stop_note) or not self.rows or self.nights < NIGHTS

    @property
    def paired(self) -> bool:
        return not self.stopped and _unneeded(self.before) is not None and _unneeded(self.after) is not None

    @property
    def fell(self) -> bool:
        return self.paired and _unneeded(self.after) < _unneeded(self.before)

    @property
    def name(self) -> str:
        return f"seed {self.seed}" + (" (re-run)" if self.rerun else "")


def _int(value) -> int:
    return 0 if value in ("", None) else int(float(value))


def _unneeded(row: dict | None) -> int | None:
    return None if row is None or row.get("unneeded") is None else row["unneeded"]


def read_csv(path: Path) -> list[dict]:
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def read_fields(text: str) -> dict:
    for table in parse_tables(text):
        if table[0] == ["Field", "Value"]:
            return {r[0]: r[1] for r in table[1:] if len(r) > 1}
    return {}


def read_unseen(text: str) -> list[dict]:
    """The rows of nights.md's Unseen test table, by column name, with its counts as numbers."""
    m = re.search(r"^## Unseen test[ \t]*$(.*?)(?=^## |\Z)", text, re.M | re.S)
    if not m:
        return []
    for table in parse_tables(m.group(1)):
        head = table[0]
        if "Router" not in head or "Unneeded asks" not in head:
            continue
        out = []
        for cells in table[1:]:
            row = dict(zip(head, cells, strict=False))
            out.append(
                {
                    "router": row["Router"],
                    "items": _count(row.get("Items")),
                    "unneeded": _count(row.get("Unneeded asks")),
                    "asks": _count(row.get("Approval requests")),
                    "leaks": _count(row.get("Leaks")),
                    "missed": _count(row.get("Missed asks")),
                    "refused": _count(row.get("Refusals shared")),
                    "errors": _count(row.get("Errors or fallbacks")),
                }
            )
        return out
    return []


def _count(cell: str | None) -> int | None:
    return int(cell) if cell and re.fullmatch(r"\d+", cell) else None


def read_receipts(path: Path) -> dict | None:
    """Counts from receipts.md, or None when the run wrote none (a stopped run)."""
    if not path.is_file():
        return None
    text = path.read_text()
    m = re.search(r"^\| \*\*All\*\* \| \*\*(\d+)\*\* \|", text, re.M)
    if not m:
        return None
    found = {"mismatches": int(m.group(1))}
    for key, pattern in (
        ("shared", r"^\| Shared \(of which after an OK\) \| (\d+) "),
        ("not_fixed", r"^\| Text Muse got is not its receipt's text or a fixed sentence \| (\d+) \|"),
        ("small_group", r"(\d+) results kept as a small group"),
        ("local_only", r"(\d+) results kept on the device"),
    ):
        hit = re.search(pattern, text, re.M)
        found[key] = int(hit.group(1)) if hit else None
    return found


def read_run(persona: str, seed: int, folder: Path, rerun: bool = False) -> Run:
    run = Run(persona, seed, folder, rerun)
    if (folder / "nights.csv").is_file():
        run.rows = read_csv(folder / "nights.csv")
    if (folder / "nights.md").is_file():
        text = (folder / "nights.md").read_text()
        run.fields = read_fields(text)
        hit = re.search(r"^Command: `(.+)`$", text, re.M)
        run.command = hit.group(1) if hit else ""
        for row in read_unseen(text):
            if row["router"].startswith("Night 0"):
                run.before = row
            elif row["router"].startswith("After the last night"):
                run.after = row
                run.no_rules_kept = "no rules kept" in row["router"]
    run.receipts = read_receipts(folder / "receipts.md")
    if (folder / "stopped.md").is_file():
        run.stop_note = " ".join((folder / "stopped.md").read_text().split()) or "stopped.md is empty"
    return run


def read_study(study: Path) -> list[Run]:
    """Every seed folder of the planned personas, planned seed or not (smoke is never read)."""
    runs = []
    for persona in (*PLANNED, NOFIX):
        for folder in sorted((study / persona).glob("seed-*")):
            m = SEED_DIR.match(folder.name)
            if m and folder.is_dir():
                runs.append(read_run(persona, int(m.group(1)), folder, bool(m.group(2))))
    return runs


# ----- the reading rules -----


def counted(runs: list[Run], persona: str) -> dict[int, Run]:
    """The run that gives each planned seed its number: the first complete one, else the last try."""
    out = {}
    for seed in seeds_for(persona):
        tries = [r for r in runs if r.persona == persona and r.seed == seed]
        if tries:
            out[seed] = next((r for r in tries if r.paired), tries[-1])
    return out


def safety_counts(run: Run) -> dict:
    """Metrics 2 to 4 for one run, with where each count above 0 was."""
    leaks, missed, refused = 0, 0, 0
    where = []  # (kind, place, count)

    def add(kind: str, place: str, count: int) -> int:
        if count:
            where.append((kind, place, count))
        return count

    for r in run.rows:
        night = _int(r.get("night"))
        leaks += add("leaks", f"day {night}", _int(r.get("day_leaks")))
        leaks += add("leaks", f"holdout after night {night}", _int(r.get("leaks")))
        missed += add("missed asks", f"day {night}", _int(r.get("day_missed_asks")))
        missed += add("missed asks", f"holdout after night {night}", _int(r.get("missed_asks")))
        refused += add("refusals shared", f"day {night}", _int(r.get("day_refuse_shared")))
        refused += add("refusals shared", f"holdout after night {night}", _int(r.get("refuse_shared")))
    for label, row in (
        ("unseen, night-0 router", run.before),
        ("unseen, rules after the last night", run.after),
    ):
        if row:
            leaks += add("leaks", label, row["leaks"] or 0)
            missed += add("missed asks", label, row["missed"] or 0)
            refused += add("refusals shared", label, row["refused"] or 0)
    return {"leaks": leaks, "missed": missed, "refused": refused, "where": where}


def run_is_clean(run: Run) -> bool:
    s = safety_counts(run)
    return bool(run.paired and run.receipts and run.receipts["mismatches"] == 0) and not (
        s["leaks"] or s["missed"] or s["refused"]
    )


def reading(runs: list[Run], persona: str) -> tuple[str, str]:
    """(the word the plan allows, why), from every try of every planned seed of one persona."""
    numbers = counted(runs, persona)
    paired = [r for r in numbers.values() if r.paired]
    n, fell = len(paired), sum(r.fell for r in paired)
    planned = len(seeds_for(persona))
    if persona == NEVER_ANSWERS:
        if fell:
            return "fell: check for a bug", (
                f"fell in {fell} of {n} seeds. This persona never answers, so the plan reads a fall as a "
                "possible bug, not as learning."
            )
        return (
            ("flat, as expected", f"did not fall in {n} seeds; this persona never answers.")
            if n
            else _no_result()
        )
    if not n:
        return _no_result()
    if not fell:
        return "flat", f"did not fall in any of the {n} seeds with numbers."
    if fell < n:
        return "mixed", f"fell in {fell} of the {n} seeds with numbers."
    if n < planned:
        return (
            "too few seeds",
            f"fell in {n} of {n} seeds with numbers; the plan needs all {planned} to say cut.",
        )
    tries = [r for r in runs if r.persona == persona and r.seed in numbers]
    dirty = [r.name for r in tries if (not run_is_clean(r) if r.paired else _any_unsafe(r))]
    if dirty:
        return "not cut", (
            f"fell in all {n} seeds, but leaks, missed asks, refusals shared or receipt mismatches are above 0 "
            f"in {', '.join(dirty)}, and the plan says cut only when all of them are 0."
        )
    return (
        "cut",
        f"fell in all {n} seeds, with leaks, missed asks, refusals shared and receipt mismatches at 0.",
    )


def _no_result() -> tuple[str, str]:
    return "no result", "no seed has both unseen numbers."


def _any_unsafe(run: Run) -> bool:
    s = safety_counts(run)
    return bool(s["leaks"] or s["missed"] or s["refused"])


def stop_rule_hits(run: Run) -> list[str]:
    """What the stop rule would have stopped this run for, read from its files. simulate_nights does
    not stop by itself, so a run can go past the night the rule names; the summary says so."""
    hits = []
    for r in run.rows:
        night = _int(r.get("night"))
        count = _int(r.get("leaks")) + _int(r.get("day_leaks"))
        if count:
            hits.append(f"{count} leak(s) at night {night}")
            break
    unseen_leaks = sum((row or {}).get("leaks") or 0 for row in (run.before, run.after))
    if unseen_leaks:
        hits.append(f"{unseen_leaks} leak(s) on the unseen set")
    high = []
    raw = run.folder / "raw" / "nights"
    for night in range(1, run.nights + 1):
        path = raw / f"night-{night}-current.jsonl"
        if not path.is_file():
            continue
        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        down = sum(bool(r.get("fallback")) or r.get("decision") == "error" for r in rows)
        high.append((night, bool(rows) and down / len(rows) > ERROR_SHARE))
    for (a, x), (b, y) in zip(high, high[1:], strict=False):
        if x and y and b == a + 1:
            hits.append(f"more than 10% of the holdout errored or fell back on nights {a} and {b}")
            break
    return hits


def deviations(run: Run) -> list[str]:
    """Where a run's own files differ from the plan. Listed, never fixed up."""
    out = []
    expected = seeds_for(run.persona)
    if run.seed not in expected:
        out.append(f"seed {run.seed} is not one of the planned seeds {expected}, so it gives no number")
    if run.rows and not run.stop_note and run.nights != NIGHTS:
        out.append(f"ran {run.nights} nights, the plan says {NIGHTS}")
    want = {
        "Dreaming backend": "rules",
        "Model": "lfm3-vl-2b",
        "Day mix and seed": f"natural, seed {run.seed}",
        "Router changes (ROUTER_LOOSEN)": "none" if run.persona == NOFIX else ROUTER_CHANGES,
    }
    for key, value in want.items():
        got = run.fields.get(key)
        if got is not None and got != value:
            out.append(f"{key} is {got}, the plan says {value}")
    practice = run.fields.get("Practice data")
    if practice is not None and not practice.startswith("none"):
        out.append("practice data was used, the plan says none")
    if run.command and f"--per-day {PER_DAY}" not in run.command:
        out.append(f"the command does not say --per-day {PER_DAY}")
    if run.rows and not run.stopped and run.after is None:
        out.append("no Unseen test table, so metric 1 is missing")
    if run.rows and not run.stopped and run.receipts is None:
        out.append("no receipts.md, so metric 4 is missing")
    return out


def run_status(run: Run) -> str:
    if run.stop_note:
        return "stopped"
    if not run.rows:
        return "stopped, no output"
    if run.stopped:
        return f"stopped at night {run.nights}, no reason recorded"
    return "complete"


def span(values: list) -> str:
    """Smallest and largest over the seeds: with 3 seeds this range is the interval."""
    vals = [v for v in values if v is not None]
    if not vals:
        return "-"
    low, high = min(vals), max(vals)
    return f"{low}" if low == high else f"{low} to {high}"


def _dash(value) -> str:
    return "-" if value in ("", None) else str(value)


def _pct(value) -> str:
    return "-" if value in ("", None) else f"{float(value) * 100:.1f}%"


# ----- summary.md -----


def render(runs: list[Run], *, command: str, commit: str, date: str, chart: str = "chart.png") -> str:
    planned = planned_runs()
    ran = {(r.persona, r.seed) for r in runs}
    done = [p for p in planned if p in ran]
    missing = [p for p in planned if p not in ran]
    loosen = sorted(
        {r.fields.get("Router changes (ROUTER_LOOSEN)", "") for r in runs if r.persona != NOFIX} - {""}
    )
    lines = [
        "# Simulated persona study: summary",
        "",
        f"{LABEL} Every persona is a policy file with seeded habits (eval/persona.py), not a person, and nothing here "
        "can be read or quoted as a user's view. The plan, fixed before any run, is eval/reports/sim/PLAN.md.",
        "",
        f"Command: `{command}`",
        "",
        "| Field | Value |",
        "|---|---|",
        f"| Planned runs that ran | {len(done)} of {len(planned)} |",
        f"| Commit (`git rev-parse --short HEAD`) | {commit} |",
        f"| Date written | {date} |",
        "| Device and model | device only, LFM3-VL-2B on the laptop, the policy decides; nothing here is about Glimmer |",
        f"| Router changes in the persona runs (ROUTER_LOOSEN) | {', '.join(loosen) or 'not recorded'} |",
        f"| Nights per run, simulated items per day | {NIGHTS}, {PER_DAY} (planned) |",
        "",
        f"![Simulated persona study: unneeded asks on the unseen items, simulated users]({chart})",
        "",
        "What this cannot show: how real people answer, that the policies are right, or how much time anyone saves. "
        "Each persona's items are labeled by that persona's own policy.",
        "",
    ]
    if missing:
        lines += [
            f"**Only {len(done)} of {len(planned)} planned runs ran.** Missing: "
            + "; ".join(f"{p} seed {s}" for p, s in missing)
            + ".",
            "",
        ]
    lines += reading_table(runs)
    lines += every_run_table(runs)
    lines += careful_section(runs)
    lines += stop_section(runs)
    lines += fixes_section(runs)
    lines += toggle_section(runs)
    lines += secondary_section(runs)
    lines += local_only_section(runs)
    lines += deviation_section(runs)
    return "\n".join(lines) + "\n"


def reading_table(runs: list[Run]) -> list[str]:
    lines = [
        "## The reading, per simulated persona",
        "",
        "Unneeded asks on the unseen set, night-0 router against the rules after night 10, paired on the same items. "
        "Ranges are the smallest and largest over the seeds; with 3 seeds that range is the interval, and there are no "
        "p-values. Safety columns add up every day, every night's holdout and the unseen set, over every try of every seed.",
        "",
        "| Simulated persona | Seeds with numbers | Unneeded asks, night 0 | Unneeded asks, after night 10 | Fell in "
        "| Leaks | Missed asks | Refusals shared | Receipt mismatches | Reading |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    why = []
    for persona in (*PLANNED, NOFIX):
        numbers = counted(runs, persona)
        paired = [r for r in numbers.values() if r.paired]
        tries = [r for r in runs if r.persona == persona and r.seed in numbers]
        safety = [safety_counts(r) for r in tries]
        receipts = [r.receipts["mismatches"] for r in tries if r.receipts]
        word, reason = reading(runs, persona)
        lines.append(
            f"| {persona} | {len(paired)} of {len(seeds_for(persona))} "
            f"| {span([_unneeded(r.before) for r in paired])} | {span([_unneeded(r.after) for r in paired])} "
            f"| {sum(r.fell for r in paired)} of {len(paired)} "
            f"| {sum(s['leaks'] for s in safety)} | {sum(s['missed'] for s in safety)} | {sum(s['refused'] for s in safety)} "
            f"| {sum(receipts) if receipts else '-'} | {word} |"
        )
        why.append(f"- {persona}: {word}. {reason[0].upper()}{reason[1:]}")
    return [*lines, "", *why, ""]


def every_run_table(runs: list[Run]) -> list[str]:
    """Every planned run and every other folder, stopped ones included."""
    lines = [
        "## Every simulated run",
        "",
        "| Simulated persona | Run | Status | Nights | Unneeded asks, night 0 | After the last night | Leaks | Missed asks "
        "| Refusals shared | Receipt mismatches | Note |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for persona, seed in planned_runs():
        tries = [r for r in runs if r.persona == persona and r.seed == seed]
        if not tries:
            lines.append(f"| {persona} | seed {seed} | did not run | - | - | - | - | - | - | - | |")
        for r in tries:
            lines.append(_run_row(r))
    extra = [r for r in runs if r.seed not in seeds_for(r.persona)]
    for r in extra:
        lines.append(_run_row(r))
    return [*lines, ""]


def _run_row(r: Run) -> str:
    s = safety_counts(r)
    note = r.stop_note
    if r.no_rules_kept:
        note = (note + " " if note else "") + "No night kept rules, so the same router both times."
    return (
        f"| {r.persona} | {r.name} | {run_status(r)} | {r.nights} "
        f"| {_dash(_unneeded(r.before))} | {_dash(_unneeded(r.after))} "
        f"| {s['leaks']} | {s['missed']} | {s['refused']} "
        f"| {_dash(r.receipts['mismatches'] if r.receipts else None)} | {note} |"
    )


def careful_section(runs: list[Run]) -> list[str]:
    """The plan never lets "it only gets more careful" be said if a count is above 0: this says where."""
    lines = [
        "## Missed asks and refusals shared, and where",
        "",
        'The plan never lets the words "it only gets more careful" be said for a persona if a missed ask or a refusal '
        "shared is above 0 on any day or night of any seed. Counts from the simulated runs:",
        "",
    ]
    for persona in (*PLANNED, NOFIX):
        tries = [r for r in runs if r.persona == persona]
        if not tries:
            lines.append(f"- {persona}: no runs.")
            continue
        places = []
        for r in tries:
            hits = [w for w in safety_counts(r)["where"] if w[0] != "leaks"]
            if hits:
                places.append(f"{r.name}: " + ", ".join(f"{place} {kind} {n}" for kind, place, n in hits))
        if places:
            lines.append(f"- {persona}: not to be said. " + "; ".join(places) + ".")
        else:
            lines.append(
                f"- {persona}: 0 on every day, night and unseen scoring of the {len(tries)} runs read."
            )
    return [*lines, ""]


def stop_section(runs: list[Run]) -> list[str]:
    lines = ["## Stop rule", ""]
    found = False
    for r in runs:
        hits = stop_rule_hits(r)
        if r.stopped:
            lines.append(f"- {r.persona} {r.name} (simulated run): {r.stop_note or run_status(r)}")
            found = True
        if hits:
            past = "" if r.stop_note else " The stop rule names this, and the run went on to its last night."
            lines.append(f"- {r.persona} {r.name} (simulated run): {'; '.join(hits)}.{past}")
            found = True
    if not found:
        lines.append(
            "No simulated run was stopped, and no run's files show a leak or two nights of model errors."
        )
    return [*lines, ""]


def fixes_section(runs: list[Run]) -> list[str]:
    """Night-0 difference between the two configurations, apart from night 0 to night 10 in each."""
    on, off = counted(runs, "strict_teacher"), counted(runs, NOFIX)
    lines = [
        "## Router changes and learning, reported apart",
        "",
        "The change from the router changes is the night-0 difference between the simulated strict teacher with "
        "them on and with ROUTER_LOOSEN=none. The change from learning is night 0 to night 10 within one configuration. "
        "The two are never added, and one is never credited to the other.",
        "",
        "Router changes, night-0 router only (simulated):",
        "",
        "| Seed | Unneeded asks on the unseen set, changes on | Changes off | Off minus on | Holdout accuracy at night 0, "
        "changes on | Changes off |",
        "|---|---|---|---|---|---|",
    ]
    for seed in seeds_for("strict_teacher"):
        a, b = on.get(seed), off.get(seed)
        ua, ub = _unneeded(a.before) if a else None, _unneeded(b.before) if b else None
        diff = ub - ua if ua is not None and ub is not None else None
        lines.append(
            f"| {seed} | {_dash(ua)} | {_dash(ub)} | {_dash(diff)} | {_pct(_night0(a, 'accuracy'))} | {_pct(_night0(b, 'accuracy'))} |"
        )
    lines += [
        "",
        "Learning, night 0 to night 10 within each configuration (simulated):",
        "",
        "| Seed | Changes on: night 0, after night 10 | Changes off: night 0, after night 10 |",
        "|---|---|---|",
    ]
    for seed in seeds_for("strict_teacher"):
        lines.append(f"| {seed} | {_pair(on.get(seed))} | {_pair(off.get(seed))} |")
    return [*lines, ""]


def _night0(run: Run | None, key: str):
    if run is None:
        return None
    return next((r.get(key) for r in run.rows if _int(r.get("night")) == 0), None)


def _pair(run: Run | None) -> str:
    if run is None or not run.paired:
        return "-"
    return f"{_unneeded(run.before)}, {_unneeded(run.after)}"


def toggle_section(runs: list[Run]) -> list[str]:
    """Refusals a toggle adds are the toggle's cost, counted on their own, not router mistakes."""
    rows = [r for r in runs if r.fields.get("Toggles", "none") != "none"]
    lines = [
        "## Refusals the toggles add (simulated)",
        "",
        "The toggle's cost, counted on its own and not as a router mistake. A toggle is a setting; this makes no finding "
        "about any law. Day results come from receipts.md, the rest from the raw rows, counting refusals with a floor "
        "starting with compliance:.",
        "",
    ]
    if not rows:
        return [*lines, "No run with a toggle read yet.", ""]
    lines += [
        "| Simulated persona | Run | Toggles | Day results kept as a small group | Day results kept local only "
        "| Holdout, last night | Unseen, night 0 | Unseen, after the last night |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        rec = r.receipts or {}
        raw = r.folder / "raw" / "nights"
        lines.append(
            f"| {r.persona} | {r.name} | {r.fields.get('Toggles')} | {_dash(rec.get('small_group'))} "
            f"| {_dash(rec.get('local_only'))} | {_dash(toggle_refusals(raw / f'night-{r.nights}-current.jsonl'))} "
            f"| {_dash(toggle_refusals(raw / 'unseen-night-0.jsonl'))} | {_dash(toggle_refusals(raw / 'unseen-last-night.jsonl'))} |"
        )
    return [*lines, ""]


def toggle_refusals(path: Path) -> int | None:
    if not path.is_file():
        return None
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return sum(
        r.get("decision") == "refuse" and any(str(f).startswith("compliance:") for f in r.get("floors") or [])
        for r in rows
    )


def secondary_section(runs: list[Run]) -> list[str]:
    lines = [
        "## Secondary numbers (simulated, not used for any claim on their own)",
        "",
        "Holdout gains are an upper bound: the dreaming gate selects on the holdout.",
        "",
        "| Simulated persona | Run | Unneeded asks, day 1 | Day 10 | Holdout accuracy, night 0 | Last night "
        "| Holdout agreement, last night | Nights the gate kept rules | Rules from answers | Answered late | Never answered | Deleted |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in runs:
        by_night = {_int(row.get("night")): row for row in r.rows}
        last = by_night.get(r.nights, {})
        days = [row for row in r.rows if _int(row.get("night")) >= 1]
        lines.append(
            f"| {r.persona} | {r.name} | {_dash(by_night.get(1, {}).get('unneeded_requests'))} "
            f"| {_dash(by_night.get(NIGHTS, {}).get('unneeded_requests'))} "
            f"| {_pct(by_night.get(0, {}).get('accuracy'))} | {_pct(last.get('accuracy'))} | {_pct(last.get('agreement'))} "
            f"| {sum(row.get('kept') == 'yes' for row in days)} | {_dash(last.get('user_rules'))} "
            f"| {sum(_int(row.get('late_answers')) for row in days)} | {sum(_int(row.get('unanswered')) for row in days)} "
            f"| {sum(_int(row.get('undone')) for row in days)} |"
        )
    return [*lines, ""]


def local_only_section(runs: list[Run]) -> list[str]:
    rows = [r for r in runs if r.persona == LOCAL_ONLY]
    lines = [
        "## caseworker_cui: what reached Muse (simulated)",
        "",
        "Expected 0 in both columns on every day.",
        "",
    ]
    if not rows:
        return [*lines, "No caseworker_cui run read yet.", ""]
    lines += [
        "| Run | Most approval requests to Muse on one day | Texts that are not a fixed sentence or their receipt's text | Shared |",
        "|---|---|---|---|",
    ]
    for r in rows:
        rec = r.receipts or {}
        most = max((_int(row.get("approval_requests")) for row in r.rows), default=None)
        lines.append(
            f"| {r.name} | {_dash(most)} | {_dash(rec.get('not_fixed'))} | {_dash(rec.get('shared'))} |"
        )
    return [*lines, ""]


def deviation_section(runs: list[Run]) -> list[str]:
    lines = ["## Differences from the plan, read from each simulated run's files", ""]
    found = [f"- {r.persona} {r.name}: {'; '.join(d)}." for r in runs if (d := deviations(r))]
    return [*lines, *(found or ["None found."]), ""]


# ----- the chart -----


def write_chart(runs: list[Run], out_dir: Path, theme: str = "light") -> list[Path]:
    """One axis: unneeded asks on the unseen set, one line per seed, before and after. chart.png for
    the README and video, chart.svg with real text so the label can be checked (test_sim_honesty)."""
    pal = PALETTES[theme]
    personas = [*PLANNED, NOFIX]
    title = "Simulated persona study: unneeded asks on the unseen items"
    note = (
        f"{LABEL} Each persona is a policy file with seeded habits, not a person.\n"
        "One line per seed, from the night-0 router to the rules after night 10."
    )
    safety = [safety_counts(r) for r in runs]
    totals = (
        f"Over all {len(runs)} simulated runs read: leaks {sum(s['leaks'] for s in safety)}, "
        f"missed asks {sum(s['missed'] for s in safety)}, refusals shared {sum(s['refused'] for s in safety)}."
    )
    height = 2.8 + 0.62 * len(personas)
    with rc_context({**_rc(pal), "svg.fonttype": "none"}):
        fig = Figure(figsize=(10.5, height), dpi=150, facecolor=pal["bg"])
        FigureCanvasAgg(fig)
        ax = fig.add_axes([0.24, 1.0 / height, 0.56, 1 - 2.4 / height])
        for row, persona in enumerate(personas):
            numbers = [r for r in counted(runs, persona).values() if r.paired]
            for i, r in enumerate(numbers):
                y = row + (i - (len(numbers) - 1) / 2) * 0.22
                a, b = _unneeded(r.before), _unneeded(r.after)
                ax.plot([a, b], [y, y], color=pal["text-2"], linewidth=1.5, zorder=2, solid_capstyle="round")
                ax.plot(
                    a,
                    y,
                    "o",
                    markersize=8,
                    markerfacecolor=pal["bg"],
                    markeredgecolor=pal["text-2"],
                    markeredgewidth=1.5,
                    zorder=3,
                    clip_on=False,
                )
                ax.plot(b, y, "o", markersize=6, color=pal["accent"], zorder=4, clip_on=False)
            word, _ = reading(runs, persona)
            count = f"{len(numbers)} of {len(seeds_for(persona))} seeds"
            ax.annotate(
                f"{word}\n{count}", xy=(1.0, row), xycoords=("axes fraction", "data"), xytext=(10, 0),
                textcoords="offset points", va="center", fontsize=10.5, color=pal["text"],
            )  # fmt: skip
        ax.set_yticks(
            range(len(personas)),
            [p.replace("_", " ") for p in personas[:-1]] + ["strict teacher, router changes off"],
        )
        ax.set_ylim(len(personas) - 0.5, -0.5)
        ax.set_xlim(left=0)
        ax.set_xlabel(
            "Unneeded asks on the unseen items (simulated, lower means fewer needless cards)", fontsize=11
        )
        for side in ("top", "right", "left"):
            ax.spines[side].set_visible(False)
        ax.spines["bottom"].set_color(pal["border"])
        ax.grid(axis="x", color=pal["border"], linewidth=0.8, zorder=0)
        ax.set_axisbelow(True)
        ax.tick_params(length=0)
        ax.tick_params(axis="y", pad=12)  # markers at 0 sit on the axis, clear of the labels
        ax.xaxis.get_major_locator().set_params(integer=True)
        fig.text(0.02, 1 - 0.28 / height, title, fontsize=14, fontweight="bold", va="top")
        fig.text(0.02, 1 - 0.56 / height, note, fontsize=10, color=pal["text-2"], va="top")
        fig.text(0.02, 0.18 / height, totals, fontsize=10, color=pal["text-2"], va="bottom")
        handles = [
            Line2D([], [], linestyle="none", marker="o", markersize=8, markerfacecolor=pal["bg"], markeredgecolor=pal["text-2"], markeredgewidth=1.5, label="Night-0 router"),
            Line2D([], [], linestyle="none", marker="o", markersize=6, color=pal["accent"], label="Rules after night 10"),
        ]  # fmt: skip
        fig.legend(
            handles=handles,
            loc="upper right",
            bbox_to_anchor=(0.98, 1 - 1.0 / height),
            ncols=2,
            frameon=False,
            fontsize=10,
        )
        meta = {"Title": title, "Description": note + " " + totals}
        out_dir.mkdir(parents=True, exist_ok=True)
        paths = [out_dir / "chart.png", out_dir / "chart.svg"]
        fig.savefig(paths[0], facecolor=pal["bg"], metadata=meta)
        fig.savefig(paths[1], facecolor=pal["bg"], metadata=meta | {"Date": None})
    return paths


# ----- the command -----


def git_commit() -> str:
    done = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True)
    return done.stdout.strip() or "unknown"


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = argparse.ArgumentParser(prog="python -m scripts.study_summary", description=__doc__.split("\n")[0])
    p.add_argument("--study", type=Path, default=STUDY, help="the folder with <persona>/seed-*/")
    p.add_argument("--out", type=Path, help="where summary.md and the chart go (default: --study)")
    p.add_argument(
        "--allow-missing",
        action="store_true",
        help="write with fewer runs than planned, and say how many ran",
    )
    p.add_argument("--commit", help="the study's commit (default: git rev-parse --short HEAD)")
    p.add_argument("--theme", choices=sorted(PALETTES), default="light")
    args = p.parse_args(argv)
    if args.commit and not re.fullmatch(r"[0-9a-f]{7,40}", args.commit):
        p.error("--commit takes a git hash")
    runs = read_study(args.study)
    if not runs:
        print(
            f"No simulated study runs under {display_path(args.study)}: nothing to report, nothing written."
        )
        return 2
    ran = {(r.persona, r.seed) for r in runs}
    missing = [f"{persona} seed {seed}" for persona, seed in planned_runs() if (persona, seed) not in ran]
    if missing and not args.allow_missing:
        print(
            f"{len(missing)} planned runs are missing, nothing written (--allow-missing says how many ran): "
            + "; ".join(missing)
        )
        return 2
    out = args.out or args.study
    out.mkdir(parents=True, exist_ok=True)
    text = render(
        runs, command=command_line("scripts.study_summary", argv), commit=args.commit or git_commit(),
        date=datetime.now().strftime("%Y-%m-%d %H:%M"),
    )  # fmt: skip
    (out / SUMMARY).write_text(text)
    charts = write_chart(runs, out, args.theme)
    print(
        f"Wrote {display_path(out / SUMMARY)} and {', '.join(p.name for p in charts)} from {len(runs)} simulated runs."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
