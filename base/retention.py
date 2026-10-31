"""Delete old results from this device on the schedule a compliance toggle asks for.

See docs/RETENTION.md. Runs at most once an hour, from the release path, so it needs no timer.
"""

from __future__ import annotations

import logging
import shutil
import sqlite3
import time
from pathlib import Path
from typing import Any

from base import compliance

log = logging.getLogger(__name__)
DAY = 86400
EVERY = 3600


def purge(services: Any, days: int, now: float | None = None) -> dict[str, int]:
    """Delete decided rows, finished jobs, finished files and scan text older than `days` days."""
    cutoff = (time.time() if now is None else now) - days * DAY
    paths = services.settings.paths
    counts = {"decisions": services.approvals.purge_before(cutoff), "jobs": 0, "files": 0}
    with sqlite3.connect(paths.db, timeout=30) as db:
        have = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "jobs" in have:
            counts["jobs"] = db.execute(
                "DELETE FROM jobs WHERE created_at < ? AND status NOT IN ('queued', 'running')", (cutoff,)
            ).rowcount
    for root in (Path(paths.output), Path(paths.scans)):
        if not root.is_dir():
            continue
        for item in root.iterdir():
            if item.stat().st_mtime >= cutoff:
                continue
            if item.is_dir():
                shutil.rmtree(item, ignore_errors=True)
            else:
                item.unlink(missing_ok=True)
            counts["files"] += 1
    return counts


def maybe_purge(services: Any, profiles: list[str]) -> None:
    days = compliance.retention_days(profiles)
    if days is None or time.monotonic() - getattr(services, "_last_purge", -EVERY) < EVERY:
        return
    services._last_purge = time.monotonic()
    try:
        counts = purge(services, days)
        if any(counts.values()):
            log.info("retention removed %d decisions, %d jobs, %d files", counts["decisions"], counts["jobs"], counts["files"])
    except Exception as exc:  # a failed cleanup must not stop a result; it runs again next hour
        log.warning("retention cleanup failed: %s", type(exc).__name__)
