"""Tests for base/guard.py. Every name, number and address here is invented."""

from __future__ import annotations

import json
import os
import random
import re
import stat
import time
from pathlib import Path

import pytest

from base import guard
from base.guard import (
    TAG_RE,
    TagMap,
    blocked_reasons,
    blocked_topics,
    find_identifiers,
    find_names,
    leaks,
    load_roster,
    luhn_valid,
    restore,
    tag,
)
from base.types import Person, Roster

FIXTURE = Path(__file__).parent / "fixtures" / "guard_roster.json"


@pytest.fixture(scope="module")
def roster() -> Roster:
    return load_roster(FIXTURE)


@pytest.fixture
def tagmap(tmp_path) -> TagMap:
    return TagMap(tmp_path / "home" / "tagmap.json", seed=11)


def full(roster: Roster, first: str) -> str:
    """The full name of the roster person with this first name."""
    return next(p.name for p in roster.people() if p.first == first)


def ids(text, roster=None, **kw):
    return [(h.kind, h.value) for h in find_identifiers(text, roster, **kw)]


def names(text, roster):
    return [(h.kind, h.value) for h in find_names(text, roster)]


# ------------------------------------------------------------------ roster


def test_load_roster(roster):
    assert roster.school.startswith("Juniper Hollow")
    assert roster.teacher.name == "Corinne Abernathy"
    assert roster.teacher.role == "teacher"
    assert len(roster.students) == 8
    maya = roster.students[0]
    assert maya.last == "Okafor-Reyes" and maya.nicknames == ("May",) and maya.student_id == "S100231"
    assert all(p.role == "student" for p in roster.students)


def test_load_roster_fills_first_and_last(tmp_path):
    path = tmp_path / "roster.json"
    path.write_text(
        json.dumps({"teacher": {"name": "Odile Fenwick"}, "students": [{"name": "Tobias Quell"}]})
    )
    r = load_roster(path)
    assert (r.teacher.first, r.teacher.last) == ("Odile", "Fenwick")
    assert r.students[0].nicknames == ()


# ------------------------------------------------------------------ identifiers


@pytest.mark.parametrize(
    "number",
    [
        "4111 1111 1111 1111",
        "4111-1111-1111-1111",
        "4111111111111111",
        "5555 5555 5555 4444",
        "3782 822463 10005",
    ],
)
def test_card_numbers_with_valid_luhn(number):
    assert ids(f"The card on file is {number}.") == [("card", number)]


@pytest.mark.parametrize("number", ["4111 1111 1111 1112", "1234567812345678", "0000 0000 0000 0000"])
def test_card_numbers_rejected(number):
    assert not [k for k, _ in ids(f"Number {number} here") if k == "card"]


def test_luhn():
    assert luhn_valid("4242424242424242")
    assert luhn_valid("378282246310005")
    assert not luhn_valid("4242424242424241")
    assert not luhn_valid("")
    assert not luhn_valid("4242-4242")


@pytest.mark.parametrize("ssn", ["123-45-6789", "900-12-3456", "000-12-3456", "900 12 3456"])
def test_ssn_found(ssn):
    assert ids(f"SSN on the form: {ssn}") == [("ssn", ssn)]


@pytest.mark.parametrize("ssn", ["666-12-3456", "123-00-4567", "123-45-0000"])
def test_ssn_invalid_parts(ssn):
    assert ids(f"form says {ssn}") == []


def test_ssn_strict_rules_reject_test_areas():
    assert ids("form says 900-12-3456", allow_test_ssn=False) == []
    assert ids("form says 000-12-3456", allow_test_ssn=False) == []
    assert ids("form says 123-45-6789", allow_test_ssn=False) == [("ssn", "123-45-6789")]


def test_ssn_nine_digits_next_to_the_word():
    assert ids("SSN: 900123456") == [("ssn", "900123456")]
    assert ids("social security number 900123456") == [("ssn", "900123456")]
    assert ids("Order 900123456 shipped") == []


@pytest.mark.parametrize(
    "phone",
    [
        "(512) 555-0143",
        "(512)555-0143",
        "512-555-0143",
        "512.555.0143",
        "512 555 0143",
        "+1 512 555 0143",
        "+1 (512) 555-0143",
        "1-512-555-0143",
    ],
)
def test_phone_formats(phone):
    assert ids(f"Reach the family at {phone} after 4.") == [("phone", phone)]


def test_phone_with_context_word():
    assert ids("call 5125550143 today") == [("phone", "5125550143")]
    assert ids("Text her at 555-0143.") == [("phone", "555-0143")]
    assert ids("Text her at 555.0143.") == [("phone", "555.0143")]


def test_seven_digit_phone_in_a_table():
    assert ids("| Margaret | mother | 555-0101 | m@example.com |") == [
        ("phone", "555-0101"),
        ("email", "m@example.com"),
    ]
    assert ids("Version 3.555-0101 and 155-0101") == []
    assert ids("Lexile 820-1010 and pages 210-1150") == []


def test_not_phones():
    assert ids("Scores were 512 and 555 on the test.") == []
    assert ids("Read pages 12-34 tonight.") == []
    assert ids("The 2025-2026 school year") == []


def test_email():
    assert ids("Write to rose.parent@example.org.") == [("email", "rose.parent@example.org")]
    assert ids("cc guardian+notes@mail.example.com, thanks") == [("email", "guardian+notes@mail.example.com")]
    assert ids("Hi @maya, see you") == []


@pytest.mark.parametrize(
    "text, code",
    [
        ("Your verification code is 482913.", "482913"),
        ("PIN: 4821", "4821"),
        ("one-time code 55120873", "55120873"),
        ("482913 is your login code", "482913"),
        ("OTP=7731", "7731"),
    ],
)
def test_one_time_codes(text, code):
    assert ids(text) == [("otp", code)]


@pytest.mark.parametrize(
    "text", ["Use code 123 for the door", "zip code 78701", "code 123456789", "area code 512"]
)
def test_not_one_time_codes(text):
    assert [k for k, _ in ids(text) if k == "otp"] == []


def test_student_ids():
    assert ids("Hunter is S100233 in the system") == [("student_id", "S100233")]
    assert ids("student ID 4512345") == [("student_id", "4512345")]
    assert ids("ID: 100231") == [("student_id", "100231")]
    assert ids("S12 and Bus 12345") == []


def test_student_ids_shaped_like_the_roster():
    odd = Roster(
        teacher=Person("Odile Fenwick", "Odile", "Fenwick", role="teacher"),
        students=(Person("Tobias Quell", "Tobias", "Quell", student_id="JH-20431"),),
    )
    assert ids("Transfer JH-20999 today") == []
    assert ids("Transfer JH-20999 today", odd) == [("student_id", "JH-20999")]


@pytest.mark.parametrize(
    "address", ["1204 Hunter Lane", "77 W 5th St Apt 4B", "450 Juniper Hollow Rd", "9 Oak street"]
)
def test_addresses(address):
    assert ids(f"They live at {address}. Thanks") == [("address", address)]


def test_not_addresses():
    assert ids("I read 3 books and 4 Short Stories") == []
    assert ids("Grade 4 Dr. Abernathy") == []


@pytest.mark.parametrize(
    "text, date",
    [
        ("born March 14, 2016", "March 14, 2016"),
        ("DOB: 03/14/2016", "03/14/2016"),
        ("Her birthday is 2016-03-14.", "2016-03-14"),
        ("born on 14 March 2016", "14 March 2016"),
        ("date of birth 3/4/16", "3/4/16"),
    ],
)
def test_dates_of_birth(text, date):
    assert ids(text) == [("dob", date)]


def test_dates_without_birth_words_are_not_dob():
    assert ids("born in Texas") == []
    assert ids("The field trip is March 14, 2016.") == []


# ------------------------------------------------------------------ names


def test_full_first_last_and_nicknames(roster):
    assert names("Maya Okafor-Reyes read first.", roster) == [("student", "Maya Okafor-Reyes")]
    assert names("Then Maya read.", roster) == [("student", "Maya")]
    assert names("I asked Bramwell to revise.", roster) == [("student", "Bramwell")]
    assert names("Lexi and Billy shared.", roster) == [("student", "Lexi"), ("student", "Billy")]
    assert names("Okafor-Reyes, Maya", roster) == [("student", "Okafor-Reyes, Maya")]


def test_lowercase_last_names_count_unless_short_or_a_common_word(roster):
    # A lowercase surname is how names show up in file slugs and quick notes (review F6).
    assert names("the bramwell file", roster) == [("student", "bramwell")]
    assert names("we met priya at noon", roster) == [("student", "priya")]
    assert names("a lindqvist note", roster) == [("student", "lindqvist")]
    assert names("met bo at noon", roster) == []  # two letters
    assert names("the hunter green door", roster) == []  # a common word


def test_possessives_hyphens_apostrophes_and_short_names(roster):
    assert names("Maya's thesis", roster) == [("student", "Maya")]
    assert names("Reyes said hi", roster) == [("student", "Reyes")]
    assert names("Liam O'Callaghan", roster) == [("student", "Liam O'Callaghan")]
    assert names("Mr. O’Callaghan called", roster) == [("student", "O’Callaghan")]
    assert names("OCallaghan wrote", roster) == [("student", "OCallaghan")]
    assert names("Bo's drawing and Bo again", roster) == [("student", "Bo"), ("student", "Bo")]
    assert names("bo staff and BOX", roster) == []


def test_teacher_forms(roster):
    assert names("Ms. Abernathy graded it.", roster) == [("teacher", "Ms. Abernathy")]
    assert names("Corinne Abernathy graded it.", roster) == [("teacher", "Corinne Abernathy")]
    assert names("Ask Corinne.", roster) == [("teacher", "Corinne")]


def test_misspellings_within_one_edit(roster):
    assert names("Mayah came late.", roster) == [("student", "Mayah")]  # insertion
    assert names("Bramwel came late.", roster) == [("student", "Bramwel")]  # deletion
    assert names("Petrakos came late.", roster) == [("student", "Petrakos")]  # substitution
    assert names("Priay came late.", roster) == [("student", "Priay")]  # swap
    assert names("Abernethy came late.", roster) == [("teacher", "Abernethy")]
    assert names("Okafor-Reyez came late.", roster) == [("student", "Okafor-Reyez")]


def test_misspellings_need_capital_four_letters_and_not_a_common_word(roster):
    assert names("mayah came late.", roster) == []  # lowercase
    assert names("Silly mistakes happen.", roster) == []  # common word one edit from Billy
    assert names("Rise and shine.", roster) == []
    assert names("Hunters track deer.", roster) == []


@pytest.mark.parametrize(
    "sentence",
    [
        "May I go?",
        "Will you help?",
        "We planted a rose garden.",
        "She painted the door hunter green.",
        "In May we read poems.",
        "The Rose Garden opened in May 2026.",
        "You will see it soon, and it may rain.",
        "A hunter walked by.",
    ],
)
def test_common_words_are_not_names(roster, sentence):
    assert names(sentence, roster) == []


def test_common_word_names_used_as_names(roster):
    assert names("Rose wrote a poem.", roster) == [("student", "Rose")]
    assert names("I asked Will to read.", roster) == [("student", "Will")]
    assert names("Hunter's essay", roster) == [("student", "Hunter")]
    assert names("Ask May to share.", roster) == [("student", "May")]


def test_relatives_who_share_a_last_name(roster):
    assert names("Margaret Bramwell called.", roster) == [("person", "Margaret Bramwell")]
    assert names("Jean-Paul Okafor-Reyes and Lourdes Reyes", roster) == [
        ("person", "Jean-Paul Okafor-Reyes"),
        ("person", "Lourdes Reyes"),
    ]
    assert names("Then Bramwell left.", roster) == [("student", "Bramwell")]
    assert names("Ms. Bramwell left.", roster) == [("student", "Bramwell")]
    assert names("Hunter Bramwell left.", roster) == [("student", "Hunter Bramwell")]


def test_word_like_nicknames():
    r = Roster(
        teacher=Person("Odile Fenwick", "Odile", "Fenwick", role="teacher"),
        students=(Person("Priyanka Raghavan", "Priyanka", "Raghavan", nicknames=("Pinky", "Dash")),),
    )
    assert names("I hurt my pinky and had to dash home.", r) == []
    assert names("Pinky wrote and Dash read.", r) == [("student", "Pinky"), ("student", "Dash")]


def test_shared_first_name_with_initial():
    r = Roster(
        teacher=Person("Odile Fenwick", "Odile", "Fenwick", role="teacher"),
        students=(Person("Maya Okafor", "Maya", "Okafor"), Person("Maya Lindqvist", "Maya", "Lindqvist")),
    )
    tm = TagMap(None, seed=3)
    out = tag("Maya L. and Maya O. sat together, two Mayas, and Maya.", r, tm)
    lind, oka = tm.tag_for("student", "Maya Lindqvist"), tm.tag_for("student", "Maya Okafor")
    assert out.text == f"{lind}. and {oka}. sat together, two [Person 1], and [Person 2]."
    assert (
        restore(out.text, out.tag_map)
        == "Maya Lindqvist. and Maya Okafor. sat together, two Mayas, and Maya."
    )


def test_shared_form_becomes_a_person_tag():
    r = Roster(
        teacher=Person("Odile Fenwick", "Odile", "Fenwick", role="teacher"),
        students=(Person("Ada Lindgren", "Ada", "Lindgren"), Person("Felix Lindgren", "Felix", "Lindgren")),
    )
    assert names("Lindgren and Ada", r) == [("person", "Lindgren"), ("student", "Ada")]
    tm = TagMap(None, seed=1)
    out = tag("Lindgren and Ada", r, tm)
    assert out.text.startswith("[Person 1] and [Student ")
    assert restore(out.text, out.tag_map) == "Lindgren and Ada Lindgren"


# ------------------------------------------------------------------ tag map


def test_tagmap_file_is_private_and_reloads(tmp_path, roster):
    path = tmp_path / "home" / "tagmap.json"
    tm = TagMap(path, seed=5)
    first = tag("Maya called (512) 555-0143.", roster, tm)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    again = TagMap(path)  # no seed: the stored one is used
    assert again.seed == "5"
    assert again.as_dict() == tm.as_dict()
    assert tag("Maya called 512.555.0143.", roster, again).text == first.text


def test_students_get_shuffled_letters_once_per_device(roster):
    def letters(seed):
        tm = TagMap(None, seed=seed)
        tm.ensure_roster(roster)
        return [tm.tag_for("student", s.name) for s in roster.students]

    order = letters(11)
    assert sorted(order) == [f"[Student {c}]" for c in "ABCDEFGH"]
    assert order != sorted(order)  # not roster order
    assert letters(11) == order  # same device seed, same letters
    assert letters(12) != order  # another device, another order


def test_teacher_tag_and_numbered_kinds(roster, tagmap):
    out = tag("Ms. Abernathy: call 512-555-0143 or 512-555-0144, email a@example.com", roster, tagmap)
    assert out.text == "[Teacher]: call [Phone 1] or [Phone 2], email [Email 1]"
    assert out.tag_map["[Teacher]"] == "Corinne Abernathy"


def test_same_value_same_tag_in_any_format(roster, tagmap):
    a = tag("Call (512) 555-0143.", roster, tagmap).text
    b = tag("Call +1 512 555 0143.", roster, tagmap).text
    c = tag("Card 4111-1111-1111-1111 and 4111 1111 1111 1111", roster, tagmap).text
    assert a == b == "Call [Phone 1]."
    assert c == "Card [Card 1] and [Card 1]"


def test_letters_after_z():
    assert [guard._letters(i) for i in (0, 25, 26, 27, 51, 52)] == ["A", "Z", "AA", "AB", "AZ", "BA"]
    big = Roster(
        teacher=Person("Odile Fenwick", "Odile", "Fenwick", role="teacher"),
        students=tuple(Person(f"Kid{i:02d} Vantor", f"Kid{i:02d}", "Vantor") for i in range(30)),
    )
    tm = TagMap(None, seed=2)
    tm.ensure_roster(big)
    tags = set(tm.as_dict())
    assert {"[Student Z]", "[Student AA]", "[Student AD]"} <= tags
    assert "[Student AE]" not in tags


def test_unreadable_tagmap_is_refused(tmp_path):
    path = tmp_path / "tagmap.json"
    path.write_text("{not json")
    with pytest.raises(guard.GuardError):
        TagMap(path)


# ------------------------------------------------------------------ tag


def test_possessive_keeps_the_s(roster, tagmap):
    out = tag("Maya's essay", roster, tagmap)
    letter = tagmap.tag_for("student", full(roster, "Maya"))
    assert out.text == f"{letter}'s essay"


def test_overlapping_spans_take_the_longest(roster, tagmap):
    out = tag("Write maya.okafor@example.org or visit 1204 Hunter Lane.", roster, tagmap)
    assert out.text == "Write [Email 1] or visit [Address 1]."
    out = tag("Maya Okafor-Reyes and Maya", roster, tagmap)
    letter = tagmap.tag_for("student", full(roster, "Maya"))
    assert out.text == f"{letter} and {letter}"
    out = tag("Maya was born May 3, 2016.", roster, tagmap)
    assert out.text == f"{letter} was born [DOB 1]."


def test_rescan_catches_what_a_pass_missed(roster, tagmap, monkeypatch):
    real = guard._identifier_cands
    calls = {"n": 0}

    def flaky(text, roster=None, allow_test_ssn=True):
        calls["n"] += 1
        return [] if calls["n"] == 1 else real(text, roster, allow_test_ssn)

    monkeypatch.setattr(guard, "_identifier_cands", flaky)
    out = tag("Maya at 512-555-0143", roster, tagmap)
    assert "555" not in out.text and "[Phone 1]" in out.text
    assert calls["n"] >= 2


def test_llm_names_add_person_tags(roster, tagmap):
    def llm_names(text):
        return ["Desmond Kowalczyk", "Maya", "the boy"]

    out = tag("Desmond Kowalczyk sat with Maya.", roster, tagmap, llm_names=llm_names)
    maya = tagmap.tag_for("student", full(roster, "Maya"))
    assert out.text == f"[Person 1] sat with {maya}."
    assert out.tag_map["[Person 1]"] == "Desmond Kowalczyk"
    # Known values are tagged later even without the model, and count as leaks.
    assert tag("Desmond Kowalczyk's mom called.", roster, tagmap).text == "[Person 1]'s mom called."
    assert [h.kind for h in leaks("Desmond Kowalczyk", roster, tagmap)] == ["person"]


LEAKED_SNIPPET = "Bennick Cinderfall scored 90 points. Bennick corrected all errors on revision."


@pytest.mark.parametrize("found", [["Bennick Cinderfall"], ["Cinderfall"], ["Bennick"]])
def test_llm_names_tag_every_part_of_a_name(roster, tagmap, found):
    # The model often reports the full name and not the first name alone (unseen syn-0765), or
    # one word of the name only. Every mention is tagged either way.
    out = tag(LEAKED_SNIPPET, roster, tagmap, llm_names=lambda text: found)
    assert "Bennick" not in out.text and "Cinderfall" not in out.text
    assert out.text.endswith("corrected all errors on revision.")
    # Each part is a known value now, so the final check catches it in any later text.
    assert [h.kind for h in leaks("Bennick said hi.", roster, tagmap)] == ["person"]


def test_llm_name_parts_skip_titles_particles_and_lowercase_words(roster, tagmap):
    out = tag("Ana de la Cruz met Cruz. Then de la came.", roster, tagmap, llm_names=lambda t: ["Ana de la Cruz"])
    assert out.text == "[Person 1] met [Person 2]. Then de la came."
    assert tagmap.get("[Person 3]") == "Ana"  # covered by the full name here, remembered for later
    out = tag("Grace Hunter left. The hunter saw grace. Grace waved.", roster, tagmap, llm_names=lambda t: ["Grace Hunter"])
    assert out.text == "[Person 4] left. The hunter saw grace. [Person 5] waved."
    out = tag("Ms. Thornwick called. Ms. smiled.", roster, tagmap, llm_names=lambda t: ["Ms. Thornwick"])
    assert out.text == "[Person 6] called. Ms. smiled."
    assert guard._name_parts("Jordan Ashby-Cole Jr.") == ["Jordan", "Ashby-Cole", "Ashby", "Cole"]


def test_llm_name_extension_stops_at_common_words_and_roster_names(roster, tagmap):
    out = tag("Yesterday Cinderfall said Hello. Report For Cinderfall Today.", roster, tagmap, llm_names=lambda t: ["Cinderfall"])
    assert out.text == "Yesterday [Person 1] said Hello. Report For [Person 1] Today."
    maya = tagmap.tag_for("student", full(roster, "Maya"))
    out = tag("Maya Cinderfall sat with Maya.", roster, tagmap, llm_names=lambda t: ["Maya Cinderfall"])
    assert out.text.endswith(f"sat with {maya}.")  # the roster word keeps its student tag


def names_said(*found):
    return lambda text: list(found)


def test_occurring_names_keeps_the_words_that_occur(roster, tagmap):
    # LocalLLM.llm_names keeps these, so a name the model wrote differently still tags its words.
    assert guard.occurring_names("Bennick Cinderfall", "Cinderfall, Bennick: 90.") == ["Bennick", "Cinderfall"]
    assert guard.occurring_names("Bennick's", "Bennick scored 90.") == ["Bennick"]
    assert guard.occurring_names("Made Up", "Bennick scored 90.") == []
    text = "Bennick Cinderfall scored 90. Bennick revised."
    out = tag(text, roster, tagmap, llm_names=lambda t: guard.occurring_names("Bennick Cinderfal", t))
    assert out.text == "[Person 1] scored 90. [Person 2] revised."


@pytest.mark.parametrize(
    ("text", "found", "expected"),
    [
        ("Bennick Cinderfall S401399 scored 90.", ["Bennick Cinderfall"], "[Person 1] [ID 1] scored 90."),
        ("Bennick Cinderfall S401399 scored 90.", ["Cinderfall"], "[Person 1] [ID 1] scored 90."),
        ("Bennick S-401399 scored 90.", ["Bennick"], "[Person 1] [ID 1] scored 90."),
        ("New student: Bennick Cinderfall S 401399.", ["Bennick"], "New student: [Person 1] [ID 1]."),
        ("Cinderfall Bennick S401399 90 88 92", ["Bennick", "Cinderfall"], "[Person 1] [ID 1] 90 88 92"),
        ("Lithia Emberfall ID S773451 scored 88.", ["Emberfall"], "[Person 1] ID [ID 1] scored 88."),
        ("BENNICK CINDERFALL S401399 SCORED 90.", ["Cinderfall"], "[Person 1] [ID 1] SCORED 90."),
        ("Bennick S4011 scored 90.", ["Bennick"], "[Person 1] S4011 scored 90."),
        (
            "Contact Bennick Cinderfall BCinderfall@example.org today.",
            ["Bennick"],
            "Contact [Person 1] [Email 1] today.",
        ),
    ],
)
def test_llm_name_never_takes_in_an_identifier(roster, tagmap, text, found, expected):
    # The "S" of a student id is a capital letter, and the email starts with one. A name that took
    # them in would leave the id digits bare, with no identifier hit for the router's floor.
    out = tag(text, roster, tagmap, llm_names=names_said(*found))
    assert out.text == expected
    if "[ID 1]" in expected:
        assert "student_id" in [h.kind for h in out.hits]


def test_names_in_single_quotes_are_tagged(roster, tagmap):
    out = tag("The card was signed ‘Maya’ and nothing else.", roster, tagmap)
    maya, rose = (tagmap.tag_for("student", full(roster, n)) for n in ("Maya", "Rose"))
    assert out.text == f"The card was signed ‘{maya}’ and nothing else."
    assert tag("Maya wrote ‘Maya’ on her folder.", roster, tagmap).text == f"{maya} wrote ‘{maya}’ on her folder."
    assert tag("She wrote 'Rosie' on the board.", roster, tagmap).text == f"She wrote '{rose}' on the board."
    assert tag("'Maya, sit down,' the aide said.", roster, tagmap).text == f"'{maya}, sit down,' the aide said."
    assert tag("‘Ms. Abernathy’ signed it.", roster, tagmap).text == "‘[Teacher]’ signed it."
    liam = tagmap.tag_for("student", full(roster, "Liam"))
    assert tag("O'Callaghan read.", roster, tagmap).text == f"{liam} read."  # still one name
    said = names_said("Bennick", "Benny", "Cinderfall")
    out = tag("Signed ‘Bennick’. Bennick ‘Benny’ Cinderfall scored 90.", roster, tagmap, llm_names=said)
    assert out.text == "Signed ‘[Person 1]’. [Person 1] ‘[Person 2]’ [Person 3] scored 90."


def test_llm_name_words_are_known_values_even_inside_a_longer_name(roster, tagmap):
    text = "Bennick Cinderfall scored 90 points on the fractions check."
    tag(text, roster, tagmap, llm_names=names_said("Bennick Cinderfall"))
    later = tag("Bennick corrected all errors on revision.", roster, tagmap)  # the model missed it
    assert "Bennick" not in later.text
    assert [h.kind for h in leaks("Mr. Cinderfall called about it.", roster, tagmap)] == ["person"]
    # A one-word report inside the fuller name the guard built is remembered too.
    tag("Lithia Emberfall finished early.", roster, tagmap, llm_names=names_said("Emberfall"))
    for later in ("Emberfall did well.", "Lithia did well."):
        assert [h.kind for h in leaks(later, roster, tagmap)] == ["person"]


def test_llm_name_extension_takes_in_accented_capitals(roster, tagmap):
    out = tag("Élodie Cinderfall scored 90. Élodie revised.", roster, tagmap, llm_names=names_said("Cinderfall"))
    assert out.text == "[Person 1] scored 90. [Person 2] revised."
    out = tag("Bennick Østergaard scored 90. Østergaard revised.", roster, tagmap, llm_names=names_said("Bennick"))
    assert "Østergaard" not in out.text
    # A relative before a roster last name ("Tindall") the same way.
    out = tag("Ángel Tindall picked her up.", roster, tagmap)
    assert list(out.tag_map.values()) == ["Ángel Tindall"] and out.text.endswith("] picked her up.")


def test_llm_names_with_possessives_and_punctuation(roster, tagmap):
    out = tag("Bennick's score was 90. Bennick corrected all errors.", roster, tagmap, llm_names=names_said("Bennick's"))
    assert out.text == "[Person 1]'s score was 90. [Person 1] corrected all errors."
    out = tag("Cinderfall. Later Cinderfall revised.", roster, tagmap, llm_names=names_said("Cinderfall."))
    assert out.text == "[Person 2]. Later [Person 2] revised."
    text = "Ona Thistlewood's group won. Ona Thistlewood cheered."
    for found in (["Ona Thistlewood"], ["Ona"], ["Ona Thistlewood's"]):
        out = tag(text, roster, tagmap, llm_names=names_said(*found))
        assert out.text == "[Person 3]'s group won. [Person 3] cheered.", found  # one person, 's kept
    assert restore("Thank [Person 3] for leading.", out.tag_map) == "Thank Ona Thistlewood for leading."
    out = tag("Bennick Cinderfall's score was 90. Cinderfall revised.", roster, tagmap, llm_names=names_said("Bennick"))
    assert "Cinderfall" not in out.text and "'s score" in out.text


def test_llm_name_lowercase_words_count_unless_particles(roster, tagmap):
    for text in ("Bennick cinderfall scored 90. Cinderfall revised.", "Bennick Cinderfall scored 90. Cinderfall revised."):
        out = tag(text, roster, tagmap, llm_names=names_said("Bennick cinderfall"))
        assert "inderfall" not in out.text, text
    assert guard._name_parts("Ana De La Cruz") == ["Ana", "Cruz"]
    assert guard._name_parts("Van Thistlewood") == ["Van", "Thistlewood"]


def test_llm_name_extension_skips_words_that_are_not_names(roster, tagmap):
    text = "Algebra Bennick Cinderfall scored 90. We started algebra today."
    out = tag(text, roster, tagmap, llm_names=names_said("Bennick"))
    assert out.text == "Algebra [Person 1] scored 90. We started algebra today."
    out = tag("Ana De La Cruz called. La Paz trip is set.", roster, tagmap, llm_names=names_said("Ana De La Cruz"))
    assert out.text.endswith("called. La Paz trip is set.")
    text = (
        "Meanwhile Bennick finished the quiz early. Overall Bennick Cinderfall did well. "
        "The overall score was 84%. Meanwhile, the class reviewed fractions."
    )
    for found in (["Bennick Cinderfall"], ["Bennick"]):
        out = tag(text, roster, tagmap, llm_names=names_said(*found))
        assert out.text.startswith("Meanwhile [Person") and "Overall [Person" in out.text
        assert out.text.endswith("The overall score was 84%. Meanwhile, the class reviewed fractions.")
    for label, found in (("Celebrating", "Korvin"), ("Nurse", "Korvin Starling"), ("Hi", "Korvin")):
        out = tag(f"{label} Korvin Starling did well.", roster, tagmap, llm_names=names_said(found))
        assert out.text.startswith(f"{label} [Person")
        assert restore(out.text, out.tag_map) == f"{label} Korvin Starling did well."
    text = "Nyssa Firebrook IEP meeting is Friday. IEP goals are attached."
    out = tag(text, roster, tagmap, llm_names=names_said("Firebrook"))
    assert out.text.endswith(" IEP meeting is Friday. IEP goals are attached.")
    # One step only: a word taken in ("Spanish") takes in nothing more.
    text = "Bennick Cinderfall Spanish homework is late. Algebra Spanish Tutoring starts Monday."
    out = tag(text, roster, tagmap, llm_names=names_said("Cinderfall"))
    assert "Algebra [Person" in out.text and "] Tutoring starts Monday." in out.text
    # A name written in lowercase only inside an identifier (an email) is still taken in.
    out = tag("Azura Willowmere lives here. Email azura@example.com.", roster, tagmap, llm_names=names_said("Willowmere"))
    assert out.text.endswith("] lives here. Email [Email 1].") and "Azura" not in out.text
    # Nothing that is not a name became a known value for later texts.
    for later in (
        "Next week we review algebra.",
        "Overall, the class average was 84%.",
        "Meanwhile the rest of the class worked.",
        "The IEP team meets Monday.",
        "Hi everyone.",
    ):
        assert tag(later, roster, tagmap).text == later and leaks(later, roster, tagmap) == []


def test_common_word_parts_keep_the_roster_context_rules(tagmap):
    out = tag("May Thornquist scored 18/20. The retest is May 5.", None, tagmap, llm_names=names_said("May Thornquist"))
    assert out.text == "[Person 1] scored 18/20. The retest is May 5."
    text = "Will Thornquist scored 90. Will you send him the rubric?"
    out = tag(text, None, tagmap, llm_names=names_said("Will Thornquist"))
    assert out.text.endswith("scored 90. Will you send him the rubric?")
    out = tag("May Thornquist left. May revised her essay.", None, tagmap, llm_names=names_said("May Thornquist"))
    assert out.text.startswith("[Person 1] left. [Person") and "May" not in out.text
    # "May" is a known value now, and later texts get the same context rules.
    for later in ("May 5 is the retest.", "May I add a note?", "Scores come in May."):
        assert tag(later, None, tagmap).text == later and leaks(later, None, tagmap) == []
    assert "May" not in tag("May revised it again.", None, tagmap).text


def test_llm_name_extension_is_one_step_and_fast():
    syllables = ["Bra", "Cel", "Dor", "Fen", "Gal", "Hob", "Jor", "Kel", "Lum", "Mor", "Nax", "Pel", "Quor", "Rin"]
    words = [a + b.lower() for a in syllables for b in syllables if not guard._is_common(a + b.lower())]
    lines = [f"- Bennick Cinderfall {words[i]} notes.docx" for i in range(150)] * 2
    text = "\n".join(lines)
    for found in (["Bennick Cinderfall"], ["Bennick"]):
        started = time.perf_counter()
        out = tag(text, None, TagMap(None), llm_names=names_said(*found))
        elapsed = time.perf_counter() - started
        assert elapsed < 2.0, f"{found} {elapsed:.3f} s"
        assert "Bennick" not in out.text and "Cinderfall" not in out.text
    # Reported in full, the name is one person and every document title stays readable.
    out = tag(text, None, TagMap(None), llm_names=names_said("Bennick Cinderfall"))
    assert set(TAG_RE.findall(out.text)) == {"[Person 1]"}
    assert out.text.splitlines()[0] == f"- [Person 1] {words[0]} notes.docx"


def test_llm_names_errors_propagate(roster, tagmap):
    def broken(text):
        raise RuntimeError("model down")

    with pytest.raises(RuntimeError):
        tag("Desmond", roster, tagmap, llm_names=broken)


def test_tag_reports_topics_and_reasons(roster, tagmap):
    never_share = {"iep": ["IEP", "504 plan"], "medical": ["ADHD", "allergy"]}
    out = tag("Maya has an IEP and a peanut allergy.", roster, tagmap, never_share=never_share)
    assert out.topics == ["iep", "medical"]
    assert out.blocked == ["Mentions an IEP or 504 plan", "Mentions health or medical details"]
    assert tag("Maya read.", roster, tagmap, never_share=never_share).blocked == []


# ------------------------------------------------------------------ restore


def test_restore_tolerates_rephrasing():
    tm = {
        "[Student A]": "Maya Okafor-Reyes",
        "[Student AB]": "Rose Tindall",
        "[Teacher]": "Corinne Abernathy",
    }
    assert restore("[Student A] wrote", tm) == "Maya Okafor-Reyes wrote"
    assert restore("Student A wrote", tm) == "Maya Okafor-Reyes wrote"
    assert restore("Student A's essay", tm) == "Maya Okafor-Reyes's essay"
    assert restore("[Student A]'s essay", tm) == "Maya Okafor-Reyes's essay"
    assert restore("Grade it (Student A).", tm) == "Grade it (Maya Okafor-Reyes)."
    # two or three letters restore only in brackets: "student is" and "Student ID" are words
    assert restore("compare student a and student ab.", tm) == "compare Maya Okafor-Reyes and student ab."
    assert restore("compare Student AB and (Student AB).", tm) == "compare Student AB and (Student AB)."
    assert restore("compare [student ab].", tm) == "compare Rose Tindall."
    assert restore("[Student AB] then [Student A]", tm) == "Rose Tindall then Maya Okafor-Reyes"
    assert restore("Send it to [Teacher].", tm) == "Send it to Corinne Abernathy."


def test_restore_leaves_ordinary_words_and_unknown_tags():
    tm = {"[Student A]": "Maya Okafor-Reyes", "[Code 1]": "482913", "[Phone 1]": "512-555-0143"}
    assert restore("Give every student a chance.", tm) == "Give every student a chance."
    assert restore("the teacher said so", tm) == "the teacher said so"
    assert restore("[Student Q] and [Phone 2]", tm) == "[Student Q] and [Phone 2]"
    assert restore("error code 1 appeared", tm) == "error code 1 appeared"
    assert restore("Use [Code 1] or Phone 1, not Phone 12", tm) == "Use 482913 or 512-555-0143, not Phone 12"


def test_restore_accepts_a_tagmap(roster, tagmap):
    out = tag("Priya read.", roster, tagmap)
    assert restore(out.text, tagmap) == "Priya Ramanathan read."


# ------------------------------------------------------------------ leaks


def test_leaks_reports_names_nicknames_values_and_identifiers(roster, tagmap):
    found = leaks("Lexi and Bramwell, S100231, 512-555-0143", roster, tagmap)
    assert [(h.kind, h.value) for h in found] == [
        ("student", "Lexi"),
        ("student", "Bramwell"),
        ("student_id", "S100231"),
        ("phone", "512-555-0143"),
    ]


def test_leaks_never_reports_tags(roster, tagmap):
    tag("Maya at 512-555-0143, code 4821", roster, tagmap)
    text = "[Student A] and [Teacher] called [Phone 1] with [Code 1]; [Student AB] and [Person 3]."
    assert leaks(text, roster, tagmap) == []
    assert leaks("", roster, tagmap) == []


def test_leaks_with_a_plain_dict(roster):
    assert [h.kind for h in leaks("Desmond Kowalczyk", roster, {"[Person 1]": "Desmond Kowalczyk"})] == [
        "person"
    ]


# ------------------------------------------------------------------ corpus

# (sentence, first names of everyone in it). All invented.
CORPUS = [
    ("Maya Okafor-Reyes turned in her essay early.", ["Maya"]),
    ("Maya's thesis was the clearest in the class.", ["Maya"]),
    ("Ask May to share her outline with Rosie.", ["Maya", "Rose"]),
    ("Rose Tindall and Hunter Bramwell worked as partners.", ["Rose", "Hunter"]),
    ("Hunter wrote three paragraphs about his grandmother's farm.", ["Hunter"]),
    ("I asked Bramwell to revise the conclusion.", ["Hunter"]),
    ("Liam O'Callaghan forgot his rubric at home.", ["Liam"]),
    ("Mr. O’Callaghan emailed about Liam's late work.", ["Liam"]),
    ("Bo Lindqvist read his story aloud.", ["Bo"]),
    ("Bo's drawing of the river was detailed.", ["Bo"]),
    ("Lexi and Alex are the same student, Alexandra Petrakis.", ["Alexandra"]),
    ("Billy Fairbanks asked for more time.", ["William"]),
    ("William's score went from 2 to 4 on organization.", ["William"]),
    ("Priya Ramanathan's essay compares two poems.", ["Priya"]),
    ("Ms. Abernathy will meet with Priya on Friday.", ["Corinne", "Priya"]),
    ("Corinne Abernathy graded the essays on Sunday.", ["Corinne"]),
    ("Call Maya's mom at (512) 555-0143 after school.", ["Maya"]),
    ("Her dad's cell is +1 512 555 0199.", []),
    ("Send the form to rose.parent@example.org by Monday.", []),
    ("Hunter's student ID is S100233.", ["Hunter"]),
    ("The card on file is 4111 1111 1111 1111.", []),
    ("His SSN is 900-12-3456 according to the form.", []),
    ("Your verification code is 482913, Bo.", ["Bo"]),
    ("Priya was born March 14, 2016.", ["Priya"]),
    ("Liam lives at 1204 Hunter Lane Apt 3.", ["Liam"]),
    ("Mayah and Bramwel both misspelled names on the sign-up sheet.", ["Maya", "Hunter"]),
    ("MAYA OKAFOR-REYES: score 3 of 4.", ["Maya"]),
    ("Petrakos and Fairbank sat together.", ["Alexandra", "William"]),
    ("Ask Will to bring the rubric, and tell Hunter too.", ["William", "Hunter"]),
    ("Rosie said Bo and Lexi shared one copy.", ["Rose", "Bo", "Alexandra"]),
]
IDENTIFIERS = [
    "(512) 555-0143",
    "+1 512 555 0199",
    "rose.parent@example.org",
    "S100233",
    "4111 1111 1111 1111",
    "900-12-3456",
    "482913",
    "March 14, 2016",
    "1204 Hunter Lane Apt 3",
]
BRACKETS = re.compile(r"\[[^\[\]]*\]")


def test_corpus_has_thirty_sentences():
    assert len(CORPUS) == 30


@pytest.mark.parametrize("sentence, people", CORPUS)
def test_corpus_no_leaks_after_tagging(roster, tagmap, sentence, people):
    out = tag(sentence, roster, tagmap)
    assert leaks(out.text, roster, tagmap) == []
    for first in people:
        p = next(p for p in roster.people() if p.first == first)
        for form in (p.first, p.last, *p.nicknames):
            assert not re.search(rf"\b{re.escape(form)}\b", out.text), form


@pytest.mark.parametrize("sentence, people", CORPUS)
def test_corpus_round_trip(roster, tagmap, sentence, people):
    out = tag(sentence, roster, tagmap)
    back = restore(out.text, out.tag_map)
    assert not TAG_RE.search(back)
    for first in people:
        assert full(roster, first) in back
    for value in IDENTIFIERS:
        if value in sentence:
            assert value in back
            assert value not in out.text


@pytest.mark.parametrize("sentence, people", CORPUS)
def test_corpus_idempotent_and_never_nested(roster, tagmap, sentence, people):
    once = tag(sentence, roster, tagmap)
    twice = tag(once.text, roster, tagmap)
    assert twice.text == once.text
    assert twice.hits == []
    assert "[[" not in once.text and "]]" not in once.text
    assert all(TAG_RE.fullmatch(b) for b in BRACKETS.findall(once.text))


def test_full_names_round_trip_exactly(roster, tagmap):
    text = "Maya Okafor-Reyes, Hunter Bramwell and Corinne Abernathy met at 1204 Hunter Lane."
    out = tag(text, roster, tagmap)
    assert restore(out.text, out.tag_map) == text


# ------------------------------------------------------------------ never-share topics

NEVER_SHARE = {
    "iep": ["IEP", "504 plan"],
    "medical": ["ADHD", "allergy", "speech therapy"],
    "lunch_status": ["free lunch"],
    "field_trip": ["permission slip"],
}


def test_blocked_topics_case_insensitive_and_word_bounded():
    assert blocked_topics("Her iep meeting and 504  plan", NEVER_SHARE) == ["iep"]
    assert blocked_topics("Two IEPs this year", NEVER_SHARE) == ["iep"]
    assert blocked_topics("Mr. Pieper reads; adhd notes", NEVER_SHARE) == ["medical"]
    assert blocked_topics("free lunches and speech therapy", NEVER_SHARE) == ["medical", "lunch_status"]
    assert blocked_topics("A fine essay.", NEVER_SHARE) == []
    assert blocked_topics("IEP", None) == []
    assert blocked_topics("allergy", {"medical": "allergy"}) == ["medical"]


def test_blocked_reasons_are_plain_language():
    reasons = blocked_reasons("IEP, allergy and a permission slip", NEVER_SHARE)
    assert reasons == [
        "Mentions an IEP or 504 plan",
        "Mentions health or medical details",
        "Mentions field trip",
    ]
    assert all(chr(0x2014) not in r for r in reasons)


# ------------------------------------------------------------------ speed

FIRSTS = [
    "Amara", "Dmitri", "Esme", "Farouk", "Giselle", "Hollis", "Ines", "Jovan", "Kiri", "Leander", "Mirela",
    "Nikolai", "Odette", "Pascal", "Quinlan", "Rosalind", "Soren", "Tamsin", "Ulrich", "Vesna", "Wendeline",
    "Xavi", "Yusra", "Zoltan",
]  # fmt: skip
LASTS = [
    "Achterberg", "Brannigan", "Castellanos", "Dunleavy", "Eriksdottir", "Fennimore", "Galbraith", "Hollinsby",
    "Iverholt", "Jaramillo", "Kowalchek", "Lindgren", "Montague", "Nakashima", "Oyelaran", "Pemberton",
    "Quarshie", "Ravensworth", "Szabo", "Thorvaldsen", "Underhill", "Valcourt", "Whitlock", "Yamaguchi",
]  # fmt: skip
FILLER = (
    "the a lighthouse robot would climb stairs every night and turn on the big lamp so ships do not crash "
    "on rocks it would also clean windows after storms my idea is good because the keeper could sleep "
    "through night I think we should build it together with friends at school next year"
).split()


def make_essays() -> tuple[Roster, list[str]]:
    rng = random.Random(4)
    students = tuple(
        Person(f"{f} {last}", f, last, nicknames=(f[:3],), student_id=f"S2{i:05d}")
        for i, (f, last) in enumerate(zip(FIRSTS, LASTS, strict=True))
    )
    r = Roster(teacher=Person("Odile Fenwick", "Odile", "Fenwick", role="teacher"), students=students)
    essays = []
    for s in students:
        words: list[str] = f"{s.name}'s essay.".split()
        while len(words) < 300:
            words.extend(rng.choice(FILLER) for _ in range(rng.randint(8, 14)))
            words[-1] += "."
            lead = rng.choice(
                [f"{s.first} says", f"{s.last} adds", f"{s.nicknames[0]} asks", "Ms. Fenwick asks"]
            )
            words.extend(lead.split())
        essays.append(" ".join(words[:300]))
    return r, essays


def test_tagging_24_essays_is_fast(tmp_path):
    r, essays = make_essays()
    assert len(essays) == 24 and all(len(e.split()) == 300 for e in essays)
    tm = TagMap(tmp_path / "tagmap.json", seed=9)
    started = time.perf_counter()
    outs = [tag(e, r, tm) for e in essays]
    elapsed = time.perf_counter() - started
    assert elapsed < 0.5, f"{elapsed:.3f} s"
    assert all(leaks(o.text, r, tm) == [] for o in outs)
