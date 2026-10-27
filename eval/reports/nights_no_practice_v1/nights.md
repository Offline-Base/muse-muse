# Nights of dreaming (simulated)

Command: `uv run python -m scripts.simulate_nights --nights 5 --per-day 20 --synthetic none --home eval/.cache/sim_nopractice_home --out eval/reports/nights_no_practice`

| Field | Value |
|---|---|
| Device | laptop |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Dreaming backend | prompt |
| Date | 2026-10-27 03:24 |
| Day items | 80 (holdout excluded) |
| Holdout items | 20 |

Each day the simulated teacher answers every approval request. Each night the router learns
from those answers and is scored on the holdout items, which it never trains on. Approval
requests are for the day before each night; accuracy, agreement and leaks are for the rules
in place after it. Night 0 is the router with no learned rules.

Each day's items are dealt evenly over the four expected decisions. Wanted requests are
items the teacher's policy says to ask about; unneeded ones are items it would have shared
or refused without asking. Only unneeded requests can go away with learning.

| Night | Approval requests that day | Accuracy | Agreement | Leaks | Kept | Seconds | Wanted | Unneeded |
|---|---|---|---|---|---|---|---|---|
| 0 | - | 80.0% | 80.0% | 0 | - | 61.9 | - | - |
| 1 | 10 | 95.0% | 95.0% | 0 | yes | 132.2 | 5 | 5 |
| 2 | 6 | 95.0% | 95.0% | 0 | yes | 138.2 | 5 | 1 |
| 3 | 7 | 100.0% | 100.0% | 0 | yes | 137.5 | 5 | 2 |
| 4 | 6 | 100.0% | 100.0% | 0 | yes | 131.6 | 5 | 1 |
| 5 | 5 | 100.0% | 100.0% | 0 | yes | 116.9 | 5 | 0 |

Holdout accuracy by expected decision, for the rules in place after each night:

| Night | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| 0 | 20% | 100% | 100% | 100% |
| 1 | 80% | 100% | 100% | 100% |
| 2 | 80% | 100% | 100% | 100% |
| 3 | 100% | 100% | 100% | 100% |
| 4 | 100% | 100% | 100% | 100% |
| 5 | 100% | 100% | 100% | 100% |

Items per expected decision each day: day 1 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 2 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 3 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 4 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 5 share_tagged:5 share_summary:5 ask_user:5 refuse:5.
