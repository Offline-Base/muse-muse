"""scripts/glimmer_probe.py: the first look at a Glimmer file's replies, shape only."""

from __future__ import annotations

import json
from dataclasses import replace

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


def test_the_side_servers_script_refuses_on_a_mac(tmp_path):
    import os
    import subprocess
    from pathlib import Path

    script = Path(__file__).resolve().parent.parent / "scripts" / "start_side_models.sh"
    fake = tmp_path / "bin"
    fake.mkdir()
    (fake / "uname").write_text("#!/bin/sh\necho Darwin\n")
    (fake / "uname").chmod(0o755)
    gguf = tmp_path / "m.gguf"
    gguf.write_bytes(b"GGUF")
    done = subprocess.run(
        ["bash", str(script), str(gguf), str(tmp_path / "side")],
        env={**os.environ, "HOME": str(tmp_path), "PATH": f"{fake}:{os.environ['PATH']}"}, capture_output=True, text=True, check=False,
    )  # fmt: skip
    assert done.returncode == 1 and "does not run on the owner's laptop" in done.stderr


def test_final_channel_keeps_only_the_answer():
    from base.local_llm import final_channel

    full = "<|start|>assistant to=self<|message|>private thought<|eom|><|start|>assistant to=user<|message|>The answer.<|eot|>"
    assert final_channel(full) == "The answer."
    assert final_channel("assistant to=self private thought assistant to=user The answer.") == "The answer."
    assert final_channel("<|start|>assistant to=self<|message|>private thought, no answer") == ""
    assert final_channel('{"decision": "refuse", "reason": "x"}') == '{"decision": "refuse", "reason": "x"}'
    assert final_channel("The answer.<|eot|><|start|>user<|message|>more") == "The answer."


def test_reasoning_off_sends_no_reasoning_at_all(tmp_path):
    settings = gp.load_settings({"BASE_HOME": str(tmp_path), "DEVICE_ONLY": "1", "PRIMARY_MODEL": "glimmer", "GLIMMER_BACKEND": "llama_server",
                                 "CHECKER_BACKEND": "glimmer", "GLIMMER_REASONING": "off", "LLAMA_API_KEY": "k"})  # fmt: skip
    llm = gp.LocalLLM(settings, "router")
    body = llm.build_body([{"role": "system", "content": "Reasoning strength: low\n\nDecide."}, {"role": "user", "content": "x"}], reasoning="high")
    assert "chat_template_kwargs" not in body
    assert "reasoning strength" not in body["messages"][0]["content"].lower()
    assert body["messages"][0]["content"] == "Decide."
    assert body["stop"] == ["<|eot|>", "<|end_of_text|>"]
    llm.close()
    on = gp.LocalLLM(replace(settings, glimmer_reasoning="on"), "router")
    with_reasoning = on.build_body([{"role": "user", "content": "x"}], reasoning="high")
    assert with_reasoning["chat_template_kwargs"] == {"reasoning_strength": "high"} and "stop" not in with_reasoning
    on.close()


def test_a_failure_on_free_text_alone_fails_the_probe(tmp_path, capsys):
    key = tmp_path / "k"
    key.write_text("test-key")
    good = reply('{"decision": "share_tagged", "reason": "x"}')

    def answer(request):
        body = json.loads(request.content)
        return good if "response_format" in body else httpx.Response(500, json={"error": {"message": SECRET_WORDS}})

    with respx.mock(assert_all_called=False) as mock:
        mock.post(f"{URL}/chat/completions").mock(side_effect=answer)
        code = gp.main(["--url", URL, "--key-file", str(key), "--levels", "off"])
    out = capsys.readouterr().out
    assert code == 1
    assert "off, free text: parsed=False" in out and "off, schema: parsed=True" in out and SECRET_WORDS not in out


def test_every_adapter_goes_to_scale_0_at_start(tmp_path):
    from types import SimpleNamespace

    from base.services import zero_adapter_scales

    (tmp_path / "router.gguf").write_bytes(b"GGUF")
    settings = SimpleNamespace(glimmer_backend="llama_server", paths=SimpleNamespace(adapters=tmp_path))
    posted = []

    def client(entries, post_status=200):
        return SimpleNamespace(
            get=lambda url, **k: httpx.Response(200, json=entries, request=httpx.Request("GET", url)),
            post=lambda url, json, **k: (posted.append(json), httpx.Response(post_status, request=httpx.Request("POST", url)))[1],
        )

    def llm(entries, **kw):
        return SimpleNamespace(base_url="http://127.0.0.1:8081/v1", headers=dict, client=client(entries, **kw))

    assert zero_adapter_scales(settings, llm([{"id": 0, "scale": 1.0, "path": "router.gguf"}]))
    assert posted == [[{"id": 0, "scale": 0.0}]]
    posted.clear()
    assert zero_adapter_scales(settings, llm([{"id": 0, "scale": 0.0}])) and not posted
    assert not zero_adapter_scales(settings, llm([{"id": 0, "scale": 1.0}], post_status=500))
    (tmp_path / "router.gguf").unlink()
    posted.clear()
    assert zero_adapter_scales(settings, llm([{"id": 0, "scale": 1.0}])) and not posted
