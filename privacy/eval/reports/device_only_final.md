# Eval report: device_only_final

Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --name device_only_final --device-label 'laptop (LFM3-VL-2B labels, policy decides, device only)'`

| Field | Value |
|---|---|
| Device | laptop (LFM3-VL-2B labels, policy decides, device only) |
| Backend | llama_server |
| Model | lfm3-vl-2b |
| Date | 2026-10-30 14:47 |
| Items | 100 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 81.0% (81 of 100) |
| Agreement with the teacher's policy | 81.0% |
| Approval requests | 27 |
| Leaks | 0 |
| Held by the final leak check | 7 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 83.0% |
| Approvals the simulated teacher gave, leak-checked after release | 17 |
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
| share_tagged | 25 | 20 | 80.0% | 80.0% | 4 | 0 |
| share_summary | 25 | 18 | 72.0% | 72.0% | 1 | 0 |
| ask_user | 25 | 21 | 84.0% | 84.0% | 21 | 0 |
| refuse | 25 | 22 | 88.0% | 88.0% | 1 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 20 | 0 | 4 | 1 |
| share_summary | 5 | 18 | 1 | 1 |
| ask_user | 2 | 2 | 21 | 0 |
| refuse | 2 | 0 | 1 | 22 |

Raw rows: raw/device_only_final.jsonl next to this report (ids and decisions only, no result text).
