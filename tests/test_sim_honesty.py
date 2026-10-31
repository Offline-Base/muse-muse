"""Simulated stays labeled simulated: every file under eval/personas and eval/reports/sim says so,
the plan was fixed before any run, and the privacy-officer output is a checklist, not a voice.

Run on the folders as committed, so a study output that forgets its label fails here too."""

from __future__ import annotations

import re
import struct
from pathlib import Path
from xml.etree import ElementTree

from matplotlib import rc_context
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.figure import Figure

from scripts import study_summary, time_model
from tests.sim_rows import write_full_study

ROOT = Path(__file__).resolve().parent.parent
FOLDERS = (ROOT / "eval" / "personas", ROOT / "eval" / "reports" / "sim")
TEXT = {".md", ".yaml", ".yml", ".jsonl", ".json", ".csv", ".txt"}
RESULT_FILES = {"summary.md", "time_model.md", "stopped.md", "chart.png", "chart.svg"}
# A reviewer's checklist cites rules; it never speaks for a person or gives a verdict.
VOICE = re.compile(r"\b(?:I|I'm|I've|we recommend|my view|compliant|certified|endorse[sd]?|approved by)\b", re.IGNORECASE)


def files(folder: Path) -> list[Path]:
    return sorted(p for p in folder.rglob("*") if p.is_file() and p.name != ".DS_Store") if folder.is_dir() else []


def unlabeled(folder: Path) -> list[str]:
    """Files under `folder` whose bytes never say "simulated" (a chart says it in its metadata)."""
    return [str(p.relative_to(folder)) for p in files(folder) if b"simulated" not in p.read_bytes().lower()]


def em_dashes(folder: Path) -> list[str]:
    return [str(p.relative_to(folder)) for p in files(folder) if p.suffix in TEXT and "\u2014" in p.read_text()]


def visible_text(path: Path) -> str:
    """What a reader sees in a summary or chart: a markdown file's text, an SVG's <text> elements, and
    for a PNG (whose pixels cannot be read here) its text chunks, from the figure that drew the SVG."""
    if path.suffix == ".svg":
        tree = ElementTree.fromstring(path.read_text())
        return " ".join(el.text or "" for el in tree.iter() if el.tag.endswith("}text") or el.tag.endswith("}tspan"))
    if path.suffix == ".png":
        data, at, chunks = path.read_bytes(), 8, []
        while at < len(data):
            size, kind = struct.unpack(">I4s", data[at : at + 8])
            if kind == b"tEXt":
                chunks.append(data[at + 8 : at + 8 + size].decode("latin-1"))
            at += 12 + size
        return " ".join(chunks)
    return path.read_text()


def results_without_label(folder: Path) -> list[str]:
    """Summaries, time models and charts, at any depth, whose visible text never says "simulated"."""
    return [
        str(p.relative_to(folder)) for p in files(folder)
        if p.name in RESULT_FILES and "simulated" not in visible_text(p).lower()
    ]  # fmt: skip


def test_every_persona_and_sim_report_file_says_simulated():
    assert all(f.is_dir() for f in FOLDERS)
    for folder in FOLDERS:
        assert unlabeled(folder) == [], folder
        assert em_dashes(folder) == [], folder
        assert results_without_label(folder) == [], folder


def test_the_study_summary_and_chart_say_simulated_and_pass_the_checks(tmp_path):
    study = tmp_path / "study"
    write_full_study(study)
    assert study_summary.main(["--study", str(study), "--commit", "abc1234"]) == 0
    for path in (study / "summary.md", study / "chart.png", study / "chart.svg"):
        assert "simulated" in visible_text(path).lower() and "invented" in visible_text(path).lower(), path.name
    assert results_without_label(study) == []
    assert unlabeled(study) == [] and em_dashes(study) == []
    assert not VOICE.search((study / "summary.md").read_text())
    assert not VOICE.search(visible_text(study / "chart.svg"))


def test_the_time_model_says_simulated_and_assumption_and_passes_the_checks(tmp_path):
    study = tmp_path / "study"
    write_full_study(study)
    assert time_model.main(["--study", str(study)]) == 0
    text = (study / "time_model.md").read_text()
    assert all(word in text.lower() for word in ("simulated", "invented", "assumption"))
    assert results_without_label(study) == [] and em_dashes(study) == []
    assert not VOICE.search(text)


def test_a_summary_or_chart_without_the_word_fails(tmp_path):
    (tmp_path / "summary.md").write_text("# Summary\n\nDreaming cut unneeded asks.\n")
    (tmp_path / "nights.md").write_text("# Nights, simulated\n")
    assert results_without_label(tmp_path) == ["summary.md"]
    (tmp_path / "summary.md").write_text("# Summary, simulated users\n")
    assert results_without_label(tmp_path) == []

    fig = Figure()
    FigureCanvasAgg(fig)
    fig.text(0.1, 0.5, "Unneeded asks per night")
    with rc_context({"svg.fonttype": "none"}):
        fig.savefig(tmp_path / "chart.svg")
    fig.savefig(tmp_path / "chart.png")
    assert sorted(results_without_label(tmp_path)) == ["chart.png", "chart.svg"]

    # A label only in the SVG's metadata is not text a reader sees, so it still fails.
    with rc_context({"svg.fonttype": "none"}):
        fig.savefig(tmp_path / "chart.svg", metadata={"Title": "simulated"})
    fig.savefig(tmp_path / "chart.png", metadata={"Description": "simulated"})
    assert results_without_label(tmp_path) == ["chart.svg"]
    fig.text(0.1, 0.2, "Simulated users")
    with rc_context({"svg.fonttype": "none"}):
        fig.savefig(tmp_path / "chart.svg")
    assert results_without_label(tmp_path) == []


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
