"""End to end across languages: the real relay Worker, the real relay client, the real connector app.

    RUN_INTEGRATION=1 uv run pytest tests/test_relay_e2e.py -q    # as a test
    uv run python tests/test_relay_e2e.py                         # by hand, printing each step

Everything runs on this machine and binds 127.0.0.1 only; nothing is deployed:
- the Worker runs under `npx wrangler dev --local` on a fixed port (RELAY_E2E_PORT, default 8796), with
  a throwaway PAIRING_PEPPER in a temp .dev.vars and its state in a temp folder;
- the connector app (base.connector.server.connector_app) runs under uvicorn with fake services whose
  egress swaps an invented name for a tag;
- base.connector.relay_client registers, pairs and runs against the Worker;
- httpx plays Muse: OAuth discovery, dynamic client registration, the authorize page with the pairing
  code and PKCE, the token exchange, then MCP initialize, tools/list and tools/call through POST /mcp.
Needs relay/node_modules (cd relay && npm ci --legacy-peer-deps). All data is invented.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import json
import logging
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
import pytest
import uvicorn

from base.config import load_settings
from base.connector import relay_client as rc
from base.connector.server import connector_app

pytestmark = pytest.mark.integration

REPO = Path(__file__).resolve().parents[1]
RELAY_DIR = REPO / "relay"
RELAY_PORT = int(os.environ.get("RELAY_E2E_PORT", "8796"))
REDIRECT_URI = "https://muse.example.com/oauth/callback"
REAL_NAME = "Zephyrine Quoll"  # invented
TAG = "[Student A]"
TOOLS = {
    "list_documents",
    "search_documents",
    "run_private_task",
    "get_result",
    "run_dreaming",
    "dreaming_report",
}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def port_is_free(port: int) -> bool:
    """True when nothing listens on 127.0.0.1:port (a bind test would trip on TIME_WAIT sockets)."""
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
    except OSError:
        return True
    return False


# The Worker under wrangler dev


class LocalWorker:
    """`npx wrangler dev --local` on 127.0.0.1:RELAY_PORT, stopped with its whole process group."""

    def __init__(self, workdir: Path, port: int = RELAY_PORT):
        self.port = port
        self.url = f"http://127.0.0.1:{port}"
        self.pepper = secrets.token_hex(32)  # a throwaway test value
        self.log_path = workdir / "wrangler.log"
        self.dev_vars = workdir / ".dev.vars"
        self.state = workdir / "wrangler-state"
        self.workdir = workdir
        self.proc: subprocess.Popen | None = None

    def start(self) -> None:
        if not port_is_free(self.port):
            raise RuntimeError(f"Port {self.port} on 127.0.0.1 is busy. Set RELAY_E2E_PORT to a free port.")
        fd = os.open(self.dev_vars, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(f"PAIRING_PEPPER={self.pepper}\n")
        # Only what npx needs from this shell: no keys, tokens or proxies reach wrangler.
        env = {k: os.environ[k] for k in ("PATH", "HOME", "TMPDIR") if k in os.environ}
        env |= {
            "WRANGLER_SEND_METRICS": "false",
            "WRANGLER_SEND_ERROR_REPORTS": "false",
            "CLOUDFLARE_CF_FETCH_ENABLED": "false",  # no request.cf download from the internet
            "WRANGLER_LOG_PATH": str(self.workdir / "wrangler-logs"),
            "NO_COLOR": "1",
        }
        cmd = [
            "npx", "wrangler", "dev", "--local",
            "--ip", "127.0.0.1", "--port", str(self.port),
            "--inspector-ip", "127.0.0.1", "--inspector-port", str(free_port()),
            "--persist-to", str(self.state),
            "--env-file", str(self.dev_vars),
            "--show-interactive-dev-session=false",
        ]  # fmt: skip
        log = open(self.log_path, "w")  # closed in stop()
        self.proc = subprocess.Popen(
            cmd, cwd=RELAY_DIR, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True,
        )  # fmt: skip
        self._log = log

    async def wait_ready(self, timeout: float = 90.0) -> None:
        deadline = time.monotonic() + timeout
        async with httpx.AsyncClient(trust_env=False, timeout=2) as http:
            while time.monotonic() < deadline:
                if self.proc.poll() is not None:
                    raise RuntimeError(f"wrangler dev exited early:\n{self.log_tail()}")
                try:
                    if (await http.get(f"{self.url}/health")).status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.5)
        raise RuntimeError(f"wrangler dev did not answer within {timeout:.0f} s:\n{self.log_tail()}")

    def log_text(self) -> str:
        try:
            return self.log_path.read_text(errors="replace")
        except FileNotFoundError:
            return ""

    def log_tail(self, lines: int = 40) -> str:
        return "\n".join(self.log_text().replace(self.pepper, "<pepper>").splitlines()[-lines:])

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            for sig, wait in ((signal.SIGTERM, 10), (signal.SIGKILL, 5)):
                try:
                    os.killpg(self.proc.pid, sig)
                    self.proc.wait(wait)
                    break
                except subprocess.TimeoutExpired:
                    continue
                except ProcessLookupError:
                    break
        if getattr(self, "_log", None):
            self._log.close()


# The device: connector app with fake services, and the relay client


class TaggingEgress:
    """Stands in for base.egress: sees the raw text on the device, returns it with the name tagged."""

    def __init__(self):
        self.raw: list[str] = []

    def release(self, tool, request, raw_text, result_kind, **kw):
        self.raw.append(raw_text)
        return SimpleNamespace(status="shared", text=raw_text.replace(REAL_NAME, TAG), approval_id=None)


def fake_services(settings) -> SimpleNamespace:
    docs = [SimpleNamespace(id="d1", path=f"essays/{REAL_NAME} essay.md", title=f"{REAL_NAME} essay")]
    return SimpleNamespace(
        settings=settings,
        egress=TaggingEgress(),
        index=SimpleNamespace(list=lambda folder: docs),
        tagmap={},
        audit=None,
    )


def device_settings(home: Path, relay_url: str, connector_port: int):
    return load_settings(
        {
            "BASE_DEVICE": "laptop",
            "BASE_HOME": str(home),
            "GLIMMER_BACKEND": "openrouter",
            "OPENROUTER_API_KEY": "test-key",
            "CONNECTOR_PORT": str(connector_port),
            "RELAY_URL": relay_url,
        }
    )


# Muse, played by httpx


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def rpc_body(response: httpx.Response) -> dict:
    """The JSON-RPC message in a response, whether it came as JSON or as one collapsed SSE body."""
    if response.headers.get("content-type", "").startswith("text/event-stream"):
        data = [line[5:].strip() for line in response.text.splitlines() if line.startswith("data:")]
        return json.loads(data[-1])
    return response.json()


async def open_authorize(http: httpx.AsyncClient, url: str) -> tuple[str, str]:
    """GET the authorize page as the user's browser would: returns (consent handle, cookie)."""
    page = await http.get(url)
    assert page.status_code == 200, page.status_code
    match = re.search(r'name="handle" value="([^"]+)"', page.text)
    assert match, "the authorize page has no consent handle"
    assert "Pairing code" in page.text and "Muse Privacy" in page.text
    cookie = page.headers.get("set-cookie", "").split(";")[0]
    assert "=" in cookie, "the authorize page set no consent cookie"
    return html.unescape(match.group(1)), cookie


async def submit_code(
    http: httpx.AsyncClient, url: str, handle: str, cookie: str, code: str
) -> httpx.Response:
    form = {"handle": handle, "code": code, "decision": "link"}
    return await http.post(url, data=form, headers={"cookie": cookie})


async def run_e2e(workdir: Path, say: Callable[[str], None] = lambda _: None) -> dict:
    """Run the whole path once. Raises AssertionError at the first step that does not hold."""
    worker = LocalWorker(workdir)
    connector_port = free_port()
    settings = device_settings(workdir / "home", worker.url, connector_port)
    settings.ensure_home()
    services = fake_services(settings)
    server = uvicorn.Server(
        uvicorn.Config(
            connector_app(services), host="127.0.0.1", port=connector_port, log_level="warning", lifespan="on"
        )
    )
    tasks: list[asyncio.Task] = []
    clients: list[rc.RelayClient] = []
    try:
        say(f"starting wrangler dev on {worker.url}")
        worker.start()
        tasks.append(asyncio.create_task(server.serve()))
        await worker.wait_ready()
        while not server.started:
            await asyncio.sleep(0.05)
        say(f"worker ready; connector on 127.0.0.1:{connector_port}")

        # The device registers, makes a pairing code, and dials out.
        local = httpx.AsyncClient(trust_env=False, timeout=20)
        device_id = await rc.register(settings, "E2E test laptop", relay_url=worker.url, http=local)
        paired = await rc.pair(settings, http=local)
        await local.aclose()
        code = paired["code"]
        assert re.fullmatch(r"[2-9A-HJ-NP-Z]{8}", code) and paired["expires_in"] == 600
        clients.append(rc.client_for(settings))
        tasks.append(asyncio.create_task(clients[0].run()))
        say(f"device {device_id} registered, pairing code issued, relay client running")

        async with httpx.AsyncClient(trust_env=False, timeout=30, follow_redirects=False) as http:
            init = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "muse-e2e", "version": "1"},
                },
            }
            mcp_url = f"{worker.url}/mcp"

            # Discovery: 401 points at the protected resource metadata, which names the auth server.
            denied = await http.post(mcp_url, json=init)
            assert denied.status_code == 401, denied.status_code
            prm_url = re.search(r'resource_metadata="([^"]+)"', denied.headers["www-authenticate"]).group(1)
            prm = (await http.get(prm_url)).json()
            assert prm["resource"] == mcp_url, prm
            issuer = prm["authorization_servers"][0]
            meta = (await http.get(f"{issuer}/.well-known/oauth-authorization-server")).json()
            assert meta["issuer"] == issuer and "S256" in meta["code_challenge_methods_supported"]
            assert meta["client_id_metadata_document_supported"] is True
            say("discovered OAuth metadata (DCR and CIMD both advertised)")

            # Dynamic client registration.
            registered = await http.post(
                meta["registration_endpoint"],
                json={
                    "client_name": "Muse (e2e test)",
                    "redirect_uris": [REDIRECT_URI],
                    "token_endpoint_auth_method": "none",
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                },
            )
            assert registered.status_code == 201, registered.text
            client_id = registered.json()["client_id"]
            say("registered a client by DCR")

            # Authorize with PKCE; the user types the pairing code on the relay's page.
            verifier = b64url(secrets.token_bytes(32))
            query = {
                "response_type": "code",
                "client_id": client_id,
                "redirect_uri": REDIRECT_URI,
                "state": "e2e-state",
                "scope": "mcp",
                "code_challenge": b64url(hashlib.sha256(verifier.encode()).digest()),
                "code_challenge_method": "S256",
                "resource": prm["resource"],
            }
            authorize_url = f"{meta['authorization_endpoint']}?{urlencode(query)}"
            handle, cookie = await open_authorize(http, authorize_url)
            linked = await submit_code(http, authorize_url, handle, cookie, code.lower())
            assert linked.status_code == 302, (linked.status_code, linked.text[:200])
            location = urlsplit(linked.headers["location"])
            assert f"{location.scheme}://{location.netloc}{location.path}" == REDIRECT_URI
            params = {k: v[0] for k, v in parse_qs(location.query).items()}
            assert params["state"] == "e2e-state" and params["code"]
            assert params.get("iss", issuer) == issuer
            say("authorized with the pairing code")

            # Token exchange.
            token = await http.post(
                meta["token_endpoint"],
                data={
                    "grant_type": "authorization_code",
                    "code": params["code"],
                    "redirect_uri": REDIRECT_URI,
                    "client_id": client_id,
                    "code_verifier": verifier,
                    "resource": prm["resource"],
                },
            )
            assert token.status_code == 200, token.text
            tokens = token.json()
            assert tokens["scope"] == "mcp" and tokens["access_token"] and tokens["refresh_token"]
            say("exchanged the code for tokens")

            # MCP through the relay, the relay client and the connector.
            headers = {
                "authorization": f"Bearer {tokens['access_token']}",
                "accept": "application/json, text/event-stream",
            }
            deadline = time.monotonic() + 20
            while True:  # the device socket may still be opening
                started = await http.post(mcp_url, json=init, headers=headers)
                if started.status_code != 503 or time.monotonic() > deadline:
                    break
                await asyncio.sleep(0.25)
            assert started.status_code == 200, (started.status_code, started.text[:200])
            result = rpc_body(started)["result"]
            assert result["serverInfo"]["name"] == "muse-privacy"
            headers["mcp-protocol-version"] = result["protocolVersion"]
            say(f"initialize answered by the device (protocol {result['protocolVersion']})")

            note = await http.post(
                mcp_url, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=headers
            )
            assert note.status_code == 202, note.status_code

            listed = await http.post(
                mcp_url, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers=headers
            )
            assert listed.status_code == 200, listed.status_code
            names = {tool["name"] for tool in rpc_body(listed)["result"]["tools"]}
            assert names == TOOLS, names
            say(f"tools/list returned {len(names)} tools")

            call = {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "list_documents", "arguments": {"folder": ""}},
            }
            called = await http.post(mcp_url, json=call, headers=headers)
            assert called.status_code == 200, called.status_code
            text = rpc_body(called)["result"]["content"][0]["text"]
            assert f"{TAG} essay" in text, text
            assert REAL_NAME not in called.text
            assert any(REAL_NAME in raw for raw in services.egress.raw)  # the raw text stayed on the device
            say("tools/call list_documents came back tagged")

            # The pairing code is single use: a fresh authorize page refuses it.
            handle2, cookie2 = await open_authorize(http, authorize_url)
            again = await submit_code(http, authorize_url, handle2, cookie2, code)
            assert again.status_code == 400, again.status_code
            assert "That code did not work" in again.text
            say("a second use of the pairing code was refused")

            # A second client with the same secret: the relay closes the first (4000) and it stops.
            clients.append(rc.client_for(settings))
            tasks.append(asyncio.create_task(clients[1].run()))
            done, _ = await asyncio.wait({tasks[1]}, timeout=15)
            assert done and isinstance(tasks[1].exception(), rc.RelayReplacedError), done
            deadline = time.monotonic() + 20
            while True:
                relisted = await http.post(
                    mcp_url, json={"jsonrpc": "2.0", "id": 4, "method": "tools/list"}, headers=headers
                )
                if relisted.status_code != 503 or time.monotonic() > deadline:
                    break
                await asyncio.sleep(0.25)
            assert relisted.status_code == 200, relisted.status_code
            say("a second copy of the client replaced the first, which stopped; MCP still works")

        assert worker.pepper not in worker.log_text(), "wrangler printed the pepper"
        return {"device_id": device_id, "tools": sorted(names), "protocol": result["protocolVersion"]}
    finally:
        server.should_exit = True
        for task in tasks[1:]:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for client in clients:
            await client.aclose()
        worker.stop()


async def test_relay_end_to_end(tmp_path):
    if not (RELAY_DIR / "node_modules" / ".bin" / "wrangler").exists():
        pytest.skip("relay/node_modules is missing: cd relay && npm ci --legacy-peer-deps")
    summary = await run_e2e(tmp_path)
    assert summary["tools"] == sorted(TOOLS)


def main() -> int:
    for noisy in ("httpx", "httpcore", "websockets", "mcp", "base.relay"):  # keep the step list readable
        logging.getLogger(noisy).setLevel(logging.WARNING)
    with tempfile.TemporaryDirectory(prefix="relay-e2e-") as tmp:
        asyncio.run(run_e2e(Path(tmp), say=lambda msg: print(f"- {msg}", flush=True)))
    print("relay end to end: every step passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
