# Nights of dreaming (simulated)

Command: `uv run python -m scripts.simulate_nights --nights 5 --per-day 20 --home <empty folder> --out eval/reports/final`

| Field | Value |
|---|---|
| Device | laptop |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Dreaming backend | prompt |
| Date | 2026-10-27 09:51 |
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
| 0 | - | 75.0% | 75.0% | 0 | - | 111.3 | - | - | - | - | - |
| 1 | 10 | 85.0% | 85.0% | 0 | yes | 125.9 | 5 | 5 | 0 | 1 | 0 |
| 2 | 8 | 85.0% | 85.0% | 0 | yes | 123.8 | 5 | 3 | 0 | 6 | 0 |
| 3 | 7 | 80.0% | 80.0% | 0 | yes | 130.9 | 5 | 2 | 0 | 8 | 0 |
| 4 | 7 | 90.0% | 90.0% | 0 | yes | 165.0 | 5 | 2 | 0 | 9 | 0 |
| 5 | 6 | 90.0% | 90.0% | 0 | yes | 113.9 | 5 | 1 | 0 | 10 | 0 |

Holdout accuracy by expected decision, for the rules in place after each night:

| Night | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| 0 | 20% | 100% | 100% | 80% |
| 1 | 40% | 100% | 100% | 100% |
| 2 | 60% | 80% | 100% | 100% |
| 3 | 60% | 60% | 100% | 100% |
| 4 | 60% | 100% | 100% | 100% |
| 5 | 60% | 100% | 100% | 100% |

Items per expected decision each day: day 1 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 2 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 3 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 4 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 5 share_tagged:5 share_summary:5 ask_user:5 refuse:5.

Holdout items the gate re-ran on each night's new rules (the rest reuse the current rules' run): night 1 2 of 20; night 2 5 of 20; night 3 4 of 20; night 4 9 of 20; night 5 4 of 20.

## Unseen test

100 items from eval/synthetic.jsonl, drawn with seed 0 (share_tagged:25 share_summary:25 ask_user:25 refuse:25), leaving out the eval tasks, the holdout and the 420 ids in eval/reports/raw/request_topics.jsonl, eval/reports/raw/request_topics_tuning.jsonl. The days, the gate and dreaming never use them, and they are left out of practice data too. Production inputs, as for the holdout. Each router is scored once. The items were written by Muse Spark and labeled with the simulated teacher's own policy.

| Router | Items | Accuracy | Agreement | Approval requests | Leaks | Errors or fallbacks | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|---|---|---|---|---|---|
| Night 0, no learned rules | 100 | 70.0% | 70.0% | 53 | 1 | 0 | 8% | 92% | 100% | 80% |
| After the last night, router_rules.md (10 rules) | 100 | 79.0% | 79.0% | 30 | 0 | 0 | 64% | 100% | 68% | 84% |

Notes on the unseen test, added after the run from raw/nights/unseen-*.jsonl (the counts above are as measured and stay as they are). The 10 rules in place after night 5 are copied unchanged to learned_rules_night5.md next to this report.

- The night-0 leak is syn-0765, a search snippet naming an invented person who is not on the roster, so only Glimmer's second pass for names could tag the name. The router model asked; the simulated teacher approved, and the released text still had the name (raw row: `leak_kinds` empty, `leak_kinds_after_approval` name). Nothing Muse got before the approval leaked. Scored again with the last night's rules, the same item was shared with no leak. The final leak check cannot catch this case: it knows the roster and the tag map, not a name the second pass missed.
- After the last night, 8 of the 25 ask_user items were shared tagged. All 8 are search snippets that reach the router with no topics (the hand labels say attendance or reading, which production inputs do not carry), so the learned rule for snippets with no topics, share tagged after 2 approvals with "don't ask again", now covers them. The teacher's policy asks about attendance and reading excerpts by default, but the router cannot tell them from the snippets she approved.

## Cost

OpenRouter spend, from the API key's total usage read just before and just after the run (anything else billed to the key in that window would count too): $0.3881 for this run (5 days, 5 nights with their gates, and the unseen test scored twice; about 33 min 56 s of wall time).
