"""Decision rows: one per routed result, plus the user's answer when the router asked.

See docs/CONTRACTS.md (Approvals). SQLite in WAL mode behind one lock, so the connector, the
approval page and the eval can share a store across threads. Rows hold tagged text only; the
raw result never reaches this table.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections.abc import Iterable, Mapping
from datetime import date
from pathlib import Path
from typing import Any

from base.types import Decision, default_share_form

SCHEMA = """
CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    day INTEGER,
    job_id TEXT,
    tool TEXT,
    request TEXT,
    result_kind TEXT,
    topics TEXT,
    blocked TEXT,
    tagged_text TEXT,
    shown_form TEXT,
    router_decision TEXT,
    router_reason TEXT,
    router_source TEXT,
    status TEXT NOT NULL,
    user_decision TEXT,
    remember INTEGER NOT NULL DEFAULT 0,
    decided_by TEXT,
    decided_at REAL,
    deleted INTEGER NOT NULL DEFAULT 0,
    item_id TEXT,
    sources TEXT,
    receipt TEXT
);
CREATE INDEX IF NOT EXISTS decisions_status ON decisions(status);
CREATE INDEX IF NOT EXISTS decisions_day ON decisions(day);
"""

STATUSES = ("auto", "pending", "approved", "denied")
DECIDERS = ("user", "policy_sim", "auto_approve")
_EPOCH = date(1970, 1, 1).toordinal()


def today() -> int:
    """Days since 1970-01-01 on the device's local calendar, the default `day` for a row."""
    return date.today().toordinal() - _EPOCH


def label_for(row: Mapping[str, Any]) -> Decision | None:
    """Dreaming label for a decided row, or None when the user has not answered.

    approve + remember -> shown_form, deny + remember -> refuse, no remember -> ask_user.
    """
    choice = row.get("user_decision")
    if choice not in ("approve", "deny"):
        return None
    if not row.get("remember"):
        return "ask_user"
    if choice == "deny":
        return "refuse"
    return row.get("shown_form") or default_share_form(row.get("result_kind") or "")


def _to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    out = dict(row)
    out["topics"] = json.loads(out["topics"]) if out.get("topics") else []
    out["blocked"] = json.loads(out["blocked"]) if out.get("blocked") else []
    out["remember"] = bool(out["remember"])
    out["deleted"] = bool(out["deleted"])
    return out


class ApprovalStore:
    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)
        if self.db_path != ":memory:":
            Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        # Notified after each decide or delete, so get_result can wait for the user's answer.
        self._decided = threading.Condition(self._lock)
        self.decisions_made = 0
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False, timeout=30)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(SCHEMA)
            have = {row[1] for row in self._conn.execute("PRAGMA table_info(decisions)")}
            if "blocked" not in have:  # a db from before the blocked column
                self._conn.execute("ALTER TABLE decisions ADD COLUMN blocked TEXT")
            if "sources" not in have:  # a db from before the privacy controls
                self._conn.execute("ALTER TABLE decisions ADD COLUMN sources TEXT")
            if "receipt" not in have:  # a db from before receipts
                self._conn.execute("ALTER TABLE decisions ADD COLUMN receipt TEXT")
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # Writing rows

    def _insert(
        self,
        status: str,
        *,
        tool: str,
        request: str,
        result_kind: str,
        tagged_text: str,
        router_decision: str,
        router_reason: str = "",
        router_source: str = "model",
        topics: Iterable[str] = (),
        blocked: Iterable[str] = (),
        shown_form: str | None = None,
        job_id: str | None = None,
        day: int | None = None,
        item_id: str | None = None,
        sources: Iterable[str] | None = None,
        receipt: Mapping[str, Any] | None = None,
    ) -> int:
        values = {
            "ts": time.time(),
            "day": today() if day is None else int(day),
            "job_id": job_id,
            "tool": tool,
            "request": request,
            "result_kind": result_kind,
            "topics": json.dumps(list(topics)),
            "blocked": json.dumps(list(blocked)),
            "tagged_text": tagged_text,
            "shown_form": shown_form or default_share_form(result_kind),
            "router_decision": router_decision,
            "router_reason": router_reason,
            "router_source": router_source,
            "status": status,
            "item_id": item_id,
            "sources": json.dumps(list(sources)) if sources else None,
            "receipt": json.dumps(dict(receipt)) if receipt else None,
        }
        cols = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        with self._lock, self._conn:
            cur = self._conn.execute(f"INSERT INTO decisions ({cols}) VALUES ({marks})", tuple(values.values()))
            return int(cur.lastrowid)

    def record_auto(self, **fields: Any) -> int:
        """A row for a result the router decided without asking. Returns its id.

        Required keywords: tool, request, result_kind, tagged_text, router_decision. Optional:
        router_reason, router_source, topics, blocked (plain reasons from TagResult.blocked),
        shown_form (default: default_share_form(result_kind)), job_id, day (default: today()), item_id.
        """
        return self._insert("auto", **fields)

    def create_pending(self, **fields: Any) -> int:
        """A row waiting for the user's answer on the device. Same keywords as record_auto."""
        return self._insert("pending", **fields)

    def decide(self, approval_id: int, approve: bool, remember: bool = False, by: str = "user") -> dict[str, Any]:
        """Record the user's answer on a pending row and return the updated row."""
        if by not in DECIDERS:
            raise ValueError(f"decided_by must be one of {DECIDERS}, not {by!r}")
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT status, deleted FROM decisions WHERE id = ?", (approval_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"no decision row {approval_id}")
            if row["deleted"]:
                raise ValueError(f"decision row {approval_id} was deleted")
            if row["status"] != "pending":
                raise ValueError(f"decision row {approval_id} is {row['status']}, not pending")
            self._conn.execute(
                "UPDATE decisions SET status = ?, user_decision = ?, remember = ?, decided_by = ?, decided_at = ? "
                "WHERE id = ?",
                (
                    "approved" if approve else "denied",
                    "approve" if approve else "deny",
                    int(bool(remember)),
                    by,
                    time.time(),
                    approval_id,
                ),
            )
        self._notify()
        return self.get(approval_id)  # type: ignore[return-value]

    def _notify(self) -> None:
        with self._decided:
            self.decisions_made += 1
            self._decided.notify_all()

    def wait_decided(self, approval_id: int, timeout: float) -> bool:
        """Wait up to `timeout` seconds while the row is pending. True once it is not.

        Wakes on decide or delete in this process, and re-reads the row every second, so an
        answer written by another process is seen too.
        """
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._decided:
            while True:
                row = self._conn.execute(
                    "SELECT status, deleted FROM decisions WHERE id = ?", (approval_id,)
                ).fetchone()
                if row is None or row["deleted"] or row["status"] != "pending":
                    return True
                left = deadline - time.monotonic()
                if left <= 0:
                    return False
                self._decided.wait(min(left, 1.0))

    def delete(self, approval_id: int) -> bool:
        """Mark a row deleted and blank its request and tagged text. False if there is no such row."""
        with self._lock, self._conn:
            cur = self._conn.execute(
                "UPDATE decisions SET deleted = 1, request = '', tagged_text = '' WHERE id = ?", (approval_id,)
            )
        self._notify()
        return cur.rowcount > 0

    # Reading rows

    def purge_before(self, cutoff: float) -> int:
        """Delete every decided row older than `cutoff` (retention). Pending rows stay."""
        with self._lock, self._conn:
            return self._conn.execute(
                "DELETE FROM decisions WHERE ts < ? AND status != 'pending'", (cutoff,)
            ).rowcount

    def _query(self, sql: str, args: tuple = ()) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
        return [_to_dict(r) for r in rows]  # type: ignore[misc]

    def get(self, approval_id: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM decisions WHERE id = ?", (approval_id,)).fetchone()
        return _to_dict(row)

    def pending(self) -> list[dict[str, Any]]:
        """Rows waiting for the user, oldest first."""
        return self._query("SELECT * FROM decisions WHERE status = 'pending' AND deleted = 0 ORDER BY id")

    def history(self, limit: int = 50) -> list[dict[str, Any]]:
        """Most recent rows first, deleted rows left out."""
        return self._query("SELECT * FROM decisions WHERE deleted = 0 ORDER BY id DESC LIMIT ?", (int(limit),))

    def training_rows(self) -> list[dict[str, Any]]:
        """Non-deleted rows the user (or the policy simulator) answered, oldest first, with `label`.

        Rows that always-approve mode answered are left out: they say nothing about the result.
        """
        rows = self._query(
            "SELECT * FROM decisions WHERE deleted = 0 AND user_decision IS NOT NULL "
            "AND COALESCE(decided_by, '') != 'auto_approve' ORDER BY id"
        )
        for row in rows:
            row["label"] = label_for(row)
        return rows

    def counts_by_day(self) -> dict[int, int]:
        """How many times the user was asked, per day (every row that was not decided automatically)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT day, COUNT(*) AS n FROM decisions WHERE status != 'auto' AND day IS NOT NULL "
                "GROUP BY day ORDER BY day"
            ).fetchall()
        return {int(r["day"]): int(r["n"]) for r in rows}


class AutoApprove:
    """Always-approve mode: while it is on, a result the router would ask about is shared at once.

    Kept as a file in BASE_HOME (mode 0600), so it survives a restart and is read on every result.
    Refusals, held results and the final leak check are unchanged.
    """

    def __init__(self, path: Path):
        self.path = Path(path)

    @property
    def on(self) -> bool:
        return self.path.is_file()

    def set(self, on: bool) -> None:
        if on:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(f"on since {time.strftime('%Y-%m-%d %H:%M')}\n")
            self.path.chmod(0o600)
        else:
            self.path.unlink(missing_ok=True)
