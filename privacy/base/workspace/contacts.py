"""The contact sheet save_on_device fills guardian names and emails from. See docs/CONTRACTS.md.

A markdown table or a .csv file with at least the columns Student, Guardian and Email, in any order
and any case; other columns are ignored. It is read on the device only and never sent anywhere.
"""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

MAX_BYTES = 1_000_000
COLUMNS = ("student", "guardian", "email")


class ContactsError(ValueError):
    """The contact sheet is missing, too big or has no Student, Guardian and Email columns."""


@dataclass(frozen=True)
class Contact:
    student: str
    guardian: str
    email: str  # "" when the sheet has no usable email for this guardian


def load_contacts(path: str | Path) -> list[Contact]:
    """Every row with a student and a guardian, in sheet order."""
    path = Path(path)
    try:
        if path.stat().st_size > MAX_BYTES:
            raise ContactsError("The contact sheet is over 1 MB.")
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        raise ContactsError("There is no contact sheet on the device.") from None
    rows = _csv_rows(text) if path.suffix.lower() == ".csv" else _markdown_rows(text)
    return _contacts(rows)


def by_student(contacts: Iterable[Contact]) -> dict[str, list[Contact]]:
    """Contacts grouped by the student's name, matched without case or extra spaces."""
    out: dict[str, list[Contact]] = {}
    for c in contacts:
        out.setdefault(student_key(c.student), []).append(c)
    return out


def student_key(name: str) -> str:
    return " ".join(name.split()).casefold()


def _markdown_rows(text: str) -> list[list[str]]:
    """The cells of the first markdown table, header first, without the |---| line."""
    rows: list[list[str]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            if rows:
                break  # the table ended
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if all(set(c) <= set("-: ") for c in cells):
            continue
        rows.append(cells)
    return rows


def _csv_rows(text: str) -> list[list[str]]:
    return [[c.strip() for c in row] for row in csv.reader(io.StringIO(text)) if any(c.strip() for c in row)]


def _contacts(rows: list[list[str]]) -> list[Contact]:
    if not rows:
        raise ContactsError("The contact sheet has no table.")
    header = [c.casefold() for c in rows[0]]
    if not all(name in header for name in COLUMNS):
        raise ContactsError("The contact sheet needs Student, Guardian and Email columns.")
    at = {name: header.index(name) for name in COLUMNS}
    out = []
    for row in rows[1:]:
        cell = {name: row[i] if i < len(row) else "" for name, i in at.items()}
        student, guardian = " ".join(cell["student"].split()), " ".join(cell["guardian"].split())
        if not (student and guardian):
            continue
        email = cell["email"].strip()
        out.append(Contact(student, guardian, email if _plain_email(email) else ""))
    return out


def _plain_email(value: str) -> bool:
    """One address and nothing else, so it can go in a To: line as it is."""
    name, _, domain = value.partition("@")
    return bool(name and "." in domain) and not any(ch.isspace() or ch in "<>,;\"'()" for ch in value)
