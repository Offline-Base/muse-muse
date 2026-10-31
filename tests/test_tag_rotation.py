"""Tag map version 2: daily rotation, codes that never repeat, the restore grace window, and the
upgrade from version 1. All names and numbers are invented."""

from __future__ import annotations

import json
import os
import sqlite3
import stat
import threading
from datetime import datetime

import pytest

from base import guard
from base.config import load_settings
from base.guard import GuardError, TagMap, leaks, restore, tag
from base.types import Person, Roster

ROSTER = Roster(
    teacher=Person("Odile Fenwick", "Odile", "Fenwick", role="teacher"),
    students=(
        Person("Maya Okafor", "Maya", "Okafor"),
        Person("Bram Tillery", "Bram", "Tillery"),
        Person("Odessa Quillfeather", "Odessa", "Quillfeather"),
    ),
)
NOON = datetime(2026, 10, 30, 12, 0).timestamp()  # local noon, so day arithmetic never crosses a DST edge
HOUR = 3600.0
DAY = 86400.0


class Clock:
    def __init__(self, now: float = NOON):
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, hours: float) -> None:
        self.now += hours * HOUR


def daily(path=None, clock=None, **kw) -> TagMap:
    return TagMap(path, seed=4, rotation="daily", clock=clock or Clock(), **kw)


def test_same_value_same_tag_within_a_day_and_a_new_one_the_next_day():
    clock = Clock()
    tm = daily(clock=clock)
    first = tag("Maya called 512-555-0143.", ROSTER, tm).text
    clock.advance(6)
    assert tag("Maya called 512-555-0143.", ROSTER, tm).text == first
    clock.advance(20)  # the next morning
    second = tag("Maya called 512-555-0143.", ROSTER, tm).text
    assert second != first and "[Student" in second and "[Phone 2]" in second
    assert tag("Ms. Fenwick", ROSTER, tm).text == "[Teacher]"  # the user keeps one tag
    clock.advance(24 * 10)
    assert tm.for_muse()["[Teacher]"] == "Odile Fenwick" and tm.expired("[Teacher] notes") == []  # never sent, still works


def test_codes_never_name_two_values_over_sixty_days():
    clock = Clock()
    tm = daily(clock=clock)
    named: dict[str, str] = {}
    for day in range(60):
        out = tag(f"Maya, Bram and Odessa met. Call 512-555-01{day % 100:02d}.", ROSTER, tm)
        for t, value in out.tag_map.items():
            assert named.setdefault(t, value) == value, f"{t} named two values"
        clock.advance(24)
    student_tags = [t for t in named if t.startswith("[Student")]
    assert len(student_tags) == 60 * 3  # every day the roster gets a fresh block


def test_yesterdays_tag_restores_within_the_grace_window_and_not_after():
    clock = Clock()
    tm = daily(clock=clock)
    out = tag("Bram wrote it.", ROSTER, tm)
    sent = next(t for t in out.tag_map if t.startswith("[Student"))
    tm.touch([sent])
    clock.advance(24)  # tomorrow: still within 36 h of the end of its day
    assert restore(f"{sent} essay", tm.for_muse()) == "Bram Tillery essay"
    assert tm.expired(f"{sent} essay") == []
    clock.advance(60)  # past the end of its day plus 36 h, and past 36 h after it was sent
    assert sent not in tm.for_muse()
    assert tm.expired(f"{sent} essay") == [sent]
    assert restore(f"{sent} essay", tm.for_muse()) == f"{sent} essay"


def test_for_muse_leaves_out_tags_never_sent_while_as_dict_keeps_them():
    tm = daily()
    out = tag("Maya and Bram.", ROSTER, tm)
    maya, bram = (t for t in out.tag_map if t.startswith("[Student"))
    tm.touch([maya])
    assert maya in tm.for_muse() and bram not in tm.for_muse()
    assert {maya, bram} <= set(tm.as_dict())  # the device's own model still reads both
    assert tm.expired(f"{bram} and {maya}") == [bram]


def test_touch_extends_the_grace_window():
    clock = Clock()
    tm = daily(clock=clock)
    t = tag("Odessa", ROSTER, tm).text
    tm.touch([t])
    clock.advance(48)
    tm.touch([t])  # sent again two days later, in an approved result
    clock.advance(30)
    assert t in tm.for_muse()
    clock.advance(7)
    assert t not in tm.for_muse()


def test_guessed_and_expired_tags_look_the_same():
    clock = Clock()
    tm = daily(clock=clock)
    old = tag("Maya", ROSTER, tm).text
    tm.touch([old])
    clock.advance(80)
    guessed = "[Student ZZ]"
    assert tm.expired(f"{guessed} essay") == [guessed]
    assert tm.expired(f"{old} essay") == [old]
    # plain words are not tags: "every student a chance", "error code 1", "Code 1" without brackets
    assert tm.expired("give every student a chance, error code 1, Code 1") == []
    assert tm.expired("Student Q and Person 4") == ["[Student Q]", "[Person 4]"]
    # lowercase words after "student" are plain words, not a guessed tag
    assert tm.expired("List each student who has an IEP; the student was late; student b") == []


def test_a_view_pins_the_day_and_tag_pins_it_for_one_text():
    clock = Clock()
    tm = daily(clock=clock)
    yesterday = tm.today()
    first = tag("Maya", ROSTER, tm).text
    clock.advance(24)
    assert tag("Maya", ROSTER, tm.view(yesterday)).text == first
    assert tag("Maya", ROSTER, tm).text != first

    ticking = Clock(datetime(2026, 10, 30, 23, 30).timestamp())
    tm2 = daily(clock=lambda: (ticking.advance(0.1), ticking.now)[1])  # every read is 6 minutes later
    out = tag("Maya, Bram, Odessa, Maya and Bram.", ROSTER, tm2)
    days = {tm2._tags[t].day for t in out.tag_map}
    assert len(days) == 1  # one tag day for the whole text, though the clock crossed midnight


def test_two_threads_at_midnight_get_one_tag_per_value_per_day():
    clock = Clock(datetime(2026, 10, 31, 0, 0, 0).timestamp())
    tm = daily(clock=clock)
    got: list[str] = []
    start = threading.Barrier(8)

    def work():
        start.wait()
        got.append(tm.tag_for("person", "kestrel vane", "Kestrel Vane"))

    threads = [threading.Thread(target=work) for _ in range(8)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert len(set(got)) == 1


def test_leaks_catches_a_day_one_value_on_day_ten_with_no_live_tag():
    clock = Clock()
    tm = daily(clock=clock)
    tag("Kestrel Vane visited.", ROSTER, tm, llm_names=lambda _t: ["Kestrel Vane"])
    clock.advance(24 * 9)
    tm.purge()  # its tags are gone
    assert not any(v == "Kestrel Vane" for v in tm.as_dict().values())
    assert [h.kind for h in leaks("Kestrel Vane came back.", ROSTER, tm)] == ["person"]
    assert "Kestrel Vane" not in tag("Kestrel Vane came back.", ROSTER, tm).text  # tagged with no model


def test_rotation_off_behaves_like_version_one():
    clock = Clock()
    tm = TagMap(None, seed=4, clock=clock)  # the constructor's default is off
    first = tag("Maya called 512-555-0143.", ROSTER, tm).text
    clock.advance(24 * 30)
    assert tag("Maya called 512-555-0143.", ROSTER, tm).text == first
    assert tm.for_muse() == tm.as_dict()
    assert tm.expired("[Student ZZ] and [Phone 9]") == [] and tm.day_for("[Student A]") is None
    tm.purge()
    assert tag("Maya called 512-555-0143.", ROSTER, tm).text == first


def test_running_out_of_codes_raises():
    tm = daily()
    tm._next_letter = guard.MAX_STUDENT_CODES - 1
    assert tm.tag_for("student", "Maya Okafor", "Maya Okafor") == "[Student ZZZ]"
    with pytest.raises(GuardError, match="every student tag code"):
        tm.tag_for("student", "Bram Tillery", "Bram Tillery")


def test_day_for_is_the_newest_day_among_tags_that_restore():
    clock = Clock()
    tm = daily(clock=clock)
    old = tag("Maya", ROSTER, tm).text
    tm.touch([old])
    day0 = tm.today()
    clock.advance(24)
    new = tag("Bram", ROSTER, tm).text
    assert tm.day_for(f"{old} essay") == day0 and tm.day_for(f"{new} essay") is None  # never sent
    tm.touch([new])
    assert tm.day_for(f"{old} and {new}") == day0 + 1
    assert tm.day_for("no tags here") is None


def test_version_two_file_is_private_and_reloads(tmp_path):
    path = tmp_path / "home" / "tagmap.json"
    clock = Clock()
    tm = daily(path, clock=clock)
    out = tag("Maya called 512-555-0143.", ROSTER, tm)
    tm.touch(out.tag_map)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    data = json.loads(path.read_text())
    assert data["version"] == 2 and data["rotation"] == "daily"
    again = TagMap(path, rotation="daily", clock=clock)
    assert again.seed == "4" and again.for_muse() == tm.for_muse() and again.as_dict() == tm.as_dict()
    assert tag("Maya called 512.555.0143.", ROSTER, again).text == out.text


def test_unknown_version_is_refused(tmp_path):
    path = tmp_path / "tagmap.json"
    path.write_text(json.dumps({"version": 9, "seed": "1"}))
    with pytest.raises(GuardError, match="unreadable"):
        TagMap(path)
    path.write_text("[]")
    with pytest.raises(GuardError, match="unreadable"):
        TagMap(path)


# ------------------------------------------------------------------ the version 1 upgrade

V1 = {
    "version": 1,
    "seed": "77",
    "next_letter": 3,
    "counters": {"phone": 1, "person": 2},
    "entries": [
        {"tag": "[Teacher]", "kind": "teacher", "key": "Odile Fenwick", "value": "Odile Fenwick"},
        {"tag": "[Student B]", "kind": "student", "key": "Maya Okafor", "value": "Maya Okafor"},
        {"tag": "[Student A]", "kind": "student", "key": "Bram Tillery", "value": "Bram Tillery"},
        {"tag": "[Student C]", "kind": "student", "key": "Odessa Quillfeather", "value": "Odessa Quillfeather"},
        {"tag": "[Phone 1]", "kind": "phone", "key": "5125550143", "value": "512-555-0143"},
        {"tag": "[Person 1]", "kind": "person", "key": "kestrel vane", "value": "Kestrel Vane"},
        {"tag": "[Person 2]", "kind": "person", "key": "kestrel", "value": "Kestrel"},
    ],
}


def v1_home(tmp_path):
    home = tmp_path / "home"
    home.mkdir(mode=0o700)
    path = home / "tagmap.json"
    path.write_text(json.dumps(V1))
    os.chmod(path, 0o600)
    with sqlite3.connect(home / "base.db") as db:
        db.execute("CREATE TABLE decisions (id INTEGER PRIMARY KEY, tagged_text TEXT)")
        db.execute("INSERT INTO decisions (tagged_text) VALUES ('[Student B]: 3 of 4')")
    return home, path


def test_a_version_one_file_upgrades_with_the_same_tags_and_backups_first(tmp_path):
    home, path = v1_home(tmp_path)
    clock = Clock()
    tm = TagMap(path, rotation="daily", clock=clock, backup=[home / "base.db"])
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    data = json.loads(path.read_text())
    assert data["version"] == 2 and data["next_letter"] == 3 and data["counters"] == {"phone": 1, "person": 2}
    assert tm.seed == "77"
    want = {e["tag"]: e["value"] for e in V1["entries"]}
    assert tm.for_muse() == want  # Muse may hold every one of them: they count as sent now
    assert tag("Maya called 512-555-0143 about Kestrel Vane.", ROSTER, tm).text == "[Student B] called [Phone 1] about [Person 1]."
    # the copies were made first, next to the originals, readable only by the user
    copies = sorted(p.name.split(".v1-backup-")[0] for p in home.glob("*.v1-backup-*"))
    assert copies == ["base.db", "tagmap.json"] and [p.name for p in tm.backups] != []
    for p in home.glob("*.v1-backup-*"):
        assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
    backup = next(home.glob("tagmap.json.v1-backup-*"))
    assert json.loads(backup.read_text()) == V1
    with sqlite3.connect(next(home.glob("base.db.v1-backup-*"))) as db:
        assert db.execute("SELECT tagged_text FROM decisions").fetchall() == [("[Student B]: 3 of 4",)]
    # the next day the roster gets new letters after C, and the old ones still restore for a while
    clock.advance(24)
    fresh = tag("Maya", ROSTER, tm).text
    assert fresh not in want and fresh.startswith("[Student ")
    assert "[Student B]" in tm.for_muse()
    # loading the upgraded file again makes no new copies
    TagMap(path, rotation="daily", clock=clock, backup=[home / "base.db"])
    assert len(list(home.glob("*.v1-backup-*"))) == 2


def test_a_failed_upgrade_keeps_the_backups_and_refuses_with_a_plain_message(tmp_path):
    home, path = v1_home(tmp_path)
    broken = {**V1, "entries": [{"tag": "[Student A]", "kind": "student"}]}  # no key or value
    path.write_text(json.dumps(broken))
    with pytest.raises(GuardError) as err:
        TagMap(path, rotation="daily", backup=[home / "base.db"])
    assert "could not be upgraded" in str(err.value) and "—" not in str(err.value)
    assert json.loads(path.read_text()) == broken  # left as it was
    assert len(list(home.glob("*.v1-backup-*"))) == 2
    # a service that restarts and fails again does not pile up more copies
    with pytest.raises(GuardError):
        TagMap(path, rotation="daily", backup=[home / "base.db"])
    assert len(list(home.glob("*.v1-backup-*"))) == 2


def test_rotation_off_upgrades_too_and_keeps_every_tag(tmp_path):
    _home, path = v1_home(tmp_path)
    tm = TagMap(path)
    assert tm.as_dict() == {e["tag"]: e["value"] for e in V1["entries"]}
    assert tag("Bram", ROSTER, tm).text == "[Student A]"


# ------------------------------------------------------------------ settings and start


def test_settings_default_to_daily_rotation_with_a_36_hour_grace(tmp_path):
    s = load_settings({"BASE_HOME": str(tmp_path / "h")})
    assert s.tag_rotation == "daily" and s.tag_grace_hours == 36.0
    off = load_settings({"BASE_HOME": str(tmp_path / "h"), "TAG_ROTATION": "off", "TAG_GRACE_HOURS": "12"})
    assert off.tag_rotation == "off" and off.tag_grace_hours == 12.0
    tm = TagMap.for_settings(off)
    assert tm.rotation == "off" and tm.grace == 12 * HOUR
    with pytest.raises(ValueError, match="TAG_ROTATION"):
        load_settings({"BASE_HOME": str(tmp_path / "h"), "TAG_ROTATION": "weekly"})
    with pytest.raises(ValueError, match="TAG_GRACE_HOURS"):
        load_settings({"BASE_HOME": str(tmp_path / "h"), "TAG_GRACE_HOURS": "soon"})


def test_the_server_says_one_plain_sentence_when_the_tag_map_will_not_load(tmp_path, monkeypatch, capsys):
    from base import server

    settings = load_settings({"BASE_HOME": str(tmp_path / "h")})

    def broken(_settings):
        raise GuardError(guard.MIGRATION_FAILED)

    monkeypatch.setattr(server, "build_services", broken)
    assert server.main(settings) == 3
    err = capsys.readouterr().err
    assert err.startswith("Not starting: The tag map could not be upgraded") and "Traceback" not in err
