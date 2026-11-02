"""scripts/health.py: the one-command probe. Mocked HTTP on 127.0.0.1, a temp BASE_HOME."""

import json
import os
import sqlite3
from types import SimpleNamespace

import httpx
import pytest
import respx

from base.config import (
    _load_settings_for_tests as load_settings,  # pre-ruling loader: LFM code load_settings now refuses
)
from scripts import health

RELAY = "https://relay.example.org"
SECRET = "device-secret-for-tests"
UP = {8787: 200, 8790: 200, 8083: 200, 8084: 200}
NOW = 1_800_000_000.0


def plenty(_path):
    return SimpleNamespace(free=50e9)


def make_settings(tmp_path, **extra):
    env = {"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(tmp_path / "w"), "DEVICE_ONLY": "1",
           "SEARCH_EMBEDDINGS": "1", "RELAY_URL": RELAY, "CHECKER_API_KEY": "local-key", **extra}
    s = load_settings(env)
    s.ensure_home()
    return s


def link(settings, log_lines=("2026-11-04 09:00:01,000 INFO connected to the relay",)):
    (settings.home / "relay.json").write_text(json.dumps({"relay_url": RELAY, "device_id": "d1", "secret": SECRET}))
    if log_lines is not None:
        (settings.home / "logs").mkdir(exist_ok=True)
        (settings.home / "logs" / "relay.log").write_text("\n".join(log_lines) + "\n")


def night(settings, finished, kept=True, wal=False):
    con = sqlite3.connect(settings.paths.db)
    if wal:
        con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE dreaming_nights (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, "
                "finished_at REAL NOT NULL, report TEXT NOT NULL, rule_row_ids TEXT NOT NULL)")
    con.execute("INSERT INTO dreaming_nights (job_id, finished_at, report, rule_row_ids) VALUES (?, ?, ?, ?)",
                ("dream-1", finished, json.dumps({"kept": kept, "night_number": 1}), "[]"))
    con.commit()
    return con


def run(settings, codes=UP, argv=(), running=lambda: True, usage=plenty, capsys=None):
    with respx.mock(assert_all_called=False) as mock:
        for port, code in codes.items():
            route = mock.get(f"http://127.0.0.1:{port}/health")
            if code is None:
                route.mock(side_effect=httpx.ConnectError("refused"))
            else:
                route.respond(code, json={"status": "ok"})
        code = health.main(list(argv), settings=settings, running=running, usage=usage, now=NOW)
    return code, capsys.readouterr().out if capsys else ""


def test_all_up_exits_0_and_prints_no_paths_or_secrets(tmp_path, capsys):
    s = make_settings(tmp_path)
    link(s)
    night(s, NOW - 3 * 3600).close()
    code, out = run(s, capsys=capsys)
    assert code == 0
    for name in ("approval", "connector", "checker", "embedder", "relay", "disk", "dreaming"):
        assert name in out
    assert "connected since 2026-11-04 09:00" in out and "50.0 GB free, floor 5 GB" in out
    assert "(3 h ago), kept the new rules" in out
    assert "All 6 required checks are ok." in out
    for private in (str(tmp_path), "relay.example.org", SECRET, "local-key", "127.0.0.1", "relay.log"):
        assert private not in out


def test_a_down_connector_exits_1(tmp_path, capsys):
    s = make_settings(tmp_path)
    link(s)
    code, out = run(s, {**UP, 8790: None}, capsys=capsys)
    assert code == 1
    assert "port 8790: no answer (ConnectError)" in out and out.rstrip().endswith("Down: connector.")


def test_a_loading_model_is_down(tmp_path, capsys):
    s = make_settings(tmp_path)
    link(s)
    code, out = run(s, {**UP, 8083: 503}, capsys=capsys)
    assert code == 1 and "still loading the model (503)" in out and "Down: checker." in out


def test_relay_states(tmp_path, capsys):
    s = make_settings(tmp_path)
    link(s, ["2026-11-04 09:00:01,000 INFO connected to the relay",
             "2026-11-04 09:00:02,000 INFO request abc POST -> 200 in 12 ms",
             "2026-11-04 09:05:00,000 WARNING relay connection failed (ConnectionClosedError)",
             "2026-11-04 09:05:00,100 INFO reconnecting in 1.3 s"])
    code, out = run(s, capsys=capsys)
    assert code == 1 and "not connected: reconnecting since 2026-11-04 09:05" in out

    link(s)
    code, out = run(s, running=lambda: False, capsys=capsys)
    assert code == 1 and "the relay client is not running" in out

    link(s, ["Another copy of this device connected to the relay, so this one stopped. Run one relay client per device."])
    code, out = run(s, capsys=capsys)
    assert code == 1 and "another copy took over" in out

    link(s, log_lines=None)
    (s.home / "logs" / "relay.log").unlink()
    code, out = run(s, capsys=capsys)  # running, but nothing to read the connection from (systemd)
    assert code == 0 and status_of(out, "relay") == ["warn"]


def test_an_unlinked_device_skips_the_relay(tmp_path, capsys):
    s = make_settings(tmp_path, RELAY_URL="")
    code, out = run(s, running=lambda: pytest.fail("no process check when not linked"), capsys=capsys)
    assert code == 0 and "not linked to the relay" in out


def test_low_disk_is_down(tmp_path, capsys):
    s = make_settings(tmp_path, RELAY_URL="")
    code, out = run(s, argv=["--min-free-gb", "8"], usage=lambda _p: SimpleNamespace(free=4.2e9), capsys=capsys)
    assert code == 1 and "4.2 GB free, floor 8 GB" in out and "Down: disk." in out


def test_dreaming_is_shown_never_required(tmp_path, capsys):
    s = make_settings(tmp_path, RELAY_URL="")
    code, out = run(s, capsys=capsys)
    assert code == 0 and "no night has run yet" in out
    night(s, NOW - 3 * 86400, kept=False).close()
    code, out = run(s, capsys=capsys)
    assert code == 0 and "(3 days ago), kept the old rules" in out and status_of(out, "dreaming") == ["warn"]


def test_the_database_is_read_without_writing(tmp_path):
    s = make_settings(tmp_path)
    night(s, NOW - 600, wal=True).close()  # a clean close leaves no -wal file: the app is down
    before = sorted(os.listdir(s.home))
    row = health.dreaming_row(s.paths.db, NOW)
    assert row.status == "ok" and "(10 min ago)" in row.detail
    assert sorted(os.listdir(s.home)) == before
    live = sqlite3.connect(s.paths.db)  # the app is up: its -wal file exists
    live.execute("INSERT INTO dreaming_nights (job_id, finished_at, report, rule_row_ids) VALUES ('dream-2', ?, '{}', '[]')",
                 (NOW - 120,))
    live.commit()
    assert (s.home / "base.db-wal").exists()
    assert "(2 min ago)" in health.dreaming_row(s.paths.db, NOW).detail
    live.close()


def test_models_follow_the_settings_and_never_a_cloud_endpoint(tmp_path):
    cloud = make_settings(tmp_path, DEVICE_ONLY="0", SEARCH_EMBEDDINGS="0", OPENROUTER_API_KEY="k")
    assert health.model_servers(cloud) == [("checker", 8083, False), ("embedder", 8084, False)]
    lfm_only = make_settings(tmp_path)
    assert health.model_servers(lfm_only) == [("checker", 8083, True), ("embedder", 8084, True)]
    glimmer = make_settings(tmp_path, DEVICE_ONLY="0", GLIMMER_BACKEND="llama_server", SEARCH_EMBEDDINGS="0")
    assert ("glimmer", 8081, True) in health.model_servers(glimmer) and ("router", 8082, True) in health.model_servers(glimmer)


def test_an_unused_server_shows_only_when_it_answers(tmp_path, capsys):
    s = make_settings(tmp_path, DEVICE_ONLY="0", SEARCH_EMBEDDINGS="0", OPENROUTER_API_KEY="k", RELAY_URL="")
    code, out = run(s, {8787: 200, 8790: 200, 8083: None, 8084: 200}, capsys=capsys)
    assert code == 0
    assert "checker" not in out and "port 8084 answered (not used by these settings)" in out


def test_a_tls_approval_page_is_skipped(tmp_path, capsys):
    s = make_settings(tmp_path, RELAY_URL="", APPROVAL_TLS_CERT=str(tmp_path / "c.pem"), APPROVAL_TLS_KEY=str(tmp_path / "k.pem"))
    code, out = run(s, {8790: 200, 8083: 200, 8084: 200}, capsys=capsys)
    assert code == 0 and "not served over plain HTTP" in out


def test_relay_state_reads_only_the_tail(tmp_path):
    log = tmp_path / "relay.log"
    log.write_text("2026-11-04 08:00:00,000 INFO connected to the relay\n" + "x" * (health.TAIL_BYTES + 10) + "\n")
    assert health.relay_state(log) == (None, "")
    assert health.relay_state(tmp_path / "missing.log") == (None, "")


def test_relay_running_uses_pgrep_quietly(monkeypatch):
    calls = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        return SimpleNamespace(returncode=1, stdout=b"", stderr=b"")

    monkeypatch.setattr(health.shutil, "which", lambda name: "/usr/bin/pgrep")
    monkeypatch.setattr(health.subprocess, "run", fake_run)
    assert health.relay_running() is False and calls == [["/usr/bin/pgrep", "-f", health.RELAY_PROCESS]]
    monkeypatch.setattr(health.shutil, "which", lambda name: None)
    assert health.relay_running() is None


def test_ages_are_short():
    assert health._ago(59) == "0 min ago" and health._ago(7200) == "2 h ago" and health._ago(3 * 86400) == "3 days ago"


def status_of(out, name):
    return [line.split()[1] for line in out.splitlines() if line.split()[:1] == [name]]
