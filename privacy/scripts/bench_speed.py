"""Time each kind of Glimmer step on this machine and write eval/reports/<label>_speed.md.

    uv run python -m scripts.bench_speed --label laptop [--runs 3] [--out eval/reports]

Steps: one router decision, one second pass for names, one request-topics label (the policy's
request_topics on an invented demo request) and grading one essay, each on invented demo data
(demo/ is marked .synthetic). It calls the Glimmer that GLIMMER_BACKEND points at: on
llama_server that is the model on this device (the number to quote as device speed); on openrouter
it is the cloud, and the report says so. Nothing is downloaded or started here. Raw rows go to
eval/reports/raw/<label>_speed.jsonl.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections.abc import Mapping
from pathlib import Path

from base.config import REPO_ROOT, load_settings
from base.local_llm import NAMES_PROMPT, NAMES_SCHEMA, TOPICS_PROMPT, LocalLLM, topics_schema
from base.policy import UserPolicy
from base.router import ROUTE_SCHEMA, SYSTEM_PROMPT
from base.workspace.agent import GRADE_SCHEMA, GRADE_SYSTEM
from eval import run_eval

DEMO = REPO_ROOT / "demo"
STEPS = ("Router decision", "Second pass for names", "Request topics", "Grade one essay")
DEMO_REQUEST = "Draft a note home to [Student C]'s family about her essay score."


def topics_messages(request: str, topics: Mapping[str, str]) -> list[dict]:
    """The messages LocalLLM.request_topics sends for `request` (tested to stay the same)."""
    listed = "\n".join(f"- {name}: {desc}" for name, desc in topics.items())
    return [{"role": "system", "content": f"{TOPICS_PROMPT}\n\nTopics:\n{listed}"}, {"role": "user", "content": request}]


def step_messages(demo: Path = DEMO, topics: Mapping[str, str] | None = None) -> dict[str, tuple[list[dict], dict | None, int]]:
    """(messages, schema, max_tokens) for each step, from the invented demo folder. With no
    request topics (a policy without any) the topics step is left out, as egress skips the call."""
    essay = sorted((demo / "essays").glob("*.md"))[0].read_text()
    rubric = (demo / "rubric.md").read_text()
    route = (
        "Request: Show each student's rubric scores\nResult kind: per_student\nTopics: grades, writing\n"
        "Blocked: none\nFound and tagged: student\nLearned rule for this result: none\nTagged text:\n"
        "| [Student A] | 3 | 3 | 2 | 3 | 11 |"
    )
    steps = {
        "Router decision": ([{"role": "system", "content": SYSTEM_PROMPT + "None yet."},
                             {"role": "user", "content": route}], ROUTE_SCHEMA, 1500),  # fmt: skip
        "Second pass for names": ([{"role": "system", "content": NAMES_PROMPT},
                                   {"role": "user", "content": essay}], NAMES_SCHEMA, 1500),  # fmt: skip
        "Request topics": (topics_messages(DEMO_REQUEST, topics or {}), topics_schema(list(topics or {})), 1500),
        "Grade one essay": ([{"role": "system", "content": GRADE_SYSTEM},
                             {"role": "user", "content": f"Rubric:\n{rubric}\n\nEssay:\n{essay}"}], GRADE_SCHEMA, 3000),  # fmt: skip
    }
    if not topics:
        del steps["Request topics"]
    return steps


def measure(llm, runs: int, demo: Path = DEMO, topics: Mapping[str, str] | None = None) -> list[dict]:
    """One row per call: step, latency, completion tokens and tokens per second."""
    rows = []
    for step, (messages, schema, max_tokens) in step_messages(demo, topics).items():
        for i in range(runs):
            result = llm.chat(messages, json_schema=schema, max_tokens=max_tokens, synthetic=True)
            seconds = max(result.latency_ms, 1) / 1000
            rows.append({
                "step": step, "run": i + 1, "latency_ms": result.latency_ms,
                "completion_tokens": result.completion_tokens, "reasoning_tokens": result.reasoning_tokens,
                "tokens_per_s": round(result.completion_tokens / seconds, 1),
            })  # fmt: skip
    return rows


def render(rows: list[dict], *, label: str, settings, command: str) -> str:
    cloud = settings.is_cloud_backend
    where = (
        f"the cloud ({settings.glimmer_backend}, `{settings.answer_model}`), not this device: do not quote "
        "it as device speed" if cloud else f"this device (llama-server at the answer URL, `{settings.answer_model}`)"
    )
    lines = [
        f"# {label.capitalize()} speed",
        "",
        f"Command: `{command}`",
        "",
        f"Glimmer on {where}. Reasoning strength low, strict JSON, invented demo data. Tokens per second is "
        "completion tokens (reasoning included) over the whole call's wall time, so it includes prompt "
        "processing.",
        "",
        "| Step | Latency (ms) | Tokens/s | Calls |",
        "|---|---:|---:|---:|",
    ]
    for step in STEPS:
        rs = [r for r in rows if r["step"] == step]
        if rs:
            latency = statistics.mean(r["latency_ms"] for r in rs)
            tps = statistics.mean(r["tokens_per_s"] for r in rs)
            lines.append(f"| {step} | {latency:.0f} | {tps:.1f} | {len(rs)} |")
    lines += ["", f"Raw rows: raw/{label}_speed.jsonl next to this report.", ""]
    return "\n".join(lines)


def main(argv: list[str] | None = None, settings=None, llm=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = argparse.ArgumentParser(prog="python -m scripts.bench_speed", description=__doc__.split("\n")[0])
    p.add_argument("--label", required=True, help="device name for the file, e.g. laptop or jetson")
    p.add_argument("--runs", type=int, default=3, help="calls per step (default 3)")
    p.add_argument("--out", type=Path, default=run_eval.REPORTS_DIR)
    args = p.parse_args(argv)
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", args.label):
        p.error("--label may use lowercase letters, digits, dash and underscore")
    if args.runs < 1:
        p.error("--runs must be at least 1")
    settings = settings or load_settings()
    llm = llm or LocalLLM(settings, "answer")
    rows = measure(llm, args.runs, topics=UserPolicy.load(settings.policy_path).request_topics)
    command = run_eval.command_line("scripts.bench_speed", argv)
    args.out.mkdir(parents=True, exist_ok=True)
    md = args.out / f"{args.label}_speed.md"
    md.write_text(render(rows, label=args.label, settings=settings, command=command))
    raw = args.out / "raw" / f"{args.label}_speed.jsonl"
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_text("".join(json.dumps(r) + "\n" for r in rows))
    print(f"Wrote {run_eval.display_path(md)} and {run_eval.display_path(raw)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
