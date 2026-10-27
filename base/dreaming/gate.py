"""Keep tonight's rules only if they are no worse than the current ones on the holdout.

Both rule files are scored with eval/run_eval.py on the holdout items (never trained on), each in
a fresh temporary home. The candidate is kept only if overall accuracy, every category's accuracy
and agreement with the teacher's policy are no worse, and it leaks nothing.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from eval import run_eval
from eval.run_eval import EvalReport

EPSILON = 1e-9


@dataclass
class GateResult:
    keep: bool
    before: EvalReport
    after: EvalReport
    reasons: list[str] = field(default_factory=list)  # why the candidate scored worse, if it did


def compare(before: EvalReport, after: EvalReport) -> list[str]:
    """Plain reasons the candidate is worse than the current rules. Empty means no worse."""
    reasons = []
    if after.leaks:
        reasons.append(f"leaked on {after.leaks} holdout items")
    if after.accuracy + EPSILON < before.accuracy:
        reasons.append(f"overall accuracy fell from {before.accuracy:.2f} to {after.accuracy:.2f}")
    if after.agreement + EPSILON < before.agreement:
        reasons.append(f"agreement fell from {before.agreement:.2f} to {after.agreement:.2f}")
    after_cats = after.category_accuracy()
    for cat, acc in before.category_accuracy().items():
        if after_cats.get(cat, 0.0) + EPSILON < acc:
            reasons.append(f"{cat} accuracy fell from {acc:.2f} to {after_cats.get(cat, 0.0):.2f}")
    return reasons


def gate(
    services,
    candidate_rules_path: str | Path,
    current_rules_path: str | Path,
    holdout_items: list[dict],
    *,
    force: bool = False,
) -> GateResult:
    """Score both rule files and swap the candidate into place if it passes.

    `force` is for nights when the current rules were learned from decisions the user has since
    deleted: the candidate then replaces them as long as it leaks nothing, and if it leaks, the
    current file is removed too, so deleted decisions never keep steering the router.
    """
    candidate, current = Path(candidate_rules_path), Path(current_rules_path)
    if not candidate.is_file():
        raise FileNotFoundError(f"no candidate rules at {candidate.name}")
    settings = services.settings
    before = run_eval.evaluate(
        settings, holdout_items, rules_path=current if current.is_file() else None, name="gate-current"
    )
    after = run_eval.evaluate(settings, holdout_items, rules_path=candidate, name="gate-candidate")
    reasons = compare(before, after)
    keep = not reasons or (force and after.leaks == 0)
    if keep:
        os.replace(candidate, current)
    else:
        candidate.unlink(missing_ok=True)
        if force:
            current.unlink(missing_ok=True)
    return GateResult(keep=keep, before=before, after=after, reasons=reasons)
