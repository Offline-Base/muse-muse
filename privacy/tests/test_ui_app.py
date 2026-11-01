"""Approval page tests with a fake services namespace. All names here are invented."""

from __future__ import annotations

import dataclasses
import json
import stat
import sys
import time
from types import ModuleType, SimpleNamespace

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

import base.heavy
from base import events, ui_app
from base.ui_app import Pairing, create_app, event_stream

LOCAL = "http://127.0.0.1:8787"
LAN = "http://base-jetson.test:8787"
RAW_NAMES = ("Juniper Ashvale", "Juniper", "Ashvale", "Rowan Thistlewood", "Thistlewood")


def make_rows():
    return [
        {
            "id": 1,
            "ts": 1_790_000_000.0,
            "day": 1,
            "job_id": "job-1",
            "tool": "get_result",
            "request": "Share the rubric scores for [Student A]",
            "result_kind": "per_student",
            "topics": json.dumps(["grades"]),
            "tagged_text": "[Student A] scored 3 of 4 on evidence. Call [Phone 1] with questions.",
            "raw_text": "Juniper Ashvale scored 3 of 4 on evidence. Call 512-555-0143 with questions.",
            "raw_result": "Juniper Ashvale: 3/4",
            "tag_map": {"[Student A]": "Juniper Ashvale"},
            "shown_form": "share_tagged",
            "router_decision": "ask_user",
            "router_reason": "It has a phone number, so I asked first.",
            "router_source": "rule",
            "status": "pending",
            "user_decision": None,
            "remember": 0,
            "deleted": 0,
        },
        {
            "id": 2,
            "ts": 1_790_000_600.0,
            "day": 2,
            "job_id": "job-2",
            "tool": "get_result",
            "request": "What is on the calendar for [Student B]?",
            "result_kind": "free_text",
            "topics": ["iep", "grades"],
            "blocked": json.dumps(["Mentions an IEP or 504 plan"]),  # TagResult.blocked, as egress stores it
            "tagged_text": "[Student B] has an IEP meeting Friday.",
            "raw_text": "Rowan Thistlewood has an IEP meeting Friday.",
            "shown_form": "share_tagged",
            "router_decision": "ask_user",
            "router_reason": "Mentions an IEP, which you asked to see first.",
            "router_source": "model",
            "status": "pending",
            "user_decision": None,
            "remember": 0,
            "deleted": 0,
        },
        {
            "id": 3,
            "ts": 1_789_999_000.0,
            "day": 1,
            "job_id": None,
            "tool": "list_documents",
            "request": "List the essays folder",
            "result_kind": "document_list",
            "topics": "[]",
            "tagged_text": "[Student C] essay.md",
            "raw_text": "Juniper Ashvale essay.md",
            "shown_form": "share_tagged",
            "router_decision": "share_tagged",
            "router_reason": "A list of titles with tags.",
            "router_source": "rule",
            "status": "auto",
            "user_decision": None,
            "remember": 0,
            "deleted": 0,
        },
    ]


class FakeApprovals:
    def __init__(self, rows):
        self.rows = {r["id"]: dict(r) for r in rows}
        self.decisions = []

    def pending(self):
        return [r for r in self.rows.values() if r["status"] == "pending" and not r["deleted"]]

    def history(self, limit=50):
        return list(self.rows.values())[:limit]

    def get(self, approval_id):
        return self.rows.get(approval_id)

    def decide(self, approval_id, approve, remember=False, by="user"):
        self.decisions.append((approval_id, approve, remember, by))
        row = self.rows[approval_id]
        row.update(
            status="approved" if approve else "denied",
            user_decision="approve" if approve else "deny",
            remember=int(remember),
            decided_by=by,
        )

    def delete(self, approval_id):
        self.rows[approval_id].update(deleted=1, request="", tagged_text="")

    def counts_by_day(self):
        return {1: 6, 2: 4, 3: 2}


class FakeEgress:
    def __init__(self):
        self.resolved = []

    def resolve(self, approval_id):
        self.resolved.append(approval_id)


class FakeNight:
    def __init__(self):
        self.started = 0
        self.report = SimpleNamespace(
            learned_from=42,
            accuracy_before=0.81,
            accuracy_after=0.93,
            agreement_before=0.7,
            agreement_after=0.9,
            kept=True,
            leaks=0,
            seconds=37.2,
        )

    def last_report(self):
        return self.report

    def start(self):
        self.started += 1
        return "night-7"


def make_services(settings, **overrides):
    ns = SimpleNamespace(
        settings=settings,
        approvals=FakeApprovals(make_rows()),
        egress=FakeEgress(),
        night=FakeNight(),
        policy=SimpleNamespace(never_share={"iep": ["IEP"], "medical": ["diagnosis"]}),
    )
    for k, v in overrides.items():
        setattr(ns, k, v)
    return ns


def lan_settings(settings, **kw):
    return dataclasses.replace(settings, **{"device": "jetson", "approval_host": "0.0.0.0", "heavy_queue": False, **kw})


@pytest.fixture
def services(settings):
    return make_services(settings)


@pytest.fixture
def client(services, tmp_path):
    app = create_app(services, nights_csv=tmp_path / "no-nights.csv")
    with TestClient(app, base_url=LOCAL, headers={"Origin": LOCAL}) as c:
        yield c


@pytest.fixture
def captured_events():
    seen = []
    unsubscribe = events.subscribe(seen.append)
    yield seen
    unsubscribe()


# ---------------------------------------------------------------- pages


def test_approvals_page_shows_cards_newest_first(client):
    r = client.get("/")
    assert r.status_code == 200
    body = r.text
    assert "Muse Privacy" in body and "Private workspace on this device" in body
    assert "Share it" in body and "Keep it here" in body
    assert "Don't ask again for things like this" in body
    assert '<span class="tag">[Student A]</span>' in body
    assert '<span class="tag">[Phone 1]</span>' in body
    assert "Mentions an IEP or 504 plan" in body  # blocked reason chip from the row's blocked list
    assert "Mentions grades" not in body  # topics alone never make a chip
    assert "It has a phone number, so I asked first." in body
    assert body.index('id="approval-2"') < body.index('id="approval-1"')
    assert 'id="approval-3"' not in body  # auto rows are not pending
    assert '<span class="badge">2</span>' in body


REQUEST_TOPICS = {
    "parents": "meant for a student's family: parents, guardians, a note or letter home",
    "class_level": "asks for class-level numbers or patterns (an average, a count, a trend)",
    "school_board": "meant for the school board: board meetings, minutes, public comment",
}


def topic_row(**kw):
    row = {
        **make_rows()[0],
        "id": 9,
        "request": "Draft a note home to [Student C]'s family about her essay score",
        "topics": json.dumps(["grades", "parents", "third_party"]),
        "tagged_text": "[Student C] scored 3 of 4 on organization.",
        "router_reason": "This is headed to a family, so I asked first.",
    }
    return {**row, **kw}


def topic_client(settings, rows, request_topics=REQUEST_TOPICS):
    policy = SimpleNamespace(never_share={"iep": ["IEP"]}, request_topics=request_topics)
    app = create_app(make_services(settings, approvals=FakeApprovals(rows), policy=policy))
    return TestClient(app, base_url=LOCAL)


def card(body, rid):
    start = body.index(f'id="approval-{rid}"')
    return body[start : body.index("</article>", start)]


def test_card_shows_request_topics_as_outline_chips(settings):
    with topic_client(settings, [topic_row()]) as c:
        body = card(c.get("/").text, 9)
    assert '<li class="chip topic" title="meant for a student&#x27;s family: parents, guardians, a note or letter' in body
    assert ">For a student&#x27;s family</li>" in body
    assert 'aria-label="What the request is about"' in body
    assert "Class-level question" not in body  # a policy topic the row does not have
    assert "For someone outside the class" not in body  # third_party is on the row but not in this policy
    assert "Mentions grades" not in body and ">grades<" not in body  # not a request topic
    assert 'class="chip warn"' not in body  # nothing blocked, so no amber chip
    assert body.count("Draft a note home to [Student C]&#x27;s family") == 1  # the request, shown once
    assert body.index('class="request"') < body.index("chip topic") < body.index('class="tagged"')
    assert "What would leave this device</div>" in body  # shared tagged, not as a summary


def test_topic_chips_sit_apart_from_blocked_chips(settings):
    row = topic_row(topics=["iep", "parents"], blocked=json.dumps(["Mentions an IEP or 504 plan"]))
    with topic_client(settings, [row]) as c:
        body = card(c.get("/").text, 9)
    assert '<li class="chip warn">Mentions an IEP or 504 plan</li>' in body
    assert body.count("chip topic") == 1 and "iep" not in body.split('class="chips topics"')[1].split("</ul>")[0]


def test_summary_card_says_a_summary_would_leave(settings):
    row = topic_row(
        request="What was the class average on evidence?",
        topics=["class_level"],
        shown_form="share_summary",
        tagged_text="The class averaged 2.9 of 4 on evidence.",
    )
    with topic_client(settings, [row]) as c:
        body = card(c.get("/").text, 9)
    assert "What would leave this device: a summary, not the full result" in body
    assert "If you share it, Muse gets a short summary, with tags." in body
    assert ">Class-level question</li>" in body


def test_cards_without_policy_request_topics_have_no_topic_chips(settings):
    with topic_client(settings, [topic_row()], request_topics={}) as c:
        body = c.get("/").text
    assert "chip topic" not in body and "For a student" not in body


def test_topic_labels():
    assert ui_app.topic_label("parents", REQUEST_TOPICS["parents"]) == "For a student's family"
    assert ui_app.topic_label("school_board", REQUEST_TOPICS["school_board"]) == "For the school board"
    assert ui_app.topic_label("long_one", "asks for a b c d e f g h") == "Asks for a b c d"
    assert ui_app.topic_label("club_fair", "") == "Club fair"


def test_every_shipped_request_topic_has_a_short_label():
    from base.policy import UserPolicy

    topics = UserPolicy.load(ui_app.REPO_ROOT / "eval" / "user_policy.yaml").request_topics
    assert topics, "the shipped policy has request topics"
    for name, desc in topics.items():
        assert name in ui_app.REQUEST_TOPIC_LABELS, name
        label = ui_app.topic_label(name, desc)
        assert len(label.split()) <= ui_app.TOPIC_LABEL_WORDS and "—" not in label


def test_real_store_and_policy_show_topics_and_summary(settings, tmp_path):
    approvals = pytest.importorskip("base.approvals")
    from base.policy import UserPolicy

    store = approvals.ApprovalStore(tmp_path / "base.db")
    store.create_pending(
        tool="get_result",
        request="Write the class trend in evidence scores for the family newsletter",
        result_kind="free_text",
        tagged_text="Evidence scores rose across the class this month.",
        router_decision="ask_user",
        router_reason="This is headed to families, so I asked first.",
        topics=["class_level", "parents", "grades"],
        shown_form="share_summary",
    )
    policy = UserPolicy.load(ui_app.REPO_ROOT / "eval" / "user_policy.yaml")
    app = create_app(make_services(settings, approvals=store, policy=policy), nights_csv=tmp_path / "none.csv")
    with TestClient(app, base_url=LOCAL) as c:
        body = c.get("/").text
    assert body.index(">For a student&#x27;s family</li>") < body.index(">Class-level question</li>")  # policy order
    assert "What would leave this device: a summary, not the full result" in body
    assert "—" not in body
    store.close()


@pytest.mark.parametrize("path", ["/history", "/history?show=pending", "/dreaming", "/device", "/pair"])
def test_other_pages_render(client, path):
    r = client.get(path)
    assert r.status_code == 200
    assert "<!doctype html>" in r.text
    assert "\u2014" not in r.text  # no em dashes in UI copy


def test_history_segments(client):
    all_rows = client.get("/history").text
    assert 'id="row-3"' in all_rows and "Router decided" in all_rows
    pending = client.get("/history?show=pending").text
    assert 'id="row-3"' not in pending and 'id="row-1"' in pending
    assert 'class="on" href="/history?show=pending"' in pending


def test_dreaming_page_shows_report_and_chart(client):
    body = client.get("/dreaming").text
    assert "93.0%" in body and "Before: 81.0%" in body
    assert "90.0%" in body and "Agreement with you" in body
    assert "Leaks" in body and "Decisions learned from" in body
    assert "<svg" in body and 'class="bar"' in body
    assert "Dream now" in body
    assert 'section-title">Nights' not in body  # the fixture points at a missing nights.csv


def test_dreaming_nights_table_from_csv(settings, tmp_path):
    csv_path = tmp_path / "nights.csv"
    csv_path.write_text("night,accuracy_after,leaks\n1,0.88,0\n2,0.93,0\n")
    app = create_app(make_services(settings, night=None), nights_csv=csv_path)
    with TestClient(app, base_url=LOCAL) as c:
        body = c.get("/dreaming").text
    assert "No nights yet" in body
    assert '<h2 class="section-title">Nights</h2>' in body
    assert body.index(">2<") < body.index(">1<")  # newest night first


def test_dreaming_before_the_first_night(settings, tmp_path):
    empty = {"learned_from": 0, "accuracy_after": None, "kept": None, "leaks": None, "night_number": 0}
    night = SimpleNamespace(last_report=lambda: empty, start=lambda: "night-1")
    app = create_app(make_services(settings, night=night), nights_csv=tmp_path / "none.csv")
    with TestClient(app, base_url=LOCAL) as c:
        body = c.get("/dreaming").text
    assert "No nights yet" in body and "n/a" not in body


def test_day_labels():
    assert ui_app.day_label(3) == "Day 3"
    assert ui_app.day_label(20753) == "Oct 27"  # days since 1970, as the approvals store keeps them


def test_dreaming_without_csv_has_no_table(settings, tmp_path):
    app = create_app(make_services(settings), nights_csv=tmp_path / "missing.csv")
    with TestClient(app, base_url=LOCAL) as c:
        assert "section-title\">Nights" not in c.get("/dreaming").text


def test_device_page(client):
    body = client.get("/device").text
    assert "Laptop" in body and "meta/muse-glimmer-30b" in body
    assert "On OpenRouter, for invented data only" in body
    assert "Only this device" in body
    assert "openrouter.ai" not in body  # no endpoint URLs on the page


def test_no_page_renders_raw_names(client):
    paths = ["/", "/history", "/history?show=pending", "/dreaming", "/device", "/pair", "/api/approvals", "/api/status"]
    for path in paths:
        body = client.get(path).text
        for name in RAW_NAMES:
            assert name not in body, (path, name)
        assert "512-555-0143" not in body
    api = client.get("/api/approvals").json()["approvals"]
    assert {"raw_text", "raw_result", "tag_map"}.isdisjoint(api[0])


# ---------------------------------------------------------------- JSON API


def test_api_approvals_newest_first(client):
    rows = client.get("/api/approvals").json()["approvals"]
    assert [r["id"] for r in rows] == [2, 1]
    assert rows[0]["blocked"] == ["Mentions an IEP or 504 plan"]
    assert rows[1]["tagged_text"].startswith("[Student A]")


def test_approve_with_remember_reaches_store(client, services, captured_events):
    r = client.post("/api/approvals/1", json={"approve": True, "remember": True})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    assert services.approvals.decisions == [(1, True, True, "user")]
    # Nothing goes to Muse until it calls get_result, so the light settles (review correctness F9).
    assert [e.state for e in captured_events] == ["idle"]
    assert services.egress.resolved == []  # get_result resolves later, never the page


def test_deny_without_remember(client, services, captured_events):
    r = client.post("/api/approvals/2", json={"approve": False})
    assert r.status_code == 200 and r.json()["status"] == "denied"
    assert services.approvals.decisions == [(2, False, False, "user")]
    assert [e.state for e in captured_events] == ["idle"]


def test_form_post_without_js_redirects(client, services):
    r = client.post("/api/approvals/2", data={"approve": "0", "remember": "1"}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/"
    assert services.approvals.decisions == [(2, False, True, "user")]


def test_decide_errors(client, services):
    assert client.post("/api/approvals/99", json={"approve": True}).status_code == 404
    assert client.post("/api/approvals/a1", json={"approve": True}).status_code == 404  # ids are ints
    assert client.post("/api/history/a1/delete", json={}).status_code == 404
    assert client.post("/api/approvals/1", json={"remember": True}).status_code == 400
    assert client.post("/api/approvals/3", json={"approve": True}).status_code == 409  # auto row
    r = client.post("/api/approvals/1", content=b"{not json", headers={"content-type": "application/json"})
    assert r.status_code == 400
    assert services.approvals.decisions == []


def test_decide_race_is_a_conflict(client, services):
    def decided_elsewhere(*args, **kwargs):
        raise ValueError("decision row 1 is approved, not pending")

    services.approvals.decide = decided_elsewhere
    assert client.post("/api/approvals/1", json={"approve": True}).status_code == 409


def test_with_the_real_approval_store(settings, tmp_path, captured_events):
    approvals = pytest.importorskip("base.approvals")
    store = approvals.ApprovalStore(tmp_path / "base.db")
    rid = store.create_pending(
        tool="get_result",
        request="Share the scores for [Student D]",
        result_kind="per_student",
        tagged_text="[Student D] scored 4 of 4.",
        router_decision="ask_user",
        router_reason="Per-student scores need your OK.",
        topics=["iep"],
        blocked=["Mentions an IEP or 504 plan"],
    )
    app = create_app(make_services(settings, approvals=store), nights_csv=tmp_path / "none.csv")
    with TestClient(app, base_url=LOCAL, headers={"Origin": LOCAL}) as c:
        page = c.get("/").text
        assert '<span class="tag">[Student D]</span>' in page and "Mentions an IEP or 504 plan" in page
        assert c.get("/dreaming").status_code == 200  # counts_by_day uses real day numbers
        assert c.post(f"/api/approvals/{rid}", json={"approve": True, "remember": True}).status_code == 200
        assert c.post(f"/api/approvals/{rid}", json={"approve": True}).status_code == 409
        row = store.get(rid)
        assert (row["status"], row["user_decision"], row["remember"], row["decided_by"]) == (
            "approved",
            "approve",
            1,
            "user",
        )
        assert c.post(f"/api/history/{rid}/delete", json={}).status_code == 200
        assert store.get(rid)["tagged_text"] == "" and store.get(rid)["deleted"] == 1
        assert "[Student D]" not in c.get("/history").text
    # Nothing goes to Muse until it calls get_result, so the light settles (review correctness F9).
    assert [e.state for e in captured_events] == ["idle"]


def test_delete_blanks_row(client, services):
    r = client.post("/api/history/2/delete", json={})
    assert r.status_code == 200
    row = services.approvals.rows[2]
    assert row["deleted"] == 1 and row["request"] == "" and row["tagged_text"] == ""
    history = client.get("/history").text
    assert "IEP meeting" not in history
    row_html = history.split('id="row-2"')[1].split("</tr>")[0]
    assert "Deleted" in row_html and "Delete this decision" not in row_html
    assert [a["id"] for a in client.get("/api/approvals").json()["approvals"]] == [1]
    assert client.post("/api/history/99/delete", json={}).status_code == 404


def test_dream_now(client, services):
    r = client.post("/api/dream", json={})
    assert r.status_code == 200 and r.json() == {"ok": True, "job_id": "night-7"}
    assert services.night.started == 1


def test_dream_now_without_runner(settings):
    app = create_app(make_services(settings, night=None))
    with TestClient(app, base_url=LOCAL, headers={"Origin": LOCAL}) as c:
        assert c.post("/api/dream", json={}).status_code == 503


def test_status_and_health(client):
    status = client.get("/api/status").json()
    assert status["device"] == "laptop" and status["pending"] == 2
    assert status["login_required"] is False and status["light"]["state"] in events.STATES
    assert client.get("/health").json() == {"ok": True}


def test_security_headers(client):
    r = client.get("/")
    assert r.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert r.headers["cache-control"] == "no-store"
    assert client.get("/static/app.css").status_code == 200


# ---------------------------------------------------------------- origin and host checks


def test_cross_site_posts_rejected(services):
    app = create_app(services)
    with TestClient(app, base_url=LOCAL) as c:
        evil = c.post("/api/approvals/1", json={"approve": True}, headers={"Origin": "http://evil.example"})
        assert evil.status_code == 403
        assert c.post("/api/approvals/1", json={"approve": True}).status_code == 403  # no Origin or Referer
        assert c.post("/api/approvals/1", json={"approve": True}, headers={"Origin": "null"}).status_code == 403
        wrong_port = c.post("/api/history/1/delete", headers={"Referer": "http://127.0.0.1:9999/history"})
        assert wrong_port.status_code == 403
        assert c.post("/api/dream", headers={"Origin": "http://evil.example"}).status_code == 403
        assert services.approvals.decisions == [] and services.night.started == 0
        assert services.approvals.rows[1]["deleted"] == 0
        ok = c.post("/api/approvals/1", json={"approve": False}, headers={"Referer": f"{LOCAL}/"})
        assert ok.status_code == 200


def test_loopback_rejects_foreign_host_header(services):
    app = create_app(services)
    with TestClient(app, base_url="http://rebind.example:8787") as c:
        assert c.get("/api/approvals").status_code == 400
        assert c.get("/health").status_code == 200
    with TestClient(app, base_url="http://localhost:8787") as c:
        assert c.get("/api/approvals").status_code == 200


# ---------------------------------------------------------------- pairing off loopback


def test_session_required_off_loopback_and_pairing_works_once(settings):
    app = create_app(make_services(lan_settings(settings)))
    assert app.state.login_required
    with TestClient(app, base_url=LAN, headers={"Origin": LAN}) as c:
        r = c.get("/", follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/pair"
        assert c.get("/api/approvals").status_code == 401
        assert c.post("/api/approvals/1", json={"approve": True}).status_code == 401
        assert c.get("/events").status_code == 401
        assert c.get("/health").status_code == 200
        pair = c.get("/pair")
        assert pair.status_code == 200 and 'name="code"' in pair.text
        assert '<span class="badge">' not in pair.text  # no pending count before pairing

        code = app.state.pairing.new_code()
        assert len(code) == 6 and code.isdigit()
        wrong = "000000" if code != "000000" else "111111"
        assert c.post("/pair", data={"code": wrong}).status_code == 400

        r = c.post("/pair", data={"code": code}, follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/"
        cookie = r.headers["set-cookie"]
        assert "muse_session=" in cookie and "HttpOnly" in cookie
        assert "samesite=strict" in cookie.lower() and "Max-Age=2592000" in cookie
        assert c.get("/").status_code == 200
        assert c.get("/api/approvals").status_code == 200
        assert c.post("/api/approvals/1", json={"approve": True}).status_code == 200
        assert "This browser is paired" in c.get("/pair").text

    with TestClient(app, base_url=LAN, headers={"Origin": LAN}) as other:
        assert other.post("/pair", data={"code": code}).status_code == 400  # one use only
        assert other.get("/api/approvals").status_code == 401
        assert other.post("/pair", data={"code": code}, headers={"Origin": "http://evil.example"}).status_code == 403


def test_pairing_code_burns_after_misses():
    pairing = Pairing(tries=3)
    code = pairing.new_code()
    wrong = "000000" if code != "000000" else "111111"
    assert not any(pairing.redeem(wrong) for _ in range(3))
    assert not pairing.redeem(code)  # burned
    code = pairing.new_code()
    assert pairing.redeem(f"{code[:3]} {code[3:]}")  # spaces are fine
    assert not pairing.redeem(code)


def test_pairing_code_expires():
    pairing = Pairing(ttl=-1)
    assert not pairing.redeem(pairing.new_code())


def test_pair_code_endpoint_is_local_only(settings, capsys):
    app = create_app(make_services(lan_settings(settings)))
    with TestClient(app, base_url=LAN) as remote:
        assert remote.post("/api/pair-code").status_code == 403
    with TestClient(app, base_url=LAN, client=("127.0.0.1", 50000)) as local:
        r = local.post("/api/pair-code")
        assert r.status_code == 200
        code = r.json()["code"]
        assert code in capsys.readouterr().out
        assert local.post("/api/pair-code", headers={"Origin": "http://evil.example"}).status_code == 403
    assert app.state.pairing.redeem(code)  # the refused call did not replace it


def test_pair_page_on_loopback_needs_no_code(services, tmp_path):
    app = create_app(services)
    with TestClient(app, base_url=LOCAL, client=("127.0.0.1", 50000)) as c:
        assert "no pairing is needed" in c.get("/pair").text
        assert c.post("/api/pair-code").json() == {"needed": False}


def test_sessions_survive_restart(settings):
    s = lan_settings(settings)
    app = create_app(make_services(s))
    code = app.state.pairing.new_code()
    with TestClient(app, base_url=LAN, headers={"Origin": LAN}) as c:
        c.post("/pair", data={"code": code})
        token = c.cookies.get("muse_session")
    assert token and len(token) >= 43  # 32 random bytes, base64url
    path = s.home / "approval_sessions.json"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert token not in path.read_text()  # only hashes are stored
    restarted = create_app(make_services(s))
    with TestClient(restarted, base_url=LAN, cookies={"muse_session": token}) as c:
        assert c.get("/api/approvals").status_code == 200
    with TestClient(restarted, base_url=LAN, cookies={"muse_session": "forged"}) as c:
        assert c.get("/api/approvals").status_code == 401


# ---------------------------------------------------------------- heavy routes


def _fake_heavy_module(seen):
    router = APIRouter()

    @router.get("/heavy/next")
    def next_step():
        return {"step": None}

    def router_for(settings, queue=None):
        seen.append(queue)
        return router

    module = ModuleType("base.heavy.routes")
    module.router_for = router_for
    return module


def test_heavy_router_included_and_exempt_from_session(settings, monkeypatch):
    seen = []
    module = _fake_heavy_module(seen)
    monkeypatch.setitem(sys.modules, "base.heavy.routes", module)
    monkeypatch.setattr(base.heavy, "routes", module, raising=False)
    heavy = SimpleNamespace(worker_present=lambda: True)
    s = lan_settings(settings, heavy_queue=True)
    app = create_app(make_services(s, heavy=heavy))
    assert seen == [heavy]  # the routes share services.heavy with the agent
    with TestClient(app, base_url=LAN) as c:
        assert c.get("/heavy/next").json() == {"step": None}  # the worker token check lives in that router
    code = app.state.pairing.new_code()
    with TestClient(app, base_url=LAN, headers={"Origin": LAN}) as c:
        c.post("/pair", data={"code": code})
        body = c.get("/device").text
    assert "Laptop helper" in body and "A laptop worker checked in recently" in body


def test_real_heavy_routes_need_the_worker_token_not_a_session(settings):
    routes = pytest.importorskip("base.heavy.routes")
    queue_mod = pytest.importorskip("base.heavy.queue")
    s = lan_settings(settings, heavy_queue=True)
    queue = queue_mod.HeavyQueue(s.paths.db)
    app = create_app(make_services(s, heavy=queue))
    with TestClient(app, base_url=LAN) as c:
        assert c.get("/heavy/next?wait=0").status_code == 401  # their bearer check, not our pairing redirect
        token = routes.load_token(s)
        ok = c.get("/heavy/next?wait=0", headers={"Authorization": f"Bearer {token}"})
        assert ok.status_code == 204


def test_app_works_without_heavy_module(settings, monkeypatch):
    monkeypatch.setitem(sys.modules, "base.heavy.routes", None)  # import raises ImportError
    monkeypatch.delattr(base.heavy, "routes", raising=False)
    app = create_app(make_services(dataclasses.replace(settings, heavy_queue=True)))
    with TestClient(app, base_url=LOCAL) as c:
        assert c.get("/heavy/next").status_code == 404
        assert c.get("/").status_code == 200


# ---------------------------------------------------------------- events stream


def test_sse_yields_event_after_emit(client, monkeypatch):
    monkeypatch.setattr(ui_app, "HEARTBEAT_SECONDS", 0.2)
    before = len(events._subscribers)
    payload = None
    with client.stream("GET", "/events") as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        lines = r.iter_lines()
        assert next(lines) == ": connected"
        events.emit("waiting", "approval 9")
        for _, line in zip(range(20), lines, strict=False):
            if line.startswith("data: "):
                payload = json.loads(line[len("data: "):])
                break
    assert payload is not None
    assert payload["state"] == "waiting" and payload["detail"] == "approval 9"
    assert isinstance(payload["ts"], float)
    deadline = time.time() + 2
    while len(events._subscribers) > before and time.time() < deadline:
        time.sleep(0.02)
    assert len(events._subscribers) == before


async def test_event_stream_heartbeat_and_data():
    stream = event_stream(heartbeat=0.01)
    assert await anext(stream) == ": connected\n\n"
    assert await anext(stream) == ": ping\n\n"
    events.emit("working", "job-5")
    line = await anext(stream)
    assert line.startswith("data: ") and line.endswith("\n\n")
    assert json.loads(line[len("data: "):])["state"] == "working"
    await stream.aclose()


# ---------------------------------------------------------------- review fixes (SEC-3, SEC-8)


def test_big_bodies_get_413_before_anything_reads_them(settings):
    app = create_app(make_services(lan_settings(settings)))
    with TestClient(app, base_url=LAN, headers={"Origin": LAN}) as c:
        r = c.post("/pair", content=b"{" + b" " * (70 * 1024), headers={"content-type": "application/json"})
        assert r.status_code == 413
        small = c.post("/pair", data={"code": "000001"})
        assert small.status_code == 400  # a normal body still reaches the route


def test_body_limit_counts_chunked_bodies():
    import asyncio

    from base.ui_app import BodyLimit

    sent, read = [], []

    async def app(scope, receive, send):
        while True:
            m = await receive()
            read.append(len(m.get("body", b"")))
            if not m.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})

    chunks = [{"type": "http.request", "body": b"x" * 1000, "more_body": True} for _ in range(5)]

    async def receive():
        return chunks.pop(0)

    async def send(m):
        sent.append(m)

    asyncio.run(BodyLimit(app, default=2500)({"type": "http", "path": "/pair", "headers": []}, receive, send))
    assert sent[0]["status"] == 413 and sum(read) <= 2000


def test_heavy_routes_check_the_token_before_reading_the_body(settings, tmp_path):
    from base.heavy.queue import HeavyQueue

    lan = lan_settings(settings, heavy_queue=True)
    svc = make_services(lan, heavy=HeavyQueue(tmp_path / "q.db"))
    app = create_app(svc)
    with TestClient(app, base_url=LAN) as c:
        bad = c.post("/heavy/" + "a" * 32 + "/result", content=b"{", headers={"content-type": "application/json"})
        assert bad.status_code == 401  # not 422: the body was never parsed


def test_pairing_misses_survive_a_restart(settings, tmp_path):
    from base.ui_app import MAX_TOTAL_MISSES

    path = tmp_path / "misses"
    for _ in range(MAX_TOTAL_MISSES):
        p = Pairing(misses_path=path)  # a new process each time, as after a crash
        code = p.new_code()
        assert not p.redeem("999999" if code != "999999" else "888888")
    p = Pairing(misses_path=path)
    assert p.locked_out()
    code = p.new_code()
    assert not p.redeem(code)  # even the right code: start-up codes are off until the device asks
    code = p.new_code(on_device=True)
    assert p.redeem(code) and not p.locked_out()


def test_cookie_is_secure_with_tls_and_other_browsers_can_be_signed_out(settings, tmp_path):
    tls = lan_settings(settings, approval_tls_cert=tmp_path / "c.pem", approval_tls_key=tmp_path / "k.pem")
    app = create_app(make_services(tls))
    https = LAN.replace("http://", "https://")  # a Secure cookie only comes back over TLS
    with TestClient(app, base_url=https, headers={"Origin": https}) as c:
        r = c.post("/pair", data={"code": app.state.pairing.new_code()}, follow_redirects=False)
        assert "Secure" in r.headers["set-cookie"]
    with TestClient(app, base_url=https, headers={"Origin": https}) as other:
        other.post("/pair", data={"code": app.state.pairing.new_code()}, follow_redirects=False)
        assert app.state.sessions.count() == 2
        assert other.post("/api/sessions/clear").json() == {"ok": True, "signed_out": 1}
        assert app.state.sessions.count() == 1 and other.get("/api/approvals").status_code == 200


def test_always_approve_switch(client, services):
    assert 'class="state-off">off<' in client.get("/").text
    r = client.post("/api/auto-approve", json={"on": True})
    assert r.status_code == 200 and r.json() == {"ok": True, "auto_approve": True}
    assert services.settings.paths.auto_approve.is_file()
    assert client.get("/api/status").json()["auto_approve"] is True
    assert 'class="state-on">on<' in client.get("/").text
    r = client.post("/api/auto-approve", data={"on": "false"}, follow_redirects=False)
    assert r.status_code == 303 and not services.settings.paths.auto_approve.exists()
    assert client.post("/api/auto-approve", json={}).status_code == 400


def test_always_approve_cannot_be_turned_on_from_another_site(client, services):
    r = client.post("/api/auto-approve", json={"on": True}, headers={"Origin": "http://evil.example"})
    assert r.status_code == 403 and not services.settings.paths.auto_approve.exists()


def test_controls_page_saves_the_form(client, services):
    root = services.settings.workspace_root
    (root / "resumes").mkdir(exist_ok=True)
    page = client.get("/controls").text
    assert "Phone numbers" in page and "Tagged" in page and "resumes" in page and "Send real names" in page
    folders = [p.name for p in sorted(root.iterdir()) if p.is_dir() and not p.name.startswith(".")]
    i = folders.index("resumes")
    form = {"form": "controls", "tag_email": "1", "always_redact": "Coral Bay\nCoral Bay\n", "never_redact": "Ms. Vale"}
    for n, name in enumerate(folders):
        form[f"folder_{n}"] = name
        if name != "resumes":
            form[f"see_{n}"] = "1"
    form[f"names_{i}"] = "1"
    r = client.post("/controls".replace("/controls", "/api/controls"), data=form, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/controls?saved=1"
    c = client.get("/api/controls").json()["controls"]
    assert c["tag_kinds"]["email"] is True and c["tag_kinds"]["phone"] is False
    assert c["always_redact"] == ["Coral Bay"] and c["never_redact"] == ["Ms. Vale"]
    assert c["hidden_folders"] == ["resumes"] and c["names_off_folders"] == ["resumes"]
    assert "Saved." in client.get("/controls?saved=1").text


def test_controls_json_and_other_sites(client, services):
    r = client.post("/api/controls", json={"controls": {"never_redact": ["Coral Bay"]}})
    assert r.status_code == 200 and r.json()["controls"]["never_redact"] == ["Coral Bay"]
    evil = client.post("/api/controls", json={"hidden_folders": []}, headers={"Origin": "http://evil.example"})
    assert evil.status_code == 403


def test_always_approve_shows_when_it_turns_itself_off(client, services):
    assert "auto-banner" not in client.get("/").text
    assert client.get("/api/status").json()["auto_approve_seconds_left"] is None
    client.post("/api/auto-approve", json={"on": True})
    page = client.get("/").text
    assert 'class="auto-banner"' in page and "Always approve is on until" in page and "turns itself off" in page
    assert "outside the class" in page  # what it still leaves for you
    left = client.get("/api/status").json()["auto_approve_seconds_left"]
    assert 8 * 3600 - 60 <= left <= 8 * 3600


def test_always_approve_from_9_hours_ago_shows_off(client, services):
    path = services.settings.paths.auto_approve
    path.write_text(f"on since 2026-10-30 08:00\nstarted {int(time.time() - 9 * 3600)}\n")
    page = client.get("/").text
    assert 'class="state-off">off<' in page and "auto-banner" not in page and not path.exists()
    status = client.get("/api/status").json()
    assert status["auto_approve"] is False and status["auto_approve_seconds_left"] is None


# ---------------------------------------------------------------- /ask shows only questions asked on the page


def test_ask_page_never_renders_another_jobs_raw_result(client, services, tmp_path):
    from base.workspace.jobs import JobStore

    services.jobs = jobs = JobStore(tmp_path / "jobs.db")
    task = jobs.create("private_task", "Grade each essay for [Student A]", "essays")
    jobs.finish(task, "Juniper Ashvale: 3 of 4, strong thesis.", "per_student")
    search = jobs.job_for_result("search", "evidence", "1. Juniper Ashvale essay\nJuniper Ashvale argues.", "snippet")
    from_muse = jobs.create("ask", "What did [Student A] write about?", None)
    jobs.finish(from_muse, "Answer: Juniper Ashvale wrote about tide pools.", "snippet")
    spoofed = jobs.create("grading", ui_app.PAGE_ASK, "essays")  # the page's request text on another kind
    jobs.finish(spoofed, "Juniper Ashvale: 2 of 4.", "per_student")
    asked_here = jobs.create("ask", ui_app.PAGE_ASK, None)
    jobs.finish(asked_here, "Answer: Rowan Thistlewood wrote about bees.", "snippet")
    for job in (task, search, from_muse, spoofed, "no-such-job"):
        page = client.get(f"/ask?job={job}").text
        assert "Juniper" not in page and "Ashvale" not in page and ">Answer</h2>" not in page
    page = client.get(f"/ask?job={asked_here}").text
    assert ">Answer</h2>" in page and "Rowan Thistlewood wrote about bees." in page
