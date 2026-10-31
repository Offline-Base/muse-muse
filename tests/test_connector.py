"""Connector tests: the eight MCP tools, egress on every result, auth, health and the audit log.

All names are invented. Services are fakes in a SimpleNamespace; the fake egress records every
call and returns a marked text, so a test can tell released text from raw text.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import stat
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace

import httpx
import httpx2
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from base.approvals import ApprovalStore
from base.config import CloudBackendRefused, load_settings
from base.connector import server
from base.connector.audit import CURRENT_VIA, Audit, audit, client_label, recent
from base.connector.server import build_server, connector_app, read_or_create_token
from base.workspace.jobs import JobStore

REAL_A = "Zephyrine Quoll"
REAL_B = "Barnaby Thistlewick"
TAG_A = "[Student A]"
TAG_B = "[Student B]"
ALL_TOOLS = {
    "list_documents",
    "search_documents",
    "ask_device",
    "run_private_task",
    "save_on_device",
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
                **({"kw": kw} if any(kw.values()) else {}),
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

    def job_for_result(self, kind, instructions, raw_result, result_kind, sources=()):
        """Like JobStore: an identical result still being released keeps its job, with its sources."""
        for row in self.rows.values():
            same = (row.get("kind"), row["instructions"], row.get("raw_result")) == (kind, instructions, raw_result)
            if same and row.get("release_status") in ("none", "releasing", "waiting"):
                return row["id"]
        job_id = f"{kind}-{len(self.rows) + 1}"
        self.rows[job_id] = {
            "id": job_id,
            "kind": kind,
            "status": "done",
            "instructions": instructions,
            "result_kind": result_kind,
            "raw_result": raw_result,
            "release_status": "none",
            "approval_id": None,
            "released_text": None,
            "topics": [],
            "sources": list(sources),
        }
        return job_id

    def set_release(self, job_id, status, approval_id=None, released_text=None):
        """Like JobStore: approval_id is an int and the job status moves with the release."""
        self.releases.append((job_id, status, approval_id, released_text))
        row = self.rows[job_id]
        row.update(release_status=status, released_text=released_text)
        if approval_id is not None:
            row["approval_id"] = int(approval_id)
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


async def test_eight_tools_with_muse_annotations(client):
    tools = {t.name: t for t in (await client.list_tools()).tools}
    assert set(tools) == ALL_TOOLS
    for name in ("list_documents", "search_documents", "ask_device", "get_result", "dreaming_report"):
        assert tools[name].annotations.read_only_hint is True, name
        assert tools[name].annotations.open_world_hint is False
    task, dream = tools["run_private_task"].annotations, tools["run_dreaming"].annotations
    assert (task.read_only_hint, task.destructive_hint, task.idempotent_hint) == (False, False, False)
    save = tools["save_on_device"].annotations  # a write, not destructive, not idempotent (MUSE-8)
    assert (save.read_only_hint, save.destructive_hint, save.idempotent_hint, save.open_world_hint) == (False, False, False, False)
    assert set(tools["save_on_device"].input_schema["required"]) == {"items", "purpose"}
    # Not idempotent: a call after a night ends starts another night (review correctness F10).
    assert (dream.read_only_hint, dream.destructive_hint, dream.idempotent_hint) == (False, False, False)
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
    # Request topics need Muse to say who a result is for (review gap: request topics).
    assert "who a result is for" in server.INSTRUCTIONS and "for the family newsletter" in server.INSTRUCTIONS
    assert "who the result is for" in tools["run_private_task"].description
    assert "purpose" in tools["search_documents"].description
    assert "search_documents" in tools["get_result"].description
    search_args = tools["search_documents"].input_schema
    assert set(search_args["properties"]) == {"query", "purpose"} and search_args["required"] == ["query"]
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


async def test_list_documents_holds_back_only_never_share_titles(client, services):
    services.policy = SimpleNamespace(never_share={"iep": ["IEP", "504 plan"], "medical": ["asthma"]})
    services.index.folders["records"] = [
        SimpleNamespace(id="r1", path="records/attendance.md", title="Attendance", size=1, modified=0),
        SimpleNamespace(id="r2", path="records/plans.md", title="IEP and 504 plan notes", size=1, modified=0),
        SimpleNamespace(id="r3", path="records/asthma.md", title="Health office", size=1, modified=0),
        SimpleNamespace(id="r4", path="records/iep_504_notes.md", title="Room notes", size=1, modified=0),
    ]
    result = await client.call_tool("list_documents", {"folder": "records"})
    [call] = services.egress.calls
    assert call["result_kind"] == "document_list"
    raw = call["raw_text"]
    assert "Attendance (records/attendance.md)" in raw
    # "_" is not a letter, so iep_504_notes names an IEP (review F1: snake_case hid it).
    assert "iep_504_notes" not in raw
    assert "IEP" not in raw and "asthma" not in raw  # title and path keywords both count
    assert raw.startswith("1 documents in folder records:")
    assert raw.endswith("3 documents held back on the device.")
    assert text_of(result) == services.egress.outputs()[0]


async def test_list_documents_all_held_back(client, services):
    services.policy = SimpleNamespace(never_share={"iep": ["IEP"]})
    services.index.folders["plans"] = [
        SimpleNamespace(id="p1", path="plans/a.md", title="IEP review", size=1, modified=0)
    ]
    await client.call_tool("list_documents", {"folder": "plans"})
    assert services.egress.calls[0]["raw_text"] == (
        "No documents to show in folder plans.\n1 document held back on the device."
    )


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
    job = services.jobs.rows[call["job_id"]]  # released as a search job, like a task's result
    assert job["kind"] == "search" and job["release_status"] == "shared"
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
    expected = {
        "job_id": "job-1",
        "status": "queued",
        "result": server.TASK_STARTED_NOTE,
        "retry_after_seconds": server.RETRY_AFTER_SECONDS,
        "next": server.NEXT_STEP,
    }
    assert result.structured_content == expected
    assert json.loads(text_of(result)) == expected
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
    assert first.structured_content == second.structured_content == {
        "job_id": "dream-1",
        "status": "running",
        "result": server.DREAM_STARTED_NOTE,
        "retry_after_seconds": server.RETRY_AFTER_SECONDS,
        "next": server.NEXT_STEP,
    }
    assert services.night.starts == 2


async def test_run_dreaming_accepts_a_status_mapping(client, services):
    services.night.start = lambda: {"job_id": "dream-7", "status": "queued"}
    result = await client.call_tool("run_dreaming", {})
    body = result.structured_content
    assert (body["job_id"], body["status"], body["result"]) == ("dream-7", "queued", server.DREAM_STARTED_NOTE)
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
    assert services.jobs.rows[job_id]["approval_id"] == 1  # an int, like JobStore
    assert services.jobs.rows[job_id]["status"] == "waiting_for_approval"

    still = json.loads(text_of(await client.call_tool("get_result", {"job_id": job_id})))
    assert still["status"] == "waiting" and services.egress.resolved == [1]
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
    assert body["status"] == "refused"
    assert body["result"] == f"Kept on the device: it mentions an IEP. {server.REFUSED_END}"
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
        # Only the job id, a status and fixed sentences leave.
        assert set(result.structured_content) == {"job_id", "status", "result", "retry_after_seconds", "next"}
        assert result.structured_content["result"] in (server.TASK_STARTED_NOTE, server.DREAM_STARTED_NOTE)
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
    long_purpose = await client.call_tool("search_documents", {"query": "x", "purpose": "y" * 400})
    assert long_purpose.is_error and "purpose" in text_of(long_purpose)
    missing = await client.call_tool("get_result", {})
    assert missing.is_error and "job_id" in text_of(missing)
    assert outcomes(services) == [
        ("list_documents", "bad_input"),
        ("search_documents", "bad_input"),
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
    assert set(rows[0]) == {"ts", "tool", "outcome", "ms", "via"}
    assert {r["via"] for r in rows} == {"local"}
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


# ----- review fixes: one release per job, retryable checks, dreaming ids, GET (correctness F1, F2, F10) -----


class SlowEgress(FakeEgress):
    """FakeEgress that takes a while and can say a check could not run."""

    def __init__(self, delay=0.0, retryable_first=0):
        super().__init__()
        self.delay, self.retryable_first = delay, retryable_first

    def release(self, *args, **kw):
        import time as _time

        _time.sleep(self.delay)
        out = super().release(*args, **kw)
        if self.retryable_first > 0:
            self.retryable_first -= 1
            return SimpleNamespace(status="refused", text="Held on your device.", approval_id=None,
                                   decision=None, retryable=True)
        out.retryable = False
        return out


def real_jobs(tmp_path):
    jobs = JobStore(tmp_path / "jobs.db")
    job_id = jobs.create("private_task", "Grade the essays", "essays")
    jobs.finish(job_id, f"{REAL_A}: 3 of 4", "per_student", summary="Average 3", topics=["grades"])
    return jobs, job_id


def test_concurrent_get_result_releases_once(services, tmp_path):
    import concurrent.futures

    services.jobs, job_id = real_jobs(tmp_path)
    services.egress = SlowEgress(delay=0.3)
    services.egress.status = "waiting"
    c = server.Connector(services)
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: c.get_result(job_id)[0].structured_content, range(2)))
    assert len(services.egress.calls) == 1
    assert sorted(r["status"] for r in results) == ["running", "waiting"]
    assert services.jobs.get(job_id)["approval_id"] == 1


def test_slow_release_answers_running_and_finishes_in_the_background(services, tmp_path, monkeypatch):
    monkeypatch.setattr(server, "RELEASE_WAIT_SECONDS", 0.05)
    services.jobs, job_id = real_jobs(tmp_path)
    services.egress = SlowEgress(delay=0.4)
    c = server.Connector(services)
    first = c.get_result(job_id)[0].structured_content
    assert first["status"] == "running" and REAL_A not in first["result"]
    import time as _time

    _time.sleep(0.6)
    second = c.get_result(job_id)[0].structured_content
    assert second["status"] == "shared" and len(services.egress.calls) == 1


def test_a_check_that_could_not_run_is_tried_again(services, tmp_path):
    services.jobs, job_id = real_jobs(tmp_path)
    services.egress = SlowEgress(retryable_first=1)
    c = server.Connector(services)
    assert c.get_result(job_id)[0].structured_content["status"] == "running"
    assert services.jobs.get(job_id)["release_status"] == "none"  # not stored as refused
    assert c.get_result(job_id)[0].structured_content["status"] == "shared"


def test_a_check_that_keeps_failing_is_held_in_the_end(services, tmp_path):
    services.jobs, job_id = real_jobs(tmp_path)
    services.egress = SlowEgress(retryable_first=server.MAX_CHECK_FAILURES)
    c = server.Connector(services)
    statuses = [c.get_result(job_id)[0].structured_content["status"] for _ in range(server.MAX_CHECK_FAILURES)]
    assert statuses == ["running"] * (server.MAX_CHECK_FAILURES - 1) + ["refused"]


def test_get_result_follows_a_dreaming_run(services):
    night = services.night
    night.running = "dream-1"
    night.running_job = lambda: night.running
    night.report_for = lambda job_id: night.report if job_id == "dream-1" and not night.running else None
    c = server.Connector(services)
    assert c.get_result("dream-1")[0].structured_content["status"] == "running"
    assert c.dreaming_report()[0].content[0].text.startswith("RELEASED")
    assert "in progress" in services.egress.calls[-1]["raw_text"]
    night.running = None
    out = c.get_result("dream-1")[0].structured_content
    assert out["status"] == "done" and "0.865" in out["result"]
    assert "learned that" not in out["result"]
    with pytest.raises(server.ToolFailure):
        c.get_result("dream-unknown")


def test_standalone_get_on_mcp_is_405(services):
    from starlette.testclient import TestClient

    app = connector_app(services, token="t" * 32)
    with TestClient(app, base_url=BASE_URL) as tc:
        r = tc.get("/mcp", headers={"authorization": "Bearer " + "t" * 32, "accept": "text/event-stream"})
    assert r.status_code == 405


# ----- search releases like get_result: bounded wait, a job_id, one release (review: relay's 55 s) -----


def wait_for_release(jobs, job_id, timeout=5.0):
    import time as _time

    deadline = _time.monotonic() + timeout
    while jobs.get(job_id)["release_status"] in ("none", "releasing"):
        assert _time.monotonic() < deadline, "the release did not finish"
        _time.sleep(0.02)


async def test_search_purpose_is_part_of_the_request(client, services):
    purpose = f"  for the family newsletter about {TAG_B} "
    result = await client.call_tool("search_documents", {"query": f"{TAG_A} garden", "purpose": purpose})
    assert services.index.searched == [(f"{REAL_A} garden", 5)]  # only the query is searched
    assert services.restored == [f"{TAG_A} garden"]  # the purpose is never swapped to real names
    [call] = services.egress.calls
    assert call["request"] == f"{TAG_A} garden\nPurpose: for the family newsletter about {TAG_B}"
    assert call["tool"] == "search_documents" and call["result_kind"] == "snippet"
    assert text_of(result) == services.egress.outputs()[0]


def test_slow_search_answers_still_checking_with_a_job_id(services, tmp_path, monkeypatch):
    import time as _time

    monkeypatch.setattr(server, "RELEASE_WAIT_SECONDS", 0.05)
    services.jobs = JobStore(tmp_path / "jobs.db")
    services.egress = SlowEgress(delay=0.5)
    c = server.Connector(services)
    started = _time.perf_counter()
    result, outcome = c.search_documents("evidence", "for my own grading")
    assert _time.perf_counter() - started < 0.4  # bounded by the wait, not by the slow check
    body = result.structured_content
    assert outcome == "pending" and body["status"] == "running"
    assert body["result"] == server.SEARCH_CHECKING_NOTE and REAL_A not in json.dumps(body)
    job_id = body["job_id"]
    assert services.jobs.get(job_id)["kind"] == "search"
    wait_for_release(services.jobs, job_id)
    done = c.get_result(job_id)[0].structured_content
    assert done == {"job_id": job_id, "status": "shared", "result": services.egress.outputs()[0]}
    assert_no_real_names(done["result"])
    [call] = services.egress.calls
    assert call["tool"] == "search_documents" and call["job_id"] == job_id
    assert call["request"] == "evidence\nPurpose: for my own grading" and call["result_kind"] == "snippet"


def test_a_retried_search_joins_the_release(services, tmp_path, monkeypatch):
    monkeypatch.setattr(server, "RELEASE_WAIT_SECONDS", 0.05)
    services.jobs = JobStore(tmp_path / "jobs.db")
    services.egress = SlowEgress(delay=0.4)
    c = server.Connector(services)
    first = c.search_documents("evidence")[0].structured_content
    again = c.search_documents("evidence")[0].structured_content  # Muse retries while it is checked
    assert again == first and first["status"] == "running"
    wait_for_release(services.jobs, first["job_id"])
    assert len(services.egress.calls) == 1
    assert c.get_result(first["job_id"])[0].structured_content["status"] == "shared"
    assert len(services.egress.calls) == 1
    # Once that release is done, the same search later is checked again, as before.
    monkeypatch.setattr(server, "RELEASE_WAIT_SECONDS", 5.0)
    assert c.search_documents("evidence")[1] == "shared" and len(services.egress.calls) == 2


def test_concurrent_identical_searches_release_once(services, tmp_path):
    import concurrent.futures

    services.jobs = JobStore(tmp_path / "jobs.db")
    services.egress = SlowEgress(delay=0.3)
    c = server.Connector(services)
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        got = sorted(pool.map(lambda _: c.search_documents("evidence")[1], range(2)))
    assert got == ["pending", "shared"] and len(services.egress.calls) == 1


async def test_a_search_waiting_for_the_user_gives_a_job_id_to_follow(client, services):
    services.egress.status = services.egress.resolve_status = "waiting"
    args = {"query": "evidence", "purpose": "for the family newsletter"}
    body = (await client.call_tool("search_documents", args)).structured_content
    assert body["status"] == "waiting" and "OK on the device" in body["result"]
    again = (await client.call_tool("search_documents", args)).structured_content
    assert again == body
    assert len(services.egress.calls) == 1 and services.egress.resolved == [1]  # one approval card
    services.egress.resolve_status = "shared"
    done = json.loads(text_of(await client.call_tool("get_result", {"job_id": body["job_id"]})))
    assert done == {"job_id": body["job_id"], "status": "shared", "result": f"RESOLVED 1: {TAG_A} scored 3"}
    assert outcomes(services) == [
        ("search_documents", "waiting"),
        ("search_documents", "waiting"),
        ("get_result", "shared"),
    ]


def test_a_search_check_that_could_not_run_is_tried_again(services, tmp_path):
    services.jobs = JobStore(tmp_path / "jobs.db")
    services.egress = SlowEgress(retryable_first=1)
    c = server.Connector(services)
    result, outcome = c.search_documents("evidence")
    body = result.structured_content
    assert outcome == "pending" and body["status"] == "running"
    assert services.jobs.get(body["job_id"])["release_status"] == "none"  # not stored as refused
    assert c.get_result(body["job_id"])[0].structured_content["status"] == "shared"


def test_a_search_whose_check_crashes_is_plain_and_runs_again(services, tmp_path):
    services.jobs = JobStore(tmp_path / "jobs.db")
    services.egress.fail = True
    c = server.Connector(services)
    crashed = c.call("search_documents", c.search_documents, "evidence")
    assert crashed.is_error and text_of(crashed) == server.GENERIC_ERROR
    services.egress.fail = False
    retried = c.call("search_documents", c.search_documents, "evidence")
    assert text_of(retried) == services.egress.outputs()[0] and len(services.egress.calls) == 1


# ask_device (mode 2: the device's model answers, as a background job)


class FakeRunner:
    def __init__(self, jobs):
        self.jobs, self.started = jobs, []

    def start(self, question, request, folder):
        """Like AskRunner: the job row keeps the documents the model read."""
        self.started.append((question, request, folder))
        raw = f"Answer: {REAL_A} wrote about tide pools."
        return self.jobs.job_for_result("ask", request, raw, "snippet", sources=["essays/d1.md"])


async def test_ask_device_starts_a_job_and_get_result_releases_it(client, services):
    services.ask_runner = FakeRunner(services.jobs)
    started = await client.call_tool("ask_device", {"question": f"What did {TAG_A} write about?", "purpose": "for me"})
    body = json.loads(text_of(started))
    assert body["status"] == "queued" and body["result"] == server.ASK_STARTED_NOTE
    assert "get_result" in body["next"] and body["retry_after_seconds"] == server.RETRY_AFTER_SECONDS
    assert services.ask_runner.started == [(f"What did {REAL_A} write about?", f"What did {TAG_A} write about?\nPurpose: for me", None)]
    result = await client.call_tool("get_result", {"job_id": body["job_id"]})
    [call] = services.egress.calls
    assert call["tool"] == "ask_device" and call["result_kind"] == "snippet"
    assert call.get("kw", {}).get("sources") == ["essays/d1.md"]  # where the answer came from, for the controls
    assert_no_real_names(text_of(result))


async def test_ask_device_without_the_local_model_says_so(client, services):
    services.ask_runner = None
    result = await client.call_tool("ask_device", {"question": "anything"})
    assert result.is_error and "search_documents" in text_of(result)
    assert services.egress.calls == []


async def test_ask_device_busy_is_a_plain_sentence(client, services):
    class Busy:
        def start(self, *a):
            from base.workspace.ask import AskBusy

            raise AskBusy("The device is already working on 5 jobs. Try again when one finishes.")

    services.ask_runner = Busy()
    result = await client.call_tool("ask_device", {"question": "anything"})
    assert result.is_error and "5 jobs" in text_of(result)


# ----- multi-step use: descriptions, result shapes, the fixed refusal sentence (MUSE-4) -----


async def test_get_result_names_every_tool_that_returns_a_job_id(client):
    tools = {t.name: t for t in (await client.list_tools()).tools}
    assert len(tools) == 8
    get = tools["get_result"]
    field = get.input_schema["properties"]["job_id"]["description"]
    for name in ("run_private_task", "search_documents", "ask_device", "save_on_device", "run_dreaming"):
        assert name in get.description and name in field, name
    for name in ("run_private_task", "search_documents", "ask_device"):
        assert "get_result" in tools[name].description and "wait_seconds 25" in tools[name].description
    assert get.input_schema["properties"]["wait_seconds"]["type"] == "integer"
    assert get.input_schema["required"] == ["job_id"]
    assert "wait_seconds" in server.INSTRUCTIONS
    assert "A scheduled job should call only the tool it names, once." in server.INSTRUCTIONS
    rotation = "Tags change daily: a person keeps one tag for the day and gets a new one the next day"
    assert server.INSTRUCTIONS.count(rotation) == 1 and server.INSTRUCTIONS.lower().count("daily") == 1
    assert "about a day and a half, so use the tags from the current results." in server.INSTRUCTIONS
    assert "\u2014" not in Path(server.__file__).read_text()


async def test_bad_ask_device_and_get_result_arguments_get_the_usage_sentence(client, services):
    services.ask_runner = FakeRunner(services.jobs)
    ask = await client.call_tool("ask_device", {"question": 3})
    assert ask.is_error and text_of(ask) == f"The device could not use those arguments. {server.USAGE['ask_device']}"
    wait = await client.call_tool("get_result", {"job_id": "job-1", "wait_seconds": "soon"})
    assert wait.is_error and "wait_seconds" in text_of(wait)
    assert outcomes(services) == [("ask_device", "bad_input"), ("get_result", "bad_input")]


@pytest.mark.parametrize("status", ["queued", "running"])
async def test_unfinished_jobs_say_when_to_ask_again(client, services, status):
    job_id = add_job(services, status=status)
    body = json.loads(text_of(await client.call_tool("get_result", {"job_id": job_id})))
    assert body == {
        "job_id": job_id,
        "status": status,
        "result": server.WORKING_NOTE,
        "retry_after_seconds": 20,
        "next": "Call get_result with this job_id and wait_seconds 25.",
    }


async def test_waiting_and_checking_results_say_when_to_ask_again(client, services):
    services.egress.status = services.egress.resolve_status = "waiting"
    body = json.loads(text_of(await client.call_tool("get_result", {"job_id": add_job(services)})))
    assert body["status"] == "waiting" and body["retry_after_seconds"] == 20 and body["next"] == server.NEXT_STEP
    search = (await client.call_tool("search_documents", {"query": "evidence"})).structured_content
    assert search["status"] == "waiting" and search["next"] == server.NEXT_STEP
    services.egress.status = "shared"
    done = json.loads(text_of(await client.call_tool("get_result", {"job_id": add_job(services, "job-10")})))
    assert set(done) == {"job_id", "status", "result"}  # a final result has nothing to wait for


async def test_missing_or_unknown_job_ids_say_what_to_pass(client, services):
    blank = await client.call_tool("get_result", {"job_id": "  "})
    assert blank.is_error and text_of(blank) == "Pass the job_id that a Muse Privacy tool returned."
    unknown = await client.call_tool("get_result", {"job_id": "nope"})
    assert unknown.is_error and text_of(unknown).endswith(server.MISSING_JOB)


async def test_refused_results_end_with_the_fixed_sentence(client, services):
    services.egress.status = "refused"
    search = text_of(await client.call_tool("search_documents", {"query": "evidence"}))
    listing = text_of(await client.call_tool("list_documents", {"folder": "essays"}))
    early = json.loads(text_of(await client.call_tool("get_result", {"job_id": add_job(services, status="refused")})))
    report = text_of(await client.call_tool("dreaming_report", {}))
    for text in (search, listing, early["result"], report):
        assert text.endswith("Do not look for this another way. The user can open it on the device.")
        assert text.count(server.REFUSED_END) == 1
    again = text_of(await client.call_tool("search_documents", {"query": "evidence"}))
    assert again.count(server.REFUSED_END) == 1


# ----- relay or local, and Muse's client name, in the audit (MUSE-3) -----


async def test_relayed_calls_are_labeled_and_initialize_records_the_client(services):
    headers = {**MCP_HEADERS, "authorization": "Bearer right-token"}
    name = "Muse Custom Connector/2.0 (https://muse.example.com)"
    init = {**INIT, "params": {**INIT["params"], "clientInfo": {"name": name, "version": "1"}}}
    call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "run_dreaming", "arguments": {}}}
    calls = {**headers, "mcp-protocol-version": "2025-06-18"}
    async with open_http(services) as http:
        assert (await http.post("/mcp", json=init, headers={**headers, "x-muse-privacy-via": "relay"})).status_code == 200
        await http.post("/mcp", json=call, headers={**calls, "x-muse-privacy-via": "relay"})
        await http.post("/mcp", json=call, headers=calls)  # a script on this machine
        await http.post("/mcp", json=call, headers={**calls, "x-muse-privacy-via": "relay; DROP TABLE audit"})
    rows = [(r["tool"], r["outcome"], r["via"]) for r in reversed(services.audit.recent(10))]
    assert rows == [
        ("initialize", "muse_custom_connector_2_0_https_muse_exa", "relay"),
        ("run_dreaming", "started", "relay"),
        ("run_dreaming", "started", "local"),
        ("run_dreaming", "started", "local"),
    ]


@pytest.mark.parametrize(
    ("name", "label"),
    [
        ("Muse", "muse"),
        ("Python-urllib/3.12", "python_urllib_3_12"),
        ("  ", "client"),
        (None, "client"),
        (42, "client_42"),
        ("123 bot", "client_123_bot"),
        ("Ünïcode Mu$e", "n_code_mu_e"),
        ("X" * 99, "x" * 40),
        ("https://evil.example.com/a?b=c", "https_evil_example_com_a_b_c"),
    ],
)
def test_client_names_become_safe_labels(name, label, tmp_path):
    assert client_label(name) == label
    assert re.fullmatch(r"[a-z][a-z0-9_]{0,39}", label)
    audit(tmp_path / "base.db", "initialize", client_label(name))  # always a valid audit label


def test_an_old_audit_table_gains_via_on_first_open(tmp_path):
    db = tmp_path / "base.db"
    conn = sqlite3.connect(db)
    with conn:
        conn.execute("CREATE TABLE audit (ts REAL NOT NULL, tool TEXT NOT NULL, outcome TEXT NOT NULL, ms INTEGER NOT NULL DEFAULT 0)")
        conn.execute("INSERT INTO audit VALUES (1.0, 'list_documents', 'shared', 5)")
    conn.close()
    audit(db, "get_result", "waiting", via="relay")
    assert [(r["tool"], r["via"]) for r in recent(db)] == [("get_result", "relay"), ("list_documents", "local")]
    for bad in ("cloud", "Relay", ""):
        with pytest.raises(ValueError):
            audit(db, "get_result", "waiting", via=bad)


def test_egress_rows_during_a_relayed_call_say_relay(services, tmp_path):
    services.jobs, job_id = real_jobs(tmp_path)

    class AuditingEgress(FakeEgress):
        def release(self, *a, **kw):  # runs on the release thread
            services.audit("egress", "egress_blocked")
            return super().release(*a, **kw)

    services.egress = AuditingEgress()
    c = server.Connector(services)
    token = CURRENT_VIA.set("relay")
    try:
        c.call("get_result", c.get_result, job_id)
    finally:
        CURRENT_VIA.reset(token)
    rows = [(r["tool"], r["outcome"], r["via"]) for r in reversed(services.audit.recent(5))]
    assert rows == [("egress", "egress_blocked", "relay"), ("get_result", "shared", "relay")]


# ----- get_result waits for Share it or Keep it here (MUSE-6) -----


class FakeClock:
    """A monotonic clock that moves only when a wait or a test moves it."""

    def __init__(self, now: float = 1000.0):
        self.now, self.waits, self._lock = now, [], threading.Lock()

    def __call__(self) -> float:
        with self._lock:
            return self.now

    def advance(self, seconds: float) -> None:
        with self._lock:
            self.now += seconds

    def wait(self, event: threading.Event, seconds: float) -> bool:
        """The connector's wait: at once if the event is set, else the whole timeout on this clock.

        A wait longer than a poll first gives a release thread half a second of real time to finish.
        """
        if event.wait(0.5 if seconds > server.POLL_SECONDS else 0):
            return True
        self.waits.append(round(seconds, 3))
        self.advance(seconds)
        return event.is_set()


class DecidingEgress(FakeEgress):
    """resolve() reads the real ApprovalStore, like Egress does."""

    def __init__(self, approvals):
        super().__init__()
        self.approvals = approvals

    def resolve(self, approval_id):
        self.resolved.append(approval_id)
        status = {"pending": "waiting", "approved": "shared", "denied": "refused"}[self.approvals.get(approval_id)["status"]]
        text = {"waiting": "Waiting for your OK on the device.", "shared": f"{TAG_A} scored 3", "refused": "Kept on your device."}
        return SimpleNamespace(status=status, text=text[status], approval_id=approval_id, decision="share_tagged")


@pytest.fixture
def waiting(services, tmp_path):
    """A finished job whose release waits for the user's answer on a real approval row."""
    services.approvals = ApprovalStore(tmp_path / "approvals.db")
    approval_id = services.approvals.create_pending(
        tool="get_result", request=f"Grade {TAG_A}", result_kind="per_student", tagged_text=f"{TAG_A} scored 3",
        router_decision="ask_user",
    )  # fmt: skip
    services.egress = DecidingEgress(services.approvals)
    job_id = add_job(services, status="waiting_for_approval", release_status="waiting", approval_id=approval_id)
    yield job_id, approval_id
    services.approvals.close()


@pytest.mark.parametrize(("approve", "status"), [(True, "shared"), (False, "refused")])
def test_get_result_returns_the_moment_the_user_answers(services, waiting, approve, status):
    job_id, approval_id = waiting
    c = server.Connector(services)
    timer = threading.Timer(0.5, services.approvals.decide, args=(approval_id, approve))
    started = time.monotonic()
    timer.start()
    try:
        body = json.loads(text_of(c.call("get_result", c.get_result, job_id, 5)))
    finally:
        timer.cancel()
    assert 0.4 < time.monotonic() - started < 1.5
    assert body["status"] == status and "retry_after_seconds" not in body
    if approve:
        assert body["result"] == f"{TAG_A} scored 3"
    else:
        assert body["result"] == f"Kept on your device. {server.REFUSED_END}"
    assert services.jobs.rows[job_id]["release_status"] == status
    assert outcomes(services) == [("get_result", status)]


def test_get_result_with_no_answer_still_waiting_after_the_wait(services, waiting):
    job_id, _ = waiting
    c = server.Connector(services)
    started = time.monotonic()
    body = json.loads(text_of(c.call("get_result", c.get_result, job_id, 1)))
    assert 0.9 < time.monotonic() - started < 2.0
    assert body["status"] == "waiting" and body["next"] == server.NEXT_STEP
    started = time.monotonic()
    assert c.get_result(job_id)[0].structured_content["status"] == "waiting"  # no wait_seconds: at once
    assert time.monotonic() - started < 0.5


def test_wait_seconds_is_clamped_to_0_and_40(services, waiting):
    job_id, _ = waiting
    clock, asked = FakeClock(), []

    def wait_decided(approval_id, seconds):
        asked.append(seconds)
        clock.advance(seconds)
        return False

    services.approvals.wait_decided = wait_decided
    c = server.Connector(services, clock=clock, wait=clock.wait)
    assert c.call("get_result", c.get_result, job_id, 99).structured_content["status"] == "waiting"
    assert asked == [40]
    c.call("get_result", c.get_result, job_id, -5)
    assert asked == [40]  # a negative wait is no wait


def test_the_ninth_waiter_answers_at_once(services, waiting):
    job_id, _ = waiting
    clock, entered, release = FakeClock(), threading.Semaphore(0), threading.Event()

    def wait_decided(approval_id, seconds):
        entered.release()
        assert release.wait(5)
        clock.advance(seconds)
        return False

    services.approvals.wait_decided = wait_decided
    c = server.Connector(services, clock=clock, wait=clock.wait)
    with ThreadPoolExecutor(server.MAX_WAITERS) as pool:
        futures = [pool.submit(c.get_result, job_id, 40) for _ in range(server.MAX_WAITERS)]
        try:
            for _ in range(server.MAX_WAITERS):
                assert entered.acquire(timeout=5)
            started = time.monotonic()
            ninth = c.get_result(job_id, 40)[0].structured_content
            assert time.monotonic() - started < 0.5 and ninth["status"] == "waiting"
        finally:
            release.set()
        assert [f.result(timeout=5)[0].structured_content["status"] for f in futures] == ["waiting"] * 8


def test_get_result_can_wait_for_a_running_job(services, tmp_path):
    services.jobs, job_id = real_jobs(tmp_path)
    clock = FakeClock()
    real_get, start = services.jobs.get, clock()

    def get(jid):  # the job is still running for its first 3 s
        row = real_get(jid)
        return {**row, "status": "running", "release_status": "none"} if row and clock() - start < 3 else row

    services.jobs.get = get
    c = server.Connector(services, clock=clock, wait=clock.wait)
    body = c.call("get_result", c.get_result, job_id, 25).structured_content
    assert body["status"] == "shared" and clock() - start == pytest.approx(3.0)
    assert set(clock.waits) == {server.POLL_SECONDS}


# ----- one time budget per tool call (MUSE-7) -----


@pytest.mark.parametrize(("pick_seconds", "release_wait"), [(30, 15.0), (50, server.MIN_WAIT_SECONDS)])
def test_search_waits_only_for_what_is_left_of_the_budget(services, tmp_path, pick_seconds, release_wait):
    clock, gate = FakeClock(), threading.Event()

    class SlowPickRag:
        candidates = 5

        def retrieve(self, index, question):
            return [SimpleNamespace(doc_id="d1", title="Essay", text="evidence matters a great deal " * 5)]

        def pick(self, question, found):
            clock.advance(pick_seconds)  # the device model takes this long to pick passages
            return found, None

    class BlockedEgress(FakeEgress):
        def release(self, *a, **kw):
            assert gate.wait(5)
            return super().release(*a, **kw)

    services.rag, services.egress = SlowPickRag(), BlockedEgress()
    services.jobs = JobStore(tmp_path / "jobs.db")
    c = server.Connector(services, clock=clock, wait=clock.wait)
    started = clock()
    try:
        body = c.call("search_documents", c.search_documents, "evidence", "for my own grading").structured_content
    finally:
        gate.set()
    assert body["status"] == "running" and body["job_id"] and body["next"] == server.NEXT_STEP
    assert clock.waits == [release_wait]
    assert clock() - started == pytest.approx(pick_seconds + release_wait)
    assert clock() - started < 46 or release_wait == server.MIN_WAIT_SECONDS
    wait_for_release(services.jobs, body["job_id"])


def test_get_result_with_wait_40_after_20_s_of_work_answers_by_45_s(services, tmp_path):
    services.jobs, job_id = real_jobs(tmp_path)
    clock, gate = FakeClock(), threading.Event()
    real_get, start = services.jobs.get, clock()

    def get(jid):  # 20 s of work before the job is done; then its check is slow
        row = real_get(jid)
        return {**row, "status": "running", "release_status": "none"} if row and clock() - start < 20 else row

    class BlockedEgress(FakeEgress):
        def release(self, *a, **kw):
            assert gate.wait(5)
            return super().release(*a, **kw)

    services.jobs.get, services.egress = get, BlockedEgress()
    c = server.Connector(services, clock=clock, wait=clock.wait)
    try:
        body = c.call("get_result", c.get_result, job_id, 40).structured_content
    finally:
        gate.set()
    assert body["status"] == "running" and body["result"] == server.CHECKING_NOTE
    assert clock() - start <= server.CALL_BUDGET_SECONDS
    assert clock.waits[-1] == pytest.approx(25.0)  # the release waits only for what is left
    wait_for_release(services.jobs, job_id)


# ----- the full result saved on the device (MUSE-9) -----


class QuietLlm:
    """The device model, faked: nothing leaves the test."""

    is_cloud = False

    def chat_json(self, *_a, **_k):
        return {"decision": "share_tagged", "reason": "because"}

    def chat(self, *_a, **_k):
        return SimpleNamespace(content="A short summary.")

    def llm_names(self, *_a, **_k):
        return []

    def llm_details(self, *_a, **_k):
        return []

    def request_topics(self, *_a, **_k):
        return []


def test_with_cui_on_a_task_is_kept_and_says_its_result_is_saved(tmp_path):
    from base.controls import Controls, ControlStore
    from base.services import Services

    root = tmp_path / "w"
    root.mkdir()
    (root / ".synthetic").write_text("invented\n")
    env = {"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(root), "DEVICE_ONLY": "1", "CHECKER_API_KEY": "k"}
    svc = Services.create(load_settings(env), light=False, heavy=False, owner=False)
    try:
        ControlStore(svc.settings.paths.controls).save(Controls(profiles=["cui"]))
        svc.router.llm = svc.checker_llm = svc.answer_llm = QuietLlm()
        people = list(svc.roster.people())
        job_id = svc.jobs.create("private_task", "Write the brief for my own records", "contracts")
        svc.jobs.finish(job_id, f"{people[1].name} and {people[2].name} reviewed the contract.", "free_text")
        out = svc.settings.paths.output / job_id
        out.mkdir(parents=True)
        (out / "result.md").write_text(f"# Task result\n\n{people[1].name} reviewed it.\n")
        c = server.Connector(svc)
        body = json.loads(text_of(c.call("get_result", c.get_result, job_id)))
        text = body["result"]
        assert body["status"] == "refused"
        assert f"The full result is saved on the device in output/{job_id}." in text
        assert text.endswith(server.REFUSED_END)
        for person in people:
            assert person.name not in text and person.first not in text and person.last not in text
        assert svc.egress.final_check(text) == []
        assert svc.jobs.get(job_id)["released_text"] in text  # stored as egress released it
    finally:
        svc.close()


def test_search_and_ask_results_never_name_an_output_folder(services, tmp_path):
    services.egress.status = "refused"
    services.ask_runner = FakeRunner(services.jobs)
    job_id = json.loads(text_of(server.Connector(services).call("ask_device", server.Connector(services).ask_device, "anything")))["job_id"]
    (services.settings.paths.output / job_id).mkdir(parents=True)
    (services.settings.paths.output / job_id / "x.md").write_text("x")
    body = server.Connector(services).get_result(job_id)[0].structured_content
    assert body["status"] == "refused" and "saved on the device" not in body["result"]


# ----- run_dreaming from Muse runs at most once a night (MUSE-11) -----


def test_run_dreaming_from_muse_runs_at_most_once_a_night(services, monkeypatch):
    from base.dreaming import night as night_module

    def quick_dream(self, job_id):
        with self._db() as con:
            con.execute(
                "INSERT INTO dreaming_nights (job_id, finished_at, report, rule_row_ids) VALUES (?, ?, '{}', '[]')",
                (job_id, time.time()),
            )

    monkeypatch.setattr(night_module.NightRunner, "_dream", quick_dream)
    runner = night_module.NightRunner(SimpleNamespace(settings=services.settings), synthetic_path="")
    services.night = runner
    c = server.Connector(services)
    first = c.call("run_dreaming", c.run_dreaming).structured_content
    runner.wait(5)
    assert first["status"] == "running"
    again = c.call("run_dreaming", c.run_dreaming).structured_content
    assert again == {"job_id": first["job_id"], "status": "done", "result": server.DREAMED_TODAY}

    forced = runner.start()  # Dream now on the approval page always runs a night
    runner.wait(5)
    assert forced != first["job_id"]
    assert c.call("run_dreaming", c.run_dreaming).structured_content["job_id"] == forced

    con = sqlite3.connect(services.settings.paths.db)  # 13 hours later
    with con:
        con.execute("UPDATE dreaming_nights SET finished_at = finished_at - 13 * 3600")
    con.close()
    tonight = c.call("run_dreaming", c.run_dreaming).structured_content
    runner.wait(5)
    assert tonight["status"] == "running" and tonight["job_id"] not in (first["job_id"], forced)
    assert outcomes(services) == [
        ("run_dreaming", "started"),
        ("run_dreaming", "done"),
        ("run_dreaming", "done"),
        ("run_dreaming", "started"),
    ]


async def test_run_dreaming_while_a_night_runs_gives_its_id(client, services):
    services.night.running_job = lambda: "dream-1"
    services.night.last_finished_at = lambda: ("dream-0", time.time() - 60)
    body = (await client.call_tool("run_dreaming", {})).structured_content
    assert body["job_id"] == "dream-1" and body["status"] == "running" and services.night.starts == 1


async def test_dreaming_report_adds_the_approval_request_numbers(client, services):
    # MUSE-12: numbers only, also when a report row carries text where a number should be.
    services.night.report = {
        "night_number": 2, "learned_from": 5, "accuracy_before": 0.7, "accuracy_after": 0.75,
        "agreement_before": 0.7, "agreement_after": 0.8, "kept": True, "leaks": 0, "seconds": 9.0,
        "approval_requests": 7, "still_asked": f"{REAL_A} [Student A]",
    }  # fmt: skip
    await client.call_tool("dreaming_report", {})
    raw = services.egress.calls[0]["raw_text"]
    assert "- approval requests in the day before: 7" in raw
    assert "would still ask" not in raw and REAL_A not in raw and "[Student" not in raw
    services.night.report = services.night.report | {"still_asked": 3}
    await client.call_tool("dreaming_report", {})
    assert "- of those, the rules in place now would still ask: 3" in services.egress.calls[1]["raw_text"]


async def test_a_list_waiting_for_the_user_gives_a_job_id_and_a_retry_joins_it(client, services):
    # Found by the scene rehearsal (MUSE-14): a waiting list used to be plain text with no job_id,
    # so Muse could only list again, and every retry made another card.
    services.egress.status = services.egress.resolve_status = "waiting"
    first = (await client.call_tool("list_documents", {"folder": "essays"})).structured_content
    again = (await client.call_tool("list_documents", {"folder": "essays"})).structured_content
    assert first["status"] == "waiting" and first["next"] == server.NEXT_STEP
    assert again["job_id"] == first["job_id"] and len(services.egress.calls) == 1  # one card, not two
    services.egress.resolve_status = "shared"
    body = json.loads(text_of(await client.call_tool("get_result", {"job_id": first["job_id"]})))
    assert body["status"] == "shared" and services.egress.calls[0]["tool"] == "list_documents"
    assert "saved on the device" not in body["result"]
    assert outcomes(services)[:2] == [("list_documents", "waiting"), ("list_documents", "waiting")]
