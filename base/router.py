"""Privacy router: share_tagged, share_summary, ask_user or refuse for one result.

See docs/CONTRACTS.md (Router). Some results take a rule path with no model call. Everything
else is one strict-JSON question to Glimmer. Floors run after either path, so a model mistake
can only make the decision stricter, never looser.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from base.types import DECISIONS, IDENTIFIER_KINDS, STRICTNESS, Decision, RouteDecision, RouteInput, stricter

log = logging.getLogger(__name__)

TEXT_LIMIT = 1500
REQUEST_LIMIT = 500
REASON_LIMIT = 200
MAX_TOKENS = 1500

ROUTE_SCHEMA = {
    "name": "route",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "decision": {"type": "string", "enum": list(DECISIONS)},
            "reason": {"type": "string"},
        },
        "required": ["decision", "reason"],
        "additionalProperties": False,
    },
}

SYSTEM_PROMPT = """\
Reasoning strength: low

You are the privacy router on the user's own device. A cloud assistant asked for a result built \
from the user's private files. Names and identifiers are already replaced with tags like [Student A].
Pick one decision:
- share_tagged: send the tagged text as it is.
- share_summary: send only a class-level summary with no per-person detail.
- ask_user: hold the result and ask the user on the device first.
- refuse: keep the result on the device.
When unsure, pick ask_user. Never share anything that names a real person; tags are not names.
Reply with JSON {"decision": "...", "reason": "..."}. The reason is one short sentence with no \
names and no details from the text.

This user's rules, learned from their decisions:
"""

NO_RULES = "None yet."

RULE_KINDS: dict[str, str] = {
    "document_list": "Document titles only, already tagged.",
    "dreaming_report": "Aggregate numbers only.",
}

FALLBACK_REASON = "The router could not decide, so it asks you first."

IDENTIFIER_WORDS = {
    "phone": "a phone number",
    "email": "an email address",
    "ssn": "a Social Security number",
    "card": "a card number",
    "otp": "a one-time code",
    "student_id": "a student ID",
    "address": "a street address",
    "dob": "a date of birth",
}


def _scrub(text: str, secrets: list[str]) -> str:
    """Belt and braces: remove any real value that should already have been tagged."""
    for value in sorted(set(secrets), key=len, reverse=True):
        text = re.sub(re.escape(value), "[hidden]", text, flags=re.IGNORECASE)
    return text


def _clean_reason(value: Any) -> str:
    text = " ".join(str(value or "").split())
    return text[:REASON_LIMIT].rstrip()


def build_user_message(inp: RouteInput) -> str:
    """The RouteInput as the model sees it: kinds of hits, never their values."""
    secrets = [h.value for h in inp.hits if h.value and len(h.value) >= 3]
    kinds = sorted({h.kind for h in inp.hits})
    text = _scrub(inp.tagged_text or "", secrets)
    if len(text) > TEXT_LIMIT:
        text = text[:TEXT_LIMIT] + " [truncated]"
    request = _scrub(inp.request or "", secrets)[:REQUEST_LIMIT]
    return "\n".join(
        [
            f"Request: {request}",
            f"Result kind: {inp.result_kind}",
            f"Topics: {', '.join(inp.topics) or 'none'}",
            f"Blocked: {'; '.join(inp.blocked) or 'none'}",
            f"Found and tagged: {', '.join(kinds) or 'none'}",
            "Tagged text:",
            text,
        ]
    )


class Router:
    def __init__(self, settings: Any, llm: Any, policy: Any, rules_text: str | None = None, adapter: Any = None):
        self.settings = settings
        self.llm = llm
        self.policy = policy
        self.rules_text = rules_text
        self.adapter = adapter

    def rules(self) -> str:
        """Learned rules: the explicit rules_text if given, else the dreaming file if it exists."""
        if self.rules_text is not None:
            return self.rules_text.strip()
        paths = getattr(self.settings, "paths", None)
        path = getattr(paths, "router_prompt", None)
        try:
            if path is not None and path.is_file():
                return path.read_text().strip()
        except OSError:
            log.warning("could not read router rules file")
        return ""

    def system_prompt(self) -> str:
        return SYSTEM_PROMPT + (self.rules() or NO_RULES)

    def messages(self, inp: RouteInput) -> list[dict]:
        return [
            {"role": "system", "content": self.system_prompt()},
            {"role": "user", "content": build_user_message(inp)},
        ]

    def decide(self, inp: RouteInput, *, synthetic: bool = False) -> RouteDecision:
        start = time.perf_counter()
        blocked_topics = [t for t in inp.topics if t in self.policy.never_share]
        is_blocked = bool(inp.blocked or blocked_topics)

        outcome = self._rule_path(inp, is_blocked)
        if outcome is None:
            outcome = self._ask_model(inp, synthetic)
        decision, reason, source = outcome

        floor, floors, floor_reason = self._floors(inp, blocked_topics)
        final = stricter(decision, floor)
        if final != decision:
            reason = floor_reason
        ms = int((time.perf_counter() - start) * 1000)
        return RouteDecision(final, reason, source, latency_ms=ms, floors=floors)

    def _rule_path(self, inp: RouteInput, is_blocked: bool) -> tuple[Decision, str, str] | None:
        if inp.result_kind in RULE_KINDS:
            return "share_tagged", RULE_KINDS[inp.result_kind], "rule"
        if is_blocked:
            return None
        rule = self.policy.match({"request": inp.request, "result_kind": inp.result_kind, "topics": inp.topics})
        if rule.pre_approved:
            return rule.wants, f"Pre-approved by your rule {rule.id}.", "rule"
        return None

    def _ask_model(self, inp: RouteInput, synthetic: bool) -> tuple[Decision, str, str]:
        kw: dict[str, Any] = {"reasoning": "low", "max_tokens": MAX_TOKENS, "synthetic": synthetic}
        if self.adapter is not None:
            kw["adapter"] = self.adapter
        try:
            out = self.llm.chat_json(self.messages(inp), ROUTE_SCHEMA, **kw)
        except Exception as exc:  # any model or parse failure falls back to asking
            log.warning("router model call failed: %s", type(exc).__name__)
            return "ask_user", FALLBACK_REASON, "fallback"
        decision = out.get("decision") if isinstance(out, dict) else None
        if decision not in DECISIONS:
            log.warning("router model returned no valid decision")
            return "ask_user", FALLBACK_REASON, "fallback"
        return decision, _clean_reason(out.get("reason")) or "No reason given.", "model"

    def _floors(self, inp: RouteInput, blocked_topics: list[str]) -> tuple[Decision, list[str], str]:
        """The strictest floor that applies, every floor that fired, and the reason for the strictest."""
        floor: Decision = "share_tagged"
        floors: list[str] = []
        reason = ""

        if inp.blocked or blocked_topics:
            ask_first = self.policy.ask_first
            # ask_first relaxes the floor only when every blocked reason maps to an ask_first topic
            can_ask = bool(blocked_topics) and set(blocked_topics) <= ask_first and len(inp.blocked) <= len(blocked_topics)
            label = "ask_first" if can_ask else "blocked"
            if blocked_topics:
                floors.extend(f"{label}:{t}" for t in blocked_topics)
            else:
                floors.append(label)
            floor = "ask_user" if can_ask else "refuse"
            reason = "; ".join(r.rstrip(".") for r in inp.blocked) or "Mentions a topic you never share"
            reason += ". You asked to be asked first." if can_ask else "."

        found = sorted({h.kind for h in inp.hits if h.kind in IDENTIFIER_KINDS})
        if found:
            floors.extend(f"identifier:{k}" for k in found)
            if STRICTNESS["ask_user"] > STRICTNESS[floor]:
                floor = "ask_user"
                reason = "Contains " + ", ".join(IDENTIFIER_WORDS.get(k, k) for k in found) + "."
        return floor, floors, reason
