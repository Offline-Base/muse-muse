"""Checks on the invented demo and eval data: counts, ground truth and agreement with the policy.

The policy matcher here is a small copy of the contract (docs/CONTRACTS.md, Policy): kinds,
topics_any, topics_all and request_any (case-insensitive substrings), first match wins, else the
default. It lives in this file on purpose so the data is checked against the contract itself.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

import pytest
import yaml

from base.types import DECISIONS, RESULT_KINDS, default_share_form

ROOT = Path(__file__).resolve().parent.parent
EVAL = ROOT / "eval"
DEMO = ROOT / "demo"
PROMPT = "Should our school have a garden? Explain your opinion."

NEVER_SHARE = (
    "iep",
    "medical",
    "discipline",
    "custody",
    "immigration",
    "home_address",
    "parent_contact",
    "lunch_status",
)
PLAIN_TOPICS = (
    "grades",
    "writing",
    "reading",
    "attendance",
    "parents",
    "third_party",
    "full_text",
    "deanonymize",
    "reidentify",
)
ITEM_KEYS = {
    "id",
    "request",
    "result",
    "result_kind",
    "topics",
    "expected",
    "names",
    "identifiers",
    "tricky",
    "notes",
}
OPTIONAL_KEYS = {"summary", "other_names", "dates"}
SHARES = ("share_tagged", "share_summary")

PHONE = re.compile(r"(?:\(\d{3}\) |\d{3}[.-])?\b555[-.]\d{4}\b")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
STUDENT_ID = re.compile(r"\bS\d{6}\b")
ADDRESS = re.compile(r"\b\d{1,5} (?:[A-Z][a-z]+ )+(?:Street|Avenue|Road|Lane|Drive|Court|Way)\b")
DATE = re.compile(
    r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(?:, \d{4})?\b"
    r"|\b\d{1,2}/\d{1,2}/\d{2,4}\b"
)
IDENTIFIER_PATTERNS = (PHONE, EMAIL, STUDENT_ID, ADDRESS, DATE)
DOB_CONTEXT = re.compile(r"(?:\bborn|\bDOB|\bbirthday|\bdate of birth)\W{0,3}(?:on\s+)?$", re.IGNORECASE)


def is_dob(text: str, start: int) -> bool:
    """A date right after born, DOB, birthday or date of birth is a date of birth."""
    return bool(DOB_CONTEXT.search(text[max(0, start - 20) : start]))


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


TASKS = load_jsonl(EVAL / "tasks.jsonl")
HOLDOUT = load_jsonl(EVAL / "holdout.jsonl")
ROSTER = json.loads((EVAL / "roster.json").read_text())
POLICY = yaml.safe_load((EVAL / "user_policy.yaml").read_text())
PEOPLE = [ROSTER["teacher"], *ROSTER["students"]]
FORMS = sorted({f for p in PEOPLE for f in (p["name"], p["first"], p["last"], *p["nicknames"])})
FULL_NAMES = [p["name"] for p in PEOPLE]
ESSAY_DIR = DEMO / "essays"


def word(value: str, flags: int = 0) -> re.Pattern:
    """Whole-word match, the way the eval's leak check looks for a value."""
    return re.compile(rf"(?<!\w){re.escape(value)}(?!\w)", flags)


def osa_distance(a: str, b: str) -> int:
    """Damerau-Levenshtein distance (optimal string alignment)."""
    d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1):
        d[i][0] = i
    for j in range(len(b) + 1):
        d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[len(a)][len(b)]


def is_roster_name(value: str) -> bool:
    """A roster form, or a misspelling of one within one edit (4+ letters)."""
    low = value.casefold()
    for form in FORMS:
        if low == form.casefold():
            return True
        if len(form) >= 4 and osa_distance(low, form.casefold()) == 1:
            return True
    return False


# ----- the contract's matcher -----


def rule_matches(rule: dict, item: dict) -> bool:
    if "kinds" in rule and item["result_kind"] not in rule["kinds"]:
        return False
    topics = set(item["topics"])
    if "topics_any" in rule and not topics & set(rule["topics_any"]):
        return False
    if "topics_all" in rule and not set(rule["topics_all"]) <= topics:
        return False
    if "request_any" in rule:
        request = item["request"].casefold()
        if not any(part.casefold() in request for part in rule["request_any"]):
            return False
    return True


def winning_rule(item: dict) -> dict:
    for rule in POLICY["rules"]:
        if rule_matches(rule, item):
            return rule
    return POLICY["default"]


def label_for(approve: bool, remember: bool, result_kind: str) -> str:
    """What dreaming learns from the simulated teacher's answer (base/approvals.py label_for)."""
    if remember:
        return default_share_form(result_kind) if approve else "refuse"
    return "ask_user"


def keyword_topics(text: str) -> set[str]:
    found = set()
    for topic, words in POLICY["never_share"].items():
        if any(word(w, re.IGNORECASE).search(text) for w in words):
            found.add(topic)
    return found


def ids(items):
    return [i["id"] for i in items]


# ----- roster -----


def test_roster_shape_and_name_shapes():
    students = ROSTER["students"]
    assert len(students) == 24
    assert ROSTER["teacher"]["role"] == "teacher"
    assert all(s["role"] == "student" for s in students)
    for p in PEOPLE:
        assert p["name"] == f"{p['first']} {p['last']}"
        assert isinstance(p["nicknames"], list)
    student_ids = [s["student_id"] for s in students]
    assert len(set(student_ids)) == 24 and all(re.fullmatch(r"S\d{6}", i) for i in student_ids)
    assert len(set(FULL_NAMES)) == len(FULL_NAMES)
    firsts = Counter(s["first"] for s in students)
    assert any(n == 2 for n in firsts.values()), "two students share a first name"
    assert any("-" in s["last"] for s in students), "a hyphenated last name"
    assert any("'" in s["name"] for s in students), "an apostrophe name"
    assert any(len(s["first"]) <= 2 and len(s["last"]) <= 2 for s in students), "a very short name"
    assert any(s["first"] in {"Rose", "Hunter", "Wren", "Faith", "Hope", "Grace"} for s in students)
    assert 10 <= sum(bool(s["nicknames"]) for s in students) <= 14, "about half have nicknames"


# ----- tasks: shape and counts -----


def test_task_counts_and_ids():
    assert len(TASKS) == 100
    assert ids(TASKS) == [f"t{n:03d}" for n in range(1, 101)]
    assert Counter(i["expected"] for i in TASKS) == {d: 25 for d in DECISIONS}


@pytest.mark.parametrize("item", TASKS, ids=ids(TASKS))
def test_item_fields(item):
    keys = set(item)
    assert ITEM_KEYS <= keys <= ITEM_KEYS | OPTIONAL_KEYS
    for key in ("other_names", "dates"):
        if key in item:
            assert item[key] and all(isinstance(v, str) and v for v in item[key]), key
    assert item["result_kind"] in RESULT_KINDS
    assert item["expected"] in DECISIONS
    assert set(item["topics"]) <= set(NEVER_SHARE) | set(PLAIN_TOPICS)
    assert isinstance(item["tricky"], bool) and isinstance(item["notes"], str)
    assert 20 <= len(item["result"].split()) <= 200
    if item["result_kind"] == "class_aggregate":
        assert item.get("summary"), "every class_aggregate item carries a summary"
    else:
        assert "summary" not in item


# ----- tasks: the policy -----


@pytest.mark.parametrize("item", TASKS, ids=ids(TASKS))
def test_expected_is_what_the_policy_wants(item):
    assert winning_rule(item)["wants"] == item["expected"]


@pytest.mark.parametrize("item", TASKS, ids=ids(TASKS))
def test_simulated_answer_teaches_the_expected_label(item):
    on_ask = winning_rule(item)["on_ask"]
    assert label_for(on_ask["approve"], on_ask["remember"], item["result_kind"]) == item["expected"]


def test_policy_module_agrees_if_present():
    policy_mod = pytest.importorskip("base.policy")
    policy = policy_mod.UserPolicy.load(EVAL / "user_policy.yaml")
    for item in TASKS:
        assert policy.wants(item) == item["expected"], item["id"]


def test_policy_schema():
    assert set(POLICY) <= {"name", "never_share", "ask_first", "request_topics", "rules", "default"}
    assert set(POLICY["never_share"]) == set(NEVER_SHARE)
    assert all(POLICY["never_share"][t] for t in NEVER_SHARE)
    assert set(POLICY["ask_first"]) <= set(NEVER_SHARE)
    rule_keys = {"id", "kinds", "topics_any", "topics_all", "request_any", "wants", "pre_approved", "on_ask"}
    seen = set()
    for rule in POLICY["rules"]:
        assert set(rule) <= rule_keys and rule["id"] not in seen
        seen.add(rule["id"])
        assert rule["wants"] in DECISIONS
        assert set(rule.get("kinds", [])) <= set(RESULT_KINDS)
        topics = set(rule.get("topics_any", [])) | set(rule.get("topics_all", []))
        assert topics <= set(NEVER_SHARE) | set(PLAIN_TOPICS)
        assert set(rule["on_ask"]) == {"approve", "remember"}
        if rule.get("pre_approved"):
            assert rule["wants"] in SHARES
    assert POLICY["default"]["wants"] == "ask_user"
    pre = {r["id"] for r in POLICY["rules"] if r.get("pre_approved")}
    assert pre == {"list_documents_ok", "class_averages"}


def test_every_rule_and_the_default_is_exercised():
    winners = Counter(winning_rule(i).get("id", "default") for i in TASKS)
    assert set(winners) == {r["id"] for r in POLICY["rules"]} | {"default"}


# ----- tasks: names and identifiers ground truth -----


@pytest.mark.parametrize("item", TASKS, ids=ids(TASKS))
def test_names_ground_truth(item):
    result = item["result"]
    for name in item["names"]:
        assert word(name).search(result), f"{name!r} is not in the result"
        assert is_roster_name(name), f"{name!r} is not a roster name, nickname or one-edit misspelling"
    missing = [f for f in FORMS if word(f).search(result) and f not in item["names"]]
    assert not missing, f"roster names in the result but not in names: {missing}"


@pytest.mark.parametrize("item", TASKS, ids=ids(TASKS))
def test_identifiers_ground_truth(item):
    result = item["result"]
    for value in item["identifiers"] + item.get("dates", []):
        assert value in result
    found = {m.group(0) for rx in IDENTIFIER_PATTERNS if rx is not DATE for m in rx.finditer(result)}
    dobs = {m.group(0) for m in DATE.finditer(result) if is_dob(result, m.start())}
    plain_dates = {m.group(0) for m in DATE.finditer(result) if not is_dob(result, m.start())}
    assert found | dobs == set(item["identifiers"]), "dates of birth stay identifiers"
    assert plain_dates == set(item.get("dates", [])), "plain calendar dates go in dates, not identifiers"
    for value in found:
        if PHONE.fullmatch(value):
            assert re.search(r"555[-.]01\d\d$", value), "phones use 555-01xx"
        if EMAIL.fullmatch(value):
            assert value.endswith(("@example.com", "@example.org"))


@pytest.mark.parametrize("item", [i for i in TASKS if "other_names" in i], ids=lambda i: i["id"])
def test_other_names_are_people_off_the_roster(item):
    for name in item["other_names"]:
        assert word(name).search(item["result"]), f"{name!r} is not in the result"
        assert name not in FORMS, f"{name!r} is a roster form; it belongs in names"
        assert not word(name, re.IGNORECASE).search(item["request"])


def test_known_non_roster_people_are_listed():
    by_id = {i["id"]: i for i in TASKS}
    for item_id, name in [("t016", "Keoni"), ("t017", "Luciana"), ("t017", "Tomas"), ("t066", "Delgado"),
                          ("t076", "Pruitt"), ("t090", "Kasia"), ("t091", "Tunde"), ("t091", "Folake")]:  # fmt: skip
        assert name in by_id[item_id]["other_names"], (item_id, name)
    assert by_id["t080"]["identifiers"] == ["3/14/2017"] and "dates" not in by_id["t080"]  # a DOB


@pytest.mark.parametrize("item", TASKS, ids=ids(TASKS))
def test_request_never_contains_a_roster_name(item):
    request = item["request"]
    for full in FULL_NAMES:
        assert full.casefold() not in request.casefold()
    for form in FORMS:
        assert not word(form).search(request), f"request contains {form!r}"


@pytest.mark.parametrize("item", TASKS, ids=ids(TASKS))
def test_never_share_keywords_agree_with_topics(item):
    found = keyword_topics(item["result"])
    assert found <= set(item["topics"]), f"keywords for {found - set(item['topics'])} but topic missing"
    if not item["tricky"]:
        assert set(item["topics"]) & set(NEVER_SHARE) <= found, "non-tricky items name their topic"


@pytest.mark.parametrize("item", [i for i in TASKS if i["expected"] in SHARES], ids=lambda i: i["id"])
def test_share_items_hold_nothing_a_floor_would_stop(item):
    assert item["identifiers"] == []
    assert not set(item["topics"]) & set(NEVER_SHARE)
    for form in FORMS:  # roster words appear only as names, never as ordinary lowercase words
        for m in word(form, re.IGNORECASE).finditer(item["result"]):
            assert m.group(0) == form, f"{m.group(0)!r} looks like the name {form!r}"


@pytest.mark.parametrize(
    "item", [i for i in TASKS if i["expected"] == "share_summary"], ids=lambda i: i["id"]
)
def test_share_summary_items(item):
    assert item["result_kind"] == "class_aggregate"
    summary = item["summary"]
    for form in FORMS:
        assert not word(form, re.IGNORECASE).search(summary), f"summary contains {form!r}"
    for name in item["names"]:
        assert not word(name, re.IGNORECASE).search(summary)
    assert not any(rx.search(summary) for rx in IDENTIFIER_PATTERNS)


def test_tricky_cases_are_present():
    by_id = {i["id"]: i for i in TASKS}
    assert by_id["t008"]["names"] == ["Dash"]  # nickname only
    assert "her 504" in by_id["t077"]["result"] and not keyword_topics(by_id["t077"]["result"])
    assert by_id["t092"]["expected"] == "refuse" and PHONE.search(by_id["t092"]["summary"])
    assert "full name" in by_id["t097"]["request"]
    assert "Ohio" in by_id["t099"]["request"] and "wheelchair" in by_id["t099"]["request"]
    assert "Only one student" in by_id["t100"]["result"]
    assert any(not any(f.casefold() == n.casefold() for f in FORMS) for i in TASKS for n in i["names"])
    assert sum(i["tricky"] for i in TASKS) >= 25


@pytest.mark.parametrize("item", [i for i in TASKS if i["result_kind"] == "snippet"], ids=lambda i: i["id"])
def test_snippets_quote_the_essays(item):
    lines = [line for line in item["result"].splitlines() if line.strip()]
    assert lines
    for line in lines:
        m = re.fullmatch(r'(.+)\.md: "(.+)"', line)
        assert m, line
        essay = (ESSAY_DIR / f"{m.group(1)}.md").read_text()
        assert m.group(2) in essay


# ----- holdout -----


def test_holdout_is_a_balanced_copy():
    by_id = {i["id"]: i for i in TASKS}
    assert len(HOLDOUT) == 20
    assert len(set(ids(HOLDOUT))) == 20
    for item in HOLDOUT:
        assert by_id[item["id"]] == item
    assert Counter(i["expected"] for i in HOLDOUT) == {d: 5 for d in DECISIONS}
    assert len({i["result_kind"] for i in HOLDOUT}) >= 6
    # Review eval F4: a shared item that names someone off the roster, so the gate can catch a
    # non-roster name leak, not only roster names.
    assert any(i.get("other_names") and i["expected"] != "refuse" for i in HOLDOUT)


# ----- demo files -----


def test_every_essay_maps_to_one_roster_student():
    files = sorted(ESSAY_DIR.glob("*.md"))
    students = sorted(s["name"] for s in ROSTER["students"])
    assert sorted(f.stem for f in files) == students
    for f in files:
        title, blank, *body = f.read_text().splitlines()
        assert title == f"# {f.stem}: {PROMPT}"
        assert blank == ""
        assert 150 <= len(" ".join(body).split()) <= 300, f.name


def test_records_and_rubric():
    names = {p.name for p in (DEMO / "records").glob("*.md")}
    assert names == {
        "parent_contacts.md", "iep_504_notes.md", "attendance.md", "reading_groups.md",
        "behavior_log.md", "lunch_status.md", "health_office.md",
    }  # fmt: skip
    contacts = (DEMO / "records" / "parent_contacts.md").read_text()
    for s in ROSTER["students"]:
        assert s["name"] in contacts and s["student_id"] in contacts
    for path in (DEMO / "records").glob("*.md"):
        text = path.read_text()
        assert all(re.fullmatch(r"555-01\d\d", p) for p in re.findall(r"\b555-\d{4}\b", text))
        assert all(e.endswith(("@example.com", "@example.org")) for e in EMAIL.findall(text))
    rubric = (DEMO / "rubric.md").read_text()
    for criterion in ("Ideas", "Organization", "Evidence and details", "Conventions"):
        assert f"## {criterion}" in rubric
    assert rubric.count("| 4 |") == rubric.count("| 1 |") == 4


CASEWORK = DEMO / "casework"
CASE_NUMBER = re.compile(r"\b000-\d{4}-\d{4}\b")


def test_casework_is_an_invented_cui_folder():
    # Scene F (MUSE-13): an invented office's case notes, marked CUI by its invented agreement.
    files = sorted(CASEWORK.glob("*.md"))
    assert len(files) == 6
    roster_forms = [f for f in FORMS if len(f) >= 4]
    for path in files:
        text = path.read_text()
        lines = text.strip().splitlines()
        assert lines[0] == "CUI" and lines[-1] == "CUI", path.name  # the banner, top and bottom
        assert "(invented)" in lines[2] and "Example City Housing Assistance Office (invented)" in text
        assert all(re.fullmatch(r"555-01\d\d", p) for p in re.findall(r"\b555-\d{4}\b", text))
        assert all(e.endswith(("@example.com", "@example.org")) for e in EMAIL.findall(text))
        assert CASE_NUMBER.search(text), path.name  # invented case numbers, 000- first
        assert not re.search(r"\b\d{3}-\d{2}-\d{4}\b", text)  # nothing shaped like an SSN
        assert not [f for f in roster_forms if re.search(rf"(?<!\w){re.escape(f)}(?!\w)", text)], path.name
        assert 100 <= len(text.split()) <= 250
    assert not (CASEWORK / ".synthetic").exists()  # demo/.synthetic above it covers the folder


def test_demo_is_marked_and_explained():
    assert (DEMO / ".synthetic").is_file()
    readme = (DEMO / "README.md").read_text()
    assert ".synthetic" in readme and "invented" in readme


def test_seed_requests_cover_every_item_once():
    text = (EVAL / "seed_requests.md").read_text()
    assert len(re.findall(r"^## \d+\. ", text, flags=re.MULTILINE)) == 30
    grew = [
        t for line in re.findall(r"^Grew into: (.+)$", text, flags=re.MULTILINE) for t in line.split(", ")
    ]
    assert sorted(grew) == ids(TASKS)


def test_no_em_dashes_in_the_data():
    paths = [
        EVAL / "roster.json", EVAL / "tasks.jsonl", EVAL / "holdout.jsonl", EVAL / "user_policy.yaml",
        EVAL / "seed_requests.md", EVAL / "DATASET.md", DEMO / "README.md", DEMO / "rubric.md",
        *ESSAY_DIR.glob("*.md"), *(DEMO / "records").glob("*.md"), *(DEMO / "casework").glob("*.md"),
    ]  # fmt: skip
    for path in paths:
        assert "—" not in path.read_text(), path.name
