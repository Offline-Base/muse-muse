# Nights of dreaming (simulated)

Command: `uv run python -m scripts.simulate_nights --persona eval/personas/strict_teacher/persona.yaml --seed 101 --nights 1 --per-day 10 --tasks eval/personas/strict_teacher/days.jsonl --holdout eval/personas/strict_teacher/holdout.jsonl --unseen eval/personas/strict_teacher/unseen.jsonl --home /var/folders/hq/4lxx9jy977lg_xvw20bhjs8c0000gn/T/pzh.kfHWUA9yrP --out eval/reports/sim/smoke/strict_teacher`

| Field | Value |
|---|---|
| Device | laptop |
| Backend | llama_server |
| Model | lfm3-vl-2b |
| Dreaming backend | rules |
| Router changes (ROUTER_LOOSEN) | lists, result_words |
| Date | 2026-10-31 02:44 |
| Day items | 800 (holdout excluded) |
| Holdout items | 80 |
| Practice data | none (learning only from the simulated persona's answers) |
| Persona | Simulated strict 4th-grade teacher (invented) (eval/personas/strict_teacher/persona.yaml) |
| Habits | flip 0; forget remember 0; late 0; never answers 0; undo 0; 15 s per card |
| Toggles | none |
| Day mix and seed | natural, seed 101 |
| Router inputs | as the connector sends them (eval/run_eval.py production_labels: the kind and job topics follow the agent's own trigger, a grading word in the request, never the hand labels; plus the topics egress finds) |

Every item is invented, and the user is simulated: a policy file with seeded habits (eval/persona.py), not a person.

Each day the simulated persona answers the approval requests as its habits say (some late, some never). Each night the router learns
from those answers and is scored on the holdout items, which it never trains on. Approval
requests are for the day before each night; accuracy, agreement and leaks are for the rules
in place after it. Night 0 is the router with no learned rules.

The holdout is never trained on, but it is selected on: the dreaming gate scores the current
rules on these same items, re-runs the new rules only on the items whose learned rules differ
(the rest reuse the current rules' run), and keeps the new rules when they are no worse. Treat
night-over-night gains as an upper bound; the unseen test below is the number the gate never saw.
Day leaks count every text Muse would get that day, including what an approval releases.

Each day's items are dealt in the pool's own mix of expected decisions (--mix natural). Wanted requests are
items the teacher's policy says to ask about; unneeded ones are items it would have shared
or refused without asking. Only unneeded requests can go away with learning.

| Night | Approval requests that day | Accuracy | Agreement | Leaks | Kept | Seconds | Wanted | Unneeded | Day leaks | Rules from answers | Practice rules |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | - | 90.0% | 90.0% | 0 | - | 28.9 | - | - | - | - | - |
| 1 | 3 | 90.0% | 90.0% | 0 | yes | 28.8 | 2 | 1 | 0 | 0 | 0 |

Shared when the teacher's policy wanted an ask (missed asks) or a refusal (refusals shared). The leak count cannot see these, so a drop in approval requests only counts while both stay at 0:

| Night | Day missed asks | Day refusals shared | Holdout missed asks | Holdout refusals shared |
|---|---|---|---|---|
| 0 | - | - | 0 | 0 |
| 1 | 0 | 0 | 0 | 0 |

Holdout accuracy by expected decision, for the rules in place after each night:

| Night | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| 0 | 75% | 95% | 90% | 100% |
| 1 | 75% | 95% | 90% | 100% |

Items per expected decision each day: day 1 share_tagged:2 share_summary:4 ask_user:2 refuse:2.

Holdout items the gate re-ran on each night's new rules (the rest reuse the current rules' run): night 1 0 of 80.

## Unseen test

100 items from eval/personas/strict_teacher/unseen.jsonl, drawn with seed 0 (share_tagged:25 share_summary:25 ask_user:25 refuse:25), leaving out the eval tasks, the holdout and the 420 ids in eval/reports/raw/request_topics.jsonl, eval/reports/raw/request_topics_tuning.jsonl. The days, the gate and dreaming never use them, and they are left out of practice data too. Production inputs, as for the holdout. Each router is scored once. The items are invented (eval/DATASET.md says who wrote each set) and labeled with the persona's own policy (strict_teacher).

| Router | Items | Accuracy | Agreement | Approval requests | Unneeded asks | Leaks | Missed asks | Refusals shared | Errors or fallbacks | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Night 0, no learned rules | 100 | 79.0% | 79.0% | 36 | 14 | 0 | 2 | 0 | 0 | 60% | 72% | 88% | 96% |
| After the last night, router_rules.md (0 rules) | 100 | 79.0% | 79.0% | 37 | 14 | 0 | 2 | 0 | 0 | 60% | 68% | 92% | 96% |
