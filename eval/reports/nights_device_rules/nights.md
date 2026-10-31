# Nights of dreaming (simulated)

Command: `uv run python -m scripts.simulate_nights --nights 5 --per-day 20 --out eval/reports/nights_device_rules`

| Field | Value |
|---|---|
| Device | laptop |
| Backend | llama_server |
| Model | lfm3-vl-2b |
| Dreaming backend | rules |
| Date | 2026-10-30 15:16 |
| Day items | 80 (holdout excluded) |
| Holdout items | 20 |
| Practice data | none (learning only from the simulated teacher's answers) |
| Router inputs | as the connector sends them (eval/run_eval.py production_labels: the kind and job topics follow the agent's own trigger, a grading word in the request, never the hand labels; plus the topics egress finds) |

Each day the simulated teacher answers every approval request. Each night the router learns
from those answers and is scored on the holdout items, which it never trains on. Approval
requests are for the day before each night; accuracy, agreement and leaks are for the rules
in place after it. Night 0 is the router with no learned rules.

The holdout is never trained on, but it is selected on: the dreaming gate scores the current
rules on these same items, re-runs the new rules only on the items whose learned rules differ
(the rest reuse the current rules' run), and keeps the new rules when they are no worse. Treat
night-over-night gains as an upper bound; the unseen test below is the number the gate never saw.
Day leaks count every text Muse would get that day, including what an approval releases.

Each day's items are dealt evenly over the four expected decisions. Wanted requests are
items the teacher's policy says to ask about; unneeded ones are items it would have shared
or refused without asking. Only unneeded requests can go away with learning.

| Night | Approval requests that day | Accuracy | Agreement | Leaks | Kept | Seconds | Wanted | Unneeded | Day leaks | Rules from answers | Practice rules |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | - | 70.0% | 70.0% | 0 | - | 22.8 | - | - | - | - | - |
| 1 | 5 | 70.0% | 70.0% | 0 | yes | 23.4 | 4 | 1 | 0 | 0 | 0 |
| 2 | 7 | 65.0% | 65.0% | 0 | yes | 23.9 | 5 | 2 | 0 | 1 | 0 |
| 3 | 5 | 70.0% | 70.0% | 0 | yes | 22.3 | 4 | 1 | 0 | 3 | 0 |
| 4 | 6 | 65.0% | 65.0% | 0 | no | 44.5 | 5 | 1 | 0 | 3 | 0 |
| 5 | 5 | 70.0% | 70.0% | 0 | no | 40.9 | 5 | 0 | 0 | 3 | 0 |

Holdout accuracy by expected decision, for the rules in place after each night:

| Night | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| 0 | 80% | 60% | 60% | 80% |
| 1 | 80% | 60% | 60% | 80% |
| 2 | 80% | 40% | 60% | 80% |
| 3 | 80% | 60% | 60% | 80% |
| 4 | 80% | 40% | 60% | 80% |
| 5 | 80% | 60% | 60% | 80% |

Items per expected decision each day: day 1 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 2 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 3 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 4 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 5 share_tagged:5 share_summary:5 ask_user:5 refuse:5.

Holdout items the gate re-ran on each night's new rules (the rest reuse the current rules' run): night 1 0 of 20; night 2 0 of 20; night 3 0 of 20; night 4 12 of 20; night 5 14 of 20.

## Unseen test

100 items from eval/synthetic.jsonl, drawn with seed 0 (share_tagged:25 share_summary:25 ask_user:25 refuse:25), leaving out the eval tasks, the holdout and the 420 ids in eval/reports/raw/request_topics.jsonl, eval/reports/raw/request_topics_tuning.jsonl. The days, the gate and dreaming never use them, and they are left out of practice data too. Production inputs, as for the holdout. Each router is scored once. The items were written by Muse Spark and labeled with the simulated teacher's own policy.

| Router | Items | Accuracy | Agreement | Approval requests | Leaks | Errors or fallbacks | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|---|---|---|---|---|---|
| Night 0, no learned rules | 100 | 74.0% | 74.0% | 44 | 0 | 0 | 56% | 52% | 100% | 88% |
| After the last night, router_rules.md (3 rules) | 100 | 74.0% | 74.0% | 44 | 0 | 0 | 60% | 48% | 100% | 88% |
