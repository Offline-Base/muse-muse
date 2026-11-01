import json
import os
import shutil
import stat
import threading
import time
from pathlib import Path

import httpx
import pytest
import respx

from base import events
from base.config import load_settings
from base.types import Person, Roster
from base.workspace.agent import GRADE_SCHEMA, Agent, clean_grade, scrub_names, short_error, student_name
from base.workspace.index import Doc, DocumentIndex
from base.workspace.jobs import JobStore
from tests.synthetic_helpers import mark_synthetic

FIXTURE = Path(__file__).parent / "fixtures" / "workspace"
NAMES = ["Tavi Brennick", "Odalys Fenwright", "Corwin Ashgrove"]
GRADE_TASK = "Grade each essay with the rubric and write feedback for every student."

# keyword in the essay -> (scores, next step). Tavi's next step uses the first name on purpose.
GRADES = {
    "garden": (
        {"ideas": 4, "organization": 4, "evidence": 3, "conventions": 4},
        "Tavi, add one fact about soil.",
    ),
    "salamanders": (
        {"ideas": 3, "organization": 2, "evidence": 3, "conventions": 2},
        "Add a closing sentence.",
    ),
    "lighthouse": (
        {"ideas": 3, "organization": 3, "evidence": 2, "conventions": 4},
        "Add a closing sentence.",
    ),
}


def essay_part(messages):
    return messages[-1]["content"].split("Essay:\n", 1)[1]


def fake_grade(messages, scores_override=None):
    essay = essay_part(messages)
    for word, (scores, next_step) in GRADES.items():
        if word in essay:
            return {
                "scores": dict(scores_override or scores),
                "total": 99,
                "strengths": f"Strong {word} details.",
                "next_step": next_step,
                "feedback": f"You wrote a lively piece about the {word}.",
            }
    raise AssertionError("unknown essay")


class FakeLLM:
    def __init__(self, grade=fake_grade, gate=None):
        self.calls = []
        self.grade = grade
        self.gate = gate
        self._lock = threading.Lock()

    def chat_json(self, messages, schema, **kw):
        assert isinstance(kw.get("synthetic"), bool)
        assert kw.get("max_tokens", 0) >= 1500
        with self._lock:
            self.calls.append((messages, schema, kw))
        if self.gate is not None:
            assert self.gate.wait(10)
        if schema is GRADE_SCHEMA:
            return self.grade(messages)
        user = messages[-1]["content"]
        if "Answers per document" in user:
            return {"answer": "Combined: garden, creek, lighthouse."}
        return {"answer": f"Notes for {user.split('Document: ', 1)[1].splitlines()[0]}"}


class FakeHeavy:
    model = "glimmer-laptop-q4"
    device = "laptop"

    def __init__(self, result=True):
        self.result = result
        self.calls = []

    def run(self, kind, messages, schema, *, synthetic=False):
        self.calls.append((kind, schema, synthetic))
        return fake_grade(messages) if self.result else None


def make_settings(tmp_path, root, backend="openrouter"):
    return load_settings(
        {
            "BASE_HOME": str(tmp_path / "home"),
            "GLIMMER_BACKEND": backend,
            "OPENROUTER_API_KEY": "test-key",
            "WORKSPACE_ROOT": str(root),
        }
    )


TEACHER = Person("Imogen Larkspur", "Imogen", "Larkspur", role="teacher")
ROSTER = Roster(TEACHER, tuple(Person(n, *n.split()) for n in NAMES))


def make_agent(tmp_path, root=FIXTURE, backend="openrouter", llm=None, **kw):
    kw.setdefault("roster", ROSTER)  # Services always passes one; names in results need it
    settings = make_settings(tmp_path, root, backend)
    jobs = JobStore(settings.paths.db)
    agent = Agent(settings, llm or FakeLLM(), DocumentIndex(settings), jobs, **kw)
    return agent, settings, jobs


def tree(path: Path) -> dict[str, int]:
    return {str(p.relative_to(path)): p.stat().st_mtime_ns for p in sorted(path.rglob("*"))}


def test_grading_writes_three_feedback_files_only_in_output(tmp_path):
    before = tree(FIXTURE)
    agent, settings, jobs = make_agent(tmp_path)
    job_id = agent.run_sync(GRADE_TASK, "essays")
    job = jobs.get(job_id)
    assert job["status"] == "done", job["error"]
    assert job["kind"] == "grading" and job["result_kind"] == "per_student"
    assert job["topics"] == ["grades", "writing"]

    out = settings.paths.output / job_id
    assert sorted(p.name for p in out.iterdir()) == sorted(f"{n} feedback.md" for n in NAMES)
    assert stat.S_IMODE(out.stat().st_mode) == 0o700
    for p in out.iterdir():
        assert stat.S_IMODE(p.stat().st_mode) == 0o600
    tavi = (out / "Tavi Brennick feedback.md").read_text()
    assert "# Feedback for Tavi Brennick" in tavi
    assert "| Ideas | 4 |" in tavi and "| Total | 15 out of 16 |" in tavi
    assert "lively piece about the garden" in tavi

    # nothing else was written anywhere: not in the workspace, not elsewhere under the temp dir
    assert tree(FIXTURE) == before
    written = {p for p in tmp_path.rglob("*") if p.is_file() and p.name != "base.db"}
    assert written == set(out.iterdir())


def test_raw_result_has_names_and_summary_does_not(tmp_path):
    agent, _, jobs = make_agent(tmp_path)
    job = jobs.get(agent.run_sync(GRADE_TASK, "essays"))
    raw, summary = job["raw_result"], job["summary"]
    for name in NAMES:
        assert f"| {name} |" in raw
    assert "| Tavi Brennick | 4 | 4 | 3 | 4 | 15 |" in raw
    assert "- Odalys Fenwright: Add a closing sentence." in raw
    for name in NAMES:
        for part in [name, *name.split()]:
            assert part.lower() not in summary.lower()
    assert "| Ideas | 3.3 | 0 | 0 | 2 | 1 |" in summary
    assert "Average total: 12.3 out of 16 (lowest 10, highest 15)." in summary
    assert "- Add a closing sentence. (2 of 3 essays)" in summary
    assert "the student, add one fact about soil." in summary


def test_scores_are_clamped_and_total_recomputed(tmp_path):
    def wild(messages):
        return fake_grade(messages, {"ideas": 7, "organization": "0", "evidence": 2.6, "conventions": "3"})

    agent, settings, jobs = make_agent(tmp_path, llm=FakeLLM(grade=wild))
    job = jobs.get(agent.run_sync(GRADE_TASK, "essays"))
    assert job["status"] == "done"
    assert "| Corwin Ashgrove | 4 | 1 | 3 | 3 | 11 |" in job["raw_result"]
    assert (
        clean_grade({"scores": {"ideas": 1, "organization": 2, "evidence": 3, "conventions": 4}})["total"]
        == 10
    )


def test_bad_grade_retries_once_then_fails_without_text(tmp_path):
    def broken(messages):
        return {"scores": {"ideas": "lots"}, "feedback": essay_part(messages)}

    llm = FakeLLM(grade=broken)
    agent, settings, jobs = make_agent(tmp_path, backend="llama_server", llm=llm)
    job = jobs.get(agent.run_sync(GRADE_TASK, "essays"))
    assert job["status"] == "failed"
    assert job["error"] == "A grading step returned a score that is not a number."
    assert len(llm.calls) == 2  # one essay, two attempts, then the job stops
    assert not (settings.paths.output / job["id"]).exists()


def test_errors_never_carry_document_text(tmp_path):
    class Leaky(FakeLLM):
        def chat_json(self, messages, schema, **kw):
            raise ValueError(messages[-1]["content"])

    agent, _, jobs = make_agent(tmp_path, llm=Leaky())
    job = jobs.get(agent.run_sync(GRADE_TASK, "essays"))
    assert job["status"] == "failed"
    assert job["error"] == "The job stopped with an error (ValueError)."
    assert (
        short_error(FileNotFoundError("/home/someone/x"))
        == "That folder or document is not in the workspace."
    )


def test_heavy_hook_used_when_it_returns_a_grade(tmp_path):
    llm, heavy = FakeLLM(), FakeHeavy(result=True)
    agent, _, jobs = make_agent(tmp_path, llm=llm, heavy=heavy)
    job = jobs.get(agent.run_sync(GRADE_TASK, "essays"))
    assert job["status"] == "done"
    assert llm.calls == []
    assert heavy.calls == [("grade", GRADE_SCHEMA, True)] * 3
    log = job["model_log"]
    assert len(log) == 3 and {e["via"] for e in log} == {"heavy"}
    assert {e["model"] for e in log} == {"glimmer-laptop-q4"}


def test_heavy_hook_skipped_when_it_returns_none(tmp_path):
    llm, heavy = FakeLLM(), FakeHeavy(result=False)
    agent, settings, jobs = make_agent(tmp_path, llm=llm, heavy=heavy)
    job = jobs.get(agent.run_sync(GRADE_TASK, "essays"))
    assert job["status"] == "done"
    assert len(heavy.calls) == 3 and len(llm.calls) == 3
    assert {kw["synthetic"] for _, _, kw in llm.calls} == {True}
    log = job["model_log"]
    assert {e["via"] for e in log} == {"local"}
    assert sorted(e["step"] for e in log) == ["grade:1", "grade:2", "grade:3"]
    for e in log:
        assert set(e) == {"step", "model", "backend", "device", "latency_ms", "via"}
        assert (
            e["model"] == settings.answer_model and e["backend"] == "openrouter" and e["device"] == "laptop"
        )


def test_generic_path_maps_then_reduces(tmp_path):
    llm = FakeLLM()
    agent, settings, jobs = make_agent(tmp_path, llm=llm)
    job = jobs.get(agent.run_sync("List the animals and places each piece mentions.", "essays"))
    assert job["status"] == "done"
    assert job["kind"] == "generic" and job["result_kind"] == "free_text"
    assert job["raw_result"] == "Combined: garden, creek, lighthouse."
    assert job["summary"] is None and job["topics"] == []
    steps = sorted(e["step"] for e in job["model_log"])
    assert steps == ["map:1", "map:2", "map:3", "map:4", "reduce"]
    assert all(schema is not GRADE_SCHEMA for _, schema, _ in llm.calls)
    out = settings.paths.output / job["id"]  # the full answer is saved on the device, and only that
    assert [p.name for p in out.iterdir()] == ["result.md"]


def test_generic_task_saves_its_full_named_result_on_the_device(tmp_path):
    root = tmp_path / "root"
    (root / "plans").mkdir(parents=True)
    (root / "plans" / "plan.md").write_text("# Tavi Brennick garden plan\nTavi will plant beans by the fence.")
    mark_synthetic(root)
    agent, settings, jobs = make_agent(tmp_path, root=root)
    job = jobs.get(agent.run_sync("Summarize the plan for my own planning.", "plans"))
    assert job["status"] == "done", job["error"]
    assert job["raw_result"] == "Notes for Tavi Brennick garden plan"  # restored on the device
    out = settings.paths.output / job["id"]
    saved = out / "result.md"
    text = saved.read_text()
    assert "Tavi Brennick" in text and "Task: Summarize the plan for my own planning." in text
    assert job["raw_result"] in text
    assert stat.S_IMODE(saved.stat().st_mode) == 0o600 and stat.S_IMODE(out.stat().st_mode) == 0o700
    assert not list(root.rglob("result.md"))  # nothing is written in the workspace
    model_input = " ".join(m["content"] for messages, _, _ in agent.llm.calls for m in messages)
    assert "Tavi Brennick" not in model_input  # the model still saw only tags


def test_single_document_skips_reduce(tmp_path):
    root = tmp_path / "root"
    (root / "one").mkdir(parents=True)
    (root / "one" / "plan.md").write_text("# Plan\nField trip on Friday.")
    mark_synthetic(root)
    agent, _, jobs = make_agent(tmp_path, root=root)
    job = jobs.get(agent.run_sync("Summarize this.", "one"))
    assert job["raw_result"] == "Notes for Plan"
    assert [e["step"] for e in job["model_log"]] == ["map:1"]


def test_rubric_without_grading_words_and_grading_words_without_rubric(tmp_path):
    agent, _, jobs = make_agent(tmp_path)
    assert jobs.get(agent.run_sync("Which essay is about animals?", "essays"))["kind"] == "generic"

    root = tmp_path / "root"
    shutil.copytree(FIXTURE, root)
    (root / "essays" / "rubric.md").unlink()
    agent2, _, jobs2 = make_agent(tmp_path / "second", root=root)
    job = jobs2.get(agent2.run_sync(GRADE_TASK, "essays"))
    assert job["kind"] == "generic" and job["result_kind"] == "free_text"


def test_rubric_in_a_parent_folder_is_used(tmp_path):
    root = tmp_path / "root"
    shutil.copytree(FIXTURE, root)
    (root / "essays" / "rubric.md").rename(root / "rubric.md")
    mark_synthetic(root)  # the moved rubric is a new path for the manifest
    before = tree(root)
    agent, settings, jobs = make_agent(tmp_path / "second", root=root)
    job_id = agent.run_sync(GRADE_TASK, "essays")
    job = jobs.get(job_id)
    assert job["status"] == "done", job["error"]
    assert job["kind"] == "grading" and job["result_kind"] == "per_student"
    assert sorted(p.name for p in (settings.paths.output / job_id).iterdir()) == sorted(
        f"{n} feedback.md" for n in NAMES
    )  # the rubric one level up is not graded as an essay
    assert tree(root) == before


def test_no_rubric_above_the_workspace_root_is_used(tmp_path):
    outer = tmp_path / "outer"
    shutil.copytree(FIXTURE, outer / "root")
    (outer / "root" / "essays" / "rubric.md").rename(outer / "rubric.md")  # outside the root
    agent, _, jobs = make_agent(tmp_path / "second", root=outer / "root")
    assert jobs.get(agent.run_sync(GRADE_TASK, "essays"))["kind"] == "generic"


def test_path_traversal_fails_the_job(tmp_path):
    llm = FakeLLM()
    agent, _, jobs = make_agent(tmp_path, llm=llm)
    for bad in ("../", "/etc", "essays/../../.."):
        job = jobs.get(agent.run_sync(GRADE_TASK, bad))
        assert job["status"] == "failed" and job["error"] == "That folder is outside the workspace."
    assert llm.calls == []


def test_cloud_backend_refuses_unmarked_folder(tmp_path):
    root = tmp_path / "private"
    shutil.copytree(FIXTURE / "essays", root / "essays")
    assert not (root / ".synthetic").exists()
    llm = FakeLLM()
    agent, settings, jobs = make_agent(tmp_path, root=root, llm=llm)
    job = jobs.get(agent.run_sync(GRADE_TASK, "essays"))
    assert job["status"] == "failed"
    assert "not" in job["error"] and ".synthetic" in job["error"]
    assert llm.calls == []
    assert not settings.paths.output.exists() or not any(settings.paths.output.iterdir())

    # on the device's own Glimmer any folder is fine, but the calls are not marked synthetic,
    # so a laptop worker on a cloud backend would never take them
    local_llm, heavy = FakeLLM(), FakeHeavy(result=False)
    local, _, local_jobs = make_agent(
        tmp_path / "local", root=root, backend="llama_server", llm=local_llm, heavy=heavy
    )
    assert local_jobs.get(local.run_sync(GRADE_TASK, "essays"))["status"] == "done"
    assert {kw["synthetic"] for _, _, kw in local_llm.calls} == {False}
    assert {synthetic for _, _, synthetic in heavy.calls} == {False}


def test_tags_in_instructions_are_restored(tmp_path):
    seen = []

    def restore(text, tag_map):
        seen.append(tag_map)
        for tag, real in tag_map.items():
            text = text.replace(tag, real)
        return text

    llm = FakeLLM()
    agent, _, jobs = make_agent(
        tmp_path, llm=llm, tagmap={"[Student A]": "Tavi Brennick"}, restore=restore, roster=None
    )
    job = jobs.get(agent.run_sync("Which piece did [Student A] write?", "essays"))
    assert seen and seen[0] == {"[Student A]": "Tavi Brennick"}  # restored locally
    # Review F4: the model sees the tag, never the real name, in the instructions and documents.
    assert all("Tavi Brennick" not in msgs[-1]["content"] for msgs, _, _ in llm.calls)
    assert all("[Student A]" in msgs[-1]["content"] for msgs, _, _ in llm.calls)
    assert job["instructions"] == "Which piece did [Student A] write?"


def test_model_never_sees_roster_names_and_files_keep_them(tmp_path):
    from base.guard import TagMap

    def echo(messages):
        out = fake_grade(messages)
        out["feedback"] = "Well done, [Student A]." if "[Student A]" in essay_part(messages) else out["feedback"]
        return out

    llm = FakeLLM(grade=echo)
    tagmap = TagMap(None, seed=5)
    agent, settings, jobs = make_agent(tmp_path, llm=llm, tagmap=tagmap)
    job = jobs.get(agent.run_sync("Grade each essay. Spell [Student A] backwards in the feedback.", "essays"))
    assert job["status"] == "done", job["error"]
    for msgs, _, _ in llm.calls:
        for name in NAMES:
            assert name not in msgs[-1]["content"] and name.split()[0] not in msgs[-1]["content"]
    files = "".join(p.read_text() for p in (settings.paths.output / job["id"]).iterdir())
    real_a = tagmap.get("[Student A]")
    assert real_a in NAMES and "[Student " not in files


def test_students_not_on_the_roster_are_essay_n_in_the_result(tmp_path):
    # Review F5: a file-stem name the roster does not know cannot be tagged, so it never goes in.
    roster = Roster(TEACHER, (Person("Tavi Brennick", "Tavi", "Brennick"),))
    agent, settings, jobs = make_agent(tmp_path, roster=roster)
    job = jobs.get(agent.run_sync(GRADE_TASK, "essays"))
    raw = job["raw_result"]
    assert "| Tavi Brennick |" in raw
    assert "Corwin" not in raw and "Odalys" not in raw and "corwin" not in raw.lower()
    assert raw.count("| Essay ") == 2
    files = sorted(p.name for p in (settings.paths.output / job["id"]).iterdir())
    assert "Corwin Ashgrove feedback.md" in files  # the real name stays on the device


def test_too_many_tasks_are_refused(tmp_path):
    from base.workspace.agent import MAX_ACTIVE_JOBS, AgentBusy

    gate = threading.Event()
    agent, _, jobs = make_agent(tmp_path, llm=FakeLLM(gate=gate))
    try:
        ids = [agent.run_private_task(GRADE_TASK, "essays") for _ in range(MAX_ACTIVE_JOBS)]
        with pytest.raises(AgentBusy):
            agent.run_private_task(GRADE_TASK, "essays")
        assert jobs.active_count() == MAX_ACTIVE_JOBS
    finally:
        gate.set()
    deadline = time.monotonic() + 10
    while any(jobs.get(i)["status"] in ("queued", "running") for i in ids) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert jobs.active_count() == 0


def test_stop_ends_queued_steps_without_model_calls(tmp_path):
    llm = FakeLLM()
    agent, _, jobs = make_agent(tmp_path, llm=llm)
    agent.stop()
    job = jobs.get(agent.run_sync(GRADE_TASK, "essays"))
    assert job["status"] == "failed" and llm.calls == []
    assert "stopped" in job["error"]


def test_roster_nicknames_are_scrubbed_from_summary(tmp_path):
    teacher = Person("Imogen Larkspur", "Imogen", "Larkspur", role="teacher")
    roster = Roster(teacher, (Person("Odalys Fenwright", "Odalys", "Fenwright", nicknames=("Oda",)),))

    def nick(messages):
        out = fake_grade(messages)
        out["next_step"] = out["next_step"].replace("Add", "Oda, add")
        return out

    agent, settings, jobs = make_agent(tmp_path, llm=FakeLLM(grade=nick), roster=roster)
    job = jobs.get(agent.run_sync(GRADE_TASK, "essays"))
    assert (settings.paths.output / job["id"] / "Odalys Fenwright feedback.md").is_file()
    assert "Oda" not in job["summary"]
    assert scrub_names("Tavi's opening", ["Tavi"]) == "the student's opening"


def test_background_job_status_and_events(tmp_path):
    gate = threading.Event()
    seen = []
    unsubscribe = events.subscribe(lambda e: seen.append((e.state, e.detail)))
    try:
        agent, _, jobs = make_agent(tmp_path, llm=FakeLLM(gate=gate))
        started = time.monotonic()
        job_id = agent.run_private_task(GRADE_TASK, "essays")
        assert time.monotonic() - started < 1
        assert jobs.get(job_id)["status"] in ("queued", "running")
        deadline = time.monotonic() + 5
        while jobs.get(job_id)["status"] != "running" and time.monotonic() < deadline:
            time.sleep(0.01)
        assert jobs.get(job_id)["status"] == "running"
        assert ("working", job_id) in seen
        gate.set()
        deadline = time.monotonic() + 10
        while jobs.get(job_id)["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.01)
        assert jobs.get(job_id)["status"] == "done"
        deadline = time.monotonic() + 5
        while ("idle", job_id) not in seen and time.monotonic() < deadline:
            time.sleep(0.01)
        assert seen.index(("working", job_id)) < seen.index(("idle", job_id))
    finally:
        gate.set()
        unsubscribe()


def test_heavy_errors_fall_back_to_local(tmp_path):
    class Broken(FakeHeavy):
        def run(self, kind, messages, schema, *, synthetic=False):
            raise ConnectionError("worker went away")

    llm = FakeLLM()
    agent, _, jobs = make_agent(tmp_path, llm=llm, heavy=Broken())
    job = jobs.get(agent.run_sync(GRADE_TASK, "essays"))
    assert job["status"] == "done" and len(llm.calls) == 3
    assert {e["via"] for e in job["model_log"]} == {"local"}


def test_worker_count_follows_backend(tmp_path):
    cloud, _, _ = make_agent(tmp_path)
    local, _, _ = make_agent(tmp_path / "local", backend="llama_server")
    assert cloud._workers() == 4 and local._workers() == 1


def test_feedback_file_never_follows_a_symlink(tmp_path):
    from base.workspace.agent import write_private

    target = tmp_path / "elsewhere.md"
    target.write_text("keep")
    link = tmp_path / "link.md"
    os.symlink(target, link)
    with pytest.raises(OSError):
        write_private(link, "overwrite")
    assert target.read_text() == "keep"


def test_with_the_real_client_and_mocked_openrouter(tmp_path):
    """The agent's calls fit LocalLLM: strict schema, synthetic flag, reasoning and token budget."""
    local_llm = pytest.importorskip("base.local_llm")
    settings = make_settings(tmp_path, FIXTURE)
    bodies = []

    def reply(request):
        body = json.loads(request.content)
        bodies.append(body)
        grade = fake_grade(body["messages"])
        return httpx.Response(
            200, json={"model": body["model"], "choices": [{"message": {"content": json.dumps(grade)}}]}
        )

    with respx.mock(assert_all_called=True) as mock:
        mock.post(f"{settings.answer_url}/chat/completions").mock(side_effect=reply)
        jobs = JobStore(settings.paths.db)
        agent = Agent(settings, local_llm.LocalLLM(settings), DocumentIndex(settings), jobs)
        job = jobs.get(agent.run_sync(GRADE_TASK, "essays"))
    assert job["status"] == "done", job["error"]
    assert len(bodies) == 3
    for body in bodies:
        assert body["response_format"]["json_schema"]["schema"] == GRADE_SCHEMA
        assert body["max_tokens"] >= 1500 and body["reasoning"] == {"effort": "low"}


@pytest.mark.integration
def test_grades_the_fixture_with_real_glimmer(tmp_path):
    """Calls the configured Glimmer backend on the invented fixture essays (RUN_INTEGRATION=1)."""
    from base.local_llm import LocalLLM

    settings = load_settings({"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(FIXTURE)})
    jobs = JobStore(settings.paths.db)
    agent = Agent(settings, LocalLLM(settings), DocumentIndex(settings), jobs)
    job = jobs.get(agent.run_sync(GRADE_TASK, "essays"))
    assert job["status"] == "done", job["error"]
    assert len(list((settings.paths.output / job["id"]).iterdir())) == 3
    for name in NAMES:
        assert name not in job["summary"]


def test_student_name_matches_hyphenated_and_apostrophe_roster_names():
    roster = Roster(
        teacher=Person("Wilhelmina Quarry", "Wilhelmina", "Quarry", role="teacher"),
        students=(Person("Odalys Brenn-Halloway", "Odalys", "Brenn-Halloway"), Person("Ciaran O'Dell", "Ciaran", "O'Dell")),
    )
    for stem, want in (("Odalys Brenn-Halloway", "Odalys Brenn-Halloway"), ("ciaran_o'dell_essay", "Ciaran O'Dell")):
        doc = Doc(id=f"essays/{stem}.md", path=f"essays/{stem}.md", title=stem, size=1, modified=0)
        assert student_name(doc, "# An essay\n\nText.", roster, 1) == want
