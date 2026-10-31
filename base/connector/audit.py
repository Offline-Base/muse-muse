"""Audit log for connector tool calls: table audit(ts, tool, outcome, ms, via) in the device db.

A row records which tool ran, how it ended, how long it took and whether the call came through
the relay or from this machine. It never holds content: tool, outcome and via must be short
lowercase labels, so a document line, a name or a query cannot be written here by mistake.
"""

from __future__ import annotations

import re
import sqlite3
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any

_LABEL = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
VIAS = ("relay", "local")
# The relay client adds this header to every call it forwards; anything else is a local call.
VIA_HEADER = "x-muse-privacy-via"
# Set by the connector for the call in progress, so every row written during it (egress's too)
# says how the call arrived.
CURRENT_VIA: ContextVar[str] = ContextVar("muse_privacy_via", default="local")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit (
    ts REAL NOT NULL,
    tool TEXT NOT NULL,
    outcome TEXT NOT NULL,
    ms INTEGER NOT NULL DEFAULT 0,
    via TEXT NOT NULL DEFAULT 'local'
)
"""


def _connect(db_path: Path | str) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.execute(_SCHEMA)
    if "via" not in {row[1] for row in conn.execute("PRAGMA table_info(audit)")}:  # a db from before via
        with conn:
            conn.execute("ALTER TABLE audit ADD COLUMN via TEXT NOT NULL DEFAULT 'local'")
    return conn


def _label(value: str, what: str) -> str:
    if not isinstance(value, str) or not _LABEL.match(value):
        raise ValueError(f"audit {what} must be a short lowercase label like 'shared' or 'bad_input'")
    return value


def via_label(value: Any) -> str:
    """'relay' when the relay client's header says so, else 'local'."""
    return "relay" if str(value or "").strip().lower() == "relay" else "local"


def client_label(name: Any) -> str:
    """An MCP client's name as a label: lowercase letters, digits and _, starting with a letter.

    "Muse Connector 2.0" becomes muse_connector_2_0 and a URL becomes its words joined by _.
    """
    text = re.sub(r"[^a-z0-9]+", "_", str(name or "").lower()).strip("_")
    if not text or not text[0].isalpha():
        text = f"client_{text}".rstrip("_")
    return text[:40].rstrip("_")


def audit(db_path: Path | str, tool: str, outcome: str, ms: int = 0, via: str | None = None) -> None:
    """Append one audit row. Raises ValueError if tool, outcome or via is not a plain label.

    `via` defaults to the call in progress (CURRENT_VIA), which is 'local' outside a call.
    """
    via = CURRENT_VIA.get() if via is None else via
    if via not in VIAS:
        raise ValueError("audit via must be 'relay' or 'local'")
    row = (time.time(), _label(tool, "tool"), _label(outcome, "outcome"), max(0, int(ms)), via)
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute("INSERT INTO audit (ts, tool, outcome, ms, via) VALUES (?, ?, ?, ?, ?)", row)
    finally:
        conn.close()


def recent(db_path: Path | str, limit: int = 50) -> list[dict]:
    """The newest rows first, as dicts with ts, tool, outcome, ms and via."""
    conn = _connect(db_path)
    try:
        rows = conn.execute(
            "SELECT ts, tool, outcome, ms, via FROM audit ORDER BY rowid DESC LIMIT ?", (max(0, int(limit)),)
        ).fetchall()
    finally:
        conn.close()
    return [
        {"ts": ts, "tool": tool, "outcome": outcome, "ms": ms, "via": via} for ts, tool, outcome, ms, via in rows
    ]


class Audit:
    """Audit log bound to one db, callable as services.audit(tool, outcome, ms=0)."""

    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)

    @classmethod
    def for_settings(cls, settings) -> Audit:
        return cls(settings.paths.db)

    def __call__(self, tool: str, outcome: str, ms: int = 0, via: str | None = None) -> None:
        audit(self.db_path, tool, outcome, ms, via)

    def recent(self, limit: int = 50) -> list[dict]:
        return recent(self.db_path, limit)
