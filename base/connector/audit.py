"""Audit log for connector tool calls: table audit(ts, tool, outcome, ms) in the device db.

A row records which tool ran, how it ended and how long it took. It never holds content:
tool and outcome must be short lowercase labels, so a document line, a name or a query
cannot be written here by mistake.
"""

from __future__ import annotations

import re
import sqlite3
import time
from pathlib import Path

_LABEL = re.compile(r"^[a-z][a-z0-9_]{0,39}$")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit (
    ts REAL NOT NULL,
    tool TEXT NOT NULL,
    outcome TEXT NOT NULL,
    ms INTEGER NOT NULL DEFAULT 0
)
"""


def _connect(db_path: Path | str) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.execute(_SCHEMA)
    return conn


def _label(value: str, what: str) -> str:
    if not isinstance(value, str) or not _LABEL.match(value):
        raise ValueError(f"audit {what} must be a short lowercase label like 'shared' or 'bad_input'")
    return value


def audit(db_path: Path | str, tool: str, outcome: str, ms: int = 0) -> None:
    """Append one audit row. Raises ValueError if tool or outcome is not a plain label."""
    row = (time.time(), _label(tool, "tool"), _label(outcome, "outcome"), max(0, int(ms)))
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute("INSERT INTO audit (ts, tool, outcome, ms) VALUES (?, ?, ?, ?)", row)
    finally:
        conn.close()


def recent(db_path: Path | str, limit: int = 50) -> list[dict]:
    """The newest rows first, as dicts with ts, tool, outcome and ms."""
    conn = _connect(db_path)
    try:
        rows = conn.execute(
            "SELECT ts, tool, outcome, ms FROM audit ORDER BY rowid DESC LIMIT ?", (max(0, int(limit)),)
        ).fetchall()
    finally:
        conn.close()
    return [{"ts": ts, "tool": tool, "outcome": outcome, "ms": ms} for ts, tool, outcome, ms in rows]


class Audit:
    """Audit log bound to one db, callable as services.audit(tool, outcome, ms=0)."""

    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)

    @classmethod
    def for_settings(cls, settings) -> Audit:
        return cls(settings.paths.db)

    def __call__(self, tool: str, outcome: str, ms: int = 0) -> None:
        audit(self.db_path, tool, outcome, ms)

    def recent(self, limit: int = 50) -> list[dict]:
        return recent(self.db_path, limit)
