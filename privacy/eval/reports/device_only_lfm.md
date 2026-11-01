# Eval report: device_only_lfm

Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --name device_only_lfm --device-label 'laptop (LFM3-VL-2B, device only)'`

| Field | Value |
|---|---|
| Device | laptop (LFM3-VL-2B, device only) |
| Backend | llama_server |
| Model | lfm3-vl-2b |
| Date | 2026-10-30 14:30 |
| Items | 100 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 38.0% (38 of 100) |
| Agreement with the teacher's policy | 38.0% |
| Approval requests | 49 |
| Leaks | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 38.0% |
| Approvals the simulated teacher gave, leak-checked after release | 43 |
| Decided by | model 96, rule 4 |
| Router latency, mean | 399 ms |
| Router latency, p95 | 487 ms |
| Items decided by the model | 96 (the rest took a rule path with no model call) |
| Router latency on those items, mean | 416 ms |
| Router latency on those items, p95 | 494 ms |
| Tokens | not reported |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 25 | 3 | 12.0% | 12.0% | 14 | 0 |
| share_summary | 25 | 0 | 0.0% | 0.0% | 21 | 0 |
| ask_user | 25 | 12 | 48.0% | 48.0% | 12 | 0 |
| refuse | 25 | 23 | 92.0% | 92.0% | 2 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 3 | 0 | 14 | 8 |
| share_summary | 0 | 0 | 21 | 4 |
| ask_user | 0 | 0 | 12 | 13 |
| refuse | 0 | 0 | 2 | 23 |

Raw rows: raw/device_only_lfm.jsonl next to this report (ids and decisions only, no result text).
