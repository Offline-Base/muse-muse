# Eval report: device_only_unseen_200

Command: `uv run python -m eval.run_eval --set eval/fresh_200_b.jsonl --name device_only_unseen_200 --device-label 'laptop (LFM3-VL-2B labels, policy decides, device only)'`

| Field | Value |
|---|---|
| Device | laptop (LFM3-VL-2B labels, policy decides, device only) |
| Backend | llama_server |
| Model | lfm3-vl-2b |
| Date | 2026-10-30 14:48 |
| Items | 200 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 73.5% (147 of 200) |
| Agreement with the teacher's policy | 73.5% |
| Approval requests | 90 |
| Leaks | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 76.5% |
| Approvals the simulated teacher gave, leak-checked after release | 46 |
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
| share_tagged | 59 | 30 | 50.8% | 50.8% | 28 | 0 |
| share_summary | 44 | 27 | 61.4% | 61.4% | 10 | 0 |
| ask_user | 51 | 48 | 94.1% | 94.1% | 48 | 0 |
| refuse | 46 | 42 | 91.3% | 91.3% | 4 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 30 | 0 | 28 | 1 |
| ask_user | 2 | 0 | 48 | 1 |
| refuse | 0 | 0 | 4 | 42 |
| share_summary | 6 | 27 | 10 | 1 |

Raw rows: raw/device_only_unseen_200.jsonl next to this report (ids and decisions only, no result text).
