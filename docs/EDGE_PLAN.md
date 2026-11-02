# The edge plan

The living plan for the edge track. Written Mon Nov 2, 2026, afternoon ET, on branch tg-edge-copy, from the judge panel's merged plan. Change a unit's status here when it changes; history goes in docs/BUILD_LOG.md.

**Why now.** On Nov 2 supermarkets across Europe reported suspected freezer hacks, and a DC substation event cut power downtown (docs/MESSAGING.md, "Edge facts, Nov 2": use only the rows marked Checked). The owner wants edge and local pushed nearly as hard as frontier. Nothing here says those events were attacks, or that this app would have stopped one.

**The scenario.** A simulated cold room. A watcher app reads a controller, an independent probe, the door, defrost, power and cloud status, and is built so it keeps answering on a Jetson when the cloud is cut. All data is invented. It gives no food-safety advice and says nothing about real freezers.

**One-line story.** "One sentence becomes a cold-room watcher: Muse Muse builds it on Meta's cloud models, tunes a Llama 3.2 3B for it, and the same app keeps answering on a Jetson with every cable out." Until M12 has run, that line is said as "is built so".

**Flags.** Everything stays off by default. `EDGE_ENABLED` adds the edge target to the brief. `EDGE_BUILDS` writes the fallback files into builds. With both off, behavior, prompts, goldens and stored data are exactly as today.

**Branch.** Code units land on `tg-edge` off `adfcc7d4`. Cut order: 1 goes first, "keep" is never cut.

## Units

Status is one of: **not started**, **built** (code or docs exist, tests pass, nothing real has run), **run** (it ran for real, with a log entry). As of `adfcc7d4` nothing below has run.

| id | What | Who | Hours | $ | Depends on | Proves | Cut | Status |
|---|---|---|---|---|---|---|---|---|
| M1 | Cloud-to-edge fallback helper. `template/lib/meta/edge.ts`: `edgeClient()` reads EDGE_URL, EDGE_MODEL, EDGE_API_KEY (the `glimmer()` pattern, never `gatewayEnv()`). `respondJsonOrEdge()` tries the cloud with a 10 s timeout, then the edge model through `chat.completions` with `json_schema` and zod. It returns `by` plus a fixed label. `EDGE_FIRST=1` flips the order. A plain message if both are down. No `enable_thinking` with a schema. Skill in `.agents/skills/muse-edge/SKILL.md`. Shipped through `nativeExtraFiles` extraFiles behind `EDGE_BUILDS` | agent | 5 | 0 | none | Unit tests, one per failure type | keep | not started |
| M2 | Drill data and scorer. `scripts/dev/drill-bench.py` make, ask, score (the receipt-bench pattern). Invented rows: setpoint, controller, independent probe, door, defrost, power, cloud. Output `{status, trust_controller, likely_cause, actions[], escalate}`. Cases: normal, door open, defrost stuck or setpoint pushed toward 50 C, controller and probe disagree, probe dropout, power-loss gap in the log, cloud down. 900 train and 100 sealed held-out rows in `train_model` format, plus 2 demo CSVs | agent | 3 | 0 | none | A rights-clean set (written by code, no Terms 10.1(ix) question) with an objective score and a "never trust a tampered reading" rule | 5 (4 cases, 300 rows) | not started |
| M3 | Outage drill kit on the laptop. `scripts/edge-fake.mjs` gives schema-valid replies and has refuse, hang, garbage and tamper modes, logging to `test-results/caps/edge.json`. A blackhole gateway and `scripts/caps/edge.mjs`. Four drills: cloud refused, cloud hangs (answers in about 12 s), both down (a plain message, no console error), tampered reply rejected. Runs through `MUSEMUSE_BASE_URL` | agent | 5 | 0 | M1 | Simulated drills pass | keep (the tamper drill goes last) | not started |
| M4 | Edge target. `"edge"` in `TARGETS` (`lib/brief/schema.ts`) behind `EDGE_ENABLED`, a `TARGET_GUIDE` entry (`lib/native/targets.ts`), `applyTargets` limits taken from selfhost `platformOnly`, a `judgeInstructions` line, and `output: "standalone"` when edge is listed. Flags-off goldens unchanged | agent | 2.5 | 0 | none | Edge is a choice in the plan, not a hand edit | 3 | not started |
| M5 | A drill inside every edge build. A step after verify in `lib/pipeline/build-steps.ts`: a second `next start` on loopback with GATEWAY_URL at the blackhole and EDGE_URL at the fake. M3's files go in as extraFiles, so no new builder snapshot. No Meta calls | agent | 3 | 0 | M3, M4 | Every edge build is drilled before it ships | 2 | not started |
| M6 | Board run kit. `docs/EDGE_DEMO.md` plus a script that builds Next standalone in a linux/arm64 Docker container on the Mac. Env: `EDGE_URL=http://127.0.0.1:11435/v1`, `EDGE_FIRST=1`, GATEWAY_URL optional. The offline `KitMode` waits until after Nov 4 | agent | 2.5 | 0 | M1 | Nothing until M12 | 4 | not started |
| M7 | One real Muse Muse edge build. Flags on for a preview only. The cold-room sentence on muse-spark-1.3-contributor. Download `/p/<slug>/code/source.zip`, run M3 on it, build it with M6 | agent 2 h, Ethan 0.5 h | 2 | 2 (Contributor, inside the $20 cap) | M1, M3, O4 | Muse Muse wrote the fallback itself | keep (fix the skill once, then hand-patch and label it) | not started |
| M8 | Scenario tune. Preferred: to-do 2's chain run uses the cold-room sentence and M2's rows through `TUNE_FOLDER`. Backup: `tune-harness.ts bundle` on unsloth/Llama-3.2-3B-Instruct-bnb-4bit (A10, rank 16), then `quant-harness.ts` with quantBase `llama-3.2-3b` for a Q4_K_M. The held-out set is scored by drill-bench, tuned against base, no Wonder judge. Logged in docs/BUILD_LOG.md and docs/KNOWLEDGE_RUN_LOG.md | agent | 3 wall | 0 extra (inside the $25), or 3 to 6 backup (cap $10) on a Lambda A10 | M2, O2 or O3, a rotated Lambda key | Tuned against base lift, on a rented GPU | 6 (stock model, labeled "base") | not started |
| M9 | Publish the GGUF as `OfflineBase/Llama-3.2-3B-ColdRoom-Watch-GGUF`, with LICENSE, USE_POLICY, "Built with Llama" and a limits card. Uploaded by hand (the proven path) | Ethan | 0.5 | 0 | M8, O5 | The file can be pulled | with M8 | not started |
| M10 | Stock Llama on a board, benched. H1, then drill-bench ask at temperature 0 through the gateway. Contributor and Bolt (labeled non-Meta) as comparison rows. Results in `docs/log/bench/2026-11-03/` | Hussam 1.5 h, agent 1 h | 2.5 | cents | M2, H1, H2 | The first Meta model on any board: speed and base score | keep | not started |
| M11 | The tuned file on the board (H4) | Hussam | 1 | 0 | M9, M10 | Tuned score on the board | 6 | not started |
| M12 | The cut, on camera (H3 and H5) | Hussam 3 h, Ethan 0.5 h | 3.5 | 0 | M6, M7, M10 | One board kept answering with its network out | keep (see the fallback ladder) | not started |
| M13 | Copy, claims and log. The edge act in docs/VIDEO.md, edge facts and Don't-say lines in docs/MESSAGING.md, this plan, the to-dos in docs/HANDOFF.md. docs/STORY.md's "On your own hardware" mark moves only after M12. `lib/__tests__/reach-claims.test.ts` stays green. One docs/BUILD_LOG.md entry per unit | agent | 2 | 0 | runs | Copy matches the runs | keep | built (drafts, branch tg-edge-copy) |
| M14 | Code matches the evidence. Add Llama 3.2 3B to `MEASURED` (`lib/train/bases.ts`, citing docs/BUILD_LOG.md lines 1668 to 1681). Swap `deviceModelTarget` after M10 if O7 is yes | agent | 1 | 0 | M10 | Defaults match the measurements | 1 | not started |

**Start now** (no spend, no decision, no Hussam): M1, M2, M3, M4 and M13, as five light agents from Mon 1:30 PM. Then M5, M6 and the `MEASURED` part of M14 from about 8 PM. Tests run only for the files each agent touches.

## Owner decisions

Each is a yes or no. Reply with the id and "yes" or "no". Dollar amounts are the most it can cost.

| id | Question | $ | Unblocks | Answer |
|---|---|---|---|---|
| O1 | Reverse the Oct 31 line "No Jetson or fleet endpoint in the Nov 4 demo" (docs/BUILD_LOG.md, Oct 31, 16:20) for an edge act, keeping the house-machine Glimmer shot? | $0 | The edge act in docs/VIDEO.md, M12 | open |
| O2 | Run to-do 2's chain run on the cold-room sentence, training on M2's code-written rows, finished by Tue 3 PM, with a rotated Lambda key in place first (to-do 8)? | $25 (to-do 2's existing Lambda estimate) | M8 preferred path, Act 1 footage | open |
| O3 | If the chain-run tune misses Tue 3 PM, run the harness tune on an A10 as a backup? | $10 cap | M8 backup path | open |
| O4 | Turn on `EDGE_BUILDS` and `EDGE_ENABLED` on a preview, not production, for 2 to 3 test builds? | $5, from the $20 Contributor cap | M7 | open |
| O5 | Create the public Hugging Face repo `OfflineBase/Llama-3.2-3B-ColdRoom-Watch-GGUF`? | $0 | M9, M11 | open |
| O6 | Approve the video re-cut: Act 2 from 33 s to about 20 s, shots 10 and 11 become an edge act of about 30 s, the Glimmer shot stays at about 5 s (docs/VIDEO.md, "Proposed revision: the edge act")? | $0 | The edge act | open |
| O7 | After M10, point `deviceModelTarget("jetson_orin_nano")` at Llama 3.2 3B Q4_K_M instead of one-bit Glimmer, with flags still off? | $0 | M14 second half | open |
| O8 | Allow fallback level 2, which pulls the house uplink and takes jetson-05's tunnel and remote fleet access down during the take? Hussam must agree too | $0 | Ladder level 2 | open |

## Hussam's asks

The boards are Hussam's. Nobody else changes them, and nobody SSHes from the laptop.

**H1. Tonight (Mon), about 1.5 h. Drill board and stock Llama.**
1. Say what the "Musetesthussamshouse" exec jobs did on jetson-04.
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
2. The product on the house machine through `jetson-05.local:8080/admin/v1`, with the uplink pulled. Only if O8 is yes.
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
