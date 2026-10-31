"""Is this device up? One short table, and exit 1 when a required check is down.

    uv run python -m scripts.health                    # exit 0 when every required check is ok
    uv run python -m scripts.health --min-free-gb 10   # a higher free-disk floor (default 5 GB)

Every check is read-only and stays on this device (127.0.0.1 and files under BASE_HOME):

- approval, connector: GET /health on APPROVAL_PORT (8787) and CONNECTOR_PORT (8790). Required.
  An approval page served over TLS or off loopback (a Jetson) is skipped.
- checker, embedder, glimmer, router: GET /health on each llama-server on this device. Required
  when the settings use it: the checker (LFM3-VL-2B, 8083) with CHECKER_BACKEND=lfm (DEVICE_ONLY=1
  sets it), the embedder (8084) with SEARCH_EMBEDDINGS=1, and Glimmer (8081, 8082) with
  GLIMMER_BACKEND=llama_server. One the settings do not use is shown only when it answers. A
  503 means the model is still loading. A cloud endpoint is never called.
- relay: when RELAY_URL is set and BASE_HOME/relay.json exists (scripts/start.sh then starts the
  relay client), the client must be running (pgrep) and the last connection line in
  BASE_HOME/logs/relay.log must be "connected to the relay". Required then. Running with no such
  line yet (or no log, as under systemd) is a warning.
- disk: free space on the volume that holds BASE_HOME, against the floor. Required.
- dreaming: when the last night finished, from BASE_HOME/base.db opened read-only (immutable
  while the app is not running, so no side file is made). Never required; a warning after 36 hours.

The output holds port numbers, sizes, counts and local times only: no address, path, key or log
text. It reads .env through base.config like the app does, and prints none of it.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from base.config import Settings, load_settings

LOOPBACK = ("127.0.0.1", "localhost", "::1")
RELAY_PROCESS = "base.connector.relay_client run"
TAIL_BYTES = 256_000
STALE_NIGHT_HOURS = 36
# Lines the relay client logs (base/connector/relay_client.py) that end a connection.
RELAY_DOWN = (
    ("relay connection closed", "closed"),
    ("relay connection failed", "failed"),
    ("relay refused the connection", "refused by the relay"),
    ("reconnecting in", "reconnecting"),
    ("rejected the device secret", "the relay rejected the device secret"),
    ("Another copy of this device", "another copy took over"),
)
_STAMP = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})")


@dataclass(frozen=True)
class Row:
    name: str
    status: str  # ok, down, warn or skip
    detail: str
    required: bool = False


def probe(client: httpx.Client, port: int) -> tuple[bool, str]:
    """GET http://127.0.0.1:<port>/health: (answered 200, what to show)."""
    try:
        r = client.get(f"http://127.0.0.1:{port}/health")
    except httpx.HTTPError as exc:
        return False, f"port {port}: no answer ({type(exc).__name__})"
    if r.status_code == 200:
        return True, f"port {port} answered"
    if r.status_code == 503:
        return False, f"port {port}: still loading the model (503)"
    return False, f"port {port} answered {r.status_code}"


def service_rows(settings: Settings, client: httpx.Client) -> list[Row]:
    rows = []
    if settings.approval_tls or settings.approval_host not in LOOPBACK:
        rows.append(Row("approval", "skip", "not served over plain HTTP on 127.0.0.1 here"))
    else:
        up, detail = probe(client, settings.approval_port)
        rows.append(Row("approval", "ok" if up else "down", detail, True))
    up, detail = probe(client, settings.connector_port)
    rows.append(Row("connector", "ok" if up else "down", detail, True))
    return rows


def model_servers(settings: Settings) -> list[tuple[str, int, bool]]:
    """(name, port, required) for each llama-server on this device, one row per port."""
    glimmer = settings.glimmer_backend == "llama_server" and not (settings.device_only and settings.primary_model == "lfm")
    wanted = [
        ("checker", settings.checker_url, settings.checker_backend == "lfm"),
        ("embedder", settings.embed_url, settings.search_embeddings),
        ("glimmer", settings.answer_url, glimmer),
        ("router", settings.router_url, glimmer),
    ]
    by_port: dict[int, tuple[str, bool]] = {}
    for name, url, required in wanted:
        parts = urlsplit(url)
        if (parts.hostname or "").lower() not in LOOPBACK or parts.port is None:
            continue  # a cloud endpoint: never called from here
        first, was = by_port.get(parts.port, (name, False))
        by_port[parts.port] = (first, was or required)
    return [(name, port, required) for port, (name, required) in by_port.items()]


def model_rows(settings: Settings, client: httpx.Client) -> list[Row]:
    rows = []
    for name, port, required in model_servers(settings):
        up, detail = probe(client, port)
        if required:
            rows.append(Row(name, "ok" if up else "down", detail, True))
        elif up:
            rows.append(Row(name, "ok", f"{detail} (not used by these settings)"))
    return rows


def relay_state(log: Path) -> tuple[str | None, str]:
    """(state, local time) of the last connection line in the relay log: "connected", a reason
    it is not, or None when there is no such line or no log."""
    try:
        with open(log, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - TAIL_BYTES))
            lines = f.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return None, ""
    for line in reversed(lines):
        text = line.rstrip()
        stamp = _STAMP.match(text)
        when = stamp.group(1) if stamp else ""
        if text.endswith(" connected to the relay"):
            return "connected", when
        for phrase, state in RELAY_DOWN:
            if phrase in text:
                return state, when
    return None, ""


def relay_running() -> bool | None:
    """Whether a relay client process is running, or None when pgrep cannot tell."""
    exe = shutil.which("pgrep")
    if exe is None:
        return None
    try:
        done = subprocess.run([exe, "-f", RELAY_PROCESS], capture_output=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.returncode == 0 if done.returncode in (0, 1) else None


def relay_row(settings: Settings, running: Callable[[], bool | None] = relay_running) -> Row:
    if not (settings.relay_url and (settings.home / "relay.json").is_file()):
        return Row("relay", "skip", "this device is not linked to the relay")
    state, when = relay_state(settings.home / "logs" / "relay.log")
    since = f" since {when}" if when else ""
    if running() is False:
        return Row("relay", "down", "the relay client is not running", True)
    if state == "connected":
        return Row("relay", "ok", f"connected{since}", True)
    if state is None:
        return Row("relay", "warn", "the client runs, but its log shows no connection yet", True)
    return Row("relay", "down", f"not connected: {state}{since}", True)


def disk_row(home: Path, floor_gb: float, usage: Callable = shutil.disk_usage) -> Row:
    target = next((p for p in (home, *home.parents) if p.exists()), Path("/"))
    free = usage(target).free / 1e9
    detail = f"{free:.1f} GB free, floor {floor_gb:g} GB"
    return Row("disk", "ok" if free >= floor_gb else "down", detail, True)


def _ago(seconds: float) -> str:
    if seconds < 3600:
        return f"{max(0, int(seconds // 60))} min ago"
    if seconds < 2 * 86400:
        return f"{int(seconds // 3600)} h ago"
    return f"{int(seconds // 86400)} days ago"


def dreaming_row(db: Path, now: float) -> Row:
    if not db.is_file():
        return Row("dreaming", "skip", "no night has run yet (no database)")
    # With no -wal file the app is not writing, so read the file as it is and leave nothing beside it.
    immutable = "" if db.with_name(db.name + "-wal").exists() else "&immutable=1"
    try:
        con = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro{immutable}", uri=True, timeout=2)
        try:
            last = con.execute("SELECT finished_at, report FROM dreaming_nights ORDER BY id DESC LIMIT 1").fetchone()
        finally:
            con.close()
    except sqlite3.OperationalError as exc:
        if "no such table" in str(exc):
            return Row("dreaming", "skip", "no night has run yet")
        return Row("dreaming", "warn", f"could not read the database ({type(exc).__name__})")
    except sqlite3.Error as exc:
        return Row("dreaming", "warn", f"could not read the database ({type(exc).__name__})")
    if last is None:
        return Row("dreaming", "skip", "no night has run yet")
    finished, report = last
    try:
        kept = json.loads(report).get("kept")
    except (TypeError, ValueError, AttributeError):
        kept = None
    outcome = {True: ", kept the new rules", False: ", kept the old rules"}.get(kept, "")
    detail = f"last night finished {time.strftime('%Y-%m-%d %H:%M', time.localtime(finished))} ({_ago(now - finished)}){outcome}"
    stale = now - finished > STALE_NIGHT_HOURS * 3600
    return Row("dreaming", "warn" if stale else "ok", detail)


def collect(
    settings: Settings,
    client: httpx.Client,
    *,
    floor_gb: float = 5.0,
    running: Callable[[], bool | None] = relay_running,
    usage: Callable = shutil.disk_usage,
    now: float | None = None,
) -> list[Row]:
    return [
        *service_rows(settings, client),
        *model_rows(settings, client),
        relay_row(settings, running),
        disk_row(settings.home, floor_gb, usage),
        dreaming_row(settings.paths.db, time.time() if now is None else now),
    ]


def render(rows: list[Row]) -> str:
    width = max(len(r.name) for r in rows)
    lines = [f"{'check'.ljust(width)}  status  detail"]
    lines += [f"{r.name.ljust(width)}  {r.status.ljust(6)}  {r.detail}" for r in rows]
    down = [r.name for r in rows if r.required and r.status == "down"]
    required = sum(r.required for r in rows)
    lines.append(f"Down: {', '.join(down)}." if down else f"All {required} required checks are ok.")
    return "\n".join(lines)


def main(argv: list[str] | None = None, *, settings: Settings | None = None, **kw) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--min-free-gb", type=float, default=5.0, help="free-disk floor in GB (default 5)")
    ap.add_argument("--timeout", type=float, default=3.0, help="seconds to wait for each /health")
    args = ap.parse_args(argv)
    settings = settings or load_settings()
    with httpx.Client(trust_env=False, timeout=args.timeout) as client:  # no proxy: loopback only
        rows = collect(settings, client, floor_gb=args.min_free_gb, **kw)
    print(render(rows))
    return 1 if any(r.required and r.status == "down" for r in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
