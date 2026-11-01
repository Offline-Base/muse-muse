"""scripts/check_name_parts.py: simulated name-pass answers, selection, scoring, report. No model."""

from __future__ import annotations

import json
from pathlib import Path

from base import guard
from base.types import Hit
from scripts import check_name_parts as cnp

ROSTER = Path(__file__).parent / "fixtures" / "guard_roster.json"
SNIPPET = (
    "Bennick Cinderfall scored 90 points on the fractions check. Bennick corrected all errors on revision."
)

# A guard with no model name pass at all, standing in for an older guard in the before/after test.
NO_NAME_PASS_GUARD = """
from base.guard import *  # noqa: F403
from base.guard import name_occurs, tag as _tag  # noqa: F401


def tag(text, roster, tagmap, llm_names=None, never_share=None):
    return _tag(text, roster, tagmap, llm_names=None, never_share=never_share)
"""


def _write(path: Path, rows: list[dict]) -> Path:
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return path


def _items() -> list[dict]:
    return [
        {"id": "syn-1", "result": SNIPPET, "names": ["Bennick", "Bennick Cinderfall"], "identifiers": []},
        {
            "id": "syn-2",
            "result": "Maya Okafor-Reyes read aloud.",
            "names": ["Maya Okafor-Reyes"],
            "identifiers": [],
        },
        {"id": "syn-3", "result": "The class average was 84%.", "names": [], "identifiers": []},
    ]


def _run(tmp_path: Path, *extra: str) -> tuple[str, list[dict]]:
    sets = _write(tmp_path / "syn.jsonl", _items())
    out = tmp_path / "out"
    assert cnp.main(["--sets", str(sets), "--roster", str(ROSTER), "--out", str(out), *extra]) == 0
    md = (out / "name_parts.md").read_text()
    rows = [json.loads(line) for line in (out / "raw" / "name_parts.jsonl").read_text().splitlines()]
    return md, rows


def test_answers_take_the_longest_name_and_its_first_or_last_word():
    item = {
        "names": ["Bennick", "Bennick Cinderfall"],
        "other_names": ["Mr. Delgado", "Delgado", "Jordan Ashby-Cole Jr."],
    }
    got = cnp.answers(item)
    assert got["all"] == ["Bennick", "Bennick Cinderfall", "Mr. Delgado", "Delgado", "Jordan Ashby-Cole Jr."]
    assert got["full"] == ["Bennick Cinderfall", "Mr. Delgado", "Jordan Ashby-Cole Jr."]
    assert got["first"] == ["Bennick", "Delgado", "Jordan"]  # titles skipped
    assert got["last"] == ["Cinderfall", "Delgado", "Ashby-Cole"]  # suffixes skipped
    assert got["none"] == []
    # Two siblings sharing a family name stay two people.
    assert cnp.persons(["Maya Cinderfall", "Leo Cinderfall", "Cinderfall"]) == [
        "Maya Cinderfall",
        "Leo Cinderfall",
    ]


def test_fake_name_pass_keeps_only_names_in_the_text_like_llm_names():
    fake = cnp.fake_llm_names(["Bennick", "Zorblat", "[Person 1]"], guard.name_occurs)
    assert fake("Bennick ran home.") == ["Bennick"]
    assert fake("   ") == []


def test_only_items_the_roster_pass_misses_are_scored(tmp_path):
    md, rows = _run(tmp_path)
    assert {r["id"] for r in rows} == {"syn-1"}  # syn-2 is on the roster, syn-3 names nobody
    assert "1 of 3 items in syn" in md
    by_answer = {r["answer"]: r for r in rows}
    assert set(by_answer) == set(cnp.ANSWERS)
    for answer in ("all", "full", "first", "last"):
        assert by_answer[answer]["leaked"] is False, answer
    none = by_answer["none"]
    assert none["leaked"] and none["past_final_check"] and none["leak_kinds"] == ["name"]
    assert none["leak_reason"] == "nothing was reported"


def test_raw_rows_and_report_carry_no_names_or_dashes(tmp_path):
    md, rows = _run(tmp_path)
    raw = (tmp_path / "out" / "raw" / "name_parts.jsonl").read_text()
    for word in ("Bennick", "Cinderfall", "Maya", "Okafor"):
        assert word not in raw and word not in md
    assert chr(0x2014) not in md and chr(0x2013) not in md  # no em or en dashes
    assert "simulation of the model's answer, not Glimmer itself" in md
    assert str(tmp_path) not in md  # paths outside the repo show by file name only


def test_before_module_compares_two_guards(tmp_path):
    before = tmp_path / "guard_without_name_pass.py"
    before.write_text(NO_NAME_PASS_GUARD)
    md, rows = _run(tmp_path, "--before-module", str(before))
    full = {r["guard"]: r for r in rows if r["answer"] == "full"}
    assert full["before"]["leaked"] and not full["after"]["leaked"]
    assert "| full | 1 | 1 | 0 | 1 | 0 | 0 (0) | 0 (0) |" in md
    assert "Leaked before (before): syn-1." in md and "Still leak after (after): none." in md
    assert "`guard_without_name_pass.py`" in md and str(tmp_path) not in md


def test_leak_reason_names_a_lowercase_common_word():
    roster = guard.load_roster(ROSTER)
    item = {"id": "x", "result": "Wendo Quill pages chose a mystery.", "names": ["Wendo Quill pages"]}
    got = cnp.measure(guard, item, ["pages"], roster, [])
    assert got["leaked"] and "common word written in lowercase" in got["leak_reason"]
    got = cnp.measure(guard, item, ["Quill"], roster, [])
    assert not got["leaked"] and got["leak_reason"] is None


def test_over_tags_are_sorted_by_kind_and_identifier_digits_are_found():
    values = ["Bennick", "Bennick Cinderfall"]
    hits = [
        Hit("person", "Bennick Cinderfall", 0, 18),  # a labeled name: not an over-tag
        Hit("person", "Bennick Cinderfall S", 30, 50),  # took the S of a student id at 49 to 56
        Hit("person", "Bennick Thornmeadow", 60, 79),  # a family name the labels left out
        Hit("person", "Nickname Bennick", 90, 106),  # an ordinary capitalized word
        Hit("phone", "555-0142", 110, 118),  # not a name tag
    ]
    assert cnp.over_tags(hits, values, [(49, 56)]) == ["identifier", "family_name", "other"]
    assert cnp.id_digits_left("[Person 1]773451 has an IEP.", ["S773451"])
    assert not cnp.id_digits_left("[Person 1] [ID 1] has an IEP.", ["S773451"])
    assert not cnp.id_digits_left("Room 12.", ["S12"])  # under 4 digits is not checked
