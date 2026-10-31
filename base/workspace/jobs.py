"""Job store for private tasks, on SQLite. See docs/CONTRACTS.md, Workspace and "Jobs and releases".

raw_result holds real names and stays on the device. summary is aggregate text with no names that
also stays here until egress tags it. released_text is the only column that already passed egress.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

STATUSES = ("queued", "running", "waiting_for_approval", "done", "refused", "failed")
RELEASE_STATUSES = ("none", "releasing", "shared", "waiting", "refused")
RESTART_ERROR = "The device restarted before the job finished."

COLUMNS = (
    ("id", "TEXT PRIMARY KEY"),
    ("kind", "TEXT NOT NULL"),
    ("instructions", "TEXT"),
    ("folder", "TEXT"),
    ("status", "TEXT NOT NULL"),
    ("created_at", "REAL NOT NULL"),
    ("finished_at", "REAL"),
    ("result_kind", "TEXT"),
    ("raw_result", "TEXT"),
    ("summary", "TEXT"),
    ("approval_id", "INTEGER"),  # a decisions row id in base/approvals.py
    ("error", "TEXT"),
    ("model_log", "TEXT NOT NULL DEFAULT '[]'"),
    ("release_status", "TEXT NOT NULL DEFAULT 'none'"),
    ("released_text", "TEXT"),
    ("topics", "TEXT NOT NULL DEFAULT '[]'"),
    # Workspace paths the result came from (a search's passages, an ask job's reading), so the
    # user's privacy controls apply the same way when the release runs after a restart.
    ("sources", "TEXT NOT NULL DEFAULT '[]'"),
)
JSON_COLUMNS = ("model_log", "topics", "sources")
FINAL = ("done", "refused", "failed")


class JobStore:
    """Thread-safe: one short-lived connection per call, writes serialized by a lock."""

    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        with self._lock, self._connect() as db:
            cols = ", ".join(f"{name} {kind}" for name, kind in COLUMNS)
            db.execute(f"CREATE TABLE IF NOT EXISTS jobs ({cols})")
            have = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
            for name, kind in COLUMNS:
                if name not in have:  # an older db from before Oct 27's columns
                    db.execute(f"ALTER TABLE jobs ADD COLUMN {name} {kind}")
            db.execute("CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at)")
        try:
            os.chmod(self.db_path, 0o600)
        except OSError:
            pass

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.db_path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def _update(self, job_id: str, **fields: Any) -> None:
        for name in JSON_COLUMNS:
            if name in fields and not isinstance(fields[name], str):
                fields[name] = json.dumps(fields[name])
        sets = ", ".join(f"{k} = ?" for k in fields)
        with self._lock, self._connect() as db:
            cur = db.execute(f"UPDATE jobs SET {sets} WHERE id = ?", (*fields.values(), job_id))
            if cur.rowcount == 0:
                raise KeyError(f"no job {job_id}")

    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        job = dict(row)
        for name in JSON_COLUMNS:
            job[name] = json.loads(job[name] or "[]")
        job["approval_id"] = _approval_id(job.get("approval_id"))
        return job

    # writes

    def create(self, kind: str, instructions: str, folder: str | None) -> str:
        job_id = uuid.uuid4().hex[:16]
        with self._lock, self._connect() as db:
            db.execute(
                "INSERT INTO jobs (id, kind, instructions, folder, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (job_id, kind, instructions, folder, "queued", time.time()),
            )
        return job_id

    def set_status(self, job_id: str, status: str, error: str | None = None) -> None:
        if status not in STATUSES:
            raise ValueError(f"unknown status {status!r}")
        fields: dict[str, Any] = {"status": status}
        if error is not None:
            fields["error"] = error
        if status in FINAL:
            fields["finished_at"] = time.time()
        self._update(job_id, **fields)

    def start(self, job_id: str) -> None:
        self.set_status(job_id, "running")

    def set_kind(self, job_id: str, kind: str) -> None:
        self._update(job_id, kind=kind)

    def add_model_step(self, job_id: str, entry: dict[str, Any]) -> None:
        with self._lock:
            job = self.get(job_id)
            if job is None:
                raise KeyError(f"no job {job_id}")
            self._update(job_id, model_log=[*job["model_log"], entry])

    def finish(
        self,
        job_id: str,
        raw_result: str,
        result_kind: str,
        summary: str | None = None,
        topics: list[str] | tuple[str, ...] = (),
        sources: list[str] | tuple[str, ...] = (),
    ) -> None:
        fields: dict[str, Any] = {"sources": [str(s) for s in sources]} if sources else {}
        self._update(
            job_id,
            status="done",
            finished_at=time.time(),
            raw_result=raw_result,
            result_kind=result_kind,
            summary=summary,
            topics=list(topics),
            error=None,
            **fields,
        )

    def fail(self, job_id: str, error: str) -> None:
        self.set_status(job_id, "failed", error=error)

    def job_for_result(
        self,
        kind: str,
        instructions: str,
        raw_result: str,
        result_kind: str,
        sources: list[str] | tuple[str, ...] = (),
    ) -> str:
        """A finished job for a result made inside one tool call, such as a search, so it can be
        released like a private task's result. `sources` are kept with it (see COLUMNS).

        While an identical one (same kind, request and raw result) is still unreleased, being
        released or waiting for the user, its id comes back instead: a retried call joins that
        release rather than starting a second one and a second approval card.
        """
        listed = json.dumps([str(s) for s in sources])
        with self._lock, self._connect() as db:
            row = db.execute(
                "SELECT id FROM jobs WHERE kind = ? AND instructions = ? AND raw_result = ? AND status != 'failed' "
                "AND release_status IN ('none', 'releasing', 'waiting') ORDER BY created_at DESC, rowid DESC LIMIT 1",
                (kind, instructions, raw_result),
            ).fetchone()
            if row is not None:
                if sources:  # a row from before the sources column has none yet
                    db.execute("UPDATE jobs SET sources = ? WHERE id = ? AND sources = '[]'", (listed, row["id"]))
                return row["id"]
            job_id, now = uuid.uuid4().hex[:16], time.time()
            db.execute(
                "INSERT INTO jobs (id, kind, instructions, status, created_at, finished_at, result_kind, raw_result, "
                "sources) VALUES (?, ?, ?, 'done', ?, ?, ?, ?, ?)",
                (job_id, kind, instructions, now, now, result_kind, raw_result, listed),
            )
            return job_id

    def claim_release(self, job_id: str) -> bool:
        """Mark a finished job's release as under way. Only one caller wins; the rest see False.

        Two get_result calls at once (Muse retrying after a relay timeout) must not run egress
        twice and leave two approval cards for one result.
        """
        with self._lock, self._connect() as db:
            cur = db.execute(
                "UPDATE jobs SET release_status = 'releasing' WHERE id = ? AND release_status = 'none'",
                (job_id,),
            )
            return cur.rowcount == 1

    def reset_release(self, job_id: str) -> None:
        """Undo claim_release after a release that could not finish, so it can be tried again."""
        with self._lock, self._connect() as db:
            db.execute(
                "UPDATE jobs SET release_status = 'none' WHERE id = ? AND release_status = 'releasing'", (job_id,)
            )

    def fail_unfinished(self, error: str = RESTART_ERROR) -> int:
        """At startup: jobs left queued or running by a stopped process are failed, and releases
        left half done are reset. One server owns a BASE_HOME, so nothing else is running them."""
        with self._lock, self._connect() as db:
            cur = db.execute(
                "UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE status IN ('queued', 'running')",
                (error, time.time()),
            )
            db.execute("UPDATE jobs SET release_status = 'none' WHERE release_status = 'releasing'")
            return cur.rowcount

    def active_count(self) -> int:
        """Jobs queued or running now."""
        with self._connect() as db:
            return db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued', 'running')").fetchone()[0]

    def set_release(
        self, job_id: str, status: str, approval_id: int | None = None, released_text: str | None = None
    ) -> None:
        """Record what egress did with a finished job.

        A finished job also moves to waiting_for_approval while the user decides, to refused when
        the result is held, and back to done once it is shared. A failed job keeps its status.
        """
        if status not in RELEASE_STATUSES:
            raise ValueError(f"unknown release status {status!r}")
        with self._lock:
            job = self.get(job_id)
            if job is None:
                raise KeyError(f"no job {job_id}")
            fields: dict[str, Any] = {"release_status": status, "released_text": released_text}
            if approval_id is not None:
                fields["approval_id"] = _approval_id(approval_id)
            if job["status"] in ("done", "waiting_for_approval", "refused"):
                fields["status"] = {"waiting": "waiting_for_approval", "refused": "refused"}.get(
                    status, "done"
                )
            self._update(job_id, **fields)

    # reads

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            return self._row(db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())

    def list_recent(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?", (int(limit),)
            ).fetchall()
        return [self._row(r) for r in rows]  # type: ignore[misc]


def _approval_id(value: Any) -> int | None:
    """Approval ids are decisions row ids: ints. A db from before Oct 27 stored them as text."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError("an approval id is an int")
    return int(value)
