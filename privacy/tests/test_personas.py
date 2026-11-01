"""Simulated personas (eval/persona.py, eval/personas/): loading, seeded answers, late and deleted
answers in the simulation, and the item sets. Everything here is invented; no model is called."""

from __future__ import annotations

import csv
import json
import re
from collections import Counter
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from base import egress
from base.config import load_settings
from base.dreaming import dataset
from base.policy import UserPolicy
from base.types import DECISIONS
from eval import persona as persona_mod
from eval import run_eval
from eval.persona import LATE, NEVER, NOW, Persona, PersonaError
from scripts import audit_replay, make_persona_items, relabel_for_persona, simulate_nights

ROOT = Path(__file__).resolve().parent.parent
PERSONAS = ROOT / "eval" / "personas"
IDS = (
    "strict_teacher", "relaxed_teacher", "sped_coordinator", "tired_teacher", "privacy_officer",
    "clinic_coordinator", "caseworker_cui",
)  # fmt: skip
DEV_SETS = ("tasks.jsonl", "fresh_200.jsonl", "fresh_200_b.jsonl")  # development sets, already read
SCHOOL = IDS[:5]


def load(pid: str) -> Persona:
    return Persona.load(PERSONAS / pid / "persona.yaml")


def dev_pool() -> list[dict]:
    return [i for f in DEV_SETS for i in run_eval.load_items(ROOT / "eval" / f)]


# ----- the persona files -----


def test_seven_personas_load_with_their_policies():
    folders = sorted(p.name for p in PERSONAS.iterdir() if p.is_dir())
    assert folders == sorted(IDS)
    for pid in IDS:
        p = load(pid)
        assert p.id == pid and "simulated" in p.name.lower() and "invented" in p.name.lower()
        assert isinstance(UserPolicy.load(PERSONAS / pid / "policy.yaml"), UserPolicy)
        assert (PERSONAS / pid / "README.md").read_text().count("not a person") >= 1
        assert p.seconds_per_card == 15 and p.mix == "natural"
    assert len({load(pid).seed for pid in IDS}) == len(IDS)


def test_the_teacher_personas_reuse_the_reference_policy_byte_for_byte():
    reference = (ROOT / "eval" / "user_policy.yaml").read_bytes()
    for pid in ("strict_teacher", "tired_teacher", "privacy_officer"):
        assert (PERSONAS / pid / "policy.yaml").read_bytes() == reference


def test_each_persona_has_the_habits_and_toggles_the_plan_says():
    assert load("tired_teacher").flip_p == 0.10 and load("tired_teacher").forget_remember_p == 0.30
    assert load("tired_teacher").late_p == 0.20 and load("tired_teacher").undo_p == 0.05
    assert load("relaxed_teacher").flip_p == 0.03
    assert load("privacy_officer").ignore_p == 1.0 and load("privacy_officer").toggles == ("ferpa", "coppa")
    assert load("clinic_coordinator").toggles == ("hipaa",) and load("caseworker_cui").toggles == ("cui",)
    assert load("sped_coordinator").policy.ask_first == {"iep"}
    strict = load("strict_teacher")
    assert (strict.flip_p, strict.forget_remember_p, strict.late_p, strict.ignore_p, strict.undo_p) == (0, 0, 0, 0, 0)


def test_school_personas_have_enough_items_of_each_decision_they_use():
    pool = dev_pool()
    for pid in SCHOOL:
        relabeled = relabel_for_persona.relabel(pool, load(pid))
        assert relabel_for_persona.thin(relabeled) == [], pid
        assert all("simulated" in i["labeled_by"] for i in relabeled)
    # The relaxed teacher's labels are not the strict teacher's: the study's one persona whose
    # labeling policy differs from the reference.
    relaxed = relabel_for_persona.relabel(pool, load("relaxed_teacher"))
    assert sum(a["expected"] != b["expected"] for a, b in zip(pool, relaxed, strict=True)) > 50


def test_the_sped_coordinator_asks_about_iep_results_instead_of_refusing():
    p = load("sped_coordinator").policy
    item = {"request": "progress on goals", "result_kind": "per_student", "topics": ["iep"]}
    assert p.wants(item) == "ask_user" and p.answer(item) == (True, False)
    assert p.wants(item | {"topics": ["iep", "medical"]}) == "refuse"
    assert load("relaxed_teacher").policy.wants({"request": "for the newsletter", "result_kind": "snippet",
                                                  "topics": ["parents"]}) == "ask_user"  # fmt: skip


@pytest.mark.parametrize(
    ("change", "match"),
    [
        ({"name": "A strict teacher"}, "simulated"),
        ({"surprise": 1}, "unknown keys"),
        ({"behavior": {"flip_p": 1.5}}, "from 0 to 1"),
        ({"behavior": {"late_p": 0.6, "ignore_p": 0.6}}, "cannot be more than 1"),
        ({"behavior": {"seconds_per_card": 0}}, "positive"),
        ({"toggles": ["nope"]}, "toggles"),
        ({"mix": "random"}, "mix"),
        ({"answers": {"no_such_rule": {"approve": 1}}}, "not a rule id"),
        ({"answers": {"default": {"approve": 2}}}, "from 0 to 1"),
        ({"seed": "one"}, "whole number"),
    ],
)
def test_a_malformed_persona_is_refused(tmp_path, change, match):
    data = {"id": "x", "name": "Simulated test persona (invented)", "policy": str(ROOT / "eval" / "user_policy.yaml")}
    path = tmp_path / "persona.yaml"
    path.write_text(json.dumps(data | change))
    with pytest.raises(PersonaError, match=match):
        Persona.load(path)


# ----- seeded answers -----


def items(n=200):
    kinds = (("snippet", ["grades"]), ("snippet", ["iep"]), ("free_text", []), ("free_text", ["parents"]))
    return [{"id": f"i{k}", "request": "for my notes", "result_kind": kinds[k % 4][0], "topics": kinds[k % 4][1]}
            for k in range(n)]  # fmt: skip


def test_the_same_seed_gives_the_same_answers_and_order_does_not_matter():
    p = load("tired_teacher")
    first = [p.answer(i, day) for day in (1, 2) for i in items()]
    again = [p.answer(i, day) for day in (1, 2) for i in reversed(items())][::-1]
    assert first == [p.answer(i, day) for day in (1, 2) for i in items()]
    assert sorted(map(repr, first)) == sorted(map(repr, again))
    assert first != [p.with_seed(p.seed + 1).answer(i, day) for day in (1, 2) for i in items()]


def test_measured_rates_are_within_a_point_of_the_settings():
    p = replace(load("strict_teacher"), flip_p=0.10, forget_remember_p=0.30, late_p=0.20, ignore_p=0.05)
    draws = [({"id": f"x{k}", "request": "for my notes", "result_kind": "snippet", "topics": ["grades"]}, k % 7)
             for k in range(10_000)]  # fmt: skip
    answers = [p.answer(item, day) for item, day in draws]
    base_approve, base_remember = p.policy.answer(draws[0][0])
    assert (base_approve, base_remember) == (True, True)
    rate = lambda hits: sum(hits) / len(answers)  # noqa: E731
    assert abs(rate(a.approve != base_approve for a in answers) - 0.10) < 0.01
    assert abs(rate(not a.remember for a in answers) - 0.30) < 0.01
    assert abs(rate(a.when == LATE for a in answers) - 0.20) < 0.01
    assert abs(rate(a.when == NEVER for a in answers) - 0.05) < 0.01


def test_no_noise_answers_exactly_as_the_policy_says():
    p = load("strict_teacher")
    for item in run_eval.load_items(ROOT / "eval" / "tasks.jsonl"):
        a = p.answer(item, 3)
        assert (a.approve, a.remember, a.when) == (*p.policy.answer(item), NOW)
    plain = Persona.from_policy(p.policy)
    assert plain.answer(items()[0], 1) == p.answer(items()[0], 1)


def test_own_odds_per_rule_replace_the_policys_answer(tmp_path):
    data = {"id": "x", "name": "Simulated test persona (invented)", "policy": str(ROOT / "eval" / "user_policy.yaml"),
            "answers": {"default": {"approve": 1.0, "remember": 1.0}}}  # fmt: skip
    (tmp_path / "persona.yaml").write_text(json.dumps(data))
    p = Persona.load(tmp_path / "persona.yaml")
    attendance = {"id": "a", "request": "attendance for my notes", "result_kind": "free_text", "topics": []}
    assert p.odds(attendance) == (1.0, 1.0) and p.answer(attendance, 1) == persona_mod.Answer(True, True, NOW)
    assert p.odds({"id": "b", "request": "x", "result_kind": "snippet", "topics": ["iep"]}) == (0.0, 1.0)
    assert "own odds for default" in p.describe()


def test_undo_is_seeded_per_row():
    p = replace(load("tired_teacher"), undo_p=0.5)
    picks = [p.undoes(r) for r in range(1000)]
    assert picks == [p.undoes(r) for r in range(1000)] and 400 < sum(picks) < 600
    assert not any(load("strict_teacher").undoes(r) for r in range(100))


# ----- in the simulation: real egress, router and dreaming, a stand-in for the local model -----


class FakeModel:
    """Stands in for LFM3-VL-2B: finds the invented names it was given, labels no request topic,
    and writes one fixed class summary. Never a network call."""

    def __init__(self, names=()):
        self.names = sorted(set(names), key=len, reverse=True)

    def llm_names(self, text, *, synthetic=False, max_tokens=1500):
        return [n for n in self.names if n in text]

    llm_details = llm_names

    def request_topics(self, request, topics, *, synthetic=False, max_tokens=1500):
        return []

    def chat(self, messages, **kw):
        return SimpleNamespace(content="Most results were about the same as last week overall.")

    def close(self):
        pass


def device_settings(tmp_path, **extra):
    root = tmp_path / "workspace"
    root.mkdir(exist_ok=True)
    env = {"BASE_HOME": str(tmp_path / "base-home"), "WORKSPACE_ROOT": str(root), "DEVICE_ONLY": "1",
           "CHECKER_API_KEY": "local-test-key", **extra}  # fmt: skip
    return load_settings(env)


@pytest.fixture
def fake_model(monkeypatch):
    """Every Services the simulation and the gate build gets the stand-in model."""
    real = run_eval.services_for
    model = FakeModel()

    def services_for(settings, home, rules_path=None):
        svc = real(settings, home, rules_path)
        svc.checker_llm = svc.answer_llm = model
        return svc

    monkeypatch.setattr(run_eval, "services_for", services_for)
    return model


def item_files(tmp_path, items_list, holdout_n):
    tasks, hold = tmp_path / "tasks.jsonl", tmp_path / "holdout.jsonl"
    tasks.write_text("".join(json.dumps(i) + "\n" for i in items_list))
    hold.write_text("".join(json.dumps(i) + "\n" for i in items_list[:holdout_n]))
    return tasks, hold


def test_late_answers_train_the_next_night_not_that_night(tmp_path, fake_model):
    settings = device_settings(tmp_path)
    teacher = replace(load("strict_teacher"), late_p=1.0)
    day_items = [i for i in run_eval.load_items(ROOT / "eval" / "tasks.jsonl")
                 if i["id"] not in {h["id"] for h in run_eval.load_items(ROOT / "eval" / "holdout.jsonl")}]  # fmt: skip
    fake_model.names = sorted({n for i in day_items for n in i["names"] + i.get("other_names", [])}, key=len, reverse=True)
    svc = run_eval.services_for(settings, tmp_path / "home")
    day = simulate_nights.run_day(svc, day_items, 1, 20, teacher)
    assert day["asked"] > 0 and len(day["late"]) == day["asked"]
    assert [e for e in dataset.build(svc.approvals, None) if e.source == "user"] == []  # nothing yet tonight
    assert simulate_nights.answer_late(svc, day["late"]) == 0
    assert len([e for e in dataset.build(svc.approvals, None) if e.source == "user"]) == day["asked"]
    svc.close()


def test_a_two_night_persona_run_with_late_and_deleted_answers(tmp_path, fake_model):
    settings = device_settings(tmp_path)
    pool = run_eval.load_items(ROOT / "eval" / "tasks.jsonl")
    fake_model.names = [n for i in pool for n in i["names"] + i.get("other_names", [])]
    tasks, hold = item_files(tmp_path, pool, 8)
    teacher = replace(load("strict_teacher"), late_p=1.0, undo_p=1.0)
    rows = simulate_nights.simulate(
        settings, nights=2, per_day=40, home=tmp_path / "sim", tasks_path=tasks, holdout_path=hold,
        synthetic_path=None, persona=teacher, mix="natural", seed=5,
    )  # fmt: skip
    assert [r["night"] for r in rows] == [0, 1, 2]
    assert rows[1]["user_rules"] == 0  # day 1's cards were answered after night 1
    assert rows[1]["late_answers"] == rows[1]["approval_requests"] > 0
    # Day 1's remembered answers are deleted on the morning of day 2, as on the History page.
    deleted = [r for r in audit_replay.read_rows(tmp_path / "sim" / "base.db") if r["deleted"]]
    assert rows[2]["undone"] == len(deleted) > 0 and all(r["day"] == 1 and r["remember"] for r in deleted)
    assert all(r["persona"] == "strict_teacher (simulated)" for r in rows)
    assert all(r["day_leaks"] == 0 for r in rows[1:])
    ledger = (tmp_path / "sim" / "received.jsonl").read_text().splitlines()
    assert len(ledger) >= 80 and all(set(json.loads(x)) == {"row", "status", "via", "sha256", "note"} for x in ledger)


def test_cui_caseworker_keeps_everything_on_the_device_for_three_nights(tmp_path, fake_model):
    """SIM-13: the CUI toggle holds every result; Muse gets only fixed sentences and no cards."""
    settings = device_settings(tmp_path)
    folder = PERSONAS / "caseworker_cui"
    pool = run_eval.load_items(folder / "items.jsonl")
    fake_model.names = make_persona_items.CLIENTS
    worker = load("caseworker_cui")
    home = tmp_path / "sim"
    # Every non-holdout item each day (the pool less its 8 holdout items), so each request is seen 3 times.
    rows = simulate_nights.simulate(
        replace(settings, policy_path=worker.policy_path), nights=3, per_day=len(pool) - 8, home=home,
        tasks_path=folder / "items.jsonl", holdout_path=folder / "holdout.jsonl", synthetic_path=None,
        persona=worker, mix="natural", seed=worker.seed,
    )  # fmt: skip
    assert [r["approval_requests"] for r in rows[1:]] == [0, 0, 0]
    assert all(r["leaks"] == 0 and r["accuracy"] == 1.0 for r in rows) and all(r["day_leaks"] == 0 for r in rows[1:])
    fixed = audit_replay.fixed_hashes()
    ledger = [json.loads(x) for x in (home / "received.jsonl").read_text().splitlines()]
    assert len(ledger) == 3 * (len(pool) - 8)
    assert all(e["status"] == "refused" and e["sha256"] in fixed for e in ledger)
    # Only "Kept on your device." sentences: the toggle's own, or the router's when it refused first.
    kept = {audit_replay.sha(egress.refusal_text([p])) for p, _ in egress.KEPT_REASONS}
    kept.add(audit_replay.sha(egress.refusal_text([])))
    assert {e["sha256"] for e in ledger} <= kept
    local = audit_replay.sha(egress.refusal_text(["compliance:local_only"]))
    assert local in {e["sha256"] for e in ledger}

    # The private-detail note: always for a phone number in the request, and for a client's name
    # once an earlier result has given the device that name.
    rows_by_id = {r["id"]: r for r in audit_replay.read_rows(home / "base.db")}
    detail = {i["id"]: i["request_detail"] for i in pool if "request_detail" in i}
    noted = Counter(detail[rows_by_id[e["row"]]["item_id"]] for e in ledger if e["note"])
    day_ids = [i for i in pool if i["id"] not in {h["id"] for h in run_eval.load_items(folder / "holdout.jsonl")}]
    phones = sum(1 for i in day_ids if i.get("request_detail") == "phone")
    assert noted["phone"] == 3 * phones and noted["name"] >= 2 * sum(1 for i in day_ids if i.get("request_detail") == "name")
    assert not [e for e in ledger if e["note"] and rows_by_id[e["row"]]["item_id"] not in detail]

    a = audit_replay.audit(replace(settings, home=home, policy_path=worker.policy_path), toggles=("cui",),
                           ledger=home / "received.jsonl")  # fmt: skip
    assert a.mismatches == 0 and a.shared == 0 and a.waiting == 0 and a.kept == a.rows > 0
    assert a.holds["compliance:local_only"] > 0


def test_toggles_reach_the_holdout_homes(tmp_path, fake_model):
    from base.controls import Controls, ControlStore

    settings = device_settings(tmp_path)
    item = run_eval.load_items(PERSONAS / "clinic_coordinator" / "items.jsonl")[0]  # a document list
    controls = tmp_path / "privacy_controls.json"
    ControlStore(controls).save(Controls(profiles=["cui"]))
    plain = run_eval.evaluate(settings, [item], name="plain")
    held = run_eval.evaluate(settings, [item], name="held", controls_path=controls)
    assert plain.rows[0]["status"] != "refused" and held.rows[0]["code"] == "compliance:local_only"


def test_the_simulation_refuses_toggles_without_device_only_and_the_lora_backend(tmp_path, monkeypatch):
    cloud = load_settings({"BASE_HOME": str(tmp_path / "h"), "WORKSPACE_ROOT": str(tmp_path),
                           "GLIMMER_BACKEND": "openrouter", "OPENROUTER_API_KEY": "k"})  # fmt: skip
    with pytest.raises(SystemExit, match="DEVICE_ONLY"):
        simulate_nights.write_toggles(cloud, tmp_path / "home", ("cui",))
    assert simulate_nights.write_toggles(cloud, tmp_path / "home", ()) is None
    lora = replace(cloud, dreaming_backend="lora")
    with pytest.raises(SystemExit):
        simulate_nights.main(["--unseen", "none"], settings=lora)


def test_natural_mix_walks_the_whole_pool_each_cycle_and_the_seed_reshuffles():
    pool = [{"id": n, "expected": "share_tagged" if n < 30 else "refuse"} for n in range(40)]
    days = [[i["id"] for i in simulate_nights.pick_items(pool, d, 10, mix="natural", seed=3)] for d in range(1, 5)]
    assert sorted(sum(days, [])) == list(range(40))  # four days of ten cover the pool once
    assert days == [[i["id"] for i in simulate_nights.pick_items(pool, d, 10, mix="natural", seed=3)] for d in range(1, 5)]
    other = [i["id"] for i in simulate_nights.pick_items(pool, 1, 10, mix="natural", seed=4)]
    assert other != days[0]
    even = simulate_nights.pick_items(pool, 1, 10, seed=7)
    assert Counter(i["expected"] for i in even) == {"share_tagged": 5, "refuse": 5}
    assert [i["id"] for i in simulate_nights.pick_items(pool, 1, 10)] != [i["id"] for i in even]


# ----- the invented item pools and their splits -----


def test_the_pools_are_up_to_date_and_labeled_by_their_own_policy():
    built = make_persona_items.build()
    for path, made in built.items():
        assert path.read_text() == make_persona_items.text_of(made), f"{path.parent.name}: run make_persona_items"
        policy = UserPolicy.load(path.parent / "policy.yaml")
        assert all(i["expected"] == policy.wants(i) for i in made)
        assert all("simulated" in i["notes"].lower() for i in made)
    clinic = Counter(i["expected"] for i in built[PERSONAS / "clinic_coordinator" / "items.jsonl"])
    assert clinic == {d: 20 for d in DECISIONS}
    assert Counter(i["expected"] for i in built[PERSONAS / "caseworker_cui" / "items.jsonl"]) == {"refuse": 36}


def test_the_pools_hold_only_fake_values_and_no_roster_names():
    from base import guard
    from scripts import make_synthetic as ms

    roster = guard.load_roster(ROOT / "eval" / "roster.json")
    roster_words = {w.lower() for p in roster.people() for w in (p.first, p.last, *p.nicknames) if w}
    for pid in ("clinic_coordinator", "caseworker_cui"):
        policy = UserPolicy.load(PERSONAS / pid / "policy.yaml")
        for item in run_eval.load_items(PERSONAS / pid / "items.jsonl"):
            text = f"{item['request']}\n{item['result']}"
            _found, bad = ms.scan_identifiers(text)
            assert not bad, item["id"]  # every phone, email, SSN and card number is a fake one
            assert all(re.fullmatch(r"555-01\d\d|000-\d{5}", v) for v in item["identifiers"]), item["id"]
            assert not {w.lower() for n in item["names"] for w in n.split()} & roster_words
            assert "\u2014" not in text
            keyword = set(guard.blocked_topics(item["result"], policy.never_share))
            own = {t for t in item["topics"] if t in policy.never_share}
            assert keyword <= set(item["topics"]), item["id"]
            assert own <= keyword | {policy.identifier_topics.get(k) for k in ("phone", "email", "address")}, item["id"]
            if "request_detail" not in item:
                assert not re.search(r"555-01\d\d", item["request"])


def test_pool_splits_are_disjoint_balanced_and_written_with_their_command(tmp_path):
    for pid, n in (("clinic_coordinator", 16), ("caseworker_cui", 8)):
        folder = PERSONAS / pid
        sets = {s: run_eval.load_items(folder / f"{s}.jsonl") for s in relabel_for_persona.SETS}
        ids = [i["id"] for s in sets.values() for i in s]
        assert len(ids) == len(set(ids)) == len(run_eval.load_items(folder / "items.jsonl"))
        assert len(sets["holdout"]) == len(sets["unseen"]) == n
        assert relabel_for_persona.thin(sets["days"]) == []
        assert "Command: `uv run python -m scripts.relabel_for_persona" in (folder / "sets.md").read_text()
    # The same split again from the command, in a temp folder.
    out = tmp_path / "again"
    argv = ["--persona", str(PERSONAS / "clinic_coordinator" / "persona.yaml"), "--pool",
            str(PERSONAS / "clinic_coordinator" / "items.jsonl"), "--holdout-n", "16", "--unseen-n", "16", "--out", str(out)]  # fmt: skip
    assert relabel_for_persona.main(argv) == 0
    for s in relabel_for_persona.SETS:
        assert (out / f"{s}.jsonl").read_text() == (PERSONAS / "clinic_coordinator" / f"{s}.jsonl").read_text()


def test_relabel_keeps_a_given_split_and_says_when_the_days_are_thin(tmp_path, capsys):
    src = tmp_path / "sim"
    src.mkdir()
    pool = dev_pool()
    for name, part in (("days", pool[:300]), ("holdout", pool[300:380]), ("unseen", pool[380:480])):
        (src / f"{name}.jsonl").write_text("".join(json.dumps(i) + "\n" for i in part))
    out = tmp_path / "out"
    argv = ["--persona", str(PERSONAS / "relaxed_teacher" / "persona.yaml"), "--from", str(src), "--out", str(out)]
    code = relabel_for_persona.main(argv)
    days = run_eval.load_items(out / "days.jsonl")
    assert [i["id"] for i in days] == [i["id"] for i in pool[:300]]
    policy = load("relaxed_teacher").policy
    assert all(i["expected"] == policy.wants(i) for i in days)
    assert code == (1 if relabel_for_persona.thin(days) else 0)
    assert "changed" in (out / "sets.md").read_text()
    with pytest.raises(SystemExit):
        relabel_for_persona.main(["--persona", str(PERSONAS / "relaxed_teacher" / "persona.yaml"), "--from", str(tmp_path / "none")])


def test_the_command_runs_a_persona_with_its_toggles_and_labels_every_output(tmp_path, fake_model, capsys):
    from tests.test_sim_honesty import em_dashes, unlabeled

    folder = PERSONAS / "clinic_coordinator"
    fake_model.names = make_persona_items.PATIENTS
    out = tmp_path / "reports" / "sim" / "clinic_coordinator" / "seed-7"
    argv = ["--persona", str(folder / "persona.yaml"), "--seed", "7", "--nights", "1", "--per-day", "12",
            "--tasks", str(folder / "days.jsonl"), "--holdout", str(folder / "holdout.jsonl"),
            "--unseen", str(folder / "unseen.jsonl"), "--unseen-exclude", "none", "--home", str(tmp_path / "sim"),
            "--out", str(out)]  # fmt: skip
    assert simulate_nights.main(argv, settings=device_settings(tmp_path)) == 0
    md = (out / "nights.md").read_text()
    assert "| Persona | Simulated clinic front-desk coordinator (invented) (eval/personas/clinic_coordinator/persona.yaml) |" in md
    assert "| Toggles | hipaa |" in md and "| Day mix and seed | natural, seed 7 |" in md
    assert "labeled with the persona's own policy (clinic_coordinator)" in md and "| Unneeded asks |" in md
    rows = list(csv_rows(out / "nights.csv"))
    assert {r["persona"] for r in rows} == {"clinic_coordinator (simulated)"}
    receipts = (out / "receipts.md").read_text()
    assert "| **All** | **0** |" in receipts and "45 CFR 164.514(b)(2)(i)(C)" in receipts
    controls = json.loads((tmp_path / "sim" / "privacy_controls.json").read_text())
    assert controls["profiles"] == ["hipaa"]
    assert unlabeled(out) == [] and em_dashes(out) == []
    assert "Receipt mismatches: 0" in capsys.readouterr().out


def csv_rows(path):
    with path.open() as f:
        yield from csv.DictReader(f)


def test_relabel_reads_the_sim_1_split_by_default_and_the_school_sets_match_it(tmp_path):
    persona = "eval/personas/relaxed_teacher/persona.yaml"
    assert relabel_for_persona.main(["--persona", str(ROOT / persona), "--out", str(tmp_path)]) == 0
    for name in relabel_for_persona.SETS:
        split = run_eval.load_items(run_eval.EVAL_DIR / "splits" / f"sim_{name}.jsonl")
        made = run_eval.load_items(tmp_path / f"{name}.jsonl")
        assert [i["id"] for i in made] == [i["id"] for i in split]
        committed = run_eval.load_items(ROOT / "eval" / "personas" / "relaxed_teacher" / f"{name}.jsonl")
        assert committed == made
