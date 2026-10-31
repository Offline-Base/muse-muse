"""study_summary reads the study the way PLAN.md says, on invented rows only (never a study result)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from scripts import study_summary as ss
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
    assert "| strict_teacher | seed 101 | stopped | 0 |" in text


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
    assert b"Simulated" in png.read_bytes()  # in its metadata; the same figure draws the visible title
