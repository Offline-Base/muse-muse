# Eval report: glimmer_fresh_200_b_2026-11-02

Command: `uv run python -m eval.run_eval --set eval/fresh_200_b.jsonl --name glimmer_fresh_200_b_2026-11-02 --device-label 'laptop (OpenRouter Glimmer, cloud mode, defaults of Nov 2)'`

| Field | Value |
|---|---|
| Device | laptop (OpenRouter Glimmer, cloud mode, defaults of Nov 2) |
| Backend | openrouter |
| Model | meta/muse-glimmer-30b |
| Date | 2026-11-02 21:48 |
| Items | 200 |
| Learned rules | none |
| Router inputs | as the connector sends them: kind mapped to what the device emits and the grading job's topics on per-student grades; topics also from never-share keywords in the result and in Muse's request, and from the device model's labels for the policy's request topics (when it has any) |

## Overall

| Metric | Value |
|---|---|
| Decision accuracy | 71.5% (143 of 200) |
| Agreement with the teacher's policy | 71.5% |
| Approval requests | 101 |
| Leaks | 0 |
| Missed asks (the policy wants an ask, the router shared) | 0 |
| Refusals shared (the policy refuses, the router shared) | 0 |
| Held by the final leak check | 0 |
| Errors | 0 |
| Fallbacks (model or check could not run; never counted correct) | 0 |
| Needless asks (asked where a share was expected) | 50 |
| Unsafe shares (shared where an ask or a refusal was expected) | 0 |
| Over-refusals (refused where a share or an ask was expected) | 0 |
| Outcome accuracy (what Muse got: shared, waiting or kept) | 75.0% |
| Approvals the simulated teacher gave, leak-checked after release | 58 |
| Decided by | model 181, rule 19 |
| Router latency, mean | 1296 ms |
| Router latency, p50 | 1192 ms |
| Router latency, p95 | 2453 ms |
| Release time per item (tagging, checks, router, summary), p50 | 3326 ms |
| Release time per item, p95 | 5868 ms |
| Items decided by the model | 181 (the rest took a rule path with no model call) |
| Router latency on those items, mean | 1432 ms |
| Router latency on those items, p95 | 2555 ms |
| Router model completions (retries included) | 181 |
| Tokens (router prompt plus completion) | 115377 |
| Router reasoning tokens, mean and p95 | 162 and 316 |

## By category

Category is the expected decision for the item.

| Category | Items | Correct | Accuracy | Agreement | Approval requests | Leaks |
|---|---|---|---|---|---|---|
| share_tagged | 59 | 11 | 18.6% | 18.6% | 48 | 0 |
| share_summary | 44 | 35 | 79.5% | 79.5% | 2 | 0 |
| ask_user | 51 | 51 | 100.0% | 100.0% | 51 | 0 |
| refuse | 46 | 46 | 100.0% | 100.0% | 0 | 0 |

## Expected and decided

Rows are the expected decision, columns what the router decided.

| Expected | share_tagged | share_summary | ask_user | refuse |
|---|---|---|---|---|
| share_tagged | 11 | 0 | 48 | 0 |
| ask_user | 0 | 0 | 51 | 0 |
| refuse | 0 | 0 | 0 | 46 |
| share_summary | 7 | 35 | 2 | 0 |

Raw rows: raw/glimmer_fresh_200_b_2026-11-02.jsonl next to this report (ids and decisions only, no result text).

## Spend

Added by hand after the run. The OpenRouter key's usage rose by $0.1382 over this run, from $4.5314 at 21:36:59 to $4.6696 at 21:49:22 on the laptop's clock (GET /api/v1/key before the run and 30 s after it ended, never printing the key), so any other use of the key in that window counts too. A 5-item pilot of the same command, written to a scratch folder and not kept, cost $0.0010 just before. Settings: `.env.example`'s defaults (DEVICE_ONLY=0, GLIMMER_BACKEND=openrouter, GLIMMER_MODEL=meta/muse-glimmer-30b, CHECKER_BACKEND=glimmer), with ROUTER_LOOSEN, DREAMING_BACKEND and the router's reasoning and tokens left at their defaults. All items invented; the teacher is a policy file.
