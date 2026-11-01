"""The user's privacy controls: guard.Redaction, Controls and ControlStore, and where they apply.

All names and numbers are invented (phones 555-01xx, SSNs starting with 9).
"""

from __future__ import annotations

import dataclasses
import json
import os
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

from base import guard
from base.compliance import PROFILES
from base.config import load_settings
from base.controls import Controls, ControlStore, top_folder
from base.guard import Redaction, TagMap, load_roster
from base.workspace.index import DocumentIndex
from tests.synthetic_helpers import mark_synthetic

ROSTER_FILE = Path(__file__).parent / "fixtures" / "guard_roster.json"
STUDENT = "Rose Tindall"
TEXT = f"{STUDENT} volunteers at the Coral Bay Aquarium. Call 555-0142 or write rose@example.com. SSN 912-34-5678."


@pytest.fixture(scope="module")
def roster():
    return load_roster(ROSTER_FILE)


def tag(text, roster, redaction=None, names=()):
    return guard.tag(text, roster, TagMap(None), llm_names=(lambda _t: list(names)) if names else None, redaction=redaction)


# guard.Redaction


def test_the_default_tags_everything(roster):
    out = tag(TEXT, roster).text
    assert STUDENT not in out and "555-0142" not in out and "rose@example.com" not in out and "912-34-5678" not in out


def test_identifier_kinds_can_be_left_as_written_but_never_ssn_or_card(roster):
    r = Redaction(skip_kinds=frozenset({"phone", "ssn", "card"}))
    assert r.skip_kinds == {"phone"}  # SSN and card numbers are always tagged
    out = tag(TEXT, roster, r).text
    assert "555-0142" in out and "rose@example.com" not in out and "912-34-5678" not in out
    assert STUDENT not in out


def test_always_redact_words_become_redacted_tags_and_the_leak_check_catches_them(roster):
    r = Redaction(always=("Coral Bay Aquarium",))
    result = tag(TEXT, roster, r)
    assert "Coral Bay Aquarium" not in result.text and "[Redacted 1]" in result.text
    assert guard.TAG_RE.search("[Redacted 1]")
    assert [h.kind for h in guard.leaks("Seen at the coral bay aquarium.", roster, TagMap(None), r)] == ["term"]
    assert guard.restore(result.text, result.tag_map) == TEXT


def test_never_redact_words_stay_even_when_the_name_check_flags_them(roster):
    flagged = ("Coral Bay",)  # the model pass thinks the place is a person
    assert "Coral Bay" not in tag(TEXT, roster, names=flagged).text
    out = tag(TEXT, roster, Redaction(never=("Coral Bay Aquarium",)), names=flagged).text
    assert "Coral Bay Aquarium" in out and STUDENT not in out


def test_never_redact_cannot_free_an_ssn(roster):
    out = tag(TEXT, roster, Redaction(never=("912-34-5678", "SSN 912-34-5678"))).text
    assert "912-34-5678" not in out


def test_names_off_leaves_names_and_the_leak_check_agrees(roster):
    r = Redaction(names=False)
    out = tag(TEXT, roster, r).text
    assert STUDENT in out and "555-0142" not in out
    assert guard.leaks(out, roster, TagMap(None), r) == []
    assert [h.kind for h in guard.leaks(out, roster, TagMap(None))] != []  # the default still flags it


def test_always_wins_over_never(roster):
    out = tag(TEXT, roster, Redaction(always=("Aquarium",), never=("Aquarium",))).text
    assert "Aquarium" not in out


# Controls


def test_names_off_only_when_every_source_is_in_a_names_off_folder():
    c = Controls(names_off_folders=["resumes"])
    assert c.redaction(["resumes/a.pdf", "resumes/b.pdf"]).names is False
    assert c.redaction(["resumes/a.pdf", "essays/x.md"]) is None  # mixed: tag everything
    assert c.redaction([]) is None and c.redaction(None) is None  # unknown: tag everything


def test_controls_build_the_redaction():
    c = Controls.from_dict(
        {"tag_kinds": {"phone": False, "ssn": False, "bogus": False}, "always_redact": ["A", "a", " "], "never_redact": ["B"]}
    )
    r = c.redaction()
    assert r.skip_kinds == {"phone"} and r.always == ("A",) and r.never == ("B",)
    assert Controls().redaction() is None


def test_hidden_folders_and_the_top_level():
    c = Controls(hidden_folders=["records", "."])
    assert not c.visible("records/iep.md") and not c.visible("resume.pdf") and c.visible("essays/a.md")
    assert top_folder("resume.pdf") == "." and top_folder("essays/sub/a.md") == "essays"


def test_store_round_trip_is_private_and_a_broken_file_means_the_strict_default(tmp_path):
    store = ControlStore(tmp_path / "privacy_controls.json")
    assert store.get() == Controls()
    store.save(Controls(never_redact=["Coral Bay"], hidden_folders=["records"]))
    assert store.get().never_redact == ["Coral Bay"]
    assert stat.S_IMODE(os.stat(store.path).st_mode) == 0o600
    store.path.write_text("{not json")
    os.utime(store.path, (1, 1))  # a new mtime, so the cache reloads
    assert store.get().profiles == list(PROFILES)  # the strictest settings


# where they apply


def make_index(tmp_path, controls):
    root = tmp_path / "w"
    (root / "essays").mkdir(parents=True)
    (root / "records").mkdir()
    (root / "essays" / "a.md").write_text("# A\nTide pools.")
    (root / "records" / "iep.md").write_text("# IEP\nNotes.")
    (root / "top.md").write_text("# Top\nTide pools at the top.")
    mark_synthetic(root)
    store = ControlStore(tmp_path / "c.json")
    store.save(controls)
    s = load_settings({"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(root), "OPENROUTER_API_KEY": "k"})
    return DocumentIndex(dataclasses.replace(s, pdftotext_bin=None), controls=store)


def test_hidden_folders_are_invisible_to_every_index_call(tmp_path):
    index = make_index(tmp_path, Controls(hidden_folders=["records", "."]))
    assert [d.id for d in index.list("")] == ["essays/a.md"]
    with pytest.raises(FileNotFoundError):
        index.list("records")
    with pytest.raises(FileNotFoundError):
        index.read("records/iep.md")
    assert {h.doc_id for h in index.search("tide pools")} == {"essays/a.md"}
    assert {p.doc_id for p in index.passages("notes tide")} == {"essays/a.md"}


def test_egress_uses_the_controls_for_the_sources_and_again_on_approval(tmp_path):
    from base.approvals import ApprovalStore
    from base.egress import Egress

    store = ControlStore(tmp_path / "c.json")
    store.save(Controls(names_off_folders=["resumes"], tag_kinds={"phone": False}))
    seen = []

    def fake_tag(text, roster, tagmap, llm_names=None, never_share=None, redaction=None):
        seen.append(("tag", redaction))
        return guard.TagResult(text=text)

    def fake_leaks(text, roster, tagmap, redaction=None):
        seen.append(("leaks", redaction))
        return []

    class Router:
        def decide(self, inp, synthetic=False):
            return guard_route("ask_user")

    approvals = ApprovalStore(tmp_path / "base.db")
    svc = SimpleNamespace(
        roster=None, tagmap=None, policy=SimpleNamespace(never_share={}, request_topics={}), router=Router(),
        approvals=approvals, answer_llm=None, settings=None, controls=store,
    )
    egress = Egress(svc, guard=SimpleNamespace(tag=fake_tag, leaks=fake_leaks))
    out = egress.release("search_documents", "q", "Jo Ng 555-0142", "snippet", sources=["resumes/jo.pdf"])
    assert out.status == "waiting"
    assert all(r is not None and r.names is False and "phone" in r.skip_kinds for _k, r in seen)
    assert json.loads(approvals.get(out.approval_id)["sources"]) == ["resumes/jo.pdf"]
    seen.clear()
    approvals.decide(out.approval_id, approve=True)
    assert egress.resolve(out.approval_id).status == "shared"
    assert seen and all(r is not None and r.names is False for _k, r in seen)  # same controls at approval
    seen.clear()
    egress.release("search_documents", "q", "x", "snippet")  # no sources: tag everything
    assert all(r is not None and r.names for _k, r in seen)
    approvals.close()


def guard_route(decision):
    from base.types import RouteDecision

    return RouteDecision(decision, "reason", "model", 0, [])


class _QuietLlm:
    is_cloud = False

    def chat_json(self, *_a, **_k):
        return {"decision": "share_tagged", "reason": "because"}

    def chat(self, *_a, **_k):
        return SimpleNamespace(content="A short summary.")

    def llm_names(self, *_a, **_k):
        return []

    def request_topics(self, *_a, **_k):
        return []

    def close(self):
        pass


def test_a_search_answer_from_a_passage_it_did_not_pick_is_tagged_like_that_passage(tmp_path):
    from base.connector.server import Connector
    from base.services import Services

    root = tmp_path / "w"
    for folder, text in (("newsletter", "# Garden news\nThe garden beds are planted."), ("essays", f"# Essay\n{STUDENT} planted beans.")):
        (root / folder).mkdir(parents=True)
        (root / folder / "a.md").write_text(text)
    env = {"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(root), "DEVICE_ONLY": "1", "CHECKER_API_KEY": "k",
           "ROSTER_PATH": str(ROSTER_FILE), "LIGHT_SERIAL": ""}  # fmt: skip
    svc = Services.create(load_settings(env), light=False, heavy=False, owner=False)
    try:
        svc.router.llm = svc.checker_llm = svc.answer_llm = _QuietLlm()
        svc.controls.save(Controls(names_off_folders=["newsletter"]))
        news = SimpleNamespace(doc_id="newsletter/a.md", title="Garden news", text="The garden beds are planted.")
        essay = SimpleNamespace(doc_id="essays/a.md", title="Essay", text=f"{STUDENT} planted beans.")

        class Rag:
            candidates = 20

            def retrieve(self, index, question):
                return [news, essay]  # the model is shown both

            def pick(self, question, found):
                return [news], f"{STUDENT} planted the beans."  # picks one, answers from the other

        svc.rag = Rag()
        c = Connector(svc)
        text = c.call("search_documents", c.search_documents, "who planted the garden", "for my own records").content[0].text
        assert STUDENT not in text and "Rose" not in text
        [row] = svc.approvals.history(limit=5)
        assert json.loads(row["sources"]) == ["newsletter/a.md", "essays/a.md"]
        # without an answer only the picked passages count, as before
        svc.rag.pick = lambda question, found: ([news], None)
        c.call("search_documents", c.search_documents, "garden beds", "for my own records")
        assert json.loads(svc.approvals.history(limit=5)[0]["sources"]) == ["newsletter/a.md"]
    finally:
        svc.close()
