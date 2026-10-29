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
from base.config import load_settings
from base.local_llm import CHECKER_SAMPLING, LocalLLM
from base.services import Services
from base.workspace.index import DocumentIndex
from base.workspace.rag import NO_ANSWER, Rag
from base.workspace.scans import ScanError, ScanReader

CHECKER = "http://127.0.0.1:8083/v1"
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
    assert body["chat_template_kwargs"] == {"enable_thinking": False}
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
