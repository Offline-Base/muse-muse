# Eval report: glimmer_holdout_2026-11-02

Command: `uv run python -m eval.run_eval --set eval/tasks.jsonl --holdout --name glimmer_holdout_2026-11-02 --device-label 'laptop (OpenRouter Glimmer, cloud mode, defaults of Nov 2)'`

| Field | Value |
|---|---|
| Device | laptop (OpenRouter Glimmer, cloud mode, defaults of Nov 2) |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Date | 2026-11-02 21:51 |
| Items | 20 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 75.0% (15 of 20) |
| Agreement with the teacher's policy | 75.0% |
| Approval requests | 10 |
| Leaks | 0 |
| Missed asks (the policy wants an ask, the router shared) | 0 |
| Refusals shared (the policy refuses, the router shared) | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Needless asks (asked where a share was expected) | 4 |
| Unsafe shares (shared where an ask or a refusal was expected) | 0 |
| Over-refusals (refused where a share or an ask was expected) | 0 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 75.0% |
| Approvals the simulated teacher gave, leak-checked after release | 6 |
| Decided by | model 19, rule 1 |
| Router latency, mean | 1425 ms |
| Router latency, p50 | 1245 ms |
| Router latency, p95 | 2366 ms |
| Release time per item (tagging, checks, router, summary), p50 | 4614 ms |
| Release time per item, p95 | 8966 ms |
| Items decided by the model | 19 (the rest took a rule path with no model call) |
| Router latency on those items, mean | 1500 ms |
| Router latency on those items, p95 | 3583 ms |
| Router model completions (retries included) | 19 |
| Tokens (router prompt plus completion) | 13316 |
| Router reasoning tokens, mean and p95 | 162 and 337 |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 5 | 1 | 20.0% | 20.0% | 4 | 0 |
| share_summary | 5 | 5 | 100.0% | 100.0% | 0 | 0 |
| ask_user | 5 | 5 | 100.0% | 100.0% | 5 | 0 |
| refuse | 5 | 4 | 80.0% | 80.0% | 1 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 1 | 0 | 4 | 0 |
| share_summary | 0 | 5 | 0 | 0 |
| ask_user | 0 | 0 | 5 | 0 |
| refuse | 0 | 0 | 1 | 4 |

Raw rows: raw/glimmer_holdout_2026-11-02.jsonl next to this report (ids and decisions only, no result text).

## Spend

Added by hand after the run. The OpenRouter key's usage rose by $0.0207 over this run, from $4.6696 at 21:49:55 to $4.6903 at 21:52:27 on the laptop's clock (GET /api/v1/key before the run and 30 s after it ended, never printing the key), so any other use of the key in that window, or billing that came in late from the 200-item run just before, counts too. Settings: `.env.example`'s defaults, as in glimmer_fresh_200_b_2026-11-02.md. All items invented; the teacher is a policy file.
