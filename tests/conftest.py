import os
import socket

import pytest

from base import config
from base.config import load_settings

LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")
_real_getaddrinfo = socket.getaddrinfo


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
        "WORKSPACE_ROOT": str(tmp_path / "workspace"),  # never the real demo/ folder
        "GLIMMER_BACKEND": "openrouter",
        "OPENROUTER_API_KEY": "test-key",
        "META_API_KEY": "test-meta-key",
    }
    s = load_settings(env)
    s.ensure_home()
    s.workspace_root.mkdir(exist_ok=True)
    return s


@pytest.fixture
def loopback_only(monkeypatch):
    """Any socket connection or name lookup that would leave this device fails the test.

    Yields the list of attempts too ("connect <host>", "lookup <host>"), so a test can still fail
    when the code under test caught the error and carried on."""
    left: list[str] = []
    real_connect, real_connect_ex = socket.socket.connect, socket.socket.connect_ex

    def off_device(sock, address) -> bool:
        host = address[0] if isinstance(address, tuple) else ""
        if sock.family == socket.AF_UNIX or host in LOOPBACK_HOSTS:
            return False
        left.append(f"connect {host}")
        return True

    def connect(self, address):
        assert not off_device(self, address), "a connection left the device"
        return real_connect(self, address)

    def connect_ex(self, address):
        assert not off_device(self, address), "a connection left the device"
        return real_connect_ex(self, address)

    def getaddrinfo(host, *a, **k):
        if host not in LOOPBACK_HOSTS:
            left.append(f"lookup {host}")
            pytest.fail(f"a name lookup left the device: {host}")
        return _real_getaddrinfo(host, *a, **k)

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)
    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    yield left
