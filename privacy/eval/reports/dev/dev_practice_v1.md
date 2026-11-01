# Eval report: dev_practice_v1

Command: `uv run python -m eval.run_eval --set <scratch>/dev80.jsonl --name dev_practice_v1 --rules <scratch>/practice_rules.md --out <scratch>/dev`

| Field | Value |
|---|---|
| Device | laptop |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Date | 2026-10-27 02:58 |
| Items | 80 |
| Learned rules | practice_rules.md (50 rules) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 100.0% (80 of 80) |
| Agreement with the teacher's policy | 100.0% |
| Approval requests | 20 |
| Leaks | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Router latency, mean | 970 ms |
| Router latency, p95 | 1941 ms |
| Items decided by the model | 67 (the rest took a rule path with no model call) |
| Router latency on those items, mean | 1158 ms |
| Router latency on those items, p95 | 1978 ms |
| Tokens | not reported |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 20 | 20 | 100.0% | 100.0% | 0 | 0 |
| share_summary | 20 | 20 | 100.0% | 100.0% | 0 | 0 |
| ask_user | 20 | 20 | 100.0% | 100.0% | 20 | 0 |
| refuse | 20 | 20 | 100.0% | 100.0% | 0 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 20 | 0 | 0 | 0 |
| share_summary | 0 | 20 | 0 | 0 |
| ask_user | 0 | 0 | 20 | 0 |
| refuse | 0 | 0 | 0 | 20 |

Raw rows: eval/reports/raw/dev_practice_v1.jsonl (ids and decisions only, no result text).
