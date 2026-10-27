from pathlib import Path

import pytest

from base.config import CloudBackendRefused, assert_synthetic, load_settings


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
    s = load_settings({"BASE_HOME": str(tmp_path / "h")})
    private = tmp_path / "private"
    private.mkdir()
    with pytest.raises(CloudBackendRefused):
        assert_synthetic(s, private)
    (private / ".synthetic").write_text("")
    assert_synthetic(s, private)


def test_local_backend_reads_anything(tmp_path):
    s = load_settings({"BASE_HOME": str(tmp_path / "h"), "GLIMMER_BACKEND": "llama_server"})
    assert_synthetic(s, tmp_path)


def test_demo_folder_is_marked():
    assert (Path(__file__).resolve().parent.parent / "demo" / ".synthetic").is_file()
