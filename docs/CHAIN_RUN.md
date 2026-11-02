# The chain run

The steps for the owner's $25 end-to-end chain run, which is also act 1 of the video. Written Nov 2, 2026, on branch `tg-chain-runbook` from `e4beadc1` (`tg-edge`), by reading the code, docs/TRAINING.md, docs/BUILD_LOG.md and the live site's public pages. **Nothing in this file has run.** It waits on O2 (docs/EDGE_PLAN.md). Every step says what is known and what isn't; "unverified" means nobody has seen it happen.

**Moved to Muse Glimmer (Nov 2, evening, branch `tg-mo-learn-plans`).** The organizers ruled on Nov 2 (3:57 PM ET, Cerebral Valley Discord; docs/MESSAGING.md, rules section) that Llama does not count as a Meta model, and that every model the project runs must be a Meta model. So the run no longer tunes Llama 3.2 3B. It tunes **Muse Glimmer 30B (r30b), the default base, with `TUNE_ANY_BASE` left off**, on the site's default GPU, and the file you keep is a one-bit IQ1_S GGUF. Costs below are re-estimated from the Meta-models audit and the measured r30b runs. Whether to run it this way is an owner question (O2 was answered for the Llama run).

**The sentence**, typed on https://muse-muse.vercel.app:

> Watch a cold room's controller and an independent probe, flag a tampered or failing reading, and keep answering when the cloud is cut

docs/VIDEO.md's revised shot 1 still has an older, longer sentence. Use this one, and change VIDEO.md to match.

**The goal, on screen:** that sentence becomes a plan, data, a tune of Muse Glimmer 30B, a blind check against the base model, a file you keep (a one-bit GGUF), and an app built around it. The cold room is simulated and every reading is invented by `scripts/dev/drill-bench.py`.

## 1. What the code allows today (read this first)

These change the plan, so they come before the steps.

1. **With `TUNE_ANY_BASE` off, every job trains r30b.** A base in a request is refused (`lib/env.ts`, `tuneAnyBase`). That is what this run wants, so no flag changes. The plan's defaults are 120 steps on `gpu_1x_a100_sxm4` (`TUNE_STEPS`, `TUNE_GPU` in `lib/train/tune/settings.ts`), the same as the measured runs. The old blocker (a folder Start trained r30b whatever base was picked) no longer matters, and `startFolderRun` saves a picked base since Nov 2 anyway.
2. **The site can't keep a GGUF made from a dropped folder.** A folder's rows are saved as the person's own (`PERSON_WRITER`), and `ownerRowsProblem` (`lib/train/store.ts`) keeps them off the Hub, by design. "Make local files" with publish 1 needs the adapter published first (`quantSetup` in `lib/train/launch.ts`, 409 `adapter_not_published`). With publish 0 it runs the checks and the file is gone with the GPU. So the GGUF is made by hand with `scripts/dev/quant-harness.ts` on a rented A10, the way the Nov 1 tuned r30b IQ1_S was made (BUILD_LOG, Nov 1 evening), and copied off before the GPU stops. It is a hand transfer to the board, never a public repo (M9 is dropped).
3. **Glimmer jobs have launched through the site.** The 40 of 40 brief-writer run (A100, 42 minutes, $1.39) and the D8 decision runs (Oct 31 and Nov 1, A100 SXM4) are on the live `/fine-tuning`. A folder-rows Glimmer job, its callbacks and judging through the site are still unverified.
4. **The site's blind check is a Muse Wonder judge**, blind A and B, on the dataset's own held-out rows: about 10% of the 900 (`evalSplit`, at most 100), in the two training layouts. The 100 sealed rows (`eval/drill/sealed.jsonl`, other layouts and rooms) never go to the site. drill-bench scores them by code, outside the site, tuned against base. Both are real checks of different things; say which one a number comes from.
5. **The app reaches the tuned model only through the edge fallback.** A product can reach a tuned adapter only through hosted Glimmer serving; the cold-room app reaches the one-bit file only through the edge fallback, and only if `EDGE_BUILDS` and `EDGE_ENABLED` were on when it was built. That is act 3 (E3a), on a board, and only if Hussam's JSON-schema gate passes (docs/EDGE_PLAN.md, H1). In act 1, shot 5 shows the app being built and checked, and its last sentence stays.
6. **The data is code-written.** Shot 2's line "A Meta model writes the plan and the training data" isn't true for this run. Muse Wonder writes the plan; our script wrote the rows. Say that (section 7).
7. **The one-bit file is weak and slow.** The tuned r30b IQ1_S from Nov 1 had KL 0.94 and 30 of 30 final answers on made-up data; the stock one-bit file gave no valid JSON on Hussam's 40-receipt bench without a schema, at about 4.7 tokens a second on jetson-02. The Q4_K_M (16.9 GB) missed its closeness limit by 0.00045 on that run and was left out. Say "kept answering, slowly", never "as good as the cloud".

## 2. Flags and settings on production

Only from docs and the live site's signed-out pages, read Nov 2. No env file or Vercel value was read. "Unknown" means no doc or public page says.

| Setting | Needed for | State on production | Source |
|---|---|---|---|
| `MAKE_CHAT_ALL` | The Make chat's menu (App, Model, App and model, Dataset) | On | docs/HANDOFF.md "Now"; `/fine-tuning/new` signed out shows "What should Muse make?" and the menu |
| `TUNE_COMPOSER` | Plans, runs, the run room | On | `MAKE_CHAT_ALL` needs it; the page renders |
| `TUNE_FOLDER` | Dropping the drill folder | On | Live page: "Add a folder of data for a model", "Your files go to Meta on a tier where Meta may train on them" |
| `OPEN_TRAIN`, `TUNE_START_CODE` | Visitors only | `OPEN_TRAIN` on (the page offers models signed out); the code unknown | Admins skip the start code (`requireAdminOrAutomation`), so this run needs none. Never type a start code on camera |
| `TUNE_ANY_BASE` | Nothing: this run uses the default r30b | **Off, and keep it off** | Off as built (BUILD_LOG); live `/fine-tuning` shows no base picker |
| `LAMBDA_API_KEY` | Launching the GPU | Rotated Nov 2 (owner to-do 8) | docs/HANDOFF.md |
| `CRON_SECRET`, the sweep | The launch gate (a sweep in the last 15 minutes) | Running: D8 launched on production | docs/BUILD_LOG.md, Oct 31 23:54 |
| `MODEL_API_KEY`, `DAILY_SPEND_CAP_USD` | The plan, the judge | Set; the cap's value unknown. 0 or unset means $100 | docs/HANDOFF.md to-do 9 |
| `TRAIN_JOB_MAX_USD`, `TRAIN_JOB_MAX_MINUTES`, `TRAIN_DAILY_USD`, `TRAIN_MAX_ACTIVE` | The job's caps | Unknown, so read as the defaults: $5, 120 minutes, $20 a day, 1 GPU | docs/TRAINING.md "Limits" |
| `BLOB_READ_WRITE_TOKEN` | The adapter's download on the job page | Unknown | Without it the adapter is only on the region's cache filesystem (step 5) |
| `TUNE_AUTO_PUBLISH`, `HF_TOKEN` | Hub uploads | Auto publish set (BUILD_LOG, owner decision); HF_TOKEN not listed then | Doesn't matter: a folder run never uploads (section 1, point 2) |
| `QUANT_ENABLED`, `QUANT_TARGETS` | Only the optional on-screen check in step 5 | Unknown, likely off | Not needed for the file you keep |
| `BUILDS_ON_CONTRIBUTOR` | The build | On | Live page: "muse-spark-1.3-contributor", "Set by the platform for every build". Label the build "Test model" |
| `EDGE_BUILDS`, `EDGE_ENABLED` | The app's edge fallback and drill | Off | docs/EDGE_PLAN.md. O4 allows a preview only (see O9 below) |
| `STORY_PAGES` | Shot 6 (`/offline`), not this run | Off: `/offline` answered 404 on Nov 2 | Signed-out GET |

Every env change needs a redeploy. After a redeploy that changes `LAMBDA_API_KEY`, wait for the next sweep (every 5 minutes) before pressing Start, or the form blocks with `sweep_not_running`.

## 3. Money

The cap is $25 (O2). Expected spend is about $4.60 to $7.70 (table below), which leaves room for one full retry and still stays under the cap. Re-estimated Nov 2 from the Meta-models audit: the r30b tune is about $1.39 on an A100 (42 to 48 minutes), against the earlier Llama plan's $1 to $2 on the same GPU, and the one-bit file costs about $1.75 on an A10 against $0.40 to $1.30 for the 2 GB Llama file.

| Part | Expected | Hard limit | Source |
|---|---|---|---|
| Make chat: plan draft (Muse Wonder) | $0.01 to $0.03 | The Meta daily cap | docs/TRAINING.md, estimate |
| The 900 rows | $0: rows mode writes nothing | | `startFolderRun` |
| r30b Glimmer tune, A100 SXM4 at $1.99 an hour | $1.39 to $1.86 | The job's $5 (`TRAIN_JOB_MAX_USD`), enforced by the workflow and the sweep | Measured: $1.39 for the 42-minute brief-writer run on an A100 (docs/SUBMISSION.md); $1.86 for 120 steps on an H100 (BUILD_LOG Nov 1, job 1898e46c) |
| Muse Wonder judge, about 90 rows | About $1.40 | The Meta daily cap | $1.54 for 100 on Nov 1 (BUILD_LOG) |
| IQ1_S file and sealed scoring, A10 by hand at $1.29 an hour | $1.75 to $2.60 | **None in code.** Set a 90-minute timer and terminate by hand | BUILD_LOG Nov 1 evening: the tuned r30b quantize job took 29 minutes, the machine 1.36 hours, about $1.75 |
| The build, on Contributor | $0.02 to $1.80 | The Meta daily cap and the build's wall | BUILD_LOG Nov 1 and 2 ($0.019 for a 6-minute build); docs/HANDOFF.md to-do 2 |
| Optional: on-screen "Make local files" with publish 0 | About $1 to $2 (29 minutes of job on an A10) | The job's $5 | Skip unless the footage is wanted |
| Backup: a second r30b tune if the first fails | $1.39 to $1.86 | The job's $5 | As above |

Expected: about $4.60 to $7.70 with no retry; about $6 to $9.50 with one retried tune. Worst case at every hard limit (two $5 jobs, two 90-minute A10s, the judge twice, a build) is about $18, inside the $25.

Keeping it under $25:
- One GPU job at a time (`TRAIN_MAX_ACTIVE` 1). No dry run first: a dry run's fake answers are still judged on Muse Wonder (about $1.40 for nothing).
- The hand-launched A10 has no platform cap. Name it `chain-quant-1`, never `mm-train-...` (the sweep terminates any `mm-train-*` instance no job claims). Terminate it from the Lambda console the moment the file is copied off, then check the instance list is empty.
- Stop: the job page's Stop job, or the sweep within 5 minutes.
- The cache filesystem bills by the GB each month outside every cap (docs/TRAINING.md "Model cache").

## 4. Time

From docs/BUILD_LOG.md measurements; the rest are estimates.

| Step | Measured or estimated | Source |
|---|---|---|
| Plan draft | Seconds (one call) | Unmeasured on Wonder |
| Dataset from the folder | At once | No writing |
| r30b tune on the site | 42 to 48 minutes on an A100 at the default 120 steps (the brief-writer and D8 runs). On an H100 the Nov 1 run took 26 minutes: base answers 319 s, training 971 s for 120 steps, with other jobs sharing the GPU | `/fine-tuning`; BUILD_LOG Nov 1, job 1898e46c |
| Judging | Minutes, 4 at once | Unmeasured |
| IQ1_S on the A10 | Setup 0.6, merge 3.8, convert 3.1, Q8_0 and Q4_K_M 2.7, matrix and IQ1_S 12.9, checks 5.0 minutes: 29 minutes of job, plus boot and copying | BUILD_LOG Nov 1 evening; `docs/log/quant-run-tuned-2026-11-01/recipe-result.json` |
| Sealed scoring, tuned and base | Unmeasured for one-bit Glimmer on an A10 GPU. r30b Q4_K_M made 49 tokens a second on an A100 (BUILD_LOG Nov 1), so 100 short verdicts each should take minutes, not hours | Estimate |
| The build | 6 to 10 minutes for a small build on Contributor; a full build can take up to its 120-minute wall | BUILD_LOG Oct 31, Nov 1 and Nov 2 |

Plan for about 2.5 to 3.5 hours of wall time. Start Tue 8 AM so it is done by 3 PM (docs/EDGE_PLAN.md, shared clock).

## 5. Who does what

**The owner, by hand** (Claude can't sign in, spend, SSH or record a screen):
- Answer O2 for the r30b run, and O9 below. Check `DAILY_SPEND_CAP_USD` is a number you accept. Leave `TUNE_ANY_BASE` off.
- Sign in on production as an admin, in a browser at 1440x900, light theme, 100% zoom, a clean profile. Record the screen.
- Press Start in the Make chat and the tune.
- Launch, SSH into, and terminate the A10 for step 5. Copy the file off.

**Claude can run, at $0 and with no model, network spend or SSH:**
- `python3 -I scripts/dev/drill-bench.py make --out eval/drill`, then check `shasum -a 256 eval/drill/sealed.jsonl` is `52b23493d1f832aebf717829469091ded8029b77fc82b517544746c94346f3dd`.
- `npx tsx --test --experimental-test-module-mocks scripts/dev/drill-bench.test.ts`: the folder keeps all 900 rows and drops none.
- Make the A10 bundle with `scripts/dev/quant-harness.ts` (it writes files only, reads no env), and the `train.json` and `dev.json` it takes.
- Score answer files with `drill-bench.py score`, write the docs/BUILD_LOG.md and docs/KNOWLEDGE_RUN_LOG.md entries from the results, and draft the E2 card from them.
- Signed-out GETs of the live site afterwards (`node scripts/judge-check.mjs`).

**Hussam:** the board half (H1 to H5). The tuned file reaches a board only through him (H4), and only if his H1 gate passed.

## 6. Before the day

1. O2 answered yes for the r30b run, the Lambda key rotated (done Nov 2), `TUNE_ANY_BASE` still off, one sweep run since the last redeploy.
2. Claude makes the drill files and runs the drill-bench test (section 5). The folder to drop is `eval/drill/folder/`: 9 files, `cold-room-drill-01.jsonl` to `-09.jsonl`, 100 rows each.
3. Claude makes `dev.json` (the 50 kept-aside rows as a JSON array of `{prompt, reference}`) and `train.json` (the 900 rows of `train.jsonl` as a JSON array) in a scratch folder, for step 5's checks. Neither file is the sealed set.
4. A dry pass of the menu signed in, without pressing Start, to see whether the Dataset choice with a folder goes straight to the plan card (unverified: the intent call may run first).
5. Free disk on the laptop: about 10 GB on Nov 2. The IQ1_S file is 6.53 GB and the laptop keeps 6 GB free, so it doesn't land on the laptop. Copy it from the A10 to the machine that hands it to Hussam (unverified which), and keep only its sha256 in the repo. Never load it on the laptop: Glimmer never runs there.
6. No other GPU job running on the site, and no other Lambda instance named `mm-train-*`.

## 7. The run

Labels for every frame: corner "Simulated cold room. Test model." on anything built on Contributor; "Sped up" on sped-up footage. Never in frame: an admin job page's right panel (it shows the GPU's IP), the Vercel, Lambda or AWS consoles, `.env.local`, a terminal with a key, the fleet console, an ngrok domain or a board address.

### Step 1. The sentence, as an app (shot 1, and the start of shot 5)

- **Do:** on the Make page, menu on Auto (or App), type the sentence, send. The sentence has none of the words that make the box ask about a model (`MODEL_WORDS` in `lib/make/intent.ts`), so it goes straight on as a build, with no model call.
- **If O9 is yes:** this build is made with `EDGE_BUILDS` and `EDGE_ENABLED` on, so it gets the fallback helper and, if the brief picks the edge target, the four simulated drills after verify. Whether the brief picks it from this sentence is unverified.
- **Record:** typing, sending, the build room starting. Keep recording the build room (sped up) for shot 5.
- **Takes:** 6 to 10 minutes for a small build, longer for a full one. Costs cents on Contributor.
- **If it fails:** the build room says why. Send again once. If it fails twice, shot 5 uses its fallback in docs/VIDEO.md (a recorded Nov 1 build, labeled "Test model, made-up data").

### Step 2. The same sentence, as data (shot 2)

- **Do:** new message, menu "Dataset", the same sentence, drop `eval/drill/folder/`. Confirm the notice. The review should say 9 files used, 900 rows, 0 dropped, 0 skipped. The plan card drafts a name and tagline on Muse Wonder. Press Start.
- **What happens:** with "Dataset", `settings.datasetOnly` is sent, so `tuneRun` never starts and no GPU launches. The rows are saved as they are (`createImportedDataset`), about 90 are held out, and the room shows the first examples with "Tune a model on this". Note the run's id from the room's address (`/fine-tuning/runs/<id>`): it is the dataset id.
- **Record:** the drop, the review (files used, sample rows), the plan card, then the room's first examples.
- **Say instead of shot 2's line:** "Muse Wonder writes the plan. The data is 900 invented log windows our own script wrote, so a check in code can score the answers." Card: "Simulated cold room. Invented readings, written by code, not a model."
- **Takes:** a minute. Costs one plan call.
- **If it fails:** a review that drops rows means the files changed: remake them and rerun the test. A 429 `rate_limited` on plans is 20 an hour per caller: wait. If the Dataset choice won't take the folder, open `/fine-tuning/new` (it now shows the Make page for a model) and try there.

### Step 3. The tune (shot 3, first half)

- **Do:** in the room, press "Tune a model on this", which trains r30b with the plan's defaults. Or, to set the limits by hand, follow "Use the full form" (`/fine-tuning?dataset=<id>#new-job`). In the New job card:
  - Recipe: the LoRA recipe (`glimmer-lora`), picked with the dataset.
  - Base: none to pick. With `TUNE_ANY_BASE` off the job trains r30b (`OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit`, the knowledge run's base). Log the commit the job shows.
  - Training steps 120 (the default and the measured number). LoRA rank 16, learning rate 0.0002, student prompt "short": the defaults.
  - GPU: "1x A100 SXM4 (40 GB)", the default. Limits: 120 minutes, $5.
  - The card's time line should fit (about 45 minutes against 120). Press Start.
- **What happens:** the GPU trains on the dataset's training rows, then the base and the tuned model answer the held-out rows under the one-line system message "You are <the plan's name>".
- **Record:** the card, Start, then progress, sped up. Film progress from the job's event log or the run room, never the right panel with the IP.
- **Takes:** 42 to 48 minutes, from the measured A100 runs. Costs about $1.39, at most $5.
- **If it fails:**
  - Blocked before Start: the card says why. `sweep_not_running`: wait 5 minutes. `no_capacity`: pick the H100 SXM5 (the measured $1.86 run's GPU, the same $5 cap) or wait.
  - Failed on the GPU: read the event log's last lines and log them. One retry after a fix you understand. Otherwise go to section 8.

### Step 4. The site's blind check (shot 3, second half)

- **What happens:** once the GPU is shut down, Muse Wonder judges each held-out row blind (base is A on even rows, B on odd), and the job gets its summary: wins, ties, average scores, judging cost. The verdict rule (`evalVerdict`): at least 8 judged, more tuned wins than base wins, tuned winning at least half, tuned's average a point or more above base's.
- **Record:** signed out, the job's public result page `/fine-tuning/<job id>` (it never shows the IP or key): the summary strip, then two or three items with prompt, base answer, tuned answer and verdict. Overlay Meta's line: "Compare your fine-tuned model against the base model on a held-out test set before deploying." Check first that the public page shows this job (unverified for a folder dataset made by an admin).
- **Say:** "A judge compared it with the base Glimmer, blind, on N rows it never trained on. Tuned won M." Fill N and M from the job only.
- **Takes:** minutes, unmeasured. About $1.40.
- **If it fails:** an unjudged summary has a note (spend cap, nothing to judge). Judging doesn't rerun by itself, and nothing on the page restarts it. Shot 3 then uses the sealed score (step 6) as the only check, and says so.

### Step 5. A file you keep (shot 4)

The site can't keep this file (section 1, point 2), so it is made by hand with the same recipe code the site runs.

1. **The adapter.** On the job page, the artifact `glimmer-lora-<first 8 of the job id>.tar.gz` (about 400 MB for an r30b adapter; 419 MB on Nov 1) if storage was on. Otherwise it is on the region's cache filesystem at `models/<job id>/` (`muse-muse-cache-<region>`, the region on the job page).
2. **The bundle**, made by Claude on the laptop, $0:

   ```
   npx tsx scripts/dev/quant-harness.ts <out> '{"adapterJobId":"<job id>","levels":"IQ1_S,Q4_K_M","slug":"cold-room-watch","trainChannel":<the job's own>,"publish":0}' "<the dataset's title>" <train.json> <dev.json> 90 /opt/muse-cache
   ```

   The params are the ones `read_quant_params` in `lib/train/recipes/quantize.ts` takes. With no `quantBase` the job merges into r30b, as on Nov 1. `levels` must include Q4_K_M, the build the template and channel checks run on; it is kept only if it passes its closeness limit. `trainChannel` is the job's own value from its params. The title must be the dataset's own, since the files carry its system line.
3. **The A10**, by the owner: `gpu_1x_a10`, image `lambda-stack-24-04` (the binaries need glibc 2.38, `QUANT_IMAGE_FAMILY`), named `chain-quant-1`, in the cache's region with the filesystem attached if the adapter is only there. Put the adapter folder at `/opt/muse-cache/models/<job id>/`. Copy the bundle over, start `python3 stub.py` in the background, then `python3 runner.py job.json`. The exact commands the Nov 1 runs used aren't in the repo, so this is unverified.
4. **The file:** `muse-glimmer-30b-cold-room-watch-IQ1_S.gguf` (`FILE_STEM` plus the slug), about 6.53 GB, in the job's `out/` folder under its work directory, and the Q4_K_M (about 16.9 GB) only if it passed. The recipe deletes builds that fail, so hard-link each output as the Nov 1 run did. Bytes and sha256 are in the done event in `events.jsonl`. Copy the IQ1_S off (section 6, point 5) and check the sha256 matches before terminating.
5. **Then step 6 on the same machine, then terminate it.**

- **Record:** the file name and size in a terminal (`ls -l` and `shasum -a 256`), nothing else on screen. Overlay Meta's line: "you own the weights, the runtime, and the data". Lower third: "Made with the platform's own quantize recipe on a rented GPU, started by hand."
- **Takes:** about 40 to 60 minutes with boot and copying. $1.75 to $2.60.
- **If it fails:** the job's last log line names the stage. The Nov 1 fixes cover the glibc image, the 4-bit base, shard hashes and the converter. One retry; then shot 4 uses its fallback card (the Nov 1 tuned r30b IQ1_S, "Test harness, made-up data").
- **Optional, on screen only:** with `QUANT_ENABLED` and `QUANT_TARGETS` on, "Make local files" on the job page with publish 0 runs the same checks on the site, and the card says the file wasn't kept. Never let that shot suggest the site kept it.

### Step 6. The sealed check (E2)

On the A10 from step 5, before it is terminated. Copy over `scripts/dev/drill-bench.py` and `eval/drill/sealed.jsonl` only.

```
llama-server -m <the tuned IQ1_S file> --port 8080 --jinja --reasoning-format none
python3 drill-bench.py ask --heldout sealed.jsonl --url http://127.0.0.1:8080/v1 --model tuned --schema --max-tokens 400 --label "Muse Glimmer 30B tuned, one-bit (IQ1_S)" --out tuned.jsonl
```

Then the same with the stock r30b IQ1_S from `OfflineBase/Muse-Glimmer-30B-2026-Knowledge-GGUF`, its sha256 checked and its file name logged (jetson-02 serves that repo's 5.75 GB `io-lowest` build), as `--label "Muse Glimmer 30B base, one-bit (IQ1_S)"`. Both at temperature 0, with the `json_schema` response format (`--schema`, which llama.cpp enforces as a grammar), under drill-bench's own system line, which states the rules, so base gets a fair chance. The tuned model trained under the one-line system message, so this is not the prompt it trained with; say so in the log.

- Glimmer under llama-server also needs the reasoning-off chat template that jetson-02 uses (docs/HANDOFF.md, fleet changes); without it chat can fail with a "peg-native format" 500. Whether the template and a `llama-server` binary are still on the machine after the quantize job is unverified; if not, use llama.cpp's b11669 release.
- **No A10 by then:** Hussam runs the same two `ask` commands on jetson-02 (M10 for base, M11 for tuned), only if his H1 gate passed. That is free and much slower (about 4.7 tokens a second), and the number is then a board number.
- **Claude** scores the copied answer files with `drill-bench.py score` and writes the log entries.
- **Record:** nothing live. E2 is a card from docs/BUILD_LOG.md: "Muse Glimmer 30B, tuned, one-bit." Tuned and base all-right rates and the hard rule (trust_controller false on the 12 mismatch rows), "100 invented items it never saw. Scored by code, not a judge." If tuned didn't beat base, show both numbers and say so.
- **Takes:** unmeasured for one-bit Glimmer on an A10; plan on 15 to 30 minutes. Inside step 5's cost and its 90-minute timer.

### Step 7. The app (shot 5)

- **Do:** back to step 1's build room. It shows the checks: typecheck, build, smoke test, the judge's screenshots, and with O9 the simulated outage drill.
- **Record:** the checks turning, sped up and labeled "Sped up. Real build." End on the live product reading the demo CSV (`eval/drill/demo-spoofed-controller.csv`) if it takes a file.
- **Say:** shot 5's lines as written, keeping "The app answering with its own tuned model hasn't run yet." That is E3a's job, on the board.
- **Then:** for the board, M7 downloads `/p/<slug>/code/source.zip`, and `scripts/edge/build-arm64.sh` packs it (docs/EDGE_DEMO.md). That only helps if the build has the edge files (O9, or M7's own preview build).

### Step 8. Log it

Claude writes one docs/BUILD_LOG.md entry for the whole run (ids, times, costs from the job pages and the Lambda price, every refusal and retry), the training and quantize lines in docs/KNOWLEDGE_RUN_LOG.md (per the repo rule), and updates docs/EDGE_PLAN.md (M8 to "run") and docs/HANDOFF.md (to-do 2). Screenshots in `docs/log/shots/2026-11-03/`. The owner terminates the A10 and confirms the Lambda instance list is empty.

## 8. If a step fails: the backups

Use the highest one that has run by Tue 3 PM.

1. **The full run above.**
2. **A second r30b tune on the site**, the same steps 3 and 4, about $1.39, inside the $25. Then step 5 and step 6.
3. **The harness tune on an A10 is no longer a separate backup:** the Nov 1 harness backup trained Llama, and r30b needs the A100 or H100 the site already uses (22.44 GB peak on an H100, BUILD_LOG Nov 1), so backup 2 covers it. **The Kaggle notebook is retired:** it tunes Llama, and Glimmer 30B doesn't fit a free 16 GB T4 (notebooks/README.md).
4. **No tune by Tue 3 PM.** Shots 2 to 4 use their fallback cards in docs/VIDEO.md, E2 is dropped and its time goes to E3a, and the board model is the stock one-bit Glimmer, labeled "Answered on jetson-02, Muse Glimmer 30B one-bit (IQ1_S)" with no "tuned" (docs/EDGE_PLAN.md, ladder level 3), or the no-model fallback if H1 failed (level 4).

## 9. Decisions and fixes for the owner

- **O2** ($25): the run, now on r30b with `TUNE_ANY_BASE` off. Answered yes for the Llama run; the owner confirms it for r30b.
- **O9** ($0, new): turn `EDGE_BUILDS` and `EDGE_ENABLED` on in production for step 1's build only, then off (two redeploys)? While on, every new build gets the edge files. If no, step 1's app is a plain cloud app, and the edge version of the app comes from M7 on a preview (O4).
- **F1** (a small code unit, about 1 hour with its test): let "App and model" with the folder start the build and the r30b tune from one Start, so steps 1 to 3 become one and the pair shows in the build room. Merged and deployed before the run, or not at all.
- **F2** (copy only, now moot): the picker's local-files note for a Llama base. With `TUNE_ANY_BASE` off there is no picker.
- **F3** (later): a way for a folder run's GGUF to be kept on the site. Today the owner-rows rule stops it, on purpose.

## 10. What may be said after it runs

From docs/MESSAGING.md and the marks in docs/STORY.md. Change a mark in `lib/story/flow.ts` and docs/STORY.md only from the log entry.

- After step 3 and 4: "Muse Muse tuned Muse Glimmer 30B on a rented GPU, started from the site, and a judge compared it with the base model blind on N held-out rows." Numbers from the job.
- After step 6: tuned against base on 100 sealed invented items, one-bit files, scored by code. Numbers from the log.
- After step 5: "a 6.5 GB one-bit file you keep", and that it was made by hand with the platform's recipe, not by the site.
- Never: that the whole chain ran end to end through the site (steps 5 and 6 are by hand), that a Meta model wrote this data, that the app answered with its tuned model (until E3a), that one-bit Glimmer is as good as the cloud, "works offline" in general, "private" or "on-device" for any board answer, anything about real freezers or food safety, or that anything is "attack-proof". Never Llama, "Built with Llama" or any non-Meta model as part of the run. Keep "is built so" for the rest.

## 11. Unverified, in one list

- Whether Blob storage and the caps are set as assumed on production.
- That the Dataset menu takes a folder and goes to the plan card as described.
- A folder-rows r30b job's launch, callback and judging through the site, and its real time and cost.
- That "Tune a model on this" uses the plan's defaults (120 steps, A100 SXM4).
- That the public result page shows an admin's folder-dataset job.
- The exact commands to start the bundle on a hand-launched A10, and where the GGUF, the chat template and `llama-server` land on it.
- One-bit Glimmer's speed and score on the A10 under `--schema`.
- Whether a 6.53 GB tuned IQ1_S fits jetson-02: its disk is 94% full (25.4 of 27 GB, about 1.6 GB free, fleet alert Nov 2), so not next to the 5.75 GB stock file, and about 450 MB of memory is free with the stock file loaded.
- That the brief picks the edge target from this sentence, with O9 on.
- Every time in section 4 not marked measured.
