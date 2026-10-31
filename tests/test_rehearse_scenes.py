"""The scene rehearsal (scripts/rehearse_scenes.py): its parsing helpers and a full dry run.

The dry run fakes the device model and mocks the network (respx), so nothing leaves the test. It
runs real services on a scratch home over a copy of the invented demo folders.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import respx

from scripts import rehearse_scenes as rs


def test_arguments():
    args = rs.parse_args([])
    assert (args.scene, args.dry_run, args.essays, args.home) == ("ALL", False, 24, None)
    assert rs.parse_args(["--scene", "c", "--dry-run", "--essays", "3"]).scene == "C"
    for bad in (["--scene", "G"], ["--essays", "0"], ["--essays", "25"]):
        with pytest.raises(SystemExit):
            rs.parse_args(bad)


def test_status_of_every_shape_a_tool_answers_with():
    assert rs.status_of(json.dumps({"job_id": "j", "status": "waiting", "result": "x"})) == (
        "waiting", {"job_id": "j", "status": "waiting", "result": "x"},
    )  # fmt: skip
    assert rs.status_of("3 documents in folder essays:\n- [Student A]")[0] == "shared"
    assert rs.status_of("Kept on your device. It mentions a topic you never share.")[0] == "refused"
    assert rs.status_of("Held on your device.")[0] == "refused"
    assert rs.status_of("Waiting for your OK on the device.")[0] == "waiting"
    assert rs.status_of("The device could not use those arguments.", error=True)[0] == "error"
    assert rs.status_of("[1, 2]")[0] == "shared"  # JSON without a status is plain text


def test_lowest_scorers_come_from_the_shared_table():
    table = (
        "| Student | Ideas | Organization | Evidence | Conventions | Total |\n|---|---|---|---|---|---|\n"
        "| [Student C] | 3 | 3 | 3 | 3 | 12 |\n| [Student AB] | 1 | 2 | 1 | 2 | 6 |\n"
        "| Essay 3 | 1 | 1 | 1 | 1 | 4 |\n| [Student D] | 2 | 2 | 2 | 2 | 8 |\n"
    )
    assert rs.lowest_scorers(table) == ["[Student AB]", "[Student D]", "[Student C]"]
    assert rs.lowest_scorers(table, n=1) == ["[Student AB]"] and rs.lowest_scorers("no table") == []


def test_the_command_line_hides_paths():
    shown = rs.shown_command(["--scene", "A", "--home", "/somewhere/private", "--out", "/x"])
    assert shown == "uv run python -m scripts.rehearse_scenes --scene A --home PATH --out PATH"


def test_a_home_with_data_or_the_default_home_is_refused(tmp_path):
    (tmp_path / "base.db").write_text("x")
    with pytest.raises(SystemExit, match="new or empty"):
        rs.scratch_home(tmp_path)
    with pytest.raises(SystemExit, match="new or empty"):
        rs.scratch_home(Path.home() / ".base")
    home, tmp = rs.scratch_home(tmp_path / "new")
    assert home == (tmp_path / "new").resolve() and tmp is None
    home, tmp = rs.scratch_home(None)
    assert home.parent == tmp and tmp.name.startswith("base-rehearsal-")
    tmp.rmdir()


def test_only_invented_markdown_is_copied(tmp_path):
    rs.copy_invented(tmp_path / "w", essays=3)
    root = tmp_path / "w"
    assert (root / ".synthetic").is_file() and (root / "rubric.md").is_file()
    assert len(list((root / "essays").glob("*.md"))) == 3
    assert len(list((root / "casework").glob("*.md"))) == 6 and (root / "records" / "parent_contacts.md").is_file()
    assert not (root / "forms").exists()
    assert {p.suffix for p in root.rglob("*") if p.is_file()} <= {".md", ""}


def test_the_fake_model_answers_from_the_schema():
    grade = {"type": "object", "properties": {
        "scores": {"type": "object", "properties": {"ideas": {"type": "integer", "minimum": 1, "maximum": 4}}},
        "feedback": {"type": "string"}, "names": {"type": "array", "items": {"type": "string"}},
        "passages": {"type": "array", "items": {"type": "integer"}}, "answer": {"type": "string"},
        "decision": {"type": "string", "enum": ["share_tagged", "refuse"]},
    }}  # fmt: skip
    value = rs._fake_value(grade, "Document: notes\n\nIEP review in May")
    assert 1 <= value["scores"]["ideas"] <= 4 and value["names"] == [] and value["passages"] == [1, 2]
    assert value["answer"] == "notes\n\nIEP review in May" and value["decision"] == "share_tagged"
    reply = rs.fake_chat(None, [{"role": "user", "content": "x"}], json_schema={"name": "n", "schema": grade})
    assert json.loads(reply.content)["feedback"] and rs.fake_chat(None, []).content == "A short summary."


def test_secrets_find_kinds_never_values():
    services = SimpleNamespace(
        roster=SimpleNamespace(people=lambda: [SimpleNamespace(name="Pim Quill", first="Pim", last="Quill", nicknames=())]),
        settings=SimpleNamespace(contacts=Path("/nowhere/contacts.md"), workspace_root=Path("/nowhere")),
        egress=SimpleNamespace(final_check=lambda text: [SimpleNamespace(kind="phone")] if "555-0101" in text else []),
    )
    secrets = rs.Secrets(services)
    assert secrets.kinds("[Student A] did well", "[Student A] did well") == []
    assert secrets.kinds("Pim did well, call 555-0101", "call 555-0101") == ["check:phone", "roster"]
    assert secrets.kinds("case 000-2026-0417", "") == ["casework"]


def test_dry_run_plays_every_scene_with_no_private_value(tmp_path, monkeypatch):
    monkeypatch.setattr(rs, "WAIT", 1)  # Muse's wait_seconds, shortened so the test is quick
    monkeypatch.setattr(rs, "TAP_AFTER", 0.2)
    with respx.mock(assert_all_called=False):  # any real model or network call fails the test
        code = rs.main(["--dry-run", "--essays", "6", "--out", str(tmp_path)])
    [report] = list(tmp_path.glob("rehearsal_dry_*.md"))
    text = report.read_text()
    assert text.startswith("# Scene rehearsal\n\nCommand: `uv run python -m scripts.rehearse_scenes --dry-run --essays 6 --out PATH`")
    assert "- private values in any tool output: 0 of" in text
    for scene in "ACDEF":
        assert f"| {scene} |" in text and f"| {scene} | " in text
    rows = {line.split(" | ")[0].strip("| "): line for line in text.splitlines() if line.startswith("| ") and " | yes |" in line}
    assert set("ACDEF") <= set(rows), text  # B can wait on its list (see the report note)
    [merge_row] = [line for line in text.splitlines() if line.startswith("| B | 6 family notes, one per tag | save_on_device |")]
    got, expected = merge_row.split(" | ")[3:5]
    assert got == expected and expected.startswith("saved ")  # one draft per guardian of those 6 students
    for secret in ("Abigail", "Thornbury", "Quintavalle", "example.org", "555-01"):
        assert secret not in text
    assert code in (0, 1)
