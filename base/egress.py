"""The single exit: every connector result passes through Egress before it reaches Muse.

See docs/CONTRACTS.md (Egress). release() tags the raw local result, routes it, records one
decision row and returns only tagged or summarized text. final_check() is the last line of
defense: any leak it finds replaces the result with "Held on your device." Every path that
returns text to Muse, including the waiting and refusal messages, goes through final_check.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Literal

from base import events as events_module
from base.config import CloudBackendRefused, assert_synthetic
from base.types import Hit, RouteDecision, RouteInput, TagResult, default_share_form

log = logging.getLogger(__name__)

WAITING_TEXT = "Waiting for your OK on the device."
HELD_TEXT = "Held on your device."
KEPT_TEXT = "Kept on your device."
SUMMARY_FAILED = "A class summary could not be made without per-student detail, so it stayed on the device."

SUMMARY_INPUT_LIMIT = 12000
SUMMARY_PROMPT = (
    "Write a short class-level summary of the result below for a teacher. Use counts, averages, "
    "ranges and common patterns only. Do not mention any one student, tag or individual score. "
    "Reply with the summary text only."
)

_ANY_TAG = re.compile(r"\[[A-Z][A-Za-z]*(?: [A-Z0-9]+)?\]")
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


def refusal_text(reason: str | None) -> str:
    """'Kept on your device.' plus the router's plain reason, with any tag removed."""
    reason = _ANY_TAG.sub("[hidden]", " ".join((reason or "").split())).strip()
    return f"{KEPT_TEXT} {reason}".strip()


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
        tagged = self._tag(raw_text)
        all_topics = list(dict.fromkeys([*topics, *tagged.topics]))
        inp = RouteInput(
            request=request,
            result_kind=result_kind,
            tagged_text=tagged.text,
            hits=list(tagged.hits),
            blocked=list(tagged.blocked),
            summary=summary,
            topics=all_topics,
        )
        route = s.router.decide(inp, synthetic=synthetic)
        shown_form = default_share_form(result_kind)

        outgoing = tagged.text
        if route.decision == "share_summary" or (route.decision == "ask_user" and shown_form == "share_summary"):
            made = self._tagged_summary(summary, tagged.text, request, synthetic)
            if made is None:
                route = RouteDecision("refuse", SUMMARY_FAILED, route.source, route.latency_ms, [*route.floors, "summary"])
            else:
                outgoing = made

        row = {
            "tool": tool,
            "request": request,
            "result_kind": result_kind,
            "topics": all_topics,
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
            return self._finish("refused", refusal_text(route.reason), None, route, tagged)
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
        return self._finish("refused", refusal_text(route.reason), approval_id, route, None)

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

    def _tag(self, text: str) -> TagResult:
        s = self.services
        return self.guard.tag(text, s.roster, s.tagmap, never_share=s.policy.never_share)

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
            self._audit_blocked()
            return Released("refused", HELD_TEXT, approval_id, route, tagged)
        if status == "shared":
            self._emit("sending", detail)
        elif status == "waiting":
            self._emit("waiting", detail)
        return Released(status, text, approval_id, route, tagged)

    def _tagged_summary(self, summary: str | None, tagged_text: str, request: str, synthetic: bool) -> str | None:
        """The provided summary, or one made by the answer model from the tagged text, then tagged.

        Returns None when no summary can be made or it still names a student or person.
        """
        text = (summary or "").strip()
        if not text:
            llm = getattr(self.services, "answer_llm", None)
            if llm is None:
                return None
            messages = [
                {"role": "system", "content": f"Reasoning strength: low\n\n{SUMMARY_PROMPT}"},
                {"role": "user", "content": f"Request: {request}\n\nResult:\n{tagged_text[:SUMMARY_INPUT_LIMIT]}"},
            ]
            try:
                result = llm.chat(messages, max_tokens=2000, reasoning="low", synthetic=synthetic)
            except Exception as exc:
                log.warning("summary model call failed: %s", type(exc).__name__)
                return None
            text = (getattr(result, "content", "") or "").strip()
            if not text:
                return None
        tagged = self._tag(text).text
        if _PERSON_TAG.search(tagged):
            log.warning("summary named a student or person; not sharing it")
            return None
        return tagged

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

    def _emit(self, state: str, detail: str | None) -> None:
        emitter = getattr(self.services, "events", None) or events_module
        try:
            emitter.emit(state, detail)
        except Exception as exc:  # the light must never stop a result
            log.warning("could not emit %s: %s", state, type(exc).__name__)

    def _audit_blocked(self) -> None:
        audit = getattr(self.services, "audit", None)
        if callable(audit):
            try:
                audit("egress", "egress_blocked")
            except Exception as exc:
                log.warning("audit write failed: %s", type(exc).__name__)
