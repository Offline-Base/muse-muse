# Nights of dreaming (simulated)

Command: `uv run python -m scripts.simulate_nights --nights 5 --per-day 20 --home <empty folder> --out eval/reports/final`

| Field | Value |
|---|---|
| Device | laptop |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Dreaming backend | prompt |
| Date | 2026-10-27 13:42 |
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
| 0 | - | 75.0% | 75.0% | 0 | - | 645.4 | - | - | - | - | - |
| 1 | 10 | 85.0% | 85.0% | 0 | yes | 606.4 | 5 | 5 | 0 | 1 | 0 |
| 2 | 9 | 90.0% | 90.0% | 0 | yes | 235.2 | 5 | 4 | 0 | 6 | 0 |
| 3 | 7 | 85.0% | 85.0% | 0 | yes | 503.3 | 5 | 2 | 0 | 8 | 0 |
| 4 | 6 | 85.0% | 85.0% | 0 | yes | 432.9 | 5 | 1 | 0 | 8 | 0 |
| 5 | 6 | 90.0% | 90.0% | 0 | yes | 363.4 | 5 | 1 | 0 | 9 | 0 |

Holdout accuracy by expected decision, for the rules in place after each night:

| Night | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| 0 | 20% | 100% | 100% | 80% |
| 1 | 40% | 100% | 100% | 100% |
| 2 | 60% | 100% | 100% | 100% |
| 3 | 60% | 80% | 100% | 100% |
| 4 | 60% | 80% | 100% | 100% |
| 5 | 60% | 100% | 100% | 100% |

Items per expected decision each day: day 1 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 2 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 3 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 4 share_tagged:5 share_summary:5 ask_user:5 refuse:5; day 5 share_tagged:5 share_summary:5 ask_user:5 refuse:5.

Holdout items the gate re-ran on each night's new rules (the rest reuse the current rules' run): night 1 2 of 20; night 2 5 of 20; night 3 4 of 20; night 4 4 of 20; night 5 4 of 20.

## Unseen test

100 items from eval/synthetic.jsonl, drawn with seed 0 (share_tagged:25 share_summary:25 ask_user:25 refuse:25), leaving out the eval tasks, the holdout and the 420 ids in eval/reports/raw/request_topics.jsonl, eval/reports/raw/request_topics_tuning.jsonl. The days, the gate and dreaming never use them, and they are left out of practice data too. Production inputs, as for the holdout. Each router is scored once. The items were written by Muse Spark and labeled with the simulated teacher's own policy.

| Router | Items | Accuracy | Agreement | Approval requests | Leaks | Errors or fallbacks | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|---|---|---|---|---|---|
| Night 0, no learned rules | 100 | 72.0% | 72.0% | 53 | 0 | 0 | 8% | 100% | 100% | 80% |
| After the last night, router_rules.md (9 rules) | 100 | 81.0% | 81.0% | 28 | 0 | 0 | 68% | 100% | 68% | 88% |

Notes on the unseen test, added after the run from raw/nights/unseen-*.jsonl (the counts above are as measured and stay as they are). The 9 rules in place after night 5 are copied unchanged to learned_rules_night5.md next to this report.

- No row leaked in either run: every row in unseen-night-0.jsonl and unseen-last-night.jsonl has `leaked` false, and every approved release was checked too (`leak_kinds_after_approval` empty).
- syn-0765 no longer leaks. In the run in commit 8afe137 it was the one leak: a search snippet naming an invented person who is not on the roster ("Bennick Cinderfall", then "Bennick" alone), so only Glimmer's second pass for names could tag it, and the old guard tagged only the exact strings that pass returned. With the guard fix, each word of a name the pass reports is tagged too. This time, with the night-0 router, the router model asked, the simulated teacher approved, and the released text had no leak (`leak_kinds_after_approval` empty). With the last night's rules it was shared tagged, with no leak. The raw rows do not record what the name pass returned for it.
- After the last night, 8 of the 25 ask_user items were shared tagged, the same count as in the last round. All 8 are search snippets that reach the router with no topics, so the learned rule for snippets with no topics (share tagged after 2 approvals with "don't ask again") covers them. Seven have hand labels attendance or reading, which production inputs do not carry; the eighth (syn-0523, a seating excerpt) has no hand topics and the teacher's policy asks about it by default. The router cannot tell these from the snippets she approved.
- Holdout accuracy went from 90% after night 2 to 85% after night 3 although night 3's rules were kept. The gate re-ran night 2's rules on the holdout that night and they scored 17 of 20 (85%), and the new rules matched it, so the drop is the same rules scoring differently from run to run, not the new rules.
- Day leaks count names and identifiers, not policy misses. On day 2, t085 (a discipline note with no never-share keyword, which the teacher's policy refuses) reached the router as a snippet with no topics, was decided share tagged under night 1's rule for such snippets, and went to Muse tagged, with no card (decision row in the simulated home: router share_tagged, status auto). Night 1's only rule was that one: rebuilding it from day 1's decision rows with base.dreaming.train (no model call) gives "Document snippets (kind: snippet; topics: none): share tagged", from the 2 approved snippets t019 and t021. It is 0 in Day leaks because its names were tagged. The rules after night 5 share it the same way on the 100 tasks (final_cloud_night5_rules.md).
- The Seconds column is about 2 to 6 times the last round's (645 s against 111 s for night 0). OpenRouter served Glimmer more slowly during this run (see cloud_speed.md); the router took 7 to 8 s per item on night 1 against about 1.5 s earlier in the day.

## Cost

OpenRouter spend, from the API key's total usage read just before and just after the run (anything else billed to the key in that window would count too): $0.4164 for this run (5 days, 5 nights with their gates, and the unseen test scored twice; 1 h 43 min 48 s of wall time, 11:58:40 to 13:42:28 ET); 30 s later the key showed $0.0021 more. Between two earlier runs, with none of them going, the key's usage still rose $0.0065 in 3 min 27 s, so other use of the key or late billing is in this window too, and over 1 h 44 min it could be a real share of the total. A local demo of the device (one grading job over the 24 demo essays plus a document list, about 28 Glimmer calls) used the same key from 12:33 to 12:38 ET, inside the nights window. The two grading jobs measured in eval/reports/e2e_cloud.md and e2e_cloud_no_rules.md cost $0.0231 and $0.0172, so about $0.02 of the nights' $0.4164 is that demo.
