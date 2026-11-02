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

from base import apps, manifest

REPO_ROOT = Path(__file__).resolve().parent.parent
SYNTHETIC_MARKER = ".synthetic"

ANSWER_PORT = 8081
ROUTER_PORT = 8082
CHECKER_PORT = 8083
EMBED_PORT = 8084
SAM_PORT = 8085
APPROVAL_PORT = 8787
CONNECTOR_PORT = 8790

# ROUTER_LOOSEN choices (base/router.py): a rule you taught for document lists, topic words read
# from the tagged result, and "[Student A]'s class" as a class-level question.
ROUTER_LOOSEN_CHOICES = ("lists", "result_words", "class_of")
ROUTER_LOOSEN_DEFAULT = "lists,result_words"  # chosen Oct 31 from eval/reports/dev/loosen/README.md
# Glimmer's reasoning strengths (base/local_llm.py REASONING_LEVELS) and the router's token budget.
ROUTER_REASONING_LEVELS = ("low", "medium", "high", "xhigh")
MIN_ROUTER_TOKENS = 64
MAX_ROUTER_TOKENS = 32768


class CloudBackendRefused(RuntimeError):
    """Raised when private data would reach a cloud model endpoint."""


class NonMetaModelRefused(ValueError):
    """Raised by load_settings for a setting that would call a model that is not a Meta model."""


# The organizers' ruling on the Cerebral Valley Discord, Nov 2, 2026: every model the project calls
# at runtime must be a Meta model (Muse Glimmer, Muse Spark, SAM and the Muse API models), with no
# non-Meta helper beside it, and Llama does not count as a Meta model however it is run.
RULING = (
    "The hackathon organizers ruled on Nov 2, 2026 that every model Muse Privacy calls must be a Meta "
    "model, with no non-Meta helper beside it, and that Llama models do not count."
)


META_CLOUD_PREFIX = "meta/muse-"  # OpenRouter ids of Meta's Muse models, such as meta/muse-glimmer-30b


def refuse_non_meta(values: Mapping[str, str]) -> None:
    """Refuse every setting that would reach a model that is not a Meta model, with a plain reason.

    The code behind these settings stays in the repo (the owner has not decided whether to delete
    it), but nothing that starts from load_settings can reach it.
    """
    get = values.get
    for key in ("PRIMARY_MODEL", "CHECKER_BACKEND"):
        if (get(key) or "").strip().lower() == "lfm":
            raise NonMetaModelRefused(
                f"{key}=lfm runs Liquid's LFM3-VL-2B, which is not a Meta model. {RULING} "
                f"Set {key}=glimmer or leave it unset, so Muse Glimmer does the work."
            )
    if (get("SEARCH_EMBEDDINGS") or "0").strip() == "1":
        raise NonMetaModelRefused(
            f"SEARCH_EMBEDDINGS=1 runs Google's EmbeddingGemma 2, which is not a Meta model. {RULING} "
            "Set SEARCH_EMBEDDINGS=0 or leave it unset; search then uses keywords only."
        )
    if (get("PROMPT_GUARD") or "0").strip() == "1":
        raise NonMetaModelRefused(
            f"PROMPT_GUARD=1 runs Llama Prompt Guard 2. {RULING} "
            "Set PROMPT_GUARD=0 or leave it unset; the floors, the final leak check and the approval page still hold."
        )
    # On OpenRouter GLIMMER_MODEL picks the model itself, so it must be one of Meta's Muse models
    # (meta/muse-glimmer-30b by default); on llama_server it is only the alias of the local file.
    backend = (get("GLIMMER_BACKEND") or "openrouter").strip().lower()
    cloud_model = (get("GLIMMER_MODEL") or "").strip()
    if backend == "openrouter" and cloud_model and not cloud_model.lower().startswith(META_CLOUD_PREFIX):
        raise NonMetaModelRefused(
            f"GLIMMER_MODEL={cloud_model} on OpenRouter is not one of Meta's Muse models. {RULING} "
            f"Set GLIMMER_MODEL=meta/muse-glimmer-30b or leave it unset."
        )
    spark_model = (get("SPARK_MODEL") or "").strip()
    if spark_model and not spark_model.lower().startswith("muse-"):
        raise NonMetaModelRefused(
            f"SPARK_MODEL={spark_model} is not one of Meta's Muse models. {RULING} "
            "Set SPARK_MODEL=muse-spark-1.3 or leave it unset."
        )
    jetson = sorted(k for k, v in values.items() if k.startswith("JETSON_LFM_") and (v or "").strip())
    if jetson:
        raise NonMetaModelRefused(
            f"{', '.join(jetson)} point Muse Privacy at Liquid's LFM3-1.7B on a Jetson, which is not a Meta "
            f"model. {RULING} Remove the JETSON_LFM_ lines from .env."
        )


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

    @property
    def regions(self) -> Path:
        """What the SAM sidecar found in each image (kinds and boxes) and its covered copy, by image hash."""
        return self.home / "regions"


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
    # Router changes that ask less often (ROUTER_LOOSEN, a comma list of ROUTER_LOOSEN_CHOICES, "all"
    # or "none"): lists and result_words unless set, class_of only when asked for. See base/router.py.
    router_loosen: frozenset[str] = frozenset({"lists", "result_words"})
    # Approval cards that may wait at once; past it a new ask is refused until the user clears some.
    # 0 is no cap (eval harnesses: run_eval.prepare_home, where cards stay unanswered on purpose).
    max_pending: int = 20
    light_serial: str | None = None
    # A certificate and key for the approval port (the Jetson on a home network). With both set
    # the page and the /heavy routes are served over TLS and the session cookie is Secure.
    approval_tls_cert: Path | None = None
    approval_tls_key: Path | None = None
    # The model for the checks and search: "glimmer" uses the answer model. "lfm" (a small Liquid
    # model on this device's own llama-server) is refused by load_settings since the Nov 2 ruling.
    checker_backend: Literal["glimmer", "lfm"] = "glimmer"
    # GLIMMER_REASONING=off: no reasoning line or reasoning_strength in Glimmer's requests and a stop
    # at <|eot|>, for a file whose reasoning is broken. start.sh then serves it with --reasoning-format
    # none; give the file's own template in GLIMMER_TEMPLATE. Tested on stage 2 Q4_K_M, b11970, A100.
    glimmer_reasoning: Literal["on", "off"] = "on"
    # The AI app linked to this device, by name, for its pages and messages (base/apps.py): Muse,
    # Claude, ChatGPT or another app that takes a remote MCP connector.
    linked_app: str = "Muse"
    # Who labels Muse's requests: the checker, or Glimmer with its labels checked the same way
    # (LABELS_BACKEND=glimmer, which needs PRIMARY_MODEL=glimmer and CHECKER_BACKEND=lfm).
    labels_backend: Literal["checker", "glimmer"] = "checker"
    # "lfm" ran every model step but the router on the checker's LFM3-VL-2B first, with the
    # Jetson's LFM (below) as the fallback. Refused by load_settings since the Nov 2 ruling.
    primary_model: Literal["glimmer", "lfm"] = "glimmer"
    # LFM3-1.7B on the user's Jetson through an OpenAI-compatible gateway on the internet: a remote
    # endpoint, so it is treated like a cloud model and only sees invented data. JETSON_LFM_* is
    # refused by load_settings since the Nov 2 ruling.
    jetson_lfm_url: str | None = None
    jetson_lfm_model: str = "hf.co/LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"
    jetson_lfm_key: str | None = None
    checker_url: str = f"http://127.0.0.1:{CHECKER_PORT}/v1"
    checker_model: str = "lfm3-vl-2b"
    checker_api_key: str | None = None
    rag_candidates: int = 20
    # Search adds EmbeddingGemma 2 on this device's llama-server to BM25 (SEARCH_EMBEDDINGS=1, refused
    # by load_settings since the Nov 2 ruling: not a Meta model).
    search_embeddings: bool = False
    embed_url: str = f"http://127.0.0.1:{EMBED_PORT}/v1"
    embed_model: str = "embeddinggemma-2"
    # pdftotext (poppler) makes .pdf files documents; None when it is not installed.
    pdftotext_bin: str | None = None
    # SAM_ENABLED=1: the SAM 3.1 sidecar (sidecars/sam/) covers faces, signatures, ID cards and
    # barcodes before the local model reads an image, and an image it cannot check is not read.
    sam_enabled: bool = False
    sam_url: str = f"http://127.0.0.1:{SAM_PORT}"
    # PROMPT_GUARD=1: Llama Prompt Guard 2 (22M, onnxruntime on the CPU) reads each source document
    # and Muse's request for text that tries to give the model orders; a hit asks the user. Refused
    # by load_settings since the Nov 2 ruling (Llama does not count as a Meta model).
    prompt_guard: bool = False
    prompt_guard_dir: Path = REPO_ROOT / "models" / "prompt-guard-2-22m"
    prompt_guard_threshold: float = 0.5
    # DEVICE_ONLY=1: every model is on this device. No OpenRouter, no Jetson gateway, no Spark key.
    # Since the Nov 2 ruling that means Muse Glimmer on this device's llama-server.
    device_only: bool = False
    # daily: every tag day gives each person a new tag, and an old tag restores until
    # tag_grace_hours after its day ends, however often it is sent. off: one tag per value, forever.
    tag_rotation: Literal["daily", "off"] = "daily"
    tag_grace_hours: float = 36.0
    # The router's model call: Glimmer's reasoning strength (llama-server's
    # chat_template_kwargs.reasoning_strength and the system prompt's line) and its token budget,
    # which reasoning counts against.
    router_reasoning: Literal["low", "medium", "high", "xhigh"] = "low"
    router_max_tokens: int = 1500
    # save_on_device's contact sheet (CONTACTS_PATH): Student, Guardian and Email columns. Read on
    # the device only. None means WORKSPACE_ROOT/records/parent_contacts.md.
    contacts_path: Path | None = None
    # How the relay client reaches the relay: "system" uses the system or environment proxy (the
    # default), "direct" bypasses every proxy (RELAY_PROXY=direct, for a proxy the relay refuses).
    relay_proxy: Literal["system", "direct"] = "system"
    # OBSERVE_POLICY: a candidate policy file (it must say mode: observe) that egress only watches,
    # writing what it would decide to BASE_HOME/observe.jsonl (base/observe.py). None: off.
    observe_policy_path: Path | None = None
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

    @property
    def contacts(self) -> Path:
        """The contact sheet save_on_device reads: CONTACTS_PATH, else records/parent_contacts.md."""
        return self.contacts_path or self.workspace_root / "records" / "parent_contacts.md"

    def ensure_home(self) -> Path:
        for d in (self.home, self.paths.output, self.paths.adapters):
            d.mkdir(parents=True, exist_ok=True)
            os.chmod(d, 0o700)
        return self.home


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Build settings from .env in the repo root, overridden by `env` (default: os.environ).

    Refuses any setting that would call a model that is not a Meta model (refuse_non_meta)."""
    merged = _merged(env)
    refuse_non_meta(merged)
    return _build(merged)


def _load_settings_for_tests(env: Mapping[str, str] | None = None) -> Settings:
    """load_settings as it was before the Nov 2 ruling: no Meta-models-only refusal, and
    DEVICE_ONLY=1 defaults to PRIMARY_MODEL=lfm. Only for unit tests of the code the refused
    settings used to reach, which stays in the repo until the owner decides whether to delete it.
    Never called outside tests/ (tests/test_config.py checks)."""
    return _build(_merged(env), lfm_device_default=True)


def _merged(env: Mapping[str, str] | None) -> dict[str, str]:
    merged: dict[str, str] = read_dotenv(REPO_ROOT / ".env")
    merged.update(os.environ if env is None else env)
    return merged


def _build(merged: Mapping[str, str], *, lfm_device_default: bool = False) -> Settings:
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
    loosen = _router_loosen(get("ROUTER_LOOSEN", ROUTER_LOOSEN_DEFAULT))
    # Muse Glimmer by default, device-only included (Nov 2 ruling: LFM was the device-only default).
    primary = get("PRIMARY_MODEL", "lfm" if device_only and lfm_device_default else "glimmer")
    if dreaming == "local_lora" and primary == "lfm":
        raise ValueError("DREAMING_BACKEND=local_lora trains Glimmer: set PRIMARY_MODEL=glimmer and GLIMMER_GGUF")
    if primary not in ("glimmer", "lfm"):
        raise ValueError(f"PRIMARY_MODEL must be glimmer or lfm, not {primary!r}")
    checker = get("CHECKER_BACKEND", primary)
    if checker not in ("glimmer", "lfm"):
        raise ValueError(f"CHECKER_BACKEND must be glimmer or lfm, not {checker!r}")
    if primary == "lfm" and checker != "lfm":
        raise ValueError("PRIMARY_MODEL=lfm runs on the checker's server: set CHECKER_BACKEND=lfm or leave it unset")
    labels = get("LABELS_BACKEND", "checker")
    if labels not in ("checker", "glimmer"):
        raise ValueError(f"LABELS_BACKEND must be checker or glimmer, not {labels!r}")
    glimmer_reasoning = get("GLIMMER_REASONING", "on")
    linked_app = apps.clean(get("LINKED_APP"))
    if glimmer_reasoning not in ("on", "off"):
        raise ValueError(f"GLIMMER_REASONING must be on or off, not {glimmer_reasoning!r}")
    if labels == "glimmer" and (primary != "glimmer" or checker != "lfm"):
        # With load_settings this always fails: CHECKER_BACKEND=lfm is refused (Nov 2 ruling), and with
        # CHECKER_BACKEND=glimmer Glimmer already labels Muse's requests.
        raise ValueError(
            "LABELS_BACKEND=glimmer needs PRIMARY_MODEL=glimmer and CHECKER_BACKEND=lfm, and LFM is not a Meta "
            "model. With CHECKER_BACKEND=glimmer, Muse Glimmer already labels Muse's requests: leave LABELS_BACKEND unset."
        )
    embed_url = get("EMBED_URL", f"http://127.0.0.1:{EMBED_PORT}/v1").rstrip("/")
    if not _is_loopback_url(embed_url):
        raise ValueError("EMBED_URL must be this device (127.0.0.1 or localhost): it reads raw documents")
    sam_url = get("SAM_URL", f"http://127.0.0.1:{SAM_PORT}").rstrip("/")
    if not _is_loopback_url(sam_url):
        raise ValueError("SAM_URL must be this device (127.0.0.1 or localhost): it reads raw page images")
    pdftotext = get("PDFTOTEXT_BIN") or shutil.which("pdftotext") or None
    jetson_lfm_url = (get("JETSON_LFM_BASE") or "").rstrip("/") or None
    if jetson_lfm_url and not jetson_lfm_url.startswith("https://"):
        raise ValueError("JETSON_LFM_BASE must be an https:// address: the key and the text cross the internet")
    checker_url = get("CHECKER_URL", f"http://127.0.0.1:{CHECKER_PORT}/v1").rstrip("/")
    if checker == "lfm" and not _is_loopback_url(checker_url):
        raise ValueError("CHECKER_URL must be this device (127.0.0.1 or localhost): the checker reads raw documents")
    checker_key = get("CHECKER_API_KEY") or _read_key(get("BASE_HOME", str(Path.home() / ".base"))) or None
    checker_model = get("CHECKER_MODEL", "lfm3-vl-2b")
    relay_proxy = get("RELAY_PROXY", "system") or "system"
    if relay_proxy not in ("system", "direct"):
        raise ValueError(f"RELAY_PROXY must be system or direct, not {relay_proxy!r}")
    workspace_root = Path(get("WORKSPACE_ROOT", str(REPO_ROOT / "demo"))).expanduser().resolve()
    contacts = Path(get("CONTACTS_PATH")).expanduser() if get("CONTACTS_PATH") else None
    if contacts is not None and not contacts.is_absolute():
        contacts = workspace_root / contacts  # a relative path is inside the workspace
    meta_key = get("META_API_KEY") or None
    router_reasoning = get("ROUTER_REASONING", "low")
    if router_reasoning not in ROUTER_REASONING_LEVELS:
        raise ValueError(f"ROUTER_REASONING must be low, medium, high or xhigh, not {router_reasoning!r}")
    router_max_tokens = get("ROUTER_MAX_TOKENS", "1500")
    if not router_max_tokens.isdigit() or not MIN_ROUTER_TOKENS <= int(router_max_tokens) <= MAX_ROUTER_TOKENS:
        raise ValueError(
            f"ROUTER_MAX_TOKENS must be a whole number from {MIN_ROUTER_TOKENS} to {MAX_ROUTER_TOKENS}, "
            f"not {router_max_tokens!r}"
        )
    if device_only:
        jetson_lfm_url, meta_key = None, None
        if primary == "lfm":  # one model on this device for every step, whatever GLIMMER_BACKEND says
            backend = "llama_server"
            answer_url = router_url = checker_url
            answer_model = router_model = checker_model
            api_key = checker_key
        elif backend != "llama_server" or not (_is_loopback_url(answer_url) and _is_loopback_url(router_url)):
            raise ValueError(
                "DEVICE_ONLY=1 needs Muse Glimmer on llama-server on this device (GLIMMER_BACKEND=llama_server, "
                "ANSWER_URL and ROUTER_URL on 127.0.0.1). For the cloud demo on invented data set DEVICE_ONLY=0."
            )
    rotation = get("TAG_ROTATION", "daily")
    if rotation not in ("daily", "off"):
        raise ValueError(f"TAG_ROTATION must be daily or off, not {rotation!r}")
    try:
        grace = float(get("TAG_GRACE_HOURS", "36"))
    except ValueError:
        grace = 0.0
    if not grace > 0:
        raise ValueError("TAG_GRACE_HOURS must be a number of hours above 0")
    try:
        pg_threshold = float(get("PROMPT_GUARD_THRESHOLD", "0.5"))
    except ValueError:
        pg_threshold = -1.0
    if not 0 < pg_threshold < 1:
        raise ValueError("PROMPT_GUARD_THRESHOLD must be a number between 0 and 1")

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
        workspace_root=workspace_root,
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
        max_pending=int(get("MAX_PENDING", "20")),
        light_serial=get("LIGHT_SERIAL") or None,
        approval_tls_cert=Path(get("APPROVAL_TLS_CERT")).expanduser() if get("APPROVAL_TLS_CERT") else None,
        approval_tls_key=Path(get("APPROVAL_TLS_KEY")).expanduser() if get("APPROVAL_TLS_KEY") else None,
        checker_backend=checker,  # type: ignore[arg-type]
        labels_backend=labels,  # type: ignore[arg-type]
        glimmer_reasoning=glimmer_reasoning,  # type: ignore[arg-type]
        linked_app=linked_app,
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
        sam_enabled=get("SAM_ENABLED", "0") == "1",
        sam_url=sam_url,
        prompt_guard=get("PROMPT_GUARD", "0") == "1",
        prompt_guard_dir=Path(get("PROMPT_GUARD_DIR", str(REPO_ROOT / "models" / "prompt-guard-2-22m"))).expanduser(),
        prompt_guard_threshold=pg_threshold,
        device_only=device_only,
        tag_rotation=rotation,  # type: ignore[arg-type]
        tag_grace_hours=grace,
        router_reasoning=router_reasoning,  # type: ignore[arg-type]
        router_max_tokens=int(router_max_tokens),
        contacts_path=contacts,
        relay_proxy=relay_proxy,  # type: ignore[arg-type]
        observe_policy_path=Path(get("OBSERVE_POLICY")).expanduser() if get("OBSERVE_POLICY") else None,
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


def synthetic_folder(folder: Path, root: Path) -> Path | None:
    """The nearest of `folder` and its parents inside `root` (root included) that holds the marker.

    A marker above the workspace root does not count: a stray .synthetic in a home folder or a
    shared parent must never mark a real class folder as invented data.
    """
    folder, root = Path(folder).resolve(), Path(root).resolve()
    for candidate in (folder, *folder.parents):
        if not candidate.is_relative_to(root):
            return None
        if (candidate / SYNTHETIC_MARKER).is_file():
            return candidate
    return None


def synthetic_marked(folder: Path, root: Path) -> bool:
    """Whether `folder` or a parent of it inside `root` (root included) holds the marker, and every
    file under that marker's folder is in its manifest with a matching hash (base/manifest.py)."""
    marked = synthetic_folder(folder, root)
    return marked is not None and manifest.check(marked).ok


def assert_synthetic(settings: Settings, folder: Path) -> None:
    """Refuse to read a folder with a cloud Glimmer backend unless it is marked synthetic.

    The marker may sit in the folder or a parent of it up to the workspace root, not above it, and
    the manifest beside it must list every file under that folder with a matching hash. The
    refusal names a count of files, never a file name.
    """
    if not settings.is_cloud_backend:
        return
    folder = Path(folder).resolve()
    marked = synthetic_folder(folder, settings.workspace_root)
    if marked is None:
        raise CloudBackendRefused(
            f"GLIMMER_BACKEND={settings.glimmer_backend} sends text to a cloud endpoint, so only folders "
            f"marked with a {SYNTHETIC_MARKER} file (invented data) can be read. {folder.name} is not marked."
        )
    found = manifest.check(marked)
    if not found.ok:
        raise CloudBackendRefused(
            f"GLIMMER_BACKEND={settings.glimmer_backend} sends text to a cloud endpoint, and {found.problem()}, "
            "so nothing in it is read."
        )
