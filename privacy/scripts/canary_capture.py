"""Canary capture: plant an invented name in a document, run Muse's side of a request against the
device, record every request that leaves the device side, and check the name is in none of them.

The planner side (Muse) and the device side are split where the code splits them: the relay. A
scripted Muse sends MCP requests as relay frames; the real relay client (base/connector/relay_client.py)
forwards each one to the real connector app (in process, no port opened), the device's Services
do the work, and the frames the relay client sends back are what would cross the internet to the
relay and on to Muse. While it runs, this script records:

- every frame the relay client sends back toward the relay;
- every HTTP request any httpx client in the process makes (method, URL, headers, body), whether
  it goes to a model on this device (127.0.0.1) or anywhere else;
- every socket connection, name lookup and datagram the process tries, below httpx.

Off the device means a relay frame, or an HTTP request or socket to an address that is not
loopback. Off-device sockets are blocked as well as recorded (with --block all, every socket is).
The device's own model calls on 127.0.0.1 stay on the device: the name pass is meant to read raw
text, so the canary is expected there, and seeing it there shows the run read the document.

PASS: the canary (the whole name or any word of it of four letters or more, any case, URL-decoded
too) is in no off-device URL, header or body, nothing else tried to leave, the device's model
answered a request that held the canary, and the device shared at least one result. FAIL: it is in one, or something
tried to leave. INCONCLUSIVE: the model never answered a request holding the canary (not running,
or a wrong key), the device shared nothing, or the run stopped with an error, so the canary's
absence says nothing.

    uv run python -m scripts.canary_capture --log eval/reports/raw/canary_capture.jsonl
    uv run python -m scripts.canary_capture --checker-url http://127.0.0.1:8083/v1 --embed-url http://127.0.0.1:8084/v1

Needs DEVICE_ONLY=1 and the device's models already serving on loopback (scripts/start.sh), from
.env or the flags. It reads nothing from the real workspace: the canary document goes in a new
temporary folder marked `.synthetic`, with a throwaway BASE_HOME, so the live tag map and decision
log are not touched; only the llama-server key is read from the real BASE_HOME, so the model
answers. Each waiting result is approved the way a user would tap Share it, the worst case. The
log never holds a header value, an off-device address or a document; the canary is invented, in
ASCII letters, and is printed. Exit 0 pass, 1 fail, 2 inconclusive. tests/test_canary_capture.py
runs the same path with fake models; docs/CANARY.md says what it proves.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import secrets
import socket
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

import httpx

LOOPBACK = ("127.0.0.1", "::1", "localhost")
PROTOCOL = "2025-06-18"
PURPOSE = "for my own planning"
STEPS = [
    ("list_documents", {"folder": "canary"}),
    ("search_documents", {"query": "herons pond", "purpose": PURPOSE}),
    (
        "ask_device",
        {"question": "How many herons did the writer of the field notes count?", "purpose": PURPOSE},
    ),
    (
        "run_private_task",
        {"instructions": f"Summarize the field notes in one paragraph, {PURPOSE}.", "folder": "canary"},
    ),
]

# Syllables for an invented name no roster, word list or document here holds.
_HEADS = ("Qu", "Zy", "Vex", "Thr", "Kv", "Xan", "Bry", "Dr", "Gw", "Ysm")
_MIDS = ("ol", "ar", "en", "ix", "ub", "ae", "or", "yl", "um", "ez")
_TAILS = ("dra", "vik", "thas", "rune", "wick", "zel", "mont", "brook", "quist", "dell")


def make_canary(choice=secrets.choice) -> str:
    """Two capitalized invented words, different on every call, such as "Zyarvik Quolbrook"."""
    word = lambda: choice(_HEADS) + choice(_MIDS) + choice(_MIDS) + choice(_TAILS)  # noqa: E731
    first, last = word(), word()
    while last == first:
        last = word()
    return f"{first} {last}"


def plant(root: Path, canary: str) -> Path:
    """A synthetic workspace at `root` holding one invented document about the canary, in canary/."""
    first = canary.split()[0]
    folder = root / "canary"
    folder.mkdir(parents=True, exist_ok=True)
    (root / ".synthetic").write_text("Invented data for the canary capture.\n")
    doc = folder / f"{canary} field notes.md"
    doc.write_text(
        f"# {canary} field notes\n\n"
        f"Field notes by {canary}, Room 12.\n\n"
        f"On Tuesday {canary} counted eleven herons at the pond behind the school garden. "
        f"{first} wrote that the herons stood still for a long time before they caught a fish. "
        f"Next week {first} wants to measure how deep the pond is.\n"
    )
    (folder / "pond checklist.md").write_text(
        "# Pond checklist\n\nBring the clipboard, the tape measure and the bird guide.\n"
    )
    return doc


def forms(canary: str) -> list[str]:
    """The strings that count as the canary: the whole name and each of its words, lower case."""
    return sorted(
        {canary.lower(), *(w.lower() for w in canary.split() if len(w) >= 4)}, key=len, reverse=True
    )


def found_in(value: str | bytes, canary: str) -> bool:
    """Whether any form of the canary is in `value`, any case, as written or URL-decoded."""
    text = value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)
    texts = {text.lower(), unquote(text).lower(), unquote(text.replace("+", " ")).lower()}
    return any(f in t for f in forms(canary) for t in texts)


def is_loopback(host: str | None) -> bool:
    return (host or "").strip("[]").lower() in LOOPBACK


@dataclass
class Sent:
    """One thing the process sent: an HTTP request, a socket attempt or a relay frame."""

    channel: str  # "http", "socket" or "relay_frame"
    on_device: bool
    method: str = ""
    url: str = ""
    headers: list[tuple[str, str]] = field(default_factory=list)
    body: bytes = b""
    op: str = ""  # socket: connect, lookup or sendto
    port: int | None = None
    blocked: bool = False
    status: int | None = None  # http: the reply's status code, None when no reply came back

    @property
    def answered(self) -> bool:
        return self.status is not None and 200 <= self.status < 300

    def canary_in(self, canary: str) -> list[str]:
        """Which parts hold the canary: url, a header (by name), body."""
        where = ["url"] if found_in(self.url, canary) else []
        where += [f"header {k}" for k, v in self.headers if found_in(k, canary) or found_in(v, canary)]
        return where + (["body"] if self.body and found_in(self.body, canary) else [])

    def log_row(self, n: int, canary: str, salt: bytes = b"") -> dict:
        """The log line: no header value, no off-device address, no body. An off-device host is a
        short hash salted per log, so it tells hosts apart within one log and cannot be looked up."""
        row: dict[str, Any] = {"n": n, "channel": self.channel, "on_device": self.on_device}
        if self.channel == "http":
            parts = urlsplit(self.url)
            host = parts.hostname or ""
            shown = (
                "loopback"
                if self.on_device
                else "off-device host " + hashlib.sha256(salt + host.encode()).hexdigest()[:8]
            )
            path = parts.path if self.on_device else ""
            row.update(method=self.method, target=f"{parts.scheme}://{shown}:{parts.port or ''}{path}")
            row.update(query=bool(parts.query), header_names=sorted({k.lower() for k, _ in self.headers}))
            row.update(status=self.status)
        elif self.channel == "socket":
            row.update(op=self.op, port=self.port, blocked=self.blocked)
        row.update(body_bytes=len(self.body), canary_in=self.canary_in(canary))
        return row


class Capture:
    """Records every httpx request and socket attempt while it is active, below any client.

    `block="off_device"` refuses sockets to anything but loopback (a real run, whose models serve on
    127.0.0.1); `block="all"` refuses every socket that is not a Unix socket (tests, where models are
    faked inside httpx and nothing should open a socket at all). Refused attempts are still recorded.
    """

    def __init__(self, block: str = "off_device"):
        if block not in ("off_device", "all"):
            raise ValueError("block must be off_device or all")
        self.block = block
        self.sent: list[Sent] = []
        self._lock = threading.Lock()
        self._stack: contextlib.ExitStack | None = None

    def _add(self, item: Sent) -> None:
        with self._lock:
            self.sent.append(item)

    def _record_request(self, request: httpx.Request) -> Sent:
        try:
            body = request.content
        except httpx.RequestNotRead:
            body = request.read()
        host = request.url.host
        sent = Sent(
            "http",
            is_loopback(host),
            request.method,
            str(request.url),
            list(request.headers.items()),
            body,
        )
        self._add(sent)
        return sent

    def _socket_guard(self, op: str, sock: socket.socket | None, address: Any) -> None:
        if sock is not None and sock.family == getattr(socket, "AF_UNIX", None):
            return
        host, port = (
            (address[0], address[1])
            if isinstance(address, tuple) and len(address) >= 2
            else (str(address), None)
        )
        local = is_loopback(str(host))
        refuse = self.block == "all" or not local
        self._add(Sent("socket", local, op=op, port=port if isinstance(port, int) else None, blocked=refuse))
        if refuse:
            raise ConnectionRefusedError(f"canary capture: socket {op} refused")

    def __enter__(self) -> Capture:
        cap = self
        stack = contextlib.ExitStack()
        real_sync, real_async = (
            httpx.HTTPTransport.handle_request,
            httpx.AsyncHTTPTransport.handle_async_request,
        )
        real_connect, real_connect_ex = socket.socket.connect, socket.socket.connect_ex
        real_sendto, real_getaddrinfo = socket.socket.sendto, socket.getaddrinfo

        def handle_request(self, request):
            sent = cap._record_request(request)
            response = real_sync(self, request)
            sent.status = response.status_code
            return response

        async def handle_async_request(self, request):
            sent = cap._record_request(request)
            response = await real_async(self, request)
            sent.status = response.status_code
            return response

        def connect(self, address):
            cap._socket_guard("connect", self, address)
            return real_connect(self, address)

        def connect_ex(self, address):
            cap._socket_guard("connect", self, address)
            return real_connect_ex(self, address)

        def sendto(self, data, *args):
            cap._socket_guard("sendto", self, args[-1] if args else None)
            return real_sendto(self, data, *args)

        def getaddrinfo(host, port, *a, **k):
            cap._socket_guard("lookup", None, (host, port))
            return real_getaddrinfo(host, port, *a, **k)

        for owner, name, new in (
            (httpx.HTTPTransport, "handle_request", handle_request),
            (httpx.AsyncHTTPTransport, "handle_async_request", handle_async_request),
            (socket.socket, "connect", connect),
            (socket.socket, "connect_ex", connect_ex),
            (socket.socket, "sendto", sendto),
            (socket, "getaddrinfo", getaddrinfo),
        ):
            original = getattr(owner, name)
            setattr(owner, name, new)
            stack.callback(setattr, owner, name, original)
        self._stack = stack
        return self

    def __exit__(self, *exc) -> None:
        if self._stack is not None:
            self._stack.close()
            self._stack = None


class RelayLine:
    """Stands in for the relay's WebSocket: frames from Muse in, the device's frames out (recorded)."""

    def __init__(self, timeout: float = 120):
        self.incoming: asyncio.Queue = asyncio.Queue()
        self.sent: list[str] = []
        self.timeout = timeout
        self._waiting: dict[str, asyncio.Future] = {}

    async def send(self, text: str) -> None:
        self.sent.append(text)
        try:
            frame = json.loads(text)
        except ValueError:
            return
        waiter = self._waiting.pop(frame.get("id"), None) if isinstance(frame, dict) else None
        if waiter is not None and not waiter.done():
            waiter.set_result(frame)

    def __aiter__(self):
        return self

    async def __anext__(self):
        raw = await self.incoming.get()
        if raw is None:
            raise StopAsyncIteration
        return raw

    async def request(self, frame_id: str, body: dict) -> dict:
        waiter = asyncio.get_running_loop().create_future()
        self._waiting[frame_id] = waiter
        headers = {"content-type": "application/json", "accept": "application/json, text/event-stream"}
        if body.get("method") != "initialize":
            headers["mcp-protocol-version"] = PROTOCOL
        frame = {
            "type": "request",
            "id": frame_id,
            "method": "POST",
            "headers": headers,
            "body": json.dumps(body),
        }
        await self.incoming.put(json.dumps(frame))
        return await asyncio.wait_for(waiter, self.timeout)

    async def close(self) -> None:
        await self.incoming.put(None)

    def records(self) -> list[Sent]:
        return [Sent("relay_frame", False, body=t.encode("utf-8", "replace")) for t in self.sent]


class Stopped(RuntimeError):
    """The scripted Muse could not go on; the message names no address or document."""


class Planner:
    """Muse's side: MCP calls as relay frames, following job ids, approving what waits on the device."""

    def __init__(self, line: RelayLine, services: Any, *, approve: bool = True, timeout: float = 60):
        self.line, self.services, self.approve, self.timeout = line, services, approve, timeout
        self.outputs: list[str] = []
        self._n = 0

    async def _rpc(self, method: str, params: dict) -> dict:
        self._n += 1
        reply = await self.line.request(
            f"f-{self._n}", {"jsonrpc": "2.0", "id": self._n, "method": method, "params": params}
        )
        if reply.get("status") != 200:
            raise Stopped(f"{method}: the device answered HTTP {reply.get('status')}")
        return json.loads(reply["body"])

    async def initialize(self) -> None:
        info = {
            "protocolVersion": PROTOCOL,
            "capabilities": {},
            "clientInfo": {"name": "canary-capture", "version": "1"},
        }
        await self._rpc("initialize", info)

    async def call(self, name: str, args: dict) -> str:
        message = await self._rpc("tools/call", {"name": name, "arguments": args})
        result = message.get("result") or {}
        text = "".join(c.get("text", "") for c in result.get("content") or [] if isinstance(c, dict))
        self.outputs.append(text)
        return text

    async def step(self, name: str, args: dict) -> str:
        """One tool call, then get_result until the job is done; a waiting result is approved once."""
        text = await self.call(name, args)
        approved = False
        deadline = time.monotonic() + self.timeout
        while text.startswith("{"):
            try:
                body = json.loads(text)
            except ValueError:
                break
            status, job = body.get("status"), body.get("job_id")
            if not job or status not in ("queued", "running", "waiting"):
                break
            if time.monotonic() > deadline:
                raise Stopped(f"{name}: the job did not finish in time")
            if status == "waiting":
                if not self.approve or approved:
                    break
                approval = (self.services.jobs.get(job) or {}).get("approval_id")
                if approval is None:
                    break
                self.services.approvals.decide(approval, approve=True)  # the user taps Share it
                approved = True
            else:
                await asyncio.sleep(0.05)
            text = await self.call("get_result", {"job_id": job})
        return text


@dataclass
class Verdict:
    status: str  # PASS, FAIL or INCONCLUSIVE
    canary: str
    frames: int
    frame_hits: list[str]
    http_on_device: int
    http_on_device_with_canary: int  # answered with a 2xx: a refused or failed call read nothing
    off_device: list[str]  # every off-device HTTP request or socket attempt, described
    off_device_hits: list[str]
    shared: int | None = None  # tool results the device shared; None when not counted
    error: str | None = None  # why the run stopped early, if it did

    def lines(self) -> list[str]:
        out = [
            f"Canary capture: {self.status}",
            f"  canary (invented): {self.canary}",
            f"  relay frames out: {self.frames}, holding the canary: {len(self.frame_hits)}",
            f"  HTTP requests to models on this device: {self.http_on_device}, answered and holding the canary: {self.http_on_device_with_canary}",
            f"  HTTP requests and sockets off the device: {len(self.off_device)}, holding the canary: {len(self.off_device_hits)}",
        ]
        if self.shared is not None:
            out.append(f"  results the device shared: {self.shared}")
        out += [f"  leak: {h}" for h in self.frame_hits + self.off_device_hits]
        out += [f"  tried to leave: {o}" for o in self.off_device]
        if self.status == "INCONCLUSIVE":
            if self.error:
                out.append(f"  the run stopped early ({self.error}), so the canary's absence proves nothing")
            elif not self.http_on_device_with_canary:
                out.append(
                    "  the device's model never answered a request holding the canary (is it running,"
                    " with this device's key?), so its absence proves nothing"
                )
            else:
                out.append("  the device shared no result, so the canary's absence proves nothing")
        return out


def shared_results(outputs: list[str]) -> int:
    """How many tool outputs carry a shared result (status "shared"), not a held or failed one."""
    count = 0
    for text in outputs:
        try:
            body = json.loads(text)
        except ValueError:
            continue
        count += isinstance(body, dict) and body.get("status") == "shared"
    return count


def check(
    capture: Capture, line: RelayLine, canary: str, *, shared: int | None = None, error: str | None = None
) -> Verdict:
    """FAIL on any leak or off-device attempt. PASS needs the device's model to have answered a
    request holding the canary, at least one shared result when `shared` is counted, and no `error`."""
    frames = line.records()
    frame_hits = [
        f"relay frame {i + 1} {', '.join(w)}" for i, f in enumerate(frames) if (w := f.canary_in(canary))
    ]
    on_device = [s for s in capture.sent if s.on_device and s.channel == "http"]
    off = [s for s in capture.sent if not s.on_device]
    off_desc = [
        f"{s.channel} {s.method or s.op}{' (blocked)' if s.blocked else ''}"
        + (f" port {s.port}" if s.port else "")
        for s in off
    ]
    off_hits = [f"{s.channel} {s.method or s.op} {', '.join(w)}" for s in off if (w := s.canary_in(canary))]
    seen = sum(1 for s in on_device if s.answered and s.canary_in(canary))
    if frame_hits or off:
        status = "FAIL"
    elif error or not seen or shared == 0:
        status = "INCONCLUSIVE"
    else:
        status = "PASS"
    return Verdict(
        status, canary, len(frames), frame_hits, len(on_device), seen, off_desc, off_hits, shared, error
    )


def write_log(path: Path, capture: Capture, line: RelayLine, canary: str, verdict: Verdict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    salt = secrets.token_bytes(16)  # never written: off-device host hashes cannot be looked up
    rows = [s.log_row(i + 1, canary, salt) for i, s in enumerate([*capture.sent, *line.records()])]
    summary = {
        "verdict": verdict.status,
        "canary": canary,
        "frames": verdict.frames,
        "off_device": len(verdict.off_device),
        "shared": verdict.shared,
        "error": verdict.error,
    }
    path.write_text("".join(json.dumps(r) + "\n" for r in [summary, *rows]))
    return path


def settle(services: Any, timeout: float = 30) -> None:
    """Wait for the device's background work (jobs, ask jobs, releases, dreaming) to end."""
    deadline = time.monotonic() + timeout
    names = ("job-", "ask-", "release-")
    while any(t.name.startswith(names) for t in threading.enumerate()) and time.monotonic() < deadline:
        time.sleep(0.02)
    night = getattr(services, "night", None)
    if night is not None and hasattr(night, "wait"):
        night.wait(max(0.0, deadline - time.monotonic()))


async def _drive(services: Any, line: RelayLine, steps, approve: bool) -> list[str]:
    from base.connector.relay_client import RelayClient
    from base.connector.server import connector_app

    token = secrets.token_urlsafe(24)
    app = connector_app(services, token=token)
    planner = Planner(line, services, approve=approve)
    async with app.router.lifespan_context(app):
        http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app))  # the connector, in process
        client = RelayClient(
            relay_url="https://relay.invalid",  # never dialed: session() is given the line directly
            secret="unused",
            connector_url=f"http://127.0.0.1:{services.settings.connector_port}/mcp",
            token=token,
            http=http,
        )
        session = asyncio.create_task(client.session(line))
        try:
            await planner.initialize()
            for name, args in steps:
                await planner.step(name, args)
        finally:
            await line.close()
            await session
            await http.aclose()
    return planner.outputs


def run(settings: Any, canary: str, *, block: str = "off_device", steps=STEPS, approve: bool = True):
    """Start the device for `settings` (its workspace already planted), drive `steps` through the
    relay client and connector, and check what left. Returns (verdict, capture, line, outputs)."""
    from base.services import Services

    if not getattr(settings, "device_only", False):
        raise ValueError("the canary capture is for the device-only setup: set DEVICE_ONLY=1")
    line = RelayLine()
    error: str | None = None
    outputs: list[str] = []
    with Capture(block=block) as capture:
        services = Services.create(settings, light=False, heavy=False)
        try:
            try:
                outputs = asyncio.run(_drive(services, line, steps, approve))
            except Exception as exc:  # still checked: whatever was sent before it stopped counts
                while isinstance(exc, BaseExceptionGroup) and exc.exceptions:  # the connector's task group
                    exc = exc.exceptions[0]
                # only this script's own messages are shown; others could name an address
                error = f"{type(exc).__name__}: {exc}" if isinstance(exc, Stopped) else type(exc).__name__
            settle(services)
        finally:
            services.close()
    verdict = check(capture, line, canary, shared=shared_results(outputs), error=error)
    return verdict, capture, line, outputs


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m scripts.canary_capture", description=__doc__.splitlines()[0])
    p.add_argument("--checker-url", help="the device model's address (default CHECKER_URL from .env)")
    p.add_argument("--embed-url", help="the embedder's address (default EMBED_URL from .env)")
    p.add_argument("--canary", help="the invented name to plant (default: a new random one)")
    p.add_argument(
        "--log", type=Path, default=Path("canary_capture.jsonl"), help="request log to write (JSONL)"
    )
    p.add_argument(
        "--block", choices=("off_device", "all"), default="off_device", help="which sockets to refuse"
    )
    p.add_argument(
        "--no-approve", action="store_true", help="leave waiting results waiting instead of approving them"
    )
    args = p.parse_args(argv)

    import os

    from base.config import load_settings

    canary = args.canary or make_canary()
    if not canary.isascii() or not any(c.isalpha() for c in canary):
        # the relay frames are JSON, which writes other characters as \u escapes the matcher misses
        p.error("--canary takes a name in ASCII letters")
    with tempfile.TemporaryDirectory(prefix="canary-capture-") as tmp:
        root = Path(tmp) / "workspace"
        plant(root, canary)
        env = dict(os.environ)
        if args.checker_url:
            env["CHECKER_URL"] = args.checker_url
        if args.embed_url:
            env["EMBED_URL"] = args.embed_url
        try:
            device = load_settings(env)
            if not device.device_only:
                p.error("the canary capture is for the device-only setup: set DEVICE_ONLY=1")
            # llama-server takes the key in the real BASE_HOME, which the throwaway home lacks
            key = device.checker_api_key or ""
            env.update(
                BASE_HOME=str(Path(tmp) / "home"),
                WORKSPACE_ROOT=str(root),
                LIGHT_SERIAL="",
                HEAVY_QUEUE="0",
                CHECKER_API_KEY=key,
                LLAMA_API_KEY=key,
            )
            settings = load_settings(env)
        except ValueError as exc:
            p.error(str(exc))
        verdict, capture, line, _outputs = run(
            settings, canary, block=args.block, approve=not args.no_approve
        )
    log = write_log(args.log, capture, line, canary, verdict)
    print("\n".join(verdict.lines()))
    print(f"  log: {log}")
    return {"PASS": 0, "FAIL": 1}.get(verdict.status, 2)


if __name__ == "__main__":
    sys.exit(main())
