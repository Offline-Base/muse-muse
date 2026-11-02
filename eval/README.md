# Measurements

Every number we quote about Muse Muse and Muse Privacy, with where it came from, including the ones that went badly. This folder holds no results of its own: it points at the docs and reports where each run was recorded, and nothing here was re-measured when this page was written (Nov 1, 2026). Where this page and a source disagree, the source wins.

## How to read this

- **Real run:** seen in a run on the platform or the device.
- **Harness:** a real model, GPU and judge, driven by `scripts/dev/tune-harness.ts` or `scripts/dev/quant-harness.ts`. Launch, callbacks and the sweep were stood in for, not run through the site.
- **Test model:** `muse-spark-1.3-contributor` with made-up data. A pass there doesn't prove the same thing on Muse Wonder.
- **Direct:** run straight on a lab box or rented GPU, not through the platform's route.
- **Simulated:** a script or policy file plays the part. In Muse Privacy every teacher is a policy file and every record is invented. There are no real users.

Scores out of 10 come from a blind judge model reading pairs of answers. The topic in the Nov 1 tunes is invented, so the base model starts out knowing nothing, which makes them easy tests.

## What failed or didn't improve

Read this first.

| What | Number | Label | Source |
|---|---|---|---|
| Two-round tuning loop on Llama 3.2 3B, loop a56febc8 | **6.67, 6.67, 6.54** overall, base about 2.5. Sealed half 6.50, 6.48, 6.38. **No improvement**, within the judge's noise. Writers $2.78, judges $2.99 | Harness | [PROVE_RESULTS](../docs/PROVE_RESULTS.md), [BUILD_LOG](../docs/BUILD_LOG.md), [TRAINING](../docs/TRAINING.md) |
| Big build 22562315 | **Partial.** 101 minutes, $0.93, 2 of 6 milestones, 20 of 40 requirements unmet, 4 of 6 rounds at their limit, no fix round, 0 subagents. Two fixes followed, with no rerun | Test model | [BUILD_LOG, "two more full build fixes"](../docs/BUILD_LOG.md) |
| Long build on Muse Wonder, b2996b46 | **Did not finish.** 64 minutes, $16.55. First 5 milestones failed, rounds cut at 5 to 8 minutes, 0 subagents. Stopped by hand in fix round 1 on a spend estimate that ran high. No finished long build on Muse Wonder exists | Real run on a Preview | [PROVE_RESULTS](../docs/PROVE_RESULTS.md) |
| Tuned Muse Glimmer doing privacy decisions | No mode beat "policy decides, LFM labels" (81.0% and 82.0%). Glimmer deciding 48.5% and 54.0%, tightening 62.5% and 64.0%, labeling 47.0% and 45.0%. Development sets on a rented A100, not a device. The sealed set has not been scored | Simulated teacher, invented items | [matrix_a100_final](../privacy/eval/reports/matrix_a100_final.md), [glimmer_prereg](../privacy/eval/reports/glimmer_prereg.md) |
| Muse Privacy on the `fresh_200` set, Oct 30 | **10 leaks**, 78.5% (157 of 200), LFM labels with the policy deciding. The report doesn't give a cause, and we found no later report of this exact set. Later runs on other sets had 0 leaks (below) | Simulated teacher, invented items | [device_only_fresh_200](../privacy/eval/reports/device_only_fresh_200.md) |
| Muse Privacy holdout | 65.0% (13 of 20), against 81.0% on the 100 tasks it sits inside | Simulated teacher, invented items | [matrix_baseline_attack_fixes](../privacy/eval/reports/matrix_baseline_attack_fixes.md) |
| Dreaming on the device, 5 nights, before today's router default | 74.0% before and after on 100 unseen items, approval requests 44 before and after: learning changed nothing there | Simulated teacher, invented items | [nights_device_rules](../privacy/eval/reports/nights_device_rules/nights.md) |
| Llama Prompt Guard 2 on planted instructions | 22M: explicit 6 of 10 alone, 5 of 10 in an essay; subtle 0 of 8 and 1 of 8. 86M: explicit 8 and 7 of 10; subtle 0 and 1 of 8 | Invented attacks | [22M](../privacy/eval/reports/prompt_guard_22m.md), [86M](../privacy/eval/reports/prompt_guard_86m.md) |
| Guest fine-tune on production | **Not run.** `POST /api/train/plan` answered 429 `trainer_ip_cap` before any plan. No dataset, job or GPU. $0 | Real attempt | [BUILD_LOG, "guest fine-tune proof"](../docs/BUILD_LOG.md) |
| One-bit tuned Glimmer under Meta's stock template | 1 of 5 usable, 2 looped. Under the tuned template 2 of 5 general answers clearly right, the same as base. Its 30 of 30 answer check is only under the tuned template | Harness | [BUILD_LOG, "first real one-bit recipe"](../docs/BUILD_LOG.md) |
| Q4_K_M of that tune | KL 0.030453 against a limit of 0.03, so it was left out. The miss is within the measurement's own error | Harness | [BUILD_LOG](../docs/BUILD_LOG.md) |
| First Glimmer lab run | Base won 28 to 11, which exposed an eval bug: the tuned model answered inside its reasoning channel | Real run | [README](../README.md#fine-tuning-lab-spark-teaches-glimmer) |
| Reinforcement learning score | First reported tuned 16 of 40. That was a scoring bug, fixed; the same adapter scored 40 of 40 | Harness | [BUILD_LOG](../docs/BUILD_LOG.md), [SUBMISSION](../docs/SUBMISSION.md) |
| Second template polish | 5.50 against 5.91 for the first polish, at 64% more cost. Not merged | Real runs | [README](../README.md#results-from-the-oct-27-test-runs) |
| Case agent stopping to ask for evidence | Failed: "asked for evidence" appeared only in seeded sample turns. The sign-off gate did hold | Test model | [PROVE_RESULTS](../docs/PROVE_RESULTS.md) |
| Mock glasses on iOS 26.5 | Failed with `no_eligible_device`, cause not known. Passed on iOS 18.4 on a test page | Direct | [PROVE_RESULTS](../docs/PROVE_RESULTS.md) |
| Sandbox previews in a browser | Don't hydrate without a config line that isn't in the template | Test model | [PROVE_RESULTS](../docs/PROVE_RESULTS.md) |

## Builds

| What | Number | Label | Source |
|---|---|---|---|
| Local batch, Oct 27 | 24 of 24 passed their checks (none deployed), 3 to 9 minutes, about $0.30 to $1.80 each. Local runs stop before deploy | Real run | [README](../README.md#results-from-the-oct-27-test-runs) |
| Blind product quality, Oct 27 | 5.5 of 10 average on 24 products. After a template polish, an 11-build canary scored 5.91, up from 5.14 for those 11 | Real run, judged on screenshots | [README](../README.md#results-from-the-oct-27-test-runs) |
| Muse Code spend `run.usage` left out | Reminder agents were 31% to 43% of each build's real Muse Code spend | Real run | [README](../README.md#results-from-the-oct-27-test-runs) |
| Tracker rerun 020084d8 | Live, judge pass, 15 of 15 met, 23m32, $0.085. Its brief has 15 requirements against the Wonder build's 21, so it doesn't prove the screenshot fix on the original failure | Test model | [BUILD_LOG](../docs/BUILD_LOG.md) |
| Subagents with BUILD_RANGE on | 8, 9, 7 and 8 subagents in four builds, read while they were still running. No Muse Wonder build has been read with it on | Test model | [BUILD_LOG, "FAST_BUILDS"](../docs/BUILD_LOG.md) |
| Recipes, Nov 1 | Agent, case agent, API, code sessions, reports and simulated loops passed; voice and games pending. $0.03 to $0.13 each | Test model | [PROVE_RESULTS](../docs/PROVE_RESULTS.md) |
| Keep editing and restore | Edit went live. A restored v3 was byte-identical to v1 in all 79 files | Test model | [PROVE_RESULTS](../docs/PROVE_RESULTS.md) |
| VR, glasses, extension, gadget | Passed on an emulated Quest, a fake bridge, real Chromium and a simulated board. No real glasses or board | Test model, partly simulated | [PROVE_RESULTS](../docs/PROVE_RESULTS.md) |

## Fine-tuning

| What | Number | Label | Source |
|---|---|---|---|
| Muse Glimmer 30B, job 1898e46c, Nov 1 | **Tuned 7.93, base 2.5**, won 40 of 40; sealed half 7.90 and 2.45. **A short harness run on an invented topic:** 120 steps, 900 rows, 40 kept-aside prompts, on an H100. GPU about $1.86, judge $0.52. Not a product-quality tune | Harness | [PROVE_RESULTS](../docs/PROVE_RESULTS.md), [model card](../docs/model-cards/muse-glimmer-30b-zubrelian-moss-guide-lora-1898e46c.md), [BUILD_LOG](../docs/BUILD_LOG.md) |
| Llama 3.2 3B, job e1b00ffa | Tuned 6.67, base 2.55, won 95 of 100. Invented topic. Dataset $0.22, judge $1.54, GPU about $0.39. Not Glimmer | Harness | [PROVE_RESULTS](../docs/PROVE_RESULTS.md) |
| Glimmer 30B in the lab's own flow, second run | Tuned 8.88, base 1.95, won 40 of 40. A100, 42 minutes, $1.39. Judged by Muse Spark 1.3 | Real run | [README](../README.md#fine-tuning-lab-spark-teaches-glimmer) |
| Reinforcement learning, 15 steps on r30b | Tuned 40 of 40, base 27 of 40. Easy arithmetic | Harness | [PROVE_RESULTS](../docs/PROVE_RESULTS.md) |
| Knowledge probes, stage 1, not this flow | Of 1,500 new-knowledge probes: tuned Q4_K_M 29.9%, tuned IQ1_S 8.1%, base IQ1_S 0.8%. IQ1_S kept 34 of 40 old facts | Direct | [KNOWLEDGE_RUN_LOG](../docs/KNOWLEDGE_RUN_LOG.md) |

## A file for a device

None of these ran on a Jetson, a Raspberry Pi or a phone.

| What | Number | Label | Source |
|---|---|---|---|
| Tuned Llama Q4_K_M GGUF | 2,019,377,312 bytes. 168.8 tokens a second, on the A10 GPU it was made on | Harness | [PROVE_RESULTS](../docs/PROVE_RESULTS.md) |
| Tuned Glimmer IQ1_S, adapter 1898e46c | 6,526,418,944 bytes, KL 0.942644, same top token 57.56%, 30 of 30 answer check under its tuned template, agreement 0 of 30. Uploaded to a private Hub repo | Harness | [BUILD_LOG](../docs/BUILD_LOG.md), [run files](../docs/log/quant-run-tuned-2026-11-01) |
| The same file under 8 and 7 GB limits | 2.48 to 2.51 tokens a second, 3.89 to 6.08 s to the first token, no out-of-memory kill. **x86 CPU under a memory limit standing in for a Jetson. Not a Jetson** | Simulated device | [BUILD_LOG](../docs/BUILD_LOG.md) |

## Device lab

| What | Number | Label | Source |
|---|---|---|---|
| A live product opened on | Mac 0.5 s, Android emulator 1.1 s, Windows 2.1 s, iOS simulator 3.5 s | Direct | [PROVE_RESULTS](../docs/PROVE_RESULTS.md) |
| Real Galaxy S25 on Device Farm | Selftest ok, loaded in 1292 ms, $0.15 | Direct | [PROVE_RESULTS](../docs/PROVE_RESULTS.md) |

## Muse Privacy

All invented data with a simulated teacher, on a laptop with LFM3-VL-2B unless the row says otherwise. `fresh_200_b` is a development set, not unseen. The sealed set has not been scored, and the persona study has not run.

| What | Number | Label | Source |
|---|---|---|---|
| Decisions on `fresh_200_b`, 200 items, today's default | 82.0% (164 of 200), 0 leaks, 76 approval requests, 28 needless, 2 unsafe shares, 3 over-refusals | Simulated | [matrix_baseline_attack_fixes](../privacy/eval/reports/matrix_baseline_attack_fixes.md) |
| Decisions on `tasks`, 100 items | 81.0% (81 of 100), 0 leaks, 27 approval requests, 3 unsafe shares | Simulated | [matrix_baseline_attack_fixes](../privacy/eval/reports/matrix_baseline_attack_fixes.md) |
| The same `fresh_200_b` before the router fixes | 74.5% (149 of 200), 0 leaks, 88 approval requests | Simulated | [score_build_fresh_200_b](../privacy/eval/reports/score_build_fresh_200_b.md) |
| Glimmer writing, policy deciding on LFM's labels, rented A100 | 80.5% and 81.0%, against 81.0% and 82.0% on LFM alone, 0 leaks. Not better, McNemar p = 1. Not on a device | Simulated | [matrix_a100_final](../privacy/eval/reports/matrix_a100_final.md) |
| Six demo scenes | All six reach their expected statuses, 0 of 18 tool outputs hold a private value. A script plays Muse, in process, not the Muse app | Simulated | [rehearsal](../privacy/eval/reports/muse_app/rehearsal_2026-10-31.md) |
| Speed of the laptop's LFM3-VL-2B | 210.4 tokens a second generating (tg128). Grading job 32.7 s for 24 essays. Time, not grade quality, which hasn't been measured on this model | Real run on one laptop, invented class | [device_mac-lfm](../privacy/eval/reports/device_mac-lfm.md) |
| Earlier, Glimmer on OpenRouter, not today's setup | 0 leaks in the final runs. Router 76% on 100 items, 75% on the holdout, 72% then 81% on 100 unseen items. Same total on 21 of 24 essays across two Glimmer runs, 15 of 24 against Muse Spark 1.3 | Simulated, cloud | [final](../privacy/eval/reports/final.md), [grading_crosscheck](../privacy/eval/reports/grading_crosscheck.md) |

More rows, with the command behind each one, are in [privacy/README.md](../privacy/README.md#numbers).

## Spend recorded on Nov 1

Meta plus sandbox about $33.52, GPU about $8.16, AWS about $0.16 new. Sandbox time, Muse Code sessions' own cost and four builds' final figures aren't included. See [PROVE_RESULTS](../docs/PROVE_RESULTS.md#spend-by-budget).

## Not proven anywhere

As of the [Nov 1 list](../docs/PROVE_RESULTS.md#not-proven-anywhere), which later log entries may have moved:

- A finished long build on Muse Wonder, or any recipe on Muse Wonder.
- A published product from those tests: the extension zip, `selfhost.zip` and automatic packaging.
- The platform launching a tune, https callbacks, the sweep and Hugging Face upload from a tune.
- A real chain or platform power.
- Composio inside a product, a real board, real glasses.
- A tuned model from this flow on anyone's own hardware, or a product answering from its own tuned model ([docs/STORY.md](../docs/STORY.md)).
- Muse Privacy in the real Muse app, on a Jetson, or with real users ([privacy/README.md](../privacy/README.md#known-limits)).
