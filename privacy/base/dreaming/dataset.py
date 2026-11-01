"""Build the dreaming training set from the user's decisions and the invented practice items.

User rows weigh 3 and synthetic rows 1. Deleted rows, undecided rows and holdout items never
make it in, so deleting a decision removes it from the next nightly rebuild.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from base.types import DECISIONS

USER_WEIGHT = 3
SYNTHETIC_WEIGHT = 1


@dataclass(frozen=True)
class Example:
    """One labeled router example. The first five fields are the contract; the rest help training."""

    request: str
    result_kind: str
    tagged_text: str
    label: str
    weight: int
    topics: tuple[str, ...] = ()
    source: str = "user"  # "user" or "synthetic"
    approved: bool | None = None
    remember: bool | None = None
    row_id: str | None = None
    item_id: str | None = None


def parse_topics(value: object) -> tuple[str, ...]:
    """Topics arrive as a list, JSON text or a comma list. Return them sorted and unique."""
    if value is None or value == "":
        return ()
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            parsed = value.split(",")
        value = parsed if isinstance(parsed, list) else [parsed]
    if not isinstance(value, Iterable):
        value = [value]
    return tuple(sorted({str(t).strip() for t in value if str(t).strip()}))


def build(store, synthetic_path: str | Path | None, holdout_ids: Iterable[str] = ()) -> list[Example]:
    """User decisions from `store` (an ApprovalStore) plus synthetic items, minus holdout and deleted rows."""
    from base.approvals import label_for  # approvals owns the labeling rule

    holdout = {str(i) for i in holdout_ids}
    examples: list[Example] = []
    for raw in store.training_rows():
        row = dict(raw)
        if row.get("deleted") or not row.get("user_decision"):
            continue
        item_id = row.get("item_id")
        label = label_for(row)
        if label is None or (item_id is not None and str(item_id) in holdout):
            continue
        examples.append(
            Example(
                request=row.get("request") or "",
                result_kind=row.get("result_kind") or "free_text",
                tagged_text=row.get("tagged_text") or "",
                label=label,
                weight=USER_WEIGHT,
                topics=parse_topics(row.get("topics")),
                source="user",
                approved=row.get("user_decision") == "approve",
                remember=bool(row.get("remember")),
                row_id=None if row.get("id") is None else str(row["id"]),
                item_id=None if item_id is None else str(item_id),
            )
        )
    examples.extend(load_synthetic(synthetic_path, holdout))
    return examples


def load_synthetic(path: str | Path | None, holdout: set[str] | frozenset[str] = frozenset()) -> list[Example]:
    """Synthetic items labeled with their `expected` decision. A missing file means no practice data."""
    if not path or not Path(path).is_file():
        return []
    out: list[Example] = []
    for line in Path(path).read_text().splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        if str(item.get("id")) in holdout or item.get("expected") not in DECISIONS:
            continue
        text = item.get("tagged_text") or mask(
            item.get("result", ""), item.get("names") or [], item.get("identifiers") or []
        )
        out.append(
            Example(
                request=item.get("request", ""),
                result_kind=item.get("result_kind", "free_text"),
                tagged_text=text,
                label=item["expected"],
                weight=SYNTHETIC_WEIGHT,
                topics=parse_topics(item.get("topics")),
                source="synthetic",
                item_id=None if item.get("id") is None else str(item["id"]),
            )
        )
    return out


def mask(text: str, names: Iterable[str], identifiers: Iterable[str]) -> str:
    """Swap an invented item's ground-truth names and identifiers for tags, longest first."""
    tags: dict[str, str] = {}
    for i, name in enumerate(dict.fromkeys(n for n in names if n)):
        tags[name] = f"[Student {_letters(i)}]"
    for i, value in enumerate(dict.fromkeys(v for v in identifiers if v), start=1):
        tags.setdefault(value, f"[ID {i}]")
    for value in sorted(tags, key=len, reverse=True):
        pattern = rf"(?<!\w){re.escape(value)}(?!\w)"
        text = re.sub(pattern, lambda _m, tag=tags[value]: tag, text, flags=re.IGNORECASE)
    return text


def _letters(i: int) -> str:
    return chr(ord("A") + i % 26) * (1 + i // 26)
