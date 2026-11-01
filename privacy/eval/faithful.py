"""A screen for made-up content in a summary a model wrote: numbers and quotes the result does not hold.

The summary prompt says to use only the numbers and facts in the result (base/egress.py). This counts
what breaks that in a way a script can see, and returns counts only, never text:

- a number is supported when the result states it, when the item's hand-written reference summary
  states it (an eval item's `summary`, whose numbers were worked out by hand), or when it is a simple
  step from what the result states: N - k or k / N as a percent for a "k of N" in the result, or the
  mean or median of a column of per-student scores, rounded to one or two decimals. Without a
  reference, a count of the names a result lists is not supported, so a result written as name lists
  needs one;
- a quote (three or more words in double quotes) is supported when the result holds it word for word,
  with any tag such as [Student A] standing for any name.

It cannot see a wrong claim made in words ("most students improved"), a comparison the result does not
make, or a correct number put on the wrong thing. A clean screen is not proof that a summary is right.
"""

from __future__ import annotations

import re
import statistics
from collections.abc import Iterable
from decimal import ROUND_HALF_UP, Decimal

from base.guard import TAG_RE

_NUMBER = re.compile(r"(?<![\d.])\d+(?:\.\d+)?(?!\.\d)")
_THOUSANDS = re.compile(r"(?<=\d),(?=\d{3}\b)")
_K_OF_N = re.compile(r"(?<![\d.])(\d+)\s*(?:of|out of|/)\s*(?:the\s+)?(\d+)(?![\d.])", re.I)
_QUOTE = re.compile(r"[\"“]([^\"“”]{3,400})[\"”]")
_SLASH_ROW = re.compile(r"(?<![\d.])\d+(?:\.\d+)?(?:/\d+(?:\.\d+)?){1,}(?![\d.])")
# "Ann Example 15;" in a list of totals: a score right after a person's full name.
_NAMED_VALUE = re.compile(r"[A-Z][a-z'-]+(?: [A-Z][a-z'-]+)+ (\d+(?:\.\d+)?)(?![\d/]|\.\d)")


def numbers(text: str) -> list[float]:
    return [float(m) for m in _NUMBER.findall(_THOUSANDS.sub("", text))]


def _key(x: float) -> float:
    return round(x, 2)


def _rounded(x: float) -> set[float]:
    """x as a summary may write it: whole, one or two decimals, half up or half to even."""
    out = set()
    for places in ("1", "0.1", "0.01"):
        out.add(float(Decimal(str(x)).quantize(Decimal(places), rounding=ROUND_HALF_UP)))
        out.add(round(x, len(places) - 2 if places != "1" else 0))
    return {_key(v) for v in out}


def supported_numbers(result: str) -> set[float]:
    """Every number the result states or that a summary may derive from it in one simple step."""
    stated = numbers(result)
    ok = {_key(x) for x in stated}
    for k, n in ((int(a), int(b)) for a, b in _K_OF_N.findall(result)):
        if 0 <= k <= n and n:
            ok |= {_key(n - k), _key(round(100 * k / n)), _key(round(100 * (n - k) / n)), _key(round(100 * k / n, 1))}
    columns: list[list[float]] = []
    for row in _SLASH_ROW.findall(result):
        for i, value in enumerate(float(v) for v in row.split("/")):
            if i >= len(columns):
                columns.append([])
            columns[i].append(value)
    named = [float(v) for v in _NAMED_VALUE.findall(result)]
    groups = [c for c in columns if len(c) > 1] + ([named] if len(named) > 2 else [])
    for values in groups:
        for stat in (statistics.mean(values), statistics.median(values), sum(values)):
            ok |= _rounded(stat)
        ok.add(_key(len(values)))
    return ok


def _normal(text: str) -> str:
    text = text.replace("’", "'").replace("‘", "'").lower()
    return re.sub(r"\s+", " ", text).strip()


def _quote_pattern(quote: str) -> re.Pattern:
    parts = TAG_RE.split(_normal(quote)) if "[" in quote else [_normal(quote)]
    return re.compile(r".{1,80}?".join(re.escape(p) for p in parts))


def quotes(text: str) -> list[str]:
    return [q.strip() for q in _QUOTE.findall(text) if len(q.split()) >= 3]


def check(summary: str, result: str, reference: str | None = None) -> dict[str, int]:
    """Counts for one summary against the result it was written from (and a correct reference summary)."""
    ok = supported_numbers(result) | {_key(x) for x in numbers(reference or "")}
    nums = numbers(TAG_RE.sub(" ", summary))
    source = _normal(result)
    qs = quotes(summary)
    return {
        "numbers": len(nums),
        "unsupported_numbers": sum(_key(x) not in ok for x in nums),
        "quotes": len(qs),
        "unsupported_quotes": sum(not _quote_pattern(q).search(source) for q in qs),
    }


def merge(checks: Iterable[dict[str, int]]) -> dict[str, int] | None:
    out: dict[str, int] = {}
    for c in checks:
        for k, v in c.items():
            out[k] = out.get(k, 0) + v
    return out or None


def unsupported(c: dict | None) -> bool:
    return bool(c) and (c.get("unsupported_numbers", 0) > 0 or c.get("unsupported_quotes", 0) > 0)
