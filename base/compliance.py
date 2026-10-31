"""The privacy toggles on the Controls and Setup pages: FERPA, HIPAA, GDPR, CUI and others.

A toggle makes the device stricter: more kinds of detail are tagged (guard.Redaction.extra_kinds),
the user's opt-outs and Always approve are ignored, and some results are held. A local_only toggle
keeps every result on the device, because tagging doesn't help when the content is what's
restricted. Several can be on and the strictest rule wins. A toggle does not make anyone compliant: no page may say so. Each
profile's `limit` says what it can't do. See docs/COMPLIANCE_PLAN.md and docs/CONTRACTS.md.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from base.types import Decision

SMALL_GROUP_MIN = 10  # our default, not a number from any law
DEFAULT_RETENTION_DAYS = 90  # our default for the COPPA toggle, written down in docs/RETENTION.md
_ALL_DETAIL = frozenset({"place", "date", "detail", "record", "url", "ip"})
_SCAN_SUFFIXES = (".png", ".jpg", ".jpeg")


@dataclass(frozen=True)
class Profile:
    key: str
    label: str
    group: str
    does: str
    limit: str
    kinds: frozenset[str] = _ALL_DETAIL
    retention_days: int | None = None
    local_only: bool = False  # nothing goes to Muse: tagging doesn't help when the content is restricted
    ask_all: bool = False  # the user sees every result that would go to Muse
    keep_words: tuple[str, ...] = ()  # a result with one of these stays on the device
    ask_words: tuple[str, ...] = ()  # a result with one of these waits for the user


_TAGS_MORE = "Tags places, dates, organizations, record numbers and links, and keeps results about fewer than 10 people."
_LOCAL = "Nothing goes to Muse, not even tagged text. Ask questions on the Ask on this device page."

_PROFILES = (
    Profile(
        "ferpa", "FERPA", "Students and children",
        f"For student records. {_TAGS_MORE}",
        "Your school decides whether Muse may be used at all. This sends de-identified results only and does not make Meta a school official.",
    ),
    Profile(
        "coppa", "COPPA", "Students and children",
        f"For data about children under 13. {_TAGS_MORE} Deletes old results on this device after 90 days.",
        "Children still cannot use Muse: Meta's terms set a minimum age of 13.",
        retention_days=DEFAULT_RETENTION_DAYS,
    ),
    Profile(
        "state_student", "State student privacy laws", "Students and children",
        f"For laws like New York Education Law 2-d and California's SOPIPA. {_TAGS_MORE}",
        "These laws expect contracts with vendors, and California has a bill on AI training. Your district handles those, and no toggle can.",
    ),
    Profile(
        "hipaa", "HIPAA", "Health",
        f"For health information. {_TAGS_MORE} Also tags ages over 89, using the Safe Harbor list as the guide.",
        "There is no BAA with Meta, and removing listed identifiers is not always enough. Muse must not give medical advice.",
        kinds=_ALL_DETAIL | {"age"},
    ),
    Profile(
        "part2", "42 CFR Part 2", "Health",
        f"For substance use treatment records. {_TAGS_MORE} Results that mention substance use stay on the device.",
        "These records usually need the patient's written consent, and word matching can miss things.",
        kinds=_ALL_DETAIL | {"age"},
        keep_words=(
            "substance use", "substance abuse", "alcohol use", "opioid", "methadone", "buprenorphine", "suboxone",
            "naloxone", "detox", "rehab", "addiction", "overdose", "sud counseling",
        ),
    ),
    Profile(
        "glba", "GLBA", "Money",
        f"For customer financial information. {_TAGS_MORE} Results about income, credit or balances wait for your OK.",
        "Financial institutions must oversee service providers by contract, and a toggle can't provide that.",
        ask_words=("income", "credit score", "credit report", "account balance", "loan application", "net worth", "mortgage", "debt"),
    ),
    Profile(
        "pci", "PCI DSS", "Money",
        f"For payment card data. {_TAGS_MORE} Results with card security details stay on the device.",
        "Card numbers are always tagged, but a toggle doesn't put you in or out of PCI scope. Your assessor decides that.",
        keep_words=("cvv", "cvc", "card verification", "security code", "expiration date", "track data", "pin block"),
    ),
    Profile(
        "tax", "Tax preparer rules (IRC 7216)", "Money",
        f"For tax return information. {_TAGS_MORE} Results that mention tax return details stay on the device.",
        "Preparers generally need the taxpayer's written consent first, and breaking this rule can carry penalties. Tagging is not that consent.",
        keep_words=("tax return", "w-2", "1099", "1040", "adjusted gross income", "refund amount", "taxable income"),
    ),
    Profile(
        "legal", "Attorney-client confidentiality", "Work",
        f"For client matters. {_TAGS_MORE} You see every result before it goes, and anything marked privileged stays on the device.",
        "ABA Opinion 512 says lawyers may need a client's informed consent before using AI tools with client information, and a line in an engagement letter isn't enough.",
        ask_all=True,
        keep_words=("privileged", "attorney-client", "attorney client", "work product", "settlement offer"),
    ),
    Profile(
        "hr", "Employee records", "Work",
        f"For HR files. {_TAGS_MORE} Results about pay, performance, leave or discipline wait for your OK.",
        "Employment rules vary by place and contract, and this covers none of them by itself. Your employer decides.",
        ask_words=(
            "salary", "compensation", "performance review", "performance plan", "termination", "disciplinary",
            "background check", "medical leave", "fmla", "accommodation",
        ),
    ),
    Profile(
        "gdpr", "GDPR", "Privacy laws",
        f"For people in the EU and UK. {_TAGS_MORE} Results about health, beliefs, ethnicity and similar stay on the device. Deletes old results after 90 days.",
        "Tagged data is pseudonymised, which generally still counts as personal data. You may still need a legal basis and terms with Meta. 90 days is our default.",
        retention_days=DEFAULT_RETENTION_DAYS,
        keep_words=(
            "religion", "religious", "ethnicity", "ethnic origin", "racial", "political opinion", "trade union",
            "sexual orientation", "sex life", "genetic", "biometric", "diagnosis", "medical condition",
        ),
    ),
    Profile(
        "ccpa", "CCPA and CPRA", "Privacy laws",
        f"For California residents. {_TAGS_MORE} Results with sensitive details wait for your OK.",
        "Tagging alone may not meet California's definition of deidentified. Check with your counsel.",
        ask_words=("precise geolocation", "immigration", "citizenship", "racial", "ethnic origin", "religion", "sexual orientation", "genetic", "biometric"),
    ),
    Profile(
        "cui", "CUI and federal contracts", "Government",
        f"For controlled unclassified information. {_LOCAL}",
        "Under DFARS, a cloud provider handling covered defense information must meet FedRAMP Moderate or equivalent. Muse's terms make no such claim, so ask your security officer before changing this.",
        local_only=True,
    ),
    Profile(
        "cjis", "CJIS", "Government",
        f"For criminal justice information. {_LOCAL}",
        "Contractors with access need the CJIS Security Addendum and personnel screening. Your agency's security officer also decides whether this device may hold the data.",
        local_only=True,
    ),
    Profile(
        "export", "ITAR and EAR", "Government",
        f"For export-controlled technical data. {_LOCAL}",
        "Tagging names doesn't change whether the content is controlled, and Muse reads what it receives, so it isn't end-to-end encrypted. Ask your export compliance officer.",
        local_only=True,
    ),
)
PROFILES = {p.key: p for p in _PROFILES}
GROUPS = tuple(dict.fromkeys(p.group for p in _PROFILES))
NOT_FOR = "Not for classified information, on any setting. Use your agency's approved systems for that."

SMALL_GROUP_REASON = "This describes fewer than 10 people, so it stays on the device under your privacy toggles."
SCAN_REASON = "This was read from an image, and that reading is less reliable, so you decide."
# With SAM_ENABLED=1 the device knows what it covered on a page (base/regions.py). A full-face photo is
# on HIPAA's Safe Harbor list (45 CFR 164.514(b)(2)(i)(Q)) and a photo of a child is in COPPA's
# definition of personal information (16 CFR 312.2); a signature is a mark of who someone is in
# health, legal and HR records. These ask first even though the page was covered before reading.
FACE_TOGGLES = ("hipaa", "coppa")
SIGNATURE_TOGGLES = ("hipaa", "legal", "hr")
FACE_REASON = "This came from a page with a photo of a person, covered on this device before reading, so you decide."
SIGNATURE_REASON = "This came from a page with a signature, covered on this device before reading, so you decide."
LOCAL_ONLY_REASON = "A privacy toggle keeps everything on this device."
KEEP_WORD_REASON = "This has a kind of detail your privacy toggles keep on this device."
ASK_WORD_REASON = "This has a kind of detail your privacy toggles want you to see first."
ASK_ALL_REASON = "A privacy toggle asks you to see every result before it goes."

_PEOPLE = r"(?:students?|kids?|children|child|pupils?|learners?|patients?|people|persons?|families|parents?|individuals?)"
_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9}
_COUNT = r"(?P<n>\d{1,3}|one|two|three|four|five|six|seven|eight|nine)"
# "3 of 24 failed" is a count of people. "scored 3 of 4" or "3 of 20 points" is a score.
_SCORE_BEFORE = re.compile(r"\b(?:scor\w+|got|earned|received|rated|grade\w*|marks?|points?)\s*(?:a\s+|an\s+)?$", re.IGNORECASE)
_GROUP = re.compile(
    rf"\b{_COUNT}\s+(?:(?:of|out of)\s+(?:the\s+)?(?:\d+\s+)?)?(?:\w+\s+)?{_PEOPLE}\b"
    rf"|\b{_COUNT.replace('?P<n>', '?P<m>')}\s+(?:of|out of)\s+(?:the\s+)?(?P<total>\d+)\b(?!\s+(?:points?|marks?|on\b))"
    r"|\bn\s*=\s*(?P<k>\d{1,3})\b"
    rf"|\b(?P<few>a few|a couple of|a handful of|only a few)\s+{_PEOPLE}\b",
    re.IGNORECASE,
)


def clean(profiles: Iterable[str] | None) -> list[str]:
    """The known toggles in `profiles`, in the page's order."""
    wanted = {str(p).lower() for p in profiles or ()}
    return [k for k in PROFILES if k in wanted]


def extra_kinds(profiles: Iterable[str]) -> frozenset[str]:
    out: frozenset[str] = frozenset()
    for key in clean(profiles):
        out |= PROFILES[key].kinds
    return out


def retention_days(profiles: Iterable[str]) -> int | None:
    """The shortest retention any toggle asks for, or None."""
    days = [PROFILES[k].retention_days for k in clean(profiles) if PROFILES[k].retention_days]
    return min(days) if days else None


def describes_small_group(text: str) -> bool:
    for m in _GROUP.finditer(text or ""):
        if m.group("few"):
            return True
        if m.group("m") and (int(m.group("total")) < SMALL_GROUP_MIN or _SCORE_BEFORE.search(text[: m.start()])):
            continue
        value = (m.group("n") or m.group("m") or m.group("k") or "").lower()
        n = _WORDS.get(value, int(value) if value.isdigit() else None)
        if n is not None and 0 < n < SMALL_GROUP_MIN:
            return True
    return False


def _has_word(words: Iterable[str], text: str) -> bool:
    return any(re.search(rf"(?<!\w){re.escape(w)}(?!\w)", text, re.IGNORECASE) for w in words)


def local_only(profiles: Iterable[str]) -> bool:
    return any(PROFILES[k].local_only for k in clean(profiles))


def check(
    text: str, sources: Sequence[str], profiles: Iterable[str], raw: str = "", image_kinds: Mapping[str, int] | None = None
) -> tuple[Decision, str, str] | None:
    """(decision, floor label, reason) when the toggles hold this result, else None. `raw` is the
    untagged text, since a keyword can sit inside a tag. `image_kinds` counts what the SAM sidecar
    covered on the result's source images (face, signature, id_card, barcode)."""
    keys = clean(profiles)
    chosen = [PROFILES[k] for k in keys]
    if not chosen:
        return None
    if any(p.local_only for p in chosen):
        return "refuse", "compliance:local_only", LOCAL_ONLY_REASON
    both = f"{text}\n{raw}"
    if any(_has_word(p.keep_words, both) for p in chosen):
        return "refuse", "compliance:sensitive", KEEP_WORD_REASON
    if describes_small_group(text):
        return "refuse", "compliance:small_group", SMALL_GROUP_REASON
    kinds = image_kinds or {}
    if kinds.get("face") and any(k in FACE_TOGGLES for k in keys):
        return "ask_user", "compliance:face", FACE_REASON
    if kinds.get("signature") and any(k in SIGNATURE_TOGGLES for k in keys):
        return "ask_user", "compliance:signature", SIGNATURE_REASON
    if any(str(s).lower().endswith(_SCAN_SUFFIXES) for s in sources):
        return "ask_user", "compliance:scan", SCAN_REASON
    if any(_has_word(p.ask_words, both) for p in chosen):
        return "ask_user", "compliance:ask_word", ASK_WORD_REASON
    if any(p.ask_all for p in chosen):
        return "ask_user", "compliance:ask_all", ASK_ALL_REASON
    return None
