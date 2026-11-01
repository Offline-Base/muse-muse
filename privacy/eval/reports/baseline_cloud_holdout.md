# Eval report: baseline_cloud_holdout

Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --holdout --name baseline_cloud_holdout --device-label 'laptop (OpenRouter Glimmer)'`

| Field | Value |
|---|---|
| Device | laptop (OpenRouter Glimmer) |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Date | 2026-10-27 02:46 |
| Items | 20 |
| Learned rules | none |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 75.0% (15 of 20) |
| Agreement with the teacher's policy | 75.0% |
| Approval requests | 6 |
| Leaks | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Router latency, mean | 1377 ms |
| Router latency, p95 | 2154 ms |
| Tokens | not reported |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 5 | 2 | 40.0% | 40.0% | 3 | 0 |
| share_summary | 5 | 5 | 100.0% | 100.0% | 0 | 0 |
| ask_user | 5 | 3 | 60.0% | 60.0% | 3 | 0 |
| refuse | 5 | 5 | 100.0% | 100.0% | 0 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 2 | 0 | 3 | 0 |
| share_summary | 0 | 5 | 0 | 0 |
| ask_user | 1 | 1 | 3 | 0 |
| refuse | 0 | 0 | 0 | 5 |

Raw rows: eval/reports/raw/baseline_cloud_holdout.jsonl (ids and decisions only, no result text).
