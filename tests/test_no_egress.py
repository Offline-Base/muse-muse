"""No network leaves the device through any connector tool (docs/COMPLIANCE_PLAN.md, task 1.4).

Real Services in DEVICE_ONLY mode over copies of the invented demo files, driven the way Muse
drives them: through the MCP server in process, one tool call at a time. LFM3-VL-2B
(127.0.0.1:8083) and EmbeddingGemma 2 (127.0.0.1:8084) are served in process by respx, so no
socket opens for them. Any other HTTP request is recorded and refused, and the loopback_only
guard (tests/conftest.py) fails any socket connection or name lookup that would leave the device.
Every tool output is checked for the roster's names, nicknames and student ids. The run is then
repeated with each model down (HTTP 503), where results are held and Muse is told nothing was
shared.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import threading
import time

import httpx
import pytest
import respx
from mcp import Client

from base import guard, local_llm
from base.config import REPO_ROOT, load_settings
from base.connector.server import REFUSED_END, build_server
from base.egress import HELD_TEXT
from base.services import Services

CHECKER = "http://127.0.0.1:8083/v1"
EMBED = "http://127.0.0.1:8084/v1"
DEMO = REPO_ROOT / "demo"  # tracked, invented files only
GRADE = "Grade each essay against rubric.md and write feedback for each student, for my own grading."
ROSTER = json.loads((REPO_ROOT / "eval" / "roster.json").read_text())
PEOPLE = [ROSTER["teacher"], *ROSTER["students"]]
FULL_NAMES = [p["name"] for p in PEOPLE]
FORMS = sorted({f for p in PEOPLE for f in (p["name"], p["first"], p["last"], *p["nicknames"])}, key=len)
IDS = [p["student_id"] for p in PEOPLE if p.get("student_id")]
NOT_ON_ROSTER = ["Keoni", "Luciana", "Tomas", "Mr. Delgado"]  # people the demo essays mention
SCAN_TEXT = f"Field trip form. Student: {ROSTER['students'][0]['name']}, ID {IDS[0]}. Parent phone 512-555-0143."
NOTHING_SHARED = "nothing was shared"
HELD_REFUSED = f"{HELD_TEXT} {REFUSED_END}"  # a refused job result ends with the fixed sentence


def private_values(text: str, services) -> list[str]:
    """Roster names and nicknames (as words, case-sensitive), student ids, and guard.leaks hits."""
    found = [f"roster:{f}" for f in FORMS if re.search(rf"(?<!\w){re.escape(f)}(?!\w)", text)]
    found += [f"id:{v}" for v in IDS if v.lower() in text.lower()]
    return found + [f"guard:{h.kind}" for h in guard.leaks(text, services.roster, services.tagmap)]


# ---------------------------------------------------------------- the two local model servers


def _reply(content: str) -> httpx.Response:
    return httpx.Response(200, json={"model": "lfm3-vl-2b", "choices": [{"message": {"content": content}, "finish_reason": "stop"}]})


def fake_lfm(request: httpx.Request) -> httpx.Response:
    """Answers each step like LFM3-VL-2B would, told apart by the response_format name."""
    body = json.loads(request.content)
    fmt = (body.get("response_format") or {}).get("json_schema") or {}
    name, props = fmt.get("name"), (fmt.get("schema") or {}).get("properties", {})
    user = body["messages"][-1]["content"]
    if isinstance(user, list):  # a scanned form: the image is read on the device
        return _reply(SCAN_TEXT)
    tag = (re.findall(r"\[(?:Student [A-Z]+|Person \d+)\]", user) or ["The class"])[0]
    if name == "person_names":  # finds roster names too, as the real model does
        reply = {"names": [n for n in [*FULL_NAMES, *NOT_ON_ROSTER] if n in user]}
    elif name == "request_topics":
        reply = {"topics": []}
    elif name in ("search_queries", "retry_queries"):
        reply = {"queries": ["garden"]}
    elif name == "request_parts":
        reply = {"parts": []}  # asked whole
    elif name == "rag_answer":
        reply = {"passages": [1, 2], "answer": f"{tag} wrote about the school garden."}
    elif name == "device_answer":
        first = re.search(r"\[1\] [^\n]*\n(.+?)(?:\n\n\[2\]|\n\nQuestion:)", user, re.DOTALL)
        quote = " ".join(first.group(1).split())[:60].rsplit(" ", 1)[0] if first else ""
        reply = {"enough": True, "more_queries": [], "answer": f"{tag} wrote about the garden.",
                 "quotes": [{"passage": 1, "quote": quote}] if quote else []}  # fmt: skip
    elif name == "combined_answer":
        reply = {"answer": f"{tag} wrote about the garden."}
    elif name == "route":
        reply = {"decision": "ask_user", "reason": "Fake router."}
    elif "scores" in props:
        essay = re.search(r"Essay:\n# ([^:\n]+)", user)
        who = essay.group(1).strip() if essay else tag
        reply = {
            "scores": {"ideas": 3, "organization": 2, "evidence": 3, "conventions": 4},
            "total": 12,
            "strengths": f"{who} states a clear opinion.",
            "next_step": f"{who} should add one more fact from a source.",
            "feedback": f"Dear {who}, your reasons are clear. Add one more fact.",
        }
    elif "answer" in props:
        reply = {"answer": "Done."}
    else:
        return _reply("Class average 3.0 of 4 across the essays.")  # a class summary
    return _reply(json.dumps(reply))


def fake_embedder(request: httpx.Request) -> httpx.Response:
    texts = json.loads(request.content)["input"]
    data = [{"index": i, "embedding": [1.0, float(len(t) % 7), float(t.count("garden"))]} for i, t in enumerate(texts)]
    return httpx.Response(200, json={"data": data})


def down(request: httpx.Request) -> httpx.Response:
    return httpx.Response(503, json={"error": {"message": "Loading model"}})


@pytest.fixture
def device(tmp_path, monkeypatch, loopback_only):
    """Start the device with the given model servers down: (services, Muse, stray requests, mock)."""
    monkeypatch.setattr(local_llm, "BACKOFF_SECONDS", 0.0)  # retries of a 503 without waiting
    root = tmp_path / "workspace"
    for name in ("essays", "records", "forms"):
        shutil.copytree(DEMO / name, root / name)
    for name in ("rubric.md", ".synthetic"):
        shutil.copy(DEMO / name, root / name)
    stray: list[str] = []
    made = []

    def start(*down_models: str):
        def route(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            for prefix, model, serve in ((CHECKER, "checker", fake_lfm), (EMBED, "embedder", fake_embedder)):
                if url.startswith(prefix + "/"):
                    return down(request) if model in down_models else serve(request)
            stray.append(f"{request.method} {request.url.host}")
            raise httpx.ConnectError("not a model on this device", request=request)

        mock = respx.mock(assert_all_called=False)
        mock.start()
        made.append(mock)
        mock.route().mock(side_effect=route)
        env = {
            "BASE_HOME": str(tmp_path / f"home-{len(made)}"),
            "WORKSPACE_ROOT": str(root),
            "BASE_DEVICE": "laptop",
            "DEVICE_ONLY": "1",
            "SEARCH_EMBEDDINGS": "1",
            "CHECKER_URL": CHECKER,
            "EMBED_URL": EMBED,
            "LIGHT_SERIAL": "",
            "HEAVY_QUEUE": "0",
            # remote settings DEVICE_ONLY must drop, so nothing remote can be built from them
            "OPENROUTER_API_KEY": "or-key",
            "META_API_KEY": "meta-key",
            "JETSON_LFM_BASE": "https://gateway.example.org/v1",
            "JETSON_LFM_API_KEY": "gw-key",
        }
        services = Services.create(load_settings(env), light=False, heavy=False)
        made.append(services)
        return services, Muse(services), stray, mock

    yield start
    for thing in reversed(made):
        if isinstance(thing, Services):
            thing.night.wait(10)
            thing.close()
        else:
            settle_threads()  # nothing may call a model after the stubs go away
            thing.stop()
    assert loopback_only == [] and stray == []


def settle_threads(timeout: float = 10) -> None:
    """Wait for the device's background work (jobs, ask jobs, releases) to end."""
    deadline = time.monotonic() + timeout
    names = ("job-", "ask-", "release-")
    while any(t.name.startswith(names) for t in threading.enumerate()) and time.monotonic() < deadline:
        time.sleep(0.02)


class Muse:
    """Calls the connector's tools the way Muse does (an in-process MCP client) and keeps every output."""

    def __init__(self, services):
        self.server = build_server(services)
        self.outputs: list[str] = []

    def call(self, name: str, args: dict | None = None) -> str:
        async def go():
            async with Client(self.server) as c:
                return await c.call_tool(name, args or {})

        text = asyncio.run(go()).content[0].text
        self.outputs.append(text)
        return text

    def follow(self, text: str, timeout: float = 20) -> dict:
        """A tool's JSON answer, then get_result until it is no longer queued or running."""
        body = json.loads(text)
        deadline = time.monotonic() + timeout
        while body["status"] in ("queued", "running"):
            assert time.monotonic() < deadline, "the job did not finish in time"
            time.sleep(0.05)
            body = json.loads(self.call("get_result", {"job_id": body["job_id"]}))
        return body

    def listing(self, folder: str) -> str | dict:
        """list_documents: plain text when shared, else a job to follow, like a search."""
        text = self.call("list_documents", {"folder": folder})
        return self.follow(text) if text.startswith("{") else text

    def search(self, query: str, purpose: str = "for my own planning") -> str | dict:
        text = self.call("search_documents", {"query": query, "purpose": purpose})
        return self.follow(text) if text.startswith("{") else text


def shared(services, muse: Muse, body):
    """What Muse gets for a waiting result once the user says Share it on the device."""
    if isinstance(body, dict) and body.get("status") == "waiting":
        services.approvals.decide(services.jobs.get(body["job_id"])["approval_id"], approve=True)
        body = json.loads(muse.call("get_result", {"job_id": body["job_id"]}))
    return body


def every_tool(services, muse: Muse) -> dict:
    """Each of the seven tools, with the get_result calls Muse makes, the user's Share it on any
    waiting result, and a search that passes back a tag Muse was given."""
    out: dict = {"top": muse.listing(""), "essays": muse.listing("essays")}
    for card in services.approvals.pending():  # a listing with a name the roster lacks waits; Share it
        services.approvals.decide(card["id"], approve=True)
    out["search"] = shared(services, muse, muse.search("school garden"))
    out["scan"] = shared(services, muse, muse.search("field trip form"))
    asked = muse.call("ask_device", {"question": "Which essays mention the school garden?", "purpose": "for my own planning"})
    out["ask"] = shared(services, muse, muse.follow(asked))
    task = muse.follow(muse.call("run_private_task", {"instructions": GRADE, "folder": "essays"}))
    out["task"] = shared(services, muse, task)
    tags = re.findall(r"\[Student [A-Z]+\]", out["task"].get("result") or "")
    out["search_by_tag"] = shared(services, muse, muse.search(f"{tags[0]} garden")) if tags else None
    out["dream"] = muse.follow(muse.call("run_dreaming"), timeout=25)
    out["report"] = muse.call("dreaming_report")
    return out


def test_every_tool_stays_on_the_device_and_nothing_private_reaches_muse(device):
    started = time.monotonic()
    services, muse, _stray, mock = device()
    out = every_tool(services, muse)
    for key in ("search", "scan", "ask", "task", "search_by_tag"):
        assert out[key]["status"] == "shared", key
    assert "| Total |" in out["task"]["result"] and out["dream"]["status"] == "done"
    assert "Last dreaming run:" in out["report"]
    for text in muse.outputs:
        assert private_values(text, services) == [], text
    bodies = [c.request.content.decode() for c in mock.calls]
    assert any(str(c.request.url).startswith(EMBED) for c in mock.calls)
    assert any('"image_url"' in b for b in bodies)  # a scanned form was read on the device
    files = [p for p in services.settings.home.rglob("*") if p.name.endswith(" feedback.md")]
    assert len(files) == 24  # finished files with real names stay on the device
    assert time.monotonic() - started < 30


def test_with_the_local_model_down_results_are_held_and_nothing_is_shared(device):
    services, muse, _stray, _mock = device("checker")
    out = every_tool(services, muse)
    for key in ("top", "essays", "search", "scan"):
        assert out[key] == {"job_id": out[key]["job_id"], "status": "refused", "result": HELD_REFUSED}
    for key in ("ask", "task"):
        assert out[key]["status"] == "failed" and NOTHING_SHARED in out[key]["result"]
    # no result was routed, so the only decision rows are the numbers-only dreaming report's
    assert all(r["tool"] == "dreaming_report" for r in services.approvals.history(limit=50))
    for text in muse.outputs:
        assert private_values(text, services) == [], text


def test_with_the_embedder_down_search_uses_keywords_and_stays_on_the_device(device):
    services, muse, _stray, mock = device("embedder")
    out = every_tool(services, muse)
    assert isinstance(out["search"], str) or out["search"]["status"] in ("shared", "waiting", "refused")
    assert out["task"]["status"] == "shared"
    assert any(str(c.request.url).startswith(EMBED) for c in mock.calls)  # it was tried, and failed
    for text in muse.outputs:
        assert private_values(text, services) == [], text


def test_the_harness_catches_a_model_client_pointed_off_the_device(device):
    """If any client used a non-loopback address, the run above would fail: shown here by moving
    the checker's address after start-up, which settings never allow."""
    services, muse, stray, _mock = device()
    services.checker_llm.base_url = "https://models.example.org/v1"
    listed = muse.listing("essays")  # the name pass could not run
    assert listed["status"] == "refused" and listed["result"] == HELD_REFUSED
    settle_threads()
    assert stray and set(stray) == {"POST models.example.org"}
    stray.clear()  # caught: the fixture's own check would fail the test otherwise


def test_the_socket_guard_records_what_it_stops(loopback_only):
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        with pytest.raises(AssertionError):
            sock.connect(("192.0.2.1", 443))  # TEST-NET-1, never routed
    finally:
        sock.close()
    assert loopback_only == ["connect 192.0.2.1"]
    loopback_only.clear()

