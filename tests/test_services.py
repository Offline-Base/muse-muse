"""Services.create wires one of each module; for_eval leaves out the light and the heavy queue."""

from __future__ import annotations

from base import events
from base.approvals import ApprovalStore
from base.config import load_settings
from base.connector.audit import Audit
from base.dreaming.night import NightRunner
from base.egress import Egress
from base.guard import TagMap
from base.heavy.queue import HeavyQueue
from base.light import Light
from base.local_llm import LocalLLM
from base.policy import UserPolicy
from base.router import Router
from base.services import HEAVY_WAIT_SECONDS, Services
from base.types import Roster
from base.workspace.agent import Agent
from base.workspace.index import DocumentIndex
from base.workspace.jobs import JobStore


def make_settings(tmp_path, **extra):
    env = {
        "BASE_HOME": str(tmp_path / "home"),
        "BASE_DEVICE": "laptop",
        "GLIMMER_BACKEND": "openrouter",
        "OPENROUTER_API_KEY": "test-key",
        "LIGHT_SERIAL": "",
        "HEAVY_QUEUE": "0",
        **extra,
    }
    return load_settings(env)


def test_create_wires_one_of_each(tmp_path):
    s = Services.create(make_settings(tmp_path))
    try:
        assert isinstance(s.roster, Roster) and len(s.roster.students) == 24
        assert isinstance(s.tagmap, TagMap) and s.tagmap.path == s.settings.paths.tagmap
        assert isinstance(s.policy, UserPolicy)
        assert isinstance(s.answer_llm, LocalLLM) and s.answer_llm.role == "answer"
        assert isinstance(s.router_llm, LocalLLM) and s.router_llm.role == "router"
        assert isinstance(s.router, Router) and s.router.llm is s.router_llm and s.router.policy is s.policy
        assert isinstance(s.approvals, ApprovalStore) and isinstance(s.jobs, JobStore)
        assert isinstance(s.index, DocumentIndex)
        assert isinstance(s.agent, Agent) and s.agent.llm is s.answer_llm and s.agent.jobs is s.jobs
        assert s.agent.tagmap is s.tagmap and s.agent.roster is s.roster and s.agent.heavy is None
        assert isinstance(s.egress, Egress) and s.egress.services is s
        assert isinstance(s.night, NightRunner) and s.night.services is s
        assert isinstance(s.audit, Audit) and s.audit.db_path == s.settings.paths.db
        assert s.events is events
        assert isinstance(s.light, Light) and s.heavy is None
        s.audit("list_documents", "shared", ms=3)
        assert s.audit.recent(1)[0]["outcome"] == "shared"
    finally:
        s.close()
    assert s.light is None


def test_jetson_gets_one_heavy_queue_shared_with_the_agent(tmp_path):
    s = Services.create(make_settings(tmp_path, BASE_DEVICE="jetson", HEAVY_QUEUE="1"))
    try:
        assert isinstance(s.heavy, HeavyQueue) and s.agent.heavy is s.heavy
        assert s.heavy.wait_seconds == HEAVY_WAIT_SECONDS
        assert str(s.settings.paths.db) == s.heavy.db_path
    finally:
        s.close()


def test_for_eval_has_no_light_and_no_heavy_queue(tmp_path):
    s = Services.for_eval(make_settings(tmp_path, BASE_DEVICE="jetson", HEAVY_QUEUE="1"))
    try:
        assert s.light is None and s.heavy is None and s.agent.heavy is None
        assert isinstance(s.egress, Egress)
    finally:
        s.close()


def test_light_follows_events_until_close(tmp_path):
    s = Services.create(make_settings(tmp_path))
    shown = []
    s.light.show = lambda state: shown.append(state) or True
    events.emit("working", "job-1")
    s.close()
    events.emit("idle", "job-1")
    assert shown == ["working"]


# ----- review fixes: quiet eval events, restart cleanup, router adapter (correctness F3, F7, device F5) -----


def test_eval_services_never_reach_the_device_event_bus(tmp_path):
    seen = []
    unsubscribe = events.subscribe(lambda e: seen.append(e.state))
    s = Services.for_eval(make_settings(tmp_path))
    try:
        s.egress.release("eval", "list", "- Notes (notes.md)", "dreaming_report", synthetic=True)
        s.night.events.emit("working", "dreaming x")
    finally:
        s.close()
        unsubscribe()
    assert seen == []


def test_create_fails_jobs_a_stopped_process_left_running(tmp_path):
    settings = make_settings(tmp_path)
    settings.ensure_home()
    jobs = JobStore(settings.paths.db)
    left = jobs.create("private_task", "Grade", "essays")
    jobs.start(left)
    s = Services.create(settings, light=False)
    try:
        job = s.jobs.get(left)
        assert job["status"] == "failed" and "restarted" in job["error"]
    finally:
        s.close()
    # the eval's throwaway services never touch another process's jobs
    other = jobs.create("private_task", "Grade", "essays")
    jobs.start(other)
    e = Services.for_eval(settings)
    try:
        assert e.jobs.get(other)["status"] == "running"
    finally:
        e.close()


class FakeSerial:
    def __init__(self, lines):
        self.lines = lines

    def write(self, data):
        self.lines.append(data.decode())

    def flush(self):
        return None

    def close(self):
        return None


def test_a_restart_with_a_card_waiting_shows_waiting_on_the_light_and_the_page(tmp_path, monkeypatch):
    import base.light

    settings = make_settings(tmp_path, LIGHT_SERIAL="/dev/fake-light")
    settings.ensure_home()
    store = ApprovalStore(settings.paths.db)  # a card left waiting by the process before the restart
    store.create_pending(tool="get_result", request="Scores", result_kind="per_student",
                         tagged_text="[Student A]: 3 of 4", router_decision="ask_user")  # fmt: skip
    store.close()
    lines: list[str] = []
    monkeypatch.setattr(base.light, "open_serial", lambda port: FakeSerial(lines))
    events.emit("idle", "before the restart")  # a fresh process starts at idle
    s = Services.create(settings)
    try:
        assert events.last().state == "waiting"
        assert lines[0] == "STATE waiting\n"
    finally:
        s.close()


def test_a_restart_with_nothing_waiting_stays_idle(tmp_path):
    events.emit("working", "before the restart")
    s = Services.create(make_settings(tmp_path), light=False)
    try:
        assert events.last().state == "idle"
    finally:
        s.close()


def test_router_adapter_is_found_by_its_file_name(tmp_path):
    import httpx
    import respx

    from base.services import discover_router_adapter

    settings = make_settings(
        tmp_path, GLIMMER_BACKEND="llama_server", DREAMING_BACKEND="lora", ROUTER_URL="http://127.0.0.1:8082/v1"
    )
    llm = LocalLLM(settings, role="router")
    with respx.mock:
        respx.get("http://127.0.0.1:8082/lora-adapters").mock(
            return_value=httpx.Response(200, json=[{"id": 0, "path": "/x/other.gguf"}, {"id": 1, "path": "/x/router.gguf"}])
        )
        assert discover_router_adapter(settings, llm) == 1
    with respx.mock:
        respx.get("http://127.0.0.1:8082/lora-adapters").mock(side_effect=httpx.ConnectError("down"))
        assert discover_router_adapter(settings, llm) is None
    assert discover_router_adapter(make_settings(tmp_path), llm) is None  # prompt backend: never
