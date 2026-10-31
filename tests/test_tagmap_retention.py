"""The tag map under retention: expired tags dropped hourly with no toggle, old values dropped
under a toggle's retention days, roster people kept. All names and numbers are invented."""

from __future__ import annotations

import json
import os
import stat
from datetime import datetime

import pytest

from base import guard, retention
from base.config import load_settings
from base.guard import TagMap, leaks, tag
from base.services import Services

ROSTER = os.path.join(os.path.dirname(__file__), "fixtures", "guard_roster.json")
STUDENT = "Rose Tindall"
OUTSIDER = "Kestrel Vane"  # not on the roster: found by the model pass
NOON = datetime(2026, 10, 30, 12, 0).timestamp()
HOUR = 3600.0


class Clock:
    def __init__(self, now: float = NOON):
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, days: float) -> None:
        self.now += days * 24 * HOUR


@pytest.fixture
def svc(tmp_path):
    root = tmp_path / "w"
    root.mkdir()
    env = {"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(root), "DEVICE_ONLY": "1",
           "CHECKER_API_KEY": "k", "ROSTER_PATH": ROSTER}  # fmt: skip
    s = Services.create(load_settings(env), light=False, heavy=False, owner=False)
    s.tagmap.clock = Clock()
    yield s
    s.close()


def seen(svc, text: str, names=()) -> str:
    return tag(text, svc.roster, svc.tagmap, llm_names=(lambda _t: list(names)) if names else None).text


def known(svc) -> list[str]:
    return svc.tagmap.values()


def test_aged_values_are_purged_under_coppa_and_kept_under_ferpa_alone(svc):
    seen(svc, f"{OUTSIDER} called 555-0142.", [OUTSIDER])
    svc.tagmap.clock.advance(100)
    retention.maybe_purge(svc, ["ferpa"])  # no retention days: only expired tags go
    assert OUTSIDER in known(svc) and set(svc.tagmap.as_dict()) == {"[Teacher]"}  # the user's tag stays
    counts = retention.purge(svc, 90, now=svc.tagmap.clock())  # what COPPA's hourly run does
    assert counts["values"] >= 2 and OUTSIDER not in known(svc) and "555-0142" not in known(svc)


def test_roster_values_stay_while_the_person_is_on_the_roster(svc):
    seen(svc, f"{STUDENT} wrote it.")
    svc.tagmap.clock.advance(400)
    retention.purge(svc, 90, now=svc.tagmap.clock())
    assert STUDENT in known(svc) and "Corinne Abernathy" in known(svc)
    # leaks still catches roster names after a purge, and tagging still works
    assert [h.kind for h in leaks(f"{STUDENT} came back.", svc.roster, svc.tagmap)] == ["student"]
    assert STUDENT not in seen(svc, f"{STUDENT} came back.")


def test_a_person_who_left_the_roster_is_purged_after_retention_days(svc):
    seen(svc, f"{STUDENT} wrote it.")
    svc.tagmap.clock.advance(100)
    smaller = svc.roster.__class__(svc.roster.teacher, tuple(p for p in svc.roster.students if p.name != STUDENT))
    svc.tagmap.purge(retention_days=90, roster=smaller)
    assert STUDENT not in known(svc)


def test_a_value_with_a_live_tag_stays(svc):
    out = seen(svc, f"{OUTSIDER} visited.", [OUTSIDER])
    sent = guard.TAG_RE.findall(out)
    svc.tagmap.touch(sent)  # shared with Muse
    svc.tagmap.clock.advance(1)  # the next day: its tag is still in its grace window
    retention.purge(svc, 0, now=svc.tagmap.clock())  # older than the retention days, but a live tag points to it
    assert OUTSIDER in known(svc) and set(sent) <= set(svc.tagmap.for_muse())
    svc.tagmap.clock.advance(2)
    svc.tagmap.touch(sent)  # sent again: a tag past its day's grace window is not kept alive by that
    retention.purge(svc, 0, now=svc.tagmap.clock())
    assert OUTSIDER not in known(svc)


def test_tags_in_a_result_still_waiting_for_the_user_stay(svc):
    out = seen(svc, f"{OUTSIDER} visited.", [OUTSIDER])
    svc.approvals.create_pending(tool="t", request="r", result_kind="snippet", tagged_text=out, router_decision="ask_user")
    svc.tagmap.clock.advance(100)
    retention.expire_tags(svc)
    retention.purge(svc, 90, now=svc.tagmap.clock())
    assert all(t in svc.tagmap for t in guard.TAG_RE.findall(out)) and OUTSIDER in known(svc)


def test_expired_tags_are_dropped_hourly_with_no_toggle(svc, monkeypatch):
    first = guard.TAG_RE.findall(seen(svc, f"{STUDENT} wrote it."))[0]
    svc.tagmap.clock.advance(3)
    retention.maybe_purge(svc, [])
    assert first not in svc.tagmap and STUDENT in known(svc)  # the code is gone, the value stays
    second = guard.TAG_RE.findall(seen(svc, f"{STUDENT} wrote it."))[0]
    assert second != first
    svc.tagmap.clock.advance(3)
    retention.maybe_purge(svc, [])  # within the hour: not run again
    assert second in svc.tagmap
    monkeypatch.setattr(svc, "_last_tag_expiry", -10 * retention.EVERY)
    retention.maybe_purge(svc, [])
    assert second not in svc.tagmap
    assert guard.TAG_RE.findall(seen(svc, f"{STUDENT} wrote it."))[0] not in (first, second)  # never reused


def test_the_file_stays_private_and_reloads_after_a_purge_and_purging_twice_changes_nothing(svc):
    seen(svc, f"{OUTSIDER} and {STUDENT}.", [OUTSIDER])
    svc.tagmap.clock.advance(100)
    first = retention.purge(svc, 90, now=svc.tagmap.clock())
    path = svc.settings.paths.tagmap
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    before = path.read_text()
    again = svc.tagmap.purge(svc.tagmap.clock(), 90, svc.roster)
    assert first["values"] > 0 and again == {"tags": 0, "values": 0} and path.read_text() == before
    reloaded = TagMap(path, rotation="daily", clock=svc.tagmap.clock)
    assert sorted(reloaded.values()) == sorted(known(svc))
    assert json.loads(before)["version"] == 2


def test_rotation_off_drops_a_tag_unused_for_retention_days_with_its_value():
    clock = Clock()
    tm = TagMap(None, seed=1, clock=clock)
    out = guard.TAG_RE.findall(tag(f"{OUTSIDER} visited.", None, tm, llm_names=lambda _t: [OUTSIDER]).text)[0]
    clock.advance(30)
    assert tm.purge(retention_days=90) == {"tags": 0, "values": 0}  # rotation off: no expiry
    clock.advance(70)
    dropped = tm.purge(retention_days=90)
    assert dropped["values"] >= 1 and out not in tm.as_dict() and OUTSIDER not in tm.values()


def test_the_server_drops_expired_tags_once_at_start(tmp_path):
    root = tmp_path / "w"
    root.mkdir()
    env = {"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(root), "DEVICE_ONLY": "1",
           "CHECKER_API_KEY": "k", "ROSTER_PATH": ROSTER}  # fmt: skip
    settings = load_settings(env)
    settings.ensure_home()
    old = TagMap.for_settings(settings)
    old.clock = Clock(NOON - 10 * 24 * HOUR)
    stale = guard.TAG_RE.findall(tag(f"{STUDENT} wrote it.", None, old, llm_names=lambda _t: [STUDENT]).text)[0]
    old.flush()
    s = Services.create(settings, light=False, heavy=False, owner=True)
    try:
        assert stale not in s.tagmap and STUDENT in s.tagmap.values()
    finally:
        s.close()
