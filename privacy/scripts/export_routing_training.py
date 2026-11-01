"""Write routing training rows for a Glimmer fine-tune, in the exact format the app sends at run time.

    uv run python -m scripts.export_routing_training --out DIR [--include-sim-days] [--keep-reasoning-line]

Runs invented items from eval/synthetic.jsonl through the real egress path with no model: a recorder
stands in for the router and a stand-in gives the hand labels as the request labels. So each row is
what Glimmer would really be sent, tags, floors and all, with the expected answer.

Writes to DIR, which should be outside this repo:
- route.jsonl: {"messages": [system, user, assistant]} for `--mode decide` or `tighten`. An item a floor
  settles never reaches the model, so it has no row here.
- labels.jsonl: the same for `--mode labels`, the request labels Glimmer would be asked for.
- manifest.json: sha256 of each file, counts per answer, and what was left out. No item text.

Left out, by id and by result text: every eval set and split, so the sealed sets stay unseen and the
development numbers stay comparable. eval/splits/sim_days.jsonl stays out too unless
--include-sim-days: the persona study's held-out rows stay clean either way, but with that flag its
simulated days are no longer new to the model, and a report must say so. The system prompts leave out
the "Reasoning strength" line, as the app does with GLIMMER_REASONING=off; --keep-reasoning-line is for
a file served with reasoning on. A row that still holds a name or identifier is dropped and counted.

Invented data only. Never add real connector interactions to this file: Muse's connector guidelines
bar using user data for model training, and the app's own decisions stay on the device.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from collections import Counter
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from base import guard
from base.config import load_settings
from base.local_llm import TOPICS_PROMPT, _without_reasoning_line
from base.router import ROUTE_SCHEMA
from eval import run_eval
from scripts import make_splits

SPLIT_DIR = make_splits.OUT
HELD_OUT = [*make_splits.SETS, *(SPLIT_DIR / f"{name}.jsonl" for name in ("fresh_200_c", "sim_holdout", "sim_unseen"))]
TEMPLATED = make_splits.EVAL / "templated" / "fresh_200_t.jsonl"
SIM_DAYS = SPLIT_DIR / "sim_days.jsonl"
REASONS = {
    "share_tagged": "Tagged detail the user's rules allow.",
    "share_summary": "A class-level result, so a summary is enough.",
    "ask_user": "The user decides this one.",
    "refuse": "This stays on the device.",
}


def gold_labels(item: Mapping, names: list[str]) -> list[str]:
    """A topic's label is the item's `topics`, except class_level (scripts/check_request_topics.py)."""
    topics = set(item.get("topics") or [])
    if item.get("result_kind") == "class_aggregate":
        topics.add("class_level")
    return [n for n in names if n in topics]


class RouteRecorder:
    """Stands in for the router's model: keeps what it was sent and answers with the expected decision."""

    model = "recorder"

    def __init__(self) -> None:
        self.item: Mapping = {}
        self.calls: list[list[dict]] = []

    def chat_json(self, messages: list[dict], schema: Any, **kw: Any) -> dict:
        self.calls.append(messages)
        return {"decision": self.item["expected"], "reason": REASONS[self.item["expected"]]}

    def close(self) -> None:
        return None


class LabelRecorder:
    """Stands in for the checker: the hand labels as the request labels, the hand names as the name pass."""

    def __init__(self) -> None:
        self.item: Mapping = {}
        self.calls: list[tuple[str, dict, list[str]]] = []

    def request_topics(self, request: str, topics: Mapping[str, str], **kw: Any) -> list[str]:
        found = gold_labels(self.item, list(topics))
        self.calls.append((request, dict(topics), found))
        return found

    def llm_names(self, text: str, **kw: Any) -> list[str]:
        """The item's own hand list of names in `text`, standing in for LFM's name pass."""
        names = [*(self.item.get("names") or []), *(self.item.get("other_names") or [])]
        return [n for n in names if isinstance(n, str) and n in text]

    def close(self) -> None:
        return None


def clean(messages: list[dict], keep_line: bool) -> list[dict]:
    return [
        {**m, "content": _without_reasoning_line(m["content"])} if m.get("role") == "system" and not keep_line else dict(m)
        for m in messages
    ]


def label_messages(request: str, topics: Mapping[str, str], found: list[str], keep_line: bool) -> list[dict]:
    listed = "\n".join(f"- {name}: {desc}" for name, desc in topics.items())
    prompt = TOPICS_PROMPT if keep_line else _without_reasoning_line(TOPICS_PROMPT)
    return [
        {"role": "system", "content": f"{prompt}\n\nTopics:\n{listed}"},
        {"role": "user", "content": request},
        {"role": "assistant", "content": json.dumps({"topics": found})},
    ]


def usable(source: Path, held_out: list[Path]) -> tuple[list[dict], Counter]:
    """The source's items in no held-out file, by id or by result text."""
    ids: set[str] = set()
    hashes: set[str] = set()
    for path in held_out:
        for _, item in make_splits.read_lines(path):
            ids.add(item["id"])
            hashes |= make_splits.item_hashes(item)
    kept, left = [], Counter()
    for _, item in make_splits.read_lines(source):
        if item["id"] in ids:
            left["held-out id"] += 1
        elif make_splits.item_hashes(item) & hashes:
            left["same text as a held-out item"] += 1
        else:
            kept.append(item)
    return kept, left


def export(items: list[dict], out: Path, *, keep_line: bool = False) -> dict:
    routes: list[str] = []
    labels: list[str] = []
    counts: Counter = Counter()
    label_counts: Counter = Counter()
    dropped = no_model = 0
    router, checker = RouteRecorder(), LabelRecorder()

    saved: dict[str, Any] = {}

    def customize(services: Any) -> None:
        saved.update(router=services.router.llm, checker=services.checker_llm, answer=services.answer_llm)
        services.router.llm = router
        services.checker_llm = checker
        services.answer_llm = None

    with tempfile.TemporaryDirectory(prefix="routing-export-") as home:
        settings = load_settings({"BASE_HOME": home, "DEVICE_ONLY": "1", "PRIMARY_MODEL": "lfm", "CHECKER_BACKEND": "lfm",
                                  "CHECKER_API_KEY": "none", "DREAMING_BACKEND": "prompt", "ROUTER_TRUST": "decide"})  # fmt: skip
        services = run_eval.services_for(settings, home, customize=customize)
        try:
            for item in items:
                router.item = checker.item = item
                router.calls, checker.calls = [], []
                run_eval.release_item(services, item)
                check = lambda text: guard.leaks(text, services.roster, services.tagmap)  # noqa: E731
                if not router.calls:
                    no_model += 1
                for sent in router.calls:
                    row = [*clean(sent, keep_line), {"role": "assistant", "content": json.dumps({"decision": item["expected"], "reason": REASONS[item["expected"]]})}]
                    # The field's own word "snippet" is also a roster nickname, not a name in the text.
                    if any(check(m["content"].replace("Result kind: snippet", "Result kind:")) for m in row if m["role"] == "user"):
                        dropped += 1
                        continue
                    routes.append(json.dumps({"messages": row}))
                    counts[item["expected"]] += 1
                for request, topics, found in checker.calls:
                    if check(request):
                        dropped += 1
                        continue
                    labels.append(json.dumps({"messages": label_messages(request, topics, found, keep_line)}))
                    label_counts.update(found or ["none"])
        finally:
            services.router.llm, services.checker_llm, services.answer_llm = saved["router"], saved["checker"], saved["answer"]
            services.close()
    out.mkdir(parents=True, exist_ok=True)
    (out / "route.jsonl").write_text("\n".join(routes) + ("\n" if routes else ""))
    (out / "labels.jsonl").write_text("\n".join(labels) + ("\n" if labels else ""))
    return {
        "route_rows": len(routes),
        "route_answers": dict(sorted(counts.items())),
        "label_rows": len(labels),
        "label_answers": dict(sorted(label_counts.items())),
        "settled_by_a_floor_no_route_row": no_model,
        "dropped_for_a_name_or_identifier": dropped,
        "route_sha256": make_splits.sha256_file(out / "route.jsonl"),
        "labels_sha256": make_splits.sha256_file(out / "labels.jsonl"),
        "route_schema": ROUTE_SCHEMA["schema"],
        "reasoning_line_kept": keep_line,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--source", type=Path, default=make_splits.SOURCE, help=argparse.SUPPRESS)
    p.add_argument("--include-sim-days", action="store_true", help="also use the persona study's simulated days")
    p.add_argument("--keep-reasoning-line", action="store_true", help="for a file served with reasoning on")
    args = p.parse_args(argv)
    held = [*HELD_OUT, *([] if args.include_sim_days else [SIM_DAYS])]
    if TEMPLATED.is_file():
        held.append(TEMPLATED)
    items, left = usable(args.source, [h for h in held if h.is_file()])
    if not items:
        print("No items left after the held-out sets: nothing written.", file=sys.stderr)
        return 1
    facts = export(items, args.out, keep_line=args.keep_reasoning_line)
    manifest = {
        "source_sha256": make_splits.sha256_file(args.source),
        "items_used": len(items),
        "left_out": dict(left),
        "sim_days_used": args.include_sim_days,
        **facts,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({k: v for k, v in manifest.items() if k != "route_schema"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
