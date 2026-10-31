"""Write a simulated persona's item sets: invented items labeled with the persona's own policy.

    uv run python -m scripts.relabel_for_persona --persona eval/personas/<id>/persona.yaml [--from eval/sim]
    uv run python -m scripts.relabel_for_persona --persona eval/personas/<id>/persona.yaml \\
        --pool eval/personas/<id>/items.jsonl --holdout-n 16 --unseen-n 16 [--seed 0]

With --from, the folder's days.jsonl, holdout.jsonl and unseen.jsonl (the SIM-1 split) keep their
split, so every persona's gate scores the same items. With --pool, one file is split here, seeded:
holdout and unseen draw an equal share per expected decision as far as the pool allows
(simulate_nights.sample_unseen), and the rest are the days. Either way each item's `expected`
becomes policy.wants(item) on its hand labels (request, result_kind, topics) under the persona's
policy, and `labeled_by` says so. Writes days.jsonl, holdout.jsonl, unseen.jsonl and sets.md (the
command and counts only) next to persona.yaml, or in --out. No model call. Exits 1 when the days
have fewer than MIN_PER_DECISION items of a decision the persona uses.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from base.types import DECISIONS
from eval import run_eval
from eval.persona import Persona, PersonaError

SETS = ("days", "holdout", "unseen")
MIN_PER_DECISION = 10
DEFAULT_FROM = run_eval.EVAL_DIR / "sim"


def relabel(items: list[dict], persona: Persona) -> list[dict]:
    """Copies of `items` with expected = the persona policy's wants, in the same order."""
    label = f"{persona.id} policy (simulated persona, invented)"
    return [dict(i) | {"expected": persona.policy.wants(i), "labeled_by": label} for i in items]


def split_pool(items: list[dict], holdout_n: int, unseen_n: int, seed: int) -> dict[str, list[dict]]:
    """Holdout, then unseen from what is left, each balanced over expected decisions; the rest are days."""
    from scripts.simulate_nights import sample_unseen

    holdout = sample_unseen(items, holdout_n, seed) if holdout_n else []
    taken = {i["id"] for i in holdout}
    unseen = sample_unseen(items, unseen_n, seed + 1, taken) if unseen_n else []
    taken |= {i["id"] for i in unseen}
    return {"days": [i for i in items if i["id"] not in taken], "holdout": holdout, "unseen": unseen}


def thin(items: list[dict], least: int = MIN_PER_DECISION) -> list[str]:
    """Decisions that some items use but fewer than `least` do."""
    counts = Counter(i.get("expected") for i in items)
    return [d for d in DECISIONS if 0 < counts[d] < least]


def mix(items: list[dict]) -> str:
    counts = Counter(i.get("expected") for i in items)
    return " ".join(f"{d}:{counts[d]}" for d in DECISIONS if counts[d]) or "none"


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = argparse.ArgumentParser(prog="python -m scripts.relabel_for_persona", description=__doc__.split("\n")[0])
    p.add_argument("--persona", type=Path, required=True)
    p.add_argument("--from", dest="source", type=Path, help=f"folder with {', '.join(SETS)}.jsonl (default eval/sim)")
    p.add_argument("--pool", type=Path, help="one item file to split here instead")
    p.add_argument("--holdout-n", type=int, default=0)
    p.add_argument("--unseen-n", type=int, default=0)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", type=Path, help="folder to write in (default: the persona's folder)")
    args = p.parse_args(argv)
    if args.pool and args.source:
        p.error("give --from or --pool, not both")
    try:
        persona = Persona.load(args.persona)
    except (PersonaError, ValueError) as exc:
        p.error(str(exc))

    if args.pool:
        if not args.pool.is_file():
            p.error(f"no pool at {args.pool}")
        raw = run_eval.load_items(args.pool)
        pool = relabel(raw, persona)
        sets = split_pool(pool, args.holdout_n, args.unseen_n, args.seed)
        source = f"{run_eval.display_path(args.pool)}, split here with seed {args.seed}"
    else:
        folder = args.source or DEFAULT_FROM
        missing = [s for s in SETS if not (folder / f"{s}.jsonl").is_file()]
        if missing:
            p.error(f"{run_eval.display_path(folder)} has no {', '.join(missing)}.jsonl (the SIM-1 split)")
        raw_sets = {s: run_eval.load_items(folder / f"{s}.jsonl") for s in SETS}
        raw = [i for s in SETS for i in raw_sets[s]]
        sets = {s: relabel(raw_sets[s], persona) for s in SETS}
        pool = [i for s in SETS for i in sets[s]]
        source = f"{run_eval.display_path(folder)} ({', '.join(f'{s}.jsonl' for s in SETS)}), split kept"

    out = args.out or persona.path.parent
    out.mkdir(parents=True, exist_ok=True)
    for name, items in sets.items():
        (out / f"{name}.jsonl").write_text("".join(json.dumps(i) + "\n" for i in items))
    changed = sum(a.get("expected") != b["expected"] for a, b in zip(raw, pool, strict=True))
    short = thin(sets["days"])
    lines = [
        f"# Item sets for the simulated persona {persona.id} (invented)",
        "",
        f"Command: `{run_eval.command_line('scripts.relabel_for_persona', argv)}`",
        "",
        f"Source: {source}. Every item is invented; `expected` is {persona.id}'s policy on the hand labels, "
        f"which changed {changed} of {len(pool)} labels.",
        "",
        "| Set | Items | Expected decisions |",
        "|---|---|---|",
        *(f"| {name} | {len(items)} | {mix(items)} |" for name, items in sets.items()),
        "",
        f"Decisions with fewer than {MIN_PER_DECISION} day items: {', '.join(short) or 'none'}.",
    ]
    (out / "sets.md").write_text("\n".join(lines) + "\n")
    for name, items in sets.items():
        print(f"{name}: {len(items)} items ({mix(items)})")
    print(f"changed {changed} of {len(pool)} labels; wrote {', '.join(SETS)}.jsonl and sets.md in {run_eval.display_path(out)}")
    if short:
        print(f"too few day items for: {', '.join(short)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
