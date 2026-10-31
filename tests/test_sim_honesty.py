"""Simulated stays labeled simulated: every file under eval/personas and eval/reports/sim says so,
the plan was fixed before any run, and the privacy-officer output is a checklist, not a voice.

Run on the folders as committed, so a study output that forgets its label fails here too."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FOLDERS = (ROOT / "eval" / "personas", ROOT / "eval" / "reports" / "sim")
TEXT = {".md", ".yaml", ".yml", ".jsonl", ".json", ".csv", ".txt"}
# A reviewer's checklist cites rules; it never speaks for a person or gives a verdict.
VOICE = re.compile(r"\b(?:I|I'm|I've|we recommend|my view|compliant|certified|endorse[sd]?|approved by)\b", re.IGNORECASE)


def files(folder: Path) -> list[Path]:
    return sorted(p for p in folder.rglob("*") if p.is_file() and p.name != ".DS_Store") if folder.is_dir() else []


def unlabeled(folder: Path) -> list[str]:
    """Files under `folder` whose bytes never say "simulated" (a chart says it in its metadata)."""
    return [str(p.relative_to(folder)) for p in files(folder) if b"simulated" not in p.read_bytes().lower()]


def em_dashes(folder: Path) -> list[str]:
    return [str(p.relative_to(folder)) for p in files(folder) if p.suffix in TEXT and "\u2014" in p.read_text()]


def test_every_persona_and_sim_report_file_says_simulated():
    assert all(f.is_dir() for f in FOLDERS)
    for folder in FOLDERS:
        assert unlabeled(folder) == [], folder
        assert em_dashes(folder) == [], folder


def test_the_check_catches_a_file_without_the_label(tmp_path):
    (tmp_path / "nights.md").write_text("# Nights\n\nSimulated users, invented items.\n")
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw" / "rows.jsonl").write_text('{"id": "t1", "decision": "refuse"}\n')
    (tmp_path / "note.md").write_text("A note \u2014 with a dash. Simulated.\n")
    assert unlabeled(tmp_path) == ["raw/rows.jsonl"]
    assert em_dashes(tmp_path) == ["note.md"]


def test_the_plan_was_fixed_with_its_metrics_seeds_nights_and_stop_rule():
    plan = (ROOT / "eval" / "reports" / "sim" / "PLAN.md").read_text()
    for heading in ("## The question", "## Personas (7, all invented)", "## Design", "## Metrics, fixed now",
                    "## How results will be read, fixed now", "## Stop rule", "## Commands"):  # fmt: skip
        assert heading in plan, heading
    assert "before any study run" in plan and "Nights: 10 per run" in plan
    assert "Seeds: 3 per persona" in plan and "s + 1000 and s + 2000" in plan
    assert "The change from fixes is the night-0 difference" in plan  # reported apart from learning
    for pid in ("strict_teacher", "relaxed_teacher", "sped_coordinator", "tired_teacher", "privacy_officer",
                "clinic_coordinator", "caseworker_cui"):  # fmt: skip
        assert f"| {pid} |" in plan


def test_privacy_officer_outputs_are_checklists_without_a_voice():
    sim = ROOT / "eval" / "reports" / "sim"
    outputs = [p for p in files(sim) if "privacy_officer" in p.parts or p.name.startswith("privacy_officer")]
    outputs = [p for p in outputs if p.suffix == ".md"]
    for path in outputs:
        text = path.read_text()
        if path.name == "receipts.md":
            assert "## Controls and the rules they relate to" in text
        assert not VOICE.search(text), (path.name, VOICE.search(text).group(0))
        assert '"' not in text.split("## Controls", 1)[-1]  # no quotes put in anyone's mouth
