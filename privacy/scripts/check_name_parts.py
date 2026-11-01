"""Measure what guard.tag leaves in the text when Glimmer's name pass reports only part of a name.

    uv run python -m scripts.check_name_parts [--sets FILE ...] [--guard-module MODULE_OR_FILE]
        [--before-module MODULE_OR_FILE] [--before-label TEXT] [--roster FILE]
        [--name name_parts] [--out eval/reports]

No model calls. This simulates the model's answer; it is not Glimmer. For every item in the sets
(default eval/synthetic.jsonl and eval/tasks.jsonl) whose `result` still shows a `names` or
`other_names` value after the roster pass alone (guard.tag with no name pass), guard.tag runs again
with a fake llm_names that returns one of these answers:

- all: every value in names + other_names
- full: only the longest name of each person (a value that is not a sub-name of another value)
- first: only the first word of each person's longest name (titles skipped)
- last: only the last word of each person's longest name (suffixes such as Jr skipped)
- none: nothing

Like LocalLLM.llm_names, the fake keeps a name only if guard.name_occurs finds it in the text. Each
run gets a fresh in-memory tag map, so no item or answer learns from another. An item leaks when a
names or other_names value still appears in the tagged text (eval/run_eval.py's find_leaks, whose
matcher is _contains). It passes the final check when it leaks and guard.leaks (egress's
final_check) finds nothing in it, so the text would reach Muse. An over-tag is a name tag (student,
teacher or person) on words that are not words of any names or other_names value.

--guard-module picks the guard to measure (default base.guard). --before-module adds a second guard
to compare, for example the guard of an earlier commit saved to a file outside the repo with
`git show REV:base/guard.py`. Writes eval/reports/NAME.md and raw/NAME.jsonl (ids, answer kinds,
leak flags and kinds; never the names themselves). Invented data only.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.util
import json
import re
import shlex
import sys
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from types import ModuleType, SimpleNamespace

from base.config import REPO_ROOT, load_settings
from base.guard import _is_common
from eval.run_eval import _contains, _roster_values, find_leaks, load_items

EVAL = REPO_ROOT / "eval"
ANSWERS = ("all", "full", "first", "last", "none")
ANSWER_TEXT = {
    "all": "every name in names + other_names",
    "full": "only the longest name of each person",
    "first": "only the first word of each name",
    "last": "only the last word of each name",
    "none": "nothing",
}
NAME_KINDS = frozenset({"student", "teacher", "person"})
OVER_KINDS = ("identifier", "family_name", "other")
_TOKEN = re.compile(r"[^\W\d_]+(?:['’\-‐‑][^\W\d_]+)*")
_TITLES = frozenset(
    {"mr", "mrs", "ms", "mx", "dr", "miss", "mister", "coach", "professor", "prof", "sir", "madam"}
)
_SUFFIXES = frozenset({"jr", "sr", "ii", "iii", "iv"})
_POSSESSIVE = re.compile(r"['’]s$", re.IGNORECASE)
TAG_SEED = 0


# ----- the guard under test


def load_guard(spec: str, alias: str) -> ModuleType:
    """A guard module: a dotted module name, or a .py file loaded as its own module `alias`."""
    path = Path(spec)
    if spec.endswith(".py") or path.exists():
        mod_spec = importlib.util.spec_from_file_location(alias, path)
        if mod_spec is None or mod_spec.loader is None:
            raise SystemExit(f"Cannot load a guard from {path.name}.")
        module = importlib.util.module_from_spec(mod_spec)
        sys.modules[alias] = module  # dataclasses look their module up while the file runs
        mod_spec.loader.exec_module(module)
        return module
    return importlib.import_module(spec)


def guard_source(module: ModuleType) -> tuple[str, str]:
    """(display name, first 12 hex of the file's sha256) for the report."""
    path = Path(getattr(module, "__file__", "") or "")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12] if path.is_file() else "unknown"
    return _display(path) if path.name else module.__name__, digest


# ----- the simulated answers


def _words(name: str) -> list[str]:
    return _TOKEN.findall(name)


def _key(word: str) -> str:
    return _POSSESSIVE.sub("", word).lower()


def persons(values: Iterable[str]) -> list[str]:
    """The longest name of each person: every value whose words are not a proper subset of another
    value's words ("Bennick" goes with "Bennick Cinderfall"; two siblings sharing a family name stay
    two people). Order kept, repeats dropped."""
    vals = list(dict.fromkeys(v.strip() for v in values if v and v.strip()))
    sets = [frozenset(_key(w) for w in _words(v)) for v in vals]
    out, seen = [], set()
    for v, s in zip(vals, sets, strict=True):
        if not s or any(s < other for other in sets) or s in seen:
            continue
        seen.add(s)
        out.append(v)
    return out


def first_word(name: str) -> str:
    words = [w for w in _words(name) if _key(w) not in _TITLES]
    return words[0] if words else ""


def last_word(name: str) -> str:
    words = [w for w in _words(name) if _key(w) not in _TITLES | _SUFFIXES]
    return words[-1] if words else ""


def answers(item: Mapping) -> dict[str, list[str]]:
    """What the fake name pass reports for each answer kind."""
    values = [str(v) for v in [*(item.get("names") or []), *(item.get("other_names") or [])] if v]
    people = persons(values)
    picked = {
        "all": values,
        "full": people,
        "first": [first_word(p) for p in people],
        "last": [last_word(p) for p in people],
        "none": [],
    }
    return {kind: [n for n in dict.fromkeys(names) if n] for kind, names in picked.items()}


def fake_llm_names(names: list[str], name_occurs: Callable[[str, str], bool]) -> Callable[[str], list[str]]:
    """llm_names that always reports `names`, filtered the way LocalLLM.llm_names filters Glimmer's."""

    def llm_names(text: str) -> list[str]:
        if not text.strip():
            return []
        return [n for n in names if not n.startswith("[") and name_occurs(n, text)]

    return llm_names


# ----- measuring one item


def name_values(item: Mapping) -> list[str]:
    return [str(v) for v in [*(item.get("names") or []), *(item.get("other_names") or [])] if v]


def name_words(values: Iterable[str]) -> set[str]:
    """Every word of the values, possessive dropped, plus each piece of a hyphenated word."""
    words: set[str] = set()
    for v in values:
        for w in _words(v):
            k = _key(w)
            words.add(k)
            words.update(p for p in re.split(r"[\-‐‑]+", k) if p)
    return words


def over_tags(hits: Iterable, values: Iterable[str], id_spans: Iterable[tuple[int, int]] = ()) -> list[str]:
    """One label per name tag (student, teacher or person) whose words, titles and suffixes aside, are
    not all words of names/other_names values:

    - identifier: the tag overlaps an identifier the guard finds in the raw text, so part of that
      identifier is no longer tagged as one.
    - family_name: the tag starts with a one-word value and adds words after it, likely a family name
      the hand labels left out.
    - other: anything else (a capitalized ordinary word such as a label or a heading).
    """
    values = list(values)
    allowed = name_words(values)
    one_word = {_key(v.strip()) for v in values if len(_words(v)) == 1}
    spans = list(id_spans)
    out: list[str] = []
    for hit in hits:
        if hit.kind not in NAME_KINDS:
            continue
        words = [_key(w) for w in _words(hit.value) if _key(w) not in _TITLES | _SUFFIXES]
        if not words or all(w in allowed for w in words):
            continue
        if any(hit.start < e and s < hit.end for s, e in spans):
            out.append("identifier")
        elif words[0] in one_word and not any(w in allowed for w in words[1:]):
            out.append("family_name")
        else:
            out.append("other")
    return out


def id_digits_left(text: str, identifiers: Iterable[str]) -> bool:
    """Whether the longest digit group (4+ digits) of any identifier still shows in `text`."""
    for ident in identifiers:
        groups = re.findall(r"\d+", str(ident or ""))
        longest = max(groups, key=len, default="")
        if len(longest) >= 4 and re.search(rf"(?<!\d){longest}(?!\d)", text):
            return True
    return False


def tagged(guard: ModuleType, text: str, roster, llm_names=None):
    """guard.tag with a fresh in-memory tag map; returns (TagResult, tag map)."""
    tagmap = guard.TagMap(None, seed=TAG_SEED)
    return guard.tag(text, roster, tagmap, llm_names=llm_names), tagmap


def uncovered(guard: ModuleType, item: Mapping, roster) -> list[str]:
    """names/other_names values the roster pass alone leaves in the item's result."""
    values = name_values(item)
    if not values:
        return []
    result, _ = tagged(guard, item.get("result") or "", roster)
    return [v for v in values if _contains(result.text, v)]


def measure(guard: ModuleType, item: Mapping, names: list[str], roster, roster_values: list[str]) -> dict:
    """One run of guard.tag on the item's result with the fake name pass reporting `names`."""
    text = item.get("result") or ""
    try:
        result, tagmap = tagged(guard, text, roster, fake_llm_names(names, guard.name_occurs))
    except Exception as exc:  # tag raising means egress holds the result: nothing leaves
        return {"leaked": False, "past_final_check": False, "leak_kinds": [], "leak_reason": None, "over_tags": 0,
                "over_tag_kinds": [], "id_digits_left": False, "id_digits_past_final_check": False,
                "error": type(exc).__name__}  # fmt: skip
    services = SimpleNamespace(guard=guard, roster=roster, tagmap=tagmap)
    kinds = find_leaks(services, result.text, item, roster_values)
    leaked = bool({"name", "other_name"} & set(kinds))
    held = any(k.startswith("guard:") for k in kinds)  # egress's final_check would hold the text
    id_spans = [(h.start, h.end) for h in guard.find_identifiers(text, roster)]
    over = over_tags(result.hits, name_values(item), id_spans)
    digits = id_digits_left(result.text, item.get("identifiers") or [])
    return {
        "leaked": leaked,
        "past_final_check": leaked and not held,
        "leak_kinds": kinds,
        "leak_reason": leak_reason(item, names, result.text) if leaked else None,
        "over_tags": len(over),
        "over_tag_kinds": sorted(over),
        "id_digits_left": digits,
        "id_digits_past_final_check": digits and not held,
        "error": None,
    }


def leak_reason(item: Mapping, names: list[str], tagged_text: str) -> str:
    """A short reason, with no names in it, why a labeled name is still in the tagged text."""
    if not names:
        return "nothing was reported"
    raw = item.get("result") or ""
    reasons = set()
    for value in name_values(item):
        if not _contains(tagged_text, value):
            continue
        words = {_key(w) for w in _words(value)}
        mine = [n for n in names if {_key(w) for w in _words(n)} <= words]
        if not mine:
            reasons.add("no word of the leaked name was reported")
        elif all(_lowercase_common(n, raw) for n in mine):
            reasons.add(
                "the only word reported for the leaked name is a common word written in lowercase, "
                "which the guard neither tags nor widens"
            )
        else:
            reasons.add("words reported for the leaked name were tagged, but the rest of it was not reached")
    return "; ".join(sorted(reasons))


def _lowercase_common(word: str, text: str) -> bool:
    word = word.strip()
    if " " in word or not _is_common(word):
        return False
    pattern = re.compile(rf"(?<!\w){re.escape(word)}(?!\w)", re.IGNORECASE)
    return not any(m.group()[:1].isupper() for m in pattern.finditer(text))


# ----- the run


def run(sets: Mapping[str, list[dict]], guards: Mapping[str, ModuleType], roster) -> tuple[dict, list[dict]]:
    """Measure every selected item under every guard and answer.

    Items are selected with the first guard in `guards` (the one under test). Returns
    ({set name: selected items}, raw rows)."""
    main_guard = next(iter(guards.values()))
    roster_values = _roster_values(roster)
    selected: dict[str, list[dict]] = {}
    rows: list[dict] = []
    for set_name, items in sets.items():
        chosen = [item for item in items if uncovered(main_guard, item, roster)]
        selected[set_name] = chosen
        for item in chosen:
            for kind, names in answers(item).items():
                for label, guard in guards.items():
                    row = {"set": set_name, "id": item["id"], "answer": kind, "guard": label, "reported": len(names),
                           "has_identifiers": bool(item.get("identifiers"))}  # fmt: skip
                    row.update(measure(guard, item, names, roster, roster_values))
                    rows.append(row)
    return selected, rows


def summarize(rows: list[dict], set_name: str | None, answer: str, label: str) -> dict:
    picked = [
        r for r in rows if r["answer"] == answer and r["guard"] == label and set_name in (None, r["set"])
    ]
    return {
        "items": len(picked),
        "leaked": sum(r["leaked"] for r in picked),
        "past": sum(r["past_final_check"] for r in picked),
        "over": sum(r["over_tags"] for r in picked),
        "over_items": sum(1 for r in picked if r["over_tags"]),
        "errors": sum(1 for r in picked if r["error"]),
        "leak_ids": [r["id"] for r in picked if r["leaked"]],
        "over_ids": {r["id"]: r["over_tags"] for r in picked if r["over_tags"]},
        "over_kinds": {k: sum(r["over_tag_kinds"].count(k) for r in picked) for k in OVER_KINDS},
        "with_ids": sum(1 for r in picked if r["has_identifiers"]),
        "id_left": sum(r["id_digits_left"] for r in picked),
        "id_left_ids": [r["id"] for r in picked if r["id_digits_left"]],
        "id_past": sum(r["id_digits_past_final_check"] for r in picked),
        "reasons": {r["id"]: r["leak_reason"] for r in picked if r["leaked"]},
    }


def render(
    sets, selected, rows, labels: list[str], sources: Mapping[str, tuple[str, str]], command: str, name: str
) -> list[str]:
    after = labels[0]
    before = labels[1] if len(labels) > 1 else None
    shown = [g for g in (before, after) if g]
    totals = ", ".join(f"{len(selected[s])} of {len(items)} items in {s}" for s, items in sets.items())
    lines = [
        "# Name parts: what guard.tag leaves when the name pass reports part of a name",
        "",
        f"Command: `{command}`",
        "",
        "This is a simulation of the model's answer, not Glimmer itself. No model was called. A fake name "
        "pass stands in for Glimmer's second name pass (LocalLLM.llm_names) and returns a fixed answer built "
        "from each item's hand labels, so the numbers show what the guard does with each kind of answer, "
        "not how often Glimmer gives it.",
        "",
        "## What it measures",
        "",
        f"Items: {totals}. An item is in when its `result` still shows a `names` or `other_names` value "
        "after the roster pass alone (guard.tag with no name pass, the roster loaded the way the eval's "
        "services load it). Only the model's name pass can catch those names.",
        "",
        "For each item, guard.tag runs once per answer and guard, with a fresh in-memory tag map. The fake "
        "keeps a name only if guard.name_occurs finds it in the text, as LocalLLM.llm_names does. Answers:",
        "",
        "- all: every name in names + other_names.",
        "- full: only the longest name of each person. A value whose words are all in another value is "
        "the same person and is dropped.",
        "- first: only the first word of each person's longest name. Titles such as Mr and Ms are skipped.",
        "- last: only the last word of each person's longest name. Suffixes such as Jr are skipped.",
        "- none: nothing.",
        "",
        "Columns:",
        "",
        "- Leaked: items where a names or other_names value still appears in the tagged text "
        "(eval/run_eval.py's find_leaks, matcher _contains).",
        "- Past final check: leaked items in which guard.leaks (egress's final_check, with the same tag map) "
        "finds nothing, so egress would send the text to Muse. Egress holds the others.",
        "- Over-tags: name tags (student, teacher or person) on words that are not words of any names or "
        "other_names value. Counted as tags; the number of items with any is in brackets.",
        "",
        "Guards:",
        "",
    ]
    for label in labels:
        path, digest = sources[label]
        lines.append(f"- {label}: `{path}`, sha256 {digest}.")
    lines += [
        "",
        "A guard shown by file name only was loaded from a file outside the repo, such as an earlier "
        "commit's guard saved with `git show REV:base/guard.py`. `git show REV:base/guard.py | shasum -a 256` "
        "tells which commit it is.",
        "",
    ]

    cols = ["Leaked", "Past final check", "Over-tags"]
    head = (
        "| Model answer | Items | "
        + " | ".join(f"{c} {g}" if before else c for c in cols for g in shown)
        + " |"
    )
    rule = "|---" * (2 + len(cols) * len(shown)) + "|"

    def row(first: str, set_name: str | None, answer: str) -> str:
        stats = {g: summarize(rows, set_name, answer, g) for g in shown}
        cells = []
        for key in ("leaked", "past", "over"):
            for g in shown:
                st = stats[g]
                cells.append(f"{st['over']} ({st['over_items']})" if key == "over" else str(st[key]))
        return f"| {first} | {stats[after]['items']} | " + " | ".join(cells) + " |"

    lines += ["## All items", "", head, rule]
    lines += [row(answer, None, answer) for answer in ANSWERS]
    errors = sum(1 for r in rows if r["error"])
    lines += ["", f"guard.tag raised on {errors} runs (counted as held, not leaked).", ""]

    for answer in ANSWERS:
        a = summarize(rows, None, answer, after)
        lines += [
            f"## Answer: {answer} ({ANSWER_TEXT[answer]})",
            "",
            head.replace("Model answer", "Set"),
            rule,
        ]
        lines += [row(set_name, set_name, answer) for set_name in sets]
        lines.append("")
        if answer == "none":
            lines += ["Every item leaks under every guard here, by construction: the items are the ones the "
                      "roster pass alone leaves names in. This row checks the selection.", ""]  # fmt: skip
            continue
        lines.append(f"Still leak after ({after}): {_ids(a['leak_ids'])}.")
        lines += [f"- {item_id}: {a['reasons'][item_id]}." for item_id in a["leak_ids"]]
        lines.append("")
        if before:
            b = summarize(rows, None, answer, before)
            gained = sorted(i for i, n in a["over_ids"].items() if n > b["over_ids"].get(i, 0))
            lines += [
                f"Leaked before ({before}): {_ids(b['leak_ids'])}.",
                "",
                f"Items with more over-tags after than before: {len(gained)}.",
                "",
            ]

    lines += ["## Over-tags by kind", "",
              "- identifier: the tag overlaps an identifier the guard finds in the raw text (a student id's "
              "leading S, for example), so that identifier is no longer tagged as one.",
              "- family_name: the tag is a one-word labeled name plus the words after it, likely a family "
              "name the hand labels left out.",
              "- other: any other word, such as a capitalized label or heading next to a name.", "",
              "| Model answer | Guard | identifier | family_name | other |", "|---|---|---|---|---|"]  # fmt: skip
    for answer in ANSWERS:
        for g in shown:
            k = summarize(rows, None, answer, g)["over_kinds"]
            lines.append(f"| {answer} | {g} | {k['identifier']} | {k['family_name']} | {k['other']} |")
    lines += ["",
              "## Identifier digits left in the tagged text", "",
              "Items whose hand-labeled `identifiers` still show their longest digit group (4 or more digits) "
              "in the tagged text. find_leaks matches whole identifiers only, so it does not count these. Past "
              "final check: guard.leaks finds nothing in the tagged text, so egress would send it.", "",
              "| Model answer | Items with identifiers | "
              + " | ".join(f"Digits left {g}" for g in shown) + " | "
              + " | ".join(f"Past final check {g}" for g in shown) + " |",
              "|---" * (2 + 2 * len(shown)) + "|"]  # fmt: skip
    for answer in ANSWERS:
        st = {g: summarize(rows, None, answer, g) for g in shown}
        cells = [str(st[g]["id_left"]) for g in shown] + [str(st[g]["id_past"]) for g in shown]
        lines.append(f"| {answer} | {st[after]['with_ids']} | " + " | ".join(cells) + " |")
    lines.append("")
    left = {
        g: sorted({i for answer in ANSWERS for i in summarize(rows, None, answer, g)["id_left_ids"]})
        for g in shown
    }
    for g in shown:
        lines.append(f"Items with digits left under {g}, any answer: {_ids(left[g])}.")
    if before:
        new = sorted(set(left[after]) - set(left[before]))
        lines += ["", f"Items with digits left under {after} and not under {before}: {len(new)}."]
    lines += [
        "",
        "## Limits",
        "",
        "- The answers are built from hand labels, so the fake never reports a word that is not a name. "
        "Glimmer can, and a capitalized false positive next to other capitalized words would be widened "
        "too. The over-tag counts here do not measure that.",
        "- Hand labels have gaps (a family name left out) and slips (a lowercase word inside a name), "
        "which show up as family_name over-tags and as leaks of the last-word answer.",
        "- Only `result` is tagged. Summaries and Muse's request are not part of this check.",
        "- Each run uses a fresh tag map. On a device the tag map persists, so a name tagged in an "
        "earlier result is caught later too.",
        "",
        f"Raw rows: raw/{name}.jsonl next to this report (ids, answer kinds, leak flags and kinds; never "
        "the names).",
        "",
    ]
    return lines


def _ids(ids: list[str]) -> str:
    return ", ".join(ids) if ids else "none"


def _display(path: Path) -> str:
    """A repo path relative to the repo; anything outside it by its file name only."""
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return path.name


def _shown_args(argv: list[str]) -> list[str]:
    """argv with every path shown as _display shows it, so no path outside the repo is written."""
    return [_display(Path(a)) if "/" in a or a.endswith((".py", ".jsonl", ".json")) else a for a in argv]


def main(argv: list[str] | None = None, settings=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sets", type=Path, nargs="+", default=[EVAL / "synthetic.jsonl", EVAL / "tasks.jsonl"])
    ap.add_argument("--guard-module", default="base.guard", help="guard to measure: module name or .py file")
    ap.add_argument("--guard-label", default="after")
    ap.add_argument("--before-module", help="a second guard to compare: module name or .py file")
    ap.add_argument("--before-label", default="before")
    ap.add_argument(
        "--roster", type=Path, help="roster file (default: the settings' roster, as the eval loads it)"
    )
    ap.add_argument("--name", default="name_parts", help="report file name")
    ap.add_argument("--out", type=Path, default=EVAL / "reports")
    args = ap.parse_args(argv)
    raw_argv = argv if argv is not None else sys.argv[1:]
    command = "uv run python -m scripts.check_name_parts " + shlex.join(_shown_args(list(raw_argv)))
    if args.before_module and args.before_label == args.guard_label:
        ap.error("--before-label and --guard-label must differ")

    guards = {args.guard_label: load_guard(args.guard_module, "check_name_parts_guard")}
    if args.before_module:
        guards[args.before_label] = load_guard(args.before_module, "check_name_parts_before")
    roster_path = args.roster or (settings or load_settings()).roster_path
    roster = guards[args.guard_label].load_roster(roster_path)
    sets = {path.stem: load_items(path) for path in args.sets}
    selected, rows = run(sets, guards, roster)
    sources = {label: guard_source(mod) for label, mod in guards.items()}
    lines = render(sets, selected, rows, list(guards), sources, command, args.name)

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"{args.name}.md").write_text("\n".join(lines))
    raw = args.out / "raw" / f"{args.name}.jsonl"
    raw.parent.mkdir(parents=True, exist_ok=True)
    keep = ("set", "id", "answer", "guard", "reported", "leaked", "past_final_check", "leak_kinds", "leak_reason",
            "over_tags", "over_tag_kinds", "has_identifiers", "id_digits_left", "id_digits_past_final_check",
            "error")  # fmt: skip
    raw.write_text("".join(json.dumps({k: r[k] for k in keep}) + "\n" for r in rows))
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
