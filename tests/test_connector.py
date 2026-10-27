"""Connector tests: the six MCP tools, egress on every result, auth, health and the audit log.

All names are invented. Services are fakes in a SimpleNamespace; the fake egress records every
call and returns a marked text, so a test can tell released text from raw text.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace

import httpx
import httpx2
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from base.config import CloudBackendRefused
from base.connector import server
from base.connector.audit import Audit, audit, recent
from base.connector.server import build_server, connector_app, read_or_create_token

REAL_A = "Zephyrine Quoll"
REAL_B = "Barnaby Thistlewick"
TAG_A = "[Student A]"
TAG_B = "[Student B]"
ALL_TOOLS = {
    "list_documents",
    "search_documents",
    "run_private_task",
    "get_result",
    "run_dreaming",
    "dreaming_report",
}
BASE_URL = "http://127.0.0.1:8790"


class FakeEgress:
    """Records every release and returns tagged text marked with RELEASED."""

    def __init__(self):
        self.calls: list[dict] = []
        self.resolved: list[str] = []
        self.status = "shared"
        self.resolve_status = "shared"
        self.fail = False

    def _tag(self, text: str) -> str:
        return text.replace(REAL_A, TAG_A).replace(REAL_B, TAG_B)

    def release(self, tool, request, raw_text, result_kind, *, job_id=None, summary=None, topics=(), **kw):
        if self.fail:
            raise RuntimeError(f"model error while reading {REAL_A} essay.md")
        self.calls.append(
            {
                "tool": tool,
                "request": request,
                "raw_text": raw_text,
                "result_kind": result_kind,
                "job_id": job_id,
                "summary": summary,
                "topics": list(topics),
            }
        )
        n = len(self.calls)
        if self.status == "waiting":
            text = "This result is waiting for your OK on the device."
        elif self.status == "refused":
            text = "Kept on the device: it mentions an IEP."
        else:
            text = f"RELEASED {n}: {self._tag(raw_text)}"
        return SimpleNamespace(
            status=self.status,
            text=text,
            approval_id=n if self.status == "waiting" else None,
            decision="share_tagged",
            tag_result=SimpleNamespace(tag_map={TAG_A: REAL_A}),
        )

    def resolve(self, approval_id):
        self.resolved.append(approval_id)
        text = f"RESOLVED {approval_id}: {TAG_A} scored 3"
        if self.resolve_status == "waiting":
            text = "This result is waiting for your OK on the device."
        return SimpleNamespace(
            status=self.resolve_status, text=text, approval_id=approval_id, decision="share_tagged"
        )

    def outputs(self) -> list[str]:
        return [f"RELEASED {i}: {self._tag(c['raw_text'])}" for i, c in enumerate(self.calls, 1)]


class FakeIndex:
    def __init__(self, root: Path):
        self.root = root
        essays = root / "essays"
        self.folders = {
            "essays": [
                SimpleNamespace(
                    id="d1", path=essays / f"{REAL_A} essay.md", title=f"{REAL_A} essay", size=900, modified=0
                ),
                SimpleNamespace(
                    id="d2", path=essays / f"{REAL_B} essay.md", title=f"{REAL_B} essay", size=800, modified=0
                ),
                SimpleNamespace(id="d3", path=essays / "rubric.md", title="rubric", size=300, modified=0),
            ],
            "empty": [],
            REAL_A: [
                SimpleNamespace(id="d4", path=root / REAL_A / "notes.md", title="notes", size=10, modified=0)
            ],
        }
        self.listed: list[str] = []
        self.searched: list[tuple[str, int]] = []
        self.refuse = False

    def list(self, folder):
        self.listed.append(folder)
        if self.refuse:
            raise CloudBackendRefused("not marked")
        if ".." in folder or folder not in self.folders:
            raise FileNotFoundError(folder)
        return self.folders[folder]

    def search(self, query, k=5):
        self.searched.append((query, k))
        long_text = f"{REAL_A} argues that " + "evidence matters a great deal " * 30
        return [
            SimpleNamespace(doc_id=f"d{i}", title=f"{REAL_A} essay", text=long_text, score=1.0)
            for i in range(7)
        ]


class FakeJobs:
    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.releases: list[tuple] = []

    def get(self, job_id):
        return self.rows.get(job_id)

    def set_release(self, job_id, status, approval_id=None, released_text=None):
        """Like JobStore: approval_id is stored as TEXT and the job status moves with the release."""
        self.releases.append((job_id, status, approval_id, released_text))
        row = self.rows[job_id]
        row.update(release_status=status, released_text=released_text)
        if approval_id is not None:
            row["approval_id"] = str(approval_id)
        if row["status"] in ("done", "waiting_for_approval", "refused"):
            row["status"] = {"waiting": "waiting_for_approval", "refused": "refused"}.get(status, "done")


class FakeAgent:
    def __init__(self, jobs: FakeJobs):
        self.jobs = jobs
        self.calls: list[tuple[str, str]] = []

    def run_private_task(self, instructions, folder):
        self.calls.append((instructions, folder))
        job_id = f"job-{len(self.calls)}"
        self.jobs.rows[job_id] = {
            "id": job_id,
            "status": "queued",
            "instructions": instructions,
            "folder": folder,
        }
        return job_id


class FakeNight:
    def __init__(self):
        self.starts = 0
        self.report = SimpleNamespace(
            learned_from=42,
            accuracy_before=0.81,
            accuracy_after=0.865,
            agreement_before=0.78,
            agreement_after=0.84,
            kept=True,
            leaks=0,
            seconds=12.5,
            detail=f"learned that {REAL_A} essays are private",  # not a contract field; must never leave
        )

    def start(self):
        self.starts += 1
        return "dream-1"

    def last_report(self):
        return self.report


def fake_restore(services, text):
    services.restored.append(text)
    return text.replace(TAG_A, REAL_A).replace("Student A", REAL_A)


@pytest.fixture
def services(settings, tmp_path, monkeypatch):
    monkeypatch.setattr(server, "restore_tags", fake_restore)
    jobs = FakeJobs()
    return SimpleNamespace(
        settings=settings,
        egress=FakeEgress(),
        index=FakeIndex(settings.workspace_root),
        jobs=jobs,
        agent=FakeAgent(jobs),
        night=FakeNight(),
        audit=Audit(tmp_path / "base.db"),
        tagmap={TAG_A: REAL_A},
        restored=[],
    )


class Muse:
    """Calls the tools like Muse would, through the SDK's in-process client.

    One session per call: an async yield fixture cannot hold the SDK's task group open
    across pytest-asyncio's setup and test tasks.
    """

    def __init__(self, services):
        self.server = build_server(services)

    async def call_tool(self, name, args):
        async with Client(self.server) as c:
            return await c.call_tool(name, args)

    async def list_tools(self):
        async with Client(self.server) as c:
            return await c.list_tools()


@pytest.fixture
def client(services):
    return Muse(services)


def text_of(result) -> str:
    assert len(result.content) == 1
    return result.content[0].text


def outcomes(services) -> list[tuple[str, str]]:
    return [(r["tool"], r["outcome"]) for r in reversed(services.audit.recent(100))]


def assert_no_real_names(text: str) -> None:
    assert REAL_A not in text and REAL_B not in text
    assert "Zephyrine" not in text and "Quoll" not in text and "Thistlewick" not in text


# Tool listing


async def test_six_tools_with_muse_annotations(client):
    tools = {t.name: t for t in (await client.list_tools()).tools}
    assert set(tools) == ALL_TOOLS
    for name in ("list_documents", "search_documents", "get_result", "dreaming_report"):
        assert tools[name].annotations.read_only_hint is True, name
        assert tools[name].annotations.open_world_hint is False
    task, dream = tools["run_private_task"].annotations, tools["run_dreaming"].annotations
    assert (task.read_only_hint, task.destructive_hint, task.idempotent_hint) == (False, False, False)
    assert (dream.read_only_hint, dream.destructive_hint, dream.idempotent_hint) == (False, False, True)
    assert set(tools["run_private_task"].input_schema["required"]) == {"instructions", "folder"}
    assert tools["get_result"].input_schema["required"] == ["job_id"]
    assert tools["run_dreaming"].input_schema.get("properties", {}) == {}


async def test_descriptions_written_for_muse(client):
    tools = {t.name: t for t in (await client.list_tools()).tools}
    joined = server.INSTRUCTIONS + " ".join(t.description for t in tools.values())
    assert "—" not in joined and "–" not in joined  # no em or en dashes
    assert "[Student A]" in server.INSTRUCTIONS and "OK on the device" in server.INSTRUCTIONS
    assert "never sent to you" in server.INSTRUCTIONS
    assert "[Student A]" in tools["search_documents"].description
    assert "OK on the device" in tools["get_result"].description
    assert "real names" in tools["run_private_task"].description
    async with Client(client.server) as c:
        assert c.instructions == server.INSTRUCTIONS


# Read tools


async def test_list_documents_goes_through_egress(client, services):
    result = await client.call_tool("list_documents", {"folder": "essays"})
    assert not result.is_error
    [call] = services.egress.calls
    assert call["tool"] == "list_documents" and call["result_kind"] == "document_list"
    assert f"{REAL_A} essay (essays/{REAL_A} essay.md)" in call["raw_text"]
    assert str(services.settings.workspace_root) not in call["raw_text"]  # no absolute paths
    assert text_of(result) == services.egress.outputs()[0]
    assert_no_real_names(text_of(result))
    assert outcomes(services) == [("list_documents", "shared")]


async def test_list_documents_restores_tags_in_folder_and_never_echoes_them(client, services):
    result = await client.call_tool("list_documents", {"folder": TAG_A})
    assert services.index.listed == [REAL_A]
    assert_no_real_names(text_of(result))
    missing = await client.call_tool("list_documents", {"folder": "no such folder"})
    assert missing.is_error and "no such folder" in text_of(missing)
    assert len(services.egress.calls) == 1  # the error never touched document text


async def test_search_restores_tags_and_releases_short_snippets(client, services):
    result = await client.call_tool("search_documents", {"query": f"{TAG_A} thesis"})
    assert services.index.searched == [(f"{REAL_A} thesis", 5)]
    [call] = services.egress.calls
    assert call["request"] == f"{TAG_A} thesis"  # Muse's tag-only request, not the restored one
    assert call["result_kind"] == "snippet"
    assert call["raw_text"].count(f"{REAL_A} essay") == 5  # at most 5 even if the index returns more
    for block in call["raw_text"].split("\n\n"):
        assert len(block.split("\n", 1)[1]) <= server.SNIPPET_CHARS + 4
    assert text_of(result) == services.egress.outputs()[0]
    assert_no_real_names(text_of(result))


async def test_dreaming_report_is_numbers_only(client, services):
    result = await client.call_tool("dreaming_report", {})
    [call] = services.egress.calls
    assert call["result_kind"] == "dreaming_report"
    raw = call["raw_text"]
    assert "42" in raw and "0.865" in raw and "yes" in raw and "12.5" in raw
    assert "learned that" not in raw and REAL_A not in raw
    assert text_of(result) == services.egress.outputs()[0]


async def test_dreaming_report_before_any_run(client, services):
    services.night.report = None
    result = await client.call_tool("dreaming_report", {})
    assert services.egress.calls[0]["raw_text"] == "No dreaming run has finished yet."
    assert text_of(result).startswith("RELEASED 1")
    # NightRunner.last_report() before the first night: zeros and None
    keys = (
        "accuracy_before",
        "accuracy_after",
        "agreement_before",
        "agreement_after",
        "kept",
        "leaks",
        "seconds",
    )
    services.night.report = {k: None for k in keys} | {"night_number": 0, "learned_from": 0}
    await client.call_tool("dreaming_report", {})
    assert services.egress.calls[1]["raw_text"] == "No dreaming run has finished yet."


# Write tools


async def test_run_private_task_starts_a_job(client, services):
    result = await client.call_tool(
        "run_private_task", {"instructions": f"Grade {TAG_A} against rubric.md", "folder": "essays"}
    )
    assert not result.is_error
    assert result.structured_content == {"job_id": "job-1", "status": "queued"}
    assert json.loads(text_of(result)) == {"job_id": "job-1", "status": "queued"}
    assert services.agent.calls == [(f"Grade {TAG_A} against rubric.md", "essays")]
    assert outcomes(services) == [("run_private_task", "started")]


@pytest.mark.parametrize(
    ("args", "expect"),
    [
        ({"instructions": "Grade them", "folder": "../etc"}, "There is no folder"),
        ({"instructions": "Grade them", "folder": "missing"}, "There is no folder"),
        ({"instructions": "Grade them", "folder": "empty"}, "has no documents"),
        ({"instructions": "   ", "folder": "essays"}, "Say what to do"),
    ],
)
async def test_run_private_task_rejects_bad_input(client, services, args, expect):
    result = await client.call_tool("run_private_task", args)
    assert result.is_error
    assert expect in text_of(result)
    assert "Traceback" not in text_of(result)
    assert services.agent.calls == []
    assert outcomes(services) == [("run_private_task", "bad_input")]


async def test_run_dreaming_is_idempotent(client, services):
    first = await client.call_tool("run_dreaming", {})
    second = await client.call_tool("run_dreaming", {})
    assert first.structured_content == second.structured_content == {"job_id": "dream-1", "status": "running"}
    assert services.night.starts == 2


async def test_run_dreaming_accepts_a_status_mapping(client, services):
    services.night.start = lambda: {"job_id": "dream-7", "status": "queued"}
    result = await client.call_tool("run_dreaming", {})
    assert result.structured_content == {"job_id": "dream-7", "status": "queued"}
    assert services.egress.calls == []  # only a job id and a status leave


# get_result and the "Jobs and releases" flow


def add_job(services, job_id="job-9", **fields):
    row = {
        "id": job_id,
        "status": "done",
        "instructions": f"Grade {TAG_A}",
        "result_kind": "per_student",
        "raw_result": f"{REAL_A}: 3/4\n{REAL_B}: 4/4",
        "summary": "Class average 3.5 of 4",
        "topics": json.dumps(["grades"]),
        "release_status": "none",
        "approval_id": None,
        "released_text": None,
        "error": None,
    }
    row.update(fields)
    services.jobs.rows[job_id] = row
    return job_id


async def test_get_result_releases_once_then_resends(client, services):
    job_id = add_job(services)
    first = await client.call_tool("get_result", {"job_id": job_id})
    [call] = services.egress.calls
    assert call == {
        "tool": "get_result",
        "request": f"Grade {TAG_A}",
        "raw_text": f"{REAL_A}: 3/4\n{REAL_B}: 4/4",
        "result_kind": "per_student",
        "job_id": job_id,
        "summary": "Class average 3.5 of 4",
        "topics": ["grades"],
    }
    body = json.loads(text_of(first))
    assert body == {"job_id": job_id, "status": "shared", "result": services.egress.outputs()[0]}
    assert_no_real_names(text_of(first))
    assert services.jobs.releases == [(job_id, "shared", None, services.egress.outputs()[0])]

    again = await client.call_tool("get_result", {"job_id": job_id})
    assert json.loads(text_of(again)) == body
    assert len(services.egress.calls) == 1  # the stored released text is resent, not re-released


async def test_get_result_waits_then_resolves(client, services):
    job_id = add_job(services)
    services.egress.status = "waiting"
    services.egress.resolve_status = "waiting"
    first = json.loads(text_of(await client.call_tool("get_result", {"job_id": job_id})))
    assert first["status"] == "waiting" and "OK on the device" in first["result"]
    assert services.jobs.rows[job_id]["approval_id"] == "1"  # stored as TEXT, like JobStore
    assert services.jobs.rows[job_id]["status"] == "waiting_for_approval"

    still = json.loads(text_of(await client.call_tool("get_result", {"job_id": job_id})))
    assert still["status"] == "waiting" and services.egress.resolved == [1]  # an int again for egress
    assert len(services.egress.calls) == 1

    services.egress.resolve_status = "shared"
    done = json.loads(text_of(await client.call_tool("get_result", {"job_id": job_id})))
    assert done == {"job_id": job_id, "status": "shared", "result": f"RESOLVED 1: {TAG_A} scored 3"}
    assert services.jobs.rows[job_id]["release_status"] == "shared"
    assert len(services.egress.calls) == 1


async def test_get_result_refused_keeps_it_on_device(client, services):
    job_id = add_job(services)
    services.egress.status = "refused"
    body = json.loads(text_of(await client.call_tool("get_result", {"job_id": job_id})))
    assert body["status"] == "refused" and body["result"] == "Kept on the device: it mentions an IEP."
    assert services.jobs.rows[job_id]["status"] == "refused"
    again = json.loads(text_of(await client.call_tool("get_result", {"job_id": job_id})))
    assert again == body and len(services.egress.calls) == 1  # the stored egress text, not re-released


async def test_get_result_for_a_job_refused_before_release(client, services):
    job_id = add_job(services, status="refused")
    body = json.loads(text_of(await client.call_tool("get_result", {"job_id": job_id})))
    assert body["status"] == "refused" and "nothing was shared" in body["result"]
    assert services.egress.calls == []


@pytest.mark.parametrize(
    ("status", "outcome"), [("queued", "pending"), ("running", "pending"), ("failed", "failed")]
)
async def test_get_result_before_done_shares_nothing(client, services, status, outcome):
    job_id = add_job(services, status=status, error=f"could not parse {REAL_A} essay.md")
    result = await client.call_tool("get_result", {"job_id": job_id})
    body = json.loads(text_of(result))
    assert body["status"] == status and body["job_id"] == job_id
    assert_no_real_names(text_of(result))
    assert services.egress.calls == []
    assert outcomes(services) == [("get_result", outcome)]


async def test_get_result_unknown_job(client, services):
    result = await client.call_tool("get_result", {"job_id": "nope"})
    assert result.is_error and "There is no job" in text_of(result)


# Every result goes through egress


async def test_every_text_result_is_an_egress_output(client, services):
    job_id = add_job(services)
    texts = [
        text_of(await client.call_tool("list_documents", {"folder": "essays"})),
        text_of(await client.call_tool("search_documents", {"query": "evidence"})),
        json.loads(text_of(await client.call_tool("get_result", {"job_id": job_id})))["result"],
        text_of(await client.call_tool("dreaming_report", {})),
    ]
    assert texts == services.egress.outputs()
    assert [c["tool"] for c in services.egress.calls] == [
        "list_documents",
        "search_documents",
        "get_result",
        "dreaming_report",
    ]
    for tool, args in (
        ("run_private_task", {"instructions": "Grade", "folder": "essays"}),
        ("run_dreaming", {}),
    ):
        result = await client.call_tool(tool, args)
        assert set(result.structured_content) == {"job_id", "status"}
        assert_no_real_names(text_of(result))


# Errors stay plain


async def test_sdk_argument_errors_become_plain_messages(client, services):
    result = await client.call_tool("list_documents", {"folder": 3})
    assert result.is_error
    text = text_of(result)
    assert text.startswith("The device could not use those arguments.") and "folder" in text
    assert "validation" not in text.lower() and "pydantic" not in text.lower()
    long = await client.call_tool("search_documents", {"query": "x" * 600})
    assert long.is_error and "query" in text_of(long)
    missing = await client.call_tool("get_result", {})
    assert missing.is_error and "job_id" in text_of(missing)
    assert outcomes(services) == [
        ("list_documents", "bad_input"),
        ("search_documents", "bad_input"),
        ("get_result", "bad_input"),
    ]


async def test_crash_returns_generic_message_without_content(client, services):
    services.egress.fail = True
    result = await client.call_tool("list_documents", {"folder": "essays"})
    assert result.is_error and text_of(result) == server.GENERIC_ERROR
    assert outcomes(services) == [("list_documents", "error")]


async def test_cloud_backend_refusal_is_plain(client, services):
    services.index.refuse = True
    result = await client.call_tool("list_documents", {"folder": "essays"})
    assert result.is_error and text_of(result) == server.CLOUD_REFUSED
    assert outcomes(services) == [("list_documents", "cloud_refused")]


async def test_broken_audit_never_breaks_a_tool(client, services):
    def broken(tool, outcome, ms=0):
        raise OSError("disk full")

    services.audit = broken
    result = await client.call_tool("run_dreaming", {})
    assert not result.is_error


def test_default_restore_uses_guard_and_tagmap(monkeypatch):
    guard = ModuleType("base.guard")
    guard.restore = lambda text, tag_map: text.replace(TAG_A, tag_map[TAG_A])
    monkeypatch.setitem(sys.modules, "base.guard", guard)

    class TagMap:
        def as_dict(self):
            return {TAG_A: REAL_A}

    assert server.restore_tags(SimpleNamespace(tagmap=TagMap()), f"{TAG_A} essay") == f"{REAL_A} essay"
    assert server.restore_tags(SimpleNamespace(tagmap={TAG_A: REAL_A}), TAG_A) == REAL_A
    with_attr = SimpleNamespace(tag_map={TAG_A: REAL_A})
    assert server.restore_tags(SimpleNamespace(tagmap=with_attr), TAG_A) == REAL_A


# HTTP app: token, auth, health


def test_token_created_0600_and_reused(tmp_path):
    path = tmp_path / "home" / "connector_token"
    token = read_or_create_token(path)
    assert len(token) >= 43
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert read_or_create_token(path) == token


def test_connector_app_reads_token_from_settings(services):
    connector_app(services)
    path = services.settings.paths.connector_token
    assert path.is_file() and stat.S_IMODE(os.stat(path).st_mode) == 0o600


INIT = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "t", "version": "1"},
    },
}
MCP_HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}


@asynccontextmanager
async def open_http(services):
    app = connector_app(services, token="right-token")
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=BASE_URL) as h:
            yield h


async def test_health_needs_no_token(services):
    async with open_http(services) as http:
        resp = await http.get("/health")
    assert resp.status_code == 200 and resp.json() == {"status": "ok"}


@pytest.mark.parametrize(
    "auth", [None, "Bearer wrong-token", "Bearer right-token-and-more", "Basic right-token", "right-token"]
)
async def test_mcp_rejects_missing_or_wrong_token(services, auth):
    headers = dict(MCP_HEADERS)
    if auth is not None:
        headers["authorization"] = auth
    async with open_http(services) as http:
        resp = await http.post("/mcp", json=INIT, headers=headers)
    assert resp.status_code == 401
    assert resp.json() == {"error": "unauthorized"}
    assert services.egress.calls == []


async def test_mcp_accepts_the_device_token(services):
    async with open_http(services) as http:
        resp = await http.post(
            "/mcp", json=INIT, headers={**MCP_HEADERS, "authorization": "Bearer right-token"}
        )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json()["result"]["serverInfo"]["name"] == "muse-privacy"


async def test_end_to_end_sdk_client_over_streamable_http(services):
    """The SDK's own streamable HTTP client, talking to the ASGI app in process (no sockets)."""
    app = connector_app(services, token="right-token")
    async with app.router.lifespan_context(app):
        transport = httpx2.ASGITransport(app=app)
        async with httpx2.AsyncClient(
            transport=transport, base_url=BASE_URL, headers={"authorization": "Bearer right-token"}
        ) as h:
            async with Client(streamable_http_client(f"{BASE_URL}/mcp", http_client=h)) as c:
                assert {t.name for t in (await c.list_tools()).tools} == ALL_TOOLS
                result = await c.call_tool("list_documents", {"folder": "essays"})
    assert text_of(result) == services.egress.outputs()[0]
    assert_no_real_names(text_of(result))


# Audit log


def test_audit_rows_have_no_content(tmp_path):
    db = tmp_path / "base.db"
    audit(db, "list_documents", "shared", 12)
    audit(db, "get_result", "waiting")
    rows = recent(db, 10)
    assert [(r["tool"], r["outcome"], r["ms"]) for r in rows] == [
        ("get_result", "waiting", 0),
        ("list_documents", "shared", 12),
    ]
    assert set(rows[0]) == {"ts", "tool", "outcome", "ms"}
    for bad in (f"{REAL_A} essay", "Shared", "x" * 41, ""):
        with pytest.raises(ValueError):
            audit(db, "list_documents", bad)
    assert len(recent(db, 10)) == 2


def test_audit_class_is_callable_like_services_audit(tmp_path, settings):
    log = Audit.for_settings(settings)
    log("run_dreaming", "started", ms=3)
    assert log.recent(1)[0]["outcome"] == "started"
    assert log.db_path == settings.paths.db
    assert recent(settings.paths.db, 5) == log.recent(5)
