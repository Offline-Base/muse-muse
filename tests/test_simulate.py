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
    for first, last in [("Orlinde", "Varsk"), ("Pell", "Hathersage"), ("Quennel", "Ambry"), ("Rusk", "Tavener")]
)
ROSTER = Roster(teacher=Person(name="Sabra Wendle", first="Sabra", last="Wendle", role="teacher"), students=STUDENTS)
GROUPS = [
    ("per_student", ["grades"], "share_tagged"),
    ("class_aggregate", ["grades"], "share_summary"),
    ("sensitive_record", ["iep"], "refuse"),
    ("contact_info", ["parent_contact"], "ask_user"),
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
    assert float(rows[0]["agreement"]) == 0.25 and float(rows[-1]["agreement"]) == 1.0
    assert float(rows[-1]["accuracy"]) == 1.0
    assert all(r["leaks"] == "0" for r in rows)
    assert [r["kept"] for r in rows[1:]] == ["yes"] * 5

    md = (out / "nights.md").read_text()
    assert md.splitlines()[2].startswith("Command: `uv run python -m scripts.simulate_nights --nights 5")
    assert "| 1 | 20 | 100.0% | 100.0% | 0 | yes |" in md
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
        simulate_nights.main(["--home", str(used), "--tasks", str(tasks), "--holdout", str(hold)], settings=settings)


def test_pick_items_is_seeded_and_cycles_through_everything():
    items = [{"id": i} for i in range(80)]
    days = [[i["id"] for i in simulate_nights.pick_items(items, d, 20)] for d in range(1, 6)]
    assert sorted(sum(days[:4], [])) == list(range(80))  # four days visit all 80 once
    assert days == [[i["id"] for i in simulate_nights.pick_items(items, d, 20)] for d in range(1, 6)]
    assert days[0] != list(range(20))  # shuffled
    assert len(set(days[4])) == 20


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
