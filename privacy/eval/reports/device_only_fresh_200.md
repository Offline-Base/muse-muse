# Eval report: device_only_fresh_200

Command: `uv run python -m eval.run_eval --set eval/fresh_200.jsonl --name device_only_fresh_200 --device-label 'laptop (LFM3-VL-2B labels, policy decides, device only)'`

| Field | Value |
|---|---|
| Device | laptop (LFM3-VL-2B labels, policy decides, device only) |
| Backend | llama_server |
| Model | lfm3-vl-2b |
| Date | 2026-10-30 14:38 |
| Items | 200 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 78.5% (157 of 200) |
| Agreement with the teacher's policy | 78.5% |
| Approval requests | 78 |
| Leaks | 10 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 81.0% |
| Approvals the simulated teacher gave, leak-checked after release | 42 |
| Decided by | rule 200 |
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
| share_tagged | 48 | 34 | 70.8% | 70.8% | 14 | 7 |
| share_summary | 60 | 41 | 68.3% | 68.3% | 13 | 0 |
| ask_user | 49 | 45 | 91.8% | 91.8% | 45 | 3 |
| refuse | 43 | 37 | 86.1% | 86.1% | 6 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| refuse | 0 | 0 | 6 | 37 |
| ask_user | 3 | 0 | 45 | 1 |
| share_tagged | 34 | 0 | 14 | 0 |
| share_summary | 5 | 41 | 13 | 1 |

Raw rows: raw/device_only_fresh_200.jsonl next to this report (ids and decisions only, no result text).
