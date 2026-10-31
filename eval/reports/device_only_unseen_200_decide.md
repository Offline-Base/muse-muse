# Eval report: device_only_unseen_200_decide

Command: `uv run python -m eval.run_eval --set eval/fresh_200_b.jsonl --name device_only_unseen_200_decide --device-label 'laptop (LFM3-VL-2B, device only), prompt model decides'`

| Field | Value |
|---|---|
| Device | laptop (LFM3-VL-2B, device only), prompt model decides |
| Backend | llama_server |
| Model | lfm3-vl-2b |
| Date | 2026-10-30 15:10 |
| Items | 200 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 41.5% (83 of 200) |
| Agreement with the teacher's policy | 41.5% |
| Approval requests | 30 |
| Leaks | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 41.5% |
| Approvals the simulated teacher gave, leak-checked after release | 27 |
| Decided by | model 181, rule 19 |
| Router latency, mean | 590 ms |
| Router latency, p95 | 935 ms |
| Items decided by the model | 181 (the rest took a rule path with no model call) |
| Router latency on those items, mean | 652 ms |
| Router latency on those items, p95 | 951 ms |
| Tokens | not reported |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 59 | 0 | 0.0% | 0.0% | 21 | 0 |
| share_summary | 44 | 33 | 75.0% | 75.0% | 3 | 0 |
| ask_user | 51 | 5 | 9.8% | 9.8% | 5 | 0 |
| refuse | 46 | 45 | 97.8% | 97.8% | 1 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 0 | 0 | 21 | 38 |
| ask_user | 1 | 1 | 5 | 44 |
| refuse | 0 | 0 | 1 | 45 |
| share_summary | 0 | 33 | 3 | 8 |

Raw rows: raw/device_only_unseen_200_decide.jsonl next to this report (ids and decisions only, no result text).
