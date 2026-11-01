"""Server entry point tests. No model runs; the only sockets opened bind 127.0.0.1 on free ports."""

from __future__ import annotations

import asyncio
import dataclasses
import re
import signal
from types import SimpleNamespace

import pytest
from fastapi import FastAPI

from base import server
from base.server import UnsafeBind, check_bind, main, make_servers, serve


def fake_services(settings):
    approvals = SimpleNamespace(pending=lambda: [], history=lambda limit=50: [], get=lambda i: None)
    return SimpleNamespace(settings=settings, approvals=approvals)


def test_main_refuses_non_loopback_laptop(settings, monkeypatch, capsys):
    def must_not_build(_settings):
        raise AssertionError("services were built for an unsafe bind")

    monkeypatch.setattr(server, "build_services", must_not_build)
    monkeypatch.setattr(server, "run_servers", must_not_build)
    for host in ("0.0.0.0", "192.0.2.11", "::"):
        assert main(dataclasses.replace(settings, approval_host=host)) == 2
        assert "Not starting" in capsys.readouterr().err


def test_check_bind():
    laptop = SimpleNamespace(device="laptop", approval_host="0.0.0.0")
    with pytest.raises(UnsafeBind):
        check_bind(laptop)
    for host in ("127.0.0.1", "localhost", "::1"):
        check_bind(SimpleNamespace(device="laptop", approval_host=host))
    check_bind(SimpleNamespace(device="jetson", approval_host="0.0.0.0"))


def _wire(monkeypatch, captured):
    monkeypatch.setattr(server, "build_services", fake_services)
    monkeypatch.setattr(server, "load_connector_app", lambda services: FastAPI())
    monkeypatch.setattr(server, "run_servers", captured.extend)


def test_main_wires_two_servers_on_laptop(settings, monkeypatch, capsys):
    captured = []
    _wire(monkeypatch, captured)
    assert main(settings) == 0
    approval, connector = captured
    assert (approval.config.host, approval.config.port) == ("127.0.0.1", settings.approval_port)
    assert (connector.config.host, connector.config.port) == ("127.0.0.1", settings.connector_port)
    assert approval.config.access_log is False
    out = capsys.readouterr().out
    assert "Pairing code" not in out and "this device only" in out


def test_main_prints_pairing_code_off_loopback(settings, monkeypatch, capsys):
    captured = []
    _wire(monkeypatch, captured)
    jetson = dataclasses.replace(settings, device="jetson", approval_host="0.0.0.0", heavy_queue=False)
    assert main(jetson) == 0
    approval, connector = captured
    assert approval.config.host == "0.0.0.0"
    assert connector.config.host == "127.0.0.1"  # the connector never leaves loopback
    out = capsys.readouterr().out
    match = re.search(r"Pairing code for the approval page: (\d{6})\.", out)
    assert match, out
    assert approval.config.app.state.pairing.redeem(match.group(1))


async def test_serve_stops_both_servers_on_sigint(settings):
    local = dataclasses.replace(settings, approval_port=0, connector_port=0)
    servers = make_servers(local, FastAPI(), FastAPI())
    task = asyncio.create_task(serve(servers))
    for _ in range(200):
        if all(s.started for s in servers):
            break
        await asyncio.sleep(0.05)
    assert all(s.started for s in servers)
    # serve() owns SIGINT now; never raise it if the default handler is still in place.
    assert signal.getsignal(signal.SIGINT) is not signal.default_int_handler
    signal.raise_signal(signal.SIGINT)
    await asyncio.wait_for(task, timeout=10)
    assert all(s.should_exit for s in servers)
    assert signal.getsignal(signal.SIGINT) is signal.default_int_handler


async def test_serve_stops_the_other_server_when_one_exits(settings):
    local = dataclasses.replace(settings, approval_port=0, connector_port=0)
    servers = make_servers(local, FastAPI(), FastAPI())
    task = asyncio.create_task(serve(servers))
    for _ in range(200):
        if all(s.started for s in servers):
            break
        await asyncio.sleep(0.05)
    servers[1].should_exit = True
    await asyncio.wait_for(task, timeout=10)
    assert servers[0].should_exit


def test_port_in_use_is_one_plain_sentence(settings, monkeypatch, capsys):
    # Review correctness F10: uvicorn exits on a bind failure; the user sees one sentence.
    monkeypatch.setattr(server, "build_services", fake_services)
    monkeypatch.setattr(server, "load_connector_app", lambda services: FastAPI())

    def busy(servers):
        raise SystemExit(1)

    monkeypatch.setattr(server, "run_servers", busy)
    assert main(settings) == 3
    err = capsys.readouterr().err
    assert "already in use" in err and "Traceback" not in err


def test_tls_settings_reach_the_approval_server(settings, monkeypatch, tmp_path):
    captured = []
    _wire(monkeypatch, captured)
    jetson = dataclasses.replace(
        settings, device="jetson", approval_host="0.0.0.0", heavy_queue=False,
        approval_tls_cert=tmp_path / "c.pem", approval_tls_key=tmp_path / "k.pem",
    )  # fmt: skip
    assert main(jetson) == 0
    approval, connector = captured
    assert approval.config.ssl_certfile == str(tmp_path / "c.pem")
    assert connector.config.ssl_certfile is None and approval.config.limit_concurrency == 64
