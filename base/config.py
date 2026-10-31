"""Settings for one device. See docs/CONTRACTS.md.

BASE_DEVICE picks laptop or jetson; GLIMMER_BACKEND picks where Glimmer runs. Nothing here is
specific to one machine: addresses come from the environment or .env.
"""

from __future__ import annotations

import os
import re
import shutil
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

REPO_ROOT = Path(__file__).resolve().parent.parent
SYNTHETIC_MARKER = ".synthetic"

ANSWER_PORT = 8081
ROUTER_PORT = 8082
CHECKER_PORT = 8083
EMBED_PORT = 8084
APPROVAL_PORT = 8787
CONNECTOR_PORT = 8790

# ROUTER_LOOSEN choices (base/router.py): a rule you taught for document lists, topic words read
# from the tagged result, and "[Student A]'s class" as a class-level question.
ROUTER_LOOSEN_CHOICES = ("lists", "result_words", "class_of")


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
        else:  # an unquoted value ends at an inline comment, as in .env.example
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
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
    def controls(self) -> Path:
        """The user's privacy controls (base/controls.py), set on the approval page."""
        return self.home / "privacy_controls.json"

    @property
    def auto_approve(self) -> Path:
        """Present while always-approve mode is on (set from the approval page)."""
        return self.home / "auto_approve"

    @property
    def connector_token(self) -> Path:
        return self.home / "connector_token"

    @property
    def scans(self) -> Path:
        """Text the local vision model read out of images, one file per image hash."""
        return self.home / "scans"


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
    # rules: learned rules are applied in code. prompt: they are also shown to the router model.
    # lora: training runs in the cloud. local_lora: Glimmer with an adapter already at
    # BASE_HOME/adapters/router.gguf; training one on this device is not built yet.
    dreaming_backend: Literal["rules", "prompt", "lora", "local_lora"] = "prompt"
    # With DEVICE_ONLY=1 and the prompt backend, how far the router model's answer counts: "tighten"
    # can only make the policy's decision stricter, "decide" replaces it (the safety floors stay).
    router_trust: Literal["tighten", "decide"] = "tighten"
    # Router changes that ask less often, each off until it is turned on (ROUTER_LOOSEN, a comma
    # list of ROUTER_LOOSEN_CHOICES or "all"): lists, result_words, class_of. See base/router.py.
    router_loosen: frozenset[str] = frozenset()
    light_serial: str | None = None
    # A certificate and key for the approval port (the Jetson on a home network). With both set
    # the page and the /heavy routes are served over TLS and the session cookie is Secure.
    approval_tls_cert: Path | None = None
    approval_tls_key: Path | None = None
    # The model for the checks and search: "glimmer" uses the answer model, "lfm" a small Liquid
    # model on this device's own llama-server (always local, so it never needs the .synthetic rule).
    checker_backend: Literal["glimmer", "lfm"] = "glimmer"
    # "lfm" runs every model step but the router on the checker's LFM3-VL-2B first, with the
    # Jetson's LFM (below) as the fallback when it is set, else Glimmer.
    primary_model: Literal["glimmer", "lfm"] = "glimmer"
    # LFM3-1.7B on the user's Jetson through an OpenAI-compatible gateway on the internet: a remote
    # endpoint, so it is treated like a cloud model and only sees invented data.
    jetson_lfm_url: str | None = None
    jetson_lfm_model: str = "hf.co/LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"
    jetson_lfm_key: str | None = None
    checker_url: str = f"http://127.0.0.1:{CHECKER_PORT}/v1"
    checker_model: str = "lfm3-vl-2b"
    checker_api_key: str | None = None
    rag_candidates: int = 20
    # Search adds EmbeddingGemma 2 on this device's llama-server to BM25 (SEARCH_EMBEDDINGS=1).
    search_embeddings: bool = False
    embed_url: str = f"http://127.0.0.1:{EMBED_PORT}/v1"
    embed_model: str = "embeddinggemma-2"
    # pdftotext (poppler) makes .pdf files documents; None when it is not installed.
    pdftotext_bin: str | None = None
    # DEVICE_ONLY=1: every model is on this device. No OpenRouter, no Jetson gateway, no Spark key.
    # With PRIMARY_MODEL=lfm (its default) LFM3-VL-2B answers every step, the router included.
    device_only: bool = False
    # daily: every tag day gives each person a new tag, and an old tag restores until
    # tag_grace_hours after its day ends or it was last sent. off: one tag per value, forever.
    tag_rotation: Literal["daily", "off"] = "daily"
    tag_grace_hours: float = 36.0
    extra: dict[str, str] = field(default_factory=dict, compare=False, repr=False)

    @property
    def approval_tls(self) -> bool:
        return self.approval_tls_cert is not None and self.approval_tls_key is not None

    @property
    def is_cloud_backend(self) -> bool:
        return self.glimmer_backend == "openrouter"

    @property
    def has_jetson_lfm(self) -> bool:
        return bool(self.jetson_lfm_url and self.jetson_lfm_key)

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
        # One server on a Jetson, or with DEVICE_ONLY=1 so a laptop holds one copy of the model.
        one_server = device == "jetson" or get("DEVICE_ONLY", "0") == "1"
        default_router = answer_url if one_server else f"http://127.0.0.1:{ROUTER_PORT}/v1"
        router_url = get("ROUTER_URL", default_router)
        answer_model = router_model = get("GLIMMER_MODEL", "glimmer")
        # llama-server is started with --api-key-file BASE_HOME/llama_api_key, so any other
        # process on the machine cannot use the model or change the router adapter's scale.
        api_key = get("LLAMA_API_KEY") or _read_key(get("BASE_HOME", str(Path.home() / ".base")))

    device_only = get("DEVICE_ONLY", "0") == "1"
    dreaming = get("DREAMING_BACKEND", "rules" if device_only else "prompt")
    if dreaming not in ("rules", "prompt", "lora", "local_lora"):
        raise ValueError(f"DREAMING_BACKEND must be rules, prompt, lora or local_lora, not {dreaming!r}")
    if dreaming == "lora" and device_only:
        raise ValueError("DREAMING_BACKEND=lora sends training examples to the cloud: with DEVICE_ONLY=1 use local_lora")
    trust = get("ROUTER_TRUST", "tighten")
    if trust not in ("tighten", "decide"):
        raise ValueError(f"ROUTER_TRUST must be tighten or decide, not {trust!r}")
    loosen = _router_loosen(get("ROUTER_LOOSEN", ""))
    primary = get("PRIMARY_MODEL", "lfm" if device_only else "glimmer")
    if dreaming == "local_lora" and primary == "lfm":
        raise ValueError("DREAMING_BACKEND=local_lora trains Glimmer: set PRIMARY_MODEL=glimmer and GLIMMER_GGUF")
    if primary not in ("glimmer", "lfm"):
        raise ValueError(f"PRIMARY_MODEL must be glimmer or lfm, not {primary!r}")
    checker = get("CHECKER_BACKEND", primary)
    if checker not in ("glimmer", "lfm"):
        raise ValueError(f"CHECKER_BACKEND must be glimmer or lfm, not {checker!r}")
    if primary == "lfm" and checker != "lfm":
        raise ValueError("PRIMARY_MODEL=lfm runs on the checker's server: set CHECKER_BACKEND=lfm or leave it unset")
    embed_url = get("EMBED_URL", f"http://127.0.0.1:{EMBED_PORT}/v1").rstrip("/")
    if not _is_loopback_url(embed_url):
        raise ValueError("EMBED_URL must be this device (127.0.0.1 or localhost): it reads raw documents")
    pdftotext = get("PDFTOTEXT_BIN") or shutil.which("pdftotext") or None
    jetson_lfm_url = (get("JETSON_LFM_BASE") or "").rstrip("/") or None
    if jetson_lfm_url and not jetson_lfm_url.startswith("https://"):
        raise ValueError("JETSON_LFM_BASE must be an https:// address: the key and the text cross the internet")
    checker_url = get("CHECKER_URL", f"http://127.0.0.1:{CHECKER_PORT}/v1").rstrip("/")
    if checker == "lfm" and not _is_loopback_url(checker_url):
        raise ValueError("CHECKER_URL must be this device (127.0.0.1 or localhost): the checker reads raw documents")
    checker_key = get("CHECKER_API_KEY") or _read_key(get("BASE_HOME", str(Path.home() / ".base"))) or None
    checker_model = get("CHECKER_MODEL", "lfm3-vl-2b")
    meta_key = get("META_API_KEY") or None
    if device_only:
        jetson_lfm_url, meta_key = None, None
        if primary == "lfm":  # one model on this device for every step, whatever GLIMMER_BACKEND says
            backend = "llama_server"
            answer_url = router_url = checker_url
            answer_model = router_model = checker_model
            api_key = checker_key
        elif backend != "llama_server" or not (_is_loopback_url(answer_url) and _is_loopback_url(router_url)):
            raise ValueError("DEVICE_ONLY=1 needs PRIMARY_MODEL=lfm, or Glimmer on llama-server on this device")
    rotation = get("TAG_ROTATION", "daily")
    if rotation not in ("daily", "off"):
        raise ValueError(f"TAG_ROTATION must be daily or off, not {rotation!r}")
    try:
        grace = float(get("TAG_GRACE_HOURS", "36"))
    except ValueError:
        grace = 0.0
    if not grace > 0:
        raise ValueError("TAG_GRACE_HOURS must be a number of hours above 0")

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
        meta_api_key=meta_key,
        workspace_root=Path(get("WORKSPACE_ROOT", str(REPO_ROOT / "demo"))).expanduser().resolve(),
        roster_path=Path(get("ROSTER_PATH", str(REPO_ROOT / "eval" / "roster.json"))).expanduser(),
        policy_path=Path(get("USER_POLICY", str(REPO_ROOT / "eval" / "user_policy.yaml"))).expanduser(),
        approval_host=get("APPROVAL_HOST", "127.0.0.1"),
        approval_port=int(get("APPROVAL_PORT", str(APPROVAL_PORT))),
        connector_port=int(get("CONNECTOR_PORT", str(CONNECTOR_PORT))),
        relay_url=get("RELAY_URL") or None,
        jetson_url=get("JETSON_URL") or None,
        dreaming_backend=dreaming,  # type: ignore[arg-type]
        router_trust=trust,  # type: ignore[arg-type]
        router_loosen=loosen,
        light_serial=get("LIGHT_SERIAL") or None,
        approval_tls_cert=Path(get("APPROVAL_TLS_CERT")).expanduser() if get("APPROVAL_TLS_CERT") else None,
        approval_tls_key=Path(get("APPROVAL_TLS_KEY")).expanduser() if get("APPROVAL_TLS_KEY") else None,
        checker_backend=checker,  # type: ignore[arg-type]
        primary_model=primary,  # type: ignore[arg-type]
        jetson_lfm_url=jetson_lfm_url,
        jetson_lfm_model=get("JETSON_LFM_MODEL", "hf.co/LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"),
        jetson_lfm_key=None if device_only else get("JETSON_LFM_API_KEY") or None,
        checker_url=checker_url,
        checker_model=checker_model,
        # The checker's llama-server reads the same key file as Glimmer's (scripts/start_checker.sh).
        checker_api_key=checker_key,
        rag_candidates=max(5, int(get("RAG_CANDIDATES", "20"))),
        search_embeddings=get("SEARCH_EMBEDDINGS", "0") == "1",
        embed_url=embed_url,
        embed_model=get("EMBED_MODEL", "embeddinggemma-2"),
        pdftotext_bin=pdftotext,
        device_only=device_only,
        tag_rotation=rotation,  # type: ignore[arg-type]
        tag_grace_hours=grace,
    )


def _router_loosen(value: str) -> frozenset[str]:
    """ROUTER_LOOSEN: "" or none for nothing, all for every choice, else a comma list of them."""
    words = {w.strip().lower() for w in value.split(",") if w.strip()}
    if words <= {"none"}:
        return frozenset()
    if words == {"all"}:
        return frozenset(ROUTER_LOOSEN_CHOICES)
    unknown = words - set(ROUTER_LOOSEN_CHOICES)
    if unknown:
        raise ValueError(f"ROUTER_LOOSEN takes all, none or {', '.join(ROUTER_LOOSEN_CHOICES)}, not {sorted(unknown)}")
    return frozenset(words)


def _is_loopback_url(url: str) -> bool:
    from urllib.parse import urlsplit

    host = (urlsplit(url).hostname or "").lower()
    return host in ("127.0.0.1", "localhost", "::1")


LLAMA_KEY_FILE = "llama_api_key"


def _read_key(home: str) -> str | None:
    """The llama-server API key from BASE_HOME/llama_api_key, or None when there is no file."""
    try:
        return (Path(home).expanduser() / LLAMA_KEY_FILE).read_text().strip() or None
    except OSError:
        return None


def synthetic_marked(folder: Path, root: Path) -> bool:
    """Whether `folder` or a parent of it inside `root` (root included) holds the marker.

    A marker above the workspace root does not count: a stray .synthetic in a home folder or a
    shared parent must never mark a real class folder as invented data.
    """
    folder, root = Path(folder).resolve(), Path(root).resolve()
    for candidate in (folder, *folder.parents):
        if not candidate.is_relative_to(root):
            return False
        if (candidate / SYNTHETIC_MARKER).is_file():
            return True
    return False


def assert_synthetic(settings: Settings, folder: Path) -> None:
    """Refuse to read a folder with a cloud Glimmer backend unless it is marked synthetic.

    The marker may sit in the folder or a parent of it up to the workspace root, not above it.
    """
    if not settings.is_cloud_backend:
        return
    folder = Path(folder).resolve()
    if synthetic_marked(folder, settings.workspace_root):
        return
    raise CloudBackendRefused(
        f"GLIMMER_BACKEND={settings.glimmer_backend} sends text to a cloud endpoint, so only folders "
        f"marked with a {SYNTHETIC_MARKER} file (invented data) can be read. {folder.name} is not marked."
    )
