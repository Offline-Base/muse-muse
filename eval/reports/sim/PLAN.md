# Simulated persona study: the plan, fixed before any run

Simulated users, invented items. Written on Oct 30, 2026 (ET), before any study run, and committed on the lane/b2-routing branch in the same commit as the persona framework; `git log -- eval/reports/sim/PLAN.md` dates it. No result in this folder existed when it was written. A change to this plan after the first study run is added below the line at the end with its date and reason, and the original text stays.

## The question

Do the device's nightly dreaming rules cut the approval requests a simulated user did not need (unneeded asks), night over night, without sharing anything that user's policy keeps (leaks, missed asks, refusals shared)?

What this cannot show:
- How real people answer. Every persona is a policy file plus seeded habits (eval/persona.py), not a person, and nothing in this folder may be read or quoted as a user's view.
- That the policies are right. Each persona's items are labeled by that persona's own policy, which also answers its cards and routes its results. So the study measures whether the router learns a policy's answers from cards it is shown, and stays careful while doing so; it does not measure agreement with anyone outside the files. Two things lean against the circle: the tired teacher's answers differ from its labeling policy by design (slips, forgotten remember boxes, late answers, deleted answers), and the relaxed teacher's labels differ from the strict teacher's on the same items.
- Time saved. That is a separate model with its own listed assumptions (SIM-9), not part of this plan.
- Anything about Glimmer. The router here is the device-only rules router ("policy decides, LFM labels"): DEVICE_ONLY=1, DREAMING_BACKEND=rules, PRIMARY_MODEL=lfm, LFM3-VL-2B on this laptop for the name, detail and request-topic passes and for summaries. A later run on the about 1.6-bit (IQ1_S) Glimmer file, if there is one, is a separate study.

## Personas (7, all invented)

| Id | Policy | Toggles | Habits (persona.yaml) | What it tests |
|---|---|---|---|---|
| strict_teacher | eval/user_policy.yaml (copy) | none | none | the reference run |
| relaxed_teacher | shares almost everything, sees family notes | none | flip 0.03 | different labels; share rules the strict teacher never gets |
| sped_coordinator | IEP asked first (ask_first) | none | none | the ask_first floor and the request:<topic> path |
| tired_teacher | eval/user_policy.yaml (copy) | none | flip 0.10, forget 0.30, late 0.20, undo 0.05 | learning under noise, late answers, deleted answers |
| privacy_officer | eval/user_policy.yaml (copy) | ferpa, coppa | never answers (ignore 1.0) | receipt audit checklist; asks should stay flat |
| clinic_coordinator | an invented family clinic | hipaa | late 0.10 | a non-school policy; the small-group hold |
| caseworker_cui | refuses everything | cui | none | local-only holds: 0 asks to Muse (SIM-13) |

Every persona assumes 15 seconds per card; that number is an assumption and is used only by the time model.

## Items

- School personas (the first five): eval/sim/days.jsonl, eval/sim/holdout.jsonl and eval/sim/unseen.jsonl, the seeded SIM-1 split of invented items written by Muse Spark, relabeled once per persona with `uv run python -m scripts.relabel_for_persona --persona eval/personas/<id>/persona.yaml`. The split is kept, so every persona's gate scores the same 80 holdout items. That split does not exist yet; the study does not start until it does, and its MANIFEST must show no overlap with the sealed set.
- clinic_coordinator: 80 template items (eval/personas/clinic_coordinator/items.jsonl, `uv run python -m scripts.make_persona_items`), split 48 days, 16 holdout, 16 unseen with seed 0.
- caseworker_cui: 36 template items, split 20 days, 8 holdout, 8 unseen with seed 0.
- The sealed set (fresh_200_c) is never used here, and no persona set may contain one of its ids.

## Design

- Nights: 10 per run. Per day: 30 items. Day mix: natural (each day walks a seeded shuffle of the persona's day items). No practice data (`--synthetic none`).
- Seeds: 3 per persona, fixed now: the persona's own seed s (101 to 107), s + 1000 and s + 2000. `--seed` sets both the persona's answers and the day order. No other seeds will be run or reported as part of this study.
- Unseen test: each persona's unseen.jsonl, scored once with the night-0 router and once with the rules in place after night 10 (`--unseen-n 100`, so the whole set when it is smaller).
- Fixes and learning are reported apart. The router changes that ask less often (ROUTER_LOOSEN: lists, result_words, class_of) are off by default and wait on Ethan's choice. Whatever he turns on is fixed for the whole study and written in every nights.md. The strict teacher then also runs with ROUTER_LOOSEN=none on the same 3 seeds (eval/reports/sim/strict_teacher_nofix/). The change from fixes is the night-0 difference between those two configurations; the change from learning is night 0 to night 10 within one configuration. No chart or sentence may add the two together or credit one to the other.
- Toggle personas: refusals a toggle adds (receipt floors starting with compliance:) are counted on their own, as the toggle's cost, not as router mistakes.

## Metrics, fixed now

Primary, per persona and seed:
1. Unneeded asks on the unseen set, night-0 router against the rules after night 10 (same items, paired). In nights.md's Unseen test table, column "Unneeded asks".

Safety, per persona and seed, each expected to be 0:
2. Leaks: day leaks every day (every text Muse would get, approvals included), holdout leaks every night, unseen leaks before and after.
3. Missed asks and refusals shared: on the days, on the holdout every night, and on the unseen set before and after.
4. Receipt mismatches (receipts.md, scripts/audit_replay.py): every receipt matches its row and what Muse got.

Secondary, reported but not used for any claim on their own:
5. Unneeded asks per day, days 1 to 10 (nights.csv unneeded_requests).
6. Holdout accuracy and agreement per night, nights the gate kept new rules, rules learned from answers.
7. Cards answered late, never answered and deleted (nights.csv late_answers, unanswered, undone).
8. For caseworker_cui: approval requests to Muse (expected 0 every day) and texts that are not a fixed sentence (expected 0).

## How results will be read, fixed now

- Every run of every seed is reported, including stopped ones. Across the 3 seeds the report gives the smallest and largest value; with 3 seeds that range is the interval, and there are no p-values.
- "Dreaming cut unneeded asks" is said for a persona only if metric 1 fell in all 3 seeds and metrics 2 to 4 are 0 in all 3. If it fell in some seeds and not others, the result is called mixed; if it did not fall, flat. Flat and mixed results are published as such.
- "It only gets more careful" is never said if any missed ask or refusal shared is above 0 on any day or night of any seed; the summary then says where.
- The privacy_officer persona never answers, so its asks are expected to stay flat; a fall there would point to a bug, not to learning.

## Stop rule

- Every run is planned for exactly 10 nights. No run is stopped or extended because its numbers look good or bad.
- A run stops, and is reported as stopped with the night and the reason (counts only), when any leak is found, or when more than 10% of a night's holdout items errored or fell back (the model was down) on two nights in a row.
- After a leak, the remaining runs of that persona do not start until the cause is found. Fixing code or data starts a new study with its own plan; the stopped run stays in the report.
- A run stopped for model errors is re-run once from night 0 with the same seed, and both runs are reported.
- No code, policy, persona or item file changes between the first and the last run. The commit (`git rev-parse --short HEAD`) is written in summary.md.

## Order and time

One run at a time through the shared model-slot lock, with a throwaway BASE_HOME, never while filming. Order: seed s of every persona in the table's order, then the fix ablation's first seed, then seeds s + 1000, then s + 2000. If time runs out before Nov 4, the study reports the seeds it has per persona and says how many; nothing is cut after its results are seen. Estimate: 25 to 60 minutes per run.

A short pipeline smoke (1 night, few items, eval/reports/sim/smoke/) may run before the study. It is not a study run, its numbers are not results, and it does not change this plan.

## Commands

```
# Once, after SIM-1 writes eval/sim/ (no model):
uv run python -m scripts.relabel_for_persona --persona eval/personas/<id>/persona.yaml

# Each run, through the model-slot lock, with BASE_HOME set to a new empty temporary folder:
uv run python -m scripts.simulate_nights --persona eval/personas/<id>/persona.yaml --seed <seed> \
    --nights 10 --per-day 30 --tasks eval/personas/<id>/days.jsonl --holdout eval/personas/<id>/holdout.jsonl \
    --unseen eval/personas/<id>/unseen.jsonl --home <new empty folder> --out eval/reports/sim/<id>/seed-<seed>

# The fix ablation, the same with ROUTER_LOOSEN=none and
#     --persona eval/personas/strict_teacher/persona.yaml --out eval/reports/sim/strict_teacher_nofix/seed-<seed>
```

Each run writes nights.md, nights.csv and receipts.md (for the privacy officer, receipts.md also maps each control to the rule it relates to; it makes no finding about any law), plus raw rows under raw/nights/ marked simulated. summary.md and the chart come after the last run (SIM-10).

---

Changes after the first study run: none yet.
