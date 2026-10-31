"""simulate_nights end to end with a fake router that improves once a rules file exists, and charts.

All names and items are invented.
"""

import csv
import json
import sys
import types
from types import SimpleNamespace

import pytest

from base.dreaming import train
from base.types import Person, Roster, RouteDecision, RouteInput, default_share_form
from eval import run_eval
from scripts import charts, simulate_nights

STUDENTS = tuple(
    Person(name=f"{first} {last}", first=first, last=last)
    for first, last in [
        ("Orlinde", "Varsk"),
        ("Pell", "Hathersage"),
        ("Quennel", "Ambry"),
        ("Rusk", "Tavener"),
    ]
)
ROSTER = Roster(
    teacher=Person(name="Sabra Wendle", first="Sabra", last="Wendle", role="teacher"), students=STUDENTS
)
# Kinds the connector really sends, so the production inputs (no hand-labeled topics, kinds as
# the device emits them) keep the four groups apart.
GROUPS = [
    ("per_student", ["grades"], "share_tagged"),
    ("free_text", ["grades"], "share_summary"),
    ("snippet", ["iep"], "refuse"),
    ("document_list", ["parent_contact"], "ask_user"),
]


def contract_label_for(row):
    if row.get("remember"):
        return row["shown_form"] if row["user_decision"] == "approve" else "refuse"
    return "ask_user"


@pytest.fixture(autouse=True)
def approvals_module(monkeypatch):
    try:
        import base.approvals  # noqa: F401  the real one, once it is written
    except Exception:
        fake = types.ModuleType("base.approvals")
        fake.label_for = contract_label_for
        monkeypatch.setitem(sys.modules, "base.approvals", fake)


class RuleRouter:
    """Asks about everything until the learned rules file says otherwise."""

    def __init__(self, settings):
        self.settings = settings

    def decide(self, inp: RouteInput) -> RouteDecision:
        path = self.settings.paths.router_prompt
        rules = train.parse_rules(path.read_text()) if path.is_file() else []
        for kind, topics, decision in rules:
            if (kind, topics) == (inp.result_kind, tuple(sorted(inp.topics))):
                return RouteDecision(decision, "learned rule", "model", 5)
        return RouteDecision("ask_user", "not sure yet", "model", 5)


class FakeApprovals:
    def __init__(self):
        self.rows = []

    def _add(self, status, **fields):
        row = {"id": len(self.rows) + 1, "status": status, "shown_form": default_share_form(fields["result_kind"]),
               "user_decision": None, "remember": 0, "decided_by": None, "deleted": 0, **fields}  # fmt: skip
        self.rows.append(row)
        return row["id"]

    def record_auto(self, **fields):
        return self._add("auto", **fields)

    def create_pending(self, **fields):
        return self._add("pending", **fields)

    def decide(self, id, approve, remember=False, by="user"):
        self.rows[id - 1].update(status="approved" if approve else "denied", remember=int(remember),
                                 user_decision="approve" if approve else "deny", decided_by=by)  # fmt: skip

    def training_rows(self):
        return [dict(r) for r in self.rows if r["user_decision"] and not r["deleted"]]


class FakeEgress:
    def __init__(self, services):
        self.services = services

    def release(self, tool, request, raw_text, result_kind, *, job_id=None, summary=None, topics=(),
                item_id=None, day=None):  # fmt: skip
        svc = self.services
        tagged = raw_text
        for i, person in enumerate(svc.roster.students):
            tagged = tagged.replace(person.name, f"[Student {chr(65 + i)}]")
        rd = svc.router.decide(RouteInput(request, result_kind, tagged, topics=list(topics)))
        fields = {"tool": tool, "request": request, "result_kind": result_kind, "topics": list(topics),
                  "tagged_text": tagged, "router_decision": rd.decision, "item_id": item_id, "day": day}  # fmt: skip
        if rd.decision == "ask_user":
            approval_id = svc.approvals.create_pending(**fields)
            return SimpleNamespace(status="waiting", text="Waiting for your OK on the device.",
                                   approval_id=approval_id, decision=rd, tag_result=None)  # fmt: skip
        svc.approvals.record_auto(**fields)
        if rd.decision == "refuse":
            return SimpleNamespace(status="refused", text="Kept on your device.", approval_id=None, decision=rd,
                                   tag_result=None)  # fmt: skip
        text = tagged if rd.decision == "share_tagged" else (summary or "Class average 3.2.")
        return SimpleNamespace(status="shared", text=text, approval_id=None, decision=rd, tag_result=None)


class FakePolicy:
    def wants(self, item):
        return item["expected"]

    def answer(self, item):
        wants = item["expected"]
        if wants in ("share_tagged", "share_summary"):
            return True, True
        return (False, True) if wants == "refuse" else (True, False)


@pytest.fixture
def fake_world(monkeypatch):
    stores = {}

    def services_for(settings, home, rules_path=None):
        s = run_eval.prepare_home(settings, home, rules_path)
        svc = SimpleNamespace(settings=s, roster=ROSTER, tagmap=None, policy=FakePolicy(), router=RuleRouter(s),
                              approvals=stores.setdefault(str(s.home), FakeApprovals()),
                              guard=SimpleNamespace(leaks=lambda text, roster, tagmap: []))  # fmt: skip
        svc.egress = FakeEgress(svc)
        return svc

    monkeypatch.setattr(run_eval, "services_for", services_for)
    return stores


def write_items(tmp_path):
    items, holdout = [], []
    for g, (kind, topics, expected) in enumerate(GROUPS):
        for n in range(6):
            student = STUDENTS[n % len(STUDENTS)]
            it = {"id": f"t{g}{n}", "request": f"request {kind} {n}", "result": f"{student.name}: {kind} {n}",
                  "result_kind": kind, "topics": topics, "expected": expected, "names": [student.name],
                  "identifiers": []}  # fmt: skip
            items.append(it)
            if n == 5:
                holdout.append(it)
    tasks = tmp_path / "tasks.jsonl"
    tasks.write_text("".join(json.dumps(i) + "\n" for i in items))
    hold = tmp_path / "holdout.jsonl"
    hold.write_text("".join(json.dumps(i) + "\n" for i in holdout))
    return tasks, hold


def test_simulate_nights_end_to_end(settings, tmp_path, fake_world, capsys):
    tasks, hold = write_items(tmp_path)
    out = tmp_path / "reports"
    argv = ["--nights", "5", "--per-day", "20", "--tasks", str(tasks), "--holdout", str(hold),
            "--synthetic", str(tmp_path / "none.jsonl"), "--out", str(out), "--unseen", "none"]  # fmt: skip
    assert simulate_nights.main(argv, settings=settings) == 0

    with (out / "nights.csv").open() as f:
        rows = list(csv.DictReader(f))
    assert list(rows[0]) == list(simulate_nights.FIELDS)
    assert [r["night"] for r in rows] == ["0", "1", "2", "3", "4", "5"]
    asked = [int(r["approval_requests"]) for r in rows[1:]]
    assert rows[0]["approval_requests"] == ""
    assert asked == [20, 5, 5, 5, 5]  # only the "keep asking" group still asks after night 1
    # A known gap, measured on production inputs: no kind the connector sends shows a summary on
    # the approval page, so approving a class-level free_text result teaches share_tagged and the
    # share_summary group never becomes right by learning alone.
    assert float(rows[0]["agreement"]) == 0.25 and float(rows[-1]["agreement"]) == 0.75
    assert float(rows[-1]["accuracy"]) == 0.75 and rows[-1]["acc_share_summary"] == "0.0"
    assert all(r["leaks"] == "0" for r in rows)
    assert [r["kept"] for r in rows[1:]] == ["yes"] * 5

    md = (out / "nights.md").read_text()
    assert md.splitlines()[2].startswith("Command: `uv run python -m scripts.simulate_nights --nights 5")
    assert "| 1 | 20 | 75.0% | 75.0% | 0 | yes |" in md
    assert "\u2014" not in md
    assert "night" in capsys.readouterr().out

    # The simulated home was temporary and the user's real home was never touched.
    assert not settings.paths.router_prompt.exists()
    assert all(not home.startswith(str(settings.home)) for home in fake_world)


def test_simulation_rejects_a_used_home(settings, tmp_path, fake_world):
    tasks, hold = write_items(tmp_path)
    used = tmp_path / "used"
    used.mkdir()
    (used / "base.db").write_text("")
    with pytest.raises(SystemExit):
        simulate_nights.main(
            ["--home", str(used), "--tasks", str(tasks), "--holdout", str(hold)], settings=settings
        )


def test_pick_items_is_seeded_and_cycles_through_everything():
    items = [{"id": i} for i in range(80)]
    days = [[i["id"] for i in simulate_nights.pick_items(items, d, 20)] for d in range(1, 6)]
    assert sorted(sum(days[:4], [])) == list(range(80))  # four days visit all 80 once
    assert days == [[i["id"] for i in simulate_nights.pick_items(items, d, 20)] for d in range(1, 6)]
    assert days[0] != list(range(20))  # shuffled
    assert len(set(days[4])) == 20


def test_each_day_covers_every_decision_evenly():
    items = [{"id": f"{d}{n}", "expected": d} for d in ("refuse", "ask_user", "share_summary", "share_tagged")
             for n in range(20)]  # fmt: skip
    for day in range(1, 6):
        picks = simulate_nights.pick_items(items, day, 20)
        counts = {
            d: sum(i["expected"] == d for i in picks)
            for d in ("share_tagged", "share_summary", "ask_user", "refuse")
        }
        assert counts == {"share_tagged": 5, "share_summary": 5, "ask_user": 5, "refuse": 5}
        assert len({i["id"] for i in picks}) == 20
    four_days = [i["id"] for d in range(1, 5) for i in simulate_nights.pick_items(items, d, 20)]
    assert sorted(four_days) == sorted(i["id"] for i in items)  # every item once before any repeats


def test_requests_split_into_wanted_and_unneeded(settings, tmp_path, fake_world):
    tasks, hold = write_items(tmp_path)
    out = tmp_path / "reports"
    argv = ["--nights", "2", "--per-day", "20", "--tasks", str(tasks), "--holdout", str(hold),
            "--synthetic", str(tmp_path / "none.jsonl"), "--out", str(out), "--unseen", "none"]  # fmt: skip
    assert simulate_nights.main(argv, settings=settings) == 0
    with (out / "nights.csv").open() as f:
        rows = list(csv.DictReader(f))
    assert [(r["wanted_requests"], r["unneeded_requests"]) for r in rows] == [
        ("", ""),
        ("5", "15"),
        ("5", "0"),
    ]
    assert rows[1]["day_mix"] == "share_tagged:5 share_summary:5 ask_user:5 refuse:5"
    assert rows[0]["acc_refuse"] == "0.0" and rows[2]["acc_refuse"] == "1.0"
    md = (out / "nights.md").read_text()
    assert "| 1 | 20 | 75.0% | 75.0% | 0 | yes | " in md and "| 5 | 15 |" in md
    assert "Holdout accuracy by expected decision" in md
    assert charts.main(["--reports", str(out)]) == 0 and (out / "five_nights.png").is_file()


# ----- charts -----

SPEED_MD = """# Laptop speed

Command: `uv run python -m eval.speed --device laptop`

| Step | Latency (ms) | Tokens/s |
|---|---:|---:|
| Router decision | 812 | 41.5 |
| Grade one essay | 9,400 | 38.2 |
"""


def test_charts_render_to_a_temp_dir(tmp_path, capsys):
    reports = tmp_path / "reports"
    reports.mkdir()
    rows = [
        {"night": 0, "approval_requests": "", "accuracy": 0.25, "agreement": 0.25, "leaks": 0, "kept": "", "seconds": 0.1},
        *({"night": n, "approval_requests": 20 // n, "accuracy": 0.5 + n / 10, "agreement": 0.5 + n / 10,
           "leaks": 0, "kept": "yes", "seconds": 1.2} for n in range(1, 6)),
    ]  # fmt: skip
    with (reports / "nights.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=simulate_nights.FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    (reports / "laptop_speed.md").write_text(SPEED_MD)
    (reports / "jetson_speed.md").write_text(SPEED_MD.replace("812", "2400").replace("41.5", "9.1"))

    assert charts.main(["--reports", str(reports)]) == 0
    for name in ("five_nights.png", "speed.png"):
        data = (reports / name).read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) > 10_000

    dark = tmp_path / "dark"
    assert charts.main(["--reports", str(reports), "--out", str(dark), "--theme", "dark"]) == 0
    assert (dark / "five_nights.png").is_file()
    assert "Wrote" in capsys.readouterr().out


def _night_rows(holdout_leaks, day_leaks=None):
    rows = []
    for n, k in enumerate(holdout_leaks):
        row = {"night": str(n), "approval_requests": "" if n == 0 else "5", "agreement": "0.8", "leaks": str(k)}
        if day_leaks is not None:
            row["day_leaks"] = "" if n == 0 else str(day_leaks[n - 1])
        rows.append(row)
    return rows


def test_leak_line_says_only_what_the_data_shows(tmp_path):
    # The line used to say "Leaks: 0 on every night" from the holdout column alone, even when the
    # unseen test in nights.md had a leak.
    unseen_rows = [
        {"router": "Night 0, no learned rules", "n": 100, "accuracy": 0.7, "agreement": 0.7,
         "approval_requests": 53, "leaks": 1, "unscored": 0},
        {"router": "After the last night, router_rules.md (10 rules)", "n": 100, "accuracy": 0.79,
         "agreement": 0.79, "approval_requests": 30, "leaks": 0, "unscored": 0},
    ]  # fmt: skip
    md = tmp_path / "nights.md"
    md.write_text("# Nights\n\n| Night | Leaks |\n|---|---|\n| 0 | 0 |\n" + "\n".join(simulate_nights.unseen_table(unseen_rows, "Note.")) + "\n\n## Cost\n\n$0.\n")  # fmt: skip
    unseen = charts.read_unseen(md)
    assert unseen == [("Night 0, no learned rules", 1), ("After the last night, router_rules.md (10 rules)", 0)]

    rows = _night_rows([0, 0, 0], day_leaks=[0, 0])
    assert charts.leak_note(rows, unseen) == (
        "Leaks: holdout 0 every night; days 0 every day; "
        "unseen test 1 with the night-0 router, 0 after the last night",
        True,
    )
    # The full line is too long for the chart, so it wraps at spaces with nothing lost.
    full, _ = charts.leak_note(rows, unseen)
    wrapped = charts.wrap_note(full)
    assert "\n" in wrapped and all(len(line) <= charts.NOTE_WIDTH for line in wrapped.splitlines())
    assert wrapped.replace("\n", " ") == full
    assert charts.leak_note(rows) == ("Leaks: holdout 0 every night; days 0 every day", False)
    # Old nights.csv without day_leaks, no unseen table: holdout only.
    assert charts.leak_note(_night_rows([0, 0])) == ("Leaks: holdout 0 every night", False)
    assert charts.read_unseen(tmp_path / "missing.md") == []
    (tmp_path / "plain.md").write_text("# Nights\n\n| Night | Leaks |\n|---|---|\n| 0 | 3 |\n")
    assert charts.read_unseen(tmp_path / "plain.md") == []  # no Unseen test section
    # Holdout and day leaks are read per night and per day, never assumed.
    assert charts.leak_note(_night_rows([0, 2, 0], day_leaks=[0, 1])) == (
        "Leaks: holdout 2 on night 1, 0 on the others; days 1 on day 2, 0 on the others",
        True,
    )

    reports = tmp_path / "reports"
    reports.mkdir()
    with (reports / "nights.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=simulate_nights.FIELDS, restval="")
        writer.writeheader()
        writer.writerows(_night_rows([0, 0, 0], day_leaks=[0, 0]))
    (reports / "nights.md").write_text(md.read_text())
    assert charts.main(["--reports", str(reports)]) == 0
    assert (reports / "five_nights.png").read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_speed_tables_prefer_tokens_per_second(tmp_path):
    (tmp_path / "laptop_speed.md").write_text(SPEED_MD)
    assert charts.read_speed(tmp_path) == [
        ("Laptop", "Tokens/s", [("Router decision", 41.5), ("Grade one essay", 38.2)])
    ]
    assert charts.read_speed(tmp_path / "nothing") == []


def test_default_run_has_no_practice_data_and_counts_rules_and_day_leaks(settings, tmp_path, fake_world):
    # Review eval F3: the practice set is labeled by the teacher's own policy, so the headline run
    # learns only from her answers; eval F4: what each approval releases is leak-checked.
    tasks, hold = write_items(tmp_path)
    out = tmp_path / "reports"
    argv = ["--nights", "2", "--per-day", "20", "--tasks", str(tasks), "--holdout", str(hold), "--out", str(out),
            "--unseen", "none"]  # fmt: skip
    assert simulate_nights.main(argv, settings=settings) == 0
    with (out / "nights.csv").open() as f:
        rows = list(csv.DictReader(f))
    assert rows[1]["day_leaks"] == "0" and rows[1]["practice_rules"] == "0"
    assert int(rows[1]["user_rules"]) >= 1
    md = (out / "nights.md").read_text()
    assert "| Practice data | none" in md and "selected on" in md
    assert "a grading word in the request, never the hand labels" in md  # how production_labels picks the path
    assert sorted(p.name for p in (out / "raw" / "nights").iterdir())[:2] == ["night-1-candidate.jsonl", "night-1-current.jsonl"]


def test_speed_series_share_one_metric(tmp_path, capsys):
    # Review eval F8: a Tokens/s file and a latency-only file used to share one axis.
    (tmp_path / "laptop_speed.md").write_text(
        "| Step | Latency (ms) | Tokens/s |\n|---|---:|---:|\n| Grade one essay | 9400 | 42 |\n"
    )
    (tmp_path / "cloud_speed.md").write_text(
        "| Step | Latency (ms) | Tokens/s |\n|---|---:|---:|\n| Grade one essay | 5200 | 55 |\n"
    )
    (tmp_path / "jetson_speed.md").write_text("| Step | Latency (ms) |\n|---|---:|\n| Grade one essay | 21000 |\n")
    series = charts.read_speed(tmp_path)
    assert {metric for _, metric, _ in series} == {"Latency (ms)"}  # the one every file has
    assert [name for name, _, _ in series] == ["Cloud", "Jetson", "Laptop"]
    (tmp_path / "jetson_speed.md").write_text("| Step | Tokens/s |\n|---|---:|\n| Grade one essay | 9 |\n")
    (tmp_path / "old_speed.md").write_text("| Step | Latency (ms) |\n|---|---:|\n| Grade one essay | 30000 |\n")
    series = charts.read_speed(tmp_path)
    assert {metric for _, metric, _ in series} == {"Tokens/s"}  # three files have it, two have latency
    assert "left out old_speed.md" in capsys.readouterr().err


# ----- unseen test: a sample the days, the gate and dreaming never use -----


def write_unseen(tmp_path, per_group=2):
    items = []
    for g, (kind, topics, expected) in enumerate(GROUPS):
        for n in range(per_group):
            student = STUDENTS[n % len(STUDENTS)]
            items.append({"id": f"u{g}{n}", "request": f"unseen {kind} {n}", "result": f"{student.name}: {kind} u{n}",
                          "result_kind": kind, "topics": topics, "expected": expected, "names": [student.name],
                          "identifiers": []})  # fmt: skip
    path = tmp_path / "unseen.jsonl"
    path.write_text("".join(json.dumps(i) + "\n" for i in items))
    return path


def test_unseen_sample_is_seeded_balanced_and_leaves_out_ids():
    from collections import Counter

    from base.types import DECISIONS

    items = [{"id": f"{d}-{n}", "expected": d} for d in DECISIONS for n in range(40)]
    sample = simulate_nights.sample_unseen(items, 100, seed=3)
    assert Counter(i["expected"] for i in sample) == {d: 25 for d in DECISIONS}
    assert sample == simulate_nights.sample_unseen(items, 100, seed=3)  # same seed, same sample
    assert sample != simulate_nights.sample_unseen(items, 100, seed=4)
    assert sample == [i for i in items if i in sample]  # in file order

    left_out = {f"refuse-{n}" for n in range(30)}  # only 10 refuse items remain
    short = simulate_nights.sample_unseen(items, 100, seed=3, exclude=left_out)
    assert Counter(i["expected"] for i in short) == {
        "share_tagged": 30, "share_summary": 30, "ask_user": 30, "refuse": 10,
    }  # fmt: skip
    assert not left_out & {i["id"] for i in short}
    assert len(simulate_nights.sample_unseen(items[:10], 100, seed=3)) == 10
    six = simulate_nights.sample_unseen(items, 6, seed=3)
    assert Counter(i["expected"] for i in six) == {"share_tagged": 2, "share_summary": 2, "ask_user": 1, "refuse": 1}


def test_ids_in_reads_ids_and_skips_missing_files(tmp_path):
    f = tmp_path / "a.jsonl"
    f.write_text('{"id": "syn-0001", "topics": []}\n{"id": "syn-0002"}\n')
    assert simulate_nights.ids_in([f, tmp_path / "missing.jsonl"]) == {"syn-0001", "syn-0002"}


def test_unseen_table_has_one_row_per_router():
    r = run_eval.EvalReport(name="x", n=4, accuracy=0.5, agreement=0.25, approval_requests=2, errors=1,
                            missed_asks=1, categories={"refuse": {"accuracy": 1.0}})  # fmt: skip
    lines = simulate_nights.unseen_table([simulate_nights._unseen_row("Night 0, no learned rules", r)], "Where from.")
    assert lines[1] == "## Unseen test" and "Where from." in lines
    assert "| Night 0, no learned rules | 4 | 50.0% | 25.0% | 2 | 0 | 0 | 1 | 0 | 1 | - | - | - | 100% |" in lines
    header = next(line for line in lines if line.startswith("| Router"))
    assert "| Approval requests | Unneeded asks | Leaks | Missed asks | Refusals shared |" in header
    assert simulate_nights.unseen_table([]) == []


def test_unseen_test_scores_two_routers_once_on_items_nothing_else_uses(settings, tmp_path, fake_world, monkeypatch):
    tasks, hold = write_items(tmp_path)
    unseen = write_unseen(tmp_path)
    out = tmp_path / "reports"
    calls = []
    evaluate = run_eval.evaluate

    def spy(settings, items, *, rules_path=None, name, **kw):
        calls.append((name, sorted(i["id"] for i in items)))
        return evaluate(settings, items, rules_path=rules_path, name=name, **kw)

    monkeypatch.setattr(run_eval, "evaluate", spy)
    # The practice data is the unseen file itself: its sampled items must still never be trained on.
    argv = ["--nights", "2", "--per-day", "20", "--tasks", str(tasks), "--holdout", str(hold), "--out", str(out),
            "--synthetic", str(unseen), "--unseen", str(unseen), "--unseen-n", "8", "--unseen-exclude", "none"]  # fmt: skip
    assert simulate_nights.main(argv, settings=settings) == 0

    ids = sorted(f"u{g}{n}" for g in range(4) for n in range(2))
    assert [c for c in calls if c[0].startswith("unseen")] == [("unseen-night-0", ids), ("unseen-last-night", ids)]
    assert all(not set(ids) & set(seen) for name, seen in calls if not name.startswith("unseen"))
    with (out / "nights.csv").open() as f:
        rows = list(csv.DictReader(f))
    assert rows[1]["practice_rules"] == "0" and rows[2]["practice_rules"] == "0"
    assert rows[1]["gate_rerun"] == "4"  # the fake router cannot compare learned rules, so all are re-run

    md = (out / "nights.md").read_text()
    assert "## Unseen test" in md and "8 items from" in md and "share_tagged:2 share_summary:2 ask_user:2 refuse:2" in md
    assert "| Night 0, no learned rules | 8 | 25.0% |" in md
    assert "| After the last night, router_rules.md (" in md and "| 8 | 75.0% |" in md
    assert "night 1 4 of 4" in md and "—" not in md
    raw = out / "raw" / "nights"
    assert (raw / "unseen-night-0.jsonl").is_file() and (raw / "unseen-last-night.jsonl").is_file()


def test_unseen_sample_leaves_out_the_request_topic_check_ids_by_default(settings, tmp_path, fake_world, monkeypatch):
    tasks, hold = write_items(tmp_path)
    unseen = write_unseen(tmp_path)
    reports = tmp_path / "repo-reports"
    (reports / "raw").mkdir(parents=True)
    (reports / "raw" / "request_topics_tuning.jsonl").write_text('{"id": "u00", "topics": []}\n{"id": "u31"}\n')
    monkeypatch.setattr(run_eval, "REPORTS_DIR", reports)
    out = tmp_path / "reports"
    argv = ["--nights", "1", "--per-day", "8", "--tasks", str(tasks), "--holdout", str(hold), "--out", str(out),
            "--unseen", str(unseen)]  # fmt: skip
    assert simulate_nights.main(argv, settings=settings) == 0
    md = (out / "nights.md").read_text()
    assert "6 items from" in md and "the 2 ids in" in md and "request_topics_tuning.jsonl" in md
    used = {json.loads(line)["id"] for line in (out / "raw" / "nights" / "unseen-night-0.jsonl").read_text().splitlines()}
    assert len(used) == 6 and not used & {"u00", "u31"}


def test_unseen_test_needs_its_file(settings, tmp_path, fake_world):
    tasks, hold = write_items(tmp_path)
    with pytest.raises(SystemExit):
        simulate_nights.main(["--tasks", str(tasks), "--holdout", str(hold), "--unseen", str(tmp_path / "nope.jsonl")],
                             settings=settings)  # fmt: skip


def test_days_and_nights_count_what_was_shared_against_the_policy(settings, tmp_path, fake_world):
    class SharesEverything:
        def decide(self, inp):
            return RouteDecision("share_tagged", "fine", "model", 1)

    tasks, hold = write_items(tmp_path)
    svc = run_eval.services_for(settings, tmp_path / "home")
    svc.router = SharesEverything()
    day = simulate_nights.run_day(svc, run_eval.load_items(tasks), 1, 8)
    assert (day["asked"], day["missed"], day["refuse_shared"]) == (0, 2, 2)

    out = tmp_path / "reports"
    argv = ["--nights", "1", "--per-day", "8", "--tasks", str(tasks), "--holdout", str(hold), "--out", str(out),
            "--unseen", "none"]  # fmt: skip
    assert simulate_nights.main(argv, settings=settings) == 0
    with (out / "nights.csv").open() as f:
        rows = list(csv.DictReader(f))
    assert {"missed_asks", "refuse_shared", "day_missed_asks", "day_refuse_shared"} <= set(rows[0])
    assert rows[0]["missed_asks"] == "0" and rows[0]["day_missed_asks"] == ""
    assert rows[1]["day_missed_asks"] == "0" and rows[1]["day_refuse_shared"] == "0"  # the fake router asks first
    md = (out / "nights.md").read_text()
    assert "| Night | Day missed asks | Day refusals shared | Holdout missed asks | Holdout refusals shared |" in md
    assert "| 0 | - | - | 0 | 0 |" in md and "| 1 | 0 | 0 | 0 | 0 |" in md
