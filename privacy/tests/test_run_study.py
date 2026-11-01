"""scripts/run_study.py: the plan's 24 runs, its order, resuming and its stop rule. Nothing runs."""

from __future__ import annotations

import json

from scripts import run_study as rs
from scripts import study_summary


def fake(study_rows=None, codes=None):
    """An execute that writes a nights.csv, or fails, per run, and records what it was asked."""
    calls = []

    def execute(run, folder):
        calls.append(folder.name if folder.name.endswith("rerun") else run.id)
        code = (codes or {}).get(run.id, 0)
        if code:
            codes[run.id] = 0  # the re-run works
            return code
        folder.mkdir(parents=True)
        (folder / "nights.csv").write_text("night,leaks,day_leaks\n" + ((study_rows or {}).get(run.id) or "1,0,0\n"))
        return 0

    return execute, calls


def test_the_plan_has_24_runs_in_order_and_matches_the_summary():
    runs = rs.planned()
    assert len(runs) == 24 == len({r.id for r in runs})
    assert [r.persona for r in runs[:8]] == [*rs.PERSONAS, rs.NOFIX]
    assert [r.seed for r in runs[:8]] == [101, 102, 103, 104, 105, 106, 107, 101]
    assert runs[8] == rs.Run("strict_teacher", 1101) and runs[-1] == rs.Run(rs.NOFIX, 2101)
    assert rs.PERSONAS == study_summary.PLANNED and rs.NOFIX == study_summary.NOFIX
    assert (rs.NIGHTS, rs.PER_DAY, rs.SEED_STEPS) == (study_summary.NIGHTS, study_summary.PER_DAY, study_summary.SEED_STEPS)


def test_the_ablation_runs_the_strict_teachers_files_with_the_fixes_off(tmp_path):
    run = rs.Run(rs.NOFIX, 101)
    cmd = rs.command(run, tmp_path / "out", tmp_path / "home")
    assert "eval/personas/strict_teacher/persona.yaml" in cmd and cmd[cmd.index("--seed") + 1] == "101"
    assert rs.env_for(run, {"A": "1"}) == {"A": "1", "ROUTER_LOOSEN": "none"}
    assert "ROUTER_LOOSEN" not in rs.env_for(rs.Run("strict_teacher", 101), {})


def test_a_second_start_runs_only_what_is_left(tmp_path):
    execute, calls = fake()
    runs = rs.planned()[:3]
    rs.run_study(tmp_path, execute, runs[:2])
    assert len(calls) == 2
    calls.clear()
    lines = rs.run_study(tmp_path, execute, runs)
    assert calls == [runs[2].id]
    assert lines[0].endswith("done before") and lines[2].endswith("done")


def test_a_leak_keeps_the_files_and_stops_that_persona_only(tmp_path):
    a, b, c = rs.Run("tired_teacher", 104), rs.Run("clinic_coordinator", 106), rs.Run("tired_teacher", 1104)
    execute, calls = fake({a.id: "1,0,1\n"})
    lines = rs.run_study(tmp_path, execute, [a, b, c])
    assert calls == [a.id, b.id]
    assert lines[0].endswith("leak") and lines[1].endswith("done") and "not started" in lines[2]
    assert not (tmp_path / "tired_teacher" / "seed-104" / "stopped.md").exists()
    assert "not started" in rs.run_study(tmp_path, execute, [a, b, c])[2]  # also after a restart


def test_a_run_that_dies_gets_a_stop_note_and_one_re_run(tmp_path):
    run = rs.Run("strict_teacher", 101)
    execute, calls = fake(codes={run.id: 1})
    lines = rs.run_study(tmp_path, execute, [run])
    assert calls == [run.id, "seed-101-rerun"] and lines == [f"{run.id}: re-run: done"]
    note = (tmp_path / "strict_teacher" / "seed-101" / "stopped.md").read_text()
    assert "simulated" in note and "model errors" in note
    assert study_summary.stop_cause(" ".join(note.split())) == "model errors"
    calls.clear()
    rs.run_study(tmp_path, execute, [run])
    assert calls == []


def test_a_try_cut_off_with_the_runner_is_reported_not_silently_run_again(tmp_path):
    run = rs.Run("strict_teacher", 101)
    (tmp_path / "strict_teacher" / "seed-101" / "raw").mkdir(parents=True)  # the laptop stopped mid-run
    execute, calls = fake()
    lines = rs.run_study(tmp_path, execute, [run])
    assert calls == ["seed-101-rerun"] and lines == [f"{run.id}: re-run: done"]
    assert (tmp_path / "strict_teacher" / "seed-101" / "stopped.md").is_file()


def test_two_bad_nights_in_a_row_stop_a_run_and_one_does_not(tmp_path):
    assert rs.two_bad_nights({1: 0.5, 2: 0.0, 3: 0.5}) is None
    assert rs.two_bad_nights({1: 0.0, 2: 0.2, 3: 0.2}) == 3
    raw = tmp_path / "raw" / "nights"
    raw.mkdir(parents=True)
    (raw / "night-1-current.jsonl").write_text(json.dumps({"fallback": True}) + "\n" + json.dumps({}) + "\n")
    (raw / "unseen-night-0.jsonl").write_text("this file is never opened\n")
    assert rs.unscored_shares(tmp_path) == {1: 0.5}
