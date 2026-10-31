"""The first check of a Glimmer file on a side port: does it answer in the shape the app reads?

    uv run python -m scripts.glimmer_probe --url http://127.0.0.1:8181/v1 --key-file FILE
        [--levels off,low,medium,high,xhigh] [--max-tokens 1500]

Sends one invented request per reasoning level, with the router's kind of strict JSON schema, through
the same client the app uses. It reports the shape only: whether the content parsed as the schema,
why the reply ended, reasoning tokens and seconds. It prints no reply text, and it needs no other
server. Exit 0 when every level parsed. A failure here means fix the server flags or the parser first,
before any scored row: a row would only count it as a stop.
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from base import config as base_config
from base.config import load_settings
from base.local_llm import REASONING_LEVELS, LocalLLM, parse_json

SCHEMA = {
    "type": "object",
    "properties": {
        "decision": {"type": "string", "enum": ["share_tagged", "share_summary", "ask_user", "refuse"]},
        "reason": {"type": "string"},
    },
    "required": ["decision", "reason"],
    "additionalProperties": False,
}
MESSAGES = [
    {"role": "system", "content": "You decide what a teacher's device may share with a cloud assistant. Answer in JSON."},
    {
        "role": "user",
        "content": "Muse asked: What was the class average on the invented quiz? The result: The class average was 8.1 of 10. Decide.",
    },
]


@dataclass
class Row:
    level: str
    parsed: bool
    finish: str
    reasoning_tokens: int
    seconds: float
    problem: str = ""


def client(url: str, key: str, reasoning: str = "on") -> LocalLLM:
    settings = load_settings({"GLIMMER_REASONING": reasoning, "DEVICE_ONLY": "1", "PRIMARY_MODEL": "glimmer", "GLIMMER_BACKEND": "llama_server",
                              "CHECKER_BACKEND": "lfm", "ROUTER_URL": url, "ANSWER_URL": url, "LLAMA_API_KEY": key})  # fmt: skip
    return LocalLLM(replace(settings, router_url=url.rstrip("/")), "router")


def probe(llm: Any, level: str, max_tokens: int) -> Row:
    start = time.monotonic()
    try:
        reasoning = None if level == "off" else level
        result = llm.chat(MESSAGES, json_schema=SCHEMA, max_tokens=max_tokens, reasoning=reasoning, synthetic=True)
    except Exception as exc:  # a type name only: an error message may quote the reply
        return Row(level, False, "error", 0, time.monotonic() - start, type(exc).__name__)
    seconds = time.monotonic() - start
    try:
        data = parse_json(result.content)
        parsed = data.get("decision") in SCHEMA["properties"]["decision"]["enum"] and isinstance(data.get("reason"), str)
        problem = "" if parsed else "JSON, but not the schema"
    except (ValueError, json.JSONDecodeError):
        parsed, problem = False, "content is not JSON; is reasoning text landing in content?"
    if level == "off" and result.reasoning_tokens:
        problem = (problem + "; " if problem else "") + "reasoning tokens with reasoning off; check the template and the budget"
    return Row(level, parsed, result.finish_reason or "unknown", result.reasoning_tokens, seconds, problem)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", required=True)
    p.add_argument("--key-file", type=Path, required=True)
    p.add_argument("--levels", default="off", help="comma list: off and the reasoning levels (default off)")
    p.add_argument("--max-tokens", type=int, default=1500)
    args = p.parse_args(argv)
    if not base_config._is_loopback_url(args.url):
        p.error("--url must be this device (127.0.0.1 or localhost)")
    levels = [x.strip() for x in args.levels.split(",") if x.strip()]
    if bad := [x for x in levels if x != "off" and x not in REASONING_LEVELS]:
        p.error(f"unknown levels: {', '.join(bad)}")
    key = args.key_file.read_text().strip()
    llm = client(args.url, key)
    off = client(args.url, key, "off")
    rows = []
    try:
        for level in levels:
            row = probe(off if level == "off" else llm, level, args.max_tokens)
            rows.append(row)
            print(f"{row.level}: parsed={row.parsed} finish={row.finish} reasoning_tokens={row.reasoning_tokens} "
                  f"seconds={row.seconds:.1f}" + (f" problem={row.problem}" if row.problem else ""))  # fmt: skip
    finally:
        llm.close()
        off.close()
    return 0 if rows and all(r.parsed and not r.problem for r in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
