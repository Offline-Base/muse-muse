"""The single exit: every connector result passes through Egress before it reaches Muse.

See docs/CONTRACTS.md (Egress). release() tags the raw local result, routes it, records one
decision row and returns only tagged or summarized text. final_check() is the last line of
defense: any leak it finds replaces the result with "Held on your device." Every path that
returns text to Muse, including the waiting and refusal messages, goes through final_check.
"""

from __future__ import annotations

import functools
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from base import events as events_module
from base import guard as guard_module
from base.config import CloudBackendRefused, assert_synthetic
from base.router import never_share_floor
from base.types import IDENTIFIER_KINDS, Hit, RouteDecision, RouteInput, TagResult, default_share_form

log = logging.getLogger(__name__)

WAITING_TEXT = "Waiting for your OK on the device."
HELD_TEXT = "Held on your device."
KEPT_TEXT = "Kept on your device."
SUMMARY_FAILED = "A class summary could not be made without per-student detail, so it stayed on the device."
NAME_CHECK_FAILED = "The device could not finish its check for names, so the result stayed on the device."
TOPIC_CHECK_FAILED = "The device could not finish reading what the request is for, so the result stayed on the device."

# Kinds whose text is built by the device itself from numbers only: the guard's roster and
# identifier passes cover them, so they skip the model's second pass for names. Document lists
# are not here: titles are first headings and paths are file names, both written by people.
NO_NAME_PASS = frozenset({"dreaming_report"})
# Kinds the policy shares whatever the request is for, so the request topic pass is skipped.
NO_TOPIC_PASS = frozenset({"document_list", "dreaming_report"})

# What Muse is told when a result is kept. Fixed strings only: the router's own reason is model
# text that could repeat what the result says, so it stays on the approval page.
KEPT_REASONS = (
    ("blocked", "It mentions a topic you never share."),
    ("policy:", "Your rules say results like this stay on the device."),
    ("learned:refuse", "Your rules say results like this stay on the device."),
    ("summary", "A class summary could not be made without per-student detail."),
)
KEPT_DEFAULT = "The privacy check kept it on the device."
CHECK_PENDING = "The device is still checking this result. Call get_result again in a little while."

SUMMARY_INPUT_LIMIT = 12000
SUMMARY_PROMPT = (
    "Write a short class-level summary of the result below for a teacher. Use counts, averages, "
    "ranges and common patterns only. Do not mention any one student, tag or individual score. "
    "Reply with the summary text only."
)

_PERSON_TAG = re.compile(r"\[(?:Student [A-Z]+|Person \d+)\]")

Status = Literal["shared", "waiting", "refused"]


@dataclass
class Released:
    """What egress hands the connector. Only `text` goes to Muse.

    `tag_result` holds real values in its tag map and hits, so it stays out of repr and logs.
    """

    status: Status
    text: str
    approval_id: int | None = None
    decision: RouteDecision | None = None
    tag_result: TagResult | None = field(default=None, repr=False)
    # True when a check could not run (the model was down or busy): nothing was decided or
    # recorded, and the same release can be tried again later.
    retryable: bool = False


def request_keyword_topics(raw_request: str, tagged_request: str, never_share: Mapping, scan=None) -> list[str]:
    """Never-share topics whose keywords are in Muse's request. The raw request is scanned too
    (a local regex on the device; nothing is stored or sent), so a keyword inside a tagged span
    still counts: "1200 Oak Avenue" is "[Address 1]" once tagged."""
    scan = scan or guard_module.blocked_topics
    return list(dict.fromkeys([*scan(raw_request or "", never_share), *scan(tagged_request or "", never_share)]))


def needs_topic_pass(result_kind: str, tagged: TagResult, own_topics: Sequence[str], policy: Any) -> bool:
    """Whether the request-topic model pass could change the outcome: not for NO_TOPIC_PASS kinds,
    and not when the result's own never-share topics already make the floor refuse."""
    if result_kind in NO_TOPIC_PASS:
        return False
    never_share = policy.never_share
    own_blocked = [t for t in own_topics if t in never_share]
    return never_share_floor(tagged.blocked, own_blocked, getattr(policy, "ask_first", None) or ()) != "refuse"


def route_input(
    asked: TagResult,
    result_kind: str,
    tagged: TagResult,
    own_topics: Sequence[str],
    asked_about: Sequence[str],
    never_share: Mapping,
    summary: str | None = None,
) -> RouteInput:
    """The RouteInput egress routes: the tagged result with its hits and blocked reasons, plus the
    identifier hits in Muse's tagged request (`asked`); the result's own topics (`own_topics`: job
    and keyword topics) then the request's (`asked_about`); and in `request_blocked` the
    never-share topics only the request names. scripts/cloud/quant_eval_modal.py builds its
    lookups with it too, so the two cannot drift apart."""
    return RouteInput(
        request=asked.text,
        result_kind=result_kind,
        tagged_text=tagged.text,
        # an identifier in the request (an address, a phone) is a reason to ask too
        hits=[*tagged.hits, *(h for h in asked.hits if h.kind in IDENTIFIER_KINDS)],
        blocked=list(tagged.blocked),
        summary=summary,
        topics=list(dict.fromkeys([*own_topics, *asked_about])),
        request_blocked=[t for t in asked_about if t in never_share and t not in own_topics],
    )


def refusal_text(floors: list[str] | tuple[str, ...] | None = None) -> str:
    """'Kept on your device.' plus one fixed sentence for the floor that kept it.

    Never model text: a router reason could spell out what the record says.
    """
    for prefix, sentence in KEPT_REASONS:
        if any(f.startswith(prefix) for f in floors or ()):
            return f"{KEPT_TEXT} {sentence}"
    return f"{KEPT_TEXT} {KEPT_DEFAULT}"


class Egress:
    """Built with a services object holding roster, tagmap, policy, router, approvals and
    optionally answer_llm, settings, audit and events. `guard` defaults to base.guard."""

    def __init__(self, services: Any, guard: Any = None):
        self.services = services
        if guard is None:
            from base import guard as guard_module

            guard = guard_module
        self.guard = guard

    # Public API

    def release(
        self,
        tool: str,
        request: str,
        raw_text: str,
        result_kind: str,
        *,
        job_id: str | None = None,
        summary: str | None = None,
        topics: tuple[str, ...] | list[str] = (),
        item_id: str | None = None,
        day: int | None = None,
        synthetic: bool | None = None,
    ) -> Released:
        """Tag, route, record and return the result. `synthetic=None` derives it from settings."""
        s = self.services
        if synthetic is None:
            synthetic = self._synthetic()
        try:
            tagged = self._tag(raw_text, result_kind, synthetic)
        except Exception as exc:  # the name pass or the guard broke: hold rather than guess
            log.warning("tagging failed (%s); holding the result", type(exc).__name__)
            self._audit("egress", "name_check_failed")
            held = RouteDecision("refuse", NAME_CHECK_FAILED, "fallback", 0, ["name_check"])
            return Released("refused", HELD_TEXT, None, held, None, retryable=True)
        # Muse's request is stored on the device and shown to the router: tag it too, in case
        # Muse was given a real name some other way. The raw request goes no further than here.
        own_topics = list(dict.fromkeys([*topics, *tagged.topics]))
        try:
            asked = self._tag_request(request)
            asked_about = self._request_topics(request, asked.text, result_kind, tagged, own_topics, synthetic)
        except Exception as exc:  # tagging the request or the topic pass broke: hold, never route without it
            log.warning("request check failed (%s); holding the result", type(exc).__name__)
            self._audit("egress", "topic_check_failed")
            held = RouteDecision("refuse", TOPIC_CHECK_FAILED, "fallback", 0, ["topic_check"])
            return Released("refused", HELD_TEXT, None, held, tagged, retryable=True)
        request = asked.text
        inp = route_input(asked, result_kind, tagged, own_topics, asked_about, s.policy.never_share, summary)
        all_topics = inp.topics
        route = s.router.decide(inp, synthetic=synthetic)
        shown_form = default_share_form(result_kind, all_topics)

        outgoing = tagged.text
        if route.decision == "share_summary" or (route.decision == "ask_user" and shown_form == "share_summary"):
            made, failure = self._tagged_summary(summary, tagged.text, request, result_kind, synthetic)
            if failure == "model":  # the model could not write or check one: try again later
                self._audit("egress", "summary_failed")
                held = RouteDecision("refuse", SUMMARY_FAILED, "fallback", route.latency_ms, [*route.floors, "summary"])
                return Released("refused", HELD_TEXT, None, held, tagged, retryable=True)
            if made is None:
                route = RouteDecision("refuse", SUMMARY_FAILED, route.source, route.latency_ms, [*route.floors, "summary"])
            else:
                outgoing = made

        row = {
            "tool": tool,
            "request": request,
            "result_kind": result_kind,
            "topics": all_topics,
            "blocked": list(tagged.blocked),
            "tagged_text": outgoing,
            "shown_form": shown_form,
            "router_decision": route.decision,
            "router_reason": route.reason,
            "router_source": route.source,
            "job_id": job_id,
            "day": day,
            "item_id": item_id,
        }
        if route.decision == "ask_user":
            approval_id = s.approvals.create_pending(**row)
            return self._finish("waiting", WAITING_TEXT, approval_id, route, tagged, detail=str(approval_id))
        s.approvals.record_auto(**row)
        if route.decision == "refuse":
            return self._finish("refused", refusal_text(route.floors), None, route, tagged)
        return self._finish("shared", outgoing, None, route, tagged, detail=job_id or tool)

    def resolve(self, approval_id: int) -> Released:
        """The outcome for a decision row after the user answers (or while they have not)."""
        row = self.services.approvals.get(approval_id)
        if row is None or row.get("deleted"):
            return self._finish("refused", KEPT_TEXT, approval_id, None, None)
        route = RouteDecision(
            row.get("router_decision") or "ask_user",
            row.get("router_reason") or "",
            row.get("router_source") or "model",
        )
        status = row.get("status")
        detail = row.get("job_id") or row.get("tool")
        if status == "pending":
            return self._finish("waiting", WAITING_TEXT, approval_id, route, None, detail=str(approval_id))
        if status == "approved":
            return self._finish("shared", row.get("tagged_text") or "", approval_id, route, None, detail=detail)
        if status == "denied":
            return self._finish("refused", KEPT_TEXT, approval_id, route, None)
        # status auto: replay what the router decided
        if route.decision in ("share_tagged", "share_summary"):
            return self._finish("shared", row.get("tagged_text") or "", approval_id, route, None, detail=detail)
        return self._finish("refused", refusal_text(), approval_id, route, None)

    def final_check(self, text: str) -> list[Hit]:
        """Every real name, nickname, tagged real value or identifier still in `text`.

        Fails closed: if the check itself breaks, it reports a hit so nothing is sent.
        """
        if not text:
            return []
        s = self.services
        try:
            return list(self.guard.leaks(text, s.roster, s.tagmap))
        except Exception as exc:
            log.warning("final leak check failed (%s); holding the result", type(exc).__name__)
            return [Hit("check_failed", "", 0, 0)]

    # Helpers

    def _tag(self, text: str, result_kind: str, synthetic: bool) -> TagResult:
        """guard.tag with the answer model's second pass for names the roster misses.

        The pass runs for every kind except NO_NAME_PASS. If it raises, so does this, and the
        caller holds the result.
        """
        s = self.services
        return self.guard.tag(
            text,
            s.roster,
            s.tagmap,
            llm_names=self._name_pass(result_kind, synthetic),
            never_share=s.policy.never_share,
        )

    def _tag_request(self, request: str) -> TagResult:
        """Muse's request with roster names, known values and identifiers tagged (no model call).
        Raises if tagging fails; the caller holds the result."""
        if not request:
            return TagResult(request or "")
        s = self.services
        return self.guard.tag(request, s.roster, s.tagmap)

    def _request_topics(
        self, raw_request: str, request: str, result_kind: str, tagged: TagResult, own_topics: list[str], synthetic: bool
    ) -> list[str]:
        """Never-share topics named in Muse's request, plus the policy's request topics the answer
        model finds in the tagged `request` ("meant for a student's family"). A result can be
        harmless text while the request says where it is going, so rules and dreaming need both.

        The keyword scan reads the raw request too (request_keyword_topics), and the model pass
        runs only when its labels could change the outcome (needs_topic_pass). Raises if the model
        pass fails; the caller holds the result."""
        s = self.services
        found = request_keyword_topics(
            raw_request, request, s.policy.never_share, getattr(self.guard, "blocked_topics", None)
        )
        wanted = getattr(s.policy, "request_topics", None) or {}
        label = getattr(self._checker(), "request_topics", None)
        if not (wanted and callable(label) and request and needs_topic_pass(result_kind, tagged, own_topics, s.policy)):
            return found
        return found + label(request, wanted, synthetic=synthetic)

    def _checker(self) -> Any:
        """The model for the name pass and the request topics: services.checker_llm (LFM3-VL-2B
        on this device with CHECKER_BACKEND=lfm), else the answer model."""
        s = self.services
        return getattr(s, "checker_llm", None) or getattr(s, "answer_llm", None)

    def _name_pass(self, result_kind: str, synthetic: bool):
        if result_kind in NO_NAME_PASS:
            return None
        names = getattr(self._checker(), "llm_names", None)
        if not callable(names):
            return None
        return functools.partial(names, synthetic=synthetic)

    def _finish(
        self,
        status: Status,
        text: str,
        approval_id: int | None,
        route: RouteDecision | None,
        tagged: TagResult | None,
        detail: str | None = None,
    ) -> Released:
        leaks = self.final_check(text)
        if leaks:
            log.warning("egress blocked a result: %d leak(s) of kind %s", len(leaks), sorted({h.kind for h in leaks}))
            self._audit("egress", "egress_blocked")
            return Released("refused", HELD_TEXT, approval_id, route, tagged)
        if status == "shared":
            self._emit("sending", detail)  # the light plays one sweep, then shows the next state
            self._emit(self._resting_state(), detail)
        elif status == "waiting":
            self._emit("waiting", detail)
        return Released(status, text, approval_id, route, tagged)

    def _tagged_summary(
        self, summary: str | None, tagged_text: str, request: str, result_kind: str, synthetic: bool
    ) -> tuple[str | None, str | None]:
        """The provided summary, or one made by the answer model from the tagged text, then tagged.

        Returns (summary, None), or (None, "model") when a model call failed (worth trying again
        later), or (None, "named") when no summary can be made without naming someone.
        """
        text = (summary or "").strip()
        if not text:
            llm = getattr(self.services, "answer_llm", None)
            if llm is None:
                return None, "named"
            messages = [
                {"role": "system", "content": f"Reasoning strength: low\n\n{SUMMARY_PROMPT}"},
                {"role": "user", "content": f"Request: {request}\n\nResult:\n{tagged_text[:SUMMARY_INPUT_LIMIT]}"},
            ]
            try:
                result = llm.chat(messages, max_tokens=2000, reasoning="low", synthetic=synthetic)
            except Exception as exc:
                log.warning("summary model call failed: %s", type(exc).__name__)
                return None, "model"
            text = (getattr(result, "content", "") or "").strip()
            if not text:
                return None, "named"
        try:
            tagged = self._tag(text, result_kind, synthetic).text
        except Exception as exc:
            log.warning("summary tagging failed: %s", type(exc).__name__)
            return None, "model"
        if _PERSON_TAG.search(tagged):
            log.warning("summary named a student or person; not sharing it")
            return None, "named"
        return tagged, None

    def _synthetic(self) -> bool:
        """On a cloud backend, data counts as synthetic only when the workspace root is marked."""
        settings = getattr(self.services, "settings", None)
        if settings is None or not getattr(settings, "is_cloud_backend", False):
            return False
        try:
            assert_synthetic(settings, settings.workspace_root)
        except CloudBackendRefused:
            return False
        except Exception as exc:  # unsure means not synthetic, the safe direction
            log.warning("could not check the synthetic marker: %s", type(exc).__name__)
            return False
        return True

    def _resting_state(self) -> str:
        """"waiting" while an approval is pending, else "idle"."""
        try:
            return "waiting" if self.services.approvals.pending() else "idle"
        except Exception:
            return "idle"

    def _emit(self, state: str, detail: str | None) -> None:
        emitter = getattr(self.services, "events", None) or events_module
        try:
            emitter.emit(state, detail)
        except Exception as exc:  # the light must never stop a result
            log.warning("could not emit %s: %s", state, type(exc).__name__)

    def _audit(self, tool: str, outcome: str) -> None:
        audit = getattr(self.services, "audit", None)
        if callable(audit):
            try:
                audit(tool, outcome)
            except Exception as exc:
                log.warning("audit write failed: %s", type(exc).__name__)
