# Eval report: loosen_all_sim_days200

Command: `uv run python -m eval.run_eval --set eval/splits/sim_days.jsonl --limit 200 --name loosen_all_sim_days200 --out eval/reports/sim/fixes_dev --device-label 'laptop (LFM3-VL-2B labels, policy decides, device only, ROUTER_LOOSEN=all)'`

| Field | Value |
|---|---|
| Device | laptop (LFM3-VL-2B labels, policy decides, device only, ROUTER_LOOSEN=all) |
| Backend | llama_server |
| Model | lfm3-vl-2b |
| Date | 2026-10-31 02:00 |
| Items | 200 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 79.5% (159 of 200) |
| Agreement with the teacher's policy | 79.5% |
| Approval requests | 69 |
| Leaks | 0 |
| Missed asks (the policy wants an ask, the router shared) | 3 |
| Refusals shared (the policy refuses, the router shared) | 0 |
| Held by the final leak check | 1 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Needless asks (asked where a share was expected) | 33 |
| Unsafe shares (shared where an ask or a refusal was expected) | 3 |
| Over-refusals (refused where a share or an ask was expected) | 2 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 80.5% |
| Approvals the simulated teacher gave, leak-checked after release | 37 |
| Decided by | rule 200 |
| Router latency, mean | 0 ms |
| Router latency, p50 | 0 ms |
| Router latency, p95 | 0 ms |
| Release time per item (tagging, checks, router, summary), p50 | 338 ms |
| Release time per item, p95 | 801 ms |
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
| share_tagged | 64 | 41 | 64.1% | 64.1% | 22 | 0 |
| share_summary | 52 | 39 | 75.0% | 75.0% | 11 | 0 |
| ask_user | 41 | 36 | 87.8% | 87.8% | 36 | 0 |
| refuse | 43 | 43 | 100.0% | 100.0% | 0 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| refuse | 0 | 0 | 0 | 43 |
| ask_user | 1 | 2 | 36 | 2 |
| share_tagged | 41 | 1 | 22 | 0 |
| share_summary | 2 | 39 | 11 | 0 |

Raw rows: raw/loosen_all_sim_days200.jsonl next to this report (ids and decisions only, no result text).
