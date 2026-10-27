"""Privacy router eval: send each invented item through egress and score what would leave.

    uv run python -m eval.run_eval --set eval/tasks.jsonl --name NAME [--holdout] [--limit N] [--rules PATH|none]

Every run gets a fresh temporary BASE_HOME, so it never touches the real decision log, unless
--home is given. Writes eval/reports/NAME.md (exact command at the top) and
eval/reports/raw/NAME.jsonl (ids, decisions and the policy topic names egress routed on, never
the result or request text).
"""

from __future__ import annotations

import argparse
import inspect
import json
import math
import re
import shlex
import shutil
import sys
import tempfile
import time
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path

from base import guard
from base.config import REPO_ROOT, load_settings
from base.types import DECISIONS
from base.workspace.agent import GRADING_WORDS, TOPICS_GRADING

EVAL_DIR = Path(__file__).resolve().parent
REPORTS_DIR = EVAL_DIR / "reports"
DEFAULT_HOLDOUT = EVAL_DIR / "holdout.jsonl"
SUMMARY_KEYS = (
    "n", "accuracy", "agreement", "approval_requests", "leaks", "held", "errors", "fallbacks",
    "outcome_accuracy", "latency_mean_ms", "latency_p95_ms", "tokens",
)  # fmt: skip

# What the connector really sends for each eval kind. The device never builds sensitive_record,
# contact_info or class_aggregate results: a search sends "snippet" and a private task's answer
# is "free_text". per_student depends on the item (production_labels). The labeled kind and
# topics are for scoring only, unless --oracle-labels.
PRODUCTION_KIND = {"sensitive_record": "snippet", "contact_info": "snippet", "class_aggregate": "free_text"}
# The agent emits per_student only from the grading job, which always attaches TOPICS_GRADING
# (base/workspace/agent.py). It grades when Muse's instructions match GRADING_WORDS and the folder
# has a rubric; the eval's essays folder always has one, so the words decide. Anything else comes
# back from the generic map-reduce path as free_text with no job topics.
# What Muse gets, per expected decision: shared text, a wait for the OK, or a kept message.
OUTCOME_FOR = {"share_tagged": "shared", "share_summary": "shared", "ask_user": "waiting", "refuse": "refused"}
# A gate run with more items than this share of errors and fallbacks says nothing about the rules.
MAX_UNSCORED_SHARE = 0.10


@dataclass
class EvalReport:
    name: str
    device: str = ""
    backend: str = ""
    model: str = ""
    date: str = ""
    command: str = ""
    rules: str = "none"
    labels: str = "production"  # production: kind and topics as the connector sends them; oracle: hand labels
    n: int = 0
    correct: int = 0
    accuracy: float = 0.0
    agreement: float = 0.0
    approval_requests: int = 0
    leaks: int = 0  # items whose released text leaked anything
    held: int = 0  # items the final leak check held back after the router let them through
    errors: int = 0  # items that raised
    fallbacks: int = 0  # the router or a check could not run (model down): never counted correct
    outcome_accuracy: float = 0.0  # what Muse received (shared, waiting, refused) matched the expected one
    sources: dict[str, int] = field(default_factory=dict)  # model, rule, fallback, error
    approved_checked: int = 0  # waiting items the simulated teacher approved, resolved and leak-checked
    latency_mean_ms: float = 0.0
    latency_p95_ms: float = 0.0
    model_calls: int = 0  # items the router sent to the model (source "model" or "fallback")
    model_latency_mean_ms: float = 0.0  # router latency over those items only
    model_latency_p95_ms: float = 0.0
    tokens: int | None = None
    categories: dict[str, dict] = field(default_factory=dict)  # expected decision -> scores
    confusion: dict[str, dict[str, int]] = field(default_factory=dict)  # expected -> decided -> count
    rows: list[dict] = field(default_factory=list)

    def category_accuracy(self) -> dict[str, float]:
        return {cat: scores["accuracy"] for cat, scores in self.categories.items()}

    def unscored_share(self) -> float:
        """Share of items that raised or fell back, so their decision says nothing."""
        return (self.errors + self.fallbacks) / self.n if self.n else 0.0

    def summary(self) -> dict:
        """Aggregate numbers only."""
        return {k: getattr(self, k) for k in SUMMARY_KEYS} | {"categories": self.category_accuracy()}


# ----- items and services -----


def load_items(path: str | Path) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def prepare_home(settings, home: str | Path, rules_path: str | Path | None = None):
    """Settings pointed at `home`, with `rules_path` copied in as the router's learned rules."""
    s = replace(settings, home=Path(home))
    s.ensure_home()
    if rules_path is not None:
        shutil.copyfile(rules_path, s.paths.router_prompt)
    return s


def services_for(settings, home: str | Path, rules_path: str | Path | None = None):
    """Wire services for `home` (no light, no heavy queue). With rules_path None, whatever rules
    file the home has is used."""
    from base.services import Services

    return Services.for_eval(prepare_home(settings, home, rules_path))


def evaluate(
    settings,
    items: list[dict],
    *,
    rules_path: str | Path | None = None,
    name: str,
    device_label: str | None = None,
    command: str = "",
    oracle: bool = False,
) -> EvalReport:
    """Run the eval in a fresh temporary home with `rules_path` (None for no learned rules).

    The home is thrown away, so approval requests are answered by the simulated teacher and the
    text an approval would release is leak-checked too.
    """
    with tempfile.TemporaryDirectory(prefix="base-eval-") as tmp:
        services = services_for(settings, Path(tmp) / "home", rules_path)
        try:
            return run(
                services,
                items,
                name=name,
                device_label=device_label or settings.device,
                command=command or f"eval.run_eval.evaluate(name={name!r})",
                rules=describe_rules(rules_path),
                oracle=oracle,
                check_approved=True,
            )
        finally:
            close = getattr(services, "close", None)
            if callable(close):
                close()


def production_labels(item: Mapping) -> tuple[str, list[str]]:
    """The result kind and job topics the connector would send with this item's result.

    A per_student item whose request has a grading word (agent.GRADING_WORDS: grade, feedback,
    score, rubric) is the grading job's table (per_student, with TOPICS_GRADING, as the agent
    always attaches them), whatever its hand labels say; any other per_student item ("What did
    the grader say", attendance, reading groups) is the generic path's free_text with no job
    topics. Other kinds map through PRODUCTION_KIND, with no job topics.
    """
    kind = item["result_kind"]
    if kind == "per_student":
        if GRADING_WORDS.search(item.get("request") or ""):
            return "per_student", list(TOPICS_GRADING)
        return "free_text", []
    return PRODUCTION_KIND.get(kind, kind), []


def release_item(services, item: Mapping, *, tool: str = "eval", day: int | None = None, oracle: bool = False):
    """Send one invented eval item through egress, the way a connector tool result goes.

    By default the router gets only what production gives it (production_labels): the kind the
    connector would send, the job's own topics where the agent attaches them (the grading job's
    per-student table) and a summary only for per_student. Egress then adds what the device finds
    itself, as in production: never-share keywords in the result and in Muse's request, and the
    device model's labels for the policy's request topics.

    A snippet item's `request` stays the item's sentence. It stands for search_documents' query
    plus its optional `purpose` (egress sees "<query>\\nPurpose: <purpose>"), so it assumes Muse
    fills in purpose; a search without one gives egress the search words only.

    `oracle=True` passes the hand-labeled kind and topics instead (egress still adds its own), for
    comparison with earlier reports only.
    """
    release = services.egress.release
    if oracle:
        kind, topics, summary = item["result_kind"], list(item.get("topics") or []), item.get("summary")
    else:
        kind, topics = production_labels(item)
        summary = item.get("summary") if kind == "per_student" else None
    kwargs = {
        "tool": tool,
        "request": item["request"],
        "raw_text": item["result"],
        "result_kind": kind,
        "summary": summary,
        "topics": topics,
        "item_id": item["id"],
    }
    if day is not None:
        kwargs["day"] = day
    if _accepts(release, "synthetic"):
        kwargs["synthetic"] = True  # eval items are invented
    return release(**kwargs)


# ----- scoring -----


def run(
    services,
    items: Iterable[Mapping],
    *,
    name: str,
    device_label: str,
    command: str = "",
    rules: str = "none",
    oracle: bool = False,
    check_approved: bool = False,
) -> EvalReport:
    """Score every item. `check_approved` answers each approval request as the simulated teacher
    would and leak-checks what an approval releases; only for a throwaway home, since it decides
    rows in the decision log."""
    settings = services.settings
    roster_values = _roster_values(getattr(services, "roster", None))
    names = policy_topic_names(getattr(services, "policy", None))
    router = getattr(services, "router", None)
    if router is not None:
        services.router = RouterTap(router)  # egress reads services.router on every release
    try:
        rows = [
            _score(services, item, roster_values, names, oracle=oracle, check_approved=check_approved)
            for item in items
        ]
    finally:
        if router is not None:
            services.router = router
    return _report(
        rows,
        name=name,
        device=device_label,
        backend=settings.glimmer_backend,
        model=settings.router_model,
        command=command,
        rules=rules,
        labels="oracle" if oracle else "production",
    )


def find_leaks(services, text: str, item: Mapping, roster_values: Iterable[str]) -> list[str]:
    """Kinds of private values found in `text` (never the values themselves).

    `other_names` are people who are not on the roster (siblings, guardians, staff): they count
    as a leak too. `dates` are plain calendar dates and do not.
    """
    found = set()
    for kind, values in (
        ("name", item.get("names") or []),
        ("other_name", item.get("other_names") or []),
        ("identifier", item.get("identifiers") or []),
        ("roster", roster_values),
    ):
        if any(v and _contains(text, v) for v in values):
            found.add(kind)
    found.update(f"guard:{hit.kind}" for hit in _guard_leaks(services, text))
    return sorted(found)


class RouterTap:
    """Forwards to the router and keeps the last RouteInput egress routed, so a row can say which
    topics egress used and the dreaming gate can compare two rule files item by item."""

    def __init__(self, router):
        self.router = router
        self.last = None

    def __getattr__(self, name):
        return getattr(self.router, name)

    def decide(self, inp, *args, **kw):
        self.last = inp
        return self.router.decide(inp, *args, **kw)


def policy_topic_names(policy) -> frozenset[str]:
    """Every topic name the policy defines (never-share, request and rule topics): the only topic
    strings a raw row may carry."""
    from base.dreaming import train

    return train.relevant_topics(policy) or frozenset()


def _score(
    services,
    item: Mapping,
    roster_values: list[str],
    topic_names: frozenset[str] = frozenset(),
    *,
    oracle: bool = False,
    check_approved: bool = False,
) -> dict:
    row = {"id": item["id"], "expected": item["expected"], "wants": services.policy.wants(item)}
    tap = getattr(services, "router", None)
    tap = tap if isinstance(tap, RouterTap) else None
    if tap is not None:
        tap.last = None
    start = _now_ms()
    try:
        released = release_item(services, item, oracle=oracle)
    except Exception as exc:  # one failed item must not end a 100-item run
        row.update(decision="error", status="error", source="error", floors=[], leaked=False, leak_kinds=[])
        row.update(fallback=False, latency_ms=_now_ms() - start, error=type(exc).__name__, topics=None)
        row["route_input"] = None
        return row
    # What egress routed on, or None when a check held the result before the router ran. The
    # RouteInput stays in memory for the gate; raw rows get only the policy's topic names.
    inp = tap.last if tap is not None else None
    row["route_input"] = inp
    row["topics"] = None if inp is None else [t for t in getattr(inp, "topics", None) or () if t in topic_names]
    rd = released.decision
    decision = getattr(rd, "decision", rd)
    latency = getattr(rd, "latency_ms", None)
    floors = list(getattr(rd, "floors", None) or [])
    source = getattr(rd, "source", None)
    kinds = find_leaks(services, released.text or "", item, roster_values)
    row.update(
        decision=decision,
        status=released.status,
        source=source,
        floors=floors,
        # The router or the name check could not run (model down or busy): the decision is the
        # fallback's, not the router's, so it is never counted as correct.
        fallback=source == "fallback" or "name_check" in floors or bool(getattr(released, "retryable", False)),
        leaked=bool(kinds),
        leak_kinds=kinds,
        latency_ms=int(latency if latency is not None else _now_ms() - start),
    )
    resolve = getattr(services.egress, "resolve", None)
    if check_approved and callable(resolve) and released.status == "waiting" and released.approval_id is not None:
        approve, remember = services.policy.answer(item)
        if approve:  # what Muse would get once the teacher says OK
            services.approvals.decide(released.approval_id, True, remember, by="policy_sim")
            after_kinds = find_leaks(services, resolve(released.approval_id).text or "", item, roster_values)
            row["approved_checked"] = True
            row["leak_kinds_after_approval"] = after_kinds
            row["leaked"] = row["leaked"] or bool(after_kinds)
    tokens = getattr(rd, "tokens", None)
    if isinstance(tokens, int):
        row["tokens"] = tokens
    return row


def _ok(r: dict, target: str) -> bool:
    """The router decided `target`, and really decided it (not a fallback)."""
    return r["decision"] == target and not r.get("fallback")


def _report(rows: list[dict], **meta) -> EvalReport:
    n = len(rows)
    correct = sum(_ok(r, r["expected"]) for r in rows)
    categories = {}
    for cat in list(DECISIONS) + sorted({r["expected"] for r in rows} - set(DECISIONS)):
        rs = [r for r in rows if r["expected"] == cat]
        if rs:
            categories[cat] = {
                "n": len(rs),
                "correct": sum(_ok(r, cat) for r in rs),
                "accuracy": _ratio(sum(_ok(r, cat) for r in rs), len(rs)),
                "agreement": _ratio(sum(_ok(r, r["wants"]) for r in rs), len(rs)),
                "approval_requests": sum(r["decision"] == "ask_user" for r in rs),
                "leaks": sum(r["leaked"] for r in rs),
            }
    confusion: dict[str, dict[str, int]] = {}
    for r in rows:
        confusion.setdefault(r["expected"], {}).setdefault(r["decision"], 0)
        confusion[r["expected"]][r["decision"]] += 1
    latencies = sorted(r["latency_ms"] for r in rows if r["decision"] != "error")
    model_latencies = sorted(r["latency_ms"] for r in rows if r.get("source") in ("model", "fallback"))
    tokens = [r["tokens"] for r in rows if "tokens" in r]
    return EvalReport(
        date=datetime.now().strftime("%Y-%m-%d %H:%M"),
        n=n,
        correct=correct,
        accuracy=_ratio(correct, n),
        agreement=_ratio(sum(_ok(r, r["wants"]) for r in rows), n),
        approval_requests=sum(r["decision"] == "ask_user" for r in rows),
        leaks=sum(r["leaked"] for r in rows),
        held=sum(r["status"] == "refused" and r["decision"] != "refuse" for r in rows),
        errors=sum(r["decision"] == "error" for r in rows),
        fallbacks=sum(bool(r.get("fallback")) for r in rows),
        outcome_accuracy=_ratio(
            sum(r["status"] == OUTCOME_FOR.get(r["expected"]) and not r.get("fallback") for r in rows), n
        ),
        sources=dict(sorted(Counter(("fallback" if r.get("fallback") else r.get("source")) or "none" for r in rows).items())),
        approved_checked=sum(bool(r.get("approved_checked")) for r in rows),
        latency_mean_ms=_mean(latencies),
        latency_p95_ms=float(_p95(latencies)),
        model_calls=len(model_latencies),
        model_latency_mean_ms=_mean(model_latencies),
        model_latency_p95_ms=float(_p95(model_latencies)),
        tokens=sum(tokens) if tokens else None,
        categories=categories,
        confusion=confusion,
        rows=rows,
        **meta,
    )


# ----- writing -----


def write_report(report: EvalReport, out_dir: str | Path = REPORTS_DIR) -> tuple[Path, Path]:
    out_dir = Path(out_dir)
    (out_dir / "raw").mkdir(parents=True, exist_ok=True)
    md_path = out_dir / f"{report.name}.md"
    raw_path = out_dir / "raw" / f"{report.name}.jsonl"
    md_path.write_text(render_markdown(report))
    write_raw_rows(report, raw_path)
    return md_path, raw_path


def write_raw_rows(report: EvalReport, path: str | Path) -> None:
    """One JSON line per item: ids, decisions, leak kinds and the policy topic names egress routed
    on (None when a check held the result before the router), never the result or request text."""
    keep = (
        "id", "expected", "wants", "decision", "status", "source", "floors", "fallback",
        "leaked", "leak_kinds", "leak_kinds_after_approval", "topics",
    )  # fmt: skip
    with Path(path).open("w") as f:
        for r in report.rows:
            out = {k: r.get(k) for k in keep} | {"latency_ms": r.get("latency_ms")}
            for extra in ("error", "reused"):  # reused: a gate row copied from the current rules' run
                if extra in r:
                    out[extra] = r[extra]
            f.write(json.dumps(out) + "\n")


def rescore(rows: list[dict], like: EvalReport, **meta) -> EvalReport:
    """A report over `rows` (as run() makes them), with `like`'s name, device, backend, model,
    command, rules and labels unless `meta` gives others. The dreaming gate merges two runs this way."""
    base = {k: getattr(like, k) for k in ("name", "device", "backend", "model", "command", "rules", "labels")}
    return _report(list(rows), **(base | meta))


def render_markdown(r: EvalReport) -> str:
    pct = _pct
    lines = [
        f"# Eval report: {r.name}",
        "",
        f"Command: `{r.command}`",
        "",
        "| Field | Value |",
        "|---|---|",
        f"| Device | {r.device} |",
        f"| Backend | {r.backend} |",
        f"| Model | {r.model} |",
        f"| Date | {r.date} |",
        f"| Items | {r.n} |",
        f"| Learned rules | {r.rules} |",
        f"| Router inputs | {LABELS_TEXT.get(r.labels, r.labels)} |",
        "",
        "## Overall",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Decision accuracy | {pct(r.accuracy)} ({r.correct} of {r.n}) |",
        f"| Agreement with the teacher's policy | {pct(r.agreement)} |",
        f"| Approval requests | {r.approval_requests} |",
        f"| Leaks | {r.leaks} |",
        f"| Held by the final leak check | {r.held} |",
        f"| Errors | {r.errors} |",
        f"| Fallbacks (model or check could not run; never counted correct) | {r.fallbacks} |",
        f"| Outcome accuracy (what Muse got: shared, waiting or kept) | {pct(r.outcome_accuracy)} |",
        f"| Approvals the simulated teacher gave, leak-checked after release | {r.approved_checked} |",
        f"| Decided by | {', '.join(f'{k} {v}' for k, v in r.sources.items()) or 'nothing'} |",
        f"| Router latency, mean | {r.latency_mean_ms:.0f} ms |",
        f"| Router latency, p95 | {r.latency_p95_ms:.0f} ms |",
        f"| Items decided by the model | {r.model_calls} (the rest took a rule path with no model call) |",
        f"| Router latency on those items, mean | {r.model_latency_mean_ms:.0f} ms |",
        f"| Router latency on those items, p95 | {r.model_latency_p95_ms:.0f} ms |",
        f"| Tokens | {r.tokens if r.tokens is not None else 'not reported'} |",
        "",
        "## By category",
        "",
        "Category is the expected decision for the item.",
        "",
        "| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |",
        "|---|---|---|---|---|---|---|",
    ]
    for cat, s in r.categories.items():
        lines.append(
            f"| {cat} | {s['n']} | {s['correct']} | {pct(s['accuracy'])} | {pct(s['agreement'])} "
            f"| {s['approval_requests']} | {s['leaks']} |"
        )
    decided = list(DECISIONS) + sorted({d for c in r.confusion.values() for d in c} - set(DECISIONS))
    lines += [
        "",
        "## Expected and decided",
        "",
        "Rows are the expected decision, columns what the router decided.",
        "",
        "| Expected | " + " | ".join(decided) + " |",
        "|---|" + "---|" * len(decided),
    ]
    for cat in r.confusion:
        lines.append(f"| {cat} | " + " | ".join(str(r.confusion[cat].get(d, 0)) for d in decided) + " |")
    lines += ["", f"Raw rows: raw/{r.name}.jsonl next to this report (ids and decisions only, no result text).", ""]
    return "\n".join(lines)


LABELS_TEXT = {
    "production": (
        "as the connector sends them: kind mapped to what the device emits and the grading job's topics on "
        "per-student grades; topics also from never-share keywords in the result and in Muse's request, and "
        "from the device model's labels for the policy's request topics (when it has any)"
    ),
    "oracle": (
        "hand labels (kind and topics from the item, which production never has), plus the topics egress finds "
        "itself (keywords and the device model's request-topic labels): for comparison only"
    ),
}


def describe_rules(path: str | Path | None) -> str:
    if path is None or not Path(path).is_file():
        return "none"
    count = sum(1 for line in Path(path).read_text().splitlines() if line.startswith("- "))
    return f"{Path(path).name} ({count} rules)"


def display_path(arg: str | Path) -> str:
    """An absolute path shown relative to the repo, or under ~, so reports never carry a username."""
    p = Path(arg)
    if p.is_absolute():
        if p.is_relative_to(REPO_ROOT):
            return str(p.relative_to(REPO_ROOT))
        if p.is_relative_to(Path.home()):
            return "~/" + str(p.relative_to(Path.home()))
    return str(arg)


def command_line(module: str, argv: list[str]) -> str:
    """The command as typed, for the top of a report."""
    return f"uv run python -m {module} " + shlex.join(display_path(a) for a in argv)


def format_summary(r: EvalReport) -> str:
    return (
        f"{r.name}: accuracy {_pct(r.accuracy)}, agreement {_pct(r.agreement)}, "
        f"approval requests {r.approval_requests}, leaks {r.leaks}, errors {r.errors}, fallbacks {r.fallbacks}, "
        f"p95 {r.latency_p95_ms:.0f} ms over {r.n} items"
    )


# ----- CLI -----


def main(argv: list[str] | None = None, settings=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = argparse.ArgumentParser(prog="python -m eval.run_eval", description="Score the privacy router.")
    p.add_argument("--set", required=True, type=Path, help="JSONL file of eval items")
    p.add_argument("--name", required=True, help="report name, used for the file names")
    p.add_argument("--holdout", action="store_true", help="score only the holdout items")
    p.add_argument("--holdout-file", type=Path, default=DEFAULT_HOLDOUT, help="ids for --holdout")
    p.add_argument("--limit", type=int, help="score only the first N items")
    home = p.add_mutually_exclusive_group()
    home.add_argument("--rules", default="none", help="learned rules file for the router, or none")
    home.add_argument("--home", type=Path, help="use this BASE_HOME as it is instead of a fresh one")
    p.add_argument("--device-label", help="device name for the report (default BASE_DEVICE)")
    p.add_argument(
        "--oracle-labels",
        action="store_true",
        help="give the router the items' hand-labeled kind and topics (earlier reports did); not what production sees",
    )
    p.add_argument("--out", type=Path, default=REPORTS_DIR, help="reports folder")
    args = p.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", args.name):
        p.error("--name may use letters, digits, dot, dash and underscore only")

    settings = settings or load_settings()
    items = load_items(args.set)
    if args.holdout:
        ids = {i["id"] for i in load_items(args.holdout_file)}
        items = [i for i in items if i["id"] in ids]
    if args.limit:
        items = items[: args.limit]
    label = args.device_label or settings.device
    command = command_line("eval.run_eval", argv)

    if args.home:
        services = services_for(settings, args.home)
        rules = describe_rules(services.settings.paths.router_prompt)
        report = run(
            services, items, name=args.name, device_label=label, command=command, rules=rules, oracle=args.oracle_labels
        )
    else:
        rules_path = None if args.rules.lower() == "none" else Path(args.rules)
        if rules_path is not None and not rules_path.is_file():
            p.error(f"no rules file at {args.rules}")
        report = evaluate(
            settings,
            items,
            rules_path=rules_path,
            name=args.name,
            device_label=label,
            command=command,
            oracle=args.oracle_labels,
        )
    md_path, raw_path = write_report(report, args.out)
    print(format_summary(report))
    print(f"Wrote {display_path(md_path)} and {display_path(raw_path)}")
    if report.fallbacks or report.errors:
        print(f"{report.errors + report.fallbacks} item(s) could not be scored; see the report.", file=sys.stderr)
        return 2
    return 0


# ----- helpers -----


def _roster_values(roster) -> list[str]:
    if roster is None:
        return []
    values = []
    for person in roster.people():
        values.append(person.name)
        values.extend(person.nicknames)
    return [v for v in dict.fromkeys(values) if v]


def _guard_leaks(services, text: str) -> list:
    guard = getattr(services, "guard", None)
    if guard is None:
        from base import guard
    return list(guard.leaks(text, services.roster, services.tagmap))


def _contains(text: str, value: str) -> bool:
    """Whether `value` appears in `text` as a whole word, any case. A one-word value that is also
    a common word ("Rose", "Grace") counts only where the text capitalizes it, the same rule
    guard.tag uses, so "the average rose" is not scored as a leak of the student Rose."""
    common = " " not in value.strip() and guard._is_common(value.strip())
    for m in re.finditer(rf"(?<!\w){re.escape(value)}(?!\w)", text, flags=re.IGNORECASE):
        if not common or text[m.start()].isupper():
            return True
    return False


def _accepts(fn, name: str) -> bool:
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    return name in params


def _mean(values: list[int]) -> float:
    return round(sum(values) / len(values), 1) if values else 0.0


def _ratio(num: int, den: int) -> float:
    return round(num / den, 4) if den else 0.0


def _p95(sorted_values: list[int]) -> int:
    if not sorted_values:
        return 0
    return sorted_values[max(0, math.ceil(0.95 * len(sorted_values)) - 1)]


def _pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def _now_ms() -> int:
    return int(time.perf_counter() * 1000)


if __name__ == "__main__":
    raise SystemExit(main())

