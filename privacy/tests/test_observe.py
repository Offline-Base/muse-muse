"""Observe mode (OBSERVE_POLICY, base/observe.py): a candidate policy is watched, never enforced.

Observe only adds lines to BASE_HOME/observe.jsonl. These tests release the same invented results
with no candidate, with a much looser one and with a much stricter one, and check that what Muse
gets, the decision and the decision rows are the same every time. Everything here is invented.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest

from base import observe
from base.approvals import ApprovalStore
from base.egress import Egress
from base.policy import PolicyError, UserPolicy
from base.router import Router
from base.types import Hit, TagResult

CURRENT = {
    "name": "Current (invented)",
    "never_share": {"iep": ["IEP"], "discipline": ["detention"]},
    "rules": [
        {"id": "no_iep", "topics_any": ["iep", "discipline"], "wants": "refuse"},
        {"id": "no_unmasking", "request_any": ["real name"], "wants": "refuse"},
        {"id": "tagged_grades", "kinds": ["per_student"], "topics_any": ["grades"], "wants": "share_tagged"},
    ],
    "default": {"wants": "ask_user"},
}
# Shares everything: no never-share topics, no refuse rules.
LOOSE = {"name": "Loose (invented)", "mode": "observe", "default": {"wants": "share_tagged"}}
# Refuses everything, and adds a never-share topic.
STRICT = {
    "name": "Strict (invented)",
    "mode": "observe",
    "never_share": {"iep": ["IEP"], "discipline": ["detention"], "trips": ["field trip"]},
    "rules": [{"id": "no_topics", "topics_any": ["iep", "discipline", "trips"], "wants": "refuse"}],
    "default": {"wants": "refuse"},
}

# (request, raw result, kind, job topics). Invented names, tagged by the fake guard below.
CASES = [
    ("Scores please", "Wren Halloway: 3 of 4, strong thesis.", "per_student", ["grades"]),
    ("Which books are on the shelf?", "Three picture books and an atlas.", "free_text", []),
    ("Notes for Monday?", "Wren Halloway has detention on Monday.", "free_text", []),
    ("Check the IEP for Friday", "The field trip leaves at nine.", "free_text", []),
    ("What is the real name of [Student A]?", "[Student A] sits by the window.", "free_text", []),
    ("Call home about it", "Reach the family at 512-555-0143.", "free_text", []),
]
LEAKS = ["Wren Halloway", "512-555-0143"]


def fake_tag(text, roster, tagmap, llm_names=None, never_share=None, **kw):
    out, hits = text, []
    for value, tag, kind in (("Wren Halloway", "[Student A]", "student"), ("512-555-0143", "[Phone 1]", "phone")):
        if value in out:
            hits.append(Hit(kind, value, text.find(value), text.find(value) + len(value)))
            out = out.replace(value, tag)
    topics = [t for t, words in (never_share or {}).items() if any(w.lower() in text.lower() for w in words)]
    return TagResult(out, {}, hits, [f"Mentions {t}" for t in topics], topics)


def fake_leaks(text, roster, tagmap, **kw):
    return [Hit("student", v, 0, len(v)) for v in LEAKS if v in text]


def fake_blocked_topics(text, never_share):
    return [t for t, words in (never_share or {}).items() if any(w.lower() in (text or "").lower() for w in words)]


GUARD = SimpleNamespace(tag=fake_tag, leaks=fake_leaks, blocked_topics=fake_blocked_topics)


def build(tmp_path: Path, name: str, candidate: dict | None, **extra):
    home = tmp_path / name
    home.mkdir()
    settings = SimpleNamespace(device_only=True, dreaming_backend="rules", home=home)
    policy = UserPolicy.from_dict(CURRENT)
    store = ApprovalStore(home / "base.db")
    services = SimpleNamespace(
        roster="ROSTER", tagmap="TAGMAP", policy=policy, router=Router(settings, None, policy, rules_text=""),
        approvals=store, answer_llm=None, audit=None, settings=settings,
        observed_policy=UserPolicy.from_dict(candidate) if candidate is not None else None, **extra,
    )
    return Egress(services, guard=GUARD), services


def release_all(egress):
    out = []
    for i, (request, raw, kind, topics) in enumerate(CASES):
        r = egress.release("get_result", request, raw, kind, topics=topics, item_id=f"item{i}")
        out.append((r.status, r.text, r.decision.decision, r.decision.code, list(r.decision.floors), r.approval_id))
    return out


def rows(services):
    keep = ("status", "router_decision", "router_reason", "tagged_text", "topics", "blocked", "request", "shown_form")
    return [{k: r.get(k) for k in keep} for r in services.approvals.history(limit=100)]


@pytest.fixture
def runs(tmp_path):
    made = {}
    for name, candidate in (("enforce", None), ("loose", LOOSE), ("strict", STRICT)):
        egress, services = build(tmp_path, name, candidate)
        made[name] = (release_all(egress), rows(services), services)
    yield made
    for _, _, services in made.values():
        services.approvals.close()


def test_enforce_is_unchanged_with_no_candidate(runs):
    """With no OBSERVE_POLICY nothing is written, and the results are the enforced policy's."""
    results, _, services = runs["enforce"]
    assert not (services.settings.home / observe.LOG_NAME).exists()
    assert [r[0] for r in results] == ["shared", "waiting", "refused", "refused", "refused", "waiting"]


@pytest.mark.parametrize("name", ["loose", "strict"])
def test_observe_changes_nothing_muse_gets_or_the_decision_rows(runs, name):
    results, decision_rows, _ = runs[name]
    base_results, base_rows, _ = runs["enforce"]
    assert results == base_results
    assert decision_rows == base_rows


def test_observe_never_sends_what_enforce_keeps_or_asks_about(runs):
    """The loose candidate would share four results the enforced policy keeps or asks about;
    observe logs that and sends none of them. The phone number stays an ask under any policy:
    the identifier floor is code, not policy."""
    results, _, services = runs["loose"]
    lines = observe.read_log(services.settings.home / observe.LOG_NAME)
    assert len(lines) == len(CASES)
    for line, (status, _text, decision, *_rest) in zip(lines, results, strict=True):
        assert line["enforced"] == decision
        if decision != "share_tagged":
            assert status != "shared"
    assert [x["candidate_decision"] for x in lines] == ["share_tagged"] * 5 + ["ask_user"]
    assert [x["would_allow"] for x in lines] == [False, True, True, True, True, False]
    assert lines[-1]["candidate_code"] == "identifier:phone"
    assert observe.totals(lines) == {
        "lines": 6, "different": 4, "stricter": 0, "looser": 4, "would_block": 0, "would_allow": 4,
    }  # fmt: skip
    for value in LEAKS:
        assert all(value not in r[1] for r in results)


def test_observe_logs_what_a_stricter_candidate_would_block(runs):
    _, _, services = runs["strict"]
    lines = observe.read_log(services.settings.home / observe.LOG_NAME)
    assert [x["candidate_decision"] for x in lines] == ["refuse"] * len(CASES)
    trip = lines[3]
    assert trip["candidate_code"].startswith("blocked:") and trip["enforced"] == "refuse"
    assert [x["would_block"] for x in lines] == [True, True, False, False, False, True]
    assert observe.totals(lines)["stricter"] == 3


def test_an_observe_line_holds_no_text(runs):
    _, _, services = runs["loose"]
    log = (services.settings.home / observe.LOG_NAME).read_text()
    for request, raw, _, _ in CASES:
        assert raw not in log and request not in log
    for value in [*LEAKS, "[Student A]", "[Phone 1]"]:
        assert value not in log
    assert set(json.loads(log.splitlines()[0])) == {
        "ts", "tool", "item_id", "result_kind", "candidate", "enforced", "enforced_code", "current_rules",
        "current_code", "candidate_decision", "candidate_code", "change", "would_block", "would_allow",
        "later_checks", "path",
    }


def test_a_result_a_later_check_held_is_never_counted_as_would_allow(tmp_path):
    """Prompt Guard (or a toggle) holds a result after the router and would hold it under the
    candidate too, so the loose candidate's rules-path share is not logged as would_allow."""
    flagged = SimpleNamespace(floors=["prompt_attack:request"], flagged_sources=[], request_flagged=True)
    scanner = SimpleNamespace(check=lambda sources, request: flagged)
    plain, plain_services = build(tmp_path, "pg_enforce", None, prompt_guard=scanner)
    watched, services = build(tmp_path, "pg_loose", LOOSE, prompt_guard=scanner)
    try:
        assert release_all(watched) == release_all(plain)
        lines = observe.read_log(services.settings.home / observe.LOG_NAME)
        assert len(lines) == len(CASES) and all(x["later_checks"] for x in lines)
        assert not any(x["would_allow"] for x in lines)
        assert [x["candidate_decision"] for x in lines][:5] == ["share_tagged"] * 5  # what the rules path says
    finally:
        plain_services.approvals.close()
        services.approvals.close()


def test_a_broken_observe_step_changes_nothing(tmp_path, runs):
    egress, services = build(tmp_path, "broken", LOOSE)
    with mock.patch.object(observe, "rules_decision", side_effect=RuntimeError("boom")):
        results = release_all(egress)
    assert results == runs["enforce"][0]
    assert not (services.settings.home / observe.LOG_NAME).exists()
    services.approvals.close()


def test_the_candidate_never_calls_a_model():
    with pytest.raises(RuntimeError):
        observe._NoModel().chat_json([], {})


def test_policy_mode_parses_and_defaults_to_enforce():
    assert UserPolicy.from_dict(CURRENT).mode == "enforce"
    assert UserPolicy.from_dict(LOOSE).mode == "observe"
    with pytest.raises(PolicyError, match="mode"):
        UserPolicy.from_dict({**CURRENT, "mode": "shadow"})


def test_services_refuse_an_observe_policy_as_user_policy_and_an_enforce_one_as_candidate(tmp_path):
    """USER_POLICY must enforce, and OBSERVE_POLICY must say mode: observe."""
    import respx
    import yaml

    from base import config
    from eval import run_eval

    observe_file, enforce_file = tmp_path / "observe.yaml", tmp_path / "enforce.yaml"
    observe_file.write_text(yaml.safe_dump(LOOSE))
    enforce_file.write_text(yaml.safe_dump(CURRENT))

    def settings(**env):
        base = {"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(tmp_path), "BASE_DEVICE": "laptop",
                "DEVICE_ONLY": "1", "LIGHT_SERIAL": "", "HEAVY_QUEUE": "0"}  # fmt: skip
        with mock.patch.object(config, "read_dotenv", lambda path: {}):
            return config.load_settings({**base, **env})

    assert settings().observe_policy_path is None  # off unless set
    with respx.mock(assert_all_called=False):
        with pytest.raises(PolicyError, match="USER_POLICY must enforce"):
            run_eval.services_for(settings(USER_POLICY=str(observe_file)), tmp_path / "h1")
        with pytest.raises(PolicyError, match="mode: observe"):
            run_eval.services_for(settings(OBSERVE_POLICY=str(enforce_file)), tmp_path / "h2")
        services = run_eval.services_for(settings(OBSERVE_POLICY=str(observe_file)), tmp_path / "h3")
        try:
            assert services.observed_policy.mode == "observe" and services.policy.mode == "enforce"
        finally:
            services.close()
