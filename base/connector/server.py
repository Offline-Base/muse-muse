"""The Muse connector: an MCP server on 127.0.0.1 at /mcp. See docs/CONTRACTS.md, "Connector".

Six tools. Every text that comes from a document goes out through services.egress.release, the
single exit, and nothing else in this file returns document text. Tool calls run on worker
threads (the SDK runs sync tools that way), each one writes an audit row with no content, and
any failure reaches Muse as a plain sentence, never a traceback.
"""

from __future__ import annotations

import hmac
import importlib
import json
import logging
import os
import re
import secrets
import threading
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Annotated, Any

from mcp.server.mcpserver import MCPServer
from mcp_types import CallToolResult, TextContent, ToolAnnotations
from pydantic import Field
from starlette.applications import Starlette
from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.responses import JSONResponse

from base.config import CloudBackendRefused

log = logging.getLogger("base.connector")

VERSION = "0.1.0"
MCP_PATH = "/mcp"
OPEN_PATHS = frozenset({"/health"})
SNIPPET_CHARS = 300
ANSWER_CHARS = 400  # the device model's short answer from the picked passages (CHECKER_BACKEND=lfm)
# How long get_result waits for a first release before answering "still checking". The relay
# client gives up on a call after 55 s, so the answer has to come well before that; the release
# keeps going in the background and the next get_result picks it up.
RELEASE_WAIT_SECONDS = 40.0
MAX_CHECK_FAILURES = 3  # a check that fails this many times in a row holds the result for good
CHECKING_NOTE = "The device is still checking this result. Call get_result again in a little while."
SEARCH_CHECKING_NOTE = "The device is still checking these snippets. Call get_result with this job_id in a little while."
# A search's snippets are released as a finished job of this kind, so a slow check can be picked
# up later with get_result. Its decision row still names the tool Muse called.
SEARCH_KIND = "search"
RELEASE_TOOLS = {SEARCH_KIND: "search_documents"}

INSTRUCTIONS = """\
Muse Privacy is a private workspace on the user's own device. The documents stay there, and every \
step that reads them runs on the device with its own model.

- Names and identifiers come back as tags like [Student A], [Teacher] or [Phone 1]. The same person \
always has the same tag on this device, so plan with the tags.
- You can pass tags back in instructions and search queries, exactly as you received them. The \
device swaps them for the real values locally.
- Say who a result is for and what it will be used for, for example "for my own grading", "for the \
family newsletter" or "to send to the principal". Put it in run_private_task's instructions and in \
search_documents' purpose. The device uses it to decide what it can share.
- Longer work runs in the background: call run_private_task, then get_result with the job id until \
the status is no longer queued or running. A search that needs more time or the user's OK gives you \
a job id for get_result too.
- Some results wait for the user's OK on the device, and some are kept on the device. Tell the user \
plainly and do not try to get the same content another way.
- Finished files with real names, such as feedback for each student, are written on the device for \
the user to open there. They are never sent to you.
"""

READ = ToolAnnotations(read_only_hint=True, open_world_hint=False)
START_TASK = ToolAnnotations(
    read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False
)
# Not idempotent: a call after a night has finished starts another full night.
START_DREAMING = ToolAnnotations(
    read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False
)

USAGE = {
    "list_documents": 'list_documents takes folder, a folder name as text ("" for the top level).',
    "search_documents": "search_documents takes query, a short search as text, and an optional purpose as text.",
    "run_private_task": "run_private_task takes instructions and folder, both as text.",
    "get_result": "get_result takes job_id, the text id that run_private_task or search_documents returned.",
    "run_dreaming": "run_dreaming takes no arguments.",
    "dreaming_report": "dreaming_report takes no arguments.",
}

GENERIC_ERROR = "Something went wrong on the device, and nothing was shared. Try again in a moment."
CLOUD_REFUSED = (
    "The device will not read that folder: its model is running in the cloud for development, so only "
    "folders marked as invented data can be read."
)

REPORT_FIELDS = (
    ("night_number", "night number"),
    ("learned_from", "decisions learned from"),
    ("accuracy_before", "router accuracy before"),
    ("accuracy_after", "router accuracy after"),
    ("agreement_before", "agreement with the user before"),
    ("agreement_after", "agreement with the user after"),
    ("kept", "new rules kept"),
    ("leaks", "leaks found"),
    ("seconds", "seconds taken"),
)


class ToolFailure(Exception):
    """A plain message for Muse plus the audit outcome to record."""

    def __init__(self, message: str, outcome: str = "bad_input"):
        super().__init__(message)
        self.outcome = outcome


def _get(obj: Any, name: str, default: Any = None) -> Any:
    """Read a field from a dict row or an object, so stores may return either."""
    if obj is None:
        return default
    if isinstance(obj, Mapping):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _text(text: str, *, error: bool = False) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=text)], is_error=error)


def _json(data: dict) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(data))], structured_content=data)


def _quote(value: str, limit: int = 80) -> str:
    """Echo Muse's own argument back in an error, short and on one line."""
    flat = " ".join(value.split())
    return json.dumps(flat if len(flat) <= limit else flat[:limit] + "...")


def _short(text: str, limit: int = SNIPPET_CHARS) -> str:
    """Trim a snippet on a word boundary, so no name is cut in half before tagging."""
    flat = " ".join(str(text).split())
    if len(flat) <= limit:
        return flat
    return flat[:limit].rsplit(" ", 1)[0] + " ..."


def _relative(path: Any, root: Any) -> str:
    """A document path relative to the workspace root; never the absolute path on this machine."""
    p = Path(str(path))
    if not p.is_absolute():
        return p.as_posix()
    if root is not None:
        try:
            return p.resolve().relative_to(Path(root).resolve()).as_posix()
        except (ValueError, OSError):
            pass
    return p.name


def _topics(job: Any) -> list[str]:
    value = _get(job, "topics")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return []
    return [str(t) for t in value] if isinstance(value, list | tuple) else []


def restore_tags(services: Any, text: str) -> str:
    """Swap tags like [Student A] back to real values. The result stays on the device."""
    guard = importlib.import_module("base.guard")
    tagmap = services.tagmap
    if isinstance(tagmap, Mapping):
        mapping = dict(tagmap)
    elif hasattr(tagmap, "as_dict"):
        mapping = dict(tagmap.as_dict())
    else:
        mapping = dict(tagmap.tag_map)
    return guard.restore(text, mapping)


class Connector:
    """The six tools as plain methods. Each returns (result, audit outcome) or raises ToolFailure."""

    def __init__(self, services: Any):
        self.services = services
        self._check_failures: dict[str, int] = {}
        self._failures_lock = threading.Lock()

    def call(self, tool: str, fn: Callable[..., tuple[CallToolResult, str]], *args: Any) -> CallToolResult:
        """Run one tool, turn every failure into a plain message, and write the audit row."""
        started = time.perf_counter()
        try:
            result, outcome = fn(*args)
        except ToolFailure as failure:
            result, outcome = _text(str(failure), error=True), failure.outcome
        except CloudBackendRefused:
            result, outcome = _text(CLOUD_REFUSED, error=True), "cloud_refused"
        except Exception as exc:  # the message may quote a document, so only its type is logged
            log.error("tool %s failed with %s", tool, type(exc).__name__)
            result, outcome = _text(GENERIC_ERROR, error=True), "error"
        self.audit(tool, outcome, int((time.perf_counter() - started) * 1000))
        return result

    def audit(self, tool: str, outcome: str, ms: int = 0) -> None:
        recorder = getattr(self.services, "audit", None)
        if recorder is None:
            return
        try:
            recorder(tool, outcome, ms=ms)
        except Exception as exc:  # an audit problem must never break a tool call
            log.warning("audit write failed with %s", type(exc).__name__)

    def _docs(self, folder: str) -> tuple[str, list]:
        """The real folder name (tags restored) and its documents, or a plain error."""
        real = restore_tags(self.services, folder) if folder else ""
        try:
            return real, list(self.services.index.list(real))
        except (ValueError, OSError, LookupError):
            raise ToolFailure(
                f"There is no folder {_quote(folder)} in the workspace. "
                'Call list_documents with folder "" to see what is there.'
            ) from None

    def list_documents(self, folder: str) -> tuple[CallToolResult, str]:
        folder = folder.strip()
        _, docs = self._docs(folder)
        root = _get(_get(self.services, "settings"), "workspace_root")
        where = f"folder {folder}" if folder else "the workspace"
        entries = [f"- {_get(d, 'title')} ({_relative(_get(d, 'path'), root)})" for d in docs]
        # A title that names a never-share topic stays on the device; the rest of the list still goes.
        # File names count with their separators as spaces: camila_iep_goals.md names an IEP.
        shown = [e for e in entries if not self._never_share_topics(re.sub(r"[_\-./]", " ", e))]
        held = len(entries) - len(shown)
        if shown:
            lines = [f"{len(shown)} documents in {where}:", *shown]
        else:
            lines = [f"No documents in {where}."] if not held else [f"No documents to show in {where}."]
        if held:
            lines.append(f"{held} {'document' if held == 1 else 'documents'} held back on the device.")
        released = self.services.egress.release(
            "list_documents", f"list {where}", "\n".join(lines), "document_list"
        )
        return _text(released.text), released.status

    def _never_share_topics(self, text: str) -> list[str]:
        """The policy's never-share topics whose keywords appear in `text`."""
        policy = getattr(self.services, "policy", None)
        never_share = getattr(policy, "never_share", None)
        if not never_share:
            return []
        guard = importlib.import_module("base.guard")
        return guard.blocked_topics(text, never_share)

    def search_documents(self, query: str, purpose: str = "") -> tuple[CallToolResult, str]:
        query, purpose = query.strip(), purpose.strip()
        if not query:
            raise ToolFailure("Pass a short search query, for example: rubric criteria for evidence.")
        restored = restore_tags(self.services, query)
        rag = getattr(self.services, "rag", None)
        found = list(self.services.index.search(restored, k=rag.candidates if rag else 5))
        snippets, answer = found[:5], None
        if rag is not None and found:
            # The device's own model picks the passages that answer the query and writes a short
            # answer from them; egress then tags and checks both like any search result.
            try:
                snippets, answer = rag.pick(restored, found)
            except Exception as exc:  # the checker is down: fall back to the keyword ranking
                log.warning("passage picking failed, using the keyword ranking: %s", type(exc).__name__)
                snippets, answer = found[:5], None
        if snippets:
            raw = "\n\n".join(
                f"{i}. {_get(s, 'title')}\n{_short(_get(s, 'text', ''))}" for i, s in enumerate(snippets, 1)
            )
            if answer:
                raw = f"Answer: {_short(answer, ANSWER_CHARS)}\n\n{raw}"
        else:
            raw = answer or "No matching passages."
        # Who the snippets are for is part of Muse's request, so egress tags and labels it with the rest.
        request = f"{query}\nPurpose: {purpose}" if purpose else query
        # Released as a finished job with get_result's bounded wait, so a slow check answers "still
        # checking" with a job_id before the relay gives up, and a retried search joins the release.
        jobs = self.services.jobs
        job_id = jobs.job_for_result(SEARCH_KIND, request, raw, "snippet")
        status, text = self._release(job_id, jobs.get(job_id))
        if status in ("shared", "refused"):
            return _text(text), status
        if status == "running":
            return _json({"job_id": job_id, "status": "running", "result": SEARCH_CHECKING_NOTE}), "pending"
        return _json({"job_id": job_id, "status": status, "result": text}), status

    def run_private_task(self, instructions: str, folder: str) -> tuple[CallToolResult, str]:
        instructions, folder = instructions.strip(), folder.strip()
        if not instructions:
            raise ToolFailure(
                "Say what to do in instructions, for example: grade each essay against rubric.md."
            )
        real_folder, docs = self._docs(folder)
        if not docs:
            raise ToolFailure(f"The folder {_quote(folder)} has no documents to work on.")
        try:
            job_id = str(self.services.agent.run_private_task(instructions, real_folder))
        except Exception as exc:
            if type(exc).__name__ == "AgentBusy":  # a plain sentence with a count, no content
                raise ToolFailure(str(exc), outcome="busy") from None
            raise
        status = _get(self.services.jobs.get(job_id), "status") or "queued"
        return _json({"job_id": job_id, "status": status}), "started"

    def get_result(self, job_id: str) -> tuple[CallToolResult, str]:
        job_id = job_id.strip()
        if not job_id:
            raise ToolFailure("Pass the job_id that run_private_task returned.")
        if job_id.startswith("dream-"):
            return self._dream_result(job_id)
        job = self.services.jobs.get(job_id)
        if job is None:
            raise ToolFailure(
                f"There is no job {_quote(job_id)} on this device. Start one with run_private_task."
            )
        status = _get(job, "status")
        # set_release also moves the job status, so a released job is judged by release_status
        if (_get(job, "release_status") or "none") == "none":
            if status in ("queued", "running"):
                note = "Still working on the device. Call get_result again in a little while."
                return _json({"job_id": job_id, "status": status, "result": note}), "pending"
            if status == "failed":
                note = "The task stopped with an error on the device, and nothing was shared. You can start it again."
                return _json({"job_id": job_id, "status": "failed", "result": note}), "failed"
            if status == "refused":
                note = "The device kept this result on the device, and nothing was shared."
                return _json({"job_id": job_id, "status": "refused", "result": note}), "refused"
        release_status, text = self._release(job_id, job)
        outcome = "pending" if release_status == "running" else release_status
        return _json({"job_id": job_id, "status": release_status, "result": text}), outcome

    def _release(self, job_id: str, job: Any) -> tuple[str, str]:
        """The flow in "Jobs and releases": release once, resolve while waiting, then resend."""
        jobs, egress = self.services.jobs, self.services.egress
        release_status = _get(job, "release_status") or "none"
        approval_id = _get(job, "approval_id")
        if release_status == "releasing":
            return "running", CHECKING_NOTE
        if release_status in ("shared", "refused"):
            return release_status, _get(job, "released_text") or ""
        if release_status == "waiting" and approval_id is not None:
            released = egress.resolve(int(approval_id))
            if released.status != "waiting":
                jobs.set_release(
                    job_id, released.status, approval_id=approval_id, released_text=released.text
                )
            return released.status, released.text
        claim = getattr(jobs, "claim_release", None)
        if callable(claim) and not claim(job_id):
            again = jobs.get(job_id)  # another call is releasing it, or just finished
            if (_get(again, "release_status") or "none") in ("none", "releasing"):
                return "running", CHECKING_NOTE
            return self._release(job_id, again)
        box: dict[str, Any] = {}
        done = threading.Event()

        def work() -> None:
            try:
                box["released"] = self._release_once(job_id, job)
            except BaseException as exc:  # handed back to the waiting call below, if it still waits
                box["error"] = exc
                reset = getattr(jobs, "reset_release", None)
                if callable(reset):
                    reset(job_id)
            finally:
                done.set()

        threading.Thread(target=work, name=f"release-{job_id}", daemon=True).start()
        if not done.wait(RELEASE_WAIT_SECONDS):
            return "running", CHECKING_NOTE
        if "error" in box:
            raise box["error"]
        return box["released"]

    def _release_once(self, job_id: str, job: Any) -> tuple[str, str]:
        """One egress release for a finished job, stored unless a check could not run."""
        jobs, egress = self.services.jobs, self.services.egress
        released = egress.release(
            RELEASE_TOOLS.get(_get(job, "kind"), "get_result"),
            _get(job, "instructions") or "",
            _get(job, "raw_result") or "",
            _get(job, "result_kind") or "free_text",
            job_id=job_id,
            summary=_get(job, "summary"),
            topics=_topics(job),
        )
        if getattr(released, "retryable", False):
            with self._failures_lock:
                failures = self._check_failures[job_id] = self._check_failures.get(job_id, 0) + 1
            if failures < MAX_CHECK_FAILURES:
                reset = getattr(jobs, "reset_release", None)
                if callable(reset):
                    reset(job_id)
                return "running", CHECKING_NOTE
        with self._failures_lock:
            self._check_failures.pop(job_id, None)
        jobs.set_release(
            job_id, released.status, approval_id=released.approval_id, released_text=released.text
        )
        return released.status, released.text

    def _dream_result(self, job_id: str) -> tuple[CallToolResult, str]:
        """get_result for a run_dreaming id: running while the night holds the lock, then its numbers."""
        night = self.services.night
        if night.running_job() == job_id:
            note = "Dreaming is still running on the device. Call get_result again in a little while."
            return _json({"job_id": job_id, "status": "running", "result": note}), "pending"
        report_for = getattr(night, "report_for", None)
        report = report_for(job_id) if callable(report_for) else None
        if report is None:
            raise ToolFailure(f"There is no dreaming run {_quote(job_id)} on this device. Start one with run_dreaming.")
        released = self.services.egress.release("dreaming_report", "dreaming report", _report_text(report), "dreaming_report")
        status = "done" if released.status == "shared" else released.status
        return _json({"job_id": job_id, "status": status, "result": released.text}), released.status

    def run_dreaming(self) -> tuple[CallToolResult, str]:
        started = self.services.night.start()
        if isinstance(started, str):
            job_id, status = started, "running"
        else:
            job_id, status = _get(started, "job_id"), _get(started, "status") or "running"
        return _json({"job_id": None if job_id is None else str(job_id), "status": str(status)}), "started"

    def dreaming_report(self) -> tuple[CallToolResult, str]:
        night = self.services.night
        raw = _report_text(night.last_report())
        running = getattr(night, "running_job", None)
        if callable(running) and running():
            raw = "A dreaming run is in progress. These numbers are from the run before it.\n" + raw
        released = self.services.egress.release("dreaming_report", "dreaming report", raw, "dreaming_report")
        return _text(released.text), released.status


def _report_text(report: Any) -> str:
    """A dreaming report as aggregate numbers only."""
    finished = any(_get(report, k) is not None for k in ("accuracy_after", "agreement_after", "kept"))
    lines = []
    for field, label in REPORT_FIELDS if finished else ():
        value = _get(report, field)
        if isinstance(value, bool):
            lines.append(f"- {label}: {'yes' if value else 'no'}")
        elif isinstance(value, int | float):  # numbers only: nothing else from the report leaves
            lines.append(f"- {label}: {round(value, 3)}")
    return "Last dreaming run:\n" + "\n".join(lines) if lines else "No dreaming run has finished yet."


def _plain_errors(connector: Connector):
    """Middleware: the SDK's own argument errors become one plain sentence for Muse."""

    async def middleware(ctx, call_next):
        result = await call_next(ctx)
        if ctx.method != "tools/call" or not isinstance(result, dict) or not result.get("isError"):
            return result
        content = result.get("content") or [{}]
        name = (ctx.params or {}).get("name")
        if not str(content[0].get("text", "")).startswith("Error executing tool") or name not in USAGE:
            return result
        connector.audit(name, "bad_input")
        text = f"The device could not use those arguments. {USAGE[name]}"
        return {**result, "content": [{"type": "text", "text": text}]}

    return middleware


def build_server(services: Any) -> MCPServer:
    """The MCP server with the six connector tools, wired to `services`."""
    c = Connector(services)
    server = MCPServer(name="muse-privacy", title="Muse Privacy", instructions=INSTRUCTIONS, version=VERSION)

    @server.tool(
        name="list_documents",
        title="List documents",
        annotations=READ,
        description=(
            "List the documents in a folder of the user's private workspace on their device. Titles come "
            "back with names and identifiers replaced by tags like [Student A], each followed by its path "
            "in parentheses; the part before the file name is the folder to pass to run_private_task. Use "
            'folder "" for the top level of the workspace.'
        ),
    )
    def list_documents(
        folder: Annotated[
            str, Field(max_length=300, description='Folder name, or "" for the top level')
        ] = "",
    ) -> CallToolResult:
        return c.call("list_documents", c.list_documents, folder)

    @server.tool(
        name="search_documents",
        title="Search documents",
        annotations=READ,
        description=(
            "Search the user's private documents on the device and get up to 5 short snippets, sometimes "
            "with a short answer the device wrote from them. Scanned pages and photos in the folders are "
            "searched by the text the device read in them. Names and identifiers come back as tags like "
            "[Student A]. You can put tags in the query, "
            "for example [Student A] thesis, and the device swaps them for the real names before it searches. "
            "Say in purpose who the snippets are for and what they will be used for, for example: for the "
            "family newsletter. If the device needs more time or the user's OK, you get a job_id instead: "
            "call get_result with it."
        ),
    )
    def search_documents(
        query: Annotated[str, Field(max_length=500, description="What to look for; tags are fine")],
        purpose: Annotated[
            str,
            Field(
                max_length=300,
                description="Who the snippets are for and what they will be used for, for example: for my own grading",
            ),
        ] = "",
    ) -> CallToolResult:
        return c.call("search_documents", c.search_documents, query, purpose)

    @server.tool(
        name="run_private_task",
        title="Run a private task",
        annotations=START_TASK,
        description=(
            "Start a task on the user's device over the documents in one folder, for example: grade each "
            "essay against rubric.md and write feedback for each student. Say who the result is for and what "
            "it will be used for, for example: for my own grading, or for the family newsletter. The device "
            "does the work with its own model and writes finished files with real names on the device, where "
            "the user opens them; those files are never sent to you. Refer to people by their tags, like "
            "[Student A]. Returns a job_id and status at once; then call get_result with the job_id."
        ),
    )
    def run_private_task(
        instructions: Annotated[
            str, Field(max_length=4000, description="What to do and who the result is for; refer to people by tag")
        ],
        folder: Annotated[str, Field(max_length=300, description="Folder with the documents to work on")],
    ) -> CallToolResult:
        return c.call("run_private_task", c.run_private_task, instructions, folder)

    @server.tool(
        name="get_result",
        title="Get a task result",
        annotations=READ,
        description=(
            "Get the status and result of a job_id from run_private_task or search_documents. While the "
            "status is queued or running, call again in a little while. A shared result has names as tags, or "
            "is a summary. Status waiting means the result is waiting for the user's OK on the device: tell the "
            "user and call again later. Status refused means it is kept on the device; do not ask for it "
            "another way. Files with real names always stay on the device."
        ),
    )
    def get_result(
        job_id: Annotated[str, Field(max_length=100, description="The job_id from run_private_task or search_documents")],
    ) -> CallToolResult:
        return c.call("get_result", c.get_result, job_id)

    @server.tool(
        name="run_dreaming",
        title="Start dreaming",
        annotations=START_DREAMING,
        description=(
            "Start the device's dreaming run now: it relearns the privacy router from the user's recent "
            "share and keep decisions, and keeps the new rules only if they test at least as well. Safe to "
            "call again: while a run is going you get the same job_id back. Then call dreaming_report."
        ),
    )
    def run_dreaming() -> CallToolResult:
        return c.call("run_dreaming", c.run_dreaming)

    @server.tool(
        name="dreaming_report",
        title="Dreaming report",
        annotations=READ,
        description=(
            "How the last dreaming run went, as aggregate numbers only: decisions learned from, router "
            "accuracy and agreement with the user before and after, whether the new rules were kept, and "
            "leaks found. It never contains document text or names."
        ),
    )
    def dreaming_report() -> CallToolResult:
        return c.call("dreaming_report", c.dreaming_report)

    @server.custom_route("/health", methods=["GET"])
    async def health(request: Request) -> JSONResponse:
        return JSONResponse({"status": "ok"})

    server.middleware.append(_plain_errors(c))
    return server


def read_or_create_token(path: Path) -> str:
    """The device connector token, created 0600 with secrets.token_urlsafe(32) on first use."""
    path = Path(path)
    for _ in range(2):
        try:
            token = path.read_text().strip()
            if token:
                return token
        except FileNotFoundError:
            pass
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:  # another process made it first, or it is empty: read it again
            if path.stat().st_size == 0:
                path.unlink(missing_ok=True)
            continue
        token = secrets.token_urlsafe(32)
        with os.fdopen(fd, "w") as f:
            f.write(token + "\n")
        os.chmod(path, 0o600)
        return token
    raise RuntimeError("could not create the connector token")


class BearerAuth:
    """ASGI middleware: every path except OPEN_PATHS needs Authorization: Bearer <token>."""

    def __init__(self, app, token: str, open_paths: frozenset[str] = OPEN_PATHS):
        self.app = app
        self._token = token.encode()
        self.open_paths = open_paths

    def allowed(self, scope) -> bool:
        scheme, _, value = Headers(scope=scope).get("authorization", "").partition(" ")
        return scheme.lower() == "bearer" and hmac.compare_digest(value.strip().encode(), self._token)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan" or (scope["type"] == "http" and scope["path"] in self.open_paths):
            return await self.app(scope, receive, send)
        if scope["type"] == "http" and self.allowed(scope):
            if scope.get("method") == "GET" and scope["path"].rstrip("/") == MCP_PATH:
                # Stateless JSON mode has no server-sent stream to offer, so a GET gets 405
                # instead of a stream that never ends.
                response = JSONResponse({"error": "method not allowed"}, status_code=405, headers={"allow": "POST"})
                return await response(scope, receive, send)
            return await self.app(scope, receive, send)
        if scope["type"] != "http":
            return await send({"type": "websocket.close", "code": 1008})
        response = JSONResponse(
            {"error": "unauthorized"}, status_code=401, headers={"www-authenticate": "Bearer"}
        )
        await response(scope, receive, send)


def connector_app(services: Any, *, token: str | None = None) -> Starlette:
    """ASGI app: the MCP server at /mcp behind the bearer token, plus GET /health without auth.

    Stateless with JSON responses, so each request relayed from Muse stands alone and no
    long-lived stream is needed.
    """
    if token is None:
        token = read_or_create_token(services.settings.paths.connector_token)
    app = build_server(services).streamable_http_app(
        streamable_http_path=MCP_PATH, json_response=True, stateless_http=True, host="127.0.0.1"
    )
    app.add_middleware(BearerAuth, token=token)
    return app


def serve(services: Any) -> None:
    """Run the connector on 127.0.0.1:<connector_port>. Never binds another address."""
    import uvicorn

    uvicorn.run(connector_app(services), host="127.0.0.1", port=services.settings.connector_port)
