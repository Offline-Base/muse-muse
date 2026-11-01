# Eval report: final_cloud_holdout

Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --holdout --name final_cloud_holdout --device-label 'laptop (OpenRouter Glimmer)'`

| Field | Value |
|---|---|
| Device | laptop (OpenRouter Glimmer) |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Date | 2026-10-27 11:47 |
| Items | 20 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 75.0% (15 of 20) |
| Agreement with the teacher's policy | 75.0% |
| Approval requests | 10 |
| Leaks | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 75.0% |
| Approvals the simulated teacher gave, leak-checked after release | 6 |
| Decided by | model 19, rule 1 |
| Router latency, mean | 1504 ms |
| Router latency, p95 | 2406 ms |
| Items decided by the model | 19 (the rest took a rule path with no model call) |
| Router latency on those items, mean | 1583 ms |
| Router latency on those items, p95 | 3396 ms |
| Tokens | not reported |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 5 | 1 | 20.0% | 20.0% | 4 | 0 |
| share_summary | 5 | 5 | 100.0% | 100.0% | 0 | 0 |
| ask_user | 5 | 5 | 100.0% | 100.0% | 5 | 0 |
| refuse | 5 | 4 | 80.0% | 80.0% | 1 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 1 | 0 | 4 | 0 |
| share_summary | 0 | 5 | 0 | 0 |
| ask_user | 0 | 0 | 5 | 0 |
| refuse | 0 | 0 | 1 | 4 |

Raw rows: raw/final_cloud_holdout.jsonl next to this report (ids and decisions only, no result text).

## Cost

OpenRouter spend, from the API key's total usage read just before and just after the run (anything else billed to the key in that window would count too): $0.0175 for this run (20 items, 1 min 43 s of wall time, 11:45:23 to 11:47:06 ET). Between two runs, with none of them going, the key's usage still rose $0.0065 in 3 min 27 s (11:50:51 to 11:54:18 ET), so other use of the key or late billing can add a few cents to any window.
