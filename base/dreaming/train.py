"""Nightly training for the privacy router.

prompt backend (default): turn the user's decisions into short plain rules with exact counts and
write them to the router's rules file. Deterministic, and rebuilt from scratch every night from
the current decision log (yesterday's file is never read), so deleted decisions drop out.

lora backend: write a chat-format training JSONL into the adapters folder. Training itself runs
in the cloud with scripts/cloud/train_lora_modal.py; nothing is trained on this machine.
"""

from __future__ import annotations

import json
import os
import re
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from base.dreaming.dataset import Example
from base.types import DECISIONS, RouteInput

MIN_DECISIONS = 2
MIN_AGREEMENT = 0.8

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
    result_kind: str
    topics: tuple[str, ...]
    decision: str
    count: int  # decisions that agree with `decision`
    total: int  # decisions in the group
    source: str  # "user" or "synthetic"

    def line(self) -> str:
        words = DECISION_WORDS[self.decision]
        if self.source == "synthetic":
            why = f"{self.count} of {self.total} practice examples agree."
        elif self.decision in ("share_tagged", "share_summary"):
            why = f"You approved {self.count} of {self.total} and said don't ask again."
        elif self.decision == "refuse":
            why = f"You said no to {self.count} of {self.total} and said don't ask again."
        else:
            why = f"You wanted to be asked {self.count} of {self.total} times, so keep asking."
        return f"- {group_label(self.result_kind, self.topics)}: {words}. {why}"


def group_label(result_kind: str, topics: Iterable[str]) -> str:
    """The part of a rule line that names its group, e.g. 'Per-student results (kind: per_student; topics: grades)'."""
    name = KIND_NAMES.get(result_kind, result_kind.replace("_", " ").capitalize())
    listed = ", ".join(sorted(topics)) or "none"
    return f"{name} (kind: {result_kind}; topics: {listed})"


def learn_rules(examples: Iterable[Example]) -> list[Rule]:
    """User rules first; synthetic fallbacks only for groups the user has never decided."""
    examples = list(examples)
    user_groups = _group(e for e in examples if e.source == "user")
    synthetic_groups = _group(e for e in examples if e.source != "user")
    user_rules = [r for key, rows in user_groups.items() if (r := _rule(key, rows, "user"))]
    fallback = [
        r
        for key, rows in synthetic_groups.items()
        if key not in user_groups and (r := _rule(key, rows, "synthetic"))
    ]
    return sorted(user_rules, key=_rule_order) + sorted(fallback, key=_rule_order)


def _rule_order(r: Rule) -> tuple:
    return (-r.total, r.result_kind, r.topics)


def render_rules(rules: list[Rule], *, user_count: int, synthetic_count: int, day: str) -> str:
    user = [r for r in rules if r.source == "user"]
    fallback = [r for r in rules if r.source != "user"]
    practice = f" and {synthetic_count} practice examples" if synthetic_count else ""
    lines = [
        "# Learned rules for the privacy router",
        "",
        f"Rebuilt from scratch on {day} from {user_count} of your decisions{practice}.",
        "Use the rule whose kind and topics match the result exactly. Your rules always win over "
        "practice defaults, and the safety floors still apply after any rule.",
        "Words: share tagged = share_tagged, share a summary = share_summary, ask first = ask_user, "
        "refuse = refuse.",
        "",
        "## Your rules",
        "",
    ]
    lines += [r.line() for r in user] or ["No rules yet."]
    if fallback:
        lines += ["", "## Practice defaults (only where you have not decided yet)", ""]
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


def train(
    examples: Iterable[Example],
    settings,
    backend: str | None = None,
    *,
    out_path: Path | None = None,
    day: str | None = None,
) -> TrainResult:
    """Train the router from `examples`. `out_path` defaults to settings.paths.router_prompt."""
    examples = list(examples)
    backend = backend or settings.dreaming_backend
    day = day or date.today().isoformat()
    if backend == "prompt":
        return _train_prompt(examples, Path(out_path or settings.paths.router_prompt), day)
    if backend == "lora":
        return _train_lora(examples, settings, day)
    raise ValueError(f"unknown dreaming backend {backend!r}")


def _train_prompt(examples: list[Example], path: Path, day: str) -> TrainResult:
    rules = learn_rules(examples)
    user_count = sum(1 for e in examples if e.source == "user")
    text = render_rules(rules, user_count=user_count, synthetic_count=len(examples) - user_count, day=day)
    _atomic_write(path, text)
    return TrainResult(
        backend="prompt",
        path=path,
        rules=len(rules),
        examples=len(examples),
        user_examples=user_count,
        message=f"Wrote {len(rules)} rules from {user_count} of your decisions.",
    )


def _train_lora(examples: list[Example], settings, day: str) -> TrainResult:
    system, render = _router_format()
    lines = []
    for e in examples:
        # Text the user did not approve stays out of a file meant for cloud training.
        text = e.tagged_text if (e.source != "user" or e.approved) else WITHHELD_TEXT
        user_msg = render(RouteInput(e.request, e.result_kind, text, topics=list(e.topics)))
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
            f"Wrote {len(lines)} training rows to {path.name}. LoRA training runs in the cloud with "
            f"{LORA_CLOUD_SCRIPT}; it was not started here."
        ),
    )


def _group(examples: Iterable[Example]) -> dict[tuple[str, tuple[str, ...]], list[Example]]:
    groups: dict[tuple[str, tuple[str, ...]], list[Example]] = defaultdict(list)
    for e in examples:
        if e.label in DECISIONS:
            groups[(e.result_kind, tuple(sorted(e.topics)))].append(e)
    return groups


def _rule(key: tuple[str, tuple[str, ...]], rows: list[Example], source: str) -> Rule | None:
    if len(rows) < MIN_DECISIONS:
        return None
    label, count = Counter(e.label for e in rows).most_common(1)[0]
    if count / len(rows) < MIN_AGREEMENT:
        return None
    return Rule(result_kind=key[0], topics=key[1], decision=label, count=count, total=len(rows), source=source)


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
        {"request": inp.request, "result_kind": inp.result_kind, "topics": inp.topics, "tagged_text": inp.tagged_text}
    )


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)
