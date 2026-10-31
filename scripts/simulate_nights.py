"""Simulate school days and nights: does dreaming cut the approval requests without leaking?

    uv run python -m scripts.simulate_nights --nights 5 --per-day 20 [--home DIR] [--synthetic PATH|none]
        [--unseen PATH|none] [--unseen-n 100] [--unseen-seed 0] [--unseen-exclude PATH ...|none]
        [--persona eval/personas/<id>/persona.yaml] [--mix even|natural] [--seed N]

Night 0 scores the router on the holdout with no learned rules. Each day sends a fixed, seeded
pick of the non-holdout eval items through egress, spread evenly over the four expected
decisions so every day has items of each kind (--mix natural deals them in their own
proportions instead), and the simulated teacher (eval/user_policy.yaml) answers every approval
request. Each night runs dreaming. Writes eval/reports/nights.csv and eval/reports/nights.md,
plus receipts.md (scripts/audit_replay.py on the simulated home). All items are invented.

--persona (eval/persona.py) swaps in a simulated persona: its policy file labels and routes, its
toggles go on in the simulated home and in every home the holdout is scored in, and its seeded
habits answer the cards: some late (after that night's dreaming, so they train the next night),
some never, some flipped, some without "don't ask again", and some remembered answers deleted the
next morning. --seed replaces the persona's seed and also reshuffles the days.

Approval requests are split into wanted (the teacher's policy says to ask about that item) and
unneeded (the policy would have shared or refused it without asking). Only the unneeded ones
can go away with learning. Fewer asks only count when nothing the policy wants asked about
(missed asks) or refused (refusals shared) was shared instead, so both are counted each day, on
the holdout each night and on the unseen test.

Unseen test: the gate selects on the holdout, so the night-0 router and the router after the last
night are also scored once each on a fixed, seeded sample of eval/synthetic.jsonl that the days,
the gate and dreaming never use (it is left out of practice data too). The sample also leaves out
the ids scripts/check_request_topics.py scored while the request-topic descriptions were written
(eval/reports/raw/request_topics*.jsonl), unless --unseen-exclude says otherwise.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
import tempfile
import time
from collections import Counter
from dataclasses import replace
from datetime import datetime
from pathlib import Path

from base.config import load_settings
from base.controls import Controls, ControlStore
from base.dreaming.night import NightRunner
from base.types import DECISIONS
from eval import run_eval
from eval.persona import LATE, NOW, Persona, PersonaError
from scripts import audit_replay

EVAL_DIR = run_eval.EVAL_DIR
FIELDS = (
    "night", "approval_requests", "accuracy", "agreement", "leaks", "kept", "seconds",
    "wanted_requests", "unneeded_requests", "day_mix", *(f"acc_{d}" for d in DECISIONS),
    "day_leaks", "user_rules", "practice_rules", "gate_rerun",
    "missed_asks", "refuse_shared", "day_missed_asks", "day_refuse_shared",
    "late_answers", "unanswered", "undone", "persona",
)  # fmt: skip
SHARED = ("share_tagged", "share_summary")
UNSEEN_N = 100
# Ids the request-topic check scored while its descriptions were written: not unseen for that pass.
TOPIC_CHECK_GLOB = "request_topics*.jsonl"
# The simulation never trains anything off the device: the lora backend writes training data for
# a cloud job, so a simulated night only runs the rules or prompt backends.
DREAMING_BACKENDS = ("rules", "prompt")


def pick_items(items: list[dict], day: int, per_day: int, *, mix: str = "even", seed: int = 0) -> list[dict]:
    """Day `day` (from 1) takes `per_day` items. With mix "even" they are dealt round robin over
    the expected decisions so each day covers every decision; each decision's items are walked
    once per cycle, each cycle in its own seeded shuffle. With "natural" the whole pool is walked
    once per cycle in a seeded shuffle, so a day has the pool's own mix. `seed` 0 keeps the
    original shuffles. Same inputs, same picks."""
    if mix == "natural":
        picks = []
        for slot in range((day - 1) * per_day, day * per_day):
            cycle, index = divmod(slot, len(items))
            order = list(range(len(items)))
            random.Random(f"{seed}:natural:{cycle}").shuffle(order)
            picks.append(items[order[index]])
        return picks
    groups: dict = {}
    for item in items:
        groups.setdefault(item.get("expected"), []).append(item)
    keys = sorted(groups, key=lambda k: (DECISIONS.index(k) if k in DECISIONS else len(DECISIONS), str(k)))
    picks = []
    for slot in range((day - 1) * per_day, day * per_day):
        key = keys[slot % len(keys)]
        group = groups[key]
        cycle, index = divmod(slot // len(keys), len(group))
        order = list(range(len(group)))
        random.Random(f"{1000 + cycle}:{key}" if not seed else f"{seed}:{1000 + cycle}:{key}").shuffle(order)
        picks.append(group[order[index]])
    return picks


def sample_unseen(items: list[dict], n: int, seed: int, exclude: set[str] = frozenset()) -> list[dict]:
    """`n` items drawn with `seed`, leaving out `exclude`: an equal share per expected decision as
    far as the set allows (a decision with too few items leaves its share to the others), in file
    order. Same inputs, same sample."""
    groups: dict = {}
    for item in items:
        if item["id"] not in exclude:
            groups.setdefault(item.get("expected"), []).append(item)
    keys = sorted(groups, key=lambda k: (DECISIONS.index(k) if k in DECISIONS else len(DECISIONS), str(k)))
    for key in keys:
        random.Random(f"{seed}:{key}").shuffle(groups[key])
    picked: set[str] = set()
    while len(picked) < n and any(groups[k] for k in keys):
        for key in keys:
            if len(picked) < n and groups[key]:
                picked.add(groups[key].pop()["id"])  # round robin, one per decision at a time
    return [i for i in items if i["id"] in picked]


def ids_in(paths: list[Path]) -> set[str]:
    """Every item id in these JSONL files (missing files count as empty)."""
    return {str(i["id"]) for p in paths if Path(p).is_file() for i in run_eval.load_items(p) if "id" in i}


def score_unseen(
    settings, items: list[dict], home: Path, raw_dir: Path | None = None, controls_path: Path | None = None
) -> list[dict]:
    """Score the night-0 router (no learned rules) and the rules in place in `home` once each on
    `items`, with production inputs and the persona's toggles (`controls_path`). When no night
    kept rules, the router after the last night is the night-0 router, so it is not scored again.
    Writes each run's raw rows to `raw_dir`."""
    rules = run_eval.prepare_home(settings, home).paths.router_prompt
    kw = {"controls_path": controls_path}
    first = run_eval.evaluate(settings, items, rules_path=None, name="unseen-night-0", **kw)
    last = (
        run_eval.evaluate(settings, items, rules_path=rules, name="unseen-last-night", **kw) if rules.is_file() else None
    )
    out = [_unseen_row("Night 0, no learned rules", first)]
    if last is None:
        out.append(_unseen_row("After the last night: no rules kept, so the night-0 router (not scored again)", first))
    else:
        out.append(_unseen_row(f"After the last night, {run_eval.describe_rules(rules)}", last))
    if raw_dir is not None:
        Path(raw_dir).mkdir(parents=True, exist_ok=True)
        for report in filter(None, (first, last)):
            run_eval.write_raw_rows(report, Path(raw_dir) / f"{report.name}.jsonl")
    return out


def run_day(
    services,
    items: list[dict],
    day: int,
    per_day: int,
    persona: Persona | None = None,
    *,
    mix: str = "even",
    seed: int = 0,
    ledger: Path | None = None,
) -> dict:
    """Release the day's items; the persona (default: the policy's own answers) answers each
    approval request, now, after tonight's dreaming (returned in "late") or never.

    Every text Muse would get that day is leak-checked, including what an approval releases, and
    each one's hash goes in the `ledger` (scripts/audit_replay.py). The morning starts with the
    persona deleting the remembered answers it changed its mind about (undo_p). Returns the
    request counts (all, wanted, unneeded), the day's leaks, the items shared that the policy
    wants asked about (missed) or refused (refuse_shared), late and unanswered cards, undone
    answers and its mix of expected decisions.
    """
    persona = persona or Persona.from_policy(services.policy)
    asked = wanted = leaks = missed = refuse_shared = unanswered = 0
    undone = undo_answers(services, persona, day)
    late: list[tuple[dict, int, object]] = []
    picks = pick_items(items, day, per_day, mix=mix, seed=seed)
    roster_values = run_eval._roster_values(getattr(services, "roster", None))
    for item in picks:
        before = _newest_row(services)
        released = run_eval.release_item(services, item, tool="simulation", day=day)
        row = released.approval_id if released.approval_id is not None else _newest_row(services)
        audit_replay.record(ledger, row if row != before else None, released.status, released.text)
        if getattr(released.decision, "decision", None) in SHARED:
            wants = services.policy.wants(item)
            missed += wants == "ask_user"
            refuse_shared += wants == "refuse"
        texts = [released.text or ""]
        if released.status == "waiting" and released.approval_id is not None:
            asked += 1
            wanted += services.policy.wants(item) == "ask_user"
            answer = persona.answer(item, day)
            if answer.when == NOW:
                texts += answer_card(services, released.approval_id, answer, ledger)
            elif answer.when == LATE:
                late.append((item, released.approval_id, answer))
            else:  # NEVER: the card stays waiting
                unanswered += 1
        leaks += any(run_eval.find_leaks(services, t, item, roster_values) for t in texts)
    counts = Counter(i.get("expected") for i in picks)
    day_mix = " ".join(f"{d}:{counts[d]}" for d in DECISIONS if counts[d])
    return {
        "asked": asked, "wanted": wanted, "unneeded": asked - wanted, "day_mix": day_mix, "leaks": leaks,
        "missed": missed, "refuse_shared": refuse_shared, "late": late, "unanswered": unanswered,
        "undone": undone,
    }  # fmt: skip


def answer_card(services, approval_id: int, answer, ledger: Path | None = None) -> list[str]:
    """Record the persona's answer on a waiting card and return what Muse then gets for it."""
    services.approvals.decide(approval_id, answer.approve, answer.remember, by="policy_sim")
    resolve = getattr(services.egress, "resolve", None)
    if not callable(resolve):
        return []
    released = resolve(approval_id)
    audit_replay.record(ledger, approval_id, released.status, released.text, via="resolve")
    return [released.text or ""]


def answer_late(services, late: list, ledger: Path | None = None) -> int:
    """Answer the cards left from the day before tonight's dreaming (so they train the next
    night). Returns how many items leaked in what those answers released."""
    roster_values = run_eval._roster_values(getattr(services, "roster", None))
    leaks = 0
    for item, approval_id, answer in late:
        texts = answer_card(services, approval_id, answer, ledger)
        leaks += any(run_eval.find_leaks(services, t, item, roster_values) for t in texts)
    return leaks


def undo_answers(services, persona: Persona, day: int) -> int:
    """The persona deletes some of yesterday's remembered answers (undo_p), as on the History page.
    Returns how many."""
    if persona.undo_p <= 0 or day <= 1:
        return 0
    rows = services.approvals.training_rows()
    gone = [
        r["id"] for r in rows
        if r.get("decided_by") == "policy_sim" and r.get("remember") and r.get("day") == day - 1 and persona.undoes(r["id"])
    ]  # fmt: skip
    for row_id in gone:
        services.approvals.delete(row_id)
    return len(gone)


def _newest_row(services) -> int | None:
    """The id of the newest decision row, to tell which row a release wrote (None without one)."""
    history = getattr(services.approvals, "history", None)
    rows = history(limit=1) if callable(history) else []
    return rows[0]["id"] if rows else None


def rule_counts(settings) -> tuple[int, int]:
    """(rules learned from the teacher's answers, practice-default rules) in the rules file in place."""
    from base.dreaming import train

    path = settings.paths.router_prompt
    rules = train.read_rules(path.read_text()) if path.is_file() else []
    user = sum(r.source == "user" for r in rules)
    return user, len(rules) - user


def simulate(
    settings,
    *,
    nights: int,
    per_day: int,
    home: Path,
    tasks_path: Path,
    holdout_path: Path,
    synthetic_path: Path | None,
    raw_dir: Path | None = None,
    exclude_ids: set[str] = frozenset(),
    persona: Persona | None = None,
    mix: str = "even",
    seed: int = 0,
) -> list[dict]:
    """Night 0, then `nights` days and nights. `exclude_ids` (the unseen test sample) are never
    trained on, even when the practice data contains them. A persona's toggles are written into
    `home` (and copied into every home the holdout is scored in); its cards left for later are
    answered after each night; every text Muse gets is hashed into home/received.jsonl."""
    items = run_eval.load_items(tasks_path)
    holdout = run_eval.load_items(holdout_path)
    holdout_ids = {i["id"] for i in holdout}
    day_items = [i for i in items if i["id"] not in holdout_ids]
    if not day_items or not holdout:
        raise SystemExit("Need non-holdout items in --tasks and items in --holdout.")

    controls_path = write_toggles(settings, home, persona.toggles if persona else ())
    services = run_eval.services_for(settings, home)
    sim_settings = services.settings
    ledger = sim_settings.home / audit_replay.LEDGER
    label = f"{persona.id if persona else 'policy'} (simulated)"
    started = time.monotonic()
    baseline = run_eval.evaluate(sim_settings, holdout, rules_path=None, name="night-0", controls_path=controls_path)
    rows = [
        _row(0, "", baseline.accuracy, baseline.agreement, baseline.leaks, "", time.monotonic() - started)
        | {"missed_asks": baseline.missed_asks, "refuse_shared": baseline.refuse_shared, "persona": label}
        | _categories(baseline.category_accuracy())
    ]
    for night in range(1, nights + 1):
        day = run_day(services, day_items, night, per_day, persona, mix=mix, seed=seed, ledger=ledger)
        runner = NightRunner(services, holdout_path=holdout_path, synthetic_path=synthetic_path or "")
        runner.raw_dir = raw_dir
        runner.exclude_ids = set(exclude_ids)
        runner.controls_path = controls_path
        r = runner.run_night()
        accuracy = r.accuracy_after if r.kept else r.accuracy_before
        agreement = r.agreement_after if r.kept else r.agreement_before
        row = _row(night, day["asked"], accuracy, agreement, r.leaks, "yes" if r.kept else "no", r.seconds)
        user_rules, practice_rules = rule_counts(sim_settings)
        _close(services)
        services = run_eval.services_for(settings, home)  # fresh services pick up the kept rules
        late_leaks = answer_late(services, day["late"], ledger)  # after the night, so they train the next one
        row |= {
            "wanted_requests": day["wanted"],
            "unneeded_requests": day["unneeded"],
            "day_mix": day["day_mix"],
            "day_leaks": day["leaks"] + late_leaks,
            "user_rules": user_rules,
            "practice_rules": practice_rules,
            "gate_rerun": _blank(getattr(r, "gate_rerun", None)),
            "missed_asks": getattr(r, "missed_asks", ""),
            "refuse_shared": getattr(r, "refuse_shared", ""),
            "day_missed_asks": day["missed"],
            "day_refuse_shared": day["refuse_shared"],
            "late_answers": len(day["late"]),
            "unanswered": day["unanswered"],
            "undone": day["undone"],
            "persona": label,
        }
        rows.append(row | _categories(getattr(r, "categories", None) or {}))
    _close(services)
    return rows


def write_toggles(settings, home: Path, toggles) -> Path | None:
    """Turn the persona's privacy toggles on in the simulated home (its privacy_controls.json) and
    return that file, which every scoring home copies; None when there are none."""
    if not toggles:
        return None
    if not getattr(settings, "device_only", False):
        raise SystemExit("A persona's privacy toggles need DEVICE_ONLY=1, as on a real device.")
    paths = run_eval.prepare_home(settings, home).paths
    ControlStore(paths.controls).save(Controls(profiles=list(toggles)))
    return paths.controls


def write_outputs(
    rows: list[dict],
    out_dir: Path,
    *,
    command: str,
    settings,
    items: int,
    holdout: int,
    practice: str = "none (learning only from the simulated teacher's answers)",
    unseen: list[dict] = (),
    unseen_note: str = "",
    persona: Persona | None = None,
    mix: str = "even",
    seed: int = 0,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "nights.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, restval="")
        writer.writeheader()
        writer.writerows(rows)
    who = [
        f"| Persona | {persona.name} ({run_eval.display_path(persona.path) if persona.path else persona.id}) |",
        f"| Habits | {persona.describe()} |",
        f"| Toggles | {', '.join(persona.toggles) or 'none'} |",
    ] if persona else []  # fmt: skip
    dealt = (
        "Each day's items are dealt in the pool's own mix of expected decisions (--mix natural)."
        if mix == "natural"
        else "Each day's items are dealt evenly over the four expected decisions."
    )
    lines = [
        "# Nights of dreaming (simulated)",
        "",
        f"Command: `{command}`",
        "",
        "| Field | Value |",
        "|---|---|",
        f"| Device | {settings.device} |",
        f"| Backend | {settings.glimmer_backend} |",
        f"| Model | {settings.router_model} |",
        f"| Dreaming backend | {settings.dreaming_backend} |",
        f"| Router changes (ROUTER_LOOSEN) | {', '.join(sorted(getattr(settings, 'router_loosen', ()) or ())) or 'none'} |",
        "| Waiting-card cap (MAX_PENDING) | off in this simulated run: its cards stay unanswered on purpose |",
        f"| Date | {datetime.now().strftime('%Y-%m-%d %H:%M')} |",
        f"| Day items | {items} (holdout excluded) |",
        f"| Holdout items | {holdout} |",
        f"| Practice data | {practice} |",
        *who,
        f"| Day mix and seed | {mix}, seed {seed} |",
        "| Router inputs | as the connector sends them (eval/run_eval.py production_labels: the kind and job "
        "topics follow the agent's own trigger, a grading word in the request, never the hand labels; plus "
        "the topics egress finds) |",
        "",
        "Every item is invented, and the user is simulated: a policy file with seeded habits"
        + (" (eval/persona.py), not a person." if persona else ", not a person."),
        "",
        (
            "Each day the simulated persona answers the approval requests as its habits say (some late, some"
            " never). Each night the router learns"
            if persona
            else "Each day the simulated teacher answers every approval request. Each night the router learns"
        ),
        "from those answers and is scored on the holdout items, which it never trains on. Approval",
        "requests are for the day before each night; accuracy, agreement and leaks are for the rules",
        "in place after it. Night 0 is the router with no learned rules.",
        "",
        "The holdout is never trained on, but it is selected on: the dreaming gate scores the current",
        "rules on these same items, re-runs the new rules only on the items whose learned rules differ",
        "(the rest reuse the current rules' run), and keeps the new rules when they are no worse. Treat",
        "night-over-night gains as an upper bound; the unseen test below is the number the gate never saw.",
        "Day leaks count every text Muse would get that day, including what an approval releases.",
        "",
        f"{dealt} Wanted requests are",
        "items the teacher's policy says to ask about; unneeded ones are items it would have shared",
        "or refused without asking. Only unneeded requests can go away with learning.",
        "",
        "| Night | Approval requests that day | Accuracy | Agreement | Leaks | Kept | Seconds | Wanted | Unneeded "
        "| Day leaks | Rules from answers | Practice rules |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['night']} | {_dash(r['approval_requests'])} "
            f"| {float(r['accuracy']) * 100:.1f}% | {float(r['agreement']) * 100:.1f}% | {r['leaks']} "
            f"| {r['kept'] or '-'} | {r['seconds']} "
            f"| {_dash(r.get('wanted_requests', ''))} | {_dash(r.get('unneeded_requests', ''))} "
            f"| {_dash(r.get('day_leaks', ''))} | {_dash(r.get('user_rules', ''))} | {_dash(r.get('practice_rules', ''))} |"
        )
    if any(r.get("missed_asks", "") != "" for r in rows):
        lines += [
            "",
            "Shared when the teacher's policy wanted an ask (missed asks) or a refusal (refusals shared). "
            "The leak count cannot see these, so a drop in approval requests only counts while both stay at 0:",
            "",
            "| Night | Day missed asks | Day refusals shared | Holdout missed asks | Holdout refusals shared |",
            "|---|---|---|---|---|",
        ]
        for r in rows:
            lines.append(
                f"| {r['night']} | {_dash(r.get('day_missed_asks', ''))} | {_dash(r.get('day_refuse_shared', ''))} "
                f"| {_dash(r.get('missed_asks', ''))} | {_dash(r.get('refuse_shared', ''))} |"
            )
    habits = ("late_answers", "unanswered", "undone")
    if any(r.get(k) not in ("", None, 0) for r in rows for k in habits):
        lines += [
            "",
            "Cards the simulated persona answered after that night's dreaming (they train the next night), "
            "never answered, and remembered answers it deleted the next morning:",
            "",
            "| Night | Answered late | Never answered | Deleted next morning |",
            "|---|---|---|---|",
        ]
        lines += [f"| {r['night']} | " + " | ".join(_dash(r.get(k, "")) for k in habits) + " |" for r in rows]
    cats = [d for d in DECISIONS if any(r.get(f"acc_{d}", "") != "" for r in rows)]
    if cats:
        lines += [
            "",
            "Holdout accuracy by expected decision, for the rules in place after each night:",
            "",
            "| Night | " + " | ".join(cats) + " |",
            "|---|" + "---|" * len(cats),
        ]
        for r in rows:
            cells = [_pct_cell(r.get(f"acc_{d}", "")) for d in cats]
            lines.append(f"| {r['night']} | " + " | ".join(cells) + " |")
    mixes = [(r["night"], r.get("day_mix", "")) for r in rows if r.get("day_mix")]
    if mixes:
        lines += [
            "",
            "Items per expected decision each day: " + "; ".join(f"day {n} {m}" for n, m in mixes) + ".",
        ]
    reruns = [(r["night"], r.get("gate_rerun", "")) for r in rows if r.get("gate_rerun", "") != ""]
    if reruns:
        lines += [
            "",
            "Holdout items the gate re-ran on each night's new rules (the rest reuse the current rules' run): "
            + "; ".join(f"night {n} {k} of {holdout}" for n, k in reruns)
            + ".",
        ]
    lines += unseen_table(unseen, unseen_note)
    (out_dir / "nights.md").write_text("\n".join(lines) + "\n")


def unseen_note(
    sample: list[dict],
    path: Path | None,
    seed: int,
    exclude_files: list[Path],
    left_out: int,
    labeler: str = "the simulated teacher's own policy",
) -> str:
    """One paragraph saying where the unseen test items came from and what they never touched."""
    if not sample:
        return ""
    mix = Counter(i.get("expected") for i in sample)
    files = ", ".join(run_eval.display_path(f) for f in exclude_files)
    return (
        f"{len(sample)} items from {run_eval.display_path(path)}, drawn with seed {seed} "
        f"({' '.join(f'{d}:{mix[d]}' for d in DECISIONS if mix[d])}), leaving out the eval tasks, the holdout"
        + (f" and the {left_out} ids in {files}" if files else "")
        + ". The days, the gate and dreaming never use them, and they are left out of practice data too. "
        "Production inputs, as for the holdout. Each router is scored once. The items are invented (eval/DATASET.md "
        f"says who wrote each set) and labeled with {labeler}."
    )


def unseen_table(rows: list[dict], note: str = "") -> list[str]:
    """The unseen test as markdown lines (none when it did not run)."""
    if not rows:
        return []
    lines = [
        "",
        "## Unseen test",
        "",
        *([note, ""] if note else []),
        "| Router | Items | Accuracy | Agreement | Approval requests | Unneeded asks | Leaks | Missed asks "
        "| Refusals shared | Errors or fallbacks | " + " | ".join(DECISIONS) + " |",
        "|---|---|---|---|---|---|---|---|---|---|" + "---|" * len(DECISIONS),
    ]
    for r in rows:
        cells = [_pct_cell(r.get(f"acc_{d}", "")) for d in DECISIONS]
        lines.append(
            f"| {r['router']} | {r['n']} | {float(r['accuracy']) * 100:.1f}% | {float(r['agreement']) * 100:.1f}% "
            f"| {r['approval_requests']} | {_dash(r.get('unneeded_requests'))} | {r['leaks']} | {_dash(r.get('missed_asks'))} "
            f"| {_dash(r.get('refuse_shared'))} | {r['unscored']} | " + " | ".join(cells) + " |"
        )
    return lines


def format_table(rows: list[dict]) -> str:
    out = [f"{'night':>5} {'asked':>5} {'accuracy':>8} {'agree':>6} {'leaks':>5} {'kept':>4} {'sec':>6}"]
    for r in rows:
        asked = "-" if r["approval_requests"] == "" else str(r["approval_requests"])
        out.append(
            f"{r['night']:>5} {asked:>5} {float(r['accuracy']) * 100:>7.1f}% "
            f"{float(r['agreement']) * 100:>5.1f}% {r['leaks']:>5} {r['kept'] or '-':>4} {r['seconds']:>6}"
        )
    return "\n".join(out)


def main(argv: list[str] | None = None, settings=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    p = argparse.ArgumentParser(prog="python -m scripts.simulate_nights", description=__doc__.split("\n")[0])
    p.add_argument("--nights", type=int, default=5)
    p.add_argument("--per-day", type=int, default=20)
    p.add_argument("--home", type=Path, help="empty folder to keep the simulated device home in")
    p.add_argument("--tasks", type=Path, default=EVAL_DIR / "tasks.jsonl")
    p.add_argument("--holdout", type=Path, default=EVAL_DIR / "holdout.jsonl")
    p.add_argument(
        "--synthetic",
        default="none",
        help="practice data for dreaming, or none (the default). eval/synthetic.jsonl is labeled with the "
        "simulated teacher's own policy, so a run with it is an ablation, not learning from her answers",
    )
    p.add_argument("--out", type=Path, default=run_eval.REPORTS_DIR)
    p.add_argument(
        "--unseen",
        default=str(EVAL_DIR / "synthetic.jsonl"),
        help="items for the unseen test, which the days, the gate and dreaming never use, or none",
    )
    p.add_argument("--unseen-n", type=int, default=UNSEEN_N, help="unseen test sample size (default 100)")
    p.add_argument("--unseen-seed", type=int, default=0, help="seed of the unseen test sample")
    p.add_argument(
        "--unseen-exclude",
        nargs="+",
        help="JSONL files whose ids the unseen sample leaves out, or none "
        f"(default: eval/reports/raw/{TOPIC_CHECK_GLOB}, the request-topic check's samples)",
    )
    p.add_argument("--persona", type=Path, help="a simulated persona (eval/personas/<id>/persona.yaml)")
    p.add_argument("--mix", choices=("even", "natural"), help="how each day's items are dealt (default: the persona's, else even)")
    p.add_argument("--seed", type=int, help="replaces the persona's seed (answers) and reshuffles the days")
    args = p.parse_args(argv)
    if args.home and args.home.exists() and any(args.home.iterdir()):
        p.error("--home must be an empty or new folder, so the simulation starts fresh")
    unseen_path = None if str(args.unseen).lower() == "none" else Path(args.unseen)
    if unseen_path is not None and not unseen_path.is_file():
        p.error(f"no unseen test items at {args.unseen}")
    try:
        persona = Persona.load(args.persona) if args.persona else None
    except (PersonaError, ValueError) as exc:
        p.error(str(exc))
    seed = args.seed if args.seed is not None else (persona.seed if persona else 0)
    mix = args.mix or (persona.mix if persona else "even")
    if persona is not None:
        persona = persona.with_seed(seed)

    settings = settings or load_settings()
    if settings.dreaming_backend not in DREAMING_BACKENDS:
        p.error(f"DREAMING_BACKEND={settings.dreaming_backend}: a simulation runs only {' or '.join(DREAMING_BACKENDS)}")
    if persona is not None:  # the persona's policy labels, routes and answers; its roster, if it has one
        settings = replace(
            settings, policy_path=persona.policy_path, roster_path=persona.roster_path or settings.roster_path
        )
    synthetic = None if str(args.synthetic).lower() == "none" else Path(args.synthetic)
    command = run_eval.command_line("scripts.simulate_nights", argv)
    tasks, holdout = run_eval.load_items(args.tasks), run_eval.load_items(args.holdout)
    holdout_ids = {i["id"] for i in holdout}
    if args.unseen_exclude is None:
        exclude_files = sorted((run_eval.REPORTS_DIR / "raw").glob(TOPIC_CHECK_GLOB))
    elif [a.lower() for a in args.unseen_exclude] == ["none"]:
        exclude_files = []
    else:
        exclude_files = [Path(a) for a in args.unseen_exclude]
    left_out = ids_in(exclude_files)
    known = {str(i["id"]) for i in tasks + holdout}
    sample = (
        sample_unseen(run_eval.load_items(unseen_path), args.unseen_n, args.unseen_seed, known | left_out)
        if unseen_path is not None
        else []
    )
    with tempfile.TemporaryDirectory(prefix="base-sim-") as tmp:
        home = args.home or Path(tmp) / "home"
        rows = simulate(
            settings,
            nights=args.nights,
            per_day=args.per_day,
            home=home,
            tasks_path=args.tasks,
            holdout_path=args.holdout,
            synthetic_path=synthetic,
            raw_dir=args.out / "raw" / "nights",
            exclude_ids={i["id"] for i in sample},
            persona=persona,
            mix=mix,
            seed=seed,
        )
        sim = run_eval.prepare_home(settings, home)
        controls = sim.paths.controls if persona is not None and persona.toggles else None
        unseen = (
            score_unseen(settings, sample, home, raw_dir=args.out / "raw" / "nights", controls_path=controls)
            if sample
            else []
        )
        receipts = audit_replay.audit(
            sim, toggles=persona.toggles if persona else (), ledger=sim.home / audit_replay.LEDGER
        )
    day_n = sum(1 for i in tasks if i["id"] not in holdout_ids)
    who = "the simulated persona's" if persona else "the simulated teacher's"
    practice = (
        f"none (learning only from {who} answers)"
        if synthetic is None
        else f"{run_eval.display_path(synthetic)} (labeled with the teacher's own policy: an ablation)"
    )
    labeler = f"the persona's own policy ({persona.id})" if persona else "the simulated teacher's own policy"
    note = unseen_note(sample, unseen_path, args.unseen_seed, exclude_files, len(left_out), labeler)
    write_outputs(
        rows, args.out, command=command, settings=settings, items=day_n, holdout=len(holdout_ids), practice=practice,
        unseen=unseen, unseen_note=note, persona=persona, mix=mix, seed=seed,
    )  # fmt: skip
    (args.out / "receipts.md").write_text(
        audit_replay.render(receipts, command=command, persona=persona, toggles=persona.toggles if persona else ())
    )
    mark_simulated(args.out / "raw" / "nights")
    print(format_table(rows))
    print(f"Receipt mismatches: {receipts.mismatches}")
    print(f"Wrote nights.csv, nights.md and receipts.md in {run_eval.display_path(args.out)}")
    return 0


def mark_simulated(raw_dir: Path) -> None:
    """Add "simulated": true to every raw row the run wrote, so no file in a report folder can be
    read as a real user's (tests/test_sim_honesty.py)."""
    for path in sorted(Path(raw_dir).glob("*.jsonl")) if Path(raw_dir).is_dir() else []:
        rows = run_eval.load_items(path)
        path.write_text("".join(json.dumps(r | {"simulated": True}) + "\n" for r in rows))


def _row(night, asked, accuracy, agreement, leaks, kept, seconds) -> dict:
    return {
        "night": night,
        "approval_requests": asked,
        "accuracy": round(accuracy, 4),
        "agreement": round(agreement, 4),
        "leaks": leaks,
        "kept": kept,
        "seconds": round(seconds, 1),
        "wanted_requests": "",
        "unneeded_requests": "",
        "day_mix": "",
        "day_leaks": "",
        "user_rules": "",
        "practice_rules": "",
        "gate_rerun": "",
        "missed_asks": "",
        "refuse_shared": "",
        "day_missed_asks": "",
        "day_refuse_shared": "",
        "late_answers": "",
        "unanswered": "",
        "undone": "",
        "persona": "",
    }


def _categories(accuracy: dict) -> dict:
    return {f"acc_{d}": round(accuracy[d], 4) if d in accuracy else "" for d in DECISIONS}


def _unseen_row(label: str, r: run_eval.EvalReport) -> dict:
    """Aggregate numbers only for one unseen-test run."""
    return {
        "router": label,
        "n": r.n,
        "accuracy": r.accuracy,
        "agreement": r.agreement,
        "approval_requests": r.approval_requests,
        # asks on items the policy would have shared or refused: the ones learning can remove
        "unneeded_requests": sum(c.get("approval_requests", 0) for d, c in r.categories.items() if d != "ask_user"),
        "leaks": r.leaks,
        "missed_asks": r.missed_asks,
        "refuse_shared": r.refuse_shared,
        "unscored": r.errors + r.fallbacks,
    } | _categories(r.category_accuracy())


def _blank(value) -> object:
    return "" if value is None else value


def _dash(value) -> str:
    return "-" if value == "" or value is None else str(value)


def _pct_cell(value) -> str:
    return "-" if value == "" or value is None else f"{float(value) * 100:.0f}%"


def _close(services) -> None:
    close = getattr(services, "close", None)
    if callable(close):
        close()


if __name__ == "__main__":
    raise SystemExit(main())
