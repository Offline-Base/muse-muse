"""Carve seeded, non-overlapping eval splits from the eval/synthetic.jsonl items no set has used yet.

    uv run python -m scripts.make_splits [--seed 20261101] [--sealed 200] [--holdout 80] [--unseen 100]
        [--days 800] [--source eval/synthetic.jsonl] [--sets FILE ...] [--used FILE ...] [--out eval/splits]
    uv run python -m scripts.make_splits --verify [--out eval/splits]

The pool is every source item whose id is in no existing set (fresh_200, fresh_200_b, tasks,
holdout, compliance) and in no report row that scored it (the request-topic check's and the
nights' unseen-test raw rows), and whose result text matches no existing item's result or text
(normalized, then hashed). From the pool, in this order: fresh_200_c, a random sample like
fresh_200 and fresh_200_b, the candidate sealed set; sim_holdout, an equal share per decision for
the dreaming gate; sim_unseen, the same for the simulation's unseen test; sim_days, the rest up to
--days. Every file keeps the source's lines byte for byte. manifest.json and MANIFEST.md give the
seed, the sources, what was left out and why, and each file's sha256 and per-decision counts.
--verify checks the files against the manifest. Item text is never printed, only counts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from collections import Counter
from pathlib import Path

from base.config import REPO_ROOT
from eval import run_eval

EVAL = REPO_ROOT / "eval"
SOURCE = EVAL / "synthetic.jsonl"
SETS = [EVAL / f"{name}.jsonl" for name in ("fresh_200", "fresh_200_b", "tasks", "holdout", "compliance")]
# Report rows whose router scores were read: the request-topic check's samples and the nights'
# unseen test. name_parts.jsonl is a guard check with no router decision, so it does not count.
USED_GLOBS = ("raw/request_topics*.jsonl", "**/raw/nights/unseen-*.jsonl")
OUT = EVAL / "splits"
SEED = 20261101
DECISIONS = ("share_tagged", "share_summary", "ask_user", "refuse")
TEXT_FIELDS = ("result", "text")
SPLITS = ("fresh_200_c", "sim_holdout", "sim_unseen", "sim_days")
PURPOSE = {
    "fresh_200_c": "candidate sealed final set: nobody reads its misses before submission",
    "sim_holdout": "the dreaming gate's holdout in the simulation, an equal share per decision",
    "sim_unseen": "the simulation's unseen test, an equal share per decision",
    "sim_days": "the simulated days, free to read",
}
STATUS = "UNSEALED"
REASON = (
    "Ethan has not confirmed what his fine-tuned Glimmer trained on. Every set here, like fresh_200 and "
    "fresh_200_b, comes from eval/synthetic.jsonl, so if the fine-tune used that file every one of them is "
    "contaminated, not only fresh_200_c. Seal fresh_200_c only after he confirms the fine-tune never saw "
    "eval/synthetic.jsonl and scripts/check_overlap.py on his training file finds nothing."
)


class SplitError(RuntimeError):
    """A plain reason the splits cannot be made."""


def used_files(reports: Path = run_eval.REPORTS_DIR) -> list[Path]:
    return sorted({p for pattern in USED_GLOBS for p in reports.glob(pattern)})


def read_lines(path: Path) -> list[tuple[str, dict]]:
    """(the line as written, the item) for every item in a JSONL file."""
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            item = json.loads(line)
            if isinstance(item, dict):
                out.append((line, item))
    return out


def text_hash(text: str) -> str:
    return hashlib.sha256(" ".join(str(text).casefold().split()).encode()).hexdigest()


def item_hashes(item: dict) -> set[str]:
    return {text_hash(item[f]) for f in TEXT_FIELDS if isinstance(item.get(f), str) and item[f].strip()}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rel(path: Path) -> str:
    return run_eval.shown_path(str(path))


def pool(source: list[tuple[str, dict]], sets: list[Path], used: list[Path]) -> tuple[list[tuple[str, dict]], dict]:
    """The source lines no set or report has used, and counts of what was left out and why."""
    set_ids: set[str] = set()
    hashes: set[str] = set()
    left: dict = {"sets": {}, "used": {}}
    for path in sets:
        items = [item for _line, item in read_lines(path)]
        ids = {str(i["id"]) for i in items if "id" in i}
        left["sets"][rel(path)] = len(ids)
        set_ids |= ids
        for item in items:
            hashes |= item_hashes(item)
    used_ids: set[str] = set()
    for path in used:
        ids = {str(i["id"]) for _line, i in read_lines(path) if "id" in i}
        left["used"][rel(path)] = len(ids)
        used_ids |= ids
    kept, seen, kept_hashes = [], set(), set()
    counts = Counter()
    for line, item in source:
        key = str(item.get("id"))
        mine = item_hashes(item)
        if key in set_ids:
            counts["in a set"] += 1
        elif key in used_ids:
            counts["scored in a report"] += 1
        elif mine & hashes:
            counts["text matches a set item"] += 1
        elif key in seen or mine & kept_hashes:
            counts["repeats a pool item"] += 1
        else:
            kept.append((line, item))
            seen.add(key)
            kept_hashes |= mine
    left["reasons"] = dict(counts)
    return kept, left


def balanced(lines: list[tuple[str, dict]], n: int) -> list[tuple[str, dict]]:
    """`n` lines, n / 4 per expected decision, the first ones of each decision in `lines`."""
    if n % len(DECISIONS):
        raise SplitError(f"{n} items cannot split equally over the {len(DECISIONS)} decisions")
    share = n // len(DECISIONS)
    out = []
    for decision in DECISIONS:
        mine = [x for x in lines if x[1].get("expected") == decision][:share]
        if len(mine) < share:
            raise SplitError(f"the pool has only {len(mine)} {decision} items left, {share} are needed")
        out += mine
    return out


def make(source: list[tuple[str, dict]], sets: list[Path], used: list[Path], *, seed: int = SEED, sealed: int = 200,
         holdout: int = 80, unseen: int = 100, days: int = 800) -> tuple[dict[str, list[tuple[str, dict]]], dict]:
    """The splits (name -> source lines, in source order) and what was left out."""
    kept, left = pool(source, sets, used)
    order = sorted(kept, key=lambda x: str(x[1]["id"]))
    random.Random(seed).shuffle(order)
    if len(order) < sealed:
        raise SplitError(f"the pool has {len(order)} items, fewer than the {sealed} the sealed set needs")
    splits = {"fresh_200_c": order[:sealed]}
    rest = order[sealed:]
    for name, n in (("sim_holdout", holdout), ("sim_unseen", unseen)):
        splits[name] = balanced(rest, n)
        taken = {x[1]["id"] for x in splits[name]}
        rest = [x for x in rest if x[1]["id"] not in taken]
    splits["sim_days"] = rest[:days]
    left["pool"] = len(kept)
    left["spare"] = len(rest) - len(splits["sim_days"])
    position = {x[1]["id"]: n for n, x in enumerate(source)}
    return {k: sorted(v, key=lambda x: position[x[1]["id"]]) for k, v in splits.items()}, left


def write(splits: dict[str, list[tuple[str, dict]]], left: dict, out: Path, *, source: Path, seed: int,
          command: str) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    files = {}
    for name in SPLITS:
        path = out / f"{name}.jsonl"
        path.write_text("".join(line + "\n" for line, _item in splits[name]), encoding="utf-8")
        per = Counter(item.get("expected") for _line, item in splits[name])
        files[path.name] = {"items": len(splits[name]), "sha256": sha256_file(path), "purpose": PURPOSE[name],
                            "per_decision": {d: per.get(d, 0) for d in DECISIONS}}  # fmt: skip
    manifest = {
        "status": STATUS, "reason": REASON, "command": command, "seed": seed,
        "source": rel(source), "source_sha256": sha256_file(source), "pool": left["pool"], "spare": left["spare"],
        "left_out": left["reasons"], "sets": left["sets"], "used": left["used"], "files": files,
    }  # fmt: skip
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (out / "MANIFEST.md").write_text(render(manifest))
    return manifest


def render(m: dict) -> str:
    lines = [
        "# Eval splits", "",
        f"Command: `{m['command']}`", "",
        f"Status: **{m['status']}**. {m['reason']}", "",
        f"Source: `{m['source']}` (sha256 `{m['source_sha256'][:16]}`), seed {m['seed']}. All items invented. "
        f"The pool is {m['pool']} items no set or scored report has used; {m['spare']} are left over. "
        "Each file keeps the source's lines byte for byte, in source order. Do not run an eval on fresh_200_c, "
        "or read anything about its items, until it is sealed.", "",
        "| File | Items | share_tagged | share_summary | ask_user | refuse | sha256 | Purpose |",
        "|---|---:|---:|---:|---:|---:|---|---|",
    ]  # fmt: skip
    for name, f in m["files"].items():
        per = f["per_decision"]
        lines.append(f"| {name} | {f['items']} | {' | '.join(str(per[d]) for d in DECISIONS)} | `{f['sha256'][:16]}` | {f['purpose']} |")
    lines += ["", "Left out of the pool:", ""]
    lines += [f"- {reason}: {n}" for reason, n in m["left_out"].items()]
    lines += ["", "Sets checked by id and by result text:", ""]
    lines += [f"- `{path}`: {n} ids" for path, n in m["sets"].items()]
    lines += ["", "Report rows that scored items (ids only):", ""]
    lines += [f"- `{path}`: {n} ids" for path, n in m["used"].items()]
    lines += ["", "Check the files against this manifest: `uv run python -m scripts.make_splits --verify`.", ""]
    return "\n".join(lines)


def verify(out: Path) -> list[str]:
    """Files that are missing or changed since the manifest was written."""
    manifest = json.loads((out / "manifest.json").read_text())
    bad = []
    for name, f in manifest["files"].items():
        path = out / name
        if not path.is_file():
            bad.append(f"{name} is missing")
        elif sha256_file(path) != f["sha256"]:
            bad.append(f"{name} changed since the manifest was written")
    return bad


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = argparse.ArgumentParser(prog="python -m scripts.make_splits", description=__doc__.split("\n")[0])
    p.add_argument("--source", type=Path, default=SOURCE)
    p.add_argument("--sets", nargs="+", type=Path, default=SETS, help="sets whose ids and texts stay out")
    p.add_argument("--used", nargs="*", type=Path, help="report rows whose ids stay out (default: the topic check and nights' unseen test)")
    p.add_argument("--seed", type=int, default=SEED)
    p.add_argument("--sealed", type=int, default=200, help="items in fresh_200_c")
    p.add_argument("--holdout", type=int, default=80, help="items in sim_holdout, a multiple of 4")
    p.add_argument("--unseen", type=int, default=100, help="items in sim_unseen, a multiple of 4")
    p.add_argument("--days", type=int, default=800, help="at most this many items in sim_days")
    p.add_argument("--out", type=Path, default=OUT)
    p.add_argument("--verify", action="store_true", help="check the files against manifest.json and change nothing")
    args = p.parse_args(argv)
    if args.verify:
        bad = verify(args.out)
        print("\n".join(bad) if bad else "Every split matches its manifest.")
        return 1 if bad else 0
    used = used_files() if args.used is None else args.used
    try:
        splits, left = make(read_lines(args.source), args.sets, used, seed=args.seed, sealed=args.sealed,
                            holdout=args.holdout, unseen=args.unseen, days=args.days)  # fmt: skip
    except SplitError as exc:
        print(f"make_splits: {exc}", file=sys.stderr)
        return 1
    manifest = write(splits, left, args.out, source=args.source, seed=args.seed,
                     command=run_eval.shown_command("scripts.make_splits", argv))  # fmt: skip
    for name, f in manifest["files"].items():
        print(f"{name}: {f['items']} items")
    print(f"Pool {manifest['pool']}, spare {manifest['spare']}. Status {STATUS}. Wrote {rel(args.out / 'manifest.json')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
