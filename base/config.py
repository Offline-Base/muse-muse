"""Settings for one device. See docs/CONTRACTS.md.

BASE_DEVICE picks laptop or jetson; GLIMMER_BACKEND picks where Glimmer runs. Nothing here is
specific to one machine: addresses come from the environment or .env.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

REPO_ROOT = Path(__file__).resolve().parent.parent
SYNTHETIC_MARKER = ".synthetic"

ANSWER_PORT = 8081
ROUTER_PORT = 8082
APPROVAL_PORT = 8787
CONNECTOR_PORT = 8790


class CloudBackendRefused(RuntimeError):
    """Raised when private data would reach a cloud model endpoint."""


def read_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key.strip()] = value
    return values


@dataclass(frozen=True)
class Paths:
    home: Path

    @property
    def db(self) -> Path:
        return self.home / "base.db"

    @property
    def output(self) -> Path:
        return self.home / "output"

    @property
    def adapters(self) -> Path:
        return self.home / "adapters"

    @property
    def tagmap(self) -> Path:
        return self.home / "tagmap.json"

    @property
    def router_prompt(self) -> Path:
        return self.home / "router_rules.md"

    @property
    def connector_token(self) -> Path:
        return self.home / "connector_token"


@dataclass(frozen=True)
class Settings:
    device: Literal["laptop", "jetson"]
    home: Path
    glimmer_backend: Literal["openrouter", "llama_server"]
    answer_url: str
    answer_model: str
    router_url: str
    router_model: str
    model_api_key: str | None
    heavy_queue: bool
    spark_base: str
    spark_model: str
    meta_api_key: str | None
    workspace_root: Path
    roster_path: Path
    policy_path: Path
    approval_host: str = "127.0.0.1"
    approval_port: int = APPROVAL_PORT
    connector_port: int = CONNECTOR_PORT
    relay_url: str | None = None
    jetson_url: str | None = None
    dreaming_backend: Literal["prompt", "lora"] = "prompt"
    light_serial: str | None = None
    extra: dict[str, str] = field(default_factory=dict, compare=False, repr=False)

    @property
    def is_cloud_backend(self) -> bool:
        return self.glimmer_backend == "openrouter"

    @property
    def paths(self) -> Paths:
        return Paths(self.home)

    def ensure_home(self) -> Path:
        for d in (self.home, self.paths.output, self.paths.adapters):
            d.mkdir(parents=True, exist_ok=True)
            os.chmod(d, 0o700)
        return self.home


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Build settings from .env in the repo root, overridden by `env` (default: os.environ)."""
    merged: dict[str, str] = read_dotenv(REPO_ROOT / ".env")
    merged.update(os.environ if env is None else env)
    get = merged.get

    device = get("BASE_DEVICE", "laptop")
    if device not in ("laptop", "jetson"):
        raise ValueError(f"BASE_DEVICE must be laptop or jetson, not {device!r}")
    backend = get("GLIMMER_BACKEND", "openrouter")
    if backend not in ("openrouter", "llama_server"):
        raise ValueError(f"GLIMMER_BACKEND must be openrouter or llama_server, not {backend!r}")

    if backend == "openrouter":
        base = get("OPENROUTER_BASE", "https://openrouter.ai/api/v1").rstrip("/")
        model = get("GLIMMER_MODEL", "meta/muse-glimmer-30b")
        answer_url = router_url = base
        answer_model = router_model = model
        api_key = get("OPENROUTER_API_KEY")
    else:
        answer_url = get("ANSWER_URL", f"http://127.0.0.1:{ANSWER_PORT}/v1")
        default_router = answer_url if device == "jetson" else f"http://127.0.0.1:{ROUTER_PORT}/v1"
        router_url = get("ROUTER_URL", default_router)
        answer_model = router_model = get("GLIMMER_MODEL", "glimmer")
        api_key = get("LLAMA_API_KEY")

    dreaming = get("DREAMING_BACKEND", "prompt")
    if dreaming not in ("prompt", "lora"):
        raise ValueError(f"DREAMING_BACKEND must be prompt or lora, not {dreaming!r}")

    return Settings(
        device=device,  # type: ignore[arg-type]
        home=Path(get("BASE_HOME", str(Path.home() / ".base"))).expanduser(),
        glimmer_backend=backend,  # type: ignore[arg-type]
        answer_url=answer_url.rstrip("/"),
        answer_model=answer_model,
        router_url=router_url.rstrip("/"),
        router_model=router_model,
        model_api_key=api_key or None,
        heavy_queue=get("HEAVY_QUEUE", "1" if device == "jetson" else "0") == "1",
        spark_base=get("META_API_BASE", "https://api.meta.ai/v1").rstrip("/"),
        spark_model=get("SPARK_MODEL", "muse-spark-1.3"),
        meta_api_key=get("META_API_KEY") or None,
        workspace_root=Path(get("WORKSPACE_ROOT", str(REPO_ROOT / "demo"))).expanduser().resolve(),
        roster_path=Path(get("ROSTER_PATH", str(REPO_ROOT / "eval" / "roster.json"))).expanduser(),
        policy_path=Path(get("USER_POLICY", str(REPO_ROOT / "eval" / "user_policy.yaml"))).expanduser(),
        approval_host=get("APPROVAL_HOST", "127.0.0.1"),
        approval_port=int(get("APPROVAL_PORT", str(APPROVAL_PORT))),
        connector_port=int(get("CONNECTOR_PORT", str(CONNECTOR_PORT))),
        relay_url=get("RELAY_URL") or None,
        jetson_url=get("JETSON_URL") or None,
        dreaming_backend=dreaming,  # type: ignore[arg-type]
        light_serial=get("LIGHT_SERIAL") or None,
    )


def assert_synthetic(settings: Settings, folder: Path) -> None:
    """Refuse to read a folder with a cloud Glimmer backend unless it is marked synthetic.

    The marker may sit in the folder or any parent up to the filesystem root.
    """
    if not settings.is_cloud_backend:
        return
    folder = folder.resolve()
    for candidate in (folder, *folder.parents):
        if (candidate / SYNTHETIC_MARKER).is_file():
            return
    raise CloudBackendRefused(
        f"GLIMMER_BACKEND={settings.glimmer_backend} sends text to a cloud endpoint, so only folders "
        f"marked with a {SYNTHETIC_MARKER} file (invented data) can be read. {folder.name} is not marked."
    )
