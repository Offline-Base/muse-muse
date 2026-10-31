"""One of each module for this device, wired together. See docs/CONTRACTS.md, Services.

`Services.create(settings)` is what `python -m base` runs: it loads the roster, the tag map and
the policy, builds both Glimmer clients and the checker (the answer model, or LFM3-VL-2B on this
device with CHECKER_BACKEND=lfm, which also reads scans and picks search passages; with
PRIMARY_MODEL=lfm every model step but the router tries LFM3-VL-2B first, then the Jetson's LFM
when JETSON_LFM_BASE is set, else Glimmer), the router,
the stores, the workspace agent, egress, the dreaming runner and the audit log, and starts the light. `Services.for_eval(settings)` is
the same without the light and the heavy-step queue, for the eval harness and the dreaming gate,
which build throwaway services in a temporary home.
"""

from __future__ import annotations

import logging
from typing import Any

from base import events as events_module
from base import guard
from base.approvals import ApprovalStore
from base.config import Settings
from base.connector.audit import Audit
from base.controls import ControlStore
from base.dreaming.night import NightRunner
from base.egress import Egress
from base.heavy.queue import HeavyQueue
from base.light import start_light
from base.local_llm import FallbackLLM, LocalLLM
from base.policy import UserPolicy
from base.router import Router
from base.workspace.agent import Agent
from base.workspace.ask import AskRunner, DeviceAsk
from base.workspace.embed import Embedder
from base.workspace.index import DocumentIndex
from base.workspace.jobs import JobStore
from base.workspace.rag import Rag
from base.workspace.scans import ScanReader

log = logging.getLogger(__name__)

# How long the Jetson waits for the laptop worker's result once a worker is present. Grading one
# essay with reasoning on the laptop's Q4_K_M can take longer than the queue's 30 s default.
HEAVY_WAIT_SECONDS = 120


class QuietEvents:
    """An event bus that drops everything (the eval's and the dreaming gate's services)."""

    def emit(self, *args: Any, **kwargs: Any) -> None:
        return None

    def settle(self, *args: Any, **kwargs: Any) -> None:
        return None


def discover_router_adapter(settings: Settings, router_llm: Any) -> int | None:
    """The llama-server LoRA id of router.gguf, so the router names it on every request.

    Only on llama_server with DREAMING_BACKEND=lora. The adapter stays at global scale 0, so the
    answer model, the name pass and grading never use it. None when there is no such adapter.
    """
    if settings.glimmer_backend != "llama_server" or settings.dreaming_backend not in ("lora", "local_lora"):
        return None
    root = router_llm.base_url.removesuffix("/v1")
    try:
        response = router_llm.client.get(f"{root}/lora-adapters", headers=router_llm.headers(), timeout=5)
        response.raise_for_status()
        for entry in response.json():
            if str(entry.get("path", "")).endswith("router.gguf"):
                return int(entry["id"])
    except Exception as exc:  # no server yet, or an old llama.cpp: the router runs without it
        log.warning("could not find the router adapter: %s", type(exc).__name__)
    return None


class Services:
    """Attributes: settings, events, roster, tagmap, policy, answer_llm, router_llm, checker_llm
    (answer_llm unless CHECKER_BACKEND=lfm), scans and rag (None unless lfm), router, approvals,
    jobs, index, heavy (HeavyQueue or None), agent, audit, egress, night, light."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.events: Any = events_module
        self.heavy: HeavyQueue | None = None
        self.light: Any = None

    @classmethod
    def create(
        cls, settings: Settings, *, light: bool = True, heavy: bool | None = None, owner: bool = True
    ) -> Services:
        """Wire every module for `settings`. `heavy=None` follows settings.heavy_queue.

        `owner=True` (the server) means this process owns BASE_HOME: jobs a stopped process left
        queued or running are marked failed. The eval passes False and gets a quiet event bus.
        """
        settings.ensure_home()
        s = cls(settings)
        if not owner:
            s.events = QuietEvents()  # throwaway services must not drive the light or the page
        s.roster = guard.load_roster(settings.roster_path)
        s.tagmap = guard.TagMap.for_settings(settings)
        s.policy = UserPolicy.load(settings.policy_path)
        s.answer_llm = LocalLLM(settings, role="answer")
        s.router_llm = LocalLLM(settings, role="router")
        s.checker_llm = s.answer_llm
        s.scans = s.rag = None
        if settings.checker_backend == "lfm":
            lfm = LocalLLM(settings, role="checker")
            s.checker_llm = lfm
            s.scans = ScanReader(settings, lfm)  # scans and passage picking stay local, never Glimmer
            s.rag = Rag(lfm, s.roster, s.tagmap, candidates=settings.rag_candidates)
            if settings.primary_model == "lfm" and settings.device_only:
                # One model, no fallback: when it is down, results are held (base/egress.py).
                s.checker_llm = s.answer_llm = lfm
            elif settings.primary_model == "lfm":
                # The router stays on Glimmer: in a test on Oct 29 the 2B model shared summaries of
                # per-student grades and a newsletter quote that Glimmer asks about first.
                backup = LocalLLM(settings, role="jetson") if settings.has_jetson_lfm else s.answer_llm
                s.checker_llm = FallbackLLM(lfm, backup)
                s.answer_llm = FallbackLLM(lfm, backup)
        adapter = discover_router_adapter(settings, s.router_llm) if owner else None
        s.router = Router(settings, s.router_llm, s.policy, adapter=adapter)
        s.approvals = ApprovalStore(settings.paths.db)
        s.jobs = JobStore(settings.paths.db)
        if owner:
            events_module.set_pending_source(lambda: len(s.approvals.pending()))
            failed = s.jobs.fail_unfinished()
            if failed:
                log.info("marked %d unfinished job(s) from a previous run as failed", failed)
        s.embedder = Embedder(settings) if settings.search_embeddings else None
        s.controls = ControlStore(settings.paths.controls)
        s.router.choice = lambda: s.controls.get().learning
        s.index = DocumentIndex(settings, scans=s.scans, embedder=s.embedder, controls=s.controls)
        # mode 2 needs the local model
        s.ask = DeviceAsk(s.rag, s.index, never_share=s.policy.never_share) if s.rag is not None else None
        if settings.heavy_queue if heavy is None else heavy:
            s.heavy = HeavyQueue(settings.paths.db, wait_seconds=HEAVY_WAIT_SECONDS)
        s.agent = Agent(
            settings, s.answer_llm, s.index, s.jobs, heavy=s.heavy, roster=s.roster, tagmap=s.tagmap
        )
        s.ask_runner = AskRunner(s.ask, s.jobs) if s.ask is not None else None
        s.audit = Audit.for_settings(settings)
        s.egress = Egress(s)
        s.night = NightRunner(s)
        if light:
            s.light = start_light(settings)
        return s

    @classmethod
    def for_eval(cls, settings: Settings) -> Services:
        """Services for eval/run_eval.py and the dreaming gate: no light, no heavy queue, and an
        event bus that goes nowhere."""
        return cls.create(settings, light=False, heavy=False, owner=False)

    def close(self) -> None:
        """Stop the agent's model steps and the light, and close the store and the model clients."""
        agent = getattr(self, "agent", None)
        if agent is not None and hasattr(agent, "stop"):
            agent.stop()
        if self.events is events_module:
            events_module.set_pending_source(None)
        if self.light is not None:
            self.light.stop()
            self.light = None
        names = ["approvals", "answer_llm", "router_llm"] + (["embedder"] if getattr(self, "embedder", None) else [])
        if getattr(self, "checker_llm", None) is not getattr(self, "answer_llm", None):
            names.append("checker_llm")
        for name in names:
            try:
                getattr(self, name).close()
            except Exception as exc:  # closing must never raise on shutdown
                log.warning("could not close %s: %s", name, type(exc).__name__)
