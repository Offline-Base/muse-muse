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
import signal
import sys
from collections.abc import Iterator
from typing import Any

import uvicorn

from base.config import Settings, load_settings
from base.ui_app import create_app, is_loopback, print_pairing_code

CONNECTOR_HOST = "127.0.0.1"
GRACEFUL_SECONDS = 3  # open /events streams never end on their own


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
    """Wire every module. Imported lazily so this file loads before base.services exists."""
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
    def config(app: Any, host: str, port: int) -> uvicorn.Config:
        return uvicorn.Config(
            app,
            host=host,
            port=port,
            log_level="warning",
            access_log=False,
            timeout_graceful_shutdown=GRACEFUL_SECONDS,
        )

    return [
        _Server(config(approval_app, settings.approval_host, settings.approval_port)),
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
        print_pairing_code(approval_app.state.pairing.new_code())
    run_servers(make_servers(settings, approval_app, connector))
    print("Stopped.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
