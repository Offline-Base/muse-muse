from pathlib import Path

import pytest

from base.config import CloudBackendRefused, assert_synthetic, load_settings, read_dotenv
from tests.synthetic_helpers import mark_synthetic


def test_openrouter_defaults(tmp_path):
    s = load_settings({"BASE_HOME": str(tmp_path), "OPENROUTER_API_KEY": "k"})
    assert s.device == "laptop"
    assert s.is_cloud_backend
    assert s.answer_model == "meta/muse-glimmer-30b"
    assert s.answer_url == s.router_url


def test_llama_server_laptop_and_jetson(tmp_path):
    laptop = load_settings({"BASE_HOME": str(tmp_path), "GLIMMER_BACKEND": "llama_server"})
    assert laptop.answer_url.endswith(":8081/v1") and laptop.router_url.endswith(":8082/v1")
    jetson = load_settings({"BASE_HOME": str(tmp_path), "GLIMMER_BACKEND": "llama_server", "BASE_DEVICE": "jetson"})
    assert jetson.router_url == jetson.answer_url
    assert jetson.heavy_queue and not laptop.heavy_queue


def test_bad_device_rejected(tmp_path):
    with pytest.raises(ValueError):
        load_settings({"BASE_HOME": str(tmp_path), "BASE_DEVICE": "phone"})


def test_cloud_backend_needs_synthetic_marker(tmp_path):
    private = tmp_path / "private"
    private.mkdir()
    s = load_settings({"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(private)})
    with pytest.raises(CloudBackendRefused):
        assert_synthetic(s, private)
    (private / ".synthetic").write_text("")
    with pytest.raises(CloudBackendRefused, match="no readable"):  # a marker needs its manifest too
        assert_synthetic(s, private)
    mark_synthetic(private)
    assert_synthetic(s, private)


def test_local_backend_reads_anything(tmp_path):
    s = load_settings({"BASE_HOME": str(tmp_path / "h"), "GLIMMER_BACKEND": "llama_server"})
    assert_synthetic(s, tmp_path)


def test_demo_folder_is_marked():
    assert (Path(__file__).resolve().parent.parent / "demo" / ".synthetic").is_file()


def test_dotenv_inline_comments_and_quotes(tmp_path):
    env = tmp_path / ".env"
    env.write_text(
        "# a comment line\n"
        "BASE_DEVICE=laptop            # laptop or jetson\n"
        "GLIMMER_MODEL='glimmer # not a comment'\n"
        "OPENROUTER_BASE=https://example.org/api/v1#frag\n"
        "EMPTY=\n"
    )
    values = read_dotenv(env)
    assert values["BASE_DEVICE"] == "laptop"
    assert values["GLIMMER_MODEL"] == "glimmer # not a comment"
    assert values["OPENROUTER_BASE"] == "https://example.org/api/v1#frag"
    assert values["EMPTY"] == ""


def test_env_example_loads_as_a_dotenv():
    """Copying .env.example to .env must give working settings."""
    example = read_dotenv(Path(__file__).resolve().parent.parent / ".env.example")
    s = load_settings({**example, "BASE_HOME": "/tmp/base-example-home"})
    # Since the Nov 2 ruling: Muse Glimmer 30B on OpenRouter for every step, invented data only.
    assert s.device == "laptop" and not s.device_only and s.primary_model == "glimmer" and s.checker_backend == "glimmer"
    assert s.is_cloud_backend and s.answer_model == "meta/muse-glimmer-30b"
    assert s.dreaming_backend == "prompt"  # Glimmer is the router, as final_cloud measured


def test_marker_above_the_workspace_root_does_not_count(tmp_path):
    # Review SEC-7: a stray .synthetic in a home folder or shared parent must not mark a class.
    root = tmp_path / "teacher" / "class-2026"
    (root / "essays").mkdir(parents=True)
    s = load_settings({"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(root)})
    mark_synthetic(tmp_path)
    with pytest.raises(CloudBackendRefused):
        assert_synthetic(s, root / "essays")
    with pytest.raises(CloudBackendRefused):
        assert_synthetic(s, tmp_path)  # outside the root: never
    mark_synthetic(root)
    assert_synthetic(s, root / "essays")


def test_llama_key_comes_from_the_home_file(tmp_path):
    home = tmp_path / "h"
    home.mkdir()
    (home / "llama_api_key").write_text("k" * 32 + "\n")
    s = load_settings({"BASE_HOME": str(home), "GLIMMER_BACKEND": "llama_server", "LLAMA_API_KEY": ""})
    assert s.model_api_key == "k" * 32
    s = load_settings({"BASE_HOME": str(home), "GLIMMER_BACKEND": "llama_server", "LLAMA_API_KEY": "env-wins"})
    assert s.model_api_key == "env-wins"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("", frozenset()),
        ("none", frozenset()),
        ("all", frozenset({"lists", "result_words", "class_of"})),
        ("lists, Class_Of", frozenset({"lists", "class_of"})),
    ],
)
def test_router_loosen_is_lists_and_result_words_unless_set(tmp_path, value, expected):
    s = load_settings({"BASE_HOME": str(tmp_path), "ROUTER_LOOSEN": value})
    assert s.router_loosen == expected
    assert load_settings({"BASE_HOME": str(tmp_path)}).router_loosen == frozenset({"lists", "result_words"})


def test_router_loosen_refuses_unknown_choices(tmp_path):
    with pytest.raises(ValueError, match="ROUTER_LOOSEN"):
        load_settings({"BASE_HOME": str(tmp_path), "ROUTER_LOOSEN": "lists,everything"})


def test_router_reasoning_and_token_budget(tmp_path):
    s = load_settings({"BASE_HOME": str(tmp_path)})
    assert s.router_reasoning == "low" and s.router_max_tokens == 1500  # today's behavior
    s = load_settings({"BASE_HOME": str(tmp_path), "ROUTER_REASONING": "xhigh", "ROUTER_MAX_TOKENS": "4000"})
    assert s.router_reasoning == "xhigh" and s.router_max_tokens == 4000
    for bad in ({"ROUTER_REASONING": "none"}, {"ROUTER_REASONING": "High"}, {"ROUTER_MAX_TOKENS": "-5"},
                {"ROUTER_MAX_TOKENS": "lots"}, {"ROUTER_MAX_TOKENS": "10"}, {"ROUTER_MAX_TOKENS": "99999"}):  # fmt: skip
        with pytest.raises(ValueError, match="ROUTER_"):
            load_settings({"BASE_HOME": str(tmp_path), **bad})


# The organizers' ruling, Nov 2, 2026: every model Muse Privacy calls must be a Meta model.


@pytest.mark.parametrize(
    "env, named",
    [
        ({"CHECKER_BACKEND": "lfm"}, "CHECKER_BACKEND=lfm"),
        ({"PRIMARY_MODEL": "lfm"}, "PRIMARY_MODEL=lfm"),
        ({"PRIMARY_MODEL": "LFM", "CHECKER_BACKEND": "lfm"}, "PRIMARY_MODEL=lfm"),
        ({"DEVICE_ONLY": "1", "PRIMARY_MODEL": "lfm", "CHECKER_BACKEND": "lfm"}, "LFM3-VL-2B"),
        ({"SEARCH_EMBEDDINGS": "1"}, "EmbeddingGemma"),
        ({"PROMPT_GUARD": "1"}, "Llama Prompt Guard"),
        ({"JETSON_LFM_BASE": "https://gateway.example.org/v1"}, "JETSON_LFM_BASE"),
        ({"JETSON_LFM_API_KEY": "gw-key"}, "JETSON_LFM_API_KEY"),
        ({"JETSON_LFM_MODEL": "hf.co/LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"}, "LFM3-1.7B"),
        # On OpenRouter GLIMMER_MODEL chooses the model, so an override to another family is refused.
        ({"GLIMMER_MODEL": "meta-llama/llama-3.3-70b-instruct"}, "GLIMMER_MODEL=meta-llama/llama-3.3-70b-instruct"),
        ({"GLIMMER_BACKEND": "openrouter", "GLIMMER_MODEL": "liquid/lfm-7b"}, "GLIMMER_MODEL=liquid/lfm-7b"),
        ({"SPARK_MODEL": "llama-4-maverick"}, "SPARK_MODEL=llama-4-maverick"),
    ],
)
def test_non_meta_models_are_refused_with_the_ruling(tmp_path, env, named):
    from base.config import NonMetaModelRefused

    with pytest.raises(NonMetaModelRefused) as err:
        load_settings({"BASE_HOME": str(tmp_path), **env})
    message = str(err.value)
    assert named in message and "Nov 2, 2026" in message and "Meta model" in message
    assert "gw-key" not in message  # a refusal never prints a value


def test_a_refused_setting_in_dotenv_is_refused_too(tmp_path, monkeypatch):
    from base import config

    (tmp_path / ".env").write_text("CHECKER_BACKEND=lfm\n")
    monkeypatch.setattr(config, "REPO_ROOT", tmp_path)
    with pytest.raises(config.NonMetaModelRefused):
        config.load_settings({"BASE_HOME": str(tmp_path / "home")})


@pytest.mark.parametrize(
    "env",
    [
        {"SEARCH_EMBEDDINGS": "0", "PROMPT_GUARD": "0", "JETSON_LFM_BASE": "", "JETSON_LFM_API_KEY": ""},
        {"CHECKER_BACKEND": "glimmer", "PRIMARY_MODEL": "glimmer"},
    ],
)
def test_the_off_values_still_load(tmp_path, env):
    s = load_settings({"BASE_HOME": str(tmp_path), **env})
    assert s.checker_backend == s.primary_model == "glimmer"
    assert not (s.search_embeddings or s.prompt_guard or s.has_jetson_lfm)


def test_meta_model_ids_and_a_local_alias_still_load(tmp_path):
    s = load_settings({"BASE_HOME": str(tmp_path), "GLIMMER_MODEL": "meta/muse-glimmer-30b", "SPARK_MODEL": "muse-spark-1.3"})
    assert s.answer_model == "meta/muse-glimmer-30b" and s.spark_model == "muse-spark-1.3"
    # On llama_server GLIMMER_MODEL is only the alias of the local file; the file is GLIMMER_GGUF.
    s = load_settings({"BASE_HOME": str(tmp_path), "GLIMMER_BACKEND": "llama_server", "GLIMMER_MODEL": "glimmer"})
    assert s.answer_model == "glimmer"


def test_defaults_are_meta_models_only(tmp_path):
    s = load_settings({"BASE_HOME": str(tmp_path)})
    assert s.primary_model == s.checker_backend == "glimmer"
    assert s.answer_model == s.router_model == "meta/muse-glimmer-30b"
    assert not (s.search_embeddings or s.prompt_guard or s.has_jetson_lfm or s.device_only)


def test_device_only_now_needs_glimmer_on_this_device(tmp_path):
    with pytest.raises(ValueError, match="Muse Glimmer on llama-server on this device"):
        load_settings({"BASE_HOME": str(tmp_path), "DEVICE_ONLY": "1"})
    s = load_settings({"BASE_HOME": str(tmp_path), "DEVICE_ONLY": "1", "GLIMMER_BACKEND": "llama_server"})
    assert s.device_only and s.primary_model == s.checker_backend == "glimmer" and not s.is_cloud_backend
    assert s.answer_url == s.router_url  # one copy of the model on a laptop


def test_labels_from_glimmer_is_refused_with_a_plain_reason(tmp_path):
    with pytest.raises(ValueError, match="already labels"):
        load_settings({"BASE_HOME": str(tmp_path), "LABELS_BACKEND": "glimmer"})


def test_the_example_env_loads_on_meta_models_only(tmp_path, monkeypatch):
    from base import config

    monkeypatch.setattr(config, "REPO_ROOT", tmp_path)  # no .env from this checkout
    values = read_dotenv(Path(__file__).resolve().parent.parent / ".env.example")
    assert values["DEVICE_ONLY"] == "0" and values["CHECKER_BACKEND"] == "glimmer"
    assert values["GLIMMER_BACKEND"] == "openrouter" and values["GLIMMER_MODEL"] == "meta/muse-glimmer-30b"
    s = config.load_settings(values | {"BASE_HOME": str(tmp_path / "home")})
    assert s.is_cloud_backend and s.primary_model == s.checker_backend == "glimmer"


def test_the_unchecked_loader_is_used_only_by_tests():
    root = Path(__file__).resolve().parent.parent
    users = [
        p.relative_to(root).as_posix()
        for folder in ("base", "scripts", "eval", "deploy", "sidecars")
        for p in (root / folder).rglob("*.py")
        if "_load_settings_for_tests" in p.read_text(encoding="utf-8")
    ]
    assert users == ["base/config.py"]
