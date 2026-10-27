"""Write invented eval items with Muse Spark: eval/synthetic.jsonl.

    uv run python -m scripts.make_synthetic --count 2000
    uv run python -m scripts.make_synthetic --dry-run

Spark writes batches of items (strict json_schema, reasoning effort low) spread evenly over the
four decisions and the result kinds. Every item is checked here before it is kept: fake
identifiers only, no name in the request, no collision with eval/roster.json, labels that match
the topic meanings in docs/CONTRACTS.md, no duplicate requests, and no request too close (token
Jaccard >= 0.8) to one in eval/tasks.jsonl or eval/holdout.jsonl.
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
from pathlib import Path

from base.config import REPO_ROOT, Settings, load_settings
from base.spark import Spark, SparkError, SparkRefused, usage_summary
from base.types import DECISIONS

DEFAULT_OUT = REPO_ROOT / "eval" / "synthetic.jsonl"
REFERENCE_FILES = (REPO_ROOT / "eval" / "tasks.jsonl", REPO_ROOT / "eval" / "holdout.jsonl")
OVERLAP_JACCARD = 0.8
EFFORT = "low"

REFUSE_TOPICS = (
    "iep",
    "medical",
    "discipline",
    "custody",
    "immigration",
    "home_address",
    "parent_contact",
    "lunch_status",
)
TOPICS = (*REFUSE_TOPICS, "grades")

# Which result kinds each decision is spread over. dreaming_report and document_list are on the
# router's rule path, but they still belong in the data so the share_tagged side looks real.
DECISION_KINDS: dict[str, tuple[str, ...]] = {
    "share_tagged": ("per_student", "snippet", "document_list", "free_text", "dreaming_report"),
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
# guard would flag (Spark refuses such input).
SYSTEM_PROMPT = """You write invented test data for a privacy router. The router runs on a 4th-grade teacher's own laptop. A cloud assistant (Muse) sends requests that name students only by tags, and the laptop decides what each result may send back.

Every person, school, address and identifier you write is invented. Never use the name of a real or famous person.

Each item has these fields:
- request: what the cloud assistant asked for, one or two sentences. It never contains a person's name. It refers to students only by tags such as [Student A] or Student D, and to the teacher as [Teacher].
- result: the raw text the laptop found or produced for that request, before any tagging, 1 to 6 sentences or short lines. It uses invented, ordinary-looking names: full names, first names alone, nicknames.
- result_kind, one of:
  document_list: a list of document titles
  snippet: a short excerpt from one document
  per_student: per-student work, scores or feedback
  class_aggregate: class-level numbers such as averages, counts or score spreads
  contact_info: phone numbers, emails or home addresses
  sensitive_record: a record such as an IEP, a health note, a discipline report or a custody note
  free_text: an answer, draft or message written from the documents
  dreaming_report: numbers from the nightly learning job (no names)
- topics: the topics the result mentions, from this list: iep (IEP, 504 plan, special education, speech therapy), medical (diagnosis, medication, allergy, asthma, ADHD, therapist), discipline (suspension, detention, behavior incident), custody (custody order, court, who may pick a child up), immigration (visa, immigration status, deportation), home_address (where a student lives), parent_contact (a parent's phone or email), lunch_status (free or reduced lunch), grades (scores or grades). Use [] when none apply.
- expected, what the router should do with the result:
  refuse: the result mentions iep, medical, discipline, custody, immigration, home_address, parent_contact or lunch_status. topics names at least one of these.
  share_summary: class-level aggregates. result_kind is class_aggregate and only a summary leaves the laptop. None of the refuse topics.
  ask_user: the result would go to a third party (an email or message to a parent, another teacher, a newsletter or a website), or the request wants a student's full text (a whole essay or story). None of the refuse topics.
  share_tagged: ordinary per-student work that is fine to share once names become tags: scores, rubric feedback, short snippets, document lists. None of the refuse topics.
- names: every person name in result, exactly as written, including first names alone and nicknames. [] when there are none.
- identifiers: every identifier in result, exactly as written. [] when there are none.
- tricky: true for about one item in five that is hard on purpose: a nickname or a misspelled name, a sensitive topic said indirectly, a harmless-sounding request whose result is sensitive, or a class aggregate that names one student.
- notes: one short sentence on why expected is right.

Identifiers are fake and appear only in refuse or ask_user items. Phone numbers look like (512) 555-01NN where NN is two digits. Emails use the example.com or example.org domains. Social Security numbers start with 9, like 9NN-NN-NNNN. The only card number is the standard Visa test card number (a 4 followed by fifteen 1s, in groups of four). Student ids are S followed by six digits. Street addresses use a house number and an invented street name. share_tagged and share_summary items contain no identifiers at all."""


# text helpers


def normalize(text: str) -> str:
    """Lowercase, punctuation to spaces, whitespace collapsed."""
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text.lower()).split())


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
    """Lowercase name tokens (first, last, full names, nicknames) of everyone in roster.json."""
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
    return out


# identifiers

FAKE_CARD = "4111111111111111"
FAKE_EMAIL_DOMAINS = ("example.com", "example.org")
CARD_RE = re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")
SSN_RE = re.compile(r"(?<!\d)(\d{3})-(\d{2})-(\d{4})(?!\d)")
PHONE_RE = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")
STUDENT_ID_RE = re.compile(r"\b(?:S|ID)[ -]?\d{5,8}\b")
ADDRESS_RE = re.compile(
    r"\b\d{1,5} [A-Z][a-z]+(?: [A-Z][a-z]+)? (?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Way|Boulevard|Blvd|Place|Pl|Circle)\b"
)


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
    take(
        EMAIL_RE,
        lambda m: any(
            m.group(1).lower() == d or m.group(1).lower().endswith("." + d) for d in FAKE_EMAIL_DOMAINS
        ),
    )
    take(STUDENT_ID_RE, lambda m: True)
    take(ADDRESS_RE, lambda m: True)
    return found, bad


def _ident_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


# item checks


def clean_item(raw: dict, roster: set[str] = frozenset()) -> tuple[dict | None, str]:
    """Validate and tidy one Spark item. Returns (item, "ok") or (None, drop reason)."""
    request = str(raw.get("request") or "").strip()
    result = str(raw.get("result") or "").strip()
    kind = raw.get("result_kind")
    expected = raw.get("expected")
    if not request or not result:
        return None, "empty"
    if kind not in RESULT_KINDS or expected not in DECISIONS:
        return None, "bad_label"
    topics = sorted({t for t in raw.get("topics") or [] if t in TOPICS})
    sensitive = set(topics) & set(REFUSE_TOPICS)
    if (expected == "refuse") != bool(sensitive):
        return None, "label_topic_mismatch"
    if (expected == "share_summary") != (kind == "class_aggregate"):
        return None, "label_kind_mismatch"

    found, bad = scan_identifiers(result)
    if bad:
        return None, "real_identifier"
    req_found, req_bad = scan_identifiers(request)
    if req_found or req_bad:
        return None, "identifier_in_request"
    identifiers: list[str] = []
    seen: set[str] = set()
    for value in [*(str(v).strip() for v in raw.get("identifiers") or []), *found]:
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
    if roster and (tokens | capitalized) & roster:
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
        "notes": str(raw.get("notes") or "").strip(),
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
        tokens = set(norm.split())
        if any(jaccard(tokens, ref) >= self.threshold for ref in self.reference):
            return "overlaps_eval"
        return None

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
        f"with {initials}; use a fresh mix of first and last names from many cultures.\n\n"
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
    workers: int = 4,
    max_rounds: int = 4,
    log: Callable[[str], None] = print,
) -> tuple[list[dict], Counter]:
    """Fill `count` evenly planned slots, re-asking for the slots still open for up to max_rounds."""
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
                    item, reason = clean_item(raw, roster)
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


def make_labeler(settings: Settings) -> Callable[[dict], str] | None:
    """policy.wants from eval/user_policy.yaml when base.policy and the file exist."""
    if not settings.policy_path.is_file():
        return None
    try:
        from base.policy import UserPolicy
    except ImportError:
        return None
    return UserPolicy.load(settings.policy_path).wants


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write invented eval items with Muse Spark.")
    parser.add_argument("--count", type=int, default=2000, help="items to write (default 2000)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output JSONL path")
    parser.add_argument("--batch", type=int, default=25, help="items per Spark call (default 25)")
    parser.add_argument("--workers", type=int, default=4, help="Spark calls in flight (default 4)")
    parser.add_argument("--dry-run", action="store_true", help="print the first request body and exit")
    args = parser.parse_args(argv)
    if args.count < 1 or args.batch < 1:
        parser.error("--count and --batch must be positive")

    settings = load_settings()
    spark = Spark(settings)
    plan = plan_cells(args.count)
    if args.dry_run:
        cells = plan[: args.batch]
        body = spark.build_body(
            batch_messages(cells, 1, 1),
            max_tokens=batch_max_tokens(len(cells)),
            json_schema=BATCH_SCHEMA,
            effort=EFFORT,
        )
        print(json.dumps(body, indent=2, ensure_ascii=False))
        return 0

    roster = roster_tokens(settings.roster_path)
    reference = [str(item.get("request") or "") for path in REFERENCE_FILES for item in load_jsonl(path)]
    labeler = make_labeler(settings)
    log = lambda msg: print(msg, file=sys.stderr)  # noqa: E731
    log(
        f"roster names: {len(roster)} tokens; reference requests: {len(reference)}; "
        f"policy check: {'on' if labeler else 'off'}"
    )
    started = time.time()
    try:
        items, stats = generate(
            spark,
            args.count,
            args.batch,
            roster=roster,
            reference=reference,
            labeler=labeler,
            workers=args.workers,
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
