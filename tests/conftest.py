import os

import pytest

from base import config
from base.config import load_settings


def pytest_collection_modifyitems(config, items):
    if os.environ.get("RUN_INTEGRATION") == "1":
        return
    skip = pytest.mark.skip(reason="integration test; set RUN_INTEGRATION=1")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(autouse=True)
def no_repo_dotenv(request, monkeypatch):
    """Unit tests never see the developer's .env (RELAY_URL, models, keys); integration tests do."""
    if "integration" in request.keywords:
        return
    real = config.read_dotenv
    repo_env = config.REPO_ROOT / ".env"
    monkeypatch.setattr(config, "read_dotenv", lambda path: {} if path == repo_env else real(path))


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
