# Eval report: floors_tasks

Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --name floors_tasks --device-label 'laptop (LFM3-VL-2B labels, policy decides, device only, floors and cap of Oct 31)'`

| Field | Value |
|---|---|
| Device | laptop (LFM3-VL-2B labels, policy decides, device only, floors and cap of Oct 31) |
| Backend | llama_server |
| Model | lfm3-vl-2b |
| Date | 2026-10-31 11:48 |
| Items | 100 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 82.0% (82 of 100) |
| Agreement with the teacher's policy | 82.0% |
| Approval requests | 27 |
| Leaks | 0 |
| Missed asks (the policy wants an ask, the router shared) | 4 |
| Refusals shared (the policy refuses, the router shared) | 2 |
| Held by the final leak check | 2 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Needless asks (asked where a share was expected) | 5 |
| Unsafe shares (shared where an ask or a refusal was expected) | 4 |
| Over-refusals (refused where a share or an ask was expected) | 1 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 88.0% |
| Approvals the simulated teacher gave, leak-checked after release | 17 |
| Decided by | rule 100 |
| Router latency, mean | 0 ms |
| Router latency, p50 | 0 ms |
| Router latency, p95 | 0 ms |
| Release time per item (tagging, checks, router, summary), p50 | 353 ms |
| Release time per item, p95 | 1635 ms |
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
| share_tagged | 25 | 20 | 80.0% | 80.0% | 4 | 0 |
| share_summary | 25 | 19 | 76.0% | 76.0% | 1 | 0 |
| ask_user | 25 | 21 | 84.0% | 84.0% | 21 | 0 |
| refuse | 25 | 22 | 88.0% | 88.0% | 1 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 20 | 0 | 4 | 1 |
| share_summary | 5 | 19 | 1 | 0 |
| ask_user | 2 | 2 | 21 | 0 |
| refuse | 2 | 0 | 1 | 22 |

Raw rows: raw/floors_tasks.jsonl next to this report (ids and decisions only, no result text).
