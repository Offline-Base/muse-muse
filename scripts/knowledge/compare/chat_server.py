"""Side-by-side chat page for the compare lab (docs/COMPARE.md).

One prompt goes to every model of a chat at once and streams into one column per model. The page and its API listen on
127.0.0.1 only. The server proxies to the lab's llama-server ports through the SSH tunnel that lab.py keeps open
(127.0.0.1:18201..18209) and never starts a model. Nothing runs a model on this Mac.

Usage: python3 scripts/knowledge/compare/chat_server.py [--port 8788]
       then open http://127.0.0.1:8788/

What it keeps private:
- Request and response bodies are never logged. The log line is time, method, path and status.
- Reasoning deltas go to the browser only. They reach disk only for a chat started with "save reasoning" ticked.
- Transcripts go to .data/compare/chats/<session>.json (gitignored, mode 600). They can hold private dev questions, so
  they stay on this Mac.

API (all JSON; POST needs Content-Type application/json and an Origin equal to the page's own):
  GET  /api/config            models with health, sampling defaults, lab summary
  POST /api/session           {"models", "blind", "save_reasoning", "system"} -> {"session", "columns"}
  POST /api/turn              {"session", "col", "messages", "reasoning", "sampling", "turn"?}, text/event-stream
  POST /api/turns             {"session", "turn", "sampling", "columns": [{"col", "messages", "reasoning"}]}: every column
                              of a turn on one stream, each event tagged "c": col (the page uses this one, so a turn
                              takes one browser connection however many columns it has)
  POST /api/stop              {"session", "col"?}: stops that column, or every column of the chat
  POST /api/vote              {"session", "turn", "col"}
  POST /api/reveal            {"session"}
  POST /api/keepalive         touches the lab's last_use so the idle timer restarts
  GET  /api/sessions, /api/sessions/<id>, /api/reports, /api/lab, /api/health[?session=<id>]
  GET  /reports/<run_id>/report.html (or report.md), served sandboxed
"""

import argparse
import copy
import http.client
import json
import os
import re
import secrets
import select
import socket
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common  # noqa: E402

WEB = os.path.join(HERE, "web")
LETTERS = "ABCDEFGHI"
SESSION_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{4}$")
RUN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
MAX_BODY = 4_000_000
MAX_MESSAGES = 400
MAX_SYSTEM = 20_000
REQUEST_TIMEOUT = 900
TOUCH_EVERY = 30
BEAT_EVERY = 15
LAB_CACHE_SECONDS = 5
CONTEXT_FULL = "context full, start a new chat"
DEFAULTS = {"temperature": 0.7, "top_p": 0.95, "top_k": 40, "max_tokens": 2048, "max_tokens_on": 4096}
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
PAGE_CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
            "frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'")
# Eval reports are builder C's self-contained pages (inline CSS and JS). They run sandboxed, in an opaque origin, so
# nothing in a report can call this API even if a model's text got into its markup.
REPORT_CSP = ("sandbox allow-scripts allow-popups; default-src 'none'; script-src 'unsafe-inline'; "
              "style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def clip(text, n=200):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 3] + "..."


def parse_iso(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def et_clock(value):
    """'9:41 PM ET' for a UTC ISO time (DST-aware through common.ET)."""
    t = parse_iso(value)
    if t is None:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    t = t.astimezone(common.ET)
    return t.strftime("%I:%M %p").lstrip("0") + " " + (t.tzname() or "ET")


def is_context_full(status, etype, message):
    low = (message or "").lower()
    return etype == "exceed_context_size_error" or ("context" in low and any(w in low for w in ("exceed", "too long", "full")))


def upstream_error(status, raw):
    """(status, message) from an error body: the status and at most 200 characters of the message, never more."""
    message, etype = "", ""
    try:
        doc = json.loads(raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw)
        err = doc.get("error", doc) if isinstance(doc, dict) else doc
        if isinstance(err, dict):
            message, etype = str(err.get("message") or ""), str(err.get("type") or "")
            status = int(err.get("code") or status) if str(err.get("code") or "").isdigit() else status
        elif isinstance(err, str):
            message = err
    except (ValueError, AttributeError):
        message = ""
    if is_context_full(status, etype, message):
        return status, CONTEXT_FULL
    return status, clip(message or http.client.responses.get(status, "error"))


def clean_messages(raw):
    """A column's history without the system message: user and assistant turns, ending on a user turn."""
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_MESSAGES:
        raise ValueError("messages must be a list of 1 to %d turns" % MAX_MESSAGES)
    out, total = [], 0
    for m in raw:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant") or not isinstance(m.get("content"), str):
            raise ValueError("each message needs a role of user or assistant and a text content")
        total += len(m["content"])
        out.append({"role": m["role"], "content": m["content"]})
    if out[-1]["role"] != "user" or not out[-1]["content"].strip():
        raise ValueError("the last message must be a user turn with text")
    if total > MAX_BODY // 2:
        raise ValueError("the conversation is too long")
    return out


class Stream:
    """One column's upstream request, so a Stop or a lost browser can close it (llama-server then stops generating)."""

    def __init__(self):
        self.cancelled = threading.Event()
        self._lock = threading.Lock()
        self._conn = None

    def attach(self, conn):
        with self._lock:
            self._conn = conn
        if self.cancelled.is_set():
            self._shut()

    def cancel(self):
        self.cancelled.set()
        self._shut()

    def _shut(self):
        with self._lock:
            sock = getattr(self._conn, "sock", None)
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class Emitter:
    """The text/event-stream writer of one browser response, shared by the columns streaming into it."""

    def __init__(self, handler, tag):
        self.handler = handler
        self.tag = tag
        self.lock = threading.Lock()
        self.gone = threading.Event()
        self.streams = []

    def add(self, stream):
        with self.lock:
            self.streams.append(stream)
        if self.gone.is_set():
            stream.cancel()

    def _write(self, data):
        if self.gone.is_set():
            return False
        with self.lock:
            try:
                self.handler.wfile.write(data)
                self.handler.wfile.flush()
                return True
            except (OSError, ValueError):
                pass
        self.lost()
        return False

    def send(self, event, col=None):
        if self.tag and col is not None:
            event = {**event, "c": col}
        return self._write(("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode("utf-8"))

    def beat(self):
        return self._write(b": keepalive\n\n")

    def lost(self):
        self.gone.set()
        with self.lock:
            streams = list(self.streams)
        for s in streams:
            s.cancel()


class App:
    def __init__(self, config_path=None, data_dir=None, touch=None, lab_summary=None, active_lab=None, quiet=False):
        self.config_path = config_path or common.CONFIG
        self.data = data_dir or common.DATA
        self.chats = os.path.join(self.data, "chats")
        self.evals = os.path.join(self.data, "evals")
        # A non-default data folder (tests, a dry run against fake servers) keeps its own last_use, so it never
        # holds a real lab machine awake.
        self.touch = touch or (common.touch_last_use if os.path.abspath(self.data) == os.path.abspath(common.DATA)
                               else lambda: self._touch_own(os.path.join(self.data, "lab", "last_use")))
        self._lab_summary = lab_summary or (lambda: common.lab_summary(self.cfg()))
        self._active_lab = active_lab or common.active_lab
        self._lab_cache = (0.0, None)
        self._lab_cache_lock = threading.Lock()
        self.quiet = quiet
        self.allowed_hosts = set()
        self.port = None
        self._cfg = None
        self._cfg_mtime = None
        self._cfg_lock = threading.Lock()
        self._locks = {}
        self._locks_lock = threading.Lock()
        self.active = {}
        self._active_lock = threading.Lock()

    @staticmethod
    def _touch_own(path):
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a"):
                pass
            os.utime(path, None)
        except OSError:
            pass

    # config and lab

    def cfg(self):
        with self._cfg_lock:
            mtime = os.stat(self.config_path).st_mtime_ns
            if self._cfg is None or mtime != self._cfg_mtime:
                self._cfg = common.load_config(self.config_path)
                self._cfg_mtime = mtime
            return self._cfg

    def lab_summary(self, fresh=False):
        """common.lab_summary(), cached for a few seconds: it runs ps to check the watch and the tunnel."""
        with self._lab_cache_lock:
            at, value = self._lab_cache
            if not fresh and value is not None and time.monotonic() - at < LAB_CACHE_SECONDS:
                return dict(value)
        try:
            value = dict(self._lab_summary() or {})
        except Exception as e:  # the page must load whatever state the lab is in
            value = {"up": False, "ready": False, "error": type(e).__name__}
        with self._lab_cache_lock:
            self._lab_cache = (time.monotonic(), value)
        return dict(value)

    def active_lab(self):
        try:
            return self._active_lab()
        except Exception:
            return None

    def token_caps(self):
        """(cap for thinking on, cap for thinking off): the lab's max_tokens_on_cap, and its context per slot."""
        s = self.lab_summary()
        on, ctx = s.get("max_tokens_on_cap"), s.get("ctx_per_slot")
        on = int(on) if isinstance(on, (int, float)) and on > 0 else None
        ctx = int(ctx) if isinstance(ctx, (int, float)) and ctx > 0 else None
        return on, ctx

    def defaults(self):
        d = {"system": common.SYSTEM, **DEFAULTS}
        on, ctx = self.token_caps()
        if on:
            d["max_tokens_on"] = min(d["max_tokens_on"], on)
        if ctx:
            d["max_tokens"] = min(d["max_tokens"], ctx)
        return d

    def probe(self, m, cfg):
        """GET /health through the tunnel: ok (200), loading (503) or down. http.client, so no proxy setting applies."""
        conn = http.client.HTTPConnection("127.0.0.1", common.local_port(m, cfg), timeout=3)
        try:
            conn.request("GET", "/health")
            status = conn.getresponse().status
            return "ok" if status == 200 else "loading" if status == 503 else "down"
        except (OSError, http.client.HTTPException):
            return "down"
        finally:
            conn.close()

    def healths(self, ms, cfg):
        if not ms:
            return {}
        with ThreadPoolExecutor(max_workers=min(9, len(ms))) as pool:
            return dict(zip([m["name"] for m in ms], pool.map(lambda m: self.probe(m, cfg), ms)))

    @staticmethod
    def modes(m):
        return [k for k in ("off", "on") if isinstance((m.get("request") or {}).get(k), dict)]

    def model_view(self, m, cfg, health, servers, replaced_by):
        try:
            bits = round(float(common.bpw(m)), 2) or None
        except (TypeError, ValueError, KeyError, ZeroDivisionError):
            bits = None
        server = servers.get(m["name"]) if isinstance(servers, dict) else None
        state = server.get("state") if isinstance(server, dict) else server if isinstance(server, str) else None
        return {"name": m["name"], "label": m.get("label") or m["name"], "role": m.get("role"), "publisher": m.get("publisher"),
                "license": m.get("license"), "quant": m.get("quant"), "bpw": bits, "params_b": m.get("params_b"),
                "reasoning_level": m.get("reasoning_level"), "cutoff": m.get("cutoff"), "file": m.get("file"),
                "reasoning": self.modes(m), "health": health, "local_port": common.local_port(m, cfg),
                "replaced_by": replaced_by, "server_state": state}

    def config_view(self):
        cfg = self.cfg()
        ms = common.models(cfg, enabled_only=True)
        health = self.healths(ms, cfg)
        replaced = {m["replaces"]: m["name"] for m in ms if m.get("replaces")}
        lab = self.lab_view()
        return {"models": [self.model_view(m, cfg, health.get(m["name"], "down"), lab.get("servers") or {}, replaced.get(m["name"])) for m in ms],
                "defaults": self.defaults(), "lab": lab}

    def lab_view(self, fresh=False):
        """lab_summary() for the banner, plus a short ET clock for the machine's end time."""
        s = self.lab_summary(fresh)
        machine = self.active_lab() if s.get("up") else None
        if isinstance(machine, dict):
            s["ends_by_et"] = et_clock(machine.get("deadline"))
            if s.get("uptime_minutes") is None:
                launched = parse_iso(machine.get("launched"))
                if launched is not None:
                    launched = launched if launched.tzinfo else launched.replace(tzinfo=timezone.utc)
                    s["uptime_minutes"] = round((datetime.now(timezone.utc) - launched).total_seconds() / 60, 1)
            if not s.get("servers"):
                s["servers"] = {k: v.get("state") for k, v in (machine.get("servers") or {}).items() if isinstance(v, dict)}
        s["now_et"] = et_clock(now_iso())
        return s

    def health_view(self, sid=None):
        cfg = self.cfg()
        if sid:
            sess = self.read_session(sid)
            if sess is None:
                return None
            pairs = []
            for c in sess["columns"]:
                try:
                    pairs.append((c["col"], common.model(c["model"], cfg)))
                except KeyError:
                    pairs.append((c["col"], None))
            found = [m for _, m in pairs if m]
            h = self.healths(found, cfg)
            return {"cols": {col: (h.get(m["name"], "down") if m else "down") for col, m in pairs}}
        ms = common.models(cfg, enabled_only=True)
        return {"models": self.healths(ms, cfg)}

    # sessions on disk

    def lock_for(self, sid):
        with self._locks_lock:
            return self._locks.setdefault(sid, threading.Lock())

    def session_path(self, sid):
        if not isinstance(sid, str) or not SESSION_RE.match(sid):
            return None
        return os.path.join(self.chats, sid + ".json")

    def _read(self, path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _write(self, path, doc):
        os.makedirs(self.chats, mode=0o700, exist_ok=True)
        tmp = "%s.%d.%d.tmp" % (path, os.getpid(), threading.get_ident())
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)

    def read_session(self, sid):
        path = self.session_path(sid)
        if path is None:
            return None
        with self.lock_for(sid):
            return self._read(path)

    def update_session(self, sid, change):
        path = self.session_path(sid)
        if path is None:
            return None
        with self.lock_for(sid):
            doc = self._read(path)
            if doc is None:
                return None
            change(doc)
            self._write(path, doc)
            return doc

    @staticmethod
    def public(doc):
        """A transcript as the page may see it: a blind chat keeps its names hidden until it is revealed."""
        doc = copy.deepcopy(doc)
        if doc.get("blind") and not doc.get("revealed"):
            for c in doc.get("columns", []):
                for k in ("model", "label", "file", "sha256"):
                    c[k] = None
        return doc

    def columns_view(self, doc, cfg):
        hidden = doc.get("blind") and not doc.get("revealed")
        out = []
        for c in doc["columns"]:
            try:
                modes = self.modes(common.model(c["model"], cfg))
            except KeyError:
                modes = ["off"]
            out.append({"col": c["col"], "model": None if hidden else c["model"], "label": None if hidden else c["label"], "reasoning": modes})
        return out

    def create_session(self, body):
        cfg = self.cfg()
        names = body.get("models")
        enabled = {m["name"]: m for m in common.models(cfg, enabled_only=True)}
        if not isinstance(names, list) or not 1 <= len(names) <= len(LETTERS) or len(set(map(str, names))) != len(names):
            raise ValueError("pick 1 to %d different models" % len(LETTERS))
        for n in names:
            if n not in enabled:
                raise ValueError("unknown or disabled model: " + clip(n, 60))
        system = body.get("system")
        if not isinstance(system, str) or not system.strip():
            system = common.SYSTEM
        if len(system) > MAX_SYSTEM:
            raise ValueError("the system prompt is too long")
        blind = body.get("blind") is True
        order = list(names)
        if blind:
            secrets.SystemRandom().shuffle(order)
        lab = self.lab_summary()
        doc = {"session": None, "created": now_iso(), "blind": blind, "revealed": False, "save_reasoning": body.get("save_reasoning") is True,
               "system": system, "lab": {k: lab.get(k) for k in ("type", "kv", "ctx_per_slot")},
               "columns": [{"col": LETTERS[i], "model": n, "label": enabled[n].get("label") or n, "file": enabled[n].get("file"),
                            "sha256": enabled[n].get("sha256")} for i, n in enumerate(order)],
               "turns": []}
        while True:
            sid = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
            path = self.session_path(sid)
            if not os.path.exists(path):
                break
        doc["session"] = sid
        with self.lock_for(sid):
            self._write(path, doc)
        return {"session": sid, "created": doc["created"], "blind": blind, "revealed": False, "save_reasoning": doc["save_reasoning"],
                "system": system, "columns": self.columns_view(doc, cfg)}

    def sessions_list(self):
        out = []
        try:
            names = sorted((f for f in os.listdir(self.chats) if f.endswith(".json")), reverse=True)
        except OSError:
            names = []
        for f in names[:300]:
            sid = f[:-5]
            if not SESSION_RE.match(sid):
                continue
            doc = self.read_session(sid)
            if not doc:
                continue
            pub = self.public(doc)
            turns = pub.get("turns") or []
            out.append({"session": sid, "created": pub.get("created"), "blind": pub.get("blind"), "revealed": pub.get("revealed"),
                        "labels": [c.get("label") for c in pub.get("columns", [])], "turns": len(turns),
                        "votes": sum(1 for t in turns if t.get("vote")), "first": clip(turns[0].get("user"), 120) if turns else ""})
        return {"sessions": out}

    def ensure_turn(self, sid, n, user):
        def change(doc):
            turns = doc.setdefault("turns", [])
            if not any(t.get("n") == n for t in turns):
                turns.append({"n": n, "at": now_iso(), "user": user, "vote": None, "replies": {}})
                turns.sort(key=lambda t: t.get("n", 0))
        self.update_session(sid, change)

    def save_reply(self, sid, n, col, reply, user):
        def change(doc):
            turns = doc.setdefault("turns", [])
            turn = next((t for t in turns if t.get("n") == n), None)
            if turn is None:
                turn = {"n": n, "at": now_iso(), "user": user, "vote": None, "replies": {}}
                turns.append(turn)
                turns.sort(key=lambda t: t.get("n", 0))
            turn.setdefault("replies", {})[col] = reply
        self.update_session(sid, change)

    def vote(self, body):
        sid, n, col = body.get("session"), body.get("turn"), body.get("col")
        result = {}

        def change(doc):
            if col is not None and col not in [c["col"] for c in doc["columns"]]:
                raise ValueError("unknown column")
            turn = next((t for t in doc.get("turns", []) if t.get("n") == n), None)
            if turn is None:
                raise ValueError("unknown turn")
            turn["vote"] = col
            turn["vote_at"] = now_iso()
            turn["vote_saw_names"] = not doc.get("blind") or bool(doc.get("revealed"))
            result["vote"] = col
        if self.update_session(sid, change) is None:
            raise LookupError("unknown chat")
        return {"ok": True, **result}

    def reveal(self, body):
        sid = body.get("session")

        def change(doc):
            if not doc.get("revealed"):
                doc["revealed"] = True
                doc["revealed_at"] = now_iso()
        doc = self.update_session(sid, change)
        if doc is None:
            raise LookupError("unknown chat")
        return {"session": sid, "revealed": True, "columns": self.columns_view(doc, self.cfg())}

    # eval reports (builder C writes them)

    def reports_list(self):
        out = []
        try:
            names = sorted(os.listdir(self.evals), reverse=True)
        except OSError:
            names = []
        for run in names[:200]:
            d = os.path.join(self.evals, run)
            if not RUN_RE.match(run) or not os.path.isdir(d):
                continue
            html, md = os.path.join(d, "report.html"), os.path.join(d, "report.md")
            meta = {}
            mp = os.path.join(d, "meta.json")
            try:
                if os.path.getsize(mp) < 5_000_000:
                    with open(mp, encoding="utf-8") as f:
                        meta = json.load(f)
            except (OSError, ValueError):
                meta = {}
            meta = meta if isinstance(meta, dict) else {}

            def names_of(v):
                if isinstance(v, dict):
                    return list(v.keys())
                if isinstance(v, list):
                    return [x.get("name") or x.get("model") or x.get("set") if isinstance(x, dict) else str(x) for x in v]
                return []
            runs = meta.get("sessions") if isinstance(meta.get("sessions"), list) else []
            lab = meta.get("lab") or next((x.get("lab") for x in reversed(runs) if isinstance(x, dict) and x.get("lab")), None)
            stamp = datetime.fromtimestamp(os.path.getmtime(html) if os.path.exists(html) else os.path.getmtime(d), timezone.utc)
            out.append({"run_id": run, "has_html": os.path.exists(html), "has_md": os.path.exists(md),
                        "modified": stamp.isoformat(timespec="seconds").replace("+00:00", "Z"), "modified_et": et_clock(stamp.isoformat()),
                        "models": [str(x) for x in names_of(meta.get("models")) if x], "sets": [str(x) for x in names_of(meta.get("sets")) if x],
                        "start": meta.get("start"), "end": meta.get("end"),
                        "lab_type": meta.get("lab_type") or (lab.get("type") if isinstance(lab, dict) else lab if isinstance(lab, str) else None)})
        return {"reports": out}

    def report_file(self, run, name):
        if not RUN_RE.match(run) or name not in ("report.html", "report.md"):
            return None
        root = os.path.realpath(self.evals)
        path = os.path.realpath(os.path.join(root, run, name))
        if not path.startswith(root + os.sep) or not os.path.isfile(path):
            return None
        return path

    # turns

    def clean_sampling(self, raw, mode):
        raw = raw if isinstance(raw, dict) else {}
        d = self.defaults()

        def num(key, lo, hi, cast, default):
            v = raw.get(key)
            try:
                v = cast(v)
            except (TypeError, ValueError):
                return default
            if v != v:  # NaN
                return default
            return max(lo, min(hi, v))
        greedy = raw.get("greedy") is True
        if greedy:
            temperature, top_p, top_k = 0.0, 1.0, 1
        else:
            temperature = num("temperature", 0.0, 2.0, float, d["temperature"])
            top_p = num("top_p", 0.0, 1.0, float, d["top_p"])
            top_k = num("top_k", 0, 1000, int, d["top_k"])
        seed = raw.get("seed")
        if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2 ** 31:
            seed = secrets.randbelow(2 ** 31)
        max_tokens = num("max_tokens", 1, 32768, int, d["max_tokens_on"] if mode == "on" else d["max_tokens"])
        on_cap, ctx = self.token_caps()
        cap = on_cap if mode == "on" else ctx
        if cap:
            max_tokens = min(max_tokens, cap)
        return {"temperature": temperature, "top_p": top_p, "top_k": top_k, "seed": seed, "max_tokens": max_tokens, "greedy": greedy}

    def run_column(self, sid, col, messages, mode, sampling, n, emit, emitter):
        """Streams one column's reply to emit() and saves it in the transcript. Never raises."""
        user = messages[-1]["content"]
        sess = self.read_session(sid)
        if sess is None:
            emit({"t": "error", "status": 404, "message": "unknown chat"})
            return
        column = next((c for c in sess["columns"] if c["col"] == col), None)
        if column is None:
            emit({"t": "error", "status": 404, "message": "unknown column"})
            return
        cfg = self.cfg()
        try:
            m = common.model(column["model"], cfg)
        except KeyError:
            emit({"t": "error", "status": 404, "message": "that model is no longer in models.json"})
            return
        if mode not in self.modes(m):
            emit({"t": "error", "status": 400, "message": "this model has no reasoning mode '%s'" % clip(mode, 20)})
            return
        s = self.clean_sampling(sampling, mode)
        try:
            body = common.request_body(m, [{"role": "system", "content": sess["system"]}] + messages, mode, max_tokens=s["max_tokens"], stream=True,
                                       temperature=s["temperature"], top_p=s["top_p"], top_k=s["top_k"], seed=s["seed"], cache_prompt=True)
        except ValueError as e:
            emit({"t": "error", "status": 400, "message": clip(e)})
            return
        key = (sid, col)
        stream = Stream()
        with self._active_lock:
            if key in self.active:
                emit({"t": "error", "status": 409, "message": "this column is still answering"})
                return
            self.active[key] = stream
        try:
            emitter.add(stream)
            self.ensure_turn(sid, n, user)
            self.touch()
            emit({"t": "start", "mode": mode, "turn": n, "sampling": s})
            r = self.relay(m, common.base_url(m, cfg), body, emit, stream, sess.get("save_reasoning") is True)
            reply = {"mode": mode, "final": r["final"], "finish": r["finish"], "usage": r["usage"], "timings": r["timings"],
                     "reasoning_chars": r["reasoning_chars"], "sampling": s, "error": r["error"]}
            if sess.get("save_reasoning") is True:
                reply["reasoning"] = r["reasoning"]
            self.save_reply(sid, n, col, reply, user)
        except Exception as e:  # a disk or programming error must not leave the browser waiting
            emit({"t": "error", "status": 500, "message": "chat server error (%s)" % type(e).__name__})
        finally:
            with self._active_lock:
                if self.active.get(key) is stream:
                    del self.active[key]
            self.touch()

    def relay(self, m, url, body, emit, stream, keep_reasoning):
        """POSTs one streamed chat completion and relays it as page events. Returns what the transcript keeps."""
        u = urllib.parse.urlsplit(url)
        t0 = time.monotonic()
        first = None
        raw, shown = "", ""
        reasoning, rchars, deltas = [], 0, 0
        finish, usage, timings, err, done = None, {}, {}, None, False
        conn = http.client.HTTPConnection(u.hostname, u.port, timeout=REQUEST_TIMEOUT)
        try:
            try:
                conn.connect()
            except OSError:
                err = (502, "model server not reachable on 127.0.0.1:%d (lab down or tunnel closed)" % u.port)
            if err is None:
                stream.attach(conn)
                if stream.cancelled.is_set():
                    raise ConnectionAbortedError
                conn.request("POST", "/v1/chat/completions", body=json.dumps(body).encode("utf-8"),
                             headers={"Content-Type": "application/json", "Accept": "text/event-stream"})
                resp = conn.getresponse()
                if resp.status != 200:
                    err = upstream_error(resp.status, resp.read(65536))
                while err is None:
                    line = resp.readline(1 << 22)
                    if not line:
                        break
                    line = line.strip()
                    if line.startswith(b"error:"):
                        err = upstream_error(500, line[6:].strip())
                        break
                    if not line.startswith(b"data:"):
                        continue
                    data = line[5:].strip()
                    if data == b"[DONE]":
                        done = True
                        break
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    if not isinstance(chunk, dict):
                        continue
                    if chunk.get("error"):
                        err = upstream_error(500, data)
                        break
                    if isinstance(chunk.get("usage"), dict):
                        usage = chunk["usage"]
                    if isinstance(chunk.get("timings"), dict):
                        timings = chunk["timings"]
                    for choice in chunk.get("choices") or []:  # the usage chunk has "choices": []
                        delta = choice.get("delta") or {}
                        r, c = delta.get("reasoning_content"), delta.get("content")
                        if isinstance(r, str) and r:
                            first = first or time.monotonic()
                            deltas += 1
                            rchars += len(r)
                            if keep_reasoning:
                                reasoning.append(r)
                            emit({"t": "reasoning", "d": r})
                        if isinstance(c, str) and c:
                            first = first or time.monotonic()
                            deltas += 1
                            raw += c
                            final = common.final_text(m, raw)
                            if final.startswith(shown):
                                if len(final) > len(shown):
                                    emit({"t": "content", "d": final[len(shown):]})
                                else:  # markup final_text drops (an unparsed thinking block): progress only, no text
                                    emit({"t": "tick"})
                            else:
                                emit({"t": "content", "d": final, "replace": True})
                            shown = final
                        if choice.get("finish_reason"):
                            finish = choice["finish_reason"]
        except (OSError, http.client.HTTPException, ConnectionAbortedError) as e:
            if not stream.cancelled.is_set():
                err = (502, "the model server connection failed (%s)" % type(e).__name__)
        finally:
            conn.close()
        end = time.monotonic()
        final = common.final_text(m, raw)
        if stream.cancelled.is_set() and err is None and not done:
            finish = "stopped"
        elif err is None and finish is None:
            finish = "stop" if done else "incomplete"
        completion = usage.get("completion_tokens")
        if not isinstance(completion, int):
            completion = deltas
        ttft = (first - t0) * 1000 if first else None
        gen_ms = timings.get("predicted_ms")
        if not isinstance(gen_ms, (int, float)) or gen_ms <= 0:
            gen_ms = (end - first) * 1000 if first else None
        tok_s = timings.get("predicted_per_second")
        if not isinstance(tok_s, (int, float)) or tok_s <= 0:
            tok_s = completion / (gen_ms / 1000) if gen_ms and completion else None
        prompt_ms = timings.get("prompt_ms") if isinstance(timings.get("prompt_ms"), (int, float)) else None

        def r1(x):
            return round(x, 1) if isinstance(x, (int, float)) else None
        out = {"final": final, "finish": "error" if err else finish,
               "usage": {"prompt": usage.get("prompt_tokens") if isinstance(usage.get("prompt_tokens"), int) else None, "completion": completion},
               "timings": {"ttft_ms": r1(ttft), "total_ms": r1((end - t0) * 1000), "prompt_ms": r1(prompt_ms), "gen_ms": r1(gen_ms), "tok_s": r1(tok_s)},
               "reasoning_chars": rchars, "reasoning": "".join(reasoning), "error": None}
        if err:
            out["error"] = {"status": err[0], "message": err[1]}
            emit({"t": "error", "status": err[0], "message": err[1], "final": final, "reasoning_chars": rchars})
        else:
            emit({"t": "done", "final": final, "finish": finish, "usage": out["usage"], "timings": out["timings"], "reasoning_chars": rchars})
        return out

    def stop(self, body):
        sid, col = body.get("session"), body.get("col")
        with self._active_lock:
            hits = [(k, s) for k, s in self.active.items() if k[0] == sid and (col is None or k[1] == col)]
        for _, s in hits:
            s.cancel()
        return {"stopped": sorted(k[1] for k, _ in hits)}


class Handler(BaseHTTPRequestHandler):
    server_version = "CompareChat/1"
    sys_version = ""

    @property
    def app(self):
        return self.server.app

    def log_message(self, fmt, *args):  # nothing from the default logger: no bodies, no headers
        pass

    def log_request(self, code="-", size="-"):
        if not self.app.quiet:
            path = urllib.parse.urlsplit(self.path).path
            sys.stderr.write("%s %s %s %s\n" % (datetime.now(common.ET).strftime("%H:%M:%S"), self.command, path[:120], code))

    # responses

    def headers_common(self, ctype, length=None, csp=PAGE_CSP):
        self.send_header("Content-Type", ctype)
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", csp)
        if csp == PAGE_CSP:
            self.send_header("X-Frame-Options", "DENY")

    def send_bytes(self, code, data, ctype, csp=PAGE_CSP):
        self.send_response(code)
        self.headers_common(ctype, len(data), csp)
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, code, obj):
        self.send_bytes(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def fail(self, code, message):
        self.send_json(code, {"error": {"status": code, "message": clip(message)}})

    def check_host(self):
        if self.headers.get("Host", "") not in self.app.allowed_hosts:
            self.fail(403, "this page answers only on 127.0.0.1 or localhost")
            return False
        return True

    def check_origin(self):
        origin = self.headers.get("Origin")
        site = self.headers.get("Sec-Fetch-Site")
        if origin != "http://" + self.headers.get("Host", "") or (site and site not in ("same-origin", "none")):
            self.fail(403, "cross-origin request refused")
            return False
        return True

    def read_json(self):
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            self.fail(415, "send application/json")
            return None
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if not 0 <= n <= MAX_BODY:
            self.fail(413, "request too large")
            return None
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            self.fail(400, "the request body is not JSON")
            return None
        if not isinstance(body, dict):
            self.fail(400, "the request body must be a JSON object")
            return None
        return body

    # GET

    def guarded(self, work):
        """Runs one request; an unexpected error answers 500 with its type name only."""
        try:
            work()
        except (ConnectionError, TimeoutError):
            self.close_connection = True
        except Exception as e:
            self.close_connection = True
            try:
                self.fail(500, "chat server error (%s)" % type(e).__name__)
            except OSError:
                pass

    def do_GET(self):
        self.guarded(self.get)

    def do_POST(self):
        self.guarded(self.post)

    def get(self):
        if not self.check_host():
            return
        path = urllib.parse.urlsplit(self.path).path
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        app = self.app
        if path in STATIC:
            name, ctype = STATIC[path]
            try:
                with open(os.path.join(WEB, name), "rb") as f:
                    data = f.read()
            except OSError:
                return self.fail(404, "missing page file " + name)
            return self.send_bytes(200, data, ctype)
        if path == "/api/config":
            return self.send_json(200, app.config_view())
        if path == "/api/lab":
            return self.send_json(200, app.lab_view())
        if path == "/api/health":
            view = app.health_view((query.get("session") or [None])[0])
            return self.send_json(200, view) if view is not None else self.fail(404, "unknown chat")
        if path == "/api/sessions":
            return self.send_json(200, app.sessions_list())
        if path.startswith("/api/sessions/"):
            doc = app.read_session(path[len("/api/sessions/"):])
            return self.send_json(200, app.public(doc)) if doc else self.fail(404, "unknown chat")
        if path == "/api/reports":
            return self.send_json(200, app.reports_list())
        hit = re.fullmatch(r"/reports/([^/]+)/([^/]+)", path)
        if hit:
            file = app.report_file(urllib.parse.unquote(hit.group(1)), hit.group(2))
            if not file:
                return self.fail(404, "no such report")
            with open(file, "rb") as f:
                data = f.read()
            ctype = "text/html; charset=utf-8" if file.endswith(".html") else "text/plain; charset=utf-8"
            return self.send_bytes(200, data, ctype, REPORT_CSP)
        return self.fail(404, "not found")

    # POST

    def post(self):
        if not self.check_host() or not self.check_origin():
            return
        path = urllib.parse.urlsplit(self.path).path
        body = self.read_json()
        if body is None:
            return
        app = self.app
        try:
            if path == "/api/session":
                return self.send_json(200, app.create_session(body))
            if path == "/api/turn":
                return self.turn_stream(body, multi=False)
            if path == "/api/turns":
                return self.turn_stream(body, multi=True)
            if path == "/api/stop":
                return self.send_json(200, app.stop(body))
            if path == "/api/vote":
                return self.send_json(200, app.vote(body))
            if path == "/api/reveal":
                return self.send_json(200, app.reveal(body))
            if path == "/api/keepalive":
                app.touch()
                return self.send_json(200, {"ok": True, "lab": app.lab_view(fresh=True)})
        except LookupError as e:
            return self.fail(404, str(e))
        except ValueError as e:
            return self.fail(400, str(e))
        return self.fail(404, "not found")

    def turn_stream(self, body, multi):
        app = self.app
        sid = body.get("session")
        if app.read_session(sid) is None:
            raise LookupError("unknown chat")
        if multi:
            cols = body.get("columns")
            if not isinstance(cols, list) or not 1 <= len(cols) <= len(LETTERS):
                raise ValueError("columns must list 1 to %d columns" % len(LETTERS))
            jobs = []
            for c in cols:
                if not isinstance(c, dict):
                    raise ValueError("each column must be an object")
                jobs.append((str(c.get("col")), clean_messages(c.get("messages")), c.get("reasoning", "off"),
                             c.get("sampling") if isinstance(c.get("sampling"), dict) else body.get("sampling")))
            if len({j[0] for j in jobs}) != len(jobs):
                raise ValueError("a column appears twice")
        else:
            jobs = [(str(body.get("col")), clean_messages(body.get("messages")), body.get("reasoning", "off"), body.get("sampling"))]
        n = body.get("turn")
        if isinstance(n, bool) or not isinstance(n, int) or n < 1:
            n = sum(1 for m in jobs[0][1] if m["role"] == "user")
        for _, _, mode, _ in jobs:
            if mode not in ("off", "on"):
                raise ValueError("reasoning must be off or on")

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        emitter = Emitter(self, tag=multi)
        emitter.beat()
        finished = threading.Event()
        watcher = threading.Thread(target=self.watch_client, args=(emitter, finished), daemon=True)
        watcher.start()
        threads = []
        for col, msgs, mode, sampling in jobs:
            emit = (lambda e, col=col: emitter.send(e, col))
            t = threading.Thread(target=app.run_column, args=(sid, col, msgs, mode, sampling, n, emit, emitter), daemon=True)
            t.start()
            threads.append(t)
        for t in threads:
            t.join()
        if multi:
            emitter.send({"t": "end"})
        finished.set()
        watcher.join(timeout=2)
        self.close_connection = True

    def watch_client(self, emitter, finished):
        """Closes the upstream requests when the browser goes away (Stop, a closed tab). Keeps last_use fresh meanwhile."""
        sock = self.connection
        touched = beat = time.monotonic()
        while not finished.wait(1.0):
            try:
                readable, _, _ = select.select([sock], [], [], 0)
                if readable and sock.recv(1, socket.MSG_PEEK) == b"":
                    emitter.lost()
                    return
            except (OSError, ValueError):
                emitter.lost()
                return
            now = time.monotonic()
            if now - touched >= TOUCH_EVERY:
                self.app.touch()
                touched = now
            if now - beat >= BEAT_EVERY:
                emitter.beat()
                beat = now


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, app, port):
        if port in common.FORBIDDEN_PORTS:
            raise ValueError("port %d is reserved; pick another" % port)
        super().__init__(("127.0.0.1", port), Handler)
        self.app = app
        app.port = self.server_address[1]
        app.allowed_hosts = {"127.0.0.1:%d" % app.port, "localhost:%d" % app.port}

    def handle_error(self, request, client_address):
        """A browser that leaves mid-request is normal. Anything else gets one line, the exception type only."""
        kind = sys.exc_info()[0]
        if kind is not None and issubclass(kind, (ConnectionError, TimeoutError)):
            return
        sys.stderr.write("chat server: request failed (%s)\n" % (kind.__name__ if kind else "unknown"))


def port_problem(port, cfg):
    """Why the page may not listen on this port, or None. Refused: outside 1024 to 65535, common.FORBIDDEN_PORTS
    (adb's 5037, another session's tunnel on 18000) and the lab tunnel's local ports (remote_ports plus
    local_port_offset), which the tunnel needs free (ExitOnForwardFailure)."""
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        return "Pick a port from 1024 to 65535."
    if port in common.FORBIDDEN_PORTS:
        return "Port %d is reserved (%s); pick another." % (port, "adb" if port == 5037 else "another session's tunnel")
    lab = (cfg or {}).get("lab") or {}
    try:
        lo, hi = (lab.get("remote_ports") or [8201, 8209])[:2]
        off = int(lab.get("local_port_offset", 10000))
    except (TypeError, ValueError):
        return None
    if lo + off <= port <= hi + off:
        return "Port %d is one of the lab tunnel's local ports (%d to %d); pick another." % (port, lo + off, hi + off)
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description="Side-by-side chat page for the compare lab, on 127.0.0.1 only.")
    ap.add_argument("--port", type=int, default=0, help="default: lab.chat_port in models.json (8788)")
    ap.add_argument("--host", default="127.0.0.1", help="only 127.0.0.1 is accepted")
    ap.add_argument("--config", default=common.CONFIG, help=argparse.SUPPRESS)
    ap.add_argument("--data", default=common.DATA, help=argparse.SUPPRESS)
    ap.add_argument("--quiet", action="store_true", help="no request log lines")
    a = ap.parse_args(argv)
    if a.host != "127.0.0.1":
        sys.exit("The chat page binds 127.0.0.1 only.")
    app = App(config_path=a.config, data_dir=a.data, quiet=a.quiet)
    try:
        cfg = app.cfg()
    except Exception as e:
        sys.exit("models.json did not load: %s" % clip(e))
    port = a.port or int((cfg.get("lab") or {}).get("chat_port") or 8788)
    problem = port_problem(port, cfg)
    if problem:
        sys.exit(problem)
    try:
        srv = Server(app, port)
    except OSError as e:
        sys.exit("Could not listen on 127.0.0.1:%d (%s). Is the chat page already running?" % (port, e.strerror or type(e).__name__))
    where = os.path.relpath(app.chats, common.ROOT) if os.path.abspath(app.chats).startswith(common.ROOT + os.sep) else app.chats
    print("Compare chat on http://127.0.0.1:%d/  (Ctrl+C stops it; transcripts go to %s)" % (port, where), flush=True)
    try:
        srv.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
