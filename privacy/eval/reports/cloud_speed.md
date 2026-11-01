# Cloud speed (OpenRouter Glimmer, development mode)

This is the tuning-stage speed report. The final runs after the review fixes are in `final.md` and `final/cloud_speed.md`; `e2e_cloud.md` and `e2e_cloud_no_rules.md` now hold the final grading runs, and the tuning-stage copies quoted below are kept as `*_after_tuning.md`.

Date: 2026-10-27. Device setting: laptop. Backend: openrouter, model `meta/muse-glimmer-30b`, reasoning low, strict JSON for the router. All data is invented. These are cloud numbers for development; the shipping backend (Glimmer on the device through llama-server) has not been measured yet. Latencies include the network round trip to OpenRouter and vary from run to run with OpenRouter load (the same grading step measured 4.3 s mean in one run and 5.4 s in another on the same day).

## Per step

The first column is the step; latency is wall time for one call as the device sees it.

| Step | Latency mean (ms) | p50 (ms) | p95 (ms) | Calls measured | Source |
|---|---:|---:|---:|---:|---|
| Router decision, model call (no learned rules) | 1652 | 1481 | 3026 | 84 | tuned_cloud |
| Router decision, model call (night-5 learned rules) | 1460 | 1308 | 2695 | 84 | tuned_cloud_night5_rules |
| Router decision, every item (rule path counted as 0 ms) | 1227 | | 2409 | 100 | tuned_cloud_night5_rules |
| Second pass for names (one result) | 2100 | | | 1 | e2e_cloud_no_rules_after_tuning |
| Grade one essay | 5400 | 5300 | | 24 | e2e_cloud_no_rules_after_tuning (max 6900) |

Router decision latency is the time inside `Router.decide`: reading the learned rules, one strict-JSON Glimmer call and the floors. It does not include tagging or the second pass for names, which egress runs before the router. 16 of the 100 eval items take a rule path with no model call (document lists and pre-approved class averages).

Before tuning, the same 100 items gave a model-call mean of 1638 ms and p95 of 2444 ms (baseline_cloud, 84 calls). The tuned prompt is longer, and the p95 moved up on the cold run (3026 ms) but down once learned rules are in place (2695 ms), when the model mostly confirms the one rule it is shown. The small holdout run (17 model calls) had a p95 of 4338 ms (tuned_cloud_holdout), so the tail is noisy.

## The 24-essay grading job

From a simulated Muse call to `run_private_task` ("Grade each essay against rubric.md and write feedback for each student.") on the 24 demo essays until Muse read the tagged result. 24 grading calls (up to 4 at once on the cloud backend), one name pass on the result, one router call; 26 Glimmer calls in all. The approval step is the test approving on the page API at once, so a real teacher's reading time is not included.

| Run | Router | Request to tagged result Muse read | Glimmer calls | Tokens (prompt / completion / reasoning) | Report |
|---|---|---|---:|---|---|
| First day, no learned rules, tuned router | ask_user (model), approved | 38.3 s | 26 | 31581 / 13590 / 9089 | e2e_cloud_no_rules_after_tuning.md |
| One learned "ask first" rule, tuned router | ask_user, approved | 35.9 s | 26 | 31772 / 13819 / 9194 | e2e_cloud_after_tuning.md |
| First day, no learned rules, router before tuning | share_tagged (model), not asked | 35.7 s | 26 | 31401 / 14287 / 9670 | e2e_cloud_no_rules_before_tuning.md |
| One learned "ask first" rule, router before tuning | ask_user, approved | 31.2 s | 26 | 31523 / 13610 / 9135 | e2e_cloud_before_tuning.md |

Almost all of the time is grading (24 calls at about 5 s, 4 at a time). The router is one call of 1.2 to 1.7 s in these runs. The spread between runs (31.2 s to 38.3 s) is mostly the grading step's latency on OpenRouter, not the router change. 0 leaks in every run; 24 feedback files with real names were written only under BASE_HOME/output.

## Whole eval runs

| Run | Items | Wall time | Per item through egress (name pass + router + any summary) |
|---|---:|---|---|
| baseline_cloud (before tuning) | 100 | 5 min 9 s | 3.1 s |
| tuned_cloud | 100 | 5 min 31 s | 3.3 s |
| tuned_cloud_night5_rules | 100 | 5 min 33 s | 3.3 s |

Items run one at a time. Wall time is from the shell's `time` around each command.

## Commands

```
uv run python -m eval.run_eval --set eval/tasks.jsonl --name baseline_cloud --device-label "laptop (OpenRouter Glimmer)"
uv run python -m eval.run_eval --set eval/tasks.jsonl --name tuned_cloud --device-label "laptop (OpenRouter Glimmer)"
uv run python -m eval.run_eval --set eval/tasks.jsonl --holdout --name tuned_cloud_holdout --device-label "laptop (OpenRouter Glimmer)"
uv run python -m eval.run_eval --set eval/tasks.jsonl --name tuned_cloud_night5_rules --rules eval/reports/learned_rules_night5.md --device-label "laptop (OpenRouter Glimmer)"
RUN_INTEGRATION=1 uv run pytest -q -s tests/test_e2e.py::test_e2e_cloud_grading_no_rules tests/test_e2e.py::test_e2e_cloud_grading
```

Router latency statistics over model calls only, from a raw file (mean, p50, p95, max in ms):

```
uv run python -c "import json,math,sys; r=[json.loads(l) for l in open(sys.argv[1])]; m=sorted(x['latency_ms'] for x in r if x['source'] in ('model','fallback')); print(len(m), round(sum(m)/len(m)), m[math.ceil(.5*len(m))-1], m[math.ceil(.95*len(m))-1], m[-1])" eval/reports/raw/tuned_cloud.jsonl
```

The eval reports written after this change also print the model-call mean and p95 in their Overall table.
