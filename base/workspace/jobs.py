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
RELEASE_STATUSES = ("none", "shared", "waiting", "refused")

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
    ("approval_id", "TEXT"),
    ("error", "TEXT"),
    ("model_log", "TEXT NOT NULL DEFAULT '[]'"),
    ("release_status", "TEXT NOT NULL DEFAULT 'none'"),
    ("released_text", "TEXT"),
    ("topics", "TEXT NOT NULL DEFAULT '[]'"),
)
JSON_COLUMNS = ("model_log", "topics")
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
    ) -> None:
        self._update(
            job_id,
            status="done",
            finished_at=time.time(),
            raw_result=raw_result,
            result_kind=result_kind,
            summary=summary,
            topics=list(topics),
            error=None,
        )

    def fail(self, job_id: str, error: str) -> None:
        self.set_status(job_id, "failed", error=error)

    def set_release(
        self, job_id: str, status: str, approval_id: str | None = None, released_text: str | None = None
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
                fields["approval_id"] = approval_id
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
