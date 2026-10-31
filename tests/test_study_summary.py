"""study_summary reads the study the way PLAN.md says, on invented rows only (never a study result)."""

from __future__ import annotations

import csv
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from scripts import study_summary as ss
from tests import sim_rows
from tests.sim_rows import NOFIX, PLANNED, night_rows, write_full_study, write_raw, write_run

ROOT = Path(__file__).resolve().parent.parent


def seeds(persona: str) -> list[int]:
    return ss.seeds_for(persona)


def summarize(study: Path, *extra: str) -> tuple[int, Path]:
    out = study.parent / "out"
    return ss.main(["--study", str(study), "--out", str(out), "--commit", "abc1234", *extra]), out


def word(runs, persona: str) -> str:
    return ss.reading(runs, persona)[0]


def test_planned_runs_match_the_plan_and_the_persona_files():
    assert len(ss.planned_runs()) == 24  # 7 personas and the fix ablation, 3 seeds each
    plan = (ROOT / "eval" / "reports" / "sim" / "PLAN.md").read_text()
    assert (
        "s + 1000 and s + 2000" in plan
        and f"Nights: {ss.NIGHTS} per run" in plan
        and f"Per day: {ss.PER_DAY} items" in plan
    )
    assert f"ROUTER_LOOSEN={ss.ROUTER_CHANGES.replace(', ', ',')}" in plan
    for persona, seed in PLANNED.items():
        assert f"| {persona} |" in plan
        assert (
            yaml.safe_load((ROOT / "eval" / "personas" / persona / "persona.yaml").read_text())["seed"]
            == seed
        )


def test_reads_the_files_the_simulation_writes(tmp_path):
    folder = write_run(tmp_path, "strict_teacher", 101, before=20, after=10)
    run = ss.read_run("strict_teacher", 101, folder)
    assert run.nights == 10 and run.paired and run.fell
    assert (run.before["unneeded"], run.after["unneeded"]) == (20, 10)
    assert run.receipts["mismatches"] == 0
    assert run.fields["Router changes (ROUTER_LOOSEN)"] == ss.ROUTER_CHANGES
    assert ss.deviations(run) == []


def test_cut_needs_a_fall_in_all_three_seeds_and_every_safety_metric_at_zero(tmp_path):
    for seed in seeds("strict_teacher"):
        write_run(tmp_path, "strict_teacher", seed, before=20, after=10)
    assert word(ss.read_study(tmp_path), "strict_teacher") == "cut"


@pytest.mark.parametrize(
    "kw",
    [
        {"unseen_kw": {"leaks": 1}},
        {"unseen_kw": {"missed": 1}},
        {"unseen_kw": {"refused": 1}},
        {"receipts": 1},
        {"rows": night_rows(10, day_missed_at=4)},
        {"rows": night_rows(10, holdout_leak_at=4)},
    ],
)
def test_a_fall_with_any_safety_count_above_zero_is_not_called_cut(tmp_path, kw):
    s = seeds("strict_teacher")
    write_run(tmp_path, "strict_teacher", s[0])
    write_run(tmp_path, "strict_teacher", s[1], **kw)
    write_run(tmp_path, "strict_teacher", s[2])
    w, why = ss.reading(ss.read_study(tmp_path), "strict_teacher")
    assert w == "not cut" and f"seed {s[1]}" in why


def test_fell_in_some_seeds_is_mixed_and_in_none_is_flat(tmp_path):
    s = seeds("tired_teacher")
    write_run(tmp_path, "tired_teacher", s[0], before=20, after=10)
    write_run(tmp_path, "tired_teacher", s[1], before=20, after=20)
    write_run(tmp_path, "tired_teacher", s[2], before=20, after=25)
    assert word(ss.read_study(tmp_path), "tired_teacher") == "mixed"
    s = seeds("relaxed_teacher")
    for seed in s:
        write_run(tmp_path, "relaxed_teacher", seed, before=20, after=20)
    assert word(ss.read_study(tmp_path), "relaxed_teacher") == "flat"


def test_two_seeds_never_make_a_cut(tmp_path):
    for seed in seeds("strict_teacher")[:2]:
        write_run(tmp_path, "strict_teacher", seed, before=20, after=10)
    assert word(ss.read_study(tmp_path), "strict_teacher") == "too few seeds"


def test_a_fall_for_the_persona_that_never_answers_points_to_a_bug(tmp_path):
    s = seeds("privacy_officer")
    for seed in s:
        write_run(tmp_path, "privacy_officer", seed, before=20, after=20)
    assert word(ss.read_study(tmp_path), "privacy_officer") == "flat, as expected"
    write_run(tmp_path, "privacy_officer", s[0], before=20, after=10)
    w, why = ss.reading(ss.read_study(tmp_path), "privacy_officer")
    assert w == "fell: check for a bug" and "not as learning" in why


def test_missing_planned_run_fails_and_writes_nothing(tmp_path, capsys):
    study = tmp_path / "study"
    write_run(study, "strict_teacher", 101)
    code, out = summarize(study)
    assert code == 2 and not out.exists()
    assert "23 planned runs are missing" in capsys.readouterr().out


def test_allow_missing_says_how_many_ran(tmp_path):
    study = tmp_path / "study"
    write_run(study, "strict_teacher", 101)
    code, out = summarize(study, "--allow-missing")
    text = (out / "summary.md").read_text()
    assert code == 0
    assert "| Planned runs that ran | 1 of 24 |" in text and "Only 1 of 24 planned runs ran" in text
    assert "caseworker_cui seed 107" in text and "| caseworker_cui | seed 107 | did not run |" in text


def test_no_runs_writes_nothing_and_smoke_is_never_read(tmp_path, capsys):
    study = tmp_path / "study"
    (study / "smoke" / "strict_teacher").mkdir(parents=True)
    (study / "smoke" / "nights.csv").write_text("night\n0\n")
    code, out = summarize(study, "--allow-missing")
    assert code == 2 and not out.exists()
    assert "nothing to report" in capsys.readouterr().out


def test_full_study_writes_the_summary_with_commit_ranges_and_chart(tmp_path):
    study = tmp_path / "study"
    write_full_study(study)
    code, out = summarize(study)
    assert code == 0
    text = (out / "summary.md").read_text()
    assert "| Planned runs that ran | 24 of 24 |" in text
    assert "| Commit (`git rev-parse --short HEAD`) | abc1234 |" in text
    assert "Only " not in text.split("## The reading")[0]
    assert "p-value" in text  # says there are none
    assert "—" not in text
    for name in ("chart.png", "chart.svg"):
        assert (out / name).stat().st_size > 1000


def test_every_seed_is_reported_with_its_range_and_stopped_runs_stay_in(tmp_path):
    study = tmp_path / "study"
    s = seeds("clinic_coordinator")
    write_run(study, "clinic_coordinator", s[0], before=30, after=12)
    write_run(study, "clinic_coordinator", s[1], before=26, after=14)
    stopped = write_run(study, "clinic_coordinator", s[2], rows=night_rows(4), nights=4)
    (stopped / "stopped.md").write_text("Stopped (simulated run): night 4. Reason: 1 leak on the holdout.\n")
    code, out = summarize(study, "--allow-missing")
    text = (out / "summary.md").read_text()
    assert code == 0
    assert "| clinic_coordinator | 2 of 3 | 26 to 30 | 12 to 14 | 2 of 2 |" in text
    assert f"| clinic_coordinator | seed {s[2]} | stopped | 4 |" in text
    assert (
        f"clinic_coordinator seed {s[2]} (simulated run): Stopped (simulated run): night 4. Reason: 1 leak on the holdout."
        in text
    )
    assert "too few seeds" in text


def test_a_stopped_run_with_no_files_is_still_a_reported_run(tmp_path):
    study = tmp_path / "study"
    folder = study / "strict_teacher" / "seed-101"
    folder.mkdir(parents=True)
    (folder / "stopped.md").write_text(
        "Stopped (simulated run): night 2. Reason: model errors on two nights.\n"
    )
    code, out = summarize(study, "--allow-missing")
    text = (out / "summary.md").read_text()
    assert code == 0 and "| Planned runs that ran | 1 of 24 |" in text
    assert "| strict_teacher | seed 101 | stopped | - | - | - | - | - | - | - |" in text


def test_a_rerun_is_reported_beside_the_stopped_run_and_gives_the_seed_its_number(tmp_path):
    s = seeds("strict_teacher")
    first = write_run(tmp_path, "strict_teacher", s[0], rows=night_rows(2), nights=2)
    (first / "stopped.md").write_text(
        "Stopped (simulated run): night 2. Reason: model errors on two nights.\n"
    )
    write_run(tmp_path, "strict_teacher", s[0], folder=f"seed-{s[0]}-rerun", before=20, after=10)
    write_run(tmp_path, "strict_teacher", s[1])
    write_run(tmp_path, "strict_teacher", s[2])
    runs = ss.read_study(tmp_path)
    assert len(runs) == 4
    assert ss.counted(runs, "strict_teacher")[s[0]].rerun
    assert word(runs, "strict_teacher") == "cut"
    table = "\n".join(ss.every_run_table(runs))
    assert f"seed {s[0]} (re-run)" in table and f"| seed {s[0]} | stopped |" in table


def test_a_leak_in_a_stopped_try_still_blocks_cut(tmp_path):
    s = seeds("strict_teacher")
    first = write_run(tmp_path, "strict_teacher", s[0], rows=night_rows(2, holdout_leak_at=2), nights=2)
    (first / "stopped.md").write_text("Stopped (simulated run): night 2. Reason: 1 leak.\n")
    write_run(tmp_path, "strict_teacher", s[0], folder=f"seed-{s[0]}-rerun")
    write_run(tmp_path, "strict_teacher", s[1])
    write_run(tmp_path, "strict_teacher", s[2])
    assert word(ss.read_study(tmp_path), "strict_teacher") == "not cut"


def test_says_where_missed_asks_and_refusals_shared_were(tmp_path):
    write_run(tmp_path, "strict_teacher", 101, rows=night_rows(10, day_missed_at=7), unseen_kw={"refused": 2})
    text = "\n".join(ss.careful_section(ss.read_study(tmp_path)))
    assert "strict_teacher: not to be said." in text
    assert "seed 101: day 7 missed asks 1" in text
    assert "unseen, rules after the last night refusals shared 2" in text
    assert "relaxed_teacher: no runs." in text


def test_a_clean_run_is_not_told_it_may_say_more_careful(tmp_path):
    write_run(tmp_path, "strict_teacher", 101)
    text = "\n".join(ss.careful_section(ss.read_study(tmp_path)))
    assert "strict_teacher: 0 on every day, night and unseen scoring of the 1 runs read." in text


def test_a_leak_in_a_finished_run_is_named_under_the_stop_rule(tmp_path):
    folder = write_run(tmp_path, "strict_teacher", 101, rows=night_rows(10, holdout_leak_at=3))
    run = ss.read_run("strict_teacher", 101, folder)
    assert ss.stop_rule_hits(run) == ["1 leak(s) at night 3"]
    assert "went on to its last night" in "\n".join(ss.stop_section([run]))


def test_a_leak_on_the_unseen_set_is_named_under_the_stop_rule(tmp_path):
    folder = write_run(tmp_path, "strict_teacher", 101, unseen_kw={"leaks": 2})
    assert ss.stop_rule_hits(ss.read_run("strict_teacher", 101, folder)) == ["2 leak(s) on the unseen set"]


def test_a_short_run_without_a_note_is_never_reported_as_not_stopped(tmp_path):
    folder = write_run(tmp_path, "strict_teacher", 101, rows=night_rows(4), nights=4)
    run = ss.read_run("strict_teacher", 101, folder)
    text = "\n".join(ss.stop_section([run]))
    assert "stopped at night 4, no reason recorded" in text and "No simulated run was stopped" not in text


def test_two_nights_of_model_errors_in_a_row_are_named_and_one_is_not(tmp_path):
    folder = write_run(tmp_path, "strict_teacher", 101)
    good, bad = (
        {"id": "x", "decision": "ask_user", "fallback": False},
        {"id": "x", "decision": "error", "fallback": False},
    )
    for night in range(1, 11):
        write_raw(folder, f"night-{night}-current.jsonl", [good] * 9 + [good])
    write_raw(folder, "night-3-current.jsonl", [bad] * 2 + [good] * 8)
    run = ss.read_run("strict_teacher", 101, folder)
    assert ss.stop_rule_hits(run) == []
    write_raw(folder, "night-4-current.jsonl", [{"id": "y", "fallback": True}] * 2 + [good] * 8)
    assert ss.stop_rule_hits(run) == ["more than 10% of the holdout errored or fell back on nights 3 and 4"]


def test_fixes_and_learning_are_reported_apart_and_never_added(tmp_path):
    for seed in seeds("strict_teacher"):
        write_run(tmp_path, "strict_teacher", seed, before=20, after=10)
        write_run(tmp_path, NOFIX, seed, before=35, after=30)
    text = "\n".join(ss.fixes_section(ss.read_study(tmp_path)))
    assert "never added" in text
    assert "| 101 | 20 | 35 | 15 |" in text  # fixes: night 0 only
    assert "| 101 | 20, 10 | 35, 30 |" in text  # learning: within each configuration
    assert "25" not in text  # 15 + 10 is written nowhere


def test_toggle_refusals_are_counted_on_their_own(tmp_path):
    folder = write_run(tmp_path, "privacy_officer", 105)
    held = {"id": "x", "decision": "refuse", "floors": ["compliance:small_group"]}
    other = {"id": "y", "decision": "refuse", "floors": ["blocked_contact"]}
    asks = {"id": "z", "decision": "ask_user", "floors": ["compliance:ask_all"]}
    write_raw(folder, "unseen-night-0.jsonl", [held, held, other, asks])
    write_raw(folder, "unseen-last-night.jsonl", [held, other])
    write_raw(folder, "night-10-current.jsonl", [other])
    text = "\n".join(ss.toggle_section(ss.read_study(tmp_path)))
    assert "| privacy_officer | seed 105 | ferpa, coppa | 0 | - | 0 | 2 | 1 |" in text
    assert "makes no finding" in text


def test_local_only_persona_reports_what_reached_muse(tmp_path):
    write_run(tmp_path, "caseworker_cui", 107)
    text = "\n".join(ss.local_only_section(ss.read_study(tmp_path)))
    assert "| seed 107 | 14 | 0 | 10 |" in text  # invented rows: the most asks on one day, as written


@pytest.mark.parametrize(
    ("kw", "expected"),
    [
        ({"loosen": ()}, "Router changes (ROUTER_LOOSEN) is none"),
        (
            {"loosen": ("lists", "result_words", "class_of")},
            "Router changes (ROUTER_LOOSEN) is class_of, lists, result_words",
        ),
        ({"nights": 8, "rows": night_rows(8)}, None),  # short with no stopped.md: stopped, no reason recorded
        ({"per_day": 20}, "does not say --per-day 30"),
    ],
)
def test_differences_from_the_plan_are_listed(tmp_path, kw, expected):
    run = ss.read_run("strict_teacher", 101, write_run(tmp_path, "strict_teacher", 101, **kw))
    found = "; ".join(ss.deviations(run))
    if expected:
        assert expected in found
    else:
        assert ss.run_status(run) == "stopped at night 8, no reason recorded"
        assert not run.paired


def test_a_seed_outside_the_plan_is_listed_and_gives_no_number(tmp_path):
    write_run(tmp_path, "strict_teacher", 999, before=20, after=1)
    runs = ss.read_study(tmp_path)
    assert ss.counted(runs, "strict_teacher") == {}
    assert word(runs, "strict_teacher") == "no result"
    assert "seed 999 is not one of the planned seeds" in "\n".join(ss.deviation_section(runs))
    assert "| strict_teacher | seed 999 |" in "\n".join(ss.every_run_table(runs))


def test_no_rules_kept_is_said_and_reads_as_no_fall(tmp_path):
    folder = write_run(tmp_path, "strict_teacher", 101, before=20, after=20)
    text = (
        (folder / "nights.md")
        .read_text()
        .replace(
            "After the last night, rules.md (3 rules)",
            "After the last night: no rules kept, so the night-0 router (not scored again)",
        )
    )
    (folder / "nights.md").write_text(text)
    run = ss.read_run("strict_teacher", 101, folder)
    assert run.no_rules_kept and not run.fell
    assert "No night kept rules" in ss._run_row(run)


def test_commit_must_be_a_git_hash_and_the_default_is_head(tmp_path):
    with pytest.raises(SystemExit):
        ss.main(["--study", str(tmp_path), "--commit", "not-a-hash"])
    assert re.fullmatch(r"[0-9a-f]{7,40}|unknown", ss.git_commit())


def test_the_chart_keeps_two_measures_off_one_axis_and_says_simulated(tmp_path):
    write_full_study(tmp_path / "study")
    runs = ss.read_study(tmp_path / "study")
    png, svg = ss.write_chart(runs, tmp_path / "out")
    text = svg.read_text()
    assert "Simulated persona study" in text and "Simulated users, invented items" in text
    assert "24 simulated runs read" in text
    assert png.read_bytes().startswith(b"\x89PNG")
    assert png.with_suffix(".svg") == svg  # the same figure: test_sim_honesty judges the PNG by this SVG


LEAK_NOTE = "Stopped (simulated run): night 4. Reason: 1 leak on the holdout.\n"
ERROR_NOTE = "Stopped (simulated run): night 2. Reason: model errors on two nights.\n"


def stop_only(study: Path, persona: str, seed: int, note: str, folder: str | None = None) -> Path:
    """A stopped run the documented way: simulate_nights writes at the end, so only stopped.md is there."""
    path = study / persona / (folder or f"seed-{seed}")
    path.mkdir(parents=True)
    (path / "stopped.md").write_text(note)
    return path


def edit_unseen(folder: Path, label: str, **cells: str) -> None:
    """Change cells of one row of nights.md's Unseen test table, by column name."""
    path = folder / "nights.md"
    lines = path.read_text().splitlines()
    at = next(i for i, line in enumerate(lines) if line.startswith("| Router | Items "))
    head = [c.strip() for c in lines[at].split("|")]
    for i, line in enumerate(lines):
        if line.startswith(f"| {label}"):
            parts = line.split("|")
            for name, value in cells.items():
                parts[head.index(name.replace("_", " "))] = f" {value} "
            lines[i] = "|".join(parts)
    path.write_text("\n".join(lines) + "\n")


def drop_columns(folder: Path, *names: str) -> None:
    path = folder / "nights.csv"
    with path.open(newline="") as f:
        rows = list(csv.DictReader(f))
    head = [k for k in rows[0] if k not in names]
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=head, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def row_for(lines: list[str], start: str) -> list[str]:
    return [c.strip() for c in next(line for line in lines if line.startswith(start)).split("|")]


def test_a_run_stopped_for_a_leak_with_only_its_note_is_never_read_as_clean(tmp_path):
    s = seeds("strict_teacher")
    stop_only(tmp_path, "strict_teacher", s[0], LEAK_NOTE)
    write_run(tmp_path, "strict_teacher", s[0], folder=f"seed-{s[0]}-rerun")
    write_run(tmp_path, "strict_teacher", s[1])
    write_run(tmp_path, "strict_teacher", s[2])
    runs = ss.read_study(tmp_path)
    w, why = ss.reading(runs, "strict_teacher")
    assert w == "not cut" and f"leaks above 0 in seed {s[0]}" in why
    assert "the only reason the plan allows" in why  # a re-run after a leak is not allowed
    assert f"seed {s[1]}: ran after a leak in seed {s[0]}" in why

    stopped = row_for(ss.every_run_table(runs), f"| strict_teacher | seed {s[0]} | stopped")
    assert stopped[4:11] == [
        "-",
        "-",
        "-",
        "at least 1",
        "-",
        "-",
        "-",
    ]  # nights, unneeded x 2, then the safety cells
    reading_row = row_for(ss.reading_table(runs), "| strict_teacher | 3 of 3")
    assert reading_row[6] == "at least 1 (seeds read in full: 0)" and reading_row[10] == "not cut"
    assert "No simulated run was stopped" not in "\n".join(ss.stop_section(runs))
    assert "starts a new study" in "\n".join(ss.stop_section(runs))
    differences = "\n".join(ss.deviation_section(runs))
    assert "None found" not in differences and "the only reason the plan allows" in differences

    png, svg = ss.write_chart(runs, tmp_path / "out")
    assert png.is_file() and "leaks at least 1" in svg.read_text()


def test_the_careful_section_never_says_zero_for_a_try_with_no_rows(tmp_path):
    stop_only(tmp_path, "strict_teacher", 101, LEAK_NOTE)
    runs = ss.read_study(tmp_path)
    text = "\n".join(ss.careful_section(runs))
    assert "strict_teacher: not to be said. Not known for seed 101" in text
    assert "strict_teacher: 0 on every" not in text
    assert ss.reading(runs, "strict_teacher")[0] == "no result"


def test_a_try_stopped_for_model_errors_with_its_rerun_is_what_the_plan_expects(tmp_path):
    s = seeds("strict_teacher")
    stop_only(tmp_path, "strict_teacher", s[0], ERROR_NOTE)
    write_run(tmp_path, "strict_teacher", s[0], folder=f"seed-{s[0]}-rerun")
    write_run(tmp_path, "strict_teacher", s[1])
    write_run(tmp_path, "strict_teacher", s[2])
    runs = ss.read_study(tmp_path)
    w, why = ss.reading(runs, "strict_teacher")
    assert w == "cut" and f"The stopped try of seed {s[0]} wrote no counts" in why
    assert (
        row_for(ss.reading_table(runs), "| strict_teacher | 3 of 3")[6]
        == "at least 0 (seeds read in full: 0)"
    )
    assert row_for(ss.every_run_table(runs), f"| strict_teacher | seed {s[0]} | stopped")[7] == "-"
    assert "strict_teacher: not to be said." in "\n".join(ss.careful_section(runs))


def test_a_stop_note_with_no_reason_blocks_cut(tmp_path):
    s = seeds("strict_teacher")
    stop_only(tmp_path, "strict_teacher", s[0], "Stopped (simulated run): night 2.\n")
    write_run(tmp_path, "strict_teacher", s[0], folder=f"seed-{s[0]}-rerun")
    write_run(tmp_path, "strict_teacher", s[1])
    write_run(tmp_path, "strict_teacher", s[2])
    w, why = ss.reading(ss.read_study(tmp_path), "strict_teacher")
    assert w == "not cut" and "names no reason the plan gives" in why


@pytest.mark.parametrize(
    ("note", "cause", "leaks"),
    [
        (LEAK_NOTE, "leak", 1),
        ("Stopped (simulated run): night 4. Reason: 3 day leaks.", "leak", 3),
        ("Stopped: a leak.", "leak", 1),
        (ERROR_NOTE, "model errors", 0),
        ("Reason: 0 leaks, more than 10% of the holdout errored.", "model errors", 0),
        ("Stopped (simulated run): night 2.", "unknown", 0),
        ("", "unknown", 0),
    ],
)
def test_the_stop_reason_is_read(note, cause, leaks):
    assert ss.stop_cause(note) == cause and ss.stop_leaks(note) == leaks


@pytest.mark.parametrize("name", ["seed-101-first", "seed-101-rerun2", "seed-101-rerun-2", "old"])
def test_a_folder_the_plan_does_not_name_is_listed_counted_and_blocks_cut(tmp_path, name):
    folder = write_run(
        tmp_path, "strict_teacher", 101, folder=name, rows=night_rows(4, holdout_leak_at=2), nights=4
    )
    (folder / "stopped.md").write_text("Stopped (simulated run): night 2. Reason: 1 leak.\n")
    for seed in seeds("strict_teacher"):
        write_run(tmp_path, "strict_teacher", seed)
    runs = ss.read_study(tmp_path)
    w, why = ss.reading(runs, "strict_teacher")
    assert w == "not cut" and name in why and f"leaks above 0 in folder {name}" in why
    assert f"folder {name}" in "\n".join(ss.every_run_table(runs))
    assert f"the folder {name} is not seed-N or seed-N-rerun" in "\n".join(ss.deviation_section(runs))
    assert "1 leak" in "\n".join(ss.stop_section(runs))
    assert ss.counted(runs, "strict_teacher")[101].folder.name == "seed-101"


def test_an_empty_stray_folder_still_blocks_cut(tmp_path):
    for seed in seeds("strict_teacher"):
        write_run(tmp_path, "strict_teacher", seed)
    (tmp_path / "strict_teacher" / "seed-101-first").mkdir()
    assert word(ss.read_study(tmp_path), "strict_teacher") == "not cut"


def test_a_stray_folder_does_not_stand_in_for_a_missing_planned_run(tmp_path, capsys):
    study = tmp_path / "study"
    write_run(study, "strict_teacher", 101, folder="seed-101-first")
    code, out = summarize(study)
    assert code == 2 and not out.exists() and "24 planned runs are missing" in capsys.readouterr().out


def test_a_seed_outside_the_plan_blocks_cut_and_its_counts_count(tmp_path):
    for seed in seeds("strict_teacher"):
        write_run(tmp_path, "strict_teacher", seed)
    write_run(tmp_path, "strict_teacher", 999, rows=night_rows(10, holdout_leak_at=2))
    w, why = ss.reading(ss.read_study(tmp_path), "strict_teacher")
    assert w == "not cut" and "leaks above 0 in seed 999" in why


def test_a_rerun_of_a_run_that_was_not_stopped_is_listed_and_blocks_cut(tmp_path):
    for seed in seeds("strict_teacher"):
        write_run(tmp_path, "strict_teacher", seed)
    write_run(tmp_path, "strict_teacher", 101, folder="seed-101-rerun")
    w, why = ss.reading(ss.read_study(tmp_path), "strict_teacher")
    assert w == "not cut" and "the first run was not stopped for model errors" in why


@pytest.mark.parametrize(
    ("cells", "expected"),
    [
        ({"Items": "50"}, "cover 100 and 50 items"),
        ({"Errors_or_fallbacks": "1"}, "have 0 and 1 errors or fallbacks"),
        ({"Items": "-"}, "cover 100 and - items"),
        ({"Errors_or_fallbacks": "-"}, "have 0 and - errors or fallbacks"),
    ],
)
def test_metric_1_needs_the_same_items_and_no_errors_or_the_seed_gets_no_number(tmp_path, cells, expected):
    s = seeds("strict_teacher")
    for seed in s:
        write_run(tmp_path, "strict_teacher", seed)
    edit_unseen(tmp_path / "strict_teacher" / f"seed-{s[0]}", "After the last night", **cells)
    runs = ss.read_study(tmp_path)
    run = ss.counted(runs, "strict_teacher")[s[0]]
    assert not run.paired and not run.fell
    w, why = ss.reading(runs, "strict_teacher")
    assert w == "too few seeds" and expected in why
    assert expected in "\n".join(ss.deviation_section(runs))
    assert expected in ss._run_row(run)
    assert "| strict_teacher | 2 of 3 |" in "\n".join(ss.reading_table(runs))


def test_a_fall_that_comes_from_errors_in_every_seed_gives_no_reading(tmp_path):
    for seed in seeds("strict_teacher"):
        write_run(tmp_path, "strict_teacher", seed)
        edit_unseen(
            tmp_path / "strict_teacher" / f"seed-{seed}",
            "After the last night",
            Items="50",
            Errors_or_fallbacks="50",
        )
    assert word(ss.read_study(tmp_path), "strict_teacher") == "no result"


def test_empty_folders_are_missing_runs_not_runs_that_ran(tmp_path, capsys):
    study = tmp_path / "study"
    for persona, seed in ss.planned_runs():
        (study / persona / f"seed-{seed}").mkdir(parents=True)
    code, out = summarize(study)
    assert code == 2 and not out.exists() and "nothing to report" in capsys.readouterr().out
    code, out = summarize(study, "--allow-missing")
    assert code == 2 and not out.exists()


def test_an_empty_folder_fails_the_missing_run_gate_beside_real_runs(tmp_path, capsys):
    study = tmp_path / "study"
    write_full_study(study)
    empty = study / "strict_teacher" / "seed-101"
    for path in sorted(empty.rglob("*"), reverse=True):
        path.unlink() if path.is_file() else path.rmdir()
    code, out = summarize(study)
    assert code == 2 and not out.exists() and "1 planned runs are missing" in capsys.readouterr().out
    code, out = summarize(study, "--allow-missing")
    text = (out / "summary.md").read_text()
    assert (
        code == 0
        and "| Planned runs that ran | 23 of 24 |" in text
        and "23 simulated runs read" in (out / "chart.svg").read_text()
    )
    assert "| strict_teacher | seed 101 | no nights.csv or stopped.md, counted as missing |" in text
    assert "strict_teacher: 0 on every day, night and unseen scoring of the 2 runs read." in text


@pytest.mark.parametrize(
    ("kw", "expected"),
    [
        ({"rows": night_rows(12), "nights": 12}, "ran 12 nights, the plan says 10"),
        (
            {"loosen": ("lists",)},
            "Router changes (ROUTER_LOOSEN) is lists, the plan says lists, result_words",
        ),
    ],
)
def test_a_run_outside_the_plan_gives_no_number_and_no_cut(tmp_path, kw, expected):
    for seed in seeds("strict_teacher"):
        write_run(tmp_path, "strict_teacher", seed, **kw)
    runs = ss.read_study(tmp_path)
    w, why = ss.reading(runs, "strict_teacher")
    assert w == "no result" and expected in why
    assert not any(r.paired for r in runs)


def test_a_missing_field_is_a_difference_and_gives_no_number(tmp_path):
    folder = write_run(tmp_path, "strict_teacher", 101)
    path = folder / "nights.md"
    path.write_text(
        "".join(line for line in path.read_text().splitlines(True) if not line.startswith("| Model |"))
    )
    run = ss.read_run("strict_teacher", 101, folder)
    assert "Model is not recorded, the plan says lfm3-vl-2b" in ss.deviations(run) and not run.paired


def test_the_header_comes_from_the_runs_own_files(tmp_path, monkeypatch):
    study = tmp_path / "study"
    write_full_study(study)
    code, out = summarize(study)
    cell = (out / "summary.md").read_text()
    assert code == 0 and "Model lfm3-vl-2b; Dreaming backend rules, as the plan fixes" in cell
    assert "nothing here is about Glimmer" in cell

    def glimmer(loosen=("lists", "result_words")):
        return SimpleNamespace(
            device="laptop", glimmer_backend="openrouter", router_model="meta/muse-glimmer-30b",
            dreaming_backend="glimmer", router_loosen=loosen,
        )  # fmt: skip

    monkeypatch.setattr(sim_rows, "settings", glimmer)
    other = tmp_path / "other"
    write_full_study(other)
    code = ss.main(["--study", str(other), "--out", str(tmp_path / "other_out"), "--commit", "abc1234"])
    text = (tmp_path / "other_out" / "summary.md").read_text()
    assert code == 0 and "Model meta/muse-glimmer-30b" in text and "Not what the plan fixes" in text
    assert "nothing here is about Glimmer" not in text
    assert "| strict_teacher | 0 of 3 |" in text
    assert "| cut |" not in text and "\ncut\n" not in (tmp_path / "other_out" / "chart.svg").read_text()


def test_receipt_mismatches_in_a_stopped_try_block_cut(tmp_path):
    s = seeds("strict_teacher")
    first = write_run(tmp_path, "strict_teacher", s[0], rows=night_rows(2), nights=2, receipts=3)
    (first / "stopped.md").write_text(ERROR_NOTE)
    write_run(tmp_path, "strict_teacher", s[0], folder=f"seed-{s[0]}-rerun")
    write_run(tmp_path, "strict_teacher", s[1])
    write_run(tmp_path, "strict_teacher", s[2])
    runs = ss.read_study(tmp_path)
    w, why = ss.reading(runs, "strict_teacher")
    assert w == "not cut" and f"receipt mismatches above 0 in seed {s[0]}" in why
    assert row_for(ss.reading_table(runs), "| strict_teacher | 3 of 3")[9] == "3 (seeds: 0 to 3)"


SAFETY_COLUMNS = (
    "leaks",
    "day_leaks",
    "missed_asks",
    "day_missed_asks",
    "refuse_shared",
    "day_refuse_shared",
)


def test_safety_counts_that_cannot_be_read_block_cut_and_print_as_a_dash(tmp_path):
    for seed in seeds("strict_teacher"):
        folder = write_run(tmp_path, "strict_teacher", seed)
        drop_columns(folder, *SAFETY_COLUMNS)
        for label in ("Night 0", "After the last night"):
            edit_unseen(folder, label, Leaks="-", Missed_asks="-", Refusals_shared="-")
    runs = ss.read_study(tmp_path)
    w, why = ss.reading(runs, "strict_teacher")
    assert w == "not cut" and "leaks, missed asks, refusals shared not known in seed 101" in why
    table = ss.reading_table(runs)
    assert row_for(table, "| strict_teacher | 3 of 3")[6:9] == ["-", "-", "-"]
    assert row_for(ss.every_run_table(runs), "| strict_teacher | seed 101 |")[7:10] == ["-", "-", "-"]
    assert "strict_teacher: not to be said. Not known for seed 101" in "\n".join(ss.careful_section(runs))


@pytest.mark.parametrize("column", SAFETY_COLUMNS)
def test_one_blank_safety_cell_on_one_night_is_enough_to_block_cut(tmp_path, column):
    for seed in seeds("strict_teacher"):
        write_run(tmp_path, "strict_teacher", seed)
    path = tmp_path / "strict_teacher" / "seed-101" / "nights.csv"
    with path.open(newline="") as f:
        rows = list(csv.DictReader(f))
    rows[5][column] = "n/a"
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    assert word(ss.read_study(tmp_path), "strict_teacher") == "not cut"


def test_a_night_missing_from_nights_csv_is_not_read_as_clean(tmp_path):
    for seed in seeds("strict_teacher"):
        write_run(tmp_path, "strict_teacher", seed)
    write_run(tmp_path, "strict_teacher", 101, rows=[r for r in night_rows(10) if r["night"] != 5])
    runs = ss.read_study(tmp_path)
    assert word(runs, "strict_teacher") == "too few seeds"
    assert "nights.csv has no row for night 5" in "\n".join(ss.deviation_section(runs))


def test_a_real_night_zero_with_no_day_columns_is_not_unknown(tmp_path):
    run = ss.read_run("strict_teacher", 101, write_run(tmp_path, "strict_teacher", 101))
    assert run.rows[0]["day_leaks"] == "" and ss.safety_counts(run)["unknown"] == set()


def test_the_stop_section_says_when_it_could_not_check_for_model_errors(tmp_path):
    folder = write_run(tmp_path, "strict_teacher", 101)
    run = ss.read_run("strict_teacher", 101, folder)
    text = "\n".join(ss.stop_section([run]))
    assert "two nights of model errors" not in text and "no run's files show a leak." in text
    assert "Could not check for model errors, no raw rows: strict_teacher seed 101 (night 1, 2, 3" in text
    assert "A run writes no raw rows for night 0" in text
    good = {"id": "x", "decision": "ask_user", "fallback": False}
    for night in range(1, 11):
        write_raw(folder, f"night-{night}-current.jsonl", [good])
    text = "\n".join(ss.stop_section([run]))
    assert (
        "no run's files show a leak or two nights of model errors." in text and "Could not check" not in text
    )
    assert "A run writes no raw rows for night 0" in text
    write_raw(folder, "night-4-current.jsonl", [])
    assert "(night 4)" in "\n".join(ss.stop_section([run]))


def test_the_summary_gives_metrics_5_and_6_per_day_and_per_night_and_a_range_beside_each_safety_sum(tmp_path):
    s = seeds("strict_teacher")
    write_run(tmp_path, "strict_teacher", s[0], rows=night_rows(10, unneeded=(9, 0)))
    write_run(tmp_path, "strict_teacher", s[1], unseen_kw={"missed": 2})
    write_run(tmp_path, "strict_teacher", s[2])
    runs = ss.read_study(tmp_path)
    lines = ss.secondary_section(runs)
    head = row_for(lines, "| Simulated persona | Run | Day 1 ")
    assert head[3:13] == [f"Day {n}" for n in range(1, 11)]
    assert row_for(lines, f"| strict_teacher | seed {s[0]} | 9 | 8 | 7 ")[12] == "0"
    assert (
        "Holdout accuracy per night (simulated):" in lines
        and "Holdout agreement per night (simulated):" in lines
    )
    assert sum(line.startswith("| Simulated persona | Run | Night 0 | Night 1 ") for line in lines) == 2
    assert row_for(ss.reading_table(runs), "| strict_teacher | 3 of 3")[7] == "2 (seeds: 0 to 2)"


def test_the_expected_model_can_be_named_for_a_study_on_glimmer(tmp_path, monkeypatch):
    monkeypatch.setitem(ss.PLANNED_SETUP, "Model", "glimmer")
    monkeypatch.setitem(ss.PLANNED_SETUP, "Dreaming backend", "prompt")
    run = ss.Run("strict_teacher", 101, tmp_path)
    run.wrote = True
    run.fields = {"Device": "laptop", "Backend": "llama_server", "Model": "glimmer", "Dreaming backend": "prompt"}
    cell = ss.setup_cell([run])
    assert "as the plan fixes" in cell and "nothing here is about Glimmer" not in cell
    run.fields["Model"] = "lfm3-vl-2b"
    assert "Not what the plan fixes" in ss.setup_cell([run])
