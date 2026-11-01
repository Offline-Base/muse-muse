"""scripts/ask_as_muse.py reads a job's status, or a result shared at once, without printing it."""

from __future__ import annotations

from types import SimpleNamespace

from scripts.ask_as_muse import main, status


def result(text: str, is_error: bool = False):
    return SimpleNamespace(content=[SimpleNamespace(text=text)], is_error=is_error)


def test_a_job_and_a_shared_result():
    assert status(result('{"status": "waiting", "job_id": "j1"}')) == {"status": "waiting", "job_id": "j1"}
    assert status(result("[Student A] wrote a thesis")) == {"status": "shared"}
    assert status(result("no", is_error=True)) == {"status": "failed"}


def test_it_says_when_the_connector_is_not_running(monkeypatch, capsys):
    monkeypatch.setenv("CONNECTOR_PORT", "9")
    monkeypatch.setattr("sys.argv", ["ask_as_muse", "rubric"])
    assert main() == 1
    assert "isn't running" in capsys.readouterr().err
