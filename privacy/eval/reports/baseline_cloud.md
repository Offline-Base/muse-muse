# Eval report: baseline_cloud

Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --name baseline_cloud --device-label 'laptop (OpenRouter Glimmer)'`

| Field | Value |
|---|---|
| Device | laptop (OpenRouter Glimmer) |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Date | 2026-10-27 02:44 |
| Items | 100 |
| Learned rules | none |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 70.0% (70 of 100) |
| Agreement with the teacher's policy | 70.0% |
| Approval requests | 29 |
| Leaks | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Router latency, mean | 1376 ms |
| Router latency, p95 | 2431 ms |
| Tokens | not reported |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 25 | 9 | 36.0% | 36.0% | 15 | 0 |
| share_summary | 25 | 25 | 100.0% | 100.0% | 0 | 0 |
| ask_user | 25 | 14 | 56.0% | 56.0% | 14 | 0 |
| refuse | 25 | 22 | 88.0% | 88.0% | 0 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 9 | 0 | 15 | 1 |
| share_summary | 0 | 25 | 0 | 0 |
| ask_user | 7 | 3 | 14 | 1 |
| refuse | 2 | 1 | 0 | 22 |

Raw rows: eval/reports/raw/baseline_cloud.jsonl (ids and decisions only, no result text).
