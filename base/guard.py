"""Redaction guard. See the Guard section of docs/CONTRACTS.md.

The guard finds roster names and personal identifiers in text, swaps them for stable tags such as
[Student C] or [Phone 1], swaps tags back in Muse's requests, and reports anything that would leak.
It runs on the device with plain regexes and a one-edit string check, so it keeps working when no
model is reachable. The local model only adds an optional second pass for names (`llm_names`).

Ideas for the exact checks (Luhn, one-time codes next to a code word) came from decision-guard's
prefilters; this is new Python written for this repo.
"""

from __future__ import annotations

import json
import os
import random
import re
import secrets
import threading
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from base.types import Hit, Person, Roster, TagResult

__all__ = [
    "GuardError",
    "TAG_RE",
    "TagMap",
    "blocked_reasons",
    "blocked_topics",
    "find_identifiers",
    "find_names",
    "leaks",
    "load_roster",
    "luhn_valid",
    "restore",
    "tag",
]


class GuardError(RuntimeError):
    """Raised when text cannot be tagged cleanly. Callers must hold the result."""


# Every tag the guard writes. Text inside a tag is never matched again, which keeps tag() idempotent.
TAG_RE = re.compile(
    r"\[(?:Student [A-Z]{1,3}|Teacher|(?:Person|Phone|Email|SSN|Card|Code|ID|Address|DOB) \d+)\]"
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
}
_KIND_BY_LABEL = {label.lower(): kind for kind, label in _LABELS.items()}
_NAME_KINDS = frozenset({"student", "teacher", "person"})

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


_DIGIT_RUN = re.compile(r"\d+(?:[ -]\d+)*")
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
    r"(?:\bssn|\bss#|\bsocial\s+security(?:\s+(?:number|no\.?|#))?|\bitin|\btax\s+id)"
    r"(?:\s+(?:number|no\.?)|\s*#)?\s*(?:is|was|:|=)?\s*(\d{9})(?!\d)",
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


_SID = re.compile(r"(?<![\w-])S\d{5,8}(?![\w-])")
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


def _identifier_cands(text: str, roster: Any = None, allow_test_ssn: bool = True) -> list[_Cand]:
    out: list[_Cand] = []
    if any(ch.isdigit() for ch in text):
        out.extend(_cards(text))
        out.extend(_ssns(text, allow_test_ssn))
        out.extend(_phones(text))
        out.extend(_otps(text))
        out.extend(_student_ids(text, roster))
        out.extend(_cand("address", text, m.start(), m.end()) for m in _ADDRESS.finditer(text))
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
    return _hits(_resolve(_identifier_cands(text, roster, allow_test_ssn), _tag_spans(text)))


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
_PRECEDING_NAMES = re.compile(r"((?:[A-Z][^\W\d_]*(?:['’\-‐‑][^\W\d_]+)*[ \t]+){1,2})$")
_TITLE_WORDS = frozenset(
    {"mr", "mrs", "ms", "mx", "dr", "miss", "mister", "coach", "professor", "prof", "sir", "madam", "dear"}
)
_NEXT_WORD = re.compile(r"[ \t]+([^\W\d_]+|\d)")


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
                r"(?<![\w'’])(?:" + "|".join(_form_pattern(f) for f in texts) + r")(?!\w)", re.IGNORECASE
            )
            if texts
            else None
        )
        t = roster.teacher
        self.title_re = None
        if t.last:
            self.title_re = re.compile(
                rf"(?<![\w'’])(?:{_TITLES})\.?\s+(?:{_form_pattern(t.first)}\s+)?{_form_pattern(t.last)}(?!\w)",
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
            if types & {"last", "part"} or ambiguous or len(_norm(form)) <= 2:
                return False
            return True
        if not ambiguous:
            return True
        nxt = _NEXT_WORD.match(text, end)
        next_word = nxt.group(1).lower() if nxt else ""
        prv = _PREV_WORD.search(text, max(0, start - 30), start)
        prev_word = prv.group(1).lower() if prv else ""
        if next_word in _SUBJECT_PRONOUNS or prev_word in _DETERMINERS:
            return False  # "May I go?", "Will you help?", "the Rose Garden"
        if form.lower() in _MONTHS and (next_word[:1].isdigit() or prev_word in _MONTH_PREPS):
            return False  # "May 5", "in May"
        return True

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
        m = _PRECEDING_NAMES.search(text, max(0, start - 60), start)
        if not m:
            return None
        begin = None
        for t in reversed(list(_TOKEN.finditer(text, m.start(1), start))):
            word = t.group()
            if _is_common(word) or word.lower() in _TITLE_WORDS or _norm(word) in self.forms:
                break
            begin = t.start()
        return begin

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
    return _hits(_resolve(_index(roster).cands(text), _tag_spans(text)))


def _extra_name_cands(text: str, names: Iterable[str], roster: Any) -> list[_Cand]:
    """Names from the local model's second pass that the roster does not already cover."""
    idx = _index(roster) if roster is not None else None
    out: list[_Cand] = []
    for raw in names:
        name = " ".join(str(raw or "").split())
        if len(_norm(name)) < 2 or not name[:1].isupper() or _is_common(name):
            continue
        if idx is not None and all(_norm(t) in idx.forms for t in name.split()):
            continue  # the roster pass tags it with the right student
        pattern = re.compile(r"(?<![\w'’])" + _form_pattern(name) + r"(?!\w)", re.IGNORECASE)
        out.extend(
            _Cand("person", m.group(), m.start(), m.end(), _norm(name)) for m in pattern.finditer(text)
        )
    return out


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


class TagMap:
    """Tag to real value, persistent per device. JSON at `path`, written 0600, never sent anywhere.

    Students get [Student A], [Student B], ... in a shuffled order chosen with a seed that is made
    once per device and stored in the file. The teacher is [Teacher]. Other kinds are numbered per
    kind ([Phone 1], [Email 1], [Person 1], ...). The same real value always gets the same tag.
    `path=None` keeps the map in memory (tests).
    """

    VERSION = 1

    def __init__(self, path: str | Path | None = None, *, seed: int | str | None = None):
        self.path = Path(path).expanduser() if path is not None else None
        self._lock = threading.RLock()
        self._entries: dict[str, tuple[str, str, str]] = {}  # tag -> (kind, key, value)
        self._by_key: dict[tuple[str, str], str] = {}
        self._counters: dict[str, int] = {}
        self._next_letter = 0
        self._version = 0
        self._value_index: tuple[int, re.Pattern[str] | None, dict[str, str]] | None = None
        if self.path is not None and self.path.exists():
            self._load()
            self._dirty = False
        else:
            self._seed = str(seed) if seed is not None else secrets.token_hex(8)
            self._dirty = self.path is not None

    @classmethod
    def load(cls, path: str | Path, *, seed: int | str | None = None) -> TagMap:
        return cls(path, seed=seed)

    @classmethod
    def for_settings(cls, settings: Any, *, seed: int | str | None = None) -> TagMap:
        return cls(settings.paths.tagmap, seed=seed)

    @property
    def seed(self) -> str:
        return self._seed

    def _load(self) -> None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if data.get("version") != self.VERSION:
                raise ValueError("unknown tag map version")
            self._seed = str(data["seed"])
            self._next_letter = int(data.get("next_letter", 0))
            self._counters = {str(k): int(v) for k, v in (data.get("counters") or {}).items()}
            for e in data.get("entries") or []:
                self._put(str(e["tag"]), str(e["kind"]), str(e["key"]), str(e["value"]))
        except (OSError, ValueError, KeyError, TypeError) as exc:
            # Starting over would hand old tags to new people, so refuse instead.
            raise GuardError("the tag map file is unreadable; fix or remove it before tagging") from exc

    def _put(self, tag: str, kind: str, key: str, value: str) -> None:
        self._entries[tag] = (kind, key, value)
        self._by_key[(kind, key)] = tag
        self._version += 1

    def tag_for(self, kind: str, key: str, value: str | None = None) -> str:
        """The tag for one real value, creating it the first time the value is seen."""
        with self._lock:
            tag = self._by_key.get((kind, key))
            if tag is not None:
                return tag
            value = key if value is None else value
            if kind == "teacher" and "[Teacher]" not in self._entries:
                tag = "[Teacher]"
            elif kind == "student":
                tag = f"[Student {_letters(self._next_letter)}]"
                self._next_letter += 1
            else:
                label_kind = "person" if kind == "teacher" else kind  # a second teacher is a person
                n = self._counters.get(label_kind, 0) + 1
                self._counters[label_kind] = n
                tag = f"[{_LABELS.get(label_kind, 'Person')} {n}]"
            self._put(tag, kind, key, value)
            self._dirty = True
            return tag

    def ensure_roster(self, roster: Any) -> None:
        """Give the teacher [Teacher] and every new student a letter, in this device's shuffled order."""
        with self._lock:
            self.tag_for("teacher", roster.teacher.name, roster.teacher.name)
            new = sorted({s.name for s in roster.students if ("student", s.name) not in self._by_key})
            if not new:
                return
            random.Random(f"{self._seed}:{self._next_letter}").shuffle(new)
            for name in new:
                self.tag_for("student", name, name)

    def get(self, tag: str) -> str | None:
        entry = self._entries.get(tag)
        return entry[2] if entry else None

    def kind_of(self, tag: str) -> str | None:
        entry = self._entries.get(tag)
        return entry[0] if entry else None

    def as_dict(self) -> dict[str, str]:
        with self._lock:
            return {tag: value for tag, (_, _, value) in self._entries.items()}

    def values(self) -> list[str]:
        with self._lock:
            return [value for _, _, value in self._entries.values()]

    def __len__(self) -> int:
        return len(self._entries)

    def __contains__(self, tag: object) -> bool:
        return tag in self._entries

    def save(self) -> None:
        """Write the map atomically with mode 0600."""
        if self.path is None:
            self._dirty = False
            return
        with self._lock:
            payload = {
                "version": self.VERSION,
                "seed": self._seed,
                "next_letter": self._next_letter,
                "counters": self._counters,
                "entries": [
                    {"tag": t, "kind": k, "key": key, "value": v} for t, (k, key, v) in self._entries.items()
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

    def known_index(self) -> tuple[re.Pattern[str] | None, dict[str, str]]:
        """A regex for every real value in the map, and normalized value -> tag."""
        with self._lock:
            if self._value_index is None or self._value_index[0] != self._version:
                regex, lookup = _value_regex(self._entries.items())
                self._value_index = (self._version, regex, lookup)
            return self._value_index[1], self._value_index[2]


def _value_regex(entries: Iterable[tuple[str, tuple[str, str, str]]]) -> tuple[re.Pattern[str] | None, dict]:
    lookup: dict[str, str] = {}
    values: list[str] = []
    for tag, (_, _, value) in entries:
        key = _norm(value)
        if len(key) >= 2 and key not in lookup:
            lookup[key] = tag
            values.append(value)
    if not values:
        return None, lookup
    values.sort(key=len, reverse=True)
    regex = re.compile(r"(?<!\w)(?:" + "|".join(_form_pattern(v) for v in values) + r")(?!\w)", re.IGNORECASE)
    return regex, lookup


def _known_cands(text: str, tagmap: Any) -> list[_Cand]:
    """Every real value already in the tag map: names from the model pass, old identifiers."""
    if tagmap is None:
        return []
    if isinstance(tagmap, TagMap):
        regex, lookup = tagmap.known_index()

        def info(tag: str) -> tuple[str, str]:
            entry = tagmap._entries[tag]
            return entry[0], entry[1]
    else:
        mapping = dict(tagmap.as_dict() if hasattr(tagmap, "as_dict") else tagmap)
        regex, lookup = _value_regex((t, (_kind_of_tag(t), _norm(v), v)) for t, v in mapping.items())

        def info(tag: str) -> tuple[str, str]:
            return _kind_of_tag(tag), _norm(mapping[tag])

    if regex is None:
        return []
    out: list[_Cand] = []
    for m in regex.finditer(text):
        tag = lookup.get(_norm(m.group()))
        if tag is None:
            continue
        kind, key = info(tag)
        out.append(_Cand(kind, m.group(), m.start(), m.end(), key))
    return out


# ------------------------------------------------------------------ tag, restore, leaks


def _scan(text: str, roster: Any, tagmap: Any, extra_names: Iterable[str] = ()) -> list[_Cand]:
    cands = _identifier_cands(text, roster)
    if roster is not None:
        cands += _index(roster).cands(text)
    cands += _known_cands(text, tagmap)
    if extra_names:
        cands += _extra_name_cands(text, extra_names, roster)
    return _resolve(cands, _tag_spans(text))


def tag(
    text: str,
    roster: Any,
    tagmap: TagMap | None,
    llm_names: Callable[[str], list[str]] | None = None,
    never_share: Mapping[str, Iterable[str]] | None = None,
) -> TagResult:
    """Replace identifiers, roster names, model-found names and known values with tags.

    Longest span first, never inside an existing tag, so tagging tagged text changes nothing.
    After each pass the output is scanned again until nothing is found. Hits from the first pass
    carry positions in `text`; hits from a later pass (rare) carry positions in the partly tagged
    text. If `llm_names` raises, the error propagates so the caller holds the result.
    """
    if tagmap is None:
        tagmap = TagMap(None)
    if roster is not None:
        tagmap.ensure_roster(roster)
    extra = [n for n in llm_names(text) if isinstance(n, str)] if llm_names is not None else []
    hits: list[Hit] = []
    used: dict[str, str] = {}
    out = text or ""
    for _ in range(_MAX_PASSES):
        found = _scan(out, roster, tagmap, extra)
        if not found:
            break
        pieces: list[str] = []
        last = 0
        for c in found:
            t = tagmap.tag_for(c.kind, c.key, c.value)
            used[t] = tagmap.get(t) or c.value
            hits.append(Hit(c.kind, c.value, c.start, c.end))
            pieces += [out[last : c.start], t]
            last = c.end
        pieces.append(out[last:])
        out = "".join(pieces)
    else:
        if _scan(out, roster, tagmap, extra):
            tagmap.flush()
            raise GuardError("text still has private values after tagging")
    tagmap.flush()
    topics = blocked_topics(text or "", never_share)
    return TagResult(text=out, tag_map=used, hits=hits, blocked=[_reason(t) for t in topics], topics=topics)


_RESTORE_RE = re.compile(
    r"\[\s*(?P<teacher>teacher)\s*\]"
    r"|(?P<ob>\[\s*)?\b(?P<student>student)\s+(?P<letters>[a-z]{1,3})(?![a-z])(?(ob)\s*\])"
    r"|(?P<ob2>\[\s*)?\b(?P<kind>person|phone|email|ssn|card|code|id|address|dob)\s+(?P<num>\d+)(?!\d)(?(ob2)\s*\])",
    re.IGNORECASE,
)
# After a lowercase "student a" (or "student i"), what shows it is a reference and not the article.
_REFERENCE_AFTER = re.compile(
    r"['’]s\b|\s*[.,;:!?)\]]|\s*$|\s+(?:and|or|is|was|has|had|needs|did|does|wrote|got|scored|earned"
    r"|should|will|can|could|would|might|must|also|then|but)\b"
)


def restore(text: str, tag_map: Mapping[str, str] | TagMap) -> str:
    """Swap tags back to real values. Tolerant of Muse rephrasing: [Student A], Student A,
    student a, Student A's, (Student A). [Student A] and [Student AB] never mix."""
    if not text:
        return text
    mapping = tag_map.as_dict() if hasattr(tag_map, "as_dict") else dict(tag_map or {})
    lookup = {(k if k.startswith("[") else f"[{k}]"): v for k, v in mapping.items()}
    if not lookup:
        return text

    def swap(m: re.Match[str]) -> str:
        if m.group("teacher"):
            canonical = "[Teacher]"
        elif m.group("student"):
            letters = m.group("letters")
            if (
                not m.group("ob")
                and letters.islower()
                and letters in ("a", "i")
                and not _REFERENCE_AFTER.match(m.string, m.end())
            ):
                return m.group(0)  # "give every student a chance"
            canonical = f"[Student {letters.upper()}]"
        else:
            word = m.group("kind")
            if not m.group("ob2") and not word[:1].isupper():
                return m.group(0)  # "error code 1" stays as written
            canonical = f"[{_LABELS[_KIND_BY_LABEL[word.lower()]]} {m.group('num')}]"
        value = lookup.get(canonical)
        return value if value is not None else m.group(0)

    return _RESTORE_RE.sub(swap, text)


def leaks(text: str, roster: Any, tagmap: Any) -> list[Hit]:
    """Everything in `text` that is a roster name, nickname, real value in the tag map, or an
    identifier. Tags themselves are never reported. Used by egress and the eval."""
    if not text:
        return []
    return _hits(_scan(text, roster, tagmap))


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
        pattern = re.compile(rf"(?<!\w){body}(?:s|es)?(?!\w)", re.IGNORECASE)
        _KEYWORD_CACHE[keyword] = pattern
    return pattern


def blocked_topics(text: str, never_share: Mapping[str, Iterable[str]] | None) -> list[str]:
    """Topic names from `never_share` whose keywords appear in text (case-insensitive, whole words)."""
    if not text or not never_share:
        return []
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
