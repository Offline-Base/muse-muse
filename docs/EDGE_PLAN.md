# The edge plan

**Llama ruled out, Nov 2, 3:57 PM.** The hackathon's organizers answered that Llama is not part of this hackathon and does not count as a Meta model however it runs, and that every model the project calls at runtime must be a Meta model. So M8 to M12's Llama 3.2 3B and Hussam's Llama 3.2 1B receipt tune (PR #67) can't be the model the project calls. The only Meta language model that fits an 8 GB board is Muse Muse's one-bit Glimmer (`muse-glimmer-2026-iq1s-io-lowest` on the fleet). The units below are unchanged until the owner re-plans them.

**Direction: SAM 3.1 on the boards (owner, Nov 2, 2026, about 8 PM ET).** After seeing it run, the owner said this is the direction the edge track goes: Meta's Segment Anything 3.1 (`facebook/sam3.1`) running on a Jetson in the office, called from a page on a laptop through the fleet control plane. SAM is on the organizers' list of Meta models, so it meets the Meta-only ruling.
- **Running now:** `sam3.service` on jetson-04, half-precision weights (1.76 GB), text prompt in, boxes and tinted masks out. Measured on Meta's sample photo: 1.4 to 2.6 s per prompt on the board, 3.4 GB of GPU memory at rest. The page round trip is about 10 to 20 s, most of it the photo going up through the fleet in 15 KB pieces.
- **Code and steps:** `scripts/edge/sam3/` (README there).
- **Not done:** the forwarder on jetson-05 (waits for the control-plane move to the Pi), a camera feed, video tracking, a hosted build or product using it (one Muse Muse product counted with it from the laptop on Nov 2 at 9 PM; docs/BUILD_LOG.md), and anything said in the video or submission. The Glimmer cold-room units below stay as written until the owner re-plans them around SAM.
- **Claim allowed now:** "Meta's SAM 3.1 runs on a Jetson Orin Nano and finds what you name in a photo in about 2 seconds." Not yet: offline, camera, video, or accuracy beyond the photos tried.

The living plan for the edge track. Written Mon Nov 2, 2026, afternoon ET, on branch tg-edge-copy, from the judge panel's merged plan. Updated Nov 2 evening on tg-submission-fields: unit status from what is built on `e4beadc1` (branch tg-edge), and the owner's answers to O1 to O8. Change a unit's status here when it changes; history goes in docs/BUILD_LOG.md.

**Meta models only (Nov 2, evening, branch `tg-mo-learn-plans`).** The organizers ruled on Nov 2 (3:57 PM ET, Cerebral Valley Discord; docs/MESSAGING.md, rules section) that Llama of any version does not count as a Meta model, and that every model the project runs must be a Meta model, with no non-Meta helper and no hybrid with Llama as the default. So the edge model is no longer Llama 3.2 3B. The target is **Muse Glimmer 30B, one-bit (IQ1_S)**, served on jetson-02 at the alias `muse-glimmer-2026-iq1s-io-lowest`. A cold-room tune of it is planned only if Hussam's $0 JSON-schema gate on jetson-02 (H1) passes. If the gate fails, the board's fallback is deterministic code (thresholds plus the probe-disagreement rule, no model). Nothing in this section has run. The on-screen label is "Answered on jetson-02, Muse Glimmer 30B one-bit (IQ1_S)", with "tuned" added only once a tuned run is logged. Bolt, LFM and Llama never appear as project rows.

**Why now.** On Nov 2 supermarkets across Europe reported suspected freezer hacks, and a DC substation event cut power downtown (docs/MESSAGING.md, "Edge facts, Nov 2": use only the rows marked Checked). The owner wants the edge and defense story as a headline beside frontier: defending infrastructure, and being ready for any scenario, including the day the cloud is out of reach or a controller can't be trusted. Nothing here says those events were attacks, or that this app would have stopped one.

**The scenario.** A simulated cold room. A watcher app reads a controller, an independent probe, the door, defrost, power and cloud status, and is built so it keeps answering on a Jetson when the cloud is cut. All data is invented. It gives no food-safety advice and says nothing about real freezers.

**One-line story.** "One sentence becomes a cold-room watcher: Muse Muse builds it on Meta's cloud models, tunes Muse Glimmer 30B for it, and the same app keeps answering from a one-bit Glimmer file on a Jetson with every uplink cut." (Not "every cable": the product's machine stays wired to the board, H3.) Until M12 has run, that line is said as "is built so". If the gate fails, the line becomes "...and the same app falls back to rules written in code when the cloud is cut", and no model is claimed on the board. One-bit answers are slow (about 4.7 tokens a second on jetson-02) and weaker than the cloud, so the honest claim is "kept answering, slowly", never "as good as the cloud".

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
| M8 | Scenario tune. To-do 2's chain run uses the cold-room sentence and M2's rows through `TUNE_FOLDER`, on the default r30b Glimmer base with `TUNE_ANY_BASE` off (docs/CHAIN_RUN.md). Then the one-bit IQ1_S file is made by hand on an A10 with `quant-harness.ts`, since the site can't keep a GGUF made from folder rows. The chain run's tune goes ahead either way (it is the frontier act); making its IQ1_S file and putting it on the board are planned only if H1's gate passes. Backup: a second r30b tune on Lambda (about $1.39) under the $25 cap, or the stock IQ1_S already on jetson-02, labeled "base". The Kaggle notebook is retired (it tunes Llama, and Glimmer 30B doesn't fit a free T4). The held-out set is scored by drill-bench, tuned against base. Logged in docs/BUILD_LOG.md and docs/KNOWLEDGE_RUN_LOG.md | agent | 3 wall | About $1.39 to $1.86 tune plus about $1.75 to $2.60 for the file (A10), inside the $25 | M2, O2 (yes), the rotated Lambda key (done Nov 2) | Tuned against base lift, on a rented GPU | 6 (stock model, labeled "base") | not started. Planned on r30b; nothing has run |
| M9 | ~~Publish the GGUF as a Llama repo~~. Dropped by the Nov 2 ruling: Llama isn't a Meta model here. The tuned IQ1_S file is a hand transfer to the board (folder rows are the person's own, `PERSON_WRITER`, and can't be published), not a public repo | Ethan | 0 | 0 | none | Nothing | cut | **dropped** (Nov 2 ruling; O5's reversal waits on the owner) |
| M10 | Stock one-bit Glimmer on a board, benched. H1's gate, then drill-bench ask at temperature 0 with the `json_schema` response format, on jetson-02. Contributor is the only comparison row (a Meta model). Results in `docs/log/bench/2026-11-03/` | Hussam 1.5 h, agent 1 h | 2.5 | cents | M2, H1, H2 | Speed and base score of Muse Glimmer 30B one-bit on an 8 GB board | keep | not started |
| M11 | The tuned IQ1_S file on the board (H4), only if H1's gate passed | Hussam | 1 | 0 | M8, M10 | Tuned score on the board | 6 | not started |
| M12 | The cut, on camera (H3 and H5). If the gate failed, the take shows the deterministic no-model fallback, labeled as rules in code | Hussam 3 h, Ethan 0.5 h | 3.5 | 0 | M6, M7, M10, O1 (yes), O6 (yes) | One board kept answering with its network out | keep (see the fallback ladder) | not started. O1 and O6 are yes |
| M13 | Copy, claims and log. The edge act in docs/VIDEO.md, edge facts and Don't-say lines in docs/MESSAGING.md, this plan, the to-dos in docs/HANDOFF.md. docs/STORY.md's "On your own hardware" mark moves only after M12. `lib/__tests__/reach-claims.test.ts` stays green. One docs/BUILD_LOG.md entry per unit | agent | 2 | 0 | runs | Copy matches the runs | keep | built (`1fc2a029`, merged in `e4beadc1`; the submission fields in docs/SUBMISSION.md on tg-submission-fields). Marks wait for the runs |
| M14 | Code matches the evidence. Under the Nov 2 ruling, Llama comes out of `MEASURED` and the base list in `lib/train/bases.ts` (the training-code unit owns that change), and `deviceModelTarget("jetson_orin_nano")` stays one-bit Glimmer (O7 no) | agent | 1 | 0 | none | Defaults name only Meta models | 1 | Reversed: the Llama `MEASURED` half (`e81e6f66`, `33c9c140`) is to be taken out by the training-code unit. `deviceModelTarget` stays Glimmer |

**Done so far** (no spend, no decision, no Hussam): M1 to M6, M13 and the `MEASURED` part of M14, all built on tg-edge, merged at `e4beadc1`. Tests ran only for the files each agent touched.

**Next:** merge tg-edge into main (owner or Hussam), then Hussam's H1 gate on jetson-02, M7 on a preview (O4), the chain run (O2) on r30b with M8, and H2 to H5.

## Owner decisions

Each was a yes or no; dollar amounts are the most it can cost. The owner answered all eight on Nov 2. Nothing spends or turns a flag on until the unit that needs it starts, and then only inside these caps.

| id | Question | $ | Unblocks | Answer |
|---|---|---|---|---|
| O1 | Reverse the Oct 31 line "No Jetson or fleet endpoint in the Nov 4 demo" (docs/BUILD_LOG.md, Oct 31, 16:20) for an edge act, keeping the house-machine Glimmer shot? | $0 | The edge act in docs/VIDEO.md, M12 | **Yes** (Nov 2). The edge act goes in the video, and the house-machine Glimmer shot stays |
| O2 | Run to-do 2's chain run on the cold-room sentence, training on M2's code-written rows, finished by Tue 3 PM, with a rotated Lambda key in place first (to-do 8)? | $25 (to-do 2's existing Lambda estimate) | M8 preferred path, Act 1 footage | **Yes**, $25 (Nov 2). The Lambda key was rotated Nov 2 |
| O3 | If the chain-run tune misses Tue 3 PM, run the harness tune on an A10 as a backup? | $10 cap | M8 backup path | **Yes, changed** (Nov 2): the backup was a free Kaggle notebook. **Retired the same evening by the ruling:** the notebook tunes Llama. Planned backup: a second r30b tune on Lambda (about $1.39) inside the $25, or the stock IQ1_S labeled "base". The owner confirms |
| O4 | Turn on `EDGE_BUILDS` and `EDGE_ENABLED` on a preview, not production, for 2 to 3 test builds? | $5, from the $20 Contributor cap | M7 | **Yes**, $5 (Nov 2). Preview only, never production |
| O5 | Create the public Hugging Face repo for a Llama cold-room GGUF? | $0 | M9 | **Yes** (Nov 2), then **moot** after the ruling: Llama isn't a Meta model here, and M9 is dropped. The owner confirms the reversal |
| O6 | Approve the video re-cut: Act 2 from 33 s to about 20 s, shots 10 and 11 become an edge act of about 30 s, the Glimmer shot stays at about 5 s (docs/VIDEO.md, "Proposed revision: the edge act")? | $0 | The edge act | **Yes** (Nov 2). The edge act in docs/VIDEO.md is approved |
| O7 | After M10, point `deviceModelTarget("jetson_orin_nano")` at a Llama file instead of one-bit Glimmer, with flags still off? | $0 | M14 second half | **No** (Nov 2), and the ruling makes it required: the board target stays one-bit Glimmer |
| O8 | Allow fallback level 2, which pulls the house uplink and takes jetson-05's tunnel and remote fleet access down during the take? Hussam must agree too | $0 | Ladder level 2 | **Only if Hussam agrees** (Nov 2). Until Hussam says yes, ladder level 2 is off |

## Hussam's asks

The boards are Hussam's. Nobody else changes them, and nobody SSHes from the laptop.

**H1. Tonight (Mon), 15 to 30 minutes, $0. The JSON-schema gate on jetson-02.** Nothing here has run. It decides whether a model answers on the board at all.
1. Board: jetson-02, which already serves the stock one-bit Glimmer (`muse-glimmer-2026-iq1s-io-lowest` on 127.0.0.1:11435). The old "never jetson-02" rule has to be lifted by the owner or Hussam first. Never jetson-05.
2. Settings: `-c 2048`, prompt cache off, the desktop off, `muse-device` stopped, so memory is as free as it gets (6.95 of 7.5 GB was in use with the model loaded).
3. Ask 10 receipts with the `json_schema` response format (the one `respondJsonOrEdge` sends) and an explicit `max_tokens` of about 400, through the fleet. `receipt-bench.py ask` has no schema option yet; `drill-bench.py ask` has one (`--schema --max-tokens 400 --limit 10`), so until receipt-bench gets the same option, run the gate as 10 sealed cold-room rows with drill-bench, which is the edge act's own shape anyway. Keep the 10 answers as receipts and watch memory.
4. **Pass:** 10 of 10 answers are valid JSON, and the board doesn't hang. Also note whether the verdicts read sensibly.
5. If it freezes the board once, stop and say so: the gate failed.
6. **If it fails:** the board fallback is deterministic code, thresholds plus the probe-disagreement rule, with no model (ladder level 4). Never Llama or another non-Meta model.
7. Report tokens a second, memory in use and time to first token either way. Hussam decides, separately, whether the Llama files on jetson-04 and Prompt Guard on jetson-05 are deleted (an owner question).

**H2. About 0.5 h. A key for the bench.**
1. Make a `jik_` key with `cloud_daily_limit` 0.
2. No `combo/` models and no `/v1/route` on it.
3. Hand it over without pasting it in chat, a doc or a commit.

**H3. Tue morning, about 1 h. The product beside the board.** The product and one-bit Glimmer won't both fit in 8 GB, so the product runs on a second machine wired straight to the board, with no uplink. That machine serves only the product, never a model, and it isn't the owner's laptop if anything else heavy runs on it.
1. Confirm the board's wired address (the USB-C device link is probably 192.168.55.1).
2. Run M7's build on the second machine with `EDGE_URL` at jetson-02's llama-server, `EDGE_MODEL=muse-glimmer-2026-iq1s-io-lowest` and `EDGE_TIMEOUT_MS=90000` (a 100 to 150 token verdict takes about 20 to 35 s at 4.7 tokens a second).
3. Check the board's free memory while it answers.
4. This changes the "every cable out" framing to "every uplink out": the wire between the product's machine and the board stays.

**H4. Tue 3 to 5 PM, about 1 h. The tuned file on the board, only if H1 passed.**
1. Install the tuned IQ1_S with `gguf-serve.sh` and its sha256. It is 6.53 GB, larger than the 5.75 GB stock file, and jetson-02's disk is 94% full (25.4 of 27 GB, about 1.6 GB free, fleet alert Nov 2), so the stock file moves first. Whether 6.53 GB fits jetson-02's memory is unverified and doubtful: about 450 MB was free with the 5.75 GB file loaded.
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
| Tue 3 to 7 PM | M8 backup if needed, the IQ1_S file (only if H1 passed), H4 |
| Tue 7 to 9 PM | H5. Hard cut at 9 PM |
| Wed morning | Copy and marks from the log only, edit, submit by noon. No new runs |

- The frontier chain run wins every conflict over Ethan's time or the Lambda window.
- The laptop runs only Node, the Docker build and fakes. No model runs on it.

## Fallback ladder

Use the highest level that has run by Tue 7 PM.

1. H1 passed: the tuned one-bit Glimmer on jetson-02, the product on a second machine wired to it. Label: "Answered on jetson-02, Muse Glimmer 30B one-bit (IQ1_S), tuned", only if the tuned run is logged. The house uplink and jetson-05 aren't touched.
2. The product on the house machine through `jetson-05.local:8080/admin/v1`, with the uplink pulled, and `EDGE_MODEL` pinned to `muse-glimmer-2026-iq1s-io-lowest` (a default pick can land on a non-Meta model). Only if Hussam agrees (O8); until then, skip this level.
3. Either of those with the stock one-bit Glimmer, labeled "Answered on jetson-02, Muse Glimmer 30B one-bit (IQ1_S)".
4. H1 failed, or no Glimmer answer on a board by Tue 7 PM: the deterministic no-model fallback (thresholds plus the probe-disagreement rule, in code; planned, not built), labeled as rules, not a model. Shot 10's Glimmer clip as written, plus a "Simulated outage" card from M3. **Never Llama, and never any non-Meta model.**

## When each claim may be said

| Claim | Said only after | Until then |
|---|---|---|
| "Every edge build runs a simulated outage drill" | M5 is built and one edge build has shown the drill in its log | "Edge builds are built so they run a simulated outage drill" |
| Speed and score on a named board, over 100 invented items | M10 (base) or M11 (tuned), with results in `docs/log/bench/` | Nothing about speed or score on a board |
| The label "Answered on jetson-02, Muse Glimmer 30B one-bit (IQ1_S)" | H1 passed and the take used it; "tuned" only after M11 is logged | Nothing on screen names a board model |
| "The board fell back to rules in code" | Ladder level 4 ran on camera | "Is built so" (the fallback is planned, not built) |
| Tuned against base on the held-out set | M8, logged in docs/BUILD_LOG.md and docs/KNOWLEDGE_RUN_LOG.md | Nothing about a lift |
| "This app kept answering on one Jetson with its network unplugged, N of 5 drills, X tokens a second" | M12, on camera, with N and X from that take | "Is built so it keeps answering on a Jetson when the cloud is cut" |
| docs/STORY.md "On your own hardware" mark moves up | M12 | It stays "Simulated" |
| Anything else | | "Is built so" |

Never, at any level: the lines in docs/MESSAGING.md, "Don't say", including the edge lines added Nov 2. In short: no "works offline" in general, no "private" or "on-device" for board answers, nothing "attack-proof", no claim that an incident was a confirmed cyberattack, nothing survives a power loss, no food-safety advice, nothing about real freezers. Label simulated things "Simulated".

## Related edge work: Hussam's PR #67 (not in the submission)

Hussam's PR #67 (merged as `9c6d54ad`, branch `doc-bench`) fine-tuned Llama 3.2 1B on jetson-04 to read invented receipts, and served it through the fleet and a product's route (#63). Under the Nov 2 ruling Llama is not a Meta model, so #67 is an earlier experiment, not part of the submitted project:

- None of its numbers go in the write-up, the video or any page, and it is never "a Meta model tuned on the board".
- Its files on jetson-04 (the 1B GGUF and adapter, 1.34 GB) stay behind a disabled drop-in through judging. Whether to delete them, and the Llama-3.2-3B file on jetson-04, is Hussam's call (an owner question).
- One technical fact carries over to the Glimmer path: llama.cpp `--lora` over a GGUF base works on these boards (b11574 on jetson-04).
- No on-board tune of Glimmer 30B is planned: an 8 GB Orin Nano can't train it.

