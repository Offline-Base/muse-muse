"""Tag rotation through the connector, egress and jobs: Muse's old or guessed tags get one fixed
sentence and start nothing, a request with yesterday's tags is answered in those tags, and a
shared result marks its tags as sent. Real Services on a temp home, invented essays, fake models."""

from __future__ import annotations

import os
from datetime import datetime

import pytest

from base import guard, retention
from base.config import load_settings
from base.connector import audit as audit_module
from base.connector.server import EXPIRED_TAG, Connector
from base.services import Services
from base.types import RouteDecision
from base.ui_app import tag_day_note

ROSTER = os.path.join(os.path.dirname(__file__), "fixtures", "guard_roster.json")
STUDENT = "Rose Tindall"
OTHER = "Hunter Bramwell"
NOON = datetime(2026, 10, 30, 12, 0).timestamp()
HOUR = 3600.0


class Clock:
    def __init__(self, now: float = NOON):
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, hours: float) -> None:
        self.now += hours * HOUR


class FakeLLM:
    is_cloud = False

    def chat_json(self, *_a, **_k):
        return {"decision": "share_tagged", "reason": "Fine."}

    def chat(self, *_a, **_k):
        return type("R", (), {"content": "The class improved overall."})()

    def llm_names(self, *_a, **_k):
        return []

    def request_topics(self, *_a, **_k):
        return []

    def close(self):
        pass


class Router:
    """Decides every result the same way, so a test can pick shared or waiting."""

    def __init__(self, decision="share_tagged"):
        self.decision = decision

    def decide(self, inp, *, synthetic=False):
        return RouteDecision(self.decision, "Test.", "rule", 0, [])


class Recorder:
    def __init__(self):
        self.calls = []


@pytest.fixture
def svc(tmp_path):
    root = tmp_path / "w"
    (root / "essays").mkdir(parents=True)
    (root / "essays" / "rose.md").write_text(f"# {STUDENT}\n\n{STUDENT} wrote about the school garden and the bean rows.\n")
    (root / "essays" / "hunter.md").write_text(f"# {OTHER}\n\n{OTHER} wrote about the river trip.\n")
    env = {"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(root), "DEVICE_ONLY": "1",
           "CHECKER_API_KEY": "k", "ROSTER_PATH": ROSTER}  # fmt: skip
    s = Services.create(load_settings(env), light=False, heavy=False, owner=False)
    s.router.llm = s.checker_llm = s.answer_llm = FakeLLM()
    s.router = Router()
    s.rag = None  # BM25 search only: no model call
    s.tagmap.clock = Clock()
    # spies: nothing may be searched, listed or started for an old tag
    s.index_calls = []
    for name in ("list", "search"):
        real = getattr(s.index, name)
        setattr(s.index, name, lambda *a, _real=real, _name=name, **k: (s.index_calls.append(_name), _real(*a, **k))[1])
    s.started = Recorder()
    s.agent = type("Agent", (), {"run_private_task": lambda _self, i, f: s.started.calls.append((i, f)) or "job-x"})()
    s.ask_runner = type("Ask", (), {"start": lambda _self, q, r, f: s.started.calls.append((q, f)) or "ask-x", "sources": {}})()
    yield s
    s.close()


def call(c: Connector, tool: str, *args) -> str:
    result = c.call(tool, getattr(c, tool), *args)
    return result.content[0].text


def outcomes(svc) -> list[tuple[str, str]]:
    return [(r["tool"], r["outcome"]) for r in reversed(audit_module.recent(svc.settings.paths.db))]


def tag_of(svc, name: str, text: str) -> str:
    return next(t for t in guard.TAG_RE.findall(text) if svc.tagmap.get(t) == name)


def test_a_listed_tag_restores_and_a_shared_result_marks_its_tags_as_sent(svc):
    c = Connector(svc)
    listing = call(c, "list_documents", "essays")
    rose = tag_of(svc, STUDENT, listing)
    assert rose in svc.tagmap.for_muse()  # shared, so sent
    found = call(c, "search_documents", f"{rose} garden", "")
    assert "bean rows" in found and STUDENT not in found
    assert ("search_documents", "shared") in outcomes(svc)


@pytest.mark.parametrize("tool", ["search_documents", "ask_device", "run_private_task", "list_documents"])
@pytest.mark.parametrize("which", ["expired", "guessed"])
def test_an_old_or_guessed_tag_gets_one_sentence_and_starts_nothing(svc, tool, which):
    c = Connector(svc)
    listing = call(c, "list_documents", "essays")
    if which == "expired":
        bad = tag_of(svc, STUDENT, listing)
        svc.tagmap.clock.advance(24 * 4)
    else:
        bad = "[Student QQ]"  # never made, never sent
    svc.index_calls.clear()
    args = {
        "search_documents": (f"{bad} garden", ""),
        "ask_device": (f"What did {bad} write?", "for my own planning", ""),
        "run_private_task": (f"Write feedback for {bad} for my own grading", "essays"),
        "list_documents": (bad,),
    }[tool]
    assert call(c, tool, *args) == EXPIRED_TAG
    assert outcomes(svc)[-1] == (tool, "expired_tag")
    assert svc.index_calls == [] and svc.started.calls == []


def test_a_tag_made_but_never_sent_does_not_restore(svc):
    c = Connector(svc)
    out = guard.tag(f"{OTHER} was absent.", svc.roster, svc.tagmap)  # tagged for the device's model only
    hunter = tag_of(svc, OTHER, out.text)
    assert call(c, "search_documents", f"{hunter} river", "") == EXPIRED_TAG


def test_rotation_off_restores_any_known_tag_as_before(svc):
    svc.tagmap.rotation = "off"
    c = Connector(svc)
    out = guard.tag(f"{OTHER} was absent.", svc.roster, svc.tagmap)
    hunter = tag_of(svc, OTHER, out.text)
    assert "river trip" in call(c, "search_documents", f"{hunter} river", "")
    assert call(c, "search_documents", "[Student QQ] river", "") != EXPIRED_TAG  # left as written, as in version 1
    assert ("search_documents", "expired_tag") not in outcomes(svc)


def test_a_job_with_yesterdays_live_tags_comes_back_in_those_tags(svc):
    c = Connector(svc)
    rose = tag_of(svc, STUDENT, call(c, "list_documents", "essays"))
    svc.tagmap.clock.advance(20)  # tomorrow morning: today's tags are new
    today = tag_of(svc, STUDENT, guard.tag(STUDENT, svc.roster, svc.tagmap).text)
    assert today != rose
    job_id = svc.jobs.create("private_task", f"Feedback for {rose}, for my own grading", "essays")
    svc.jobs.start(job_id)
    svc.jobs.finish(job_id, f"{STUDENT}: strong thesis, add one more example.", "free_text")
    result = call(c, "get_result", job_id)
    assert rose in result and today not in result and STUDENT not in result
    # a search with no tags in it is answered in today's tags
    assert today in call(c, "search_documents", "garden bean rows", "")


def test_an_approval_answered_three_days_later_is_shared_but_its_old_tags_do_not_restore(svc):
    svc.router = Router("ask_user")
    out = svc.egress.release("get_result", "Notes for my own grading", f"{STUDENT} needs a new thesis.", "free_text")
    assert out.status == "waiting"
    rose = tag_of(svc, STUDENT, svc.approvals.get(out.approval_id)["tagged_text"])
    assert rose not in svc.tagmap.for_muse()  # not sent yet
    svc.tagmap.clock.advance(72)
    retention.expire_tags(svc)  # the tag stays: its result is still waiting
    svc.approvals.decide(out.approval_id, approve=True)
    shared = svc.egress.resolve(out.approval_id)
    assert shared.status == "shared" and rose in shared.text
    # sending it late does not bring back a tag whose day and grace are over
    assert call(Connector(svc), "search_documents", f"{rose} garden", "") == EXPIRED_TAG


def test_a_tag_muse_sends_back_every_day_still_stops_working(svc):
    c = Connector(svc)
    rose = tag_of(svc, STUDENT, call(c, "list_documents", "essays"))  # noon on day 0
    for hours in (20, 24):  # the next two mornings Muse searches with it, and the result goes back
        svc.tagmap.clock.advance(hours)
        found = call(c, "search_documents", f"{rose} garden", "")
        assert "bean rows" in found and rose in found
    svc.tagmap.clock.advance(5)  # day 2, 13:00: day 0's grace ended at noon
    assert call(c, "search_documents", f"{rose} garden", "") == EXPIRED_TAG
    fresh = tag_of(svc, STUDENT, call(c, "list_documents", "essays"))
    assert fresh != rose and "bean rows" in call(c, "search_documents", f"{fresh} garden", "")


def test_a_request_mixing_yesterdays_and_todays_tags_is_refused(svc):
    c = Connector(svc)
    old_rose = tag_of(svc, STUDENT, call(c, "list_documents", "essays"))
    svc.tagmap.clock.advance(20)  # the next morning
    listing = call(c, "list_documents", "essays")
    new_hunter = tag_of(svc, OTHER, listing)
    assert old_rose in svc.tagmap.for_muse() and new_hunter in svc.tagmap.for_muse()
    svc.index_calls.clear()
    for tool, args in (
        ("search_documents", (f"{old_rose} and {new_hunter} garden", "")),
        ("search_documents", (f"{old_rose} garden", f"to compare with {new_hunter}")),  # the purpose counts too
        ("ask_device", (f"What did {old_rose} write?", f"for {new_hunter}'s family", "")),
        ("run_private_task", (f"Compare {old_rose} with {new_hunter}, for my own grading", "essays")),
    ):
        assert call(c, tool, *args) == EXPIRED_TAG, tool
        assert outcomes(svc)[-1] == (tool, "expired_tag")
    assert svc.index_calls == [] and svc.started.calls == []
    # one day's tags at a time still work, the older day's in its own tags
    assert old_rose in call(c, "search_documents", f"{old_rose} garden", "")


@pytest.mark.parametrize(
    ("tool", "args"),
    [
        ("search_documents", ("Student ID numbers on the forms", "")),
        ("search_documents", ("which student IEP goals mention reading", "for my own planning")),
        ("run_private_task", ("Check the Student ID column on each form, for my own records", "essays")),
        ("ask_device", ("Which STUDENT ID is missing?", "", "")),
    ],
)
def test_school_words_after_student_are_not_refused_as_tags(svc, tool, args):
    svc.tagmap.ensure_roster(svc.roster)
    assert call(Connector(svc), tool, *args) != EXPIRED_TAG
    assert ("expired_tag" not in {o for _t, o in outcomes(svc)})


def test_the_prepare_page_marks_its_tags_as_sent_and_says_which_day(svc):
    from fastapi.testclient import TestClient

    from base.ui_app import create_app

    client = TestClient(create_app(svc), base_url="http://127.0.0.1:8787", headers={"origin": "http://127.0.0.1:8787"})
    page = client.post("/prepare", data={"text": f"How did {STUDENT} do?"}).text
    rose = next(t for t in guard.TAG_RE.findall(page) if t.startswith("[Student"))
    assert rose in svc.tagmap.for_muse()
    assert "Tags change every day" in page and f"tag day {svc.tagmap.today()}" in page and "—" not in page
    svc.tagmap.rotation = "off"
    assert "daily tag change is off" in client.get("/prepare").text
    assert tag_day_note(None).startswith("Tags stay the same")
    assert client.get("/api/status").json()["tag_rotation"] == "off"
