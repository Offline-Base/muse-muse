"""Dreaming: dataset, prompt and LoRA training, the gate and the night runner. All data is invented."""

import json
import sqlite3
import sys
import threading
import time
import types
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from base import events
from base.dreaming import dataset, gate, night, train
from base.dreaming.dataset import Example
from base.policy import UserPolicy
from base.types import default_share_form
from eval import run_eval
from eval.run_eval import EvalReport


def contract_label_for(row):
    """label_for as docs/CONTRACTS.md states it, used until base/approvals.py exists."""
    if row.get("remember"):
        return row["shown_form"] if row["user_decision"] == "approve" else "refuse"
    return "ask_user"


@pytest.fixture(autouse=True)
def approvals_module(monkeypatch):
    try:
        import base.approvals  # noqa: F401  the real one, once it is written
    except Exception:
        fake = types.ModuleType("base.approvals")
        fake.label_for = contract_label_for
        monkeypatch.setitem(sys.modules, "base.approvals", fake)


def row(id, kind, topics, decision, remember, *, item_id=None, deleted=0, decided_by="user"):
    return {
        "id": id, "ts": 0.0, "day": 1, "job_id": None, "tool": "get_result",
        "request": f"request {id}", "result_kind": kind, "topics": json.dumps(list(topics)),
        "tagged_text": f"[Student A] text {id}", "shown_form": default_share_form(kind),
        "router_decision": "ask_user", "router_reason": "test", "router_source": "model",
        "status": {"approve": "approved", "deny": "denied", None: "pending"}[decision],
        "user_decision": decision, "remember": int(remember), "decided_by": decided_by,
        "decided_at": 0.0, "deleted": deleted, "item_id": item_id,
    }  # fmt: skip


class FakeStore:
    """Returns every row, so the dataset's own filters are what the tests check."""

    def __init__(self, rows):
        self.rows = rows

    def training_rows(self):
        return [dict(r) for r in self.rows]


def ex(kind, topics, label, *, approved=None, remember=None, source="user"):
    weight = dataset.USER_WEIGHT if source == "user" else dataset.SYNTHETIC_WEIGHT
    return Example(
        "req", kind, "[Student A] text", label, weight, tuple(sorted(topics)), source, approved, remember
    )


# ----- dataset -----


def test_dataset_labels_weights_and_exclusions(tmp_path):
    store = FakeStore([
        row(1, "per_student", ["grades"], "approve", True),
        row(2, "class_aggregate", ["grades"], "approve", True, decided_by="policy_sim"),
        row(3, "sensitive_record", ["iep"], "deny", True),
        row(4, "contact_info", ["parent_contact"], "approve", False),
        row(5, "contact_info", ["parent_contact"], "deny", False),
        row(6, "per_student", ["grades"], "approve", True, deleted=1),
        row(7, "per_student", ["grades"], "approve", True, item_id="t-holdout"),
        row(8, "per_student", ["grades"], None, False),
    ])  # fmt: skip
    synthetic = tmp_path / "synthetic.jsonl"
    synthetic.write_text(
        json.dumps({"id": "s1", "request": "list grades", "result": "Quilla Varnot got 3, call 512-555-0199",
                    "result_kind": "per_student", "topics": ["grades"], "expected": "share_tagged",
                    "names": ["Quilla Varnot"], "identifiers": ["512-555-0199"]}) + "\n"
        + json.dumps({"id": "t-holdout", "request": "x", "result": "y", "result_kind": "snippet",
                      "topics": [], "expected": "refuse", "names": [], "identifiers": []}) + "\n"
    )  # fmt: skip

    examples = dataset.build(store, synthetic, {"t-holdout"})
    user = [e for e in examples if e.source == "user"]
    assert [e.row_id for e in user] == ["1", "2", "3", "4", "5"]
    assert [e.label for e in user] == ["share_tagged", "share_summary", "refuse", "ask_user", "ask_user"]
    assert {e.weight for e in user} == {3}
    assert user[0].topics == ("grades",) and user[0].approved and user[0].remember
    assert user[4].approved is False and user[4].remember is False

    synth = [e for e in examples if e.source == "synthetic"]
    assert len(synth) == 1 and synth[0].weight == 1 and synth[0].label == "share_tagged"
    assert "Quilla" not in synth[0].tagged_text and "555-0199" not in synth[0].tagged_text
    assert synth[0].tagged_text == "[Student A] got 3, call [ID 1]"


def test_dataset_without_synthetic_file(tmp_path):
    examples = dataset.build(FakeStore([row(1, "snippet", [], "deny", True)]), tmp_path / "missing.jsonl", [])
    assert [(e.label, e.source) for e in examples] == [("refuse", "user")]


def test_parse_topics_accepts_json_lists_and_commas():
    assert dataset.parse_topics('["writing", "grades"]') == ("grades", "writing")
    assert dataset.parse_topics("iep, medical") == ("iep", "medical")
    assert dataset.parse_topics(["b", "a", "a"]) == ("a", "b")
    assert dataset.parse_topics(None) == () and dataset.parse_topics("") == ()


# ----- prompt training -----


def fixture_log():
    examples = [ex("per_student", ["grades", "writing"], "share_tagged", approved=True, remember=True)] * 6
    examples += [ex("sensitive_record", ["iep"], "refuse", approved=False, remember=True)] * 3
    examples += [ex("contact_info", ["parent_contact"], "ask_user", approved=True, remember=False)] * 4
    examples += [ex("contact_info", ["parent_contact"], "share_tagged", approved=True, remember=True)]
    examples += [ex("snippet", [], "share_tagged", approved=True, remember=True)]  # only 1 decision
    examples += [ex("free_text", ["grades"], "share_tagged", approved=True, remember=True)] * 3
    examples += [ex("free_text", ["grades"], "refuse", approved=False, remember=True)] * 2  # 60% agree
    examples += [ex("class_aggregate", ["grades"], "share_summary", source="synthetic")] * 3
    examples += [ex("per_student", ["grades", "writing"], "refuse", source="synthetic")] * 4  # user decided
    examples += [ex("snippet", [], "refuse", source="synthetic")] * 3  # user decided once
    return examples


def test_prompt_training_writes_expected_rules(settings):
    path = settings.paths.router_prompt
    path.write_text("- Old rule (kind: snippet; topics: none): refuse. From yesterday.\n")

    result = train.train(fixture_log(), settings, day="2026-10-27")

    assert result.backend == "prompt" and result.path == path and result.rules == 4
    assert result.user_examples == 20 and result.examples == 30 and not result.cloud_required
    text = path.read_text()
    lines = [line for line in text.splitlines() if line.startswith("- ")]
    assert lines == [
        "- Per-student results (kind: per_student; topics: grades, writing): share tagged. "
        "You approved 6 of 6 and said don't ask again.",
        "- Contact details (kind: contact_info; topics: parent_contact): ask first. "
        "You wanted to be asked 4 of 5 times, so keep asking.",
        "- Sensitive records (kind: sensitive_record; topics: iep): refuse. "
        "You said no to 3 of 3 and said don't ask again.",
        "- Class-wide results (kind: class_aggregate; topics: grades): share a summary. "
        "3 of 3 practice examples agree.",
    ]
    assert "From yesterday" not in text  # rebuilt from scratch
    assert text.index("## Your rules") < text.index("## Practice defaults")
    assert "from 20 of your decisions and 10 practice examples" in text
    assert "\u2014" not in text
    assert train.parse_rules(text) == [
        ("per_student", ("grades", "writing"), "share_tagged"),
        ("contact_info", ("parent_contact",), "ask_user"),
        ("sensitive_record", ("iep",), "refuse"),
        ("class_aggregate", ("grades",), "share_summary"),
    ]


def test_prompt_training_with_no_rules_and_custom_path(settings, tmp_path):
    out = tmp_path / "candidate.md"
    result = train.train([ex("snippet", [], "refuse", approved=False, remember=True)], settings, out_path=out)
    assert result.rules == 0 and out.is_file() and "No rules yet." in out.read_text()
    assert not settings.paths.router_prompt.exists()


def small_policy():
    return UserPolicy.from_dict({
        "never_share": {"iep": ["IEP"], "custody": ["custody"]},
        "ask_first": ["custody"],
        "rules": [
            {"id": "no_iep", "topics_any": ["iep"], "wants": "refuse"},
            {"id": "families", "topics_any": ["parents"], "wants": "ask_user"},
            {"id": "grades", "kinds": ["per_student"], "topics_any": ["grades"], "wants": "share_tagged"},
        ],
    })  # fmt: skip


def test_policy_grouping_drops_unnamed_topics_and_floored_groups(settings):
    examples = [ex("per_student", ["grades", "reading"], "share_tagged", approved=True, remember=True)] * 2
    examples += [ex("per_student", ["grades"], "share_tagged", approved=True, remember=True)]
    examples += [ex("sensitive_record", ["iep"], "refuse", source="synthetic")] * 3
    examples += [
        ex("sensitive_record", ["custody"], "refuse", approved=False, remember=True)
    ] * 2  # ask_first
    result = train.train(examples, settings, day="2026-10-27", policy=small_policy())
    text = settings.paths.router_prompt.read_text()
    lines = [line for line in text.splitlines() if line.startswith("- ")]
    assert lines == [
        "- Per-student results (kind: per_student; topics: grades): share tagged. "
        "You approved 3 of 3 and said don't ask again.",
        "- Sensitive records (kind: sensitive_record; topics: custody): refuse. "
        "You said no to 2 of 2 and said don't ask again.",
    ]  # "reading" is not a policy topic; iep is always refused by the floor, custody only asks
    assert result.rules == 2
    assert "never-share topic (iep) in their own text are always refused by the safety floor" in text
    assert "so no rule lists them" not in text


def test_a_request_only_never_share_topic_learns_from_the_users_answers(settings):
    # "Which students have an IEP?" over a list of tags: the result has no keyword, so the device
    # asked (floor request:iep). Deny plus remember is a refuse rule the router then holds.
    from base.router import Router
    from base.types import RouteInput

    denied = [ex("free_text", ["iep"], "refuse", approved=False, remember=True)] * 2
    train.train(denied, settings, day="2026-10-27", policy=small_policy())
    text = settings.paths.router_prompt.read_text()
    assert "- Free-text answers (kind: free_text; topics: iep): refuse. You said no to 2 of 2" in text
    assert "One named only in Muse's request (the Blocked line then says none) is asked about instead" in text

    class Shares:
        def chat_json(self, *_a, **_kw):
            return {"decision": "share_tagged", "reason": "Fine."}

    inp = RouteInput("Which students have an IEP?", "free_text", "[Student A], [Student B]", topics=["iep"],
                     request_blocked=["iep"])  # fmt: skip
    out = Router(settings, Shares(), small_policy()).decide(inp)
    assert out.decision == "refuse" and out.floors == ["request:iep", "learned:refuse"]

    # Asks stay asks; approvals never become a share rule there (the request floor asks anyway).
    asked = [ex("free_text", ["iep"], "ask_user", approved=True, remember=False)] * 3
    assert [(r.result_kind, r.topics, r.decision) for r in train.learn_rules(asked, small_policy())] == [
        ("free_text", ("iep",), "ask_user"), (None, ("iep",), "ask_user")
    ]  # fmt: skip
    approved = [ex("free_text", ["iep"], "share_tagged", approved=True, remember=True)] * 3
    assert train.learn_rules(approved, small_policy()) == []
    # Practice data with a floored topic still teaches nothing.
    assert train.learn_rules([ex("free_text", ["iep"], "refuse", source="synthetic")] * 4, small_policy()) == []


def test_topic_rules_are_strict_only_and_need_three_decisions(settings):
    examples = [ex("free_text", ["parents"], "ask_user", approved=True, remember=False)] * 2
    examples += [ex("per_student", ["grades", "parents"], "ask_user", approved=True, remember=False)]
    examples += [ex("snippet", ["grades"], "share_tagged", approved=True, remember=True)]
    examples += [ex("per_student", ["grades"], "share_tagged", approved=True, remember=True)] * 2
    examples += [ex("snippet", ["deanonymize"], "refuse", source="synthetic")] * 3  # not a policy topic
    rules = train.learn_rules(examples, small_policy())
    topic_rules = [r for r in rules if r.result_kind is None]
    assert [(r.topics, r.decision, r.count, r.total) for r in topic_rules] == [
        (("parents",), "ask_user", 3, 3)
    ]
    # grades mixes share forms with asks, so it never becomes a topic rule; sharing is never a topic rule
    assert topic_rules[0].line() == (
        "- Anything about parents (topic: parents): ask first. You wanted to be asked 3 of 3 times, so keep asking."
    )
    assert train.learn_rules(examples[:2], small_policy()) == [
        train.Rule("free_text", ("parents",), "ask_user", 2, 2, "user")
    ]  # two decisions make a group rule but not a topic rule


def test_a_topic_that_rides_along_gets_no_topic_rule():
    # The user was only asked about grades when parents were involved, plus two grade approvals:
    # 8 of 10 grades decisions say ask, but parents explains every one of them.
    examples = [ex("per_student", ["grades", "parents"], "ask_user", approved=True, remember=False)] * 8
    examples += [ex("per_student", ["grades"], "share_tagged", approved=True, remember=True)] * 2
    rules = train.learn_rules(examples, small_policy())
    assert [(r.topics, r.decision) for r in rules if r.result_kind is None] == [(("parents",), "ask_user")]

    # With no decision of its own, a topic that always comes with a better-supported one gets nothing.
    policy = UserPolicy.from_dict(
        {"rules": [{"id": "w", "topics_any": ["writing", "full_text"], "wants": "ask_user"}]}
    )
    riders = [ex("free_text", ["full_text", "writing"], "ask_user", approved=True, remember=False)] * 4
    riders += [ex("free_text", ["full_text"], "ask_user", approved=True, remember=False)]
    assert [r.topics for r in train.learn_rules(riders, policy) if r.result_kind is None] == [("full_text",)]


def test_read_rules_and_match_rule_order(settings):
    examples = [ex("per_student", ["grades"], "share_tagged", approved=True, remember=True)] * 2
    examples += [ex("free_text", ["parents"], "ask_user", source="synthetic")] * 4
    examples += [ex("free_text", ["grades"], "share_tagged", source="synthetic")] * 2
    examples += [ex("per_student", ["grades"], "refuse", source="synthetic")] * 2  # you decided this group
    policy = small_policy()
    train.train(examples, settings, day="2026-10-27", policy=policy)
    rules = train.read_rules(settings.paths.router_prompt.read_text())
    assert [(r.kind, r.topics, r.decision, r.source) for r in rules] == [
        ("per_student", ("grades",), "share_tagged", "user"),
        ("free_text", ("parents",), "ask_user", "synthetic"),
        ("free_text", ("grades",), "share_tagged", "synthetic"),
        (None, ("parents",), "ask_user", "synthetic"),
    ]
    assert rules[0].text.startswith(
        "- Per-student results (kind: per_student; topics: grades): share tagged."
    )
    relevant = train.relevant_topics(policy)
    match = lambda kind, topics: train.match_rule(rules, *train.rule_key(kind, topics, relevant))  # noqa: E731
    assert (
        match("per_student", ["grades", "reading"]).source == "user"
    )  # your rule; reading is not a policy topic
    assert match("per_student", ["grades", "parents"]).kind is None  # no exact rule: the practice topic rule
    assert match("free_text", ["grades"]).decision == "share_tagged"
    assert match("class_aggregate", ["grades"]) is None
    assert train.match_rule(rules, "x", ()) is None and train.read_rules("") == []

    strict = [
        train.RuleLine(None, ("parents",), "ask_user", "synthetic", "a"),
        train.RuleLine(None, ("deanonymize",), "refuse", "synthetic", "b"),
    ]
    assert train.match_rule(strict, "free_text", ("deanonymize", "parents")).decision == "refuse"  # strictest


def test_relevant_topics_needs_a_policy():
    assert train.relevant_topics(None) is None
    assert train.relevant_topics(SimpleNamespace(wants=lambda item: "ask_user")) is None
    assert train.relevant_topics(small_policy()) == {"iep", "custody", "parents", "grades"}
    assert train.floored_topics(small_policy()) == {"iep"}


def test_lora_backend_writes_chat_jsonl_and_does_not_train(settings):
    examples = [
        ex("per_student", ["grades"], "share_tagged", approved=True, remember=True),
        ex("sensitive_record", ["iep"], "refuse", approved=False, remember=True),
        ex("class_aggregate", ["grades"], "share_summary", source="synthetic"),
    ]
    result = train.train(examples, settings, "lora", day="2026-10-27")
    assert result.cloud_required and result.backend == "lora"
    assert result.path == settings.paths.adapters / "train-2026-10-27.jsonl"
    assert "scripts/cloud/train_lora_modal.py" in result.message and "not started" in result.message
    records = [json.loads(line) for line in result.path.read_text().splitlines()]
    assert len(records) == 3 + 3 + 1  # user rows weigh 3
    first = records[0]["messages"]
    assert [m["role"] for m in first] == ["system", "user", "assistant"]
    assert first[0]["content"].startswith("Reasoning strength: low")
    assert "per_student" in first[1]["content"] and "[Student A] text" in first[1]["content"]
    assert json.loads(first[2]["content"])["decision"] == "share_tagged"
    denied = records[3]["messages"][1]["content"]
    assert (
        train.WITHHELD_TEXT in denied and "[Student A] text" not in denied
    )  # text the user said no to stays out
    assert not settings.paths.router_prompt.exists()


# ----- gate -----


def report(acc, cats=None, agreement=None, leaks=0, name="r"):
    cats = cats or {"share_tagged": acc, "refuse": acc}
    return EvalReport(
        name=name, n=20, accuracy=acc, agreement=acc if agreement is None else agreement, leaks=leaks,
        categories={c: {"accuracy": a} for c, a in cats.items()},
    )  # fmt: skip


@pytest.fixture
def scored(monkeypatch):
    """Fake evaluate: the report for a rules file is looked up by its first line ('none' if no file)."""
    table, calls = {}, []

    def evaluate(settings, items, *, rules_path=None, name, **kw):
        key = "none" if rules_path is None else rules_path.read_text().splitlines()[0]
        calls.append(key)
        return table[key]

    monkeypatch.setattr(run_eval, "evaluate", evaluate)
    return table, calls


def two_files(tmp_path):
    current, candidate = tmp_path / "router_rules.md", tmp_path / "router_rules.candidate.md"
    current.write_text("current\n")
    candidate.write_text("candidate\n")
    return candidate, current


def test_gate_keeps_a_better_candidate_and_swaps_it_in(settings, tmp_path, scored):
    table, _ = scored
    table.update(current=report(0.5), candidate=report(0.8))
    candidate, current = two_files(tmp_path)
    g = gate.gate(SimpleNamespace(settings=settings), candidate, current, [{"id": "h"}])
    assert g.keep and g.reasons == [] and g.before.accuracy == 0.5 and g.after.accuracy == 0.8
    assert current.read_text() == "candidate\n" and not candidate.exists()


@pytest.mark.parametrize(
    ("after", "reason"),
    [
        (report(0.9, cats={"share_tagged": 1.0, "refuse": 0.4}), "refuse accuracy fell"),
        (report(0.9, agreement=0.4), "agreement fell"),
        (report(0.9, leaks=1), "leaked on 1"),
        (report(0.4), "overall accuracy fell"),
    ],
)
def test_gate_rejects_any_regression_or_leak(settings, tmp_path, scored, after, reason):
    table, _ = scored
    table.update(current=report(0.5), candidate=after)
    candidate, current = two_files(tmp_path)
    g = gate.gate(SimpleNamespace(settings=settings), candidate, current, [{"id": "h"}])
    assert not g.keep and any(reason in r for r in g.reasons)
    assert current.read_text() == "current\n" and not candidate.exists()


def test_gate_with_no_current_rules_compares_against_none(settings, tmp_path, scored):
    table, calls = scored
    table.update(none=report(0.25), candidate=report(0.25))
    candidate, current = two_files(tmp_path)
    current.unlink()
    g = gate.gate(SimpleNamespace(settings=settings), candidate, current, [{"id": "h"}])
    assert calls == ["none", "candidate"] and g.keep and current.read_text() == "candidate\n"


def test_gate_force_replaces_rules_from_deleted_decisions(settings, tmp_path, scored):
    table, _ = scored
    table.update(current=report(0.9), candidate=report(0.5))
    candidate, current = two_files(tmp_path)
    assert gate.gate(SimpleNamespace(settings=settings), candidate, current, [{}], force=True).keep
    assert current.read_text() == "candidate\n"

    table.update(candidate=report(0.5, leaks=2))
    candidate.write_text("candidate\n")
    current.write_text("current\n")
    assert not gate.gate(SimpleNamespace(settings=settings), candidate, current, [{}], force=True).keep
    assert not current.exists() and not candidate.exists()  # no rules beats rules from deleted rows


# ----- paired gate: only items whose learned rules differ are re-run -----


class ViewRouter:
    """Fake Router.learned_view: the rule lines of a rules text that name the item's kind."""

    def learned_view(self, inp, rules_text=None):
        return tuple(line for line in (rules_text or "").splitlines() if inp.result_kind in line)


GATE_ITEMS = [
    {"id": "a", "request": "r", "result_kind": "snippet", "expected": "refuse"},
    {"id": "b", "request": "r", "result_kind": "per_student", "expected": "share_tagged"},
    {"id": "c", "request": "r", "result_kind": "free_text", "expected": "ask_user"},
]


def gate_row(item, decision, *, leaked=False, fallback=False, routed=True):
    from base.types import RouteInput

    return {
        "id": item["id"], "expected": item["expected"], "wants": item["expected"], "decision": decision,
        "status": run_eval.OUTCOME_FOR.get(decision, "refused"), "source": "fallback" if fallback else "model",
        "floors": [], "fallback": fallback, "leaked": leaked, "leak_kinds": ["name"] if leaked else [],
        "latency_ms": 5, "route_input": RouteInput(item["request"], item["result_kind"], "") if routed else None,
    }  # fmt: skip


@pytest.fixture
def paired_runs(monkeypatch):
    """Fake evaluate over rows, scored by run_eval itself. decide[(rules, id)] overrides the right
    answer, extra[(rules, id)] marks a row leaked, fallen back or not routed; `calls` shows which
    items each rules file was run on."""
    decide, extra, calls = {}, {}, []

    def evaluate(settings, items, *, rules_path=None, name, **kw):
        key = "none" if rules_path is None else rules_path.read_text().splitlines()[0]
        calls.append((key, [i["id"] for i in items]))
        rows = [gate_row(i, decide.get((key, i["id"]), i["expected"]), **extra.get((key, i["id"]), {})) for i in items]
        return run_eval.rescore(rows, EvalReport(name=name), rules=key)

    monkeypatch.setattr(run_eval, "evaluate", evaluate)
    return decide, extra, calls


def paired_files(tmp_path):
    current, candidate = tmp_path / "router_rules.md", tmp_path / "router_rules.candidate.md"
    current.write_text("current\n- snippet: refuse\n")
    candidate.write_text("candidate\n- snippet: refuse\n- per_student: share tagged\n")
    return candidate, current


def test_paired_gate_reruns_only_items_whose_learned_rules_changed(settings, tmp_path, paired_runs):
    decide, _, calls = paired_runs
    decide[("current", "b")] = "ask_user"  # the current rules miss b; the new per_student rule fixes it
    decide[("candidate", "a")] = "share_tagged"  # a flip a separate candidate run could have hit
    decide[("candidate", "c")] = "share_tagged"
    candidate, current = paired_files(tmp_path)
    g = gate.gate(SimpleNamespace(settings=settings, router=ViewRouter()), candidate, current, GATE_ITEMS)

    assert calls == [("current", ["a", "b", "c"]), ("candidate", ["b"])]
    assert g.keep and g.rerun == 1 and g.reasons == []
    assert (g.before.accuracy, g.after.accuracy) == (round(2 / 3, 4), 1.0)
    assert {r["id"]: r["reused"] for r in g.after.rows} == {"a": True, "b": False, "c": True}
    assert g.after.name == "gate-candidate" and "1 of 3 holdout items re-run" in g.after.command
    assert current.read_text().startswith("candidate")


def test_paired_gate_with_unchanged_learned_rules_needs_no_candidate_run(settings, tmp_path, paired_runs):
    _, _, calls = paired_runs
    candidate, current = paired_files(tmp_path)
    candidate.write_text("candidate\n- snippet: refuse\n")  # same rules for every holdout kind
    g = gate.gate(SimpleNamespace(settings=settings, router=ViewRouter()), candidate, current, GATE_ITEMS)
    assert calls == [("current", ["a", "b", "c"])] and g.rerun == 0
    assert g.keep and g.after.summary() == g.before.summary()
    assert all(r["reused"] for r in g.after.rows)


def test_paired_gate_reruns_items_the_current_run_could_not_route(settings, tmp_path, paired_runs):
    _, extra, calls = paired_runs
    extra[("current", "c")] = {"routed": False, "fallback": True}  # a check held it before the router
    candidate, current = paired_files(tmp_path)
    g = gate.gate(SimpleNamespace(settings=settings, router=ViewRouter()), candidate, current, GATE_ITEMS)
    assert calls[1] == ("candidate", ["b", "c"]) and g.rerun == 2


def test_paired_gate_still_checks_leaks_and_unscored_items(settings, tmp_path, paired_runs):
    decide, extra, _ = paired_runs
    services = SimpleNamespace(settings=settings, router=ViewRouter())

    extra[("candidate", "b")] = {"leaked": True}  # a leak on a re-run item
    candidate, current = paired_files(tmp_path)
    g = gate.gate(services, candidate, current, GATE_ITEMS)
    assert not g.keep and any("leaked on 1" in r for r in g.reasons)
    assert current.read_text().startswith("current") and not candidate.exists()

    extra.clear()
    extra[("current", "a")] = {"leaked": True}  # a leak on a reused item counts against the candidate too
    candidate, current = paired_files(tmp_path)
    g = gate.gate(services, candidate, current, GATE_ITEMS)
    assert not g.keep and g.rerun == 1 and g.after.leaks == 1

    extra.clear()
    extra[("current", "c")] = {"fallback": True}  # 1 of 3 fell back, over the 10% limit, on both sides
    candidate, current = paired_files(tmp_path)
    g = gate.gate(services, candidate, current, GATE_ITEMS)
    assert not g.keep and sum("could not be scored" in r for r in g.reasons) == 2


def test_gate_without_a_router_that_can_compare_reruns_everything(settings, tmp_path, paired_runs):
    _, _, calls = paired_runs
    candidate, current = paired_files(tmp_path)
    g = gate.gate(SimpleNamespace(settings=settings), candidate, current, GATE_ITEMS)
    assert calls[1] == ("candidate", ["a", "b", "c"]) and g.rerun == 3


# ----- night -----


@pytest.fixture
def holdout_file(tmp_path):
    path = tmp_path / "holdout.jsonl"
    path.write_text(json.dumps({"id": "h1", "request": "r", "result": "x", "result_kind": "snippet",
                                "topics": [], "expected": "refuse"}) + "\n")  # fmt: skip
    return path


@pytest.fixture
def by_rule_count(monkeypatch):
    """Fake evaluate: more learned rules score better, so the gate's choice is predictable."""

    def evaluate(settings, items, *, rules_path=None, name, **kw):
        n = len(train.parse_rules(rules_path.read_text())) if rules_path else 0
        acc = min(1.0, 0.25 + 0.25 * n)
        return report(acc, name=name)

    monkeypatch.setattr(run_eval, "evaluate", evaluate)


def runner_for(settings, rows, holdout_file, tmp_path, **kw):
    services = SimpleNamespace(settings=settings, approvals=FakeStore(rows))
    return night.NightRunner(
        services, holdout_path=holdout_file, synthetic_path=tmp_path / "none.jsonl", **kw
    )


def test_night_learns_keeps_and_reports_aggregates_only(settings, holdout_file, tmp_path, by_rule_count):
    rows = [row(i, "per_student", ["grades"], "approve", True) for i in range(1, 5)]
    runner = runner_for(settings, rows, holdout_file, tmp_path)
    assert runner.last_report()["night_number"] == 0

    r = runner.run_night()
    assert r.kept and r.learned_from == 4 and r.rules == 1 and r.leaks == 0
    assert (r.accuracy_before, r.accuracy_after) == (0.25, 0.5)
    assert "share tagged. You approved 4 of 4" in settings.paths.router_prompt.read_text()
    assert not settings.paths.router_prompt.with_name("router_rules.candidate.md").exists()

    last = runner.last_report()
    assert set(last) == set(night.REPORT_KEYS)
    assert last["night_number"] == 1 and last["kept"] is True
    assert all(isinstance(v, int | float | bool) for v in last.values())
    assert runner.running_job() is None


def test_night_drops_rules_learned_from_deleted_decisions(settings, holdout_file, tmp_path, by_rule_count):
    rows = [row(i, "per_student", ["grades"], "approve", True) for i in range(1, 4)]
    rows += [row(i, "contact_info", ["parent_contact"], "deny", True) for i in range(4, 7)]
    runner = runner_for(settings, rows, holdout_file, tmp_path)
    assert runner.run_night().kept
    assert "contact_info" in settings.paths.router_prompt.read_text()

    for r in rows[3:]:
        r["deleted"] = 1  # the user deletes those decisions
    second = runner.run_night()  # fewer rules score worse, but deleted rows must not keep steering
    assert second.kept and second.night_number == 2
    text = settings.paths.router_prompt.read_text()
    assert "contact_info" not in text and "per_student" in text


def test_night_lora_backend_writes_data_and_keeps_current_rules(
    settings, holdout_file, tmp_path, by_rule_count
):
    lora = replace(settings, dreaming_backend="lora")
    settings.paths.router_prompt.write_text("current\n")
    runner = runner_for(lora, [row(1, "snippet", [], "deny", True)], holdout_file, tmp_path)
    r = runner.run_night()
    assert not r.kept and r.backend == "lora" and "cloud" in r.note
    assert settings.paths.router_prompt.read_text() == "current\n"
    assert list(settings.paths.adapters.glob("train-*.jsonl"))


def test_start_is_idempotent_while_a_night_runs(settings, holdout_file, tmp_path, monkeypatch):
    gate_open, entered = threading.Event(), threading.Event()

    def slow_dream(self, job_id):
        entered.set()
        assert gate_open.wait(5)
        return "done"

    monkeypatch.setattr(night.NightRunner, "_dream", slow_dream)
    seen = []
    unsubscribe = events.subscribe(lambda e: seen.append((e.state, e.detail)))
    try:
        runner = runner_for(settings, [], holdout_file, tmp_path)
        job = runner.start()
        assert entered.wait(5)
        assert runner.start() == job
        other = runner_for(settings, [], holdout_file, tmp_path)  # same db, different object
        assert other.start() == job and other.running_job() == job
        with pytest.raises(night.DreamingBusy) as busy:
            other.run_night()
        assert busy.value.job_id == job

        gate_open.set()
        runner.wait(5)
        assert runner.running_job() is None
        assert ("working", f"dreaming {job}") in seen and ("idle", f"dreaming {job}") in seen
        assert seen.index(("working", f"dreaming {job}")) < seen.index(("idle", f"dreaming {job}"))
        assert runner.start() != job
        runner.wait(5)
    finally:
        gate_open.set()
        unsubscribe()


def test_stale_lock_is_taken_over(settings, holdout_file, tmp_path):
    runner = runner_for(settings, [], holdout_file, tmp_path, stale_after=60)
    con = sqlite3.connect(settings.paths.db)
    con.execute(
        "INSERT INTO dreaming_lock (name, job_id, started_at) VALUES ('night', 'dream-dead', ?)",
        (time.time() - 3600,),
    )
    con.commit()
    con.close()
    job, acquired = runner._acquire()
    assert acquired and job != "dream-dead"


def test_lock_left_by_a_stopped_process_is_not_a_running_night(settings, holdout_file, tmp_path):
    # Review correctness F4: SIGTERM mid-night skips the finally that drops the lock row.
    import subprocess
    import sys

    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    runner = runner_for(settings, [], holdout_file, tmp_path)
    con = sqlite3.connect(settings.paths.db)
    con.execute(
        "INSERT INTO dreaming_lock (name, job_id, started_at, owner) VALUES ('night', 'dream-dead', ?, ?)",
        (time.time(), f"{dead.pid}:abcd1234"),
    )
    con.commit()
    con.close()
    assert runner.running_job() is None
    job, acquired = runner._acquire()
    assert acquired and job != "dream-dead"


def test_report_for_a_finished_night(settings, holdout_file, tmp_path, by_rule_count):
    runner = runner_for(settings, [row(1, "per_student", ["grades"], "approve", True)], holdout_file, tmp_path)
    r = runner.run_night()
    assert runner.report_for(r.job_id)["kept"] is True
    assert set(runner.report_for(r.job_id)) == set(night.REPORT_KEYS)
    assert runner.report_for("dream-none") is None


def test_last_finished_at_names_the_latest_night(settings, holdout_file, tmp_path, by_rule_count):
    runner = runner_for(settings, [row(1, "per_student", ["grades"], "approve", True)], holdout_file, tmp_path)
    assert runner.last_finished_at() is None
    before = time.time()
    first, second = runner.run_night(), runner.run_night()
    job_id, finished_at = runner.last_finished_at()
    assert job_id == second.job_id != first.job_id
    assert before <= finished_at <= time.time()
    forced = runner.start()  # Dream now still starts a night right after one finished
    runner.wait(5)
    assert forced not in (first.job_id, second.job_id) and runner.last_finished_at()[0] == forced


def test_night_says_how_many_holdout_items_the_gate_reran(settings, holdout_file, tmp_path, paired_runs):
    rows = [row(i, "snippet", [], "deny", True) for i in range(1, 4)]
    runner = runner_for(settings, rows, holdout_file, tmp_path)
    runner.services.router = ViewRouter()
    first = runner.run_night()  # no rules yet, then a snippet rule: the snippet item's view changed
    assert first.kept and first.gate_rerun == 1 and "re-ran 1 of 1 holdout items" in first.note
    assert "gate_rerun" not in runner.last_report()  # aggregate numbers for Muse stay as they were

    second = runner.run_night()  # the same decisions give the same rules: nothing to re-run
    assert second.gate_rerun == 0 and second.kept and "re-ran 0 of 1" in second.note
    _, _, calls = paired_runs
    assert [ids for _, ids in calls] == [["h1"], ["h1"], ["h1"]]


def test_night_never_trains_on_excluded_ids(settings, holdout_file, tmp_path, by_rule_count, monkeypatch):
    seen = []
    build = dataset.build
    monkeypatch.setattr(dataset, "build", lambda store, path, ids: seen.append(set(ids)) or build(store, path, ids))
    runner = runner_for(settings, [], holdout_file, tmp_path)
    runner.exclude_ids = {"syn-0001"}  # the simulation's unseen test items
    runner.run_night()
    assert seen == [{"h1", "syn-0001"}]


def test_lora_rows_that_still_name_someone_never_leave(settings):
    # Review privacy F9: requests are Muse's text, and approved text never passed final_check.
    from dataclasses import replace as dc_replace

    roster = load_roster_for(settings)
    real = roster.students[0].name
    named = dc_replace(ex("per_student", ["grades"], "share_tagged", approved=True, remember=True),
                       tagged_text=f"{real.lower()} wrote 3 pages")
    asked = dc_replace(ex("free_text", [], "refuse", approved=False, remember=True),
                       request=f"Find the phone for {real}")
    ok = ex("per_student", ["grades"], "share_tagged", approved=True, remember=True)
    result = train.train([named, asked, ok], settings, "lora", day="2026-10-28")
    text = result.path.read_text()
    assert real.split()[0].lower() not in text.lower()
    assert "left out 1" in result.message
    lines = [json.loads(line) for line in text.splitlines()]
    assert len(lines) == 6  # the denied row stays, with its request withheld; the named row is gone
    assert any(train.WITHHELD_TEXT in r["messages"][1]["content"].split("Result kind")[0] for r in lines)


def load_roster_for(settings):
    from base import guard

    return guard.load_roster(settings.roster_path)


def test_relevant_topics_include_request_topics():
    policy = UserPolicy.from_dict(
        {"never_share": {"iep": ["IEP"]}, "request_topics": {"parents": "meant for a family"}, "rules": []}
    )
    relevant = train.relevant_topics(policy)
    assert {"iep", "parents"} <= relevant
    # grades for the teacher and grades for families land in different groups
    assert train.rule_key("per_student", ["parents"], relevant) != train.rule_key("per_student", [], relevant)


def test_class_level_requests_are_shared_as_a_summary():
    assert default_share_form("per_student", ["class_level"]) == "share_summary"
    assert default_share_form("free_text", ["parents", "class_level"]) == "share_summary"
    assert default_share_form("class_aggregate") == "share_summary"
    assert default_share_form("per_student", ["parents"]) == "share_tagged"


# ----- learned floors: a request topic never loosens a learned rule (train.learned_floor) -----


def rule_line(kind, topics, decision, source="user"):
    return train.RuleLine(kind, tuple(sorted(topics)), decision, source, f"{kind} {topics} {decision} {source}")


def test_covers_is_same_kind_with_fewer_topics_or_a_topic_rule():
    assert train.covers(rule_line("snippet", [], "refuse"), "snippet", ("class_level",))
    assert train.covers(rule_line("snippet", ["parents"], "ask_user"), "snippet", ("class_level", "parents"))
    assert not train.covers(rule_line("snippet", ["parents"], "ask_user"), "snippet", ("class_level",))
    assert not train.covers(rule_line("free_text", [], "refuse"), "snippet", ())
    assert train.covers(rule_line(None, ["parents"], "ask_user"), "per_student", ("parents",))
    assert not train.covers(rule_line(None, ["parents"], "ask_user"), "per_student", ())


def test_learned_floor_is_the_strictest_rule_that_still_holds():
    broad = rule_line("snippet", [], "refuse")
    closer = rule_line("snippet", ["class_level"], "share_summary")
    asks = rule_line("snippet", ["parents"], "ask_user")
    assert train.match_rule([closer, broad], "snippet", ("class_level",)) == closer  # shown to the model
    assert train.learned_floor([closer, broad], "snippet", ("class_level",)) == broad  # still the floor
    assert train.learned_floor([asks, broad], "snippet", ("class_level", "parents")) == broad
    assert train.learned_floor([asks], "snippet", ("class_level", "parents")) == asks
    assert train.learned_floor([closer], "snippet", ("class_level",)) is None  # a share rule is never a floor
    assert train.learned_floor([broad], "free_text", ("class_level",)) is None  # another kind
    assert train.learned_floor([], "snippet", ()) is None


def test_learned_floor_keeps_your_rules_ahead_of_practice_defaults():
    yours = rule_line("snippet", ["class_level"], "share_summary")
    practice = rule_line("snippet", [], "refuse", "synthetic")
    assert train.learned_floor([yours, practice], "snippet", ("class_level",)) is None
    assert train.learned_floor([practice], "snippet", ("class_level",)) == practice
    # Among equally strict rules, yours gives the reason.
    mine = rule_line("snippet", [], "refuse")
    exact_practice = rule_line("snippet", ["class_level"], "refuse", "synthetic")
    assert train.learned_floor([mine, exact_practice], "snippet", ("class_level",)) == mine


def test_rules_header_and_router_prompt_say_broader_strict_rules_still_hold(settings):
    from base.router import SYSTEM_PROMPT

    examples = [ex("snippet", [], "refuse", approved=False, remember=True)] * 2
    train.train(examples, settings, day="2026-10-27", policy=small_policy())
    text = settings.paths.router_prompt.read_text()
    assert "Use the rule whose kind and topics match the result exactly." not in text
    assert "has all of its topics, with or without more (topics: none covers the whole kind)" in text
    assert "it is the stricter one: follow it" in text
    assert "is shown too, it is the stricter one: follow it" in SYSTEM_PROMPT
    assert "\u2014" not in text
    rules = train.read_rules(text)
    key = train.rule_key("snippet", ["parents"], train.relevant_topics(small_policy()))
    assert train.match_rule(rules, *key) is None and train.learned_floor(rules, *key).decision == "refuse"


# ----- stricter share rules (HANDOFF open item 12, the t085 case) -----


def eval_policy():
    return UserPolicy.load(Path(__file__).resolve().parents[1] / "eval" / "user_policy.yaml")


def approvals(kind, topics, n, label="share_tagged"):
    return [ex(kind, topics, label, approved=True, remember=True)] * n


def test_two_approvals_on_snippets_with_no_topics_teach_no_share_rule(settings):
    # Oct 27: two approvals taught "share snippets with no topics", and t085, a discipline note
    # with no discipline keyword, went out tagged with no card. That rule never forms now.
    assert train.learn_rules(approvals("snippet", [], 2), eval_policy()) == []
    train.train(approvals("snippet", [], 2), settings, day="2026-10-30", policy=eval_policy())
    rules_text = settings.paths.router_prompt.read_text()
    assert "kind: snippet; topics: none" not in rules_text

    from base.router import Router
    from base.types import RouteInput

    class NoModel:
        def chat_json(self, *_a, **_k):
            raise AssertionError("the router asked the model")

    device = replace(settings, device_only=True, primary_model="lfm", dreaming_backend="rules")
    note = RouteInput("what happened at recess", "snippet", "[Student A] was sent to the office after recess.")
    out = Router(device, NoModel(), eval_policy(), rules_text=rules_text).decide(note)
    assert out.decision == "ask_user" and out.code == "policy_default"


def test_a_share_rule_for_a_whole_kind_needs_five_decisions_that_all_agree():
    policy = eval_policy()
    assert train.learn_rules(approvals("snippet", [], 4), policy) == []
    dissent = approvals("snippet", [], 5) + [ex("snippet", [], "ask_user", approved=True, remember=False)]
    assert train.learn_rules(dissent, policy) == []  # 5 of 6 is 83%: enough before, not now
    assert [(r.result_kind, r.topics, r.decision, r.count) for r in train.learn_rules(approvals("snippet", [], 5), policy)] == [
        ("snippet", (), "share_tagged", 5)
    ]
    # Groups with topics and ask first or refuse rules keep the old bar.
    assert train.learn_rules(approvals("per_student", ["grades"], 2), policy)[0].decision == "share_tagged"
    asks = [ex("snippet", [], "ask_user", approved=True, remember=False)] * 2
    assert train.learn_rules(asks, policy)[0].decision == "ask_user"
    # Practice defaults follow the same bar.
    assert train.learn_rules([ex("snippet", [], "share_tagged", source="synthetic")] * 4, policy) == []


@pytest.mark.parametrize("topic", ["third_party", "parents", "full_text"])
def test_a_group_going_outside_the_class_never_gets_a_share_rule(topic):
    policy = eval_policy()
    assert train.learn_rules(approvals("free_text", [topic], 5), policy) == []
    assert train.learn_rules([ex("free_text", [topic], "share_tagged", source="synthetic")] * 5, policy) == []
    asked = [ex("free_text", [topic], "ask_user", approved=True, remember=False)] * 3
    assert {(r.result_kind, r.decision) for r in train.learn_rules(asked, policy)} == {("free_text", "ask_user"), (None, "ask_user")}


def test_destination_topics_come_from_the_policy():
    assert train.destination_topics(eval_policy()) == {"parents", "third_party", "full_text", "deanonymize"}
    assert train.destination_topics(None) == train.DESTINATION_TOPICS
    assert train.destination_topics(small_policy()) == frozenset()  # no request topics there
    assert train.learn_rules(approvals("free_text", ["parents"], 5)) == []  # no policy: the default names


# ----- the gate checks missed asks and refusals shared -----


@pytest.mark.parametrize(("field", "reason"), [("missed_asks", "missed asks rose"), ("refuse_shared", "refusals shared rose")])
def test_gate_rejects_a_candidate_that_shares_one_more_ask_or_refusal_even_when_more_accurate(
    settings, tmp_path, scored, field, reason
):
    table, _ = scored
    table.update(current=report(0.5), candidate=replace(report(0.9), **{field: 1}))
    candidate, current = two_files(tmp_path)
    g = gate.gate(SimpleNamespace(settings=settings), candidate, current, [{"id": "h"}])
    assert not g.keep and any(reason in r for r in g.reasons)
    assert current.read_text() == "current\n"

    table.update(current=replace(report(0.5), **{field: 1}), candidate=replace(report(0.9), **{field: 1}))
    candidate.write_text("candidate\n")
    assert gate.gate(SimpleNamespace(settings=settings), candidate, current, [{"id": "h"}]).keep  # no worse


def test_night_reports_missed_asks_and_refusals_shared_for_the_rules_in_place(settings, holdout_file, tmp_path, monkeypatch):
    def evaluate(settings, items, *, rules_path=None, name, **kw):
        return replace(report(0.5 if rules_path is None else 0.75, name=name), missed_asks=0, refuse_shared=2)

    monkeypatch.setattr(run_eval, "evaluate", evaluate)
    rows = [row(i, "per_student", ["grades"], "approve", True) for i in range(1, 4)]
    r = runner_for(settings, rows, holdout_file, tmp_path).run_night()
    assert r.kept and (r.missed_asks, r.refuse_shared) == (0, 2)


# ----- approval requests for the 8 AM sentence (MUSE-12) -----

CANARY = "Zephyrine Quoll canary-4417"


def seeded_asks(settings, *, remember_share=5, ask_again=2):
    """Approval requests in a real decisions table: some the user taught to share, some to ask again.
    Five shares, because a share rule for a whole kind needs 5 decisions that all agree."""
    from base.approvals import ApprovalStore

    store = ApprovalStore(settings.paths.db)
    for i in range(remember_share):
        rid = store.create_pending(
            tool="get_result", request=f"attendance this week {CANARY}", result_kind="free_text",
            tagged_text=f"[Student A] was here {CANARY} {i}", router_decision="ask_user", topics=[],
        )  # fmt: skip
        store.decide(rid, approve=True, remember=True)
    for i in range(ask_again):
        rid = store.create_pending(
            tool="search_documents", request=f"seating chart {CANARY}", result_kind="snippet",
            tagged_text=f"[Student B] sits by the window {i}", router_decision="ask_user", topics=[],
        )  # fmt: skip
        store.decide(rid, approve=True, remember=False)
    return store


def test_night_counts_approval_requests_and_those_the_new_rules_still_ask(settings, holdout_file, tmp_path, by_rule_count):
    from base.connector.server import _report_text

    store = seeded_asks(settings)
    policy = UserPolicy.load(run_eval.REPO_ROOT / "eval" / "user_policy.yaml")
    services = SimpleNamespace(settings=settings, approvals=store, policy=policy)
    runner = night.NightRunner(services, holdout_path=holdout_file, synthetic_path=tmp_path / "none.jsonl")
    r = runner.run_night()
    assert r.kept and (r.approval_requests, r.still_asked) == (7, 2)
    last = runner.last_report()
    assert (last["approval_requests"], last["still_asked"]) == (7, 2)
    assert runner.report_for(r.job_id)["still_asked"] == 2

    text = _report_text(last)
    assert "- approval requests in the day before: 7" in text
    assert "- of those, the rules in place now would still ask: 2" in text
    for secret in ("Zephyrine", "Quoll", "canary", "[Student", "attendance", "seating"):
        assert secret not in text

    again = runner.run_night()  # nothing new since that night finished
    assert (again.approval_requests, again.still_asked) == (0, 0)
    store.close()


def test_requests_older_than_a_day_or_deleted_do_not_count(settings, holdout_file, tmp_path, by_rule_count):
    store = seeded_asks(settings, remember_share=0, ask_again=3)
    con = sqlite3.connect(settings.paths.db)
    with con:
        con.execute("UPDATE decisions SET ts = ts - 25 * 3600 WHERE id = 1")
    con.close()
    store.delete(2)
    services = SimpleNamespace(settings=settings, approvals=store, policy=UserPolicy.load(run_eval.REPO_ROOT / "eval" / "user_policy.yaml"))
    r = night.NightRunner(services, holdout_path=holdout_file, synthetic_path=tmp_path / "none.jsonl").run_night()
    assert (r.approval_requests, r.still_asked) == (1, 1)
    store.close()


def test_replayed_rows_keep_their_identifier_request_and_toggle_floors():
    rules = "- free_text: share tagged. You approved 3 of 3 (your decisions)\n"
    receipt = {"floors": ["identifier:phone", "request:iep", "identifier:digits"], "toggles": []}
    stored = {"request": "a note", "result_kind": "free_text", "tagged_text": "[Student A] [Phone 1]",
              "topics": "[]", "blocked": "[]", "receipt": json.dumps(receipt)}  # fmt: skip
    inp, held = night.replay_input(stored)
    assert [h.kind for h in inp.hits] == ["phone"] and inp.request_blocked == ["iep"] and not held and not inp.strict
    policy = UserPolicy.load(run_eval.REPO_ROOT / "eval" / "user_policy.yaml")
    assert night._RulesOnly(SimpleNamespace(device_only=False), None, policy, rules_text=rules).decide(inp).decision == "ask_user"
    toggled = {**stored, "receipt": json.dumps({"floors": ["compliance:ask_all"], "toggles": ["glba"]})}
    inp, held = night.replay_input(toggled)
    assert held and inp.strict
    assert night.replay_input({"receipt": "not json", "topics": "{}"})[0].topics == []
