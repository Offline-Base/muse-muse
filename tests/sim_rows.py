"""Invented rows for the study_summary and time_model tests, written with the simulation's own
writers so they have the shape a real run writes. Nothing here is a study result, and no model runs."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from eval.persona import Persona
from scripts import audit_replay, simulate_nights
from scripts.study_summary import NOFIX, PLANNED, planned_runs

ROOT = Path(__file__).resolve().parent.parent


def settings(loosen=("lists", "result_words")) -> SimpleNamespace:
    return SimpleNamespace(
        device="laptop",
        glimmer_backend="llama_server",
        router_model="lfm3-vl-2b",
        dreaming_backend="rules",
        router_loosen=loosen,
    )


def unseen_row(label: str, unneeded: int, *, leaks=0, missed=0, refused=0) -> dict:
    return {
        "router": label, "n": 100, "accuracy": 0.8, "agreement": 0.8, "approval_requests": unneeded + 10,
        "unneeded_requests": unneeded, "leaks": leaks, "missed_asks": missed, "refuse_shared": refused, "unscored": 0,
    }  # fmt: skip


def night_rows(
    nights: int, *, unneeded=(9, 3), day_missed_at=None, holdout_leak_at=None, label="invented (simulated)"
) -> list[dict]:
    """Night 0 and `nights` days, unneeded asks running from the first value to the second."""
    first, last = unneeded
    rows = [
        simulate_nights._row(0, "", 0.7, 0.7, 0, "", 1.0)
        | {"missed_asks": 0, "refuse_shared": 0, "persona": label}
    ]
    for night in range(1, nights + 1):
        share = (night - 1) / max(nights - 1, 1)
        count = round(first + (last - first) * share)
        rows.append(
            simulate_nights._row(night, count + 5, 0.8, 0.8, 1 if night == holdout_leak_at else 0, "yes", 1.0)
            | {
                "wanted_requests": 5, "unneeded_requests": count, "day_mix": "share_tagged:15 share_summary:5 ask_user:10",
                "day_leaks": 0, "user_rules": night, "practice_rules": 0, "gate_rerun": 0, "missed_asks": 0, "refuse_shared": 0,
                "day_missed_asks": 1 if night == day_missed_at else 0, "day_refuse_shared": 0, "late_answers": 0,
                "unanswered": 0, "undone": 0, "persona": label,
            }
        )  # fmt: skip
    return rows


def write_run(
    study: Path, persona: str, seed: int, *, before=20, after=10, nights=10, unseen_kw=None, receipts=0, loosen=None,
    folder=None, rows=None, per_day=30,
):  # fmt: skip
    """One complete invented run under study/<persona>/seed-<seed>/."""
    pid = "strict_teacher" if persona == NOFIX else persona
    real = Persona.load(ROOT / "eval" / "personas" / pid / "persona.yaml").with_seed(seed)
    out = study / persona / (folder or f"seed-{seed}")
    if loosen is None:
        loosen = () if persona == NOFIX else ("lists", "result_words")
    unseen = [
        unseen_row("Night 0, no learned rules", before),
        unseen_row("After the last night, rules.md (3 rules)", after, **(unseen_kw or {})),
    ]
    simulate_nights.write_outputs(
        rows if rows is not None else night_rows(nights), out,
        command=f"uv run python -m scripts.simulate_nights --persona {pid} --seed {seed} --nights {nights} --per-day {per_day}",
        settings=settings(loosen), items=48, holdout=16, unseen=unseen, persona=real, mix="natural", seed=seed,
    )  # fmt: skip
    audit = audit_replay.Audit(rows=30, shared=10, ledger_text_mismatch=receipts)
    (out / "receipts.md").write_text(
        audit_replay.render(audit, command="invented", persona=real, toggles=real.toggles)
    )
    return out


def write_full_study(study: Path, **kw) -> None:
    for persona, seed in planned_runs():
        write_run(study, persona, seed, **kw)


def write_raw(folder: Path, name: str, rows: list[dict]) -> None:
    raw = folder / "raw" / "nights"
    raw.mkdir(parents=True, exist_ok=True)
    (raw / name).write_text("".join(json.dumps(r | {"simulated": True}) + "\n" for r in rows))


__all__ = ["NOFIX", "PLANNED", "night_rows", "write_full_study", "write_raw", "write_run"]
