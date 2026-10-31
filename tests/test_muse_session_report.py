"""scripts/muse_session_report.py: statuses-only counts, and no text from any column ever printed.

The fixture db is built in a temp BASE_HOME with invented rows. A canary string sits in every text
column (and in relay.log), and must never reach the report.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime

import pytest

from base.approvals import ApprovalStore
from base.connector.audit import audit
from base.workspace.jobs import JobStore
from scripts import muse_session_report as report

CANARY = "CANARY Zephyrine Quoll 555-0142"
DAY = datetime(2026, 10, 31)


def at(hour: int, minute: int = 0, second: int = 0) -> float:
    return DAY.replace(hour=hour, minute=minute, second=second).timestamp()


def add_audit(db, ts, tool, outcome, ms=0, via="local"):
    conn = sqlite3.connect(db)
    with conn:
        conn.execute("INSERT INTO audit (ts, tool, outcome, ms, via) VALUES (?, ?, ?, ?, ?)", (ts, tool, outcome, ms, via))
    conn.close()


def add_decision(db, ts, *, tool="search_documents", request=CANARY, status="auto", router="share_tagged",
                 user=None, decided_at=None, decided_by=None, topics=(), blocked=()):  # fmt: skip
    conn = sqlite3.connect(db)
    with conn:
        conn.execute(
            "INSERT INTO decisions (ts, day, job_id, tool, request, result_kind, topics, blocked, tagged_text, "
            "shown_form, router_decision, router_reason, router_source, status, user_decision, decided_by, "
            "decided_at, item_id, sources, receipt) VALUES (?, 1, ?, ?, ?, 'snippet', ?, ?, ?, 'share_tagged', ?, ?, "
            "'rule', ?, ?, ?, ?, ?, ?, ?)",
            (
                ts, CANARY, tool, request, json.dumps([*topics, f"{CANARY} t{ts}"]), json.dumps([*blocked, f"{CANARY} b{ts}"]),
                CANARY, router, CANARY, status, user, decided_by, decided_at, CANARY, json.dumps([CANARY]),
                json.dumps({"note": CANARY}),
            ),
        )  # fmt: skip
    conn.close()


@pytest.fixture
def home(tmp_path):
    home = tmp_path / "home"
    db = home / "base.db"
    ApprovalStore(db).close()  # the real schemas, then invented rows with set times
    jobs = JobStore(db)
    job_id = jobs.create("private_task", CANARY, CANARY)
    jobs.finish(job_id, CANARY, "free_text", summary=CANARY, topics=[CANARY])
    jobs.set_release(job_id, "shared", released_text=CANARY)
    audit(db, "list_documents", "shared")  # creates the table; this row is outside the window
    conn = sqlite3.connect(db)
    with conn:
        conn.execute("UPDATE audit SET ts = ?", (at(8),))
    conn.close()

    add_audit(db, at(9, 1), "initialize", "muse_connector", via="relay")
    add_audit(db, at(9, 2), "list_documents", "shared", 100, "relay")
    add_audit(db, at(9, 3), "list_documents", "shared", 300, "relay")
    add_audit(db, at(9, 4), "search_documents", "refused", 6000)
    add_audit(db, at(9, 30), "get_result", "shared", 40)
    add_audit(db, at(10, 0), CANARY, CANARY, 5, CANARY)  # not labels: never printed
    add_audit(db, at(2, 0), "run_dreaming", "started")  # before the window
    add_audit(db, at(11, 15), "run_dreaming", "done", 12, "relay")

    # Purpose: 2 of 3 searches and asks carry one; the task row does not count.
    add_decision(db, at(9, 4), request=f"{CANARY}\nPurpose: for my own grading", status="auto", router="refuse",
                 topics=["iep"])  # fmt: skip
    add_decision(db, at(9, 9), tool="ask_device", request=f"{CANARY}\nPurpose: for me", topics=["iep"])  # a re-ask
    add_decision(db, at(9, 25), request=CANARY, topics=["iep"])  # 21 min later: not a re-ask
    add_decision(db, at(9, 10), tool="get_result", status="approved", user="approve", decided_at=at(9, 27),
                 decided_by="user", topics=["grades"])  # fmt: skip
    add_decision(db, at(9, 12), tool="get_result", status="denied", user="deny", decided_at=at(9, 40),
                 decided_by="user", blocked=["Mentions IEP"])  # fmt: skip
    add_decision(db, at(9, 50), tool="get_result", status="pending")

    logs = home / "logs"
    logs.mkdir()
    (logs / "relay.log").write_text(
        f"2026-10-31 09:02:00,123 INFO request f-1 POST -> 200 in 5100 ms\n"
        f"2026-10-31 09:04:00,123 INFO request f-2 POST -> 200 in 6700 ms\n"
        f"2026-10-31 09:05:00,123 INFO request {CANARY} POST -> 504 in 55000 ms\n"
        f"2026-10-31 07:00:00,123 INFO request f-0 POST -> 503 in 1 ms\n"
        f"{CANARY} -> 999\n"
    )
    return home


def run(home, tmp_path, *extra):
    out = tmp_path / "out"
    argv = ["--since", "2026-10-31T09:00", "--until", "2026-10-31T12:00", "--home", str(home), "--out", str(out), *extra]
    assert report.main(argv) == 0
    [path] = out.glob("*.md")
    return path, path.read_text()


def test_the_canary_never_reaches_the_report(home, tmp_path):
    path, text = run(home, tmp_path)
    assert path.name == "session_2026-10-31.md"
    for piece in (CANARY, "CANARY", "Zephyrine", "Quoll", "555-0142", "Purpose:", "iep", "IEP", "grades"):
        assert piece not in text
    assert str(home) not in text and str(tmp_path) not in text  # no home path in the command line
    assert "--home PATH" in text and "--out PATH" in text
    assert "—" not in text


def test_counts_timings_and_labels(home, tmp_path):
    _, text = run(home, tmp_path, "--label", "oct31_probe")
    assert "| list_documents | shared | 2 | 200 | 300 |" in text
    assert "| search_documents | refused | 1 | 6000 | 6000 |" in text
    assert "| unlabeled | unlabeled | 1 | 5 | 5 |" in text
    assert "| initialize |" not in text  # client names are listed apart
    assert "Through the relay: 3. Local: 2." in text and "Unlabeled: 1." in text
    assert "MCP clients (initialize): muse_connector 1." in text
    assert "with a purpose: 2 of 3." in text
    assert "asked the user: 3 (1 shared, 1 kept, 1 still waiting)" in text
    # Approved at 9:27, read at 9:30; kept at 9:40 and never read again.
    assert "read again with get_result: 1 of 2, median 3.0 min after the answer." in text
    assert "- 11:15 run_dreaming done (relay)" in text and "02:00" not in text
    assert "Forwarded requests by status: 200 2, 504 1." in text


def test_reask_detection(home, tmp_path):
    _, text = run(home, tmp_path)
    # The 9:04 refusal (topic iep) is asked again at 9:09 but not at 9:25; the 9:12 kept result
    # (blocked IEP) has no later row with that reason.
    assert "Results kept on the device (router refused or user kept): 2." in text
    assert "within 15 min with a shared topic or blocked reason: 1 of 2 refusals that had one (1 later requests)." in text


def test_reasks_unit():
    rows = [
        {"id": 1, "ts": 0.0, "status": "auto", "router_decision": "refuse", "topics": {"iep"}, "blocked": set()},
        {"id": 2, "ts": 60.0, "status": "auto", "router_decision": "share_tagged", "topics": {"iep"}, "blocked": set()},
        {"id": 3, "ts": 120.0, "status": "auto", "router_decision": "refuse", "topics": set(), "blocked": set()},
        {"id": 4, "ts": 900.0, "status": "denied", "router_decision": "ask_user", "topics": set(), "blocked": {"x"}},
        {"id": 5, "ts": 1000.0, "status": "auto", "router_decision": "share_tagged", "topics": set(), "blocked": {"x"}},
    ]
    assert report.reasks(rows) == (3, 2, 2, 2)


def test_the_db_is_opened_read_only(home, tmp_path):
    db = home / "base.db"
    before = db.read_bytes()
    run(home, tmp_path)
    assert db.read_bytes() == before
    conn = report.connect_ro(db)
    with pytest.raises(sqlite3.OperationalError):
        conn.execute("DELETE FROM audit")
    conn.close()


def test_an_old_audit_table_without_via_counts_as_local(tmp_path):
    home = tmp_path / "old"
    home.mkdir()
    conn = sqlite3.connect(home / "base.db")
    with conn:
        conn.execute("CREATE TABLE audit (ts REAL NOT NULL, tool TEXT NOT NULL, outcome TEXT NOT NULL, ms INTEGER)")
        conn.execute("INSERT INTO audit VALUES (?, 'list_documents', 'shared', 9)", (at(9, 5),))
    conn.close()
    _, text = run(home, tmp_path)
    assert "Through the relay: 0. Local: 1." in text
    assert "with a purpose: 0 of 0." in text and "No relay.log found." in text


def test_bad_label_and_missing_db(tmp_path, capsys):
    with pytest.raises(SystemExit):
        report.main(["--since", "2026-10-31T09:00", "--until", "2026-10-31T10:00", "--label", "../x", "--home", str(tmp_path)])
    assert report.main(["--since", "2026-10-31T09:00", "--until", "2026-10-31T10:00", "--home", str(tmp_path / "none")]) == 1
