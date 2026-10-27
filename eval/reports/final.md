# Final numbers (Oct 27)

The numbers to quote. They were measured on Oct 27 between 09:03 and 09:51 ET, one run at a time, on one code state: the working tree on top of commit 7bb404b, with the request-topic review fixes in place. No source file changed after 08:58. Glimmer was `meta/muse-glimmer-30b` on OpenRouter, reasoning low, with invented data only and `BASE_DEVICE=laptop`. **These are cloud numbers from development mode, not device speed.** Every report linked here starts with the command that made it, and raw rows are in `raw/` next to each report.

The first final runs, from before request topics and the review fixes, moved unchanged to [before_fixes/](before_fixes/). They and the earlier reports are history only (see the end of this page).

## Leaks

| Run | What was checked | Leaks | Report | Raw |
|---|---|---:|---|---|
| final_cloud | What Muse got for 100 items, plus the 34 texts the simulated teacher's approvals released | 0 | [final_cloud.md](final_cloud.md) | [raw/final_cloud.jsonl](raw/final_cloud.jsonl) |
| final_cloud_holdout | 20 holdout items, plus 6 approved releases | 0 | [final_cloud_holdout.md](final_cloud_holdout.md) | [raw/final_cloud_holdout.jsonl](raw/final_cloud_holdout.jsonl) |
| Five simulated nights, holdout | The holdout scored with the current and the candidate rules every night | 0 every night | [final/nights.md](final/nights.md) | [final/nights.csv](final/nights.csv), [final/raw/nights/](final/raw/nights/) |
| Five simulated days | Every text Muse got on each of 5 days of 20 items, approvals included | 0 every day | [final/nights.md](final/nights.md) | [final/nights.csv](final/nights.csv) (`day_leaks`) |
| Unseen test | 100 practice items no step ever saw, approvals included, scored with the night-0 router and with the rules after night 5 | **1 with the night-0 router**, 0 after the last night | [final/nights.md](final/nights.md#unseen-test) | [final/raw/nights/unseen-night-0.jsonl](final/raw/nights/unseen-night-0.jsonl), [unseen-last-night.jsonl](final/raw/nights/unseen-last-night.jsonl) |
| Grading job, first day | Every tool output of a 24-essay grading job | 0 | [e2e_cloud_no_rules.md](e2e_cloud_no_rules.md) | [raw/e2e_cloud_no_rules.jsonl](raw/e2e_cloud_no_rules.jsonl) |
| Grading job, one learned rule | The same, with one learned "ask first" rule | 0 | [e2e_cloud.md](e2e_cloud.md) | [raw/e2e_cloud.jsonl](raw/e2e_cloud.jsonl) |

**The one leak is real.** Item syn-0765 is a search snippet that names an invented person who is not on the roster, so only Glimmer's second pass for names could tag the name, and it missed it. The router model asked; the simulated teacher approved, and the released text still had the name (raw row: `leak_kinds` empty, `leak_kinds_after_approval` name). Nothing Muse got before the approval leaked. The device's final leak check cannot catch this case: it knows the roster and the tag map, not a name the second pass missed. A real teacher would see the name on the approval card; the simulated one approves by policy without reading the text. With the last night's rules the same item was shared with no leak. This explanation comes from the raw rows; the name pass on that item was not run again.

The first final runs' one flagged day-5 text was a false positive of the eval's checker (the verb "rose" matched the invented student Rose). The checker now treats a one-word name that is also a common word the way the guard does, and the rerun above counts 0 day leaks. The flagged run stays unchanged in [before_fixes/final/](before_fixes/final/nights.md).

A leak is any roster name or nickname, any name of someone off the roster that an item lists (`other_names`), any identifier the item lists, or anything `guard.leaks` finds (roster forms, tag-map values, identifiers, names run together, spelled out or reversed) in a text Muse received. "Held by the final leak check" was 0 in both eval runs.

## What changed since the first final runs

**Request topics.** The device now reads Muse's request as well as the result. It scans the request, raw and tagged, for never-share keywords on the device, and one extra Glimmer call labels it with the policy's request topics: for a student's family (`parents`), for someone outside the class (`third_party`), a whole text (`full_text`), who a tag really is (`deanonymize`) and a class-level question (`class_level`). Document lists and dreaming reports skip that call. The topics join the result's own topics in the router's input and the decision row, so dreaming groups the teacher's answers by who a result is for, and a class-level answer is shared as a summary. A never-share word that appears only in the request asks her instead of refusing. A learned ask first or refuse rule now holds for every narrower group of its kind, so an extra request topic cannot move a result out from under it. Muse is asked to say who each result is for (search_documents has a new `purpose` field).

**How the eval sends per-student items.** The router gets what the connector would really send, not the hand labels. A per_student item whose request has a grading word (grade, feedback, score, rubric) goes in as the grading job's table with `grades, writing`, because that is the only path that makes per-student results. Any other per_student item goes in as free_text with no topics, as the agent's generic answer would. The first final runs used an older mapping. [eval/DATASET.md](../DATASET.md#how-the-eval-sends-an-item) has the full table.

## 1. Decision accuracy per category, 100 items

`uv run python -m eval.run_eval --set eval/tasks.jsonl --name final_cloud --device-label "laptop (OpenRouter Glimmer)"`. Report [final_cloud.md](final_cloud.md), raw [raw/final_cloud.jsonl](raw/final_cloud.jsonl). Router inputs as the connector sends them, no learned rules (a first day).

| Category (expected decision) | Items | Correct | Accuracy | Approval requests | Leaks |
|---|---:|---:|---:|---:|---:|
| share_tagged | 25 | 3 | 12% | 21 | 0 |
| share_summary | 25 | 25 | 100% | 0 | 0 |
| ask_user | 25 | 25 | 100% | 25 | 0 |
| refuse | 25 | 23 | 92% | 2 | 0 |
| **All** | **100** | **76** | **76%** | **48** | **0** |

Agreement with the simulated teacher's policy is also 76%, since every item's expected decision is what her policy wants. Outcome accuracy (what Muse got: shared, waiting or kept) is 76%. 0 errors, 0 fallbacks; 96 items were decided by the model and 4 (document lists) by a rule.

Where the 24 misses went: 21 tagged per-student results were asked about instead of shared (the model's call, no floor); one document list was refused (t002, which names an IEP file and a lunch-status file; the real connector holds those two titles back and shares the rest); and two refuse items were asked about instead of refused (t077, a 504 with no IEP keyword, and t085, a discipline note). **No item was shared that the teacher's policy says to ask about or keep.** The two refuse items still waited for her OK.

Against the first final run ([before_fixes/final_cloud.md](before_fixes/final_cloud.md), 75%), one item changed: t050 (essays counted by score on each criterion) was asked about and is now shared as a summary, with its request labeled `class_level`.

| Run (history) | Inputs | Accuracy | Approval requests | Leaks |
|---|---|---:|---:|---:|
| [baseline_cloud](baseline_cloud.md) (before tuning) | hand labels | 70% | 29 | 0 |
| [tuned_cloud](tuned_cloud.md) (after tuning) | hand labels | 79% | 46 | 0 |
| [post_fix_cloud](post_fix_cloud.md) (after the first review fixes) | production, older mapping | 76% | 48 | 0 |
| [before_fixes/final_cloud](before_fixes/final_cloud.md) (first final run) | production, older mapping | 75% | 49 | 0 |
| **final_cloud** | production | **76%** | **48** | **0** |

## 2. Agreement with the teacher on the holdout

`uv run python -m eval.run_eval --set eval/tasks.jsonl --holdout --name final_cloud_holdout --device-label "laptop (OpenRouter Glimmer)"`. Report [final_cloud_holdout.md](final_cloud_holdout.md), raw [raw/final_cloud_holdout.jsonl](raw/final_cloud_holdout.jsonl).

| Category | Items | Agreement |
|---|---:|---:|
| share_tagged | 5 | 1 of 5 |
| share_summary | 5 | 5 of 5 |
| ask_user | 5 | 5 of 5 |
| refuse | 5 | 4 of 5 |
| **All** | **20** | **75%** |

10 approval requests and 0 leaks, with the 6 approved releases leak-checked too. The same scores as the first final run. The holdout is never trained on, but the dreaming gate selects on it, and the request-topic descriptions were written with the eval task requests in view, which include these 20 items. Treat night-over-night holdout gains below as an upper bound. With 5 items per category, one changed decision moves a category by 20 points.

## 3. The unseen test

Part of the five-night run below (`--unseen eval/synthetic.jsonl`, on by default). 100 items from the practice set, seed 0, 25 per expected decision, leaving out the eval tasks, the holdout and the 420 ids the request-topic check used. The days, the nights and the gate never see them. Report [final/nights.md](final/nights.md#unseen-test), raw [final/raw/nights/unseen-night-0.jsonl](final/raw/nights/unseen-night-0.jsonl) and [unseen-last-night.jsonl](final/raw/nights/unseen-last-night.jsonl).

| Router | Accuracy (= agreement) | Approval requests | Leaks | Errors or fallbacks | share_tagged | share_summary | ask_user | refuse |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Night 0, no learned rules | 70% | 53 | 1 | 0 | 8% | 92% | 100% | 80% |
| After the last night, 10 rules ([final/learned_rules_night5.md](final/learned_rules_night5.md)) | 79% | 30 | 0 | 0 | 64% | 100% | 68% | 84% |

This is the more honest learning number: +9 points and 23 fewer approval requests on items the gate never saw. Two cautions. The items were written by Muse Spark in a style like the eval tasks and labeled with the simulated teacher's own policy, so they are not a real teacher either. And learning made the router ask less than she wants on 8 of the 25 ask_user items: all 8 are search snippets that reach the router with no topics (their hand labels say attendance or reading, which production inputs do not carry), so the rule "snippets with no topics: share tagged", learned from 2 approvals with "don't ask again", now covers them. Those 8 went out tagged, so they are not leaks, but she wanted to be asked. The night-0 leak is explained under Leaks.

## 4. Approval requests per day, five simulated days

`uv run python -m scripts.simulate_nights --nights 5 --per-day 20 --home <empty folder> --out eval/reports/final`. Report [final/nights.md](final/nights.md), data [final/nights.csv](final/nights.csv), the gate's rows per night in [final/raw/nights/](final/raw/nights/). Each day is 20 of the 80 non-holdout items, 5 per expected decision; the simulated teacher (`eval/user_policy.yaml`) answers every request. No practice data, and router inputs are what the connector really sends. Wall time about 34 minutes.

| Day | Rules in place | Approval requests | Wanted by the teacher | Unneeded | Leaks in what Muse got |
|---|---|---:|---:|---:|---:|
| 1 | none | 10 | 5 | 5 | 0 |
| 2 | after night 1 | 8 | 5 | 3 | 0 |
| 3 | after night 2 | 7 | 5 | 2 | 0 |
| 4 | after night 3 | 7 | 5 | 2 | 0 |
| 5 | after night 4 | 6 | 5 | 1 | 0 |

"Wanted" are items her policy says to ask about (5 a day by construction); "unneeded" are items she would have had shared or kept without being asked. Only unneeded requests can go away with learning, and they fell from 5 to 1. For scale: in the first final run (an older code state), the gate kept no rules, so every day ran with no learned rules, and unneeded requests still went 6, 7, 4, 3, 5 ([before_fixes/final/nights.md](before_fixes/final/nights.md)). A day-to-day change of a few requests is within that noise; days 3 to 5 here (2, 2, 1) are below anything that run saw.

## 5. Five nights of dreaming

Same run and files as section 4.

| Night | Holdout agreement | share_tagged | share_summary | ask_user | refuse | Kept | Rules from answers | Holdout items re-run by the gate | Holdout leaks |
|---|---:|---:|---:|---:|---:|---|---:|---:|---:|
| 0 (no rules) | 75% | 20% | 100% | 100% | 80% | - | - | - | 0 |
| 1 | 85% | 40% | 100% | 100% | 100% | yes | 1 | 2 of 20 | 0 |
| 2 | 85% | 60% | 80% | 100% | 100% | yes | 6 | 5 of 20 | 0 |
| 3 | 80% | 60% | 60% | 100% | 100% | yes | 8 | 4 of 20 | 0 |
| 4 | 90% | 60% | 100% | 100% | 100% | yes | 9 | 9 of 20 | 0 |
| 5 | 90% | 60% | 100% | 100% | 100% | yes | 10 | 4 of 20 | 0 |

Accuracy equals agreement every night. Chart: [final/five_nights.png](final/five_nights.png), drawn with `uv run python -m scripts.charts --reports eval/reports/final`. Its "Leaks: 0 on every night" line is true for the holdout and the days; it does not show the unseen test's one leak.

**The gate kept all five nights** (the first final run kept none). The gate is now paired: each night it scores the current rules once and re-runs the new rules only on the holdout items whose learned rules differ (the column above), so a few run-to-run flips cannot reject a good night. Night 3's dip is that noise, not new rules doing worse: the night-2 rules scored 85% as that night's candidate and 80% when re-scored as night 3's current rules, and night 3's candidate tied at 80% (`raw/nights/night-3-*.jsonl`). The 10 rules after night 5 are copied unchanged to [final/learned_rules_night5.md](final/learned_rules_night5.md).

Night seconds (dreaming plus the gate): 111.3 (night 0, scoring only), 125.9, 123.8, 130.9, 165.0, 113.9.

There is no separate 100-task run of the night-5 router: the final_cloud run above is the starting router. Its scores are the holdout after night 5 (90%) and the unseen test (79%). The run is ready if wanted, about $0.10: `uv run python -m eval.run_eval --set eval/tasks.jsonl --name final_cloud_night5_rules --rules eval/reports/final/learned_rules_night5.md --device-label "laptop (OpenRouter Glimmer)"`.

## 6. Time from Muse's request to the result

`RUN_INTEGRATION=1 uv run pytest -q -s tests/test_e2e.py::test_e2e_cloud_grading_no_rules tests/test_e2e.py::test_e2e_cloud_grading` (both in one command, 67.5 s). A simulated Muse calls list_documents on `essays`, then run_private_task ("Grade each essay against rubric.md and write feedback for each student."), then get_result every 2 s; when the router asks, the test approves on the approval page API at once and reads the result.

| Run | Router | Request to the result Muse read | The job itself (created to finished) | Glimmer calls | Leaks | Report | Raw |
|---|---|---:|---:|---:|---:|---|---|
| First day, no learned rules | ask_user (model), approved | 33.4 s | 26.0 s | 28 | 0 | [e2e_cloud_no_rules.md](e2e_cloud_no_rules.md) | [raw/e2e_cloud_no_rules.jsonl](raw/e2e_cloud_no_rules.jsonl) |
| One learned "ask first" rule | ask_user (model), approved | 30.1 s | 25.9 s | 28 | 0 | [e2e_cloud.md](e2e_cloud.md) | [raw/e2e_cloud.jsonl](raw/e2e_cloud.jsonl) |

The 28 calls are 24 grading calls (up to 4 at once on the cloud backend), 2 name passes (one on the document list, one on the result), 1 request-topic call and 1 router call. The job writes 24 feedback files with real names under `BASE_HOME/output/<job id>/`. The rest of the time (7.4 s and 4.2 s) is the release of the result: the name pass (4.3 s and 1.8 s), the request-topic call (1.6 s and 1.1 s) and the router (1.1 s and 0.8 s), plus the wait for the next poll (per-call times in the raw files). A real teacher's time to read the approval card is not included. Tokens: 32681 prompt, 14740 completion (9971 reasoning) on the first day; 32883, 14307 (9635) with the rule.

The two earlier runs with request topics (07:06, [before_fixes/e2e_cloud_no_rules.md](before_fixes/e2e_cloud_no_rules.md) and [before_fixes/e2e_cloud.md](before_fixes/e2e_cloud.md)) took 46.6 s and 37.5 s, mostly a slower grading job (38.4 s and 30.5 s); these are single runs and the cloud's speed varies.

## 7. Speed in cloud mode

| Step | Latency | Tokens/s | Calls | Source |
|---|---|---:|---:|---|
| Router decision, model calls in the 100-item run | 1619 ms mean, 1359 ms median, 3017 ms p95 | | 96 | [raw/final_cloud.jsonl](raw/final_cloud.jsonl) |
| Router decision, bench | 1917 ms mean | 70.6 | 5 | [final/cloud_speed.md](final/cloud_speed.md), [final/raw/cloud_speed.jsonl](final/raw/cloud_speed.jsonl) |
| Second pass for names, bench | 1310 ms mean | 132.0 | 5 | same |
| Request topics, bench (new step) | 805 ms mean | 116.6 | 5 | same |
| Grade one essay, bench | 3832 ms mean | 138.2 | 5 | same |
| Grade one essay, inside the two grading jobs | 4.1 s mean, 5.5 s max | | 48 | [raw/e2e_cloud_no_rules.jsonl](raw/e2e_cloud_no_rules.jsonl), [raw/e2e_cloud.jsonl](raw/e2e_cloud.jsonl) |
| One eval item through egress (name pass, request topics, router, a summary when needed, approval and leak checks) | 5.6 s (9 min 22 s for 100 items, one at a time; 1 min 40 s for the 20 holdout items) | | 100 | wall times in the Cost sections of [final_cloud.md](final_cloud.md#cost) and [final_cloud_holdout.md](final_cloud_holdout.md#cost) |

Bench command: `uv run python -m scripts.bench_speed --label cloud --runs 5 --out eval/reports/final`. Tokens per second is completion tokens (reasoning included) over the whole call's wall time, so it includes the network and prompt processing. The first final bench ([before_fixes/final/cloud_speed.md](before_fixes/final/cloud_speed.md)) measured 2069 ms, 2057 ms and 4203 ms for the router, the name pass and grading; the cloud's speed varies between runs. Router latency and grading inside the jobs from the raw files:

```
uv run python -c "import json,math,sys; r=[json.loads(l) for l in open(sys.argv[1])]; m=sorted(x['latency_ms'] for x in r if x['source'] in ('model','fallback')); print(len(m), round(sum(m)/len(m)), m[math.ceil(.5*len(m))-1], m[math.ceil(.95*len(m))-1], m[-1])" eval/reports/raw/final_cloud.jsonl
uv run python -c "import json,sys; g=[json.loads(l)['latency_ms'] for f in sys.argv[1:] for l in open(f) if json.loads(l).get('kind')=='grade']; print(len(g), round(sum(g)/len(g)), max(g))" eval/reports/raw/e2e_cloud_no_rules.jsonl eval/reports/raw/e2e_cloud.jsonl
```

They print `96 1619 1359 3017 5186` and `48 4109 5515`. Chart: [final/speed.png](final/speed.png) (cloud only, until device reports exist).

## 8. How well Glimmer labels the request

`uv run python -m scripts.check_request_topics --keywords eval/reports/raw/request_topics_keywords.yaml --extra-topic 'reidentify=narrows the class down to one or a few students by a personal trait or a one-time event only they share'`. Report [request_topics.md](request_topics.md), raw [raw/request_topics.jsonl](raw/request_topics.jsonl). Run before the final runs, with the same topic descriptions they used. Glimmer's labels against Spark's hand labels, next to a keyword list, on a fresh draw of 160 invented requests (seed 11) made after the descriptions were frozen:

| Topic | Labeled | Glimmer precision | Glimmer recall | Keywords precision | Keywords recall |
|---|---:|---:|---:|---:|---:|
| parents | 37 | 0.86 | 0.86 | 0.65 | 1.00 |
| third_party | 32 | 0.75 | 0.84 | 0.67 | 0.50 |
| full_text | 6 | 0.50 | 1.00 | 1.00 | 0.67 |
| deanonymize | 6 | 1.00 | 1.00 | 1.00 | 1.00 |
| class_level | 18 | 0.94 | 0.94 | 0.92 | 0.67 |
| reidentify (tried, not shipped) | 10 | 0.50 | 0.30 | n/a | 0.00 |

Glimmer beats the keyword list on third_party and class_level, trades recall for precision on parents and ties on deanonymize. full_text is the weak one: its 6 false positives ask for one paragraph or note, and each would reach the router and the dreaming rules as a full-text request. reidentify was left out of the policy because it feeds a refuse floor and its labels were this unreliable. Half of each sample has an outside-the-class topic, which is rare in the full set, so these precisions are not the precision on all requests. The seen-during-tuning sample and the eval tasks (which include the holdout) are in the report as in-sample. The run cost $0.17 of OpenRouter.

## 9. Grading quality

The plan's number here is a manual spot-check of 10 essays against the rubric, which is **not done yet**: [grading_spotcheck.md](grading_spotcheck.md) has Glimmer's scores and feedback for 10 of the 24 essays next to the rubric, with blank columns for Ethan's scores. Both measures below use the two cloud grading runs from 05:52 (their e2e reports are in git at commit 291b0eb), whose scores are in [raw/grading_spotcheck.jsonl](raw/grading_spotcheck.jsonl); the command to recompute is in the spot-check page.

| Measure | Glimmer run A against run B | Muse Spark 1.3 against Glimmer run A |
|---|---|---|
| Same total | 21 of 24 essays | 15 of 24 |
| Totals within 1 point | 23 of 24 | 23 of 24 |
| Same score on a criterion | 92 of 96 | 82 of 96 |
| Criterion scores within 1 point | 96 of 96 | 96 of 96 |
| Mean absolute difference in total (of 16) | 0.17 | 0.42 |

Spark column: `uv run python -m scripts.grade_crosscheck`, report [grading_crosscheck.md](grading_crosscheck.md), raw [raw/grading_crosscheck.jsonl](raw/grading_crosscheck.jsonl). Spark got the same tagged essays, rubric and grading prompt. Glimmer is the slightly harsher grader, by 0.25 points per essay on average. **Spark is a second opinion, not ground truth:** both are Meta Muse models reading the same prompt, so habits they share agree by construction. Glimmer's totals run 8 to 16 of 16 (mean 14.0, 7 of 24 at 16), and 5 of the 10 picked essays have feedback or strengths with a personal word (family, health, home, a street), a keyword search. The high totals and the personal details are the two things the spot-check should look at.

## Not measured yet

These wait on Ethan's decisions or on hardware. No number for them exists.

| Item | Why not yet | What it needs | Ready to run |
|---|---|---|---|
| Laptop speed with llama-server (time to first token, tokens/s, the grading job on the device) | No local models on this Mac: Ethan asked for cloud only for now, and the disk has about 15 GB free | Free about 20 GB, download the Q4_K_M, `scripts/start.sh` | `uv run python -m scripts.bench_speed --label laptop`, then `run_eval --device-label laptop` |
| Jetson speed and memory | No board picked | A board and `deploy/jetson/install.sh` | `bench_speed --label jetson`; record memory in `jetson_memory.md` |
| Quantization quality (Q4_K_M against i1-IQ1_S and IQ1_M), now with the request-topic pass as a fourth job | Modal spend not approved | Ethan's go-ahead (about $2 to $5) | `scripts/cloud/quant_eval_modal.py --check` passes |
| A router LoRA from dreaming | Cloud training not approved | Ethan's go-ahead (about $6 to $12), then a holdout run on llama-server | `scripts/cloud/train_lora_modal.py --check`; adapters have no gate yet |
| Grading spot-check of 10 essays | Manual | Ethan's scores | [grading_spotcheck.md](grading_spotcheck.md) |
| The flow in the Muse app (connector, pairing, the search purpose, scheduled jobs, the morning message) | Not tried; the relay is not deployed (Claude's deploy attempt was stopped by the session's safety check) | `cd relay && npx wrangler login && ./deploy.sh`, then the Muse app | `docs/MUSE_SETUP.md` |
| The night-5 router on the 100 tasks | Not in the final run list | About $0.10 | The command at the end of section 5 |

## Cost of these runs

$0.5652 of OpenRouter: the key's usage went from $3.2239 to $3.7891, read from `GET /api/v1/key` before and after each run without printing the key. Per run: the 100 items $0.0988, the holdout $0.0178, both grading jobs $0.0317, the speed bench $0.0175, the five nights with the unseen test $0.3881, the charts $0. That sums to $0.5539; another $0.0113 posted after the last model call. Each report's Cost section has its own figure and wall time. Any other use of the key during a run would count in it.

Also cited on this page, from earlier runs: the request-topic check, $0.17 of OpenRouter ([request_topics.md](request_topics.md)), and the Spark cross-check, about $0.14 of the Meta Model API, an estimate from the usage fields ([grading_crosscheck.md](grading_crosscheck.md)). No Modal or local model calls.

## History

Kept for comparison only. Do not quote these as current.

| Files | What they are |
|---|---|
| [before_fixes/final_cloud.md](before_fixes/final_cloud.md), [before_fixes/final_cloud_holdout.md](before_fixes/final_cloud_holdout.md), [before_fixes/final/](before_fixes/final/nights.md) | The first final runs, 05:49 to 06:25, before request topics (commit 291b0eb): 75% on 100 items with 49 requests, holdout 75%, the gate kept none of five nights, and the day-5 false positive |
| [before_fixes/e2e_cloud_no_rules.md](before_fixes/e2e_cloud_no_rules.md), [before_fixes/e2e_cloud.md](before_fixes/e2e_cloud.md) | The grading runs at 07:06, with request topics and before the review fixes (commit 7bb404b). The 05:52 runs without request topics (32.4 s and 31.3 s) are in git at commit 291b0eb |
| [topics_cloud.md](topics_cloud.md), [topics_cloud_holdout.md](topics_cloud_holdout.md) | Request topics before the review fixes (76%, holdout 70%); see the note in each about their router inputs |
| [post_fix_cloud.md](post_fix_cloud.md), [post_fix.md](post_fix.md), [post_fix/](post_fix/) | After the first review fixes |
| [baseline_cloud.md](baseline_cloud.md), [tuned_cloud.md](tuned_cloud.md), [nights.md](nights.md), [tuning_log.md](tuning_log.md), [cloud_speed.md](cloud_speed.md) | Tuning, on hand-labeled inputs |
