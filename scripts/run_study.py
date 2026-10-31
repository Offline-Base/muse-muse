"""Run the simulated persona study as eval/reports/sim/PLAN.md fixes it: 24 runs, one at a time.

    uv run python -m scripts.run_study --homes DIR [--study eval/reports/sim] [--wrap CMD] [--dry-run]

Runs in the plan's order: seed s of every persona, the fix ablation's first seed, then seeds s + 1000,
then s + 2000. It can stop and start: a run with a nights.csv or a stopped.md is done and never run
again. A home is made new under --homes for every run. --wrap goes in front of each run's command
(the model-slot lock). All users are simulated and all items invented.

simulate_nights writes its files only at the end, so the plan's stop rule is applied when a run ends:
- a leak: the run's files stay, and that persona's remaining runs do not start;
- a run that did not finish, or more than 10% of a night's holdout unscored on two nights in a row:
  a stopped.md in the seed folder, and one re-run from night 0 in seed-<seed>-rerun/.
Prints and writes run ids, statuses and counts only (status.md beside the runs).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import shlex
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from eval.run_eval import REPORTS_DIR

ROOT = Path(__file__).resolve().parent.parent
PERSONAS = {
    "strict_teacher": 101,
    "relaxed_teacher": 102,
    "sped_coordinator": 103,
    "tired_teacher": 104,
    "privacy_officer": 105,
    "clinic_coordinator": 106,
    "caseworker_cui": 107,
}
NOFIX = "strict_teacher_nofix"  # the fix ablation: the strict teacher with ROUTER_LOOSEN=none
SEED_STEPS = (0, 1000, 2000)
NIGHTS, PER_DAY, UNSEEN_N = 10, 30, 100
MAX_UNSCORED_SHARE = 0.10
LEAK_FIELDS = ("leaks", "day_leaks")


@dataclass(frozen=True)
class Run:
    persona: str  # the folder name; the ablation runs the strict teacher's persona file
    seed: int

    @property
    def source(self) -> str:
        return "strict_teacher" if self.persona == NOFIX else self.persona

    @property
    def id(self) -> str:
        return f"{self.persona}/seed-{self.seed}"


def planned() -> list[Run]:
    """The 24 runs in the plan's order."""
    runs = []
    for step in SEED_STEPS:
        runs += [Run(p, s + step) for p, s in PERSONAS.items()]
        runs.append(Run(NOFIX, PERSONAS["strict_teacher"] + step))
    return runs


def command(run: Run, out: Path, home: Path) -> list[str]:
    folder = f"eval/personas/{run.source}"
    return [
        "uv", "run", "--offline", "python", "-m", "scripts.simulate_nights", "--persona", f"{folder}/persona.yaml",
        "--seed", str(run.seed), "--nights", str(NIGHTS), "--per-day", str(PER_DAY), "--tasks", f"{folder}/days.jsonl",
        "--holdout", f"{folder}/holdout.jsonl", "--unseen", f"{folder}/unseen.jsonl", "--unseen-n", str(UNSEEN_N),
        "--home", str(home), "--out", str(out),
    ]  # fmt: skip


def env_for(run: Run, base: dict[str, str]) -> dict[str, str]:
    return {**base, "ROUTER_LOOSEN": "none"} if run.persona == NOFIX else dict(base)


def _rows(folder: Path) -> list[dict[str, str]]:
    with (folder / "nights.csv").open(newline="") as f:
        return list(csv.DictReader(f))


def _count(row: dict[str, str], name: str) -> int:
    try:
        return int(float(row.get(name) or 0))
    except ValueError:
        return 0


def has_leak(folder: Path) -> bool:
    return any(_count(row, f) for row in _rows(folder) for f in LEAK_FIELDS)


def unscored_shares(folder: Path) -> dict[int, float]:
    """Night to the share of its holdout items that errored or fell back, from the raw rows. Only the
    gate's rows are read, for their status fields; the unseen rows are never opened."""
    shares: dict[int, float] = {}
    raw = folder / "raw" / "nights"
    for night in range(0, NIGHTS + 1):
        rows = []
        for path in raw.glob(f"night-{night}-*.jsonl"):
            rows += [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        if rows:
            shares[night] = sum(bool(r.get("fallback") or r.get("error")) for r in rows) / len(rows)
    return shares


def two_bad_nights(shares: dict[int, float]) -> int | None:
    """The first night that is the second in a row over the limit, else None."""
    for night in sorted(shares):
        if shares[night] > MAX_UNSCORED_SHARE and shares.get(night - 1, 0) > MAX_UNSCORED_SHARE:
            return night
    return None


def _stop_note(folder: Path, where: str, why: str) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "stopped.md").write_text(f"Stopped (simulated run): {where}. Reason: {why}.\n")


def finished(folder: Path) -> bool:
    return (folder / "nights.csv").is_file() or (folder / "stopped.md").is_file()


def run_once(run: Run, folder: Path, execute: Callable[[Run, Path], int]) -> str:
    """Run one try and say how it ended: done, leak or model errors."""
    code = execute(run, folder)
    if code != 0 or not (folder / "nights.csv").is_file():
        _stop_note(folder, "before the last night", "model errors: the run or its model server stopped")
        return "model errors"
    if has_leak(folder):
        return "leak"
    night = two_bad_nights(unscored_shares(folder))
    if night is not None:
        _stop_note(folder, f"night {night}", "model errors: over 10% of the holdout unscored on two nights in a row")
        return "model errors"
    return "done"


def run_study(study: Path, execute: Callable[[Run, Path], int], runs: Iterable[Run] | None = None) -> list[str]:
    """Every run not already done, in order. Returns one status line per planned run."""
    lines, leaked = [], set()
    for run in runs if runs is not None else planned():
        folder = study / run.persona / f"seed-{run.seed}"
        rerun = study / run.persona / f"seed-{run.seed}-rerun"
        if run.persona in leaked:
            lines.append(f"{run.id}: not started, a leak in an earlier run of this persona")
            continue
        if folder.is_dir() and not finished(folder):  # the runner itself was cut off in this try
            _stop_note(folder, "before the last night", "model errors: the run or its model server stopped")
        if finished(folder):
            status = "done before"
            if (folder / "nights.csv").is_file() and has_leak(folder):
                status = "leak"
            elif (folder / "stopped.md").is_file() and not finished(rerun):
                status = "model errors"
        else:
            status = run_once(run, folder, execute)
        if status == "model errors" and not finished(rerun):
            status = "re-run: " + run_once(run, rerun, execute)
        if status.endswith("leak"):
            leaked.add(run.persona)
        lines.append(f"{run.id}: {status}")
    return lines


def write_status(study: Path, lines: list[str]) -> None:
    text = ["# Simulated persona study: runs so far", "", f"Updated {datetime.now():%Y-%m-%d %H:%M}. Simulated users.", ""]
    (study / "status.md").write_text("\n".join([*text, *(f"- {line}" for line in lines)]) + "\n")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m scripts.run_study", description=__doc__.split("\n")[0])
    p.add_argument("--study", type=Path, default=REPORTS_DIR / "sim")
    p.add_argument("--homes", type=Path, required=True, help="where each run's new home folder goes")
    p.add_argument("--wrap", default="", help="command to put in front of each run")
    p.add_argument("--dry-run", action="store_true", help="print the runs and change nothing")
    args = p.parse_args(argv)
    if args.dry_run:
        for run in planned():
            print(run.id, "done" if finished(args.study / run.persona / f"seed-{run.seed}") else "to run")
        return 0
    args.homes.mkdir(parents=True, exist_ok=True)
    wrap = shlex.split(args.wrap)
    log = args.homes / "runs.log"

    def execute(run: Run, folder: Path) -> int:
        home = Path(tempfile.mkdtemp(prefix=run.persona + "-", dir=args.homes))
        env = {**env_for(run, dict(os.environ)), "BASE_HOME": str(home)}
        with log.open("a") as out:
            done = subprocess.run([*wrap, *command(run, folder, home)], cwd=ROOT, env=env, stdout=out, stderr=out, check=False)
        print(f"{datetime.now():%H:%M} {run.id}: exit {done.returncode}", flush=True)
        return done.returncode

    lines = run_study(args.study, execute)
    write_status(args.study, lines)
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
