"""Shared types. See docs/CONTRACTS.md before changing anything here."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Literal

Decision = Literal["share_tagged", "share_summary", "ask_user", "refuse"]
DECISIONS: tuple[Decision, ...] = ("share_tagged", "share_summary", "ask_user", "refuse")
STRICTNESS: dict[str, int] = {"share_tagged": 0, "share_summary": 1, "ask_user": 2, "refuse": 3}

ResultKind = Literal[
    "document_list",
    "snippet",
    "per_student",
    "class_aggregate",
    "contact_info",
    "sensitive_record",
    "free_text",
    "dreaming_report",
]
RESULT_KINDS: tuple[str, ...] = (
    "document_list",
    "snippet",
    "per_student",
    "class_aggregate",
    "contact_info",
    "sensitive_record",
    "free_text",
    "dreaming_report",
)

HitKind = Literal[
    "student", "teacher", "person", "phone", "email", "ssn", "card", "otp", "student_id", "address", "dob"
]
IDENTIFIER_KINDS: frozenset[str] = frozenset({"phone", "email", "ssn", "card", "otp", "student_id", "address", "dob"})


def stricter(a: Decision, b: Decision) -> Decision:
    """Return whichever decision keeps more on the device."""
    return a if STRICTNESS[a] >= STRICTNESS[b] else b


@dataclass(frozen=True)
class Person:
    name: str
    first: str
    last: str
    nicknames: tuple[str, ...] = ()
    role: str = "student"
    student_id: str | None = None


@dataclass(frozen=True)
class Roster:
    teacher: Person
    students: tuple[Person, ...]
    school: str | None = None

    def people(self) -> Iterator[Person]:
        yield self.teacher
        yield from self.students


@dataclass(frozen=True)
class Hit:
    kind: str
    value: str
    start: int
    end: int


@dataclass
class TagResult:
    text: str
    tag_map: dict[str, str] = field(default_factory=dict)
    hits: list[Hit] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)
    topics: list[str] = field(default_factory=list)


# The request topic that marks a class-level question (an average, a count, a trend). Results
# for one are shown and shared as a summary, whatever their kind.
CLASS_LEVEL_TOPIC = "class_level"


def default_share_form(result_kind: str, topics: Iterable[str] = ()) -> Decision:
    """What an approved result is shared as: aggregates and answers to a class-level question as
    a summary, everything else tagged."""
    if result_kind == "class_aggregate" or CLASS_LEVEL_TOPIC in topics:
        return "share_summary"
    return "share_tagged"


@dataclass
class RouteInput:
    request: str
    result_kind: str
    tagged_text: str
    hits: list[Hit] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)
    summary: str | None = None
    topics: list[str] = field(default_factory=list)
    # Never-share topics named only in Muse's request, not in the result ("Do not mention any
    # IEP"). They stay in `topics`, but floor the result to ask_user instead of refuse.
    request_blocked: list[str] = field(default_factory=list)
    # A compliance toggle is on: the router model may only make the decision stricter.
    strict: bool = False


@dataclass
class RouteDecision:
    decision: Decision
    reason: str
    source: Literal["model", "rule", "fallback", "cache"]
    latency_ms: int = 0
    floors: list[str] = field(default_factory=list)
    # What decided it, as a fixed string (never model text): "policy_default", "outside_class",
    # "identifier:phone"... docs/CONTRACTS.md (Router) lists them. Empty when unknown.
    code: str = ""
    # The router model's usage for this decision: completions sent (0 on a path with no model
    # call) and the tokens the server reported, None when it reported none.
    calls: int = 0
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    reasoning_tokens: int | None = None
    finish_reason: str | None = None
