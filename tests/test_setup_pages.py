"""The Setup, Prepare and Controls pages, receipts, the audit export and retention."""

from __future__ import annotations

import csv
import io
import os
import time

import pytest
from fastapi.testclient import TestClient

from base import retention
from base.approvals import AutoApprove
from base.config import load_settings
from base.controls import Controls, ControlStore
from base.egress import RAW_REQUEST_NOTE, Egress
from base.services import Services
from base.ui_app import create_app

STUDENT = "Rose Tindall"
ROSTER = os.path.join(os.path.dirname(__file__), "fixtures", "guard_roster.json")


class _Llm:
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


@pytest.fixture
def svc(tmp_path):
    root = tmp_path / "w"
    (root / "essays").mkdir(parents=True)
    env = {"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(root), "DEVICE_ONLY": "1", "CHECKER_API_KEY": "k", "ROSTER_PATH": ROSTER}
    s = Services.create(load_settings(env), light=False, heavy=False, owner=False)
    s.router.llm = s.checker_llm = s.answer_llm = _Llm()
    yield s
    s.close()


@pytest.fixture
def client(svc):
    return TestClient(create_app(svc), base_url="http://127.0.0.1:8787", headers={"origin": "http://127.0.0.1:8787"}, follow_redirects=False)


def test_the_first_visit_goes_to_setup_and_a_choice_sets_the_toggles(client, svc):
    assert client.get("/").headers["location"] == "/setup"
    page = client.get("/setup").text
    assert "Who are you protecting?" in page and "Muse training is off" in page and "compliant" not in page
    assert client.post("/api/setup", data={"profile_ferpa": "1", "profile_coppa": "1"}).status_code == 303
    assert ControlStore(svc.settings.paths.controls).get().profiles == ["ferpa", "coppa"]
    assert client.get("/").status_code == 200
    assert client.post("/api/setup", data={"muse_training_off": "1"}).status_code == 303
    assert ControlStore(svc.settings.paths.controls).get().profiles == []
    assert "state-off" in client.get("/setup").text  # this test device is not linked to Muse


def test_setup_keeps_the_users_other_controls(client, svc):
    store = ControlStore(svc.settings.paths.controls)
    store.save(Controls(always_redact=["Secret Word"]))
    client.post("/api/setup", data={"profile_hipaa": "1"})
    c = store.get()
    assert c.profiles == ["hipaa"] and c.always_redact == ["Secret Word"]


def test_the_controls_page_shows_saves_and_locks(client, svc):
    store = ControlStore(svc.settings.paths.controls)
    store.save(Controls(tag_kinds={"phone": False}, never_redact=["Coral Bay"]))
    assert "FERPA" in client.get("/controls").text
    form = {"form": "controls", "profile_hipaa": "1", "tag_email": "1", "never_redact": "Coral Bay"}
    assert client.post("/api/controls", data=form).status_code == 303
    assert store.get().profiles == ["hipaa"]
    page = client.get("/controls").text
    assert "Locked while a toggle is on" in page and 'name="tag_phone" value="1" disabled' in page
    # a locked form posts nothing for the locked fields, and what the user set stays
    assert client.post("/api/controls", data={"form": "controls", "profile_hipaa": "1"}).status_code == 303
    c = store.get()
    assert c.never_redact == ["Coral Bay"] and c.tag_kinds["phone"] is False


def test_toggles_are_refused_without_device_only(tmp_path):
    root = tmp_path / "w"
    root.mkdir()
    (root / ".synthetic").write_text("x")
    env = {"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(root), "OPENROUTER_API_KEY": "k", "ROSTER_PATH": ROSTER}
    s = Services.create(load_settings(env), light=False, heavy=False, owner=False)
    try:
        c = TestClient(create_app(s), base_url="http://127.0.0.1:8787", headers={"origin": "http://127.0.0.1:8787"})
        assert c.post("/api/controls", json={"profiles": ["ferpa"]}).status_code == 400
        assert c.post("/api/setup", data={"profile_ferpa": "1"}).status_code == 400
        assert "DEVICE_ONLY=1" in c.get("/controls").text
    finally:
        s.close()


def test_always_approve_is_locked_on_the_page_and_the_api(client, svc):
    client.post("/api/setup", data={"profile_ferpa": "1"})
    assert client.post("/api/auto-approve", json={"on": True}).status_code == 409
    assert not AutoApprove(svc.settings.paths.auto_approve).on
    page = client.get("/").text
    assert "Off while a privacy toggle" in page and "disabled" in page
    status = client.get("/api/status").json()
    assert status["device_only"] is True and status["profiles"] == ["ferpa"] and status["auto_approve"] is False


def test_prepare_tags_the_question_and_keeps_nothing(client, svc):
    assert "paste the tagged version" in client.get("/prepare").text
    page = client.post("/prepare", data={"text": f"How did {STUDENT} do? Call 555-0142."}).text
    assert "[Student" in page and "[Phone 1]" in page
    assert svc.approvals.history(limit=5) == []


def test_prepare_says_so_when_the_local_model_is_down(client, svc):
    class Down(_Llm):
        def llm_names(self, *_a, **_k):
            raise RuntimeError("down")

    svc.checker_llm = Down()
    page = client.post("/prepare", data={"text": f"How did {STUDENT} do?"}).text
    assert "not running" in page and "[Student" in page


def test_a_private_detail_in_the_request_warns_once_and_is_on_the_receipt(svc):
    out = Egress(svc).release("search_documents", f"How did {STUDENT} do?", "The class improved.", "class_aggregate", summary="The class improved.")
    assert out.text.endswith(RAW_REQUEST_NOTE) and STUDENT not in out.text
    row = svc.approvals.history(limit=1)[0]
    assert "student" in row["receipt"] and STUDENT not in row["receipt"] and STUDENT not in (row["request"] or "")


def test_a_tag_in_the_request_does_not_warn(svc):
    out = Egress(svc).release("search_documents", "How did [Student A] do?", "The class improved.", "class_aggregate", summary="The class improved.")
    assert RAW_REQUEST_NOTE not in out.text


def test_receipts_show_on_history_and_the_export_holds_no_values(client, svc):
    secret_phone = "555-0142"
    raw = f"{STUDENT} can be reached at {secret_phone}."
    Egress(svc).release("search_documents", f"Contact for {STUDENT}", raw, "snippet")
    client.post("/api/setup", data={})
    page = client.get("/history").text
    assert "Receipt" in page and "On this device only" in page and "Muse, through the relay" in page
    assert "1 phone numbers" in page and "Fingerprint" in page and "Warning" in page
    response = client.get("/api/audit.csv")
    assert response.headers["content-type"].startswith("text/csv")
    rows = list(csv.DictReader(io.StringIO(response.text)))
    assert rows[0]["device_only"] == "True" and "phone=1" in rows[0]["removed"] and len(rows[0]["sha256"]) == 64
    assert STUDENT not in response.text and secret_phone not in response.text and "Contact for" not in response.text


def test_retention_removes_old_results_and_keeps_new_and_waiting_ones(svc):
    a = svc.approvals
    old = a.record_auto(tool="t", request="r", result_kind="snippet", tagged_text="x", router_decision="share_tagged")
    waiting = a.create_pending(tool="t", request="r", result_kind="snippet", tagged_text="x", router_decision="ask_user")
    a._conn.execute("UPDATE decisions SET ts = ? WHERE id IN (?, ?)", (time.time() - 100 * 86400, old, waiting))
    a._conn.commit()
    new = a.record_auto(tool="t", request="r", result_kind="snippet", tagged_text="x", router_decision="share_tagged")
    output = svc.settings.paths.output
    (output / "old_job").mkdir(parents=True)
    os.utime(output / "old_job", (1, 1))
    (output / "new_job").mkdir()
    counts = retention.purge(svc, 90)
    assert counts["decisions"] == 1 and counts["files"] == 1
    assert a.get(old) is None and a.get(waiting) is not None and a.get(new) is not None
    assert not (output / "old_job").exists() and (output / "new_job").exists()


def test_retention_runs_only_under_coppa_and_at_most_hourly(svc, monkeypatch):
    calls = []
    monkeypatch.setattr(retention, "purge", lambda _s, days: calls.append(days) or {"decisions": 0, "jobs": 0, "files": 0})
    retention.maybe_purge(svc, ["ferpa"])
    assert calls == []
    retention.maybe_purge(svc, ["coppa"])
    retention.maybe_purge(svc, ["coppa"])
    assert calls == [90]


def test_the_dreaming_page_chooses_how_rules_are_used(client, svc):
    client.post("/api/setup", data={})
    page = client.get("/dreaming").text
    assert "Rules in code" in page and "Prompt, stricter only" in page and "Prompt, model decides" in page and "Local fine-tune" in page
    assert 'value="rules" checked' in page and 'value="local_lora" disabled' in page
    assert client.post("/api/learning", data={"learning": "tighten"}).status_code == 303
    assert ControlStore(svc.settings.paths.controls).get().learning == "tighten"
    assert svc.router.mode() == "tighten"
    assert client.post("/api/learning", data={"learning": "local_lora"}).status_code == 409
    assert client.post("/api/learning", data={"learning": "bogus"}).status_code == 400


def test_setup_and_controls_show_every_toggle_by_group(client):
    for path in ("/setup", "/controls"):
        page = client.get(path).text
        for text in ("Government", "Money", "Privacy laws", "GDPR", "CJIS", "ITAR and EAR", "IRC 7216", "Not for classified information"):
            assert text in page


def test_ask_on_this_device_answers_with_real_names_and_records_no_release(client, svc):
    class Runner:
        def start(self, question, request, folder):
            job = svc.jobs.create("ask", request, folder)
            svc.jobs.start(job)
            svc.jobs.finish(job, f"Answer: {STUDENT} wrote about bees.", "free_text")
            return job

    svc.ask_runner = Runner()
    response = client.post("/ask", data={"question": "Who wrote about bees?"})
    assert response.status_code == 303
    page = client.get(response.headers["location"]).text
    assert STUDENT in page and "Nothing goes to Muse" in page
    assert svc.approvals.history(limit=5) == []


def test_ask_while_working_refreshes_itself(client, svc):
    job = svc.jobs.create("ask", "asked on this device", None)
    assert 'http-equiv="refresh"' in client.get(f"/ask?job={job}").text


def test_every_page_avoids_the_word_compliant(client):
    client.post("/api/setup", data={"profile_ferpa": "1"})
    for path in ("/", "/setup", "/controls", "/prepare", "/history", "/ask"):
        assert "compliant" not in client.get(path).text.lower().replace("make you compliant", "")
