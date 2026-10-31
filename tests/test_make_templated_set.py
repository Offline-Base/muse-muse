"""scripts/make_templated_set.py and eval/templated/: the model-free, unsealed test set.

These tests are the only code that opens eval/templated/fresh_200_t.jsonl. They check counts and
rules, never print item text.
"""

import builtins
import hashlib
import re
from collections import Counter
from pathlib import Path

import pytest
import respx

from base.config import REPO_ROOT
from scripts import make_synthetic as ms
from scripts import make_templated_set as mt

EVAL = REPO_ROOT / "eval"
OTHER_SETS = (
    "compliance.jsonl",
    "fresh_200.jsonl",
    "fresh_200_b.jsonl",
    "holdout.jsonl",
    "synthetic.jsonl",
    "tasks.jsonl",
)


@pytest.fixture(scope="module")
def checker():
    return mt.load_checker()


@pytest.fixture(scope="module")
def items():
    return ms.load_jsonl(mt.OUT)


@pytest.fixture(scope="module")
def overlap(items):
    return mt.overlap_table(items)


def cells(items):
    return Counter((i["expected"], i["result_kind"]) for i in items)


# the build


def test_the_file_is_what_the_seed_builds(checker):
    assert mt.render_jsonl(mt.build_items(mt.SEED, checker)) == mt.OUT.read_text()


def test_the_build_is_deterministic_and_seeded(checker):
    a, b, c = (mt.build_items(seed, checker) for seed in (5, 5, 6))
    assert a == b
    assert a != c
    assert cells(a) == cells(c) == Counter(mt.PLAN)


def test_the_build_reads_no_eval_set_and_calls_no_model(checker, monkeypatch):
    def refuse_jsonl(path):
        if str(path).endswith(".jsonl"):
            raise AssertionError(f"the build opened {Path(path).name}")

    real_open, real_read = builtins.open, Path.read_text
    monkeypatch.setattr(builtins, "open", lambda f, *a, **k: refuse_jsonl(f) or real_open(f, *a, **k))
    monkeypatch.setattr(
        Path, "read_text", lambda self, *a, **k: refuse_jsonl(self) or real_read(self, *a, **k)
    )
    with respx.mock(assert_all_called=False) as router:  # any HTTP request would fail as unmocked
        built = mt.build_items(mt.SEED, checker)
    assert router.calls.call_count == 0
    assert len(built) == sum(mt.PLAN.values())


def test_a_template_the_policy_labels_differently_is_refused(checker, monkeypatch):
    cell = ("ask_user", "free_text")
    wrong = mt.Template("Sum up how {A} did on the {proj}.", "{n1} earned {s1} of {max}.", ("grades",))
    monkeypatch.setitem(mt.TEMPLATES, cell, (wrong,))
    with pytest.raises(ValueError, match="labels as share_tagged"):
        mt.build_items(mt.SEED, checker)


def test_a_template_with_an_unlisted_keyword_topic_is_refused(checker, monkeypatch):
    cell = ("share_tagged", "free_text")
    wrong = mt.Template(
        "Sum up how {A} did on the {proj}.", "{n1} has asthma and earned {s1} of {max}.", ("grades",)
    )
    monkeypatch.setitem(mt.TEMPLATES, cell, (wrong,))
    with pytest.raises(ValueError, match="fails"):
        mt.build_items(mt.SEED, checker)


def test_names_in_lists_each_form_once_in_order():
    forms = ["Ilse Druvaley", "Ilse", "Fola", "Radek Druvaley"]
    text = "Fola met Ilse Druvaley's guardian, Radek Druvaley. Ilse waved."
    assert mt.names_in(text, forms) == ["Fola", "Ilse Druvaley", "Radek Druvaley", "Ilse"]
    assert mt.names_in("Ilsewhere", forms) == []


def test_misspell_drops_one_letter():
    for _, last, _ in mt.STUDENTS:
        wrong = mt.misspell(last)
        assert len(wrong) == len(last) - 1 and wrong != last
    assert mt.misspell("Zarvinek") == "Zarvnek"


# the written set


def test_counts_match_fresh_200_b(items):
    assert sum(mt.PLAN.values()) == len(items) == 200
    assert cells(items) == cells(ms.load_jsonl(EVAL / "fresh_200_b.jsonl")) == Counter(mt.PLAN)


def test_every_check_passes(items, checker):
    failed = [name for name, ok, _ in mt.check_set(items, checker) if not ok]
    assert failed == []


def test_expected_is_what_the_policy_wants(items, checker):
    assert all(checker.policy.wants(i) == i["expected"] for i in items)


def test_item_fields_match_the_other_sets(items):
    shape = list(ms.load_jsonl(EVAL / "fresh_200_b.jsonl")[0])
    assert all(list(i) == shape for i in items)
    assert {i["source"] for i in items} == {"template"}
    assert all(re.fullmatch(r"tpl-\d{3}", i["id"]) for i in items)


def test_identifiers_use_only_the_fake_ranges(items):
    text = "\n".join(f"{i['request']}\n{i['result']}" for i in items)
    phones = list(ms.PHONE_RE.finditer(text))
    emails = list(ms.EMAIL_RE.finditer(text))
    ssns = list(ms.SSN_RE.finditer(text))
    assert phones and emails and ssns
    assert all(m.group(2) == "555" and m.group(3).startswith("01") for m in phones)
    assert all(m.group(1).lower() in ("example.com", "example.org") for m in emails)
    assert all(m.group(1).startswith("9") or m.group(1) == "000" for m in ssns)
    assert not ms.CARD_RE.search(text)
    assert all(not i["identifiers"] for i in items if i["expected"] != "refuse")


# overlap and the roster


def test_zero_overlap_with_every_other_eval_set(overlap):
    assert {f"eval/{name}" for name in OTHER_SETS} <= set(overlap)
    assert not any(path.startswith("eval/templated") for path in overlap)
    assert {path: mt.hits(c) for path, c in overlap.items() if mt.hits(c)} == {}
    assert all(c["closest_jaccard"] < mt.NEAR_JACCARD for c in overlap.values())


def test_overlap_counts_find_planted_hits():
    ref = [
        {
            "id": "syn-0001",
            "request": "Give the rubric scores for [Student C] on the fractions quiz, please, before lunch today.",
            "result": "Corvin Ashdale scored three, four and three on the fractions quiz rubric with neat careful work.",
            "identifiers": ["(555) 555-0101"],
        }
    ]
    exact = {**ref[0], "id": "tpl-001"}
    near = {
        "id": "syn-0001",
        "request": "Give the rubric scores for [Student D] on the fractions quiz, please, before lunch today.",
        # Jaccard 0.58 with the reference result, but 5 of its 9 8-word runs are in it
        "result": "Corvin Ashdale scored three, four and three on the fractions quiz rubric, then sang about owls.",
        "identifiers": [],
    }
    far = {"id": "tpl-003", "request": "List the kite files.", "result": "Kite Plan", "identifiers": []}
    counts = mt.overlap_counts([exact, near, far], ref)
    assert {k: counts[k] for k in mt.HIT_KEYS} == {
        "exact_request": 1,
        "exact_result": 1,
        "exact_pair": 1,
        "near_request": 2,
        "near_result": 2,
        "identifier": 1,
        "id": 1,
    }


def test_the_roster_is_new():
    files = mt.roster_files()
    names = {str(p.relative_to(REPO_ROOT)) for p in files}
    assert {
        "eval/roster.json",
        "eval/synthetic.jsonl",
        "eval/fresh_200_b.jsonl",
        "tests/fixtures/guard_roster.json",
    } <= names
    assert any(n.startswith("demo/essays/") for n in names)
    tokens = mt.roster_name_tokens()
    assert len(tokens) > 100
    assert mt.roster_collisions(tokens, files) == {}
    assert not tokens & ms.roster_tokens(EVAL / "roster.json")


def test_roster_collisions_find_a_planted_name():
    hit = mt.roster_collisions({"fairbrook", "zarvinek"}, mt.roster_files())
    assert hit and all(n >= 1 for n in hit.values())


def test_every_roster_form_is_used_and_new_to_the_guard(checker, items):
    text = "\n".join(i["result"] for i in items)
    assert sum(first in text for first, _, _ in mt.STUDENTS) >= 40
    for first, last, nick in mt.STUDENTS:
        assert not checker.guard.names(f"{first} {last} {mt.misspell(last)} {nick or ''}")


# the manifest


def test_manifest_records_the_file_and_stays_unsealed(items):
    text = mt.MANIFEST.read_text()
    digest = hashlib.sha256(mt.OUT.read_bytes()).hexdigest()
    assert f"| sha256 | `{digest}` |" in text
    assert "**Status: UNSEALED.**" in text and "SEALED with the date" in text
    assert f"| Seed | {mt.SEED} |" in text
    assert f"`{mt.COMMAND}`" in text and f"`{mt.CHECK_COMMAND}`" in text
    for (decision, kind), n in mt.PLAN.items():
        assert f"| {decision} | {kind} | {n} |" in text
    assert "FAIL" not in text
    assert "/Users/" not in text and "—" not in text


def test_check_command_passes_and_writes_nothing(capsys):
    before = mt.OUT.read_bytes(), mt.MANIFEST.read_bytes()
    assert mt.main(["--check"]) == 0
    assert (mt.OUT.read_bytes(), mt.MANIFEST.read_bytes()) == before
    out = capsys.readouterr().out
    assert "FAIL" not in out
    assert not any(first in out for first, _, _ in mt.STUDENTS)  # counts only, no item text
