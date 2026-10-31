"""Privacy router: share_tagged, share_summary, ask_user or refuse for one result.

See docs/CONTRACTS.md (Router). Some results take a rule path with no model call. Everything
else is one strict-JSON question to the router model. With DEVICE_ONLY=1 the user picks how much
that answer counts (routing_mode): rules asks no model at all. Floors run after either path, so a model mistake
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
OUTSIDE_REASON = "The request says this is going outside the class, so you decide."
LEFT_OUT_REASON = "This number leaves someone out, so comparing answers could show theirs. You decide."
TAUGHT_LIST_REASON = "You said to share document lists like this without asking."

# With DEVICE_ONLY=1 and LFM the user's policy decides, not the model. In a test on Oct 29 the 2B
# model shared summaries of per-student grades and a newsletter quote, and on Oct 30 it agreed with
# the eval's labels 38 times in 100 (eval/reports/device_only_lfm.md). The model still labels who
# a request is for; these patterns check its labels and catch a destination it misses.
_OUTSIDE = re.compile(
    r"\b(?:famil(?:y|ies)|parents?|guardians?|newsletters?|principal|district|superintendent|counselor|"
    r"club|board|staff|colleagues?|another teacher|website|social media|post(?:ed|ing)? (?:it|this|on)|"
    r"publish|press|flyer|send (?:it |this )?to|email (?:it |this )?to|forward (?:it |this )?to|"
    r"pta|pto|yearbook|specialists?|judges|(?:at|for) the assembly|school assembly|tweet(?:s|ed|ing)?|"
    r"grant (?:application|proposal|report)|newspapers?|(?:local|school|town|city) paper|other (?:[\w-]+ )?teachers|"
    r"send(?:ing)? (?:it |this |them )?home|sent home|take (?:it |this )?home|(?:letter|note|report) home)\b",
    re.IGNORECASE,
)
_CLASS_LEVEL = re.compile(
    r"\b(?:average|mean|median|range|distribution|how many|counts?|percent(?:age)?|most common|most often|"
    r"across the class|the class(?:'s)?|summari[sz]e)\b",
    re.IGNORECASE,
)
# A group number with one person or small group left out: two answers subtract to that one's number.
_LEFT_OUT = re.compile(
    r"\b(?:excluding|excludes?|without|except(?: for)?|all but|apart from|aside from|other than|not counting|"
    r"leaving out|leave out|minus)\s+(?:\[(?:Student [A-Z]{1,3}|Person \d+)\]|the (?:\[[^\]]+\]|[\w-]+) (?:group|table|team|pod)\b)",
    re.IGNORECASE,
)
_WHOLE_TEXT = re.compile(r"\b(?:full|whole|entire|complete|word for word|verbatim)\b", re.IGNORECASE)
_TAGGED_PERSON = re.compile(r"\[(?:Student [A-Z]{1,3}|Person \d+)\]")
_WRITING_WORDS = re.compile(r"\b(?:essays?|excerpts?|writing|feedback|paragraph|praise|spelling|reasons?)\b", re.IGNORECASE)
_GRADE_WORDS = re.compile(
    r"\b(?:scores?|scored|grades?|grader|rubric|criterion|criteria|conventions|ideas|organization|evidence)\b", re.IGNORECASE
)
# ROUTER_LOOSEN=result_words: topic words read from the tagged result on the device (never sent).
# A score in the result, or class-wide numbers in a result that names nobody.
_SCORE_RESULT = re.compile(r"\b(?:scored|points|pts|rubric|out of \d+)\b|\b\d{1,3} ?/ ?\d{1,3}\b(?! ?/)", re.IGNORECASE)
_AGGREGATE_RESULT = re.compile(
    r"\b(?:averages?|averaged|median|distribution|percent(?:age)?|range of|ranged from|"
    r"(?:\d+|most|half|all|none) of (?:the )?(?:\d+ )?(?:class|students))\b|\d ?%",
    re.IGNORECASE,
)
# ROUTER_LOOSEN=class_of: "[Student A]'s class" asks about the class, not about one student.
_CLASS_OF_PERSON = re.compile(r"\[(?:Student [A-Z]{1,3}|Person \d+)\]['’]s (?:class|group)\b", re.IGNORECASE)


LEARNING_MODES = ("rules", "tighten", "decide", "local_lora")


def loosened(settings: Any, choice: str) -> bool:
    """Whether ROUTER_LOOSEN turned on `choice` (base.config.ROUTER_LOOSEN_CHOICES)."""
    return choice in (getattr(settings, "router_loosen", None) or ())


def routing_mode(settings: Any, choice: str = "") -> str:
    """How the router decides. "model": the model answers (not device-only). With DEVICE_ONLY=1,
    the user's choice on the Dreaming page, else DREAMING_BACKEND and ROUTER_TRUST:
    rules (policy and learned rules in code), tighten (the model can only make that stricter),
    decide (the model's answer, under the floors), local_lora (decide, with the adapter)."""
    if not getattr(settings, "device_only", False):
        return "model"
    if choice in LEARNING_MODES:
        return "rules" if choice == "local_lora" and getattr(settings, "primary_model", "") == "lfm" else choice
    backend = getattr(settings, "dreaming_backend", "rules")
    if backend == "rules":
        return "rules"
    return "local_lora" if backend == "local_lora" else getattr(settings, "router_trust", "tighten")


def _taught_by_user(rule: Any) -> bool:
    return getattr(rule, "source", None) == "user" and getattr(rule, "decision", None) in DECISIONS


def lfm_labels(settings: Any) -> bool:
    """DEVICE_ONLY=1 with LFM labeling Muse's requests (CHECKER_BACKEND=lfm, also when Glimmer is
    plugged in as the main model): its labels are checked against the request's own words, so
    every router configuration routes on the same labels."""
    return getattr(settings, "device_only", False) and getattr(settings, "checker_backend", "") == "lfm"


def checked_labels(request: str, labels: Collection[str], *, class_of: bool = False) -> list[str]:
    """The local model's request labels, checked against the request's own words: a whole text must
    be asked for, and a question about one tagged person is not class-level. Never-share labels and
    who-it-is-for labels stay, since they only make a decision stricter. With `class_of`
    (ROUTER_LOOSEN=class_of), "[Student A]'s class" or "'s group" does not count as one person."""
    out = [t for t in labels if not (t == "full_text" and not _WHOLE_TEXT.search(request or ""))]
    asked = _CLASS_OF_PERSON.sub("", request or "") if class_of else request or ""
    person = bool(_TAGGED_PERSON.search(asked))
    if person:
        out = [t for t in out if t != "class_level"]
    elif _CLASS_LEVEL.search(request or "") and "class_level" not in out:
        out.append("class_level")
    return out


def result_topics(tagged_text: str) -> list[str]:
    """Topic words the tagged result itself gives (ROUTER_LOOSEN=result_words), for the policy
    match only: grades for a score, class_level for class-wide numbers in a result that names
    nobody. The caller skips this when the request or the result has an ask word (attendance)."""
    text = tagged_text or ""
    out = ["grades"] if _SCORE_RESULT.search(text) else []
    if not _TAGGED_PERSON.search(text) and _AGGREGATE_RESULT.search(text):
        out.append("class_level")
    return out


# A contact detail, or one person picked out by what makes them unique: refused, not asked.
_CONTACT = re.compile(
    r"\b(?:(?:home|family|parent|guardian|emergency)\s+(?:contact|phone|number)|contact\s+(?:card|info|information|details)|"
    r"how\s+to\s+reach|where\s+\S+(?:\s+\S+)?\s+lives?|home\s+address|delivered\s+to)\b",
    re.IGNORECASE,
)
_NARROWED = re.compile(r"\b(?:the only (?:\w+ )?(?:student|kid|child|one|person|patient)|only (?:one|student) who)\b", re.IGNORECASE)
# What the excerpts and grades rule must not pick up from a stray word like "essay" or "writing".
_ASK_WORDS = re.compile(r"\b(?:absen\w+|attendance|tard\w+|seat(?:s|ing)?|sits?|reading groups?|lunch|behaviou?r)\b", re.IGNORECASE)
CONTACT_REASON = "This asks for someone's contact details, so it stays on the device."
NARROWED_REASON = "This could point to one person, so it stays on the device."
SENSITIVE_REASON = "This is a sensitive record, so it stays on the device."

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


def model_usage(llm: Any) -> dict[str, Any]:
    """RouteDecision's usage fields from the client's last call (LocalLLM.last_result): one call
    and no token counts for a client that keeps none."""
    last = getattr(llm, "last_result", None)
    calls = getattr(last, "calls", None)
    if last is None or not isinstance(calls, int):
        return {"calls": 1}
    return {
        "calls": calls,
        "prompt_tokens": last.prompt_tokens,
        "completion_tokens": last.completion_tokens,
        "reasoning_tokens": last.reasoning_tokens,
        "finish_reason": last.finish_reason,
    }


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
        self.choice: Any = None  # returns the user's choice on the Dreaming page (base/services.py)

    def mode(self, inp: RouteInput | None = None) -> str:
        chosen = self.choice() if callable(self.choice) else ""
        mode = routing_mode(self.settings, chosen)
        if inp is not None and inp.strict and mode in ("decide", "local_lora"):
            return "tighten"  # a compliance toggle: no model can loosen the policy, tuned or not
        return mode

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

    def reasoning(self) -> str:
        """Glimmer's reasoning strength for the router's call (ROUTER_REASONING, default low)."""
        return getattr(self.settings, "router_reasoning", None) or "low"

    def max_tokens(self) -> int:
        """The router call's token budget, reasoning included (ROUTER_MAX_TOKENS, default 1500)."""
        return getattr(self.settings, "router_max_tokens", None) or MAX_TOKENS

    def system_prompt(self) -> str:
        """The prompt with its `Reasoning strength:` line at the chosen level, so the text and
        llama-server's chat_template_kwargs agree."""
        prompt = SYSTEM_PROMPT.replace("Reasoning strength: low", f"Reasoning strength: {self.reasoning()}", 1)
        return prompt + (self.rules() or NO_RULES)

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

        mode = self.mode(inp)
        outcome = self._rule_path(inp, is_blocked, learned)
        by_policy = outcome is None and mode != "model"
        usage: dict[str, Any] = {}
        if outcome is None:
            outcome = self._decide_by_mode(mode, inp, synthetic, learned, learned_floor, usage)
        decision, reason, source, code = outcome

        floor, floors, floor_reason, floor_code = self._floors(inp, blocked_topics, learned_floor)
        if by_policy:
            floor, floors, floor_reason, floor_code = self._policy_floors(
                inp, learned, floor, floors, floor_reason, floor_code
            )
        final = stricter(decision, floor)
        if floor_reason and STRICTNESS[floor] >= STRICTNESS[final]:
            reason, code = floor_reason, floor_code  # the floor decided it, whatever the model said
        ms = int((time.perf_counter() - start) * 1000)
        return RouteDecision(final, reason, source, latency_ms=ms, floors=floors, code=code, **usage)

    def _decide_by_mode(
        self, mode: str, inp: RouteInput, synthetic: bool, learned: Any, learned_floor: Any, usage: dict | None = None
    ) -> tuple[Decision, str, str, str]:
        if mode == "rules":
            return self._policy_path(inp, learned)
        asked = self._ask_model(
            inp, synthetic, learned, learned_floor, use_adapter=mode in ("model", "local_lora"), usage=usage
        )
        asked = (*asked, "fallback" if asked[2] == "fallback" else "model")
        if mode != "tighten":
            return asked
        base = self._policy_path(inp, learned)
        if asked[2] == "fallback":  # nothing judged it: keep the mark, so Always approve can't answer
            return stricter(base[0], asked[0]), asked[1], "fallback", "fallback"
        return asked if STRICTNESS[asked[0]] > STRICTNESS[base[0]] else base

    def _policy_path(self, inp: RouteInput, learned: Any) -> tuple[Decision, str, str, str]:
        """The rule the user taught for results like this, else the first policy rule that matches.
        Practice defaults come from invented data, so they never stand in for the user's policy."""
        if _taught_by_user(learned):
            return learned.decision, "You decided this before for results like this.", "rule", f"learned:{learned.decision}"
        topics, kind = list(inp.topics), inp.result_kind
        request, text = inp.request or "", inp.tagged_text or ""
        if not _ASK_WORDS.search(request):
            if _WRITING_WORDS.search(request):
                topics.append("writing")
            if _GRADE_WORDS.search(request):
                topics.append("grades")
            if loosened(self.settings, "result_words") and not _ASK_WORDS.search(text):
                topics += result_topics(text)
        if "class_level" in topics and kind in ("snippet", "free_text", "per_student"):
            kind = "class_aggregate"  # the request asks for numbers or patterns, not for one person
        rule = self.policy.match({"request": inp.request, "result_kind": kind, "topics": topics})
        code = "policy_default" if rule.id == "default" else f"policy_rule:{rule.id}"
        return rule.wants, f"Your rule {rule.id} covers results like this.", "rule", code

    def _policy_floors(
        self, inp: RouteInput, learned: Any, floor: Decision, floors: list[str], reason: str, code: str
    ) -> tuple[Decision, list[str], str, str]:
        """A sensitive record stays on the device, and the user sees what is going outside the class
        unless they taught a rule that shares results like this."""
        if inp.result_kind == "sensitive_record":
            return "refuse", [*floors, "sensitive_record"], SENSITIVE_REASON, "sensitive_record"
        if _CONTACT.search(inp.request or ""):
            return "refuse", [*floors, "contact"], CONTACT_REASON, "contact"
        if _NARROWED.search(inp.request or ""):
            return "refuse", [*floors, "narrowed"], NARROWED_REASON, "narrowed"
        request = inp.request or ""
        if (
            STRICTNESS[floor] < STRICTNESS["ask_user"]  # no rule you taught lifts this: it is about the subtraction
            and _LEFT_OUT.search(request)
            and (inp.result_kind == "class_aggregate" or _CLASS_LEVEL.search(request))
        ):
            return "ask_user", [*floors, "left_out"], LEFT_OUT_REASON, "left_out"
        taught = _taught_by_user(learned) and learned.decision in ("share_tagged", "share_summary")
        if not taught and STRICTNESS[floor] < STRICTNESS["ask_user"] and _OUTSIDE.search(request):
            return "ask_user", [*floors, "outside_class"], OUTSIDE_REASON, "outside_class"
        return floor, floors, reason, code

    def _rule_path(
        self, inp: RouteInput, is_blocked: bool, learned: Any = None
    ) -> tuple[Decision, str, str, str] | None:
        if inp.result_kind == "document_list" and any(h.kind == "person" for h in inp.hits):
            # The name pass found someone the roster does not know: a title can say more than
            # a name, so the user looks first, unless they taught a rule that shares lists like
            # this (ROUTER_LOOSEN=lists). Names stay tagged, and the floors still run.
            taught = (
                loosened(self.settings, "lists")
                and _taught_by_user(learned)
                and learned.kind == "document_list"
                and learned.decision == "share_tagged"
            )
            if taught:
                return "share_tagged", TAUGHT_LIST_REASON, "rule", "learned:share_tagged"
            return "ask_user", UNKNOWN_PERSON_REASON, "rule", "unknown_person_title"
        if inp.result_kind in RULE_KINDS:
            return "share_tagged", RULE_KINDS[inp.result_kind], "rule", "rule_kind"
        if is_blocked:
            return None
        rule = self.policy.match(
            {"request": inp.request, "result_kind": inp.result_kind, "topics": inp.topics}
        )
        if rule.pre_approved:
            return rule.wants, f"Pre-approved by your rule {rule.id}.", "rule", "pre_approved"
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
        self, inp: RouteInput, synthetic: bool, learned=None, learned_floor=None, use_adapter: bool = True,
        usage: dict | None = None,
    ) -> tuple[Decision, str, str]:
        kw: dict[str, Any] = {"reasoning": self.reasoning(), "max_tokens": self.max_tokens(), "synthetic": synthetic}
        if self.adapter is not None and use_adapter:
            kw["adapter"] = self.adapter
        try:
            out = self.llm.chat_json(self.messages(inp, learned, learned_floor), ROUTE_SCHEMA, **kw)
        except Exception as exc:  # any model or parse failure falls back to asking
            log.warning("router model call failed: %s", type(exc).__name__)
            return "ask_user", FALLBACK_REASON, "fallback"
        finally:
            if usage is not None:
                usage.update(model_usage(self.llm))
        decision = out.get("decision") if isinstance(out, dict) else None
        if decision not in DECISIONS:
            log.warning("router model returned no valid decision")
            return "ask_user", FALLBACK_REASON, "fallback"
        return decision, _clean_reason(out.get("reason")) or "No reason given.", "model"

    def _floors(
        self, inp: RouteInput, blocked_topics: list[str], learned=None
    ) -> tuple[Decision, list[str], str, str]:
        """The strictest floor that applies, every floor that fired, and the reason and code for
        the strictest.

        `learned` is the rule behind the learned floor (train.learned_floor), not the shown rule.
        """
        floor: Decision = "share_tagged"
        floors: list[str] = []
        reason = code = ""

        blocked_floor = never_share_floor(inp.blocked, blocked_topics, self.policy.ask_first)
        if blocked_floor is not None:
            # ask_first relaxes the floor only when every blocked reason maps to an ask_first topic
            can_ask = blocked_floor == "ask_user"
            label = "ask_first" if can_ask else "blocked"
            if blocked_topics:
                floors.extend(f"{label}:{t}" for t in blocked_topics)
            else:
                floors.append(label)
            floor, code = blocked_floor, floors[0]
            reason = "; ".join(r.rstrip(".") for r in inp.blocked) or "Mentions a topic you never share"
            reason += ". You asked to be asked first." if can_ask else "."

        # A never-share word only in Muse's request ("Do not mention any IEP") may be a caution,
        # not a question about the topic, so the user decides instead of a silent refusal.
        if inp.request_blocked:
            floors.extend(f"request:{t}" for t in inp.request_blocked)
            if STRICTNESS["ask_user"] > STRICTNESS[floor]:
                floor, reason, code = "ask_user", REQUEST_TOPIC_REASON, f"request_topic:{inp.request_blocked[0]}"

        found = sorted({h.kind for h in inp.hits if h.kind in IDENTIFIER_KINDS})
        if found:
            floors.extend(f"identifier:{k}" for k in found)
            if STRICTNESS["ask_user"] > STRICTNESS[floor]:
                floor, code = "ask_user", f"identifier:{found[0]}"
                reason = "Contains " + ", ".join(IDENTIFIER_WORDS.get(k, k) for k in found) + "."
        elif inp.result_kind not in NUMBER_KINDS and guard.long_digit_runs(inp.tagged_text or ""):
            # A number in a format no exact check knows (a case number, an ITIN with odd spacing).
            floors.append("identifier:digits")
            if STRICTNESS["ask_user"] > STRICTNESS[floor]:
                floor, reason, code = "ask_user", DIGITS_REASON, "identifier:digits"

        # The user's own refuse rules hold in code, not only as words in the prompt: a request to
        # unmask a tag, say, is refused whatever the model answers.
        for rule in self._refuse_rules(inp):
            floors.append(f"policy:{rule.id}")
            if STRICTNESS["refuse"] > STRICTNESS[floor]:
                floor, reason, code = "refuse", POLICY_REASON.format(id=rule.id), f"policy_rule:{rule.id}"

        # The strictest learned "ask first" or "refuse" rule that holds is a floor; a learned share
        # rule never loosens one, and neither does a topic the request adds.
        wanted = getattr(learned, "decision", None)
        if wanted in ("ask_user", "refuse"):
            floors.append(f"learned:{wanted}")
            if STRICTNESS[wanted] > STRICTNESS[floor]:
                section = "user" if learned.source == "user" else "synthetic"
                floor, reason = wanted, LEARNED_REASONS[(wanted, section)]
                code = f"learned:{wanted}" if section == "user" else f"practice:{wanted}"
        return floor, floors, reason, code
