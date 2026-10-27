"""Heavy steps the Jetson hands to the laptop's dial-out worker. See docs/CONTRACTS.md.

`HeavyQueue.run(kind, messages, schema)` is the workspace agent's heavy-step hook. It returns the
worker's JSON result, or None when no worker is around or the result does not arrive in time, in
which case the step runs on the device's own Glimmer.

Steps live in the device's own SQLite db. Their messages hold document text, so they are blanked
as soon as a step finishes or is abandoned. A worker whose Glimmer is a cloud endpoint only ever
receives steps the caller marked synthetic.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

HELLO_WINDOW = 30.0  # seconds since a worker's last hello for it to count as present
MAX_NEXT_WAIT = 25.0  # long-poll cap for /heavy/next
STALE_AFTER = 600.0  # steps older than this were left by a process that died; blank them

SCHEMA = """
CREATE TABLE IF NOT EXISTS heavy_steps (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    messages TEXT NOT NULL,
    schema TEXT,
    synthetic INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    worker TEXT,
    result TEXT,
    error TEXT,
    created_at REAL NOT NULL,
    claimed_at REAL,
    finished_at REAL
);
CREATE INDEX IF NOT EXISTS heavy_steps_status ON heavy_steps(status, created_at);
CREATE TABLE IF NOT EXISTS heavy_workers (
    worker TEXT PRIMARY KEY,
    cloud INTEGER NOT NULL DEFAULT 0,
    last_seen REAL NOT NULL
);
"""

class HeavyQueue:
    """Thread-safe SQLite queue of heavy steps, shared by the agent and the /heavy routes."""

    # Read by the workspace agent's step log for steps that came back from the worker.
    device = "laptop"
    backend = "heavy_worker"

    def __init__(
        self,
        db_path: str | Path,
        wait_seconds: float = 30,
        *,
        hello_window: float = HELLO_WINDOW,
        poll_interval: float = 0.2,
    ) -> None:
        self.db_path = str(db_path)
        self.wait_seconds = wait_seconds
        self.hello_window = hello_window
        self.poll_interval = poll_interval
        self._lock = threading.Lock()
        self._changed = threading.Condition()
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self.stale_after = max(STALE_AFTER, 2 * wait_seconds)
        with closing(self._connect()) as conn:
            conn.executescript(SCHEMA)
        self._sweep()

    # -- agent side -------------------------------------------------------------------------

    def run(
        self, kind: str, messages: list[dict], schema: dict | None, *, synthetic: bool = False
    ) -> dict | None:
        """Hand one step to the laptop worker and wait for its result.

        Returns None right away when no worker has said hello in the last 30 seconds, and None
        after `wait_seconds` without a result (the step is then abandoned and a late result is
        ignored). `synthetic=True` lets a worker on a cloud backend take the step; only pass it
        for folders marked `.synthetic`.
        """
        if not self.worker_present(synthetic=synthetic):
            log.info("heavy step %s: no laptop worker, running on this device", kind)
            return None
        step_id = uuid.uuid4().hex
        with closing(self._connect()) as conn:
            conn.execute(
                "INSERT INTO heavy_steps (id, kind, messages, schema, synthetic, status, created_at)"
                " VALUES (?, ?, ?, ?, ?, 'queued', ?)",
                (
                    step_id,
                    kind,
                    json.dumps(messages),
                    None if schema is None else json.dumps(schema),
                    int(synthetic),
                    time.time(),
                ),
            )
        self._notify()
        try:
            return self._wait_for(step_id, kind)
        finally:
            self._forget(step_id)

    def _wait_for(self, step_id: str, kind: str) -> dict | None:
        deadline = time.monotonic() + self.wait_seconds
        while True:
            row = self._row(step_id)
            if row is None:
                return None
            if row["status"] == "done":
                log.info("heavy step %s: done on the laptop worker", kind)
                return json.loads(row["result"])
            if row["status"] == "failed":
                log.info("heavy step %s: laptop worker failed (%s), running on this device", kind, row["error"])
                return None
            if row["status"] == "abandoned":
                return None
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if self._abandon(step_id):
                    log.info("heavy step %s: no result in %ss, running on this device", kind, self.wait_seconds)
                    return None
                continue  # the result landed just now; read it on the next pass
            with self._changed:
                self._changed.wait(min(remaining, self.poll_interval))

    # -- worker side ------------------------------------------------------------------------

    def hello(self, worker: str = "worker", cloud: bool = False) -> None:
        """Record that a worker is present. `cloud` says its Glimmer is a cloud endpoint."""
        with closing(self._connect()) as conn:
            conn.execute(
                "INSERT INTO heavy_workers (worker, cloud, last_seen) VALUES (?, ?, ?)"
                " ON CONFLICT(worker) DO UPDATE SET cloud = excluded.cloud, last_seen = excluded.last_seen",
                (worker, int(cloud), time.time()),
            )

    def worker_present(self, *, synthetic: bool = False) -> bool:
        """True when a worker said hello recently; cloud workers count only for synthetic steps."""
        since = time.time() - self.hello_window
        with closing(self._connect()) as conn:
            row = conn.execute(
                "SELECT 1 FROM heavy_workers WHERE last_seen >= ? AND (cloud = 0 OR ?) LIMIT 1",
                (since, int(synthetic)),
            ).fetchone()
        return row is not None

    def next(self, *, worker: str = "worker", cloud: bool = False, wait: float = MAX_NEXT_WAIT) -> dict | None:
        """Claim the oldest queued step for a worker, waiting up to `wait` seconds (max 25)."""
        wait = max(0.0, min(wait, MAX_NEXT_WAIT))
        self.hello(worker, cloud)
        self._sweep()
        deadline = time.monotonic() + wait
        while True:
            step = self._claim(worker, cloud)
            if step is not None:
                return step
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.hello(worker, cloud)
                return None
            with self._changed:
                self._changed.wait(min(remaining, self.poll_interval))

    def submit(self, step_id: str, result: dict | None = None, error: str | None = None) -> bool:
        """Store a worker's result. Returns False when the step is unknown, abandoned or finished."""
        if result is None and error is None:
            raise ValueError("submit needs a result or an error")
        status = "done" if error is None else "failed"
        with closing(self._connect()) as conn:
            cur = conn.execute(
                "UPDATE heavy_steps SET status = ?, result = ?, error = ?, finished_at = ?"
                " WHERE id = ? AND status = 'claimed'",
                (status, None if result is None else json.dumps(result), error, time.time(), step_id),
            )
            accepted = cur.rowcount == 1
        if accepted:
            self._notify()
        return accepted

    def status(self, step_id: str) -> str | None:
        row = self._row(step_id)
        return None if row is None else row["status"]

    # -- internals --------------------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30, isolation_level=None, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _notify(self) -> None:
        with self._changed:
            self._changed.notify_all()

    def _row(self, step_id: str) -> sqlite3.Row | None:
        with closing(self._connect()) as conn:
            return conn.execute(
                "SELECT status, result, error FROM heavy_steps WHERE id = ?", (step_id,)
            ).fetchone()

    def _claim(self, worker: str, cloud: bool) -> dict[str, Any] | None:
        pick = (
            "SELECT id, kind, messages, schema, synthetic FROM heavy_steps"
            " WHERE status = 'queued' AND (? = 0 OR synthetic = 1) ORDER BY created_at LIMIT 1"
        )
        with self._lock, closing(self._connect()) as conn:
            if conn.execute(pick, (int(cloud),)).fetchone() is None:
                return None  # nothing queued: skip the write lock on the shared db
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(pick, (int(cloud),)).fetchone()
                if row is not None:
                    conn.execute(
                        "UPDATE heavy_steps SET status = 'claimed', worker = ?, claimed_at = ? WHERE id = ?",
                        (worker, time.time(), row["id"]),
                    )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        if row is None:
            return None
        return {
            "id": row["id"],
            "kind": row["kind"],
            "messages": json.loads(row["messages"]),
            "schema": None if row["schema"] is None else json.loads(row["schema"]),
            "synthetic": bool(row["synthetic"]),
        }

    def _abandon(self, step_id: str) -> bool:
        with closing(self._connect()) as conn:
            cur = conn.execute(
                "UPDATE heavy_steps SET status = 'abandoned', finished_at = ?"
                " WHERE id = ? AND status IN ('queued', 'claimed')",
                (time.time(), step_id),
            )
            return cur.rowcount == 1

    def _forget(self, step_id: str) -> None:
        """Blank the document text and result; keep the row (kind, status, times) as a log."""
        with closing(self._connect()) as conn:
            conn.execute(
                "UPDATE heavy_steps SET messages = '[]', schema = NULL, result = NULL WHERE id = ?",
                (step_id,),
            )

    def _sweep(self) -> None:
        """Abandon and blank steps a crashed process left behind. Live waiters are never this old."""
        with closing(self._connect()) as conn:
            conn.execute(
                "UPDATE heavy_steps SET messages = '[]', schema = NULL, result = NULL,"
                " status = CASE WHEN status IN ('queued', 'claimed') THEN 'abandoned' ELSE status END"
                " WHERE created_at < ? AND (messages != '[]' OR result IS NOT NULL OR status IN ('queued', 'claimed'))",
                (time.time() - self.stale_after,),
            )
