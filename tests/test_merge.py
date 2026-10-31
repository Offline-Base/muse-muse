"""save_on_device (base/workspace/merge.py and the connector tool), on real services.

Real Services on a temp BASE_HOME over a copy of the invented demo records, with the device model
faked: guard, egress, the router, the stores and the files are all real. Every name, guardian,
email and phone is invented.
"""

from __future__ import annotations

import email
import email.policy
import json
import shutil
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

from base.config import load_settings
from base.connector import server
from base.controls import Controls, ControlStore
from base.services import Services
from base.workspace import merge
from base.workspace.contacts import load_contacts

DEMO = Path(__file__).resolve().parent.parent / "demo"
NOTE = "Dear {guardian}, [Student X] wrote a strong garden essay. From [Teacher]"


class QuietLlm:
    """The device model, faked: nothing leaves the test."""

    is_cloud = False

    def chat_json(self, *_a, **_k):
        return {"decision": "share_tagged", "reason": "because"}

    def chat(self, *_a, **_k):
        return SimpleNamespace(content="A short summary.")

    def llm_names(self, *_a, **_k):
        return []

    def llm_details(self, *_a, **_k):
        return []

    def request_topics(self, *_a, **_k):
        return []

    def close(self):
        pass


@pytest.fixture
def svc(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    (root / ".synthetic").write_text("invented\n")
    shutil.copytree(DEMO / "records", root / "records")
    env = {"BASE_HOME": str(tmp_path / "home"), "WORKSPACE_ROOT": str(root), "DEVICE_ONLY": "1", "CHECKER_API_KEY": "k"}
    services = Services.create(load_settings(env), light=False, heavy=False, owner=False)
    services.router.llm = services.checker_llm = services.answer_llm = QuietLlm()
    services.tagmap.ensure_roster(services.roster)
    services.tagmap.touch(services.tagmap.as_dict())  # Muse was sent these tags (daily rotation restores only sent tags)
    yield services
    services.close()


def student_tags(services) -> dict[str, str]:
    return {tag: value for tag, value in services.tagmap.as_dict().items() if tag.startswith("[Student ")}


def save(services, items, purpose="notes home to families", address_to="guardians"):
    c = server.Connector(services)
    result = c.call("save_on_device", c.save_on_device, items, purpose, address_to)
    return result, (result.structured_content or {})


def private_values(services) -> list[str]:
    people = list(services.roster.people())
    contacts = load_contacts(services.settings.contacts)
    return [
        *(p.name for p in people), *(p.first for p in people), *(p.last for p in people),
        *(c.guardian for c in contacts), *(c.email for c in contacts),
    ]  # fmt: skip


def test_24_notes_make_27_guardian_drafts_and_only_counts_come_back(svc):
    tags = student_tags(svc)
    assert len(tags) == 24
    items = [{"for_tag": tag, "title": f"About {tag}'s essay", "body": NOTE.replace("[Student X]", tag)} for tag in tags]
    result, body = save(svc, items)
    assert not result.is_error and body["status"] == "saved"
    assert body["result"].startswith("Saved 27 letters home for 24 students in your own files")
    assert svc.approvals.pending() == []  # shared tagged with the demo policy: no approval card
    assert svc.egress.final_check(body["result"]) == []
    for value in private_values(svc):
        assert value not in result.content[0].text, value

    out = svc.settings.paths.output / body["job_id"]
    drafts = sorted(out.glob("*.eml"))
    assert len(drafts) == 27 and (out / merge.LIST_FILE).is_file()
    assert stat.S_IMODE(out.stat().st_mode) == 0o700
    assert all(stat.S_IMODE(p.stat().st_mode) == 0o600 for p in out.iterdir())
    contacts = load_contacts(svc.settings.contacts)
    per_student: dict[str, int] = {}
    for path in drafts:
        msg = email.message_from_string(path.read_text(), policy=email.policy.default)
        assert msg["X-Unsent"] == "1"
        assert msg["To"].rstrip(">").endswith(("@example.com", "@example.org"))
        student = path.stem.split(" to ")[0]
        per_student[student] = per_student.get(student, 0) + 1
        text = msg.get_content()
        assert student in text and "[Student" not in text and "{guardian}" not in text
        assert "Celeste Fairbrook" in text  # [Teacher] restored on the device
        guardian = path.stem.split(" to ")[1]
        assert f"Dear {guardian}," in text and any(c.guardian == guardian and c.email in msg["To"] for c in contacts)
    assert sorted(per_student.values()).count(2) == 3 and set(per_student) == set(tags.values())
    rows = (out / merge.LIST_FILE).read_text().splitlines()
    assert len(rows) == 28 and rows[0].startswith("file,for_tag,student,guardian,email,title,purpose")
    job = svc.jobs.get(body["job_id"])
    assert job["kind"] == "save" and job["instructions"] == merge.SAVE_REQUEST and job["release_status"] == "shared"
    decision = svc.approvals.history(limit=5)[0]
    assert decision["tool"] == "save_on_device" and decision["request"] == merge.SAVE_REQUEST


def test_get_result_resends_the_same_receipt(svc):
    tag = next(iter(student_tags(svc)))
    _, body = save(svc, [{"for_tag": tag, "title": "Note", "body": "Hello {guardian}."}])
    again = server.Connector(svc).get_result(body["job_id"])[0].structured_content
    assert again["status"] == "shared" and again["result"] == body["result"]


def test_notes_without_guardians_stay_inside_the_job_folder(svc):
    tag = next(iter(student_tags(svc)))
    items = [
        {"title": "../../x", "body": f"Plan for {tag}."},
        {"title": "/etc/passwd", "body": "Two."},
        {"for_tag": tag, "title": f"{tag} small group", "body": f"{tag} reads with me on Tuesdays."},
    ]
    result, body = save(svc, items, purpose="my own planning", address_to="none")
    assert body["status"] == "saved" and body["result"].startswith("Saved 3 notes in your own files.")
    out = (svc.settings.paths.output / body["job_id"]).resolve()
    files = sorted(p.name for p in out.iterdir())
    assert len(files) == 4 and merge.LIST_FILE in files
    assert all((out / f).resolve().parent == out for f in files)
    name = student_tags(svc)[tag]
    assert (out / f"{name} small group.md").read_text().startswith(f"# {name} small group\n\n{name} reads")
    assert name not in result.content[0].text


def test_an_unknown_tag_saves_nothing(svc):
    tag = next(iter(student_tags(svc)))
    result, _ = save(svc, [{"for_tag": tag, "title": "Hi", "body": "Hello [Student ZZ] and [Person 9]."}])
    text = result.content[0].text
    assert result.is_error and "does not know 2 of the tags" in text and "[Student ZZ]" in text
    assert "nothing was saved" in text
    assert not svc.settings.paths.output.exists() or not any(svc.settings.paths.output.iterdir())
    assert svc.jobs.list_recent() == []


@pytest.mark.parametrize(
    ("items", "address_to", "message"),
    [
        ([{"title": "Hi", "body": "x"}], "guardians", "give each item for_tag"),
        ([{"for_tag": "[Teacher]", "title": "Hi", "body": "x"}], "guardians", "give each item for_tag"),
        ([{"title": "", "body": "x"}], "none", "title of 1 to 120"),
        ([{"title": "Hi", "body": "x" * 6001}], "none", "at most 6000"),
        ([{"title": "Hi", "body": "x"}] * 61, "none", "1 to 60 items"),
        ([], "none", "1 to 60 items"),
        ([{"title": "Hi", "body": "x"}], "parents", "none"),
    ],
)
def test_items_that_cannot_be_saved_say_why(svc, items, address_to, message):
    result, _ = save(svc, items, address_to=address_to)
    assert result.is_error and message in result.content[0].text
    assert svc.jobs.list_recent() == []


def test_a_purpose_is_required(svc):
    result, _ = save(svc, [{"title": "Hi", "body": "x"}], purpose="  ", address_to="none")
    assert result.is_error and "purpose" in result.content[0].text


def test_a_hidden_records_folder_is_never_read(svc):
    ControlStore(svc.settings.paths.controls).save(Controls(hidden_folders=["records"]))
    tag = next(iter(student_tags(svc)))
    result, _ = save(svc, [{"for_tag": tag, "title": "Hi", "body": "Hello {guardian}."}])
    assert result.is_error and "privacy controls hide" in result.content[0].text
    assert svc.jobs.list_recent() == []
    # A note with no guardians needs no contact list, so it still saves.
    _, body = save(svc, [{"for_tag": tag, "title": "Hi", "body": "Notes."}], address_to="none")
    assert body["status"] == "saved"


def test_a_missing_contact_list_saves_nothing(svc, tmp_path):
    (svc.settings.workspace_root / "records" / "parent_contacts.md").unlink()
    tag = next(iter(student_tags(svc)))
    result, _ = save(svc, [{"for_tag": tag, "title": "Hi", "body": "Hello."}])
    assert result.is_error and "no contact sheet" in result.content[0].text and "Nothing was saved" in result.content[0].text


def test_with_cui_on_the_drafts_are_saved_and_only_a_kept_receipt_comes_back(svc):
    ControlStore(svc.settings.paths.controls).save(Controls(profiles=["cui"]))
    tags = list(student_tags(svc))[:2]
    items = [{"for_tag": t, "title": "Note", "body": "Hello {guardian}."} for t in tags]
    result, body = save(svc, items)
    assert body["status"] == "refused"
    assert f"The full result is saved on the device in output/{body['job_id']}." in body["result"]
    assert body["result"].endswith(server.REFUSED_END) and "Saved" not in body["result"]
    assert svc.egress.final_check(body["result"]) == []
    assert len(list((svc.settings.paths.output / body["job_id"]).glob("*.eml"))) >= 2


def test_a_student_with_no_guardian_on_file_is_counted(svc):
    sheet = svc.settings.workspace_root / "records" / "parent_contacts.md"
    tags = student_tags(svc)
    first_tag, first_name = next(iter(tags.items()))
    lines = [line for line in sheet.read_text().splitlines() if not line.startswith(f"| {first_name} |")]
    sheet.write_text("\n".join(lines) + "\n")
    second = [t for t in tags if t != first_tag][0]
    _, body = save(svc, [{"for_tag": t, "title": "Note", "body": "Hi."} for t in (first_tag, second)])
    assert "for 2 students" in body["result"] and "1 note had no parent on file, so no letter was made for it." in body["result"]


def test_unknown_tags_and_receipts_by_themselves():
    known = {"[Student A]", "[Teacher]"}
    items = merge.items_from([{"for_tag": "[Student A]", "title": "[Teacher] says", "body": "[Student B] [Phone 2] [1] [note]"}])
    assert merge.unknown_tags(items, known) == ["[Student B]", "[Phone 2]"]  # only tag shapes count
    assert merge.receipt(merge.Saved(1, 1, 1, 0, True)).startswith("Saved 1 letter home for 1 student in your own files,")
    assert merge.receipt(merge.Saved(0, 2, 2, 2, True)).count("2 notes had no parent on file, so no letter was made for them.") == 1
    obj = SimpleNamespace(for_tag=" [Student A] ", title=" T ", body="b")
    assert merge.items_from([obj]) == [merge.Item("T", "b", "[Student A]")]


def test_titles_that_start_a_formula_are_quoted_in_the_list(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    merge.write(out, [merge.Item("=1+1", "x")], "none", "@me", restore=lambda t: t)
    rows = (out / merge.LIST_FILE).read_text().splitlines()
    assert rows[1].endswith(",'=1+1,'@me")


def test_receipt_json_shape_is_small(svc):
    tag = next(iter(student_tags(svc)))
    result, body = save(svc, [{"for_tag": tag, "title": "Note", "body": "Hi {guardian}."}])
    assert set(body) == {"job_id", "status", "result"}
    assert json.loads(result.content[0].text) == body


async def test_through_mcp_items_arrive_as_objects_and_bad_arguments_get_the_usage_sentence(svc):
    from mcp import Client

    guardians = [c.student for c in load_contacts(svc.settings.contacts)]
    # tags are shuffled each day, so pick a student with one guardian on file
    tag = next(t for t, name in student_tags(svc).items() if guardians.count(name) == 1)
    mcp_server = server.build_server(svc)
    async with Client(mcp_server) as c:
        ok = await c.call_tool(
            "save_on_device",
            {"items": [{"for_tag": tag, "title": "Note", "body": "Hi {guardian}."}], "purpose": "notes home", "address_to": "guardians"},
        )
        missing = await c.call_tool("save_on_device", {"items": [{"title": "Note"}]})
        odd = await c.call_tool("save_on_device", {"items": [], "purpose": "x", "address_to": "everyone"})
    assert ok.structured_content["status"] == "saved" and "Saved 1 letter home" in ok.structured_content["result"]
    for bad in (missing, odd):
        assert bad.is_error and bad.content[0].text == f"The device could not use those arguments. {server.USAGE['save_on_device']}"


def test_every_receipt_word_is_common_english_to_the_guard():
    import re

    from base import guard

    shapes = [merge.Saved(27, 24, 24, 0, True), merge.Saved(25, 24, 23, 1, True), merge.Saved(2, 3, 3, 2, True),
              merge.Saved(1, 1, 0, 0, False), merge.Saved(3, 3, 1, 0, False)]  # fmt: skip
    for shape in shapes:
        words = re.findall(r"[A-Za-z]+", merge.receipt(shape))
        assert [w for w in words if not guard._is_common(w)] == [], shape


def test_header_words_the_guard_took_for_names_do_not_hold_the_receipt(svc):
    # Found by the scene rehearsal: after a search showed the contact sheet, the device-only
    # name-shape pass had stored the table headers "Guardian" and "Email" as names, and a receipt
    # that used those words waited for an OK.
    for word in ("Guardian", "Email", "Relationship", "Opinion"):
        svc.tagmap.tag_for("person", word.lower(), word)
    tag = next(iter(student_tags(svc)))
    _, body = save(svc, [{"for_tag": tag, "title": "Note", "body": "Hi {guardian}."}])
    assert body["status"] == "saved" and svc.approvals.pending() == []
