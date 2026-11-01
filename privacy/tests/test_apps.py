"""base/apps.py and LINKED_APP: the device names the app it is linked to, Muse by default."""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from base import apps, ui_app
from base.config import load_settings
from base.egress import RAW_REQUEST_NOTE, Egress
from base.services import Services
from base.ui_app import create_app

ROSTER = os.path.join(os.path.dirname(__file__), "fixtures", "guard_roster.json")
STUDENT = "Rose Tindall"


def test_muse_is_the_default_and_its_note_is_unchanged():
    assert load_settings({}).linked_app == "Muse"
    assert RAW_REQUEST_NOTE == (
        "Note: this request included a private detail, so Muse has already seen it. Use tags in requests, "
        "and turn off training under Data controls in your Muse settings."
    )
    assert apps.destination() == "Muse, through the relay"


def test_claude_and_chatgpt_get_their_own_maker_and_training_step():
    assert apps.company("Claude") == "Anthropic" and "Help improve Claude" in apps.request_note("Claude")
    assert apps.company("chatgpt") == "OpenAI" and "Improve the model for everyone" in apps.request_note("ChatGPT")
    assert apps.company("Some App") == "the company that runs it"
    assert "Some App's data settings" in apps.request_note("Some App")


@pytest.mark.parametrize("bad", ["x" * 31, "<script>", "Claude\nSecond line", "-dash"])
def test_a_name_that_could_break_a_page_is_refused(bad):
    with pytest.raises(ValueError):
        load_settings({"LINKED_APP": bad})


@pytest.fixture
def claude(tmp_path):
    root = tmp_path / "w"
    (root / "essays").mkdir(parents=True)
    env = {"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(root), "DEVICE_ONLY": "1",
           "CHECKER_API_KEY": "k", "ROSTER_PATH": ROSTER, "LINKED_APP": "Claude"}  # fmt: skip
    s = Services.create(load_settings(env), light=False, heavy=False, owner=False)

    class Llm:
        is_cloud = False

        def chat_json(self, *_a, **_k):
            return {"decision": "share_summary", "reason": "because"}

        def chat(self, *_a, **_k):
            return type("R", (), {"content": "The class improved overall."})()

        def llm_names(self, *_a, **_k):
            return []

        def request_topics(self, *_a, **_k):
            return []

        def health(self, *_a):
            return True

        def close(self):
            pass

    s.router.llm = s.checker_llm = s.answer_llm = Llm()
    yield s
    s.close()


def test_the_note_and_receipt_name_the_linked_app(claude):
    out = Egress(claude).release("search_documents", f"How did {STUDENT} do?", "The class improved.", "class_aggregate",
                                 summary="The class improved.")  # fmt: skip
    assert out.text.endswith(apps.request_note("Claude")) and "Muse" not in out.text
    receipt = claude.approvals.history(limit=1)[0]["receipt"]
    assert "Claude, through the relay" in receipt


def test_the_pages_name_the_linked_app_and_its_maker(claude, monkeypatch):
    monkeypatch.setattr(ui_app, "_app_names", dict(ui_app._app_names))  # later tests keep Muse
    client = TestClient(create_app(claude), base_url="http://127.0.0.1:8787", headers={"origin": "http://127.0.0.1:8787"})
    setup = client.get("/setup").text
    assert "This device is linked to Claude" in setup and "reaches Anthropic before this device sees it" in setup
    assert "Help improve Claude" in setup
    assert "Muse asked" not in client.get("/").text
    assert "goes to Claude" in client.get("/controls").text or "Claude can see" in client.get("/controls").text
