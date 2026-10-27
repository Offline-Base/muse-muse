"""The approval page: what Muse wants to share, the decision log, dreaming and device status.

Pages are plain HTML built from ui/templates with string.Template (jinja2 is not installed),
plus ui/static/app.css and ui/static/app.js. Only tag-only fields of a decision row are ever
rendered (request, tagged_text, router reason, blocked reasons); raw results stay in the stores.

Access: bound to loopback, the page needs no login but only answers to loopback Host headers
(a DNS-rebinding guard). Bound to a LAN address (Jetson), every route except /health, /pair and
the heavy-worker routes needs a session cookie from a one-time 6-digit pairing code. Every
POST needs a matching Origin or Referer.
"""

from __future__ import annotations

import asyncio
import csv
import hashlib
import hmac
import html
import ipaddress
import json
import os
import re
import secrets
import threading
import time
from collections.abc import AsyncIterator, Iterable, Mapping
from datetime import date, datetime, timedelta
from pathlib import Path
from string import Template
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from base import events
from base.config import REPO_ROOT
from base.types import default_share_form

UI_DIR = REPO_ROOT / "ui"
TEMPLATES_DIR = UI_DIR / "templates"
STATIC_DIR = UI_DIR / "static"
NIGHTS_CSV = REPO_ROOT / "eval" / "reports" / "nights.csv"

SESSION_COOKIE = "muse_session"
SESSION_SECONDS = 30 * 24 * 3600
CODE_SECONDS = 600
CODE_TRIES = 5
HEARTBEAT_SECONDS = 15.0
HISTORY_LIMIT = 200

LIGHT_LABELS = {
    "idle": "Idle",
    "working": "Working on this device",
    "waiting": "Waiting for your OK",
    "sending": "Sending a tagged result to Muse",
}
DECISION_LABELS = {
    "share_tagged": "Share tagged",
    "share_summary": "Share a summary",
    "ask_user": "Ask you",
    "refuse": "Keep it here",
}
STATUS_CHIPS = {
    "auto": ("Router decided", ""),
    "pending": ("Waiting for you", "warn"),
    "approved": ("You shared it", "send"),
    "denied": ("You kept it here", "danger"),
}
SOURCE_LABELS = {
    "model": "Decided by Glimmer",
    "rule": "Decided by a rule",
    "fallback": "Safe fallback, the model did not answer",
    "cache": "Same as a recent decision",
}
TOPIC_REASONS = {
    "iep": "Mentions an IEP or 504 plan",
    "medical": "Mentions medical or health details",
    "discipline": "Mentions discipline records",
    "custody": "Mentions custody or family court",
    "immigration": "Mentions immigration status",
    "home_address": "Mentions a home address",
    "parent_contact": "Mentions parent contact details",
    "lunch_status": "Mentions free or reduced lunch status",
}
TAG_RE = re.compile(r"\[(?:Student [A-Z]{1,2}|Teacher|(?:Person|Phone|Email|SSN|Card|Code|ID|Address|DOB) \d+)\]")

SECURITY_HEADERS = [
    (b"x-frame-options", b"DENY"),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"same-origin"),
    (
        b"content-security-policy",
        b"default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
        b"font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; "
        b"frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ),
]

ICONS = {
    "approvals": '<path d="M10 2.5l6 2.25v4.5c0 3.9-2.6 6.9-6 8.25-3.4-1.35-6-4.35-6-8.25v-4.5z"/>'
    '<path d="M7.5 10l1.75 1.75 3.25-3.5"/>',
    "history": '<circle cx="10" cy="10" r="7.25"/><path d="M10 6v4.25l2.75 1.75"/>',
    "dreaming": '<path d="M16.25 12.25A6.75 6.75 0 1 1 7.75 3.75a5.25 5.25 0 0 0 8.5 8.5z"/>',
    "device": '<rect x="5" y="5" width="10" height="10" rx="2"/><path d="M8 2.5V5M12 2.5V5M8 15v2.5M12 15v2.5'
    'M2.5 8H5M2.5 12H5M15 8h2.5M15 12h2.5"/>',
    "pairing": '<circle cx="6.75" cy="10" r="3.25"/><path d="M10 10h7.5M15 10v2.5M17.5 10v2"/>',
}
NAV = [
    ("approvals", "/", "Approvals"),
    ("history", "/history", "History"),
    ("dreaming", "/dreaming", "Dreaming"),
    ("device", "/device", "Device"),
    ("pairing", "/pair", "Pairing"),
]


# ---------------------------------------------------------------- templates


_template_cache: dict[str, Template] = {}


def render(name: str, **values: Any) -> str:
    """Fill ui/templates/<name>. Values are HTML-escaped unless their key ends in `_html`."""
    tpl = _template_cache.get(name)
    if tpl is None:
        tpl = Template((TEMPLATES_DIR / name).read_text(encoding="utf-8"))
        _template_cache[name] = tpl
    safe = {k: (str(v) if k.endswith("_html") else html.escape(str(v), quote=True)) for k, v in values.items()}
    return tpl.substitute(safe)


def esc(value: Any) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def highlight_tags(text: str | None) -> str:
    """Escape text and wrap tags like [Student A] in chips."""
    return TAG_RE.sub(lambda m: f'<span class="tag">{m.group(0)}</span>', esc(text))


# ---------------------------------------------------------------- access control


def is_loopback(host: str | None) -> bool:
    """True for 127.0.0.0/8, ::1 and localhost."""
    if not host:
        return False
    host = host.strip("[]").lower()
    if host == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    return ip.is_loopback or bool(mapped and mapped.is_loopback)


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Pairing:
    """One-time 6-digit codes shown on the device. A code works once and burns after 5 misses."""

    def __init__(self, ttl: float = CODE_SECONDS, tries: int = CODE_TRIES) -> None:
        self.ttl, self.tries = ttl, tries
        self._lock = threading.Lock()
        self._code: str | None = None
        self._expires = 0.0
        self._misses = 0

    def new_code(self) -> str:
        code = f"{secrets.randbelow(10**6):06d}"
        with self._lock:
            self._code, self._expires, self._misses = code, time.time() + self.ttl, 0
        return code

    def redeem(self, code: str) -> bool:
        code = "".join(str(code or "").split())
        with self._lock:
            if self._code is None or time.time() > self._expires:
                self._code = None
                return False
            if hmac.compare_digest(code.encode(), self._code.encode()):
                self._code = None
                return True
            self._misses += 1
            if self._misses >= self.tries:
                self._code = None
            return False


class SessionStore:
    """Server-side browser sessions. Only SHA-256 hashes of tokens are kept, in a 0600 file."""

    def __init__(self, path: Path, ttl: float = SESSION_SECONDS) -> None:
        self.path, self.ttl = path, ttl
        self._lock = threading.Lock()
        self._sessions = self._load()

    def _load(self) -> dict[str, float]:
        try:
            data = json.loads(self.path.read_text())
            now = time.time()
            return {str(k): float(v) for k, v in data.items() if float(v) > now}
        except (OSError, ValueError, AttributeError, TypeError):
            return {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(self._sessions, f)
        os.chmod(self.path, 0o600)

    def create(self) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            now = time.time()
            self._sessions = {k: v for k, v in self._sessions.items() if v > now}
            self._sessions[_digest(token)] = now + self.ttl
            self._save()
        return token

    def valid(self, token: str | None) -> bool:
        if not token:
            return False
        with self._lock:
            expires = self._sessions.get(_digest(token))
        return expires is not None and expires > time.time()

    def count(self) -> int:
        now = time.time()
        with self._lock:
            return sum(1 for v in self._sessions.values() if v > now)


class NeedPairing(Exception):
    """Raised when a browser off loopback has no valid session."""


def _same_origin(request: Request) -> bool | None:
    """True or False when Origin or Referer is present, None when both are missing."""
    host = request.headers.get("host", "").lower()
    origin = request.headers.get("origin")
    if origin is not None:
        return origin != "null" and urlsplit(origin).netloc.lower() == host
    referer = request.headers.get("referer")
    if referer:
        return urlsplit(referer).netloc.lower() == host
    return None


def _is_local_client(request: Request) -> bool:
    """The request came from the device itself: a loopback peer, or the server's own address."""
    client = request.client.host if request.client else ""
    server = request.scope.get("server") or ("",)
    return is_loopback(client) or (bool(client) and client == server[0])


def make_access(settings: Any, sessions: SessionStore):
    """Build the dependency that every route runs before its handler."""
    local_only = is_loopback(settings.approval_host)
    port = settings.approval_port
    allowed_hosts = {f"{h}:{port}" for h in ("127.0.0.1", "localhost", "[::1]")}
    allowed_hosts.add(f"{settings.approval_host}:{port}".lower())

    async def access(request: Request) -> None:
        path = request.url.path
        if path == "/health" or path.startswith("/heavy/"):
            return  # health is public; heavy routes check the paired worker token themselves
        if local_only and request.headers.get("host", "").lower() not in allowed_hosts:
            raise HTTPException(400, "This page only answers on this device's own address.")
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            same = _same_origin(request)
            if same is False or (same is None and path != "/api/pair-code"):
                raise HTTPException(403, "Cross-site request refused.")
        if path == "/api/pair-code":
            if not _is_local_client(request):
                raise HTTPException(403, "Ask for a pairing code on the device itself.")
            return
        if local_only or path == "/pair":
            return
        if not sessions.valid(request.cookies.get(SESSION_COOKIE)):
            raise NeedPairing()

    return access


async def _need_pairing(request: Request, exc: Exception) -> JSONResponse | RedirectResponse:
    path = request.url.path
    if path.startswith("/api/") or path == "/events":
        return JSONResponse({"detail": "Pair this browser first. Open /pair."}, status_code=401)
    return RedirectResponse("/pair", status_code=303)


class SecurityHeaders:
    """Plain ASGI middleware (safe for SSE) that adds framing, sniffing and caching headers."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        extra = list(SECURITY_HEADERS)
        if not scope.get("path", "").startswith("/static/"):
            extra.append((b"cache-control", b"no-store"))

        async def send_with_headers(message: dict) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                present = {k.lower() for k, _ in headers}
                headers += [(k, v) for k, v in extra if k not in present]
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)


# ---------------------------------------------------------------- rows


def _val(row: Any, key: str, default: Any = None) -> Any:
    """Read a field from a dict, sqlite3.Row or object."""
    if row is None:
        return default
    if isinstance(row, Mapping):
        return row.get(key, default)
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return getattr(row, key, default)


def _as_list(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return [p.strip() for p in value.split(",") if p.strip()]
        return [str(p) for p in parsed] if isinstance(parsed, list) else [str(parsed)]
    return [str(v) for v in value]


def _ts_number(ts: Any) -> float | None:
    if isinstance(ts, int | float):
        return float(ts)
    if isinstance(ts, str) and ts:
        try:
            return float(ts)
        except ValueError:
            try:
                return datetime.fromisoformat(ts).timestamp()
            except ValueError:
                return None
    return None


def _when(ts: Any) -> str:
    t = _ts_number(ts)
    if t is None:
        return "" if ts is None else str(ts)
    return datetime.fromtimestamp(t).strftime("%b %d, %H:%M")


def _newest_first(rows: Iterable[Any]) -> list[Any]:
    def key(row: Any) -> tuple[float, str]:
        rid = _val(row, "id")
        return (_ts_number(_val(row, "ts")) or 0.0, f"{rid:0>12}" if rid is not None else "")

    return sorted(rows, key=key, reverse=True)


def _coerce_id(raw: str) -> int | str:
    return int(raw) if raw.isdigit() else raw


def _kind_label(kind: str | None) -> str:
    return (kind or "result").replace("_", " ").capitalize()


def _never_share(services: Any) -> set[str] | None:
    policy = getattr(services, "policy", None)
    try:
        return set(policy.never_share) if policy is not None else None
    except Exception:
        return None


def blocked_reasons(row: Any, never_share: set[str] | None) -> list[str]:
    """Plain-language blocked reasons: the row's own list if it has one, else from its topics."""
    own = _as_list(_val(row, "blocked"))
    if own:
        return own
    known = never_share if never_share is not None else set(TOPIC_REASONS)
    topics = [t for t in _as_list(_val(row, "topics")) if t in known]
    return [TOPIC_REASONS.get(t, f"Mentions {t.replace('_', ' ')}") for t in topics]


def public_row(row: Any, never_share: set[str] | None) -> dict[str, Any]:
    """Only the tag-only fields of a decision row, for the JSON API."""
    kind = _val(row, "result_kind")
    return {
        "id": _val(row, "id"),
        "ts": _val(row, "ts"),
        "when": _when(_val(row, "ts")),
        "tool": _val(row, "tool"),
        "request": _val(row, "request") or "",
        "result_kind": kind,
        "shown_form": _val(row, "shown_form") or default_share_form(kind or ""),
        "tagged_text": _val(row, "tagged_text") or "",
        "blocked": blocked_reasons(row, never_share),
        "router_decision": _val(row, "router_decision"),
        "router_reason": _val(row, "router_reason") or "",
        "router_source": _val(row, "router_source"),
        "status": _val(row, "status"),
    }


# ---------------------------------------------------------------- page pieces


def _chips(items: Iterable[str], cls: str = "") -> str:
    items = list(items)
    if not items:
        return ""
    return '<ul class="chips">' + "".join(f'<li class="chip {cls}">{esc(i)}</li>' for i in items) + "</ul>"


def approval_card(row: Any, never_share: set[str] | None) -> str:
    r = public_row(row, never_share)
    rid = str(r["id"])
    form = "a short summary, with tags" if r["shown_form"] == "share_summary" else "the tagged text above"
    meta = [
        r["tool"],
        _kind_label(r["result_kind"]),
        f"Router: {DECISION_LABELS.get(r['router_decision'] or '', 'Ask you')}",
        SOURCE_LABELS.get(r["router_source"] or "", r["router_source"]),
    ]
    return render(
        "approval_card.html",
        id=rid,
        id_url=quote(rid, safe=""),
        when=r["when"],
        request=r["request"] or "No request text",
        tagged_html=highlight_tags(r["tagged_text"]),
        blocked_html=_chips(r["blocked"], "warn"),
        router_reason=r["router_reason"] or "The router wants your OK before this leaves.",
        shown=form,
        meta=" · ".join(m for m in meta if m),
    )


def history_row(row: Any, never_share: set[str] | None) -> str:
    r = public_row(row, never_share)
    rid = str(r["id"])
    deleted = bool(_val(row, "deleted"))
    label, cls = STATUS_CHIPS.get(r["status"] or "", (r["status"] or "Unknown", ""))
    you = _val(row, "user_decision")
    remember = bool(_val(row, "remember"))
    status_html = f'<span class="chip {cls}">{esc(label)}</span>'
    if you and remember:
        status_html += '<div class="caption">Remembered for next time</div>'
    if deleted:
        request_html = '<span class="muted">Deleted</span>'
        action_html = '<span class="muted">Deleted</span>'
    else:
        request_html = f'<div class="req">{esc(r["request"])}</div>'
        if r["tagged_text"]:
            request_html += (
                '<details class="peek"><summary>What would leave</summary>'
                f'<pre class="tagged small">{highlight_tags(r["tagged_text"])}</pre></details>'
            )
        action_html = (
            f'<form class="js-delete" method="post" action="/api/history/{esc(quote(rid, safe=""))}/delete">'
            '<button class="btn secondary danger small" type="submit">Delete this decision</button></form>'
        )
    return render(
        "history_row.html",
        id=rid,
        row_class="deleted" if deleted else "",
        when=r["when"],
        request_html=request_html,
        kind=_kind_label(r["result_kind"]),
        router=DECISION_LABELS.get(r["router_decision"] or "", r["router_decision"] or ""),
        status_html=status_html,
        action_html=action_html,
    )


def _pct(value: Any) -> str:
    if value is None:
        return "n/a"
    try:
        v = float(value)
    except (TypeError, ValueError):
        return str(value)
    return f"{v * 100:.1f}%" if v <= 1 else f"{v:.1f}%"


def metric_card(value: Any, label: str, tip: str, caption: str = "", chart_html: str = "") -> str:
    return render("metric_card.html", value=value, label=label, tip=tip, caption=caption, chart_html=chart_html)


def day_label(day: Any) -> str:
    """Store days are days since 1970 ("Oct 27"); small simulation days stay "Day 3"."""
    n = _ts_number(day)
    if n is None:
        return str(day)
    if n > 10_000:
        d = date(1970, 1, 1) + timedelta(days=int(n))
        return f"{d:%b} {d.day}"
    return f"Day {int(n)}"


def bar_chart(counts: Mapping[Any, Any], days: int = 14) -> str:
    """A small inline SVG bar chart of approval requests per day, styled by app.css."""
    keys = sorted(counts, key=lambda d: (_ts_number(d) or 0.0))[-days:]
    if not keys:
        return ""
    values = [int(counts[k] or 0) for k in keys]
    top = max(max(values), 1)
    top += top % 2
    width, height, left, bottom, pad = 560, 168, 32, 24, 8
    plot_w, plot_h = width - left - pad, height - bottom - pad
    slot = plot_w / len(keys)
    bar_w = min(32.0, slot * 0.6)
    parts = [f'<svg class="chart" viewBox="0 0 {width} {height}" role="img" aria-label="Approval requests per day">']
    for frac in (0.0, 0.5, 1.0):
        y = pad + plot_h * (1 - frac)
        parts.append(f'<line class="grid" x1="{left}" x2="{width - pad}" y1="{y:.1f}" y2="{y:.1f}"/>')
        parts.append(f'<text class="axis" x="{left - 8}" y="{y + 4:.1f}" text-anchor="end">{int(top * frac)}</text>')
    step = 1 if len(keys) <= 7 else 2  # keep date labels from overlapping
    for i, (day, v) in enumerate(zip(keys, values, strict=True)):
        x = left + slot * i + (slot - bar_w) / 2
        h = plot_h * v / top
        y = pad + plot_h - h
        r = min(2.0, bar_w / 2, h)
        label = esc(day_label(day))
        if h > 0:
            parts.append(
                f'<path class="bar" d="M{x:.1f},{y + h:.1f}V{y + r:.1f}Q{x:.1f},{y:.1f} {x + r:.1f},{y:.1f}'
                f'H{x + bar_w - r:.1f}Q{x + bar_w:.1f},{y:.1f} {x + bar_w:.1f},{y + r:.1f}V{y + h:.1f}Z">'
                f"<title>{label}: {v}</title></path>"
            )
        if (len(keys) - 1 - i) % step == 0:
            parts.append(
                f'<text class="axis" x="{x + bar_w / 2:.1f}" y="{height - 6}" text-anchor="middle">{label}</text>'
            )
    parts.append("</svg>")
    parts.append('<div class="legend"><span class="dot c1"></span>Approval requests</div>')
    return "".join(parts)


def nights_table(path: Path, limit: int = 30) -> str:
    if not path.is_file():
        return ""
    try:
        with path.open(newline="", encoding="utf-8") as f:
            rows = list(csv.reader(f))
    except (OSError, csv.Error, UnicodeDecodeError):
        return ""
    if len(rows) < 2:
        return ""
    head, body = rows[0], rows[1:][-limit:]
    th = "".join(f"<th>{esc(h.replace('_', ' ').capitalize())}</th>" for h in head)
    trs = "".join("<tr>" + "".join(f'<td class="num">{esc(c)}</td>' for c in r) + "</tr>" for r in reversed(body))
    return (
        '<h2 class="section-title">Nights</h2>'
        f'<div class="table-wrap"><table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div>'
    )


def last_report(services: Any) -> Any:
    """The latest NightReport from services.night.last_report (a method or an attribute)."""
    attr = getattr(getattr(services, "night", None), "last_report", None)
    try:
        return attr() if callable(attr) else attr
    except Exception:
        return None


def heavy_status(services: Any) -> str:
    """One line about the laptop worker, from services.heavy.worker_present() (a HeavyQueue)."""
    present = getattr(getattr(services, "heavy", None), "worker_present", None)
    if callable(present):
        try:
            if present():
                return "A laptop worker checked in recently, so heavy steps go to the laptop."
            return "No laptop worker has checked in recently, so heavy steps run on this device."
        except Exception:
            pass
    return "Heavy steps go to the laptop worker when it checks in. Without it, this device runs them."


# ---------------------------------------------------------------- SSE


def _sse(event: events.Event) -> str:
    return "data: " + json.dumps({"state": event.state, "detail": event.detail, "ts": event.ts}) + "\n\n"


async def event_stream(heartbeat: float = HEARTBEAT_SECONDS) -> AsyncIterator[str]:
    """Yield one SSE data line per base.events event, and a comment line every `heartbeat` seconds."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[events.Event] = asyncio.Queue()
    unsubscribe = events.subscribe(lambda ev: loop.call_soon_threadsafe(queue.put_nowait, ev))
    try:
        yield ": connected\n\n"
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=heartbeat)
            except TimeoutError:
                yield ": ping\n\n"
                continue
            yield _sse(event)
    finally:
        unsubscribe()


# ---------------------------------------------------------------- request bodies


async def _read_body(request: Request) -> dict[str, Any]:
    raw = await request.body()
    if "application/json" in request.headers.get("content-type", ""):
        try:
            data = json.loads(raw or b"{}")
        except ValueError as exc:
            raise HTTPException(400, "The request body is not valid JSON.") from exc
        if not isinstance(data, dict):
            raise HTTPException(400, "Send a JSON object.")
        return data
    return {k: v[-1] for k, v in parse_qs(raw.decode("utf-8", "replace")).items()}


def _is_form(request: Request) -> bool:
    return request.headers.get("content-type", "").startswith("application/x-www-form-urlencoded")


def _truthy(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return bool(value)
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("1", "true", "yes", "on"):
            return True
        if v in ("0", "false", "no", "off", ""):
            return False
    return None


# ---------------------------------------------------------------- app


def create_app(services: Any, *, nights_csv: Path | None = None) -> FastAPI:
    """Build the approval page app for one device. `services` needs settings and approvals."""
    settings = services.settings
    store = services.approvals
    nights_path = nights_csv or NIGHTS_CSV
    sessions = SessionStore(settings.home / "approval_sessions.json")
    pairing = Pairing()
    login_required = not is_loopback(settings.approval_host)

    app = FastAPI(
        title="Muse Privacy",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        dependencies=[Depends(make_access(settings, sessions))],
    )
    app.state.services = services
    app.state.pairing = pairing
    app.state.sessions = sessions
    app.state.login_required = login_required
    app.add_middleware(SecurityHeaders)
    app.add_exception_handler(NeedPairing, _need_pairing)
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    def authorized(request: Request) -> bool:
        return not login_required or sessions.valid(request.cookies.get(SESSION_COOKIE))

    def pending_rows() -> list[Any]:
        return _newest_first(r for r in store.pending() if not _val(r, "deleted"))

    def page(request: Request, name: str, title: str, content_html: str, status: int = 200) -> HTMLResponse:
        live = authorized(request)
        count = len(pending_rows()) if live else 0
        nav = []
        for key, href, label in NAV:
            cls, current = ("nav-item active", ' aria-current="page"') if key == name else ("nav-item", "")
            badge = f'<span class="badge">{count}</span>' if key == "approvals" and count else ""
            nav.append(
                f'<a class="{cls}" href="{href}"{current}>'
                f'<svg viewBox="0 0 20 20" aria-hidden="true">{ICONS[key]}</svg><span>{label}</span>{badge}</a>'
            )
        light = events.last() if live else events.Event("idle")
        device = "Jetson" if settings.device == "jetson" else "Laptop"
        backend = "Glimmer via OpenRouter" if settings.is_cloud_backend else "Glimmer on this device"
        body = render(
            "layout.html",
            title=title,
            page=name,
            live="1" if live else "0",
            nav_html="".join(nav),
            light_state=light.state,
            light_label=LIGHT_LABELS.get(light.state, light.state),
            device_initial=device[0],
            device_name=device,
            backend=backend,
            content_html=content_html,
        )
        return HTMLResponse(body, status_code=status)

    # ------------------------------------------------------------ pages

    @app.get("/", response_class=HTMLResponse)
    def approvals_page(request: Request) -> HTMLResponse:
        never = _never_share(services)
        rows = pending_rows()
        content = render(
            "approvals.html",
            cards_html="".join(approval_card(r, never) for r in rows),
            empty_hidden="" if not rows else "hidden",
        )
        return page(request, "approvals", "Approvals", content)

    @app.get("/history", response_class=HTMLResponse)
    def history_page(request: Request, show: str = "all") -> HTMLResponse:
        never = _never_share(services)
        show = "pending" if show == "pending" else "all"
        rows = pending_rows() if show == "pending" else _newest_first(store.history(limit=HISTORY_LIMIT))
        content = render(
            "history.html",
            on_pending="on" if show == "pending" else "",
            on_all="on" if show == "all" else "",
            rows_html="".join(history_row(r, never) for r in rows),
            empty_hidden="" if not rows else "hidden",
        )
        return page(request, "history", "History", content)

    @app.get("/dreaming", response_class=HTMLResponse)
    def dreaming_page(request: Request) -> HTMLResponse:
        report = last_report(services)
        if report is None or _val(report, "night_number") == 0:
            report_html = (
                '<div class="card empty-card">No nights yet. Press Dream now to run the first one.</div>'
            )
        else:
            kept = bool(_val(report, "kept"))
            seconds = _val(report, "seconds")
            took = f"Took {float(seconds):.0f} s" if isinstance(seconds, int | float) else ""
            night = _val(report, "night_number")
            took = f"Night {night}. {took}".strip() if night else took
            report_html = '<section class="metrics">' + "".join(
                [
                    metric_card(
                        _val(report, "learned_from", 0),
                        "Decisions learned from",
                        "Your approve and deny decisions, minus any you deleted.",
                        "New rules kept" if kept else "Kept the previous rules",
                    ),
                    metric_card(
                        _pct(_val(report, "accuracy_after")),
                        "Decision accuracy",
                        "Share of held-out test items the router got right after last night.",
                        f"Before: {_pct(_val(report, 'accuracy_before'))}",
                    ),
                    metric_card(
                        _pct(_val(report, "agreement_after")),
                        "Agreement with you",
                        "How often the router now decides the way you would.",
                        f"Before: {_pct(_val(report, 'agreement_before'))}",
                    ),
                    metric_card(
                        _val(report, "leaks", 0),
                        "Leaks",
                        "Real names or identifiers found in anything that would leave. This must stay at 0.",
                        took,
                    ),
                ]
            ) + "</section>"
        counts_fn = getattr(store, "counts_by_day", None)
        try:
            counts = counts_fn() if callable(counts_fn) else {}
        except Exception:
            counts = {}
        chart_html = ""
        if counts:
            latest = sorted(counts, key=lambda d: (_ts_number(d) or 0.0))[-1]
            chart_html = '<section class="metrics wide">' + metric_card(
                counts[latest],
                "Approval requests on the latest day",
                "How often the router asked you. Dreaming should bring this down.",
                f"Days counted: {len(counts)}",
                bar_chart(counts),
            ) + "</section>"
        content = render(
            "dreaming.html",
            report_html=report_html,
            chart_html=chart_html,
            nights_html=nights_table(nights_path),
        )
        return page(request, "dreaming", "Dreaming", content)

    @app.get("/device", response_class=HTMLResponse)
    def device_page(request: Request) -> HTMLResponse:
        light = events.last()
        facts = [
            ("Device", "Jetson" if settings.device == "jetson" else "Laptop"),
            (
                "Glimmer runs",
                "On OpenRouter, for invented data only" if settings.is_cloud_backend else "On this device with llama-server",
            ),
            ("Answer model", settings.answer_model),
            ("Router model", settings.router_model),
            (
                "Dreaming",
                "LoRA adapter, trained in the cloud" if settings.dreaming_backend == "lora" else "Rules rewritten each night",
            ),
            ("Light", f"{LIGHT_LABELS.get(light.state, light.state)} since {_when(light.ts)}"),
            (
                "Who can open this page",
                f"Browsers on your home network that entered a pairing code ({sessions.count()} paired)"
                if login_required
                else "Only this device",
            ),
        ]
        if settings.heavy_queue:
            facts.append(("Laptop helper", heavy_status(services)))
        facts_html = "".join(f"<div class=\"fact\"><dt>{esc(k)}</dt><dd>{esc(v)}</dd></div>" for k, v in facts)
        return page(request, "device", "Device", render("device.html", facts_html=facts_html))

    @app.get("/pair", response_class=HTMLResponse)
    def pair_page(request: Request) -> HTMLResponse:
        return pair_response(request)

    def pair_response(request: Request, error: str = "", status: int = 200) -> HTMLResponse:
        if not login_required:
            subtitle, notice, hidden = "This page is only open on this device, so no pairing is needed.", "", "hidden"
        elif sessions.valid(request.cookies.get(SESSION_COOKIE)):
            subtitle, notice, hidden = "This browser is paired. It stays paired for 30 days.", "", "hidden"
        else:
            subtitle, hidden = "Enter the 6-digit code the device printed when it started.", ""
            notice = f'<p class="form-error" role="alert">{esc(error)}</p>' if error else ""
        content = render("pair.html", subtitle=subtitle, notice_html=notice, form_hidden=hidden)
        return page(request, "pairing", "Pairing", content, status=status)

    @app.post("/pair", response_class=HTMLResponse)
    async def pair_submit(request: Request) -> Response:
        if not login_required:
            return RedirectResponse("/", status_code=303)
        data = await _read_body(request)
        if not pairing.redeem(str(data.get("code", ""))):
            return pair_response(request, "That code did not work. Ask the device for a new one.", status=400)
        response = RedirectResponse("/", status_code=303)
        response.set_cookie(
            SESSION_COOKIE,
            sessions.create(),
            max_age=SESSION_SECONDS,
            httponly=True,
            samesite="strict",
            path="/",
        )
        return response

    # ------------------------------------------------------------ JSON API

    @app.get("/api/approvals")
    def api_approvals() -> dict[str, Any]:
        never = _never_share(services)
        return {"approvals": [public_row(r, never) for r in pending_rows()]}

    @app.post("/api/approvals/{approval_id}")
    async def api_decide(approval_id: str, request: Request) -> Any:
        data = await _read_body(request)
        approve = _truthy(data.get("approve"))
        if approve is None:
            raise HTTPException(400, "Say approve: true or false.")
        remember = bool(_truthy(data.get("remember")))
        rid = _coerce_id(approval_id)
        row = store.get(rid)
        if row is None or _val(row, "deleted"):
            raise HTTPException(404, "There is no such request.")
        if _val(row, "status") != "pending":
            raise HTTPException(409, "This one was already decided.")
        try:
            store.decide(rid, approve=approve, remember=remember, by="user")
        except (KeyError, ValueError) as exc:  # decided or deleted from another tab just now
            raise HTTPException(409, "This one was already decided.") from exc
        events.emit("sending" if approve else "idle", f"approval {rid}")
        if _is_form(request):
            return RedirectResponse("/", status_code=303)
        return {"ok": True, "id": rid, "status": "approved" if approve else "denied", "remember": remember}

    @app.post("/api/history/{approval_id}/delete")
    async def api_delete(approval_id: str, request: Request) -> Any:
        rid = _coerce_id(approval_id)
        if store.get(rid) is None:
            raise HTTPException(404, "There is no such decision.")
        store.delete(rid)
        if _is_form(request):
            return RedirectResponse("/history", status_code=303)
        return {"ok": True, "id": rid}

    @app.post("/api/dream")
    def api_dream(request: Request) -> Any:
        start = getattr(getattr(services, "night", None), "start", None)
        if not callable(start):
            raise HTTPException(503, "Dreaming is not set up on this device yet.")
        job = start()
        if _is_form(request):
            return RedirectResponse("/dreaming", status_code=303)
        return {"ok": True, "job_id": None if job is None else str(job)}

    @app.post("/api/pair-code")
    def api_pair_code() -> dict[str, Any]:
        if not login_required:
            return {"needed": False}
        code = pairing.new_code()
        print_pairing_code(code)
        return {"needed": True, "code": code, "expires_in": CODE_SECONDS}

    @app.get("/api/status")
    def api_status() -> dict[str, Any]:
        light = events.last()
        return {
            "device": settings.device,
            "backend": settings.glimmer_backend,
            "answer_model": settings.answer_model,
            "router_model": settings.router_model,
            "light": {"state": light.state, "detail": light.detail, "ts": light.ts},
            "pending": len(pending_rows()),
            "heavy_queue": settings.heavy_queue,
            "login_required": login_required,
        }

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {"ok": True}

    @app.get("/events")
    def sse() -> StreamingResponse:
        return StreamingResponse(
            event_stream(HEARTBEAT_SECONDS),
            media_type="text/event-stream",
            headers={"x-accel-buffering": "no"},
        )

    _include_heavy(app, services)
    return app


def print_pairing_code(code: str) -> None:
    """Show a pairing code on the device console (never sent anywhere else)."""
    print(
        f"Pairing code for the approval page: {code}. It works once and expires in "
        f"{CODE_SECONDS // 60} minutes. Open /pair in your browser to enter it.",
        flush=True,
    )


def _include_heavy(app: FastAPI, services: Any) -> bool:
    """Add base.heavy.routes when heavy_queue is on and the module exists."""
    if not services.settings.heavy_queue:
        return False
    try:
        from base.heavy import routes
    except ImportError:
        return False
    router_for = getattr(routes, "router_for", None)
    if callable(router_for):
        router = router_for(services.settings, getattr(services, "heavy", None))
    else:
        router = getattr(routes, "router", None)
    if router is None:
        return False
    app.include_router(router)
    return True
