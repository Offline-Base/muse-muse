import os

import pytest

from base.config import load_settings


def pytest_collection_modifyitems(config, items):
    if os.environ.get("RUN_INTEGRATION") == "1":
        return
    skip = pytest.mark.skip(reason="integration test; set RUN_INTEGRATION=1")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)


@pytest.fixture
def settings(tmp_path, monkeypatch):
    """Settings isolated to a temp BASE_HOME, with no real keys, on the openrouter backend."""
    env = {
        "BASE_DEVICE": "laptop",
        "BASE_HOME": str(tmp_path / "home"),
        "GLIMMER_BACKEND": "openrouter",
        "OPENROUTER_API_KEY": "test-key",
        "META_API_KEY": "test-meta-key",
    }
    s = load_settings(env)
    s.ensure_home()
    return s
