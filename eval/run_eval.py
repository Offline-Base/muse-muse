"""Privacy router eval: send each invented item through egress and score what would leave.

    uv run python -m eval.run_eval --set eval/tasks.jsonl --name NAME [--holdout] [--limit N] [--rules PATH|none]

Every run gets a fresh temporary BASE_HOME, so it never touches the real decision log, unless
--home is given. Writes eval/reports/NAME.md (exact command at the top) and
eval/reports/raw/NAME.jsonl (ids and decisions only, never the result text).
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
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path

from base.config import REPO_ROOT, load_settings
from base.types import DECISIONS

EVAL_DIR = Path(__file__).resolve().parent
REPORTS_DIR = EVAL_DIR / "reports"
DEFAULT_HOLDOUT = EVAL_DIR / "holdout.jsonl"
SUMMARY_KEYS = (
    "n", "accuracy", "agreement", "approval_requests", "leaks", "held", "errors",
    "latency_mean_ms", "latency_p95_ms", "tokens",
)  # fmt: skip


@dataclass
class EvalReport:
    name: str
    device: str = ""
    backend: str = ""
    model: str = ""
    date: str = ""
    command: str = ""
    rules: str = "none"
    n: int = 0
    correct: int = 0
    accuracy: float = 0.0
    agreement: float = 0.0
    approval_requests: int = 0
    leaks: int = 0  # items whose released text leaked anything
    held: int = 0  # items the final leak check held back after the router let them through
    errors: int = 0
    latency_mean_ms: float = 0.0
    latency_p95_ms: float = 0.0
    tokens: int | None = None
    categories: dict[str, dict] = field(default_factory=dict)  # expected decision -> scores
    confusion: dict[str, dict[str, int]] = field(default_factory=dict)  # expected -> decided -> count
    rows: list[dict] = field(default_factory=list)

    def category_accuracy(self) -> dict[str, float]:
        return {cat: scores["accuracy"] for cat, scores in self.categories.items()}

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
    """Wire services for `home`. With rules_path None, whatever rules file the home has is used."""
    from base.services import Services

    return Services.create(prepare_home(settings, home, rules_path))


def evaluate(
    settings,
    items: list[dict],
    *,
    rules_path: str | Path | None = None,
    name: str,
    device_label: str | None = None,
    command: str = "",
) -> EvalReport:
    """Run the eval in a fresh temporary home with `rules_path` (None for no learned rules)."""
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
            )
        finally:
            close = getattr(services, "close", None)
            if callable(close):
                close()


def release_item(services, item: Mapping, *, tool: str = "eval", day: int | None = None):
    """Send one invented eval item through egress, the way a connector tool result goes."""
    release = services.egress.release
    kwargs = {
        "tool": tool,
        "request": item["request"],
        "raw_text": item["result"],
        "result_kind": item["result_kind"],
        "summary": item.get("summary"),
        "topics": list(item.get("topics") or []),
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
) -> EvalReport:
    settings = services.settings
    roster_values = _roster_values(getattr(services, "roster", None))
    rows = [_score(services, item, roster_values) for item in items]
    return _report(
        rows,
        name=name,
        device=device_label,
        backend=settings.glimmer_backend,
        model=settings.router_model,
        command=command,
        rules=rules,
    )


def find_leaks(services, text: str, item: Mapping, roster_values: Iterable[str]) -> list[str]:
    """Kinds of private values found in `text` (never the values themselves)."""
    found = set()
    for kind, values in (
        ("name", item.get("names") or []),
        ("identifier", item.get("identifiers") or []),
        ("roster", roster_values),
    ):
        if any(v and _contains(text, v) for v in values):
            found.add(kind)
    found.update(f"guard:{hit.kind}" for hit in _guard_leaks(services, text))
    return sorted(found)


def _score(services, item: Mapping, roster_values: list[str]) -> dict:
    row = {"id": item["id"], "expected": item["expected"], "wants": services.policy.wants(item)}
    start = _now_ms()
    try:
        released = release_item(services, item)
    except Exception as exc:  # one failed item must not end a 100-item run
        row.update(decision="error", status="error", source="error", floors=[], leaked=False, leak_kinds=[])
        row.update(latency_ms=_now_ms() - start, error=type(exc).__name__)
        return row
    rd = released.decision
    decision = getattr(rd, "decision", rd)
    latency = getattr(rd, "latency_ms", None)
    kinds = find_leaks(services, released.text or "", item, roster_values)
    row.update(
        decision=decision,
        status=released.status,
        source=getattr(rd, "source", None),
        floors=list(getattr(rd, "floors", None) or []),
        leaked=bool(kinds),
        leak_kinds=kinds,
        latency_ms=int(latency if latency is not None else _now_ms() - start),
    )
    tokens = getattr(rd, "tokens", None)
    if isinstance(tokens, int):
        row["tokens"] = tokens
    return row


def _report(rows: list[dict], **meta) -> EvalReport:
    n = len(rows)
    correct = sum(r["decision"] == r["expected"] for r in rows)
    categories = {}
    for cat in list(DECISIONS) + sorted({r["expected"] for r in rows} - set(DECISIONS)):
        rs = [r for r in rows if r["expected"] == cat]
        if rs:
            categories[cat] = {
                "n": len(rs),
                "correct": sum(r["decision"] == cat for r in rs),
                "accuracy": _ratio(sum(r["decision"] == cat for r in rs), len(rs)),
                "agreement": _ratio(sum(r["decision"] == r["wants"] for r in rs), len(rs)),
                "approval_requests": sum(r["decision"] == "ask_user" for r in rs),
                "leaks": sum(r["leaked"] for r in rs),
            }
    confusion: dict[str, dict[str, int]] = {}
    for r in rows:
        confusion.setdefault(r["expected"], {}).setdefault(r["decision"], 0)
        confusion[r["expected"]][r["decision"]] += 1
    latencies = sorted(r["latency_ms"] for r in rows if r["decision"] != "error")
    tokens = [r["tokens"] for r in rows if "tokens" in r]
    return EvalReport(
        date=datetime.now().strftime("%Y-%m-%d %H:%M"),
        n=n,
        correct=correct,
        accuracy=_ratio(correct, n),
        agreement=_ratio(sum(r["decision"] == r["wants"] for r in rows), n),
        approval_requests=sum(r["decision"] == "ask_user" for r in rows),
        leaks=sum(r["leaked"] for r in rows),
        held=sum(r["status"] == "refused" and r["decision"] != "refuse" for r in rows),
        errors=sum(r["decision"] == "error" for r in rows),
        latency_mean_ms=round(sum(latencies) / len(latencies), 1) if latencies else 0.0,
        latency_p95_ms=float(_p95(latencies)),
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
    with raw_path.open("w") as f:
        for r in report.rows:
            keep = ("id", "expected", "wants", "decision", "status", "source", "floors", "leaked", "leak_kinds")
            out = {k: r.get(k) for k in keep} | {"latency_ms": r.get("latency_ms")}
            if "error" in r:
                out["error"] = r["error"]
            f.write(json.dumps(out) + "\n")
    return md_path, raw_path


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
        f"| Router latency, mean | {r.latency_mean_ms:.0f} ms |",
        f"| Router latency, p95 | {r.latency_p95_ms:.0f} ms |",
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
    lines += ["", f"Raw rows: eval/reports/raw/{r.name}.jsonl (ids and decisions only, no result text).", ""]
    return "\n".join(lines)


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
        f"approval requests {r.approval_requests}, leaks {r.leaks}, errors {r.errors}, "
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
        report = run(services, items, name=args.name, device_label=label, command=command, rules=rules)
    else:
        rules_path = None if args.rules.lower() == "none" else Path(args.rules)
        if rules_path is not None and not rules_path.is_file():
            p.error(f"no rules file at {args.rules}")
        report = evaluate(
            settings, items, rules_path=rules_path, name=args.name, device_label=label, command=command
        )
    md_path, raw_path = write_report(report, args.out)
    print(format_summary(report))
    print(f"Wrote {display_path(md_path)} and {display_path(raw_path)}")
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
    return re.search(rf"(?<!\w){re.escape(value)}(?!\w)", text, flags=re.IGNORECASE) is not None


def _accepts(fn, name: str) -> bool:
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    return name in params


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

