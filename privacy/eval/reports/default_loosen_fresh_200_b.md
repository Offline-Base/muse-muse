# Eval report: default_loosen_fresh_200_b

Command: `uv run python -m eval.run_eval --set eval/fresh_200_b.jsonl --name default_loosen_fresh_200_b --device-label 'laptop (LFM3-VL-2B labels, policy decides, device only, ROUTER_LOOSEN default)'`

| Field | Value |
|---|---|
| Device | laptop (LFM3-VL-2B labels, policy decides, device only, ROUTER_LOOSEN default) |
| Backend | llama_server |
| Model | lfm3-vl-2b |
| Date | 2026-10-31 02:23 |
| Items | 200 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 81.5% (163 of 200) |
| Agreement with the teacher's policy | 81.5% |
| Approval requests | 75 |
| Leaks | 0 |
| Missed asks (the policy wants an ask, the router shared) | 2 |
| Refusals shared (the policy refuses, the router shared) | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Needless asks (asked where a share was expected) | 28 |
| Unsafe shares (shared where an ask or a refusal was expected) | 2 |
| Over-refusals (refused where a share or an ask was expected) | 4 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 83.0% |
| Approvals the simulated teacher gave, leak-checked after release | 36 |
| Decided by | rule 200 |
| Router latency, mean | 0 ms |
| Router latency, p50 | 0 ms |
| Router latency, p95 | 0 ms |
| Release time per item (tagging, checks, router, summary), p50 | 328 ms |
| Release time per item, p95 | 796 ms |
| Items decided by the model | 0 (the rest took a rule path with no model call) |
| Router latency on those items, mean | 0 ms |
| Router latency on those items, p95 | 0 ms |
| Router model completions (retries included) | 0 |
| Tokens (router prompt plus completion) | not reported |
| Router reasoning tokens, mean and p95 | not reported |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 59 | 34 | 57.6% | 57.6% | 24 | 0 |
| share_summary | 44 | 36 | 81.8% | 81.8% | 4 | 0 |
| ask_user | 51 | 47 | 92.2% | 92.2% | 47 | 0 |
| refuse | 46 | 46 | 100.0% | 100.0% | 0 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 34 | 0 | 24 | 1 |
| ask_user | 2 | 0 | 47 | 2 |
| refuse | 0 | 0 | 0 | 46 |
| share_summary | 3 | 36 | 4 | 1 |

Raw rows: raw/default_loosen_fresh_200_b.jsonl next to this report (ids and decisions only, no result text).
