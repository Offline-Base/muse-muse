import sqlite3
import threading

import pytest

from base.approvals import ApprovalStore, label_for, today


@pytest.fixture
def store(tmp_path):
    s = ApprovalStore(tmp_path / "home" / "base.db")
    yield s
    s.close()


def fields(**kw):
    base = {
        "tool": "get_result",
        "request": "Grade the essays for [Student A]",
        "result_kind": "per_student",
        "tagged_text": "[Student A]: 3 of 4",
        "router_decision": "ask_user",
        "router_reason": "Per-student scores.",
        "router_source": "model",
        "topics": ["grades"],
    }
    base.update(kw)
    return base


def test_wal_mode(store):
    mode = store._conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode == "wal"


def test_record_auto(store):
    rid = store.record_auto(**fields(router_decision="share_tagged", job_id="j1", item_id="t001", day=3))
    row = store.get(rid)
    assert row["status"] == "auto"
    assert row["router_decision"] == "share_tagged"
    assert row["topics"] == ["grades"]
    assert row["shown_form"] == "share_tagged"
    assert row["job_id"] == "j1"
    assert row["item_id"] == "t001"
    assert row["day"] == 3
    assert row["remember"] is False and row["deleted"] is False
    assert store.pending() == []


def test_shown_form_defaults_from_kind(store):
    rid = store.create_pending(**fields(result_kind="class_aggregate"))
    assert store.get(rid)["shown_form"] == "share_summary"


def test_default_day_is_today(store):
    rid = store.record_auto(**fields(router_decision="refuse"))
    assert store.get(rid)["day"] == today()


def test_pending_lifecycle(store):
    a = store.create_pending(**fields())
    b = store.create_pending(**fields(request="second"))
    assert [r["id"] for r in store.pending()] == [a, b]

    row = store.decide(a, approve=True, remember=True)
    assert row["status"] == "approved"
    assert row["user_decision"] == "approve"
    assert row["remember"] is True
    assert row["decided_by"] == "user"
    assert row["decided_at"] is not None
    assert [r["id"] for r in store.pending()] == [b]

    row = store.decide(b, approve=False, by="policy_sim")
    assert row["status"] == "denied"
    assert row["user_decision"] == "deny"
    assert row["remember"] is False
    assert row["decided_by"] == "policy_sim"
    assert store.pending() == []


def test_decide_errors(store):
    with pytest.raises(KeyError):
        store.decide(999, approve=True)
    auto = store.record_auto(**fields(router_decision="share_tagged"))
    with pytest.raises(ValueError, match="not pending"):
        store.decide(auto, approve=True)
    pid = store.create_pending(**fields())
    store.decide(pid, approve=True)
    with pytest.raises(ValueError, match="not pending"):
        store.decide(pid, approve=False)
    with pytest.raises(ValueError, match="decided_by"):
        store.decide(store.create_pending(**fields()), approve=True, by="muse")


def test_delete_blanks_text_and_hides_row(store):
    pid = store.create_pending(**fields())
    store.decide(pid, approve=True, remember=True)
    keep = store.create_pending(**fields(request="keep me"))
    store.decide(keep, approve=False, remember=True)
    assert len(store.training_rows()) == 2

    assert store.delete(pid) is True
    row = store.get(pid)
    assert row["deleted"] is True
    assert row["request"] == ""
    assert row["tagged_text"] == ""
    assert [r["id"] for r in store.training_rows()] == [keep]
    assert pid not in [r["id"] for r in store.history()]
    assert store.delete(12345) is False


def test_deleted_pending_cannot_be_decided(store):
    pid = store.create_pending(**fields())
    store.delete(pid)
    assert store.pending() == []
    with pytest.raises(ValueError, match="deleted"):
        store.decide(pid, approve=True)


def test_history_newest_first_with_limit(store):
    ids = [store.record_auto(**fields(router_decision="share_tagged", request=f"r{i}")) for i in range(5)]
    assert [r["id"] for r in store.history(limit=3)] == ids[::-1][:3]


def test_training_rows_only_decided_with_labels(store):
    store.record_auto(**fields(router_decision="share_tagged"))
    store.create_pending(**fields())  # undecided
    pid = store.create_pending(**fields(result_kind="class_aggregate"))
    store.decide(pid, approve=True, remember=True)
    rows = store.training_rows()
    assert [r["id"] for r in rows] == [pid]
    assert rows[0]["label"] == "share_summary"


@pytest.mark.parametrize(
    "decision, remember, shown, expected",
    [
        ("approve", True, "share_summary", "share_summary"),
        ("approve", True, "share_tagged", "share_tagged"),
        ("deny", True, "share_tagged", "refuse"),
        ("approve", False, "share_tagged", "ask_user"),
        ("deny", False, "share_summary", "ask_user"),
    ],
)
def test_label_for(decision, remember, shown, expected):
    row = {"user_decision": decision, "remember": remember, "shown_form": shown, "result_kind": "per_student"}
    assert label_for(row) == expected


def test_label_for_undecided_and_missing_shown_form():
    assert label_for({"user_decision": None, "remember": False}) is None
    row = {"user_decision": "approve", "remember": 1, "shown_form": None, "result_kind": "class_aggregate"}
    assert label_for(row) == "share_summary"


def test_label_for_store_rows(store):
    pid = store.create_pending(**fields())
    row = store.decide(pid, approve=False, remember=True)
    assert label_for(row) == "refuse"


def test_counts_by_day(store):
    store.create_pending(**fields(day=1))
    store.create_pending(**fields(day=1))
    store.create_pending(**fields(day=2))
    decided = store.create_pending(**fields(day=2))
    store.decide(decided, approve=True)
    store.record_auto(**fields(router_decision="share_tagged", day=1))
    store.record_auto(**fields(router_decision="share_tagged", day=5))
    assert store.counts_by_day() == {1: 2, 2: 2}


def test_threads_share_one_store(store):
    errors = []

    def work(n):
        try:
            for i in range(20):
                rid = store.create_pending(**fields(request=f"t{n}-{i}"))
                store.decide(rid, approve=bool(i % 2))
        except Exception as exc:  # pragma: no cover - surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(n,)) for n in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert len(store.training_rows()) == 120


def test_reopen_keeps_rows(tmp_path):
    path = tmp_path / "base.db"
    first = ApprovalStore(path)
    rid = first.create_pending(**fields())
    first.close()
    second = ApprovalStore(path)
    assert second.get(rid)["status"] == "pending"
    second.close()


def test_blocked_reasons_round_trip_and_old_dbs_gain_the_column(tmp_path):
    db = tmp_path / "old.db"
    with sqlite3.connect(db) as conn:  # a decisions table from before the blocked column
        conn.execute(
            "CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, day INTEGER, "
            "job_id TEXT, tool TEXT, request TEXT, result_kind TEXT, topics TEXT, tagged_text TEXT, "
            "shown_form TEXT, router_decision TEXT, router_reason TEXT, router_source TEXT, "
            "status TEXT NOT NULL, user_decision TEXT, remember INTEGER NOT NULL DEFAULT 0, decided_by TEXT, "
            "decided_at REAL, deleted INTEGER NOT NULL DEFAULT 0, item_id TEXT)"
        )
        conn.execute("INSERT INTO decisions (ts, tool, status) VALUES (0, 'eval', 'auto')")
    store = ApprovalStore(db)
    assert store.get(1)["blocked"] == []
    rid = store.create_pending(
        tool="get_result", request="r", result_kind="free_text", tagged_text="[Student A] has an IEP.",
        router_decision="ask_user", blocked=["Mentions an IEP or 504 plan"],
    )  # fmt: skip
    assert store.get(rid)["blocked"] == ["Mentions an IEP or 504 plan"]
    assert store.pending()[0]["blocked"] == ["Mentions an IEP or 504 plan"]
    store.close()


# Always approve: narrowed and turned off after 8 hours (GAP-7)


class Clock:
    def __init__(self, now=1_793_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


def test_always_approve_records_when_it_was_turned_on_and_turns_itself_off(tmp_path):
    import os
    import stat

    from base.approvals import AUTO_APPROVE_HOURS, AutoApprove

    clock = Clock()
    auto = AutoApprove(tmp_path / "auto_approve", clock=clock)
    assert not auto.on and auto.until() is None and auto.seconds_left() is None
    auto.set(True)
    assert stat.S_IMODE(os.stat(auto.path).st_mode) == 0o600
    assert f"started {int(clock.now)}" in auto.path.read_text() and "on since " in auto.path.read_text()
    assert auto.on and auto.seconds_left() == AUTO_APPROVE_HOURS * 3600
    clock.now += AUTO_APPROVE_HOURS * 3600 - 1
    assert auto.on and auto.seconds_left() == 1
    clock.now += 1
    assert not auto.on and not auto.path.exists()  # off at 8 hours, and the file is gone


def test_always_approve_reads_an_older_file_by_its_stamp_or_its_time(tmp_path):
    import os
    import time

    from base.approvals import AutoApprove

    path = tmp_path / "auto_approve"
    now = time.time()
    path.write_text(time.strftime("on since %Y-%m-%d %H:%M\n", time.localtime(now - 9 * 3600)))
    assert not AutoApprove(path).on and not path.exists()  # the live app's file from before this change
    path.write_text(time.strftime("on since %Y-%m-%d %H:%M\n", time.localtime(now - 3600)))
    assert AutoApprove(path).on
    path.write_text("on\n")  # no stamp: its modified time counts
    os.utime(path, (now - 9 * 3600, now - 9 * 3600))
    assert not AutoApprove(path).on
    path.write_text(f"started {int(now + 3600)}\n")  # a time in the future makes no sense: off
    assert not AutoApprove(path).on and not path.exists()


def test_needs_a_person_lists_the_floors_always_approve_leaves():
    from base.approvals import needs_a_person

    for floor in ("request:iep", "ask_first:custody", "identifier:phone", "identifier:digits", "outside_class"):
        assert needs_a_person([floor]) and needs_a_person(["policy:x", floor])
    for floors in ([], None, ["learned:ask_user"], ["policy:class_averages"], ["contact_ok"]):
        assert not needs_a_person(floors)
