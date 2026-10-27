# Final numbers (Oct 27)

The numbers to quote. They were measured on Oct 27 between 11:35 and 13:54 ET, one run at a time, on one code state: the working tree on top of commit 8afe137, with the guard fix for names the model finds in place (`base/guard.py` sha256 d7bfc2325a30; see [What changed since the last round](#what-changed-since-the-last-round)). No file the runs use changed after 11:34. Afterwards only `scripts/charts.py` and its test (`tests/test_simulate.py`) changed, to draw the chart's leak line, plus `relay/wrangler.jsonc` (its KV namespace id, at 12:31), and no run imports or reads them. Glimmer was `meta/muse-glimmer-30b` on OpenRouter, reasoning low, with invented data only and `BASE_DEVICE=laptop`. **These are cloud numbers from development mode, not device speed.** The grading runs, the speed bench and the nights (11:47 on) ran while OpenRouter served Glimmer several times more slowly than in the last round, with about the same tokens per call, so the times in sections 6 and 7 and the night seconds are not typical ([final/cloud_speed.md](final/cloud_speed.md#against-the-last-run)). Every report linked here starts with the command that made it, and raw rows are in `raw/` next to each report.

The last round's reports (09:03 to 09:51, before the guard fix) were rerun in place; they are in git at commit 8afe137 (`git show 8afe137:eval/reports/final.md`). The first final runs, from before request topics, are in [before_fixes/](before_fixes/). Both are history only (see the end of this page).

## Leaks

| Run | What was checked | Leaks | Report | Raw |
|---|---|---:|---|---|
| final_cloud | What Muse got for 100 items, plus the 34 texts the simulated teacher's approvals released | 0 | [final_cloud.md](final_cloud.md) | [raw/final_cloud.jsonl](raw/final_cloud.jsonl) |
| final_cloud_holdout | 20 holdout items, plus 6 approved releases | 0 | [final_cloud_holdout.md](final_cloud_holdout.md) | [raw/final_cloud_holdout.jsonl](raw/final_cloud_holdout.jsonl) |
| final_cloud_night5_rules | The 100 items with the rules after night 5, plus 23 approved releases | 0 | [final_cloud_night5_rules.md](final_cloud_night5_rules.md) | [raw/final_cloud_night5_rules.jsonl](raw/final_cloud_night5_rules.jsonl) |
| Five simulated nights, holdout | The holdout scored with the current and the candidate rules every night | 0 every night | [final/nights.md](final/nights.md) | [final/nights.csv](final/nights.csv), [final/raw/nights/](final/raw/nights/) |
| Five simulated days | Every text Muse got on each of 5 days of 20 items, approvals included | 0 every day | [final/nights.md](final/nights.md) | [final/nights.csv](final/nights.csv) (`day_leaks`) |
| Unseen test | 100 practice items no step ever saw, approvals included, scored with the night-0 router and with the rules after night 5 | 0 with the night-0 router (1 in the last round), 0 after the last night | [final/nights.md](final/nights.md#unseen-test) | [final/raw/nights/unseen-night-0.jsonl](final/raw/nights/unseen-night-0.jsonl), [unseen-last-night.jsonl](final/raw/nights/unseen-last-night.jsonl) |
| Grading job, first day | Every tool output of a 24-essay grading job | 0 | [e2e_cloud_no_rules.md](e2e_cloud_no_rules.md) | [raw/e2e_cloud_no_rules.jsonl](raw/e2e_cloud_no_rules.jsonl) |
| Grading job, one learned rule | The same, with one learned "ask first" rule | 0 | [e2e_cloud.md](e2e_cloud.md) | [raw/e2e_cloud.jsonl](raw/e2e_cloud.jsonl) |

"Held by the final leak check" was 0 in all three eval runs.

**The last round's one leak.** In the last round (commit 8afe137), item syn-0765 of the unseen test leaked after approval. It is a search snippet naming an invented person who is not on the roster, "Bennick Cinderfall" and later "Bennick" alone, so only Glimmer's second pass for names could tag the name. The old guard tagged only the exact strings that pass returned, so when it returned the full name alone, the later "Bennick" stayed in the text, and the final leak check, which knows only the roster and the tag map, could not catch it. The guard now tags every word of a name the pass reports and stores each one in the tag map, where the final check knows it (see [What changed since the last round](#what-changed-since-the-last-round)). This round syn-0765 did not leak: with the night-0 router the model asked, the simulated teacher approved, and the released text had no leak; after the last night it was shared tagged with no leak ([final/nights.md](final/nights.md#unseen-test)). That is one run of a pass that varies from run to run, and the raw rows do not record what the pass returned, so the sweep below is the stronger evidence.

**What the guard does with each kind of name-pass answer.** `uv run python -m scripts.check_name_parts --before-module guard_8afe137.py`, where `guard_8afe137.py` is `git show 8afe137:base/guard.py` saved outside the repo. Report [name_parts.md](name_parts.md), raw [raw/name_parts.jsonl](raw/name_parts.jsonl). No model call: a fake name pass returns a fixed answer built from each item's hand labels, so this measures the guard, not how often Glimmer gives each answer. The items are the 1384 whose names the roster pass alone leaves in the text (1380 practice items and 4 eval tasks). Before is the guard at commit 8afe137, after is the guard these runs used.

| Name-pass answer | Items | Leaked before | Leaked after | Over-tags before | Over-tags after (items) |
|---|---:|---:|---:|---:|---:|
| Every name | 1384 | 0 | 0 | 0 | 30 (15) |
| Only each person's full name | 1384 | 15 | 0 | 0 | 30 (15) |
| Only the first word | 1384 | 0 | 0 | 0 | 33 (16) |
| Only the last word | 1384 | 31 | 1 | 0 | 33 (16) |
| Nothing | 1384 | 1384 | 1384 | 0 | 0 |

Every leaked item also passed the final check, so egress would have sent it (each run in the sweep starts with a fresh tag map). syn-0765 is one of the 15 full-name leaks before. The one leak left, syn-0728 under the last-word answer, is a hand-label slip: the only word reported is a common word written in lowercase. Of the over-tags, 30 for every answer that reports names are the words after a one-word labeled name, likely family names the hand labels left out, and 3 (first-word and last-word answers only) are other capitalized words next to a name. Items with identifier digits left in the tagged text: 2 before and 2 after, for every answer. The sweep does not measure a pass that reports a word that is not a name (a capitalized false positive next to other capitalized words would be taken in too), and it cannot help with a name the pass misses entirely: the "Nothing" row leaks every item by construction.

**A policy miss the leak count does not see.** A leak is a name or an identifier. On day 2 of the simulation, t085, a discipline note with no never-share keyword that the teacher's policy refuses, was shared tagged with no card. The rule that did it is night 1's only rule, "Document snippets (kind: snippet; topics: none): share tagged", learned from two approved snippets. The night-5 rules shared t085 the same way on the 100 tasks. Its names were tagged, so it counts 0 above, but Muse got a tagged discipline note she would have kept ([final/nights.md](final/nights.md#unseen-test), [final_cloud_night5_rules.md](final_cloud_night5_rules.md#which-items-these-are)).

A leak is any roster name or nickname, any name of someone off the roster that an item lists (`other_names`), any identifier the item lists, or anything `guard.leaks` finds (roster forms, tag-map values, identifiers, names run together, spelled out or reversed) in a text Muse received.

The first final runs' one flagged day-5 text was a false positive of the eval's checker (the verb "rose" matched the invented student Rose). The checker treats a one-word name that is also a common word the way the guard does, and the flagged run stays unchanged in [before_fixes/final/](before_fixes/final/nights.md).

## What changed since the last round

**The guard tags every part of a name the model finds.** Glimmer's second pass reports names the roster does not know (siblings, guardians, staff). The guard used to tag only the exact strings it reported. Now (`base/guard.py`; the full rules are in [docs/CONTRACTS.md](../../docs/CONTRACTS.md#guard-baseguardpy)):

- Each word of a name the pass reports is tagged alone too, with its own `[Person N]`, and so is each 3+ letter piece of a hyphenated word. Titles, suffixes such as Jr and particles such as de and van are left out.
- A one-word name the pass reported on its own takes in up to two capitalized words on each side, one step only: "Cinderfall" alone still tags "Bennick Cinderfall". It stops at common words, titles, roster names, single letters, words that touch a digit or an identifier, words the text also writes in lowercase, and a short list of greetings, labels and roles (Hi, Overall, Nurse).
- A name or a part that is also a common word (Grace, May) is tagged only where the text capitalizes it and does not use it as the word, with the roster's rules.
- Every one of these values is stored in the tag map as a known value, so a later text with only "Bennick" is tagged with no model call, and the final leak check reports it if it is not.
- `LocalLLM.llm_names` keeps each word of a name that does not occur whole ("Bennick Cinderfall" over "Cinderfall, Bennick").

The cost is more tags: the sweep above finds 30 to 33 over-tags on 15 to 16 of 1384 items, against 0 before. A part gets its own `[Person N]`, not linked to the full name's, so Muse can read one person as two. A part that is also a common word is tagged where the text capitalizes it and the context rules do not see it used as the word ("Grace period ends Friday" after the pass reported "Grace Thornquist"). [docs/DECISIONS.md](../../docs/DECISIONS.md) has the trade-off.

**The chart's leak line** now reads the holdout, the days and the unseen test from the reports, instead of a fixed "Leaks: 0 on every night" (`scripts/charts.py`).

## What changed before that, since the first final runs

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

Where the 24 misses went: 21 share_tagged items were asked about instead of shared (by their hand-labeled kind, 10 per-student results, 7 snippets and 4 free-text answers; the model's call, no floor); one document list was refused (t002, which names an IEP file and a lunch-status file; the real connector holds those two titles back and shares the rest); and two refuse items were asked about instead of refused (t077, a 504 with no IEP keyword, and t085, a discipline note). **No item was shared that the teacher's policy says to ask about or keep.** The two refuse items still waited for her OK.

Against the last round (commit 8afe137, also 76%), every item got the same decision; only t007's request topics gained `class_level` (`raw/final_cloud.jsonl` against the same file at that commit). Against the first final run ([before_fixes/final_cloud.md](before_fixes/final_cloud.md), 75%), one item changed: t050 (essays counted by score on each criterion) was asked about and is now shared as a summary, with its request labeled `class_level`.

| Run (history) | Inputs | Accuracy | Approval requests | Leaks |
|---|---|---:|---:|---:|
| [baseline_cloud](baseline_cloud.md) (before tuning) | hand labels | 70% | 29 | 0 |
| [tuned_cloud](tuned_cloud.md) (after tuning) | hand labels | 79% | 46 | 0 |
| [post_fix_cloud](post_fix_cloud.md) (after the first review fixes) | production, older mapping | 76% | 48 | 0 |
| [before_fixes/final_cloud](before_fixes/final_cloud.md) (first final run) | production, older mapping | 75% | 49 | 0 |
| final_cloud at commit 8afe137 (last round, before the guard fix) | production | 76% | 48 | 0 |
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

10 approval requests and 0 leaks, with the 6 approved releases leak-checked too. The same scores as the last round and the first final run. The holdout is never trained on, but the dreaming gate selects on it, and the request-topic descriptions were written with the eval task requests in view, which include these 20 items. Treat night-over-night holdout gains below as an upper bound. With 5 items per category, one changed decision moves a category by 20 points.

## 3. The unseen test

Part of the five-night run below (`--unseen eval/synthetic.jsonl`, on by default). 100 items from the practice set, seed 0, 25 per expected decision, leaving out the eval tasks, the holdout and the 420 ids the request-topic check used. The days, the nights and the gate never see them. Report [final/nights.md](final/nights.md#unseen-test), raw [final/raw/nights/unseen-night-0.jsonl](final/raw/nights/unseen-night-0.jsonl) and [unseen-last-night.jsonl](final/raw/nights/unseen-last-night.jsonl).

| Router | Accuracy (= agreement) | Approval requests | Leaks | Errors or fallbacks | share_tagged | share_summary | ask_user | refuse |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Night 0, no learned rules | 72% | 53 | 0 | 0 | 8% | 100% | 100% | 80% |
| After the last night, 9 rules ([final/learned_rules_night5.md](final/learned_rules_night5.md)) | 81% | 28 | 0 | 0 | 68% | 100% | 68% | 88% |

This is the more honest learning number: +9 points and 25 fewer approval requests on items the gate never saw. The last round measured 70% and 79%, with 53 and 30 approval requests, 10 rules and the one leak (commit 8afe137). Two cautions. The items were written by Muse Spark in a style like the eval tasks and labeled with the simulated teacher's own policy, so they are not a real teacher either. And learning made the router ask less than she wants on 8 of the 25 ask_user items, the same count as in the last round. All 8 are search snippets that reach the router with no topics, so the rule "snippets with no topics: share tagged", learned from 2 approvals with "don't ask again", covers them. Seven have hand labels attendance or reading, which production inputs do not carry; the eighth (syn-0523, a seating excerpt) has no hand topics, and her policy asks about it by default. Those 8 went out tagged, so they are not leaks, but she wanted to be asked. syn-0765, the last round's leak, is under Leaks.

## 4. Approval requests per day, five simulated days

`uv run python -m scripts.simulate_nights --nights 5 --per-day 20 --home <empty folder> --out eval/reports/final`. Report [final/nights.md](final/nights.md), data [final/nights.csv](final/nights.csv), the gate's rows per night in [final/raw/nights/](final/raw/nights/). Each day is 20 of the 80 non-holdout items, 5 per expected decision; the simulated teacher (`eval/user_policy.yaml`) answers every request. No practice data, and router inputs are what the connector really sends. Wall time 1 h 43 min 48 s, in the slow hours (about 34 minutes in the last round).

| Day | Rules in place | Approval requests | Wanted by the teacher | Unneeded | Leaks in what Muse got |
|---|---|---:|---:|---:|---:|
| 1 | none | 10 | 5 | 5 | 0 |
| 2 | after night 1 | 9 | 5 | 4 | 0 |
| 3 | after night 2 | 7 | 5 | 2 | 0 |
| 4 | after night 3 | 6 | 5 | 1 | 0 |
| 5 | after night 4 | 6 | 5 | 1 | 0 |

"Wanted" are items her policy says to ask about (5 a day by construction); "unneeded" are items she would have had shared or kept without being asked. Only unneeded requests can go away with learning, and they fell from 5 to 1. For scale: in the first final run (an older code state), the gate kept no rules, so every day ran with no learned rules, and unneeded requests still went 6, 7, 4, 3, 5 ([before_fixes/final/nights.md](before_fixes/final/nights.md)); the last round went 5, 3, 2, 2, 1. A day-to-day change of a few requests is within that noise; days 3 to 5 here (2, 1, 1) are below anything the first final run saw. Day 2 also had the policy miss described under Leaks: t085 was shared tagged with no card.

## 5. Five nights of dreaming

Same run and files as section 4.

| Night | Holdout agreement | share_tagged | share_summary | ask_user | refuse | Kept | Rules from answers | Holdout items re-run by the gate | Holdout leaks |
|---|---:|---:|---:|---:|---:|---|---:|---:|---:|
| 0 (no rules) | 75% | 20% | 100% | 100% | 80% | - | - | - | 0 |
| 1 | 85% | 40% | 100% | 100% | 100% | yes | 1 | 2 of 20 | 0 |
| 2 | 90% | 60% | 100% | 100% | 100% | yes | 6 | 5 of 20 | 0 |
| 3 | 85% | 60% | 80% | 100% | 100% | yes | 8 | 4 of 20 | 0 |
| 4 | 85% | 60% | 80% | 100% | 100% | yes | 8 | 4 of 20 | 0 |
| 5 | 90% | 60% | 100% | 100% | 100% | yes | 9 | 4 of 20 | 0 |

Accuracy equals agreement every night. Chart: [final/five_nights.png](final/five_nights.png), drawn with `uv run python -m scripts.charts --reports eval/reports/final`. Its leak line reads "Leaks: holdout 0 every night; days 0 every day; unseen test 0 with the night-0 router, 0 after the last night". Like every leak count here, it counts names and identifiers, not policy misses such as t085.

**The gate kept all five nights**, as in the last round (the first final run kept none). The gate is paired: each night it scores the current rules once and re-runs the new rules only on the holdout items whose learned rules differ (the column above), so a few run-to-run flips cannot reject a good night. The dip after night 3 (90% to 85%) is that noise, not new rules doing worse: that night the gate re-ran night 2's rules on the holdout and they scored 17 of 20, and night 3's candidate tied at 17. It goes the other way too: night 4's candidate scored 17 of 20, and the same rules scored 18 when re-run as night 5's current rules. From the gate's rows:

```
uv run python -c "import json; print(' '.join(f'{n}{k[:2]}:' + str(sum(r['expected']==r['decision'] for r in map(json.loads, open(f'eval/reports/final/raw/nights/night-{n}-{k}.jsonl')))) for n in range(1,6) for k in ('current','candidate')))"
```

It prints `1cu:15 1ca:17 2cu:17 2ca:18 3cu:17 3ca:17 4cu:17 4ca:17 5cu:18 5ca:18` (items correct of 20, for each night's current and candidate rules). The 9 rules after night 5 are copied unchanged to [final/learned_rules_night5.md](final/learned_rules_night5.md).

Night seconds (dreaming plus the gate): 645.4 (night 0, scoring only), 606.4, 235.2, 503.3, 432.9, 363.4. That is about 2 to 6 times the last round's 111.3 to 165.0, because OpenRouter served Glimmer more slowly during this run: the router took 7 to 8 s per item on night 1 ([final/nights.md](final/nights.md)).

### The night-5 router on the 100 tasks

`uv run python -m eval.run_eval --set eval/tasks.jsonl --name final_cloud_night5_rules --rules eval/reports/final/learned_rules_night5.md --device-label "laptop (OpenRouter Glimmer)"`. Report [final_cloud_night5_rules.md](final_cloud_night5_rules.md), raw [raw/final_cloud_night5_rules.jsonl](raw/final_cloud_night5_rules.jsonl).

**This is in-sample, not a fresh test.** The 100 tasks include the 20 holdout items the gate selected these rules on every night, and the other 80 are the day items the rules were learned from. Do not quote 88% as how well learning generalizes; the unseen test's 81% is that number.

| Category (expected decision) | Items | Correct | Accuracy | Approval requests | Leaks |
|---|---:|---:|---:|---:|---:|
| share_tagged | 25 | 17 | 68% | 7 | 0 |
| share_summary | 25 | 22 | 88% | 3 | 0 |
| ask_user | 25 | 25 | 100% | 25 | 0 |
| refuse | 25 | 24 | 96% | 0 | 0 |
| **All** | **100** | **88** | **88%** | **35** | **0** |

Holdout items 18 of 20, day items 70 of 80. Against final_cloud (the same 100 items with no learned rules, the same day): accuracy 76% to 88%, approval requests 48 to 35, 0 leaks in both, with 23 approved releases leak-checked here. The 12 misses: 7 share_tagged items were asked about (t008, t010, t013, t022, t023, t024, t025; t010 and t023 are holdout items); t002 was refused by the never-share floor, as in final_cloud; 3 class-level summaries were asked about (t039, t041, t050), which final_cloud shared as summaries; and **t085 was shared tagged although her policy refuses it** (see Leaks). Apart from t002, each of these was the model's call, with no floor.

## 6. Time from Muse's request to the result

`RUN_INTEGRATION=1 uv run pytest -q -s tests/test_e2e.py::test_e2e_cloud_grading` and `RUN_INTEGRATION=1 uv run pytest -q -s tests/test_e2e.py::test_e2e_cloud_grading_no_rules`, run as two commands so each has its own cost (89 s and 125 s). A simulated Muse calls list_documents on `essays`, then run_private_task ("Grade each essay against rubric.md and write feedback for each student."), then get_result every 2 s; when the router asks, the test approves on the approval page API at once and reads the result.

| Run | Router | Request to the result Muse read | The job itself (created to finished) | Glimmer calls | Leaks | Report | Raw |
|---|---|---:|---:|---:|---:|---|---|
| First day, no learned rules | ask_user (model), approved | 118.8 s | 102.2 s | 28 | 0 | [e2e_cloud_no_rules.md](e2e_cloud_no_rules.md) | [raw/e2e_cloud_no_rules.jsonl](raw/e2e_cloud_no_rules.jsonl) |
| One learned "ask first" rule | ask_user (model), approved | 84.9 s | 64.6 s | 28 | 0 | [e2e_cloud.md](e2e_cloud.md) | [raw/e2e_cloud.jsonl](raw/e2e_cloud.jsonl) |

**Slow hour.** Both ran between 11:47 and 11:51, while OpenRouter served Glimmer slowly: grading took 14.3 s and 9.8 s per essay on average, against 4.2 s and 4.1 s in the last round, with about the same tokens. Then Muse waited 33.4 s and 30.1 s ([e2e_cloud_no_rules.md](e2e_cloud_no_rules.md#against-the-last-run), [e2e_cloud.md](e2e_cloud.md#against-the-last-run)). Do not quote either pair as typical; neither is device speed.

The 28 calls are 24 grading calls (up to 4 at once on the cloud backend), 2 name passes (one on the document list, one on the result), 1 request-topic call and 1 router call. The job writes 24 feedback files with real names under `BASE_HOME/output/<job id>/`. The rest of the time (16.6 s and 20.3 s) is the release of the result: the name pass on the result (8.9 s and 2.8 s), the request-topic call (4.8 s and 8.3 s) and the router (1.9 s and 7.0 s), plus the wait for the next poll (per-call times in the raw files). A real teacher's time to read the approval card is not included. Tokens: 32672 prompt, 14586 completion (9952 reasoning) on the first day; 32906, 14593 (9678) with the rule.

The two earlier runs with request topics (07:06, [before_fixes/e2e_cloud_no_rules.md](before_fixes/e2e_cloud_no_rules.md) and [before_fixes/e2e_cloud.md](before_fixes/e2e_cloud.md)) took 46.6 s and 37.5 s, mostly a slower grading job (38.4 s and 30.5 s). These are single runs, and the cloud's speed varies.

## 7. Speed in cloud mode

| Step | Latency | Tokens/s | Calls | Source |
|---|---|---:|---:|---|
| Router decision, model calls in the 100-item run | 1805 ms mean, 1732 ms median, 2950 ms p95 | | 96 | [raw/final_cloud.jsonl](raw/final_cloud.jsonl) |
| Router decision, bench | 1640 ms mean | 80.2 | 5 | [final/cloud_speed.md](final/cloud_speed.md), [final/raw/cloud_speed.jsonl](final/raw/cloud_speed.jsonl) |
| Second pass for names, bench | 7521 ms mean | 43.9 | 5 | same |
| Request topics, bench | 3031 ms mean | 33.6 | 5 | same |
| Grade one essay, bench | 29030 ms mean | 18.0 | 5 | same |
| Grade one essay, inside the two grading jobs | 12.1 s mean, 30.0 s max | | 48 | [raw/e2e_cloud_no_rules.jsonl](raw/e2e_cloud_no_rules.jsonl), [raw/e2e_cloud.jsonl](raw/e2e_cloud.jsonl) |
| One eval item through egress (name pass, request topics, router, a summary when needed, approval and leak checks) | 5.9 s (9 min 54 s for 100 items, one at a time; 1 min 43 s for the 20 holdout items) | | 100 | wall times in the Cost sections of [final_cloud.md](final_cloud.md#cost) and [final_cloud_holdout.md](final_cloud_holdout.md#cost) |

Bench command: `uv run python -m scripts.bench_speed --label cloud --runs 5 --out eval/reports/final`. Tokens per second is completion tokens (reasoning included) over the whole call's wall time, so it includes the network and prompt processing. The router's mean in the 100-item run (11:35 to 11:45), 1805 ms, is close to the last round's 1619 ms. The bench ran from 11:54 to 11:57, in the slow hours: the name pass, request topics and grading took 3.8 to 7.6 times as long as in the last round's bench (1310 ms, 805 ms and 3832 ms), with about the same completion tokens per call, and the name pass ranged from 2391 ms to 11584 ms within the run ([final/cloud_speed.md](final/cloud_speed.md#against-the-last-run)). Cloud latency is not stable enough to quote as one number. Router latency and grading inside the jobs from the raw files:

```
uv run python -c "import json,math,sys; r=[json.loads(l) for l in open(sys.argv[1])]; m=sorted(x['latency_ms'] for x in r if x['source'] in ('model','fallback')); print(len(m), round(sum(m)/len(m)), m[math.ceil(.5*len(m))-1], m[math.ceil(.95*len(m))-1], m[-1])" eval/reports/raw/final_cloud.jsonl
uv run python -c "import json,sys; g=[json.loads(l)['latency_ms'] for f in sys.argv[1:] for l in open(f) if json.loads(l).get('kind')=='grade']; print(len(g), round(sum(g)/len(g)), max(g))" eval/reports/raw/e2e_cloud_no_rules.jsonl eval/reports/raw/e2e_cloud.jsonl
```

They print `96 1805 1732 2950 3196` and `48 12050 29952`. Chart: [final/speed.png](final/speed.png) (cloud only, until device reports exist).

## 8. How well Glimmer labels the request

`uv run python -m scripts.check_request_topics --keywords eval/reports/raw/request_topics_keywords.yaml --extra-topic 'reidentify=narrows the class down to one or a few students by a personal trait or a one-time event only they share'`. Report [request_topics.md](request_topics.md), raw [raw/request_topics.jsonl](raw/request_topics.jsonl). Run before the last round's final runs, with the same topic descriptions, and not rerun since. Glimmer's labels against Spark's hand labels, next to a keyword list, on a fresh draw of 160 invented requests (seed 11) made after the descriptions were frozen:

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
| The flow in the Muse app (connector, pairing, the search purpose, scheduled jobs, the morning message) | Not tried. Ethan deployed the relay on Oct 27 (12:31 ET); no device or Muse client has connected through it yet | docs/MUSE_SETUP.md step 2 (connect the device), then the Muse app | `docs/MUSE_SETUP.md` |
| How often Glimmer's name pass reports only part of a name, or misses one | The name-parts sweep measures the guard with fixed answers, not the model | A run of the real name pass over the sweep's 1384 items | Not built |

## Cost of these runs

$0.6943 of OpenRouter: the key's usage went from $3.8035 (11:35, before the first run) to $4.4978 (13:54, 30 s after the last), read from `GET /api/v1/key` before and after each run without printing the key. Per run: the 100 items $0.0989, the holdout $0.0175, the grading job with one rule $0.0231, the first-day grading job $0.0172, the speed bench $0.0057, the five nights with the unseen test $0.4164, the night-5 rules on the 100 tasks $0.0979, the charts and the name-parts sweep $0 (no model calls). That sums to $0.6767. The other $0.0176 came between runs, when none of them was going (for example $0.0065 in 3 min 27 s, 11:50:51 to 11:54:18), so other use of the key or late billing is in every window too, and over the 1 h 44 min nights window it could be a real share. A local demo of the device (one grading job over the 24 demo essays plus a document list, about 28 Glimmer calls) used the same key from 12:33 to 12:38 ET, inside the nights window. The two grading jobs measured in e2e_cloud.md and e2e_cloud_no_rules.md cost $0.0231 and $0.0172, so about $0.02 of the nights' $0.4164 is that demo. Each report's Cost section has its own figure and wall time.

Between the last round (the key read $3.7891 at its end) and this one, the key rose $0.0144. That covers the cloud name-pass runs made while the guard fix was studied and any other use of the key; it is not broken down in a report. The key's total after this round: $4.4978.

Also cited on this page, from earlier runs: the request-topic check, $0.17 of OpenRouter ([request_topics.md](request_topics.md)), and the Spark cross-check, about $0.14 of the Meta Model API, an estimate from the usage fields ([grading_crosscheck.md](grading_crosscheck.md)). No Modal or local model calls.

## History

Kept for comparison only. Do not quote these as current.

| Files | What they are |
|---|---|
| This page and the reports it links, as of commit 8afe137 (`git show 8afe137:eval/reports/final.md`; the same path for each report) | The last round, 09:03 to 09:51, before the guard fix: 76% on 100 items with 48 requests, holdout 75%, the unseen test 70% to 79% with one leak (syn-0765), approval requests 10, 8, 7, 7, 6 a day, the grading jobs 33.4 s and 30.1 s, $0.5652 of OpenRouter. Rerun in place this round, so only git has them |
| [before_fixes/final_cloud.md](before_fixes/final_cloud.md), [before_fixes/final_cloud_holdout.md](before_fixes/final_cloud_holdout.md), [before_fixes/final/](before_fixes/final/nights.md) | The first final runs, 05:49 to 06:25, before request topics (commit 291b0eb): 75% on 100 items with 49 requests, holdout 75%, the gate kept none of five nights, and the day-5 false positive |
| [before_fixes/e2e_cloud_no_rules.md](before_fixes/e2e_cloud_no_rules.md), [before_fixes/e2e_cloud.md](before_fixes/e2e_cloud.md) | The grading runs at 07:06, with request topics and before the review fixes (commit 7bb404b). The 05:52 runs without request topics (32.4 s and 31.3 s) are in git at commit 291b0eb |
| [topics_cloud.md](topics_cloud.md), [topics_cloud_holdout.md](topics_cloud_holdout.md) | Request topics before the review fixes (76%, holdout 70%); see the note in each about their router inputs |
| [post_fix_cloud.md](post_fix_cloud.md), [post_fix.md](post_fix.md), [post_fix/](post_fix/) | After the first review fixes |
| [baseline_cloud.md](baseline_cloud.md), [tuned_cloud.md](tuned_cloud.md), [nights.md](nights.md), [tuning_log.md](tuning_log.md), [cloud_speed.md](cloud_speed.md) | Tuning, on hand-labeled inputs |
