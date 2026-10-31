import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from base import events
from base.approvals import ApprovalStore
from base.egress import HELD_TEXT, KEPT_DEFAULT, KEPT_TEXT, WAITING_TEXT, Egress, Released
from base.policy import UserPolicy
from base.router import Router
from base.types import Hit, RouteDecision, TagResult

FIXTURE = Path(__file__).parent / "fixtures" / "policy_small.yaml"

# Invented people and identifiers.
REPLACEMENTS = [
    ("Odessa Quillfeather", "[Student A]", "student"),
    ("Bram Tillery", "[Student B]", "student"),
    ("Odessa", "[Student A]", "student"),
    ("Bram", "[Student B]", "student"),
    ("512-555-0143", "[Phone 1]", "phone"),
    ("tillery.home@example.org", "[Email 1]", "email"),
]
NICKNAME = "Dessa"  # the fake tagger misses it; the fake leak check does not
LEAK_VALUES = [v for v, _, _ in REPLACEMENTS] + [NICKNAME]

RAW = "Odessa Quillfeather: 3 of 4, strong thesis.\nBram Tillery: 2 of 4, needs evidence."
TAGGED = "[Student A]: 3 of 4, strong thesis.\n[Student B]: 2 of 4, needs evidence."


def fake_tag(text, roster, tagmap, llm_names=None, never_share=None):
    out, hits, tag_map = text, [], {}
    for value, tag, kind in sorted(REPLACEMENTS, key=lambda r: len(r[0]), reverse=True):
        if value in out:
            start = text.find(value)
            hits.append(Hit(kind, value, start, start + len(value)))
            tag_map[tag] = value
            out = out.replace(value, tag)
    topics = [t for t, words in (never_share or {}).items() if any(w.lower() in text.lower() for w in words)]
    return TagResult(out, tag_map, hits, [f"Mentions {t}" for t in topics], topics)


def fake_leaks(text, roster, tagmap):
    return [Hit("student", v, text.find(v), text.find(v) + len(v)) for v in LEAK_VALUES if v in text]


class FakeRouter:
    def __init__(self, decision="share_tagged", reason="Router reason."):
        self.decision, self.reason = decision, reason
        self.inputs, self.kwargs = [], []

    def decide(self, inp, *, synthetic=False):
        self.inputs.append(inp)
        self.kwargs.append({"synthetic": synthetic})
        return RouteDecision(self.decision, self.reason, "model", 5, [])


class FakeAnswerLLM:
    def __init__(self, content="Class average 2.5 of 4. One essay met the bar."):
        self.content = content
        self.calls = []

    def chat(self, messages, **kw):
        self.calls.append({"messages": messages, "kw": kw})
        return SimpleNamespace(content=self.content)


class FakeLLM:
    def __init__(self, reply):
        self.reply = reply

    def chat_json(self, messages, schema, **kw):
        return self.reply


@pytest.fixture
def policy():
    return UserPolicy.load(FIXTURE)


@pytest.fixture
def seen():
    states = []
    unsubscribe = events.subscribe(lambda e: states.append(e.state))
    yield states
    unsubscribe()


@pytest.fixture
def make(tmp_path, policy):
    stores = []

    def build(decision="share_tagged", reason="Router reason.", router=None, **extra):
        store = ApprovalStore(tmp_path / f"base{len(stores)}.db")
        stores.append(store)
        audits = []
        services = SimpleNamespace(
            roster="ROSTER",
            tagmap="TAGMAP",
            policy=policy,
            router=router or FakeRouter(decision, reason),
            approvals=store,
            answer_llm=FakeAnswerLLM(),
            audit=lambda tool, outcome: audits.append((tool, outcome)),
            audits=audits,
            settings=None,
        )
        for key, value in extra.items():
            setattr(services, key, value)
        guard = SimpleNamespace(tag=fake_tag, leaks=fake_leaks)
        return Egress(services, guard=guard), services

    yield build
    for store in stores:
        store.close()


def assert_clean(released: Released, raw: str = RAW):
    """Nothing returned carries the raw text or any real value."""
    assert raw not in released.text
    assert raw not in repr(released)
    for value in LEAK_VALUES:
        assert value not in released.text
        assert value not in repr(released)


def all_rows_text(store):
    return json.dumps([store.get(r["id"]) for r in store.history(limit=1000)])


def test_share_tagged(make, seen):
    egress, svc = make("share_tagged")
    out = egress.release("get_result", "Scores please", RAW, "per_student", job_id="j1", topics=["grades"])
    assert out.status == "shared"
    assert out.text == TAGGED
    assert out.approval_id is None
    assert_clean(out)
    assert "sending" in seen
    row = svc.approvals.history()[0]
    assert row["status"] == "auto"
    assert row["tagged_text"] == TAGGED
    assert row["topics"] == ["grades"]
    # the router only ever sees tagged text
    inp = svc.router.inputs[0]
    assert inp.tagged_text == TAGGED
    assert {h.kind for h in inp.hits} == {"student"}


def test_share_summary_uses_provided_summary(make):
    egress, svc = make("share_summary")
    summary = "Class average 2.5 of 4. Half the essays met the bar."
    out = egress.release("get_result", "How did the class do?", RAW, "class_aggregate", summary=summary)
    assert out.status == "shared"
    assert out.text == summary
    assert svc.answer_llm.calls == []
    assert_clean(out)
    assert svc.approvals.history()[0]["tagged_text"] == summary


def test_share_summary_made_by_answer_model_from_tagged_text(make):
    egress, svc = make("share_summary")
    svc.answer_llm = FakeAnswerLLM("Average 2.5 of 4 across 2 essays. Evidence was the common gap.")
    out = egress.release("get_result", "Summarize", RAW, "per_student", synthetic=True)
    assert out.status == "shared"
    assert out.text.startswith("Average 2.5")
    call = svc.answer_llm.calls[0]
    sent = json.dumps(call["messages"])
    assert TAGGED.split("\n")[0] in json.loads(sent)[1]["content"]
    for value in LEAK_VALUES:
        assert value not in sent
    assert call["kw"]["synthetic"] is True
    assert call["kw"]["reasoning"] == "low"


def test_summary_that_names_a_student_is_refused(make):
    egress, _ = make("share_summary")
    out = egress.release("get_result", "Summarize", RAW, "class_aggregate", summary="Bram had the top score.")
    assert out.status == "refused"
    assert out.text.startswith(KEPT_TEXT)
    assert out.decision.decision == "refuse"
    assert_clean(out)


def test_ask_user_waits_and_records_pending(make, seen):
    egress, svc = make("ask_user", "Per-student scores.")
    out = egress.release("get_result", "Scores please", RAW, "per_student", job_id="j2", item_id="t007", day=4)
    assert out.status == "waiting"
    assert out.text == WAITING_TEXT
    assert out.approval_id is not None
    assert "waiting" in seen and "sending" not in seen
    row = svc.approvals.get(out.approval_id)
    assert row["status"] == "pending"
    assert row["shown_form"] == "share_tagged"
    assert row["tagged_text"] == TAGGED
    assert row["router_reason"] == "Per-student scores."
    assert (row["job_id"], row["item_id"], row["day"]) == ("j2", "t007", 4)
    assert_clean(out)


def test_ask_user_on_aggregate_stores_the_summary_it_would_share(make):
    egress, svc = make("ask_user")
    out = egress.release("get_result", "Class?", RAW, "class_aggregate", summary="Average 2.5 of 4.")
    row = svc.approvals.get(out.approval_id)
    assert row["shown_form"] == "share_summary"
    assert row["tagged_text"] == "Average 2.5 of 4."


def test_refuse_sends_a_fixed_sentence_never_the_router_reason(make, seen):
    # Review F3: the model's reason can spell out the record, so it stays on the approval page.
    egress, svc = make("refuse", "[Student A] takes medication at 11:30 with the nurse.")
    out = egress.release("get_result", "Notes", RAW + " IEP review.", "sensitive_record")
    assert out.status == "refused"
    assert out.text == f"{KEPT_TEXT} {KEPT_DEFAULT}"
    assert "medication" not in out.text and "3 of 4" not in out.text
    assert "medication" in svc.approvals.history()[0]["router_reason"]  # kept locally
    assert "sending" not in seen
    assert svc.approvals.history()[0]["status"] == "auto"
    assert_clean(out, RAW + " IEP review.")


def test_final_check_catches_planted_name_in_summary(make, seen):
    egress, svc = make("share_summary")
    planted = f"Class average 2.5 of 4. {NICKNAME} wrote the longest essay."
    out = egress.release("get_result", "Class?", RAW, "class_aggregate", summary=planted)
    assert out.status == "refused"
    assert out.text == HELD_TEXT
    assert svc.audits == [("egress", "egress_blocked")]
    assert "sending" not in seen
    assert NICKNAME not in out.text


def test_final_check_fails_closed(make):
    egress, svc = make("share_tagged")

    def broken(*a, **k):
        raise RuntimeError("guard down")

    egress.guard = SimpleNamespace(tag=fake_tag, leaks=broken)
    out = egress.release("get_result", "Scores", RAW, "per_student")
    assert (out.status, out.text) == ("refused", HELD_TEXT)
    assert svc.audits == [("egress", "egress_blocked")]


def test_no_audit_attribute_is_fine(make):
    egress, svc = make("share_summary")
    del svc.audit
    out = egress.release("get_result", "Class?", RAW, "class_aggregate", summary=f"{NICKNAME} led.")
    assert out.text == HELD_TEXT


def test_resolve_after_approve(make, seen):
    egress, svc = make("ask_user")
    first = egress.release("get_result", "Scores", RAW, "per_student")
    assert egress.resolve(first.approval_id).status == "waiting"
    svc.approvals.decide(first.approval_id, approve=True, remember=True)
    seen.clear()
    out = egress.resolve(first.approval_id)
    assert out.status == "shared"
    assert out.text == TAGGED
    assert out.approval_id == first.approval_id
    assert "sending" in seen
    assert_clean(out)


def test_resolve_after_deny(make):
    egress, svc = make("ask_user")
    first = egress.release("get_result", "Scores", RAW, "per_student")
    svc.approvals.decide(first.approval_id, approve=False)
    out = egress.resolve(first.approval_id)
    assert (out.status, out.text) == ("refused", KEPT_TEXT)


def test_resolve_pending_missing_and_deleted(make):
    egress, svc = make("ask_user")
    first = egress.release("get_result", "Scores", RAW, "per_student")
    out = egress.resolve(first.approval_id)
    assert (out.status, out.text) == ("waiting", WAITING_TEXT)
    assert egress.resolve(9999).text == KEPT_TEXT
    svc.approvals.delete(first.approval_id)
    assert egress.resolve(first.approval_id).status == "refused"


def test_resolve_runs_final_check(make):
    egress, svc = make("ask_user")
    first = egress.release("get_result", "Scores", RAW, "per_student")
    # tamper with the stored text to prove resolve checks it again
    with svc.approvals._lock, svc.approvals._conn:
        svc.approvals._conn.execute("UPDATE decisions SET tagged_text = ? WHERE id = ?", ("Bram: 2", first.approval_id))
    svc.approvals.decide(first.approval_id, approve=True)
    out = egress.resolve(first.approval_id)
    assert (out.status, out.text) == ("refused", HELD_TEXT)
    assert svc.audits == [("egress", "egress_blocked")]


@pytest.mark.parametrize("decision", ["share_tagged", "share_summary", "ask_user", "refuse"])
def test_raw_text_never_returned_or_stored(make, decision):
    egress, svc = make(decision, "Reason with no content.")
    raw = RAW + "\nCall 512-555-0143 or tillery.home@example.org."
    out = egress.release("get_result", "Everything", raw, "per_student", summary="Average 2.5 of 4.")
    assert_clean(out, raw)
    if out.approval_id:
        svc.approvals.decide(out.approval_id, approve=True)
        assert_clean(egress.resolve(out.approval_id), raw)
    stored = all_rows_text(svc.approvals)
    for value in LEAK_VALUES:
        assert value not in stored


def test_topics_merge_and_synthetic_derivation(make, tmp_path):
    egress, svc = make("share_tagged")
    egress.release("get_result", "x", RAW + " allergy note", "per_student", topics=["grades"])
    assert svc.router.inputs[0].topics == ["grades", "medical"]
    assert svc.router.inputs[0].blocked == ["Mentions medical"]
    assert svc.router.kwargs[0]["synthetic"] is False

    marked = tmp_path / "ws"
    marked.mkdir()
    svc.settings = SimpleNamespace(is_cloud_backend=True, glimmer_backend="openrouter", workspace_root=marked)
    egress.release("get_result", "x", RAW, "per_student")
    assert svc.router.kwargs[-1]["synthetic"] is False  # not marked yet
    (marked / ".synthetic").write_text("")
    egress.release("get_result", "x", RAW, "per_student")
    assert svc.router.kwargs[-1]["synthetic"] is True
    egress.release("get_result", "x", RAW, "per_student", synthetic=False)
    assert svc.router.kwargs[-1]["synthetic"] is False


def test_with_real_router_identifier_floor_waits(make, settings, policy):
    router = Router(settings, FakeLLM({"decision": "share_tagged", "reason": "Fine."}), policy)
    egress, svc = make(router=router)
    out = egress.release("get_result", "Contacts", "Bram Tillery: 512-555-0143", "contact_info")
    assert out.status == "waiting"
    assert "identifier:phone" in out.decision.floors
    assert svc.approvals.get(out.approval_id)["tagged_text"] == "[Student B]: [Phone 1]"


def test_with_real_router_blocked_topic_refuses(make, settings, policy):
    router = Router(settings, FakeLLM({"decision": "share_tagged", "reason": "Fine."}), policy)
    egress, _ = make(router=router)
    out = egress.release("get_result", "Notes", "Odessa has an IEP meeting Friday.", "sensitive_record")
    assert out.status == "refused"
    assert out.text == f"{KEPT_TEXT} It mentions a topic you never share."
    assert_clean(out, "Odessa has an IEP meeting Friday.")


def test_with_real_router_document_list_shares_tagged_titles(make, settings, policy):
    llm = FakeLLM({"decision": "refuse", "reason": "unused"})
    egress, _ = make(router=Router(settings, llm, policy))
    out = egress.release("list_documents", "essays", "Odessa Quillfeather essay.md\nrubric.md", "document_list")
    assert out.status == "shared"
    assert out.text == "[Student A] essay.md\nrubric.md"


# The answer model's second pass for names the roster misses


class NamesLLM(FakeAnswerLLM):
    """An answer model whose llm_names finds one non-roster name, or breaks."""

    def __init__(self, names=("Keoni",), fail=False):
        super().__init__()
        self.names, self.fail = list(names), fail
        self.name_calls = []

    def llm_names(self, text, *, synthetic=False):
        self.name_calls.append({"text": text, "synthetic": synthetic})
        if self.fail:
            raise RuntimeError("model unavailable")
        return [n for n in self.names if n in text]


def tag_with_names(text, roster, tagmap, llm_names=None, never_share=None):
    """fake_tag plus the second pass: names llm_names returns become [Person N]."""
    result = fake_tag(text, roster, tagmap, never_share=never_share)
    for i, name in enumerate(llm_names(text) if llm_names else [], 1):
        result.text = result.text.replace(name, f"[Person {i}]")
        result.hits.append(Hit("person", name, 0, len(name)))
    return result


def names_egress(make, decision="share_tagged", **llm):
    egress, svc = make(decision)
    svc.answer_llm = NamesLLM(**llm)
    egress.guard = SimpleNamespace(tag=tag_with_names, leaks=fake_leaks)
    return egress, svc


def test_second_pass_tags_names_the_roster_missed(make):
    egress, svc = names_egress(make)
    raw = RAW + "\nOdessa's uncle Keoni grows taro."
    out = egress.release("get_result", "Scores please", raw, "per_student", synthetic=True)
    assert out.status == "shared"
    assert "Keoni" not in out.text and "[Person 1]" in out.text
    assert svc.answer_llm.name_calls == [{"text": raw, "synthetic": True}]


def test_second_pass_follows_the_synthetic_flag(make):
    egress, svc = names_egress(make)
    egress.release("get_result", "Scores please", RAW, "per_student", synthetic=False)
    assert svc.answer_llm.name_calls[0]["synthetic"] is False


def test_no_second_pass_for_device_built_numbers(make):
    egress, svc = names_egress(make)
    out = egress.release("dreaming_report", "report", "Last run: 3 of 4 kept", "dreaming_report", synthetic=True)
    assert out.status == "shared"
    assert svc.answer_llm.name_calls == []


def test_document_lists_get_the_second_pass(make):
    # Review F2: titles are first headings and paths are file names, both written by people.
    egress, svc = names_egress(make, names=["Margarita Ruiz"])
    raw = "- Call with Margarita Ruiz (notes/call.md)"
    out = egress.release("list_documents", "list", raw, "document_list", synthetic=True)
    assert svc.answer_llm.name_calls == [{"text": raw, "synthetic": True}]
    assert "Margarita" not in out.text


def test_real_router_asks_before_listing_a_title_with_an_unknown_person(make, settings, policy):
    router = Router(settings, FakeLLM({"decision": "share_tagged", "reason": "unused"}), policy)
    egress, svc = make(router=router)
    svc.answer_llm = NamesLLM(names=["Margarita Ruiz"])
    egress.guard = SimpleNamespace(tag=tag_with_names, leaks=fake_leaks)
    out = egress.release("list_documents", "list", "- Call with Margarita Ruiz (notes/call.md)", "document_list")
    assert out.status == "waiting"
    assert "Margarita" not in svc.approvals.pending()[0]["tagged_text"]


def test_request_is_tagged_before_it_is_stored(make):
    egress, svc = make("ask_user")
    egress.release("get_result", "Scores for Odessa Quillfeather, cell 512-555-0143", RAW, "per_student")
    row = svc.approvals.pending()[0]
    assert "Odessa" not in row["request"] and "0143" not in row["request"]
    assert "[Student A]" in row["request"]


def test_second_pass_failure_holds_the_result(make):
    egress, svc = names_egress(make, fail=True)
    out = egress.release("get_result", "Scores please", RAW, "per_student", synthetic=True)
    assert out.status == "refused" and out.text == HELD_TEXT
    assert out.retryable  # nothing was decided, so the connector can try again later
    assert out.decision.decision == "refuse" and out.decision.floors == ["name_check"]
    assert svc.audits == [("egress", "name_check_failed")]
    assert svc.router.inputs == []  # nothing was routed
    assert svc.approvals.history() == []
    assert_clean(out)


def test_second_pass_runs_on_a_provided_summary(make):
    egress, svc = names_egress(make, "share_summary")
    summary = "Class average 2.5 of 4. Keoni visited the garden."
    out = egress.release("get_result", "How did we do?", RAW, "class_aggregate", summary=summary, synthetic=True)
    assert out.status == "refused"  # the summary named a person, so nothing per-person leaves
    assert "Keoni" not in out.text
    assert [c["text"] for c in svc.answer_llm.name_calls] == [RAW, summary]


def test_blocked_reasons_are_stored_on_the_decision_row(make):
    egress, svc = make("ask_user")
    raw = "Bram Tillery has an IEP meeting Friday."
    out = egress.release("get_result", "Calendar", raw, "free_text")
    assert svc.approvals.get(out.approval_id)["blocked"] == ["Mentions iep"]  # fake_tag's wording
    plain = egress.release("get_result", "Scores", RAW, "per_student")
    assert svc.approvals.get(plain.approval_id)["blocked"] == []


class TopicLLM(FakeAnswerLLM):
    def __init__(self, topics=(), fail=False):
        super().__init__()
        self.topics, self.fail, self.calls = list(topics), fail, []

    def request_topics(self, request, topics, *, synthetic=False):
        self.calls.append((request, dict(topics)))
        if self.fail:
            raise RuntimeError("model down")
        return [t for t in self.topics if t in topics]


@pytest.fixture
def topic_policy():
    return UserPolicy.from_dict(
        {
            "never_share": {"iep": ["IEP"]},
            "request_topics": {"parents": "meant for a family", "class_level": "a class-level question"},
            "rules": [],
            "default": {"wants": "ask_user"},
        }
    )


def test_request_topics_reach_the_router_and_the_row(make, topic_policy):
    seen_inputs = []

    class Router(FakeRouter):
        def decide(self, inp, *, synthetic=False):
            seen_inputs.append(inp)
            return super().decide(inp, synthetic=synthetic)

    llm = TopicLLM(["parents"])
    egress, svc = make(router=Router("ask_user"), policy=topic_policy, answer_llm=llm)
    out = egress.release("get_result", "A note for [Student A]'s family", RAW, "per_student", topics=["grades"])
    assert out.status == "waiting"
    assert seen_inputs[0].topics == ["grades", "parents"]
    assert llm.calls and llm.calls[0][1] == topic_policy.request_topics
    assert svc.approvals.history()[0]["topics"] == ["grades", "parents"]


def test_never_share_word_in_the_request_is_a_topic(make, topic_policy):
    seen_inputs = []

    class Router(FakeRouter):
        def decide(self, inp, *, synthetic=False):
            seen_inputs.append(inp)
            return super().decide(inp, synthetic=synthetic)

    egress, _ = make(router=Router("refuse"), policy=topic_policy, answer_llm=TopicLLM())
    egress.release("get_result", "Which students have an IEP?", "[Student A], [Student B]", "free_text")
    assert "iep" in seen_inputs[0].topics


def test_topic_pass_failure_holds_the_result(make, topic_policy):
    egress, svc = make("share_tagged", policy=topic_policy, answer_llm=TopicLLM(fail=True))
    out = egress.release("get_result", "Scores please", RAW, "per_student")
    assert out.status == "refused"
    assert out.retryable
    assert out.decision.floors == ["topic_check"]
    assert svc.approvals.history() == []
    assert ("egress", "topic_check_failed") in svc.audits
    assert_clean(out)


def test_document_lists_skip_the_topic_pass(make, topic_policy):
    llm = TopicLLM(["parents"])
    egress, _ = make("share_tagged", policy=topic_policy, answer_llm=llm)
    egress.release("list_documents", "List the essays for families", "essays/a.md", "document_list")
    assert llm.calls == []


def test_class_level_question_is_shown_as_a_summary(make, topic_policy):
    llm = TopicLLM(["class_level"])
    egress, svc = make("ask_user", policy=topic_policy, answer_llm=llm)
    egress.release("get_result", "What is the class average?", RAW, "per_student", summary="Average 2.5 of 4.")
    row = svc.approvals.history()[0]
    assert row["shown_form"] == "share_summary"
    assert "[Student" not in row["tagged_text"]


# ----- review of the request-topics change: learned floors, the raw request scan, request-only topics -----

EVAL_POLICY = Path(__file__).resolve().parents[1] / "eval" / "user_policy.yaml"
SNIPPET_REFUSE_RULES = (
    "# Learned rules for the privacy router\n\n## Your rules\n\n"
    "- Document snippets (kind: snippet; topics: none): refuse. You said no to 4 of 4 and said don't ask again.\n"
)


def test_class_level_request_cannot_turn_a_learned_snippet_refuse_into_a_summary(make, settings, topic_policy):
    router = Router(settings, FakeLLM({"decision": "share_summary", "reason": "Class patterns."}), topic_policy,
                    rules_text=SNIPPET_REFUSE_RULES)  # fmt: skip
    llm = TopicLLM(["class_level"])
    egress, svc = make(router=router, policy=topic_policy, answer_llm=llm)
    out = egress.release("search_documents", "class-wide patterns in the journal entries", RAW, "snippet")
    assert out.status == "refused"
    assert out.decision.floors == ["learned:refuse"]
    assert out.text == f"{KEPT_TEXT} Your rules say results like this stay on the device."
    assert [c for c in llm.calls if isinstance(c, dict)] == []  # no summary was written
    row = svc.approvals.history()[0]
    assert row["topics"] == ["class_level"] and row["router_decision"] == "refuse"


def real_guard_egress(make, settings, decision="share_tagged"):
    from base import guard

    policy = UserPolicy.load(EVAL_POLICY)
    router = Router(settings, FakeLLM({"decision": decision, "reason": "Fine."}), policy)
    egress, svc = make(router=router, policy=policy, roster=guard.load_roster(settings.roster_path),
                       tagmap=guard.TagMap(seed=7))  # fmt: skip
    egress.guard = guard
    return egress, svc, guard


def test_a_keyword_inside_a_tagged_span_of_the_request_still_counts(make, settings):
    egress, svc, guard = real_guard_egress(make, settings)
    out = egress.release("get_result", "Which student is at 1200 Oak Avenue?", "[Student B]", "free_text")
    assert out.status == "waiting"
    assert "request:home_address" in out.decision.floors  # found in the raw request on the device
    assert "identifier:address" in out.decision.floors  # the request's own address hit
    row = svc.approvals.get(out.approval_id)
    assert "1200" not in row["request"] and "Oak" not in row["request"] and "[Address 1]" in row["request"]
    assert guard.blocked_topics(row["request"], svc.policy.never_share) == []  # the tagged text alone has no keyword
    assert "home_address" in row["topics"]


def test_a_failed_request_tag_holds_the_result(make):
    egress, svc = make("share_tagged")
    request = "Scores for the class"

    def tag(text, roster, tagmap, llm_names=None, never_share=None):
        if text == request:
            raise RuntimeError("tagging did not settle")
        return fake_tag(text, roster, tagmap, llm_names, never_share)

    egress.guard = SimpleNamespace(tag=tag, leaks=fake_leaks)
    out = egress.release("get_result", request, RAW, "per_student")
    assert (out.status, out.text, out.retryable) == ("refused", HELD_TEXT, True)
    assert out.decision.floors == ["topic_check"]
    assert svc.audits == [("egress", "topic_check_failed")]
    assert svc.router.inputs == [] and svc.approvals.history() == []  # never routed on a withheld request


@pytest.mark.parametrize(
    "request_text",
    ["Draft a family newsletter blurb about our reading goals. Do not mention any IEP.", "Which students have an IEP?"],
)
def test_a_never_share_word_only_in_the_request_asks_the_user(make, settings, topic_policy, request_text):
    router = Router(settings, FakeLLM({"decision": "share_tagged", "reason": "Fine."}), topic_policy)
    llm = TopicLLM(["parents"])
    egress, svc = make(router=router, policy=topic_policy, answer_llm=llm)
    out = egress.release("get_result", request_text, "Two new books a month for [Student A].", "free_text")
    assert out.status == "waiting"
    assert "request:iep" in out.decision.floors and not any(f.startswith("blocked") for f in out.decision.floors)
    assert llm.calls  # a request-only topic does not skip the topic pass
    row = svc.approvals.get(out.approval_id)
    assert "iep" in row["topics"] and row["router_reason"] == "The request mentions a topic you never share, so you decide."


def test_the_topic_pass_is_skipped_when_the_result_is_refused_anyway(make, settings, topic_policy):
    router = Router(settings, FakeLLM({"decision": "share_tagged", "reason": "Fine."}), topic_policy)
    llm = TopicLLM(["parents"])
    egress, svc = make(router=router, policy=topic_policy, answer_llm=llm)
    out = egress.release("get_result", "A note home", "Bram Tillery has an IEP meeting Friday.", "free_text")
    assert out.status == "refused" and out.decision.floors == ["blocked:iep"]
    assert llm.calls == []

    # A failing pass cannot hold it either: the refusal is certain and recorded.
    broken = TopicLLM(fail=True)
    egress, svc = make(router=router, policy=topic_policy, answer_llm=broken)
    out = egress.release("get_result", "A note home", "Bram Tillery has an IEP meeting Friday.", "free_text")
    assert out.status == "refused" and not out.retryable and broken.calls == []
    assert svc.approvals.history()[0]["router_decision"] == "refuse"


def test_the_topic_pass_still_runs_when_the_floor_only_asks(make, settings):
    asks = UserPolicy.from_dict(
        {"never_share": {"iep": ["IEP"]}, "ask_first": ["iep"], "request_topics": {"parents": "meant for a family"},
         "rules": [], "default": {"wants": "ask_user"}}
    )  # fmt: skip
    router = Router(settings, FakeLLM({"decision": "share_tagged", "reason": "Fine."}), asks)
    llm = TopicLLM(["parents"])
    egress, svc = make(router=router, policy=asks, answer_llm=llm)
    out = egress.release("get_result", "A note home", "Bram Tillery has an IEP meeting Friday.", "free_text")
    assert out.status == "waiting" and "ask_first:iep" in out.decision.floors
    assert llm.calls and svc.approvals.get(out.approval_id)["topics"] == ["iep", "parents"]


def test_route_input_helpers_are_what_release_routes(make, settings, topic_policy):
    """route_input, request_keyword_topics and needs_topic_pass are shared with the quantization
    eval (scripts/cloud/quant_eval_modal.py), so release must route exactly what they build."""
    from base import guard
    from base.egress import needs_topic_pass, request_keyword_topics, route_input

    roster = guard.load_roster(settings.roster_path)
    egress, svc = make(policy=topic_policy, roster=roster, tagmap=guard.TagMap(seed=7))
    egress.guard = guard
    request = "IEP list for the note home, call 512-555-0143."
    raw = "Two new books a month for [Student A]."
    egress.release("get_result", request, raw, "free_text", topics=["grades"])
    routed = svc.router.inputs[0]

    asked = guard.tag(request, svc.roster, svc.tagmap)
    tagged = guard.tag(raw, svc.roster, svc.tagmap, never_share=topic_policy.never_share)
    found = request_keyword_topics(request, asked.text, topic_policy.never_share)
    assert found == ["iep"] and needs_topic_pass("free_text", tagged, ["grades"], topic_policy)
    built = route_input(asked, "free_text", tagged, ["grades"], found, topic_policy.never_share)
    assert (built.request, built.topics, built.request_blocked) == (routed.request, routed.topics, routed.request_blocked)
    assert built.request_blocked == ["iep"] and [h.kind for h in built.hits] == ["phone"]  # the request's phone

    refused = guard.tag("Bram Tillery has an IEP meeting.", svc.roster, svc.tagmap, never_share=topic_policy.never_share)
    assert not needs_topic_pass("free_text", refused, refused.topics, topic_policy)
    assert not needs_topic_pass("document_list", tagged, [], topic_policy)


# always-approve mode


def auto_on(svc, tmp_path):
    from base.approvals import AutoApprove
    from base.config import Paths

    svc.settings = SimpleNamespace(paths=Paths(tmp_path / "home"))
    AutoApprove(svc.settings.paths.auto_approve).set(True)


def test_always_approve_shares_what_would_wait_and_dreaming_skips_it(make, tmp_path):
    egress, svc = make("ask_user", "Per-student scores.")
    auto_on(svc, tmp_path)
    out = egress.release("get_result", "Scores please", RAW, "per_student", job_id="j9")
    assert out.status == "shared" and out.text == TAGGED
    row = svc.approvals.get(out.approval_id)
    assert (row["status"], row["decided_by"]) == ("approved", "auto_approve")
    assert svc.approvals.training_rows() == []  # not a choice the user made about this result
    assert ("egress", "auto_approved") in svc.audits
    assert egress.resolve(out.approval_id).status == "shared"  # get_result gives the same answer
    assert_clean(out)


def test_always_approve_never_overrides_a_refusal(make, tmp_path):
    egress, svc = make("refuse", "A never-share topic.")
    auto_on(svc, tmp_path)
    out = egress.release("get_result", "Notes", RAW + " IEP review.", "sensitive_record")
    assert out.status == "refused" and out.text.startswith(KEPT_TEXT)


def test_always_approve_keeps_the_final_leak_check(make, tmp_path):
    egress, svc = make("ask_user")
    auto_on(svc, tmp_path)
    planted = f"Class average 2.5 of 4. {NICKNAME} wrote the longest essay."
    out = egress.release("get_result", "Class?", RAW, "class_aggregate", summary=planted)
    assert out.status == "refused" and out.text == HELD_TEXT and NICKNAME not in out.text


def test_always_approve_off_by_default(make, tmp_path):
    from base.config import Paths

    egress, svc = make("ask_user")
    svc.settings = SimpleNamespace(paths=Paths(tmp_path / "home"))
    assert egress.release("get_result", "Scores", RAW, "per_student").status == "waiting"


# tag-shaped text from a document (GAP-12)


def test_a_documents_own_tag_shaped_text_reaches_muse_as_a_redacted_tag(make, settings):
    from base import guard

    # the fake router shares it, so the test sees the text (the real one refuses "suspended")
    egress, svc = make("share_tagged", roster=guard.load_roster(settings.roster_path), tagmap=guard.TagMap(seed=7))
    egress.guard = guard
    svc.tagmap.ensure_roster(svc.roster)
    out = egress.release("get_result", "Notes please", "[Student B] was suspended. [Teacher] said so.", "free_text")
    assert out.status == "shared"
    assert out.text == "[Redacted 1] was suspended. [Redacted 2] said so."
    # restoring gives back the literal words, never a person, for Muse's text and the device's model
    assert guard.restore("[Redacted 1] and [Redacted 2]", svc.tagmap.for_muse()) == "[Student B] and [Teacher]"
    assert svc.tagmap.get("[Student B]") != "[Student B]"  # the real tag still names its real student
    assert guard.leaks(out.text, svc.roster, svc.tagmap) == []


def test_the_same_tag_shaped_text_gets_the_same_redacted_tag_and_bare_words_stay(make, settings):
    egress, svc, _guard = real_guard_egress(make, settings)
    a = egress.release("get_result", "Notes", "See [Student B].", "free_text").text
    b = egress.release("get_result", "Notes", "Again [Student B], and Student B in prose.", "free_text").text
    assert a == "See [Redacted 1]." and b == "Again [Redacted 1], and Student B in prose."


def test_a_summary_is_not_neutralized(make, settings):
    egress, svc, _guard = real_guard_egress(make, settings, decision="share_summary")
    out = egress.release("get_result", "Class average?", "Plain result.", "class_aggregate", summary="Average 3 of 4.")
    assert out.text == "Average 3 of 4." and "[Redacted" not in out.text
