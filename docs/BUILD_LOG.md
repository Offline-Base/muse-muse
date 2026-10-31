# Build log

Every merge, review, fix, measurement and decision on the way to the submission, newest last. Times are ET, from commit and run-log times. Numbers here are copies; the report named next to each one holds the command that produced it. All data is invented.

Branches: `ethan/score-build` is the integration branch, built in local worktrees (one per lane) and merged here. `main` on GitHub is updated only with verified work. The live app runs older code (`ethan/device-only-build`, tag map v1) and moves to new code only in Ethan's restart windows.

How runs are kept from overloading the laptop: one model job at a time (a lock around every eval, sim, bench or rehearsal, since the live app's LFM server on 127.0.0.1:8083 is shared), lane processes reniced, at most 4 lane test runs at once, and lane tests paused when free memory drops under 20%. Every run uses a throwaway BASE_HOME; the live ~/.base is never written.

## Oct 30

**22:47** Score plan committed (`docs/SCORE_PLAN.md`, b3b274d).

**About 22:25 to Oct 31 01:15** Wave 1: six lanes built the parts that need neither Ethan's Glimmer nor Ethan, each in its own worktree, then merged, reviewed and fixed.
- A, models and evals: model-file inspector (`scripts/gguf_info.py`, `plug_in_model.py --check`), drafter, flash-attention and reasoning-budget knobs, label checks keyed to the LFM labeler, overlap checker (`scripts/check_overlap.py`), uptime supervisor (`scripts/supervise.sh`, `docs/UPTIME.md`), model matrix, device bench, unsealed SIM-1 splits (`eval/splits/`).
- B1, privacy core: tag map v2 with daily rotation and a 36 h grace, restart state, narrowed Always approve, retention.
- B2, routing: a reason code on every decision, `scripts/ask_causes.py`, stricter share rules (SIM-3), opt-in loosening fixes behind ROUTER_LOOSEN (SIM-4, off by default), seven simulated personas, audit replay, the persona study plan written before any run (`eval/reports/sim/PLAN.md`).
- C1, Muse app: multi-step connector, mail merge (`save_on_device`), offline relay results, session report, scene rehearsal.
- C2, SAM: synthetic SAM pages with ground truth, region sidecar, cover-before-reading (opt-in, SAM_ENABLED off by default).
- D, red team: threat model, attack suite, secrets scan, CI workflow. The Spark-driven red-team harness (RED-5 to RED-8, RED-12 to RED-14) was stopped by a safety check and is dropped, not retried.

**22:49** Incident: a lane's test run fell back to the default home and upgraded the live `~/.base/tagmap.json` to v2. Restored from its v1 backup the same minute (the v2 copy kept beside it); `/health` 200, nothing else in ~/.base changed. Prevention: every test run now gets a throwaway BASE_HOME (`tests/conftest.py`, 895e9bf), and the cloud-script tests pass one too.

**22:57** Load governor started (load average had reached 51 to 58, mostly from another session's search over a different repo).

**23:57 to Oct 31 00:28** Wave 1 merged into `ethan/score-build`: 78879c7 (B1), 5036ce0 + 79362d5 (B2), 0fe1936 (A), 3a75f83 + 4f313c1 (C1), 17fad98 (C2), 93ac9a4 + aee41b2 (D). 14 conflicts resolved, every lane's fields and tests kept. 3235 passed, 6 skipped, 64 xfailed.

## Oct 31

**00:46** 895e9bf: throwaway BASE_HOME for every test run (above).

**About 00:50 to 01:16** Review 1: three reviewers (correctness, privacy, live app) found 16 issues; one fixer handled them in cf913d8. 3266 passed; each of the 36 new or changed tests fails on the code before the fix.
- High, fixed: under daily rotation, ordinary words after "student" ("your student is", "Student ID", "Student IEP") were read as tags, so restore swapped in a real name on the device or the request was refused as an expired tag. Now an unbracketed two or three letter Student code is plain words; those codes restore only in brackets.
- Medium, fixed: a tag Muse kept sending never expired (the grace restarted on every send), and a request could mix yesterday's and today's tags. A tag now lives until the end of its day plus the grace, whatever is sent; a mixed-day request is refused.
- Medium, fixed: a letter home could carry another student's tag, a phone or email tag, or a never-share topic. Now refused before anything is saved.
- Medium, fixed: private task results recorded no sources, so the SAM image checks never ran on them.
- Medium, fixed: the relay client treated any 403 as a bad secret and stopped for good. Now only a 401 stops it.
- Medium, fixed: `plug_in_model.py` run from a lane worktree wrote through the linked `.env` into the live one. Now refused.
- Medium, fixed (docs): the documented rotation rollback could reuse codes Muse already holds. UPTIME and RETENTION now say to set TAG_ROTATION=off on the new code and keep the v2 map.
- Low, fixed: the letter-home receipt told Muse how many guardians each student has; base.db was not always backed up before its first schema change; the matrix time estimate counted each config twice; ask_causes counted against `expected` instead of `wants`; a CONTRACTS line on floors; start.sh waited 180 s for a SAM helper that had already stopped.
- Deferred: a task result Muse first reads after its tags expired comes back in that day's tags, so Muse could pair old and new tags (needs a decision; written up in THREAT_MODEL residual risks). One lane commit added a private address in a test (a later commit had already replaced it with a documentation-range address). It was rewritten out before the push (below).

**01:24** Side lanes merged: 5111385 (wording: earlier projects are "by the same author", the Jetson fallback is "the Jetson gateway"), 7cec53b (synthetic hash manifest that gates cloud runs only, `scripts/health.py`), f8630b2 (templated eval set `eval/templated/fresh_200_t.jsonl`, unsealed and unread; Glimmer pre-registration `eval/reports/glimmer_prereg.md`; `THIRD_PARTY_NOTICES.md`). Two doc and import conflicts, both sides kept.

**01:31** 5e04a4f: the merged tree had 8 failing tests, all from lanes meeting for the first time. The demo and SAM page manifests were stale (other lanes added files after they were hashed), so both were rebuilt from tracked files; one templated roster first name was also in the persona and casework sets, so it was replaced and fresh_200_t rebuilt (0 overlap hits in 18 sets, 0 shared name tokens); two tests made folders without a manifest. 3317 passed, then the last listing test fixed and rerun. Ruff and the secrets scan clean.

**01:33** Re-baseline on the merged build, policy decides with LFM labels (`eval/reports/score_build_fresh_200_b.md`, 0c43fa8): 74.5% (149 of 200), 0 leaks, 88 approval requests, 40 of them not needed. Before: 73.5%, 0 leaks, 90. Six items moved: four refusals that used to ask now refuse (the blocked contact and address floors), two shares now ask (ask_before_outside_class). The two unsafe shares (asks the policy wanted, shared tagged) are the same two as before.

**01:47** Model matrix, LFM only, DEVICE_ONLY=1 (`eval/reports/matrix_lfm_score_build.md`, f857b0d), 0 leaks in every row:

| Config | fresh_200_b | tasks |
|---|---|---|
| keywords, no model | 62.0% | 59.0% |
| policy decides, LFM labels | 75.0% | 81.0% |
| LFM can only tighten | 42.5% | 61.0% |
| LFM decides under the floors | 43.5% | 60.0% |

The 2B model as router over-refuses (86 to 88 on fresh_200_b), so policy decides stays the device-only default. policy_lfm scored 75.0% here and 74.5% in the run before on the same code: LFM's labels differed on one item, so one item between runs is noise.

**01:48** Compliance tagging reports (`eval/reports/compliance_score_build.md`, `compliance_with_model_score_build.md`, 4fb4fef): rules only unchanged; with LFM3-VL-2B 0 misses and 0 of 20 clean sentences changed (the earlier report had 1 of 16 before the clean set grew).

**01:50 to 01:53** Scene rehearsal and device smoke on 5e04a4f (`eval/reports/muse_app/rehearsal_2026-10-31.md`, `eval/reports/device_smoke_lfm_score_build.md`): all six scenes reach their expected statuses, 0 of 18 tool outputs hold a private value; smoke passes, 24 essays graded in 41.2 s, every result device only.

**About 01:25 to 02:13** Review 2, independent of review 1, on 895e9bf..f8630b2: four lenses (rotation, privacy, live-app restart path, the side lanes), one skeptic per lens trying to refute each finding, then one fixer. Confirmed:
- Medium: stale manifests; fixed in 5e04a4f.
- Low: the templated roster name clash; fixed in 5e04a4f.
- Medium: the pre-registration names the sealed set by the wrong path (`eval/fresh_200_c.jsonl`; it is `eval/splits/fresh_200_c.jsonl`).
- Medium: `save_on_device` joins title and body with a line break before the tag check, and the restore pattern reaches across it, so a title ending in "student" and a body starting with "I" or "A" reads as a tag.
- Medium: four texts still describe the old grace rule (a send extends the window).
- Medium: THIRD_PARTY_NOTICES calls SAM 3.1 "planned" although the sidecar ships, and leaves out the SAM weights' source.
- Low: the board bundle ships the templated set; an empty base.db backup left by a failed copy is later taken as the copy; RETENTION says the old code "tags nothing" given a v2 map (it does not start); the letter-home never-share check reads restored text, so a real surname such as Street can block every letter.
- Rejected after checking: one claim about the templated set's roster.
- Needs Ethan (all low, nothing leaves the device): (1) one-letter words after "student" ("the student I tutor", "Student I.D.") can still read as a tag; the line-break and "I.D." parts are plain fixes, how strict restore is for an unbracketed "Student A" is a product call; (2) a two or three letter code Muse writes without brackets is saved as the bare code, not the name; (3) the letter-home check looks at tags only, so a plain name or phone Muse typed itself passes into an unsent draft.
- The fixer took the confirmed, non-Ethan findings (below).

**01:53 to 02:00** ROUTER_LOOSEN fixes measured on 5e04a4f (`eval/reports/dev/loosen/README.md`): each fix alone and all, against none, on the first 200 of the 800 free-to-read simulated day items (`eval/splits/sim_days.jsonl`), not the study's holdout or unseen sets, with ask_causes on each. 0 leaks and the same 3 unsafe shares in every run; no fix turned an ask or refusal into a share.

| ROUTER_LOOSEN | Accuracy | Approval requests | Needless asks | Fixed / broke vs none |
|---|---|---|---|---|
| none | 70.0% | 84 | 47 | baseline |
| lists | 71.0% | 85 | 47 | 2 / 0 |
| result_words | 81.0% | 70 | 32 | 22 / 0 |
| class_of | 71.5% | 85 | 47 | 3 / 0 |
| all | 79.5% | 69 | 33 | 20 / 1 |

Only result_words is above the 1 to 3 item run-to-run noise. lists needs a learned share rule, which these runs do not have, so only the persona study can show it. Ethan picks which ship; the study fixes that choice before its first run.

**02:02** Ethan's decisions:
- ROUTER_LOOSEN ships as `result_words,lists` (the default, and fixed for the whole persona study); class_of stays off.
- One-letter codes: fix the clear cases (restore never reaches across a line break, and never before "." plus a letter as in "I.D.", "e.g.", "i.e."); an unbracketed capital "Student A" still restores.
- Two or three letter codes without brackets in a saved note: save as now, and the receipt tells Muse how many codes were not in brackets and stayed as written.
- Letters home: keep the tag-only check; make the refusal text and docs say exactly what is checked.
These go in after review 2's fixer commits, then the numbers that depend on the router default are measured again.

**02:13** Review 2's fixer committed 3af0cad: restore no longer reads across a line break or before "." plus a letter; `save_on_device` checks each text on its own; the never-share check on letters reads Muse's text as written, not restored names; a failed base.db copy leaves nothing and an empty one no longer counts as the backup; the notices and the pre-registration path are corrected; the board bundle leaves out the templated set; four texts on the old grace rule are corrected; the letter refusal says it checks tags only. It read Ethan's decisions from this log and applied the one-letter and letter-wording parts. 3331 passed. One license gap is open: the notices say the `mlx-community/sam3.1-bf16` license is not checked yet. Check before submitting.

Script error, logged so it is not repeated: the review 2 script matched verdicts to findings by list position, and the skeptics returned them in another order, so some verdicts were attached to the wrong finding. Checked afterward by text: 15 findings, 15 verdicts, one rejected on evidence (a claim that the templated set needs a roster that does not ship), nothing real dropped. Later scripts should key verdicts by finding id.

**02:22** Ethan's remaining decisions in: ROUTER_LOOSEN defaults to `lists,result_words` (`none` turns them off); the `save_on_device` receipt counts codes Muse wrote without brackets (they stay as written, with no real name). The relabel step now reads the SIM-1 split where it is (`eval/splits/sim_*.jsonl`), and all five school personas have their sets (relaxed teacher 163 of 980 labels changed, special ed coordinator 42, the three on the strict policy 0), so the whole study can run with no Meta API call. The change is noted below the line in `eval/reports/sim/PLAN.md`, before any study run. 3334 passed, 6 skipped, 64 xfailed; ruff and the secrets scan clean. The templated set's bytes did not change (sha256 c83fd50f...), now checked against 33 sets.

**02:45** Everything the router default touches measured again on 7ad8083, ROUTER_LOOSEN=lists,result_words:
- fresh_200_b (`eval/reports/default_loosen_fresh_200_b.md`): 81.5% (163 of 200), 0 leaks, 75 approval requests, 28 needless, 2 missed asks, 0 refusals shared, 4 over-refusals. Before the fixes: 74.5%, 0 leaks, 88, 40, 2, 0, 3. The fixes were chosen on simulated day items, but they came from ask causes seen on sets like this one, so the sealed set, not this one, is the number to treat as unseen.
- Model matrix (`eval/reports/matrix_lfm_loosen_default.md`), 0 leaks in every row. fresh_200_b: keywords 64.5%, policy_lfm 81.5%, lfm_tighten 44.5%, lfm_decide 43.0%. tasks: 59.0%, 82.0%, 58.0%, 59.0%.
- Scene rehearsal (`eval/reports/muse_app/rehearsal_2026-10-31.md`, replaces the 01:50 run of the same name; the older one is in git): all six scenes reach their expected statuses, 0 of 18 outputs hold a private value. The new default did not change a demo scene.
- Device smoke (`eval/reports/device_smoke_lfm_loosen_default.md`): passes, 24 essays graded in 41.1 s with no toggle and 35.9 s with FERPA on, every result device only.
- Persona pipeline smoke (`eval/reports/sim/smoke/strict_teacher/`): 1 night, 10 items, 127 s, 0 receipt mismatches. A pipeline check, not a study run, and its numbers are not results.

**02:46** History rewritten locally before the push, over 92ee1a7..ethan/score-build (43 commits, 25 got new hashes): the private address in that one lane commit became a documentation-range address, and two commit messages were reworded. The final tree is byte-identical to before, the range adds no private address, and no message names the old wording. Old hashes in commit messages, this log and the reports were mapped to the new ones (51 places in 25 files), so every hash cited here resolves. The old commits stay only in local lane branches and a local backup ref, none of which are pushed.

**02:53** The clean clone (no .env, single branch) found 1 failure out of 3334: `test_the_committed_splits_match_their_manifest_and_touch_no_used_item` counted any scored unseen row as used, and the persona smoke had scored the study's unseen items, as every real study run will. It would have failed in the worktree too; only two test files were run before that commit. The test now holds the sim sets to reports outside `eval/reports/sim/` and holds fresh_200_c to every report, so the invariant that matters is stated directly: nothing has scored fresh_200_c. The smoke's unseen rows are disclosed in PLAN.md; nobody read them. From here the full suite runs before every commit that adds reports.

**02:56** Clean clone at the head, no .env, single branch: 3334 passed, 6 skipped, 64 xfailed; ruff clean; all 3 manifests current; secrets scan over every file and all history on the branch: 0 findings (`eval/reports/secrets_scan.md`). Pushed `ethan/score-build` to `main` (92ee1a7 to 0c0ced8), a fast-forward. CI queued on it. The live app did not move.

**03:02** CI on that push (GitHub, run on 0c0ced8): macOS and the relay job passed, Linux failed 2 of 3334 tests, neither in privacy code. `test_cli_rejects_rules_with_home_and_bad_names`: argparse compares a value with the default by identity, so `--rules none` next to `--home` got past the exclusive group on the Linux build, a real if small bug; `--rules` now has no default. `test_committed_set_matches_the_script`: re-drawing the SAM pages on Linux moves text more than the 2 pixel tolerance; the committed PNGs and truth.json were drawn on macOS and are the source of truth, so the exact box check runs only there (counts, kinds and sizes are still checked everywhere).

**03:07** CI on 86fccc0: Python on Linux and macOS and the relay job all pass. `main` is green.

**03:46** Wave 2, three lanes, each reviewed then fixed, no model calls. Merged here:
- Threat model (`docs/THREAT_MODEL.md`, `tests/test_threat_model.py`): every row names an existing test or says it is a gap and why; every xfail is listed (64 cases); the suite is described as hand-written attacks, not Spark; Muse's retention is stated as not known, with what is assumed. The review found the page overstating twice, both fixed: old results are deleted only with COPPA or GDPR on, and a paraphrase the labeler and the floors both miss follows the first matching policy rule rather than always asking.
- Study and time tools (`scripts/study_summary.py`, `scripts/time_model.py`, `eval/reports/sim/assumptions.yaml`), tested on invented rows only. The review found a stopped or misnamed run could read as clean; a run now gives a number only if it is complete, on plan and error-free. No study has run, so these report nothing yet.
- Device table (`docs/DEVICES.md`): Mac rows from reports, Jetson, Raspberry Pi and Device Farm "not measured". 
3546 passed, 6 skipped, 64 xfailed; ruff and the secrets scan clean.
Held on lane/w2-docs, not merged: README, MUSE_SETUP and RUBRIC draft plus `tests/test_claims.py` (3447 passed on that lane), waiting for Ethan's wording decisions.

Router finding for Ethan: a request headed outside the class that both the labeler and the floors miss ("For the yearbook") follows the first matching policy rule. Names stay tags, but a tagged score goes out with no ask. That was already so for per-student results (RED-F3c, 10 of 22 destinations missed); the result_words default extends it to free text holding a score. Fix on offer: widen the floor with those destinations, before the study freeze.

**02:56 to 11:30, Oct 31** The session ended overnight. CI on f253359 passed. The live app was started from that session and stopped with it: ports 8083, 8084, 8787 and 8790 did not answer at 11:35. It has not been restarted; that is Ethan's call.

**11:35** Ethan's answers: `.env.example` ships device-only; the direct tooling line; all three safety fixes before the freeze; start the study right after them.

**11:55** Those are in, and lane/w2-docs is merged (README wording approved by those answers):
- `router._OUTSIDE` lists the 10 destinations the attacks missed (RED-F3c). New left-out floor (`router._LEFT_OUT`, RED-F5a, RED-F5b): a class number that leaves out a tag or a named group, table, team or pod asks the user, even under a rule the user taught, and Always approve leaves it. MAX_PENDING=20 (RED-F11): past it a new ask is refused with a fixed sentence asking the user to clear some. 17 attack cases flipped; 47 xfails remain.
- The cap is off in `run_eval.prepare_home`, so in every eval and study run: those runs leave cards unanswered on purpose (27 of 75 on fresh_200_b; all of them for the privacy officer), so a cap would turn later asks into refusals that say nothing about the router. nights.md and PLAN.md say so. So the cap is shown by its test, not by these numbers.
- `.env.example` is device-only. It also no longer sets DREAMING_BACKEND=prompt, which on that setup would have put the 2B model in charge (43% in the matrix) instead of the policy; a test pins it.
- Measured on aa19b38, on a separate copy of the LFM server (127.0.0.1:8183, throwaway home), since the live one is down: fresh_200_b 82.5% (165 of 200), 0 leaks, 75 asks, 27 needless, 2 missed, 3 over-refusals (`eval/reports/floors_fresh_200_b.md`); tasks 82.0%, 0 leaks, 27 asks (`floors_tasks.md`); 200 day items 80.0%, 0 leaks, 71 asks (`eval/reports/dev/floors/`). Item by item against the runs before, fresh_200_b moved 2 items and the day items 2, none with a new floor's code: this is label noise, not a gain, and the new floors added no needless ask on these sets. They exist for attacks these sets do not hold.
- Rehearsal: six scenes as expected, 0 of 18 outputs private. Device smoke passes: 32.9 s, 32.8 s with FERPA. Demo risk: in the FERPA run the grading result was refused, because the model's text used a never-share word (the blocked floor, unchanged today), with the files still saved; the run before shared it. Fail-safe, not a leak. How often it happens is not measured yet.
- `scripts/run_study.py`: the 24 runs in the plan's order, resumable, applying the stop rule when a run ends. The misplaced strict-teacher smoke files moved to `eval/reports/sim/smoke/strict_teacher/`, where this log already said they were. They had been copied one folder up at 02:45; nothing was overwritten.

**11:58** Persona study started on the frozen commit 0f00c79, on Ethan's call: 24 runs, one at a time (`scripts/run_study.py`), on the study's own LFM server. Ethan asked to be careful with the laptop's memory: at the start 80% was free, the server holds about 1.7 GB, and a guard pauses the running study below 20% free and resumes it above 35%, logging each pause. Results are copied here and committed when runs finish. Nobody reads a run's numbers to change anything before the last run.

**12:01** CI on 0f00c79: Python on Linux and macOS and the relay job all pass.

**12:08** Study paused at Ethan's request (fans loud, on battery): its processes are stopped, not ended, and the keep-awake hold is released. The model server stays loaded and idle. The first run had finished and the second (relaxed_teacher, seed 102) was under way. A cause to try before it resumes: the server holds 10 CPU threads, about 430 to 500% CPU, though the model is on the GPU.

**13:28** Ethan shared an outside research report. Checked it against the code and read its connector rules, the event page and two Gallup surveys at the source. What is worth keeping is in [RESEARCH_NOTES.md](RESEARCH_NOTES.md). Nothing built from it yet; the study stays paused.

**13:41** Ethan plans to submit with the tuned Glimmer, so numbers from LFM would not describe the submission. Ended the paused LFM study (1 of 24 finished, kept as a pilot; the partial second run is dropped) and started on what the model swap needs, without loading Glimmer. Found the swap did not match the matrix: `plug_in_model` left Glimmer writing only, unless the Dreaming page said otherwise, and "Glimmer labels" could not be set in the app at all. Added `LABELS_BACKEND` and `plug_in_model --mode answers|labels|tighten|decide`; `shipped_*` matrix rows that run as the app does; `scripts/glimmer_probe.py` for the reply shape; `scripts/start_side_models.sh` (4 threads, low priority, throwaway key); `CHECKER_THREADS`; `study_summary --model --dreaming-backend`; a Request labels row in nights.md; the UI now says what LFM still does. Pre-registration amended before any Glimmer row, with no change to the candidate, baseline, sealed set, metrics, test or stop rules. Wiring check: all four shipped rows ran 5 items on `fresh_200_b` with LFM standing in as Glimmer, 0 errors and 0 fallbacks; the scores mean nothing and the report was deleted.

**14:05** Ethan's notes on the tune: a knowledge LoRA with broken reasoning tokens, a GGUF of about 6 to 8 GB targeted for Nov 1 at 6 PM, Nov 2 at 4 PM at the latest for the video, and a further routing tune planned in the training project. Yes to base i1-IQ1_S (one Glimmer file at a time) and to keeping LFM as a helper. Added `GLIMMER_REASONING=off`, `GLIMMER_TEMPLATE`, `final_channel` (reasoning text never passes as an answer) and `scripts/export_routing_training.py` with docs/ROUTING_TUNE_HANDOFF.md: rows in the app's format, leaving out every eval set by id and result text. The prereg candidate stays "model decides" until Ethan names the tune's target.

**14:05** Six attack findings closed and merged (RED-F3a, F3b, F5c, F6b, F8, F10a): xfailed cases 47 to 16, full suite 3827 passed, 6 skipped, 16 xfailed. Keywords row on fresh_200_b unchanged, 64.5%, but the new patterns match almost nothing in the development sets, so only the hand-written negative tests exercise them. Over-refusal risks are in the merge's report and THREAT_MODEL's residual list. LFM baseline on this code: 82.0% on fresh_200_b (164 of 200, 76 asks, 28 needless, 2 missed, 3 over-refusals, 0 leaks) and 81.0% on tasks (27 asks, 0 leaks), eval/reports/matrix_baseline_attack_fixes.md. The change from 82.5% and 82.0% is within the runs' label noise. With `CHECKER_THREADS=4` the server sampled at 123 to 140% CPU during that run, against about 430 to 500% with 10 threads during the study, on a different workload.

**14:12** Base i1-IQ1_S downloaded, sha256 matches Hugging Face, and the header check passed: 1.874 bits per weight measured, not the 1.6 we had been saying, 27.85 B parameters (eval/reports/model_file_base_iq1s.md, no model run). Started it with LFM on side ports. The laptop got too hot, Ethan stopped the probe before any result was seen, and both servers were stopped. Ethan's instruction: do not run Muse Glimmer locally. No Glimmer reply has been measured on our server. The Glimmer steps in SCORE_PLAN that run on this Mac need another machine or a different plan; that is Ethan's call.

## Open items

- Ethan: which mode the routing tune targets; whether to hand over stage 2 IQ1_S early.
- Ethan: where Glimmer gets measured and filmed, since it no longer runs on the laptop.
- Persona study: on Glimmer, on that machine, sized from its speed test.
- Ethan: restart the live app (it is down); read the Oct 28 History row before deleting it; what the fine-tune trained on (decides sealing fresh_200_c or the templated set); restart window to move the live app to this code; Always approve is on in the live app.
- Measure how often grading is refused for a never-share word in the model's own text.
- Before submitting: check the `mlx-community/sam3.1-bf16` license in THIRD_PARTY_NOTICES.md.
