# Build log

Every merge, review, fix, measurement and decision on the way to the submission, newest last. Times are ET. Numbers here are copies; the report named next to each one holds the command that produced it. All data is invented.

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

**22:49** Incident: a lane's test run fell back to the default home and upgraded the live `~/.base/tagmap.json` to v2. Restored from its v1 backup the same minute (the v2 copy kept beside it); `/health` 200, nothing else in ~/.base changed. Prevention: every test run now gets a throwaway BASE_HOME (`tests/conftest.py`, caf720b), and the cloud-script tests pass one too.

**22:57** Load governor started (load average had reached 51 to 58, mostly from another session's search over a different repo).

**23:57 to Oct 31 00:28** Wave 1 merged into `ethan/score-build`: 78879c7 (B1), 5036ce0 + 79362d5 (B2), 870a834 (A), e9a3328 + 7cf2491 (C1), 78dcff5 (C2), 4f321c8 + 0ded2f8 (D). 14 conflicts resolved, every lane's fields and tests kept. 3235 passed, 6 skipped, 64 xfailed.

## Oct 31

**00:46** caf720b: throwaway BASE_HOME for every test run (above).

**About 00:50 to 01:16** Review 1: three reviewers (correctness, privacy, live app) found 16 issues; one fixer handled them in 6c4a82f. 3266 passed; each of the 36 new or changed tests fails on the code before the fix.
- High, fixed: under daily rotation, ordinary words after "student" ("your student is", "Student ID", "Student IEP") were read as tags, so restore swapped in a real name on the device or the request was refused as an expired tag. Now an unbracketed two or three letter Student code is plain words; those codes restore only in brackets.
- Medium, fixed: a tag Muse kept sending never expired (the grace restarted on every send), and a request could mix yesterday's and today's tags. A tag now lives until the end of its day plus the grace, whatever is sent; a mixed-day request is refused.
- Medium, fixed: a letter home could carry another student's tag, a phone or email tag, or a never-share topic. Now refused before anything is saved.
- Medium, fixed: private task results recorded no sources, so the SAM image checks never ran on them.
- Medium, fixed: the relay client treated any 403 as a bad secret and stopped for good. Now only a 401 stops it.
- Medium, fixed: `plug_in_model.py` run from a lane worktree wrote through the linked `.env` into the live one. Now refused.
- Medium, fixed (docs): the documented rotation rollback could reuse codes Muse already holds. UPTIME and RETENTION now say to set TAG_ROTATION=off on the new code and keep the v2 map.
- Low, fixed: the letter-home receipt told Muse how many guardians each student has; base.db was not always backed up before its first schema change; the matrix time estimate counted each config twice; ask_causes counted against `expected` instead of `wants`; a CONTRACTS line on floors; start.sh waited 180 s for a SAM helper that had already stopped.
- Deferred: a task result Muse first reads after its tags expired comes back in that day's tags, so Muse could pair old and new tags (needs a decision; written up in THREAT_MODEL residual risks). One commit in the history (5dfb2f9) adds a private address in a test; the current file uses a documentation-range address. It is rewritten out before any push (below).

**01:24** Side lanes merged: 8ed1f48 (wording: earlier projects are "by the same author", the Jetson fallback is "the Jetson gateway"), 40f019f (synthetic hash manifest that gates cloud runs only, `scripts/health.py`), 87da41f (templated eval set `eval/templated/fresh_200_t.jsonl`, unsealed and unread; Glimmer pre-registration `eval/reports/glimmer_prereg.md`; `THIRD_PARTY_NOTICES.md`). Two doc and import conflicts, both sides kept.

**01:31** bf38b1c: the merged tree had 8 failing tests, all from lanes meeting for the first time. The demo and SAM page manifests were stale (other lanes added files after they were hashed), so both were rebuilt from tracked files; one templated roster first name was also in the persona and casework sets, so it was replaced and fresh_200_t rebuilt (0 overlap hits in 18 sets, 0 shared name tokens); two tests made folders without a manifest. 3317 passed, then the last listing test fixed and rerun. Ruff and the secrets scan clean.

**01:33** Re-baseline on the merged build, policy decides with LFM labels (`eval/reports/score_build_fresh_200_b.md`, 81f8c9f): 74.5% (149 of 200), 0 leaks, 88 approval requests, 40 of them not needed. Before: 73.5%, 0 leaks, 90. Six items moved: four refusals that used to ask now refuse (the blocked contact and address floors), two shares now ask (ask_before_outside_class). The two unsafe shares (asks the policy wanted, shared tagged) are the same two as before.

**01:47** Model matrix, LFM only, DEVICE_ONLY=1 (`eval/reports/matrix_lfm_score_build.md`, b028bc5), 0 leaks in every row:

| Config | fresh_200_b | tasks |
|---|---|---|
| keywords, no model | 62.0% | 59.0% |
| policy decides, LFM labels | 75.0% | 81.0% |
| LFM can only tighten | 42.5% | 61.0% |
| LFM decides under the floors | 43.5% | 60.0% |

The 2B model as router over-refuses (86 to 88 on fresh_200_b), so policy decides stays the device-only default. policy_lfm scored 75.0% here and 74.5% in the run before on the same code: LFM's labels differed on one item, so one item between runs is noise.

**01:48** Compliance tagging reports (`eval/reports/compliance_score_build.md`, `compliance_with_model_score_build.md`, d066ce1): rules only unchanged; with LFM3-VL-2B 0 misses and 0 of 20 clean sentences changed (the earlier report had 1 of 16 before the clean set grew).

**About 01:50** Scene rehearsal and device smoke on bf38b1c (`eval/reports/muse_app/rehearsal_2026-10-31.md`, `eval/reports/device_smoke_lfm_score_build.md`): all six scenes reach their expected statuses, 0 of 18 tool outputs hold a private value; smoke passes, 24 essays graded in 41.2 s, every result device only.

**About 01:20 to now** Review 2, independent of review 1, on caf720b..87da41f: four lenses (rotation, privacy, live-app restart path, the side lanes), one skeptic per lens trying to refute each finding, then one fixer. Confirmed:
- Medium: stale manifests; fixed in bf38b1c.
- Low: the templated roster name clash; fixed in bf38b1c.
- Medium: the pre-registration names the sealed set by the wrong path (`eval/fresh_200_c.jsonl`; it is `eval/splits/fresh_200_c.jsonl`).
- Medium: `save_on_device` joins title and body with a line break before the tag check, and the restore pattern reaches across it, so a title ending in "student" and a body starting with "I" or "A" reads as a tag.
- Medium: four texts still describe the old grace rule (a send extends the window).
- Medium: THIRD_PARTY_NOTICES calls SAM 3.1 "planned" although the sidecar ships, and leaves out the SAM weights' source.
- Low: the board bundle ships the templated set; an empty base.db backup left by a failed copy is later taken as the copy; RETENTION says the old code "tags nothing" given a v2 map (it does not start); the letter-home never-share check reads restored text, so a real surname such as Street can block every letter.
- Rejected after checking: one claim about the templated set's roster.
- Needs Ethan (all low, nothing leaves the device): (1) one-letter words after "student" ("the student I tutor", "Student I.D.") can still read as a tag; the line-break and "I.D." parts are plain fixes, how strict restore is for an unbracketed "Student A" is a product call; (2) a two or three letter code Muse writes without brackets is saved as the bare code, not the name; (3) the letter-home check looks at tags only, so a plain name or phone Muse typed itself passes into an unsent draft.
- The fixer is working on the confirmed, non-Ethan findings now.

**02:00 to 02:10** ROUTER_LOOSEN fixes measured on bf38b1c (`eval/reports/dev/loosen/README.md`): each fix alone and all, against none, on the first 200 of the 800 free-to-read simulated day items (`eval/splits/sim_days.jsonl`), not the study's holdout or unseen sets, with ask_causes on each. 0 leaks and the same 3 unsafe shares in every run; no fix turned an ask or refusal into a share.

| ROUTER_LOOSEN | Accuracy | Approval requests | Needless asks | Fixed / broke vs none |
|---|---|---|---|---|
| none | 70.0% | 84 | 47 | baseline |
| lists | 71.0% | 85 | 47 | 2 / 0 |
| result_words | 81.0% | 70 | 32 | 22 / 0 |
| class_of | 71.5% | 85 | 47 | 3 / 0 |
| all | 79.5% | 69 | 33 | 20 / 1 |

Only result_words is above the 1 to 3 item run-to-run noise. lists needs a learned share rule, which these runs do not have, so only the persona study can show it. Ethan picks which ship; the study fixes that choice before its first run.

## Open items

- Ethan: which ROUTER_LOOSEN fixes ship (numbers above when the runs finish); the three restore choices above; what the fine-tune trained on (decides sealing fresh_200_c or the templated set); restart window to move the live app to this code; Always approve is on in the live app.
- Persona study: the five school personas read `eval/sim/`, but SIM-1 wrote the split to `eval/splits/sim_*.jsonl`. Point the relabel step at it, note the path in PLAN.md below its line, then the pipeline smoke. The study itself runs on the frozen commit (the plan says Nov 2 night), one run at a time.
- History: before `ethan/score-build` goes to `main`, rewrite 5dfb2f9's private address to a documentation-range one and reword the two commit messages that name the old org wording, then check a clean clone.
