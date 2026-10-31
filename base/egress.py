"""The single exit: every connector result passes through Egress before it reaches Muse.

See docs/CONTRACTS.md (Egress). release() tags the raw local result, routes it, records one
decision row and returns only tagged or summarized text. final_check() is the last line of
defense: any leak it finds replaces the result with "Held on your device." Every path that
returns text to Muse, including the waiting and refusal messages, goes through final_check.
"""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import re
from collections.abc import Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from typing import Any, Literal

from base import compliance, regions, retention
from base import events as events_module
from base import guard as guard_module
from base.approvals import AutoApprove, needs_a_person
from base.config import CloudBackendRefused, assert_synthetic
from base.router import checked_labels, lfm_labels, loosened, never_share_floor, singles_out
from base.types import (
    IDENTIFIER_KINDS,
    STRICTNESS,
    Hit,
    RouteDecision,
    RouteInput,
    TagResult,
    default_share_form,
)

log = logging.getLogger(__name__)
# The user's redaction controls for the release in progress (see release and resolve).
_REDACTION: ContextVar[Any] = ContextVar("redaction", default=None)
# True while the release in progress came with a private detail in Muse's own request.
_RAW_REQUEST: ContextVar[bool] = ContextVar("raw_request", default=False)
# The tag map for the release in progress, pinned to the tag day of the tags in Muse's request.
_TAGS: ContextVar[Any] = ContextVar("tags", default=None)

WAITING_TEXT = "Waiting for your OK on the device."
HELD_TEXT = "Held on your device."
KEPT_TEXT = "Kept on your device."
RAW_REQUEST_NOTE = (
    "Note: this request included a private detail, so Muse has already seen it. Use tags in requests, "
    "and turn off training under Data controls in your Muse settings."
)
DESTINATION = "Muse, through the relay"
# Kinds that count as a private detail in Muse's request, for the note above. The kinds only a
# toggle adds are left out: they lean toward removing too much, so they'd warn about plain words.
_REQUEST_NOTE_KINDS = frozenset({"student", "teacher", "person", "term"}) | IDENTIFIER_KINDS
SUMMARY_FAILED = "A class summary could not be made without per-student detail, so it stayed on the device."
IMAGE_UNCHECKED = "It came from an image the device has not checked for faces and signatures, so it stays here."
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
TOO_MANY_WAITING = "Too many results are waiting for your OK, so this one was not added."
KEPT_REASONS = (
    ("too_many_waiting", "Too many results are waiting for the user's OK. Ask them to clear some on the device, then ask again."),
    ("compliance:cloud", "Your privacy toggles need every model on this device."),
    ("compliance:local_only", "A privacy toggle keeps everything on this device."),
    ("compliance:sensitive", "It has a kind of detail your privacy toggles keep on this device."),
    ("regions:unchecked", "It came from an image the device has not checked for faces and signatures."),
    ("compliance", "It describes fewer than 10 people, and your privacy toggles keep that on the device."),
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
    "ranges and common patterns only. Use only numbers and facts in the result, and add no "
    "comparison or range it does not state. Do not mention any one student, tag or individual score. "
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


def identifier_topics(hits: Sequence[Hit], policy: Any) -> list[str]:
    """The never-share topics the policy's identifier_topics give the result's own identifier hits
    (a phone number counts as parent_contact), so the floor refuses it like the topic. Only the
    result's hits: one in Muse's request alone is asked about, like a never-share word there."""
    mapped = getattr(policy, "identifier_topics", None) or {}
    return list(dict.fromkeys(mapped[h.kind] for h in hits if h.kind in mapped))


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


def _points_at_someone(sentence: str) -> bool:
    """A summary sentence with a person's tag, or one that describes a single student."""
    return bool(_PERSON_TAG.search(sentence)) or singles_out(sentence)


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
        sources: Sequence[str] = (),
    ) -> Released:
        """Tag, route, record and return the result. `synthetic=None` derives it from settings.

        `sources` are the workspace paths (or folders) the result came from; with the user's
        controls (services.controls) they decide what is redacted for this result.

        With tag rotation, the result is tagged on the newest tag day among the tags in `request`
        that still restore (TagMap.day_for), else today: a job Muse started with yesterday's tags
        comes back in those tags.
        """
        token = _REDACTION.set(self._redaction_for(sources))
        tags = _TAGS.set(self._tags_for(request))
        try:
            return self._release(
                tool, request, raw_text, result_kind, job_id=job_id, summary=summary, topics=topics,
                item_id=item_id, day=day, synthetic=synthetic, sources=list(sources),
            )
        finally:
            _TAGS.reset(tags)
            _REDACTION.reset(token)

    def _tags_for(self, request: str) -> Any:
        """services.tagmap pinned to the tag day of Muse's request (a TagView), or as it is."""
        tagmap = getattr(self.services, "tagmap", None)
        if not callable(getattr(tagmap, "view", None)):
            return tagmap
        try:
            return tagmap.view(tagmap.day_for(request or ""))
        except Exception as exc:  # today's tags are always a safe answer
            log.warning("could not read the request's tag day (%s); using today", type(exc).__name__)
            return tagmap.view()

    def _tags(self) -> Any:
        """The tag map for tagging in the release in progress (see _tags_for)."""
        tags = _TAGS.get()
        return self.services.tagmap if tags is None else tags

    def _redaction_for(self, sources: Sequence[str]) -> Any:
        """guard.Redaction from the user's controls for these sources, or None (tag everything)."""
        shapes = bool(getattr(getattr(self.services, "settings", None), "device_only", False))
        store = getattr(self.services, "controls", None)
        if store is None:
            return guard_module.Redaction(name_shapes=True) if shapes else None
        try:
            return store.get().redaction(sources, name_shapes=shapes)
        except Exception as exc:  # a broken controls file never means less redaction
            log.warning("privacy controls unreadable (%s); tagging everything", type(exc).__name__)
            return guard_module.Redaction(name_shapes=True) if shapes else None

    def _profiles(self) -> list[str]:
        """The compliance toggles that are on. A broken controls file reads as all of them."""
        store = getattr(self.services, "controls", None)
        if store is None:
            return []
        try:
            return list(store.get().profiles)
        except Exception as exc:
            log.warning("privacy controls unreadable (%s); every toggle applies", type(exc).__name__)
            return list(compliance.PROFILES)

    def _with_toggles(
        self, route: RouteDecision, text: str, sources: Sequence[str], profiles: Sequence[str], raw: str = "",
        images: regions.ImageCheck | None = None, request: str = "",
    ) -> RouteDecision:
        """The router's decision, or the stricter one a compliance toggle asks for. With SAM_ENABLED=1,
        a result from an image the sidecar never checked is refused (floor regions:unchecked)."""
        kinds = images.counts if images is not None else None
        hold = compliance.check(text, sources, profiles, raw, image_kinds=kinds, request=request)
        unchecked = images is not None and images.unchecked  # images is None unless SAM_ENABLED=1
        if unchecked and (hold is None or hold[0] != "refuse"):  # a toggle's own refusal keeps its reason
            hold = ("refuse", "regions:unchecked", IMAGE_UNCHECKED)
        if hold is None or STRICTNESS[route.decision] >= STRICTNESS[hold[0]]:
            return route
        return RouteDecision(hold[0], hold[2], "rule", route.latency_ms, [*route.floors, hold[1]], code=hold[1])

    def _images(self, sources: Sequence[str]) -> regions.ImageCheck | None:
        """What the SAM sidecar found on the result's source images, or None when none is an image or
        SAM_ENABLED is off (then nothing changes). A lookup that breaks counts every image as unchecked."""
        settings = getattr(self.services, "settings", None)
        if not getattr(settings, "sam_enabled", False) or not regions.image_sources(sources):
            return None
        try:
            return regions.image_check(settings, sources)
        except Exception as exc:
            log.warning("image check lookup failed (%s); counting the images as unchecked", type(exc).__name__)
            return regions.ImageCheck({}, 0, len(regions.image_sources(sources)))

    def _red_kw(self) -> dict[str, Any]:
        r = _REDACTION.get()
        return {"redaction": r} if r is not None else {}

    def _release(
        self,
        tool: str,
        request: str,
        raw_text: str,
        result_kind: str,
        *,
        job_id: str | None,
        summary: str | None,
        topics: tuple[str, ...] | list[str],
        item_id: str | None,
        day: int | None,
        synthetic: bool | None,
        sources: list[str],
    ) -> Released:
        s = self.services
        if synthetic is None:
            synthetic = self._synthetic()
        profiles = self._profiles()
        retention.maybe_purge(s, profiles)
        if profiles and not getattr(getattr(s, "settings", None), "device_only", False):
            self._audit("egress", "compliance_needs_device_only")
            held = RouteDecision(
                "refuse", "A privacy toggle is on and a model is not on this device.", "rule", 0, ["compliance:cloud"],
                code="compliance:cloud",
            )
            return Released("refused", refusal_text(held.floors), None, held, None)
        try:
            tagged = self._tag(self._neutralized(raw_text), result_kind, synthetic)
        except Exception as exc:  # the name pass or the guard broke: hold rather than guess
            log.warning("tagging failed (%s); holding the result", type(exc).__name__)
            self._audit("egress", "name_check_failed")
            held = RouteDecision("refuse", NAME_CHECK_FAILED, "fallback", 0, ["name_check"], code="name_check")
            return Released("refused", HELD_TEXT, None, held, None, retryable=True)
        # Muse's request is stored on the device and shown to the router: tag it too, in case
        # Muse was given a real name some other way. The raw request goes no further than here.
        own_topics = list(dict.fromkeys([*topics, *tagged.topics, *identifier_topics(tagged.hits, s.policy)]))
        try:
            asked = self._tag_request(request)
            asked_about = self._request_topics(request, asked.text, result_kind, tagged, own_topics, synthetic)
            settings = getattr(s, "settings", None)
            if lfm_labels(settings):
                asked_about = checked_labels(asked.text, asked_about, class_of=loosened(settings, "class_of"))
        except Exception as exc:  # tagging the request or the topic pass broke: hold, never route without it
            log.warning("request check failed (%s); holding the result", type(exc).__name__)
            self._audit("egress", "topic_check_failed")
            held = RouteDecision("refuse", TOPIC_CHECK_FAILED, "fallback", 0, ["topic_check"], code="topic_check")
            return Released("refused", HELD_TEXT, None, held, tagged, retryable=True)
        raw_kinds = sorted({h.kind for h in asked.hits} & _REQUEST_NOTE_KINDS)
        if raw_kinds:
            self._audit("egress", "private_detail_in_request")
        request = asked.text
        inp = route_input(asked, result_kind, tagged, own_topics, asked_about, s.policy.never_share, summary)
        inp.strict = bool(profiles)
        all_topics = inp.topics
        images = None if result_kind == "document_list" else self._images(sources)  # a listing never reads an image
        route = self._with_toggles(
            s.router.decide(inp, synthetic=synthetic), tagged.text, sources, profiles, raw_text, images, request
        )
        shown_form = default_share_form(result_kind, all_topics)

        outgoing = tagged.text
        if route.decision == "share_summary" or (route.decision == "ask_user" and shown_form == "share_summary"):
            made, failure = self._tagged_summary(summary, tagged.text, request, result_kind, synthetic)
            if failure == "model":  # the model could not write or check one: try again later
                self._audit("egress", "summary_failed")
                held = RouteDecision(
                    "refuse", SUMMARY_FAILED, "fallback", route.latency_ms, [*route.floors, "summary"], code="summary"
                )
                return Released("refused", HELD_TEXT, None, held, tagged, retryable=True)
            if made is None:
                route = RouteDecision(
                    "refuse", SUMMARY_FAILED, route.source, route.latency_ms, [*route.floors, "summary"], code="summary"
                )
            else:
                outgoing = made
                route = self._with_toggles(route, outgoing, sources, profiles, raw_text, images, request)

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
        if sources:
            row["sources"] = sources
        row["receipt"] = self._receipt(tagged, route, outgoing, profiles, raw_kinds, images)
        note = _RAW_REQUEST.set(bool(raw_kinds))
        try:
            return self._decide_row(route, row, outgoing, tagged, job_id, tool, profiles)
        finally:
            _RAW_REQUEST.reset(note)

    def _decide_row(
        self, route: RouteDecision, row: dict[str, Any], outgoing: str, tagged: TagResult, job_id: str | None, tool: str,
        profiles: Sequence[str],
    ) -> Released:
        """Record the row and give the outcome for the router's decision."""
        s = self.services
        if route.decision == "ask_user" and self._cards_full(route, profiles):
            # Too many cards are waiting: nothing is added to a page the user is not keeping up
            # with. It is recorded like any refusal, so dreaming does not learn from it.
            self._audit("egress", "too_many_waiting")
            route = replace(route, decision="refuse", reason=TOO_MANY_WAITING, floors=[*route.floors, "too_many_waiting"], code="too_many_waiting")
            row = {**row, "router_decision": "refuse", "router_reason": TOO_MANY_WAITING}
            row["receipt"] = {**row["receipt"], "floors": route.floors, "code": route.code}
        if route.decision == "ask_user":
            approval_id = s.approvals.create_pending(**row)
            if self._auto_approve() and route.source != "fallback" and not profiles:
                # The user turned on always-approve: answer as they would with Share it, and
                # leave it out of dreaming. The leak check in _finish still runs. When the router
                # could not decide, nothing has judged this result, so the user still looks. A
                # compliance toggle turns it off too, and so does a floor that needs a person
                # (approvals.AUTO_APPROVE_SKIPS: a never-share topic in the request, ask first,
                # an identifier, a result going outside the class, a number with someone left out).
                if not needs_a_person(route.floors):
                    s.approvals.decide(approval_id, approve=True, remember=False, by="auto_approve")
                    self._audit("egress", "auto_approved")
                    return self._finish("shared", outgoing, approval_id, route, tagged, detail=job_id or tool)
                self._audit("egress", "auto_approve_skipped")
            return self._finish("waiting", WAITING_TEXT, approval_id, route, tagged, detail=str(approval_id))
        s.approvals.record_auto(**row)
        if route.decision == "refuse":
            return self._finish("refused", refusal_text(route.floors), None, route, tagged)
        return self._finish("shared", outgoing, None, route, tagged, detail=job_id or tool)

    def _cards_full(self, route: RouteDecision, profiles: Sequence[str]) -> bool:
        """Whether this ask would wait on a page already at the cap. Always approve answers it at
        once when it can, so that card never waits."""
        s = self.services
        cap = getattr(getattr(s, "settings", None), "max_pending", 0)
        if not cap or len(s.approvals.pending()) < cap:
            return False
        auto = self._auto_approve() and route.source != "fallback" and not profiles and not needs_a_person(route.floors)
        return not auto

    def _receipt(
        self, tagged: TagResult, route: RouteDecision, outgoing: str, profiles: Sequence[str], raw_kinds: Sequence[str],
        images: regions.ImageCheck | None = None,
    ) -> dict[str, Any]:
        """What the page and the audit export show for one result. Kinds and counts, never a value,
        a box or a pixel."""
        removed: dict[str, int] = {}
        for hit in tagged.hits:
            removed[hit.kind] = removed.get(hit.kind, 0) + 1
        settings = getattr(self.services, "settings", None)
        checked = images is not None and images.checked > 0
        extra: dict[str, Any] = {}
        if images is not None:
            # what SAM covered on the source images before the device read them, per kind
            extra = {"image_regions": dict(images.counts), "images_unchecked": images.unchecked}
        return {
            "removed": removed,
            "checks": [
                "tagging", *(["image check"] if checked else []), "name check", "router",
                *(["toggles"] if profiles else []), "final leak check",
            ],
            "floors": list(route.floors),
            "code": getattr(route, "code", "") or "",
            "decided_by": route.source,
            "model": getattr(settings, "router_model", None),
            "toggles": list(profiles),
            "device_only": bool(getattr(settings, "device_only", False)),
            "destination": DESTINATION,
            "request_had_private_detail": list(raw_kinds),
            "sha256": hashlib.sha256(outgoing.encode("utf-8")).hexdigest(),
            **extra,
        }

    def _auto_approve(self) -> bool:
        settings = getattr(self.services, "settings", None)
        paths = getattr(settings, "paths", None)
        return paths is not None and AutoApprove(paths.auto_approve).on

    def resolve(self, approval_id: int) -> Released:
        """The outcome for a decision row after the user answers (or while they have not)."""
        row = self.services.approvals.get(approval_id)
        try:
            sources = json.loads(row.get("sources") or "[]") if row else []
        except (TypeError, ValueError):
            sources = []
        token = _REDACTION.set(self._redaction_for(sources if isinstance(sources, list) else []))
        try:
            return self._resolve(approval_id, row)
        finally:
            _REDACTION.reset(token)

    def _resolve(self, approval_id: int, row: Any) -> Released:
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
            return list(self.guard.leaks(text, s.roster, s.tagmap, **self._red_kw()))
        except Exception as exc:
            log.warning("final leak check failed (%s); holding the result", type(exc).__name__)
            return [Hit("check_failed", "", 0, 0)]

    # Helpers

    def _neutralized(self, raw_text: str) -> str:
        """The raw result with tag-shaped document text ("[Student B]") as [Redacted N] tags
        (guard.neutralize_tags), so Muse never reads it as a real person's tag. Raises if the tag
        map cannot make one; the caller holds the result."""
        neutralize = getattr(self.guard, "neutralize_tags", None)
        tags = self._tags()
        if not callable(neutralize) or not hasattr(tags, "tag_for"):
            return raw_text
        return neutralize(raw_text, tags)

    def _tag(self, text: str, result_kind: str, synthetic: bool) -> TagResult:
        """guard.tag with the answer model's second pass for names the roster misses.

        The pass runs for every kind except NO_NAME_PASS. If it raises, so does this, and the
        caller holds the result.
        """
        s = self.services
        kw = self._red_kw()
        names_off = "redaction" in kw and not kw["redaction"].names  # the user's names-off folders
        return self.guard.tag(
            text,
            s.roster,
            self._tags(),
            llm_names=None if names_off else self._name_pass(result_kind, synthetic),
            never_share=s.policy.never_share,
            **kw,
        )

    def _tag_request(self, request: str) -> TagResult:
        """Muse's request with roster names, known values and identifiers tagged (no model call).
        Raises if tagging fails; the caller holds the result."""
        if not request:
            return TagResult(request or "")
        return self.guard.tag(request, self.services.roster, self._tags(), **self._red_kw())

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
        wider = self._profiles() and getattr(self._checker(), "llm_details", None)
        names = wider or getattr(self._checker(), "llm_names", None)
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
        if _RAW_REQUEST.get():
            text = f"{text}\n\n{RAW_REQUEST_NOTE}"
        if status == "shared":
            self._mark_sent(text)
            self._emit("sending", detail)  # the light plays one sweep, then shows the next state
            self._emit(self._resting_state(), detail)
        elif status == "waiting":
            self._emit("waiting", detail)
        return Released(status, text, approval_id, route, tagged)

    def _mark_sent(self, text: str) -> None:
        """Every tag in a shared text now counts as sent (TagMap.touch): Muse may send it back,
        and it restores until the grace window after its own day ends; this send does not extend it."""
        touch = getattr(getattr(self.services, "tagmap", None), "touch", None)
        if not callable(touch):
            return
        try:
            touch(guard_module.TAG_RE.findall(text))
        except Exception as exc:  # the text already passed every check; only the send time is lost
            log.warning("could not mark tags as sent: %s", type(exc).__name__)

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
        if _points_at_someone(tagged) and getattr(getattr(self.services, "settings", None), "device_only", False):
            # A local model often adds an example. Its sentences about the class are still
            # a class summary once the ones that name or describe someone are gone.
            kept = [p for p in re.split(r"(?<=[.!?])\s+", tagged) if p.strip() and not _points_at_someone(p)]
            tagged = " ".join(kept)
            if not kept:
                return None, "named"
        elif _points_at_someone(tagged):
            log.warning("summary named or singled out a student or person; not sharing it")
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
