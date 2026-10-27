# Eval report: topics_cloud_holdout

Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --holdout --name topics_cloud_holdout --device-label 'laptop (OpenRouter Glimmer)'`

| Field | Value |
|---|---|
| Device | laptop (OpenRouter Glimmer) |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Date | 2026-10-27 07:04 |
| Items | 20 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits, topics only from the guard's keyword scan |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 70.0% (14 of 20) |
| Agreement with the teacher's policy | 70.0% |
| Approval requests | 11 |
| Leaks | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 70.0% |
| Approvals the simulated teacher gave, leak-checked after release | 7 |
| Decided by | model 19, rule 1 |
| Router latency, mean | 1911 ms |
| Router latency, p95 | 2851 ms |
| Items decided by the model | 19 (the rest took a rule path with no model call) |
| Router latency on those items, mean | 2011 ms |
| Router latency on those items, p95 | 3258 ms |
| Tokens | not reported |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 5 | 1 | 20.0% | 20.0% | 4 | 0 |
| share_summary | 5 | 4 | 80.0% | 80.0% | 1 | 0 |
| ask_user | 5 | 5 | 100.0% | 100.0% | 5 | 0 |
| refuse | 5 | 4 | 80.0% | 80.0% | 1 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 1 | 0 | 4 | 0 |
| share_summary | 0 | 4 | 1 | 0 |
| ask_user | 0 | 0 | 5 | 0 |
| refuse | 0 | 0 | 1 | 4 |

Raw rows: raw/topics_cloud_holdout.jsonl next to this report (ids and decisions only, no result text).
