# Eval report: device_only_lfm_policy

Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --name device_only_lfm_policy --device-label 'laptop (LFM3-VL-2B labels, policy decides, device only)'`

| Field | Value |
|---|---|
| Device | laptop (LFM3-VL-2B labels, policy decides, device only) |
| Backend | llama_server |
| Model | lfm3-vl-2b |
| Date | 2026-10-30 14:33 |
| Items | 100 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 53.0% (53 of 100) |
| Agreement with the teacher's policy | 53.0% |
| Approval requests | 61 |
| Leaks | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 53.0% |
| Approvals the simulated teacher gave, leak-checked after release | 47 |
| Decided by | rule 100 |
| Router latency, mean | 0 ms |
| Router latency, p95 | 0 ms |
| Items decided by the model | 0 (the rest took a rule path with no model call) |
| Router latency on those items, mean | 0 ms |
| Router latency on those items, p95 | 0 ms |
| Tokens | not reported |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 25 | 9 | 36.0% | 36.0% | 15 | 0 |
| share_summary | 25 | 0 | 0.0% | 0.0% | 19 | 0 |
| ask_user | 25 | 23 | 92.0% | 92.0% | 23 | 0 |
| refuse | 25 | 21 | 84.0% | 84.0% | 4 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 9 | 0 | 15 | 1 |
| share_summary | 0 | 0 | 19 | 6 |
| ask_user | 1 | 0 | 23 | 1 |
| refuse | 0 | 0 | 4 | 21 |

Raw rows: raw/device_only_lfm_policy.jsonl next to this report (ids and decisions only, no result text).
