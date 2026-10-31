"""scripts/ask_causes.py: approval requests counted by the router's reason code. Invented ids only."""

import json

import pytest

from scripts import ask_causes


def row(id, expected, decision, code="", **kw):
    return {"id": id, "expected": expected, "wants": expected, "decision": decision, "code": code, **kw}


ROWS = [
    row("d1", "share_tagged", "ask_user", "unknown_person_title"),
    row("d2", "share_tagged", "ask_user", "unknown_person_title"),
    row("s1", "share_summary", "ask_user", "policy_default"),
    row("s2", "share_tagged", "ask_user", "policy_default"),
    row("o1", "share_summary", "ask_user", "outside_class"),
    row("r1", "refuse", "ask_user", "identifier:phone"),
    row("w1", "ask_user", "ask_user", "policy_default"),
    row("w2", "ask_user", "ask_user", "outside_class"),
    row("m1", "ask_user", "share_tagged", "policy_rule:tagged_grades_and_excerpts"),  # a missed ask
    row("x1", "refuse", "share_tagged", "learned:share_tagged"),  # a refusal shared
    row("f1", "share_tagged", "ask_user", "", fallback=True),  # an older fallback row
    row("o2", "share_tagged", "ask_user"),  # an older row with no code
    row("ok", "share_tagged", "share_tagged", "pre_approved"),
    row("e1", "share_tagged", "error", "error"),
]
ITEMS = [
    {"id": "d1", "request": "list the essays", "result_kind": "document_list"},
    {"id": "d2", "request": "list the essays", "result_kind": "document_list"},
    {"id": "s1", "request": "class numbers", "result_kind": "class_aggregate"},
    {"id": "s2", "request": "notes", "result_kind": "per_student"},
    {"id": "o1", "request": "for the newsletter", "result_kind": "class_aggregate"},
    {"id": "r1", "request": "pickup", "result_kind": "contact_info"},
]


def test_needless_buckets_add_up_to_the_needless_asks():
    c = ask_causes.count(ROWS)
    assert (c.n, c.asks, c.wanted, c.needless) == (14, 10, 2, 8)
    assert sum(c.needless_by.values()) == c.needless
    assert c.needless_by[("unknown_person_title", "share_tagged")] == 2
    assert c.needless_by[("policy_default", "share_summary")] == 1 and c.needless_by[("policy_default", "share_tagged")] == 1
    assert c.needless_by[("identifier:phone", "refuse")] == 1
    assert c.needless_by[("fallback", "share_tagged")] == 1 and c.needless_by[(ask_causes.NOT_RECORDED, "share_tagged")] == 1
    assert c.wanted_by == {"policy_default": 1, "outside_class": 1}
    assert (c.missed_asks, c.refuse_shared) == (1, 1)


def test_items_add_the_kind_the_connector_sends():
    c = ask_causes.count(ROWS, ask_causes.production_kinds(ITEMS))
    assert c.needless_kinds[("unknown_person_title", "document_list")] == 2
    assert c.needless_kinds[("policy_default", "free_text")] == 2  # class_aggregate and per_student without a grading word
    assert c.needless_kinds[("identifier:phone", "snippet")] == 1
    assert c.not_in_set == 2  # f1 and o2 are not in the item set
    assert sum(c.needless_kinds.values()) == c.needless


def test_report_has_the_command_counts_and_no_text(tmp_path):
    raw = tmp_path / "raw" / "dev_run.jsonl"
    raw.parent.mkdir()
    raw.write_text("".join(json.dumps(r) + "\n" for r in ROWS))
    items = tmp_path / "items.jsonl"
    items.write_text("".join(json.dumps(i | {"result": "Zirconia Vosberg wrote this."}) + "\n" for i in ITEMS))
    out = tmp_path / "reports"
    assert ask_causes.main(["--raw", str(raw), "--set", str(items), "--out", str(out)]) == 0

    md = (out / "ask_causes_dev_run.md").read_text()
    lines = md.splitlines()
    assert lines[0] == "# Why the router asked: dev_run"
    assert lines[2].startswith("Command: `uv run python -m scripts.ask_causes --raw ")
    assert "| Needless (expected anything else) | 8 |" in md and "| Missed asks (expected ask_user, shared) | 1 |" in md
    assert "| Code | share_tagged | share_summary | refuse | Total |" in md
    assert "| unknown_person_title | 2 | 0 | 0 | 2 |" in md
    assert "| Total | 5 | 2 | 1 | 8 |" in md
    assert "| Total | 2 |" in md  # wanted
    assert "| identifier:phone | the result or the request holds an identifier" in md
    assert "Zirconia" not in md and "pickup" not in md and "newsletter" not in md and "—" not in md


def test_bad_arguments_are_refused(tmp_path):
    with pytest.raises(SystemExit):
        ask_causes.main(["--raw", str(tmp_path / "missing.jsonl")])
    raw = tmp_path / "r.jsonl"
    raw.write_text("")
    with pytest.raises(SystemExit):
        ask_causes.main(["--raw", str(raw), "--name", "../escape"])
    assert ask_causes.main(["--raw", str(raw), "--out", str(tmp_path)]) == 0
    assert "| Approval requests | 0 |" in (tmp_path / "ask_causes_r.md").read_text()
