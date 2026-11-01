# Nights of dreaming (simulated)

Command: `uv run python -m scripts.simulate_nights --nights 5 --per-day 20 --home <empty folder> --out eval/reports/final`

| Field | Value |
|---|---|
| Device | laptop |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Dreaming backend | prompt |
| Date | 2026-10-27 06:25 |
| Day items | 80 (holdout excluded) |
| Holdout items | 20 |
| Practice data | none (learning only from the simulated teacher's answers) |
| Router inputs | as the connector sends them (no hand-labeled topics; see eval/run_eval.py) |

Each day the simulated teacher answers every approval request. Each night the router learns
from those answers and is scored on the holdout items, which it never trains on. Approval
requests are for the day before each night; accuracy, agreement and leaks are for the rules
in place after it. Night 0 is the router with no learned rules.

The holdout is never trained on, but it is selected on: the dreaming gate scores the current
and the new rules on these same items and keeps the better ones, so each night's number is the
better of two runs on the set that chose it. Treat night-over-night gains as an upper bound.
Day leaks count every text Muse would get that day, including what an approval releases.

Each day's items are dealt evenly over the four expected decisions. Wanted requests are
items the teacher's policy says to ask about; unneeded ones are items it would have shared
or refused without asking. Only unneeded requests can go away with learning.

| Night | Approval requests that day | Accuracy | Agreement | Leaks | Kept | Seconds | Wanted | Unneeded | Day leaks | Rules from answers | Practice rules |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | - | 75.0% | 75.0% | 0 | - | 114.8 | - | - | - | - | - |
| 1 | 11 | 70.0% | 70.0% | 0 | no | 205.1 | 5 | 6 | 0 | 0 | 0 |
| 2 | 12 | 75.0% | 75.0% | 0 | no | 317.8 | 5 | 7 | 0 | 0 | 0 |
| 3 | 9 | 75.0% | 75.0% | 0 | no | 230.7 | 5 | 4 | 0 | 0 | 0 |
| 4 | 8 | 75.0% | 75.0% | 0 | no | 207.2 | 5 | 3 | 0 | 0 | 0 |
| 5 | 10 | 75.0% | 75.0% | 0 | no | 271.4 | 5 | 5 | 1 | 0 | 0 |

Holdout accuracy by expected decision, for the rules in place after each night:

| Night | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| 0 | 20% | 100% | 100% | 80% |
| 1 | 20% | 80% | 100% | 80% |
| 2 | 20% | 100% | 100% | 80% |
| 3 | 20% | 100% | 100% | 80% |
| 4 | 20% | 100% | 100% | 80% |
| 5 | 20% | 100% | 100% | 80% |

Items per expected decision each day: day 1 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 2 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 3 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 4 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 5 share_tagged:5 share_summary:5 ask_user:5 refuse:5.
