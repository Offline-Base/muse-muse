# Plan: Impact, Meta tooling and technical depth to 10

Oct 30, 2026, 10:30 PM ET. For Ethan. This merges seven workstream plans (SIM, GLM, SAM, RED, MUSE, GAP and DEV) and applies two reviews. Nothing in it has been built or run yet. Task IDs from the first draft are unchanged. New IDs and new decision numbers come after the old ones.

Status, Oct 30 at 11 PM: the parts that need neither Ethan's Glimmer nor Ethan are being built in six lanes plus two side lanes, merged into the local branch ethan/score-build. Where this plan says three lanes, read six. The editable copy of this plan lives in a private Claude doc; this file is the snapshot that ships with the code.

## 1. What shapes this plan

- **Time.**
  - From now there are about 110 hours to Nov 4 noon ET and about 119 to the 9 PM deadline. The clock change at 2 AM on Nov 1 adds one hour.
  - Scored code freezes at **Nov 2, 6 PM**, which is about 68 hours away.
  - After that we write docs and reports, record the video (uploaded by Nov 3, 9 PM) and keep the app up through Nov 9.
- **This Mac.** M4 Max, 14 cores, 36 GB RAM.
  - **Disk:** 12 GiB free on the data volume, about 12.9 GB (df at 22:20).
  - **HF cache, real sizes.** These count unique blobs only (realpath + stat over each model's snapshots at 22:2x). The `du -L` figures in the first draft counted shared blobs twice.

    | Cached model | GB | Used by this repo? |
    |---|---|---|
    | embeddinggemma-2 (HF weights) | 1.53 | No. The embedder uses models/embeddinggemma-2-Q8_0.gguf |
    | siglip2-base | 1.54 | No |
    | all-MiniLM-L6-v2 | 0.93 | No |
    | d1-omni-600M + ONNX copy | 2.35 + 0.50 | No (check jetson-infra router use first) |
    | Nemotron Bolt GGUF | 6.74 | No (Bolt demo) |

    Snapshots link into a shared hub/blobs folder (7.2 GB). Use `hf cache delete` and check df afterwards. Deleting the models-- folders alone may free nothing.
  - **Disk budget:**

    | Item | GB | When |
    |---|---|---|
    | Floor kept free at all times | 5 | always |
    | Base i1-IQ1_S control (GLM-18) | 6.53 | Oct 31. Delete once its rows are saved if the space is needed |
    | DFlash drafter Q4_K_M | 1.63 | Oct 31 |
    | Your tuned file | about 6 to 6.5 | on arrival |
    | Training file and imatrix text for the overlap check | unknown | on arrival |
    | Glimmer mmproj (P1) | 1.40 | after the tuned file |
    | SAM 3.1 MLX bf16 + its env | 3.49 + about 1 (unverified) | see Decision 5 |
    | Four worktrees + relay node_modules | about 1.7 (unverified; uv may hardlink) | tonight |
    | Screen recording and edit | 8 to 10 | Nov 2 to 3, or an external drive |

    - Keeping everything at once needs about 36 GB plus the training file.
    - Sequenced, with base IQ1_S deleted before the tuned file lands and the video on an external drive, the peak is about 21 GB.
    - Target 30 GB free. Recording to an external drive brings that to 22 GB.
  - **Background load.** 5 caffeinate processes are running (pgrep). The review says they watch training jobs under .data/aws (unverified).
- **One model job at a time, and memory rules.**
  - The live app and every eval, sim and red-team run share the LFM server on 8083 and the GPU.
  - Heavy jobs run one at a time and never while you film or use Muse.
  - Two Glimmer files are never loaded at once.
  - No SAM eval runs while Glimmer runs.
  - Every model-slot job and every restart first checks for more than 5 GB free.
- **The one-bit Glimmer.**
  - "glimmer1bit" is only an internal file label. User-facing text says "about 1.6-bit (IQ1_S), X GiB" and uses GLM-1's measured bits per weight.
  - IQ1_S is 1.5625 bpw nominal. The public i1-IQ1_S file is 6,526,419,520 bytes, which is about 1.76 bpw over all 29.6B params (review figure, unverified).
  - We never run or test the fine-tune.
  - Unknown until it lands: the delivery shape (merged GGUF, LoRA on base IQ1_S, or safetensors), the quant type and quantizer, the imatrix text, whether the chat template and reasoning kwarg survived, whether the embeddings or LM head changed (DFlash shares both, https://arxiv.org/html/2602.06036v1), whether the vision tower was kept, and whether the training data overlaps our eval sets.
- **Baseline, named correctly.** The "rules-only" baseline is really **"policy decides, LFM labels"**: LFM3-VL-2B labels the request topics and the policy decides (eval/reports/device_only_unseen_200.md lines 3, 13; eval/user_policy.yaml:28).

  | Setup | Set | Result | Source |
  |---|---|---|---|
  | Policy decides, LFM labels | fresh_200_b | 73.5%, 0 leaks, 90 asks (48 wanted, 42 unneeded) | device_only_unseen_200.md |
  | Policy decides, LFM labels | tasks.jsonl | 81.0%, 27 asks | device_only_final.md:19 |
  | Base Glimmer on OpenRouter | tasks.jsonl | 76.0%, 48 asks | final_cloud.md:19 |
  | LFM in tighten mode | fresh_200_b | 42.5%, by refusing items that should have been asked or shared | device_only_unseen_200_tighten.md:19 |
  | Latest device nights | unseen | 74.0% before and after; daily unneeded asks 1, 2, 1, 1, 0 (flat) | eval/reports/nights_device_rules/nights.md |

  - The 42-ask report predates later edits to router.py, egress.py and guard.py, so we re-baseline first.
  - The 42 unneeded asks were read during research, so fresh_200_b is now a dev set.
- **Muse app.**
  - The real Muse app made 2 calls on Oct 28 (per Ethan): list_documents was shared and one search was refused.
  - The other audit rows (30 in all, Oct 27 to 30, per the review) came from scripts (ask_as_muse, relay e2e).
  - The audit has no relay or local column, and relay.log only goes back to today.
  - Untested: scheduled jobs, waiting for approvals, purpose filling, multi-step use of tags.
  - README line 9 and docs/MUSE_SETUP.md line 5 still say the app never connected. GAP-16 fixes that.
- **Live state: step 0 is tonight, before any other run.**
  - WORKSPACE_ROOT is unset, so it defaults to demo/ (base/config.py:262).
  - demo/ holds a .synthetic marker, a real resume PDF and a real screenshot. That means Muse can reach them through the relay today, and a cloud run would pass the folder-level synthetic gate.
  - Always approve is ON (BASE_HOME/auto_approve exists).
  - BASE_HOME/scans holds 4 cached entries. We did not read them.
  - setup.json shows muse_training_off false.
  - The Oct 28 list_documents result may have carried the resume's file name to Muse (unverified).
- **Repo (rebased on tonight's state).**
  - At 22:12, 7 commits (5af98a9 to 92ee1a7) landed on ethan/device-only-build (git reflog).
  - That branch tracks origin with nothing ahead, so it has been **pushed** (git branch -vv).
  - main sits at f62b827, which is on origin only through that branch.
  - The working tree shows only your local relay/wrangler.jsonc edit (not pushed) and an untracked docs/diagram/.
  - There is no LICENSE file and no .github/ CI.
  - From the earlier research run, not rechecked: pytest collects 1,953 tests, ruff is clean, the history secrets scan is clean.
- **Track and theme** (https://dev.meta.ai/events/global-hackathon, fetched):
  - Indie track: "creativity, technical ambition, and whether it works".
  - Startup track: "technical execution and whether it holds up in production".
  - Your track is unconfirmed (docs/HANDOFF.md row 14).
  - The public themes are "Build for Your World" and "Push the Frontier". If no problem-statement list exists behind your login, we use "Build for Your World".
- **Cloud runs never touch live data.** Every Spark or OpenRouter run:
  - starts its own services on a non-live loopback port, with a temp BASE_HOME and an invented workspace;
  - passes the GAP-19 hash-manifest check;
  - refuses ~/.base and port 8790;
  - turns on cloud only through a per-process override, so .env stays byte-identical.
- **Needs your yes:**
  - pushing and making the repo public;
  - Spark calls beyond the red team, and OpenRouter or Model API spend;
  - every download, and every restart of the live app;
  - relay and Vercel deploys;
  - anything on the Jetson or the Pi (you run it);
  - behavior changes in the router, egress or connector;
  - any pyproject.toml change;
  - the CLAUDE.md update;
  - the LaunchAgent install.
- **Simulated stays labeled simulated.**
  - Personas are policy files with seeded behavior, not people.
  - Every file under eval/reports/sim, every chart caption and the README section say "simulated" and "invented", and a test fails if they don't.
  - Red-team reports carry "Simulated attacker, invented data".
  - Your own click timing is labeled "measured by the author" and kept out of the simulated numbers.

## 2. Critical path

0. **Tonight, step 0 (you, about 20 min).** Nothing that reads the workspace runs until this is done.
   - Turn Always approve off and check that BASE_HOME/auto_approve is gone.
   - Move the resume PDF and the screenshot out of demo/ to a folder outside the repo. The app has no file-delete route: its only delete route removes approval history (base/ui_app.py:1385).
   - Clear BASE_HOME/scans and rebuild the index. Check the document count on /setup.
   - Delete any approval-history rows built from those two files through that route.
   - Delete the Oct 28 Muse chat that listed documents.
   - Turn off Muse training in Muse's Data controls (docs/MUSE_SETUP.md line 30) and confirm it on /setup.
1. **Tonight: your first answers.** These are Decisions 1, 2, 4, 5, 6, 7, 8, 23, 24 and 25. Decision 2 gates the seal. Decision 4 gates every download.
2. **GAP-1 is done. Next are GAP-1b (CLAUDE.md, with your yes) and the worktrees.** There are three lane worktrees plus an integration worktree, all branched from ethan/device-only-build at 92ee1a7. .env is never copied into a worktree.
3. **GAP-21 and GAP-19 first thing Oct 31.** GAP-21 is one shared config and types change. GAP-19 is the manifest that gates every cloud run.
4. **SIM-1.** Re-baseline tonight, write the splits Oct 31, then seal after Decision 2, or build SIM-1b if the fine-tune used synthetic.jsonl.
5. **Glimmer harness before the file lands.** In order: GLM-21, GLM-1, GLM-3, GLM-5/6, GLM-8, GLM-2, GLM-4 and DEV-2. Then GLM-11 (base on OpenRouter) and **GLM-18 (base IQ1_S on this Mac)**, so Glimmer runs on the device even if your file is late. This is the biggest lever for Tooling 1 and 2 and for Depth 1.
6. **Spark red team.** RED-5/6 on Oct 31, the pilot Nov 1 morning, v1 Nov 1 evening, fixes Nov 2, then v2 on the frozen commit at Nov 2, 6 PM.
7. **Tag rotation and the tag map under retention** (GAP-2, GAP-3, GAP-4), done before RED-13.
8. **Muse app.**
   - The MUSE-1 probe runs Oct 31 morning, followed by the connector fixes.
   - The relay redeploys Nov 1 daytime.
   - The judging home is created Nov 1 evening, with night 1 at 2 AM Nov 2.
   - Rehearsal is Nov 2. On Nov 3 the scenes are recorded as video footage.
9. **Persona study.** SIM-2, 3, 5/6 and 17, then SIM-8 on the frozen commit, Nov 2 night.
10. **SAM-2 to SAM-7.**
11. **Freeze rules (the one set used everywhere):**
    - **Nov 2, 6 PM:** code freeze for everything scored or run live: router, egress, guard, policy, dreaming, connector, workspace, relay and UI. After it, only docs, reports and the env-only knobs below.
    - **Nov 2, 8 PM:** restart on the frozen commit and install the LaunchAgent. Its hash goes into every scene, sealed and red-team report.
    - **Nov 3, noon:** last live restart. It happens only for a scene-breaking bug with your yes, or for an env-only knob.
    - **Nov 3, 9 PM:** no changes of any kind.
    - **Nov 4 noon to Nov 9:** no heavy jobs and no deploys.

**Post-freeze knobs (env only, until Nov 3 noon):**
- Allowed: the Glimmer file (through plug_in_model), router max tokens, reasoning budget, reasoning level, and drafter on or off.
- Each change goes into eval/reports/post_freeze_knobs.md with the knob, the old and new value, the time and the commit hash. The sealed report names it.
- No code changes.

### The hour Glimmer lands

The run takes the model slot from whatever is running. Every step runs from the **live tree**, because plug_in_model writes the .env of the tree it runs from (scripts/plug_in_model.py:23). The harness merges into the live tree in the Nov 1 evening window.

0. **You.**
   - Copy the file to the data volume.
   - Answer GLM-12.
   - Run `uv run python -m scripts.check_overlap --train <training file> --calib <imatrix text> --name glimmer1bit` and paste the counts.
1. **Disk.** If free space minus the file is under 5 GB, delete base IQ1_S first. Its rows are already saved.
2. **Check the file:** `uv run python -m scripts.plug_in_model FILE --check`.
   - It writes model_file_glimmer1bit.md: arch, quant, tensor type ids checked against the installed llama.cpp b11972, measured bpw, sha256, memory and disk.
   - It refuses unknown types in plain words.
   - If you sent a LoRA, it checks the adapter against base IQ1_S on start.sh's existing `--lora` path (scripts/start.sh:123, 135).
2b. **Look at the reply shape (Oct 31).**
   - `scripts/start_side_models.sh FILE` starts it and LFM on side ports, 4 CPU threads each, low priority, a throwaway key. It prints the environment for the steps below.
   - `uv run python -m scripts.glimmer_probe --url http://127.0.0.1:8181/v1 --key-file KEY` sends one invented request per reasoning level and reports whether the reply parses as the schema. Glimmer has only run on OpenRouter here, so this is the first test of its template and reasoning on our llama-server. Fix anything it finds before any scored row.
   - Stop the Glimmer attempt if no load and no parsed reply within 90 minutes.
   - Oct 31, from the training session's tests (stage 2 Q4_K_M on an A100, b11970, not run here): the tuned file needs reasoning off, its own template and a stop at `<|eot|>`. `plug_in_model --reasoning-off --template FILE` sets them, and start.sh then serves it with `--reasoning-format none`. Reasoning on returned HTTP 500 on free text. The probe tests free text and JSON, because JSON alone passed while free text failed. The Jetson unit has none of these flags yet.
   - Oct 31: Ethan said not to run Glimmer on this laptop. Every step here that loads it needs another machine; where is his call. `start_side_models.sh` now refuses on a Mac. docs/GPU_RUN.md has the commands for the A100 if he says yes, and its pre-registration amendment. Reasoning off is untested on the Jetson's b10353, so test it there before relying on it.
3. **Measure speed with the live app untouched.**
   - Run `uv run python -m scripts.bench_device --label mac-glimmer1b --gguf FILE --kind glimmer --reasoning low,medium,high,xhigh`.
   - With the drafter, first confirm that `--draft-n` changes acceptance, then sweep `3,5,7,15,16`.
   - Compare against base IQ1_S with the drafter (GLM-10) and Meta's 1.5x M4 Max figure at Q4_K_M (https://huggingface.co/meta-models/Muse-Glimmer-30B). DFlash stays off if the speedup is under 1.1x.
   - The seconds per call give the matrix's wall time.
4. **Preflight on a side port:** `uv run python -m scripts.model_matrix --name glimmer1bit --preflight`. It runs 5 items per config and stops in either case:
   - errors plus fallbacks go over 10%;
   - p95 tool latency is at or above 20 s at the chosen level with a set reasoning budget. The Muse budget per call is 45 s (MUSE-7).
5. **Plug it in, only inside the cutoff and only with your OK.**
   - Stop the app (LaunchAgent or start.sh).
   - Run `uv run python -m scripts.plug_in_model FILE --mode MODE`, adding `--draft` if DFlash wins. Without `--mode`, Glimmer writes answers and nothing else unless the Dreaming page says so.
   - Start it again. The relay drops for a few minutes.
6. **Smoke test:** `uv run python -m scripts.device_smoke --name glimmer1bit`. It must show 0 private values in any tool output.
7. **Matrix.**
   - Compute the wall time from step 3 first.
   - P0 configs: keywords only, policy plus LFM labels, LFM decide, base cloud, base IQ1_S decide (all reused), then tuned decide and tuned labels plus policy, on fresh_200_b and tasks.jsonl.
   - Tuned tighten is a P1 row.
   - Add the `shipped_` rows for the mode going live (Oct 31): they have Glimmer write summaries too, as the app does. The registered rows leave summaries on LFM.
   - If the wall time is over 4 h, run fresh_200_b decide first.
8. **Then one at a time:** GLM-10, GLM-9 (low and high first), GLM-20, GLM-15, GLM-7b, RED-14, SIM-15, GLM-19.
9. **Sealed rows:** `--final` on fresh_200_c, once per config, on the frozen commit.
10. **Write-up:** GLM-16, then the GAP-17 wording (you approve), then the DEV-11 row. DEV-8 on the Jetson is optional, and you run it.
11. **If the tuned model loses:**
    - run `plug_in_model --undo`, restart and keep LFM;
    - publish the result as measured, against base IQ1_S;
    - tighten is not a safe fallback, because LFM tighten fell to 42.5% through over-refusal.

**Oct 31, Ethan plans to submit with the tuned Glimmer.** The persona study therefore runs on Glimmer in the chosen mode, not on LFM: `scripts.run_study --study eval/reports/sim_glimmer --homes DIR`, then `scripts.study_summary --study eval/reports/sim_glimmer --model glimmer --dreaming-backend BACKEND`. Use step 3's seconds per call to size it before starting. If 24 runs do not fit, run the first seed of all 8 first (the plan's own order) and report how many ran. The LFM study stopped at 1 of 24, and that run is a pilot.

**Model-slot priority if it lands Nov 1 or 2:** preflight, tuned decide plus policy rows on fresh_200_b, RED-13, sealed rows, SIM-8, GLM-9 at low and high, GLM-10, then the rest.

**Arrival cutoffs:**
- **By Nov 1, 6 PM:** the full sequence. It can go live in the Nov 1 evening window.
- **By Nov 2, 4 PM:** steps 0 to 7 (decide rows only). It goes live at the 8 PM window only if preflight passes.
- **Nov 2, 4 PM to Nov 3, 9 PM:**
  - Side port only.
  - Run steps 0 to 4, then tuned decide on fresh_200_b and the sealed set.
  - The video stays on LFM.
  - The README gets the numbers, with your approval, before 9 PM.
- **After Nov 3, 9 PM:**
  - Nothing in the submission changes.
  - Steps 1 to 3 can run after you submit, for the Nov 9 finals only.
  - Whether later public-repo updates are allowed is unverified, so we ask first.

**For the parent session (memory):** the Muse Privacy entry still says "no Glimmer for now" and "no Meta API calls". Replace it with:
- Ethan is fine-tuning Muse Glimmer and shrinking it to one bit (about 1.5 to 1.6 bits per weight, IQ1_S class, about 6 GB).
- Measure it with scripts/plug_in_model.py and scripts/model_matrix.py when it lands, against base i1-IQ1_S.
- Never run Glimmer fine-tuning ourselves.
- User-facing text says "about 1.6-bit (IQ1_S)" with the measured bpw.
- Spark is allowed for the red team only, on invented data.

## 3. Schedule

**Lanes.** At most three Claude build lanes run. Each has its own git worktree and owns its files.

| Lane | Files it owns | Tasks |
|---|---|---|
| A: models, evals, devices | scripts/ (including start*.sh, plug_in_model.py, install_login.sh, cloud/), eval/, base/local_llm.py, config.py, types.py, spark.py, base/heavy/, hardware/, deploy/, models/, tests/conftest.py, .github/ | GLM, DEV, SIM-1, SIM-1b, ask_causes.py (SIM-2), SIM-5 to SIM-10, SIM-17, GAP-14, 15, 19, 20, 21 |
| B: privacy core | base/guard.py, egress.py, router.py, approvals.py, policy.py, compliance.py, controls.py, retention.py, light.py, events.py, base/dreaming/, base/workspace/rag.py, docs/THREAT_MODEL.md | GAP-2 to GAP-7, GAP-11 to GAP-13, RED-1 to RED-14, SIM-2 reason codes, SIM-3, SIM-4, SIM-12 |
| C: Muse surface, SAM, docs | base/connector/, base/workspace/ (not rag.py), base/server.py, services.py, ui_app.py, flow.py, __main__.py, ui/, relay/, site/, sidecars/sam/, docs/ (not THREAT_MODEL.md), README.md, CLAUDE.md after GAP-1b | MUSE, SAM, GAP-8, 9, 10, 16, 17, 22, RED-16 |

- **Cross-lane rules.**
  - A change to another lane's file goes through that lane.
  - pyproject.toml and uv.lock change only with your yes.
  - New test files belong to the lane that writes them.
- **Docs ownership.** Lane C owns docs/CONTRACTS.md, README.md and docs/RUBRIC.md. The other lanes send patches with each merge. A contract change and its CONTRACTS.md patch land in the same merge.
- **Known handoffs.**
  - GLM-3's router edit goes to Lane B.
  - SAM-4's retention part goes to Lane B.
  - GAP-7's UI part goes to Lane C.
  - SAM-7's start.sh part goes to Lane A.
  - SIM-10's README part goes to Lane C.
  - Every new setting (TAG_ROTATION, SAM_URL, SAM toggle, CONTACTS_PATH, reasoning knobs, drafter settings, scratch-home settings) goes into GAP-21, one Lane A change on Oct 31 morning.
- **Merging.**
  - Lanes merge daily into an integration branch in its own worktree, after a full `uv run pytest -q`. Tests never read .env.
  - The live checkout moves only in your restart windows: Nov 1 evening (Glimmer harness, tag map v2, connector fixes), Nov 2 at 8 PM (the frozen commit), and Nov 3 before noon (scene fixes only).
  - Keep your local relay/wrangler.jsonc edit unstaged.

**Model slot.** One heavy job at a time: evals, sims, red-team runs, benches and the SAM eval.

**P0 load (Claude hours per lane per day, from the task tables)**

| Lane | Oct 30 night | Oct 31 | Nov 1 | Nov 2 | Nov 3 | P0 total | If Glimmer lands or SIM-1b is needed |
|---|---|---|---|---|---|---|---|
| A | 3.5 | 14 | 14.75 | 10 | 6 | 48.25 | up to +13 |
| B | 3.5 | 14 | 15 | 13.5 | 2.5 | 48.5 | up to +2 |
| C | 3.5 | 14 | 13.75 | 14.5 | 6 | 51.75 | 0 |

- Capacity is about 56.5 h per lane: 3.5 tonight, 14 on Oct 31, 15 on Nov 1, 14 on Nov 2 and 10 on Nov 3.
- P0 is about 149 h against about 170 h. Estimates usually run about 30% long, which would make it about 193 h, so the cut order below is planned in from the start.
- P1 adds about 50 h. It runs only on lanes that are ahead.

**Oct 30 night (10:30 PM to 2 AM)**
- **Ethan (about 90 min).**
  - Step 0.
  - Decisions 1, 2, 4, 5, 6, 7, 8, 23, 24 and 25.
  - Free the disk.
  - The short GLM-12 answers: delivery shape and ETA.
  - The Pi model.
  - Paste the problem statements if they are handy; otherwise Oct 31 morning.
- **Claude.** After step 0 and your yes: GAP-1b, then the worktrees.
  - Lane A: SIM-1 re-baseline, GLM-21, GLM-3, start GLM-1.
  - Lane B: RED-1, start GAP-2/3 behind TAG_ROTATION=off.
  - Lane C: MUSE-4, start MUSE-3.
  - Model slot: the SIM-1 re-baseline, about 4 min.

**Oct 31 (Sat)**
- **Claude.**
  - Lane A: GAP-21 (first), GAP-19, GLM-1, GLM-5/6, SIM-1 splits (SIM-1b instead if Decision 2 needs it).
  - Lane B: RED-2, RED-5/6, GAP-2/3.
  - Lane C: MUSE-3, MUSE-6/7, SAM-2, MUSE-10, GAP-9, GAP-10, start MUSE-2.
  - Model slot:
    - 7 PM: GLM-6 dry run, 10 items on live LFM.
    - 8 PM: GLM-11 (cloud rows, scratch home).
    - 9:30 PM to 8 AM: GLM-18, base IQ1_S on a side port. It runs check, preflight, a wall-time estimate, decide rows, then base perplexity.
    - The night crosses the clock change, so reports use elapsed time and UTC.
  - **Load check at 9 PM:** if any lane is behind, apply the cut order now.
- **Ethan (about 3 h).**
  - Morning: the MUSE-1 probe, after step 0.
  - The full GLM-12 questionnaire.
  - SAM-1.
  - DEV-1.
  - Decisions 3, 9, 10, 11, 12, 13, 14, 16, 17, 26, 27, 28.
  - Approve the base IQ1_S and drafter downloads.

**Nov 1 (Sun, 25 hours)**
- **Claude.**
  - Lane A: DEV-2, GLM-2, GLM-4, GLM-8, SIM-5/6.
  - Lane B: GAP-2/3 (finish), SIM-2 reason codes, SIM-3, RED-3 with the GAP-11 cases.
  - Lane C: MUSE-2, MUSE-5, MUSE-11, SAM-3, SAM-4, SAM-5.
  - Model slot:
    - 9 AM: RED-7 pilot ($0.75).
    - 3 PM: DEV-6 (LFM bench, plugged in, then 15 min on battery).
    - 4 PM: GLM-10 base reference (base IQ1_S with the drafter).
    - 7:30 PM: RED-8 (1.5 to 2 h).
    - Then free, ending by 1:45 AM before night 1.
- **Ethan (about 2.5 h).**
  - Early afternoon: redeploy the relay after MUSE-10 merges and relay vitest passes. Note the previous version for `wrangler rollback` and run a probe right after.
  - Unplug for DEV-6.
  - Optional: SIM-18 and SIM-19.
  - **6:30 PM restart window:**
    - merge the Glimmer harness into the live tree;
    - back up tagmap.json and base.db;
    - create and pair the judging home (Decision 29);
    - arm MUSE-17 night 1 (dreaming at 2 AM Nov 2).
  - Decisions 15, 18, 19, 29.

**Nov 2 (Mon)**
- **Claude.**
  - Lane A: SIM-17 (morning, before SIM-8), ask_causes.py, SIM-9, GAP-14/15, GAP-20.
  - Lane B: GAP-7, RED-4, RED-9/10, GAP-4, GAP-5/6.
  - Lane C: MUSE-9, SAM-6, SAM-7, MUSE-13, MUSE-14/15, SAM-11. After the freeze: MUSE-18 and GAP-22.
  - Model slot:
    - 9 AM to noon: SAM-6.
    - Afternoon: dev re-checks.
    - 6 to 8 PM: RED-13 on the frozen commit.
    - 9:30 PM to 1:45 AM: SIM-8.
  - **6 PM: freeze.**
- **Ethan (about 4 h).**
  - 8 AM: check night 1.
  - Pre-public review of CLAUDE.md, HANDOFF, DECISIONS and NEXT_STEPS (45 min).
  - Rotate the OpenRouter and Jetson gateway keys (docs/NEXT_STEPS.md item 7).
  - Confirm track, entity and sole ownership (HANDOFF rows 14, 15).
  - Decisions 20, 30, 31, 32.
  - Review the MUSE-18 shot list.
  - **8 PM:** restart on the frozen commit with the LaunchAgent.
  - **8:30 to 9:30 PM:** rough take of all six scenes.
  - Re-arm MUSE-17 if night 1 misfired.
  - Optional: DEV-8, DEV-9.

**Nov 3 (Tue)**
- **Claude.**
  - 6 AM model slot: the sealed run on fresh_200_c.
  - Then SIM-10, GLM-16 (if Glimmer has landed), DEV-11, GAP-13, GAP-16/17, RED-16, the MUSE-18 captions and the GAP-18 checks.
- **Ethan (about 8.5 h, mostly video).**
  - 8 AM: check MUSE-17.
  - 9:30 AM to 12:30 PM: MUSE-16, screen recorded as final footage, plus RED-15 if time.
  - Noon: last restart.
  - 1:30 to 3 PM: retakes and voice-over.
  - 3 PM: approve the claim wording, push, make the repo public, redeploy Vercel.
  - 4 to 8 PM: edit and captions.
  - **Upload by 9 PM.**

**Nov 4 (morning)**
- **Claude:** no changes. Run the secrets scan and the claims test, check every link returns 200, and check that the submission's numbers match the reports.
- **Ethan:** submit by noon, then the GAP-20 uptime checklist through Nov 9.

**Cut order.** Apply it at the Oct 31, 9 PM check and again Nov 1 evening.
1. P2 first: SAM-8, MUSE-12, GAP-12, SIM-13.
2. Then P1: SIM-14, SIM-12, RED-12, RED-11, MUSE-8, GLM-19, DEV-9, DEV-3/4/5, SIM-4, SIM-18.
3. Then P0 trims:
   - GLM-9 to the router at low and high only;
   - personas from 5 to 3 (still 3 seeds);
   - RED-3 to 25 cases;
   - SAM-5 without the covered preview;
   - MUSE-2 counts only.

## 4. Workstreams

### SIM: impact evidence without real users
**What a 10 looks like:**
- The study is pre-registered: eval/reports/sim/PLAN.md is committed before SIM-8.
- 5 invented personas run 3 seeds each over 10 simulated nights. One persona's answers differ from the labeling policy, which breaks the circularity of Spark-written items labeled by the same policy.
- Night-0 changes from static fixes are shown apart from night-over-night changes from dreaming.
- Each night reports leaks, missed asks, refusals shared, over-refusals and needless asks, with intervals across seeds.
- The result is published as measured, even if it is flat. The latest device nights were flat.
- A time model cites published figures and lists its assumptions.
- The submission names one official problem statement, or Theme 1 if no list exists.

| ID | P | Task | Owner | Needs | Hours | Done when |
|---|---|---|---|---|---|---|
| SIM-1 | P0 | Re-baseline tonight. Seeded splits from the untouched pool, computed in code, with the exclusion list and count written to the split report (the 1,264 figure did not reproduce). Splits: fresh_200_c (sealed), days 800, holdout 80, unseen 100 | A | Dec. 2 for the seal | 2.5 | No-overlap test passes |
| SIM-1b | P0 if needed | Model-free sealed-set generator: deterministic templates, a new invented roster and phrasings, synthetic-format rules enforced | A | Dec. 2, 24 | 3 | 200 items; 0 overlap hits against the training file |
| SIM-2 | P0 | Fixed reason code on every ask (B); ask_causes.py (A) | B, A | SIM-1 | 2.5 | Buckets sum to the unneeded asks |
| SIM-3 | P0 | Stricter first: identifier_topics; no share rules for destination groups; kind-wide rules need 5 decisions at 100%; gate on missed_asks and refuse_shared | B | SIM-2 | 4 | A t085-type rule never forms |
| SIM-4 | P1 | Loosening fixes F1 to F3, dev sets only | B | SIM-3, Dec. 9 | 4 | Attack tests pass; 0 new missed asks |
| SIM-5, SIM-6 | P0 | Persona framework (seeded approve, remember, flip, late answers) and 5 persona folders, one off-policy. Device labels are cached per item and model sha, so extra seeds cost little model time | A | SIM-1 | 6.5 | Same seed gives same answers; all load |
| SIM-17 | P0 | sim/PLAN.md: metrics, seeds, nights, stop rule, and how fixes and dreaming are separated | A | SIM-5 | 1 | Committed before the first SIM-8 run |
| SIM-8 | P0 | Run on the frozen commit, 3 seeds per persona. A test asserts the dreaming backend is rules or prompt, never lora (base/dreaming/train.py:18 to 22). P1: a run without the fixes | A | SIM-6, 17 | 1 + 4.25 wall | nights.md per persona with intervals |
| SIM-9, SIM-9b | P0 | Time model, 3x3x3 sensitivity, capped by EdWeek and McKinsey. You time 20 clicks, labeled "measured by the author" | Both | SIM-8 | 2.5 | Sources and assumptions listed |
| SIM-10 | P0 | Chart, summary, README "Simulated study (no real users)", honesty test over every sim file | A (README via C) | SIM-8, 9 | 3 | Test fails without "simulated" |
| SIM-11 | P0 | Quote one problem statement, or Theme 1 "Build for Your World" | Both | Your paste | 1 | In RUBRIC.md and the README's first 3 sentences |
| SIM-12 | P1 | Invented HIPAA clinic, person_label "Patient". Data by hand or from templates, never Spark | B | Dec. 15, GAP-3 | 5.5 | Smoke clean; small-group hold fires |
| SIM-13, SIM-14, SIM-15 | P2, P1, P1 | CUI persona (hand-made data); receipt audit replay; personas on Glimmer | A | SIM-8 | 4.5 | 0 receipt mismatches |
| SIM-18 | P1 | Out-of-distribution set: about 40 invented items you write in the real Muse app (or by hand), checked by the synthetic rules, scored once on the frozen commit | Both | SIM-1 | 0.5 you + 1.5 | ood_40.md |
| SIM-19 | P1 | You fill the 10-essay grading spot-check, reported as "one developer grading invented essays" | Ethan | none | 0.5 | grading_spotcheck.md columns filled |

**Notes:** SIM-16 is covered by GAP-1. SIM-1 owns the seal, and GLM-8 keeps only the overlap checker.

**Reports:** device_only_unseen_200_rebase.md, ask_causes_*.md, sim/PLAN.md, sim/fixes_dev.md, sim/<persona>/nights.md, sim/summary.md, sim/asks_per_night.png, sim/time_model.md, sim/controls_checklist.md, ood_40.md, device_only_sealed_200.md.

The old privacy_officer.md becomes controls_checklist.md: controls mapped to cited rules, with no persona voice, quotes or verdicts.

### GLM: measure the one-bit Glimmer and show the fine-tune matters
**What a 10 looks like:**
- One command compares every config on the same items: keywords only (no model), policy plus LFM labels, LFM decide, base Glimmer on the cloud (provider and stated quant recorded), **base Glimmer i1-IQ1_S on this Mac**, and tuned about 1.6-bit in decide and labels-plus-policy.
- The fine-tune's effect is **tuned IQ1_S against base IQ1_S**. Quantization loss is shown separately, as base IQ1_S against base cloud.
- Metrics: leaks, asks, needless asks, unsafe shares, over-refusals, missed asks, p95 latency, reasoning tokens and paired McNemar tests.
- "The model matters" is defined before any row runs.
- Alongside: a reasoning curve per step, a DFlash A/B against Meta's 1.5x figure, an overlap report and a perplexity delta.
- If the tuned model loses, the report says where.
- The write-up says the file runs on llama.cpp only, since ExecuTorch maps only Q4_K to Q6_K (https://pytorch.org/blog/fast-ondevice-agentic-ai-with-executorch/, unverified).

| ID | P | Task | Owner | Needs | Hours | Done when |
|---|---|---|---|---|---|---|
| GLM-1 | P0 | Extend the existing `--check` (plug_in_model.py:102): stdlib GGUF reader, arch, quant, type ids against the installed llama.cpp, measured bpw, sha256, drafter fit, 5 GB floor; writes model_file_<name>.md | A | none | 3 | Tiny-GGUF tests pass; unknown type refused in plain words |
| GLM-2 | P0 | `--draft`, flash-attention and reasoning-budget knobs; start.sh `-md <drafter> -ngld 99` (Meta GGUF README). `--undo` already exists | A | GLM-1 | 2 | No non-loopback bind; start.sh tests with and without a drafter |
| GLM-3 | P0 | Router reasoning level and max tokens; tokens and timings kept per decision (router.py part through B) | A, B | none | 2 | Prompt line matches template kwargs |
| GLM-4 | P0 | Label checks keyed to the LFM labeler (Dec. 11 default) | A | none | 0.75 | Plug-in settings apply them |
| GLM-5, GLM-6 | P0 | Extend compare_modes.py into model_matrix. See the list below the table | A | GLM-1, 3, GAP-19 | 6 | 10-item dry run on live LFM; .env byte-identical after a cloud row; refuses ~/.base |
| GLM-7a | P1 | Glimmer tagging and label harness, against a mocked server and LFM | A | GLM-6 | 1.5 | Scores only, no text |
| GLM-7b, GLM-15 | P1 | The runs: Glimmer tagging and labels; grading agreement (no API call) | A | Glimmer | 3 | Scores only |
| GLM-8 | P0 | Overlap checker over the training file and the imatrix text: counts only, exits 1 on hits | A | none | 1.5 | Exact, near and name hits found |
| GLM-9 | P0 low/high, P1 rest | Reasoning sweep per step: router 60 items; name pass, request-topic label and grading 20 each; timed with bench_speed's steps | A | Glimmer | 3 | Default level per step with 0 leaks |
| GLM-10 | P0 | DFlash A/B, base IQ1_S first (GLM-18), then tuned. Sweeps 3, 5, 7, 15, 16 after confirming the flag works. Reports acceptance length and greedy match. Off if under 1.1x | A | Drafter, DEV-2 | 1.5 | dflash_base_iq1s.md, dflash_glimmer1bit.md |
| GLM-11 | P0 | Base Glimmer via OpenRouter in a scratch home, $2 cap; records provider and stated quant | A | GLM-6, Dec. 6 | 1.5 | Cost logged; 0 leaks; .env unchanged |
| GLM-12 | P0 | File and training questionnaire (Decision 2 has the list) | Ethan | none | 0.5 | Answers in docs/DECISIONS.md |
| GLM-13, GLM-16 | P0 | The Glimmer hour; a one-page write-up in "about 1.6-bit (IQ1_S), X GiB" wording | Both | All above | 10 | Every number links to a report |
| GLM-18 | P0 | Same-quant control: base i1-IQ1_S on a side port. Runs check, bench, preflight, decide rows on fresh_200_b and tasks.jsonl, and base perplexity on fixed invented text. Deleted when the disk needs it | A | Dec. 23, GLM-6 | 2 + overnight | matrix_base_iq1s.md |
| GLM-19 | P1 | Glimmer vision: base mmproj (1,400,328,928 bytes) against LFM on the 24 SAM-2 pages, measuring field accuracy, signature names in the text, seconds per page and peak RSS. If the tuned file can't take it, that is a finding | A | Dec. 26, SAM-2 | 2 | glimmer_vision.md |
| GLM-20 | P1 | Perplexity of tuned against base IQ1_S, same text and context | A | GLM-18, Glimmer | 0.5 | ppl_glimmer1bit.md |
| GLM-21 | P0 | Pre-register in glimmer_prereg.md: "the model matters" means it beats policy plus LFM labels on accuracy with no more leaks, missed asks or over-refusals | A | none | 0.5 | Committed before GLM-11 |

**GLM-5/6 scope (model_matrix):**
- Configs: keywords only, policy plus LFM labels, LFM decide, base cloud, base IQ1_S, tuned decide, tuned labels plus policy, and tuned tighten (P1).
- Preflight stops above 10% errors plus fallbacks, or at p95 of 20 s or more, and gives a wall-time estimate.
- Resume, McNemar, fixed vs broke.
- Over-refusal and missed asks are top-level metrics.
- Cost cap and side port.
- Cloud rows run only through the per-process override in a temp BASE_HOME, behind the manifest check.

**Reports:** glimmer_prereg.md, model_file_base_iq1s.md, model_file_glimmer1bit.md, matrix_base_cloud.md, matrix_base_iq1s.md, matrix_glimmer1bit.md, reasoning_sweep_glimmer1bit.md, dflash_*.md, grading_1bit_glimmer1bit.md, overlap_glimmer1bit.md, ppl_glimmer1bit.md, glimmer_vision.md, glimmer_1bit.md, post_freeze_knobs.md.

### SAM: SAM 3.1 covers faces and signatures before the device reads a page
**What a 10 looks like:**
- SAM 3.1 runs as an optional loopback sidecar on 127.0.0.1:8085, with its own uv environment and no pyproject edit.
- A SAM health failure disables SAM only. It never stops the connector.
- Before the device reads a scan, it covers faces, signatures, ID cards and barcodes.
- Receipts count region kinds. The counts map to:
  - HIPAA's full-face photo identifier (45 CFR 164.514(b)(2)(i)(Q));
  - COPPA's definition of personal information (16 CFR 312.2 (8), (10));
  - FERPA photo guidance.

  The line "a toggle doesn't make anyone compliant" stays next to them.
- Under a toggle, each request fails closed, so an image nobody checked is never read.
- On invented pages we measure, per text prompt: recall, false covers, ms per page and peak RAM. We also count how many signature names reach Muse's text with covering off and on.
- Meta's hosted SAM 3.1 checks the third-party MLX port on the same pages.

| ID | P | Task | Owner | Needs | Hours | Done when |
|---|---|---|---|---|---|---|
| SAM-1 | P0 | Pick weights, approve the sidecar's dependency list (mlx-vlm>=0.4.3), pick the face source, fill the HF gate form | Ethan | Dec. 4, 5, 14, 27 | 0.5 | df shows the Decision 5 margin |
| SAM-2 | P0 | 24 invented pages with ground-truth boxes; faces drawn or from Muse Image | C | Dec. 27 | 2.5 | Byte-identical reruns |
| SAM-3 | P0 | Sidecar (mlx-vlm, mlx-community/sam3.1-bf16), bearer key, box fill, pixels never logged. Root tests use only a fake predictor with pytest.importorskip | C | SAM-1 | 3 | Fake-predictor tests pass on ubuntu |
| SAM-4 | P0 | Device reads the covered page; fails closed per request under toggles; regions under retention (part via B) | C | SAM-3 | 3 | Sidecar down: image appears nowhere |
| SAM-5 | P0 | Receipt counts, face and signature floors, covered preview on the card | C | SAM-4 | 2.5 | Preview serves covered bytes only |
| SAM-6 | P0 | Region eval with recall per prompt ("signature", "barcode", "ID card" are unverified), plus the end-to-end name count. Never while Glimmer runs | C | SAM-2, 4 | 3 | Both reports exist |
| SAM-7 | P0 | start.sh with SAM optional and non-fatal (via A), smoke, contracts, PRIOR_WORK credit | C | SAM-5 | 1.5 | Killing SAM leaves the connector up |
| SAM-8 | P2 | Covered copy of photos; 3.1 video tracking as a stretch | C | SAM-4 | 2.5 | Counts-only release |
| SAM-11 | P0 | Demo beat: which forms lack a signature | Both | SAM-7 | 1 | Numbers match reports |
| SAM-12 | P1 | Hosted SAM 3.1 on the same 24 pages (about $0.06 at $2.50 per 1,000 images) against the MLX port | C | Dec. 27 | 0.5 | sam_hosted_check.md |

**Reports:** sam_regions_v1.md, sam_e2e_v1.md, sam_hosted_check.md. If the guard already caught every name with covering off, we present SAM as a compliance signal, not a leak fix.

### RED: Muse Spark plays a hostile Muse
**What a 10 looks like:**
- A threat model maps 12 attack families to code and tests.
- A no-network suite of 30 or more cases runs in pytest.
- Spark runs 36 adaptive episodes through the real MCP tools of a **scratch** connector on invented data. Spark is pinned to `muse-spark-1.3` (Standard), and any `-contributor` id is refused, since that tier lets Meta train on content (https://dev.meta.ai/docs/pricing-rate-limits.md).
- Target results:
  - 0 leaks;
  - attribute guesses no better than base rate;
  - linking across sessions near chance (1 in 24) once tags rotate.
- Every finding becomes a replay test, a fix and a paired before/after number on the frozen commit.
- Possible framing: if Glimmer was distilled from Spark (per a Meta blog, unverified), this is the teacher attacking its student. We check the source before using it.

| ID | P | Task | Owner | Needs | Hours | Done when |
|---|---|---|---|---|---|---|
| RED-1 | P0 | Threat model outline (GAP-13 completes it) | B | none | 1.5 | Each family names a test or a gap |
| RED-2 | P0 | Ground truth, dossier, scenarios with canaries (invented only) | B | none | 2.5 | Spark's own name check passes on every brief |
| RED-3 | P0 | Deterministic suite with GAP-11's cases | B | RED-2, GAP-3 | 6.5 | 30+ cases in under 60 s |
| RED-4 | P0 | Models whose output leaves never see a real name | B | none | 1.5 | Passes, or xfails on rag._view |
| RED-5, RED-6 | P0 | red_team.py and tests. See the list below the table | B | RED-2, GAP-19 | 8.5 | Replay run with 0 Spark calls; test refuses the live home and port |
| RED-7, RED-8 | P0 | Pilot ($0.75) Nov 1 morning, then full v1 (about $5) Nov 1 evening | Both | Dec. 6 | 3 | Per-family tables |
| RED-9, RED-10 | P0 | Freeze findings; fixes (source topics, tagged model views, differencing floor, summary singling-out) | B | RED-8, Dec. 13 | 7 | xfails flip; fresh_200_b at 73.5% or better |
| RED-11, RED-12 | P1 | Uniform hold text and named-person ask; a mode that spans several sessions | B | Dec. 12, GAP-3 | 5 | Indistinguishability test passes |
| RED-13 | P0 | Full v2 on the frozen commit, paired with v1 | Both | RED-10 | 2 | 0 leaks; commit hash in the report |
| RED-14, RED-15 | P1 | Glimmer as defender; hostile clip in the real app (invented home) | Both | Glimmer | 3 | Side-by-side table; 0 private values |
| RED-16 | P0 | README section, RUBRIC rows, demo beat | C | RED-13 | 1.5 | No "compliant" |

**RED-5/6 scope (red_team.py):**
- Starts its own connector on a non-live loopback port, with a temp BASE_HOME and an invented workspace.
- Refuses ~/.base and port 8790.
- Pins the model id and prints it in each report.
- Runs a strict name check before every Spark call.
- Stops at the budget.

**Reports:** red_team_pilot.md, red_team_v1.md, red_team_v1_always.md, red_team_v2.md, red_team_glimmer_1bit.md, device_only_unseen_200_red.md.

### MUSE: deep use of the real Muse app
**What a 10 looks like:** six scenes in the real app, in one judging home that also serves Scene E and Nov 4 to 9.
- **A, grading:** Muse waits in the same turn for your approval, then follows up with tags.
- **B, mail merge (P1):** 27 guardian drafts that Muse never sees.
- **C, newsletter quote:** it arrives when you tap Share it.
- **D, IEP refusal:** 0 re-asks.
- **E, scheduled night:** Muse's own 2 AM dreaming and 8 AM report.
- **F, CUI task:** only a receipt comes back.

All claims go in eval/reports/muse_app. When the device is offline, Muse says so in plain words.

| ID | P | Task | Owner | Needs | Hours | Done when |
|---|---|---|---|---|---|---|
| MUSE-1 | P0 | Probe on current code after step 0: purpose, waiting, refusal, offline, scheduled task, token refresh | Ethan | Dec. 8 | 1.5 | Muse's exact words pasted |
| MUSE-2, MUSE-3 | P0 | Statuses-only session report; relay or local label recorded for every call from now on | C | none | 5.5 | Counts match the session's audit rows |
| MUSE-4 | P0 | Descriptions, INSTRUCTIONS (with GAP-3's rotation line), fixed refusal sentence | C | none | 2 | No em dash |
| MUSE-5 | P0 | Purpose required | C | Dec. 16 | 1.5 | Missing purpose gets the usage sentence |
| MUSE-6, MUSE-7 | P0 | get_result waits up to 40 s; 45 s budget per call | C | Dec. 28 | 4.5 | Approval returns in under 1.5 s |
| MUSE-8 | P1 | save_on_device: the device fills in names | C | Dec. 17 | 6 | 27 drafts; no name in the receipt |
| MUSE-9 | P0 | Named result saved on the device | C | MUSE-4 | 2 | CUI refusal mentions the file |
| MUSE-10 | P0 | Relay sends a readable result when the device is offline; redeploy Nov 1 with a rollback and a probe | Both | Dec. 18 | 3.25 | Muse quotes the sentence |
| MUSE-11 | P0 | Connector-side lock so a second dream start in one night starts nothing | C | none | 1.5 | Second call starts nothing |
| MUSE-12 | P2 | Ask numbers in the dreaming report | B | SIM-2 | 3 | Report shows them |
| MUSE-13 | P0 | Invented CUI folder (shared with SIM-13), by hand or templates, never Spark | C | Dec. 15 | 1.5 | Synthetic checks pass |
| MUSE-14, MUSE-15 | P0 | Scene rehearsal on a scratch home; docs updated from the probe | C | MUSE-1 to 13 | 4 | Six scenes reach expected statuses |
| MUSE-16, MUSE-17 | P0 | Scene session, recorded as final footage; scheduled night in the judging home, dreaming on rules or prompt | Ethan | MUSE-14 | 3.25 | scene_A..F.md, night_1.md |
| MUSE-18 | P0 | Shot list (Nov 2) and captions (Nov 3) | Both | MUSE-14 | 3 | Every number in a report |

**Reports:** muse_app/probe_oct31.md, scene_A.md to scene_F.md, night_1.md, rehearsal_<date>.md, each with the commit hash. Metrics: purpose filled N of M, re-asks, calls via relay, tool times.

### GAP: close the privacy gaps and make the repo shippable
**What a 10 looks like:**
- The repo is public, with a LICENSE, third-party notices, green CI and short history.
- The threat model names code and a test for every control, and lists Muse's own retention as an assumption.
- Tags rotate daily with a 36 h grace, and only tags the device sent can be restored.
- The tag map is under retention.
- The synthetic gate checks hashes, not just a folder marker.
- The app stays up from Nov 4 to 9.
- README and site claims match what ships.

| ID | P | Task | Owner | Needs | Hours | Done when |
|---|---|---|---|---|---|---|
| GAP-1 | Done | 7 commits at 22:12, pushed. Left: you confirm the push, and decide on docs/diagram/ | Ethan | Dec. 1 | 0.1 | Confirmed in DECISIONS.md |
| GAP-1b | P0 | CLAUDE.md update. See the list below the table | Claude | Dec. 25 | 0.5 | Lane agents read the new rules |
| GAP-2, GAP-3 | P0 | Tag map v2 behind TAG_ROTATION (daily, codes never reused, 36 h grace); only sent tags restore. Migration tested on a copy. Rollback: TAG_ROTATION=off on the new code, keeping the v2 tagmap.json; restore the v1 backup only if Muse never saw a v2 tag (it brings back old counters, so codes would be reused), and the old branch cannot read v2 (docs/UPTIME.md, docs/RETENTION.md) | B | Dec. 10 | 7 | A guessed tag gets the fixed sentence |
| GAP-4 | P0 | Tag map under retention (you asked for it) | B | GAP-2 | 1.5 | RETENTION.md:15 gap removed |
| GAP-5, GAP-6 | P0 | Sources survive restart; light after restart | B | none | 1.5 | Restart tests fail today, pass after |
| GAP-8 | P1 | /ask shows only page questions | C | none | 0.75 | Test passes |
| GAP-7 | P0 | Narrow Always approve, 8 h expiry (UI via C) | B | Dec. 7 | 1.5 | auto_approve gone before recording |
| GAP-9 | P0 | Relay uses the system proxy by default; RELAY_PROXY=direct is the opt-in for the 1010 case | C | Dec. 19 | 1 | Both modes tested |
| GAP-10 | P0 | No-network test through every tool | C | none | 1 | Fails if a stub leaves loopback |
| GAP-11, GAP-12 | P0, P2 | Attack cases that need rotation (in RED-3's file); neutralize tag-shaped text | B | GAP-3 | 3 | xfails match residual risks |
| GAP-13 | P0 | Complete the threat model, including Muse retention and the Oct 28 list_documents exposure | B | RED-1, GAP-3 to 11 | 2.5 | Every row names an existing test |
| GAP-14, GAP-15 | P0 | Stronger secrets scan (including .env.example); CI on ubuntu and macOS, run in a clean clone with no .env before the CI file is pushed | A | none | 2.5 | Green in the clean clone, then after your push |
| GAP-16, GAP-17 | P0 | Claims match device-only, then measured Glimmer; fix README line 9 and MUSE_SETUP.md line 5. The claims test bans "compliant", "1-bit" without the measured bpw next to it, and "COPPA acts on" | C | GAP-13, GLM-16 | 3 | You approve wording |
| GAP-18 | P0 | Push and make public, after keys are rotated and the LICENSE is in | Ethan | Dec. 20 | 1 | Landing-page links return 200 |
| GAP-19 | P0 | Synthetic gate checks a hash manifest of invented files; a stray real file in a .synthetic folder is refused (config.py, workspace via C) | A | none | 2 | Test with a stray file passes |
| GAP-20 | P0 | Uptime kit. See the list below the table | A | Dec. 30 | 2 + 0.5 you | Probe green after a forced crash and restart |
| GAP-21 | P0 | One config and types change for all lanes | A | none | 1.5 | Every lane builds on it |
| GAP-22 | P0 | LICENSE and third-party notices (SAM License, Glimmer Apache 2.0, LFM license) | C | Dec. 31 | 1 | Files in the repo |

**GAP-1b changes to CLAUDE.md:**
- The one-bit Glimmer is measured with plug_in_model and model_matrix.
- Never run fine-tuning here.
- Spark is allowed for the red team only, on invented data.
- The SAM sidecar is approved on 127.0.0.1:8085.
- The Oct 27 "no llama-server" line (CLAUDE.md:15) and the Oct 30 "ignore Glimmer" line (CLAUDE.md:23) are marked superseded.

**GAP-20 uptime kit:**
- The LaunchAgent (scripts/install_login.sh) is installed from the frozen tree.
- A one-command health probe checks the ports on 127.0.0.1, the relay connection, df and the last night.
- The Nov 4 to 9 checklist:
  - AC power and lid open;
  - macOS updates deferred;
  - 5 GB floor of free disk;
  - relay token refresh checked;
  - no heavy jobs and no deploys.

**Reports:** a refreshed secrets_scan.md, a fresh test count with its command, and a device-only rerun after GAP-7.

### DEV: device numbers
**What a 10 looks like:**
- One bench script runs unchanged on the Mac, the Jetson and the Pi.
- Each run reports load time, peak memory, tokens per second, the real steps on the invented class, reasoning levels and power source. DFlash on and off is measured on the Mac only.
- A README matrix marks each device as fits, too slow or does not fit, with links.
- The cost table sums the measured peak RSS of every sidecar. "$0 on an existing 16 GB laptop" says "projected" unless it was tested.
- Prices are dated and cited.
- The "12x slower on battery" claim is either measured or removed.

| ID | P | Task | Owner | Needs | Hours | Done when |
|---|---|---|---|---|---|---|
| DEV-1 | P0 | Device facts: Pi model, Jetson board that serves no other demo, transfer method, file host | Ethan | none | 0.25 | Table in DEVICE_BENCH.md |
| DEV-2 | P0 | Extend bench_speed.py: own port, memory sampler, timings, `--draft-n`, greedy match, refuses reports with a hostname or IP | A | none | 3.5 | Mocked tests; server always killed |
| DEV-3, DEV-4 | P1 | Scanned bundle from the working tree; runbook per device. Jetson: text only, no drafter, small context, run on the board's own console, USB transfer, no SSH from this Mac | A | DEV-2 | 2.5 | No .env or gguf inside |
| DEV-5 | P1 | Board path: RAM margin including KV cache at the chosen context (52 layers, 2 KV heads, head dim 128 per the Glimmer GGUF README, about 52 KiB per token in f16, unverified), --model-file, GLIMMER_GGUF in the unit file | A | none | 2 | 6.1 GiB plus KV passes on a mock Jetson |
| DEV-6, DEV-7 | P0 | Mac LFM bench (plugged in, then 15 min on battery); Mac one-bit bench (step 3 of the hour) | Both | DEV-2; Glimmer for DEV-7 | 2.5 | Battery claim backed or gone |
| DEV-8, DEV-9 | P1 | Jetson and Pi runs | Ethan | DEV-3 to 5 | 5.5 | Reports, or out-of-memory reports |
| DEV-11 | P0 | Device matrix and cost table | A | DEV-6, 7 | 2 | Per-school figure labeled an assumption |

**Reports:** device_mac-lfm.md, device_mac-lfm-battery.md, device_mac-base-iq1s.md, device_mac-glimmer1b.md, device_mac-glimmer1b-dflash.md, device_jetson-*.md, device_pi5-*.md, devices.md.

## 5. Decisions for Ethan

Numbers 1 to 22 are unchanged. Numbers 23 and up are new. Where work starts on a recommendation before you answer, it sits behind a switch, and your answer can change it.

**Tonight**
1. **The 22:12 push.** **Rec:** confirm the push to origin was yours. Commit docs/diagram/ in Lane C's first merge if it holds no real data. Keep wrangler.jsonc unstaged.
2. **Fine-tune data and the file (GLM-12).**
   - Did it use synthetic.jsonl, fresh_200*, tasks, holdout or roster names?
   - Who wrote the data?
   - Delivery shape: merged GGUF, LoRA on base IQ1_S, or safetensors?
   - Quantizer and build.
   - The imatrix text.
   - Did the chat template and reasoning_strength survive?
   - Did the embeddings or LM head change?
   - Was the vision tower kept?
   - Where is the training file, and how big is it?
   - ETA.

   **Rec:** answer before SIM-1 splits. Every planned set is a slice of synthetic.jsonl (eval/DATASET.md line 20). If it was used, all of them are contaminated, and SIM-1b builds a new sealed set without a model.

   synthetic.jsonl is Spark output (eval/reports/synthetic.md), and docs/PRIOR_WORK.md line 27 records that Meta's terms bar using outputs to train a competing model. Read that clause yourself (https://dev.meta.ai/legal/terms-of-service; the clause number is unverified) before any submission claim uses the tuned model.
4. **Disk.** **Rec:**
   - Tonight: `hf cache delete` embeddinggemma-2, siglip2 and all-MiniLM (about 4.0 GB). Check df.
   - Find 10 to 15 GB outside the HF cache (Downloads, Movies, old builds).
   - Delete d1-omni (2.85 GB) only if jetson-infra doesn't need it here.
   - Delete Nemotron (6.74 GB) once the Bolt demo is done.
   - Record the video to an external drive if you have one.
   - Target 30 GB free.
5. **Downloads.** **Rec:**
   - Base i1-IQ1_S and the drafter on Oct 31.
   - Your file on arrival, after deleting base IQ1_S if space is short.
   - SAM 3.1 bf16 when df shows about 17 GB free (room for your file, the floor and SAM), else after your file is measured.
   - If it never fits, use sam3-8bit and call it SAM 3.
   - Request facebook/sam3.1 access yourself.
6. **Spend.** **Rec:**
   - Spark red team: $25 total.
   - OpenRouter base Glimmer: $2, on invented data, as an exception to device-only through the per-process override.
   - No Spark persona judge (SIM-7).
7. **Always approve.** **Rec:** off tonight (step 0), then ship GAP-7.
8. **Personal files in demo/.** **Rec:** step 0 tonight, before any other run.
23. **Base IQ1_S control (6.53 GB).** **Rec:** yes. Measure it Oct 31 night. It is the only fair test of your fine-tune, and it puts Glimmer on the device even if your file is late.
24. **New sealed set if Decision 2 needs one.** Options: SIM-1b templates (no model) / Spark writes 200 items (about $1, beyond the red-team exception). **Rec:** templates.
25. **CLAUDE.md update (GAP-1b).** **Rec:** yes, before the lanes start.

**Oct 31 to Nov 1**

3. **Problem statement.** **Rec:** paste the list. If none exists, use Theme 1 "Build for Your World".
9. **SIM-4 fixes (P1).** **Rec:** F1 to F3 with attack tests if Lane B is ahead. Skip F4.
10. **Tag rotation.** Options: daily / weekly / per chat (not possible: no chat id reaches the device) / per socket session / only under toggles. **Rec:** daily, with a 36 h grace and sent-only restore. TAG_ROTATION=off is the escape hatch.
11. **Label checks with Glimmer plugged in.** **Rec:** key them to the LFM labeler.
12. **Hold text and raw names.** **Rec:** one uniform hold text for floors that reveal content. Ask the user when Muse's request contains a roster name.
13. **Fixes that may raise asks** (RED-10, the differencing floor, MAX_PENDING). **Rec:** yes. Measure each one and report the change.
14. **SAM.** **Rec:**
    - Fail closed per request under privacy toggles.
    - Send no images to Muse.
    - Use drawn or Muse Image faces, not Face Synthetics (non-commercial license).
    - Never call SAM under cui, cjis or export, since the SAM License excludes ITAR use.
16. **Purpose required.** **Rec:** yes. Size the change after MUSE-1.
17. **save_on_device and CONTACTS_PATH (P1).** **Rec:** yes, if Lane C is ahead.
26. **Glimmer mmproj (1.4 GB, GLM-19).** **Rec:** yes, if df allows after your file. Glimmer reading SAM-covered pages is Meta models end to end.
27. **Hosted SAM 3.1 check and Muse Image pages.** Prices are $2.50 per 1,000 images and $0.01 per image (https://dev.meta.ai/docs/pricing-rate-limits.md, fetched tonight). **Rec:** yes, $1 cap, invented pages only. This is Model API use beyond the red team.
28. **Connector waits (MUSE-6/7).** **Rec:** yes. get_result waits up to 40 s, with a 45 s budget per call.

**Nov 1**

15. **Non-education scene.** **Rec:** CUI scene F for sure. Do the HIPAA clinic (P1) only if person_label lands after GAP-3, and make it a clinic, never a school nurse. Those records fall under FERPA per the HHS and ED guidance, though the PDF returned 403, so this is unverified. Use one invented CUI agency for MUSE-13 and SIM-13.
18. **Relay.** **Rec:** redeploy MUSE-10 Nov 1 in daytime, with a rollback and a probe. Keep the 1 h token unless the refresh probe fails; if it does, use 24 h for Nov 4 to 9. No relay deploys Nov 4 to 9.
19. **Defaults.** **Rec:**
    - The relay uses the system proxy, with RELAY_PROXY=direct as the opt-in. Tell us whether your employer's IT policy allows the direct mode on this managed laptop (CLAUDE.md line 27).
    - APPROVAL_LOGIN off.
    - CI on both operating systems.
    - No backup dreaming timer.
    - Skip Muse Code and Muse Gadgets.
29. **Judging home.** **Rec:** a fresh BASE_HOME, created and paired in the Nov 1 evening window after backing up the old home. MUSE-17, the video, Scene E and judging all use it. It never held the real files.

**Nov 2 to 3**

20. **Going public.** **Rec:** Nov 3 around 3 PM, after the Nov 2 doc review, key rotation and LICENSE. Commit author emails become public.
21. **Glimmer in the video.** **Rec:** only if it passes the full preflight (errors and p95) by Nov 2, 4 PM.
22. **Devices.** **Rec:**
    - Use one Jetson that serves no other demo, and record `nvpmodel -q` without changing it.
    - Transfer files by USB.
    - Skip Device Farm.
    - Show cost per teacher, with 16 GB laptops marked "projected" unless tested.
30. **LaunchAgent.** **Rec:** install it from the frozen tree at the Nov 2, 8 PM restart, so a crash during judging restarts the app.
31. **License.** **Rec:** your call, after checking the Startup track's sole-ownership warranty. Apache 2.0 matches Glimmer's license; MIT is simpler.
32. **Track and entity.** **Rec:** confirm by Nov 2 (HANDOFF rows 14, 15).
    - Startup: lean on uptime, CI, LICENSE and docs.
    - Indie: lean on the demo's creativity.

## 6. Risks

1. **Your file is late, fails to load, or is worse.** IQ1_S cost +248% perplexity on Llama 3 70B. *Mitigation:*
   - the harness is ready first;
   - base IQ1_S gives on-device Glimmer numbers regardless;
   - the arrival cutoffs apply;
   - `--undo` restores LFM;
   - we publish what we measure.

   Tighten is not a safe fallback: it over-refuses (42.5%).
2. **Cut-off or slow replies.** Thinking can't be turned off and defaults to high (Glimmer GGUF card). A 30B dense model at about 1.6 bits has never run here. *Mitigation:*
   - preflight stops above 10% errors plus fallbacks, or at p95 of 20 s or more;
   - the matrix wall time is computed before it starts;
   - the post-freeze knobs.
3. **Contaminated numbers or a terms problem.** *Mitigation:* Decision 2 tonight, the overlap report (including the imatrix text), SIM-1b, the sealed set scored once on frozen code, and your read of the terms.
4. **Mac resources.** Disk is tight, memory too, LFM is shared, and restarts drop the relay. *Mitigation:*
   - the disk table and the 5 GB floor checked before every job;
   - never two Glimmer files loaded, and no SAM during Glimmer;
   - one model slot;
   - restarts only in your windows;
   - the single set of freeze rules in section 2.
5. **Real data reaching a cloud model.** The live workspace held a real resume under a .synthetic marker. *Mitigation:* step 0, GAP-19's hash manifest, scratch homes for every cloud run, and tests that refuse ~/.base and port 8790.
6. **Overclaiming.** *Mitigation:*
   - Personas could read as real people: the label test, plus the checklist in place of a "privacy officer".
   - "1-bit" reads as BitNet: measured bpw wording, enforced by the claims test.
   - Dreaming can learn an over-broad share rule (Oct 27: t085 was shared, and ask_first fell from 100% to 68%): the missed-ask gate.
   - Covering pixels that never leave proves nothing: SAM's before/after count.
   - COPPA binds operators, not a teacher's device: "maps to" wording.
7. **Live tree drift and edit collisions.** *Mitigation:* every path has an owner, lanes merge into an integration worktree, the live tree moves only in windows, and .env stays in the live tree only.
8. **Muse app unknowns.** Scheduled jobs may not reach connectors, Muse's tool timeout is unknown, the token lasts 1 h, and Cloudflare error 1010 may come back. *Mitigation:*
   - the day-one probe;
   - wait caps of 40 s and 45 s;
   - a User-Agent line in the setup prompt;
   - two scheduled-night tries;
   - Dream now with an honest caption as the fallback.
9. **Downtime Nov 4 to 9.** start.sh stops everything if one child stops (scripts/start.sh:197). *Mitigation:* SAM is optional and non-fatal, plus the LaunchAgent, the health probe and the GAP-20 checklist.
10. **Scope.** P0 is about 149 h against about 170 h of lane capacity, before the usual overrun. *Mitigation:* critical-path order, the cut order applied from Oct 31 evening, and personas cut from 7 to 5.
11. **Demo is 25% of the score.** *Mitigation:* shot list on Nov 2, rough take on Nov 2 evening, final footage from the Nov 3 scene session, upload by Nov 3, 9 PM, and checks only on Nov 4.

## 7. Not doing

- Running or testing Glimmer's fine-tune, SSH or fleet tools, real data, or any push or PR without your yes.
- SIM-7 (Spark persona judge).
- GLM-14, because there is no time to measure it well. GLM-17 and the separate DFlash script are merged into DEV-8 and DEV-2.
- A Q4_K_M device baseline: 16.76 GB does not fit.
- KL divergence against base: it needs large saved logits. Perplexity only (GLM-20).
- Tuned tighten as a fallback. It stays only as a P1 matrix row.
- SAM-9: a new kind of egress, checked only by a 2B OCR model.
- SAM-10: Glimmer and SAM cannot share 8 GB on the Jetson.
- sam3-mlx: SAM 3 only, and it needs Python 3.13.
- DEV-12: merged into SAM-6.
- DFlash on the Jetson: the drafter does not fit beside the file in 8 GB.
- MUSE-19: the Gadget SDK's system.run and file.read have no documented off switch.
- MUSE-12 is P2.
- DEV-10 (Device Farm phones). A phone is not a Muse Privacy device, and there is no time. The 4 GB limit applies only to app uploads; the test spec could download base IQ1_S (https://docs.aws.amazon.com/devicefarm/latest/developerguide/limits.html), so a phone run would be a capability probe, not a blocker.
- Audio: Muse Voice Transcribe appears in the event page's navigation and COPPA covers children's voice files, but there is no time.
- GAP-8's login option, a separate test_attacks.py (merged into RED-3), per-chat rotation, SIM-4 F4, and a backup dreaming timer.

## 8. Sources

Repo paths are cited inline. Web sources follow. Items marked "secondary" are not used for any quoted number.

**Meta event, pricing, terms**
- https://dev.meta.ai/events/global-hackathon
- https://dev.meta.ai/docs/pricing-rate-limits.md
- https://dev.meta.ai/docs/models.md
- https://dev.meta.ai/legal/terms-of-service
- https://dev.meta.ai/legal/geographic-use-policy

**Glimmer, llama.cpp, quantization**
- https://huggingface.co/meta-models/Muse-Glimmer-30B
- https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF
- https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF/raw/main/README.md
- https://huggingface.co/api/models/meta-models/Muse-Glimmer-30B-GGUF/tree/main
- https://huggingface.co/mradermacher/Muse-Glimmer-30B-i1-GGUF
- https://huggingface.co/api/models/mradermacher/Muse-Glimmer-30B-i1-GGUF/tree/main
- https://dev.meta.ai/resources/blog/build-with-muse-glimmer/
- https://pytorch.org/blog/fast-ondevice-agentic-ai-with-executorch/
- https://arxiv.org/html/2602.06036v1
- https://arxiv.org/html/2610.24628v1
- https://www.jetson-ai-lab.com/tutorials/speculative-decoding
- https://huggingface.co/spiritbuun/Qwen3.6-27B-DFlash-GGUF (replaces the hf-cn0.pages.dev mirror; path unverified)
- https://huggingface.co/JaaackXD/Llama-3-70B-GGUF
- https://github.com/ggerganov/llama.cpp/pull/6936
- https://github.com/ggerganov/llama.cpp/pull/6302
- https://github.com/ggml-org/llama.cpp/pull/8151/files
- https://github.com/ggml-org/llama.cpp/releases/tag/b10414
- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- https://github.com/ggml-org/llama.cpp/issues/12968

**SAM**
- https://huggingface.co/facebook/sam3.1
- https://huggingface.co/facebook/sam3.1/tree/main
- https://huggingface.co/facebook/sam3
- https://huggingface.co/facebook/sam3/tree/main
- https://huggingface.co/facebook/sam3/discussions/11
- https://huggingface.co/facebook/sam3/discussions/252
- https://github.com/facebookresearch/sam3
- https://github.com/facebookresearch/sam3/blob/main/RELEASE_SAM3p1.md
- https://github.com/facebookresearch/sam3/blob/main/LICENSE
- https://github.com/facebookresearch/sam3/pull/400 (replaces the gh.r-mj.com mirror)
- https://ai.meta.com/blog/segment-anything-model-3/
- https://huggingface.co/docs/transformers/en/model_doc/sam3
- https://huggingface.co/mlx-community/sam3.1-bf16
- https://huggingface.co/mlx-community/sam3.1-bf16/raw/main/README.md
- https://huggingface.co/mlx-community/sam3-8bit/blob/main/README.md
- https://raw.githubusercontent.com/Blaizzy/mlx-vlm/main/mlx_vlm/models/sam3/README.md
- https://raw.githubusercontent.com/Blaizzy/mlx-vlm/main/requirements.txt
- https://pypi.org/project/mlx-vlm/
- https://pypi.org/project/sam3-mlx/
- https://github.com/ustcwq/sam3
- https://github.com/vietanhdev/samexporter/releases/tag/v0.5.0
- https://huggingface.co/danilobukvic/sam3-text-onnx
- https://huggingface.co/adopd/SAM3.1-segmentation-ADOPD
- https://huggingface.co/Arm/mobile-sam-int8-xnnpack-executorch
- https://github.com/microsoft/FaceSynthetics
- https://microsoft.github.io/DigiFace1M
- Secondary: https://aiproductivity.ai/news/meta-sam-3-1-real-time-video-segmentation/
- Secondary: https://codersera.com/blog/how-to-run-sam-3-locally-2026/amp/

**Law and compliance**
- https://www.hhs.gov/sites/default/files/ocr/privacy/hipaa/understanding/coveredentities/hipaaferpajointguide.pdf (403 for the reviewer; unverified)
- https://archives.gov/files/cui/registry/policy-guidance/registry-documents/2018-cui-notice-2018-01-drafting-agreements.pdf
- https://www.law.cornell.edu/cfr/text/45/164.514
- https://www.law.cornell.edu/cfr/text/16/312.2
- https://studentprivacy.ed.gov/faq/when-photo-or-video-student-education-record-under-ferpa

**Muse app, relay, network**
- https://www.meta.com/help/artificial-intelligence/1687253048996149/
- https://www.meta.com/help/artificial-intelligence/1385290430137537/
- https://platform.muse.ai/docs
- https://dev.meta.ai/docs/muse-code/extending
- https://github.com/facebookincubator/muse-gadget-sdk
- https://raw.githubusercontent.com/facebookincubator/muse-gadget-sdk/main/linux/README.md
- https://community.cloudflare.com/t/python-urllib-gets-1010-on-workers-dev-while-authenticated-node-fetch-works/966872
- https://community.cloudflare.com/t/workers-dev-rejects-python-get-with-error-1010-supported-diagnostic-path/963394
- https://developers.cloudflare.com/changelog/2025-10-31-increased-websocket-message-size-limit
- https://docs.python.org/3/library/urllib.request.html#urllib.request.getproxies
- Secondary: https://parallel.ai/articles/meta-muse-custom-integrations.md
- Secondary: https://saascrmreview.com/how-to-use-meta-muse/
- Secondary: https://www.eesel.ai/pt/blog/meta-muse-para-o-trabalho
- Secondary: https://www.cnx-software.com/2026/10/12/facebook-releases-muse-gadgets-sdk-for-esp32-and-raspberry-pi-linux-based-devices/

**Teacher time and schools**
- https://www.edweek.org/teaching-learning/how-teachers-spend-their-time-a-breakdown/2022/04
- https://www.mckinsey.com/industries/education/our-insights/how-artificial-intelligence-will-impact-k-12-teachers
- https://news.gallup.com/poll/691967/teachers-using-ai-tools-save-hours-week.aspx
- https://www.businesswire.com/news/home/20250326730498/en/A-Third-of-US-Teachers-Considered-Leaving-Education-Due-to-Grading-Workload-Says-New-Research-by-Learnosity
- https://lincs.ed.gov/state-resources/federal-initiatives/teal/guide/feedback
- https://nces.ed.gov/blogs/nces/2022/04/20/default
- Secondary: https://snlwritingnews.blogspot.com/2016/07/keeping-time.html
- Secondary: https://nces.ed.gov/pubs2008/100_largest_0506/tables/table_01.asp (2005-06 data; to be replaced by a current NCES Digest table before any scale figure is quoted)

**Devices and prices**
- https://www.notebookcheck.net/Apple-M4-Max-14-cores-Processor-Benchmarks-and-Specs.920365.0.html
- https://www.techpowerup.com/329957/nvidia-unveils-new-jetson-orin-nano-super-developer-kit
- https://cnx-software.com/2026/07/22/nvidia-increases-the-price-of-jetson-modules-and-devkits-by-up-to-101
- https://github.com/hokwangchoi/jetson-orin-nano-benchmarks
- https://forums.developer.nvidia.com/t/how-to-run-sam3-on-jetson-orin-nx-8g/366188
- https://forums.developer.nvidia.com/t/ai-models-that-run-on-jetson-orin-nano-super-8gb-a-practical-guide/365412
- https://www.tweaktown.com/news/110841/raspberry-pi-hikes-prices-by-up-to-150-tries-to-cushion-the-blow-with-new-raspberry-pi-4-3gb-variant/index.html
- https://www.tomshardware.com/raspberry-pi/component-shortages-drive-raspberry-pi-prices-up-by-up-to-23-percent-escalating-lpddr4-lpddr5-costs-trigger-the-third-price-hike-of-the-year
- https://www.sparkfun.com/raspberry-pi-5-4gb.html
- https://docs.aws.amazon.com/devicefarm/latest/developerguide/custom-test-environment-test-spec.html
- https://docs.aws.amazon.com/devicefarm/latest/developerguide/custom-test-environment-variables.html
- https://docs.aws.amazon.com/devicefarm/latest/developerguide/limits.html
- https://aws.amazon.com/device-farm/pricing/
- Secondary: https://zbotic.in/?p=595022
- Secondary: https://tinyweights.dev/posts/run-llms-raspberry-pi-5/
- Secondary: https://www.dfrobot.com/blog-13498.html
- Secondary: https://specpicks.com/reviews/raspberry-pi-5-local-llm-llama-cpp-tokens-per-second-2026

## Review notes

Every high and medium issue is applied. Where one was changed or partly rejected:

- **"Restart at 7 PM Nov 2."** Moved to 8 PM, so RED-13 runs 6 to 8 PM on the frozen commit before the live restart.
- **"Remove the files through the app's delete path."** There is no file-delete route. The only delete route removes approval history (base/ui_app.py:1385). Step 0 moves the files, clears scans, rebuilds the index and deletes the matching history rows instead.
- **"Download SAM 3.1 only after the Glimmer file is measured."** The intent is kept: SAM never takes your file's room. SAM may still download earlier when df shows room for both, so a late Glimmer does not block SAM-6.
- **"Move GAP-5/6 to Nov 1."** Moved to Nov 2, because Lane B's Nov 1 is full after RED-3 and tag rotation.
- **"Make base IQ1_S a P0 control."** Applied. Base and tuned run one after the other, never loaded together, per the memory rule.
- **OOD set, grading spot-check.** Applied as P1 (SIM-18, SIM-19), because P0 is already over capacity once the usual overrun is counted.
- **DEV-10 as P2.** Kept under Not doing, with the corrected reason.
- **"Muse Connectors on the event page."** The page's navigation lists "Meta AI Connectors" and does not tie them to the hackathon (fetched tonight). It is not cited as a hackathon product.
- **Not from the reviews.**
  - GAP-4 is now P0, because you asked for the tag map under retention.
  - Personas are cut from 7 to 5, with 3 seeds each, to fit the load.
  - MUSE-11 becomes a connector-side lock, so it stays in Lane C's files.
  - MUSE-8 and DEV-3 to DEV-5 drop to P1 to fit the load.