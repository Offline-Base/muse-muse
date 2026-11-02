"""The search embedder (EmbeddingGemma 2 on this device). The server is mocked with respx."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from base.config import (
    _load_settings_for_tests as load_settings,  # pre-ruling loader: LFM code load_settings now refuses
)
from base.workspace.embed import Embedder, EmbedError

EMBED = "http://127.0.0.1:8084/v1"


def settings_for(tmp_path, **extra):
    return load_settings(
        {
            "BASE_HOME": str(tmp_path / "home"),
            "WORKSPACE_ROOT": str(tmp_path),
            "CHECKER_API_KEY": "local-key",
            "SEARCH_EMBEDDINGS": "1",
            **extra,
        }
    )


def vectors(request):
    texts = json.loads(request.content)["input"]
    return httpx.Response(200, json={"data": [{"index": i, "embedding": [3.0, 4.0]} for i in range(len(texts))]})


def test_settings(tmp_path):
    s = settings_for(tmp_path)
    assert s.search_embeddings and s.embed_url == EMBED and s.embed_model == "embeddinggemma-2"
    assert not settings_for(tmp_path, SEARCH_EMBEDDINGS="0").search_embeddings


@pytest.mark.parametrize("url", ["https://embed.example.org/v1", "http://embed.example.net:8084/v1"])
def test_the_embedder_must_be_this_device(tmp_path, url):
    with pytest.raises(ValueError, match="this device"):
        settings_for(tmp_path, EMBED_URL=url)


@respx.mock
def test_prompts_normalizing_and_the_cache(tmp_path):
    route = respx.post(f"{EMBED}/embeddings").mock(side_effect=vectors)
    e = Embedder(settings_for(tmp_path))
    assert e.query("sharks") == pytest.approx([0.6, 0.8])
    body = json.loads(route.calls[0].request.content)
    assert body == {"model": "embeddinggemma-2", "input": ["task: search result | query: sharks"]}
    assert route.calls[0].request.headers["authorization"] == "Bearer local-key"
    e.documents("Resume | 2026", ["a", "b"])
    assert json.loads(route.calls[1].request.content)["input"] == [
        "title: Resume   2026 | text: a",
        "title: Resume   2026 | text: b",
    ]
    e.documents("Resume | 2026", ["a", "b"])  # unchanged text is not embedded again
    assert route.call_count == 2


@respx.mock
def test_a_failed_server_is_an_embed_error(tmp_path):
    respx.post(f"{EMBED}/embeddings").mock(return_value=httpx.Response(503))
    with pytest.raises(EmbedError):
        Embedder(settings_for(tmp_path)).query("x")
