"""Embeddings for search: EmbeddingGemma 2 on this device's own llama-server. See docs/CONTRACTS.md, Workspace.

Started by scripts/start_embedder.sh on 127.0.0.1:8084 (SEARCH_EMBEDDINGS=1). It reads raw document
text, so it must be this device: settings refuse any other address. Vectors are kept in memory,
keyed by a hash of the exact text sent, so a file that changes is embedded again on the next search
and one that does not is embedded once per process.
"""

from __future__ import annotations

import hashlib
import logging
import math
from collections import OrderedDict
from typing import Any

import httpx

from base.config import Settings

log = logging.getLogger(__name__)

CHUNK_CHARS = 800
CHUNK_OVERLAP = 150
MAX_CACHE = 20_000
BATCH = 16
TIMEOUT = httpx.Timeout(60.0, connect=5.0)


class EmbedError(RuntimeError):
    """The embedding server did not answer; search falls back to keywords only."""


def chunks(text: str, size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Overlapping pieces of about `size` characters, cut at a space where one is near."""
    flat = " ".join(text.split())
    if len(flat) <= size:
        return [flat] if flat else []
    out, start = [], 0
    while start < len(flat):
        end = min(start + size, len(flat))
        if end < len(flat):
            space = flat.rfind(" ", start + size // 2, end)
            end = space if space > 0 else end
        out.append(flat[start:end].strip())
        if end >= len(flat):
            break
        start = max(end - overlap, start + 1)
    return out


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))  # vectors are normalized on the way in


def _normalized(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class Embedder:
    """EmbeddingGemma 2 through llama-server's OpenAI-compatible /v1/embeddings."""

    def __init__(self, settings: Settings, *, client: httpx.Client | None = None):
        self.base_url = settings.embed_url.rstrip("/")
        self.model = settings.embed_model
        self.api_key = settings.checker_api_key  # the same key file as the other local servers
        self._client = client
        self._cache: OrderedDict[str, list[float]] = OrderedDict()

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(trust_env=False)  # no proxy between us and raw text
        return self._client

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def query(self, text: str) -> list[float]:
        return self._embed([f"task: search result | query: {text}"])[0]

    def documents(self, title: str, pieces: list[str]) -> list[list[float]]:
        head = title.replace("|", " ").strip() or "none"
        return self._embed([f"title: {head} | text: {p}" for p in pieces])

    def _embed(self, texts: list[str]) -> list[list[float]]:
        keys = [hashlib.sha256(t.encode("utf-8")).hexdigest() for t in texts]
        missing = [i for i, k in enumerate(keys) if k not in self._cache]
        for start in range(0, len(missing), BATCH):
            batch = missing[start : start + BATCH]
            for i, vector in zip(batch, self._post([texts[i] for i in batch]), strict=True):
                self._cache[keys[i]] = vector
                if len(self._cache) > MAX_CACHE:
                    self._cache.popitem(last=False)
        return [self._cache[k] for k in keys]

    def _post(self, texts: list[str]) -> list[list[float]]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        try:
            response = self.client.post(
                f"{self.base_url}/embeddings",
                json={"model": self.model, "input": texts},
                headers=headers,
                timeout=TIMEOUT,
            )
            response.raise_for_status()
            data: Any = response.json()["data"]
            rows = sorted(data, key=lambda d: d.get("index", 0))
            vectors = [_normalized([float(x) for x in row["embedding"]]) for row in rows]
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
            raise EmbedError(f"embedding failed: {type(exc).__name__}") from exc
        if len(vectors) != len(texts):
            raise EmbedError("embedding server returned the wrong number of vectors")
        return vectors
