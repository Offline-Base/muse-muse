"""Start the approval page and the Muse connector in one process.

`python -m base.server` (or `python -m base`) loads settings, builds services, and runs two
uvicorn servers in one asyncio loop: the approval page on APPROVAL_HOST:APPROVAL_PORT and the
connector on 127.0.0.1:CONNECTOR_PORT. A laptop never binds the approval page off loopback.
Ctrl+C (SIGINT) or SIGTERM stops both; a second Ctrl+C forces the exit.

Uvicorn runs at warning level with access logs off, so no client or bind address is logged.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import signal
import sys
from collections.abc import Iterator
from typing import Any

import uvicorn

from base.config import Settings, load_settings
from base.ui_app import create_app, is_loopback, print_pairing_code

CONNECTOR_HOST = "127.0.0.1"
GRACEFUL_SECONDS = 3  # open /events streams never end on their own
MAX_CONNECTIONS = 64  # open browser tabs hold one /events stream each; more than this is not a person


class UnsafeBind(RuntimeError):
    """The settings would expose the approval page in a way this device must not."""


def check_bind(settings: Settings) -> None:
    """Refuse a laptop approval page off loopback (the Mac is a managed work laptop)."""
    if settings.device == "laptop" and not is_loopback(settings.approval_host):
        raise UnsafeBind(
            "On a laptop the approval page only listens on this device. "
            "Set APPROVAL_HOST to 127.0.0.1 (or remove it), or use BASE_DEVICE=jetson."
        )


def build_services(settings: Settings) -> Any:
    """Wire every module (base/services.py), which also starts the light."""
    from base.services import Services

    return Services.create(settings)


def load_connector_app(services: Any) -> Any:
    from base.connector.server import connector_app

    return connector_app(services)


class _Server(uvicorn.Server):
    """A uvicorn server that leaves signal handling to serve() so one Ctrl+C stops both."""

    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:
        yield


def make_servers(settings: Settings, approval_app: Any, connector_app: Any) -> list[uvicorn.Server]:
    def config(app: Any, host: str, port: int, **extra: Any) -> uvicorn.Config:
        return uvicorn.Config(
            app,
            host=host,
            port=port,
            log_level="warning",
            access_log=False,
            timeout_graceful_shutdown=GRACEFUL_SECONDS,
            limit_concurrency=MAX_CONNECTIONS,
            **extra,
        )

    tls: dict[str, Any] = {}
    if getattr(settings, "approval_tls", False):
        tls = {"ssl_certfile": str(settings.approval_tls_cert), "ssl_keyfile": str(settings.approval_tls_key)}
    return [
        _Server(config(approval_app, settings.approval_host, settings.approval_port, **tls)),
        _Server(config(connector_app, CONNECTOR_HOST, settings.connector_port)),
    ]


async def serve(servers: list[uvicorn.Server]) -> None:
    """Run the servers until a signal arrives or one of them stops, then stop the rest."""
    loop = asyncio.get_running_loop()

    def stop() -> None:
        for s in servers:
            if s.should_exit:
                s.force_exit = True
            s.should_exit = True

    installed = []
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop)
            installed.append(sig)
        except (NotImplementedError, RuntimeError, ValueError):
            pass  # not the main thread, or a platform without loop signal handlers
    try:
        tasks = [asyncio.create_task(s.serve()) for s in servers]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        stop()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            task.result()
    finally:
        for sig in installed:
            loop.remove_signal_handler(sig)


def run_servers(servers: list[uvicorn.Server]) -> None:
    try:
        asyncio.run(serve(servers))
    except KeyboardInterrupt:
        pass


def main(settings: Settings | None = None) -> int:
    settings = settings or load_settings()
    try:
        check_bind(settings)
    except UnsafeBind as exc:
        print(f"Not starting: {exc}", file=sys.stderr)
        return 2
    settings.ensure_home()
    # The MCP SDK turns on INFO logging; httpx would then log every model and worker URL.
    for name in ("httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
    services = build_services(settings)
    approval_app = create_app(services)
    connector = load_connector_app(services)

    where = "this device only" if is_loopback(settings.approval_host) else "your home network, pairing required"
    print(
        f"Muse Privacy on the {settings.device}: approval page on port {settings.approval_port} ({where}), "
        f"connector on port {settings.connector_port} (this device only). Press Ctrl+C to stop.",
        flush=True,
    )
    if approval_app.state.login_required:
        if not getattr(settings, "approval_tls", False):
            print(
                "Warning: the approval page is plain http on your network, so the session cookie and the "
                "laptop worker's essays cross it unencrypted. Set APPROVAL_TLS_CERT and APPROVAL_TLS_KEY.",
                flush=True,
            )
        pairing = approval_app.state.pairing
        if pairing.locked_out():
            print(
                "Too many wrong pairing codes. On this device, ask for a new one with: "
                f"curl -X POST http://127.0.0.1:{settings.approval_port}/api/pair-code",
                flush=True,
            )
        else:
            print_pairing_code(pairing.new_code())
    try:
        run_servers(make_servers(settings, approval_app, connector))
    except (OSError, SystemExit) as exc:  # uvicorn exits on a port in use: one plain sentence, no traceback
        if isinstance(exc, SystemExit) and exc.code in (0, None):
            raise
        print(
            f"Not starting: port {settings.approval_port} or {settings.connector_port} is already in use or "
            "cannot be opened.",
            file=sys.stderr,
        )
        return 3
    finally:
        close = getattr(services, "close", None)
        if callable(close):
            close()
    print("Stopped.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
