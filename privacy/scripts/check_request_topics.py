"""Measure how well Glimmer labels Muse's requests with the policy's request topics.

    uv run python -m scripts.check_request_topics [--sample 160] [--seed 11] [--keywords FILE]
        [--extra-topic NAME=DESCRIPTION ...] [--name request_topics] [--out eval/reports]

Compares Glimmer's labels (LocalLLM.request_topics with the policy's descriptions) with the hand
labels on three sets:
- Synthetic sample, held out: a fresh draw from eval/synthetic.jsonl (--seed) that leaves out
  every id in --seen, the labels kept from the runs scored while the descriptions were written.
  Change a description after reading this sample's errors and it is seen too: add its raw file
  to --seen and draw again with another --seed.
- Synthetic sample, seen during tuning: the seed-7 draw (--dev-seed) those runs scored.
- Eval tasks: eval/tasks.jsonl, 100 items. eval/holdout.jsonl is 20 of them, so it is not scored
  again. The descriptions were written with these requests in view.
Both samples are half items with an outside-the-class topic, which are rare. A topic's label is
the item's `topics`, except class_level, whose label is result_kind == class_aggregate.

--extra-topic scores a candidate that is not in the policy: a second call per item lists the
policy's topics plus the candidates, as the policy would if it shipped them, and only the
candidates are scored from it. The policy is never changed. With --keywords, a YAML file of
{request_topics: {topic: [keywords]}} is scored on the same items as a baseline (no model calls).
Writes eval/reports/NAME.md and raw/NAME.jsonl. Invented data only.
"""

from __future__ import annotations

import argparse
import json
import random
import shlex
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml

from base import guard
from base.config import REPO_ROOT, load_settings
from base.local_llm import LocalLLM
from base.policy import UserPolicy
from base.types import CLASS_LEVEL_TOPIC

OUTSIDE = {"parents", "third_party", "full_text", "deanonymize", "reidentify"}
EVAL = REPO_ROOT / "eval"
SEEN = EVAL / "reports" / "raw" / "request_topics_tuning.jsonl"
HELD_OUT = "Synthetic sample, held out"
DEV = "Synthetic sample, seen during tuning"
TASKS = "Eval tasks, in-sample"


class CountingLLM(LocalLLM):
    """LocalLLM that adds up the tokens of every call, for the report's usage line."""

    def __init__(self, *args, **kw):
        super().__init__(*args, **kw)
        self._lock = threading.Lock()
        self.prompt_tokens = self.completion_tokens = 0

    def chat(self, *args, **kw):
        result = super().chat(*args, **kw)
        with self._lock:
            self.prompt_tokens += result.prompt_tokens
            self.completion_tokens += result.completion_tokens
        return result


def load(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def label(item: dict, topic: str) -> bool:
    if topic == CLASS_LEVEL_TOPIC:
        return item["result_kind"] == "class_aggregate"
    return topic in (item.get("topics") or [])


def sample_synthetic(items: list[dict], n: int, seed: int, exclude: set[str] = frozenset()) -> list[dict]:
    rng = random.Random(seed)
    items = [i for i in items if i["id"] not in exclude]
    rare = [i for i in items if set(i.get("topics") or []) & OUTSIDE]
    rest = [i for i in items if not set(i.get("topics") or []) & OUTSIDE]
    return rng.sample(rare, min(n // 2, len(rare))) + rng.sample(rest, min(n - n // 2, len(rest)))


def score(items: list[dict], found: dict[str, list[str]], topic: str) -> dict:
    tp = sum(1 for i in items if label(i, topic) and topic in found[i["id"]])
    fp = sum(1 for i in items if topic in found[i["id"]] and not label(i, topic))
    fn = sum(1 for i in items if label(i, topic) and topic not in found[i["id"]])
    return {
        "labeled": tp + fn,
        "found": tp + fp,
        "precision": round(tp / (tp + fp), 2) if tp + fp else None,
        "recall": round(tp / (tp + fn), 2) if tp + fn else None,
    }


def extra_topic(value: str) -> tuple[str, str]:
    name, sep, description = value.partition("=")
    if not sep or not name.strip().isidentifier() or not description.strip():
        raise argparse.ArgumentTypeError("use NAME=DESCRIPTION")
    return name.strip(), " ".join(description.split())


def build_sets(args: argparse.Namespace) -> dict[str, list[dict]]:
    """The three scored sets. The held-out draw shares no id with --seen (tested)."""
    synthetic = load(args.synthetic)
    seen = {r["id"] for path in args.seen for r in load(path)}
    dev = sample_synthetic(synthetic, args.sample, args.dev_seed)
    return {
        HELD_OUT: sample_synthetic(synthetic, args.sample, args.seed, exclude=seen | {i["id"] for i in dev}),
        DEV: dev,
        TASKS: load(args.tasks),
    }


def main(argv: list[str] | None = None, settings=None, llm=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sample", type=int, default=160)
    ap.add_argument("--seed", type=int, default=11, help="seed of the held-out draw")
    ap.add_argument("--dev-seed", type=int, default=7, help="seed of the sample scored while tuning")
    ap.add_argument("--seen", type=Path, nargs="+", default=[SEEN], help="raw rows whose ids the held-out draw leaves out")
    ap.add_argument("--synthetic", type=Path, default=EVAL / "synthetic.jsonl")
    ap.add_argument("--tasks", type=Path, default=EVAL / "tasks.jsonl")
    ap.add_argument("--keywords", type=Path, help="YAML of keyword lists to score as a baseline")
    ap.add_argument("--extra-topic", type=extra_topic, action="append", default=[], metavar="NAME=DESCRIPTION")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--name", default="request_topics", help="report file name")
    ap.add_argument("--out", type=Path, default=EVAL / "reports")
    args = ap.parse_args(argv)
    command = "uv run python -m scripts.check_request_topics " + shlex.join(argv if argv is not None else sys.argv[1:])

    settings = settings or load_settings()
    policy = UserPolicy.load(settings.policy_path)
    topics = policy.request_topics
    if not topics:
        print("The policy has no request_topics.", file=sys.stderr)
        return 2
    extras = dict(args.extra_topic)
    if set(extras) & set(topics):
        print("An --extra-topic is already in the policy.", file=sys.stderr)
        return 2
    sets = build_sets(args)
    llm = llm or CountingLLM(settings, "answer")

    def run(item: dict) -> dict:
        start = time.monotonic()
        try:
            got, error = llm.request_topics(item["request"], topics, synthetic=True), None
        except Exception as exc:  # recorded and counted, never scored as a correct label
            got, error = [], type(exc).__name__
        row = {"id": item["id"], "topics": got, "error": error, "ms": round((time.monotonic() - start) * 1000)}
        if extras:
            try:
                found = llm.request_topics(item["request"], {**topics, **extras}, synthetic=True)
                row.update(extra=[t for t in found if t in extras], extra_error=None)
            except Exception as exc:
                row.update(extra=[], extra_error=type(exc).__name__)
        return row

    every = {i["id"]: i for items in sets.values() for i in items}
    with ThreadPoolExecutor(args.workers) as pool:
        rows = list(pool.map(run, every.values()))
    close = getattr(llm, "close", None)
    if callable(close):
        close()
    glimmer = {r["id"]: r["topics"] + r.get("extra", []) for r in rows}
    scored = [*topics, *extras]
    keywords = None
    if args.keywords:
        lexicon = yaml.safe_load(args.keywords.read_text())["request_topics"]
        keywords = {
            i["id"]: [t for t in scored if t in lexicon and guard.blocked_topics(i["request"], {t: lexicon[t]})]
            for i in every.values()
        }

    errors = sum(1 for r in rows if r["error"]) + sum(1 for r in rows if r.get("extra_error"))
    lines = render(args, settings, sets, rows, topics, extras, glimmer, keywords, command, llm)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"{args.name}.md").write_text("\n".join(lines))
    raw = args.out / "raw" / f"{args.name}.jsonl"
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_text("".join(json.dumps(r) + "\n" for r in rows))
    print("\n".join(lines))
    return 1 if errors else 0


def render(args, settings, sets, rows, topics, extras, glimmer, keywords, command, llm) -> list[str]:
    ms = sorted(r["ms"] for r in rows)
    failed = sum(1 for r in rows if r["error"])
    calls = len(rows) + (len(rows) if extras else 0)
    usage = ""
    if getattr(llm, "prompt_tokens", None) is not None:
        usage = f" Tokens over all {calls} calls: prompt {llm.prompt_tokens}, completion {llm.completion_tokens}."
    lines = [
        "# Request topics: Glimmer labels against hand labels",
        "",
        f"Command: `{command}`",
        "",
        f"Model: {settings.answer_model} on {settings.glimmer_backend}, device setting {settings.device}. "
        f"{len(rows)} calls with the policy's topics, {failed} failed (a failure counts as no topics). "
        f"Latency per call: mean {round(statistics.mean(ms))} ms, p95 {ms[max(0, round(0.95 * len(ms)) - 1)]} ms."
        + usage,
        "",
        "Topics and descriptions come from the policy (`request_topics` in eval/user_policy.yaml). Hand labels "
        "are Spark's and have noise: a school newsletter is labeled parents in some items and third_party in "
        "others.",
        "",
        "## Which numbers are held out",
        "",
        f"The descriptions were written from eval/DATASET.md's topic definitions with the eval task requests in "
        f"view, then checked on the seed-{args.dev_seed} synthetic sample. Those runs also scored reidentify, "
        "grades and writing, which were then left out of the policy. After one scored run, the full_text "
        "description was tightened (\"not a search, a quote, an excerpt or a summary\") after looking at its "
        "false positives, mostly eval tasks such as \"Search the essays for compost.\" and \"Find excerpts that "
        "mention a friend.\". So the seen-during-tuning sample and the eval tasks are in-sample. Only the first "
        f"table is held out: a fresh draw (seed {args.seed}) with the descriptions frozen, leaving out every id "
        f"in {', '.join(f'`{_display(p)}`' for p in args.seen)} (the labels kept from those runs). Each sample is half items with an "
        "outside-the-class topic (rare in the 2000 items), so its precision is not the precision on all items. "
        "The eval tasks include the 20 holdout items (eval/holdout.jsonl is a subset), scored once.",
        "",
    ]
    if extras:
        lines += [
            "## Candidate topics (not in the policy)",
            "",
            "Each is scored from a second call per item that lists the policy's topics plus the candidates, as "
            "the policy would if it shipped them. Only the candidate's labels are scored from that call; the "
            "policy's own rows come from the first call.",
            "",
        ]
        lines += [f"- {name}: \"{desc}\"" for name, desc in extras.items()]
        lines.append("")
    for name, items in sets.items():
        lines += [f"## {name} ({len(items)} items)", "", "| Topic | Method | Labeled | Found | Precision | Recall |",
                  "|---|---|---|---|---|---|"]  # fmt: skip
        for topic in [*topics, *extras]:
            shown = f"{topic} (candidate)" if topic in extras else topic
            for method, found in (("Glimmer", glimmer), ("Keywords", keywords)):
                if found is None:
                    continue
                s = score(items, found, topic)
                lines.append(
                    f"| {shown} | {method} | {s['labeled']} | {s['found']} | {_fmt(s['precision'])} | {_fmt(s['recall'])} |"
                )
        lines.append("")
    lines += [f"Raw rows: raw/{args.name}.jsonl next to this report (ids and topic names only).", ""]
    return lines


def _display(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return path.name


def _fmt(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.2f}"


if __name__ == "__main__":
    raise SystemExit(main())
