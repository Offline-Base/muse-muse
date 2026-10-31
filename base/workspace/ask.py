"""Ask the device: a local model searches, reasons and answers a request itself (ask_device).

See docs/CONTRACTS.md, Workspace. Mode 2 next to search_documents: Muse gets a finished answer
and a few short quotes, not a list of passages. It runs as a background job (AskRunner), up to
DEADLINE_SECONDS, because a request can have several parts:

1. split: the checker (LFM3-VL-2B on this device) splits the request into up to 5 parts.
2. each part: search (the part plus rewritten queries), read up to 12 passages, answer; while the
   answer is "not found" and time is left, search again with new words, up to ROUNDS_PER_PART times.
3. combine: with more than one part, one finished answer from the part answers.

The model only ever reads passages with names, known values and identifiers swapped for tags. A
quote counts only if it occurs in the passage it names, so a made-up quote never leaves. The answer
and quotes are restored to real names here, and the connector releases them through egress, which
tags, checks and routes them like any result.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from base import events
from base.regions import unchecked_images, unchecked_note

log = logging.getLogger(__name__)

NOT_FOUND = "The documents on this device do not answer this."
HELD_PART = "Kept on the device: the answer to this part touches a topic you never share."
DEADLINE_SECONDS = 180  # the user's limit for one request (Oct 29)
MAX_PARTS = 5
ROUNDS_PER_PART = 3
SHOW_PASSAGES = 12
QUOTE_CHARS = 300
MAX_QUOTES = 5
ASK_MAX_TOKENS = 1500
FAILED = "The device's model could not finish this request."

SPLIT_PROMPT = (
    "You split a teacher's request into the separate questions it asks, so each can be searched on its "
    "own. Each question must stand alone: keep every detail it needs from the request, such as which "
    "document, which person or which folder (for example \"in the resume\"). Copy tags such as "
    "[Student A] exactly. A request that asks one thing stays one question. At most 5. "
    'Reply with JSON only: {"parts": ["..."]}.'
)
SPLIT_SCHEMA = {
    "name": "request_parts",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {"parts": {"type": "array", "items": {"type": "string"}}},
        "required": ["parts"],
        "additionalProperties": False,
    },
}

ASK_PROMPT = (
    "You answer a teacher's question from passages of the teacher's own documents. Read every passage, "
    "then answer from what they say: most questions are answered by at least one passage, so answer "
    "whenever any passage is related. People appear as tags such as [Student A] or [Person 1]: copy tags "
    "exactly and never guess who they are. Write two to five sentences, and give up to 3 quotes: the passage "
    "number and a short exact quote copied from it. Set enough to true unless a different search would "
    "clearly find better passages; then set it to false and give up to 3 short more_queries. Only if no "
    f'passage is related at all, answer "{NOT_FOUND}" with no quotes. Reply with JSON only.'
)
# Measured on Oct 29 with LFM3-VL-2B on 3 questions x 3 runs: this wording with the question after
# the passages answered 8 of 9, the first wording with the question first 5 of 9.

ASK_SCHEMA = {
    "name": "device_answer",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "enough": {"type": "boolean"},
            "more_queries": {"type": "array", "items": {"type": "string"}},
            "answer": {"type": "string"},
            "quotes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"passage": {"type": "integer"}, "quote": {"type": "string"}},
                    "required": ["passage", "quote"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["enough", "more_queries", "answer", "quotes"],
        "additionalProperties": False,
    },
}

RETRY_PROMPT = (
    "A search of a teacher's documents found nothing for the question below. Write up to 3 new short "
    "search queries with different words than the ones already tried: synonyms, broader or narrower "
    'terms. Copy tags such as [Student A] exactly. Reply with JSON only: {"queries": ["..."]}.'
)
RETRY_SCHEMA = {
    "name": "retry_queries",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {"queries": {"type": "array", "items": {"type": "string"}}},
        "required": ["queries"],
        "additionalProperties": False,
    },
}

COMBINE_PROMPT = (
    "You write one finished answer to a teacher's request from the answers to its parts. Use only what "
    "the part answers say, keep every tag such as [Student A] exactly, and say plainly which parts the "
    'documents did not answer. Write a short paragraph or a few lines. Reply with JSON only: {"answer": "..."}.'
)
COMBINE_SCHEMA = {
    "name": "combined_answer",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
        "additionalProperties": False,
    },
}


def _flat(text: Any) -> str:
    return " ".join(str(text).split())


def _found(answer: str) -> bool:
    return bool(answer) and answer != NOT_FOUND


@dataclass
class AskResult:
    answer: str  # real names restored
    quotes: list[tuple[str, str]] = field(default_factory=list)  # (title, quote), real names restored
    sources: list[str] = field(default_factory=list)  # doc ids of every passage the model read
    parts: int = 1
    answered: int = 0
    timed_out: bool = False


class DeviceAsk:
    """`run(question, folder)` -> AskResult; `ask(question, folder)` -> (answer, quotes)."""

    def __init__(
        self,
        rag: Any,
        index: Any,
        *,
        rounds: int = ROUNDS_PER_PART,
        deadline_seconds: float = DEADLINE_SECONDS,
        never_share: Any = None,
    ):
        self.rag = rag
        self.index = index
        self.never_share = never_share  # the policy's never-share topics: a part that touches one is held
        self.rounds = max(1, rounds)
        self.deadline_seconds = deadline_seconds

    def ask(self, question: str, folder: str | None = None) -> tuple[str, list[tuple[str, str]]]:
        r = self.run(question, folder)
        return r.answer, r.quotes

    def run(self, question: str, folder: str | None = None, deadline: float | None = None) -> AskResult:
        from base import guard

        deadline = deadline if deadline is not None else time.monotonic() + self.deadline_seconds
        parts = self.split(question)
        found: list[tuple[str, str, list[tuple[str, str]]]] = []  # (part, tagged answer, tagged quotes)
        sources: list[str] = []
        timed_out = False
        with unchecked_images() as unread:  # images the SAM sidecar could not check are left out
            for part in parts:
                if time.monotonic() >= deadline:
                    timed_out = True
                    break
                answer, quotes, srcs = self._part(part, folder, deadline)
                if _found(answer) and self._touches_never_share(answer, quotes):
                    answer, quotes = HELD_PART, []  # the other parts can still go; egress checks it all again
                found.append((part, answer, quotes))
                sources += [s for s in srcs if s not in sources]
        answered = sum(_found(a) and a != HELD_PART for _p, a, _q in found)
        quotes = [q for _p, _a, qs in found for q in qs][:MAX_QUOTES]
        held = [p for p, a, _q in found if a == HELD_PART]
        missing = [p for p, a, _q in found if not _found(a)]
        skipped = parts[len(found) :]
        if len(parts) == 1 and found:
            answer = found[0][1]
        elif answered == 0:
            answer = HELD_PART if held else NOT_FOUND
        else:
            # Only answered parts go to the combine step; what was held, not found or not reached
            # is said in fixed sentences after it, so the model cannot restate it as a fact.
            answer = self._combine(question, [f for f in found if _found(f[1]) and f[1] != HELD_PART])
            answer = " ".join([answer, *_notes(len(held), len(missing), len(skipped))])
        if unread:
            answer = f"{answer} {unchecked_note(len(unread))}"
        restore = self.rag.tagmap
        return AskResult(
            answer=guard.restore(answer, restore),
            quotes=[(guard.restore(t, restore), guard.restore(q, restore)) for t, q in quotes],
            sources=sources,
            parts=len(parts),
            answered=answered,
            timed_out=timed_out,
        )

    # steps

    def _touches_never_share(self, answer: str, quotes: list[tuple[str, str]]) -> bool:
        if not self.never_share:
            return False
        from base import guard

        restored = guard.restore(" ".join([answer, *(q for _t, q in quotes)]), self.rag.tagmap)
        return bool(guard.blocked_topics(restored, self.never_share))

    def split(self, question: str) -> list[str]:
        """The request's separate questions (tagged view in, real values out); [question] on failure."""
        from base import guard

        try:
            data = self.rag.llm.chat_json(
                [{"role": "system", "content": SPLIT_PROMPT}, {"role": "user", "content": self.rag._view(question)}],
                SPLIT_SCHEMA,
                max_tokens=400,
            )
        except Exception as exc:
            log.warning("could not split the request, asking it whole: %s", type(exc).__name__)
            return [question]
        parts = []
        for value in (data.get("parts") or [])[:MAX_PARTS]:
            p = guard.restore(_flat(value), self.rag.tagmap)[:300]
            if p and p.lower() not in {x.lower() for x in parts}:
                parts.append(p)
        return parts or [question]

    def _part(self, part: str, folder: str | None, deadline: float) -> tuple[str, list[tuple[str, str]], list[str]]:
        """Search, read and answer one part; search again with new words while nothing is found."""
        from base import guard

        queries = self.rag.queries(part)
        best: tuple[dict[str, Any], list[tuple[str, str]]] | None = None
        data: dict[str, Any] = {}
        views: list[tuple[str, str]] = []
        sources: list[str] = []
        for round_no in range(self.rounds):
            passages = list(self.index.passages(queries, k=self.rag.candidates, folder=folder))[:SHOW_PASSAGES]
            if passages:
                sources += [str(_get(p, "doc_id")) for p in passages if str(_get(p, "doc_id")) not in sources]
                views = [(self.rag._view(_get(p, "title", "")), self.rag._view(_get(p, "text", ""))) for p in passages]
                listed = "\n\n".join(f"[{i}] {t}\n{x}" for i, (t, x) in enumerate(views, 1))
                data = self.rag.llm.chat_json(
                    [
                        {"role": "system", "content": ASK_PROMPT},
                        {"role": "user", "content": f"Passages:\n\n{listed}\n\nQuestion: {self.rag._view(part)}"},
                    ],
                    ASK_SCHEMA,
                    max_tokens=ASK_MAX_TOKENS,
                )
                if _found(_flat(data.get("answer") or "")):
                    best = (data, views)
                    if data.get("enough") or round_no == self.rounds - 1:
                        break
            if round_no == self.rounds - 1 or time.monotonic() >= deadline:
                break
            more = [str(q).strip() for q in (data.get("more_queries") or []) if str(q).strip()][:3]
            if best is None and not more:
                more = self._retry_queries(part, queries)
            new = [q for q in (guard.restore(m, self.rag.tagmap) for m in more) if q not in queries]
            if not new:
                break
            # every query so far: what the first ones agreed on stays on top
            queries += new
        if best is None:
            return NOT_FOUND, [], sources
        data, views = best
        return _flat(data.get("answer") or ""), _quotes(data, views), sources

    def _retry_queries(self, part: str, tried: list[str]) -> list[str]:
        try:
            data = self.rag.llm.chat_json(
                [
                    {"role": "system", "content": RETRY_PROMPT},
                    {
                        "role": "user",
                        "content": "Already tried: "
                        + "; ".join(self.rag._view(q) for q in tried)
                        + f"\n\nQuestion: {self.rag._view(part)}",
                    },
                ],
                RETRY_SCHEMA,
                max_tokens=300,
            )
        except Exception as exc:
            log.warning("could not write new queries: %s", type(exc).__name__)
            return []
        return [str(q).strip() for q in (data.get("queries") or []) if str(q).strip()][:3]

    def _combine(self, question: str, found: list[tuple[str, str, list]]) -> str:
        lines = [f"Part: {self.rag._view(p)}\nAnswer: {a}" for p, a, _q in found]
        try:
            data = self.rag.llm.chat_json(
                [
                    {"role": "system", "content": COMBINE_PROMPT},
                    {"role": "user", "content": "\n\n".join(lines) + f"\n\nRequest: {self.rag._view(question)}"},
                ],
                COMBINE_SCHEMA,
                max_tokens=ASK_MAX_TOKENS,
            )
            combined = _flat(data.get("answer") or "")
            if combined:
                return combined
        except Exception as exc:
            log.warning("could not combine the answers, listing them: %s", type(exc).__name__)
        return " ".join(f"{p}: {a}" for p, a, _q in found)  # still only tagged text from the parts


def _notes(held: int, missing: int, skipped: int) -> list[str]:
    """Fixed sentences for the parts that are not in the combined answer."""
    notes = []
    if held:
        notes.append(f"{_count(held)} kept on your device because it touches a topic you never share." if held == 1
                     else f"{_count(held)} kept on your device because they touch topics you never share.")
    if missing:
        notes.append(f"The documents did not answer {_count(missing, lower=True)}.")
    if skipped:
        notes.append(f"The device ran out of time before {_count(skipped, lower=True)}.")
    return notes


def _count(n: int, lower: bool = False) -> str:
    text = "One part of the request was" if n == 1 else f"{n} parts of the request were"
    if lower:
        return "one part of the request" if n == 1 else f"{n} parts of the request"
    return text


def _quotes(data: dict[str, Any], views: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """The model's quotes that really occur in the passage they name (tagged view), up to 3."""
    out: list[tuple[str, str]] = []
    for item in data.get("quotes") or []:
        n, quote = item.get("passage"), _flat(item.get("quote") or "").strip(" \"'")
        if not isinstance(n, int) or not 1 <= n <= len(views) or not quote:
            continue
        title, text = views[n - 1]
        if quote.lower() not in _flat(text).lower():
            continue  # not in the passage it names: never send a made-up quote
        quote = quote if len(quote) <= QUOTE_CHARS else quote[:QUOTE_CHARS].rsplit(" ", 1)[0] + "..."
        if all(quote != q for _t, q in out):
            out.append((title, quote))
        if len(out) >= 3:
            break
    return out


def format_result(result: AskResult) -> str:
    """What the connector releases: the answer, then the quotes."""
    raw = f"Answer: {result.answer}"
    if result.timed_out and result.parts == 1:
        raw += " (The device ran out of time before it finished searching.)"
    if result.quotes:
        raw += "\n\nQuotes:\n" + "\n".join(f'{i}. {t}: "{q}"' for i, (t, q) in enumerate(result.quotes, 1))
    return raw


class AskBusy(RuntimeError):
    """Too many jobs are queued or running; the message is plain and has no content."""


class AskRunner:
    """ask_device's background jobs: one at a time on the device's model, at most MAX_ACTIVE jobs."""

    MAX_ACTIVE = 5

    def __init__(self, asker: DeviceAsk, jobs: Any, *, deadline_seconds: float = DEADLINE_SECONDS):
        self.asker = asker
        self.jobs = jobs
        self.deadline_seconds = deadline_seconds
        self.sources: dict[str, list[str]] = {}  # job id -> doc ids, for the user's redaction controls
        self._slot = threading.Semaphore(1)

    def start(self, question: str, request: str, folder: str | None) -> str:
        """Queue one request; `question` has real values for the model, `request` is Muse's own text."""
        if self.jobs.active_count() >= self.MAX_ACTIVE:
            raise AskBusy(f"The device is already working on {self.MAX_ACTIVE} jobs. Try again when one finishes.")
        job_id = str(self.jobs.create("ask", request, folder or None))
        threading.Thread(target=self._work, args=(job_id, question, folder), name=f"ask-{job_id}", daemon=True).start()
        return job_id

    def run_sync(self, question: str, request: str, folder: str | None) -> str:
        job_id = str(self.jobs.create("ask", request, folder or None))
        self._work(job_id, question, folder)
        return job_id

    def _work(self, job_id: str, question: str, folder: str | None) -> None:
        with self._slot:
            self.jobs.start(job_id)
            events.emit("working", job_id)
            try:
                result = self.asker.run(question, folder, deadline=time.monotonic() + self.deadline_seconds)
                self.sources[job_id] = result.sources
                self.jobs.finish(job_id, format_result(result), "snippet")
            except Exception as exc:
                log.warning("ask job failed: %s", type(exc).__name__)
                self.jobs.fail(job_id, FAILED)
            finally:
                events.settle(job_id)


def _get(obj: Any, name: str, default: Any = None) -> Any:
    return obj.get(name, default) if isinstance(obj, dict) else getattr(obj, name, default)
