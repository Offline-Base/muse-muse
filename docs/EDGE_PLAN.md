# The edge plan

The living plan for the edge track. Written Mon Nov 2, 2026, afternoon ET, on branch tg-edge-copy, from the judge panel's merged plan. Updated Nov 2 evening on tg-submission-fields: unit status from what is built on `e4beadc1` (branch tg-edge), and the owner's answers to O1 to O8. Change a unit's status here when it changes; history goes in docs/BUILD_LOG.md.

**Why now.** On Nov 2 supermarkets across Europe reported suspected freezer hacks, and a DC substation event cut power downtown (docs/MESSAGING.md, "Edge facts, Nov 2": use only the rows marked Checked). The owner wants the edge and defense story as a headline beside frontier: defending infrastructure, and being ready for any scenario, including the day the cloud is out of reach or a controller can't be trusted. Nothing here says those events were attacks, or that this app would have stopped one.

**The scenario.** A simulated cold room. A watcher app reads a controller, an independent probe, the door, defrost, power and cloud status, and is built so it keeps answering on a Jetson when the cloud is cut. All data is invented. It gives no food-safety advice and says nothing about real freezers.

**One-line story.** "One sentence becomes a cold-room watcher: Muse Muse builds it on Meta's cloud models, tunes a Llama 3.2 3B for it, and the same app keeps answering on a Jetson with every cable out." Until M12 has run, that line is said as "is built so".

**Flags.** Everything stays off by default. `EDGE_ENABLED` adds the edge target to the brief. `EDGE_BUILDS` writes the fallback files into builds. With both off, behavior, prompts, goldens and stored data are exactly as today.

**Branch.** Code units land on `tg-edge` off `adfcc7d4`; `e4beadc1` merges main with tg-edge-runtime (M1, M3, M6), the drill bench (M2, M14's first half), tg-edge-target (M4, M5) and tg-edge-copy (M13). Not merged to main yet. Cut order: 1 goes first, "keep" is never cut.

## Units

Status is one of: **not started**, **built** (code or docs exist, tests pass, nothing real has run), **run** (it ran for real, with a log entry), **dropped**. As of `e4beadc1`, M1 to M6, M13 and the `MEASURED` half of M14 are built; nothing below has run.

| id | What | Who | Hours | $ | Depends on | Proves | Cut | Status |
|---|---|---|---|---|---|---|---|---|
| M1 | Cloud-to-edge fallback helper. `template/lib/meta/edge.ts`: `edgeClient()` reads EDGE_URL, EDGE_MODEL, EDGE_API_KEY (the `glimmer()` pattern, never `gatewayEnv()`). `respondJsonOrEdge()` tries the cloud with a 10 s timeout, then the edge model through `chat.completions` with `json_schema` and zod. It returns `by` plus a fixed label. `EDGE_FIRST=1` flips the order. A plain message if both are down. No `enable_thinking` with a schema. Skill in `.agents/skills/muse-edge/SKILL.md`. Shipped through `nativeExtraFiles` extraFiles behind `EDGE_BUILDS` | agent | 5 | 0 | none | Unit tests, one per failure type | keep | built, not run (`a4e191b1`; `5c679d87` stopped it falling back around a cloud 4xx). Unit tests on a fake edge server |
| M2 | Drill data and scorer. `scripts/dev/drill-bench.py` make, ask, score (the receipt-bench pattern). Invented rows: setpoint, controller, independent probe, door, defrost, power, cloud. Output `{status, trust_controller, likely_cause, actions[], escalate}`. Cases: normal, door open, defrost stuck or setpoint pushed toward 50 C, controller and probe disagree, probe dropout, power-loss gap in the log, cloud down. 900 train and 100 sealed held-out rows in `train_model` format, plus 2 demo CSVs | agent | 3 | 0 | none | A rights-clean set (written by code, no Terms 10.1(ix) question) with an objective score and a "never trust a tampered reading" rule | 5 (4 cases, 300 rows) | built, not run (`e81e6f66`, `33c9c140`). 900 train, 50 kept-aside and 100 sealed held-out rows (`eval/drill/sealed.jsonl`, sha256 pinned), plus 2 demo CSVs. `ask` tested only against a local fake |
| M3 | Outage drill kit on the laptop. `scripts/edge-fake.mjs` gives schema-valid replies and has refuse, hang, garbage and tamper modes, logging to `test-results/caps/edge.json`. A blackhole gateway and `scripts/caps/edge.mjs`. Four drills: cloud refused, cloud hangs (answers in about 12 s), both down (a plain message, no console error), tampered reply rejected. Runs through `MUSEMUSE_BASE_URL` | agent | 5 | 0 | M1 | Simulated drills pass | keep (the tamper drill goes last) | built, not run (`a4e191b1`, `5c679d87`). The four drills pass on loopback against a test product, with a fake model |
| M4 | Edge target. `"edge"` in `TARGETS` (`lib/brief/schema.ts`) behind `EDGE_ENABLED`, a `TARGET_GUIDE` entry (`lib/native/targets.ts`), `applyTargets` limits taken from selfhost `platformOnly`, a `judgeInstructions` line, and `output: "standalone"` when edge is listed. Flags-off goldens unchanged | agent | 2.5 | 0 | none | Edge is a choice in the plan, not a hand edit | 3 | built, not run (`193a1c30`). Flags-off goldens unchanged |
| M5 | A drill inside every edge build. A step after verify in `lib/pipeline/build-steps.ts`: a second `next start` on loopback with GATEWAY_URL at the blackhole and EDGE_URL at the fake. M3's files go in as extraFiles, so no new builder snapshot. No Meta calls | agent | 3 | 0 | M3, M4 | Every edge build is drilled before it ships | 2 | built, not run (`193a1c30`). Unit-tested with the sandbox faked; no real edge build has drilled yet |
| M6 | Board run kit. `docs/EDGE_DEMO.md` plus a script that builds Next standalone in a linux/arm64 Docker container on the Mac. Env: `EDGE_URL=http://127.0.0.1:11435/v1`, `EDGE_FIRST=1`, GATEWAY_URL optional. The offline `KitMode` waits until after Nov 4 | agent | 2.5 | 0 | M1 | Nothing until M12 | 4 | built, not run (`a4e191b1`). `build-arm64.sh` checked with `bash -n` only; the Docker build hasn't run |
| M7 | One real Muse Muse edge build. Flags on for a preview only. The cold-room sentence on muse-spark-1.3-contributor. Download `/p/<slug>/code/source.zip`, run M3 on it, build it with M6 | agent 2 h, Ethan 0.5 h | 2 | 2 (Contributor, inside the $20 cap) | M1, M3, M4, M5, O4 (yes) | Muse Muse wrote the fallback itself, and its drills ran in a real sandbox | keep (fix the skill once, then hand-patch and label it) | not started. Unblocked: O4 is yes |
| M8 | Scenario tune. Preferred: to-do 2's chain run uses the cold-room sentence and M2's rows through `TUNE_FOLDER`. Backup (O3, changed Nov 2): a free Kaggle notebook, `notebooks/edge-tune-kaggle.ipynb` (built and reviewed, not run on a GPU), tunes unsloth/Llama-3.2-3B-Instruct-bnb-4bit on the same rows and makes a Q4_K_M, in place of the $10 harness tune on a Lambda A10. Not run. The held-out set is scored by drill-bench, tuned against base, no Wonder judge. Logged in docs/BUILD_LOG.md and docs/KNOWLEDGE_RUN_LOG.md | agent | 3 wall | 0 extra (inside the $25); the Kaggle backup is $0 | M2, O2 (yes) or O3 (yes), the rotated Lambda key (done Nov 2) | Tuned against base lift, on a rented GPU (or a free notebook) | 6 (stock model, labeled "base") | not started. Unblocked: O2 and O3 are yes. docs/CHAIN_RUN.md has the steps: the site trains and blind-checks the Llama tune, and the GGUF comes from the notebook or `quant-harness.ts`, since the site can't keep a GGUF made from folder rows. The bug that trained Glimmer for a folder run whatever base was picked is fixed in `startFolderRun` (Nov 2) |
| M9 | Publish the GGUF as `OfflineBase/Llama-3.2-3B-ColdRoom-Watch-GGUF`, with LICENSE, USE_POLICY, "Built with Llama" and a limits card. Uploaded by hand (the proven path) | Ethan | 0.5 | 0 | M8, O5 (yes) | The file can be pulled | with M8 | not started. O5 is yes |
| M10 | Stock Llama on a board, benched. H1, then drill-bench ask at temperature 0 through the gateway. Contributor and Bolt (labeled non-Meta) as comparison rows. Results in `docs/log/bench/2026-11-03/` | Hussam 1.5 h, agent 1 h | 2.5 | cents | M2, H1, H2 | The first Llama 3.2 3B on a board: speed and base score. (Hussam's PR #67 reports a Llama 3.2 1B on jetson-04, so this is no longer the first Meta model on a board once #67 is logged.) | keep | not started |
| M11 | The tuned file on the board (H4) | Hussam | 1 | 0 | M9, M10 | Tuned score on the board | 6 | not started |
| M12 | The cut, on camera (H3 and H5) | Hussam 3 h, Ethan 0.5 h | 3.5 | 0 | M6, M7, M10, O1 (yes), O6 (yes) | One board kept answering with its network out | keep (see the fallback ladder) | not started. O1 and O6 are yes |
| M13 | Copy, claims and log. The edge act in docs/VIDEO.md, edge facts and Don't-say lines in docs/MESSAGING.md, this plan, the to-dos in docs/HANDOFF.md. docs/STORY.md's "On your own hardware" mark moves only after M12. `lib/__tests__/reach-claims.test.ts` stays green. One docs/BUILD_LOG.md entry per unit | agent | 2 | 0 | runs | Copy matches the runs | keep | built (`1fc2a029`, merged in `e4beadc1`; the submission fields in docs/SUBMISSION.md on tg-submission-fields). Marks wait for the runs |
| M14 | Code matches the evidence. Add Llama 3.2 3B to `MEASURED` (`lib/train/bases.ts`, citing docs/BUILD_LOG.md lines 1668 to 1681). Swap `deviceModelTarget` after M10 if O7 is yes | agent | 1 | 0 | M10 | Defaults match the measurements | 1 | `MEASURED` half built (`e81e6f66`, `33c9c140`: unsloth/Llama-3.2-3B-Instruct-bnb-4bit counts as measured). `deviceModelTarget` half dropped: O7 is no |

**Done so far** (no spend, no decision, no Hussam): M1 to M6, M13 and the `MEASURED` part of M14, all built on tg-edge, merged at `e4beadc1`. Tests ran only for the files each agent touched.

**Next:** merge tg-edge into main (owner or Hussam), then M7 on a preview (O4), the chain run (O2) with M8, and Hussam's H1 to H5.

## Owner decisions

Each was a yes or no; dollar amounts are the most it can cost. The owner answered all eight on Nov 2. Nothing spends or turns a flag on until the unit that needs it starts, and then only inside these caps.

| id | Question | $ | Unblocks | Answer |
|---|---|---|---|---|
| O1 | Reverse the Oct 31 line "No Jetson or fleet endpoint in the Nov 4 demo" (docs/BUILD_LOG.md, Oct 31, 16:20) for an edge act, keeping the house-machine Glimmer shot? | $0 | The edge act in docs/VIDEO.md, M12 | **Yes** (Nov 2). The edge act goes in the video, and the house-machine Glimmer shot stays |
| O2 | Run to-do 2's chain run on the cold-room sentence, training on M2's code-written rows, finished by Tue 3 PM, with a rotated Lambda key in place first (to-do 8)? | $25 (to-do 2's existing Lambda estimate) | M8 preferred path, Act 1 footage | **Yes**, $25 (Nov 2). The Lambda key was rotated Nov 2 |
| O3 | If the chain-run tune misses Tue 3 PM, run the harness tune on an A10 as a backup? | $10 cap | M8 backup path | **Yes, changed** (Nov 2): the backup is a free Kaggle notebook on branch tg-kaggle-tune instead of the $10 A10 tune. $0 |
| O4 | Turn on `EDGE_BUILDS` and `EDGE_ENABLED` on a preview, not production, for 2 to 3 test builds? | $5, from the $20 Contributor cap | M7 | **Yes**, $5 (Nov 2). Preview only, never production |
| O5 | Create the public Hugging Face repo `OfflineBase/Llama-3.2-3B-ColdRoom-Watch-GGUF`? | $0 | M9, M11 | **Yes** (Nov 2). Create it when M8 has a file worth publishing |
| O6 | Approve the video re-cut: Act 2 from 33 s to about 20 s, shots 10 and 11 become an edge act of about 30 s, the Glimmer shot stays at about 5 s (docs/VIDEO.md, "Proposed revision: the edge act")? | $0 | The edge act | **Yes** (Nov 2). The edge act in docs/VIDEO.md is approved |
| O7 | After M10, point `deviceModelTarget("jetson_orin_nano")` at Llama 3.2 3B Q4_K_M instead of one-bit Glimmer, with flags still off? | $0 | M14 second half | **No** (Nov 2). `deviceModelTarget` stays as it is; M14's second half is dropped |
| O8 | Allow fallback level 2, which pulls the house uplink and takes jetson-05's tunnel and remote fleet access down during the take? Hussam must agree too | $0 | Ladder level 2 | **Only if Hussam agrees** (Nov 2). Until Hussam says yes, ladder level 2 is off |

## Hussam's asks

The boards are Hussam's. Nobody else changes them, and nobody SSHes from the laptop.

**H1. Tonight (Mon), about 1.5 h. Drill board and stock Llama.**
1. Say what the "Musetesthussamshouse" exec jobs did on jetson-04. PR #67's "What ran on jetson-04" may already answer it; confirm.
2. Pick the drill board: jetson-04, or jetson-03 with Bolt unloaded. Never jetson-02 or jetson-05.
3. Install a public Llama-3.2-3B-Instruct Q4_K_M with `gguf-serve.sh --model-url`, and check its sha256.
4. Take the board out of maintenance.
5. Report tokens a second, memory in use and time to first token.
6. If it freezes the board once, stop and say so.

**H2. About 0.5 h. A key for the bench.**
1. Make a `jik_` key with `cloud_daily_limit` 0.
2. No `combo/` models and no `/v1/route` on it.
3. Hand it over without pasting it in chat, a doc or a commit.

**H3. Tue morning, about 1 h. The product on the board.**
1. Install Node 20 on the drill board.
2. Confirm the USB-C device-link address (probably 192.168.55.1).
3. Run M7's arm64 build there with EDGE_URL on loopback.
4. Check free memory with both the product and the model running.

**H4. Tue 3 to 5 PM, about 1 h. The tuned file on the board.**
1. Install the tuned file with `pull_model hf.co/...` (never tried) or `gguf-serve.sh`.
2. Rerun the held-out set.
3. Report the result either way.

**H5. Tue 7 to 9 PM, about 2 h. The take.**
1. Two rehearsals, then one take.
2. Board Ethernet and Wi-Fi out, laptop Wi-Fi off, `api.meta.ai` failing in a terminal, 5 drills live.
3. No addresses, ngrok domain or console in frame.
4. No power cuts. Power loss stays a case in the data only.

## Shared clock

At most 3 heavy jobs at once: Lambda, one sandbox build, one board.

| When (ET) | What |
|---|---|
| Mon evening | Frontier judge-path cleanup, alongside H1 and M10 |
| Tue 8 AM to 3 PM | Chain run (O2), M7 build, H3 |
| Tue 3 to 7 PM | M8 backup if needed, M9, H4 |
| Tue 7 to 9 PM | H5. Hard cut at 9 PM |
| Wed morning | Copy and marks from the log only, edit, submit by noon. No new runs |

- The frontier chain run wins every conflict over Ethan's time or the Lambda window.
- The laptop runs only Node, the Docker build and fakes. No model runs on it.

## Fallback ladder

Use the highest level that has run by Tue 7 PM.

1. The tuned Llama, with the product and the model both on the board, reached over USB-C. The house uplink and jetson-05 aren't touched.
2. The product on the house machine through `jetson-05.local:8080/admin/v1`, with the uplink pulled. Only if Hussam agrees (O8); until then, skip this level.
3. Either of those with the stock model, labeled "base".
4. No Llama on a board by Tue 7 PM: shot 10 as written, plus a "Simulated outage" card from M3.

## When each claim may be said

| Claim | Said only after | Until then |
|---|---|---|
| "Every edge build runs a simulated outage drill" | M5 is built and one edge build has shown the drill in its log | "Edge builds are built so they run a simulated outage drill" |
| Speed and score on a named board, over 100 invented items | M10 (base) or M11 (tuned), with results in `docs/log/bench/` | Nothing about speed or score on a board |
| Tuned against base on the held-out set | M8, logged in docs/BUILD_LOG.md and docs/KNOWLEDGE_RUN_LOG.md | Nothing about a lift |
| "This app kept answering on one Jetson with its network unplugged, N of 5 drills, X tokens a second" | M12, on camera, with N and X from that take | "Is built so it keeps answering on a Jetson when the cloud is cut" |
| docs/STORY.md "On your own hardware" mark moves up | M12 | It stays "Simulated" |
| Anything else | | "Is built so" |

Never, at any level: the lines in docs/MESSAGING.md, "Don't say", including the edge lines added Nov 2. In short: no "works offline" in general, no "private" or "on-device" for board answers, nothing "attack-proof", no claim that an incident was a confirmed cyberattack, nothing survives a power loss, no food-safety advice, nothing about real freezers. Label simulated things "Simulated".

## Related edge work: Hussam's PR #67

Hussam's PR #67 (open, Nov 2, branch `doc-bench`) fine-tunes Llama 3.2 1B on jetson-04 itself, to read invented receipts, and serves the tuned model through the fleet and a product's route (#63). It is separate from this plan's units, and not merged or logged in docs/BUILD_LOG.md yet, so none of its numbers may be said in public until it is. What it means here:

- It is the on-board training path: the board trained a Meta model with no rented GPU. The PR reports the tuned 1B at 100% valid JSON and 81% of fields right on 40 held-out invented receipts, against 88% and 47% for base, all on invented data at $0.
- M10's "first Meta model on a board" is no longer true once #67 is logged. M10 stays the first Llama 3.2 3B on a board.
- jetson-04 is H1's first-choice drill board. #67 left it serving Bolt with 4 GB of disk free, and the base 1B GGUF and adapter (1.34 GB) kept beside a disabled drop-in. Hussam decides whether the 3B fits next to them or what moves.
- A possible later line for the write-up, after it is logged and marked in docs/MESSAGING.md: one sentence on a Llama tuned on the board itself. The owner decides.

