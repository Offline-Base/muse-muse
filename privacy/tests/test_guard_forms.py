"""Name and identifier forms the review found slipping past the guard (privacy F1, F4, F6, F7, F8).

Every value here is invented. The roster is eval/roster.json.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from base import guard
from base.guard import TagMap, blocked_topics, find_identifiers, leaks, load_roster, long_digit_runs, tag

ROSTER = load_roster(Path(__file__).resolve().parents[1] / "eval" / "roster.json")
NEVER = {"iep": ["IEP", "504 plan"], "custody": ["custody"], "medical": ["ADHD", "medication", "asthma"]}


def tagged(text: str, llm_names=None) -> str:
    return tag(text, ROSTER, TagMap(None, seed=3), llm_names=llm_names, never_share=NEVER).text


@pytest.mark.parametrize(
    ("path", "topic"),
    [
        ("records/camila_iep_goals.md", "iep"),
        ("records/farhan_custody_order.md", "custody"),
        ("records/hana_adhd_medication.md", "medical"),
        ("records/IEP2.md", "iep"),
    ],
)
def test_snake_case_paths_show_never_share_topics(path, topic):
    assert topic in blocked_topics(path, NEVER)


def test_snake_case_and_slug_names_are_tagged():
    out = tagged("- Draft 2 (essays/camila_restrepo_draft2.md)\n- Goals (records/camila_iep_goals.md)")
    assert "camila" not in out.lower() and "restrepo" not in out.lower()
    assert out.count("[Student ") == 2


def test_lowercase_surnames_and_unicode_tricks_are_tagged():
    text = (
        "Scores: camila_restrepo 3, kowalczyk 2, Esper­anza 4, Far​han 3, "
        "Ellings-\nworth 2, Jasper Ellings- worth 3, Ｋｅｔｕｒａｈ 4, Tessa OʼCallan 1."
    )
    out = tagged(text)
    for leaked in ("restrepo", "kowalczyk", "anza", "han 3", "worth", "Ｋ", "Callan"):
        assert leaked not in out, leaked
    assert leaks(out, ROSTER, TagMap(None, seed=3)) == []


def test_identifiers_with_unicode_dashes_dots_and_labels():
    text = (
        "Guardian cell 512‑555‑0143. SSN: 900–12–3456. ITIN on file as 912701234. "
        "Card 4111.1111.1111.1111. Student no. S-401127. Reach her at maya＠example.org. "
        "Mailing: 42 oak lane apt 3."
    )
    kinds = {h.kind for h in find_identifiers(text, ROSTER)}
    assert {"phone", "ssn", "card", "student_id", "email", "address"} <= kinds
    out = tagged(text)
    for raw in ("0143", "3456", "912701234", "1111", "401127", "example.org", "oak lane"):
        assert raw not in out, raw


def test_lowercase_address_needs_a_real_street():
    assert not find_identifiers("I ran 5 miles down the road.")
    assert not find_identifiers("Tenths: 17 mastered tenths place value.")


def test_long_digit_runs_skip_dates_and_scores():
    assert long_digit_runs("Locker combo 4417302 on file") == ["4417302"]
    assert long_digit_runs("Case 12-345-678 opened") == ["12-345-678"]
    assert long_digit_runs("Due 2026-10-27, scores 3 3 2 3 11, page 1050") == []


def test_leak_check_spells_out_encoded_full_names():
    text = "opertseR alimaC | C-a-m-i-l-a-/-R-e-s-t-r-e-p-o | CAMILARESTREPO"
    hits = leaks(text, ROSTER, TagMap(None, seed=3))
    assert len(hits) >= 3
    assert {h.kind for h in hits} == {"student"}


def test_leak_check_ignores_tags_and_short_names():
    tm = TagMap(None, seed=3)
    tm.ensure_roster(ROSTER)
    # "Ty Vo" is too short to look for inside other words; tags never count.
    assert leaks("[Student A] [Student B] typed vocabulary words", ROSTER, tm) == []


def test_model_names_survive_lowercase_and_common_word_filters():
    text = (
        "Her brother Mason was picked up early by Grace. Ms. O’Donnell from the district phoned. "
        "spoke with margarita ruiz today. Taylor drove them home. The mason jar stayed."
    )
    names = ["Mason", "Grace", "Ms. O'Donnell", "margarita ruiz", "Taylor", "the"]
    out = tagged(text, llm_names=lambda _t: names)
    for leaked in ("Mason was", "Grace", "Donnell", "margarita", "Taylor"):
        assert leaked not in out, leaked
    assert "The mason jar" in out  # the word, lowercase, is left alone
    assert out.startswith("Her brother")  # a function word the model listed is ignored


def test_name_occurs_allows_apostrophe_and_space_differences():
    assert guard.name_occurs("Ms. O'Donnell", "Ms. O’Donnell called")
    assert guard.name_occurs("Hunter Price", "met Hunter Price")
    assert guard.name_occurs("Hunter Price", "met Hunter\nPrice")
    assert not guard.name_occurs("Invented Person", "nobody here")
