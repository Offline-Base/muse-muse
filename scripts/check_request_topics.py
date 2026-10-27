"""Measure how well Glimmer labels Muse's requests with the policy's request topics.

    uv run python -m scripts.check_request_topics [--sample 160] [--seed 7] [--keywords FILE]

Compares Glimmer's labels (LocalLLM.request_topics with the policy's descriptions) with the
hand labels on two sets: a sample of eval/synthetic.jsonl, written by Spark and never used to
write the descriptions (half drawn from items with an outside-the-class topic, which are rare),
and all of eval/tasks.jsonl plus eval/holdout.jsonl. A topic's label is the item's `topics`,
except class_level, whose label is result_kind == class_aggregate. With --keywords, a YAML file
of {request_topics: {topic: [keywords]}} is scored on the same items as a baseline (no model
calls). Writes eval/reports/request_topics.md and raw/request_topics.jsonl. Invented data only.
"""

from __future__ import annotations

import argparse
import json
import random
import shlex
import statistics
import sys
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


def load(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def label(item: dict, topic: str) -> bool:
    if topic == CLASS_LEVEL_TOPIC:
        return item["result_kind"] == "class_aggregate"
    return topic in (item.get("topics") or [])


def sample_synthetic(items: list[dict], n: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sample", type=int, default=160)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--keywords", type=Path, help="YAML of keyword lists to score as a baseline")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--out", type=Path, default=REPO_ROOT / "eval" / "reports")
    args = ap.parse_args(argv)
    command = "uv run python -m scripts.check_request_topics " + shlex.join(argv if argv is not None else sys.argv[1:])

    settings = load_settings()
    policy = UserPolicy.load(settings.policy_path)
    topics = policy.request_topics
    if not topics:
        print("The policy has no request_topics.", file=sys.stderr)
        return 2
    sets = {
        "Synthetic sample (held out)": sample_synthetic(
            load(REPO_ROOT / "eval" / "synthetic.jsonl"), args.sample, args.seed
        ),
        "Eval tasks and holdout": load(REPO_ROOT / "eval" / "tasks.jsonl") + load(REPO_ROOT / "eval" / "holdout.jsonl"),
    }
    llm = LocalLLM(settings, "answer")

    def run(item: dict) -> dict:
        start = time.monotonic()
        try:
            got, error = llm.request_topics(item["request"], topics, synthetic=True), None
        except Exception as exc:  # recorded and counted, never scored as a correct label
            got, error = [], type(exc).__name__
        return {"id": item["id"], "topics": got, "error": error, "ms": round((time.monotonic() - start) * 1000)}

    every = {i["id"]: i for items in sets.values() for i in items}
    with ThreadPoolExecutor(args.workers) as pool:
        rows = list(pool.map(run, every.values()))
    llm.close()
    glimmer = {r["id"]: r["topics"] for r in rows}
    keywords = None
    if args.keywords:
        lexicon = yaml.safe_load(args.keywords.read_text())["request_topics"]
        keywords = {
            i["id"]: [t for t in topics if t in lexicon and guard.blocked_topics(i["request"], {t: lexicon[t]})]
            for i in every.values()
        }

    errors = sum(1 for r in rows if r["error"])
    ms = sorted(r["ms"] for r in rows)
    lines = [
        "# Request topics: Glimmer labels against hand labels",
        "",
        f"Command: `{command}`",
        "",
        f"Model: {settings.answer_model} on {settings.glimmer_backend}. {len(rows)} calls, {errors} failed "
        f"(a failure counts as no topics). Latency per call: mean {round(statistics.mean(ms))} ms, "
        f"p95 {ms[max(0, round(0.95 * len(ms)) - 1)]} ms.",
        "",
        "Topics and descriptions come from the policy (`request_topics` in eval/user_policy.yaml). The "
        "synthetic sample is half items with an outside-the-class topic (rare in the set), so its "
        "precision is not the precision on all 2000 items. Hand labels are Spark's and have noise: "
        "a school newsletter is labeled parents in some items and third_party in others.",
        "",
    ]
    for name, items in sets.items():
        lines += [f"## {name} ({len(items)} items)", "", "| Topic | Method | Labeled | Found | Precision | Recall |", "|---|---|---|---|---|---|"]
        for topic in topics:
            for method, found in (("Glimmer", glimmer), ("Keywords", keywords)):
                if found is None:
                    continue
                s = score(items, found, topic)
                lines.append(
                    f"| {topic} | {method} | {s['labeled']} | {s['found']} | {_fmt(s['precision'])} | {_fmt(s['recall'])} |"
                )
        lines.append("")
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "request_topics.md").write_text("\n".join(lines))
    raw = args.out / "raw" / "request_topics.jsonl"
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_text("".join(json.dumps(r) + "\n" for r in rows))
    print("\n".join(lines))
    return 1 if errors else 0


def _fmt(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.2f}"


if __name__ == "__main__":
    raise SystemExit(main())
