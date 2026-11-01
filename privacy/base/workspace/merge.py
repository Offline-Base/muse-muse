"""save_on_device: Muse writes with tags, the device fills in the real names and saves. See docs/CONTRACTS.md.

Muse sends items of {for_tag, title, body} written with tags like [Student A]. The device swaps
every tag for its real value. With address_to "guardians" it writes one email draft (.eml) for
each guardian of the item's student on the contact sheet (base/workspace/contacts.py), with
{guardian} replaced by that guardian's name; otherwise one .md note per item. A merge.csv lists
what was written. Everything goes under BASE_HOME/output/<job id>/ (folder 0700, files 0600), and
nothing is read back: Muse gets only counts, through egress.
"""

from __future__ import annotations

import csv
import io
import re
from collections.abc import Callable, Collection, Iterable, Mapping
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr
from pathlib import Path

from base.guard import TAG_RE, TEACHER_TAG, blocked_topics, tag_references
from base.workspace.agent import safe_filename, unique_filename, write_private
from base.workspace.contacts import Contact, by_student, student_key

MAX_ITEMS = 60
MAX_TITLE = 120
MAX_BODY = 6000
ADDRESS_TO = ("none", "guardians")
GUARDIAN = "{guardian}"
LIST_FILE = "merge.csv"
NO_GUARDIAN = "none on file"  # merge.csv's guardian cell for an item no letter was made for
# The request egress sees for a receipt: fixed, so nothing Muse writes can set off a request floor
# on a text that holds only counts.
SAVE_REQUEST = "save files on the device"
STUDENT_TAG = re.compile(r"\[Student [A-Z]{1,3}\]")


class SaveRefused(ValueError):
    """Nothing was saved. The message is a plain sentence for Muse with no private value."""


@dataclass(frozen=True)
class Item:
    title: str
    body: str
    for_tag: str = ""


@dataclass(frozen=True)
class Saved:
    files: int  # drafts or notes written; merge.csv is not counted
    items: int
    students: int  # different students the items were for
    no_guardian: int  # items for a student with no guardian on the sheet: nothing written for them
    drafts: bool  # email drafts for guardians, else notes


def items_from(raw: Iterable) -> list[Item]:
    """Items from the tool's arguments (models or dicts), trimmed."""
    out = []
    for value in raw:
        get = value.get if isinstance(value, Mapping) else lambda k, d="", v=value: getattr(v, k, d)
        out.append(Item(str(get("title", "") or "").strip(), str(get("body", "") or ""), str(get("for_tag", "") or "").strip()))
    return out


def unknown_tags(items: Iterable[Item], known: Collection[str]) -> list[str]:
    """Bracketed tags in the items that the device does not know, each once, in order."""
    seen: list[str] = []
    for item in items:
        for text in (item.for_tag, item.title, item.body):
            for tag in TAG_RE.findall(text):
                if tag not in known and tag not in seen:
                    seen.append(tag)
    return seen


OTHER_TAGS = (
    "A letter home may hold only the tag of the student it is for and [Teacher], so nothing was saved. Take "
    "any other student's tag, and phone, email, address and other tags, out of the title and body."
)
NEVER_SHARE = "A letter home may not mention a topic your privacy policy never shares, so nothing was saved."


def check(
    items: list[Item],
    address_to: str,
    known: Collection[str],
    *,
    restore: Callable[[str], str] | None = None,
    never_share: Mapping[str, Iterable[str]] | None = None,
) -> None:
    """Raise SaveRefused when the items cannot be saved as they are. Nothing is written first.

    A letter home goes to one family, so with address_to "guardians" its title and body may hold
    only the tags of the item's own student (for_tag) and [Teacher]: another student's tag, or a
    phone, email, address or any other tag, would put someone else's real value in the draft. Only
    tags are checked: a name or number Muse wrote out itself goes into the unsent draft as written.
    With `never_share` (the policy's), a letter whose title or body, as Muse wrote it, names a
    never-share topic is refused too. Restored names are not scanned: only names can come from
    the two allowed tags, and a surname such as Street is not a topic."""
    if address_to not in ADDRESS_TO:
        raise SaveRefused('address_to must be "none" or "guardians".')
    if not 1 <= len(items) <= MAX_ITEMS:
        raise SaveRefused(f"Send 1 to {MAX_ITEMS} items.")
    for item in items:
        if not item.title or len(item.title) > MAX_TITLE or len(item.body) > MAX_BODY:
            raise SaveRefused(f"Each item needs a title of 1 to {MAX_TITLE} characters and a body of at most {MAX_BODY}.")
        if address_to == "guardians" and not STUDENT_TAG.fullmatch(item.for_tag):
            raise SaveRefused('With address_to "guardians", give each item for_tag, the [Student X] tag the note is for.')
    unknown = unknown_tags(items, known)
    if unknown:
        shown = ", ".join(unknown[:5]) + (" and more" if len(unknown) > 5 else "")
        raise SaveRefused(
            f"This device does not know {len(unknown)} of the tags in these items ({shown}), so nothing was "
            "saved. Use the tags from the current results."
        )
    if address_to != "guardians":
        return
    for item in items:
        allowed = {item.for_tag, TEACHER_TAG}
        if any(tag not in allowed for text in (item.title, item.body) for tag, _b in tag_references(text)):
            raise SaveRefused(OTHER_TAGS)
        if never_share and blocked_topics(f"{item.title}\n{item.body}", never_share):
            raise SaveRefused(NEVER_SHARE)


def write(
    out_dir: Path,
    items: list[Item],
    address_to: str,
    purpose: str,
    *,
    restore: Callable[[str], str],
    contacts: list[Contact] | None = None,
) -> Saved:
    """Write the files with real names under out_dir. Call check() first."""
    guardians = address_to == "guardians"
    sheet = by_student(contacts or [])
    used: set[str] = set()
    rows: list[list[str]] = []
    no_guardian = 0
    for item in items:
        title, body = restore(item.title), restore(item.body)
        student = restore(item.for_tag) if item.for_tag else ""
        if not guardians:
            name = _place(out_dir, unique_filename(f"{safe_filename(_line(title))}.md", used))
            write_private(out_dir / name, f"# {_line(title)}\n\n{body.rstrip()}\n")
            rows.append([name, item.for_tag, student, "", "", _line(title)])
            continue
        family = sheet.get(student_key(student), [])
        if not family:
            no_guardian += 1
            rows.append(["", item.for_tag, student, NO_GUARDIAN, "", _line(title)])  # the list on the device says so
            continue
        for c in family:
            subject, text = _line(title.replace(GUARDIAN, c.guardian)), body.replace(GUARDIAN, c.guardian)
            name = _place(out_dir, unique_filename(f"{safe_filename(f'{student} to {c.guardian}')}.eml", used))
            write_private(out_dir / name, _draft(c, subject, text))
            rows.append([name, item.for_tag, student, c.guardian, c.email, subject])
    _write_list(out_dir, rows, purpose)
    return Saved(
        files=sum(1 for r in rows if r[0]),
        items=len(items),
        students=len({i.for_tag for i in items if i.for_tag}),
        no_guardian=no_guardian,
        drafts=guardians,
    )


def receipt(saved: Saved, left_as_written: int = 0) -> str:
    """What Muse gets back: the number of items it sent, no name, tag, address or family count.
    `left_as_written` is how many codes Muse wrote without brackets (guard.unbracketed_codes),
    which the files keep as codes, so Muse can send them again.

    For letters home it never says how many letters were made or how many students have no
    guardian on file: one call per student would tell Muse how many parents each tag has, which
    is household and custody structure. Those counts stay in merge.csv on the device.

    Every word is one the guard counts as common English, so its name-shape pass can never take a
    word here for a name (as it can with "Email" or "Guardian" from a table header) and hold the
    receipt for the user's OK.
    """
    done = "The real names were filled in there, and none of them came back to you."
    if left_as_written:
        done += f" {_n(left_as_written, 'code')} came in the wrong form and got no real name. Send each code just as you got it."
    if not saved.drafts:
        return f"Saved {_n(saved.files, 'note')} in your own files. {done}"
    return (
        f"Made letters home from {_n(saved.items, 'note')} in your own files. The list there shows who each one "
        f"is for and any with no parent on file. {done}"
    )


def _n(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


def _line(text: str) -> str:
    return " ".join(text.split())[:200]


def _place(out_dir: Path, name: str) -> str:
    """A file name that stays inside out_dir (safe_filename already drops path separators)."""
    if (out_dir / name).resolve().parent != out_dir.resolve():
        raise SaveRefused("A title could not be used as a file name, so nothing more was saved.")
    return name


def _draft(contact: Contact, subject: str, body: str) -> str:
    """An unsent email draft (X-Unsent: 1) addressed to one guardian."""
    msg = EmailMessage()
    if contact.email:
        msg["To"] = formataddr((contact.guardian, contact.email))
    msg["Subject"] = subject
    msg["X-Unsent"] = "1"
    msg.set_content(body.rstrip() + "\n")
    return msg.as_string()


def _cell(value: str) -> str:
    """A spreadsheet cell that cannot start a formula."""
    return "'" + value if value[:1] in ("=", "+", "-", "@") else value


def _write_list(out_dir: Path, rows: list[list[str]], purpose: str) -> None:
    buf = io.StringIO()
    out = csv.writer(buf)
    out.writerow(["file", "for_tag", "student", "guardian", "email", "title", "purpose"])
    for row in rows:
        out.writerow([_cell(v) for v in [*row, _line(purpose)]])
    write_private(out_dir / LIST_FILE, buf.getvalue())
