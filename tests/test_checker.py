"""The local checker (LFM3-VL-2B on this device): settings, client, scans, retrieval and wiring.

Every model call is mocked with respx; nothing here starts a model. All names are invented.
"""

from __future__ import annotations

import json
import os
import stat
from types import SimpleNamespace

import httpx
import pytest
import respx

from base import guard
from base.config import CloudBackendRefused, load_settings
from base.local_llm import CHECKER_SAMPLING, FallbackLLM, LocalLLM
from base.services import Services
from base.workspace.index import DocumentIndex
from base.workspace.rag import NO_ANSWER, Rag
from base.workspace.scans import ScanError, ScanReader

CHECKER = "http://127.0.0.1:8083/v1"
OPENROUTER = "https://openrouter.ai/api/v1"
GATEWAY = "https://gateway.example.org/v1"
JETSON = {"JETSON_LFM_BASE": GATEWAY, "JETSON_LFM_API_KEY": "gateway-key"}
REAL_A = "Abigail Thornbury"
REAL_D = "Dashiell Kowalczyk"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64  # bytes are enough: the model is mocked


def reply(content: str) -> dict:
    return {
        "model": "lfm3-vl-2b",
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    }


def body_of(call) -> dict:
    return json.loads(call.request.content)


def settings_for(tmp_path, **extra):
    root = tmp_path / "work"
    root.mkdir(exist_ok=True)
    env = {
        "BASE_HOME": str(tmp_path / "home"),
        "BASE_DEVICE": "laptop",
        "GLIMMER_BACKEND": "openrouter",
        "OPENROUTER_API_KEY": "or-key",
        "WORKSPACE_ROOT": str(root),
        "LIGHT_SERIAL": "",
        "CHECKER_BACKEND": "lfm",
        "CHECKER_API_KEY": "local-key",
        **extra,
    }
    return load_settings(env)


@pytest.fixture
def settings(tmp_path):
    s = settings_for(tmp_path)
    (s.workspace_root / ".synthetic").write_text("invented\n")
    return s


@pytest.fixture
def checker(settings):
    return LocalLLM(settings, role="checker", sleep=lambda _s: None)


# settings


def test_checker_defaults_to_glimmer(tmp_path):
    s = settings_for(tmp_path, CHECKER_BACKEND="glimmer")
    assert s.checker_backend == "glimmer"
    assert s.checker_url == CHECKER and s.checker_model == "lfm3-vl-2b" and s.rag_candidates == 20


def test_lfm_settings(tmp_path):
    s = settings_for(tmp_path, RAG_CANDIDATES="2", CHECKER_MODEL="lfm3")
    assert s.checker_backend == "lfm" and s.checker_model == "lfm3"
    assert s.rag_candidates == 5  # never fewer candidates than a search returns


@pytest.mark.parametrize("url", ["http://checker.example.org:8083/v1", "https://example.com/v1"])
def test_checker_must_be_this_device(tmp_path, url):
    with pytest.raises(ValueError, match="this device"):
        settings_for(tmp_path, CHECKER_URL=url)


def test_unknown_checker_backend(tmp_path):
    with pytest.raises(ValueError, match="glimmer or lfm"):
        settings_for(tmp_path, CHECKER_BACKEND="cloud")


# client


@respx.mock
def test_checker_body_uses_liquid_sampling_and_no_glimmer_reasoning(checker):
    route = respx.post(f"{CHECKER}/chat/completions").mock(return_value=httpx.Response(200, json=reply("ok")))
    checker.chat([{"role": "system", "content": "Reasoning strength: low\nFind names."}, {"role": "user", "content": "x"}])
    body = body_of(route.calls[0])
    assert body["model"] == "lfm3-vl-2b"
    for key, value in CHECKER_SAMPLING.items():
        assert body[key] == value
    assert "chat_template_kwargs" not in body  # thinking is off on the server; the flag breaks json_schema
    assert "reasoning" not in body
    assert body["messages"][0]["content"] == "Find names."  # Glimmer's line is taken out


@respx.mock
def test_checker_is_local_so_it_needs_no_synthetic_flag_and_never_gets_the_cloud_key(checker):
    route = respx.post(f"{CHECKER}/chat/completions").mock(return_value=httpx.Response(200, json=reply("ok")))
    assert checker.settings.is_cloud_backend  # Glimmer is on OpenRouter...
    checker.chat([{"role": "user", "content": "real text"}])  # ...but the checker is not refused
    headers = route.calls[0].request.headers
    assert headers["authorization"] == "Bearer local-key"
    assert "or-key" not in str(headers) and "x-title" not in headers
    assert checker.is_cloud is False


@respx.mock
def test_checker_strips_thinking_left_in_the_content(checker):
    respx.post(f"{CHECKER}/chat/completions").mock(
        return_value=httpx.Response(200, json=reply('<think>hmm</think>\n{"names": []}'))
    )
    assert checker.chat([{"role": "user", "content": "x"}]).content == '{"names": []}'


def test_checker_takes_no_adapter(checker):
    with pytest.raises(ValueError, match="no LoRA"):
        checker.build_body([{"role": "user", "content": "x"}], adapter=1)


@respx.mock
def test_name_pass_and_topics_on_the_checker(checker):
    route = respx.post(f"{CHECKER}/chat/completions").mock(
        side_effect=[
            httpx.Response(200, json=reply(json.dumps({"names": ["Odessa"]}))),
            httpx.Response(200, json=reply(json.dumps({"topics": ["parents"]}))),
        ]
    )
    assert checker.llm_names("Odessa's uncle grows taro.") == ["Odessa"]
    assert checker.request_topics("A note home", {"parents": "for a family", "class_level": "class"}) == ["parents"]
    topics_prompt = body_of(route.calls[1])["messages"][0]["content"]
    assert not topics_prompt.lower().startswith("reasoning strength")


# LFM first, Glimmer as the fallback (PRIMARY_MODEL=lfm)


def test_primary_model_settings(tmp_path):
    assert settings_for(tmp_path).primary_model == "glimmer"
    env = {"BASE_HOME": str(tmp_path / "h2"), "WORKSPACE_ROOT": str(tmp_path / "work"), "PRIMARY_MODEL": "lfm"}
    s = load_settings(env)
    assert s.primary_model == "lfm" and s.checker_backend == "lfm"  # the checker follows unless told otherwise
    with pytest.raises(ValueError, match="CHECKER_BACKEND=lfm"):
        settings_for(tmp_path, PRIMARY_MODEL="lfm", CHECKER_BACKEND="glimmer")
    with pytest.raises(ValueError, match="PRIMARY_MODEL must be"):
        settings_for(tmp_path, PRIMARY_MODEL="spark")


@pytest.fixture
def both(settings):
    lfm = LocalLLM(settings, role="checker", sleep=lambda _s: None)
    glimmer = LocalLLM(settings, role="answer", sleep=lambda _s: None)
    return FallbackLLM(lfm, glimmer)


@respx.mock
def test_lfm_answers_first_and_glimmer_is_not_called(both):
    local = respx.post(f"{CHECKER}/chat/completions").mock(return_value=httpx.Response(200, json=reply('{"a": 1}')))
    cloud = respx.post(f"{OPENROUTER}/chat/completions").mock(return_value=httpx.Response(200, json=reply('{"a": 2}')))
    assert both.chat_json([{"role": "user", "content": "x"}], {"type": "object"}, adapter=3, synthetic=True) == {"a": 1}
    assert local.call_count == 1 and cloud.call_count == 0
    assert "lora" not in body_of(local.calls[0])  # an adapter is Glimmer's, never sent to LFM
    assert both.last_used == "lfm3-vl-2b" and both.model == "lfm3-vl-2b"


@respx.mock
def test_glimmer_takes_over_when_lfm_fails(both):
    respx.post(f"{CHECKER}/chat/completions").mock(return_value=httpx.Response(500, json={"error": "grammar"}))
    cloud = respx.post(f"{OPENROUTER}/chat/completions").mock(
        return_value=httpx.Response(200, json=reply(json.dumps({"names": ["Odessa"]})))
    )
    assert both.llm_names("Odessa's uncle grows taro.", synthetic=True) == ["Odessa"]
    assert cloud.call_count == 1 and both.last_used == "meta/muse-glimmer-30b"


@respx.mock
def test_glimmer_takes_over_when_lfm_is_not_running(both):
    respx.post(f"{CHECKER}/chat/completions").mock(side_effect=httpx.ConnectError("refused"))
    cloud = respx.post(f"{OPENROUTER}/chat/completions").mock(return_value=httpx.Response(200, json=reply("ok")))
    assert both.chat([{"role": "user", "content": "x"}], synthetic=True).content == "ok"
    assert cloud.call_count == 1


@respx.mock
def test_the_fallback_keeps_the_cloud_refusal(both):
    """Real text that LFM could not handle is never sent to a cloud Glimmer instead."""
    respx.post(f"{CHECKER}/chat/completions").mock(return_value=httpx.Response(500, json={"error": "x"}))
    cloud = respx.post(f"{OPENROUTER}/chat/completions").mock(return_value=httpx.Response(200, json=reply("ok")))
    with pytest.raises(CloudBackendRefused):
        both.chat([{"role": "user", "content": "real text"}])
    assert cloud.call_count == 0 and both.is_cloud is True


def test_services_wire_lfm_first(tmp_path):
    s = Services.create(settings_for(tmp_path, PRIMARY_MODEL="lfm"), light=False, heavy=False, owner=False)
    try:
        for llm in (s.answer_llm, s.checker_llm):
            assert isinstance(llm, FallbackLLM) and llm.primary.role == "checker"
        assert s.answer_llm.fallback.role == "answer"
        assert isinstance(s.router_llm, LocalLLM) and s.router_llm.role == "router"  # privacy calls stay on Glimmer
        assert s.router.llm is s.router_llm and s.agent.llm is s.answer_llm
        # scans and passage picking never fall back to a cloud model
        assert not isinstance(s.scans.llm, FallbackLLM) and not isinstance(s.rag.llm, FallbackLLM)
    finally:
        s.close()


# the Jetson's LFM through the gateway, as the fallback


def test_jetson_lfm_settings(tmp_path):
    s = settings_for(tmp_path, **JETSON)
    assert s.has_jetson_lfm and s.jetson_lfm_url == GATEWAY and s.jetson_lfm_model.startswith("hf.co/LiquidAI/LFM3")
    assert not settings_for(tmp_path).has_jetson_lfm
    with pytest.raises(ValueError, match="https"):
        settings_for(tmp_path, JETSON_LFM_BASE="http://gateway.example.org/v1")


@respx.mock
def test_jetson_lfm_is_remote_so_it_sees_only_invented_data(tmp_path):
    jetson = LocalLLM(settings_for(tmp_path, **JETSON), role="jetson", sleep=lambda _s: None)
    route = respx.post(f"{GATEWAY}/chat/completions").mock(return_value=httpx.Response(200, json=reply("<think>x</think>ok")))
    assert jetson.is_cloud
    with pytest.raises(CloudBackendRefused):
        jetson.chat([{"role": "user", "content": "real text"}])
    assert route.call_count == 0
    assert jetson.chat([{"role": "system", "content": "Reasoning strength: low\nGo."}], synthetic=True).content == "ok"
    body = body_of(route.calls[0])
    assert body["temperature"] == CHECKER_SAMPLING["temperature"] and "reasoning" not in body
    assert body["messages"][0]["content"] == "Go."
    assert route.calls[0].request.headers["authorization"] == "Bearer gateway-key"


@respx.mock
def test_lfm_falls_back_to_the_jetson_and_the_router_stays_on_glimmer(tmp_path):
    s = Services.create(settings_for(tmp_path, PRIMARY_MODEL="lfm", **JETSON), light=False, heavy=False, owner=False)
    try:
        assert s.answer_llm.fallback.role == "jetson" and s.checker_llm.fallback.role == "jetson"
        assert s.router_llm.role == "router" and s.router_llm.backend == "openrouter"
        s.answer_llm.primary._sleep = lambda _s: None  # no backoff between the local tries
        respx.post(f"{CHECKER}/chat/completions").mock(side_effect=httpx.ConnectError("refused"))
        jetson = respx.post(f"{GATEWAY}/chat/completions").mock(return_value=httpx.Response(200, json=reply("ok")))
        assert s.answer_llm.chat([{"role": "user", "content": "x"}], synthetic=True).content == "ok"
        assert jetson.call_count == 1 and s.answer_llm.last_backend == "gateway"
    finally:
        s.close()


# scans


@respx.mock
def test_scan_reader_sends_the_image_and_caches_the_text(settings, checker, tmp_path):
    route = respx.post(f"{CHECKER}/chat/completions").mock(
        return_value=httpx.Response(200, json=reply(f"Student: {REAL_D}\nSSN 900-12-3456"))
    )
    image = settings.workspace_root / "form.png"
    image.write_bytes(PNG)
    reader = ScanReader(settings, checker)
    assert reader.text(image) == f"Student: {REAL_D}\nSSN 900-12-3456"
    assert reader.text(image).startswith("Student:")  # second read comes from the cache
    assert len(route.calls) == 1
    part = body_of(route.calls[0])["messages"][1]["content"][0]
    assert part["type"] == "image_url" and part["image_url"]["url"].startswith("data:image/png;base64,")
    [cached] = list(settings.paths.scans.iterdir())
    assert stat.S_IMODE(cached.stat().st_mode) == 0o600
    assert stat.S_IMODE(settings.paths.scans.stat().st_mode) == 0o700
    assert not any(p.suffix == ".txt" for p in settings.workspace_root.iterdir())  # nothing written back


@respx.mock
def test_scan_failure_is_a_fixed_message(settings, checker):
    respx.post(f"{CHECKER}/chat/completions").mock(return_value=httpx.Response(500, json={"error": "boom"}))
    image = settings.workspace_root / "form.jpg"
    image.write_bytes(PNG)
    with pytest.raises(ScanError, match="could not read that scan"):
        ScanReader(settings, checker).text(image)
    assert not settings.paths.scans.exists() or not any(settings.paths.scans.iterdir())


def test_scan_reader_refuses_a_cloud_model(settings):
    with pytest.raises(ValueError, match="this device"):
        ScanReader(settings, LocalLLM(settings, role="answer"))


# index with scans


class FakeScans:
    def __init__(self, texts, fail=()):
        self.texts, self.fail, self.read = texts, set(fail), []

    def text(self, path):
        self.read.append(path.name)
        if path.name in self.fail:
            raise ScanError("The device could not read that scan.")
        return self.texts[path.name]


def test_images_are_documents_only_with_a_scan_reader(settings):
    root = settings.workspace_root
    (root / "notes.md").write_text("# Notes\nGarden tomatoes.\n")
    (root / "form.png").write_bytes(PNG)
    assert [d.id for d in DocumentIndex(settings).list()] == ["notes.md"]
    scans = FakeScans({"form.png": "Field trip form. Card 4111 1111 1111 1111."})
    index = DocumentIndex(settings, scans=scans)
    docs = {d.id: d for d in index.list()}
    assert set(docs) == {"notes.md", "form.png"} and docs["form.png"].title == "form"
    assert scans.read == []  # listing never reads an image
    assert index.read("form.png").startswith("Field trip form")
    [hit] = index.search("field trip card")
    assert hit.doc_id == "form.png" and "4111" in hit.text


def test_search_skips_an_image_it_cannot_read(settings):
    root = settings.workspace_root
    (root / "notes.md").write_text("# Notes\nField trip on Thursday.\n")
    (root / "bad.png").write_bytes(PNG)
    index = DocumentIndex(settings, scans=FakeScans({}, fail={"bad.png"}))
    assert [s.doc_id for s in index.search("field trip")] == ["notes.md"]


# retrieval


class FakeChecker:
    is_cloud = False

    def __init__(self, data=None, fail=False):
        self.data, self.fail, self.calls = data or {}, fail, []

    def chat_json(self, messages, schema, **kw):
        self.calls.append(messages)
        if self.fail:
            raise RuntimeError("down")
        return self.data


@pytest.fixture
def roster(settings):
    return guard.load_roster(settings.roster_path)


def snip(i, text):
    return SimpleNamespace(doc_id=f"d{i}", title=f"{REAL_A} essay {i}", text=text, score=1.0)


def test_rag_shows_the_model_tags_and_restores_its_answer(roster):
    tagmap = guard.TagMap(None)
    snippets = [snip(i, f"{REAL_A} grows tomatoes {i}") for i in range(1, 8)]
    tag_a = guard.tag(REAL_A, roster, tagmap).text
    llm = FakeChecker({"passages": [3, 1, 3, 99, 0, 2, 4, 5, 6], "answer": f"{tag_a} grows tomatoes."})
    rag = Rag(llm, roster, tagmap, candidates=20, keep=5)
    picked, answer = rag.pick(f"{REAL_A} tomatoes", snippets)
    sent = json.dumps(llm.calls[0])
    assert REAL_A not in sent and tag_a in sent  # the model never sees the real name
    assert [s.doc_id for s in picked] == ["d3", "d1", "d2", "d4", "d5"]  # order kept, junk dropped, at most 5
    assert answer == f"{REAL_A} grows tomatoes."  # restored on the device; egress tags it again


def test_rag_with_nothing_relevant(roster):
    rag = Rag(FakeChecker({"passages": [], "answer": "whatever"}), roster, guard.TagMap(None))
    assert rag.pick("anything", [snip(1, "text")]) == ([], NO_ANSWER)
    assert rag.pick("anything", []) == ([], NO_ANSWER)


def test_rag_refuses_a_cloud_model(roster):
    with pytest.raises(ValueError, match="this device"):
        Rag(SimpleNamespace(is_cloud=True), roster, guard.TagMap(None))


# wiring


def test_services_wire_the_checker_when_lfm(settings):
    s = Services.create(settings, light=False, heavy=False, owner=False)
    try:
        assert s.checker_llm is not s.answer_llm and s.checker_llm.role == "checker"
        assert s.scans is not None and s.index.scans is s.scans
        assert s.rag is not None and s.rag.candidates == settings.rag_candidates
    finally:
        s.close()


def test_services_without_lfm_use_the_answer_model(tmp_path):
    s = Services.create(settings_for(tmp_path, CHECKER_BACKEND="glimmer"), light=False, heavy=False, owner=False)
    try:
        assert s.checker_llm is s.answer_llm and s.scans is None and s.rag is None and s.index.scans is None
    finally:
        s.close()


def test_scan_cache_dir_is_under_home(settings):
    assert settings.paths.scans == settings.home / "scans"
    assert os.path.commonpath([settings.paths.scans, settings.home]) == str(settings.home)
