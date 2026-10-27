"""Nightly training for the privacy router.

prompt backend (default): turn the user's decisions into short plain rules with exact counts and
write them to the router's rules file. Deterministic, and rebuilt from scratch every night from
the current decision log (yesterday's file is never read), so deleted decisions drop out.

Given the user's policy, a rule's group is the result kind plus only the topics the policy names
(so "grades, reading" and "grades" share a rule), and a topic whose decisions all say ask first
or refuse also gets a rule of its own that holds for any kind. A never-share topic in the result
itself is refused by the floor without asking, so a group with one gets no rule from practice
data; the user is asked only when Muse's request alone names one, and those answers can become
ask first or refuse rules (never share rules: that floor asks whatever a rule says). The router
reads the file back with read_rules() and match_rule() and shows the model the one rule that fits.
learned_floor() gives the strictest "ask first" or "refuse" rule that still holds for a result,
so a topic Muse's request adds can move a result to a narrower group but never out from under a
broader rule.

lora backend: write a chat-format training JSONL into the adapters folder. Training itself runs
in the cloud with scripts/cloud/train_lora_modal.py; nothing is trained on this machine.
"""

from __future__ import annotations

import json
import logging
import os
import re
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from base.dreaming.dataset import Example
from base.types import DECISIONS, STRICTNESS, RouteInput

log = logging.getLogger(__name__)

MIN_DECISIONS = 2
MIN_AGREEMENT = 0.8
MIN_TOPIC_DECISIONS = 3  # a rule for one topic across every kind needs a little more evidence
TOPIC_RULE_DECISIONS = ("ask_user", "refuse")  # a topic is a reason for care, never for sharing
FLOOR_DECISIONS = ("ask_user", "refuse")  # learned rules that hold as floors in the router

KIND_NAMES = {
    "document_list": "Document lists",
    "snippet": "Document snippets",
    "per_student": "Per-student results",
    "class_aggregate": "Class-wide results",
    "contact_info": "Contact details",
    "sensitive_record": "Sensitive records",
    "free_text": "Free-text answers",
    "dreaming_report": "Dreaming reports",
}
DECISION_WORDS = {
    "share_tagged": "share tagged",
    "share_summary": "share a summary",
    "ask_user": "ask first",
    "refuse": "refuse",
}
WORD_DECISIONS = {v: k for k, v in DECISION_WORDS.items()}

LORA_CLOUD_SCRIPT = "scripts/cloud/train_lora_modal.py"
WITHHELD_TEXT = "(text kept on the device)"

_FALLBACK_SYSTEM_PROMPT = (
    "Reasoning strength: low\n"
    "You are the privacy router on a teacher's device. Decide what may leave for Muse: "
    "share_tagged, share_summary, ask_user or refuse. Answer as JSON with decision and reason."
)

_RULE_LINE = re.compile(
    r"^- .*?\(kind: (?P<kind>[a-z_]+); topics: (?P<topics>[^)]*)\): (?P<words>[a-z ]+?)\."
)
_TOPIC_LINE = re.compile(r"^- .*?\(topic: (?P<topic>[a-z_]+)\): (?P<words>[a-z ]+?)\.")
PRACTICE_HEADING = "## Practice defaults"


@dataclass
class TrainResult:
    backend: str
    path: Path | None
    rules: int
    examples: int
    user_examples: int
    cloud_required: bool = False
    message: str = ""


@dataclass(frozen=True)
class Rule:
    result_kind: str | None  # None for a topic rule, which holds for any kind
    topics: tuple[str, ...]  # a topic rule has exactly one
    decision: str
    count: int  # decisions that agree with `decision`
    total: int  # decisions in the group
    source: str  # "user" or "synthetic"

    def line(self) -> str:
        words = DECISION_WORDS[self.decision]
        label = (
            topic_label(self.topics[0])
            if self.result_kind is None
            else group_label(self.result_kind, self.topics)
        )
        if self.source == "synthetic":
            why = f"{self.count} of {self.total} practice examples agree."
        elif self.decision in ("share_tagged", "share_summary"):
            why = f"You approved {self.count} of {self.total} and said don't ask again."
        elif self.decision == "refuse":
            why = f"You said no to {self.count} of {self.total} and said don't ask again."
        else:
            why = f"You wanted to be asked {self.count} of {self.total} times, so keep asking."
        return f"- {label}: {words}. {why}"


@dataclass(frozen=True)
class RuleLine:
    """A rule read back from a rules file. `kind` is None for a topic rule."""

    kind: str | None
    topics: tuple[str, ...]
    decision: str
    source: str  # "user" or "synthetic" (the practice defaults section)
    text: str


def group_label(result_kind: str, topics: Iterable[str]) -> str:
    """The part of a rule line that names its group, e.g. 'Per-student results (kind: per_student; topics: grades)'."""
    name = KIND_NAMES.get(result_kind, result_kind.replace("_", " ").capitalize())
    listed = ", ".join(sorted(topics)) or "none"
    return f"{name} (kind: {result_kind}; topics: {listed})"


def topic_label(topic: str) -> str:
    """The part of a topic rule line that names it, e.g. 'Anything about parents (topic: parents)'."""
    return f"Anything about {topic.replace('_', ' ')} (topic: {topic})"


def relevant_topics(policy) -> frozenset[str] | None:
    """Topics the policy names (never-share topics, request topics and every rule's topics), or None for no policy
    (or an object that is not one).

    Rules group on these only, so a topic the policy never mentions cannot split a group.
    """
    if policy is None or not hasattr(policy, "never_share"):
        return None
    topics = set(policy.never_share or {})
    topics.update(getattr(policy, "request_topics", None) or {})
    for rule in getattr(policy, "rules", None) or []:
        topics.update(getattr(rule, "topics_any", ()) or ())
        topics.update(getattr(rule, "topics_all", ()) or ())
    return frozenset(topics)


def floored_topics(policy) -> frozenset[str]:
    """Never-share topics that the router's floor always refuses (ask_first ones only ask)."""
    if policy is None:
        return frozenset()
    never = set(getattr(policy, "never_share", None) or {})
    return frozenset(never - set(getattr(policy, "ask_first", None) or ()))


def rule_key(
    result_kind: str, topics: Iterable[str], relevant: frozenset[str] | None
) -> tuple[str, tuple[str, ...]]:
    """(kind, sorted topics), keeping only `relevant` topics when given. Dreaming and the router
    both use this, so a rule's group and a result's group are worked out the same way."""
    present = {str(t) for t in topics}
    if relevant is not None:
        present &= relevant
    return result_kind, tuple(sorted(present))


def learn_rules(examples: Iterable[Example], policy=None) -> list[Rule]:
    """User rules first; synthetic fallbacks only for groups the user has never decided.

    Group rules come before topic rules in each section. With `policy`, groups use only the
    policy's topics. A group with a never-share topic the floor refuses (`floored_topics`) gets
    no practice rule, and only an ask first or refuse rule from the user's own decisions: the
    user is asked about one only when Muse's request alone names it (the result's own refuses
    without a card), and that "request:<topic>" floor asks whatever a share rule says.
    """
    relevant, floored = relevant_topics(policy), floored_topics(policy)
    keyed = []
    for e in examples:
        if e.label not in DECISIONS:
            continue
        key = rule_key(e.result_kind, e.topics, relevant)
        if e.source == "user" or not floored.intersection(key[1]):
            keyed.append((key, e))
    user = [(k, e) for k, e in keyed if e.source == "user"]
    synthetic = [(k, e) for k, e in keyed if e.source != "user"]
    user_groups, synthetic_groups = _group(user), _group(synthetic)
    user_rules = [
        r
        for key, rows in user_groups.items()
        if (r := _rule(key, rows, "user")) and (r.decision in FLOOR_DECISIONS or not floored.intersection(key[1]))
    ]
    fallback = [
        r
        for key, rows in synthetic_groups.items()
        if key not in user_groups and (r := _rule(key, rows, "synthetic"))
    ]
    # Topic rules need the policy to say which topics matter; without one, exact groups only.
    user_topic_rules, fallback_topics = [], []
    if relevant is not None:
        user_topic_rules = _topic_rules(user, "user")
        decided = {t for (_kind, topics), _e in user for t in topics}
        fallback_topics = _topic_rules(synthetic, "synthetic", skip=decided)
    return (
        sorted(user_rules, key=_rule_order)
        + sorted(user_topic_rules, key=_rule_order)
        + sorted(fallback, key=_rule_order)
        + sorted(fallback_topics, key=_rule_order)
    )


def _rule_order(r: Rule) -> tuple:
    return (-r.total, r.result_kind or "", r.topics)


def render_rules(
    rules: list[Rule], *, user_count: int, synthetic_count: int, day: str, floored: Iterable[str] = ()
) -> str:
    user = [r for r in rules if r.source == "user"]
    fallback = [r for r in rules if r.source != "user"]
    practice = f" and {synthetic_count} practice examples" if synthetic_count else ""
    lines = [
        "# Learned rules for the privacy router",
        "",
        f"Rebuilt from scratch on {day} from {user_count} of your decisions{practice}.",
        "The device shows each result with the rule that fits it best: the rule whose kind and "
        "topics match it exactly. An ask first or refuse rule also holds for every result of its "
        "kind that has all of its topics, with or without more (topics: none covers the whole "
        "kind), so a closer rule never loosens it; when the device shows such a rule too, it is "
        "the stricter one: follow it. Your rules always win over practice defaults, and the "
        "safety floors still apply after any rule.",
        "Words: share tagged = share_tagged, share a summary = share_summary, ask first = ask_user, "
        "refuse = refuse.",
    ]
    if any(r.result_kind is None for r in rules):
        lines.append(
            "A topic rule (topic: X) holds for any kind of result with that topic, even when "
            "another rule matches its kind and topics; when several fit, the strictest wins. "
            "The device shows a topic rule as the best fit when no rule matches exactly."
        )
    if floored:
        lines.append(
            "Results with a never-share topic (" + ", ".join(sorted(floored)) + ") in their own text "
            "are always refused by the safety floor. One named only in Muse's request (the Blocked line "
            "then says none) is asked about instead, unless a refuse rule here holds for it."
        )
    lines += ["", "## Your rules", ""]
    lines += [r.line() for r in user] or ["No rules yet."]
    if fallback:
        lines += ["", f"{PRACTICE_HEADING} (only where you have not decided yet)", ""]
        lines += [r.line() for r in fallback]
    return "\n".join(lines) + "\n"


def parse_rules(text: str) -> list[tuple[str, tuple[str, ...], str]]:
    """Read rule lines back as (result_kind, topics, decision), in priority order."""
    out = []
    for line in text.splitlines():
        m = _RULE_LINE.match(line.strip())
        if not m or m["words"] not in WORD_DECISIONS:
            continue
        topics = () if m["topics"].strip() == "none" else tuple(t.strip() for t in m["topics"].split(","))
        out.append((m["kind"], tuple(sorted(topics)), WORD_DECISIONS[m["words"]]))
    return out


def read_rules(text: str) -> list[RuleLine]:
    """Every group and topic rule in a rules file, in file order, with the section it is in."""
    out: list[RuleLine] = []
    source = "user"
    for raw in (text or "").splitlines():
        line = raw.strip()
        if line.startswith(PRACTICE_HEADING):
            source = "synthetic"
            continue
        m = _RULE_LINE.match(line)
        if m and m["words"] in WORD_DECISIONS:
            listed = m["topics"].strip()
            topics = () if listed == "none" else tuple(sorted(t.strip() for t in listed.split(",")))
            out.append(RuleLine(m["kind"], topics, WORD_DECISIONS[m["words"]], source, line))
            continue
        m = _TOPIC_LINE.match(line)
        if m and m["words"] in WORD_DECISIONS:
            out.append(RuleLine(None, (m["topic"],), WORD_DECISIONS[m["words"]], source, line))
    return out


def match_rule(rules: list[RuleLine], result_kind: str, topics: tuple[str, ...]) -> RuleLine | None:
    """The one rule for a result whose (kind, topics) went through rule_key.

    Order: your rule for this exact group, else your strictest topic rule, else the same two
    from the practice defaults. None when nothing fits.
    """
    for source in ("user", "synthetic"):
        mine = [r for r in rules if r.source == source]
        for r in mine:
            if r.kind == result_kind and r.topics == tuple(topics):
                return r
        topical = [r for r in mine if r.kind is None and r.topics and r.topics[0] in topics]
        if topical:
            return max(topical, key=lambda r: STRICTNESS[r.decision])
    return None


def covers(rule: RuleLine, result_kind: str, topics: tuple[str, ...]) -> bool:
    """A topic rule for one of the result's topics, or a rule for its kind whose topics are all
    among the result's ("topics: none" covers the whole kind)."""
    if rule.kind is None:
        return bool(rule.topics) and rule.topics[0] in topics
    return rule.kind == result_kind and set(rule.topics) <= set(topics)


def learned_floor(rules: list[RuleLine], result_kind: str, topics: tuple[str, ...]) -> RuleLine | None:
    """The strictest "ask first" or "refuse" rule that holds for a result whose (kind, topics)
    went through rule_key, or None.

    It holds when match_rule picks it, or when it covers the result: your rules first, practice
    defaults only when none of your rules covers it. So a topic the request adds (class_level,
    parents) cannot lift a result out from under a broader rule, and a closer share rule never
    loosens a stricter one. Among equally strict rules yours wins, then the one match_rule picks.
    """
    topics = tuple(topics)
    shown = match_rule(rules, result_kind, topics)
    held = [r for r in rules if r.source == "user" and covers(r, result_kind, topics)]
    held = held or [r for r in rules if r.source != "user" and covers(r, result_kind, topics)]
    if shown is not None:
        held.append(shown)
    strict = [r for r in held if r.decision in FLOOR_DECISIONS]
    if not strict:
        return None
    return max(strict, key=lambda r: (STRICTNESS[r.decision], r.source == "user", r == shown))


def train(
    examples: Iterable[Example],
    settings,
    backend: str | None = None,
    *,
    out_path: Path | None = None,
    day: str | None = None,
    policy=None,
) -> TrainResult:
    """Train the router from `examples`. `out_path` defaults to settings.paths.router_prompt.

    `policy` (the user's UserPolicy) makes the prompt backend group on the policy's topics only.
    """
    examples = list(examples)
    backend = backend or settings.dreaming_backend
    day = day or date.today().isoformat()
    if backend == "prompt":
        return _train_prompt(examples, Path(out_path or settings.paths.router_prompt), day, policy)
    if backend == "lora":
        return _train_lora(examples, settings, day)
    raise ValueError(f"unknown dreaming backend {backend!r}")


def _train_prompt(examples: list[Example], path: Path, day: str, policy=None) -> TrainResult:
    rules = learn_rules(examples, policy)
    user_count = sum(1 for e in examples if e.source == "user")
    text = render_rules(
        rules,
        user_count=user_count,
        synthetic_count=len(examples) - user_count,
        day=day,
        floored=floored_topics(policy),
    )
    _atomic_write(path, text)
    return TrainResult(
        backend="prompt",
        path=path,
        rules=len(rules),
        examples=len(examples),
        user_examples=user_count,
        message=f"Wrote {len(rules)} rules from {user_count} of your decisions.",
    )


def _leak_check(settings):
    """guard.leaks with this device's roster and tag map, or None when they cannot be loaded."""
    from base import guard

    try:
        roster = guard.load_roster(settings.roster_path)
        tagmap = guard.TagMap.for_settings(settings)
    except Exception as exc:  # unsure: no file at all is safer than an unchecked one
        log.warning("cannot load the roster or tag map for the training check: %s", type(exc).__name__)
        return None
    return lambda text: guard.leaks(text, roster, tagmap)


def _train_lora(examples: list[Example], settings, day: str) -> TrainResult:
    system, render = _router_format()
    check = _leak_check(settings)
    if check is None:
        return TrainResult(
            backend="lora", path=None, rules=0, examples=len(examples), user_examples=0, cloud_required=True,
            message="No training file was written: the device could not check it for names.",
        )
    lines, dropped = [], 0
    for e in examples:
        # Text and requests the user did not approve stay out of a file meant for cloud training.
        approved = e.source != "user" or e.approved
        text = e.tagged_text if approved else WITHHELD_TEXT
        request = e.request if approved else WITHHELD_TEXT
        user_msg = render(RouteInput(request, e.result_kind, text, topics=list(e.topics)))
        if check(user_msg):  # a name or identifier slipped through: this row never leaves
            dropped += 1
            continue
        answer = json.dumps({"decision": e.label, "reason": _reason(e)})
        record = {
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
                {"role": "assistant", "content": answer},
            ]
        }
        lines.extend([json.dumps(record)] * max(1, e.weight))
    path = Path(settings.paths.adapters) / f"train-{day}.jsonl"
    _atomic_write(path, "\n".join(lines) + ("\n" if lines else ""))
    user_count = sum(1 for e in examples if e.source == "user")
    return TrainResult(
        backend="lora",
        path=path,
        rules=0,
        examples=len(examples),
        user_examples=user_count,
        cloud_required=True,
        message=(
            f"Wrote {len(lines)} training rows to {path.name}"
            + (f" and left out {dropped} that still named someone" if dropped else "")
            + f". LoRA training runs in the cloud with {LORA_CLOUD_SCRIPT}; it was not started here."
        ),
    )


def _group(keyed: Iterable[tuple[tuple, Example]]) -> dict[tuple[str, tuple[str, ...]], list[Example]]:
    groups: dict[tuple[str, tuple[str, ...]], list[Example]] = defaultdict(list)
    for key, e in keyed:
        groups[key].append(e)
    return groups


def _topic_rules(keyed: list[tuple[tuple, Example]], source: str, skip: set[str] = frozenset()) -> list[Rule]:
    """Strict rules for single topics, most decisive first.

    A topic also needs evidence of its own: the decisions on it that no topic chosen before it
    covers must exist and agree with it. A topic that only rides along with a stricter one
    (grades next to parents in every request the user was asked about) gets no rule.
    """
    rows = [(set(topics), e) for (_kind, topics), e in keyed]
    candidates = []
    for t in sorted({t for topics, _e in rows for t in topics} - set(skip)):
        found = _topic_rule(t, [e for topics, e in rows if t in topics], source)
        if found:
            candidates.append(found)
    candidates.sort(key=lambda r: (-r.count / r.total, -r.total, r.topics))
    chosen: list[Rule] = []
    for rule in candidates:
        taken = {r.topics[0] for r in chosen}
        own = [e for topics, e in rows if rule.topics[0] in topics and not topics & taken]
        agrees = _majority(own, 1)
        if agrees and agrees[0] == rule.decision:
            chosen.append(rule)
    return chosen


def _majority(rows: list[Example], minimum: int) -> tuple[str, int] | None:
    if len(rows) < minimum:
        return None
    label, count = Counter(e.label for e in rows).most_common(1)[0]
    if count / len(rows) < MIN_AGREEMENT:
        return None
    return label, count


def _rule(key: tuple[str, tuple[str, ...]], rows: list[Example], source: str) -> Rule | None:
    found = _majority(rows, MIN_DECISIONS)
    if found is None:
        return None
    label, count = found
    return Rule(
        result_kind=key[0], topics=key[1], decision=label, count=count, total=len(rows), source=source
    )


def _topic_rule(topic: str, rows: list[Example], source: str) -> Rule | None:
    found = _majority(rows, MIN_TOPIC_DECISIONS)
    if found is None or found[0] not in TOPIC_RULE_DECISIONS:
        return None
    label, count = found
    return Rule(
        result_kind=None, topics=(topic,), decision=label, count=count, total=len(rows), source=source
    )


def _reason(e: Example) -> str:
    if e.source != "user":
        return "Practice example."
    if e.label == "ask_user":
        return "You decide these one at a time."
    return "You said don't ask again for things like this."


def _router_format():
    """The router's own system prompt (with no learned rules) and input format, so a LoRA learns
    exactly what the router sees at run time."""
    try:
        from base.router import NO_RULES, SYSTEM_PROMPT, build_user_message
    except ImportError:
        return _FALLBACK_SYSTEM_PROMPT, _fallback_user_message
    return SYSTEM_PROMPT + NO_RULES, build_user_message


def _fallback_user_message(inp: RouteInput) -> str:
    return json.dumps(
        {
            "request": inp.request,
            "result_kind": inp.result_kind,
            "topics": inp.topics,
            "tagged_text": inp.tagged_text,
        }
    )


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)
