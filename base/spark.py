"""Muse Spark 1.3 through the Meta Model API. See docs/CONTRACTS.md, "Model clients".

For the eval harness and synthetic data only, never user data. Every message is checked first,
and any roster name, nickname or identifier hit refuses the call before anything is sent.
Responses are cached in SQLite keyed by the full request body, and every call (cached or not)
gets a row in `spark_calls` for token accounting.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import sqlite3
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from base.config import REPO_ROOT, Settings
from base.local_llm import parse_json, post_json_with_retry, response_format
from base.types import Roster

EFFORTS = ("minimal", "low", "medium", "high", "xhigh", "max")
DEFAULT_CACHE = REPO_ROOT / "eval" / ".cache" / "spark.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, response TEXT NOT NULL, ts REAL NOT NULL);
CREATE TABLE IF NOT EXISTS spark_calls (
    ts REAL NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cached INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0
);
"""


class SparkError(RuntimeError):
    """A Spark call failed."""


class SparkRefused(SparkError):
    """The input held a roster name or an identifier, so nothing was sent."""


@dataclass
class SparkResult:
    content: str
    usage: dict = field(default_factory=dict)
    cached: bool = False
    finish_reason: str | None = None


def _texts(messages: Iterable[dict]) -> Iterable[str]:
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            yield content
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    yield part["text"]


class Spark:
    """Muse Spark client with an input check, a response cache and token accounting.

    `checker(text) -> list of hits` decides what is refused. The default lazily imports
    base.guard and runs find_identifiers plus find_names with the roster (the one given, or
    settings.roster_path when it exists).
    """

    def __init__(
        self,
        settings: Settings,
        roster: Roster | None = None,
        *,
        checker: Callable[[str], list] | None = None,
        cache_path: Path | str | None = None,
        client: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
        timeout: float = 300,
    ):
        self.settings = settings
        self.roster = roster
        self.model = settings.spark_model
        self.url = f"{settings.spark_base.rstrip('/')}/chat/completions"
        self.cache_path = Path(cache_path) if cache_path else DEFAULT_CACHE
        self.timeout = timeout
        self._checker = checker
        self._client = client
        self._sleep = sleep
        self._lock = threading.Lock()
        self._ready = False

    # input check

    def _default_checker(self) -> Callable[[str], list]:
        guard = importlib.import_module("base.guard")
        roster = self.roster
        if roster is None and self.settings.roster_path.is_file():
            roster = guard.load_roster(self.settings.roster_path)

        def check(text: str) -> list:
            hits = list(guard.find_identifiers(text))
            if roster is not None:
                hits += list(guard.find_names(text, roster))
            return hits

        return check

    def check(self, messages: list[dict]) -> None:
        """Raise SparkRefused if any message has a roster name or identifier. Values are never echoed."""
        if self._checker is None:
            try:
                self._checker = self._default_checker()
            except ImportError as exc:
                raise SparkRefused("base.guard is unavailable, so the input cannot be checked") from exc
        kinds: set[str] = set()
        for text in _texts(messages):
            for hit in self._checker(text) or []:
                kinds.add(str(getattr(hit, "kind", "match")))
        if kinds:
            raise SparkRefused(
                "Spark is for invented eval data only; the input contains " + ", ".join(sorted(kinds))
            )

    # request

    def build_body(
        self,
        messages: list[dict],
        *,
        max_tokens: int = 4000,
        json_schema: dict | None = None,
        effort: str = "minimal",
    ) -> dict:
        if effort not in EFFORTS:
            raise ValueError(f"effort must be one of {EFFORTS}, not {effort!r}")
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [dict(m) for m in messages],
            "max_tokens": max_tokens,
            "reasoning_effort": effort,
        }
        if json_schema is not None:
            body["response_format"] = response_format(json_schema)
        return body

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(trust_env=False)  # never through an environment proxy
        return self._client

    def chat(
        self,
        messages: list[dict],
        *,
        max_tokens: int = 4000,
        json_schema: dict | None = None,
        effort: str = "minimal",
        cache: bool = True,
    ) -> SparkResult:
        self.check(messages)
        body = self.build_body(messages, max_tokens=max_tokens, json_schema=json_schema, effort=effort)
        key = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        if cache:
            stored = self._cache_get(key)
            if stored is not None:
                result = self._result(stored, cached=True)
                self._log(result)
                return result
        if not self.settings.meta_api_key:
            raise SparkError("META_API_KEY is not set")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.settings.meta_api_key}",
        }
        data = post_json_with_retry(
            self.client, self.url, body, headers, timeout=self.timeout, sleep=self._sleep, error=SparkError
        )
        result = self._result(data, cached=False)
        self._log(result)
        if cache and result.content.strip() and result.finish_reason != "length":
            self._cache_put(key, data)
        return result

    def chat_json(self, messages: list[dict], schema: dict, **kw: Any) -> dict:
        """chat() with a strict json_schema, returning the parsed object."""
        result = self.chat(messages, json_schema=schema, **kw)
        try:
            return parse_json(result.content)
        except ValueError as exc:
            raise SparkError("Spark reply was not valid JSON") from exc

    @staticmethod
    def _result(data: dict, *, cached: bool) -> SparkResult:
        try:
            choice = data["choices"][0]
        except (KeyError, IndexError, TypeError) as exc:
            raise SparkError("response has no choices") from exc
        message = choice.get("message") or {}
        return SparkResult(
            content=message.get("content") or "",
            usage=dict(data.get("usage") or {}),
            cached=cached,
            finish_reason=choice.get("finish_reason"),
        )

    # cache and accounting

    def _connect(self) -> sqlite3.Connection:
        if not self._ready:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.cache_path, timeout=30)
        if not self._ready:
            conn.executescript(SCHEMA)
            self._ready = True
        return conn

    def _cache_get(self, key: str) -> dict | None:
        with self._lock:
            conn = self._connect()
            try:
                row = conn.execute("SELECT response FROM responses WHERE key = ?", (key,)).fetchone()
            finally:
                conn.close()
        return json.loads(row[0]) if row else None

    def _cache_put(self, key: str, data: dict) -> None:
        with self._lock:
            conn = self._connect()
            try:
                with conn:
                    conn.execute(
                        "INSERT OR REPLACE INTO responses (key, response, ts) VALUES (?, ?, ?)",
                        (key, json.dumps(data), time.time()),
                    )
            finally:
                conn.close()

    def _log(self, result: SparkResult) -> None:
        usage = result.usage
        completion = usage.get("completion_tokens_details") or {}
        prompt = usage.get("prompt_tokens_details") or {}
        row = (
            time.time(),
            self.model,
            int(usage.get("prompt_tokens") or 0),
            int(usage.get("completion_tokens") or 0),
            int(completion.get("reasoning_tokens") or 0),
            int(result.cached),
            int(prompt.get("cached_tokens") or 0),
        )
        with self._lock:
            conn = self._connect()
            try:
                with conn:
                    conn.execute(
                        "INSERT INTO spark_calls (ts, model, prompt_tokens, completion_tokens, reasoning_tokens,"
                        " cached, cached_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        row,
                    )
            finally:
                conn.close()

    def usage_summary(self, since: float | None = None) -> dict[str, int]:
        """Token totals from spark_calls. Billed counts skip cache hits, which cost nothing."""
        return usage_summary(self.cache_path, since=since)


def usage_summary(cache_path: Path | str = DEFAULT_CACHE, since: float | None = None) -> dict[str, int]:
    """Totals over spark_calls (optionally only rows with ts >= since)."""
    empty = {
        "calls": 0,
        "api_calls": 0,
        "cache_hits": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "reasoning_tokens": 0,
        "cached_prompt_tokens": 0,
    }
    path = Path(cache_path)
    if not path.is_file():
        return empty
    conn = sqlite3.connect(path)
    try:
        row = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(cached = 0), 0), COALESCE(SUM(cached), 0),"
            " COALESCE(SUM(CASE WHEN cached = 0 THEN prompt_tokens END), 0),"
            " COALESCE(SUM(CASE WHEN cached = 0 THEN completion_tokens END), 0),"
            " COALESCE(SUM(CASE WHEN cached = 0 THEN reasoning_tokens END), 0),"
            " COALESCE(SUM(CASE WHEN cached = 0 THEN cached_tokens END), 0)"
            " FROM spark_calls WHERE ts >= ?",
            (since or 0,),
        ).fetchone()
    except sqlite3.OperationalError:
        return empty
    finally:
        conn.close()
    return dict(zip(empty, (int(v) for v in row), strict=True))
