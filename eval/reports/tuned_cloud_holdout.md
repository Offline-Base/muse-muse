# Eval report: tuned_cloud_holdout

Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --holdout --name tuned_cloud_holdout --device-label 'laptop (OpenRouter Glimmer)'`

| Field | Value |
|---|---|
| Device | laptop (OpenRouter Glimmer) |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Date | 2026-10-27 03:13 |
| Items | 20 |
| Learned rules | none |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 80.0% (16 of 20) |
| Agreement with the teacher's policy | 80.0% |
| Approval requests | 9 |
| Leaks | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Router latency, mean | 1621 ms |
| Router latency, p95 | 2904 ms |
| Items decided by the model | 17 (the rest took a rule path with no model call) |
| Router latency on those items, mean | 1907 ms |
| Router latency on those items, p95 | 4338 ms |
| Tokens | not reported |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 5 | 1 | 20.0% | 20.0% | 4 | 0 |
| share_summary | 5 | 5 | 100.0% | 100.0% | 0 | 0 |
| ask_user | 5 | 5 | 100.0% | 100.0% | 5 | 0 |
| refuse | 5 | 5 | 100.0% | 100.0% | 0 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 1 | 0 | 4 | 0 |
| share_summary | 0 | 5 | 0 | 0 |
| ask_user | 0 | 0 | 5 | 0 |
| refuse | 0 | 0 | 0 | 5 |

Raw rows: raw/tuned_cloud_holdout.jsonl next to this report (ids and decisions only, no result text).
