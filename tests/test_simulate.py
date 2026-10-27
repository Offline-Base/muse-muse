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
            "--synthetic", str(tmp_path / "none.jsonl"), "--out", str(out)]  # fmt: skip
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
            "--synthetic", str(tmp_path / "none.jsonl"), "--out", str(out)]  # fmt: skip
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
    argv = ["--nights", "2", "--per-day", "20", "--tasks", str(tasks), "--holdout", str(hold), "--out", str(out)]
    assert simulate_nights.main(argv, settings=settings) == 0
    with (out / "nights.csv").open() as f:
        rows = list(csv.DictReader(f))
    assert rows[1]["day_leaks"] == "0" and rows[1]["practice_rules"] == "0"
    assert int(rows[1]["user_rules"]) >= 1
    md = (out / "nights.md").read_text()
    assert "| Practice data | none" in md and "selected on" in md
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
