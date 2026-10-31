"""The Muse connector: an MCP server on 127.0.0.1 at /mcp. See docs/CONTRACTS.md, "Connector".

Eight tools. Every text that comes from a document goes out through services.egress.release, the
single exit, and nothing else in this file returns document text; the notes added to a result
are fixed sentences and job ids. save_on_device writes Muse's tagged text with the real names
filled in on the device and sends back only a receipt with counts, through egress too. Tool calls
run on worker threads (the SDK runs sync tools that way), each one writes an audit row with no
content (relay or local, from the relay client's header), and any failure reaches Muse as a plain
sentence, never a traceback. Each call has one time budget, so it answers before the relay gives up.
"""

from __future__ import annotations

import contextvars
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
from typing import Annotated, Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp_types import CallToolResult, TextContent, ToolAnnotations
from pydantic import BaseModel, Field
from starlette.applications import Starlette
from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.responses import JSONResponse

from base.config import CloudBackendRefused
from base.connector.audit import CURRENT_VIA, VIA_HEADER, client_label, via_label
from base.regions import mark_uncovered, reads_uncovered, unchecked_images, unchecked_note
from base.workspace import merge
from base.workspace.contacts import ContactsError, load_contacts
from base.workspace.index import snippet, tokenize

log = logging.getLogger("base.connector")

VERSION = "0.1.0"
MCP_PATH = "/mcp"
OPEN_PATHS = frozenset({"/health"})
SNIPPET_CHARS = 300
ANSWER_CHARS = 400  # the device model's short answer from the picked passages (CHECKER_BACKEND=lfm)
ASK_ANSWER_CHARS = 900  # ask_device's answer, two to five sentences
# One time budget per tool call, started when Connector.call begins it. The relay client gives up
# on a call after 55 s and the relay after 60 s, so every wait inside a call (a release being
# checked, get_result's wait_seconds) takes only what is left of the budget, at least
# MIN_WAIT_SECONDS. A model step before the wait (search's passage picking) uses it up too.
CALL_BUDGET_SECONDS = 45.0
MIN_WAIT_SECONDS = 1.0
# The longest wait for a first release before answering "still checking"; the release keeps going
# in the background and the next get_result picks it up.
RELEASE_WAIT_SECONDS = 40.0
MAX_WAIT_SECONDS = 40  # get_result's wait_seconds is clamped to 0..40
MAX_WAITERS = 8  # get_result calls that may wait at once; past that a call answers at once
POLL_SECONDS = 0.5  # how often a waiting get_result looks again at a job that is still running
RETRY_AFTER_SECONDS = 20
WAITABLE = ("queued", "running", "waiting")  # statuses that carry retry_after_seconds and next
NEXT_STEP = "Call get_result with this job_id and wait_seconds 25."
MAX_CHECK_FAILURES = 3  # a check that fails this many times in a row holds the result for good
CHECKING_NOTE = "The device is still checking this result."
SEARCH_CHECKING_NOTE = "The device is still checking these snippets."
WORKING_NOTE = "Still working on the device."
FAILED_NOTE = "The task stopped with an error on the device, and nothing was shared. You can start it again."
KEPT_EARLY_NOTE = "The device kept this result on the device, and nothing was shared."
# Every refused result ends with this, so Muse does not try to get the same content another way.
REFUSED_END = "Do not look for this another way. The user can open it on the device."
SAVED_NOTE = "The full result is saved on the device in {where}."
SAFE_JOB_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
MISSING_JOB = "Pass the job_id that a Muse Privacy tool returned."
TASK_STARTED_NOTE = "The device is working on it. Finished files with real names stay on the device."
DREAM_STARTED_NOTE = "Dreaming is running on the device. It takes a few minutes; then call dreaming_report."
DREAM_RUNNING_NOTE = "Dreaming is still running on the device."
# run_dreaming from Muse starts at most one night in this many seconds (Dream now on the approval
# page always starts one), so a scheduled job that retries does not learn from the same rows twice.
DREAM_AGAIN_AFTER_SECONDS = 12 * 3600
DREAMED_TODAY = "A dreaming run already finished today. The next one can start tonight."
# A search's snippets are released as a finished job of this kind, so a slow check can be picked
# up later with get_result. Its decision row still names the tool Muse called.
SEARCH_KIND = "search"
ASK_KIND = "ask"
LIST_KIND = "list"  # list_documents: a list that waits for the user's OK gets a job_id too
SAVE_KIND = "save"  # save_on_device: the receipt is released like a finished job
RELEASE_TOOLS = {
    SEARCH_KIND: "search_documents", ASK_KIND: "ask_device", LIST_KIND: "list_documents", SAVE_KIND: "save_on_device",
}
NO_SAVED_NOTE = (SEARCH_KIND, ASK_KIND, LIST_KIND)  # jobs that never write files on the device
PASSAGE_SHOW = 600  # how much of each retrieved passage search_documents sends (CHECKER_BACKEND=lfm)
ASK_UNAVAILABLE = "ask_device needs the device's own model. Use search_documents instead."
ASK_STARTED_NOTE = "The device is working on it and may search for up to 3 minutes."

INSTRUCTIONS = """\
Muse Privacy is a private workspace on the user's own device. The documents stay there, and every \
step that reads them runs on the device with its own model.

- Names and identifiers come back as tags like [Student A], [Teacher] or [Phone 1]. With a privacy \
toggle on, places, dates, organizations and record numbers do too, like [Place 1] or [Date 1]. Plan \
with the tags. Tags change daily: a person keeps one tag for the day and gets a new one the next \
day, and an older tag stops working about a day and a half after its day ends, however often it is \
used, so use the tags from the current results and keep to one day's tags in a request.
- You can pass tags back in instructions and search queries, exactly as you received them. The \
device swaps them for the real values locally.
- Two ways to ask about the documents: search_documents returns the best passages for you to reason \
over; ask_device has the device's own model search, read and answer, and returns its answer with a \
few short quotes. Use ask_device for a question, search_documents to see the text yourself.
- Say who a result is for and what it will be used for, for example "for my own grading", "for the \
family newsletter" or "to send to the principal". Put it in run_private_task's instructions and in \
search_documents' and ask_device's purpose. The device uses it to decide what it can share.
- Longer work runs in the background: run_private_task and ask_device return a job_id at once. Call \
get_result with it until the status is no longer queued or running. A search that needs more time \
or the user's OK gives you a job_id for get_result too.
- get_result can wait on the device: pass wait_seconds (up to 40) and it answers as soon as the job \
is done or the user taps Share it or Keep it here, so a waiting result can be awaited in the same turn.
- Some results wait for the user's OK on the device, and some are kept on the device. Tell the user \
plainly and do not try to get the same content another way.
- A scheduled job should call only the tool it names, once.
- Finished files with real names, such as feedback for each student, are written on the device for \
the user to open there. They are never sent to you.
- To make files with real names yourself, such as a note home for each student, write them with tags \
and call save_on_device. The device fills in the names (with address_to "guardians", one email draft \
for each guardian, from the device's own list) and saves them there. You get back only counts.
"""

READ = ToolAnnotations(read_only_hint=True, open_world_hint=False)
START_TASK = ToolAnnotations(
    read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False
)
# Not idempotent: a call 12 hours after a night finished starts another full night.
START_DREAMING = ToolAnnotations(
    read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False
)

USAGE = {
    "list_documents": 'list_documents takes folder, a folder name as text ("" for the top level).',
    "search_documents": "search_documents takes query, a short search as text, and an optional purpose as text.",
    "ask_device": "ask_device takes question, a question as text, and an optional purpose and folder as text.",
    "run_private_task": "run_private_task takes instructions and folder, both as text.",
    "get_result": (
        "get_result takes job_id, the text id that a Muse Privacy tool returned, and an optional "
        "wait_seconds, a whole number from 0 to 40."
    ),
    "save_on_device": (
        "save_on_device takes items, a list of 1 to 60 objects each with a title and a body as text and an "
        'optional for_tag like [Student A], a purpose as text, and an optional address_to, "none" or "guardians".'
    ),
    "run_dreaming": "run_dreaming takes no arguments.",
    "dreaming_report": "dreaming_report takes no arguments.",
}

GENERIC_ERROR = "Something went wrong on the device, and nothing was shared. Try again in a moment."
EXPIRED_TAG = "That tag no longer works on this device. Call list_documents or search_documents again for current tags."
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
    ("approval_requests", "approval requests in the day before"),
    ("still_asked", "of those, the rules in place now would still ask"),
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


def _passage(text: str, terms: list[str]) -> str:
    """Up to PASSAGE_SHOW characters of a passage, centered where the query words are."""
    return snippet(text, terms, width=PASSAGE_SHOW) if len(" ".join(str(text).split())) > SNIPPET_CHARS else _short(text)


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


def tag_values(services: Any) -> dict[str, str]:
    """The tags Muse may send back and their real values: with a TagMap, only the tags this
    device sent that are still in their grace window (TagMap.for_muse). Never leaves the device."""
    tagmap = services.tagmap
    if isinstance(tagmap, Mapping):
        return dict(tagmap)
    if hasattr(tagmap, "for_muse"):
        return dict(tagmap.for_muse())
    if hasattr(tagmap, "as_dict"):
        return dict(tagmap.as_dict())
    return dict(tagmap.tag_map)


def check_tags(services: Any, text: str) -> None:
    """Raise ToolFailure with EXPIRED_TAG (audit expired_tag) when `text` holds a tag that will not
    restore for Muse (TagMap.expired), or restorable tags from two tag days (TagMap.mixed_days).
    Old, never-sent and guessed tags and mixed days get the same sentence, so Muse cannot tell
    them apart. Nothing is searched, listed, started or saved then."""
    tagmap = services.tagmap
    if isinstance(tagmap, Mapping) or not hasattr(tagmap, "expired"):
        return
    if tagmap.expired(text) or (hasattr(tagmap, "mixed_days") and tagmap.mixed_days(text)):
        raise ToolFailure(EXPIRED_TAG, outcome="expired_tag")


def restore_tags(services: Any, text: str) -> str:
    """Swap tags like [Student A] back to real values. The result stays on the device.

    With a TagMap only the tags this device sent to Muse, still in their grace window, restore
    (TagMap.for_muse), and `text` must pass check_tags first."""
    guard = importlib.import_module("base.guard")
    check_tags(services, text)
    return guard.restore(text, tag_values(services))


# Set by Connector.call when a tool call starts, so every wait inside it shares one budget.
_CALL_STARTED: contextvars.ContextVar[float | None] = contextvars.ContextVar("connector_call_started", default=None)


def _result_body(job_id: str, status: str, text: str, saved: str | None = None) -> dict:
    """A job's answer for Muse: status and text, the saved-file note, and what to do next.

    Every added sentence is fixed text or the job id, never document text. A shared text is sent
    exactly as egress released it (and as the receipt's sha256 has it); a waiting or refused one
    may end with SAVED_NOTE and REFUSED_END.
    """
    if saved and status in ("waiting", "refused"):
        text = f"{text} {SAVED_NOTE.format(where=saved)}"
    if status == "refused":
        text = _refused(text)
    body = {"job_id": job_id, "status": status, "result": text}
    if status in WAITABLE:
        body |= {"retry_after_seconds": RETRY_AFTER_SECONDS, "next": NEXT_STEP}
    return body


def _refused(text: str) -> str:
    return text if text.endswith(REFUSED_END) else f"{text} {REFUSED_END}".strip()


def _plain(released: Any) -> CallToolResult:
    """A release sent as plain text, with the fixed last sentence when it was refused."""
    text = released.text or ""
    return _text(_refused(text) if released.status == "refused" else text)


class Connector:
    """The eight tools as plain methods. Each returns (result, audit outcome) or raises ToolFailure.

    `clock` and `wait(event, seconds) -> bool` are time.monotonic and Event.wait; tests pass fakes.
    """

    def __init__(
        self,
        services: Any,
        *,
        clock: Callable[[], float] = time.monotonic,
        wait: Callable[[threading.Event, float], bool] | None = None,
    ):
        self.services = services
        self.clock = clock
        self._wait = wait or (lambda event, seconds: event.wait(seconds))
        self._never = threading.Event()  # waited on as a plain pause between looks at a job
        self._waiters = threading.BoundedSemaphore(MAX_WAITERS)
        self._check_failures: dict[str, int] = {}
        self._failures_lock = threading.Lock()

    def call(self, tool: str, fn: Callable[..., tuple[CallToolResult, str]], *args: Any) -> CallToolResult:
        """Run one tool, turn every failure into a plain message, and write the audit row."""
        started = time.perf_counter()
        budget = _CALL_STARTED.set(self.clock())
        try:
            result, outcome = fn(*args)
        except ToolFailure as failure:
            result, outcome = _text(str(failure), error=True), failure.outcome
        except CloudBackendRefused:
            result, outcome = _text(CLOUD_REFUSED, error=True), "cloud_refused"
        except Exception as exc:  # the message may quote a document, so only its type is logged
            log.error("tool %s failed with %s", tool, type(exc).__name__)
            result, outcome = _text(GENERIC_ERROR, error=True), "error"
        finally:
            _CALL_STARTED.reset(budget)
        self.audit(tool, outcome, int((time.perf_counter() - started) * 1000))
        return result

    def audit(self, tool: str, outcome: str, ms: int = 0) -> None:
        """One audit row. The recorder adds via (relay or local) from CURRENT_VIA, set per call."""
        recorder = getattr(self.services, "audit", None)
        if recorder is None:
            return
        try:
            recorder(tool, outcome, ms=ms)
        except Exception as exc:  # an audit problem must never break a tool call
            log.warning("audit write failed with %s", type(exc).__name__)

    def _deadline(self) -> float:
        """When this tool call's budget runs out. A method called on its own starts one now."""
        started = _CALL_STARTED.get()
        return (self.clock() if started is None else started) + CALL_BUDGET_SECONDS

    def _left(self, deadline: float, cap: float) -> float:
        """How long a wait may take: what is left of the budget, at least MIN_WAIT_SECONDS, at most cap."""
        return min(cap, max(MIN_WAIT_SECONDS, deadline - self.clock()))

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
        deadline = self._deadline()
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
        # Released as a finished job, like a search: a list that waits for the user's OK (a title
        # with a name the roster does not know) gives Muse a job_id for get_result, and a retried
        # list joins that release instead of making a second card.
        jobs = self.services.jobs
        sources = [str(_get(d, "id")) for d in docs]
        job_id = jobs.job_for_result(LIST_KIND, f"list {where}", "\n".join(lines), "document_list", sources=sources)
        status, text = self._release(job_id, jobs.get(job_id), deadline)
        if status == "shared":
            return _text(text), status
        if status == "refused":
            return _text(_refused(text)), status
        if status == "running":
            return _json(_result_body(job_id, "running", CHECKING_NOTE)), "pending"
        return _json(_result_body(job_id, status, text)), status

    def _never_share_topics(self, text: str) -> list[str]:
        """The policy's never-share topics whose keywords appear in `text`."""
        policy = getattr(self.services, "policy", None)
        never_share = getattr(policy, "never_share", None)
        if not never_share:
            return []
        guard = importlib.import_module("base.guard")
        return guard.blocked_topics(text, never_share)

    def search_documents(self, query: str, purpose: str = "") -> tuple[CallToolResult, str]:
        deadline = self._deadline()
        query, purpose = query.strip(), purpose.strip()
        if not query:
            raise ToolFailure("Pass a short search query, for example: rubric criteria for evidence.")
        # Who the snippets are for is part of Muse's request, so egress tags and labels it with the
        # rest, and its tags pick the result's tag day: the purpose's tags are checked too.
        request = f"{query}\nPurpose: {purpose}" if purpose else query
        check_tags(self.services, request)
        restored = restore_tags(self.services, query)
        rag = getattr(self.services, "rag", None)
        uncovered = reads_uncovered(self.services.index)
        found: list[Any] = []
        with unchecked_images() as unread:  # images the SAM sidecar could not check are left out
            if rag is not None:
                try:  # passages for the query and the device model's rewrites of it
                    found = list(rag.retrieve(self.services.index, restored))
                except Exception as exc:
                    log.warning("passage search failed, using the document search: %s", type(exc).__name__)
            passages = bool(found)
            if not found:
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
            terms = tokenize(restored)
            show = (lambda t: _passage(t, terms)) if passages else _short
            raw = "\n\n".join(f"{i}. {_get(s, 'title')}\n{show(_get(s, 'text', ''))}" for i, s in enumerate(snippets, 1))
            if answer:
                raw = f"Answer: {_short(answer, ANSWER_CHARS)}\n\n{raw}"
        else:
            raw = answer or "No matching passages."
        if unread:
            raw = f"{raw}\n\n{unchecked_note(len(unread))}"
        # Released as a finished job with get_result's bounded wait, so a slow check answers "still
        # checking" with a job_id before the relay gives up, and a retried search joins the release.
        # The wait is what is left of this call's budget after the retrieval and picking above.
        jobs = self.services.jobs
        # The documents the text came from are stored with the job, so a release after a restart
        # still uses the user's controls for them (a names-off folder, a scanned page). The model's
        # answer can draw on every passage it was shown, not only the ones it picked, so with an
        # answer every candidate counts. An image read while covering was off stays unchecked.
        shown = [*snippets, *found] if answer else snippets
        sources = list(dict.fromkeys(str(_get(s, "doc_id")) for s in shown if _get(s, "doc_id")))
        if uncovered or reads_uncovered(self.services.index):
            sources = mark_uncovered(sources)
        job_id = jobs.job_for_result(SEARCH_KIND, request, raw, "snippet", sources=sources)
        status, text = self._release(job_id, jobs.get(job_id), deadline)
        if status == "shared":
            return _text(text), status
        if status == "refused":
            return _text(_refused(text)), status
        if status == "running":
            return _json(_result_body(job_id, "running", SEARCH_CHECKING_NOTE)), "pending"
        return _json(_result_body(job_id, status, text)), status

    def ask_device(self, question: str, purpose: str = "", folder: str = "") -> tuple[CallToolResult, str]:
        """Mode 2: the device's model works on the request in the background; get_result has the answer."""
        question, purpose, folder = question.strip(), purpose.strip(), folder.strip()
        if not question:
            raise ToolFailure("Pass a question, for example: which essays mention the school garden?")
        runner = getattr(self.services, "ask_runner", None)
        if runner is None:
            raise ToolFailure(ASK_UNAVAILABLE)
        request = f"{question}\nPurpose: {purpose}" if purpose else question
        check_tags(self.services, request)  # the purpose's tags pick the answer's tag day too
        real_question = restore_tags(self.services, question)  # before any index call
        real_folder = self._docs(folder)[0] if folder else ""
        try:
            job_id = str(runner.start(real_question, request, real_folder or None))
        except Exception as exc:
            if type(exc).__name__ == "AskBusy":  # a plain sentence with a count, no content
                raise ToolFailure(str(exc), outcome="busy") from None
            raise
        return _json(_result_body(job_id, "queued", ASK_STARTED_NOTE)), "started"

    def run_private_task(self, instructions: str, folder: str) -> tuple[CallToolResult, str]:
        instructions, folder = instructions.strip(), folder.strip()
        if not instructions:
            raise ToolFailure(
                "Say what to do in instructions, for example: grade each essay against rubric.md."
            )
        restore_tags(self.services, instructions)  # an old or guessed tag starts nothing (EXPIRED_TAG)
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
        return _json(_result_body(job_id, status, TASK_STARTED_NOTE)), "started"

    def save_on_device(self, items: Any, purpose: str, address_to: str = "none") -> tuple[CallToolResult, str]:
        """Mail merge on the device: Muse's tagged text with real names filled in, saved under
        output/<job id>/. Muse gets the receipt (counts only) through egress, never a name."""
        deadline = self._deadline()
        purpose, address_to = purpose.strip(), (address_to or "none").strip()
        if not purpose:
            raise ToolFailure("Say in purpose who the files are for, for example: notes home to families.")
        parsed = merge.items_from(items or [])
        never_share = getattr(getattr(self.services, "policy", None), "never_share", None)
        try:
            merge.check(
                parsed, address_to, set(tag_values(self.services)),
                restore=lambda text: restore_tags(self.services, text), never_share=never_share,
            )
        except merge.SaveRefused as refused:
            raise ToolFailure(str(refused)) from None
        # Every text at once, before anything is written: an old tag or two tag days save nothing.
        check_tags(self.services, "\n".join(t for i in parsed for t in (i.for_tag, i.title, i.body)))
        contacts = self._contacts() if address_to == "guardians" else None
        jobs = self.services.jobs
        job_id = jobs.create(SAVE_KIND, merge.SAVE_REQUEST, None)
        try:
            saved = merge.write(
                self._output(job_id), parsed, address_to, purpose,
                restore=lambda text: restore_tags(self.services, text), contacts=contacts,
            )
        except Exception as exc:
            jobs.fail(job_id, "The files could not be saved on the device.")
            if isinstance(exc, merge.SaveRefused):
                raise ToolFailure(str(exc)) from None
            raise
        jobs.finish(job_id, merge.receipt(saved), "document_list")
        status, text = self._release(job_id, jobs.get(job_id), deadline)
        if status == "shared":
            return _json({"job_id": job_id, "status": "saved", "result": text}), "shared"
        if status == "running":
            return _json(_result_body(job_id, "running", CHECKING_NOTE)), "pending"
        return _json(_result_body(job_id, status, text, self._saved(job_id, jobs.get(job_id)))), status

    def _contacts(self) -> list:
        """The contact sheet, read on the device. A folder the user hid is never read."""
        settings = self.services.settings
        path = Path(settings.contacts)
        store = getattr(self.services, "controls", None)
        try:
            rel = path.resolve().relative_to(Path(settings.workspace_root).resolve()).as_posix()
        except ValueError:
            rel = None  # CONTACTS_PATH outside the workspace: no folder control covers it
        if store is not None and rel is not None:
            try:
                visible = store.get().visible(rel)
            except Exception:  # a broken controls file never means reading more
                visible = False
            if not visible:
                raise ToolFailure(
                    "The device's contact list is in a folder your privacy controls hide, so nothing was saved.",
                    outcome="refused",
                )
        try:
            contacts = load_contacts(path)
        except ContactsError as exc:
            raise ToolFailure(f"{exc} Nothing was saved.") from None
        if not contacts:
            raise ToolFailure("The device's contact list has no guardians, so nothing was saved.")
        return contacts

    def _output(self, job_id: str) -> Path:
        """output/<job id> under BASE_HOME, mode 0700."""
        self.services.settings.ensure_home()
        out = Path(self.services.settings.paths.output) / job_id
        out.mkdir(mode=0o700, exist_ok=True)
        os.chmod(out, 0o700)
        return out

    def get_result(self, job_id: str, wait_seconds: int = 0) -> tuple[CallToolResult, str]:
        """The job's status and result. With wait_seconds, wait on the device (within the call's
        budget) while the job is queued, running or waiting for the user's answer."""
        deadline = self._deadline()
        job_id = job_id.strip()
        if not job_id:
            raise ToolFailure(MISSING_JOB)
        until = min(self.clock() + max(0, min(int(wait_seconds or 0), MAX_WAIT_SECONDS)), deadline)
        body, outcome = self._result(job_id, deadline)
        if body["status"] in WAITABLE and self.clock() < until and self._waiters.acquire(blocking=False):
            try:
                decided = False
                while body["status"] in WAITABLE and (left := until - self.clock()) > 0:
                    decided = self._pause(job_id, body["status"], left, poll=decided)
                    body, outcome = self._result(job_id, deadline)
            finally:
                self._waiters.release()
        return _json(body), outcome

    def _pause(self, job_id: str, status: str, seconds: float, *, poll: bool = False) -> bool:
        """Wait for the user's answer on a waiting release, else pause POLL_SECONDS. True if answered."""
        if status == "waiting" and not poll:
            approval_id = _get(self.services.jobs.get(job_id), "approval_id")
            wait_decided = getattr(getattr(self.services, "approvals", None), "wait_decided", None)
            if approval_id is not None and callable(wait_decided):
                return bool(wait_decided(int(approval_id), seconds))
        self._wait(self._never, min(POLL_SECONDS, seconds))
        return False

    def _result(self, job_id: str, deadline: float) -> tuple[dict, str]:
        """One look at a job for get_result: its answer and the audit outcome."""
        if job_id.startswith("dream-"):
            return self._dream_result(job_id)
        job = self.services.jobs.get(job_id)
        if job is None:
            raise ToolFailure(f"There is no job {_quote(job_id)} on this device. {MISSING_JOB}")
        status = _get(job, "status")
        saved = self._saved(job_id, job)
        # set_release also moves the job status, so a released job is judged by release_status
        if (_get(job, "release_status") or "none") == "none":
            if status in ("queued", "running"):
                return _result_body(job_id, status, WORKING_NOTE), "pending"
            if status == "failed":
                return _result_body(job_id, "failed", FAILED_NOTE), "failed"
            if status == "refused":
                return _result_body(job_id, "refused", KEPT_EARLY_NOTE, saved), "refused"
        release_status, text = self._release(job_id, job, deadline)
        outcome = "pending" if release_status == "running" else release_status
        return _result_body(job_id, release_status, text, saved), outcome

    def _saved(self, job_id: str, job: Any) -> str | None:
        """Where a private task's files are on the device, relative to its home ("output/<job id>"),
        or None. Only the job id is named, never a file name, which can hold a real name."""
        if _get(job, "kind") in NO_SAVED_NOTE or not SAFE_JOB_ID.fullmatch(job_id):
            return None
        output = _get(_get(_get(self.services, "settings"), "paths"), "output")
        if output is None:
            return None
        try:
            has_files = any(p.is_file() for p in (Path(output) / job_id).iterdir())
        except OSError:
            return None
        return f"output/{job_id}" if has_files else None

    def _release(self, job_id: str, job: Any, deadline: float | None = None) -> tuple[str, str]:
        """The flow in "Jobs and releases": release once, resolve while waiting, then resend."""
        jobs, egress = self.services.jobs, self.services.egress
        deadline = self._deadline() if deadline is None else deadline
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
            return self._release(job_id, again, deadline)
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

        # The copied context keeps the call's relay or local label on egress's audit rows.
        context = contextvars.copy_context()
        threading.Thread(target=context.run, args=(work,), name=f"release-{job_id}", daemon=True).start()
        if not self._wait(done, self._left(deadline, RELEASE_WAIT_SECONDS)):
            return "running", CHECKING_NOTE
        if "error" in box:
            raise box["error"]
        return box["released"]

    def _job_sources(self, job: Any) -> list[str]:
        """Where a job's result came from, for the user's controls and the image checks: the job
        row's sources (a search's passages, an ask job's reading, a task's documents), else the
        folder of a job from before tasks stored theirs. None known means no sources, which
        always tags everything."""
        known = _get(job, "sources")
        if isinstance(known, str):
            try:
                known = json.loads(known)
            except ValueError:
                known = []
        if isinstance(known, list | tuple) and known:
            return [str(s) for s in known]
        folder = _get(job, "folder")
        return [str(folder)] if folder and _get(job, "kind") not in NO_SAVED_NOTE else []

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
            sources=self._job_sources(job),
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

    def _dream_result(self, job_id: str) -> tuple[dict, str]:
        """get_result for a run_dreaming id: running while the night holds the lock, then its numbers."""
        night = self.services.night
        if night.running_job() == job_id:
            return _result_body(job_id, "running", DREAM_RUNNING_NOTE), "pending"
        report_for = getattr(night, "report_for", None)
        report = report_for(job_id) if callable(report_for) else None
        if report is None:
            raise ToolFailure(f"There is no dreaming run {_quote(job_id)} on this device. Start one with run_dreaming.")
        released = self.services.egress.release("dreaming_report", "dreaming report", _report_text(report), "dreaming_report")
        status = "done" if released.status == "shared" else released.status
        return _result_body(job_id, status, released.text), released.status

    def run_dreaming(self) -> tuple[CallToolResult, str]:
        """Start a night, at most one per DREAM_AGAIN_AFTER_SECONDS from Muse. While one runs, its id."""
        night = self.services.night
        running = getattr(night, "running_job", None)
        last_finished = getattr(night, "last_finished_at", None)
        if not (callable(running) and running()) and callable(last_finished):
            finished = last_finished()
            if finished and time.time() - float(finished[1]) < DREAM_AGAIN_AFTER_SECONDS:
                return _json({"job_id": str(finished[0]), "status": "done", "result": DREAMED_TODAY}), "done"
        started = night.start()
        if isinstance(started, str):
            job_id, status = started, "running"
        else:
            job_id, status = _get(started, "job_id"), _get(started, "status") or "running"
        if job_id is None:
            return _json({"job_id": None, "status": str(status)}), "started"
        return _json(_result_body(str(job_id), str(status), DREAM_STARTED_NOTE)), "started"

    def dreaming_report(self) -> tuple[CallToolResult, str]:
        night = self.services.night
        raw = _report_text(night.last_report())
        running = getattr(night, "running_job", None)
        if callable(running) and running():
            raw = "A dreaming run is in progress. These numbers are from the run before it.\n" + raw
        released = self.services.egress.release("dreaming_report", "dreaming report", raw, "dreaming_report")
        return _plain(released), released.status


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


def _label_calls(connector: Connector):
    """Middleware: label each message relay or local for the audit (the relay client's header), and
    record the MCP client's name from initialize as a short label, never its other fields."""

    async def middleware(ctx, call_next):
        headers = getattr(ctx.request, "headers", None)
        token = CURRENT_VIA.set(via_label(headers.get(VIA_HEADER) if headers is not None else None))
        try:
            if ctx.method == "initialize":
                info = (ctx.params or {}).get("clientInfo")
                connector.audit("initialize", client_label(info.get("name") if isinstance(info, Mapping) else None))
            return await call_next(ctx)
        finally:
            CURRENT_VIA.reset(token)

    return middleware


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


class SaveItem(BaseModel):
    """One file for save_on_device, written with tags."""

    for_tag: str = Field(
        default="", max_length=40, description="The [Student X] tag this item is for; needed when address_to is guardians"
    )
    title: str = Field(min_length=1, max_length=merge.MAX_TITLE, description="The title or email subject; tags are fine")
    body: str = Field(max_length=merge.MAX_BODY, description="The text, with tags; {guardian} becomes the guardian's name")


def build_server(services: Any) -> MCPServer:
    """The MCP server with the eight connector tools, wired to `services`."""
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
            "call get_result with it and wait_seconds 25."
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
        name="ask_device",
        title="Ask the device",
        annotations=READ,
        description=(
            "Ask the device to answer a request about the user's private documents. The device's own model "
            "splits a request with several parts into questions, searches the documents several ways for "
            "each (and keeps searching with new words while it finds nothing, for up to 3 minutes), then "
            "writes one finished answer with up to 5 short quotes, names and identifiers as tags like "
            "[Student A]. Use it for questions; use search_documents when you want the passages "
            "themselves. You can put tags in the question. Say in purpose who the answer is for, for "
            "example: for my own planning. folder is optional (default: every folder Muse can see). "
            "Returns a job_id at once: call get_result with it and wait_seconds 25 until the status is "
            "no longer queued or running."
        ),
    )
    def ask_device(
        question: Annotated[str, Field(max_length=500, description="The question; tags are fine")],
        purpose: Annotated[
            str, Field(max_length=300, description="Who the answer is for, for example: for my own planning")
        ] = "",
        folder: Annotated[str, Field(max_length=300, description="Optional folder to search in")] = "",
    ) -> CallToolResult:
        return c.call("ask_device", c.ask_device, question, purpose, folder)

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
            "[Student A]. Returns a job_id and status at once; then call get_result with the job_id and "
            "wait_seconds 25. A task that is not grading saves its full answer with real names on the device too."
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
        name="save_on_device",
        title="Save files on the device",
        annotations=START_TASK,
        description=(
            "Save files you wrote on the user's device with the real names filled in, for example one note "
            "home per student. Write each item with tags exactly as you received them, like [Student A]; the "
            "device swaps them for the real names and saves the files there, where the user opens them. They "
            'are never sent to you. With address_to "guardians", give each item for_tag, the [Student X] tag '
            "it is for: the device makes one email draft for each of that student's guardians from its own "
            "list, with {guardian} in the title or body replaced by the guardian's name. Say in purpose who "
            "the files are for. You get back only counts. A tag the device does not know saves nothing."
        ),
    )
    def save_on_device(
        items: Annotated[
            list[SaveItem],
            Field(min_length=1, max_length=merge.MAX_ITEMS, description="1 to 60 items, each a title and a body with tags"),
        ],
        purpose: Annotated[
            str, Field(min_length=1, max_length=300, description="Who the files are for, for example: notes home to families")
        ],
        address_to: Annotated[
            Literal["none", "guardians"],
            Field(description='"guardians" makes one email draft per guardian of each item\'s student; "none" one note per item'),
        ] = "none",
    ) -> CallToolResult:
        return c.call("save_on_device", c.save_on_device, items, purpose, address_to)

    @server.tool(
        name="get_result",
        title="Get a task result",
        annotations=READ,
        description=(
            "Get the status and result of a job_id from run_private_task, search_documents, ask_device, "
            "save_on_device or run_dreaming. With wait_seconds (up to 40) the device waits and answers as soon as the job is "
            "done or the user taps Share it or Keep it here. While the status is queued, running or waiting, "
            "call again with wait_seconds 25. A shared result has names as tags, or is a summary. Status "
            "waiting means the result is waiting for the user's OK on the device: tell the user. Status refused "
            "means it is kept on the device; do not ask for it another way. Files with real names always stay "
            "on the device."
        ),
    )
    def get_result(
        job_id: Annotated[
            str,
            Field(
                max_length=100,
                description="The job_id from run_private_task, search_documents, ask_device, save_on_device or run_dreaming",
            ),
        ],
        wait_seconds: Annotated[
            int,
            Field(description="Seconds to wait on the device for the job or the user's answer, 0 to 40"),
        ] = 0,
    ) -> CallToolResult:
        return c.call("get_result", c.get_result, job_id, wait_seconds)

    @server.tool(
        name="run_dreaming",
        title="Start dreaming",
        annotations=START_DREAMING,
        description=(
            "Start the device's dreaming run: it relearns the privacy router from the user's recent "
            "share and keep decisions, and keeps the new rules only if they test at least as well. It runs at "
            "most once a day: while a run is going you get the same job_id back, and after a run finished "
            "today it starts nothing and says so. Then call dreaming_report."
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

    server.middleware.extend([_label_calls(c), _plain_errors(c)])
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
