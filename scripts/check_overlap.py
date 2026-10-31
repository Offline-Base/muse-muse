"""Check a training file for overlap with the eval sets before its model is scored on them.

    uv run python -m scripts.check_overlap --train FILE [FILE ...] --name NAME [--sets eval/*.jsonl]
        [--threshold 0.8] [--shingle 3] [--roster eval/roster.json] [--out eval/reports]

Standard library only, so it also runs on the machine that did the training (python3 -m
scripts.check_overlap from a copy of the repo). Training JSONL may be in any shape: chat
"messages", dreaming rows or raw eval-style items. Every string in a row counts, and so does each
line of it with a leading "Label:" dropped, so the router's prompt layout ("Request: ...") still
matches. For each eval set (default: every eval/*.jsonl and the demo essays) it counts items with:

- an exact match: one of the item's texts (request, result, text, or a line of them), normalized
  (lowercase, punctuation dropped, tags like [Student A] folded to one token), equals a training
  string or line. Results are also compared with their names and identifiers replaced by a tag,
  the way a training file built from tagged results would hold them.
- a near duplicate: word-shingle Jaccard similarity at or above the threshold to a training string
  or line, when there is no exact match. The defaults, one-word shingles and 0.8, are the token
  Jaccard rule scripts/make_synthetic.py used; --shingle 3 asks for runs of three words instead.
- a name: one of the item's invented full names (`names`, `other_names`) appears in a training row.
- an id: the item's id (syn-0122, t001) appears in a training row.

It also counts training rows holding a full name from the roster. Texts under 5 words are not
compared. It prints and writes counts only, never a text, name or id, to eval/reports/overlap_NAME.md,
and exits 1 on any hit, 0 when the training file shares nothing with the sets.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shlex
import sys
import unicodedata
from collections import Counter
from collections.abc import Iterable, Iterator
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVAL = ROOT / "eval"
DEFAULT_SETS = [*sorted(EVAL.glob("*.jsonl")), ROOT / "demo" / "essays"]
THRESHOLD = 0.8  # the make_synthetic rule for "too close"
SHINGLE = 1  # one-word shingles: token Jaccard, the rule make_synthetic used to keep its items apart
MIN_WORDS = 5
TEXT_FIELDS = ("request", "result", "text", "summary")
_TAG = re.compile(r"\[[A-Za-z][^\[\]\n]{0,40}\]")
_TAG_WORD = "zztagzz"
_LABEL = re.compile(r"^\s*[A-Za-z][A-Za-z ]{0,30}:\s*")
_TOKEN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def normalize(text: str) -> str:
    """Lowercase words and digits only, each tag (and each run of tags) as one token."""
    text = _TAG.sub(f" {_TAG_WORD} ", unicodedata.normalize("NFKC", text).lower())
    out: list[str] = []
    for word in re.findall(r"[a-z0-9]+", text):
        if not (word == _TAG_WORD and out and out[-1] == _TAG_WORD):
            out.append(word)
    return " ".join(out)


def shingles(norm: str, k: int = SHINGLE) -> frozenset[str]:
    words = norm.split()
    return frozenset(" ".join(words[i : i + k]) for i in range(len(words) - k + 1))


def strings(value) -> Iterator[str]:
    """Every string inside a JSON value."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from strings(v)


def pieces(text: str) -> set[str]:
    """The normalized text, each line of it, and each line without a leading label."""
    out = {normalize(text)}
    for line in text.splitlines():
        out.add(normalize(line))
        out.add(normalize(_LABEL.sub("", line)))
    return {p for p in out if len(p.split()) >= MIN_WORDS}


def tagger(names: Iterable[str]) -> re.Pattern | None:
    """A pattern for each name and each word of it (two letters or more), longest first."""
    words = {n.strip() for n in names if n and n.strip()}
    words |= {w for n in list(words) for w in n.split() if len(w.strip(".,'")) >= 2}
    if not words:
        return None
    alternation = "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True))
    return re.compile(rf"(?<!\w)(?:{alternation})(?!\w)", re.IGNORECASE)


class Training:
    """The training rows, indexed for exact, near and name lookups."""

    def __init__(self, files: list[Path], k: int = SHINGLE):
        self.k = k
        self.rows: list[str] = []  # each row's strings joined, lowercased
        self.unreadable = 0
        segments: set[str] = set()
        for path in files:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    self.unreadable += 1
                    continue
                texts = list(strings(row))
                self.rows.append("\n".join(texts).lower())
                for text in texts:
                    segments |= pieces(text)
        self.exact = segments
        self.sets = [shingles(s, k) for s in segments]
        self.index: dict[str, list[int]] = {}
        for i, sh in enumerate(self.sets):
            for s in sh:
                self.index.setdefault(s, []).append(i)
        self.words = {w for row in self.rows for w in re.findall(r"[a-z0-9]+", row)}
        self.tokens = {t for row in self.rows for t in _TOKEN.findall(row)}

    def near(self, norm: str, threshold: float) -> bool:
        """Whether a training string's shingles reach Jaccard `threshold` with `norm`'s. Prefix
        filtering: a match must hold one of A's rarest |A| - ceil(t|A|) + 1 shingles."""
        a = shingles(norm, self.k)
        if not a:
            return False
        prefix = sorted(a, key=lambda s: len(self.index.get(s, ())))[: len(a) - math.ceil(threshold * len(a)) + 1]
        seen: set[int] = set()
        for s in prefix:
            for i in self.index.get(s, ()):
                if i in seen:
                    continue
                seen.add(i)
                b = self.sets[i]
                if threshold * len(b) > len(a) or threshold * len(a) > len(b):
                    continue
                inter = len(a & b)
                if inter / (len(a) + len(b) - inter) >= threshold:
                    return True
        return False

    @staticmethod
    def name_pattern(name: str) -> str:
        words = re.findall(r"[a-z0-9]+", name.lower())
        return r"(?<!\w)" + r"\W+".join(map(re.escape, words)) + r"(?!\w)"

    def has_name(self, name: str) -> bool:
        words = re.findall(r"[a-z0-9]+", name.lower())
        if not words or any(w not in self.words for w in words):  # cheap: most names are in no row
            return False
        pattern = re.compile(self.name_pattern(name))
        return any(pattern.search(row) for row in self.rows)

    def rows_with(self, names: Iterable[str]) -> tuple[int, int]:
        """(training rows holding any of `names`, how many of the names appear)."""
        found = [n for n in names if self.has_name(n)]
        if not found:
            return 0, 0
        pattern = re.compile("|".join(self.name_pattern(n) for n in found))
        return sum(1 for row in self.rows if pattern.search(row)), len(found)


def load_set(path: Path) -> list[dict]:
    """Items of a .jsonl set, or one item per .md file of a folder (the demo essays)."""
    if path.is_dir():
        return [{"text": p.read_text(encoding="utf-8", errors="replace")} for p in sorted(path.glob("*.md"))]
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def full_names(item: dict) -> list[str]:
    return [n for n in [*item.get("names", []), *item.get("other_names", [])] if isinstance(n, str) and len(n.split()) >= 2]


def roster_names(path: Path) -> list[str]:
    if not path.is_file():
        return []
    data = json.loads(path.read_text())
    people = [data.get("teacher") or {}, *data.get("students", [])]
    return [p["name"] for p in people if isinstance(p.get("name"), str) and len(p["name"].split()) >= 2]


def check_item(item: dict, train: Training, roster_tagger: re.Pattern | None, threshold: float) -> dict[str, bool]:
    own = tagger([*item.get("names", []), *item.get("other_names", []), *map(str, item.get("identifiers", []))])
    norms: set[str] = set()
    for field in TEXT_FIELDS:
        text = item.get(field)
        if not isinstance(text, str):
            continue
        variants = [text]
        for pattern in (own, roster_tagger):
            if pattern is not None:
                variants.append(pattern.sub("[x]", variants[-1]))
        for v in variants:
            norms |= pieces(v)
    exact = any(n in train.exact for n in norms)
    near = not exact and any(train.near(n, threshold) for n in norms)
    names = any(train.has_name(n) for n in full_names(item))
    item_id = str(item.get("id", "")).lower()
    ids = bool(item_id) and item_id in train.tokens
    return {"exact": exact, "near": near, "names": names, "ids": ids}


def check(train: Training, sets: list[Path], roster: Path, threshold: float) -> tuple[list[dict], dict]:
    roster_list = roster_names(roster)
    roster_tagger = tagger(roster_list)
    rows = []
    for path in sets:
        items = load_set(path)
        counts = Counter()
        for item in items:
            hit = check_item(item, train, roster_tagger, threshold)
            counts.update(k for k, v in hit.items() if v)
            counts["any"] += any(hit.values())
        rows.append({"set": path.name + ("/" if path.is_dir() else ""), "items": len(items), **{
            k: counts[k] for k in ("exact", "near", "names", "ids", "any")}})  # fmt: skip
    with_roster, distinct = train.rows_with(roster_list)
    return rows, {"roster_rows": with_roster, "roster_names": distinct, "roster_size": len(roster_list)}


def render(name: str, command: str, train: Training, files: list[Path], rows: list[dict], roster: dict,
           threshold: float, k: int) -> str:
    hits = sum(r["any"] for r in rows) + roster["roster_rows"]
    lines = [
        f"# Overlap check: {name}",
        "",
        f"Command: `{command}`",
        "",
        f"Date: {date.today().isoformat()}. Training files: {', '.join(p.name for p in files)}; {len(train.rows)} rows, "
        f"{train.unreadable} unreadable lines, {len(train.exact)} strings and lines compared.",
        "",
        f"Exact: equal after normalizing (lowercase, punctuation dropped, tags folded; results also with their names "
        f"and identifiers tagged). Near: word {k}-shingle Jaccard >= {threshold} with no exact match. Names: an "
        f"item's invented full name in a training row. Ids: the item's id in a training row. Texts under "
        f"{MIN_WORDS} words are not compared. Counts are items; an item can count in several columns.",
        "",
        "| Set | Items | Exact | Near | Names | Ids | Any |",
        "|---|---|---|---|---|---|---|",
        *(f"| {r['set']} | {r['items']} | {r['exact']} | {r['near']} | {r['names']} | {r['ids']} | {r['any']} |" for r in rows),
        "",
        f"Training rows with a full name from the roster: {roster['roster_rows']} "
        f"({roster['roster_names']} of the roster's {roster['roster_size']} names).",
        "",
        "Result: " + ("clean, no overlap found." if not hits else "overlap found. Do not score this model on a set with hits."),
        "",
        "Counts only: no item text, name or id is written here.",
        "",
    ]
    return "\n".join(lines)


def shown(arg: str) -> str:
    """A path as its base name (also after --flag=), so the command carries no folders or home path."""
    flag, eq, value = arg.partition("=") if arg.startswith("--") else ("", "", arg)
    return f"{flag}{eq}{Path(value).name if '/' in value else value}"


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--train", nargs="+", type=Path, required=True, help="training JSONL file(s)")
    p.add_argument("--sets", nargs="+", type=Path, default=DEFAULT_SETS, help="eval sets (.jsonl) or folders of .md")
    p.add_argument("--name", required=True, help="the report's name: eval/reports/overlap_NAME.md")
    p.add_argument("--threshold", type=float, default=THRESHOLD, help="near-duplicate Jaccard (default 0.8)")
    p.add_argument("--shingle", type=int, default=SHINGLE, help="words per shingle (default 1)")
    p.add_argument("--roster", type=Path, default=EVAL / "roster.json")
    p.add_argument("--out", type=Path, default=EVAL / "reports")
    args = p.parse_args(argv)
    if args.sets is DEFAULT_SETS:  # a copy of the repo without demo/ still checks the eval sets
        args.sets = [s for s in DEFAULT_SETS if s.exists()]
    if not 0 < args.threshold <= 1 or args.shingle < 1:
        p.error("--threshold must be in (0, 1] and --shingle 1 or more")
    for path in [*args.train, *args.sets]:
        if not path.exists():
            p.error(f"no file or folder named {path.name}")
    train = Training(args.train, args.shingle)
    rows, roster = check(train, args.sets, args.roster, args.threshold)
    command = "uv run python -m scripts.check_overlap " + shlex.join(shown(a) for a in argv)
    text = render(args.name, command, train, args.train, rows, roster, args.threshold, args.shingle)
    args.out.mkdir(parents=True, exist_ok=True)
    out = args.out / f"overlap_{re.sub(r'[^A-Za-z0-9_.-]+', '_', args.name)}.md"
    out.write_text(text)
    print(text)
    print(f"Wrote {out.name}")
    return 1 if sum(r["any"] for r in rows) + roster["roster_rows"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
