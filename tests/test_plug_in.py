"""Plugging a local GGUF in as the device's model, and comparing the router modes."""

from __future__ import annotations

import dataclasses
import json
import stat
import subprocess

import pytest

from base.config import REPO_ROOT, load_settings, read_dotenv
from scripts import compare_modes, device_smoke
from scripts import plug_in_model as plug
from tests.gguf_helpers import glimmer_like


def test_the_smoke_test_copies_only_the_invented_class(tmp_path):
    root = tmp_path / "w"
    device_smoke.copy_invented(root)
    assert {p.name for p in root.iterdir()} <= {"essays", "records", "forms", "rubric.md"}
    # Every copied file is tracked in git: personal files in demo/ never are.
    tracked = set(subprocess.check_output(["git", "ls-files", "demo"], cwd=REPO_ROOT, text=True).splitlines())
    assert {f"demo/{p.relative_to(root)}" for p in root.rglob("*") if p.is_file() and p.name != ".DS_Store"} <= tracked


def gguf(tmp_path, name="tuned.gguf", **kw):
    return glimmer_like(tmp_path / name, **kw)


def test_the_file_must_exist_be_a_gguf_and_fit_in_memory(tmp_path):
    assert "No model file" in plug.check_model(tmp_path / "none.gguf", 36)[0]
    other = tmp_path / "a.txt"
    other.write_text("hello")
    assert "not a GGUF" in plug.check_model(other, 36)[0]
    model = gguf(tmp_path)
    assert plug.check_model(model, 36) == [] and plug.check_model(model, None) == []
    assert "memory" in plug.check_model(model, 2)[0]


def test_the_check_reports_arch_quant_bits_and_kv_cache(tmp_path):
    model = gguf(tmp_path, vision=True)
    problems, facts = plug.inspect(model, 36, ctx=1 << 20, build=11669, free_gb=50)
    assert problems == []
    assert facts["Architecture"] == "glimmer-test" and facts["Quant type (general.file_type)"] == "IQ1_S"
    assert "IQ1_S x4" in facts["Tensor types"] and facts["Tensor type ids"] == "0, 1, 12, 19"
    params = 256 * 64 + 4 * 256 * 256 + 256 + 256 * 32 + 256 * 16
    assert facts["Effective bits per weight"].startswith(f"{model.stat().st_size * 8 / params:.3f} ")
    assert "Effective bits per weight, text only" in facts and "2 vision tensors" in facts["Vision"]
    assert facts["KV cache at 1,048,576 tokens"] == "1.00 GB" and facts["Vocabulary"] == "5,000 tokens"
    assert "mentions reasoning_strength: yes" in facts["Chat template"] and len(facts["sha256"]) == 64
    assert facts["llama-server build"] == "11669"


@pytest.mark.parametrize(
    ("kw", "message"),
    [
        ({"free_gb": 1.5}, "disk"),
        ({"build": 9000}, "b10353"),
        ({"extra": [("odd.weight", (64,), 99)]}, "unknown (99) (id 99)"),
    ],
)
def test_the_check_refuses_low_disk_old_llama_cpp_and_unknown_types(tmp_path, kw, message):
    extra = kw.pop("extra", ())
    problems, _facts = plug.inspect(gguf(tmp_path, extra=extra), 36, **{"free_gb": 50, "build": 11669, **kw})
    assert len(problems) == 1 and message in problems[0]


def test_a_vision_projector_is_not_a_model(tmp_path):
    problems, _ = plug.inspect(gguf(tmp_path, **{"general.architecture": "clip"}), 36, free_gb=50)
    assert "vision projector" in problems[0]


def test_the_drafter_must_share_the_vocabulary_and_counts_toward_memory(tmp_path):
    model = gguf(tmp_path)
    ok = gguf(tmp_path, "draft.gguf", **{"general.architecture": "dflash-test"})
    problems, facts = plug.inspect(model, 36, draft=ok, free_gb=50, hash_file=False)
    assert problems == [] and facts["Drafter fits"] == "vocabulary matches" and "dflash-test" in facts["Drafter"]
    bad = gguf(tmp_path, "other.gguf", vocab=4999)
    problems, _ = plug.inspect(model, 36, draft=bad, free_gb=50, hash_file=False)
    assert "vocabulary (4,999 tokens) does not match the model's (5,000)" in problems[0]
    assert "No drafter file" in plug.inspect(model, 36, draft=tmp_path / "none.gguf")[0][0]


def six_gib(monkeypatch):
    """gguf_info.read as usual, but every file says it is 6.1 GiB (the 1.6-bit Glimmer's size)."""
    real = plug.gguf_info.read
    monkeypatch.setattr(plug.gguf_info, "read", lambda p: dataclasses.replace(real(p), file_bytes=int(6.1 * plug.GIB)))


def test_a_6_gib_file_fits_an_8_gb_jetson_but_not_an_8_gb_laptop(tmp_path, monkeypatch):
    six_gib(monkeypatch)
    model = gguf(tmp_path)
    kw = {"free_gb": 50, "build": 11972, "hash_file": False, "ctx": plug.DEFAULT_CTX["jetson"]}
    assert plug.inspect(model, 7.4, margin_gb=plug.MARGIN_GB["jetson"], **kw)[0] == []
    [problem] = plug.inspect(model, 7.4, margin_gb=plug.MARGIN_GB["laptop"], **kw)[0]
    assert "4 GB for everything else, more than this device's 7.4 GB" in problem
    # the KV cache at the configured context counts too: a long context no longer fits the board
    assert plug.inspect(model, 7.4, margin_gb=1, **{**kw, "ctx": 1 << 22})[0]


def test_on_a_jetson_the_check_keeps_1_gb_with_a_warning_and_counts_the_units_context(tmp_path, monkeypatch, capsys):
    six_gib(monkeypatch)
    monkeypatch.setattr(plug, "ENV", tmp_path / ".env")
    monkeypatch.delenv("ANSWER_CTX", raising=False)
    monkeypatch.setenv("BASE_DEVICE", "jetson")
    monkeypatch.setattr(plug, "total_memory_gb", lambda: 7.4)
    monkeypatch.setattr(plug.gguf_info, "llama_build", lambda _bin: 11972)
    monkeypatch.setattr(plug, "free_disk_gb", lambda _p: 50.0)
    out = tmp_path / "r"
    assert plug.main([str(gguf(tmp_path)), "--check", "--out", str(out)]) == 0
    assert "headless board" in capsys.readouterr().err
    text = (out / "model_file_tuned.md").read_text()
    assert "| KV cache at 4,096 tokens |" in text and "| Device | jetson, 1 GB kept" in text
    assert plug.main([str(gguf(tmp_path)), "--check", "--margin", "4", "--out", str(out)]) == 1
    assert plug.main([str(gguf(tmp_path)), "--check", "--device", "laptop", "--out", str(out)]) == 1


def test_the_jetson_context_default_is_the_units():
    unit = (REPO_ROOT / "deploy" / "jetson" / "muse-privacy-glimmer.service").read_text()
    assert f" -c {plug.DEFAULT_CTX['jetson']} " in unit


def test_check_writes_a_report_with_no_folders_and_leaves_env_alone(tmp_path, monkeypatch, capsys):
    env = tmp_path / ".env"
    env.write_text("PRIMARY_MODEL=lfm\n")
    monkeypatch.setattr(plug, "ENV", env)
    monkeypatch.setattr(plug.gguf_info, "llama_build", lambda _bin: 11669)
    monkeypatch.setattr(plug, "free_disk_gb", lambda _p: 50.0)
    monkeypatch.setattr(plug, "plug_in", lambda *a, **k: pytest.fail("--check changed .env"))
    model, draft = gguf(tmp_path), gguf(tmp_path, "draft.gguf")
    out = tmp_path / "reports"
    argv = [str(model), "--check", f"--draft={draft}", "--label", "glimmer1bit", "--ctx", "2048", "--out", str(out)]
    assert plug.main(argv) == 0
    text = (out / "model_file_glimmer1bit.md").read_text()
    assert "Command: `uv run python -m scripts.plug_in_model tuned.gguf --check --draft=draft.gguf --label glimmer1bit" in text
    assert str(tmp_path) not in text and "/Users/" not in text and "Result: can be plugged in." in text
    assert "| Effective bits per weight |" in text and "| KV cache at 2,048 tokens |" in text
    assert env.read_text() == "PRIMARY_MODEL=lfm\n" and "can be plugged in" in capsys.readouterr().out


def test_a_refused_file_still_gets_its_report(tmp_path, monkeypatch):
    monkeypatch.setattr(plug.gguf_info, "llama_build", lambda _bin: 11669)
    monkeypatch.setattr(plug, "free_disk_gb", lambda _p: 0.5)
    out = tmp_path / "reports"
    assert plug.main([str(gguf(tmp_path)), "--check", "--out", str(out)]) == 1
    assert "Result: refused." in (out / "model_file_tuned.md").read_text()


def test_the_drafter_and_server_knobs_go_in_env_and_undo_restores_it_byte_for_byte(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    before = "# keep\nPRIMARY_MODEL=lfm\nGLIMMER_FA=auto\n"
    env.write_text(before)
    monkeypatch.setattr(plug, "ENV", env)
    monkeypatch.setattr(plug.gguf_info, "llama_build", lambda _bin: 11669)
    monkeypatch.setattr(plug, "free_disk_gb", lambda _p: 50.0)
    model, draft = gguf(tmp_path), gguf(tmp_path, "draft.gguf")
    argv = [str(model), "--draft", str(draft), "--draft-n", "7", "--flash-attn", "on", "--reasoning-budget", "0",
            "--out", str(tmp_path / "r")]
    assert plug.main(argv) == 0
    values = read_dotenv(env)
    assert values["GLIMMER_DRAFT_GGUF"].endswith("draft.gguf") and values["GLIMMER_DRAFT_N"] == "7"
    assert values["GLIMMER_FA"] == "on" and env.read_text().count("GLIMMER_FA=") == 1
    assert values["GLIMMER_REASONING_BUDGET"] == "0" and values["PRIMARY_MODEL"] == "glimmer"
    plug.plug_in(model, env)  # the same model again with no drafter: the old drafter line is emptied
    assert read_dotenv(env)["GLIMMER_DRAFT_GGUF"] == "" and read_dotenv(env)["GLIMMER_DRAFT_N"] == "7"
    assert plug.main(["--undo"]) == 0 and env.read_bytes() == before.encode()
    with pytest.raises(SystemExit):
        plug.main([str(model), "--draft-n", "0"])


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


def test_the_summary_json_is_read_and_a_failed_run_shows_in_the_table(tmp_path):
    path = tmp_path / "rules.json"
    path.write_text(json.dumps({"accuracy": 0.735, "agreement": 0.7, "approval_requests": 90, "leaks": 0,
                                "errors": 1, "fallbacks": 2}))  # fmt: skip
    row = compare_modes.read_summary(path)
    assert compare_modes.read_summary(tmp_path / "missing.json") is None
    text = "\n".join(compare_modes.table([("Rules", row), ("Prompt", None)]))
    assert "| Mode | Decision accuracy |" in text and "Agreement" not in text  # it was accuracy all along
    assert "| Rules | 73.5% | 90 | 0 | 3 |" in text and "did not finish" in text
