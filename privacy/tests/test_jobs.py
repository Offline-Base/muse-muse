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
    store.set_release(job_id, "waiting", approval_id=7)
    job = store.get(job_id)
    assert job["status"] == "waiting_for_approval" and job["approval_id"] == 7
    assert job["release_status"] == "waiting" and job["released_text"] is None

    store.set_release(job_id, "shared", released_text="[Student A] scored 3")
    job = store.get(job_id)
    assert job["status"] == "done" and job["release_status"] == "shared"
    assert job["released_text"] == "[Student A] scored 3" and job["approval_id"] == 7

    other = store.create("private_task", "y", None)
    store.finish(other, "raw", "free_text")
    store.set_release(other, "refused", released_text="Held on your device.")
    assert store.get(other)["status"] == "refused"


def test_approval_id_is_an_int_even_from_an_old_text_column(tmp_path):
    db = tmp_path / "old.db"
    with sqlite3.connect(db) as conn:  # a jobs table from before approval ids were ints
        conn.execute(
            "CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, instructions TEXT, folder TEXT, "
            "status TEXT NOT NULL, created_at REAL NOT NULL, approval_id TEXT)"
        )
        conn.execute("INSERT INTO jobs VALUES ('j1', 'private_task', 'x', NULL, 'done', 0, '12')")
    store = JobStore(db)
    assert store.get("j1")["approval_id"] == 12
    store.set_release("j1", "waiting", approval_id="13")
    assert store.get("j1")["approval_id"] == 13
    with pytest.raises(ValueError):
        store.set_release("j1", "waiting", approval_id="a1")


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


def test_job_for_result_keeps_one_release_per_identical_result(store):
    args = ("search", "evidence", "1. raw snippet", "snippet")
    first = store.job_for_result(*args)
    job = store.get(first)
    assert job["kind"] == "search" and job["status"] == "done" and job["release_status"] == "none"
    assert job["instructions"] == "evidence" and job["raw_result"] == "1. raw snippet"
    assert job["result_kind"] == "snippet" and job["finished_at"] == job["created_at"]
    assert store.active_count() == 0  # never counted against the private task limit
    # Unreleased, being released or waiting for the user: a retried call gets the same job.
    assert store.job_for_result(*args) == first
    assert store.claim_release(first)
    assert store.job_for_result(*args) == first
    store.set_release(first, "waiting", approval_id=4)
    assert store.job_for_result(*args) == first
    # A different request, result or kind is its own job.
    others = {
        store.job_for_result("search", "evidence\nPurpose: for the family newsletter", "1. raw snippet", "snippet"),
        store.job_for_result("search", "evidence", "1. another snippet", "snippet"),
        store.job_for_result("private_task", "evidence", "1. raw snippet", "snippet"),
    }
    assert len(others) == 3 and first not in others
    # Once shared or refused, the same result later is a new job with its own check.
    store.set_release(first, "shared", released_text="[Student A] cites the article")
    later = store.job_for_result(*args)
    assert later != first
    store.set_release(later, "refused", released_text="Kept on your device.")
    assert store.job_for_result(*args) not in (first, later)


def test_job_for_result_from_many_threads_makes_one_job(store):
    ids = []
    threads = [
        threading.Thread(target=lambda: ids.append(store.job_for_result("search", "q", "raw", "snippet")))
        for _ in range(20)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(set(ids)) == 1 and len(store.list_recent(50)) == 1


def test_a_search_release_cut_off_by_a_restart_is_picked_up_again(store):
    job_id = store.job_for_result("search", "q", "raw", "snippet")
    assert store.claim_release(job_id)
    assert store.fail_unfinished() == 0  # a finished search is not failed, only its claim reset
    job = store.get(job_id)
    assert job["status"] == "done" and job["release_status"] == "none"
    assert store.job_for_result("search", "q", "raw", "snippet") == job_id


# sources live in the job row, so a release after a restart keeps them (GAP-5)


def test_sources_are_kept_in_the_job_row_across_a_new_store(tmp_path):
    path = tmp_path / "base.db"
    store = JobStore(path)
    search = store.job_for_result("search", "q", "raw", "snippet", sources=["forms/trip.png", "essays/a.md"])
    asked = store.create("ask", "q", None)
    store.finish(asked, "Answer: raw", "snippet", sources=["essays/b.md"])
    plain = store.create("private_task", "x", "essays")
    store.finish(plain, "raw", "free_text")
    again = JobStore(path)  # the next process after a restart
    assert again.get(search)["sources"] == ["forms/trip.png", "essays/a.md"]
    assert again.get(asked)["sources"] == ["essays/b.md"]
    assert again.get(plain)["sources"] == []


def test_a_job_from_before_the_sources_column_gets_them_when_the_search_repeats(tmp_path):
    path = tmp_path / "base.db"
    store = JobStore(path)
    job_id = store.job_for_result("search", "q", "raw", "snippet")
    assert store.get(job_id)["sources"] == []
    assert store.job_for_result("search", "q", "raw", "snippet", sources=["essays/a.md"]) == job_id
    assert store.get(job_id)["sources"] == ["essays/a.md"]
    # known sources are never replaced by a later call
    assert store.job_for_result("search", "q", "raw", "snippet", sources=["other.md"]) == job_id
    assert store.get(job_id)["sources"] == ["essays/a.md"]
