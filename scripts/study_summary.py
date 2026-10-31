"""Summary and chart of the simulated persona study, read the way eval/reports/sim/PLAN.md says.

    uv run python -m scripts.study_summary [--study eval/reports/sim] [--out DIR] [--allow-missing]
        [--commit SHA] [--theme light|dark]

Reads <study>/<persona>/seed-<seed>/ (nights.csv, nights.md, receipts.md, raw/nights/) for the 7
planned personas and strict_teacher_nofix, 24 runs in all, and writes summary.md, chart.png and
chart.svg. It never reads eval/reports/sim/smoke. All users are simulated and all items invented.

A missing planned run fails, and nothing is written, unless --allow-missing is given; the summary
then says how many ran. A folder with neither nights.csv nor stopped.md is missing, not a run. With
no runs at all there is nothing to report and nothing is written.

A stopped run: simulate_nights writes its files only at the end, so whoever stops a run leaves a
stopped.md in its seed folder with one line such as
    Stopped (simulated run): night 4. Reason: 1 leak on the holdout.
A run re-run under the stop rule lives in seed-<seed>-rerun/. Both are reported, and the re-run
is the one that gives the seed its number. The plan allows one re-run, and only after model errors.
Any other folder under a persona is listed as a difference from the plan, and its counts still count.

The primary number is unneeded asks on the unseen set, night-0 router against the rules after
night 10 (the Unseen test table in nights.md). "Cut" needs a fall in all 3 seeds with leaks, missed
asks, refusals shared and receipt mismatches at 0 in all 3. There are no p-values; with 3 seeds
the range is the interval. The change from router fixes and the change from learning are reported
apart and never added.

A seed gets a number only from a complete run that follows the plan and whose two unseen scorings
cover the same items with 0 errors or fallbacks; otherwise the reason is listed. A count that cannot
be read is not 0: it prints as "-" and blocks "cut". The one exception is a try stopped for model
errors with a re-run beside it, which the plan expects: it prints "-", the reading says so, and any
count above 0 in it still blocks "cut".
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
METRICS = {
    "leaks": "leaks",
    "missed": "missed asks",
    "refused": "refusals shared",
    "receipts": "receipt mismatches",
}
PLANNED_SETUP = {
    "Device": "laptop",
    "Backend": "llama_server",
    "Model": "lfm3-vl-2b",
    "Dreaming backend": "rules",
}


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
    stray: bool = False  # a folder whose name is not seed-N or seed-N-rerun: reported, gives no number
    wrote: bool = False  # nights.csv is there
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
    def ran(self) -> bool:
        """A folder with neither nights.csv nor stopped.md is a missing run, not a run that ran."""
        return self.wrote or bool(self.stop_note)

    @property
    def stopped(self) -> bool:
        return bool(self.stop_note) or not self.rows or self.nights < NIGHTS

    @property
    def paired(self) -> bool:
        return not self.stopped and not no_number(self)

    @property
    def fell(self) -> bool:
        return self.paired and _unneeded(self.after) < _unneeded(self.before)

    @property
    def name(self) -> str:
        if self.stray:
            return f"folder {self.folder.name}"
        return f"seed {self.seed}" + (" (re-run)" if self.rerun else "")


def _cell(value) -> int | None:
    """A count from nights.csv, or None when it is absent or cannot be read (never read as 0)."""
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _int(value) -> int:
    """For the night number and the secondary columns, where nothing is claimed from a 0."""
    return _cell(value) or 0


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
        run.wrote = True
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
    """Every folder of the planned personas, planned seed or not (smoke is never read). One whose name
    the plan does not give is still read, so its counts count and it cannot be hidden by its name."""
    runs = []
    for persona in (*PLANNED, NOFIX):
        for folder in sorted((study / persona).glob("*")):
            if not folder.is_dir() or folder.name.startswith("."):
                continue
            m = SEED_DIR.match(folder.name)
            if m:
                runs.append(read_run(persona, int(m.group(1)), folder, bool(m.group(2))))
                continue
            lead = re.match(r"seed-(\d+)", folder.name)
            run = read_run(persona, int(lead.group(1)) if lead else -1, folder)
            run.stray = True
            runs.append(run)
    return runs


# ----- the reading rules -----


def counted(runs: list[Run], persona: str) -> dict[int, Run]:
    """The run that gives each planned seed its number: the first complete one, else the last try."""
    out = {}
    for seed in seeds_for(persona):
        tries = [r for r in runs if r.persona == persona and r.seed == seed and not r.stray]
        if tries:
            out[seed] = next((r for r in tries if r.paired), tries[-1])
    return out


def stop_cause(note: str) -> str:
    """Why a stopped.md says the run stopped: "leak", "model errors", or "unknown"."""
    reason = note.lower().split("reason:", 1)[-1]
    if re.search(r"\bleaks?\b", reason):
        numbers = re.findall(r"(\d+)\s+(?:\w+\s+)?leaks?\b", reason)
        if not numbers or any(int(n) for n in numbers):
            return "leak"
    return (
        "model errors"
        if re.search(r"\b(model|errors?|errored|fell back|fallbacks?)\b", reason)
        else "unknown"
    )


def stop_leaks(note: str) -> int:
    """The leaks a stop note names: at least 1 when it says a leak with no number."""
    if stop_cause(note) != "leak":
        return 0
    numbers = re.findall(r"(\d+)\s+(?:\w+\s+)?leaks?\b", note.lower().split("reason:", 1)[-1])
    return max([int(n) for n in numbers] or [1])


def safety_counts(run: Run) -> dict:
    """Metrics 2 to 4 for one run, with where each count above 0 was, and which could not be read.
    A count in "unknown" is the least it can be, never a clean 0."""
    counts = dict.fromkeys(METRICS, 0)
    unknown = set()
    where = []  # (kind, place, count)

    def add(key: str, place: str, count: int | None) -> None:
        if count is None:
            unknown.add(key)
        elif count:
            counts[key] += count
            where.append((METRICS[key], place, count))

    seen = {_cell(r.get("night")) for r in run.rows}
    if not run.rows or set(range(run.nights + 1)) - seen:
        unknown |= {"leaks", "missed", "refused"}
    for r in run.rows:
        night = _int(r.get("night"))
        if night >= 1:  # night 0 has no day
            add("leaks", f"day {night}", _cell(r.get("day_leaks")))
            add("missed", f"day {night}", _cell(r.get("day_missed_asks")))
            add("refused", f"day {night}", _cell(r.get("day_refuse_shared")))
        add("leaks", f"holdout after night {night}", _cell(r.get("leaks")))
        add("missed", f"holdout after night {night}", _cell(r.get("missed_asks")))
        add("refused", f"holdout after night {night}", _cell(r.get("refuse_shared")))
    for label, row in (
        ("unseen, night-0 router", run.before),
        ("unseen, rules after the last night", run.after),
    ):
        if row:
            add("leaks", label, row["leaks"])
            add("missed", label, row["missed"])
            add("refused", label, row["refused"])
        elif not run.stopped:
            unknown |= {"leaks", "missed", "refused"}
    if run.receipts:
        add("receipts", "receipts.md", run.receipts["mismatches"])
    else:
        unknown.add("receipts")
    named = stop_leaks(run.stop_note)
    if named > counts["leaks"]:  # the note is the only record: the files came to an end before it
        where.append(("leaks", "the stop note", named - counts["leaks"]))
        counts["leaks"] = named
        unknown.add("leaks")
    return {**counts, "where": where, "unknown": unknown}


def count_cell(value: int, unknown: bool) -> str:
    if not unknown:
        return str(value)
    return f"at least {value}" if value else "-"


def excused(run: Run, runs: list[Run]) -> bool:
    """A try stopped for model errors with its re-run beside it: the one try the plan expects to
    have no counts. Unknown counts here do not block "cut"; a count above 0 still does."""
    return (
        bool(run.stop_note)
        and not run.rerun
        and not run.stray
        and stop_cause(run.stop_note) == "model errors"
        and any(r.rerun and r.persona == run.persona and r.seed == run.seed for r in runs)
    )


def blockers(runs: list[Run], persona: str) -> list[str]:
    """Everything that keeps this persona from "cut", over every folder of it."""
    out = []
    for r in (r for r in runs if r.persona == persona):
        out += [f"{r.name}: {d}" for d in (*no_number(r), *sibling_problems(r, runs))]
        if not r.ran:
            continue
        s = safety_counts(r)
        above = [label for key, label in METRICS.items() if s[key]]
        if above:
            out.append(f"{', '.join(above)} above 0 in {r.name}")
        unread = [label for key, label in METRICS.items() if key in s["unknown"] and not s[key]]
        if unread and not excused(r, runs):
            out.append(f"{', '.join(unread)} not known in {r.name}")
    return out


def reading(runs: list[Run], persona: str) -> tuple[str, str]:
    """(the word the plan allows, why), from every try of every planned seed of one persona."""
    numbers = counted(runs, persona)
    paired = [r for r in numbers.values() if r.paired]
    n, fell = len(paired), sum(r.fell for r in paired)
    planned = len(seeds_for(persona))
    problems = blockers(runs, persona)
    if persona == NEVER_ANSWERS and fell:
        word, why = (
            "fell: check for a bug",
            (
                f"fell in {fell} of {n} seeds. This persona never answers, so the plan reads a fall as a "
                "possible bug, not as learning."
            ),
        )
    elif not n:
        word, why = _no_result()
    elif persona == NEVER_ANSWERS:
        word, why = "flat, as expected", f"did not fall in {n} seeds; this persona never answers."
    elif not fell:
        word, why = "flat", f"did not fall in any of the {n} seeds with numbers."
    elif fell < n:
        word, why = "mixed", f"fell in {fell} of the {n} seeds with numbers."
    elif n < planned:
        word, why = (
            "too few seeds",
            f"fell in {n} of {n} seeds with numbers; the plan needs all {planned} to say cut.",
        )
    elif problems:
        return "not cut", (
            f"fell in all {n} seeds, but {'; '.join(problems)}. The plan says cut only when the runs follow it "
            "and leaks, missed asks, refusals shared and receipt mismatches are all 0."
        )
    else:
        no_counts = [
            r.name for r in runs if r.persona == persona and excused(r, runs) and safety_counts(r)["unknown"]
        ]
        note = (
            f" The stopped try of {', '.join(no_counts)} wrote no counts for some of these: it stopped for model "
            "errors, and the plan re-runs it."
            if no_counts
            else ""
        )
        return (
            "cut",
            f"fell in all {n} seeds, with leaks, missed asks, refusals shared and receipt mismatches at 0.{note}",
        )
    return word, why + (f" Also: {'; '.join(problems)}." if problems else "")


def _no_result() -> tuple[str, str]:
    return "no result", "no seed has a number."


def raw_night(run: Run, night: int) -> list[dict]:
    """The holdout rows of one night; empty when the run has none."""
    path = run.folder / "raw" / "nights" / f"night-{night}-current.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def unchecked_nights(run: Run) -> list[int]:
    """Nights with no raw rows, where the stop rule's model errors cannot be seen."""
    return [night for night in range(1, run.nights + 1) if not raw_night(run, night)]


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
    for night in range(1, run.nights + 1):
        rows = raw_night(run, night)
        if rows:
            down = sum(bool(r.get("fallback")) or r.get("decision") == "error" for r in rows)
            high.append((night, down / len(rows) > ERROR_SHARE))
    for (a, x), (b, y) in zip(high, high[1:], strict=False):
        if x and y and b == a + 1:
            hits.append(f"more than 10% of the holdout errored or fell back on nights {a} and {b}")
            break
    return hits


def off_plan(run: Run) -> list[str]:
    """Where a run's own files, or its folder, differ from what the plan fixes."""
    out = []
    expected = seeds_for(run.persona)
    if run.stray:
        out.append(
            f"the folder {run.folder.name} is not seed-N or seed-N-rerun (the plan allows one re-run), so it "
            "gives no number, and its counts still count"
        )
    elif run.seed not in expected:
        out.append(f"seed {run.seed} is not one of the planned seeds {expected}, so it gives no number")
    if not run.ran:
        return [*out, "no nights.csv or stopped.md, so it counts as missing"]
    if run.stop_note and stop_cause(run.stop_note) == "unknown":
        out.append("the stop note names no reason the plan gives (a leak, or model errors)")
    if not run.wrote:
        return out
    if not run.rows:
        out.append("nights.csv has no rows")
    if run.rows and not run.stop_note and run.nights != NIGHTS:
        out.append(f"ran {run.nights} nights, the plan says {NIGHTS}")
    seen = {_cell(r.get("night")) for r in run.rows}
    gaps = sorted(set(range(run.nights + 1)) - seen) if run.rows else []
    if gaps:
        out.append(f"nights.csv has no row for night {', '.join(map(str, gaps))}")
    want = {
        **PLANNED_SETUP,
        "Day mix and seed": f"natural, seed {run.seed}",
        "Router changes (ROUTER_LOOSEN)": "none" if run.persona == NOFIX else ROUTER_CHANGES,
    }
    for key, value in want.items():
        got = run.fields.get(key)
        if got != value:
            out.append(f"{key} is {got or 'not recorded'}, the plan says {value}")
    practice = run.fields.get("Practice data")
    if practice is None or not practice.startswith("none"):
        out.append("practice data was used or is not recorded, the plan says none")
    if f"--per-day {PER_DAY}" not in run.command:
        out.append(f"the command does not say --per-day {PER_DAY}")
    return out


def pairing_problems(run: Run) -> list[str]:
    """Why metric 1 of a complete run cannot be read as a paired fall. An errored row stops counting
    as an ask (eval/run_eval.py), so errors in the last scoring would look like learning."""
    if run.stopped:
        return []
    if run.before is None or run.after is None:
        return ["no Unseen test table, so metric 1 is missing"]
    out = []
    if _unneeded(run.before) is None or _unneeded(run.after) is None:
        out.append("an Unneeded asks cell of the Unseen test table cannot be read")
    a, b = run.before["items"], run.after["items"]
    if a is None or a != b:
        out.append(f"the unseen scorings cover {_dash(a)} and {_dash(b)} items, so they are not paired")
    errors = (run.before["errors"], run.after["errors"])
    if errors != (0, 0):
        out.append(
            f"the unseen scorings have {_dash(errors[0])} and {_dash(errors[1])} errors or fallbacks, so a fall "
            "cannot be read as learning"
        )
    return out


def no_number(run: Run) -> list[str]:
    """Why this run gives its seed no number. Empty for a run that can."""
    return [*off_plan(run), *pairing_problems(run)]


def deviations(run: Run) -> list[str]:
    """Where a run's own files differ from the plan. Listed, never fixed up."""
    out = no_number(run)
    if run.rows and not run.stopped and run.receipts is None:
        out.append("no readable receipts.md, so metric 4 is missing")
    return out


def sibling_problems(run: Run, runs: list[Run]) -> list[str]:
    """What the plan says about this run given the others: one re-run, only after model errors, and
    no more runs of a persona after a leak."""
    if run.stray:
        return []
    out = []
    mine = [r for r in runs if r.persona == run.persona and not r.stray and r.ran]
    if run.rerun:
        first = next((r for r in mine if r.seed == run.seed and not r.rerun), None)
        if first is None:
            out.append("a re-run with no first run beside it")
        elif not first.stop_note or stop_cause(first.stop_note) != "model errors":
            out.append(
                "a re-run, but the first run was not stopped for model errors, the only reason the plan allows"
            )
    planned = seeds_for(run.persona)
    if run.seed in planned:
        order = (planned.index(run.seed), run.rerun)
        for r in mine:
            if r.seed in planned and (planned.index(r.seed), r.rerun) < order and safety_counts(r)["leaks"]:
                out.append(f"ran after a leak in {r.name}, and the plan starts no more runs of this persona")
                break
    return out


def run_status(run: Run) -> str:
    if not run.ran:
        return "no nights.csv or stopped.md, counted as missing"
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
    try:
        return f"{float(value) * 100:.1f}%"
    except (TypeError, ValueError):
        return "-"


# ----- summary.md -----


def render(runs: list[Run], *, command: str, commit: str, date: str, chart: str = "chart.png") -> str:
    planned = planned_runs()
    ran = planned_that_ran(runs)
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
        f"| Device and model, from the runs' own files | {setup_cell(runs)} |",
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


def planned_that_ran(runs: list[Run]) -> set[tuple[str, int]]:
    return {(r.persona, r.seed) for r in runs if r.ran and not r.stray}


def setup_cell(runs: list[Run]) -> str:
    """What the runs' own files say they ran on, never a fixed sentence."""
    read = [r for r in runs if r.wrote]
    if not read:
        return "not recorded: no run wrote nights.md"
    seen = {key: sorted({r.fields.get(key, "not recorded") for r in read}) for key in PLANNED_SETUP}
    text = "; ".join(f"{key} {' and '.join(values)}" for key, values in seen.items())
    if all(values == [PLANNED_SETUP[key]] for key, values in seen.items()):
        return f"{text}, as the plan fixes (device only, the policy decides); nothing here is about Glimmer"
    return f"{text}. **Not what the plan fixes**, so those runs give no number; see the differences from the plan"


def safety_cell(tries: list[Run], key: str) -> str:
    """The sum over every try, and the smallest and largest over the seeds whose counts are all known."""
    if not tries:
        return "-"
    per_seed: dict[int, int] = {}
    not_known = set()
    for r in tries:
        s = safety_counts(r)
        per_seed[r.seed] = per_seed.get(r.seed, 0) + s[key]
        if key in s["unknown"]:
            not_known.add(r.seed)
    total = sum(per_seed.values())
    known = [v for seed, v in per_seed.items() if seed not in not_known]
    if not not_known:
        return f"{total} (seeds: {span(known)})"
    head = f"at least {total}" if total or known else "-"
    return f"{head} (seeds read in full: {span(known)})" if known else head


def reading_table(runs: list[Run]) -> list[str]:
    lines = [
        "## The reading, per simulated persona",
        "",
        "Unneeded asks on the unseen set, night-0 router against the rules after night 10. A seed has a number only from "
        "a complete run that follows the plan and whose two scorings cover the same items with 0 errors or fallbacks; "
        "any other run stays in the table below with its reason. Ranges are the smallest and largest over the seeds; with "
        "3 seeds that range is the interval, and there are no p-values. Safety columns add up every day, every night's "
        'holdout and the unseen set, over every try of every seed, with the per-seed range in brackets. "-" or "at least" '
        "means a count could not be read; it is not a 0.",
        "",
        "| Simulated persona | Seeds with numbers | Unneeded asks, night 0 | Unneeded asks, after night 10 | Fell in "
        "| Leaks | Missed asks | Refusals shared | Receipt mismatches | Reading |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    why = []
    for persona in (*PLANNED, NOFIX):
        numbers = counted(runs, persona)
        paired = [r for r in numbers.values() if r.paired]
        tries = [r for r in runs if r.persona == persona and r.ran]
        word, reason = reading(runs, persona)
        lines.append(
            f"| {persona} | {len(paired)} of {len(seeds_for(persona))} "
            f"| {span([_unneeded(r.before) for r in paired])} | {span([_unneeded(r.after) for r in paired])} "
            f"| {sum(r.fell for r in paired)} of {len(paired)} "
            f"| {safety_cell(tries, 'leaks')} | {safety_cell(tries, 'missed')} | {safety_cell(tries, 'refused')} "
            f"| {safety_cell(tries, 'receipts')} | {word} |"
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
    cells = {key: count_cell(s[key], key in s["unknown"]) for key in METRICS}
    note = r.stop_note
    if r.ran and not r.paired and not r.stop_note and (reasons := no_number(r)):
        note = f"Gives no number: {'; '.join(reasons)}."
    if r.no_rules_kept:
        note = (note + " " if note else "") + "No night kept rules, so the same router both times."
    return (
        f"| {r.persona} | {r.name} | {run_status(r)} | {r.nights if r.rows else '-'} "
        f"| {_dash(_unneeded(r.before))} | {_dash(_unneeded(r.after))} "
        f"| {cells['leaks']} | {cells['missed']} | {cells['refused']} | {cells['receipts']} | {note} |"
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
        tries = [r for r in runs if r.persona == persona and r.ran]
        if not tries:
            lines.append(f"- {persona}: no runs.")
            continue
        places, unread = [], []
        for r in tries:
            s = safety_counts(r)
            hits = [w for w in s["where"] if w[0] in (METRICS["missed"], METRICS["refused"])]
            if hits:
                places.append(f"{r.name}: " + ", ".join(f"{place} {kind} {n}" for kind, place, n in hits))
            if s["unknown"] & {"missed", "refused"}:
                unread.append(r.name)
        known = f" Not known for {', '.join(unread)}: its files have no such counts." if unread else ""
        if places:
            lines.append(f"- {persona}: not to be said. " + "; ".join(places) + "." + known)
        elif unread:
            lines.append(f"- {persona}: not to be said.{known}")
        else:
            lines.append(
                f"- {persona}: 0 on every day, night and unseen scoring of the {len(tries)} runs read."
            )
    return [*lines, ""]


def stop_section(runs: list[Run]) -> list[str]:
    lines = ["## Stop rule", ""]
    found = False
    unchecked = []
    for r in runs:
        if not r.ran:
            continue
        hits = stop_rule_hits(r)
        if r.stopped:
            after = ""
            if stop_cause(r.stop_note) == "leak":
                after = " After a leak the plan starts no more runs of this persona until the cause is found, and a fix starts a new study."
            lines.append(f"- {r.persona} {r.name} (simulated run): {r.stop_note or run_status(r)}{after}")
            found = True
        if hits:
            past = "" if r.stop_note else " The stop rule names this, and the run went on to its last night."
            lines.append(f"- {r.persona} {r.name} (simulated run): {'; '.join(hits)}.{past}")
            found = True
        nights = unchecked_nights(r)
        if not r.rows:
            unchecked.append(f"{r.persona} {r.name} (no nights read)")
        elif nights:
            unchecked.append(f"{r.persona} {r.name} (night {', '.join(map(str, nights))})")
    if not found:
        lines.append(
            "No simulated run was stopped, and no run's files show a leak"
            + (" or two nights of model errors." if not unchecked else ".")
        )
    if unchecked:
        lines += ["", f"Could not check for model errors, no raw rows: {'; '.join(unchecked)}."]
    lines += [
        "",
        "A run writes no raw rows for night 0, so model errors on nights 0 and 1 together cannot be seen from these files.",
    ]
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
        a, b = a if a and a.paired else None, b if b and b.paired else None
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
    read = [r for r in runs if r.rows]
    lines = [
        "## Secondary numbers (simulated, not used for any claim on their own)",
        "",
        "Holdout gains are an upper bound: the dreaming gate selects on the holdout.",
        "",
        "| Simulated persona | Run | Nights the gate kept rules | Rules from answers | Answered late | Never answered | Deleted |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in read:
        by_night = {_int(row.get("night")): row for row in r.rows}
        days = [row for row in r.rows if _int(row.get("night")) >= 1]
        lines.append(
            f"| {r.persona} | {r.name} | {sum(row.get('kept') == 'yes' for row in days)} "
            f"| {_dash(by_night.get(r.nights, {}).get('user_rules'))} "
            f"| {sum(_int(row.get('late_answers')) for row in days)} | {sum(_int(row.get('unanswered')) for row in days)} "
            f"| {sum(_int(row.get('undone')) for row in days)} |"
        )
    last = max([NIGHTS, *(r.nights for r in read)])
    for title, word, key, first, show in (
        ("Unneeded asks per day", "Day", "unneeded_requests", 1, _dash),
        ("Holdout accuracy per night", "Night", "accuracy", 0, _pct),
        ("Holdout agreement per night", "Night", "agreement", 0, _pct),
    ):
        nights = range(first, last + 1)
        lines += [
            "",
            f"{title} (simulated):",
            "",
            "| Simulated persona | Run | " + " | ".join(f"{word} {n}" for n in nights) + " |",
            "|---|---|" + "---|" * len(nights),
        ]
        for r in read:
            by_night = {_int(row.get("night")): row for row in r.rows}
            cells = [show(by_night.get(n, {}).get(key)) for n in nights]
            lines.append(f"| {r.persona} | {r.name} | " + " | ".join(cells) + " |")
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
        asks = [_cell(row.get("approval_requests")) for row in r.rows]
        most = max((a for a in asks if a is not None), default=None)
        lines.append(
            f"| {r.name} | {_dash(most)} | {_dash(rec.get('not_fixed'))} | {_dash(rec.get('shared'))} |"
        )
    return [*lines, ""]


def deviation_section(runs: list[Run]) -> list[str]:
    lines = ["## Differences from the plan, read from each simulated run's files", ""]
    found = [
        f"- {r.persona} {r.name}: {'; '.join(d)}."
        for r in runs
        if (d := [*deviations(r), *sibling_problems(r, runs)])
    ]
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
    read = [r for r in runs if r.ran]
    safety = [safety_counts(r) for r in read]

    def total(key: str) -> str:
        cell = count_cell(sum(s[key] for s in safety), any(key in s["unknown"] for s in safety))
        return "not known" if cell == "-" else cell

    totals = (
        f"Over all {len(read)} simulated runs read: leaks {total('leaks')}, "
        f"missed asks {total('missed')}, refusals shared {total('refused')}."
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
    if not any(r.ran for r in runs):
        print(
            f"No simulated study runs under {display_path(args.study)}: nothing to report, nothing written."
        )
        return 2
    ran = planned_that_ran(runs)
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
        f"Wrote {display_path(out / SUMMARY)} and {', '.join(p.name for p in charts)} from {sum(r.ran for r in runs)} simulated runs."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
