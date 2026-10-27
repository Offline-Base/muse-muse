"""Privacy router: share_tagged, share_summary, ask_user or refuse for one result.

See docs/CONTRACTS.md (Router). Some results take a rule path with no model call. Everything
else is one strict-JSON question to Glimmer. Floors run after either path, so a model mistake
can only make the decision stricter, never looser.

Learned rules (the dreaming file) are read back here: the one rule that fits a result is shown
to the model, and the strictest learned "ask first" or "refuse" rule that holds for it is a floor
(train.learned_floor), so neither the model nor a topic Muse's request adds can loosen what the
user asked for. When that floor comes from another rule, the model is shown it too.
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Collection, Sequence
from typing import Any, NamedTuple

from base import guard
from base.dreaming import train as learned_rules
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

How to decide, first match wins:
1. refuse when the request asks who a tag really is (real or full names, unmasking), or narrows \
the class down to a few students by a personal trait or a one-time event only they share, even \
for an average.
2. ask_user when the result is meant for anyone outside the class (families, a newsletter, other \
staff, the district, a club), or is a student's whole essay.
3. When a learned rule for this result is shown, follow it. When a learned rule that also holds \
is shown too, it is the stricter one: follow it (a rule for fewer topics still holds for a result \
with more).
4. share_summary for class-level counts, averages, distributions and patterns.
5. ask_user for per-student detail (scores, feedback, excerpts, attendance, groups) that no \
learned rule covers.
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
UNKNOWN_PERSON_REASON = "A title or file name names someone who is not on the roster."
POLICY_REASON = "Your rule {id} says results like this stay on the device."
DIGITS_REASON = "Contains a long number that could be an identifier."
REQUEST_TOPIC_REASON = "The request mentions a topic you never share, so you decide."

# Kinds made of the device's own aggregate numbers, where a long number is not an identifier.
NUMBER_KINDS = frozenset({"class_aggregate", "dreaming_report"})

LEARNED_REASONS = {
    ("refuse", "user"): "You said not to share results like this.",
    ("ask_user", "user"): "You asked to be asked first about results like this.",
    ("refuse", "synthetic"): "Results like this stay on the device by default.",
    ("ask_user", "synthetic"): "Results like this need your OK by default.",
}

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


def never_share_floor(
    blocked: Sequence[str], blocked_topics: Sequence[str], ask_first: Collection[str]
) -> Decision | None:
    """The never-share floor: None when nothing is blocked, ask_user when every blocked reason
    maps to an ask_first topic, else refuse. Egress uses it too, to skip a pass it makes moot."""
    if not (blocked or blocked_topics):
        return None
    can_ask = bool(blocked_topics) and set(blocked_topics) <= set(ask_first) and len(blocked) <= len(blocked_topics)
    return "ask_user" if can_ask else "refuse"


class LearnedView(NamedTuple):
    """Everything the learned rules add to one decision: the rule line shown with the result
    and the rule behind the learned floor (with its decision and section). Hashable, so the
    gate can compare two rule files item by item."""

    shown: str | None
    floor: str | None
    floor_decision: str | None
    floor_source: str | None


def build_user_message(inp: RouteInput, learned: str | None = None, also: str | None = None) -> str:
    """The RouteInput as the model sees it: kinds of hits, never their values, the learned rule
    that fits it (`learned`, a rule line), if any, and the stricter one behind the learned floor
when that is another rule (`also`)."""
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
            f"Learned rule for this result: {(learned or 'none').removeprefix('- ')}",
            *([f"Learned rule that also holds: {also.removeprefix('- ')}"] if also else []),
            "Tagged text:",
            text,
        ]
    )


class Router:
    def __init__(
        self, settings: Any, llm: Any, policy: Any, rules_text: str | None = None, adapter: Any = None
    ):
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

    def learned(self, inp: RouteInput, rules: str | None = None):
        """(the learned rule shown with this result, the learned rule behind its floor), each a
        train.RuleLine or None."""
        rules = self.rules() if rules is None else rules
        if not rules:
            return None, None
        lines = learned_rules.read_rules(rules)
        key = learned_rules.rule_key(inp.result_kind, inp.topics, learned_rules.relevant_topics(self.policy))
        return learned_rules.match_rule(lines, *key), learned_rules.learned_floor(lines, *key)

    def learned_rule(self, inp: RouteInput, rules: str | None = None):
        """The learned rule shown with this result (a train.RuleLine), or None."""
        return self.learned(inp, rules)[0]

    def learned_view(self, inp: RouteInput, rules_text: str | None = None) -> LearnedView:
        """What a rules file (default: this router's own) adds to the decision for `inp`."""
        shown, floor = self.learned(inp, rules_text)
        return LearnedView(
            getattr(shown, "text", None),
            getattr(floor, "text", None),
            getattr(floor, "decision", None),
            getattr(floor, "source", None),
        )

    def messages(self, inp: RouteInput, learned=None, floor=None) -> list[dict]:
        shown = getattr(learned, "text", None)
        also = getattr(floor, "text", None)
        return [
            {"role": "system", "content": self.system_prompt()},
            {"role": "user", "content": build_user_message(inp, shown, also if also != shown else None)},
        ]

    def decide(self, inp: RouteInput, *, synthetic: bool = False) -> RouteDecision:
        start = time.perf_counter()
        request_only = set(inp.request_blocked)
        blocked_topics = [t for t in inp.topics if t in self.policy.never_share and t not in request_only]
        is_blocked = bool(inp.blocked or blocked_topics)
        learned, learned_floor = self.learned(inp)

        outcome = self._rule_path(inp, is_blocked)
        if outcome is None:
            outcome = self._ask_model(inp, synthetic, learned, learned_floor)
        decision, reason, source = outcome

        floor, floors, floor_reason = self._floors(inp, blocked_topics, learned_floor)
        final = stricter(decision, floor)
        if floor_reason and STRICTNESS[floor] >= STRICTNESS[final]:
            reason = floor_reason  # the floor decided it, whatever the model said
        ms = int((time.perf_counter() - start) * 1000)
        return RouteDecision(final, reason, source, latency_ms=ms, floors=floors)

    def _rule_path(self, inp: RouteInput, is_blocked: bool) -> tuple[Decision, str, str] | None:
        if inp.result_kind == "document_list" and any(h.kind == "person" for h in inp.hits):
            # The name pass found someone the roster does not know: a title can say more than
            # a name, so the user looks first.
            return "ask_user", UNKNOWN_PERSON_REASON, "rule"
        if inp.result_kind in RULE_KINDS:
            return "share_tagged", RULE_KINDS[inp.result_kind], "rule"
        if is_blocked:
            return None
        rule = self.policy.match(
            {"request": inp.request, "result_kind": inp.result_kind, "topics": inp.topics}
        )
        if rule.pre_approved:
            return rule.wants, f"Pre-approved by your rule {rule.id}.", "rule"
        return None

    def _refuse_rules(self, inp: RouteInput) -> list:
        """Every policy rule that wants refuse and matches this request, kind and topics."""
        rules = getattr(self.policy, "rules", None) or ()
        return [
            r
            for r in rules
            if getattr(r, "wants", None) == "refuse"
            and r.matches(inp.request or "", inp.result_kind, inp.topics)
            # a rule over never-share topics only is already the "blocked" floor
            and not (r.topics_any and set(r.topics_any) <= set(self.policy.never_share))
        ]

    def _ask_model(
        self, inp: RouteInput, synthetic: bool, learned=None, learned_floor=None
    ) -> tuple[Decision, str, str]:
        kw: dict[str, Any] = {"reasoning": "low", "max_tokens": MAX_TOKENS, "synthetic": synthetic}
        if self.adapter is not None:
            kw["adapter"] = self.adapter
        try:
            out = self.llm.chat_json(self.messages(inp, learned, learned_floor), ROUTE_SCHEMA, **kw)
        except Exception as exc:  # any model or parse failure falls back to asking
            log.warning("router model call failed: %s", type(exc).__name__)
            return "ask_user", FALLBACK_REASON, "fallback"
        decision = out.get("decision") if isinstance(out, dict) else None
        if decision not in DECISIONS:
            log.warning("router model returned no valid decision")
            return "ask_user", FALLBACK_REASON, "fallback"
        return decision, _clean_reason(out.get("reason")) or "No reason given.", "model"

    def _floors(
        self, inp: RouteInput, blocked_topics: list[str], learned=None
    ) -> tuple[Decision, list[str], str]:
        """The strictest floor that applies, every floor that fired, and the reason for the strictest.

        `learned` is the rule behind the learned floor (train.learned_floor), not the shown rule.
        """
        floor: Decision = "share_tagged"
        floors: list[str] = []
        reason = ""

        blocked_floor = never_share_floor(inp.blocked, blocked_topics, self.policy.ask_first)
        if blocked_floor is not None:
            # ask_first relaxes the floor only when every blocked reason maps to an ask_first topic
            can_ask = blocked_floor == "ask_user"
            label = "ask_first" if can_ask else "blocked"
            if blocked_topics:
                floors.extend(f"{label}:{t}" for t in blocked_topics)
            else:
                floors.append(label)
            floor = blocked_floor
            reason = "; ".join(r.rstrip(".") for r in inp.blocked) or "Mentions a topic you never share"
            reason += ". You asked to be asked first." if can_ask else "."

        # A never-share word only in Muse's request ("Do not mention any IEP") may be a caution,
        # not a question about the topic, so the user decides instead of a silent refusal.
        if inp.request_blocked:
            floors.extend(f"request:{t}" for t in inp.request_blocked)
            if STRICTNESS["ask_user"] > STRICTNESS[floor]:
                floor, reason = "ask_user", REQUEST_TOPIC_REASON

        found = sorted({h.kind for h in inp.hits if h.kind in IDENTIFIER_KINDS})
        if found:
            floors.extend(f"identifier:{k}" for k in found)
            if STRICTNESS["ask_user"] > STRICTNESS[floor]:
                floor = "ask_user"
                reason = "Contains " + ", ".join(IDENTIFIER_WORDS.get(k, k) for k in found) + "."
        elif inp.result_kind not in NUMBER_KINDS and guard.long_digit_runs(inp.tagged_text or ""):
            # A number in a format no exact check knows (a case number, an ITIN with odd spacing).
            floors.append("identifier:digits")
            if STRICTNESS["ask_user"] > STRICTNESS[floor]:
                floor, reason = "ask_user", DIGITS_REASON

        # The user's own refuse rules hold in code, not only as words in the prompt: a request to
        # unmask a tag, say, is refused whatever the model answers.
        for rule in self._refuse_rules(inp):
            floors.append(f"policy:{rule.id}")
            if STRICTNESS["refuse"] > STRICTNESS[floor]:
                floor, reason = "refuse", POLICY_REASON.format(id=rule.id)

        # The strictest learned "ask first" or "refuse" rule that holds is a floor; a learned share
        # rule never loosens one, and neither does a topic the request adds.
        wanted = getattr(learned, "decision", None)
        if wanted in ("ask_user", "refuse"):
            floors.append(f"learned:{wanted}")
            if STRICTNESS[wanted] > STRICTNESS[floor]:
                floor = wanted
                reason = LEARNED_REASONS[(wanted, "user" if learned.source == "user" else "synthetic")]
        return floor, floors, reason
