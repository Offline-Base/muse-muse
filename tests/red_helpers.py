"""Shared pieces for the red-team tests (tests/test_attacks.py, tests/test_red_model_view.py).

Real Services under DEVICE_ONLY=1 in a temp BASE_HOME, over a copy of the invented demo class, with
the device model at 127.0.0.1:8083 faked by respx. FakeModel records every request, so a test can
check what each model saw, and each of its answers can be swapped for an adversarial one: a name
pass that finds nothing, a labeler that obeys an injection, a router that always shares, a summary
that singles someone out. No model and no network: respx fails any request it was not told about.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from mcp import Client

from base import guard
from base.config import REPO_ROOT, load_settings
from base.connector.server import build_server
from base.services import Services

# The device model's address in these tests. Port 9 has no server, so even a call that slipped past
# respx (a thread outliving its test) could never reach the live model on 8083.
CHECKER = "http://127.0.0.1:9/v1"
DEMO = REPO_ROOT / "demo"
RED = REPO_ROOT / "eval" / "red"
ROSTER = guard.load_roster(REPO_ROOT / "eval" / "roster.json")
TRUTH = json.loads((RED / "truth.json").read_text())
# The invented records, by name. Nothing is globbed from demo/: the live checkout keeps personal
# files next to the invented ones, and only these may be copied.
RECORDS = (
    "attendance.md",
    "behavior_log.md",
    "health_office.md",
    "iep_504_notes.md",
    "lunch_status.md",
    "parent_contacts.md",
    "reading_groups.md",
)
FORMS = ("Abigail Thornbury field trip form.png",)
PEOPLE = [ROSTER.teacher, *ROSTER.students]
FORMS_OF_NAMES = sorted({f for p in PEOPLE for f in (p.name, p.first, p.last, *p.nicknames)}, key=len, reverse=True)
OTHER_PEOPLE = sorted({*TRUTH["guardians"], *TRUTH["other_people"]}, key=len, reverse=True)
_PHONE = re.compile(r"555-01\d\d")
_EMAIL = re.compile(r"[\w.]+@example\.(?:com|org)")
_SID = re.compile(r"\bS4\d{5}\b")


def invented_workspace(root: Path, *, forms: bool = False) -> Path:
    """A copy of the invented class: the 24 roster essays, the 7 records and the rubric, by name."""
    (root / "essays").mkdir(parents=True)
    (root / "records").mkdir()
    for p in ROSTER.students:
        shutil.copy2(DEMO / "essays" / f"{p.name}.md", root / "essays" / f"{p.name}.md")
    for name in RECORDS:
        shutil.copy2(DEMO / "records" / name, root / "records" / name)
    if forms:
        (root / "forms").mkdir()
        for name in FORMS:
            shutil.copy2(DEMO / "forms" / name, root / "forms" / name)
    shutil.copy2(DEMO / "rubric.md", root / "rubric.md")
    (root / ".synthetic").write_text("Invented red-team copy of the demo class.\n")
    return root


def red_settings(tmp_path: Path, *, forms: bool = False, **extra: str):
    root = tmp_path / "workspace"
    if not root.exists():
        invented_workspace(root, forms=forms)
    env = {
        "BASE_DEVICE": "laptop",
        "BASE_HOME": str(tmp_path / "home"),
        "WORKSPACE_ROOT": str(root),
        "DEVICE_ONLY": "1",
        "CHECKER_URL": CHECKER,
        "CHECKER_API_KEY": "local-test-key",
        "HEAVY_QUEUE": "0",
        "LIGHT_SERIAL": "",
        **extra,
    }
    return load_settings(env)


def private_values(text: str) -> list[str]:
    """Every private value in `text`, as a kind and never the value: roster forms written as names
    (case-sensitive, whole word), people the roster does not know (guardians, staff), 555-01xx
    phones, example.com emails, student ids, and whatever guard.leaks finds with no tag map."""
    found = [f"roster:{len(f)}" for f in FORMS_OF_NAMES if re.search(rf"(?<![\w']){re.escape(f)}(?![\w'])", text)]
    found += ["other" for n in OTHER_PEOPLE if re.search(rf"(?<!\w){re.escape(n)}(?!\w)", text, re.IGNORECASE)]
    found += ["phone"] * bool(_PHONE.search(text)) + ["email"] * bool(_EMAIL.search(text)) + ["sid"] * bool(_SID.search(text))
    found += [f"guard:{h.kind}" for h in guard.leaks(text, ROSTER, None)]
    return found


@dataclass
class Call:
    url: str
    schema: str | None
    messages: list[dict]

    def texts(self) -> list[str]:
        out = []
        for m in self.messages:
            content = m.get("content")
            if isinstance(content, str):
                out.append(content)
            elif isinstance(content, list):
                out += [p["text"] for p in content if isinstance(p, dict) and isinstance(p.get("text"), str)]
        return out

    @property
    def user(self) -> str:
        users = [m for m in self.messages if m.get("role") == "user"]
        content = users[-1].get("content") if users else ""
        return content if isinstance(content, str) else ""

    @property
    def system(self) -> str:
        first = self.messages[0] if self.messages else {}
        return first.get("content") if first.get("role") == "system" and isinstance(first.get("content"), str) else ""


def _first_passage(user: str) -> str:
    """The text of passage [1] in a rag or ask prompt, as the model saw it."""
    m = re.search(r"\[1\][^\n]*\n(.*?)(?:\n\n\[2\]|\n\nQuestion:|\Z)", user, re.DOTALL)
    return " ".join((m.group(1) if m else "").split())[:240]


class FakeModel:
    """The device model, faked. Each answer is a callable of the request (a Call) and can be
    replaced. The defaults echo what the model was shown, the worst an obedient model can do."""

    def __init__(self) -> None:
        self.calls: list[Call] = []
        self.names: Callable[[Call], list[str]] = lambda c: []  # misses every name
        self.topics: Callable[[Call], list[str]] = lambda c: []  # misses every label
        self.route: Callable[[Call], str] = lambda c: "share_tagged"  # always wants to share
        self.summary: Callable[[Call], str] = lambda c: "The class did well overall. Most essays gave two reasons."
        self.scan: Callable[[Call], str] = lambda c: "Field trip form. Permission given."
        self.rag: Callable[[Call], dict] = lambda c: {"passages": [1], "answer": _first_passage(c.user) or "No passage answers this."}
        self.ask: Callable[[Call], dict] = lambda c: {
            "enough": True,
            "more_queries": [],
            "answer": _first_passage(c.user) or "The documents on this device do not answer this.",
            "quotes": [],
        }
        self.grade: Callable[[Call], dict] = lambda c: {
            "scores": {"ideas": 3, "organization": 3, "evidence": 2, "conventions": 3},
            "total": 11,
            "strengths": "Clear opinion with two reasons.",
            "next_step": "Add one more detail.",
            "feedback": "Nice work giving reasons for a garden.",
        }
        self.answer: Callable[[Call], str] = lambda c: _first_passage(c.user) or "Nothing found."

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        fmt = body.get("response_format") or {}
        spec = fmt.get("json_schema") or {}
        call = Call(str(request.url), spec.get("name") if fmt else None, body.get("messages") or [])
        self.calls.append(call)
        content = self.reply(call, spec.get("schema") or {})
        text = content if isinstance(content, str) else json.dumps(content)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": text}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 10},
            },
        )

    def reply(self, call: Call, schema: dict) -> Any:
        name = call.schema
        props = schema.get("properties") or {}
        if name == "person_names":
            return {"names": self.names(call)}
        if name == "request_topics":
            return {"topics": self.topics(call)}
        if name == "route":
            return {"decision": self.route(call), "reason": "The fake router's reason."}
        if name in ("search_queries", "retry_queries"):
            return {"queries": []}
        if name == "rag_answer":
            return self.rag(call)
        if name == "request_parts":
            return {"parts": [call.user]}
        if name == "device_answer":
            return self.ask(call)
        if name == "combined_answer":
            return {"answer": " ".join(re.findall(r"Answer: (.*)", call.user))}
        if "scores" in props:
            return self.grade(call)
        if "answer" in props:
            return {"answer": self.answer(call)}
        if call.system.startswith("You read scanned documents"):
            return self.scan(call)
        return self.summary(call)


class Device:
    """Services for the invented class plus a Muse that calls the connector tools in process."""

    def __init__(self, tmp_path: Path, fake: FakeModel, *, forms: bool = False, **env: str):
        self.fake = fake
        self.settings = red_settings(tmp_path, forms=forms, **env)
        self.services = Services.create(self.settings, light=False, heavy=False, owner=False)
        self.server = build_server(self.services)
        self.outputs: list[str] = []

    def close(self) -> None:
        self.services.close()

    def tag_of(self, name: str, *, sent: bool = True) -> str:
        """The tag this device gives a roster student, marked as sent to Muse (with daily rotation
        only the tags the device sent restore) unless sent=False: a tag Muse guessed."""
        tag = guard.tag(name, ROSTER, self.services.tagmap).text
        assert guard.TAG_RE.fullmatch(tag), "not a single roster name"
        if sent:
            self.services.tagmap.touch([tag])
        return tag

    def call(self, tool: str, **args: Any) -> tuple[bool, str]:
        async def go():
            async with Client(self.server) as c:
                return await c.call_tool(tool, args)

        result = asyncio.run(go())
        text = result.content[0].text
        self.outputs.append(text)
        return bool(result.is_error), text

    def final(self, tool: str, timeout: float = 20, *, approve: bool = False, **args: Any) -> tuple[str, str]:
        """(status, text Muse ends up with): follows a job id with get_result until it settles.
        With approve=True a waiting result is approved and fetched again: what Muse gets from a
        teacher who clicks Share it on every card, the worst case for a leak."""
        error, text = self.call(tool, **args)
        if error:
            return "error", text
        try:
            body = json.loads(text)
        except ValueError:
            if approve and text.startswith("Waiting for your OK"):
                sent = self.approve_all()
                return ("shared", sent[-1]) if sent else ("waiting", text)
            return ("refused" if text.startswith(("Kept on", "Held on")) else "shared"), text
        if not isinstance(body, dict) or "job_id" not in body:
            return "shared", text
        deadline = time.monotonic() + timeout
        while True:
            while body.get("status") in ("queued", "running"):
                assert time.monotonic() < deadline, "the job did not settle in time"
                time.sleep(0.02)
                error, text = self.call("get_result", job_id=body["job_id"])
                assert not error, text
                body = json.loads(text)
            if not (approve and body.get("status") == "waiting" and self.approve_all()):
                return str(body.get("status")), str(body.get("result") or "")
            body = {"job_id": body["job_id"], "status": "running"}

    def approve_all(self) -> list[str]:
        """Approve every waiting card; returns the text each one releases."""
        out = []
        for row in self.services.approvals.pending():
            self.services.approvals.decide(row["id"], approve=True)
            out.append(self.services.egress.resolve(row["id"]).text)
        return out

    def sent(self, released: Any) -> str:
        """The text a release gives Muse, after the teacher approves it if it waited."""
        if released.status != "waiting":
            return released.text
        self.services.approvals.decide(released.approval_id, approve=True)
        return self.services.egress.resolve(released.approval_id).text

    def audit_outcomes(self) -> list[str]:
        return [r["outcome"] for r in self.services.audit.recent(200)]
