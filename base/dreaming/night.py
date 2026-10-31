"""The nightly dreaming job: rebuild the dataset, train, gate on the holdout, keep or roll back.

`NightRunner.start()` runs one night in a background thread and is idempotent: while a night is
running, a lock row in the device db makes every caller (this process or another) get the same
job id back. `last_report()` returns aggregate numbers only, safe to hand to Muse.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

from base import events as default_events
from base.config import REPO_ROOT
from base.dreaming import dataset, gate, train
from eval import run_eval

log = logging.getLogger(__name__)

LOCK_NAME = "night"
STALE_AFTER_SECONDS = 3 * 3600  # a lock this old belongs to a run that died
# Who holds the lock: this process id plus a token made once per process, so a lock left by a
# process that was stopped (Ctrl+C, SIGTERM, a crash) is not mistaken for a running night.
OWNER = f"{os.getpid()}:{uuid.uuid4().hex[:8]}"
REPORT_KEYS = (
    "learned_from", "accuracy_before", "accuracy_after", "agreement_before", "agreement_after",
    "kept", "leaks", "seconds", "night_number",
)  # fmt: skip

_SCHEMA = """
CREATE TABLE IF NOT EXISTS dreaming_lock (name TEXT PRIMARY KEY, job_id TEXT NOT NULL, started_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS dreaming_nights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    finished_at REAL NOT NULL,
    report TEXT NOT NULL,
    rule_row_ids TEXT NOT NULL
);
"""


@dataclass
class NightReport:
    learned_from: int
    accuracy_before: float
    accuracy_after: float
    agreement_before: float
    agreement_after: float
    kept: bool
    leaks: int
    seconds: float
    night_number: int = 0
    job_id: str = ""
    backend: str = "prompt"
    rules: int = 0
    note: str = ""
    categories: dict = field(default_factory=dict)  # holdout accuracy per expected decision, rules in place
    gate_rerun: int | None = None  # holdout items the gate re-ran on the new rules; None if it did not run
    missed_asks: int = 0  # holdout items the policy wants asked about that the rules in place shared
    refuse_shared: int = 0  # holdout items the policy refuses that the rules in place shared

    def numbers(self) -> dict:
        """Aggregate numbers only."""
        return {k: getattr(self, k) for k in REPORT_KEYS}


class DreamingBusy(RuntimeError):
    def __init__(self, job_id: str):
        super().__init__(f"dreaming job {job_id} is already running")
        self.job_id = job_id


class NightRunner:
    def __init__(
        self,
        services,
        *,
        holdout_path: str | Path | None = None,
        synthetic_path: str | Path | None = None,
        stale_after: float = STALE_AFTER_SECONDS,
    ):
        self.services = services
        self.settings = services.settings
        self.holdout_path = Path(holdout_path or REPO_ROOT / "eval" / "holdout.jsonl")
        # "" means no practice data at all (the simulation's default); None means eval/synthetic.jsonl.
        self.synthetic_path = (
            None if synthetic_path == "" else Path(synthetic_path or REPO_ROOT / "eval" / "synthetic.jsonl")
        )
        self.stale_after = stale_after
        self.events = getattr(services, "events", None) or default_events
        self.raw_dir: Path | None = None  # set by the simulation: per-item gate rows go here
        # Set by the simulation: its unseen test items, never trained on (like the holdout), so a
        # practice set that contains them cannot teach the router the answers.
        self.exclude_ids: set[str] = set()
        # Set by the simulation: a persona's privacy_controls.json (its toggles), copied into
        # every home the gate scores in, so the holdout is scored under the same toggles.
        self.controls_path: Path | None = None
        self._thread: threading.Thread | None = None
        with self._db() as con:
            con.executescript(_SCHEMA)
            cols = {r[1] for r in con.execute("PRAGMA table_info(dreaming_lock)")}
            if "owner" not in cols:  # a db from before the owner column
                con.execute("ALTER TABLE dreaming_lock ADD COLUMN owner TEXT")

    # ----- public -----

    def start(self) -> str:
        """Start a night in the background, or return the id of the one already running."""
        job_id, acquired = self._acquire()
        if acquired:
            self._thread = threading.Thread(target=self._run_background, args=(job_id,), daemon=True)
            self._thread.start()
        return job_id

    def run_night(self) -> NightReport:
        """Run one night in this thread. Raises DreamingBusy if another night holds the lock."""
        job_id, acquired = self._acquire()
        if not acquired:
            raise DreamingBusy(job_id)
        return self._run(job_id)

    def running_job(self) -> str | None:
        with self._db() as con:
            row = con.execute("SELECT job_id, started_at, owner FROM dreaming_lock WHERE name = ?", (LOCK_NAME,))
            row = row.fetchone()
        return row[0] if row and self._live(row[1], row[2]) else None

    def report_for(self, job_id: str) -> dict | None:
        """Aggregate numbers for one finished night, or None if no night had that id."""
        with self._db() as con:
            row = con.execute("SELECT report FROM dreaming_nights WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            return None
        report = json.loads(row[0])
        return {k: report.get(k) for k in REPORT_KEYS}

    def wait(self, timeout: float | None = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout)

    def last_report(self) -> dict:
        """Aggregate numbers from the latest night, or zeros and None before the first one."""
        with self._db() as con:
            row = con.execute("SELECT report FROM dreaming_nights ORDER BY id DESC LIMIT 1").fetchone()
        if row is None:
            return {k: None for k in REPORT_KEYS} | {"night_number": 0, "learned_from": 0}
        report = json.loads(row[0])
        return {k: report.get(k) for k in REPORT_KEYS}

    # ----- one night -----

    def _run_background(self, job_id: str) -> None:
        try:
            self._run(job_id)
        except Exception as exc:  # the lock is already released; log the kind of failure, never content
            log.warning("dreaming job %s failed: %s", job_id, type(exc).__name__)

    def _run(self, job_id: str) -> NightReport:
        self.events.emit("working", f"dreaming {job_id}")
        try:
            return self._dream(job_id)
        finally:
            self._release(job_id)
            settle = getattr(self.events, "settle", None)
            if callable(settle):
                settle(f"dreaming {job_id}")
            else:
                self.events.emit("idle", f"dreaming {job_id}")

    def _dream(self, job_id: str) -> NightReport:
        started = time.monotonic()
        settings = self.settings
        holdout = run_eval.load_items(self.holdout_path) if self.holdout_path.is_file() else []
        holdout_ids = {str(i["id"]) for i in holdout}
        never_train = holdout_ids | {str(i) for i in self.exclude_ids}
        examples = dataset.build(self.services.approvals, self.synthetic_path, never_train)
        user_ids = sorted({e.row_id for e in examples if e.source == "user" and e.row_id is not None})
        learned_from = sum(1 for e in examples if e.source == "user")

        current = settings.paths.router_prompt
        candidate = current.with_name("router_rules.candidate.md")
        prev_ids = self._rule_row_ids()
        # Rules built from a decision the user has since deleted must not stay in place.
        tainted = bool(set(prev_ids) - set(user_ids))

        policy = getattr(self.services, "policy", None)
        result = train.train(examples, settings, out_path=candidate, policy=policy)
        note = result.message
        rerun = None
        if result.cloud_required or not holdout:
            candidate.unlink(missing_ok=True)
            if tainted:
                current.unlink(missing_ok=True)
                prev_ids = []
            before = after = self._score_current(holdout, current)
            kept, in_place_ids = False, prev_ids
            if not holdout:
                note += " No holdout items, so nothing was kept."
        else:
            g = gate.gate(self.services, candidate, current, holdout, force=tainted, controls_path=self.controls_path)
            before, after, kept, rerun = g.before, g.after, g.keep, g.rerun
            self._write_raw(before, after)
            in_place_ids = user_ids if kept else ([] if tainted else prev_ids)
            note += (
                f" The gate re-ran {rerun} of {len(holdout)} holdout items on the new rules; the rest have "
                "the same learned rules in both files and reuse the current rules' run."
            )
            if g.reasons and not kept:
                note += " Kept the current rules: " + "; ".join(g.reasons) + "."

        in_place = after if kept else before
        report = NightReport(
            learned_from=learned_from,
            accuracy_before=before.accuracy,
            accuracy_after=after.accuracy,
            agreement_before=before.agreement,
            agreement_after=after.agreement,
            kept=kept,
            leaks=in_place.leaks,
            seconds=round(time.monotonic() - started, 1),
            night_number=self._night_count() + 1,
            job_id=job_id,
            backend=result.backend,
            rules=result.rules,
            note=note.strip(),
            categories=in_place.category_accuracy(),
            gate_rerun=rerun,
            missed_asks=getattr(in_place, "missed_asks", 0),
            refuse_shared=getattr(in_place, "refuse_shared", 0),
        )
        with self._db() as con:
            con.execute(
                "INSERT INTO dreaming_nights (job_id, finished_at, report, rule_row_ids) VALUES (?, ?, ?, ?)",
                (job_id, time.time(), json.dumps(asdict(report)), json.dumps(in_place_ids)),
            )
        return report

    def _write_raw(self, before: run_eval.EvalReport, after: run_eval.EvalReport) -> None:
        """The gate's per-item rows for this night (ids and decisions only), when raw_dir is set."""
        if self.raw_dir is None:
            return
        n = self._night_count() + 1
        for label, report in (("current", before), ("candidate", after)):
            path = Path(self.raw_dir) / f"night-{n}-{label}.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            run_eval.write_raw_rows(report, path)

    def _score_current(self, holdout: list[dict], current: Path) -> run_eval.EvalReport:
        if not holdout:
            return run_eval.EvalReport(name="no-holdout")
        rules = current if current.is_file() else None
        return run_eval.evaluate(
            self.settings, holdout, rules_path=rules, name="night-current", controls_path=self.controls_path
        )

    # ----- db -----

    @contextlib.contextmanager
    def _db(self):
        self.settings.paths.db.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(self.settings.paths.db, timeout=30, isolation_level=None)
        try:
            yield con
        finally:
            con.close()

    def _acquire(self) -> tuple[str, bool]:
        """Take the lock row. Returns (job_id, True) if taken, or (running job id, False)."""
        with self._db() as con:
            con.execute("BEGIN IMMEDIATE")
            row = con.execute(
                "SELECT job_id, started_at, owner FROM dreaming_lock WHERE name = ?", (LOCK_NAME,)
            ).fetchone()
            if row and self._live(row[1], row[2]):
                con.execute("COMMIT")
                return row[0], False
            job_id = "dream-" + uuid.uuid4().hex[:12]
            con.execute(
                "INSERT OR REPLACE INTO dreaming_lock (name, job_id, started_at, owner) VALUES (?, ?, ?, ?)",
                (LOCK_NAME, job_id, time.time(), OWNER),
            )
            con.execute("COMMIT")
            return job_id, True

    def _live(self, started_at: float, owner: str | None) -> bool:
        """Whether a lock row belongs to a night that can still be running."""
        if time.time() - started_at >= self.stale_after:
            return False
        if not owner:
            return True  # an older row: only age can tell
        pid_text = owner.partition(":")[0]
        if owner == OWNER:
            return True
        try:
            pid = int(pid_text)
        except ValueError:
            return False
        if pid == os.getpid():
            return False  # this process id, but another token: an earlier process with our pid
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True  # alive, run by another user
        return True

    def _release(self, job_id: str) -> None:
        with self._db() as con:
            con.execute("DELETE FROM dreaming_lock WHERE name = ? AND job_id = ?", (LOCK_NAME, job_id))

    def _rule_row_ids(self) -> list[str]:
        with self._db() as con:
            row = con.execute("SELECT rule_row_ids FROM dreaming_nights ORDER BY id DESC LIMIT 1").fetchone()
        return [str(i) for i in json.loads(row[0])] if row else []

    def _night_count(self) -> int:
        with self._db() as con:
            return con.execute("SELECT COUNT(*) FROM dreaming_nights").fetchone()[0]
