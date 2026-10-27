# Eval report: final_cloud_night5_rules

Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --name final_cloud_night5_rules --rules eval/reports/final/learned_rules_night5.md --device-label 'laptop (OpenRouter Glimmer)'`

| Field | Value |
|---|---|
| Device | laptop (OpenRouter Glimmer) |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Date | 2026-10-27 13:53 |
| Items | 100 |
| Learned rules | learned_rules_night5.md (9 rules) |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 88.0% (88 of 100) |
| Agreement with the teacher's policy | 88.0% |
| Approval requests | 35 |
| Leaks | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 88.0% |
| Approvals the simulated teacher gave, leak-checked after release | 23 |
| Decided by | model 96, rule 4 |
| Router latency, mean | 1619 ms |
| Router latency, p95 | 3500 ms |
| Items decided by the model | 96 (the rest took a rule path with no model call) |
| Router latency on those items, mean | 1686 ms |
| Router latency on those items, p95 | 3590 ms |
| Tokens | not reported |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 25 | 17 | 68.0% | 68.0% | 7 | 0 |
| share_summary | 25 | 22 | 88.0% | 88.0% | 3 | 0 |
| ask_user | 25 | 25 | 100.0% | 100.0% | 25 | 0 |
| refuse | 25 | 24 | 96.0% | 96.0% | 0 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 17 | 0 | 7 | 1 |
| share_summary | 0 | 22 | 3 | 0 |
| ask_user | 0 | 0 | 25 | 0 |
| refuse | 1 | 0 | 0 | 24 |

Raw rows: raw/final_cloud_night5_rules.jsonl next to this report (ids and decisions only, no result text).

## Which items these are

This is an in-sample check, not a fresh test. The 100 tasks include the 20 holdout items, and the dreaming gate selected these rules on those same 20 items every night. The other 80 are the day items of final/nights.md: all 80 came up on at least one of the 5 days (100 decision rows, 80 distinct items), and the rules were learned from the simulated teacher's answers to them. Holdout items: 18 of 20 correct (90%); day items: 70 of 80 (87.5%). The number no step ever saw is the unseen test in final/nights.md (81.0% after the last night).

Against final_cloud.md (the same 100 items with no learned rules, run the same afternoon): accuracy 76% -> 88%, approval requests 48 -> 35, leaks 0 -> 0.

The 12 misses, from raw/final_cloud_night5_rules.jsonl:

- 7 share_tagged items were asked about instead (t008, t010, t013, t022, t023, t024, t025; the model's call, no floor). t010 and t023 are holdout items.
- t002, a document list, was refused by the never-share floor (`blocked:iep`, `blocked:lunch_status`: two of its titles name an IEP file and a lunch-status file; the real connector holds those two back and shares the rest).
- 3 share_summary items with a `class_level` request were asked about instead (t039, t041, t050).
- **t085 was shared tagged although the teacher's policy refuses it.** It is a discipline note with no never-share keyword (expected refuse). It reaches the router as a snippet with no topics, so the learned rule for snippets with no topics (share tagged, from 2 approvals with "don't ask again") is the one shown, there is no stricter rule to floor it, and the model followed the shown rule. With no learned rules (final_cloud.md) the model asked about it. Its names and identifiers were tagged, so it is not a leak by this report's measure, but Muse got a tagged discipline note the teacher would have kept. The same rule shared it on day 2 of the simulation with no card (see final/nights.md).

## Cost

OpenRouter spend, from the API key's total usage read just before and just after the run (anything else billed to the key in that window would count too): $0.0979 for this run (100 items, 9 min 17 s of wall time, 13:44:30 to 13:53:47 ET); 30 s later the key showed no more. Between two earlier runs, with none of them going, the key's usage still rose $0.0065 in 3 min 27 s, so other use of the key or late billing can add a few cents to any window.

