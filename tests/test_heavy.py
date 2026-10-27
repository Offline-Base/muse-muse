"""Heavy-step handoff: queue, routes and the laptop's dial-out worker, all in-process."""

from __future__ import annotations

import sqlite3
import stat
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from base.heavy import worker as worker_mod
from base.heavy.queue import HeavyQueue
from base.heavy.routes import load_token, make_router, router_for, token_path
from base.heavy.worker import TokenRejected, Worker

TOKEN = "test-worker-token"
MESSAGES = [{"role": "user", "content": "Grade this invented essay by Student A."}]
SCHEMA = {"type": "object", "properties": {"score": {"type": "integer"}}}


@pytest.fixture
def queue(tmp_path):
    return HeavyQueue(tmp_path / "base.db", wait_seconds=5, poll_interval=0.02)


@pytest.fixture
def client(queue):
    app = FastAPI()
    app.include_router(make_router(queue, TOKEN))
    return TestClient(app)


def auth(token=TOKEN):
    return {"Authorization": f"Bearer {token}"}


class FakeLLM:
    def __init__(self, result=None, error=None):
        self.result = {"score": 3} if result is None else result
        self.error = error
        self.calls = []

    def chat_json(self, messages, schema, **kw):
        self.calls.append((messages, schema, kw))
        if self.error:
            raise self.error
        return self.result


def start(fn):
    t = threading.Thread(target=fn, daemon=True)
    t.start()
    return t


def test_no_worker_returns_none_immediately(queue):
    t0 = time.monotonic()
    assert queue.run("grade", MESSAGES, SCHEMA) is None
    assert time.monotonic() - t0 < 0.5


def test_stale_hello_counts_as_no_worker(tmp_path):
    q = HeavyQueue(tmp_path / "base.db", wait_seconds=5, hello_window=0.05)
    q.hello("laptop-1")
    time.sleep(0.1)
    assert not q.worker_present()
    assert q.run("grade", MESSAGES, SCHEMA) is None


def test_round_trip_through_routes_with_worker_thread(queue, client):
    llm = FakeLLM({"score": 4, "next_step": "Add a closing sentence."})
    w = Worker("http://testserver", TOKEN, llm, client=client, wait=3)
    w.hello()
    handled = []
    t = start(lambda: handled.append(w.run_once()))
    result = queue.run("grade", MESSAGES, SCHEMA)
    t.join(5)
    assert result == {"score": 4, "next_step": "Add a closing sentence."}
    assert handled == [True]
    messages, schema, kw = llm.calls[0]
    assert messages == MESSAGES and schema == SCHEMA
    assert kw["synthetic"] is False


def test_finished_step_blanks_document_text(queue, client, tmp_path):
    w = Worker("http://testserver", TOKEN, FakeLLM(), client=client, wait=3)
    w.hello()
    t = start(w.run_once)
    assert queue.run("grade", MESSAGES, SCHEMA) == {"score": 3}
    t.join(5)
    with sqlite3.connect(tmp_path / "base.db") as conn:
        rows = conn.execute("SELECT kind, status, messages, result FROM heavy_steps").fetchall()
    assert rows == [("grade", "done", "[]", None)]


def test_timeout_abandons_step_and_ignores_late_result(tmp_path):
    q = HeavyQueue(tmp_path / "slow.db", wait_seconds=0.3, poll_interval=0.02)
    app = FastAPI()
    app.include_router(make_router(q, TOKEN))
    c = TestClient(app)
    c.post("/heavy/hello", headers=auth(), json={"worker": "slow"})
    claimed = {}
    t = start(lambda: claimed.update(c.get("/heavy/next", params={"wait": 2}, headers=auth()).json()))
    t0 = time.monotonic()
    assert q.run("grade", MESSAGES, SCHEMA) is None
    assert 0.25 < time.monotonic() - t0 < 2
    t.join(3)
    assert q.status(claimed["id"]) == "abandoned"
    late = c.post(f"/heavy/{claimed['id']}/result", headers=auth(), json={"result": {"score": 1}})
    assert late.status_code == 409 and late.json()["accepted"] is False
    assert q.next(wait=0) is None  # the abandoned step is never handed out again


def test_step_abandoned_elsewhere_returns_none(tmp_path):
    db = tmp_path / "base.db"
    q = HeavyQueue(db, wait_seconds=5, poll_interval=0.02)
    q.hello("laptop-1")

    def abandon_soon():
        time.sleep(0.1)
        with sqlite3.connect(db) as conn:
            conn.execute("UPDATE heavy_steps SET status = 'abandoned'")

    t = start(abandon_soon)
    t0 = time.monotonic()
    assert q.run("grade", MESSAGES, SCHEMA) is None
    assert time.monotonic() - t0 < 2
    t.join(2)


def test_leftover_steps_are_swept(tmp_path):
    db = tmp_path / "base.db"
    HeavyQueue(db)
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO heavy_steps (id, kind, messages, status, created_at) VALUES (?, 'grade', ?, 'queued', 1)",
            ("d" * 32, '[{"role": "user", "content": "invented essay"}]'),
        )
    q = HeavyQueue(db)  # a restart after a crash
    assert q.status("d" * 32) == "abandoned"
    assert q.next(wait=0) is None
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT messages FROM heavy_steps").fetchone() == ("[]",)


def test_worker_error_falls_back_quickly(queue, client):
    w = Worker("http://testserver", TOKEN, FakeLLM(error=ValueError("Student A wrote ...")), client=client, wait=3)
    w.hello()
    t = start(w.run_once)
    t0 = time.monotonic()
    assert queue.run("grade", MESSAGES, SCHEMA) is None
    assert time.monotonic() - t0 < 3
    t.join(5)


def test_worker_error_report_has_no_content():
    w = Worker("http://x", TOKEN, FakeLLM(error=ValueError("Student A wrote about Maple Street")))
    assert w.run_step({"id": "a" * 32, "kind": "grade", "messages": MESSAGES, "schema": None}) == {"error": "ValueError"}


def test_next_returns_204_when_empty(client):
    r = client.get("/heavy/next", params={"wait": 0.05}, headers=auth())
    assert r.status_code == 204


def test_next_wait_is_capped(client):
    assert client.get("/heavy/next", params={"wait": 60}, headers=auth()).status_code == 422


@pytest.mark.parametrize(
    "headers",
    [{}, {"Authorization": "Bearer wrong"}, {"Authorization": TOKEN}, {"Authorization": f"Basic {TOKEN}"},
     {"Authorization": f"Bearer {TOKEN}x"}],
)
def test_auth_rejects_bad_tokens(client, headers):
    assert client.post("/heavy/hello", headers=headers).status_code == 401
    assert client.get("/heavy/next", params={"wait": 0}, headers=headers).status_code == 401
    assert client.post(f"/heavy/{'a' * 32}/result", headers=headers, json={"result": {}}).status_code == 401


def test_auth_accepts_good_token(client, queue):
    r = client.post("/heavy/hello", headers=auth(), json={"worker": "laptop-1"})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert queue.worker_present()


def test_result_for_unknown_step(client):
    assert client.post("/heavy/not-a-step/result", headers=auth(), json={"result": {}}).status_code == 404
    assert client.post(f"/heavy/{'b' * 32}/result", headers=auth(), json={"result": {}}).status_code == 409
    assert client.post(f"/heavy/{'b' * 32}/result", headers=auth(), json={}).status_code == 422


def test_cloud_worker_only_gets_synthetic_steps(tmp_path):
    q = HeavyQueue(tmp_path / "base.db", wait_seconds=0.2, poll_interval=0.02)
    q.hello("laptop-cloud", cloud=True)
    assert not q.worker_present()
    assert q.run("grade", MESSAGES, SCHEMA) is None  # real data never goes to a cloud worker
    assert q.worker_present(synthetic=True)

    got = {}
    t = start(lambda: got.update(q.next(worker="laptop-cloud", cloud=True, wait=2) or {}))
    deadline = time.monotonic() + 2
    while not got and time.monotonic() < deadline:
        q.run("grade", MESSAGES, SCHEMA, synthetic=True)
    t.join(3)
    assert got["synthetic"] is True


def test_cloud_worker_refuses_unmarked_step():
    llm = FakeLLM()
    w = Worker("http://x", TOKEN, llm, cloud=True, synthetic=True)
    assert w.run_step({"id": "c" * 32, "kind": "grade", "messages": MESSAGES, "schema": None}) == {
        "error": "CloudBackendRefused"
    }
    assert llm.calls == []


def test_token_file_created_0600_and_stable(settings):
    token = load_token(settings)
    path = token_path(settings)
    assert path == settings.home / "heavy_token"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert len(token) >= 32
    assert load_token(settings) == token


def test_router_for_uses_stored_token(settings):
    app = FastAPI()
    app.include_router(router_for(settings))
    c = TestClient(app)
    assert c.post("/heavy/hello", headers=auth(load_token(settings))).status_code == 200
    assert c.post("/heavy/hello", headers=auth("nope")).status_code == 401


def test_print_token_shows_pairing_command(settings, capsys):
    from base.heavy.routes import print_token

    print_token(settings)
    out = capsys.readouterr().out
    assert load_token(settings) in out and "base.heavy.worker" in out


@respx.mock
def test_worker_backs_off_while_jetson_is_down():
    respx.post("http://jetson.test/heavy/hello").mock(side_effect=httpx.ConnectError("down"))
    sleeps = []
    w = Worker("http://jetson.test", TOKEN, FakeLLM())

    def record(seconds):
        sleeps.append(seconds)
        if len(sleeps) >= 5:
            w.stop.set()

    w.sleep = record
    w.run_forever()
    base = [1, 2, 4, 8, 16]
    assert all(b <= s <= b * 1.25 for s, b in zip(sleeps, base, strict=True))


@respx.mock
def test_worker_stops_on_rejected_token():
    respx.post("http://jetson.test/heavy/hello").mock(return_value=httpx.Response(401))
    w = Worker("http://jetson.test", TOKEN, FakeLLM(), sleep=lambda s: None)
    with pytest.raises(TokenRejected):
        w.run_forever()


@respx.mock
def test_worker_sends_bearer_token_and_handles_204():
    hello = respx.post("http://jetson.test/heavy/hello").mock(return_value=httpx.Response(200, json={"ok": True}))
    nxt = respx.get("http://jetson.test/heavy/next").mock(return_value=httpx.Response(204))
    w = Worker("http://jetson.test/", TOKEN, FakeLLM())
    assert w.run_once() is False
    assert hello.calls[0].request.headers["authorization"] == f"Bearer {TOKEN}"
    assert nxt.calls[0].request.url.params["cloud"] == "false"


def test_worker_main_requires_synthetic_on_cloud_backend(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("BASE_DEVICE", "laptop")
    monkeypatch.setenv("BASE_HOME", str(tmp_path))
    monkeypatch.setenv("GLIMMER_BACKEND", "openrouter")
    with pytest.raises(SystemExit) as exc:
        worker_mod.main(["--jetson-url", "http://127.0.0.1:9", "--token", TOKEN])
    assert exc.value.code == 2
    assert "--synthetic" in capsys.readouterr().err


def test_worker_main_refuses_on_jetson(monkeypatch, tmp_path):
    monkeypatch.setenv("BASE_DEVICE", "jetson")
    monkeypatch.setenv("BASE_HOME", str(tmp_path))
    monkeypatch.setenv("GLIMMER_BACKEND", "llama_server")
    with pytest.raises(SystemExit) as exc:
        worker_mod.main(["--jetson-url", "http://127.0.0.1:9", "--token", TOKEN])
    assert exc.value.code == 2


def test_worker_main_runs_once_with_local_backend(monkeypatch, tmp_path):
    monkeypatch.setenv("BASE_DEVICE", "laptop")
    monkeypatch.setenv("BASE_HOME", str(tmp_path))
    monkeypatch.setenv("GLIMMER_BACKEND", "llama_server")
    seen = {}

    class FakeLocalLLM(FakeLLM):
        def __init__(self, settings, role):
            super().__init__()
            seen["role"] = role

    monkeypatch.setitem(sys.modules, "base.local_llm", SimpleNamespace(LocalLLM=FakeLocalLLM))
    with respx.mock:
        respx.post("http://jetson.test/heavy/hello").mock(return_value=httpx.Response(200, json={"ok": True}))
        respx.get("http://jetson.test/heavy/next").mock(return_value=httpx.Response(204))
        assert worker_mod.main(["--jetson-url", "http://jetson.test", "--token", TOKEN, "--once", "--allow-plain-http"]) == 0
    assert seen["role"] == "answer"


def test_worker_refuses_plain_http_off_loopback_without_opt_in(monkeypatch, tmp_path):
    # Review privacy F10: heavy steps carry whole essays and the replayable worker token.
    monkeypatch.setenv("BASE_DEVICE", "laptop")
    monkeypatch.setenv("BASE_HOME", str(tmp_path))
    monkeypatch.setenv("GLIMMER_BACKEND", "llama_server")
    with pytest.raises(SystemExit) as stop:
        worker_mod.main(["--jetson-url", "http://jetson.test", "--token", TOKEN, "--once"])
    assert stop.value.code == 2


def test_pinned_context_trusts_only_the_given_cert(tmp_path):
    import ssl

    from tests.tls_helpers import self_signed

    cert, _key = self_signed(tmp_path)
    ctx = worker_mod.pinned_context(str(cert))
    assert isinstance(ctx, ssl.SSLContext) and ctx.check_hostname is False
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert worker_mod.pinned_context(None) is True


def test_worker_caps_each_step_below_the_jetsons_wait():
    llm = FakeLLM()
    calls = []
    llm.chat_json = lambda messages, schema, **kw: calls.append(kw) or {"ok": 1}
    w = worker_mod.Worker("http://127.0.0.1:8787", TOKEN, llm)
    with respx.mock:
        respx.post("http://127.0.0.1:8787/heavy/hello").mock(
            return_value=httpx.Response(200, json={"ok": True, "wait_seconds": 120})
        )
        w.hello()
    w.run_step({"kind": "grade", "messages": [], "schema": None, "synthetic": False})
    assert calls[0]["timeout"] == 110


def test_a_worker_busy_on_a_step_still_counts_as_present(tmp_path):
    # Review correctness F6: no hello while the model runs, and one essay can take over 30 s.
    q = HeavyQueue(tmp_path / "q.db", wait_seconds=120, hello_window=0.05)
    q.hello("w1")
    import threading as _t
    import time as _time

    def work():
        step = q.next(worker="w1", wait=2)
        _time.sleep(0.2)  # longer than the hello window
        assert q.worker_present()  # claimed within wait_seconds
        q.submit(step["id"], result={"ok": 1})

    t = _t.Thread(target=work)
    t.start()
    assert q.run("grade", [{"role": "user", "content": "x"}], None) == {"ok": 1}
    t.join()
    assert q.worker_present()  # submit counted as a hello


def test_worker_never_listens():
    source = Path(worker_mod.__file__).read_text()
    for word in ("uvicorn", ".bind(", "listen(", "socketserver", "http.server"):
        assert word not in source
