"""DEVICE_ONLY=1: every model is on this device, and nothing else can be reached."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
import respx

from base import guard
from base.config import load_settings
from base.egress import Egress
from base.guard import TagMap
from base.local_llm import LocalLLM
from base.policy import UserPolicy
from base.router import Router, checked_labels
from base.services import Services
from base.types import RouteDecision, RouteInput

CHECKER = "http://127.0.0.1:8083/v1"


def settings_for(tmp_path, **extra):
    root = tmp_path / "w"
    root.mkdir(exist_ok=True)
    return load_settings(
        {
            "BASE_HOME": str(tmp_path / "home"),
            "WORKSPACE_ROOT": str(root),
            "DEVICE_ONLY": "1",
            "GLIMMER_BACKEND": "openrouter",
            "OPENROUTER_API_KEY": "or-key",
            "JETSON_LFM_BASE": "https://gateway.example.org/v1",
            "JETSON_LFM_API_KEY": "gw-key",
            "META_API_KEY": "meta-key",
            "CHECKER_API_KEY": "local-key",
            **extra,
        }
    )


def test_every_model_is_the_local_one_and_no_remote_key_is_kept(tmp_path):
    s = settings_for(tmp_path)
    assert s.device_only and s.primary_model == "lfm" and s.checker_backend == "lfm"
    assert s.glimmer_backend == "llama_server" and not s.is_cloud_backend
    assert s.answer_url == s.router_url == s.checker_url == CHECKER
    assert s.answer_model == s.router_model == "lfm3-vl-2b"
    assert s.model_api_key == "local-key"
    assert not s.has_jetson_lfm and s.jetson_lfm_url is None and s.jetson_lfm_key is None and s.meta_api_key is None


def test_a_remote_checker_is_refused(tmp_path):
    with pytest.raises(ValueError, match="this device"):
        settings_for(tmp_path, CHECKER_URL="https://checker.example.org/v1")


def test_glimmer_is_allowed_only_on_this_device(tmp_path):
    with pytest.raises(ValueError, match="DEVICE_ONLY"):
        settings_for(tmp_path, PRIMARY_MODEL="glimmer")
    with pytest.raises(ValueError, match="DEVICE_ONLY"):
        settings_for(
            tmp_path, PRIMARY_MODEL="glimmer", GLIMMER_BACKEND="llama_server", ROUTER_URL="https://r.example.org/v1"
        )
    s = settings_for(tmp_path, PRIMARY_MODEL="glimmer", GLIMMER_BACKEND="llama_server")
    assert s.router_url == s.answer_url == "http://127.0.0.1:8081/v1"  # one copy of the model


def test_services_build_only_local_clients(tmp_path):
    svc = Services.create(settings_for(tmp_path), light=False, heavy=False, owner=False)
    try:
        for llm in (svc.answer_llm, svc.router_llm, svc.checker_llm):
            assert isinstance(llm, LocalLLM) and not llm.is_cloud and llm.base_url == CHECKER and llm.liquid
    finally:
        svc.close()


@respx.mock
def test_the_label_passes_use_liquid_sampling_on_the_local_server(tmp_path):
    route = respx.post(f"{CHECKER}/chat/completions").mock(
        return_value=httpx.Response(200, json={"choices": [{"message": {"content": '{"names": []}'}, "finish_reason": "stop"}]})
    )
    svc = Services.create(settings_for(tmp_path), light=False, heavy=False, owner=False)
    try:
        assert svc.checker_llm.llm_names("Some text.") == []
        body = route.calls[0].request.content.decode()
        assert "Reasoning strength" not in body and "reasoning_strength" not in body and "lfm3-vl-2b" in body
    finally:
        svc.close()


# the policy decides, not the model


class _NoModel:
    def chat_json(self, *_a, **_k):
        raise AssertionError("the router asked the model")


POLICY = UserPolicy.load(Path(__file__).parent.parent / "eval" / "user_policy.yaml")


def _route(tmp_path, request, text, kind="snippet", topics=(), rules=""):
    router = Router(settings_for(tmp_path), _NoModel(), POLICY, rules_text=rules)
    return router.decide(RouteInput(request, kind, text, topics=list(topics)))


def test_the_policy_decides_without_a_model_call(tmp_path):
    out = _route(tmp_path, "grades for my records", "[Student A] scored 88.", "per_student", ["grades"])
    assert out.decision == "share_tagged" and out.source == "rule" and not out.floors
    out = _route(tmp_path, "class spread for my notes", "Scores ranged from 2 to 4.", "class_aggregate")
    assert out.decision == "share_summary"
    assert _route(tmp_path, "attendance for my notes", "[Student A] missed a day.").decision == "ask_user"


@pytest.mark.parametrize(
    ("request_text", "labels", "kept"),
    [
        ("How did [Student T] do on the essay?", ["full_text"], []),  # the model's usual mistake
        ("Give me the whole essay by [Student T]", ["full_text"], ["full_text"]),
        ("Which reading group is [Student W] in?", ["class_level"], []),
        ("What is the class average?", [], ["class_level"]),
        ("Send the average to the principal", ["third_party"], ["third_party", "class_level"]),
        ("Search for bees", ["iep"], ["iep"]),
    ],
)
def test_the_models_labels_are_checked_against_the_request(request_text, labels, kept):
    assert checked_labels(request_text, labels) == kept


@pytest.mark.parametrize(
    "text",
    ["Xyla Winterbourne scored 18 of 20.", "Zirconia got 8/10.", "We met Vosberg after class.", "Hello family of Urmond Pellwater, nice work."],
)
def test_a_name_the_model_misses_is_still_tagged(tmp_path, text):
    class Misses:
        def llm_names(self, *_a, **_k):
            return []

        def request_topics(self, *_a, **_k):
            return []

    svc = Services.create(settings_for(tmp_path), light=False, heavy=False, owner=False)
    try:
        svc.checker_llm = svc.answer_llm = Misses()
        out = Egress(svc).release("search_documents", "excerpts for me", text, "snippet")
        row = svc.approvals.history(limit=1)[0]
        assert "[Person 1]" in row["tagged_text"]
        for word in ("Xyla", "Winterbourne", "Zirconia", "Vosberg", "Urmond", "Pellwater"):
            assert word not in row["tagged_text"] and word not in out.text
    finally:
        svc.close()


def test_a_word_the_model_calls_a_person_is_not_remembered(tmp_path):
    tagmap = TagMap(None)
    out = guard.tag("Organization improved.", None, tagmap, llm_names=lambda _t: ["Organization"]).text
    assert out == "Organization improved." and "Organization" not in tagmap.as_dict().values()


@pytest.mark.parametrize(
    ("request_text", "floor"),
    [
        ("Share [Student C] home contact for the walk", "contact"),
        ("How to reach the family of [Student C]?", "contact"),
        ("Summarize the essay by the only student who moved here from Ohio", "narrowed"),
    ],
)
def test_contact_details_and_singling_out_are_refused(tmp_path, request_text, floor):
    out = _route(tmp_path, request_text, "Notes.")
    assert out.decision == "refuse" and floor in out.floors


RULES = """# Learned rules

## {section}

- Class-level results (kind: class_aggregate; topics: none): share tagged. You approved 2 of 2 and said don't ask again.
"""


def test_a_rule_you_taught_is_applied_with_no_model_and_can_skip_the_outside_check(tmp_path):
    rules = RULES.format(section="Your rules")
    out = _route(tmp_path, "Class numbers for my notes", "Scores rose.", "class_aggregate", rules=rules)
    assert out.decision == "share_tagged" and out.source == "rule"
    out = _route(tmp_path, "Send the numbers to the principal", "Scores rose.", "class_aggregate", rules=rules)
    assert out.decision == "share_tagged" and "outside_class" not in out.floors


def test_a_practice_default_does_not_replace_your_policy_or_skip_the_outside_check(tmp_path):
    rules = RULES.format(section="Practice defaults (only where you have not decided yet)")
    out = _route(tmp_path, "Class numbers for my notes", "Scores rose.", "class_aggregate", rules=rules)
    assert out.decision == "share_summary"  # the policy's class rule, not the practice default
    out = _route(tmp_path, "Send the numbers to the principal", "Scores rose.", "class_aggregate", rules=rules)
    assert out.decision == "ask_user" and "outside_class" in out.floors


class _Says:
    def __init__(self, decision=None):
        self.decision = decision
        self.calls = []

    def chat_json(self, *_a, **kw):
        self.calls.append(kw)
        if self.decision is None:
            raise RuntimeError("server down")
        return {"decision": self.decision, "reason": "the model's reason"}


def _with_mode(tmp_path, mode, says, request="grades for my records", text="[Student A] scored 88.", kind="per_student", strict=False, adapter=None, **env):
    router = Router(settings_for(tmp_path, **env), says, POLICY, rules_text="", adapter=adapter)
    router.choice = lambda: mode
    return router.decide(RouteInput(request, kind, text, topics=["grades"], strict=strict))


def test_stricter_only_lets_the_model_tighten_but_never_loosen(tmp_path):
    assert _with_mode(tmp_path, "tighten", _Says("refuse")).decision == "refuse"
    router = Router(settings_for(tmp_path), _Says("share_tagged"), POLICY, rules_text="")
    router.choice = lambda: "tighten"
    assert router.decide(RouteInput("seating chart", "snippet", "[Student A] sits here.")).decision == "ask_user"


def test_model_decides_can_loosen_within_the_floors(tmp_path):
    assert _with_mode(tmp_path, "decide", _Says("ask_user")).decision == "ask_user"
    router = Router(settings_for(tmp_path), _Says("share_tagged"), POLICY, rules_text="")
    router.choice = lambda: "decide"
    assert router.decide(RouteInput("seating chart", "snippet", "[Student A] sits here.")).decision == "share_tagged"
    out = router.decide(RouteInput("send it to the principal", "snippet", "Notes."))
    assert out.decision == "ask_user" and "outside_class" in out.floors


def test_a_compliance_toggle_stops_any_model_from_loosening(tmp_path):
    for mode in ("decide", "local_lora"):
        router = Router(settings_for(tmp_path, PRIMARY_MODEL="glimmer", GLIMMER_BACKEND="llama_server"), _Says("share_tagged"), POLICY, rules_text="", adapter=3)
        router.choice = lambda m=mode: m
        assert router.decide(RouteInput("seating chart", "snippet", "[Student A] sits here.", strict=True)).decision == "ask_user"
        assert router.llm.calls[-1].get("adapter") is None


def test_rules_mode_never_calls_the_model(tmp_path):
    says = _Says("refuse")
    assert _with_mode(tmp_path, "rules", says).decision == "share_tagged" and says.calls == []


def test_a_model_failure_keeps_the_fallback_mark_in_every_prompt_mode(tmp_path):
    for mode in ("tighten", "decide"):
        out = _with_mode(tmp_path, mode, _Says(None))
        assert out.decision == "ask_user" and out.source == "fallback"


def test_the_adapter_is_only_used_in_local_fine_tune_mode(tmp_path):
    env = {"PRIMARY_MODEL": "glimmer", "GLIMMER_BACKEND": "llama_server"}
    says = _Says("share_tagged")
    _with_mode(tmp_path, "local_lora", says, adapter=3, **env)
    assert says.calls[-1]["adapter"] == 3
    _with_mode(tmp_path, "decide", says, adapter=3, **env)
    assert "adapter" not in says.calls[-1]


def test_local_fine_tune_falls_back_to_rules_on_lfm(tmp_path):
    says = _Says("share_tagged")
    assert _with_mode(tmp_path, "local_lora", says).source == "rule" and says.calls == []


@pytest.mark.parametrize(
    ("env", "match"),
    [
        ({"DREAMING_BACKEND": "lora"}, "cloud"),
        ({"DREAMING_BACKEND": "local_lora"}, "trains Glimmer"),
        ({"DREAMING_BACKEND": "bogus"}, "DREAMING_BACKEND"),
        ({"ROUTER_TRUST": "bogus"}, "ROUTER_TRUST"),
    ],
)
def test_bad_learning_settings_are_refused(tmp_path, env, match):
    with pytest.raises(ValueError, match=match):
        settings_for(tmp_path, **env)


def test_a_stray_word_does_not_make_attendance_shareable(tmp_path):
    assert _route(tmp_path, "List absences during the essay unit for [Student C]", "Two absences.").decision == "ask_user"


def test_a_class_level_question_reaches_the_class_rule(tmp_path):
    out = _route(tmp_path, "Median and range of the total scores.", "Scores ranged from 2 to 4.", "free_text", ["class_level"])
    assert out.decision == "share_summary"


def test_excerpts_reach_the_excerpts_rule_without_a_label(tmp_path):
    assert _route(tmp_path, "Find essay excerpts about bees.", "[Student A] wrote about bees.").decision == "share_tagged"


def test_a_summary_loses_sentences_that_name_someone(tmp_path):
    class Writes:
        def chat(self, *_a, **_k):
            return type("R", (), {"content": "The class improved. [Student A] improved most. Spelling is next."})()

        def llm_names(self, *_a, **_k):
            return []

        def request_topics(self, *_a, **_k):
            return []

    svc = Services.create(settings_for(tmp_path), light=False, heavy=False, owner=False)
    try:
        svc.checker_llm = svc.answer_llm = Writes()
        out = Egress(svc).release("search_documents", "What is the class average?", "[Student A] scored 3.", "free_text")
        assert out.status == "shared" and "[Student A]" not in out.text and "The class improved. Spelling is next." in out.text
    finally:
        svc.close()


@pytest.mark.parametrize(
    "request_text",
    ["Write this up for the family newsletter", "send it to the principal", "for a parent email"],
)
def test_what_is_going_outside_the_class_waits_even_when_the_label_is_missed(tmp_path, request_text):
    out = _route(tmp_path, request_text, "Most of the class improved.", "class_aggregate")
    assert out.decision == "ask_user" and "outside_class" in out.floors


def test_a_sensitive_record_stays_on_the_device(tmp_path):
    out = _route(tmp_path, "notes for me", "Notes.", "sensitive_record")
    assert out.decision == "refuse" and "sensitive_record" in out.floors


def test_never_share_topics_still_refuse(tmp_path):
    assert _route(tmp_path, "notes for me", "Notes.", "snippet", ["iep"]).decision == "refuse"


def test_the_policy_only_decides_in_device_only_mode(tmp_path):
    class Says:
        def chat_json(self, *_a, **_k):
            return {"decision": "ask_user", "reason": "the model's reason"}

    s = load_settings({"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(tmp_path), "OPENROUTER_API_KEY": "k"})
    out = Router(s, Says(), POLICY, rules_text="").decide(
        RouteInput("grades for me", "per_student", "[Student A] scored 88.", topics=["grades"]), synthetic=True
    )
    assert out.decision == "ask_user" and out.source == "model"


# Always approve


def test_always_approve_does_not_share_what_the_router_could_not_judge(tmp_path):
    class Broken:
        def llm_names(self, *_a, **_k):
            return []

    class Unsure:
        def decide(self, *_a, **_k):
            return RouteDecision("ask_user", "could not decide", "fallback")

    svc = Services.create(settings_for(tmp_path), light=False, heavy=False, owner=False)
    try:
        svc.router = Unsure()
        svc.checker_llm = svc.answer_llm = Broken()
        svc.settings.paths.auto_approve.write_text("on\n")
        out = Egress(svc).release("search_documents", "a question", "Plain class notes about tide pools.", "snippet")
        assert out.status == "waiting" and out.decision.source == "fallback"
    finally:
        svc.close()


class _NoLabels:
    def llm_names(self, *_a, **_k):
        return []

    def request_topics(self, *_a, **_k):
        return []


@pytest.fixture
def auto_on(tmp_path):
    """Device-only services with Always approve on and the real router (rules mode, no model)."""
    from base.approvals import AutoApprove

    svc = Services.create(settings_for(tmp_path), light=False, heavy=False, owner=False)
    svc.checker_llm = svc.answer_llm = _NoLabels()
    AutoApprove(svc.settings.paths.auto_approve).set(True)
    yield svc
    svc.close()


@pytest.mark.parametrize(
    ("request_text", "raw", "kind", "floor"),
    [
        ("Which students have an IEP?", "- Abigail Thornbury essay\n- Benjamin Adeyemi essay", "document_list", "request:iep"),
        ("Find essay excerpts about bees.", "Abigail Thornbury wrote about bees. Call 512-555-0143.", "snippet", "identifier:phone"),
        ("Summarize the class scores to send to the principal", "Most of the class improved.", "class_aggregate", "outside_class"),
    ],
)
def test_always_approve_leaves_these_cards_for_you(auto_on, request_text, raw, kind, floor):
    out = Egress(auto_on).release("search_documents", request_text, raw, kind, summary="Most of the class improved.")
    assert out.status == "waiting" and floor in out.decision.floors
    assert [r["decided_by"] for r in auto_on.approvals.pending()] == [None]


def test_always_approve_shares_a_plain_policy_ask(auto_on):
    out = Egress(auto_on).release("search_documents", "attendance for my notes", "Abigail Thornbury missed a day.", "snippet")
    assert out.decision.decision == "ask_user" and not out.decision.floors
    assert out.status == "shared" and "Abigail" not in out.text
    assert auto_on.approvals.history(limit=1)[0]["decided_by"] == "auto_approve"


def test_always_approve_turned_on_9_hours_ago_is_off(auto_on):
    import time

    path = auto_on.settings.paths.auto_approve
    path.write_text(f"on since 2026-10-30 08:00\nstarted {int(time.time() - 9 * 3600)}\n")
    out = Egress(auto_on).release("search_documents", "attendance for my notes", "Abigail Thornbury missed a day.", "snippet")
    assert out.status == "waiting" and not path.exists()


# the network (the loopback_only guard is in tests/conftest.py)


def test_a_release_with_every_model_down_stays_on_this_device(tmp_path, loopback_only):
    """No server listens on the local ports, so each model call fails: the result is held, and
    nothing tries another address."""
    svc = Services.create(settings_for(tmp_path, CHECKER_URL="http://127.0.0.1:9/v1"), light=False, heavy=False, owner=False)
    try:
        out = Egress(svc).release("search_documents", "a question", "Plain class notes about tide pools.", "snippet")
        assert out.status == "refused" and "tide pools" not in (out.text or "")
    finally:
        svc.close()


def test_the_loopback_guard_works(loopback_only):
    with pytest.raises((AssertionError, pytest.fail.Exception)):
        httpx.get("https://gateway.example.org/v1", timeout=1)

