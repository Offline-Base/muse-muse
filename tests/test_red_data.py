"""The red team's invented data (eval/red/): ground truth, the side dossier and the scenarios.

truth.json stays on the device and is only checked against the invented records. Everything a
simulated attacker would be shown (the dossier and every scenario text) must pass base/spark.py's
own check, so it is safe to send to Spark later. No network: only the checker runs.
"""

from __future__ import annotations

import json
import random
import re

import pytest
import yaml

from base import guard
from base.config import REPO_ROOT
from base.spark import Spark

RED = REPO_ROOT / "eval" / "red"
DEMO = REPO_ROOT / "demo"
TRUTH = json.loads((RED / "truth.json").read_text())
DOSSIER = json.loads((RED / "dossier.json").read_text())
SCENARIOS = yaml.safe_load((RED / "scenarios.yaml").read_text())
ROSTER = guard.load_roster(REPO_ROOT / "eval" / "roster.json")
NAMES = [p.name for p in ROSTER.students]
FAMILIES = [f"F{n}" for n in range(1, 12)]
TOOLS = {"list_documents", "search_documents", "ask_device", "run_private_task", "get_result", "dreaming_report"}


def record(attribute: str) -> str:
    return (DEMO / TRUTH["sources"][attribute]).read_text()


def shown_texts() -> list[str]:
    """Every text an attacker could be shown: the system brief, the dossier and each scenario."""
    texts = [SCENARIOS["system"], *(" ".join(facts) for facts in DOSSIER["people"].values())]
    for s in SCENARIOS["scenarios"]:
        texts += [s["family"], s["persona"], s["goal"], s["brief"], s["win"]]
        texts += [p["text"] for p in s.get("planted", [])]
    return texts


def test_truth_covers_every_roster_student_with_every_attribute():
    assert sorted(TRUTH["students"]) == sorted(NAMES)
    for facts in TRUTH["students"].values():
        assert set(facts) == {"reading_group", *TRUTH["protected"]}
    assert set(TRUTH["protected"]) == {"iep", "medical", "discipline", "lunch_status", "custody", "attendance"}


def test_each_protected_attribute_is_in_its_record_file():
    rows = TRUTH["students"].items()
    for attribute, wanted in (
        ("iep", lambda f: f["iep"]),
        ("medical", lambda f: f["medical"]),
        ("discipline", lambda f: f["discipline"]),
        ("lunch_status", lambda f: f["lunch_status"] in ("free", "reduced")),
        ("custody", lambda f: f["custody"]),
        ("attendance", lambda f: f["attendance"]["absences"] or f["attendance"]["tardies"]),
    ):
        text = record(attribute)
        marked = [name for name, facts in rows if wanted(facts)]
        assert marked, attribute
        for name in marked:
            assert name in text, (attribute, name)
    assert {n for n, f in rows if f["iep"] == "IEP"} == {"Gideon Pakalnis", "Quentin Beaumont"}


def test_reading_groups_match_the_record():
    text = record("reading_group")
    for group in ("Redwoods", "Cedars", "Aspens", "Saplings"):
        row = next(line for line in text.splitlines() if line.startswith(f"| {group} "))
        listed = {n.strip() for n in row.split("|")[3].split(",")}
        assert listed == {n for n, f in TRUTH["students"].items() if f["reading_group"] == group}


def test_people_off_the_roster_are_invented_and_in_the_class_files():
    contacts = (DEMO / "records" / "parent_contacts.md").read_text()
    for name in TRUTH["guardians"]:
        assert name in contacts and name not in NAMES
    everything = "\n".join(p.read_text() for p in (*DEMO.joinpath("records").glob("*.md"), *DEMO.joinpath("essays").glob("*.md")))
    for name in TRUTH["other_people"]:
        assert name in everything and name not in NAMES


def test_the_dossier_is_a_seeded_shuffle_and_holds_no_names():
    key = TRUTH["dossier_key"]
    assert list(key) == [f"P{i:02d}" for i in range(1, 25)] == list(DOSSIER["people"])
    assert list(key.values()) == random.Random(TRUTH["dossier_seed"]).sample(NAMES, len(NAMES))
    assert list(key.values()) != NAMES  # not roster order
    for pid, facts in DOSSIER["people"].items():
        assert 2 <= len(facts) <= 3, pid
        student = TRUTH["students"][key[pid]]
        assert f"the {student['reading_group']} reading group" in facts[0]


def test_one_scenario_per_family_with_allowed_tools_only():
    assert SCENARIOS["allowed_tools"] and set(SCENARIOS["allowed_tools"]) == TOOLS
    assert [s["id"] for s in SCENARIOS["scenarios"]] == FAMILIES
    for s in SCENARIOS["scenarios"]:
        assert set(s["tools"]) <= TOOLS and "run_dreaming" not in s["tools"], s["id"]
        assert 1 <= s["turns"] <= 8 and isinstance(s["dossier"], bool)
        for field in ("family", "persona", "goal", "brief", "win"):
            assert s[field].strip(), (s["id"], field)


def test_planted_documents_carry_unique_canaries_and_only_the_two_placeholders():
    planted = next(s for s in SCENARIOS["scenarios"] if s["id"] == "F7")["planted"]
    canaries = [p["canary"] for p in planted]
    assert len(canaries) == len(set(canaries)) >= 5
    for p in planted:
        assert p["canary"] in p["text"] and re.fullmatch(r"[A-Z]+-\d", p["canary"])
        assert set(re.findall(r"\{\{(\w+)\}\}", p["text"])) <= {"STUDENT", "GUARDIAN"}
        assert "{{STUDENT}}" in p["text"]
    assert {p["target"] for p in planted} >= {"name pass", "topic labeler", "router in decide mode", "summary", "ask_device"}


@pytest.mark.parametrize("index", range(len(shown_texts())))
def test_every_attacker_text_passes_sparks_own_check(settings, index):
    """Spark refuses any roster name, nickname or identifier; nothing here may trip it."""
    text = shown_texts()[index]
    assert guard.leaks(text, ROSTER, guard.TagMap(None)) == []
    Spark(settings, ROSTER).check([{"role": "user", "content": text}])  # raises SparkRefused on a hit


def test_red_files_have_no_em_dashes_and_only_test_contacts():
    for path in RED.iterdir():
        if path.suffix not in (".json", ".yaml", ".md"):
            continue
        text = path.read_text()
        assert "—" not in text, path.name
        for phone in re.findall(r"\b\d{3}-\d{4}\b", text):
            assert phone.startswith("555-01"), path.name
        for email in re.findall(r"[\w.+-]+@[\w.-]+", text):
            assert email.endswith(("example.com", "example.org")), path.name


def test_truth_is_marked_local_only():
    assert "never sent" in TRUTH["note"]
