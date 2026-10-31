"""The contact sheet save_on_device reads (base/workspace/contacts.py). All data is invented."""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

import pytest

from base.workspace.contacts import Contact, ContactsError, by_student, load_contacts, student_key

DEMO_SHEET = Path(__file__).resolve().parent.parent / "demo" / "records" / "parent_contacts.md"


def test_demo_sheet_has_27_guardians_for_24_students():
    contacts = load_contacts(DEMO_SHEET)
    assert len(contacts) == 27
    per_student = Counter(c.student for c in contacts)
    assert len(per_student) == 24
    assert sorted(n for n in per_student.values() if n > 1) == [2, 2, 2]  # 3 students have two guardians
    assert all(re.fullmatch(r"[\w.+-]+@example\.(com|org)", c.email) for c in contacts)
    assert contacts[0] == Contact("Abigail Thornbury", "Margaret Thornbury", "mthornbury@example.com")
    family = by_student(contacts)[student_key("  benjamin   ADEYEMI ")]
    assert [c.guardian for c in family] == ["Tunde Adeyemi", "Folake Adeyemi"]


def test_csv_with_other_columns_any_order_and_case(tmp_path):
    sheet = tmp_path / "contacts.csv"
    sheet.write_text(
        "Phone,EMAIL,guardian,Notes,STUDENT\n"
        "555-0101,ada.quill@example.org,Ada Quill,likes mornings,Pim Quill\n"
        "555-0102,not an email,Rob Quill,,Pim Quill\n"
        "555-0103,,,no guardian here,Lo Wren\n"
        "\n"
    )
    contacts = load_contacts(sheet)
    assert contacts == [Contact("Pim Quill", "Ada Quill", "ada.quill@example.org"), Contact("Pim Quill", "Rob Quill", "")]


def test_only_the_first_markdown_table_counts(tmp_path):
    sheet = tmp_path / "sheet.md"
    sheet.write_text(
        "# Contacts\n\n| Student | Guardian | Email |\n|:---|---|---:|\n| Pim Quill | Ada Quill | a@example.org |\n\n"
        "Notes\n\n| Student | Guardian | Email |\n|---|---|---|\n| Lo Wren | Bo Wren | b@example.org |\n"
    )
    assert [c.guardian for c in load_contacts(sheet)] == ["Ada Quill"]


def test_an_email_with_extra_text_is_dropped(tmp_path):
    sheet = tmp_path / "sheet.md"
    sheet.write_text("| Student | Guardian | Email |\n|---|---|---|\n| Pim Quill | Ada Quill | Ada <a@example.org> |\n")
    assert load_contacts(sheet)[0].email == ""


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("No table here.\n", "no table"),
        ("| Student | Phone |\n|---|---|\n| Pim Quill | 555-0101 |\n", "Student, Guardian and Email"),
    ],
)
def test_bad_sheets_say_why(tmp_path, text, message):
    sheet = tmp_path / "sheet.md"
    sheet.write_text(text)
    with pytest.raises(ContactsError, match=message):
        load_contacts(sheet)


def test_a_missing_or_huge_sheet_is_refused(tmp_path):
    with pytest.raises(ContactsError, match="no contact sheet"):
        load_contacts(tmp_path / "missing.md")
    big = tmp_path / "big.md"
    big.write_text("x" * 1_000_001)
    with pytest.raises(ContactsError, match="over 1 MB"):
        load_contacts(big)


def test_contacts_path_setting(tmp_path):
    from base.config import load_settings

    root = tmp_path / "w"
    default = load_settings({"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(root)})
    assert default.contacts_path is None and default.contacts == root.resolve() / "records" / "parent_contacts.md"
    relative = load_settings({"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(root), "CONTACTS_PATH": "office/families.csv"})
    assert relative.contacts == root.resolve() / "office" / "families.csv"
    absolute = load_settings({"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(root), "CONTACTS_PATH": str(tmp_path / "c.md")})
    assert absolute.contacts == tmp_path / "c.md"
