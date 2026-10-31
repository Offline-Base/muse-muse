"""Delete old results from this device on the schedule a compliance toggle asks for.

See docs/RETENTION.md. Runs at most once an hour, from the release path, so it needs no timer.
Tags that can no longer restore are dropped hourly too, with no toggle (expire_tags).
"""

from __future__ import annotations

import logging
import shutil
import sqlite3
import time
from pathlib import Path
from typing import Any

from base import compliance
from base.guard import TAG_RE

log = logging.getLogger(__name__)
DAY = 86400
EVERY = 3600


def waiting_tags(services: Any) -> set[str]:
    """The tags in results still waiting for the user's OK: they reach Muse if the user says yes,
    so the tag map keeps them until then."""
    approvals = getattr(services, "approvals", None)
    if approvals is None:
        return set()
    return {t for row in approvals.pending() for t in TAG_RE.findall(row.get("tagged_text") or "")}


def purge(services: Any, days: int, now: float | None = None) -> dict[str, int]:
    """Delete decided rows, finished jobs, finished files, scan text and tag map entries older
    than `days` days (TagMap.purge: roster values stay while the person is on the roster)."""
    now = time.time() if now is None else now
    cutoff = now - days * DAY
    paths = services.settings.paths
    counts = {"decisions": services.approvals.purge_before(cutoff), "jobs": 0, "files": 0, "tags": 0, "values": 0}
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
    tagmap_purge = getattr(getattr(services, "tagmap", None), "purge", None)
    if callable(tagmap_purge):
        dropped = tagmap_purge(now, days, getattr(services, "roster", None), waiting_tags(services))
        counts["tags"], counts["values"] = dropped["tags"], dropped["values"]
    return counts


def expire_tags(services: Any, now: float | None = None) -> int:
    """Drop the tags that can no longer restore (tag rotation on), keeping the ones in results
    still waiting for the user's OK. Needs no toggle. Returns how many were dropped."""
    tagmap_purge = getattr(getattr(services, "tagmap", None), "purge", None)
    if not callable(tagmap_purge):
        return 0
    return tagmap_purge(now, keep=waiting_tags(services))["tags"]


def maybe_expire_tags(services: Any) -> None:
    """expire_tags at most once an hour; a failure only logs."""
    if time.monotonic() - getattr(services, "_last_tag_expiry", -EVERY) < EVERY:
        return
    services._last_tag_expiry = time.monotonic()
    try:
        dropped = expire_tags(services)
        if dropped:
            log.info("dropped %d expired tags", dropped)
    except Exception as exc:  # a failed cleanup must not stop a result; it runs again next hour
        log.warning("tag expiry failed: %s", type(exc).__name__)


def maybe_purge(services: Any, profiles: list[str]) -> None:
    maybe_expire_tags(services)
    days = compliance.retention_days(profiles)
    if days is None or time.monotonic() - getattr(services, "_last_purge", -EVERY) < EVERY:
        return
    services._last_purge = time.monotonic()
    try:
        counts = purge(services, days)
        if any(counts.values()):
            log.info(
                "retention removed %d decisions, %d jobs, %d files, %d tags, %d values",
                *(counts.get(k, 0) for k in ("decisions", "jobs", "files", "tags", "values")),
            )
    except Exception as exc:  # a failed cleanup must not stop a result; it runs again next hour
        log.warning("retention cleanup failed: %s", type(exc).__name__)
