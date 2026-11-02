"""scripts/simulate_policy.py on a tiny invented set with a known diff. No model runs.

Every request, result and policy here is invented. The items name nobody, so the null name pass
(no names found) has nothing to miss.
"""

from __future__ import annotations

import json

import pytest

from scripts import simulate_policy as sim

CURRENT = """\
name: Current (invented)
never_share:
  iep: ["IEP", "504 plan"]
rules:
  - id: no_iep
    topics_any: [iep]
    wants: refuse
  - id: tagged_grades
    kinds: [per_student, snippet, free_text]
    topics_any: [grades]
    wants: share_tagged
default: {wants: ask_user}
"""

# Adds a never-share topic (field trips) and shares what is left without asking.
PROPOSED = """\
name: Proposed (invented)
mode: observe
never_share:
  iep: ["IEP", "504 plan"]
  trips: ["field trip"]
rules:
  - id: no_iep_or_trips
    topics_any: [iep, trips]
    wants: refuse
  - id: tagged_grades
    kinds: [per_student, snippet, free_text]
    topics_any: [grades]
    wants: share_tagged
default: {wants: share_tagged}
"""

ITEMS = [
    # Graded feedback: tagged_grades shares it under both policies.
    {"id": "inv-1", "request": "What score did [Student A] get on the quiz?",
     "result": "[Student A] scored 7 out of 10 on the quiz.", "result_kind": "free_text", "expected": "share_tagged"},
    # Nothing matches: the current default asks, the proposed default shares.
    {"id": "inv-2", "request": "Which books are on the shelf this week?",
     "result": "Three picture books and one atlas are on the shelf.", "result_kind": "free_text",
     "expected": "ask_user"},
    # A field trip note: the current default asks, the proposed never-share topic refuses.
    {"id": "inv-3", "request": "What is planned for Friday?",
     "result": "The field trip to the science museum leaves at nine.", "result_kind": "free_text",
     "expected": "ask_user"},
    # An IEP mention: refused under both.
    {"id": "inv-4", "request": "Any notes for Monday?",
     "result": "Check the IEP binder before the meeting.", "result_kind": "free_text", "expected": "refuse"},
]  # fmt: skip

KNOWN = {"inv-1": "same", "inv-2": "now_allowed", "inv-3": "now_blocked", "inv-4": "same"}


@pytest.fixture
def files(tmp_path):
    cur, new, items = tmp_path / "current.yaml", tmp_path / "proposed.yaml", tmp_path / "tiny.jsonl"
    cur.write_text(CURRENT)
    new.write_text(PROPOSED)
    items.write_text("".join(json.dumps(i) + "\n" for i in ITEMS))
    return cur, new, items


def test_the_tiny_set_gives_the_known_diff(files):
    cur, new, _ = files
    diffs = sim.simulate(ITEMS, cur, new)
    assert {d.id: d.kind for d in diffs} == KNOWN
    by_id = {d.id: d for d in diffs}
    assert (by_id["inv-2"].current.outcome, by_id["inv-2"].proposed.outcome) == ("ask", "allow")
    assert (by_id["inv-3"].current.outcome, by_id["inv-3"].proposed.outcome) == ("ask", "block")
    assert by_id["inv-3"].proposed.code.startswith("blocked:trips")
    t = sim.totals(diffs)
    assert t["changed"] == 2 and t["looser"] == 1 and t["stricter"] == 1
    assert t["current"] == {"allow": 1, "ask": 2, "block": 1}
    assert t["proposed"] == {"allow": 2, "ask": 0, "block": 2}
    assert t["leaks_current"] == t["leaks_proposed"] == 0


def test_a_policy_against_itself_changes_nothing(files):
    cur, _, _ = files
    diffs = sim.simulate(ITEMS, cur, cur)
    assert all(d.kind == "same" for d in diffs)


def test_redacted_differently_is_a_share_with_another_text():
    same = sim.Outcome("allow", "share_tagged", "x", "aaa")
    other = sim.Outcome("allow", "share_summary", "x", "bbb")
    assert sim.ItemDiff("i", same, other).kind == "redacted_differently"
    assert sim.ItemDiff("i", same, other).direction == "same"
    held = sim.Outcome("block", "refuse", "a", "ccc")
    assert sim.ItemDiff("i", held, sim.Outcome("block", "refuse", "b", "ccc")).kind == "reason_changed"


def test_the_cli_writes_a_report_with_no_item_text(files, tmp_path, capsys):
    cur, new, items = files
    out = tmp_path / "report.md"
    assert sim.main(["--proposed", str(new), "--current", str(cur), "--set", str(items), "--out", str(out)]) == 0
    report = out.read_text()
    assert "2 of 4 items change: 1 now allowed, 0 now ask, 1 now blocked" in report
    assert "| inv-3 | now_blocked | ask (ask_user) | block (refuse) |" in report
    assert "Simulated" in report and chr(0x2014) not in report
    for item in ITEMS:  # ids and codes only, never what the item says
        assert item["result"] not in report and item["request"] not in report
    assert "2 of 4 items change" in capsys.readouterr().out


def test_the_cli_refuses_a_sealed_set(files, tmp_path):
    cur, new, _ = files
    sealed = tmp_path / "fresh_200_c.jsonl"
    sealed.write_text("")
    with pytest.raises(SystemExit):
        sim.main(["--proposed", str(new), "--current", str(cur), "--set", str(sealed)])
