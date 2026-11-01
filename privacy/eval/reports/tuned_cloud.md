# Eval report: tuned_cloud

Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --name tuned_cloud --device-label 'laptop (OpenRouter Glimmer)'`

| Field | Value |
|---|---|
| Device | laptop (OpenRouter Glimmer) |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Date | 2026-10-27 03:12 |
| Items | 100 |
| Learned rules | none |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 79.0% (79 of 100) |
| Agreement with the teacher's policy | 79.0% |
| Approval requests | 46 |
| Leaks | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Router latency, mean | 1388 ms |
| Router latency, p95 | 3009 ms |
| Items decided by the model | 84 (the rest took a rule path with no model call) |
| Router latency on those items, mean | 1652 ms |
| Router latency on those items, p95 | 3026 ms |
| Tokens | not reported |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 25 | 4 | 16.0% | 16.0% | 21 | 0 |
| share_summary | 25 | 25 | 100.0% | 100.0% | 0 | 0 |
| ask_user | 25 | 25 | 100.0% | 100.0% | 25 | 0 |
| refuse | 25 | 25 | 100.0% | 100.0% | 0 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 4 | 0 | 21 | 0 |
| share_summary | 0 | 25 | 0 | 0 |
| ask_user | 0 | 0 | 25 | 0 |
| refuse | 0 | 0 | 0 | 25 |

Raw rows: raw/tuned_cloud.jsonl next to this report (ids and decisions only, no result text).
