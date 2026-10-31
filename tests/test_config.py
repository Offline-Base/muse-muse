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
    assert s.device == "laptop" and s.glimmer_backend == "openrouter"
    assert s.dreaming_backend == "prompt"


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
