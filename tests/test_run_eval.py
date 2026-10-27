"""eval/run_eval.py scoring, report files and CLI, with a fake egress. All names are invented."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from base.types import Hit, Person, Roster, RouteDecision
from eval import run_eval

TEACHER = Person(name="Marlow Pennick", first="Marlow", last="Pennick", role="teacher")
STUDENTS = (
    Person(name="Zorvan Pellicott", first="Zorvan", last="Pellicott", nicknames=("Zee",), student_id="S700001"),
    Person(name="Ilsabet Quorn", first="Ilsabet", last="Quorn", student_id="S700002"),
)
ROSTER = Roster(teacher=TEACHER, students=STUDENTS)


def item(id, expected, kind="per_student", topics=("grades",), names=("Zorvan Pellicott",), identifiers=()):
    return {
        "id": id,
        "request": f"request for {id}",
        "result": f"Zorvan Pellicott raw result {id}",
        "result_kind": kind,
        "topics": list(topics),
        "expected": expected,
        "names": list(names),
        "identifiers": list(identifiers),
    }


ITEMS = [
    item("a1", "share_tagged"),
    item("a2", "share_tagged"),
    item("b1", "share_summary", kind="class_aggregate", names=()),
    item("c1", "ask_user", kind="contact_info"),
    item("c2", "ask_user", kind="contact_info"),
    item("d1", "refuse", kind="sensitive_record", topics=("iep",)),
    item("d2", "refuse", kind="sensitive_record", topics=("iep",)),
    item("e1", "share_tagged"),
]

# item id -> (decision, status, released text, router latency ms)
OUTCOMES = {
    "a1": ("share_tagged", "shared", "[Student A] scored 3.", 10),
    "a2": ("ask_user", "waiting", "Waiting for your OK on the device.", 20),
    "b1": ("share_summary", "shared", "Class average 3.1. Call 512-555-0142.", 30),  # guard hit
    "c1": ("ask_user", "waiting", "Waiting for your OK on the device.", 40),
    "c2": ("ask_user", "waiting", "Waiting for your OK on the device.", 50),
    "d1": ("refuse", "refused", "Kept on your device.", 60),
    "d2": ("share_tagged", "shared", "zorvan pellicott has an IEP.", 70),  # planted leak, lower case
}


class FakeEgress:
    def __init__(self):
        self.calls = []

    def release(self, tool, request, raw_text, result_kind, *, job_id=None, summary=None, topics=(),
                item_id=None, day=None, synthetic=False):  # fmt: skip
        self.calls.append({"tool": tool, "item_id": item_id, "synthetic": synthetic, "topics": topics})
        if item_id == "e1":
            raise RuntimeError("model timed out")
        decision, status, text, latency = OUTCOMES[item_id]
        rd = RouteDecision(decision=decision, reason="test", source="model", latency_ms=latency)
        return SimpleNamespace(status=status, text=text, approval_id=None, decision=rd, tag_result=None)


def fake_guard_leaks(text, roster, tagmap):
    return [Hit("phone", "512-555-0142", 0, 12)] if "555-0142" in text else []


def fake_services(settings, egress=None):
    wants = {"c2": "refuse"}  # the teacher's policy disagrees with the label on one item
    return SimpleNamespace(
        settings=settings,
        roster=ROSTER,
        tagmap=None,
        egress=egress or FakeEgress(),
        policy=SimpleNamespace(wants=lambda it: wants.get(it["id"], it["expected"])),
        guard=SimpleNamespace(leaks=fake_guard_leaks),
    )


def test_run_scores_accuracy_agreement_asks_leaks_and_latency(settings):
    services = fake_services(settings)
    report = run_eval.run(services, ITEMS, name="unit", device_label="laptop")

    assert report.n == 8 and report.errors == 1
    assert report.correct == 5 and report.accuracy == 0.625
    assert report.category_accuracy() == {
        "share_tagged": 0.3333, "share_summary": 1.0, "ask_user": 1.0, "refuse": 0.5,
    }  # fmt: skip
    assert report.agreement == 0.5
    assert report.approval_requests == 3
    assert report.leaks == 2  # d2 by name (case-insensitive), b1 by the guard
    assert report.latency_mean_ms == 40.0 and report.latency_p95_ms == 70.0
    assert report.tokens is None
    assert report.backend == "openrouter" and report.model == settings.router_model

    rows = {r["id"]: r for r in report.rows}
    assert rows["d2"]["leaked"] and rows["d2"]["leak_kinds"] == ["name", "roster"]
    assert rows["b1"]["leak_kinds"] == ["guard:phone"]
    assert not rows["a1"]["leaked"]
    assert rows["e1"]["decision"] == "error" and rows["e1"]["error"] == "RuntimeError"
    assert report.confusion["refuse"] == {"refuse": 1, "share_tagged": 1}

    calls = services.egress.calls
    assert all(c["tool"] == "eval" and c["synthetic"] is True for c in calls)
    assert calls[0]["item_id"] == "a1" and calls[0]["topics"] == ["grades"]


def test_find_leaks_is_word_bounded_and_case_insensitive(settings):
    services = fake_services(settings)
    it = item("x", "share_tagged", identifiers=("S700001",))
    values = run_eval._roster_values(ROSTER)
    assert run_eval.find_leaks(services, "ZEE was here", it, values) == ["roster"]
    assert run_eval.find_leaks(services, "id s700001", it, values) == ["identifier"]
    assert run_eval.find_leaks(services, "Zeeland and Zorvanish", it, values) == []
    assert run_eval.find_leaks(services, "[Student A] scored 3", it, values) == []


def test_write_report_has_command_table_and_raw_rows_without_text(settings, tmp_path):
    report = run_eval.run(fake_services(settings), ITEMS, name="unit", device_label="laptop",
                          command="uv run python -m eval.run_eval --set eval/tasks.jsonl --name unit")  # fmt: skip
    md_path, raw_path = run_eval.write_report(report, tmp_path)

    md = md_path.read_text()
    lines = md.splitlines()
    assert lines[0] == "# Eval report: unit"
    assert lines[2] == "Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --name unit`"
    assert "| Device | laptop |" in md and "| Backend | openrouter |" in md
    assert "| share_tagged | 3 | 1 | 33.3% |" in md
    assert "| Leaks | 2 |" in md
    assert "\u2014" not in md

    raw_text = raw_path.read_text()
    rows = [json.loads(line) for line in raw_text.splitlines()]
    assert [r["id"] for r in rows] == [i["id"] for i in ITEMS]
    assert {"id", "expected", "wants", "decision", "source", "floors", "leaked", "latency_ms"} <= set(rows[0])
    assert "Zorvan" not in raw_text and "zorvan" not in raw_text and "raw result" not in raw_text


def _write_jsonl(path: Path, items) -> Path:
    path.write_text("".join(json.dumps(i) + "\n" for i in items))
    return path


def test_cli_uses_a_fresh_temp_home_and_passes_rules(settings, tmp_path, monkeypatch, capsys):
    seen = []

    def services_for(s, home, rules_path=None):
        seen.append((Path(home), rules_path))
        return fake_services(run_eval.prepare_home(s, home, rules_path))

    monkeypatch.setattr(run_eval, "services_for", services_for)
    tasks = _write_jsonl(tmp_path / "tasks.jsonl", ITEMS)
    holdout = _write_jsonl(tmp_path / "holdout.jsonl", [ITEMS[0], ITEMS[3]])
    rules = tmp_path / "rules.md"
    rules.write_text("# rules\n\n- Per-student results (kind: per_student; topics: grades): share tagged. x\n")
    out = tmp_path / "reports"

    argv = ["--set", str(tasks), "--name", "cli-test", "--holdout", "--holdout-file", str(holdout),
            "--rules", str(rules), "--out", str(out)]  # fmt: skip
    assert run_eval.main(argv, settings=settings) == 0

    home, rules_path = seen[0]
    assert home != settings.home and not home.exists()  # temp home, cleaned up afterwards
    assert rules_path == rules
    md = (out / "cli-test.md").read_text()
    assert "Command: `uv run python -m eval.run_eval --set" in md
    assert "| Items | 2 |" in md and "rules.md (1 rules)" in md
    assert len((out / "raw" / "cli-test.jsonl").read_text().splitlines()) == 2
    assert "cli-test: accuracy" in capsys.readouterr().out

    assert run_eval.main(["--set", str(tasks), "--name", "lim", "--limit", "3", "--out", str(out)],
                         settings=settings) == 0  # fmt: skip
    assert seen[-1][1] is None
    assert len((out / "raw" / "lim.jsonl").read_text().splitlines()) == 3


def test_cli_rejects_rules_with_home_and_bad_names(settings, tmp_path):
    tasks = _write_jsonl(tmp_path / "tasks.jsonl", ITEMS)
    with pytest.raises(SystemExit):
        run_eval.main(["--set", str(tasks), "--name", "x", "--home", str(tmp_path / "h"), "--rules", "none"],
                      settings=settings)  # fmt: skip
    with pytest.raises(SystemExit):
        run_eval.main(["--set", str(tasks), "--name", "../escape"], settings=settings)


def test_prepare_home_copies_rules_or_leaves_none(settings, tmp_path):
    rules = tmp_path / "candidate.md"
    rules.write_text("- a rule\n")
    with_rules = run_eval.prepare_home(settings, tmp_path / "one", rules)
    assert with_rules.paths.router_prompt.read_text() == "- a rule\n"
    assert with_rules.home == tmp_path / "one" and settings.home != with_rules.home
    without = run_eval.prepare_home(settings, tmp_path / "two", None)
    assert not without.paths.router_prompt.exists()
    assert run_eval.describe_rules(rules) == "candidate.md (1 rules)"
    assert run_eval.describe_rules(None) == "none"


def test_command_line_hides_home_paths():
    cmd = run_eval.command_line("eval.run_eval", ["--set", str(run_eval.EVAL_DIR / "tasks.jsonl"),
                                                  "--home", str(Path.home() / "sim")])  # fmt: skip
    assert cmd == "uv run python -m eval.run_eval --set eval/tasks.jsonl --home '~/sim'"
