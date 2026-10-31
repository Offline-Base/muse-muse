"""The time model on invented rows only: it reports nothing until the study has run, every figure is
labeled simulated and an assumption, and the author's own timing stays apart."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from scripts import time_model as tm
from tests.sim_rows import night_rows, write_run

ROOT = Path(__file__).resolve().parent.parent
SHIPPED = ROOT / "eval" / "reports" / "sim" / "assumptions.yaml"


def assumptions(**changes) -> dict:
    data = yaml.safe_load(SHIPPED.read_text())
    data.update(changes)
    return data


def write_assumptions(path: Path, data: dict) -> Path:
    path.write_text(yaml.safe_dump(data))
    return path


def run_tool(study: Path, assumptions_path: Path = SHIPPED) -> tuple[int, Path]:
    out = study.parent / "time_model.md"
    return tm.main(["--study", str(study), "--assumptions", str(assumptions_path), "--out", str(out)]), out


def test_the_shipped_assumptions_load_and_say_what_they_are():
    data = tm.load_assumptions(SHIPPED)
    assert data["seconds_per_card"]["values"] == [5, 15, 30]
    assert data["seconds_per_card"]["values"][1] == 15
    assert "assumption" in data["label"] and "simulated" in data["label"]
    assert data["measured_by_author"]["label"] == "measured by the author"
    assert data["measured_by_author"]["clicks"] == 20


def test_every_used_cap_cites_url_title_and_figure_and_an_unverified_one_stays_out():
    caps = tm.load_assumptions(SHIPPED)["caps"]
    edweek = next(c for c in caps if c["id"] == "edweek_admin")
    assert edweek["used"] and edweek["hours_per_week"] == 3 and "3 hours" in edweek["figure"]
    assert edweek["url"].startswith("https://www.edweek.org/") and edweek["title"]
    assert {c["id"] for c in caps} == {"edweek_admin", "mckinsey_automation"}
    for cap in caps:
        if "not verified" in cap["figure"]:
            assert not cap["used"] and cap["hours_per_week"] is None, cap["id"]
        if cap["used"]:
            assert cap["url"].startswith("https://") and cap["title"] and cap["read"], cap["id"]


def test_the_middle_seconds_must_match_the_persona_files(tmp_path):
    bad = assumptions(seconds_per_card={"values": [5, 20, 30], "why": "x"})
    with pytest.raises(tm.AssumptionError, match="persona files say"):
        tm.load_assumptions(write_assumptions(tmp_path / "a.yaml", bad))


@pytest.mark.parametrize(
    "change",
    [
        {"results_per_day": {"values": [10, 30]}},
        {"school_days": {"values": [160, 180, -1]}},
        {"first_and_last_days": 9},
        {"measured_by_author": {"label": "measured", "clicks": 20, "total_seconds": None}},
        {"measured_by_author": {"label": "measured by the author", "clicks": 5, "total_seconds": None}},
        {"measured_by_author": {"label": "measured by the author", "clicks": 20, "total_seconds": "fast"}},
        {"caps": [{"id": "x", "used": True, "figure": "f", "title": "t", "url": "u"}]},
        {"caps": [{"id": "x", "used": False, "figure": "f", "title": "t"}]},
    ],
)
def test_a_malformed_assumption_is_refused(tmp_path, change):
    with pytest.raises(tm.AssumptionError):
        tm.load_assumptions(write_assumptions(tmp_path / "a.yaml", assumptions(**change)))


def test_reports_nothing_until_the_study_has_run(tmp_path, capsys):
    study = tmp_path / "study"
    (study / "smoke" / "strict_teacher").mkdir(parents=True)  # a smoke is not the study
    (study / "smoke" / "nights.csv").write_text("night,unneeded_requests\n1,3\n")
    code, out = run_tool(study)
    assert code == 0 and not out.exists()
    assert "reporting nothing" in capsys.readouterr().out


def test_the_rates_come_from_nights_csv_over_the_first_and_last_days(tmp_path):
    folder = write_run(tmp_path, "strict_teacher", 101, rows=night_rows(10, unneeded=(9, 0)))
    rate = tm.read_rates(folder / "nights.csv", "strict_teacher", 101, 3)
    # invented: 9, 8, 7 unneeded in the first 3 days and 2, 1, 0 in the last 3, with 30 items a day
    assert rate.unneeded_first == pytest.approx(24 / 90)
    assert rate.unneeded_last == pytest.approx(3 / 90)
    assert rate.asks_first == pytest.approx(39 / 90)


def test_the_arithmetic_and_the_cap(tmp_path):
    rate = tm.Rates("strict_teacher", 101, 0.5, 0.1, 0.6, 0.2)
    assert tm.hours(0.4, 15, 30, 180) == pytest.approx(9.0)
    data = assumptions()
    assert tm.cap_hours(data, 180) == pytest.approx(108.0)  # 3 hours a week over 36 five-day weeks
    assert tm.saved(rate, 15, 30, 180, 108.0) == (pytest.approx(9.0), False)
    assert tm.saved(rate, 30000, 30, 180, 108.0) == (108.0, True)
    data["caps"] = [c for c in data["caps"] if c["id"] != "edweek_admin"]
    assert tm.cap_hours(data, 180) is None  # no used limit: none is made up


def test_a_rise_in_asks_stays_negative_and_is_never_floored():
    rate = tm.Rates("strict_teacher", 101, 0.1, 0.5, 0.2, 0.6)
    value, hit = tm.saved(rate, 15, 30, 180, 108.0)
    assert value == pytest.approx(-9.0) and not hit


def test_the_table_has_27_rows_and_every_figure_is_labeled(tmp_path):
    study = tmp_path / "study"
    for seed in (101, 1101, 2101):
        write_run(study, "strict_teacher", seed, rows=night_rows(10))
    code, out = run_tool(study)
    text = out.read_text()
    assert code == 0
    assert "Simulated runs used: 3 of 21 planned." in text
    assert "This does not show that anyone saves this time." in text
    section = text.split("## Hours saved per teacher per school year, 3 x 3 x 3")[1].split(
        "## Seconds per card, measured"
    )[0]
    rows = [line for line in section.splitlines() if re.match(r"\| \d", line)]
    assert len(rows) == 27
    assert len({tuple(r.split("|")[1:4]) for r in rows}) == 27
    for title in ("## Asks per simulated item", "## Hours saved per teacher"):
        part = text.split(title)[1].split("\n## ")[0]
        assert "Simulated and an assumption" in part
        header = next(line for line in part.splitlines() if line.startswith("| ") and "---" not in line)
        figures = header.split("|")[-2:-1] if "Hours" in title else header.split("|")[3:-1]
        for cell in figures:
            assert "simulated" in cell and "assumption" in cell, cell
    assert "—" not in text


def test_the_sources_are_printed_and_the_left_out_figure_says_so(tmp_path):
    study = tmp_path / "study"
    write_run(study, "strict_teacher", 101)
    _, out = run_tool(study)
    text = out.read_text()
    assert "How Teachers Spend Their Time: A Breakdown" in text
    assert (
        "https://www.edweek.org/teaching-learning/how-teachers-spend-their-time-a-breakdown/2022/04" in text
    )
    assert "not verified at the source" in text and "no, left out" in text


def test_the_author_slot_is_empty_until_filled_and_stays_out_of_the_simulated_numbers(tmp_path):
    study = tmp_path / "study"
    write_run(study, "strict_teacher", 101)
    blank = assumptions()
    blank["measured_by_author"]["total_seconds"] = None
    _, out = run_tool(study, write_assumptions(tmp_path / "blank.yaml", blank))
    empty = out.read_text()
    assert "Not done yet." in empty and "| 20 | empty | empty | measured by the author |" in empty
    filled = assumptions()
    filled["measured_by_author"]["total_seconds"] = 64
    _, out = run_tool(study, write_assumptions(tmp_path / "filled.yaml", filled))
    text = out.read_text()
    assert "| 20 | 64 | 3.2 | measured by the author |" in text and "Not done yet." not in text
    hours_table = "## Hours saved per teacher"
    after = "## Seconds per card"
    assert text.split(hours_table)[1].split(after)[0] == empty.split(hours_table)[1].split(after)[0]


def test_a_short_run_gives_no_rate_and_is_named(tmp_path):
    study = tmp_path / "study"
    write_run(study, "strict_teacher", 101, rows=night_rows(4), nights=4)
    write_run(study, "strict_teacher", 1101)
    rates, skipped = tm.read_study(study, 3)
    assert [r.seed for r in rates] == [1101]
    assert skipped == ["strict_teacher seed 101 (without all its nights)"]


def test_a_stopped_run_with_all_its_nights_gives_no_rate_and_is_named(tmp_path):
    study = tmp_path / "study"
    folder = write_run(study, "strict_teacher", 101)
    (folder / "stopped.md").write_text("Stopped (simulated run): night 10. Reason: 1 leak on the holdout.\n")
    write_run(study, "strict_teacher", 1101)
    rates, skipped = tm.read_study(study, 3)
    assert [r.seed for r in rates] == [1101]
    assert skipped == ["strict_teacher seed 101 (stopped)"]
    code, out = run_tool(study)
    assert (
        code == 0
        and "Simulated runs used: 1 of 21 planned. Left out: strict_teacher seed 101 (stopped)."
        in out.read_text()
    )


def test_a_rerun_gives_the_rate_and_the_stopped_try_is_still_named(tmp_path):
    first = write_run(tmp_path, "strict_teacher", 101, rows=night_rows(2), nights=2)
    (first / "stopped.md").write_text(
        "Stopped (simulated run): night 2. Reason: model errors on two nights.\n"
    )
    write_run(tmp_path, "strict_teacher", 101, folder="seed-101-rerun")
    rates, skipped = tm.read_study(tmp_path, 3)
    assert [r.seed for r in rates] == [101]
    assert skipped == ["strict_teacher seed 101 (stopped)"]


def test_a_folder_the_plan_does_not_name_is_named_and_gives_no_rate(tmp_path):
    write_run(tmp_path, "strict_teacher", 101, folder="seed-101-first")
    (tmp_path / "strict_teacher" / "seed-1101").mkdir()
    rates, skipped = tm.read_study(tmp_path, 3)
    assert rates == []
    assert skipped == [
        "strict_teacher seed-101-first (its name is not seed-N or seed-N-rerun)",
        "strict_teacher seed 1101 (no nights.csv)",
    ]


def test_the_fix_ablation_and_unplanned_seeds_are_left_out(tmp_path):
    write_run(tmp_path, "strict_teacher_nofix", 101)
    write_run(tmp_path, "strict_teacher", 999)
    assert tm.read_study(tmp_path, 3) == ([], [])
