import json
from pathlib import Path

import pytest

from base.policy import UserPolicy
from base.router import ROUTE_SCHEMA, TEXT_LIMIT, Router, build_user_message
from base.types import Hit, RouteInput

FIXTURE = Path(__file__).parent / "fixtures" / "policy_small.yaml"

# Invented values only.
NAME = "Odessa Quillfeather"
PHONE = "(512) 555-0143"
EMAIL = "guardian.q@example.org"


class FakeLLM:
    def __init__(self, reply=None, exc=None):
        self.reply = reply if reply is not None else {"decision": "share_tagged", "reason": "Looks fine."}
        self.exc = exc
        self.calls = []

    def chat_json(self, messages, schema, **kw):
        self.calls.append({"messages": messages, "schema": schema, "kw": kw})
        if self.exc is not None:
            raise self.exc
        return self.reply


class FakeParseError(Exception):
    pass


@pytest.fixture
def policy():
    return UserPolicy.load(FIXTURE)


def route_input(kind="per_student", text="[Student A] scored 3 of 4.", **kw):
    return RouteInput(request=kw.pop("request", "Show the scores"), result_kind=kind, tagged_text=text, **kw)


def make_router(settings, policy, llm, **kw):
    return Router(settings, llm, policy, **kw)


@pytest.mark.parametrize("kind", ["document_list", "dreaming_report"])
def test_rule_kinds_make_no_model_call(settings, policy, kind):
    llm = FakeLLM()
    out = make_router(settings, policy, llm).decide(route_input(kind=kind))
    assert out.decision == "share_tagged"
    assert out.source == "rule"
    assert llm.calls == []


def test_pre_approved_makes_no_model_call(settings, policy):
    llm = FakeLLM()
    out = make_router(settings, policy, llm).decide(route_input(kind="class_aggregate", text="Average 3.1"))
    assert out.decision == "share_summary"
    assert out.source == "rule"
    assert "class_averages" in out.reason
    assert llm.calls == []


def test_pre_approved_still_floors_identifiers(settings, policy):
    llm = FakeLLM()
    hits = [Hit("phone", PHONE, 0, len(PHONE))]
    out = make_router(settings, policy, llm).decide(route_input(kind="snippet", text="[Phone 1]", hits=hits))
    assert llm.calls == []
    assert out.decision == "ask_user"
    assert "identifier:phone" in out.floors


def test_blocked_skips_pre_approval_and_asks_model(settings, policy):
    llm = FakeLLM({"decision": "share_summary", "reason": "Class level."})
    inp = route_input(
        kind="class_aggregate", text="Two detentions this week.", topics=["discipline"], blocked=["Mentions discipline"]
    )
    out = make_router(settings, policy, llm).decide(inp)
    assert len(llm.calls) == 1
    # discipline is ask_first, so the floor is ask_user, not refuse
    assert out.decision == "ask_user"
    assert out.floors == ["ask_first:discipline"]
    assert out.source == "model"


def test_model_decision_and_call_shape(settings, policy):
    llm = FakeLLM({"decision": "share_tagged", "reason": "  Tagged scores only.\n "})
    out = make_router(settings, policy, llm, adapter="a1").decide(route_input(), synthetic=True)
    assert out.decision == "share_tagged"
    assert out.reason == "Tagged scores only."
    assert out.source == "model"
    assert out.floors == []
    call = llm.calls[0]
    assert call["kw"] == {"reasoning": "low", "max_tokens": 1500, "synthetic": True, "adapter": "a1"}
    assert call["schema"] is ROUTE_SCHEMA
    props = call["schema"]["schema"]["properties"]
    assert props["decision"]["enum"] == ["share_tagged", "share_summary", "ask_user", "refuse"]
    assert call["schema"]["strict"] is True


def test_synthetic_defaults_false(settings, policy):
    llm = FakeLLM()
    make_router(settings, policy, llm).decide(route_input())
    assert llm.calls[0]["kw"]["synthetic"] is False
    assert "adapter" not in llm.calls[0]["kw"]


def test_blocked_topic_floors_to_refuse(settings, policy):
    llm = FakeLLM({"decision": "share_tagged", "reason": "Fine."})
    inp = route_input(text="[Student A] has an IEP.", topics=["iep"], blocked=["Mentions an IEP or 504 plan"])
    out = make_router(settings, policy, llm).decide(inp)
    assert out.decision == "refuse"
    assert out.floors == ["blocked:iep"]
    assert out.reason == "Mentions an IEP or 504 plan."
    assert out.source == "model"


def test_blocked_reason_without_known_topic_refuses(settings, policy):
    out = make_router(settings, policy, FakeLLM()).decide(route_input(blocked=["Mentions something"]))
    assert out.decision == "refuse"
    assert out.floors == ["blocked"]


def test_mixed_ask_first_and_never_share_refuses(settings, policy):
    inp = route_input(topics=["discipline", "medical"], blocked=["Mentions discipline", "Mentions medical"])
    out = make_router(settings, policy, FakeLLM()).decide(inp)
    assert out.decision == "refuse"
    assert set(out.floors) == {"blocked:discipline", "blocked:medical"}


def test_never_share_topic_without_reason_still_floors(settings, policy):
    out = make_router(settings, policy, FakeLLM()).decide(route_input(topics=["medical"]))
    assert out.decision == "refuse"


def test_identifier_floor(settings, policy):
    llm = FakeLLM({"decision": "share_tagged", "reason": "Fine."})
    hits = [Hit("phone", PHONE, 0, 14), Hit("email", EMAIL, 20, 42), Hit("student", NAME, 50, 69)]
    out = make_router(settings, policy, llm).decide(route_input(text="[Phone 1] [Email 1] [Student A]", hits=hits))
    assert out.decision == "ask_user"
    assert out.floors == ["identifier:email", "identifier:phone"]
    assert out.reason == "Contains an email address, a phone number."


def test_names_alone_do_not_floor(settings, policy):
    hits = [Hit("student", NAME, 0, len(NAME))]
    out = make_router(settings, policy, FakeLLM()).decide(route_input(hits=hits))
    assert out.decision == "share_tagged"
    assert out.floors == []


def test_floor_never_loosens_a_stricter_model_answer(settings, policy):
    llm = FakeLLM({"decision": "refuse", "reason": "Too personal."})
    hits = [Hit("phone", PHONE, 0, 14)]
    out = make_router(settings, policy, llm).decide(route_input(hits=hits))
    assert out.decision == "refuse"
    assert out.reason == "Too personal."
    assert out.floors == ["identifier:phone"]


def test_parse_failure_falls_back_to_ask_user(settings, policy):
    out = make_router(settings, policy, FakeLLM(exc=FakeParseError("bad json"))).decide(route_input())
    assert out.decision == "ask_user"
    assert out.source == "fallback"


@pytest.mark.parametrize("reply", [{"decision": "share_everything", "reason": "x"}, {}, ["refuse"], "refuse"])
def test_invalid_model_reply_falls_back(settings, policy, reply):
    out = make_router(settings, policy, FakeLLM(reply)).decide(route_input())
    assert out.decision == "ask_user"
    assert out.source == "fallback"


def test_fallback_still_floors_blocked_topics(settings, policy):
    inp = route_input(topics=["iep"], blocked=["Mentions an IEP or 504 plan"])
    out = make_router(settings, policy, FakeLLM(exc=RuntimeError("down"))).decide(inp)
    assert out.decision == "refuse"
    assert out.source == "fallback"


def test_prompt_never_contains_raw_identifier_values(settings, policy):
    llm = FakeLLM()
    hits = [Hit("student", NAME, 0, 19), Hit("phone", PHONE, 30, 44), Hit("email", EMAIL, 50, 72)]
    # Values should already be tagged; plant them anyway to prove the prompt scrubs them.
    inp = route_input(
        request=f"Call {PHONE} about {NAME.upper()}",
        text=f"[Student A] can be reached at [Phone 1]. Backup: {EMAIL} or {NAME}.",
        hits=hits,
    )
    make_router(settings, policy, llm).decide(inp)
    dumped = json.dumps(llm.calls[0]["messages"]).lower()
    for value in (NAME, PHONE, EMAIL, "odessa", "quillfeather"):
        assert value.lower() not in dumped
    user = llm.calls[0]["messages"][1]["content"]
    assert "Found and tagged: email, phone, student" in user
    assert "[Student A]" in user


def test_user_message_lists_fields_and_truncates(policy):
    text = "x" * (TEXT_LIMIT + 400)
    inp = route_input(kind="free_text", text=text, topics=["grades"], blocked=["Mentions grades"])
    msg = build_user_message(inp)
    assert "Request: Show the scores" in msg
    assert "Result kind: free_text" in msg
    assert "Topics: grades" in msg
    assert "Blocked: Mentions grades" in msg
    assert "Found and tagged: none" in msg
    body = msg.split("Tagged text:\n", 1)[1]
    assert body == "x" * TEXT_LIMIT + " [truncated]"


def test_system_prompt_cold_start_and_rules_file(settings, policy):
    router = make_router(settings, policy, FakeLLM())
    prompt = router.system_prompt()
    for word in ("share_tagged", "share_summary", "ask_user", "refuse", "When unsure, pick ask_user"):
        assert word in prompt
    assert "Reasoning strength: low" in prompt
    assert prompt.endswith("This user's rules, learned from their decisions:\nNone yet.")
    assert "\u2014" not in prompt

    settings.paths.router_prompt.write_text("- Share class averages as a summary (12 approvals).\n")
    assert prompt != router.system_prompt()
    assert router.system_prompt().endswith("- Share class averages as a summary (12 approvals).")


def test_explicit_rules_text_wins(settings, policy):
    settings.paths.router_prompt.write_text("- from the file\n")
    router = make_router(settings, policy, FakeLLM(), rules_text="- candidate rule")
    assert router.system_prompt().endswith("- candidate rule")
    router.decide(route_input())
    assert "- candidate rule" in router.llm.calls[0]["messages"][0]["content"]


def test_latency_recorded(settings, policy):
    out = make_router(settings, policy, FakeLLM()).decide(route_input())
    assert out.latency_ms >= 0
