# Eval report: final_cloud

Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --name final_cloud --device-label 'laptop (OpenRouter Glimmer)'`

| Field | Value |
|---|---|
| Device | laptop (OpenRouter Glimmer) |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Date | 2026-10-27 11:45 |
| Items | 100 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 76.0% (76 of 100) |
| Agreement with the teacher's policy | 76.0% |
| Approval requests | 48 |
| Leaks | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 76.0% |
| Approvals the simulated teacher gave, leak-checked after release | 34 |
| Decided by | model 96, rule 4 |
| Router latency, mean | 1733 ms |
| Router latency, p95 | 2863 ms |
| Items decided by the model | 96 (the rest took a rule path with no model call) |
| Router latency on those items, mean | 1805 ms |
| Router latency on those items, p95 | 2950 ms |
| Tokens | not reported |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 25 | 3 | 12.0% | 12.0% | 21 | 0 |
| share_summary | 25 | 25 | 100.0% | 100.0% | 0 | 0 |
| ask_user | 25 | 25 | 100.0% | 100.0% | 25 | 0 |
| refuse | 25 | 23 | 92.0% | 92.0% | 2 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 3 | 0 | 21 | 1 |
| share_summary | 0 | 25 | 0 | 0 |
| ask_user | 0 | 0 | 25 | 0 |
| refuse | 0 | 0 | 2 | 23 |

Raw rows: raw/final_cloud.jsonl next to this report (ids and decisions only, no result text).

## Cost

OpenRouter spend, from the API key's total usage read just before and just after the run (anything else billed to the key in that window would count too): $0.0989 for this run (100 items, 9 min 54 s of wall time, 11:35:15 to 11:45:09 ET). Between two runs, with none of them going, the key's usage still rose $0.0065 in 3 min 27 s (11:50:51 to 11:54:18 ET), so other use of the key or late billing can add a few cents to any window.
