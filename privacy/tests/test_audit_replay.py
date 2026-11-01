"""scripts/audit_replay.py: receipts replayed against their rows and against what Muse got.

Real egress, router and decision log in a temp home, with a stand-in for the local model. All
names and items are invented."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from pathlib import Path

from base import egress
from base.controls import Controls, ControlStore
from eval import run_eval
from scripts import audit_replay
from tests.test_personas import FakeModel, device_settings

ROOT = Path(__file__).resolve().parent.parent
ITEMS = {i["id"]: i for i in run_eval.load_items(ROOT / "eval" / "tasks.jsonl")}


def simulated_home(tmp_path, toggles=()):
    """A home where a few invented items went through egress, with the simulation's ledger."""
    settings = device_settings(tmp_path)
    svc = run_eval.services_for(settings, tmp_path / "home")
    svc.checker_llm = svc.answer_llm = FakeModel([n for i in ITEMS.values() for n in i["names"] + i.get("other_names", [])])
    if toggles:
        ControlStore(svc.settings.paths.controls).save(Controls(profiles=list(toggles)))
    ledger = svc.settings.home / audit_replay.LEDGER
    for item in list(ITEMS.values())[:24]:
        before = svc.approvals.history(limit=1)
        released = run_eval.release_item(svc, item, tool="simulation", day=1)
        after = svc.approvals.history(limit=1)
        row = after[0]["id"] if after and after != before else None
        audit_replay.record(ledger, row, released.status, released.text)
        if released.status == "waiting":
            approve, remember = svc.policy.answer(item)
            svc.approvals.decide(released.approval_id, approve, remember, by="policy_sim")
            out = svc.egress.resolve(released.approval_id)
            audit_replay.record(ledger, released.approval_id, out.status, out.text, via="resolve")
    home_settings = svc.settings
    svc.close()
    return home_settings, ledger


def test_a_clean_run_has_no_mismatches(tmp_path):
    settings, ledger = simulated_home(tmp_path)
    a = audit_replay.audit(settings, toggles=(), ledger=ledger)
    assert a.rows > 0 and a.shared > 0 and a.kept > 0 and a.ledger >= a.rows
    assert a.mismatches == 0, {f: getattr(a, f) for f in a.MISMATCH_FIELDS if getattr(a, f)}
    assert a.ledger_shared + a.ledger_waiting + a.ledger_kept == a.ledger
    text = audit_replay.render(a, command="uv run python -m scripts.audit_replay --home H")
    assert "simulated" in text and "| **All** | **0** |" in text and "Controls and the rules" not in text


def _tamper(db: Path, sql: str, *args) -> None:
    con = sqlite3.connect(db)
    with con:
        con.execute(sql, args)
    con.close()


def test_a_tampered_receipt_is_caught(tmp_path):
    settings, ledger = simulated_home(tmp_path)
    rows = audit_replay.read_rows(settings.paths.db)
    shared = next(r for r in rows if r["status"] == "auto" and r["router_decision"] in audit_replay.SHARED)
    receipt = dict(shared["receipt"]) | {"sha256": "0" * 64}
    _tamper(settings.paths.db, "UPDATE decisions SET receipt = ? WHERE id = ?", json.dumps(receipt), shared["id"])
    a = audit_replay.audit(settings, toggles=(), ledger=ledger)
    assert a.hash_mismatch == 1 and a.ledger_text_mismatch == 1 and a.mismatches == 2


def test_a_changed_text_a_dropped_receipt_and_a_refuse_floor_are_caught(tmp_path):
    settings, ledger = simulated_home(tmp_path)
    rows = audit_replay.read_rows(settings.paths.db)
    shared = [r for r in rows if r["status"] == "auto" and r["router_decision"] in audit_replay.SHARED]
    _tamper(settings.paths.db, "UPDATE decisions SET tagged_text = tagged_text || ' more' WHERE id = ?", shared[0]["id"])
    _tamper(settings.paths.db, "UPDATE decisions SET receipt = NULL WHERE id = ?", shared[1]["id"])
    floored = dict(shared[2]["receipt"]) | {"floors": ["blocked:iep"]}
    _tamper(settings.paths.db, "UPDATE decisions SET receipt = ? WHERE id = ?", json.dumps(floored), shared[2]["id"])
    a = audit_replay.audit(settings, toggles=(), ledger=ledger)
    assert a.hash_mismatch == 1 and a.receipts_missing == 1 and a.shared_refuse_floor == 1
    assert a.ledger_text_mismatch == 1  # the ledger line for the row with no receipt
    assert a.mismatches == 4


def test_the_ledger_must_match_and_the_toggles_must_be_recorded(tmp_path):
    settings, ledger = simulated_home(tmp_path)
    lines = ledger.read_text().splitlines()
    kept = next(i for i, x in enumerate(lines) if json.loads(x)["status"] == "refused")
    entry = json.loads(lines[kept]) | {"sha256": audit_replay.sha("Something the device never sends.")}
    lines[kept] = json.dumps(entry)
    lines.append(json.dumps({"row": 99999, "status": "shared", "via": "release", "sha256": "x", "note": False}))
    ledger.write_text("\n".join(lines) + "\n")
    a = audit_replay.audit(settings, toggles=("ferpa",), ledger=ledger)
    assert a.ledger_text_mismatch == 1 and a.ledger_unknown_row == 1 and a.toggles_mismatch == a.rows
    assert audit_replay.audit(replace(settings, device_only=False), ledger=None).mode_mismatch == a.rows


def test_the_private_detail_note_must_agree_with_the_receipt(tmp_path):
    settings, ledger = simulated_home(tmp_path)
    lines = [json.loads(x) for x in ledger.read_text().splitlines()]
    release = next(e for e in lines if e["via"] == "release" and e["row"] is not None)
    release["note"] = not release["note"]
    ledger.write_text("".join(json.dumps(e) + "\n" for e in lines))
    assert audit_replay.audit(settings, ledger=ledger).ledger_note_mismatch == 1
    # record() cuts the note off before hashing, so a noted text still matches its receipt.
    path = tmp_path / "one.jsonl"
    audit_replay.record(path, 1, "waiting", f"{egress.WAITING_TEXT}\n\n{egress.RAW_REQUEST_NOTE}")
    line = json.loads(path.read_text())
    assert line["note"] and line["sha256"] == audit_replay.sha(egress.WAITING_TEXT)
    audit_replay.record(None, 1, "waiting", "ignored")  # no ledger: nothing written


def test_under_toggles_the_report_maps_controls_to_cited_rules_without_verdicts(tmp_path):
    settings, ledger = simulated_home(tmp_path, toggles=("ferpa", "coppa"))
    a = audit_replay.audit(settings, toggles=("ferpa", "coppa"), ledger=ledger)
    assert a.mismatches == 0 and a.toggles_mismatch == 0
    text = audit_replay.render(a, command="c", toggles=("ferpa", "coppa"))
    assert "## Controls and the rules they relate to" in text
    for cite in ("34 CFR 99.3 ", "99.31(b)(1)", "34 CFR 99.32", "16 CFR 312.2", "16 CFR 312.10"):
        assert cite in text
    assert "45 CFR 164.514" in text  # the tagging row names every rule it relates to
    assert "Nothing goes to Muse" not in text  # the CUI row is only for local-only toggles
    lowered = text.lower()
    for word in ("compliant", " i ", "we recommend", "endorse", "certif"):
        assert word not in lowered
    assert "\u2014" not in text


def test_the_command_writes_the_report_and_exits_on_mismatches(tmp_path, capsys):
    settings, _ledger = simulated_home(tmp_path)
    out = tmp_path / "receipts.md"
    persona = ROOT / "eval" / "personas" / "strict_teacher" / "persona.yaml"
    base = replace(settings, home=tmp_path / "elsewhere")
    assert audit_replay.main(["--home", str(settings.home), "--persona", str(persona), "--out", str(out)], settings=base) == 0
    assert out.read_text().splitlines()[2].startswith("Command: `uv run python -m scripts.audit_replay --home")
    assert "Simulated strict 4th-grade teacher (invented)" in out.read_text()
    _tamper(settings.paths.db, "UPDATE decisions SET tagged_text = 'changed' WHERE id = 1")
    assert audit_replay.main(["--home", str(settings.home)], settings=base) == 1
    assert "mismatches 1" in capsys.readouterr().out


def test_refuse_floors_are_the_ones_that_refuse():
    for floor in ("blocked", "blocked:iep", "policy:no_unmasking_requests", "learned:refuse", "sensitive_record",
                  "contact", "narrowed", "summary", "name_check", "topic_check", "compliance:local_only",
                  "compliance:small_group", "compliance:sensitive", "compliance:cloud"):  # fmt: skip
        assert audit_replay.refuses(floor), floor
    for floor in ("ask_first:iep", "request:iep", "identifier:phone", "identifier:digits", "learned:ask_user",
                  "outside_class", "compliance:scan", "compliance:ask_word", "compliance:ask_all"):  # fmt: skip
        assert not audit_replay.refuses(floor), floor


def test_a_name_in_a_shared_text_is_a_mismatch_but_a_word_learned_later_is_not(tmp_path):
    from base import guard

    settings, ledger = simulated_home(tmp_path)
    rows = audit_replay.read_rows(settings.paths.db)
    shared = [r for r in rows if r["status"] == "auto" and r["router_decision"] in audit_replay.SHARED]
    named = shared[0]["tagged_text"] + " Abigail Thornbury"  # a roster name, untagged
    receipt = dict(shared[0]["receipt"]) | {"sha256": audit_replay.sha(named)}
    _tamper(settings.paths.db, "UPDATE decisions SET tagged_text = ?, receipt = ? WHERE id = ?", named,
            json.dumps(receipt), shared[0]["id"])  # fmt: skip
    # The name check reports a plain word of a shared text as a name only after it was shared.
    word = next(w for w in shared[1]["tagged_text"].split() if w.isalpha() and len(w) > 5)
    tagmap = guard.TagMap.for_settings(settings)
    tagmap.tag_for("person", word, word)
    tagmap.save()
    a = audit_replay.audit(settings, toggles=(), ledger=None)
    assert a.shared_leaks == 1 and a.later_tagged >= 1 and a.mismatches == 1
