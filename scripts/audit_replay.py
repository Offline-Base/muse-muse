"""Replay the receipts in a simulated device home: does every receipt match what Muse got?

    uv run python -m scripts.audit_replay --home DIR [--persona eval/personas/<id>/persona.yaml]
        [--out eval/reports/sim/<id>/receipts.md]

No model calls, counts only, never text. For every decision row in the home's base.db it checks:
- the row has a receipt, and the receipt's sha256 is the hash of the row's outgoing text;
- the receipt records the run's device-only mode and the toggles that were on;
- nothing that was shared (at once, or after the persona's OK) had a floor that refuses, nothing
  shared at once had a never-share topic, and no shared text has a leak (guard.leaks with the
  roster and the home's tag map).
With the simulation's ledger (BASE_HOME/received.jsonl, written by scripts/simulate_nights.py:
row id, status and the sha256 of every text Muse got, never the text), it also checks that each
shared text is its receipt's outgoing text and each waiting or kept text is one of egress's fixed
sentences. 0 mismatches is the pass.

When toggles were on, the report adds a checklist that maps each control to the rule it relates
to, with this run's counts. The checklist cites rules; it makes no finding about any law.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from collections import Counter
from dataclasses import dataclass, field, replace
from pathlib import Path

from base import compliance, egress, guard
from base.config import load_settings
from base.policy import UserPolicy
from eval import run_eval

LEDGER = "received.jsonl"
SHARED = ("share_tagged", "share_summary")
# Floors that refuse a result (router, egress and the toggles). A shared result never has one.
_REFUSE_NAMES = frozenset(
    {"blocked", "policy", "sensitive_record", "contact", "narrowed", "summary", "name_check", "topic_check"}
)
_REFUSE_FLOORS = frozenset(
    {"learned:refuse", "compliance:local_only", "compliance:sensitive", "compliance:small_group", "compliance:cloud"}
)
_NOTE = f"\n\n{egress.RAW_REQUEST_NOTE}"


def sha(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def refuses(floor: str) -> bool:
    return floor in _REFUSE_FLOORS or floor.split(":")[0] in _REFUSE_NAMES


def fixed_hashes() -> set[str]:
    """Hashes of every fixed sentence egress can send instead of a result."""
    texts = {egress.WAITING_TEXT, egress.HELD_TEXT, egress.KEPT_TEXT, egress.refusal_text([])}
    texts |= {egress.refusal_text([prefix]) for prefix, _ in egress.KEPT_REASONS}
    return {sha(t) for t in texts}


def record(path: Path | None, row_id: int | None, status: str, text: str, via: str = "release") -> None:
    """Append one ledger line for a text Muse got: its row, status, how it got it (`release`, or
    `resolve` after an answer) and its hash (the private-detail note egress adds to a release is
    cut off first and marked), never the text."""
    if path is None:
        return
    text = text or ""
    note = text.endswith(_NOTE)
    line = {"row": row_id, "status": status, "via": via, "sha256": sha(text.removesuffix(_NOTE)), "note": note}
    with Path(path).open("a") as f:
        f.write(json.dumps(line) + "\n")


@dataclass
class Audit:
    rows: int = 0
    deleted: int = 0  # rows the persona deleted later (undo); their text is blank, so only the ledger checks them
    shared: int = 0
    shared_after_ok: int = 0
    waiting: int = 0
    kept: int = 0
    receipts_missing: int = 0
    hash_mismatch: int = 0
    mode_mismatch: int = 0  # the receipt's device_only is not the run's
    toggles_mismatch: int = 0
    shared_refuse_floor: int = 0
    shared_never_share: int = 0  # shared at once with a never-share topic
    shared_leaks: int = 0  # a roster name, identifier or (under toggles) extra detail in a shared text
    later_tagged: int = 0  # shared texts with a value the name pass gave the tag map later (not a mismatch)
    auto_approved: int = 0  # shared by Always approve (the user's switch, so not a mismatch by itself)
    auto_approved_under_toggles: int = 0  # Always approve is off while a toggle is on
    ledger: int = 0  # texts Muse got, per the simulation's ledger (0 when there is none)
    ledger_shared: int = 0
    ledger_waiting: int = 0
    ledger_kept: int = 0
    ledger_unknown_row: int = 0
    ledger_text_mismatch: int = 0  # a shared text that is not its receipt's, or a kept text that is not fixed
    ledger_note_mismatch: int = 0  # the private-detail note without the receipt saying so, or the reverse
    held_by_final_check: int = 0  # the router shared it, the final leak check held it
    removed: Counter = field(default_factory=Counter)  # kind -> count, from every receipt
    holds: Counter = field(default_factory=Counter)  # compliance floor -> results it kept

    MISMATCH_FIELDS = (
        "receipts_missing", "hash_mismatch", "mode_mismatch", "toggles_mismatch", "shared_refuse_floor",
        "shared_never_share", "shared_leaks", "auto_approved_under_toggles", "ledger_unknown_row", "ledger_text_mismatch",
        "ledger_note_mismatch",
    )  # fmt: skip

    @property
    def mismatches(self) -> int:
        return sum(getattr(self, f) for f in self.MISMATCH_FIELDS)


def read_rows(db: Path) -> list[dict]:
    """Every decision row, read only, topics and receipt decoded."""
    if not Path(db).is_file():
        return []
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        if not con.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decisions'").fetchone():
            return []
        rows = [dict(r) for r in con.execute("SELECT * FROM decisions ORDER BY id")]
    finally:
        con.close()
    for r in rows:
        r["topics"] = json.loads(r["topics"]) if r.get("topics") else []
        try:
            r["receipt"] = json.loads(r["receipt"]) if r.get("receipt") else None
        except ValueError:
            r["receipt"] = None
    return rows


def audit(settings, *, toggles=None, ledger: Path | None = None) -> Audit:
    """Check every receipt in settings.home against its row and, with a ledger, against what Muse got.
    `toggles` are the ones the run had on (None: not checked)."""
    policy = UserPolicy.load(settings.policy_path)
    roster = guard.load_roster(settings.roster_path)
    tagmap = guard.TagMap.for_settings(settings)
    never = set(policy.never_share)
    out = Audit()
    rows = read_rows(settings.paths.db)
    by_id = {r["id"]: r for r in rows}
    for r in rows:
        out.rows += 1
        receipt = r["receipt"]
        if receipt is None:
            out.receipts_missing += 1
            continue
        out.removed.update(receipt.get("removed") or {})
        out.holds.update(f for f in receipt.get("floors") or [] if f.startswith("compliance:"))
        if bool(receipt.get("device_only")) != bool(getattr(settings, "device_only", False)):
            out.mode_mismatch += 1
        if toggles is not None and list(receipt.get("toggles") or []) != list(compliance.clean(toggles)):
            out.toggles_mismatch += 1
        if r.get("deleted"):
            out.deleted += 1
            continue
        if receipt.get("sha256") != sha(r.get("tagged_text") or ""):
            out.hash_mismatch += 1
        status, decision = r.get("status"), r.get("router_decision")
        shared = (status == "auto" and decision in SHARED) or status == "approved"
        if status == "pending":
            out.waiting += 1
        elif not shared:
            out.kept += 1
        else:
            out.shared += 1
            out.shared_after_ok += status == "approved"
            auto = r.get("decided_by") == "auto_approve"
            out.auto_approved += auto
            out.auto_approved_under_toggles += auto and bool(receipt.get("toggles"))
            out.shared_refuse_floor += any(refuses(f) for f in receipt.get("floors") or [])
            out.shared_never_share += status == "auto" and bool(never & set(r["topics"]))
            # The release-time check, replayed: the roster and identifier scans with the run's toggles.
            # The tag map is the end of the run's, so a word the model pass reported later as a name
            # is counted on its own: it was not known, so not checkable, when this text was shared.
            text, red = r.get("tagged_text") or "", _redaction(receipt.get("toggles"), settings)
            replayed = bool(guard.leaks(text, roster, None, **red))
            out.shared_leaks += replayed
            out.later_tagged += not replayed and bool(guard.leaks(text, roster, tagmap, **red))
    if ledger is not None and Path(ledger).is_file():
        fixed = fixed_hashes()
        for line in Path(ledger).read_text().splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            out.ledger += 1
            row = by_id.get(entry.get("row"))
            receipt = (row or {}).get("receipt") or {}
            if entry.get("row") is not None and row is None:
                out.ledger_unknown_row += 1
                continue
            status = entry.get("status")
            # The router shared it and the final leak check held it: "Held on your device.", no note.
            held = status == "refused" and row is not None and row["status"] == "auto" and row["router_decision"] in SHARED
            out.held_by_final_check += held
            # Only a release carries the note; a hold before routing has no receipt to say so.
            if entry.get("via") == "release" and row is not None and not held:
                out.ledger_note_mismatch += bool(entry.get("note")) != bool(receipt.get("request_had_private_detail"))
            if status == "shared":
                out.ledger_shared += 1
                out.ledger_text_mismatch += row is None or entry.get("sha256") != receipt.get("sha256")
                continue
            if status == "waiting":
                out.ledger_waiting += 1
            else:
                out.ledger_kept += 1
            out.ledger_text_mismatch += entry.get("sha256") not in fixed
    return out


def _redaction(toggles, settings) -> dict:
    """The final check's redaction for a run with these toggles and no other controls."""
    from base.controls import Controls

    r = Controls(profiles=list(toggles or [])).redaction(name_shapes=bool(getattr(settings, "device_only", False)))
    return {"redaction": r} if r is not None else {}


# ----- the checklist: controls mapped to the rules they relate to (cited, not a finding) -----

CHECKLIST = (
    (
        "Names and identifiers are swapped for tags before any result leaves the device",
        "FERPA, 34 CFR 99.3 (personally identifiable information) and 99.31(b)(1) (release after removing it); "
        "COPPA, 16 CFR 312.2 (the definition of personal information); HIPAA, 45 CFR 164.514(b)(2) (the Safe Harbor list)",
        ("ferpa", "coppa", "state_student", "hipaa", "part2"),
        lambda a: "tags in receipts: " + (", ".join(f"{k} {n}" for k, n in sorted(a.removed.items())) or "none"),
    ),
    (
        "Every result gets a decision row and a receipt (kinds, counts, checks, sha256; no values)",
        "FERPA, 34 CFR 99.32 (record of disclosures), as the closest rule; tagged results are meant to carry no PII",
        ("ferpa", "coppa", "state_student", "hipaa", "part2", "cui", "cjis", "export"),
        lambda a: f"{a.rows - a.receipts_missing} of {a.rows} rows have a receipt",
    ),
    (
        "What Muse received is the text each receipt describes",
        "the same record-keeping rules as above",
        tuple(compliance.PROFILES),
        lambda a: f"{a.ledger_text_mismatch + a.ledger_unknown_row} of {a.ledger} texts differ from their receipt or a fixed sentence",
    ),
    (
        "A result about fewer than 10 people stays on the device",
        "FERPA, 34 CFR 99.3 (indirect identifiers) and 99.31(b)(1) (a reasonable determination across releases); "
        "HIPAA, 45 CFR 164.514(b)(2)(ii) (no actual knowledge that the rest could identify someone)",
        ("ferpa", "coppa", "state_student", "hipaa", "part2"),
        lambda a: f"{a.holds['compliance:small_group']} results kept as a small group",
    ),
    (
        "Old results on the device are deleted after 90 days",
        "COPPA, 16 CFR 312.10 (data retention and deletion)",
        ("coppa", "gdpr"),
        lambda a: "retention set by the toggles; this run lasted less than a day, so nothing was old enough",
    ),
    (
        "Ages over 89 are tagged",
        "HIPAA, 45 CFR 164.514(b)(2)(i)(C)",
        ("hipaa", "part2"),
        lambda a: f"age tags in receipts: {a.removed.get('age', 0)}",
    ),
    (
        "Nothing goes to Muse, not even tagged text",
        "32 CFR Part 2002 (the CUI program); DFARS 252.204-7012 (covered defense information in a cloud service)",
        ("cui", "cjis", "export"),
        lambda a: f"{a.holds['compliance:local_only']} results kept on the device; {a.shared} shared",
    ),
    (
        "Always approve is off while a toggle is on",
        "no rule; a device setting",
        tuple(compliance.PROFILES),
        lambda a: f"{a.auto_approved} results shared by Always approve",
    ),
)


def checklist_lines(a: Audit, toggles) -> list[str]:
    on = set(compliance.clean(toggles))
    if not on:
        return []
    lines = [
        "",
        "## Controls and the rules they relate to",
        "",
        "A checklist for a reviewer. It maps each control the device runs to a rule it relates to, with "
        "counts from this simulated run. It cites rules and makes no finding about any law; a toggle does not "
        "satisfy a law by itself (each toggle's own limit is on the Controls page).",
        "",
        "| Control | Related rule (cited) | This run |",
        "|---|---|---|",
    ]
    for control, rules, profiles, evidence in CHECKLIST:
        if on & set(profiles):
            lines.append(f"| {control} | {rules} | {evidence(a)} |")
    return lines


def render(a: Audit, *, command: str, persona=None, toggles=()) -> str:
    who = getattr(persona, "name", None) or "the simulated teacher's policy"
    lines = [
        "# Receipt audit replay (simulated run, invented data)",
        "",
        f"Command: `{command}`",
        "",
        f"Persona: {who}. The persona is a policy file with seeded habits, not a person. No model calls; counts only.",
        "",
        "| Count | Value |",
        "|---|---|",
        f"| Decision rows | {a.rows} |",
        f"| Shared (of which after an OK) | {a.shared} ({a.shared_after_ok}) |",
        f"| Waiting for an answer | {a.waiting} |",
        f"| Kept on the device | {a.kept} |",
        f"| Deleted later by the persona | {a.deleted} |",
        f"| Texts Muse got (ledger): shared, waiting, kept | {a.ledger_shared}, {a.ledger_waiting}, {a.ledger_kept} |",
        f"| Held by the final leak check after the router shared | {a.held_by_final_check} |",
        f"| Shared by Always approve | {a.auto_approved} |",
        f"| Shared texts with a word the name check reported only later | {a.later_tagged} |",
        "",
        "| Check | Mismatches |",
        "|---|---|",
        f"| Row without a receipt | {a.receipts_missing} |",
        f"| Receipt hash is not the row's outgoing text | {a.hash_mismatch} |",
        f"| Receipt's device-only mode is not the run's | {a.mode_mismatch} |",
        f"| Receipt's toggles are not the run's | {a.toggles_mismatch} |",
        f"| Shared with a floor that refuses | {a.shared_refuse_floor} |",
        f"| Shared at once with a never-share topic | {a.shared_never_share} |",
        f"| Shared text with a roster name or identifier | {a.shared_leaks} |",
        f"| Shared by Always approve while a toggle was on | {a.auto_approved_under_toggles} |",
        f"| Ledger line for a row that does not exist | {a.ledger_unknown_row} |",
        f"| Text Muse got is not its receipt's text or a fixed sentence | {a.ledger_text_mismatch} |",
        f"| Private-detail note and receipt disagree | {a.ledger_note_mismatch} |",
        f"| **All** | **{a.mismatches}** |",
        "",
        "0 mismatches is the pass.",
    ]
    if not a.ledger:
        lines += ["", "No ledger in this home, so what Muse got was not compared, only the rows."]
    lines += checklist_lines(a, toggles)
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None, settings=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = argparse.ArgumentParser(prog="python -m scripts.audit_replay", description=__doc__.split("\n")[0])
    p.add_argument("--home", type=Path, required=True, help="a simulated device home (simulate_nights --home)")
    p.add_argument("--persona", type=Path, help="the persona the run used (its policy, roster and toggles)")
    p.add_argument("--out", type=Path, help="markdown report to write (default: print the counts)")
    args = p.parse_args(argv)
    if not (args.home / "base.db").is_file():
        p.error("--home has no base.db")
    from eval.persona import Persona

    settings = replace(settings or load_settings(), home=args.home)
    persona = Persona.load(args.persona) if args.persona else None
    if persona is not None:
        settings = replace(
            settings, policy_path=persona.policy_path, roster_path=persona.roster_path or settings.roster_path
        )
    toggles = persona.toggles if persona is not None else None
    a = audit(settings, toggles=toggles, ledger=args.home / LEDGER)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        command = run_eval.command_line("scripts.audit_replay", argv)
        args.out.write_text(render(a, command=command, persona=persona, toggles=toggles or ()))
        print(f"Wrote {run_eval.display_path(args.out)}")
    print(f"rows {a.rows}, shared {a.shared}, waiting {a.waiting}, kept {a.kept}, mismatches {a.mismatches}")
    return 0 if a.mismatches == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
