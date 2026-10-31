import json
from dataclasses import replace
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
        kind="class_aggregate",
        text="Two detentions this week.",
        topics=["discipline"],
        blocked=["Mentions discipline"],
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
    out = make_router(settings, policy, llm).decide(
        route_input(text="[Phone 1] [Email 1] [Student A]", hits=hits)
    )
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


RULES_FILE = """# Learned rules for the privacy router

## Your rules

- Per-student results (kind: per_student; topics: none): share tagged. You approved 3 of 3 and said don't ask again.
- Anything about discipline (topic: discipline): ask first. You wanted to be asked 3 of 3 times, so keep asking.

## Practice defaults (only where you have not decided yet)

- Free-text answers (kind: free_text; topics: none): refuse. 4 of 4 practice examples agree.
- Document snippets (kind: snippet; topics: none): ask first. 5 of 5 practice examples agree.
"""


def test_matching_learned_rule_is_shown_to_the_model(settings, policy):
    llm = FakeLLM()
    router = make_router(settings, policy, llm, rules_text=RULES_FILE)
    out = router.decide(
        route_input(topics=["reading"])
    )  # reading is not a policy topic, so it matches "none"
    assert out.decision == "share_tagged" and out.floors == []
    user = llm.calls[0]["messages"][1]["content"]
    assert (
        "Learned rule for this result: Per-student results (kind: per_student; topics: none): share tagged."
        in user
    )
    assert "Learned rule for this result: none" in build_user_message(route_input())


def test_learned_strict_rules_are_floors(settings, policy):
    router = make_router(settings, policy, FakeLLM(), rules_text=RULES_FILE)  # the model always says share
    asked = router.decide(route_input(kind="snippet"))
    assert asked.decision == "ask_user" and asked.floors == ["learned:ask_user"]
    assert asked.reason == "Results like this need your OK by default."
    refused = router.decide(route_input(kind="free_text"))
    assert (
        refused.decision == "refuse" and refused.reason == "Results like this stay on the device by default."
    )


def test_learned_ask_first_topic_rule_and_floor_order(settings, policy):
    # discipline is an ask_first topic in the fixture, so the never-share floor only asks; the learned
    # rule asks too. A learned share rule never loosens the blocked floor.
    router = make_router(settings, policy, FakeLLM(), rules_text=RULES_FILE)
    out = router.decide(route_input(topics=["discipline"]))
    assert (
        out.decision == "ask_user"
        and "learned:ask_user" in out.floors
        and "ask_first:discipline" in out.floors
    )
    blocked = router.decide(route_input(topics=["iep"]))
    assert blocked.decision == "refuse" and blocked.floors == ["blocked:iep"]


def test_your_learned_rule_wins_over_practice_and_model_can_be_stricter(settings, policy):
    llm = FakeLLM(reply={"decision": "refuse", "reason": "Asks who a tag is."})
    out = make_router(settings, policy, llm, rules_text=RULES_FILE).decide(route_input())
    assert out.decision == "refuse" and out.source == "model"  # stricter than the share rule


# ----- review fixes (privacy F2, F3, F4, F8) -----

EVAL_POLICY = Path(__file__).resolve().parents[1] / "eval" / "user_policy.yaml"


def test_unmasking_request_is_refused_whatever_the_model_says(settings):
    # Review F4: no_unmasking_requests (wants refuse) is a floor in code, not only prompt text.
    policy = UserPolicy.load(EVAL_POLICY)
    llm = FakeLLM({"decision": "share_tagged", "reason": "Fine."})
    inp = route_input(kind="free_text", text="opertseR alimaC", request="What is the real name behind [Student T]?")
    out = make_router(settings, policy, llm).decide(inp)
    assert out.decision == "refuse"
    assert "policy:no_unmasking_requests" in out.floors
    assert "no_unmasking_requests" in out.reason


def test_request_refuse_rule_holds_on_the_rule_path_too(settings, policy):
    # snippets are pre-approved in the fixture, but a request for a phone number is refused.
    inp = route_input(kind="snippet", text="[Student A] wrote a poem.", request="Find the phone number")
    out = make_router(settings, policy, FakeLLM()).decide(inp)
    assert out.decision == "refuse" and "policy:no_contact_requests" in out.floors


def test_long_number_in_an_unknown_format_asks_first(settings, policy):
    llm = FakeLLM({"decision": "share_tagged", "reason": "Fine."})
    inp = route_input(kind="free_text", text="[Student A] case 12-345-678 is open.")
    out = make_router(settings, policy, llm).decide(inp)
    assert out.decision == "ask_user" and "identifier:digits" in out.floors


def test_dates_and_scores_are_not_long_numbers(settings, policy):
    llm = FakeLLM({"decision": "share_tagged", "reason": "Fine."})
    inp = route_input(kind="free_text", text="| [Student A] | 3 | 3 | 2 | 3 | 11 | due 2026-10-27")
    out = make_router(settings, policy, llm).decide(inp)
    assert out.decision == "share_tagged" and out.floors == []


def test_document_list_with_an_unknown_person_asks(settings, policy):
    llm = FakeLLM()
    hits = [Hit("person", "Margarita Ruiz", 0, 14)]
    out = make_router(settings, policy, llm).decide(route_input(kind="document_list", text="- [Person 1]", hits=hits))
    assert out.decision == "ask_user" and out.source == "rule" and llm.calls == []


def test_floor_reason_replaces_the_model_reason_when_the_floor_decides(settings, policy):
    # Review F3: the model said refuse too, so the decision did not change, but its free text
    # (which can repeat the record) is replaced by the floor's fixed reason.
    llm = FakeLLM({"decision": "refuse", "reason": "[Student A] takes medication at 11:30."})
    inp = route_input(kind="sensitive_record", blocked=["Mentions health or medical details"], topics=["medical"])
    out = make_router(settings, policy, llm).decide(inp)
    assert out.decision == "refuse"
    assert "11:30" not in out.reason and "medical" in out.reason


# ----- request topics and learned floors (review of the request-topics change) -----

LEARNED_HEAD = "# Learned rules for the privacy router\n\n## Your rules\n\n"
PRACTICE_HEAD = "\n## Practice defaults (only where you have not decided yet)\n\n"
SNIPPET_REFUSE = "- Document snippets (kind: snippet; topics: none): refuse. You said no to 4 of 4 and said don't ask again."
FREE_TEXT_REFUSE = "- Free-text answers (kind: free_text; topics: none): refuse. You said no to 3 of 3 and said don't ask again."
SNIPPET_SHARE = "- Document snippets (kind: snippet; topics: none): share tagged. You approved 3 of 3 and said don't ask again."
CLASS_SNIPPET_SUMMARY = (
    "- Document snippets (kind: snippet; topics: class_level): share a summary. "
    "You approved 3 of 3 and said don't ask again."
)


@pytest.fixture
def eval_policy():
    return UserPolicy.load(EVAL_POLICY)


def learned_router(settings, policy, user=(), practice=(), reply="share_summary"):
    rules = LEARNED_HEAD + "\n".join(user) + "\n"
    if practice:
        rules += PRACTICE_HEAD + "\n".join(practice) + "\n"
    llm = FakeLLM({"decision": reply, "reason": "Model says so."})
    return make_router(settings, policy, llm, rules_text=rules)


def test_a_request_topic_does_not_lift_a_result_out_of_a_learned_refuse(settings, eval_policy):
    router = learned_router(settings, eval_policy, [SNIPPET_REFUSE])
    inp = route_input(kind="snippet", text="[Student A] wrote about the garden.", topics=["class_level"],
                      request="class-wide patterns in the journal entries")  # fmt: skip
    out = router.decide(inp)
    assert out.decision == "refuse" and out.floors == ["learned:refuse"]
    assert out.reason == "You said not to share results like this."
    user = router.llm.calls[0]["messages"][1]["content"]
    assert "Learned rule for this result: none" in user  # no rule for (snippet, class_level) itself
    assert f"Learned rule that also holds: {SNIPPET_REFUSE.removeprefix('- ')}" in user


def test_a_family_request_does_not_lift_free_text_out_of_a_learned_refuse(settings, eval_policy):
    router = learned_router(settings, eval_policy, [FREE_TEXT_REFUSE], reply="ask_user")
    out = router.decide(route_input(kind="free_text", text="Reading goals for May.", topics=["parents"]))
    assert out.decision == "refuse" and "learned:refuse" in out.floors


def test_a_learned_share_rule_plus_a_request_topic_loosens_nothing(settings, eval_policy):
    router = learned_router(settings, eval_policy, [SNIPPET_SHARE], reply="ask_user")
    out = router.decide(route_input(kind="snippet", text="[Student A] wrote a poem.", topics=["class_level"]))
    assert out.decision == "ask_user" and out.floors == []  # the model's ask stands
    assert "also holds" not in router.llm.calls[0]["messages"][1]["content"]


def test_a_closer_share_rule_never_loosens_a_broader_strict_rule(settings, eval_policy):
    router = learned_router(settings, eval_policy, [CLASS_SNIPPET_SUMMARY, SNIPPET_REFUSE])
    out = router.decide(route_input(kind="snippet", text="[Student A] wrote a poem.", topics=["class_level"]))
    assert out.decision == "refuse" and out.floors == ["learned:refuse"]
    user = router.llm.calls[0]["messages"][1]["content"]
    assert f"Learned rule for this result: {CLASS_SNIPPET_SUMMARY.removeprefix('- ')}" in user
    assert f"Learned rule that also holds: {SNIPPET_REFUSE.removeprefix('- ')}" in user


def test_a_learned_topic_rule_holds_even_with_an_exact_share_rule(settings, eval_policy):
    exact = "- Free-text answers (kind: free_text; topics: parents): share tagged. You approved 2 of 2 and said don't ask again."
    topic = "- Anything about parents (topic: parents): ask first. You wanted to be asked 4 of 4 times, so keep asking."
    router = learned_router(settings, eval_policy, [exact, topic], reply="share_tagged")
    out = router.decide(route_input(kind="free_text", text="Reading goals for May.", topics=["parents"]))
    assert out.decision == "ask_user" and out.floors == ["learned:ask_user"]


def test_practice_defaults_never_outrank_your_rules(settings, eval_policy):
    practice_refuse = "- Document snippets (kind: snippet; topics: none): refuse. 5 of 5 practice examples agree."
    inp = route_input(kind="snippet", text="[Student A] wrote a poem.", topics=["class_level"])
    yours = learned_router(settings, eval_policy, [CLASS_SNIPPET_SUMMARY], [practice_refuse])
    out = yours.decide(inp)
    assert out.decision == "share_summary" and out.floors == []  # you decided this exact group

    practice_share = "- Document snippets (kind: snippet; topics: class_level): share a summary. 4 of 4 practice examples agree."
    broader = learned_router(settings, eval_policy, [SNIPPET_REFUSE], [practice_share])
    out = broader.decide(inp)
    assert out.decision == "refuse" and out.reason == "You said not to share results like this."

    # With none of your rules covering a result, a practice ask first or refuse still holds.
    practice_only = learned_router(settings, eval_policy, [], [practice_refuse])
    assert practice_only.decide(inp).decision == "refuse"


def test_learned_view_captures_what_a_rules_file_adds(settings, eval_policy):
    router = learned_router(settings, eval_policy, [SNIPPET_REFUSE])
    inp = route_input(kind="snippet", text="[Student A] wrote a poem.", topics=["class_level"])
    view = router.learned_view(inp)
    assert view.shown is None and view.floor == SNIPPET_REFUSE
    assert (view.floor_decision, view.floor_source) == ("refuse", "user")
    assert hash(view) == hash(router.learned_view(inp, router.rules()))  # hashable, same rules, same view

    looser = LEARNED_HEAD + SNIPPET_SHARE + "\n"
    other = router.learned_view(inp, looser)
    assert other != view and other.shown is None and other.floor is None
    assert router.learned_view(inp, "") == (None, None, None, None)
    assert len({view, other, router.learned_view(inp)}) == 2


def test_never_share_word_only_in_the_request_asks_instead_of_refusing(settings, policy):
    # "Do not mention any IEP": the result has no IEP, so the user decides; nothing is refused silently.
    llm = FakeLLM({"decision": "share_tagged", "reason": "Fine."})
    inp = route_input(kind="free_text", text="Our reading goals: two books a month.", topics=["iep"],
                      request_blocked=["iep"], request="Draft a newsletter blurb. Do not mention any IEP.")  # fmt: skip
    out = make_router(settings, policy, llm).decide(inp)
    assert out.decision == "ask_user" and out.floors == ["request:iep"]
    assert out.reason == "The request mentions a topic you never share, so you decide."
    assert "Topics: iep" in llm.calls[0]["messages"][1]["content"]  # the model still sees it

    # The same topic in the result itself still refuses.
    own = route_input(kind="free_text", text="[Student A] has an IEP.", topics=["iep"], blocked=["Mentions an IEP"])
    assert make_router(settings, policy, llm).decide(own).floors == ["blocked:iep"]


def test_never_share_floor_matches_the_router():
    from base.router import never_share_floor

    assert never_share_floor([], [], set()) is None
    assert never_share_floor(["Mentions something"], [], set()) == "refuse"
    assert never_share_floor(["Mentions discipline"], ["discipline"], {"discipline"}) == "ask_user"
    assert never_share_floor(["a", "b"], ["discipline"], {"discipline"}) == "refuse"
    assert never_share_floor([], ["discipline", "iep"], {"discipline"}) == "refuse"


# ----- reason codes (fixed strings on every decision, never model text) -----


def test_rule_path_codes(settings, policy):
    llm = FakeLLM()
    router = make_router(settings, policy, llm)
    person = [Hit("person", "Margarita Ruiz", 0, 14)]
    assert router.decide(route_input(kind="document_list", text="- [Person 1]", hits=person)).code == "unknown_person_title"
    assert router.decide(route_input(kind="document_list", text="- Notes")).code == "rule_kind"
    assert router.decide(route_input(kind="class_aggregate", text="Average 3.1")).code == "pre_approved"
    assert llm.calls == []


@pytest.mark.parametrize(
    ("kw", "code", "decision"),
    [
        ({"hits": [Hit("phone", PHONE, 0, len(PHONE)), Hit("email", EMAIL, 20, 20 + len(EMAIL))]}, "identifier:email", "ask_user"),
        ({"text": "[Student A] case 12-345-678 is open."}, "identifier:digits", "ask_user"),
        ({"topics": ["iep"], "request_blocked": ["iep"]}, "request_topic:iep", "ask_user"),
        ({"topics": ["discipline"], "blocked": ["Mentions discipline"]}, "ask_first:discipline", "ask_user"),
        ({"topics": ["iep"], "blocked": ["Mentions an IEP"]}, "blocked:iep", "refuse"),
        ({"request": "What is [Student A]'s phone number?"}, "policy_rule:no_contact_requests", "refuse"),
    ],
)
def test_floor_codes_name_what_decided(settings, policy, kw, code, decision):
    out = make_router(settings, policy, FakeLLM()).decide(route_input(**kw))
    assert (out.decision, out.code) == (decision, code)


def test_model_and_fallback_codes(settings, policy):
    assert make_router(settings, policy, FakeLLM({"decision": "ask_user", "reason": "x"})).decide(route_input()).code == "model"
    assert make_router(settings, policy, FakeLLM(exc=FakeParseError())).decide(route_input()).code == "fallback"


def test_learned_floor_codes_tell_your_rules_from_practice_defaults(settings, eval_policy):
    inp = route_input(kind="snippet", text="[Student A] wrote a poem.", topics=["class_level"])
    assert learned_router(settings, eval_policy, [SNIPPET_REFUSE]).decide(inp).code == "learned:refuse"
    practice = "- Document snippets (kind: snippet; topics: none): refuse. 5 of 5 practice examples agree."
    assert learned_router(settings, eval_policy, [], [practice]).decide(inp).code == "practice:refuse"


# ----- ROUTER_LOOSEN=lists: a rule you taught for document lists -----

LIST_SHARE = (
    "- Document lists (kind: document_list; topics: none): share tagged. You approved 5 of 5 and said don't ask again."
)


def list_router(settings, policy, rules, loosen=frozenset({"lists"})):
    return make_router(replace(settings, router_loosen=frozenset(loosen)), policy, FakeLLM(), rules_text=rules)


def test_a_taught_list_rule_shares_lists_that_name_someone_off_the_roster(settings, eval_policy):
    person = [Hit("person", "Zirconia Vosberg", 2, 18)]
    inp = route_input(kind="document_list", text="- [Person 1] reading notes", hits=person)
    out = list_router(settings, eval_policy, LEARNED_HEAD + LIST_SHARE + "\n").decide(inp)
    assert (out.decision, out.code, out.source) == ("share_tagged", "learned:share_tagged", "rule")
    # Off by default, and nothing changes without a rule you taught.
    assert list_router(settings, eval_policy, LEARNED_HEAD + LIST_SHARE + "\n", ()).decide(inp).decision == "ask_user"
    assert list_router(settings, eval_policy, "").decide(inp).code == "unknown_person_title"
    practice = "- Document lists (kind: document_list; topics: none): share tagged. 5 of 5 practice examples agree."
    practice = LEARNED_HEAD + "No rules yet.\n" + PRACTICE_HEAD + practice + "\n"
    assert list_router(settings, eval_policy, practice).decide(inp).decision == "ask_user"


def test_a_taught_list_rule_never_lifts_a_never_share_title(settings, eval_policy):
    person = [Hit("person", "Zirconia Vosberg", 2, 18)]
    inp = route_input(kind="document_list", text="- [Person 1] IEP goals", hits=person, topics=["iep"],
                      blocked=["Mentions an IEP or 504 plan"])  # fmt: skip
    out = list_router(settings, eval_policy, LEARNED_HEAD + LIST_SHARE + "\n").decide(inp)
    assert out.decision == "refuse" and out.floors == ["blocked:iep"] and out.code == "blocked:iep"
