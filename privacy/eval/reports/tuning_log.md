# Tuning log: privacy router and dreaming on cloud Glimmer

Date: 2026-10-27. Backend: openrouter, model `meta/muse-glimmer-30b` (router and answer roles), reasoning low, strict JSON. Device label in the reports: "laptop (OpenRouter Glimmer)". Every item is invented. OpenRouter spend for this stage: $1.40 (key usage went from $0.041 to $1.439, read from GET /api/v1/key before and after; this includes rerunning the two cloud grading end-to-end tests for cloud_speed.md). No other model was called.

Ground rules followed:
- Failures were analyzed on the 80 non-holdout items only (eval/tasks.jsonl minus the ids in eval/holdout.jsonl). Holdout items were never read one by one; only their aggregate scores were looked at. Nothing trains on them.
- guard, egress, final_check and the existing floors are unchanged. One stricter floor was added (learned "ask first" and "refuse" rules). Leaks stayed at 0 in every run.
- No label in eval/tasks.jsonl or eval/holdout.jsonl and no rule in eval/user_policy.yaml was changed. Every non-holdout failure was checked against the policy's own comments, and none of the labels contradicted them.

## 1. Starting point

```
uv run python -m eval.run_eval --set eval/tasks.jsonl --name baseline_cloud --device-label "laptop (OpenRouter Glimmer)"
uv run python -m eval.run_eval --set eval/tasks.jsonl --holdout --name baseline_cloud_holdout --device-label "laptop (OpenRouter Glimmer)"
uv run python -m scripts.simulate_nights --nights 5 --per-day 20 --home eval/.cache/sim_before_home
uv run python -m scripts.charts
```

The simulation and chart outputs were renamed to nights_before.csv, nights_before.md and five_nights_before.png so the later run could not overwrite them. `--home` only keeps the simulated device home (gitignored) for inspection; the run is otherwise the plain command.

| Category (expected decision) | baseline_cloud, 100 items | baseline_cloud_holdout, 20 items |
|---|---|---|
| share_tagged | 36.0% (9 of 25) | 40% (2 of 5) |
| share_summary | 100.0% | 100% |
| ask_user | 56.0% (14 of 25) | 60% (3 of 5) |
| refuse | 88.0% (22 of 25) | 100% |
| Overall | 70.0% | 75.0% |
| Approval requests | 29 | 6 |
| Leaks | 0 | 0 |

Run-to-run noise: the holdout items were scored twice with the same code (inside baseline_cloud and in baseline_cloud_holdout). 2 of the 17 items the model decided came out differently. With 5 holdout items per category, one flip moves a category by 20 points, which matters for the nightly gate (it keeps new rules only if no category drops).

Nights before tuning (nights_before.md):

| Night | Approval requests that day | Holdout accuracy | Leaks | Kept |
|---|---|---|---|---|
| 0 | - | 70.0% | 0 | - |
| 1 | 3 | 85.0% | 0 | yes |
| 2 | 6 | 85.0% | 0 | yes |
| 3 | 7 | 85.0% | 0 | no (share_tagged 1.00 to 0.80) |
| 4 | 7 | 90.0% | 0 | no (share_tagged 1.00 to 0.80) |
| 5 | 5 | 85.0% | 0 | no (share_tagged 1.00 to 0.80) |

The approvals curve went up, not down. Reading the simulated decision log (day items are non-holdout) showed why: the old day sampler took a plain shuffle, so the number of items the teacher wants to be asked about swung from 1 on day 1 to 7 on day 4. The requests that day were 1, 4, 6, 7 and 5 wanted plus 2, 2, 1, 0 and 0 unneeded. The curve tracked the sample, not learning. The rules file was 99 to 104 lines, one per exact (kind, every topic) group.

## 2. What went wrong (80 non-holdout items, baseline_cloud)

24 of the 80 were wrong:
- 13 share_tagged items were asked about (per-student scores, essay excerpts, feedback). The router had no learned rules, and its prompt said to ask when unsure. This is the cold start that dreaming is meant to fix.
- 8 ask_user items were shared without asking: 3 meant for families (newsletter paragraph, a list of families to write to, a thank-you note), 2 meant for people outside the class (district coach, art teacher), and 3 per-student records with no rule (attendance, reading groups).
- 3 refuse items were shared: a request to put full names next to scores, an essay picked out by where the student moved from and a disability, and an average for the few students who took a makeup test.
- No floor caused a wrong decision. No leaks.

## 3. Changes

### Change 1: a decision guide in the router prompt (base/router.py, SYSTEM_PROMPT)

What: five ordered steps. (1) refuse when the request asks who a tag really is, or narrows the class down to a few students by a personal trait or a one-time event, even for an average. (2) ask_user when the result is meant for anyone outside the class or is a student's whole essay. (3) follow the learned rule shown for this result. (4) share_summary for class-level counts, averages and patterns. (5) ask_user for per-student detail that no learned rule covers. "When unsure, pick ask_user" stays.

Why: the misses above were generic privacy mistakes (unmasking, singling out, sending outside the class), and the guide words them by what the request asks, not by this teacher's topic names. Step 5 makes the first day ask about tagged per-student results. That is what the policy says (tagged grades are fine but not pre-approved, and the router learns them from her approvals), and it closes the first-day gap the end-to-end run reported, where Glimmer shared per-student grades without asking.

Effect (no learned rules, so changes 2 and 3 do nothing yet):

| Category | baseline_cloud | tuned_cloud | baseline_cloud_holdout | tuned_cloud_holdout |
|---|---|---|---|---|
| share_tagged | 36.0% | 16.0% | 40% | 20% |
| share_summary | 100.0% | 100.0% | 100% | 100% |
| ask_user | 56.0% | 100.0% | 60% | 100% |
| refuse | 88.0% | 100.0% | 100% | 100% |
| Overall | 70.0% | 79.0% | 75.0% | 80.0% |
| Approval requests | 29 | 46 | 6 | 9 |
| Leaks | 0 | 0 | 0 | 0 |

Every remaining miss on the first day is a share_tagged item that is asked about, the safe direction. The price is more approval requests on day one (46 against 29 on the 100 items).

On the 80 non-holdout items alone the same code scored 78.8% against 70.0% (eval/reports/dev/dev_cold_v1.md).

### Change 2: the router shows the model the one learned rule that fits (base/router.py, base/dreaming/train.py)

What: the router reads the rules file back (`train.read_rules`), works out the result's group the same way dreaming does (`train.rule_key`), picks the one rule that fits (`train.match_rule`: your rule for this exact group, else your strictest topic rule, else the same two from the practice defaults) and adds a line `Learned rule for this result: ...` to the model's input. The full rules file stays in the system prompt as before.

Why: with about 100 rule lines in the prompt, the model had to find the matching line itself. Before tuning, nights 3 to 5 were rejected because one holdout share_tagged item went wrong under rules that should have covered it.

### Change 3: learned "ask first" and "refuse" rules act as floors (base/router.py)

What: when the rule that fits says ask first or refuse, the decision is at least that, with floor label `learned:ask_user` or `learned:refuse` and a plain reason ("You asked to be asked first about results like this."). A learned share rule never loosens any floor.

Why: a model slip must not loosen what the user taught. This only adds strictness; nothing that was refused or asked before can now be shared.

Effect of changes 2 and 3, measured on the 80 non-holdout items with the rules dreaming writes from the practice set alone (eval/reports/dev/dev_practice_v1.md, rules in eval/reports/dev/practice_rules_v1.md): 100.0% on all four categories, 20 approval requests (exactly the 20 ask_user items), model-call latency 1158 ms mean against 1515 ms with no rules.

### Change 4: dreaming groups on the policy's topics, drops floored groups, and learns topic rules (base/dreaming/train.py, night.py)

What:
- A rule's group is the result kind plus only the topics the user's policy names (never-share topics and every rule's topics). "reading" and "attendance" no longer split a group.
- Groups that contain a never-share topic the floor always refuses get no rule; the file says so in one line.
- A topic whose decisions agree (at least 3, at least 80%) on ask first or refuse gets a rule for any kind of result (`Anything about parents (topic: parents): ask first.`). Sharing is never a topic rule, because whether to share depends on the kind of result.
- The night passes the user's policy to training. Without a policy the old behavior is unchanged.

Why: exact groups did not generalize. Rules from the practice set alone went from 104 lines (11,776 characters) to 50 lines (6,263 characters), 49 lines (6,183 characters) after change 5, and items like a family newsletter paragraph (class_aggregate with grades and parents) now have a rule through the parents topic.

Effect, first version (v1, nights_tuned_v1.md and nights_no_practice_v1/):

| Night | Requests (wanted + unneeded) | Holdout accuracy | Kept |
|---|---|---|---|
| 0 | - | 80.0% | - |
| 1 | 11 (5 + 6) | 95.0% | yes |
| 2 | 5 (5 + 0) | 95.0% | yes |
| 3 | 6 (5 + 1) | 100.0% | yes |
| 4 | 5 (5 + 0) | 100.0% | no |
| 5 | 5 (5 + 0) | 100.0% | no |

Nights 4 and 5 were rejected with "share_summary accuracy fell from 1.00 to 0.60". Rebuilding night 4's rules from the simulated log showed a new rule, `Anything about grades: ask first. You wanted to be asked 8 of 10 times`. Only asked items reach the decision log, and once tagged grades were learned they stopped being asked, so the grades decisions left were mostly parent and outside-the-class requests. The gate caught it, which is what it is for.

### Change 5: a topic rule needs evidence of its own (base/dreaming/train.py)

What: topic rules are chosen most decisive first, and a topic only gets one if the decisions on it that no topic chosen before it covers exist and agree with it. Grades loses: every grades "ask" is already covered by parents or outside the class, and what is left are approvals.

Effect, checked offline on the v1 log before spending anything (no model calls): the grades rule is gone on nights 4 and 5, and parents, third_party and full_text keep theirs. Side effect: the practice set no longer gives reidentify a topic rule, because every practice reidentify item outside the floored topics also has deanonymize. Items about re-identifying a student now rely on prompt step 1, which got all of them right in tuned_cloud.

### Change 6: the simulation deals each day evenly over the four decisions (scripts/simulate_nights.py, scripts/charts.py)

What: each day's 20 items are dealt round robin over the expected decisions, 5 each, and each decision's items are walked in their own seeded shuffle, so four days visit all 80 once. nights.csv gains wanted_requests, unneeded_requests, day_mix and acc_<decision> (holdout accuracy per category for the rules in place). nights.md shows them, and five_nights.png stacks wanted and unneeded requests.

Why: so the approvals curve measures learning, not the day's mix. With this policy the curve cannot reach zero: 5 items a day are ones the teacher wants to be asked about every time. Only the unneeded requests can go away, and they are now shown apart.

### Change 7: eval harness (eval/run_eval.py)

- Reports now give router latency over the items the model decided, apart from the overall mean, which counts the 0 ms rule-path items.
- The "Raw rows" footer now names the right path when `--out` points elsewhere.
- Checked and left alone: agreement equals accuracy on every run, because every item's expected decision equals policy.wants (tests/test_data.py checks this), so agreement adds nothing here. Held items are scored on the router's decision, and none were held. No scoring bug changed any number.

## 4. After all changes

```
uv run python -m eval.run_eval --set eval/tasks.jsonl --name tuned_cloud --device-label "laptop (OpenRouter Glimmer)"
uv run python -m eval.run_eval --set eval/tasks.jsonl --holdout --name tuned_cloud_holdout --device-label "laptop (OpenRouter Glimmer)"
uv run python -m scripts.simulate_nights --nights 5 --per-day 20 --home eval/.cache/sim_after_home
uv run python -m scripts.charts
uv run python -m scripts.simulate_nights --nights 5 --per-day 20 --synthetic none --home eval/.cache/sim_nopractice_home --out eval/reports/nights_no_practice
uv run python -m scripts.charts --reports eval/reports/nights_no_practice
uv run python -m eval.run_eval --set eval/tasks.jsonl --name tuned_cloud_night5_rules --rules eval/reports/learned_rules_night5.md --device-label "laptop (OpenRouter Glimmer)"
```

The router code did not change after tuned_cloud and tuned_cloud_holdout ran (change 5 is in dreaming only, and those runs have no rules file), so they stand as the final first-day numbers.

Five nights, final code (nights.md, nights.csv, five_nights.png):

| Night | Requests that day | Wanted | Unneeded | Holdout accuracy | share_tagged | share_summary | ask_user | refuse | Leaks | Kept |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | - | - | - | 80.0% | 20% | 100% | 100% | 100% | 0 | - |
| 1 | 10 | 5 | 5 | 95.0% | 80% | 100% | 100% | 100% | 0 | yes |
| 2 | 5 | 5 | 0 | 95.0% | 80% | 100% | 100% | 100% | 0 | yes |
| 3 | 6 | 5 | 1 | 100.0% | 100% | 100% | 100% | 100% | 0 | yes |
| 4 | 5 | 5 | 0 | 100.0% | 100% | 100% | 100% | 100% | 0 | yes |
| 5 | 5 | 5 | 0 | 100.0% | 100% | 100% | 100% | 100% | 0 | yes |

Every day had 5 items of each expected decision. All five nights were kept. Rules: 46 to 47 lines (user rules plus practice defaults).

Same, with no practice data, so the router learns only from the teacher's answers (nights_no_practice/nights.md):

| Night | Requests that day | Wanted | Unneeded | Holdout accuracy | share_tagged | Leaks | Kept |
|---|---|---|---|---|---|---|---|
| 0 | - | - | - | 80.0% | 20% | 0 | - |
| 1 | 10 | 5 | 5 | 80.0% | 20% | 0 | no (ask_user 1.00 to 0.80) |
| 2 | 10 | 5 | 5 | 95.0% | 80% | 0 | yes |
| 3 | 6 | 5 | 1 | 100.0% | 100% | 0 | yes |
| 4 | 6 | 5 | 1 | 100.0% | 100% | 0 | yes |
| 5 | 5 | 5 | 0 | 100.0% | 100% | 0 | yes |

The other three categories stayed at 100% on every night of this run. The gate turned down night 1 here (one ask_user holdout item; which one was not looked at); the v1 run of the same ablation kept its night 1 with the same number of rules, so this is likely the run-to-run noise above. The ablation ends with 11 rules, all from the teacher (eval/reports/nights_no_practice/learned_rules_night5.md).

All 100 items with the night-5 rules from the main run (tuned_cloud_night5_rules.md): 100.0% in every category, 25 approval requests (exactly the 25 ask_user items), 0 leaks. 80 of these items were among the simulated days, so only the 20 holdout items are unseen; the holdout score is the honest one.

Before and after:

| Category | First day, before (baseline_cloud, 100 items) | First day, after (tuned_cloud, 100 items) | Holdout after night 5, after (nights.md) |
|---|---|---|---|
| share_tagged | 36.0% | 16.0% | 100% |
| share_summary | 100.0% | 100.0% | 100% |
| ask_user | 56.0% | 100.0% | 100% |
| refuse | 88.0% | 100.0% | 100% |
| Overall | 70.0% | 79.0% | 100.0% |
| Leaks | 0 | 0 | 0 |

The simulation before tuning recorded overall holdout accuracy only: 70.0% on night 0 and 85.0% after night 5, with approvals 3, 6, 7, 7, 5. After tuning: 80.0% on night 0 and 100.0% after night 5, with approvals 10, 5, 6, 5, 5 (5 wanted every day; unneeded 5, 0, 1, 0, 0).

## 5. What these numbers do and do not show

- The practice set (eval/synthetic.jsonl, 2000 items written by Muse Spark) is labeled with the same teacher policy (scripts/make_synthetic.py keeps an item only if its label equals policy.wants). The practice defaults therefore already carry most of that policy, and the main run's night-1 jump comes mostly from them. The no-practice run is the measure of learning from the teacher's own answers: 3 nights to reach 100% on the holdout.
- The eval items carry topic labels such as parents, third_party, full_text, deanonymize and reidentify. In the product, a result's topics come from the job (grades, writing) and the never-share keyword scan, so those five topics are not there and only the request text tells the router. Prompt steps 1 and 2 are written about the request for that reason, but the topic rules and their floors will fire less often in the product than here.
- The holdout is 20 items, 5 per category. "100%" means 20 of 20, and one flip is 5 points overall and 20 points in a category.
- The decision log only holds items the router asked about, so it is biased toward strict answers once sharing is learned. Change 5 handles the case that showed up; other skews are possible as the log grows.
- First-day approvals went up (29 to 46 on the 100 items) in exchange for 0 wrong shares on the first day. With learned rules they fall to the 25 the teacher wants.
- Floors carry many of the strict cases: on the night-5 run, `learned:ask_user` fired on all 25 ask_user items and `learned:refuse` on 3 refuse items, next to the never-share floors on 20 refuse items. On the first day, with no learned rules, ask_user was 25 of 25 and refuse 25 of 25 with only the never-share and identifier floors in play. 20 of those 50 items had such a floor (all of them refuse items), so the model got the other 30 right on its own.

## 6. Files

- Code: base/router.py, base/dreaming/train.py, base/dreaming/night.py, eval/run_eval.py, scripts/simulate_nights.py, scripts/charts.py. Tests added in tests/test_router.py, tests/test_dreaming.py, tests/test_simulate.py, tests/test_run_eval.py.
- Reports: baseline_cloud.md, baseline_cloud_holdout.md, tuned_cloud.md, tuned_cloud_holdout.md, tuned_cloud_night5_rules.md, nights_before.csv and .md, five_nights_before.png, nights_tuned_v1.csv and .md, five_nights_tuned_v1.png, nights.csv, nights.md, five_nights.png, nights_no_practice/ and nights_no_practice_v1/ (each with nights.csv, nights.md, five_nights.png), learned_rules_night5.md, dev/ (the two 80-item runs and the practice rules they used), cloud_speed.md, speed.png. Raw rows (ids and decisions only) in raw/ and dev/raw/.
- nights_tuned_v1.md names `--home eval/.cache/sim_after_home`; that folder was renamed to eval/.cache/sim_tuned_v1_home before the final run reused the name. The v1 ablation home is eval/.cache/sim_nopractice_v1_home.
- The 80-item dev set used in eval/reports/dev/ is eval/tasks.jsonl without the holdout ids:

```
python3 -c "import json; h={json.loads(l)['id'] for l in open('eval/holdout.jsonl')}; [print(l, end='') for l in open('eval/tasks.jsonl') if json.loads(l)['id'] not in h]" > <scratch>/dev80.jsonl
```

- The wanted and unneeded counts for the run before tuning come from its decision log:

```
uv run python -c "import json,sqlite3; it={json.loads(l)['id']:json.loads(l) for l in open('eval/tasks.jsonl')}; rows=sqlite3.connect('eval/.cache/sim_before_home/base.db').execute(\"select day,item_id from decisions where status!='auto'\").fetchall(); [print(d, sum(it[i]['expected']=='ask_user' for x,i in rows if x==d), sum(it[i]['expected']!='ask_user' for x,i in rows if x==d)) for d in range(1,6)]"
```
