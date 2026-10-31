"""scripts/glimmer_probe.py: the first look at a Glimmer file's replies, shape only."""

from __future__ import annotations

import httpx
import respx

from scripts import glimmer_probe as gp

URL = "http://127.0.0.1:8181/v1"
SECRET_WORDS = "invented reply text"


def reply(content, *, finish="stop", reasoning=0, **message):
    return httpx.Response(200, json={
        "choices": [{"message": {"content": content, **message}, "finish_reason": finish}],
        "usage": {"completion_tokens_details": {"reasoning_tokens": reasoning}},
    })  # fmt: skip


def run(tmp_path, capsys, response):
    key = tmp_path / "k"
    key.write_text("test-key")
    with respx.mock(assert_all_called=False) as mock:
        mock.post(f"{URL}/chat/completions").mock(return_value=response)
        code = gp.main(["--url", URL, "--key-file", str(key), "--levels", "low"])
    return code, capsys.readouterr().out


def test_a_clean_reply_with_reasoning_in_its_own_field_passes(tmp_path, capsys):
    good = '{"decision": "share_tagged", "reason": "' + SECRET_WORDS + '"}'
    code, out = run(tmp_path, capsys, reply(good, reasoning=40, reasoning_content="thinking"))
    assert code == 0
    assert "parsed=True" in out and "reasoning_tokens=40" in out
    assert SECRET_WORDS not in out and "test-key" not in out


def test_reasoning_text_left_in_content_fails_in_plain_words(tmp_path, capsys):
    code, out = run(tmp_path, capsys, reply('thinking first {"decision": "refuse", "reason": "x"}'))
    assert code == 1
    assert "parsed=False" in out and "reasoning text" in out


def test_json_outside_the_schema_fails(tmp_path, capsys):
    code, out = run(tmp_path, capsys, reply('{"decision": "maybe", "reason": "x"}'))
    assert code == 1 and "not the schema" in out


def test_a_server_error_is_reported_by_type_only(tmp_path, capsys):
    code, out = run(tmp_path, capsys, httpx.Response(400, json={"error": {"message": SECRET_WORDS}}))
    assert code == 1
    assert "finish=error" in out and SECRET_WORDS not in out


def test_only_this_device(tmp_path, capsys):
    key = tmp_path / "k"
    key.write_text("x")
    try:
        gp.main(["--url", "http://example.org/v1", "--key-file", str(key)])
    except SystemExit as exc:
        assert exc.code == 2
    else:
        raise AssertionError("a remote url must be refused")


def test_the_side_servers_script_stays_on_this_device_and_off_the_real_home(tmp_path):
    import os
    import subprocess
    from pathlib import Path

    script = Path(__file__).resolve().parent.parent / "scripts" / "start_side_models.sh"
    text = script.read_text()
    assert "--host 127.0.0.1" in text and "0.0.0.0" not in text
    assert subprocess.run(["bash", "-n", str(script)], check=False).returncode == 0
    gguf = tmp_path / "m.gguf"
    gguf.write_bytes(b"GGUF")
    (tmp_path / ".base").mkdir()
    done = subprocess.run(
        ["bash", str(script), str(gguf), str(tmp_path / ".base")],
        env={**os.environ, "HOME": str(tmp_path)}, capture_output=True, text=True, check=False,
    )  # fmt: skip
    assert done.returncode == 1 and "not the app's ~/.base" in done.stderr
