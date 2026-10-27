import sqlite3
import stat
import threading

import pytest

from base.workspace.jobs import JobStore


@pytest.fixture
def store(tmp_path):
    return JobStore(tmp_path / "home" / "base.db")


def test_create_and_status_transitions(store):
    job_id = store.create("private_task", "Grade [Student A]", "essays")
    job = store.get(job_id)
    assert job["status"] == "queued" and job["release_status"] == "none"
    assert job["model_log"] == [] and job["topics"] == [] and job["finished_at"] is None

    store.start(job_id)
    assert store.get(job_id)["status"] == "running"

    store.finish(job_id, "| raw |", "per_student", summary="averages", topics=["grades", "writing"])
    job = store.get(job_id)
    assert job["status"] == "done"
    assert job["raw_result"] == "| raw |" and job["summary"] == "averages"
    assert job["result_kind"] == "per_student" and job["topics"] == ["grades", "writing"]
    assert job["finished_at"] >= job["created_at"]


def test_fail_records_reason(store):
    job_id = store.create("private_task", "x", None)
    store.start(job_id)
    store.fail(job_id, "That folder is outside the workspace.")
    job = store.get(job_id)
    assert job["status"] == "failed" and job["error"] == "That folder is outside the workspace."
    assert job["finished_at"] is not None


def test_bad_status_and_unknown_job(store):
    job_id = store.create("private_task", "x", None)
    with pytest.raises(ValueError):
        store.set_status(job_id, "exploded")
    with pytest.raises(ValueError):
        store.set_release(job_id, "maybe")
    assert store.get("nope") is None
    with pytest.raises(KeyError):
        store.start("nope")


def test_model_log_appends_from_many_threads(store):
    job_id = store.create("private_task", "x", None)

    def add(i):
        store.add_model_step(job_id, {"step": f"grade:{i}", "latency_ms": i, "via": "local"})

    threads = [threading.Thread(target=add, args=(i,)) for i in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    log = store.get(job_id)["model_log"]
    assert sorted(e["latency_ms"] for e in log) == list(range(40))


def test_release_moves_status(store):
    job_id = store.create("private_task", "x", None)
    store.finish(job_id, "raw", "per_student")
    store.set_release(job_id, "waiting", approval_id="a1")
    job = store.get(job_id)
    assert job["status"] == "waiting_for_approval" and job["approval_id"] == "a1"
    assert job["release_status"] == "waiting" and job["released_text"] is None

    store.set_release(job_id, "shared", released_text="[Student A] scored 3")
    job = store.get(job_id)
    assert job["status"] == "done" and job["release_status"] == "shared"
    assert job["released_text"] == "[Student A] scored 3" and job["approval_id"] == "a1"

    other = store.create("private_task", "y", None)
    store.finish(other, "raw", "free_text")
    store.set_release(other, "refused", released_text="Held on your device.")
    assert store.get(other)["status"] == "refused"


def test_release_keeps_failed_status(store):
    job_id = store.create("private_task", "x", None)
    store.fail(job_id, "boom")
    store.set_release(job_id, "refused")
    assert store.get(job_id)["status"] == "failed"


def test_list_recent_newest_first(store):
    ids = [store.create("private_task", f"task {i}", None) for i in range(5)]
    recent = store.list_recent(limit=3)
    assert [j["id"] for j in recent] == ids[::-1][:3]
    assert len(store.list_recent()) == 5


def test_db_file_is_private_and_reopens(tmp_path):
    path = tmp_path / "home" / "base.db"
    job_id = JobStore(path).create("private_task", "x", None)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert JobStore(path).get(job_id)["instructions"] == "x"


def test_adds_missing_columns_to_an_older_table(tmp_path):
    path = tmp_path / "base.db"
    db = sqlite3.connect(path)
    db.execute(
        "CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, instructions TEXT, folder TEXT, "
        "status TEXT NOT NULL, created_at REAL NOT NULL)"
    )
    db.commit()
    db.close()
    store = JobStore(path)
    job_id = store.create("private_task", "x", None)
    store.finish(job_id, "raw", "free_text", topics=["grades"])
    store.set_release(job_id, "shared", released_text="ok")
    assert store.get(job_id)["topics"] == ["grades"]
