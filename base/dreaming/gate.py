"""Keep tonight's rules only if they are no worse than the current ones on the holdout.

Paired: the current rules are scored once with eval/run_eval.py on the holdout items (never
trained on) in a fresh temporary home. The candidate is then re-run, in another fresh home, only
on the items whose learned rules differ between the two files (Router.learned_view: the rule shown
with the item and the rule behind its learned floor). Every other item keeps the current run's
row. Router decisions flip on a few items between identical runs, so two separate runs could
reject a good night on noise alone. An item the current run could not route (it raised, or a
check held it before the router ran) has no learned view to compare and is re-run too.

The pairing assumes a rule that is neither shown with an item nor behind its floor does not
change that item's decision. The model's system prompt lists every rule, but its step 3 makes
only the shown ones binding, and the learned floor is applied in code.

The candidate is kept only if overall accuracy, every category's accuracy and agreement with the
teacher's policy are no worse, it leaks nothing (a leak on a reused item counts against it too),
it shares no more items the policy wants asked about (missed asks) or refused (refusals shared),
and neither side has more than MAX_UNSCORED_SHARE of items that errored or fell back. The leak
count cannot see a refused item shared tagged, so the last two are checked on their own.
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
    rerun: int = 0  # holdout items scored again on the candidate rules; the rest reuse the current run


def compare(before: EvalReport, after: EvalReport) -> list[str]:
    """Plain reasons the candidate is worse than the current rules. Empty means no worse."""
    reasons = []
    limit = run_eval.MAX_UNSCORED_SHARE
    for label, r in (("current", before), ("candidate", after)):
        if r.unscored_share() > limit:  # the model was down: both sides score the same failure
            reasons.append(
                f"the router could not be scored on the {label} rules: {r.errors + r.fallbacks} of {r.n} "
                "items had model errors"
            )
    if after.leaks:
        reasons.append(f"leaked on {after.leaks} holdout items")
    if after.missed_asks > before.missed_asks:
        reasons.append(f"missed asks rose from {before.missed_asks} to {after.missed_asks}")
    if after.refuse_shared > before.refuse_shared:
        reasons.append(f"refusals shared rose from {before.refuse_shared} to {after.refuse_shared}")
    if after.accuracy + EPSILON < before.accuracy:
        reasons.append(f"overall accuracy fell from {before.accuracy:.2f} to {after.accuracy:.2f}")
    if after.agreement + EPSILON < before.agreement:
        reasons.append(f"agreement fell from {before.agreement:.2f} to {after.agreement:.2f}")
    after_cats = after.category_accuracy()
    for cat, acc in before.category_accuracy().items():
        if after_cats.get(cat, 0.0) + EPSILON < acc:
            reasons.append(f"{cat} accuracy fell from {acc:.2f} to {after_cats.get(cat, 0.0):.2f}")
    return reasons


def changed_items(
    services, before: EvalReport, items: list[dict], current_text: str, candidate_text: str
) -> list[dict]:
    """The holdout items the candidate must be re-run on: those whose learned view differs between
    the two rules texts, and those the current run has no RouteInput for. Every item, when the
    services have no router that can tell (Router.learned_view)."""
    view = getattr(getattr(services, "router", None), "learned_view", None)
    inputs = {r.get("id"): r.get("route_input") for r in before.rows}
    out = []
    for item in items:
        inp = inputs.get(item.get("id"))
        if not callable(view) or inp is None or view(inp, current_text) != view(inp, candidate_text):
            out.append(item)
    return out


def paired(before: EvalReport, rerun: EvalReport, *, rules: str) -> EvalReport:
    """The candidate's report: its re-run rows where it has them, the current run's rows (marked
    reused) everywhere else."""
    fresh = {r["id"]: r | {"reused": False} for r in rerun.rows}
    rows = [fresh.pop(r["id"], None) or r | {"reused": True} for r in before.rows]
    rows += fresh.values()  # an id the current run did not have (never expected)
    command = f"dreaming gate: {len(rerun.rows)} of {len(rows)} holdout items re-run on the candidate rules"
    return run_eval.rescore(rows, rerun if rerun.rows else before, name="gate-candidate", rules=rules, command=command)


def gate(
    services,
    candidate_rules_path: str | Path,
    current_rules_path: str | Path,
    holdout_items: list[dict],
    *,
    force: bool = False,
) -> GateResult:
    """Score both rule files, paired, and swap the candidate into place if it passes.

    `force` is for nights when the current rules were learned from decisions the user has since
    deleted: the candidate then replaces them as long as it leaks nothing, and if it leaks, the
    current file is removed too, so deleted decisions never keep steering the router.
    """
    candidate, current = Path(candidate_rules_path), Path(current_rules_path)
    if not candidate.is_file():
        raise FileNotFoundError(f"no candidate rules at {candidate.name}")
    settings = services.settings
    has_current = current.is_file()
    before = run_eval.evaluate(
        settings, holdout_items, rules_path=current if has_current else None, name="gate-current"
    )
    current_text = current.read_text() if has_current else ""  # "" means no learned rules, not the router's own file
    todo = changed_items(services, before, holdout_items, current_text, candidate.read_text())
    if len(todo) == len(holdout_items):
        after = run_eval.evaluate(settings, holdout_items, rules_path=candidate, name="gate-candidate")
    else:
        rerun = (
            run_eval.evaluate(settings, todo, rules_path=candidate, name="gate-candidate")
            if todo
            else EvalReport(name="gate-candidate")
        )
        after = paired(before, rerun, rules=run_eval.describe_rules(candidate))
    reasons = compare(before, after)
    keep = not reasons or (force and after.leaks == 0)
    if keep:
        os.replace(candidate, current)
    else:
        candidate.unlink(missing_ok=True)
        if force:
            current.unlink(missing_ok=True)
    return GateResult(keep=keep, before=before, after=after, reasons=reasons, rerun=len(todo))
