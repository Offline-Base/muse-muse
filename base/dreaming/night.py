"""The nightly dreaming job: rebuild the dataset, train, gate on the holdout, keep or roll back.

`NightRunner.start()` runs one night in a background thread and is idempotent: while a night is
running, a lock row in the device db makes every caller (this process or another) get the same
job id back. `last_report()` returns aggregate numbers only, safe to hand to Muse.
"""

from __future__ import annotations

import contextlib
import json
import logging
import sqlite3
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

from base import events as default_events
from base.config import REPO_ROOT
from base.dreaming import dataset, gate, train
from eval import run_eval

log = logging.getLogger(__name__)

LOCK_NAME = "night"
STALE_AFTER_SECONDS = 3 * 3600  # a lock this old belongs to a run that died
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
        self.synthetic_path = Path(synthetic_path or REPO_ROOT / "eval" / "synthetic.jsonl")
        self.stale_after = stale_after
        self.events = getattr(services, "events", None) or default_events
        self._thread: threading.Thread | None = None
        with self._db() as con:
            con.executescript(_SCHEMA)

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
            row = con.execute("SELECT job_id, started_at FROM dreaming_lock WHERE name = ?", (LOCK_NAME,))
            row = row.fetchone()
        return row[0] if row and time.time() - row[1] < self.stale_after else None

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
            self.events.emit("idle", f"dreaming {job_id}")

    def _dream(self, job_id: str) -> NightReport:
        started = time.monotonic()
        settings = self.settings
        holdout = run_eval.load_items(self.holdout_path) if self.holdout_path.is_file() else []
        holdout_ids = {str(i["id"]) for i in holdout}
        examples = dataset.build(self.services.approvals, self.synthetic_path, holdout_ids)
        user_ids = sorted({e.row_id for e in examples if e.source == "user" and e.row_id is not None})
        learned_from = sum(1 for e in examples if e.source == "user")

        current = settings.paths.router_prompt
        candidate = current.with_name("router_rules.candidate.md")
        prev_ids = self._rule_row_ids()
        # Rules built from a decision the user has since deleted must not stay in place.
        tainted = bool(set(prev_ids) - set(user_ids))

        result = train.train(examples, settings, out_path=candidate)
        note = result.message
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
            g = gate.gate(self.services, candidate, current, holdout, force=tainted)
            before, after, kept = g.before, g.after, g.keep
            in_place_ids = user_ids if kept else ([] if tainted else prev_ids)
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
        )
        with self._db() as con:
            con.execute(
                "INSERT INTO dreaming_nights (job_id, finished_at, report, rule_row_ids) VALUES (?, ?, ?, ?)",
                (job_id, time.time(), json.dumps(asdict(report)), json.dumps(in_place_ids)),
            )
        return report

    def _score_current(self, holdout: list[dict], current: Path) -> run_eval.EvalReport:
        if not holdout:
            return run_eval.EvalReport(name="no-holdout")
        rules = current if current.is_file() else None
        return run_eval.evaluate(self.settings, holdout, rules_path=rules, name="night-current")

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
                "SELECT job_id, started_at FROM dreaming_lock WHERE name = ?", (LOCK_NAME,)
            ).fetchone()
            if row and time.time() - row[1] < self.stale_after:
                con.execute("COMMIT")
                return row[0], False
            job_id = "dream-" + uuid.uuid4().hex[:12]
            con.execute(
                "INSERT OR REPLACE INTO dreaming_lock (name, job_id, started_at) VALUES (?, ?, ?)",
                (LOCK_NAME, job_id, time.time()),
            )
            con.execute("COMMIT")
            return job_id, True

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
