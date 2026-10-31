"""Redaction guard. See the Guard section of docs/CONTRACTS.md.

The guard finds roster names and personal identifiers in text, swaps them for tags such as
[Student C] or [Phone 1] (the same all day; with TAG_ROTATION=daily a new set each day, see
TagMap), swaps tags back in Muse's requests, and reports anything that would leak.
It runs on the device with plain regexes and a one-edit string check, so it keeps working when no
model is reachable. The local model only adds an optional second pass for names (`llm_names`).
Each word of a name from that pass is tagged alone too, a one-word name grows by up to two
capitalized neighbors that look like a name, and every one of these values stays in the tag map,
so later texts and the final leak check catch them with no model call (see _extra_name_cands).

Ideas for the exact checks (Luhn, one-time codes next to a code word) came from decision-guard's
prefilters; this is new Python written for this repo.
"""

from __future__ import annotations

import contextlib
import json
import os
import random
import re
import secrets
import sqlite3
import threading
import time
import unicodedata
from collections.abc import Callable, Collection, Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime
from functools import lru_cache, partial
from pathlib import Path
from typing import Any

from base.types import Hit, Person, Roster, TagResult

__all__ = [
    "GuardError",
    "TAG_RE",
    "TagMap",
    "TagView",
    "blocked_reasons",
    "blocked_topics",
    "find_identifiers",
    "find_names",
    "leaks",
    "load_roster",
    "luhn_valid",
    "neutralize_tags",
    "restore",
    "tag",
    "tag_references",
]


class GuardError(RuntimeError):
    """Raised when text cannot be tagged cleanly. Callers must hold the result."""


# Every tag the guard writes. Text inside a tag is never matched again, which keeps tag() idempotent.
TAG_RE = re.compile(
    r"\[(?:Student [A-Z]{1,3}|Teacher|(?:Person|Phone|Email|SSN|Card|Code|ID|Address|DOB|Redacted|Place|Date|Age|Detail|Record|URL|IP) \d+)\]"
)

_LABELS = {
    "person": "Person",
    "phone": "Phone",
    "email": "Email",
    "ssn": "SSN",
    "card": "Card",
    "otp": "Code",
    "student_id": "ID",
    "address": "Address",
    "dob": "DOB",
    "term": "Redacted",  # a word or phrase on the user's always-redact list (Redaction.always)
    # Tagged only when a compliance toggle asks for them (Redaction.extra_kinds).
    "place": "Place",
    "date": "Date",
    "age": "Age",
    "detail": "Detail",
    "record": "Record",
    "url": "URL",
    "ip": "IP",
}
_KIND_BY_LABEL = {label.lower(): kind for kind, label in _LABELS.items()}
_NAME_KINDS = frozenset({"student", "teacher", "person"})
# Identifiers no control may leave untagged.
ALWAYS_TAGGED = frozenset({"ssn", "card"})
EXTRA_KINDS = frozenset({"place", "date", "age", "detail", "record", "url", "ip"})


@dataclass(frozen=True)
class Redaction:
    """The user's redaction controls for one result (see base/controls.py). The default tags everything.

    skip_kinds: identifier kinds left as written (never ssn or card). names=False: names (roster,
    model-found and known) left as written, for folders the user chose. always: words and phrases
    always tagged, as [Redacted N]. never: words and phrases left as written wherever they occur,
    except inside an SSN or card number. always wins over never. extra_kinds: more kinds of detail
    to tag, from a compliance toggle (base/compliance.py). name_shapes: also tag capitalized words
    shaped like a name, with no model, because the small local model misses names (DEVICE_ONLY=1).
    """

    skip_kinds: frozenset[str] = frozenset()
    names: bool = True
    always: tuple[str, ...] = ()
    never: tuple[str, ...] = ()
    extra_kinds: frozenset[str] = frozenset()
    name_shapes: bool = False

    def __post_init__(self):
        object.__setattr__(self, "skip_kinds", frozenset(self.skip_kinds) - ALWAYS_TAGGED)
        object.__setattr__(self, "always", tuple(w.strip() for w in self.always if w and w.strip()))
        object.__setattr__(self, "never", tuple(w.strip() for w in self.never if w and w.strip()))

    @property
    def is_default(self) -> bool:
        return not (self.skip_kinds or self.always or self.never or self.extra_kinds or self.name_shapes) and self.names


def _phrase_spans(text: str, phrases: Iterable[str]) -> list[tuple[int, int, str]]:
    """Case-insensitive whole-word occurrences of each phrase: (start, end, phrase)."""
    spans = []
    for phrase in phrases:
        pattern = re.compile(rf"(?<!\w){re.escape(phrase)}(?!\w)", re.IGNORECASE)
        spans += [(m.start(), m.end(), phrase) for m in pattern.finditer(text)]
    return spans


def _apply_redaction(cands: list[_Cand], t: str, redaction: Redaction | None) -> list[_Cand]:
    """The candidates the user's controls keep, plus their always-redact words."""
    if redaction is None or redaction.is_default:
        return cands
    never = [(a, b) for a, b, _p in _phrase_spans(t, redaction.never)]
    kept = []
    for c in cands:
        if c.kind not in ALWAYS_TAGGED:
            if c.kind in redaction.skip_kinds or (not redaction.names and c.kind in _NAME_KINDS):
                continue
            if any(a <= c.start and c.end <= b for a, b in never):
                continue
        kept.append(c)
    for a, b, phrase in _phrase_spans(t, redaction.always):
        kept.append(_Cand("term", t[a:b], a, b, phrase.lower()))
    extra: list[_Cand] = []
    if redaction.extra_kinds:
        extra += _extra_cands(t, redaction.extra_kinds, kept)
    if redaction.name_shapes and redaction.names and "detail" not in redaction.extra_kinds:
        taken = [(c.start, c.end) for c in kept] + _tag_spans(t)
        extra += _strict_details(t, taken, kind="person", need_uncommon=True)
    return kept + [c for c in extra if not any(a <= c.start and c.end <= b for a, b in never)]

# When two candidate spans have the same length, the earlier kind in this order wins.
_PRIORITY = {
    k: i
    for i, k in enumerate(
        [
            "card",
            "ssn",
            "email",
            "phone",
            "address",
            "dob",
            "student_id",
            "otp",
            "teacher",
            "student",
            "person",
        ]
    )
}
_MAX_PASSES = 5


# ------------------------------------------------------------------ common English words

# Words that are never fuzzy-matched to a name, and names that are also words ("Rose", "Will")
# are only matched when capitalized and not used as the word ("May I go?", "a rose garden").
_STOPLIST_TEXT = """
a about above across act add after again against age ago agree ahead air all allow almost alone along
already also although always am among an and animal another answer any anybody anyone anything anyway
anywhere apart apex appear apple area arm army around art as ask at aunt autumn away baby back bad bag
baker ball band bank base basket bat bath be beach bear beat beautiful became because become bed bee
been before began begin behind being believe bell belly below bend beside besides best better between
beyond big bill bird birth bit black blank block blood blue board boat body bone book boot bored both
bottle bottom bought box boy brain brave bread break breakfast bright bring brook brother brown bug
build building built bully bus busy but butter buy by cake call called calm came camp can candy cannot
cap captain car card care careful carry case cash cat catch cause chair chance change chapter chase
check child children choose city class classroom clean clear cliff climb clock close cloud coat code
coin cold color come compare complete cook cool cooper copy coral corner correct could count country
course cousin cover cow crazy cross cry crystal cup cut cute dad daily daisy dale dance dark date dawn
day dead deal dean dear decide deep desk did die different difficult dinner dirty do does dog doing
done door dot down dragon draw dream dress drink drive drop dry duck during dusty each ear early earth
easy eat edge egg either else empty end energy english enjoy enough enter entire equal essay even
evening event ever every everybody everyone everything everywhere excited explain eye face fact fair
faith fall false family famous far farm fast fat father favorite fear feel feet fell felt fern few
field fight file fill final find fine finish fire first fish fit five fix flag flat flex floor flower
fly follow food foot for forest forget form found four frank free fresh friend friendly from front
fruit full fun funny game garden gate gave gene gentle get gets getting gift ginger girl give glad
glass glen go goal goes going gold gone good got grace grade grass gray great green grew ground group
grow guess guy had hair half hall hand hang happen happy hard has hat hate have having he head hear
heard heart heat heath heather heavy help her here hers herself hide high hill hilly him himself his
history hit hold hole holly home honey honor hope horse hot hour house how however hug huge hungry
hunt hunter hurry i idea if imagine important in include inside instead into iris is island it its
itself ivy jack jade jasper jewel job join joke joy july jump june just keep key kick kid kill kind
king kitchen knew know lady lake land lane language large last late later laugh lay lazy lead learn
least leave left leg less lesson let letter liar library lie life lift light like lily line list
listen little live lonely long look lose lot loud love low lucky lunch made main make man many map
march mark mason math matter may maybe mayo me meal mean meet melody merry messy middle might mill
mind mine minute miss misty modern mom money month moon more morning most mother mountain mouth move
movie much music must my myself name nature near neck need neither never new news next nice night
nine no nobody noise none nor normal north nose not note nothing notice now number ocean of off
office often oh old olive on once one only onto opal open or orange order other others otherwise our
ours ourselves out outside over own page paint pair paper parent park parker part party pass pat
patience pay pearl pen pencil penny people pepper perhaps person pet phone pick picture piece pig pink
piper place plain plan plane planet plant plate play please poem point pool poor poppy possible
pour power practice prepare press pretend pretty price print problem promise proud pull purple push
put question quick quiet quite rabbit race rain rather ray reach read ready real realize really
reason red reed remember repeat reply report rest return rich ride right ring rise river road robin
rock rocky room rope rose round ruby rule run rusty sad safe sage said same sandy sat save saw say
scared school science score sea season seat second see seem sell send sentence set seven several
shake shall shape share sharp she sheep shine ship shirt shoe shop short should shout show shut shy
side sign silly simple since sing sister sit six size skill sky sleep slip slow small smart smell
smile snake snow so soft solve some somebody someone something sometimes somewhere song soon sorry
sound south space speak special spell spend spring square stand star start state stay step sterling
still stick stone stop store storm story strange street strong student study subject such sudden
sugar summer sun sunny suppose sure sweet swim table tail take talk tall taught taylor teach teacher
team tell ten terrible test than thank that the their theirs them themselves then there therefore
these they thick thin thing think third this those though three threw through throw thus tiny tired
to today together told tomorrow too took top total touch toward towards town toy train travel tree
tried trip truck true try turn two ugly uncle under understand unit unless until up upon us use very
violet visit voice wait wake walk wall want war warm was wash watch water wave way we weak wear
weather week weekend well went were west wet what whatever when whenever where wherever whether which
while white who whoever whole whom whose why wide wild will win wind window winter wise wish with
within without woman wonder wonderful wood woods woody word work world worry would wren write wrong
wrote yard year yellow yes yesterday yet you young your yours yourself yourselves zoo
monday tuesday wednesday thursday friday saturday sunday
january february april august september october november december
rubric strengths feedback organization conclusion thesis paragraph evidence sign spelling
dash giddy pinky polo
africa america asia europe australia antarctica ghana nigeria kenya egypt ethiopia somalia morocco
mexico canada cuba haiti jamaica brazil peru chile colombia argentina china japan korea india nepal
pakistan vietnam thailand philippines france spain italy germany greece ireland england scotland wales
russia ukraine poland turkey iran iraq syria lebanon texas california florida ohio hawaii alaska utah
nevada oregon maine iowa idaho
"""
STOPLIST: frozenset[str] = frozenset(_STOPLIST_TEXT.split())
_MONTHS = frozenset({"april", "may", "june", "july", "august", "march"})
_MONTH_PREPS = frozenset({"in", "since", "until", "till", "during", "early", "late", "mid"})
_SUBJECT_PRONOUNS = frozenset({"i", "you", "we", "he", "she", "they", "it", "there", "this", "that"})
_DETERMINERS = frozenset(
    {
        "a",
        "an",
        "the",
        "this",
        "that",
        "my",
        "your",
        "his",
        "her",
        "our",
        "their",
        "its",
        "some",
        "every",
        "each",
    }
)


def _is_common(word: str) -> bool:
    """True for a common English word or a simple inflection of one ("hunters", "roses", "rising")."""
    w = word.lower().replace("’", "'")
    if w in STOPLIST:
        return True
    for suffix, adds in (("s", ("",)), ("es", ("",)), ("ed", ("", "e")), ("ing", ("", "e")), ("ly", ("",))):
        if w.endswith(suffix) and len(w) > len(suffix) + 2:
            stem = w[: -len(suffix)]
            if any(stem + a in STOPLIST for a in adds):
                return True
    return False


# ------------------------------------------------------------------ roster


def load_roster(path: str | Path) -> Roster:
    """Read a roster file: {"school", "teacher": {name, first, last, nicknames}, "students": [...]}."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    teacher = _person(data["teacher"], role="teacher")
    students = tuple(_person(s, role="student") for s in data.get("students") or [])
    return Roster(teacher=teacher, students=students, school=data.get("school"))


def _person(raw: Mapping[str, Any], role: str) -> Person:
    name = " ".join(str(raw.get("name") or "").split())
    first = str(raw.get("first") or "").strip()
    last = str(raw.get("last") or "").strip()
    if not name:
        name = f"{first} {last}".strip()
    parts = name.split()
    first = first or (parts[0] if parts else "")
    last = last or (parts[-1] if len(parts) > 1 else "")
    if not name or not first:
        raise ValueError("every roster person needs a name")
    nicknames = tuple(str(n).strip() for n in raw.get("nicknames") or () if n and str(n).strip())
    sid = raw.get("student_id")
    return Person(
        name=name,
        first=first,
        last=last,
        nicknames=nicknames,
        role=role,
        student_id=str(sid).strip() if sid else None,
    )


# ------------------------------------------------------------------ candidates


@dataclass(frozen=True)
class _Cand:
    kind: str
    value: str  # the text as found
    start: int
    end: int
    key: str  # what the tag map keys on: a person's full name or a normalized identifier
    nvalue: str = ""  # the value as found in the normalized copy (see _normalize), when it differs


def _resolve(cands: Iterable[_Cand], blocked: list[tuple[int, int]] = ()) -> list[_Cand]:
    """Longest span first, never overlapping another chosen span or an existing tag."""
    chosen: list[_Cand] = []
    order = sorted(cands, key=lambda c: (-(c.end - c.start), _PRIORITY.get(c.kind, 99), c.start))
    for c in order:
        if c.end <= c.start:
            continue
        if any(c.start < e and s < c.end for s, e in blocked):
            continue
        if any(c.start < o.end and o.start < c.end for o in chosen):
            continue
        chosen.append(c)
    return sorted(chosen, key=lambda c: c.start)


def _tag_spans(text: str) -> list[tuple[int, int]]:
    return [m.span() for m in TAG_RE.finditer(text)] if "[" in text else []


def _hits(cands: Iterable[_Cand]) -> list[Hit]:
    return [Hit(c.kind, c.value, c.start, c.end) for c in cands]


# ------------------------------------------------------------------ normalized copy

# Dash-like characters a word processor or PDF puts in phone numbers, SSNs and names.
_DASHES = frozenset("\u2010\u2011\u2012\u2013\u2014\u2015\u2212\ufe58\ufe63\uff0d")
_APOSTROPHES = frozenset("\u02bc\u2032\u2018\uff07")
# "Ellings-\nworth" from a PDF line break, or "Ellings- worth" once a snippet joins the lines.
_HYPHEN_BREAK = re.compile(r"(?<=[^\W\d_])-(?:[ \t]*\r?\n[ \t]*|[ \t])(?=[^\W\d_])")


@dataclass(frozen=True)
class _Norm:
    """A copy of some text that the checks scan, and where each of its characters came from.

    NFKC (fullwidth letters, non-breaking spaces and hyphens), format characters removed (soft
    hyphen, zero-width spaces), every dash as "-", modifier apostrophes as "’", "_" as a space,
    and line-break hyphenation joined. starts[i]:ends[i] is the span of the original text that
    produced character i, so a match in the copy can be replaced in the original.
    """

    text: str
    starts: tuple[int, ...] | None = None  # None: same length and positions as the original
    ends: tuple[int, ...] | None = None

    def span(self, start: int, end: int) -> tuple[int, int]:
        if self.starts is None or end <= start:
            return start, end
        return self.starts[start], self.ends[end - 1]


def _normalize(text: str) -> _Norm:
    text = text or ""
    if text.isascii():
        out = text.replace("_", " ")
        if "-" not in out or not _HYPHEN_BREAK.search(out):
            return _Norm(out)
        starts, ends = list(range(len(out))), list(range(1, len(out) + 1))
    else:
        chars: list[str] = []
        starts, ends = [], []
        i, n = 0, len(text)
        while i < n:
            j = i + 1
            while j < n and unicodedata.combining(text[j]):
                j += 1  # keep a letter with its accents, so NFKC can join them
            group = text[i:j]
            if unicodedata.category(group[0]) == "Cf":
                piece = ""
            else:
                piece = unicodedata.normalize("NFKC", group)
            for ch in piece:
                if ch in _DASHES:
                    ch = "-"
                elif ch in _APOSTROPHES:
                    ch = "’"
                elif ch == "_":
                    ch = " "
                elif unicodedata.category(ch) == "Cf":
                    continue
                chars.append(ch)
                starts.append(i)
                ends.append(j)
            i = j
        out = "".join(chars)
    drop = [m.span() for m in _HYPHEN_BREAK.finditer(out)]
    if drop:
        keep = [True] * len(out)
        for a, b in drop:
            for k in range(a, b):
                keep[k] = False
        out = "".join(ch for ch, k in zip(out, keep, strict=True) if k)
        starts = [v for v, k in zip(starts, keep, strict=True) if k]
        ends = [v for v, k in zip(ends, keep, strict=True) if k]
    return _Norm(out, tuple(starts), tuple(ends))


def _remap(cands: Iterable[_Cand], text: str, norm: _Norm) -> list[_Cand]:
    """Candidates found in the normalized copy, with spans and values in the original text."""
    out: list[_Cand] = []
    for c in cands:
        s, e = norm.span(c.start, c.end)
        value = text[s:e]
        out.append(_Cand(c.kind, value, s, e, c.key, c.value if c.value != value else ""))
    return out


# ------------------------------------------------------------------ identifiers


def luhn_valid(digits: str) -> bool:
    """The Luhn checksum used by card numbers."""
    if not digits.isdigit():
        return False
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = ord(ch) - 48
        if i % 2:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _id_key(kind: str, value: str) -> str:
    """Normalize an identifier so one real value always gets one tag, whatever its format."""
    if kind == "phone":
        d = re.sub(r"\D", "", value)
        return d[1:] if len(d) == 11 and d[0] == "1" else d
    if kind in ("ssn", "card", "otp"):
        return re.sub(r"\D", "", value)
    if kind == "email":
        return value.lower()
    if kind == "student_id":
        return re.sub(r"[^0-9A-Za-z]", "", value).upper()
    return " ".join(re.sub(r"[.,]", " ", value.lower()).split())


def _cand(kind: str, text: str, start: int, end: int) -> _Cand:
    value = text[start:end]
    return _Cand(kind, value, start, end, _id_key(kind, value))


_DIGIT_RUN = re.compile(r"\d+(?:[ .-]\d+)*")
_DIGITS = re.compile(r"\d+")


def _card_shape(lengths: list[int]) -> bool:
    """One block, 4-4-4-4 style groups (last one 1 to 4), or Amex/Diners 4-6-5 and 4-6-4."""
    if len(lengths) == 1 or lengths in ([4, 6, 5], [4, 6, 4]):
        return True
    return len(lengths) >= 4 and all(n == 4 for n in lengths[:-1]) and 1 <= lengths[-1] <= 4


def _cards(text: str) -> Iterable[_Cand]:
    for run in _DIGIT_RUN.finditer(text):
        groups = [(run.start() + m.start(), run.start() + m.end()) for m in _DIGITS.finditer(run.group())]
        i = 0
        while i < len(groups):
            best = None
            digits = ""
            for j in range(i, len(groups)):
                digits += text[groups[j][0] : groups[j][1]]
                if len(digits) > 19:
                    break
                lengths = [e - s for s, e in groups[i : j + 1]]
                if len(digits) >= 13 and _card_shape(lengths) and len(set(digits)) > 1 and luhn_valid(digits):
                    best = j
            if best is None:
                i += 1
                continue
            yield _cand("card", text, groups[i][0], groups[best][1])
            i = best + 1


_SSN = re.compile(r"(?<![\w-])(\d{3})([-. ])(\d{2})\2(\d{4})(?!\w|-\d)")
_SSN_CONTEXT = re.compile(
    r"(?:\bssn|\bss#|\bsocial\s+security(?:\s+(?:number|no\.?|#))?|\bsocial\b|\bitin|\btax\s+id)"
    r"[^\d\n]{0,30}?(?<!\d)(\d{9})(?!\d)",
    re.IGNORECASE,
)


def _ssn_ok(digits: str, allow_test: bool) -> bool:
    area, group, serial = digits[:3], digits[3:5], digits[5:]
    if group == "00" or serial == "0000" or area == "666":
        return False
    if not allow_test and (area == "000" or area[0] == "9"):
        return False
    return True


def _ssns(text: str, allow_test: bool) -> Iterable[_Cand]:
    for m in _SSN.finditer(text):
        if _ssn_ok(m.group(1) + m.group(3) + m.group(4), allow_test):
            yield _cand("ssn", text, m.start(), m.end())
    for m in _SSN_CONTEXT.finditer(text):
        if _ssn_ok(m.group(1), allow_test):
            yield _cand("ssn", text, m.start(1), m.end(1))


_PHONE = re.compile(
    r"(?<![\w+])(?:\+1[\s.-]?|1[\s.-])?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d|-\d)"
)
_PHONE7 = re.compile(r"(?<![\w.-])[2-9]\d{2}-\d{4}(?![\w-]|\.\d)")  # 555-0143 in a contact table
_NOT_PHONE7_BEFORE = re.compile(r"\b(?:lexile|pages?|pp\.?|levels?|scores?|range)\s*:?\s*$", re.IGNORECASE)
_PHONE_CONTEXT = re.compile(
    r"\b(?:phone|cell|mobile|tel|telephone|call|text|fax)\b[^\w\n]{0,3}"
    r"(?:(?:is|at|me|us|her|him|them|mom|dad|home|work|number)\b[^\w\n]{0,3}){0,3}"
    r"(\+?1?\d{10}|\d{3}[-.]\d{4})(?![\d-])",
    re.IGNORECASE,
)


def _phones(text: str) -> Iterable[_Cand]:
    for m in _PHONE.finditer(text):
        yield _cand("phone", text, m.start(), m.end())
    for m in _PHONE7.finditer(text):
        if not _NOT_PHONE7_BEFORE.search(text, max(0, m.start() - 12), m.start()):
            yield _cand("phone", text, m.start(), m.end())
    for m in _PHONE_CONTEXT.finditer(text):
        yield _cand("phone", text, m.start(1), m.end(1))


_EMAIL = re.compile(r"(?<![\w.%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![\w-])")

_OTP_BEFORE = re.compile(
    r"\b(?:one[- ]time\s+(?:code|passcode|password|pin)|codes?|passcodes?|otps?|pins?|verification|2fa|mfa"
    r"|authentication)\b(?:[\s:=#-]*\b(?:code|number|is|was|of)\b)*[\s:=#-]*(\d{4,8})(?!\d|[-.]\d)",
    re.IGNORECASE,
)
_OTP_AFTER = re.compile(
    r"(?<![\d-])(\d{4,8})(?!\d)\s+(?:is|was)\s+(?:your|the|my)\s+(?:[a-z-]+\s+){0,2}(?:code|passcode|pin|otp)\b",
    re.IGNORECASE,
)
_NOT_OTP_BEFORE = re.compile(r"\b(?:zip|postal|area|dress|country|bar|source|honor|post)\s*$", re.IGNORECASE)


def _otps(text: str) -> Iterable[_Cand]:
    for m in _OTP_BEFORE.finditer(text):
        if not _NOT_OTP_BEFORE.search(text, max(0, m.start() - 12), m.start()):
            yield _cand("otp", text, m.start(1), m.end(1))
    for m in _OTP_AFTER.finditer(text):
        yield _cand("otp", text, m.start(1), m.end(1))


_SID = re.compile(r"(?<![\w-])S(?:-|\s)?\d{5,8}(?![\w-])")
_SID_LABEL = re.compile(
    r"(?:\bstudent\s+(?:id|number|no\.?|#)|\bid(?:\s+(?:number|no\.?)|\s*#)?)\s*[:#]?\s*(\d{5,8})(?!\d)",
    re.IGNORECASE,
)
_ID_SHAPES: dict[tuple[str, ...], re.Pattern[str] | None] = {}


def _roster_id_pattern(roster: Any) -> re.Pattern[str] | None:
    """A regex for ids shaped like the roster's (S123456, JH-20431). Pure short numbers are exact only."""
    ids = tuple(sorted({str(s.student_id) for s in getattr(roster, "students", ()) if s.student_id}))
    if ids in _ID_SHAPES:
        return _ID_SHAPES[ids]
    shapes: set[str] = set()
    for sid in ids:
        parts = re.findall(r"\d+|[^\W\d_]+|[^\w]+|_", sid)
        n_digits = sum(len(p) for p in parts if p.isdigit())
        if n_digits >= 5 or any(not p.isdigit() for p in parts):
            shapes.add("".join(rf"\d{{{len(p)}}}" if p.isdigit() else re.escape(p) for p in parts))
        else:
            shapes.add(re.escape(sid))
    pattern = re.compile(r"(?<![\w-])(?:" + "|".join(sorted(shapes)) + r")(?![\w-])") if shapes else None
    _ID_SHAPES[ids] = pattern
    return pattern


def _student_ids(text: str, roster: Any) -> Iterable[_Cand]:
    for m in _SID.finditer(text):
        yield _cand("student_id", text, m.start(), m.end())
    for m in _SID_LABEL.finditer(text):
        yield _cand("student_id", text, m.start(1), m.end(1))
    pattern = _roster_id_pattern(roster) if roster is not None else None
    if pattern is not None:
        for m in pattern.finditer(text):
            yield _cand("student_id", text, m.start(), m.end())


_STREET_SUFFIX = (
    "Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|"
    "Circle|Cir|Parkway|Pkwy|Highway|Hwy|Trail|Trl|Loop|Cove|Cv|Path|Pike|Square|Sq"
)
_ADDRESS = re.compile(
    r"(?<![\w-])\d{1,6}[A-Za-z]?\s+"
    r"(?:(?:[NSEW]\.?|North|South|East|West)\s+)?"
    r"(?:(?:[A-Z][\w'’-]*|\d+(?:st|nd|rd|th))\s+){1,4}"
    rf"(?i:{_STREET_SUFFIX})\b"
    r"(?:\.?,?\s+(?i:apt|apartment|unit|suite|ste|#)\.?\s*#?[\w-]+)?"
)
# The same in lower case ("42 oak lane apt 3"), with the plainer street words only. Kept only when
# no street word is a common word or a unit follows, so "ran 5 miles down the road" is not one.
_STRONG_SUFFIX = "street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|highway|hwy|parkway|pkwy"
_ADDRESS_LOWER = re.compile(
    r"(?<![\w-])\d{1,6}[a-z]?\s+((?:[a-z][a-z'’-]*\s+){1,3})"
    rf"(?:{_STRONG_SUFFIX})\b"
    r"(\.?,?\s+(?:apt|apartment|unit|suite|ste|#)\.?\s*#?[\w-]+)?"
)


def _addresses(text: str) -> Iterable[_Cand]:
    for m in _ADDRESS.finditer(text):
        yield _cand("address", text, m.start(), m.end())
    for m in _ADDRESS_LOWER.finditer(text):
        words = m.group(1).split()
        if m.group(2) or not any(_is_common(w) for w in words):
            yield _cand("address", text, m.start(), m.end())

_MONTH_RE = (
    r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?"
    r"|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?"
)
_DATE_RE = (
    r"(?:\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})"
    r"|\d{4}-\d{1,2}-\d{1,2}"
    rf"|{_MONTH_RE}\s+\d{{1,2}}(?:st|nd|rd|th)?(?:,?\s+\d{{4}})?"
    rf"|\d{{1,2}}(?:st|nd|rd|th)?\s+(?:of\s+)?{_MONTH_RE}(?:,?\s+\d{{4}})?)"
)
_DOB = re.compile(
    r"(?:\b(?:born|dob|birthday|birth\s*date|date\s+of\s+birth)\b|\bd\.o\.b\.?)"
    rf"[\s:,-]*(?:(?:is|was|on|of)\s+)*({_DATE_RE})(?!\d)",
    re.IGNORECASE,
)


# What the compliance toggles add. These lean toward removing too much, on purpose.
_ANY_DATE = re.compile(
    rf"(?<![\w/-])(?:{_DATE_RE}|{_MONTH_RE}\s+\d{{4}}|\d{{4}}[/.-]\d{{1,2}})(?![\w/-]|\.\d)", re.IGNORECASE
)
_OLD_AGE = re.compile(
    r"\b(?:aged?:?\s*(?P<a>9\d|1\d\d)\b|(?P<b>9\d|1\d\d)[- ]?(?:years?|yrs?)[- ]?old\b|(?P<c>9\d|1\d\d)\s?y/?o\b)",
    re.IGNORECASE,
)
_URL = re.compile(
    r"(?i)\b(?:https?://|www\.)[^\s)\]>\"']+"
    r"|\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|us|info|co)\b(?:/[^\s)\]>\"']*)?"
)
_IPV4 = re.compile(r"(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])")
_IPV6 = re.compile(r"(?i)(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])")
_ZIP = re.compile(r"(?<![\d$.,:/-])\d{5}(?:-\d{4})?(?![\d-]|[.,]\d)")
_STATES = (
    "AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|"
    "OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY"
)
_CITY_STATE = re.compile(rf"\b(?:[A-Z][a-z'’.-]+\s+){{0,2}}[A-Z][a-z'’.-]+,\s*(?:{_STATES})\b(?:\s+\d{{5}}(?:-\d{{4}})?)?")
_RECORD_LABEL = re.compile(
    r"(?i)\b(?:mrn|medical record|patient id|patient number|chart|member|beneficiary|subscriber|insurance|"
    r"health plan|plan|policy|group|account|acct|license|licence|driver'?s license|dl|certificate|passport|"
    r"state id|national id|tax id|ein|vin|vehicle|plate|license plate|serial|device|imei|udid|mac address|"
    r"biometric|fingerprint|voiceprint|fax|case|claim|docket|badge|clearance|contract|employee|ein|routing)"
    r"(?:\s+(?:id|number|num|no\.?|#|code))?\s*(?:is|:|#|=|-)?\s*"
    r"(?P<v>(?=[A-Za-z0-9:.()+-]*\d)[A-Za-z0-9][A-Za-z0-9:.()+-]*(?:[ -]\d[\d-]*)*)"
)
_VIN = re.compile(r"\b(?=[A-HJ-NPR-Z0-9]*\d)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b")
_MAC = re.compile(r"(?i)(?<![\w:-])(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}(?![\w:-])")
_LONG_NUMBER = re.compile(r"(?<![\w.-])\d{6,}(?![\w-])")
_CAP_WORD = re.compile(r"[A-Z][a-zA-Z]*(?:['’-][A-Za-z]+)*|[A-Z]{3,}")
_JOINS = re.compile(r"\s(?:of|the|de|la|and|for)\s|\s")
# Capitalized words that do not point at anyone, in any position.
_PLAIN_WORDS = frozenset(
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august "
    "september october november december english math mathematics science history spanish french art music reading "
    "writing geography biology chemistry physics student students teacher teachers class grade i ok fall spring "
    "summer winter tagged result results document documents waiting kept held note notes summary average median "
    "total overall patient patients doctor nurse clinic hospital dose dosage medication therapy treatment symptoms "
    "diagnosis attendance rubric evidence ideas organization conventions essay essays assignment homework quiz test "
    "families family parent parents school schools question questions answer answers request source sources "
    "percent score scores status purpose title report hello dear hi excerpt excerpts range draft log logs principal "
    "contact lowest highest level club station quarter custody discipline fitness jan feb mar apr jun jul aug sep "
    "sept oct nov dec".split()
)
# Rubric and class words the small model sometimes calls a person. Never remembered as a name.
# Words that are also first names (May, June, Art) are left out, so a name the model found stays.
_CLASS_WORDS = _PLAIN_WORDS - {"may", "june", "april", "august", "art", "i"}
_ACRONYMS = frozenset(
    "iep gpa ela stem esl ell adhd ssn dob mrn ferpa hipaa coppa sat act pdf usa faq bmi hiv aids mri ekg ecg covid".split()
)


def _at_sentence_start(text: str, i: int) -> bool:
    j = i - 1
    while j >= 0 and text[j] in " \t*_#>|-(\"'“‘":
        j -= 1
    return j < 0 or text[j] in ".!?:\n"


def _strict_details(
    text: str, taken: list[tuple[int, int]], kind: str = "detail", need_uncommon: bool = False
) -> list[_Cand]:
    """Runs of capitalized words that could be a place, an employer, a school or anyone's name.

    A common word that starts a sentence does not count, and neither do plain words like month
    names or a lone letter. Every other run is tagged, so a mistake removes too much rather than
    too little. `need_uncommon` also skips a run made only of common words.
    """
    return list(_detail_runs(text, taken, kind, need_uncommon))


def _detail_runs(text: str, taken: list[tuple[int, int]], kind: str, need_uncommon: bool) -> Iterable[_Cand]:
    run: list[re.Match[str]] = []

    def flush() -> Iterable[_Cand]:
        words = list(run)
        run.clear()
        if words and _at_sentence_start(text, words[0].start()) and _is_common(words[0].group()):
            words.pop(0)
        while words and words[0].group().lower() in _PLAIN_WORDS:
            words.pop(0)
        while words and words[-1].group().lower() in _PLAIN_WORDS:
            words.pop()
        if not words:
            return
        one = words[0].group()
        if len(words) == 1 and (len(one) < 3 or _is_common(one) or one.lower() in _ACRONYMS):
            return
        if need_uncommon and all(_is_common(w.group()) or w.group().lower() in _PLAIN_WORDS for w in words):
            return
        yield _cand(kind, text, words[0].start(), words[-1].end())

    for m in _CAP_WORD.finditer(text):
        if any(m.start() < e and s < m.end() for s, e in taken):
            yield from flush()
            continue
        if run and not _JOINS.fullmatch(text[run[-1].end() : m.start()]):
            yield from flush()
        run.append(m)
    yield from flush()


def _extra_cands(text: str, kinds: frozenset[str], existing: list[_Cand]) -> list[_Cand]:
    out: list[_Cand] = []
    if "date" in kinds:
        out += [_cand("date", text, m.start(), m.end()) for m in _ANY_DATE.finditer(text)]
    if "age" in kinds:
        for m in _OLD_AGE.finditer(text):
            g = "a" if m.group("a") else "b" if m.group("b") else "c"
            out.append(_cand("age", text, m.start(g), m.end(g)))
    if "url" in kinds:
        for m in _URL.finditer(text):
            end = m.start() + len(m.group().rstrip(".,;:!?"))
            out.append(_cand("url", text, m.start(), end))
    if "ip" in kinds:
        out += [_cand("ip", text, m.start(), m.end()) for r in (_IPV4, _IPV6) for m in r.finditer(text)]
    if "record" in kinds:
        out += [_cand("record", text, m.start("v"), m.end("v")) for m in _RECORD_LABEL.finditer(text)]
        out += [_cand("record", text, m.start(), m.end()) for r in (_VIN, _MAC, _LONG_NUMBER) for m in r.finditer(text)]
    if "place" in kinds:
        out += [_cand("place", text, m.start(), m.end()) for r in (_CITY_STATE, _ZIP) for m in r.finditer(text)]
    if "detail" in kinds:
        taken = [(c.start, c.end) for c in [*existing, *out]] + _tag_spans(text)
        out += list(_strict_details(text, taken))
    return out


def _identifier_cands(text: str, roster: Any = None, allow_test_ssn: bool = True) -> list[_Cand]:
    out: list[_Cand] = []
    if any(ch.isdigit() for ch in text):
        out.extend(_cards(text))
        out.extend(_ssns(text, allow_test_ssn))
        out.extend(_phones(text))
        out.extend(_otps(text))
        out.extend(_student_ids(text, roster))
        out.extend(_addresses(text))
        out.extend(_cand("dob", text, m.start(1), m.end(1)) for m in _DOB.finditer(text))
    if "@" in text:
        out.extend(_cand("email", text, m.start(), m.end()) for m in _EMAIL.finditer(text))
    return out


def find_identifiers(text: str, roster: Any = None, *, allow_test_ssn: bool = True) -> list[Hit]:
    """Exact identifier checks: cards (Luhn), SSNs, phones, emails, one-time codes, student ids,
    street addresses and dates of birth. Overlaps resolve to the longest span.

    SSN areas 000 and 9xx are accepted by default: invented data in this repo uses them, and 9xx is
    also the ITIN range, which is just as private. Pass allow_test_ssn=False for strict SSA rules.
    With a roster, ids shaped like the roster's student ids are found too.
    """
    norm = _normalize(text)
    found = _resolve(_identifier_cands(norm.text, roster, allow_test_ssn), _tag_spans(norm.text))
    return _hits(_remap(found, text, norm))


_LONG_DIGITS = re.compile(r"(?<![\d.-])\d+(?:[.-]\d+)*(?![\d])")
_DATE_SHAPE = re.compile(r"\d{4}([.-])\d{1,2}\1\d{1,2}|\d{1,2}([.-])\d{1,2}\2\d{2,4}")


def long_digit_runs(text: str) -> list[str]:
    """Runs of 7 or more digits, alone or joined by "-" or ".", that are not calendar dates.

    A fallback for identifiers in a format no exact check knows: the router asks first.
    """
    norm = _normalize(text).text
    out = []
    for m in _LONG_DIGITS.finditer(norm):
        run = m.group()
        if sum(ch.isdigit() for ch in run) >= 7 and not _DATE_SHAPE.fullmatch(run):
            out.append(run)
    return out


# ------------------------------------------------------------------ names


def _norm(s: str) -> str:
    """Lowercase with spaces, apostrophes, hyphens, periods and commas removed."""
    return re.sub(r"[\s'’\-‐‑.,]+", "", s.lower())


def _form_pattern(form: str) -> str:
    """A regex for a name: any whitespace, optional apostrophe, hyphen or space or nothing."""
    out = []
    for ch in form:
        if ch in "'’":
            out.append("['’]?")
        elif ch in "-‐‑":
            out.append(r"(?:[-‐‑]|\s+)?")
        elif ch.isspace():
            out.append(r"\s+")
        else:
            out.append(re.escape(ch))
    return "".join(out)


def _one_edit(a: str, b: str) -> bool:
    """Damerau-Levenshtein distance exactly 1 (substitution, insertion, deletion or swap)."""
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        diffs = [i for i in range(len(a)) if a[i] != b[i]]
        if len(diffs) == 1:
            return True
        i, j = (diffs + [0, 0])[:2]
        return len(diffs) == 2 and j == i + 1 and a[i] == b[j] and a[j] == b[i]
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i:] == b[i + 1 :]


@dataclass(frozen=True)
class _Form:
    person: int  # index into _NameIndex.people; 0 is the teacher
    ftype: str  # full, first, nick, last, part
    form: str


_SINGLE = frozenset({"first", "nick", "last", "part"})
_TITLES = r"Mrs|Mr|Ms|Mx|Dr|Miss|Mister|Coach|Professor|Prof"
_TOKEN = re.compile(r"[^\W\d_]+(?:['’\-‐‑][^\W\d_]+)*")
_PREV_WORD = re.compile(r"([^\W\d_]+)[ \t]+$")
# Up to two words right before or after a name; _name_like keeps the capitalized ones ("Émile" too).
_PRECEDING_NAMES = re.compile(r"((?:[^\W\d_]+(?:['’\-‐‑][^\W\d_]+)*[ \t]+){1,2})$")
_FOLLOWING_NAMES = re.compile(r"(?:[ \t]+[^\W\d_]+(?:['’\-‐‑][^\W\d_]+)*){1,2}")
# Before a name: not a letter, and not an apostrophe right after a letter (the "Callaghan" in
# "O'Callaghan"). An opening quote is fine: ‘Maya’ and 'Maya' are names.
_NAME_START = r"(?<![^\W\d_])(?<![^\W\d_]['’])"
_TITLE_WORDS = frozenset(
    {"mr", "mrs", "ms", "mx", "dr", "miss", "mister", "coach", "professor", "prof", "sir", "madam", "dear"}
)
_NEXT_WORD = re.compile(r"[ \t]+([^\W\d_]+|\d)")


def _used_as_word(text: str, start: int, end: int, form: str) -> bool:
    """For a capitalized name that is also a common word: whether the text uses it as the word."""
    nxt = _NEXT_WORD.match(text, end)
    next_word = nxt.group(1).lower() if nxt else ""
    prv = _PREV_WORD.search(text, max(0, start - 30), start)
    prev_word = prv.group(1).lower() if prv else ""
    if next_word in _SUBJECT_PRONOUNS or prev_word in _DETERMINERS:
        return True  # "May I go?", "Will you help?", "the Rose Garden"
    # "May 5", "in May"
    return form.lower() in _MONTHS and (next_word[:1].isdigit() or prev_word in _MONTH_PREPS)


def _forms_for(p: Person) -> Iterable[tuple[str, str]]:
    first, last = p.first.strip(), p.last.strip()
    yield "full", p.name
    if first and last:
        yield "full", f"{first} {last}"
        yield "full", f"{last}, {first}"
    for nick in p.nicknames:
        yield ("full" if " " in nick.strip() else "nick"), nick
        if last:
            yield "full", f"{nick} {last}"
    if first:
        yield "first", first
    if last:
        yield "last", last
        for part in re.split(r"[\s\-‐‑]+", last):
            if part != last and len(part) >= 3:
                yield "part", part
        m = re.match(r"^[^\W\d_]{1,2}['’]([^\W\d_]{4,})$", last)  # O'Callaghan -> Callaghan
        if m:
            yield "part", m.group(1)


class _NameIndex:
    """Every name form for one roster, compiled once: an exact regex and a one-edit lookup."""

    def __init__(self, roster: Any):
        self.people: list[Person] = [roster.teacher, *roster.students]
        self.forms: dict[str, list[_Form]] = {}
        firsts = [_norm(p.first) for p in self.people]
        for i, p in enumerate(self.people):
            forms = list(_forms_for(p))
            if firsts.count(firsts[i]) > 1 and p.last[:1].isalpha():
                forms.append(("full", f"{p.first} {p.last[0]}"))  # "Maya L." when two students are Maya
            for ftype, form in forms:
                key = _norm(form)
                entries = self.forms.setdefault(key, [])
                if key and not any(e.person == i and e.ftype == ftype for e in entries):
                    entries.append(_Form(i, ftype, form))
        texts = sorted({e.form for es in self.forms.values() for e in es}, key=len, reverse=True)
        self.regex = (
            re.compile(
                _NAME_START + "(?:" + "|".join(_form_pattern(f) for f in texts) + r")(?![^\W\d_])",
                re.IGNORECASE,
            )
            if texts
            else None
        )
        t = roster.teacher
        self.title_re = None
        if t.last:
            self.title_re = re.compile(
                rf"{_NAME_START}(?:{_TITLES})\.?\s+(?:{_form_pattern(t.first)}\s+)?{_form_pattern(t.last)}"
                r"(?![^\W\d_])",
                re.IGNORECASE,
            )
        # One-edit lookup: every form and every form with one letter deleted.
        self.fuzzy_forms: dict[str, list[_Form]] = {}
        self.deletes: dict[str, set[str]] = {}
        for key, entries in self.forms.items():
            single = [e for e in entries if e.ftype in _SINGLE]
            if len(key) < 4 or not single or (len(key) < 5 and any(_is_common(e.form) for e in single)):
                continue
            self.fuzzy_forms[key] = single
            for d in {key, *(key[:i] + key[i + 1 :] for i in range(len(key)))}:
                self.deletes.setdefault(d, set()).add(key)
        self._fuzzy_cache: dict[str, list[_Form]] = {}

    def _accept(self, text: str, start: int, end: int, entries: list[_Form]) -> bool:
        """Case and context rules for a single-word match. Full names match in any case."""
        types = {e.ftype for e in entries}
        if "full" in types:
            return True
        form = entries[0].form
        ambiguous = _is_common(form)
        if not text[start].isupper():
            # A lowercase name counts unless it is also a common word or very short. Last names
            # need four letters: "restrepo" in a file slug, "kowalczyk" in a note.
            short = len(_norm(form)) < (4 if types & {"last", "part"} else 3)
            return not (ambiguous or short)
        return not (ambiguous and _used_as_word(text, start, end, form))

    def _cand(self, value: str, start: int, end: int, entries: list[_Form]) -> _Cand:
        people = {e.person for e in entries}
        if len(people) == 1:
            i = people.pop()
            return _Cand("teacher" if i == 0 else "student", value, start, end, self.people[i].name)
        return _Cand("person", value, start, end, _norm(value))  # a form two people share

    def _fuzzy(self, key: str) -> list[_Form]:
        if key in self._fuzzy_cache:
            return self._fuzzy_cache[key]
        found: list[_Form] = []
        seen: set[str] = set()
        for d in {key, *(key[:i] + key[i + 1 :] for i in range(len(key)))}:
            for form_key in self.deletes.get(d, ()):
                if form_key not in seen and _one_edit(key, form_key):
                    seen.add(form_key)
                    found.extend(self.fuzzy_forms[form_key])
        self._fuzzy_cache[key] = found
        return found

    def _family_start(self, text: str, start: int) -> int | None:
        """Where a relative's name starts, for "Margaret Thornbury" before a roster last name.

        Up to two capitalized words right before the last name count, unless they are common
        words, titles or roster names themselves.
        """
        return _given_names_start(text, start, self.forms)

    def cands(self, text: str) -> list[_Cand]:
        out: list[_Cand] = []
        if self.regex is not None:
            for m in self.regex.finditer(text):
                entries = self.forms.get(_norm(m.group()))
                if not entries or not self._accept(text, m.start(), m.end(), entries):
                    continue
                out.append(self._cand(m.group(), m.start(), m.end(), entries))
                if {e.ftype for e in entries} <= {"last", "part"} and text[m.start()].isupper():
                    begin = self._family_start(text, m.start())
                    if begin is not None:
                        value = text[begin : m.end()]
                        out.append(_Cand("person", value, begin, m.end(), _norm(value)))
        if self.title_re is not None:
            for m in self.title_re.finditer(text):
                out.append(_Cand("teacher", m.group(), m.start(), m.end(), self.people[0].name))
        # One-edit misspellings: capitalized tokens of 4+ letters that are not common words.
        for m in _TOKEN.finditer(text):
            token, start, end = m.group(), m.start(), m.end()
            if token[-2:] in ("'s", "’s"):
                token, end = token[:-2], end - 2
            if not token[:1].isupper():
                continue
            key = _norm(token)
            if len(key) < 4 or key in self.forms or _is_common(token):
                continue
            entries = self._fuzzy(key)
            if entries:
                out.append(self._cand(token, start, end, entries))
        return out


_INDEX_CACHE: dict[tuple, _NameIndex] = {}
_INDEX_LOCK = threading.Lock()


def _roster_signature(roster: Any) -> tuple:
    def sig(p: Person) -> tuple:
        return (p.name, p.first, p.last, tuple(p.nicknames or ()))

    return (sig(roster.teacher), tuple(sig(s) for s in roster.students))


def _index(roster: Any) -> _NameIndex:
    key = _roster_signature(roster)
    with _INDEX_LOCK:
        idx = _INDEX_CACHE.get(key)
        if idx is None:
            if len(_INDEX_CACHE) > 16:
                _INDEX_CACHE.clear()
            idx = _INDEX_CACHE[key] = _NameIndex(roster)
        return idx


def find_names(text: str, roster: Any) -> list[Hit]:
    """Roster names: full names, first names, capitalized last names, nicknames, possessives
    ("Maya's" gives a hit on "Maya"), a teacher's title and last name, and one-edit misspellings
    of capitalized tokens of 4+ letters that are not common English words."""
    if roster is None:
        return []
    norm = _normalize(text)
    return _hits(_remap(_resolve(_index(roster).cands(norm.text), _tag_spans(norm.text)), text, norm))


def _given_names_start(
    text: str, start: int, forms: Mapping[str, Any], joins: Callable[[re.Match[str]], bool] | None = None
) -> int | None:
    """Where up to two capitalized words right before `start` begin, stopping at a common word,
    a title, a name in `forms` or a word `joins` refuses. None when there are none."""
    m = _PRECEDING_NAMES.search(text, max(0, start - 60), start)
    if not m:
        return None
    begin = None
    for t in reversed(list(_TOKEN.finditer(text, m.start(1), start))):
        if not _name_like(t.group(), forms) or (joins is not None and not joins(t)):
            break
        begin = t.start()
    return begin


def _family_names_end(
    text: str, end: int, forms: Mapping[str, Any], joins: Callable[[re.Match[str]], bool] | None = None
) -> int | None:
    """Where up to two capitalized words right after `end` stop, with the same exceptions as
    _given_names_start. A possessive ends the name before its 's ("Ona Thistlewood's group"). None
    when there are none."""
    m = _FOLLOWING_NAMES.match(text, end)
    if not m:
        return None
    stop = None
    for t in _TOKEN.finditer(text, end, m.end()):
        possessive = t.group()[-2:].lower() in ("'s", "’s")
        word = t.group()[:-2] if possessive else t.group()
        if not _name_like(word, forms) or (joins is not None and not joins(t)):
            break
        stop = t.end() - 2 if possessive else t.end()
        if possessive:
            break
    return stop


def _name_like(word: str, forms: Mapping[str, Any]) -> bool:
    if not word[:1].isupper():
        return False
    return not (_is_common(word) or word.lower() in _TITLE_WORDS or _norm(word) in forms)


# Capitalized words seen right next to names in school text that are not names: greetings, labels,
# roles and sentence openers. A model-found name never takes them in.
_NOT_NAMES = frozenset(
    "hi hello hey congrats congratulations welcome thanks meanwhile overall principal nurse officer judge"
    " counselor grandma grandpa nana auntie remind email contact nickname neighbor celebrating review"
    " reflection portfolio quiz draft elementary academy guardian".split()
)
_TOUCHES_DIGIT = re.compile(r"-?\d")


def _extra_name_cands(
    text: str, names: Iterable[str], roster: Any, stops: Iterable[tuple[int, int]] = ()
) -> list[_Cand]:
    """Names from the local model's second pass that the roster does not already cover.

    Each word of a model-found name counts alone too (a later "Bennick" when the model reported
    "Bennick Cinderfall"). A one-word name the model reported on its own, not inside a longer name
    it also reported, takes in up to two capitalized words on each side: the model reporting only
    "Cinderfall" still tags "Bennick Cinderfall", and the "Bennick" it took in counts alone where
    the text capitalizes it. One step only: a word taken in takes in nothing more. A neighbor is
    not taken in when it is one letter, touches a digit or an identifier span in `stops` (the "S"
    of "S401399"), is in capitals next to a name that is not ("IEP"), is written in lowercase
    elsewhere in the text ("Overall" and "overall") or is in _NOT_NAMES. The candidates overlap:
    _resolve keeps the longest, and tag() remembers every one.
    """
    idx = _index(roster) if roster is not None else None
    roster_forms = idx.forms if idx is not None else {}
    reported: list[str] = []
    for raw in names:
        name = _clean_name(raw)
        if len(_norm(name)) < 2 or name in reported:
            continue
        if idx is not None and all(_norm(t) in idx.forms for t in name.split()):
            continue  # the roster pass tags it with the right student
        reported.append(name)
    in_longer = {_norm(p) for name in reported if " " in name for p in _name_parts(name)}
    covered = bytearray(len(text))  # 1 inside an identifier
    for s, e in stops:
        covered[s:e] = b"\x01" * (e - s)
    # Words the text writes in lowercase, not counting identifiers ("azura@example.com").
    lower = {
        t.group().lower() for t in _TOKEN.finditer(text) if t.group()[:1].islower() and not covered[t.start()]
    }

    def joins(t: re.Match[str], caps: bool) -> bool:
        word = t.group()
        return not (
            len(word) < 2
            or _TOUCHES_DIGIT.match(text, t.end())
            or 1 in covered[t.start() : t.end()]
            or (word.isupper() and not caps)
            or word.lower() in lower
            or _norm(word) in _NOT_NAMES
        )

    out: list[_Cand] = []
    seen: set[str] = set()
    taken_in: set[str] = set()
    for name in reported:
        for form in (name, *(p for p in _name_parts(name) if _norm(p) not in roster_forms)):
            key = _norm(form)
            if key in seen:
                continue
            seen.add(key)
            common = " " not in form and _is_common(form)
            if common and (len(form) < 3 or form.lower() in _FUNCTION_WORDS):
                continue
            extend = form == name and " " not in name and key not in in_longer
            pattern = re.compile(_NAME_START + _form_pattern(form) + r"(?![^\W\d_])", re.IGNORECASE)
            for m in pattern.finditer(text):
                upper = text[m.start()].isupper()
                # A name that is also a word ("Mason", "Grace") counts where the text capitalizes it
                # and does not use it as the word ("May 5", "Will you").
                if common and (not upper or _used_as_word(text, m.start(), m.end(), form)):
                    continue
                out.append(_Cand("person", m.group(), m.start(), m.end(), key))
                if not (extend and upper):
                    continue
                ok = partial(joins, caps=m.group().isupper())
                begin = _given_names_start(text, m.start(), roster_forms, ok)
                stop = _family_names_end(text, m.end(), roster_forms, ok)
                if begin is None and stop is None:
                    continue
                begin, stop = (m.start() if begin is None else begin), (stop or m.end())
                out.append(_Cand("person", text[begin:stop], begin, stop, _norm(text[begin:stop])))
                for t in _TOKEN.finditer(text, begin, stop):
                    if not m.start() <= t.start() < m.end():
                        taken_in.update(_norm(p) for p in (t.group(), *_name_parts(t.group())))
    taken_in -= seen
    if taken_in:
        # One pass over the words of the text finds each word taken in wherever it is capitalized.
        for t in _TOKEN.finditer(text):
            s, e = t.span()
            if text[e - 2 : e].lower() in ("'s", "’s"):
                e -= 2
            spans = [(s, e)]
            if any(ch in "-‐‑" for ch in text[s:e]):
                spans += [(s + p.start(), s + p.end()) for p in re.finditer(r"[^\-‐‑]+", text[s:e])]
            for a, b in spans:
                if text[a].isupper() and _norm(text[a:b]) in taken_in:
                    out.append(_Cand("person", text[a:b], a, b, _norm(text[a:b])))
    return out


def _clean_name(raw: Any) -> str:
    """A model-found name the way the scan reads text: whitespace joined, normalized, and a
    possessive or trailing punctuation left off ("Bennick's" and "Cinderfall." match bare names)."""
    name = _normalize(" ".join(str(raw or "").split())).text.strip()
    return re.sub(r"(?:['’][sS]|[.,;:!?])+$", "", name).strip()


def _name_parts(name: str) -> list[str]:
    """The words of a model-found name that can stand alone: every word of a multi-word name and
    each 3+ letter piece of a hyphenated one, possessives left off. Titles and suffixes are left
    out, and so are particles ("de", "van") in lowercase or after the first word. Any other
    lowercase word counts ("Bennick cinderfall")."""
    tokens = [re.sub(r"['’][sS]$", "", t) for t in _TOKEN.findall(name)]
    parts: list[str] = []
    for i, token in enumerate(tokens):
        pieces = [token] if len(tokens) > 1 else []
        pieces += [p for p in re.split(r"[\-‐‑]+", token) if p != token and len(p) >= 3]
        for piece in pieces:
            key = _norm(piece)
            if len(key) < 2 or key in _TITLE_WORDS or key in _NAME_SUFFIXES:
                continue
            if key in _PARTICLES and (i > 0 or not piece[:1].isupper()):
                continue
            if piece not in parts:
                parts.append(piece)
    return parts


_FUNCTION_WORDS = _SUBJECT_PRONOUNS | _DETERMINERS | _TITLE_WORDS
_NAME_SUFFIXES = frozenset({"jr", "sr", "ii", "iii", "iv"})
_PARTICLES = frozenset(
    "de del della der den di da das dos du la le van von bin ibn al el ter ten".split()
)


def name_occurs(name: str, text: str) -> bool:
    """Whether a name the model reported occurs in `text`, allowing for apostrophe, dash,
    whitespace and case differences (the model may write O'Donnell for O’Donnell)."""
    name = _normalize(" ".join(str(name or "").split())).text.strip()
    if len(_norm(name)) < 2:
        return False
    pattern = re.compile(r"(?<![^\W\d_])" + _form_pattern(name) + r"(?![^\W\d_])", re.IGNORECASE)
    return pattern.search(_normalize(text).text) is not None


def occurring_names(name: str, text: str) -> list[str]:
    """What of a name the model reported occurs in `text`: the name, else each of its words that
    does ("Bennick" and "Cinderfall" in "Cinderfall, Bennick", or "Bennick" when the model
    misspelled the last name). Empty when nothing does, so a made-up name tags nothing."""
    if name_occurs(name, text):
        return [name]
    clean = _clean_name(name)
    if clean != name and name_occurs(clean, text):
        return [clean]
    return [p for p in _name_parts(clean) if name_occurs(p, text)]


# ------------------------------------------------------------------ tag map


def _letters(n: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA, 27 -> AB."""
    out = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        out = chr(65 + r) + out
    return out


def _kind_of_tag(tag: str) -> str:
    label = tag.strip("[]").split(" ")[0].lower()
    if label in ("student", "teacher"):
        return label
    return _KIND_BY_LABEL.get(label, "person")


TEACHER_TAG = "[Teacher]"
ROTATIONS = ("daily", "off")
GRACE_HOURS = 36.0
# TAG_RE allows 1 to 3 letters, [Student A] to [Student ZZZ]: about 761 days at 24 students a day.
MAX_STUDENT_CODES = 26 + 26**2 + 26**3
LITERAL_KEY = "literal:"  # the key of a [Redacted N] tag that stands for tag-shaped document text
_EPOCH_ORDINAL = date(1970, 1, 1).toordinal()
CODES_USED_UP = (
    "This device has used every student tag code. Set TAG_ROTATION=off, or move tagmap.json aside to "
    "start a new tag map."
)
MIGRATION_FAILED = (
    "The tag map could not be upgraded to version 2, so it was left as it was. Copies of tagmap.json and "
    "base.db from before the upgrade are next to them, named with .v1-backup and the time. Check that the "
    "disk has space and start again, or move tagmap.json aside to start a new tag map (Muse's old tags "
    "then stop working)."
)


def day_of(ts: float) -> int:
    """The tag day of a time: days since 1970-01-01 on the device's local calendar, the same clock
    as approvals.today()."""
    return date.fromtimestamp(ts).toordinal() - _EPOCH_ORDINAL


@lru_cache(maxsize=4096)
def day_end(day: int) -> float:
    """When a tag day ends: local midnight at the start of the next day."""
    return datetime.combine(date.fromordinal(day + 1 + _EPOCH_ORDINAL), datetime.min.time()).timestamp()


@dataclass
class _Value:
    value: str
    first_day: int
    last_day: int  # updated when the day changes, not on every call


@dataclass
class _Tag:
    kind: str
    key: str
    day: int
    issued_at: float
    last_sent: float | None = None  # when a result with this tag first went to Muse (None: never sent)


class TagMap:
    """Tag to real value, persistent per device. JSON at `path`, written 0600, never sent anywhere.

    Values (a real name or identifier, by kind and key) and tags are kept apart. Students get
    [Student A], [Student B], ... in a shuffled order chosen with a seed that is made once per
    device and stored in the file. The teacher is [Teacher]. Other kinds are numbered per kind
    ([Phone 1], [Email 1], [Person 1], ...). Codes only go up, so a tag never names two values.

    rotation="off" (the constructor's default): the same value always has the same tag and every
    tag restores, as in version 1. rotation="daily": each tag day gives a value a new tag the first
    time it is tagged that day (the roster gets its block at once, shuffled again). A tag stays
    live until `grace_hours` after its day ends, however often it is sent, and restores for Muse
    (for_muse) only once it was sent (touch). Every value from every day stays known
    (known_index), so detection never gets weaker. `clock` gives the time
    (tests). `backup` lists more files copied next to themselves before a version 1 file is
    upgraded (base.db). `path=None` keeps the map in memory (tests).
    """

    VERSION = 2

    def __init__(
        self,
        path: str | Path | None = None,
        *,
        seed: int | str | None = None,
        rotation: str = "off",
        grace_hours: float = GRACE_HOURS,
        clock: Callable[[], float] | None = None,
        backup: Iterable[str | Path] = (),
    ):
        if rotation not in ROTATIONS:
            raise ValueError(f"tag rotation must be daily or off, not {rotation!r}")
        self.path = Path(path).expanduser() if path is not None else None
        self.rotation = rotation
        self.grace = float(grace_hours) * 3600
        self.clock = clock or time.time  # tests may set it
        self._backup = tuple(Path(p) for p in backup)
        self._lock = threading.RLock()
        self._values: dict[tuple[str, str], _Value] = {}  # (kind, key) -> value
        self._tags: dict[str, _Tag] = {}  # tag -> its row, oldest first
        self._by_day: dict[tuple[int, str, str], str] = {}  # (day, kind, key) -> tag
        self._newest: dict[tuple[str, str], str] = {}  # (kind, key) -> its newest tag
        self._counters: dict[str, int] = {}
        self._next_letter = 0
        self._version = 0
        self._value_index: tuple[int, re.Pattern[str] | None, dict[str, tuple[str, str]]] | None = None
        self.backups: list[Path] = []  # the copies made before a version 1 file was upgraded
        self._dirty = False
        if self.path is not None and self.path.exists():
            self._load()
        else:
            self._seed = str(seed) if seed is not None else secrets.token_hex(8)
            self._dirty = self.path is not None

    @classmethod
    def load(cls, path: str | Path, *, seed: int | str | None = None) -> TagMap:
        return cls(path, seed=seed)

    @classmethod
    def for_settings(cls, settings: Any, *, seed: int | str | None = None) -> TagMap:
        """The device's map, with TAG_ROTATION and TAG_GRACE_HOURS; base.db is backed up too
        before a version 1 file is upgraded."""
        paths = settings.paths
        return cls(
            paths.tagmap,
            seed=seed,
            rotation=getattr(settings, "tag_rotation", "off"),
            grace_hours=getattr(settings, "tag_grace_hours", GRACE_HOURS),
            backup=[paths.db],
        )

    @property
    def seed(self) -> str:
        return self._seed

    def today(self, now: float | None = None) -> int:
        return day_of(self.clock() if now is None else now)

    # loading, the version 1 upgrade, saving

    def _load(self) -> None:
        try:
            raw = self.path.read_bytes()
            data = json.loads(raw.decode("utf-8"))
            version = data.get("version")
        except (OSError, ValueError, AttributeError) as exc:
            raise GuardError("the tag map file is unreadable; fix or remove it before tagging") from exc
        if version == 1:
            self._migrate(data, raw)
            return
        try:
            if version != self.VERSION:
                raise ValueError("unknown tag map version")
            self._seed = str(data["seed"])
            self._next_letter = int(data.get("next_letter", 0))
            self._counters = {str(k): int(v) for k, v in (data.get("counters") or {}).items()}
            for v in data.get("values") or []:
                ident = (str(v["kind"]), str(v["key"]))
                self._values[ident] = _Value(str(v["value"]), int(v["first_day"]), int(v["last_day"]))
            for t in data.get("tags") or []:
                ident = (str(t["kind"]), str(t["key"]))
                if ident not in self._values:
                    raise ValueError("a tag without a value")
                sent = t.get("last_sent")
                self._add_tag(str(t["tag"]), *ident, int(t["day"]), float(t["issued_at"]), None if sent is None else float(sent))
            self._version += 1
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            # Starting over would hand old tags to new people, so refuse instead.
            raise GuardError("the tag map file is unreadable; fix or remove it before tagging") from exc

    def _migrate(self, data: Mapping[str, Any], raw: bytes) -> None:
        """Version 1 to 2. The file (and `backup`, base.db) is copied next to itself first; then
        each entry becomes a value and a tag on today's tag day, counted as sent now since Muse may
        hold it. A failure leaves the copies and raises GuardError with a plain message."""
        try:
            self.backups = _back_up(self.path, raw, self._backup, self.clock())
        except (OSError, sqlite3.Error) as exc:
            raise GuardError(MIGRATION_FAILED) from exc
        try:
            now = self.clock()
            day = self.today(now)
            self._seed = str(data["seed"])
            self._next_letter = int(data.get("next_letter", 0))
            self._counters = {str(k): int(v) for k, v in (data.get("counters") or {}).items()}
            for e in data.get("entries") or []:
                ident = (str(e["kind"]), str(e["key"]))
                self._remember(ident, str(e["value"]), day)
                self._add_tag(str(e["tag"]), *ident, day, now, now)
            self.save()
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            raise GuardError(MIGRATION_FAILED) from exc

    def save(self) -> None:
        """Write the map atomically with mode 0600."""
        if self.path is None:
            self._dirty = False
            return
        with self._lock:
            payload = {
                "version": self.VERSION,
                "seed": self._seed,
                "rotation": self.rotation,
                "next_letter": self._next_letter,
                "counters": self._counters,
                "values": [
                    {"kind": k, "key": key, "value": v.value, "first_day": v.first_day, "last_day": v.last_day}
                    for (k, key), v in self._values.items()
                ],
                "tags": [
                    {"tag": t, "kind": r.kind, "key": r.key, "day": r.day, "issued_at": r.issued_at, "last_sent": r.last_sent}
                    for t, r in self._tags.items()
                ],
            }
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            tmp = self.path.with_name(self.path.name + ".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=1)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
            os.chmod(self.path, 0o600)
            self._dirty = False

    def flush(self) -> None:
        """Save only if something changed since the last save."""
        if self._dirty:
            self.save()

    # tags

    def _add_tag(self, tag: str, kind: str, key: str, day: int, issued_at: float, last_sent: float | None = None) -> None:
        self._tags[tag] = _Tag(kind, key, day, issued_at, last_sent)
        self._by_day[(day, kind, key)] = tag
        self._newest[(kind, key)] = tag

    def _remember(self, ident: tuple[str, str], value: str, day: int) -> None:
        known = self._values.get(ident)
        if known is None:
            self._values[ident] = _Value(value, day, day)
            self._version += 1
            self._dirty = True
        elif known.last_day < day:
            known.last_day = day
            self._dirty = True

    def _new_code(self, kind: str) -> str:
        if kind == "teacher" and TEACHER_TAG not in self._tags:
            return TEACHER_TAG
        if kind == "student":
            if self._next_letter >= MAX_STUDENT_CODES:
                raise GuardError(CODES_USED_UP)
            tag = f"[Student {_letters(self._next_letter)}]"
            self._next_letter += 1
            return tag
        label_kind = "person" if kind == "teacher" else kind  # a second teacher is a person
        n = self._counters.get(label_kind, 0) + 1
        self._counters[label_kind] = n
        return f"[{_LABELS.get(label_kind, 'Person')} {n}]"

    def tag_for(self, kind: str, key: str, value: str | None = None, day: int | None = None) -> str:
        """The tag for one real value on tag day `day` (default today), made the first time the
        value is tagged that day. With rotation off the value keeps its one tag."""
        with self._lock:
            now = self.clock()
            ident = (kind, key)
            self._remember(ident, key if value is None else value, self.today(now))
            day = self.today(now) if day is None or self.rotation == "off" else day
            newest = self._newest.get(ident)
            if self.rotation == "off" or newest == TEACHER_TAG:
                tag = newest
            else:
                tag = self._by_day.get((day, kind, key))
            if tag is not None:
                return tag
            tag = self._new_code(kind)
            self._add_tag(tag, kind, key, day, now)
            self._dirty = True
            return tag

    def ensure_roster(self, roster: Any, day: int | None = None) -> None:
        """Give the teacher [Teacher] and every student without a tag on this tag day a letter, in
        this device's shuffled order (a new shuffle for each day's block)."""
        with self._lock:
            self.tag_for("teacher", roster.teacher.name, roster.teacher.name, day)
            if self.rotation == "off":
                new = sorted({s.name for s in roster.students if ("student", s.name) not in self._newest})
                order = f"{self._seed}:{self._next_letter}"
            else:
                day = self.today() if day is None else day
                new = sorted({s.name for s in roster.students if (day, "student", s.name) not in self._by_day})
                order = f"{self._seed}:{day}:{self._next_letter}"
            if not new:
                return
            random.Random(order).shuffle(new)
            for name in new:
                self.tag_for("student", name, name, day)

    def view(self, day: int | None = None) -> TagView:
        """This map pinned to tag day `day` (default today): what guard.tag uses for one text."""
        return TagView(self, self.today() if day is None else day)

    def _live(self, tag: str, row: _Tag, now: float) -> bool:
        if self.rotation == "off" or tag == TEACHER_TAG:
            return True
        # From the tag's own day only: sending a tag again never keeps it alive, so a Muse that
        # keeps using its tags still gets new ones once their day and the grace have passed.
        return now < day_end(row.day) + self.grace

    def _value_of(self, row: _Tag) -> str | None:
        known = self._values.get((row.kind, row.key))
        return known.value if known else None

    def get(self, tag: str) -> str | None:
        with self._lock:
            row = self._tags.get(tag)
            return self._value_of(row) if row else None

    def kind_of(self, tag: str) -> str | None:
        row = self._tags.get(tag)
        return row.kind if row else None

    def as_dict(self) -> dict[str, str]:
        """{tag: real value} for every live tag: what the device's own model reads and writes."""
        with self._lock:
            now = self.clock()
            return {t: self._value_of(r) for t, r in self._tags.items() if self._live(t, r, now)}

    def for_muse(self) -> dict[str, str]:
        """{tag: real value} for the tags Muse may send back: live and sent (every tag with rotation
        off). [Teacher] is the user, never changes and always restores."""
        with self._lock:
            now = self.clock()
            return {
                t: self._value_of(r)
                for t, r in self._tags.items()
                if self._live(t, r, now) and (self.rotation == "off" or t == TEACHER_TAG or r.last_sent is not None)
            }

    def touch(self, tags: Iterable[str], now: float | None = None) -> None:
        """Mark tags as sent to Muse (a shared result held them), so they restore until their
        day's grace window ends. Saved at once the first time; sending one again changes nothing."""
        with self._lock:
            now = self.clock() if now is None else now
            changed = False
            for tag in tags:
                row = self._tags.get(tag)
                if row is not None and row.last_sent is None:
                    row.last_sent = now
                    changed = True
            if changed:
                self._dirty = True
                self.flush()

    def _days(self, *texts: str) -> set[int]:
        """The tag days of the tags in `texts` that restore for Muse ([Teacher] has none)."""
        with self._lock:
            restorable = self.for_muse()
            refs = [t for text in texts for t, _b in tag_references(text)]
            return {self._tags[t].day for t in refs if t in restorable and t != TEACHER_TAG}

    def expired(self, text: str) -> list[str]:
        """The tags in Muse's `text` that will not restore: never sent, past their grace window or
        never made. Bracketed tags of any kind count, and Student and Person references without
        brackets ("Student B"). Always empty with rotation off."""
        if self.rotation == "off" or not text:
            return []
        restorable = self.for_muse()
        out = [
            tag
            for tag, bracketed in tag_references(text, as_written=True)
            if tag not in restorable and (bracketed or _kind_of_tag(tag) in ("student", "person"))
        ]
        return list(dict.fromkeys(out))

    def day_for(self, text: str) -> int | None:
        """The newest tag day among the tags in `text` that restore for Muse, or None. A result for
        a request with yesterday's tags is tagged on that day, so Muse gets the tags it used."""
        if self.rotation == "off" or not text:
            return None
        days = self._days(text)
        return max(days) if days else None

    def mixed_days(self, *texts: str) -> bool:
        """True when the tags in Muse's `texts` that restore come from more than one tag day. The
        connector refuses such a request (EXPIRED_TAG), so no answer puts a person from an older
        day's tags into today's tags, which would link the two codes. Each text is read on its
        own, so a tag never runs from the end of one into the start of the next."""
        if self.rotation == "off" or not any(texts):
            return False
        return len(self._days(*texts)) > 1

    # retention

    def purge(
        self,
        now: float | None = None,
        retention_days: int | None = None,
        roster: Any = None,
        keep: Iterable[str] = (),
    ) -> dict[str, int]:
        """Drop what can no longer be used. With rotation daily, every tag past its grace window
        (it cannot restore anything; the counters keep its code from coming back). With
        `retention_days`, every value not on the roster whose last day is older than that, with
        its tags, unless a live tag (rotation daily) or a tag in `keep` still points to it. `keep`
        holds tags in results still waiting for the user's OK. Returns {"tags": n, "values": m}."""
        with self._lock:
            now = self.clock() if now is None else now
            keep = set(keep)
            dropped_tags = 0
            if self.rotation == "daily":
                gone = [t for t, r in self._tags.items() if t not in keep and not self._live(t, r, now)]
                for t in gone:
                    del self._tags[t]
                dropped_tags = len(gone)
            dropped_values = 0
            if retention_days is not None:
                held = {(r.kind, r.key) for t, r in self._tags.items() if t in keep or self.rotation == "daily"}
                held |= _roster_idents(roster)
                cutoff = self.today(now) - int(retention_days)
                old = {i for i, v in self._values.items() if v.last_day < cutoff and i not in held}
                for ident in old:
                    del self._values[ident]
                tags = [t for t, r in self._tags.items() if (r.kind, r.key) in old]
                for t in tags:
                    del self._tags[t]
                dropped_tags += len(tags)
                dropped_values = len(old)
            if dropped_tags or dropped_values:
                self._by_day, self._newest = {}, {}
                for t, r in self._tags.items():
                    self._by_day[(r.day, r.kind, r.key)] = t
                    self._newest[(r.kind, r.key)] = t
                self._version += 1
                self._dirty = True
                self.flush()
            return {"tags": dropped_tags, "values": dropped_values}

    # what the scans read

    def values(self) -> list[str]:
        with self._lock:
            return [v.value for v in self._values.values()]

    def known_values(self) -> list[tuple[str, str]]:
        """(kind, value) for every value from every tag day."""
        with self._lock:
            return [(kind, v.value) for (kind, _key), v in self._values.items()]

    def __len__(self) -> int:
        return len(self._tags)

    def __contains__(self, tag: object) -> bool:
        return tag in self._tags

    def known_index(self) -> tuple[re.Pattern[str] | None, dict[str, tuple[str, str]]]:
        """A regex for every real value in the map, and normalized value -> (kind, key)."""
        with self._lock:
            if self._value_index is None or self._value_index[0] != self._version:
                regex, lookup = _value_regex((ident, v.value) for ident, v in self._values.items())
                self._value_index = (self._version, regex, lookup)
            return self._value_index[1], self._value_index[2]


class TagView:
    """A TagMap pinned to one tag day: tag_for and ensure_roster use that day. Everything else is
    the map's own. guard.tag pins the day at its start, so one text never mixes two days' tags,
    and egress pins the day of the tags in Muse's request (TagMap.day_for)."""

    def __init__(self, tagmap: TagMap, day: int):
        self.tagmap = tagmap
        self.day = day

    def tag_for(self, kind: str, key: str, value: str | None = None, day: int | None = None) -> str:
        return self.tagmap.tag_for(kind, key, value, self.day if day is None else day)

    def ensure_roster(self, roster: Any, day: int | None = None) -> None:
        self.tagmap.ensure_roster(roster, self.day if day is None else day)

    def view(self, day: int | None = None) -> TagView:
        return self if day is None else self.tagmap.view(day)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.tagmap, name)


def _roster_idents(roster: Any) -> set[tuple[str, str]]:
    """The tag map keys of the people on the roster, whose values stay while they are on it."""
    if roster is None:
        return set()
    return {("teacher", roster.teacher.name), *(("student", s.name) for s in roster.students)}


BACKUP_SUFFIX = ".v1-backup-"
COPYING_SUFFIX = ".v1-copying-"  # a base.db copy still being written (back_up_files)


def _back_up(path: Path, raw: bytes, more: Iterable[Path], now: float) -> list[Path]:
    """Copy `path` (its bytes are `raw`) and each existing file in `more` next to itself as
    <name>.v1-backup-<local time>, 0600. Each file is checked on its own: a copy of the same tag
    map, or any earlier copy of a file in `more`, is enough, so a service that restarts after a
    failed upgrade does not fill the disk, and a base.db never copied is still copied."""
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now))
    made = []
    if not any(p.read_bytes() == raw for p in path.parent.glob(f"{path.name}{BACKUP_SUFFIX}*")):
        dst = path.with_name(f"{path.name}{BACKUP_SUFFIX}{stamp}")
        fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
        os.chmod(dst, 0o600)
        made.append(dst)
    return made + back_up_files(more, now)


def _usable_copy(path: Path) -> bool:
    """A finished SQLite copy: its schema reads and has a table. Read as immutable, so no -wal or
    -shm file is made next to the copy."""
    try:
        with contextlib.closing(sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro&immutable=1", uri=True)) as db:
            return db.execute("SELECT count(*) FROM sqlite_master").fetchone()[0] > 0
    except (OSError, sqlite3.Error):
        return False


def back_up_files(files: Iterable[Path], now: float | None = None) -> list[Path]:
    """Copy each existing SQLite file in `files` that has no usable <name>.v1-backup-* copy yet
    next to itself, 0600, through SQLite's backup API (a consistent snapshot, WAL included).
    Returns the copies made. Used before the tag map upgrade and before base.db's first schema
    change. The copy is written under a .v1-copying- name and renamed only once it is complete,
    so a copy that fails partway (a full disk, a kill) leaves no file that looks like a backup,
    and an empty one an older start left behind does not count."""
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(time.time() if now is None else now))
    made = []
    for src in map(Path, files):
        if not src.exists() or any(_usable_copy(p) for p in src.parent.glob(f"{src.name}{BACKUP_SUFFIX}*")):
            continue
        for old in src.parent.glob(f"{src.name}{COPYING_SUFFIX}*"):  # left by a start that was killed
            old.unlink(missing_ok=True)
        dst = src.with_name(f"{src.name}{BACKUP_SUFFIX}{stamp}")
        part = src.with_name(f"{src.name}{COPYING_SUFFIX}{stamp}")
        try:
            os.close(os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
            with contextlib.closing(sqlite3.connect(src)) as a, contextlib.closing(sqlite3.connect(part)) as b:
                a.backup(b)
            os.chmod(part, 0o600)
            os.replace(part, dst)
        except BaseException:
            for p in src.parent.glob(f"{part.name}*"):  # the copy and its -journal
                p.unlink(missing_ok=True)
            raise
        made.append(dst)
    return made


def _value_regex(entries: Iterable[tuple[Any, str]]) -> tuple[re.Pattern[str] | None, dict[str, Any]]:
    """A regex for the values, and normalized value -> the first id given with it. Tag-shaped
    values (a [Redacted N] for tag-shaped document text) are words, not private values."""
    lookup: dict[str, Any] = {}
    values: list[str] = []
    for ident, value in entries:
        if TAG_RE.fullmatch(value.strip()):
            continue
        key = _norm(_normalize(value).text)
        if len(key) >= 2 and key not in lookup:
            lookup[key] = ident
            values.append(value)
    if not values:
        return None, lookup
    values.sort(key=len, reverse=True)
    body = "|".join(_form_pattern(_normalize(v).text) for v in values)
    regex = re.compile(r"(?<![^\W\d_])(?:" + body + r")(?![^\W\d_])", re.IGNORECASE)
    return regex, lookup


def _known_cands(text: str, tagmap: Any) -> list[_Cand]:
    """Every real value already in the tag map: names from the model pass, old identifiers."""
    if tagmap is None:
        return []
    if hasattr(tagmap, "known_index"):
        regex, lookup = tagmap.known_index()  # (kind, key) for every value from every tag day
    else:
        mapping = dict(tagmap.as_dict() if hasattr(tagmap, "as_dict") else tagmap)
        regex, lookup = _value_regex(((_kind_of_tag(t), _norm(v)), v) for t, v in mapping.items())
    if regex is None:
        return []
    out: list[_Cand] = []
    for m in regex.finditer(text):
        ident = lookup.get(_norm(m.group()))  # text is already the normalized copy
        if ident is None:
            continue
        kind, key = ident
        word = m.group()
        if kind == "person" and " " not in word and _is_common(word):
            if not word[:1].isupper() or _used_as_word(text, m.start(), m.end(), word):
                continue  # "Mason" the person, not "a mason jar"; "May" the person, not "May 5"
        out.append(_Cand(kind, word, m.start(), m.end(), key))
    return out


# ------------------------------------------------------------------ tag, restore, leaks


def _scan(
    text: str,
    roster: Any,
    tagmap: Any,
    extra_names: Iterable[str] = (),
    model: list[_Cand] | None = None,
    redaction: Redaction | None = None,
) -> list[_Cand]:
    """Every private value in `text`, found in its normalized copy, with spans in `text`.
    `model` collects every candidate from the model's names, overlapped ones included.
    `redaction` applies the user's controls (None: tag everything)."""
    norm = _normalize(text)
    t = norm.text
    cands = _identifier_cands(t, roster)
    stops = [(c.start, c.end) for c in cands]
    if roster is not None:
        cands += _index(roster).cands(t)
    # What only a toggle tags is remembered, but counts only while a toggle asks for that kind.
    wanted = redaction.extra_kinds if redaction is not None else frozenset()
    cands += [c for c in _known_cands(t, tagmap) if c.kind not in EXTRA_KINDS or c.kind in wanted]
    if extra_names:
        extra = _extra_name_cands(t, extra_names, roster, stops)
        if model is not None:
            model += extra
        cands += extra
    cands = _apply_redaction(cands, t, redaction)
    return _remap(_resolve(cands, _tag_spans(t)), text, norm)


def tag(
    text: str,
    roster: Any,
    tagmap: TagMap | None,
    llm_names: Callable[[str], list[str]] | None = None,
    never_share: Mapping[str, Iterable[str]] | None = None,
    redaction: Redaction | None = None,
) -> TagResult:
    """Replace identifiers, roster names, model-found names and known values with tags.

    `redaction` is the user's controls for this result (None: tag everything; see Redaction).

    Longest span first, never inside an existing tag, so tagging tagged text changes nothing.
    After each pass the output is scanned again until nothing is found. Hits from the first pass
    carry positions in `text`; hits from a later pass (rare) carry positions in the partly tagged
    text. If `llm_names` raises, the error propagates so the caller holds the result.

    Model-found names are tagged with their words and, for a one-word name, the capitalized
    neighbors it takes in (_extra_name_cands). Every one of those values is then stored in the tag
    map, even where a longer span covered it, so a later "Bennick" alone is a known value.

    A TagMap is pinned to today's tag day for the whole call (a TagView keeps its own day), so a
    text tagged across midnight never mixes two days' tags.
    """
    if tagmap is None:
        tagmap = TagMap(None)
    if isinstance(tagmap, TagMap):
        tagmap = tagmap.view()
    if roster is not None:
        tagmap.ensure_roster(roster)
    extra = [n for n in llm_names(text) if isinstance(n, str)] if llm_names is not None else []
    extra = [n for n in extra if not all(w in _CLASS_WORDS for w in n.lower().split())]
    hits: list[Hit] = []
    used: dict[str, str] = {}
    model: list[_Cand] = []
    out = text or ""
    clean = False
    for i in range(_MAX_PASSES):
        found = _scan(out, roster, tagmap, extra, model if i == 0 else None, redaction)
        if not found:
            clean = True
            break
        pieces: list[str] = []
        last = 0
        for c in found:
            if c.start < last:
                continue  # two matches from one original character (an NFKC expansion)
            t = tagmap.tag_for(c.kind, c.key, c.nvalue or c.value)
            used[t] = tagmap.get(t) or c.value
            hits.append(Hit(c.kind, c.value, c.start, c.end))
            pieces += [out[last : c.start], t]
            last = c.end
        pieces.append(out[last:])
        out = "".join(pieces)
    else:
        clean = not _scan(out, roster, tagmap, extra, redaction=redaction)
    # Every name the model pass found becomes a known value, also where a longer name covered it
    # ("Bennick" inside "Hi Bennick", "Cinderfall" inside "Bennick Cinderfall"), so a later text
    # that has it alone is tagged and the final check catches it. A common word ("Grace", "May")
    # is remembered only where it was tagged on its own.
    for c in model:
        if " " in c.value or not _is_common(c.value):
            tagmap.tag_for(c.kind, c.key, c.value)
    tagmap.flush()
    if not clean:
        raise GuardError("text still has private values after tagging")
    topics = blocked_topics(text or "", never_share)
    return TagResult(text=out, tag_map=used, hits=hits, blocked=[_reason(t) for t in topics], topics=topics)


_RESTORE_RE = re.compile(
    r"\[\s*(?P<teacher>teacher)\s*\]"
    # Spaces or tabs only between "student" and its code: "per student\nI want" is two lines, not a tag.
    r"|(?P<ob>\[\s*)?\b(?P<student>student)[ \t]+(?P<letters>[a-z]{1,3})(?![a-z])(?(ob)\s*\])"
    r"|(?P<ob2>\[\s*)?\b(?P<kind>person|phone|email|ssn|card|code|id|address|dob|redacted)\s+(?P<num>\d+)(?!\d)(?(ob2)\s*\])"
    # Only in brackets: "Age 12" or "Date 2" in a sentence is not a tag.
    r"|\[\s*(?P<kind2>place|date|age|detail|record|url|ip)\s+(?P<num2>\d+)\s*\]",
    re.IGNORECASE,
)
# After a lowercase "student a" (or "student i"), what shows it is a reference and not the article.
_REFERENCE_AFTER = re.compile(
    r"['’]s\b|\s*[.,;:!?)\]]|\s*$|\s+(?:and|or|is|was|has|had|needs|did|does|wrote|got|scored|earned"
    r"|should|will|can|could|would|might|must|also|then|but)\b"
)
_ABBREVIATION_AFTER = re.compile(r"\.[^\W\d_]")  # "Student I.D.", "student e.g.", "student i.e."


def _canonical(m: re.Match[str]) -> str | None:
    """The tag a _RESTORE_RE match refers to, like [Student A], or None when it is plain words."""
    if m.group("teacher"):
        return TEACHER_TAG
    if m.group("student"):
        letters = m.group("letters")
        if not m.group("ob") and len(letters) > 1:
            # Without brackets two or three letters are words or acronyms as often as codes
            # ("student is", "Student ID", "STUDENT OF THE MONTH"), and daily rotation makes
            # most of those codes real, so only [Student AB] in brackets counts.
            return None
        if not m.group("ob") and _ABBREVIATION_AFTER.match(m.string, m.end()):
            return None
        if (
            not m.group("ob")
            and letters.islower()
            and letters in ("a", "i")
            and not _REFERENCE_AFTER.match(m.string, m.end())
        ):
            return None  # "give every student a chance"
        return f"[Student {letters.upper()}]"
    if m.group("kind2"):
        return f"[{_LABELS[_KIND_BY_LABEL[m.group('kind2').lower()]]} {m.group('num2')}]"
    word = m.group("kind")
    if not m.group("ob2") and not word[:1].isupper():
        return None  # "error code 1" stays as written
    return f"[{_LABELS[_KIND_BY_LABEL[word.lower()]]} {m.group('num')}]"


def tag_references(text: str, *, as_written: bool = False) -> list[tuple[str, bool]]:
    """(tag, bracketed) for every tag `restore` would swap in `text`, in order. Without brackets
    a Student reference has one letter ("Student B"), on the same line as "student" and not before
    a dot and a letter ("Student I.D.", "student e.g."); two or three letters count only in
    brackets ([Student AB]), so "student is", "Student ID" or "Student IEP" stay words. With
    `as_written` an unbracketed Student reference counts only when its letter is a capital, so
    plain words ("each student who has", "the student was") never read as a tag."""
    if not text:
        return []
    out = []
    for m in _RESTORE_RE.finditer(text):
        canonical = _canonical(m)
        if canonical is None:
            continue
        bracketed = m.group(0).startswith("[")
        if as_written and not bracketed and m.group("student") and not m.group("letters").isupper():
            continue
        out.append((canonical, bracketed))
    return out


def unbracketed_codes(text: str, tags: Collection[str]) -> int:
    """How many capital two or three letter Student codes in `text` are in `tags` but have no
    brackets, so restore left them as written. "Student AB" counts when [Student AB] is in `tags`;
    "Student is" never does."""
    count = 0
    for m in _RESTORE_RE.finditer(text or ""):
        letters = m.group("letters")
        if letters and not m.group("ob") and len(letters) > 1 and letters.isupper():
            count += f"[Student {letters}]" in tags
    return count


def restore(text: str, tag_map: Mapping[str, str] | TagMap) -> str:
    """Swap tags back to real values. Tolerant of Muse rephrasing: [Student A], Student A,
    student a, Student A's, (Student A). [Student A] and [Student AB] never mix, and a code of
    two or three letters restores only in brackets (tag_references). A TagMap gives its live
    tags (as_dict); the connector passes TagMap.for_muse() for Muse's text."""
    if not text:
        return text
    mapping = tag_map.as_dict() if hasattr(tag_map, "as_dict") else dict(tag_map or {})
    lookup = {(k if k.startswith("[") else f"[{k}]"): v for k, v in mapping.items()}
    if not lookup:
        return text

    def swap(m: re.Match[str]) -> str:
        canonical = _canonical(m)
        value = lookup.get(canonical) if canonical is not None else None
        return value if value is not None else m.group(0)

    return _RESTORE_RE.sub(swap, text)


def neutralize_tags(text: str, tagmap: Any) -> str:
    """Tag-shaped text from a document ("[Student B]", "[Teacher]") as a [Redacted N] tag whose
    value is that literal text. Muse then never takes it for a real tag, and restoring it gives
    back the words, never a person. Egress runs it on a raw result before tagging (by contract a
    raw result holds real values, never tags). "Student B" without brackets is left as written."""
    if not text or "[" not in text:
        return text or ""
    return TAG_RE.sub(lambda m: tagmap.tag_for("term", LITERAL_KEY + m.group(), m.group()), text)


def leaks(text: str, roster: Any, tagmap: Any, redaction: Redaction | None = None) -> list[Hit]:
    """Everything in `text` that is a roster name, nickname, real value in the tag map, or an
    identifier. Tags themselves are never reported. Used by egress and the eval. With `redaction`,
    what the user chose to leave as written is not a leak, and an always-redact word is."""
    if not text:
        return []
    found = _scan(text, roster, tagmap, redaction=redaction)
    taken = [(c.start, c.end) for c in found]
    compact = _compact_cands(text, roster, tagmap)
    if redaction is not None and not redaction.is_default:
        compact = [c for c in _apply_redaction(compact, text, redaction) if c.kind != "term"]
    compact = [c for c in compact if c.kind not in EXTRA_KINDS]
    extra = [c for c in compact if not any(c.start < e and s < c.end for s, e in taken)]
    return _hits(sorted([*found, *extra], key=lambda c: c.start))


COMPACT_MIN = 8  # letters; shorter full names ("Ty Vo") turn up inside ordinary words


def _compact_targets(roster: Any, tagmap: Any) -> list[tuple[str, str]]:
    """(kind, letters-only lowercase form) for every full name the leak check spells out."""
    targets: dict[str, str] = {}
    if roster is not None:
        for i, p in enumerate([roster.teacher, *roster.students]):
            kind = "teacher" if i == 0 else "student"
            forms = [p.name, f"{p.first} {p.last}", *(f"{n} {p.last}" for n in p.nicknames)]
            for form in forms:
                key = re.sub(r"[^a-z]", "", _normalize(form).text.lower())
                if len(key) >= COMPACT_MIN:
                    targets.setdefault(key, kind)
    if tagmap is not None:
        if hasattr(tagmap, "known_values"):  # every value from every tag day
            pairs = tagmap.known_values()
        else:
            mapping = tagmap.as_dict() if hasattr(tagmap, "as_dict") else dict(tagmap)
            pairs = [(_kind_of_tag(tag), value) for tag, value in mapping.items()]
        for kind, value in pairs:
            if kind in _NAME_KINDS and " " in str(value).strip():
                key = re.sub(r"[^a-z]", "", _normalize(str(value)).text.lower())
                if len(key) >= COMPACT_MIN:
                    targets.setdefault(key, kind)
    return [(kind, key) for key, kind in targets.items()]


def _compact_cands(text: str, roster: Any, tagmap: Any) -> list[_Cand]:
    """Full names spelled with the letters run together, dashed, slugged or reversed
    ("C-a-m-i-l-a R-e-s-t-r-e-p-o", "camilarestrepo", "opertseR alimaC").

    Only the leak check uses this: it is stricter than tag() on purpose, so final_check is a
    second line of defense rather than the same scanner run twice.
    """
    targets = _compact_targets(roster, tagmap)
    if not targets:
        return []
    norm = _normalize(TAG_RE.sub(lambda m: "|" * len(m.group()), text))
    letters: list[str] = []
    where: list[int] = []
    for i, ch in enumerate(norm.text.lower()):
        if "a" <= ch <= "z":
            letters.append(ch)
            where.append(i)
    compact = "".join(letters)
    out: list[_Cand] = []
    for kind, key in targets:
        for probe in (key, key[::-1]):
            start = compact.find(probe)
            while start != -1:
                s, e = norm.span(where[start], where[start + len(probe) - 1] + 1)
                out.append(_Cand(kind, text[s:e], s, e, key))
                start = compact.find(probe, start + 1)
    return out


# ------------------------------------------------------------------ never-share topics

TOPIC_REASONS = {
    "iep": "Mentions an IEP or 504 plan",
    "medical": "Mentions health or medical details",
    "discipline": "Mentions a discipline matter",
    "custody": "Mentions custody or family court details",
    "immigration": "Mentions immigration status",
    "home_address": "Mentions a home address",
    "parent_contact": "Mentions parent contact details",
    "lunch_status": "Mentions free or reduced lunch status",
    "grades": "Mentions grades",
    "counseling": "Mentions counseling",
}
_KEYWORD_CACHE: dict[str, re.Pattern[str]] = {}


def _keyword_re(keyword: str) -> re.Pattern[str]:
    pattern = _KEYWORD_CACHE.get(keyword)
    if pattern is None:
        body = r"\s+".join(re.escape(w) for w in keyword.split())
        # Letters only at the edges: "_" or a digit next to a keyword ("camila_iep_goals") still counts.
        pattern = re.compile(rf"(?<![^\W\d_]){body}(?:s|es)?(?![^\W\d_])", re.IGNORECASE)
        _KEYWORD_CACHE[keyword] = pattern
    return pattern


def blocked_topics(text: str, never_share: Mapping[str, Iterable[str]] | None) -> list[str]:
    """Topic names from `never_share` whose keywords appear in text (case-insensitive, whole words)."""
    if not text or not never_share:
        return []
    text = _normalize(text).text
    found = []
    for topic, keywords in never_share.items():
        words = [keywords] if isinstance(keywords, str) else list(keywords or [])
        if any(_keyword_re(str(k).strip()).search(text) for k in words if k and str(k).strip()):
            found.append(str(topic))
    return found


def _reason(topic: str) -> str:
    return TOPIC_REASONS.get(topic) or f"Mentions {topic.replace('_', ' ')}"


def blocked_reasons(text: str, never_share: Mapping[str, Iterable[str]] | None) -> list[str]:
    """One plain-language reason per blocked topic, for the approval page."""
    return [_reason(t) for t in blocked_topics(text, never_share)]
