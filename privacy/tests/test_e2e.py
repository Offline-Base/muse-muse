"""End to end, in process: Muse's tool calls -> connector -> agent -> egress -> approval page -> resolve.

Real Services.create on a temp BASE_HOME over the invented demo workspace. The unit test fakes
Glimmer at the HTTP layer (respx), so LocalLLM, the router, the guard, egress, the stores, the
connector and the approval page all run for real. The integration test does the same with real
Glimmer on OpenRouter, grades all 24 demo essays and writes eval/reports/e2e_cloud.md.

Every tool output is checked for roster names, nicknames, other_names values (people who are not
on the roster) and identifiers from the eval data. None may appear.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
from datetime import datetime
from pathlib import Path

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from mcp import Client

from base import guard
from base.config import REPO_ROOT, load_settings
from base.connector import server
from base.connector.server import build_server
from base.dreaming import train
from base.services import Services
from base.ui_app import create_app

DEMO = REPO_ROOT / "demo"
PAGE = "http://127.0.0.1:8787"
GRADE_INSTRUCTIONS = "Grade each essay against rubric.md and write feedback for each student."

ROSTER = json.loads((REPO_ROOT / "eval" / "roster.json").read_text())
PEOPLE = [ROSTER["teacher"], *ROSTER["students"]]
STUDENTS = [p["name"] for p in ROSTER["students"]]
FORMS = sorted({f for p in PEOPLE for f in (p["name"], p["first"], p["last"], *p["nicknames"])}, key=len)
TASKS = [json.loads(line) for line in (REPO_ROOT / "eval" / "tasks.jsonl").read_text().splitlines() if line]
OTHER_NAMES = sorted({n for item in TASKS for n in item.get("other_names", [])})
IDENTIFIERS = sorted({v for item in TASKS for v in item["identifiers"]})


def _word(value: str, flags: int = 0) -> re.Pattern:
    return re.compile(rf"(?<!\w){re.escape(value)}(?!\w)", flags)


def private_values(text: str, services) -> list[str]:
    """Everything private in `text`: roster forms (as names, so case-sensitive), other_names and
    identifiers from the eval data (case-insensitive), and whatever guard.leaks reports."""
    found = [f"roster:{f}" for f in FORMS if _word(f).search(text)]
    found += [f"other:{n}" for n in OTHER_NAMES if _word(n, re.IGNORECASE).search(text)]
    found += [f"identifier:{v}" for v in IDENTIFIERS if _word(v, re.IGNORECASE).search(text)]
    found += [f"guard:{h.kind}" for h in guard.leaks(text, services.roster, services.tagmap)]
    return found


def e2e_settings(home: Path, **extra: str):
    env = {
        **os.environ,
        "BASE_DEVICE": "laptop",
        "BASE_HOME": str(home),
        "GLIMMER_BACKEND": "openrouter",
        "WORKSPACE_ROOT": str(DEMO),
        "HEAVY_QUEUE": "0",
        "LIGHT_SERIAL": "",
        "APPROVAL_HOST": "127.0.0.1",
        "APPROVAL_PORT": "8787",
        **extra,
    }
    return load_settings(env)


def demo_files() -> list[str]:
    return sorted(str(p.relative_to(DEMO)) for p in DEMO.rglob("*"))


class Muse:
    """Calls the connector tools the way Muse does (in-process MCP client) and keeps every output."""

    def __init__(self, services):
        self.server = build_server(services)
        self.outputs: list[str] = []

    def call(self, name: str, args: dict | None = None) -> tuple[bool, str]:
        async def go():
            async with Client(self.server) as c:
                return await c.call_tool(name, args or {})

        result = asyncio.run(go())
        text = result.content[0].text
        self.outputs.append(text)
        return result.is_error, text

    def result(self, job_id: str) -> dict:
        error, text = self.call("get_result", {"job_id": job_id})
        assert not error, text
        return json.loads(text)

    def wait(self, job_id: str, timeout: float, every: float = 0.05) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            body = self.result(job_id)
            if body["status"] not in ("queued", "running"):
                return body
            assert time.monotonic() < deadline, "the job did not finish in time"
            time.sleep(every)


class CallLog:
    """Records each Glimmer call's role, step kind, model, latency and tokens. Never content."""

    def __init__(self):
        self.rows: list[dict] = []
        self._lock = threading.Lock()

    def wrap(self, llm, role: str) -> None:
        inner = llm.chat

        def chat(messages, **kw):
            result = inner(messages, **kw)
            with self._lock:
                self.rows.append(
                    {
                        "role": role,
                        "kind": step_kind(kw.get("json_schema")),
                        "model": result.model,
                        "latency_ms": result.latency_ms,
                        "prompt_tokens": result.prompt_tokens,
                        "completion_tokens": result.completion_tokens,
                        "reasoning_tokens": result.reasoning_tokens,
                    }
                )
            return result

        llm.chat = chat


def step_kind(schema: dict | None) -> str:
    if schema is None:
        return "summary"
    if schema.get("name") == "route":
        return "route"
    if schema.get("name") == "person_names":
        return "names"
    if schema.get("name") == "request_topics":
        return "topics"
    props = (schema.get("schema") or schema).get("properties", {})
    return "grade" if "scores" in props else "answer" if "answer" in props else "other"


def feedback_files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file() and p.name.endswith(" feedback.md"))


# ------------------------------------------------------------------ unit: Glimmer faked over HTTP

NON_ROSTER = ["Keoni", "Luciana", "Tomas", "Mr. Delgado"]


def fake_glimmer(request: httpx.Request) -> httpx.Response:
    """Answers like Glimmer would for each step, told apart by the response_format name."""
    body = json.loads(request.content)
    fmt = (body.get("response_format") or {}).get("json_schema") or {}
    props = (fmt.get("schema") or {}).get("properties", {})
    user = body["messages"][-1]["content"]
    if fmt.get("name") == "route":
        kind = re.search(r"Result kind: (\w+)", user).group(1)
        reply = {"decision": "ask_user" if kind == "per_student" else "share_tagged", "reason": "Fake router."}
    elif fmt.get("name") == "request_topics":  # the request's topics; grading for the teacher has none
        reply = {"topics": []}
    elif fmt.get("name") == "person_names":  # finds roster names too, as the real model does
        reply = {"names": [n for n in [*STUDENTS, *NON_ROSTER] if n in user]}
    elif "scores" in props:
        name = re.search(r"Essay:\n# ([^:\n]+):", user).group(1)
        first = name if name.startswith("[") else name.split()[0]  # the model sees tags (review F4)
        reply = {
            "scores": {"ideas": 3, "organization": 2, "evidence": 3, "conventions": 4},
            "total": 12,
            "strengths": f"{first} states a clear opinion.",
            "next_step": f"{first} should add one more fact from a source.",  # names must be scrubbed
            "feedback": f"Dear {first}, your reasons are clear. Add one more fact.",
        }
    elif "answer" in props:
        reply = {"answer": "Done."}
    else:
        return glimmer_reply("Class average 3.0 of 4 across the essays.")
    return glimmer_reply(json.dumps(reply))


def glimmer_reply(content: str) -> httpx.Response:
    usage = {"prompt_tokens": 100, "completion_tokens": 20, "completion_tokens_details": {"reasoning_tokens": 5}}
    data = {"model": "meta/muse-glimmer-30b", "choices": [{"message": {"content": content}, "finish_reason": "stop"}]}
    return httpx.Response(200, json={**data, "usage": usage})


def route_texts(route) -> list[str]:
    """The user message of every router call the fake received."""
    out = []
    for call in route.calls:
        body = json.loads(call.request.content)
        if ((body.get("response_format") or {}).get("json_schema") or {}).get("name") == "route":
            out.append(body["messages"][-1]["content"])
    return out


@pytest.fixture
def world(tmp_path):
    settings = e2e_settings(tmp_path / "home", OPENROUTER_API_KEY="test-key")
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(f"{settings.answer_url}/chat/completions").mock(side_effect=fake_glimmer)
        services = Services.create(settings)
        log = CallLog()
        log.wrap(services.answer_llm, "answer")
        log.wrap(services.router_llm, "router")
        try:
            yield services, route, log, tmp_path
        finally:
            services.close()


def test_full_path_keeps_every_private_value_on_the_device(world):
    services, route, log, tmp_path = world
    home = services.settings.home
    before = demo_files()
    muse = Muse(services)

    # Muse looks around: titles come back as tags.
    error, listing = muse.call("list_documents", {"folder": "essays"})
    assert not error and listing.startswith("24 documents in folder essays:")
    assert len(set(re.findall(r"\[Student [A-Z]+\]", listing))) == 24

    # Search: a non-roster relative is tagged by the model's second pass; a medical hit is refused.
    error, found = muse.call("search_documents", {"query": "uncle taro farm"})
    assert not error and "[Person " in found and "taro" in found
    error, held = muse.call("search_documents", {"query": "asthma inhaler"})
    assert not error and held.startswith("Kept on your device.")
    error, staff = muse.call("search_documents", {"query": "custodian hose fig"})
    assert not error and "[Person " in staff

    # Muse refers to a student by tag; the device swaps it back locally to search.
    tag = re.search(r"\[Student [A-Z]+\]", listing).group(0)
    error, by_tag = muse.call("search_documents", {"query": f"{tag} garden"})
    assert not error

    # Grading: the agent runs on the device and the per-student table waits for the user's OK.
    error, started = muse.call("run_private_task", {"instructions": GRADE_INSTRUCTIONS, "folder": "essays"})
    assert not error
    job_id = json.loads(started)["job_id"]
    first = muse.wait(job_id, timeout=30)
    saved = server.SAVED_NOTE.format(where=f"output/{job_id}")  # the feedback files, by job id only
    assert first["status"] == "waiting" and first["result"] == f"Waiting for your OK on the device. {saved}"
    job = services.jobs.get(job_id)
    assert job["kind"] == "grading" and job["status"] == "waiting_for_approval"
    assert isinstance(job["approval_id"], int)
    assert len([s for s in job["model_log"] if s["step"].startswith("grade:")]) == 24

    with TestClient(create_app(services), base_url=PAGE, headers={"Origin": PAGE}) as page:
        [card] = page.get("/api/approvals").json()["approvals"]
        assert card["id"] == job["approval_id"] and card["tool"] == "get_result"
        assert private_values(card["tagged_text"], services) == []  # the page shows tags only
        assert "| Total |" in card["tagged_text"] and card["tagged_text"].count("[Student ") >= 48
        ok = page.post(f"/api/approvals/{card['id']}", json={"approve": True, "remember": True})
        assert ok.status_code == 200

        shared = muse.result(job_id)
        assert shared["status"] == "shared"
        assert shared["result"] == services.approvals.get(card["id"])["tagged_text"]
        assert muse.result(job_id) == shared  # resent from the job, not released again

        # A second job, and this time the user keeps it on the device.
        error, started = muse.call("run_private_task", {"instructions": GRADE_INSTRUCTIONS, "folder": "essays"})
        second = json.loads(started)["job_id"]
        assert muse.wait(second, timeout=30)["status"] == "waiting"
        pending = services.jobs.get(second)["approval_id"]
        assert page.post(f"/api/approvals/{pending}", json={"approve": False}).status_code == 200
        kept = muse.result(second)
        saved = server.SAVED_NOTE.format(where=f"output/{second}")
        assert kept == {"job_id": second, "status": "refused", "result": f"Kept on your device. {saved} {server.REFUSED_END}"}
        assert services.jobs.get(second)["status"] == "refused"

    error, report = muse.call("dreaming_report")
    assert not error and report == "No dreaming run has finished yet."

    # Nothing private in any tool output.
    for text in muse.outputs:
        assert private_values(text, services) == [], text
    assert all("[Student " not in r["raw_result"] for r in [services.jobs.get(job_id)])  # raw stays raw

    # The router only ever saw tagged text.
    seen = route_texts(route)
    assert seen and all(private_values(t, services) == [] for t in seen)
    assert {(r["role"], r["kind"]) for r in log.rows} >= {("router", "route"), ("answer", "grade"), ("answer", "names")}

    # Feedback files with real names exist, only under BASE_HOME/output, and the demo is untouched.
    files = feedback_files(tmp_path)
    assert len(files) == 48
    assert all(f.is_relative_to(home / "output") for f in files)
    for f in files:
        student = f.name.removesuffix(" feedback.md")
        assert student in STUDENTS and f"# Feedback for {student}" in f.read_text()
        assert oct(f.stat().st_mode & 0o777) == "0o600"
    assert {f.parent.name for f in files} == {job_id, second}
    assert demo_files() == before
    assert feedback_files(DEMO) == []

    # Every call was audited, with labels only.
    outcomes = [(r["tool"], r["outcome"]) for r in reversed(services.audit.recent(100))]
    assert ("run_private_task", "started") in outcomes and ("get_result", "shared") in outcomes
    assert ("search_documents", "refused") in outcomes and ("get_result", "refused") in outcomes


# ------------------------------------------------------------------ integration: real Glimmer

REPORTS = REPO_ROOT / "eval" / "reports"
COMMAND = "RUN_INTEGRATION=1 uv run pytest -q -s tests/test_e2e.py::{test}"


def ask_first_rules() -> str:
    """What a night writes after the teacher asked to keep seeing per-student grades (three answers
    without "don't ask again"): one learned rule, in dreaming's own format."""
    rule = train.Rule("per_student", ("grades", "writing"), "ask_user", count=3, total=3, source="user")
    return train.render_rules([rule], user_count=3, synthetic_count=0, day="2026-10-26")


@pytest.mark.integration
def test_e2e_cloud_grading(tmp_path):
    """Real Glimmer, with one learned rule that asks first: grade, approve on the page, read."""
    run_cloud_grading(tmp_path, ask_first_rules(), REPORTS / "e2e_cloud.md", "test_e2e_cloud_grading")


@pytest.mark.integration
def test_e2e_cloud_grading_no_rules(tmp_path):
    """Real Glimmer on a first day with no learned rules: the router decides on its own."""
    run_cloud_grading(tmp_path, None, REPORTS / "e2e_cloud_no_rules.md", "test_e2e_cloud_grading_no_rules")


def run_cloud_grading(tmp_path, rules: str | None, report: Path, test_name: str) -> None:
    """Grade the 24 demo essays with real Glimmer on OpenRouter from a simulated Muse call."""
    settings = e2e_settings(tmp_path / "home")
    if not settings.model_api_key:
        pytest.skip("OPENROUTER_API_KEY is not set")
    if rules is not None:
        settings.ensure_home()
        settings.paths.router_prompt.write_text(rules)
    services = Services.create(settings)
    log = CallLog()
    log.wrap(services.answer_llm, "answer")
    log.wrap(services.router_llm, "router")
    muse = Muse(services)
    timeline: list[tuple[str, float]] = []
    try:
        t0 = time.monotonic()
        error, listing = muse.call("list_documents", {"folder": "essays"})
        assert not error
        timeline.append(("list_documents", time.monotonic() - t0))

        t_request = time.monotonic()
        error, started = muse.call("run_private_task", {"instructions": GRADE_INSTRUCTIONS, "folder": "essays"})
        assert not error, started
        job_id = json.loads(started)["job_id"]
        first = muse.wait(job_id, timeout=1200, every=2.0)
        t_first = time.monotonic()
        job = services.jobs.get(job_id)
        assert job["status"] != "failed", job["error"]
        timeline.append((f"get_result after the job: {first['status']}", t_first - t_request))

        approved = False
        if first["status"] == "waiting":
            with TestClient(create_app(services), base_url=PAGE, headers={"Origin": PAGE}) as page:
                [card] = page.get("/api/approvals").json()["approvals"]
                assert private_values(card["tagged_text"], services) == []
                ok = page.post(f"/api/approvals/{card['id']}", json={"approve": True, "remember": True})
                assert ok.status_code == 200
                approved = True
            final = muse.result(job_id)
            timeline.append(("approved on the page API, then get_result", time.monotonic() - t_request))
        else:
            final = first
        t_result = time.monotonic()

        leaks = [(i, v) for i, text in enumerate(muse.outputs) for v in private_values(text, services)]
        files = feedback_files(tmp_path)
        job = services.jobs.get(job_id)
        # The job's own time comes from the job store; the poll every 2 s is not part of it.
        job_s = (job["finished_at"] or job["created_at"]) - job["created_at"]
        write_report(services, job, log.rows, timeline, first, final, approved, leaks, files,
                     t_result - t_request, job_s, rules, report, test_name)  # fmt: skip
        assert leaks == []
        assert final["status"] in ("shared", "refused")
        assert len(files) == 24 and all(f.is_relative_to(settings.home / "output") for f in files)
    finally:
        services.close()


def _ms(values: list[int]) -> str:
    if not values:
        return "n/a"
    values = sorted(values)
    return f"{sum(values) / len(values) / 1000:.1f} s mean, {values[len(values) // 2] / 1000:.1f} s median, {values[-1] / 1000:.1f} s max"


def write_report(
    services, job, calls, timeline, first, final, approved, leaks, files, total_s, job_s, rules, report, test_name
) -> None:
    s = services.settings
    grade_steps = [e for e in job["model_log"] if e["step"].startswith("grade:")]
    by_kind: dict[tuple[str, str], list[dict]] = {}
    for row in calls:
        by_kind.setdefault((row["kind"], row["role"]), []).append(row)
    labels = {"grade": "Grade one essay", "names": "Second pass for names", "topics": "Request topics", "route": "Privacy router",
              "summary": "Class summary", "answer": "Generic answer", "other": "Other"}  # fmt: skip
    tokens = {k: sum(r[k] for r in calls) for k in ("prompt_tokens", "completion_tokens", "reasoning_tokens")}
    decision = services.approvals.history(limit=50)
    routed = [r for r in decision if r["tool"] == "get_result"]
    lines = [
        "# End to end on the cloud backend",
        "",
        f"Command: `{COMMAND.format(test=test_name)}`",
        "",
        f"Date: {datetime.now().strftime('%Y-%m-%d %H:%M')}. Device setting: {s.device}. Backend: {s.glimmer_backend} "
        f"(Glimmer `{s.answer_model}` for answers and routing). Workspace: the invented demo folder "
        "(marked `.synthetic`). A fresh temporary BASE_HOME "
        + ("with one learned router rule, as a dreaming night writes it after the teacher asked three times "
           "to keep seeing per-student grades: "
           f"`{next(line for line in rules.splitlines() if line.startswith('- '))}`" if rules else
           "with no learned router rules (a first day).")
        + "",
        "",
        "What ran: a simulated Muse called list_documents on `essays`, then run_private_task with "
        f'"{GRADE_INSTRUCTIONS}", then get_result until the job finished. '
        + ("The router asked, so the test approved it on the approval page API (POST /api/approvals/<id>) "
           "and called get_result again." if approved else "The router did not ask, so there was nothing to approve.")
        + " Every tool output was checked for roster names, nicknames, other_names values and identifiers "
        "from eval/tasks.jsonl, plus guard.leaks.",
        "",
        "## Result",
        "",
        "| Measure | Value |",
        "|---|---|",
        f"| Time from run_private_task to the result Muse read (includes the 2 s get_result poll) | {total_s:.1f} s |",
        f"| Time for the job itself, jobs.created_at to finished_at (24 essays graded, files written) | {job_s:.1f} s |",
        f"| First get_result after the job | {first['status']} |",
        f"| Router decision | {routed[0]['router_decision'] if routed else 'n/a'} ({routed[0]['router_source'] if routed else ''}) |",
        f"| Approved on the page | {'yes' if approved else 'no, not asked'} |",
        f"| Final status Muse saw | {final['status']} |",
        f"| Feedback files with real names | {len(files)}, all under BASE_HOME/output/<job id>/ |",
        f"| Leaks found in tool outputs | {len(leaks)} |",
        f"| Glimmer calls | {len(calls)} |",
        f"| Tokens (prompt / completion / of which reasoning) | {tokens['prompt_tokens']} / {tokens['completion_tokens']} / {tokens['reasoning_tokens']} |",
        "",
        "## Steps and the model that did each",
        "",
        "| Step | Calls | Client role | Model | Backend | Device | Latency |",
        "|---|---|---|---|---|---|---|",
    ]
    for (kind, role), rows in sorted(by_kind.items()):
        models = ", ".join(sorted({r["model"] for r in rows}))
        lines.append(
            f"| {labels.get(kind, kind)} | {len(rows)} | {role} | {models} | {s.glimmer_backend} | {s.device} "
            f"| {_ms([r['latency_ms'] for r in rows])} |"
        )
    lines += [
        "",
        "The agent's own step log (jobs.model_log) agrees: "
        f"{len(grade_steps)} grading steps, via {sorted({e['via'] for e in grade_steps})}, "
        f"model {sorted({e['model'] for e in grade_steps})}, step latency {_ms([e['latency_ms'] for e in grade_steps])}.",
        "Up to 4 grading steps run at once on the cloud backend.",
        "",
        "## Timeline",
        "",
        "| Point | Seconds after the call |",
        "|---|---|",
    ]
    lines += [f"| {label} | {sec:.1f} |" for label, sec in timeline]
    lines += [
        "",
        "## Leaks",
        "",
        "None." if not leaks else "\n".join(f"- output {i}: {kind.split(':')[0]}" for i, kind in leaks),
        "",
        "Only the invented demo data was sent to OpenRouter. On the shipping backend (llama_server) the "
        "same calls go to Glimmer on the device.",
        "",
    ]
    raw = report.parent / "raw" / f"{report.stem}.jsonl"
    lines.insert(-1, f"Raw rows: raw/{raw.name} next to this report (call kinds, models, latencies, tokens and "
                     "job times; no text).")
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text("\n".join(lines))
    write_raw(raw, calls, timeline, job)


def write_raw(path: Path, calls, timeline, job) -> None:
    """Every number the report quotes, as rows with no content, so it can be checked later."""
    keep = ("kind", "role", "model", "latency_ms", "prompt_tokens", "completion_tokens", "reasoning_tokens")
    rows = [{"type": "call", **{k: c.get(k) for k in keep}} for c in calls]
    rows += [{"type": "timeline", "point": label, "seconds": round(sec, 3)} for label, sec in timeline]
    rows.append({"type": "job", "created_at": job["created_at"], "finished_at": job["finished_at"],
                 "steps": [{k: e.get(k) for k in ("step", "model", "via", "latency_ms")} for e in job["model_log"]]})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))
