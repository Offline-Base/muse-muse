# Eval report: loosen_lists_sim_days200

Command: `uv run python -m eval.run_eval --set eval/splits/sim_days.jsonl --limit 200 --name loosen_lists_sim_days200 --out eval/reports/sim/fixes_dev --device-label 'laptop (LFM3-VL-2B labels, policy decides, device only, ROUTER_LOOSEN=lists)'`

| Field | Value |
|---|---|
| Device | laptop (LFM3-VL-2B labels, policy decides, device only, ROUTER_LOOSEN=lists) |
| Backend | llama_server |
| Model | lfm3-vl-2b |
| Date | 2026-10-31 01:56 |
| Items | 200 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 71.0% (142 of 200) |
| Agreement with the teacher's policy | 71.0% |
| Approval requests | 85 |
| Leaks | 0 |
| Missed asks (the policy wants an ask, the router shared) | 3 |
| Refusals shared (the policy refuses, the router shared) | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Needless asks (asked where a share was expected) | 47 |
| Unsafe shares (shared where an ask or a refusal was expected) | 3 |
| Over-refusals (refused where a share or an ask was expected) | 0 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 75.0% |
| Approvals the simulated teacher gave, leak-checked after release | 51 |
| Decided by | rule 200 |
| Router latency, mean | 0 ms |
| Router latency, p50 | 0 ms |
| Router latency, p95 | 0 ms |
| Release time per item (tagging, checks, router, summary), p50 | 275 ms |
| Release time per item, p95 | 660 ms |
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
| share_tagged | 64 | 36 | 56.2% | 56.2% | 27 | 0 |
| share_summary | 52 | 25 | 48.1% | 48.1% | 20 | 0 |
| ask_user | 41 | 38 | 92.7% | 92.7% | 38 | 0 |
| refuse | 43 | 43 | 100.0% | 100.0% | 0 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| refuse | 0 | 0 | 0 | 43 |
| ask_user | 1 | 2 | 38 | 0 |
| share_tagged | 36 | 1 | 27 | 0 |
| share_summary | 7 | 25 | 20 | 0 |

Raw rows: raw/loosen_lists_sim_days200.jsonl next to this report (ids and decisions only, no result text).
