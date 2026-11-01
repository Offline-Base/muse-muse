# Nights of dreaming (simulated)

Command: `uv run python -m scripts.simulate_nights --persona eval/personas/privacy_officer/persona.yaml --nights 1 --per-day 10 --tasks eval/tasks.jsonl --holdout eval/holdout.jsonl --unseen none --out eval/reports/sim/smoke/privacy_officer`

| Field | Value |
|---|---|
| Device | laptop |
| Backend | llama_server |
| Model | lfm3-vl-2b |
| Dreaming backend | rules |
| Router changes (ROUTER_LOOSEN) | none |
| Date | 2026-10-30 23:45 |
| Day items | 80 (holdout excluded) |
| Holdout items | 20 |
| Practice data | none (learning only from the simulated persona's answers) |
| Persona | Simulated district privacy reviewer (invented) (eval/personas/privacy_officer/persona.yaml) |
| Habits | flip 0; forget remember 0; late 0; never answers 1; undo 0; 15 s per card |
| Toggles | ferpa, coppa |
| Day mix and seed | natural, seed 105 |
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
| 0 | - | 60.0% | 60.0% | 0 | - | 13.4 | - | - | - | - | - |
| 1 | 3 | 65.0% | 65.0% | 0 | yes | 13.9 | 3 | 0 | 0 | 0 | 0 |

Shared when the teacher's policy wanted an ask (missed asks) or a refusal (refusals shared). The leak count cannot see these, so a drop in approval requests only counts while both stay at 0:

| Night | Day missed asks | Day refusals shared | Holdout missed asks | Holdout refusals shared |
|---|---|---|---|---|
| 0 | - | - | 2 | 1 |
| 1 | 0 | 0 | 2 | 1 |

Cards the simulated persona answered after that night's dreaming (they train the next night), never answered, and remembered answers it deleted the next morning:

| Night | Answered late | Never answered | Deleted next morning |
|---|---|---|---|
| 0 | - | - | - |
| 1 | 0 | 3 | 0 |

Holdout accuracy by expected decision, for the rules in place after each night:

| Night | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| 0 | 100% | 20% | 40% | 80% |
| 1 | 100% | 40% | 40% | 80% |

Items per expected decision each day: day 1 share_tagged:5 share_summary:2 ask_user:3.

Holdout items the gate re-ran on each night's new rules (the rest reuse the current rules' run): night 1 0 of 20.
