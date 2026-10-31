"""Plugging a local GGUF in as the device's model, and comparing the router modes."""

from __future__ import annotations

import stat
import subprocess

from base.config import REPO_ROOT, load_settings, read_dotenv
from scripts import compare_modes, device_smoke
from scripts import plug_in_model as plug


def test_the_smoke_test_copies_only_the_invented_class(tmp_path):
    root = tmp_path / "w"
    device_smoke.copy_invented(root)
    assert {p.name for p in root.iterdir()} <= {"essays", "records", "forms", "rubric.md"}
    # Every copied file is tracked in git: personal files in demo/ never are.
    tracked = set(subprocess.check_output(["git", "ls-files", "demo"], cwd=REPO_ROOT, text=True).splitlines())
    assert {f"demo/{p.relative_to(root)}" for p in root.rglob("*") if p.is_file() and p.name != ".DS_Store"} <= tracked


def gguf(tmp_path, size=16):
    path = tmp_path / "tuned.gguf"
    path.write_bytes(b"GGUF" + b"\0" * size)
    return path


def test_the_file_must_exist_be_a_gguf_and_fit_in_memory(tmp_path):
    assert "No file" in plug.check_model(tmp_path / "none.gguf", 36)[0]
    other = tmp_path / "a.txt"
    other.write_text("hello")
    assert "not a GGUF" in plug.check_model(other, 36)[0]
    model = gguf(tmp_path)
    assert plug.check_model(model, 36) == [] and plug.check_model(model, None) == []
    assert "memory" in plug.check_model(model, 2)[0]


def test_plugging_in_sets_only_the_models_lines_and_undo_restores_them(tmp_path):
    env = tmp_path / ".env"
    before = "# keep this\nOPENROUTER_API_KEY=secret\nPRIMARY_MODEL=lfm\nCHECKER_SERVER_BIN=/x/llama-server\n"
    env.write_text(before)
    plug.plug_in(gguf(tmp_path), env)
    values = read_dotenv(env)
    assert values["PRIMARY_MODEL"] == "glimmer" and values["GLIMMER_BACKEND"] == "llama_server"
    assert values["GLIMMER_GGUF"].endswith("tuned.gguf") and values["CHECKER_BACKEND"] == "lfm" and values["DEVICE_ONLY"] == "1"
    assert values["LLAMA_SERVER_BIN"] == "/x/llama-server" and values["OPENROUTER_API_KEY"] == "secret"
    assert "# keep this" in env.read_text() and env.read_text().count("PRIMARY_MODEL=") == 1
    assert stat.S_IMODE(env.stat().st_mode) == 0o600
    plug.plug_in(gguf(tmp_path), env)  # a second model keeps the first backup
    assert plug.undo(env) and env.read_text() == before
    assert not plug.undo(env)


def test_the_plugged_in_settings_load_as_one_local_server(tmp_path):
    env = tmp_path / ".env"
    plug.plug_in(gguf(tmp_path), env)
    s = load_settings({**read_dotenv(env), "BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(tmp_path), "CHECKER_API_KEY": "k"})
    assert s.device_only and s.primary_model == "glimmer" and not s.is_cloud_backend and s.checker_backend == "lfm"
    assert s.router_url == s.answer_url == "http://127.0.0.1:8081/v1" and s.checker_url == "http://127.0.0.1:8083/v1"
    assert s.dreaming_backend == "rules"


def test_the_summary_line_is_read_and_a_failed_run_shows_in_the_table():
    line = "x: accuracy 73.5%, agreement 73.5%, approval requests 90, leaks 0, errors 1, fallbacks 2, p95 0 ms over 200 items"
    row = compare_modes.parse_summary(line)
    assert row == {"accuracy": "73.5", "asked": "90", "leaks": "0", "errors": "1", "fallbacks": "2"}
    assert compare_modes.parse_summary("Traceback") is None
    text = "\n".join(compare_modes.table([("Rules", row), ("Prompt", None)]))
    assert "| Rules | 73.5% | 90 | 0 | 3 |" in text and "did not finish" in text
