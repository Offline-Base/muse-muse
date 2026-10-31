"""eval/run_eval.py scoring, report files and CLI, with a fake egress. All names are invented."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from base.types import Hit, Person, Roster, RouteDecision
from eval import run_eval

TEACHER = Person(name="Marlow Pennick", first="Marlow", last="Pennick", role="teacher")
STUDENTS = (
    Person(
        name="Zorvan Pellicott", first="Zorvan", last="Pellicott", nicknames=("Zee",), student_id="S700001"
    ),
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
    item("a1", "share_tagged") | {"request": "Scores for a1"},  # a grading word: the grading job's table
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
    # Review eval F1: the router gets what production gives it, never the hand-labeled topics. A
    # per-student grading table carries the grading job's own topics, as the agent attaches them.
    assert calls[0]["item_id"] == "a1" and calls[0]["topics"] == ["grades", "writing"]
    assert calls[3]["item_id"] == "c1" and calls[3]["topics"] == []


def test_find_leaks_is_word_bounded_and_case_insensitive(settings):
    services = fake_services(settings)
    it = item("x", "share_tagged", identifiers=("S700001",))
    values = run_eval._roster_values(ROSTER)
    assert run_eval.find_leaks(services, "ZEE was here", it, values) == ["roster"]
    assert run_eval.find_leaks(services, "id s700001", it, values) == ["identifier"]
    assert run_eval.find_leaks(services, "Zeeland and Zorvanish", it, values) == []
    assert run_eval.find_leaks(services, "[Student A] scored 3", it, values) == []


def test_other_names_leak_and_plain_dates_do_not(settings):
    services = fake_services(settings)
    it = dict(item("x", "ask_user"), other_names=["Mr. Brindlewick", "Brindlewick"], dates=["Oct 6"])
    values = run_eval._roster_values(ROSTER)
    assert run_eval.find_leaks(services, "Ask brindlewick about the hose", it, values) == ["other_name"]
    assert run_eval.find_leaks(services, "[Person 1] helped on Oct 6", it, values) == []


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
    rules.write_text(
        "# rules\n\n- Per-student results (kind: per_student; topics: grades): share tagged. x\n"
    )
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


def test_model_path_latency_is_reported_separately(settings):
    services = fake_services(settings)
    rule_item = item("r1", "share_tagged", kind="document_list", names=())
    OUTCOMES["r1"] = ("share_tagged", "shared", "notes.md", 0)
    try:
        original = services.egress.release

        def release(*args, **kw):
            out = original(*args, **kw)
            if kw.get("item_id") == "r1":
                out.decision = RouteDecision("share_tagged", "titles", "rule", 0)
            return out

        services.egress.release = release
        report = run_eval.run(services, [*ITEMS[:2], rule_item], name="unit", device_label="laptop")
    finally:
        del OUTCOMES["r1"]
    assert report.model_calls == 2  # the rule-path item is not a model call
    assert report.model_latency_mean_ms == 15.0 and report.model_latency_p95_ms == 20.0
    assert report.latency_mean_ms == 10.0  # the overall mean still counts the 0 ms rule path
    md = run_eval.render_markdown(report)
    assert "| Items decided by the model | 2 " in md and "Raw rows: raw/unit.jsonl" in md


# ----- review fixes (eval F1, F2, F4; correctness F5) -----


def test_production_inputs_map_kinds_and_drop_labels(settings):
    class Recorder:
        def __init__(self):
            self.calls = []

        def release(self, **kw):
            self.calls.append(kw)

    services = fake_services(settings, egress=Recorder())
    it = item("s1", "refuse", kind="sensitive_record", topics=("iep",))
    run_eval.release_item(services, it)
    run_eval.release_item(services, item("c1", "share_summary", kind="class_aggregate") | {"summary": "Avg 3"})
    run_eval.release_item(services, it, oracle=True)
    first, agg, oracle = services.egress.calls
    assert (first["result_kind"], first["topics"]) == ("snippet", [])
    assert (agg["result_kind"], agg["summary"]) == ("free_text", None)
    assert (oracle["result_kind"], oracle["topics"]) == ("sensitive_record", ["iep"])


def test_per_student_items_go_in_the_way_the_agent_emits_them(settings):
    """Only the grading job emits per_student, always with its topics, and the agent grades when
    Muse's instructions have a grading word (the eval's essays folder has a rubric). Other
    per-student detail comes back from the generic path as free_text with no job topics."""
    from base.workspace.agent import TOPICS_GRADING

    def asked(id, expected, request, **kw):
        return item(id, expected, **kw) | {"request": request}

    calls = []
    services = fake_services(settings, egress=SimpleNamespace(release=lambda **kw: calls.append(kw)))
    run_eval.release_item(services, asked("g1", "share_tagged", "Scores for [Student F].") | {"summary": "Avg 3"})
    run_eval.release_item(services, asked("w1", "ask_user", "Feedback for families.", topics=("writing", "parents")))
    run_eval.release_item(services, asked("t1", "ask_user", "Who was absent?", topics=("attendance",)) | {"summary": "Avg 3"})
    run_eval.release_item(services, item("r1", "ask_user", topics=("reading",)), oracle=True)
    grading, writing, attendance, oracle = calls
    assert (grading["result_kind"], grading["topics"], grading["summary"]) == ("per_student", TOPICS_GRADING, "Avg 3")
    assert (writing["result_kind"], writing["topics"]) == ("per_student", TOPICS_GRADING)  # parents is not a job topic
    assert (attendance["result_kind"], attendance["topics"], attendance["summary"]) == ("free_text", [], None)
    assert (oracle["result_kind"], oracle["topics"]) == ("per_student", ["reading"])
    assert run_eval.production_labels(item("x", "ask_user", topics=("reading",))) == ("free_text", [])
    assert run_eval.production_labels(item("y", "refuse", kind="contact_info")) == ("snippet", [])

    # The request picks the path, not the hand label: a grades item with no grading word is free_text,
    # and "grader" is not a grading word; an unlabeled request that asks for a rubric score grades.
    labels = run_eval.production_labels
    assert labels(asked("c1", "share_tagged", "Compare [Student D] and [Student Q] on Evidence and details.")) == (
        "free_text", [])  # fmt: skip
    assert labels(asked("m1", "share_tagged", "What did the grader say about [Student M]?", topics=("writing",))) == (
        "free_text", [])  # fmt: skip
    assert labels(asked("u1", "refuse", "Rubric score for the student with an IEP.", topics=())) == (
        "per_student", TOPICS_GRADING)  # fmt: skip


def test_report_says_where_the_router_topics_come_from():
    production, oracle = run_eval.LABELS_TEXT["production"], run_eval.LABELS_TEXT["oracle"]
    assert "only from the guard's keyword scan" not in production
    assert "grading job's topics" in production and "Muse's request" in production
    assert "request topics" in production and "device model" in production
    assert "egress finds itself" in oracle
    md = run_eval.render_markdown(run_eval.EvalReport(name="x"))
    assert f"| Router inputs | {production} |" in md
    assert "—" not in production + oracle


def test_raw_rows_record_the_policy_topic_names_egress_routed_on(settings, tmp_path):
    from base.types import RouteInput

    class Router:
        def decide(self, inp, *, synthetic=False):
            return RouteDecision("ask_user", "test", "model", 3)

    class Egress:
        def __init__(self, services):
            self.services = services

        def release(self, tool, request, raw_text, result_kind, *, topics=(), item_id=None, synthetic=False, **kw):
            if item_id == "h1":  # a check held it before the router ran
                held = RouteDecision("refuse", "held", "fallback", 0, ["name_check"])
                return SimpleNamespace(status="refused", text="Held on your device.", approval_id=None,
                                       decision=held, retryable=True)  # fmt: skip
            found = [*topics, "parents", "iep", "free words from the request"]  # the last is not a policy topic
            rd = self.services.router.decide(RouteInput(request, result_kind, "[Student A] 3", topics=found))
            return SimpleNamespace(status="waiting", text="Waiting for your OK on the device.", approval_id=None,
                                   decision=rd)  # fmt: skip

    router = Router()
    services = fake_services(settings)
    services.router = router
    services.egress = Egress(services)
    services.policy = SimpleNamespace(
        wants=lambda it: it["expected"], never_share={"iep": ["IEP"]}, request_topics={"parents": "for a family"},
        rules=[SimpleNamespace(topics_any=("grades", "writing"), topics_all=())],
    )  # fmt: skip
    graded = item("p1", "ask_user") | {"request": "Feedback request for p1"}
    report = run_eval.run(services, [graded, item("h1", "ask_user")], name="t", device_label="laptop")
    assert services.router is router  # the tap is gone after the run
    rows = {r["id"]: r for r in report.rows}
    assert rows["p1"]["topics"] == ["grades", "writing", "parents", "iep"]
    assert rows["p1"]["route_input"].result_kind == "per_student"  # kept in memory for the dreaming gate
    assert rows["h1"]["topics"] is None and rows["h1"]["route_input"] is None

    _, raw_path = run_eval.write_report(report, tmp_path)
    raw = raw_path.read_text()
    assert [json.loads(line)["topics"] for line in raw.splitlines()] == [["grades", "writing", "parents", "iep"], None]
    assert "free words" not in raw and "[Student A]" not in raw and "request for" not in raw
    assert "route_input" not in raw


def test_fallbacks_are_never_counted_correct():
    rows = [
        {"id": "a", "expected": "ask_user", "wants": "ask_user", "decision": "ask_user", "status": "waiting",
         "source": "fallback", "fallback": True, "leaked": False, "latency_ms": 5},
        {"id": "r", "expected": "refuse", "wants": "refuse", "decision": "refuse", "status": "refused",
         "source": "fallback", "floors": ["name_check"], "fallback": True, "leaked": False, "latency_ms": 5},
        {"id": "s", "expected": "share_tagged", "wants": "share_tagged", "decision": "share_tagged",
         "status": "shared", "source": "model", "fallback": False, "leaked": False, "latency_ms": 5},
    ]  # fmt: skip
    r = run_eval._report(rows, name="x")
    assert r.correct == 1 and r.fallbacks == 2 and r.accuracy == round(1 / 3, 4)
    assert r.sources == {"fallback": 2, "model": 1}
    assert r.outcome_accuracy == round(1 / 3, 4)
    md = run_eval.render_markdown(r)
    assert "Fallbacks" in md and "fallback 2" in md


def test_gate_rejects_rules_scored_while_the_model_was_down():
    from base.dreaming import gate

    down = run_eval.EvalReport(name="x", n=20, accuracy=0.3, agreement=0.3, fallbacks=16)
    reasons = gate.compare(down, down)
    assert reasons and "could not be scored" in reasons[0]
    ok = run_eval.EvalReport(name="y", n=20, accuracy=0.9, agreement=0.9, fallbacks=1)
    assert gate.compare(ok, ok) == []  # one flake in 20 is within the limit


def test_text_released_after_an_approval_is_leak_checked(settings, tmp_path):
    """The simulated teacher approves a waiting item; what egress then releases is checked too."""
    from types import SimpleNamespace as NS

    class Egress:
        def __init__(self):
            self.calls = []

        def release(self, **kw):
            self.calls.append(kw)
            return NS(status="waiting", text="Waiting for your OK on the device.", approval_id=7,
                      decision=NS(decision="ask_user", source="model", floors=[], latency_ms=3))

        def resolve(self, approval_id):
            return NS(status="shared", text="Uncle Keoni will pick [Student A] up.")

    decided = []
    services = fake_services(settings)
    services.egress = Egress()
    services.approvals = NS(decide=lambda *a, **k: decided.append(a))
    services.policy = NS(wants=lambda i: "ask_user", answer=lambda i: (True, False))
    it = item("k1", "ask_user", names=()) | {"other_names": ["Keoni"]}
    rows = run_eval.run(services, [it], name="x", device_label="laptop", check_approved=True).rows
    assert decided == [(7, True, False)]
    assert rows[0]["leaked"] and rows[0]["leak_kinds_after_approval"] == ["other_name"]


@pytest.mark.parametrize(
    "text, value, found",
    [
        ("The class average rose from 2.4 to 2.9.", "Rose", False),  # a verb, not the student
        ("Rose wrote about the garden.", "Rose", True),
        ("ROSE wrote about the garden.", "Rose", True),
        ("thanks to rose hallaway", "Rose Hallaway", True),  # a full name counts in any case
        ("[Student A] used a mason jar.", "Mason", False),
        ("Odessa wrote it.", "Odessa", True),
        ("odessa wrote it.", "Odessa", True),  # not a common word, so any case
    ],
)
def test_leak_check_treats_common_word_names_like_the_guard(text, value, found):
    assert run_eval._contains(text, value) is found


# ----- matrix hooks (GLM-5) -----


def _row(id, expected, decision, status, **kw):
    return {"id": id, "expected": expected, "wants": expected, "decision": decision, "status": status,
            "source": kw.pop("source", "rule"), "fallback": False, "leaked": False, "latency_ms": 5, **kw}  # fmt: skip


SAFETY_ROWS = [
    _row("s1", "share_tagged", "ask_user", "waiting"),  # needless ask
    _row("s2", "share_summary", "ask_user", "waiting"),  # needless ask
    _row("s3", "share_tagged", "refuse", "refused"),  # over-refusal
    _row("a1", "ask_user", "share_tagged", "shared"),  # unsafe share
    _row("a2", "ask_user", "refuse", "refused"),  # over-refusal (an ask was expected)
    _row("r1", "refuse", "share_summary", "shared"),  # unsafe share
    _row("r2", "refuse", "refuse", "refused"),
    _row("r3", "refuse", "ask_user", "waiting"),  # stricter than share, not unsafe, not needless
    _row("s4", "share_tagged", "share_tagged", "refused"),  # held by the final check: not shared
]


def test_needless_asks_unsafe_shares_and_over_refusals_are_counted():
    r = run_eval._report(SAFETY_ROWS, name="safety")
    assert (r.needless_asks, r.unsafe_shares, r.over_refusals) == (2, 2, 2)
    assert r.held == 1
    md = run_eval.render_markdown(r)
    assert "| Needless asks (asked where a share was expected) | 2 |" in md
    assert "| Unsafe shares (shared where an ask or a refusal was expected) | 2 |" in md
    assert "| Over-refusals (refused where a share or an ask was expected) | 2 |" in md


def test_subset_rescoring_matches_a_hand_count():
    r = run_eval._report(SAFETY_ROWS, name="all", command="cmd")
    sub = run_eval.subset(r, ["s1", "a1", "r2", "r3", "nope"], name="holdout")
    assert sub.n == 4 and sub.correct == 1 and sub.accuracy == 0.25  # only r2 is right
    assert (sub.needless_asks, sub.unsafe_shares, sub.over_refusals) == (1, 1, 0)
    assert sub.name == "holdout" and sub.command == "cmd"


def test_summary_json_round_trips(tmp_path):
    rows = [_row("s1", "share_tagged", "share_tagged", "shared", source="model", latency_ms=100, release_ms=400,
                 router_calls=2, prompt_tokens=300, completion_tokens=50, reasoning_tokens=30, tokens=350),
            _row("s2", "share_tagged", "ask_user", "waiting", source="model", latency_ms=300, release_ms=900,
                 router_calls=1, prompt_tokens=200, completion_tokens=40, reasoning_tokens=10, tokens=240),
            _row("s3", "refuse", "refuse", "refused", latency_ms=0, release_ms=50, router_calls=0)]  # fmt: skip
    r = run_eval._report(rows, name="j")
    path = tmp_path / "s.json"
    run_eval.write_summary_json(r, path)
    data = json.loads(path.read_text())
    assert data == r.summary()
    assert data["router_calls"] == 3 and data["tokens"] == 590
    assert data["reasoning_tokens_mean"] == 20.0 and data["reasoning_tokens_p95"] == 30
    assert data["latency_p50_ms"] == 100.0 and data["release_p50_ms"] == 400.0 and data["release_p95_ms"] == 900.0
    assert set(run_eval.SUMMARY_KEYS) <= set(data)


def test_cli_writes_the_summary_json(settings, tmp_path, monkeypatch):
    monkeypatch.setattr(run_eval, "services_for",
                        lambda s, home, rules_path=None: fake_services(run_eval.prepare_home(s, home, rules_path)))  # fmt: skip
    tasks = _write_jsonl(tmp_path / "tasks.jsonl", ITEMS)
    out = tmp_path / "reports"
    argv = ["--set", str(tasks), "--name", "js", "--out", str(out), "--summary-json", str(tmp_path / "js.json")]
    run_eval.main(argv, settings=settings)
    data = json.loads((tmp_path / "js.json").read_text())
    assert data["n"] == len(ITEMS) and data["errors"] == 1


def test_customize_is_called_and_its_client_is_used(settings, tmp_path, monkeypatch):
    from base import services as services_module

    built = SimpleNamespace(router=SimpleNamespace(llm="device model"), settings=settings)
    monkeypatch.setattr(services_module.Services, "for_eval", classmethod(lambda cls, s: built))
    seen = []

    def customize(services):
        seen.append(services)
        services.router.llm = "side-port model"

    out = run_eval.services_for(settings, tmp_path / "h", None, customize)
    assert seen == [built] and out.router.llm == "side-port model"
    assert out.settings is settings  # every setting stays as it was


class RoutedEgress:
    """Calls the router like egress, then drops its usage the way a later hold would."""

    def __init__(self, services):
        self.services = services

    def release(self, tool, request, raw_text, result_kind, *, item_id=None, synthetic=False, **kw):
        from base.types import RouteInput

        rd = self.services.router.decide(RouteInput(request, result_kind, "[Student A] text"))
        held = RouteDecision(rd.decision, rd.reason, rd.source, rd.latency_ms, rd.floors)
        return SimpleNamespace(status="waiting", text="Waiting for your OK on the device.", approval_id=None,
                               decision=held, tag_result=None)  # fmt: skip


def test_rows_carry_the_router_usage_and_raw_rows_keep_no_text(settings, tmp_path):
    usage = RouteDecision("ask_user", "r", "model", latency_ms=120, calls=2, prompt_tokens=310,
                          completion_tokens=44, reasoning_tokens=21, finish_reason="stop")  # fmt: skip
    services = fake_services(settings)
    services.router = SimpleNamespace(decide=lambda inp, **kw: usage)
    services.egress = RoutedEgress(services)
    report = run_eval.run(services, [ITEMS[3]], name="usage", device_label="laptop")
    row = report.rows[0]
    assert row["router_calls"] == 2 and row["prompt_tokens"] == 310 and row["completion_tokens"] == 44
    assert row["reasoning_tokens"] == 21 and row["finish_reason"] == "stop" and row["tokens"] == 354
    assert isinstance(row["release_ms"], int) and row["latency_ms"] == 120
    assert report.tokens == 354 and report.router_calls == 2

    _md, raw_path = run_eval.write_report(report, tmp_path)
    raw = json.loads(raw_path.read_text())
    assert {"release_ms", "router_calls", "prompt_tokens", "completion_tokens", "reasoning_tokens",
            "finish_reason", "tokens"} <= set(raw)  # fmt: skip
    assert "Zorvan" not in raw_path.read_text() and "request for" not in raw_path.read_text()


def test_a_rule_path_row_has_no_router_usage(settings):
    report = run_eval.run(fake_services(settings), ITEMS[:1], name="u", device_label="laptop")
    row = report.rows[0]
    assert row["router_calls"] == 0 and "tokens" not in row and "release_ms" in row
