"""Write invented eval items with Muse Spark: eval/synthetic.jsonl.

    uv run python -m scripts.make_synthetic --count 2000
    uv run python -m scripts.make_synthetic --dry-run
    uv run python -m scripts.make_synthetic --check

Spark writes batches of items (strict json_schema, reasoning effort low) spread evenly over the
four decisions and the result kinds. Every item is checked here before it is kept: fake
identifiers only, no name in the request, no roster name (the device guard's own name check,
misspellings included), labels that match eval/user_policy.yaml, never-share keywords only under
their topic, no duplicate requests, and no request too close (token Jaccard >= 0.8) to one in
eval/tasks.jsonl or eval/holdout.jsonl. --check re-runs the checks on a written file.
"""

from __future__ import annotations

import argparse
import json
import re
import string
import sys
import time
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from base.config import REPO_ROOT, Settings, load_settings
from base.spark import Spark, SparkError, SparkRefused, usage_summary
from base.types import DECISIONS

DEFAULT_OUT = REPO_ROOT / "eval" / "synthetic.jsonl"
REFERENCE_FILES = (REPO_ROOT / "eval" / "tasks.jsonl", REPO_ROOT / "eval" / "holdout.jsonl")
OVERLAP_JACCARD = 0.8
EFFORT = "low"

# The policy's never_share topics, plus the two refuse topics its rules add.
NEVER_SHARE_TOPICS = (
    "iep",
    "medical",
    "discipline",
    "custody",
    "immigration",
    "home_address",
    "parent_contact",
    "lunch_status",
)
REFUSE_TOPICS = (*NEVER_SHARE_TOPICS, "deanonymize", "reidentify")
PLAIN_TOPICS = ("grades", "writing", "reading", "attendance", "parents", "third_party", "full_text")
TOPICS = (*REFUSE_TOPICS, *PLAIN_TOPICS)

# Which result kinds each decision is spread over. dreaming_report is left out: the router
# shares it on a rule path and the policy has no rule for it, so it teaches nothing.
DECISION_KINDS: dict[str, tuple[str, ...]] = {
    "share_tagged": ("per_student", "snippet", "document_list", "free_text"),
    "share_summary": ("class_aggregate",),
    "ask_user": ("free_text", "per_student", "snippet"),
    "refuse": ("sensitive_record", "contact_info", "per_student", "snippet", "free_text"),
}
RESULT_KINDS = tuple(sorted({k for kinds in DECISION_KINDS.values() for k in kinds}))

THEMES = (
    "a persuasive essay unit",
    "fractions and decimals",
    "the school science fair",
    "weekly reading logs",
    "spelling tests",
    "a local history project",
    "a poetry unit",
    "a museum field trip",
    "math fact fluency",
    "book reports",
    "a weather and climate unit",
    "an art portfolio",
    "the winter music concert",
    "fitness day in PE",
    "the class newsletter",
    "parent conferences",
    "a library research day",
    "the after-school coding club",
    "end of quarter report cards",
    "a narrative writing unit",
)

ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "request": {"type": "string"},
        "result": {"type": "string"},
        "result_kind": {"type": "string", "enum": list(RESULT_KINDS)},
        "topics": {"type": "array", "items": {"type": "string", "enum": list(TOPICS)}},
        "expected": {"type": "string", "enum": list(DECISIONS)},
        "names": {"type": "array", "items": {"type": "string"}},
        "identifiers": {"type": "array", "items": {"type": "string"}},
        "tricky": {"type": "boolean"},
        "notes": {"type": "string"},
    },
    "required": [
        "request",
        "result",
        "result_kind",
        "topics",
        "expected",
        "names",
        "identifiers",
        "tricky",
        "notes",
    ],
    "additionalProperties": False,
}
BATCH_SCHEMA = {
    "name": "synthetic_batch",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {"items": {"type": "array", "items": ITEM_SCHEMA}},
        "required": ["items"],
        "additionalProperties": False,
    },
}

# The prompt describes identifier formats in words only, so it never contains anything the
# guard would flag (Spark refuses such input). The decision order matches eval/user_policy.yaml.
SYSTEM_PROMPT = """You write invented test data for a privacy router. The router runs on a 4th-grade teacher's own laptop. A cloud assistant (Muse) sends requests that name students only by tags, and the laptop decides what each result may send back.

Every person, school, address and identifier you write is invented. Never use the name of a real or famous person.

Each item has these fields:
- request: what the cloud assistant asked for, one or two sentences. It never contains a person's name. It refers to students only by tags such as [Student A] or Student D, and to the teacher as [Teacher].
- result: the raw text the laptop found or produced for that request, before any tagging, 1 to 6 sentences or short lines. It uses invented names: full names, first names alone, nicknames.

Names must not match any real class list, so invent them: rare first names (never the popular ones you reach for first) and surnames you make up by joining two word parts, like Ashdale, Quillfeather or Brambleton, never common real family names. Vary the sounds and styles across many cultures.
- result_kind, one of:
  document_list: a list of document titles
  snippet: a short excerpt from one document
  per_student: per-student work, scores or feedback
  class_aggregate: class-level numbers such as averages, counts or score spreads
  contact_info: phone numbers, emails or home addresses
  sensitive_record: a record such as an IEP, a health note, a discipline report or a custody note
  free_text: an answer, draft or message written from the documents
- topics: every topic below that the request or result is about. Use [] when none apply.
  Private topics: iep (IEP, 504 plan, special education, speech therapy), medical (diagnosis, medication, allergy, asthma, ADHD, therapist, nurse visit), discipline (suspension, detention, a behavior incident or referral), custody (custody order, court, who may pick a child up), immigration (visa, immigration status, deportation, refugee), home_address (where a student lives), parent_contact (a parent's phone or email), lunch_status (free or reduced lunch), deanonymize (the request asks to undo the tags or for a student's real name), reidentify (details that single out one student even with names tagged).
  Plain topics: grades (scores, rubric points or grades), writing (essay content, excerpts or feedback on writing), reading (reading groups or levels), attendance (absences and tardies), parents (the result is meant for parents or families), third_party (the result goes outside the class: another teacher, the principal, the district, a newsletter or a website), full_text (a whole essay or story, word for word).
- expected, what the router should do. Check these in order; the first one that fits wins:
  1. refuse: topics include any private topic, or the request asks for a real or full name.
  2. share_tagged: result_kind is document_list.
  3. ask_user: topics include parents, third_party or full_text.
  4. share_summary: result_kind is class_aggregate. Only a summary leaves the laptop.
  5. share_tagged: a per_student, snippet or free_text result whose topics include grades or writing.
  6. ask_user: anything else, such as attendance, reading groups, seating or team lists.
- names: every person name in result, exactly as written, including first names alone and nicknames. [] when there are none.
- identifiers: every identifier in result, exactly as written. [] when there are none.
- tricky: true for about one item in five that is hard on purpose: a nickname or a misspelled name, a sensitive topic said indirectly, a harmless-sounding request whose result is sensitive, or a class aggregate that names one student.
- notes: one short sentence on why expected is right.

Make the topics true. A refuse item really is about its private topic. An item that is not refuse mentions no private topic at all, not even in passing: no health, behavior, court, address, contact detail or lunch detail. A share_tagged per_student, snippet or free_text item is about grades or writing. An ask_user item is meant for parents or someone outside the class, or is a whole essay, or is about something other than grades and writing.

Identifiers are fake and appear only in refuse items. Phone numbers have a three digit area code, then 555, then four digits that start with 01. Emails use the example.com or example.org domains. Social Security numbers are three, two and four digits joined by hyphens, and the first digit is always 9. Write every identifier out in full with real digits, never a pattern or placeholder. The only card number is the standard Visa test card number (a 4 followed by fifteen 1s, in groups of four). Student ids are S followed by six digits. Street addresses use a house number and an invented street name. Items that are not refuse contain no identifiers at all."""


# text helpers


def normalize(text: str) -> str:
    """Lowercase, punctuation to spaces, whitespace collapsed."""
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text.lower()).split())


def no_em_dash(text: str) -> str:
    """House style: no em dashes in anything that may be shown to people."""
    return re.sub(r"\s*\u2014\s*", " - ", text)


def token_set(text: str) -> set[str]:
    return set(normalize(text).split())


def jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)


def name_tokens(name: str) -> set[str]:
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", name)
    return {w.lower().removesuffix("'s").strip("'-") for w in words if len(w) >= 2} - {
        "ms",
        "mr",
        "mrs",
        "dr",
    }


def load_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def write_jsonl(path: Path, items: Iterable[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as fh:
        for item in items:
            fh.write(json.dumps(item, ensure_ascii=False) + "\n")


def roster_tokens(path: Path) -> set[str]:
    """Lowercase name tokens (first, last, full names, nicknames) and student ids from roster.json."""
    if not path.is_file():
        return set()
    data = json.loads(path.read_text())
    people = [data.get("teacher"), *(data.get("students") or [])] if isinstance(data, dict) else data
    out: set[str] = set()
    for person in people or []:
        if not isinstance(person, dict):
            continue
        for key in ("name", "first", "last", "nicknames"):
            value = person.get(key)
            for s in value if isinstance(value, list) else [value]:
                if isinstance(s, str):
                    out |= name_tokens(s)
        if isinstance(person.get("student_id"), str):
            out.add(_ident_key(person["student_id"]))
    return out


# identifiers

FAKE_CARD = "4111111111111111"
FAKE_EMAIL_DOMAINS = ("example.com", "example.org")
CARD_RE = re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")
SSN_RE = re.compile(r"(?<!\d)(\d{3})-(\d{2})-(\d{4})(?!\d)")
PHONE_RE = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")
STUDENT_ID_RE = re.compile(r"\b(?:S|ID)[ -]?\d{5,8}\b")
PLACEHOLDER_RE = re.compile(r"[\d-]NN|NN[\d-]")  # a format pattern copied instead of an invented value
ADDRESS_RE = re.compile(
    r"\b\d{1,5} [A-Z][a-z]+(?: [A-Z][a-z]+)? (?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Way|Boulevard|Blvd|Place|Pl|Circle)\b"
)


def _fake_domain(domain: str) -> bool:
    domain = domain.lower()
    return any(domain == d or domain.endswith("." + d) for d in FAKE_EMAIL_DOMAINS)


def scan_identifiers(text: str) -> tuple[list[str], list[str]]:
    """(fake identifiers found, identifiers that are not in a fake range)."""
    found: list[str] = []
    bad: list[str] = []
    masked = text

    def take(pattern: re.Pattern, is_fake: Callable[[re.Match], bool]) -> None:
        nonlocal masked
        for m in pattern.finditer(masked):
            (found if is_fake(m) else bad).append(m.group(0).strip())
            masked = masked[: m.start()] + " " * (m.end() - m.start()) + masked[m.end() :]

    take(CARD_RE, lambda m: re.sub(r"\D", "", m.group(0)) == FAKE_CARD)
    take(SSN_RE, lambda m: m.group(1).startswith("9") or m.group(1) == "000")
    take(PHONE_RE, lambda m: m.group(2) == "555" and m.group(3).startswith("01"))
    take(EMAIL_RE, lambda m: _fake_domain(m.group(1)))
    take(STUDENT_ID_RE, lambda m: True)
    take(ADDRESS_RE, lambda m: True)
    return found, bad


def is_fake(kind: str, value: str) -> bool:
    """Whether a guard hit sits in a reserved fake range. Ids, addresses, dates and codes are free text."""
    digits = re.sub(r"\D", "", value)
    if kind == "phone":
        return digits[-7:-2] == "55501"
    if kind == "email":
        return _fake_domain(value.rsplit("@", 1)[-1])
    if kind == "ssn":
        return digits[:1] == "9" or digits[:3] == "000"
    if kind == "card":
        return digits == FAKE_CARD
    return True


def _ident_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def in_roster_id_block(key: str, roster: set[str]) -> bool:
    """True for an id equal to a roster student id or in its numbering block (s401275 next to s401270)."""
    return any(len(key) == len(t) and key[:4] == t[:4] for t in roster if t[:1].isalpha() and t[1:].isdigit())


# the device guard, run on what Spark wrote


@dataclass(frozen=True)
class GuardChecks:
    """base.guard bound to the roster and the policy: name hits, identifier hits, never-share topics."""

    names: Callable[[str], list]
    identifiers: Callable[[str], list]
    topics: Callable[[str], list[str]]


def make_guard(settings: Settings, never_share: dict | None) -> GuardChecks | None:
    try:
        from base import guard
    except ImportError:
        return None
    roster = guard.load_roster(settings.roster_path) if settings.roster_path.is_file() else None
    return GuardChecks(
        names=lambda text: guard.find_names(text, roster),
        identifiers=lambda text: guard.find_identifiers(text, roster),
        topics=lambda text: guard.blocked_topics(text, never_share or {}),
    )


# item checks


def clean_item(raw: dict, roster: set[str] = frozenset(), guard: GuardChecks | None = None) -> tuple[dict | None, str]:
    """Validate and tidy one Spark item. Returns (item, "ok") or (None, drop reason)."""
    request = no_em_dash(str(raw.get("request") or "")).strip()
    result = no_em_dash(str(raw.get("result") or "")).strip()
    kind = raw.get("result_kind")
    expected = raw.get("expected")
    if not request or not result:
        return None, "empty"
    if kind not in RESULT_KINDS or expected not in DECISIONS:
        return None, "bad_label"
    if PLACEHOLDER_RE.search(f"{request}\n{result}"):
        return None, "placeholder"
    topics = {t for t in raw.get("topics") or [] if t in TOPICS}
    if guard is not None:
        topics |= set(guard.topics(result))  # a never-share keyword makes its topic true
    topics = sorted(topics)
    sensitive = set(topics) & set(REFUSE_TOPICS)
    if (expected == "refuse") != bool(sensitive):
        return None, "label_topic_mismatch"
    if (expected == "share_summary") != (kind == "class_aggregate"):
        return None, "label_kind_mismatch"

    found, bad = scan_identifiers(result)
    guard_hits = list(guard.identifiers(result)) if guard is not None else []
    if bad or any(not is_fake(h.kind, h.value) for h in guard_hits):
        return None, "real_identifier"
    req_found, req_bad = scan_identifiers(request)
    if req_found or req_bad or (guard is not None and guard.identifiers(request)):
        return None, "identifier_in_request"
    identifiers: list[str] = []
    seen: set[str] = set()
    for value in [*(str(v).strip() for v in raw.get("identifiers") or []), *found, *(h.value for h in guard_hits)]:
        key = _ident_key(value)
        if value and value in result and key not in seen:
            seen.add(key)
            identifiers.append(value)
    if identifiers and expected in ("share_tagged", "share_summary"):
        return None, "identifier_floor"

    names: list[str] = []
    for value in raw.get("names") or []:
        name = str(value).strip()
        if name and name in result and not name.startswith("[") and name not in names:
            names.append(name)
    tokens: set[str] = set()
    for name in names:
        tokens |= name_tokens(name)
    request_words = {w.lower() for w in re.findall(r"[A-Za-z][A-Za-z'-]*", request)}
    if tokens & {w.removesuffix("'s") for w in request_words}:
        return None, "name_in_request"
    capitalized = {
        w.lower().removesuffix("'s") for w in re.findall(r"\b[A-Z][A-Za-z'-]+", f"{request} {result}")
    }
    if roster and ((tokens | capitalized) & roster or any(in_roster_id_block(k, roster) for k in seen)):
        return None, "roster_collision"
    if guard is not None and (guard.names(request) or guard.names(result)):
        return None, "roster_collision"

    item = {
        "request": request,
        "result": result,
        "result_kind": kind,
        "topics": topics,
        "expected": expected,
        "names": names,
        "identifiers": identifiers,
        "tricky": bool(raw.get("tricky")),
        "notes": no_em_dash(str(raw.get("notes") or "")).strip(),
        "source": "spark",
    }
    return item, "ok"


class RequestFilter:
    """Drops repeated requests and requests too close to the hand-written eval sets."""

    def __init__(self, reference: Iterable[str] = (), threshold: float = OVERLAP_JACCARD):
        self.reference = [token_set(r) for r in reference if r and r.strip()]
        self.threshold = threshold
        self.seen: set[str] = set()

    def reason(self, request: str) -> str | None:
        norm = normalize(request)
        if norm in self.seen:
            return "duplicate"
        if self.closest(request) >= self.threshold:
            return "overlaps_eval"
        return None

    def closest(self, request: str) -> float:
        tokens = token_set(request)
        return max((jaccard(tokens, ref) for ref in self.reference), default=0.0)

    def add(self, request: str) -> None:
        self.seen.add(normalize(request))


# planning and generation

Cell = tuple[str, str]


def plan_cells(count: int) -> list[Cell]:
    """count (expected, result_kind) slots: decisions round robin, kinds round robin within each."""
    used: Counter[str] = Counter()
    cells: list[Cell] = []
    for i in range(count):
        decision = DECISIONS[i % len(DECISIONS)]
        kinds = DECISION_KINDS[decision]
        cells.append((decision, kinds[used[decision] % len(kinds)]))
        used[decision] += 1
    return cells


def remaining_cells(plan: Sequence[Cell], have: Counter) -> list[Cell]:
    """The slots of `plan` not yet filled, in plan order."""
    filled = Counter(have)
    out: list[Cell] = []
    for cell in plan:
        if filled[cell] > 0:
            filled[cell] -= 1
        else:
            out.append(cell)
    return out


def batch_messages(cells: Sequence[Cell], batch_no: int, round_no: int) -> list[dict]:
    letters = string.ascii_uppercase
    start = (batch_no * 3 + round_no * 7) % 26
    initials = ", ".join(letters[(start + i) % 26] for i in range(3))
    theme = THEMES[(batch_no + round_no * 3) % len(THEMES)]
    lines = "\n".join(f"{i}. {expected}, {kind}" for i, (expected, kind) in enumerate(cells, 1))
    user = (
        f"Round {round_no}, batch {batch_no}. Theme: {theme}. Most invented first names in this batch start "
        f"with {initials}; use rare first names and made-up surnames, a fresh mix in every item.\n\n"
        f"Write exactly {len(cells)} items, in this order, with these expected and result_kind values:\n"
        f"{lines}\n\n"
        'Reply with JSON {"items": [...]}.'
    )
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]


def batch_max_tokens(n: int) -> int:
    return 500 * n + 2000


def run_batch(spark: Spark, cells: Sequence[Cell], batch_no: int, round_no: int) -> list[dict] | None:
    """One Spark call. None when the call or its JSON failed; SparkRefused is never swallowed."""
    try:
        data = spark.chat_json(
            batch_messages(cells, batch_no, round_no),
            BATCH_SCHEMA,
            max_tokens=batch_max_tokens(len(cells)),
            effort=EFFORT,
        )
    except SparkRefused:
        raise
    except SparkError:
        return None
    items = data.get("items")
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else None


def generate(
    spark: Spark,
    count: int,
    batch: int = 25,
    *,
    roster: set[str] = frozenset(),
    reference: Iterable[str] = (),
    labeler: Callable[[dict], str] | None = None,
    guard: GuardChecks | None = None,
    workers: int = 4,
    max_rounds: int = 4,
    max_calls: int | None = None,
    log: Callable[[str], None] = print,
) -> tuple[list[dict], Counter]:
    """Fill `count` evenly planned slots, re-asking for the slots still open for up to max_rounds.

    max_calls caps the Spark calls this run may make (cache hits included), as a spend limit.
    """
    plan = plan_cells(count)
    quota = Counter(plan)
    have: Counter[Cell] = Counter()
    stats: Counter[str] = Counter()
    accepted: list[dict] = []
    filt = RequestFilter(reference)

    for round_no in range(1, max_rounds + 1):
        missing = remaining_cells(plan, have)
        if not missing:
            break
        batches = [missing[i : i + batch] for i in range(0, len(missing), batch)]
        if max_calls is not None:
            batches = batches[: max(0, max_calls - stats["calls"])]
            if not batches:
                log(f"stopped: reached --max-calls {max_calls}")
                break
        stats["calls"] += len(batches)
        log(f"round {round_no}: {len(missing)} slots in {len(batches)} batches")
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            futures = [
                pool.submit(run_batch, spark, cells, n, round_no) for n, cells in enumerate(batches, 1)
            ]
            for future in futures:
                raw_items = future.result()
                if raw_items is None:
                    stats["batch_failed"] += 1
                    continue
                for raw in raw_items:
                    stats["generated"] += 1
                    item, reason = clean_item(raw, roster, guard)
                    if item is None:
                        stats[reason] += 1
                        continue
                    cell = (item["expected"], item["result_kind"])
                    if have[cell] >= quota[cell]:
                        stats["off_plan"] += 1
                        continue
                    if labeler is not None and labeler(item) != item["expected"]:
                        stats["policy_disagrees"] += 1
                        continue
                    reason = filt.reason(item["request"])
                    if reason:
                        stats[reason] += 1
                        continue
                    filt.add(item["request"])
                    have[cell] += 1
                    accepted.append(item)

    width = max(4, len(str(count)))
    items = [{"id": f"syn-{n:0{width}d}", **item} for n, item in enumerate(accepted, 1)]
    return items, stats


# checking a written file


def check_items(
    items: list[dict],
    count: int,
    *,
    roster: set[str] = frozenset(),
    reference: Iterable[str] = (),
    labeler: Callable[[dict], str] | None = None,
    guard: GuardChecks | None = None,
) -> list[tuple[str, bool, str]]:
    """(check, passed, detail) rows for a written synthetic set."""
    rows: list[tuple[str, bool, str]] = []

    def add(name: str, bad: int, detail: str) -> None:
        rows.append((name, bad == 0, detail))

    n = len(items)
    add("item count", int(n != count), f"{n} of {count}")
    add("unique ids", n - len({i.get("id") for i in items}), f"{len({i.get('id') for i in items})} unique ids")

    by_decision = Counter(i.get("expected") for i in items)
    even = count / len(DECISIONS)
    spread = max(abs(by_decision[d] - even) / even for d in DECISIONS)
    detail = ", ".join(f"{d} {by_decision[d]}" for d in DECISIONS) + f"; widest gap {spread:.1%}"
    add("decisions within 5% of even", int(spread > 0.05), detail)

    plan = Counter(plan_cells(count))
    have = Counter((i.get("expected"), i.get("result_kind")) for i in items)
    off = sum(abs(have[c] - plan[c]) for c in set(plan) | set(have))
    add("result kinds match the even plan", off, f"{off} items off the plan")

    if labeler is not None:
        bad = sum(labeler(i) != i.get("expected") for i in items)
        add("expected equals policy.wants", bad, f"{bad} items disagree with eval/user_policy.yaml")

    def core(item: dict) -> dict:  # source is skipped so a set written in the Muse app checks the same way
        return {k: v for k, v in item.items() if k not in ("id", "source")}

    again = 0
    for i in items:
        cleaned, _ = clean_item(i, roster, guard)
        if cleaned is None or core(cleaned) != core(i):
            again += 1
    add("every item passes the generator checks again", again, f"{again} items fail or change")

    if guard is not None:
        bad = sum(bool(guard.names(i["request"]) or guard.names(i["result"])) for i in items)
        add("no roster name (guard.find_names, misspellings included)", bad, f"{bad} items with a hit")
        hits = [h for i in items for h in guard.identifiers(i["result"])]
        real = sum(not is_fake(h.kind, h.value) for h in hits)
        kinds = Counter(h.kind for h in hits)
        add("every guard identifier hit is fake", real, f"{len(hits)} hits ({dict(sorted(kinds.items()))}), {real} real")
        bad = sum(bool(guard.identifiers(i["request"])) for i in items)
        add("no identifier in any request", bad, f"{bad} requests with an identifier")
        bad = sum(bool(set(guard.topics(i["result"])) - set(i.get("topics") or [])) for i in items)
        add("never-share keywords only under their topic", bad, f"{bad} items with an unlisted keyword topic")

    listed = sum(bool({t for nm in i.get("names") or [] for t in name_tokens(nm)} & roster) for i in items)
    add("no listed name on eval/roster.json", listed, f"{listed} items")
    near = sum(any(in_roster_id_block(_ident_key(v), roster) for v in i.get("identifiers") or []) for i in items)
    add("no id equal to or in the block of a roster student id", near, f"{near} items")
    bad = sum(bool(scan_identifiers(i["result"])[1]) for i in items)
    add("no identifier outside the fake ranges", bad, f"{bad} items")
    bad = sum(bool(i.get("identifiers")) for i in items if i.get("expected") in ("share_tagged", "share_summary"))
    add("no identifier in a share item", bad, f"{bad} items")

    requests = Counter(normalize(i["request"]) for i in items)
    results = Counter(normalize(i["result"]) for i in items)
    dup_req = sum(c - 1 for c in requests.values())
    dup_res = sum(c - 1 for c in results.values())
    add("no duplicate requests or results", dup_req + dup_res, f"{dup_req} repeated requests, {dup_res} repeated results")

    filt = RequestFilter(reference)
    scores = [filt.closest(i["request"]) for i in items]
    close = sum(s >= OVERLAP_JACCARD for s in scores)
    add(
        "no request with Jaccard >= 0.8 to tasks or holdout",
        close,
        f"{close} items; highest {max(scores, default=0.0):.2f} against {len(filt.reference)} requests",
    )
    return rows


def render_checks(rows: list[tuple[str, bool, str]]) -> str:
    lines = ["| Check | Result | Detail |", "|---|---|---|"]
    lines += [f"| {name} | {'pass' if ok else 'FAIL'} | {detail} |" for name, ok, detail in rows]
    return "\n".join(lines)


def load_policy(settings: Settings):
    """The UserPolicy from eval/user_policy.yaml, or None when base.policy or the file is missing."""
    if not settings.policy_path.is_file():
        return None
    try:
        from base.policy import UserPolicy
    except ImportError:
        return None
    return UserPolicy.load(settings.policy_path)


def export_usage(cache_path: Path, out: Path) -> int:
    """The spark_calls table as JSONL, so synthetic.md's token and time figures can be checked
    from a clean checkout (eval/.cache is gitignored). Numbers only, never prompts or replies."""
    import sqlite3

    cols = ("ts", "model", "prompt_tokens", "completion_tokens", "reasoning_tokens", "cached", "cached_tokens")
    with sqlite3.connect(cache_path) as con:
        rows = con.execute(f"SELECT {', '.join(cols)} FROM spark_calls ORDER BY ts").fetchall()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(dict(zip(cols, r, strict=True))) + "\n" for r in rows))
    return len(rows)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write invented eval items with Muse Spark.")
    parser.add_argument("--count", type=int, default=2000, help="items to write (default 2000)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output JSONL path")
    parser.add_argument("--batch", type=int, default=25, help="items per Spark call (default 25)")
    parser.add_argument("--workers", type=int, default=4, help="Spark calls in flight (default 4)")
    parser.add_argument("--max-calls", type=int, default=200, help="most Spark calls this run may make")
    parser.add_argument("--dry-run", action="store_true", help="print the first request body and exit")
    parser.add_argument("--check", action="store_true", help="check --out and print the results")
    parser.add_argument(
        "--export-usage",
        type=Path,
        help="write the Spark call log (time, model, token counts, cached; no text) to this JSONL and exit",
    )
    args = parser.parse_args(argv)
    if args.count < 1 or args.batch < 1:
        parser.error("--count and --batch must be positive")

    settings = load_settings()
    if args.export_usage:
        n = export_usage(Spark(settings).cache_path, args.export_usage)
        print(f"Wrote {n} Spark call rows to {args.export_usage}")
        return 0
    plan = plan_cells(args.count)
    if args.dry_run:
        cells = plan[: args.batch]
        body = Spark(settings).build_body(
            batch_messages(cells, 1, 1),
            max_tokens=batch_max_tokens(len(cells)),
            json_schema=BATCH_SCHEMA,
            effort=EFFORT,
        )
        print(json.dumps(body, indent=2, ensure_ascii=False))
        return 0

    roster = roster_tokens(settings.roster_path)
    reference = [str(item.get("request") or "") for path in REFERENCE_FILES for item in load_jsonl(path)]
    policy = load_policy(settings)
    labeler = policy.wants if policy is not None else None
    guard = make_guard(settings, policy.never_share if policy is not None else None)
    log = lambda msg: print(msg, file=sys.stderr)  # noqa: E731

    if args.check:
        items = load_jsonl(args.out)
        rows = check_items(items, args.count, roster=roster, reference=reference, labeler=labeler, guard=guard)
        print(render_checks(rows))
        print()
        cells = Counter((i["expected"], i["result_kind"]) for i in items)
        print("| expected | result_kind | items |\n|---|---|---|")
        print("\n".join(f"| {d} | {k} | {n} |" for (d, k), n in sorted(cells.items())))
        print(f"\ntricky: {sum(bool(i.get('tricky')) for i in items)} of {len(items)}")
        return 0 if all(ok for _, ok, _ in rows) else 1

    log(
        f"roster tokens: {len(roster)}; reference requests: {len(reference)}; "
        f"policy check: {'on' if labeler else 'off'}; guard check: {'on' if guard else 'off'}"
    )
    spark = Spark(settings)
    started = time.time()
    try:
        items, stats = generate(
            spark,
            args.count,
            args.batch,
            roster=roster,
            reference=reference,
            labeler=labeler,
            guard=guard,
            workers=args.workers,
            max_calls=args.max_calls,
            log=log,
        )
    except SparkRefused as exc:
        log(f"stopped: {exc}")
        return 2
    write_jsonl(args.out, items)

    by_decision = Counter(i["expected"] for i in items)
    by_kind = Counter(i["result_kind"] for i in items)
    usage = usage_summary(spark.cache_path, since=started)
    log(f"wrote {len(items)} of {args.count} items to {args.out}")
    log("by decision: " + json.dumps(dict(sorted(by_decision.items()))))
    log("by result_kind: " + json.dumps(dict(sorted(by_kind.items()))))
    log("filter: " + json.dumps(dict(sorted(stats.items()))))
    log("spark usage: " + json.dumps(usage))
    return 0 if len(items) == args.count else 1


if __name__ == "__main__":
    raise SystemExit(main())
