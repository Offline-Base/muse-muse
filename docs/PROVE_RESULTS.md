# Prove results, Nov 1, 2026

Every item from the Nov 1 prove run, with the state each line of work reported. No state has been raised here.

How to read the states:

- **passed:** seen working in a real run. "Test model" means muse-spark-1.3-contributor with made-up data, not Muse Wonder. "Direct" means run straight on a lab box or rented GPU, not through the platform's route.
- **done:** the work is finished, which says nothing about whether it was proven in a real run.
- **failed, blocked, pending, not run:** as named. A cost of "-" means none was recorded, not that it was free.

A pass on the test model does not prove the same thing on Muse Wonder. The only long Muse Wonder build in this run failed.

## All items

| Line | Item | State | Evidence | Cost |
|---|---|---|---|---|
| Setup | Preview A (test model) | done | muse-muse-571jspu5f, dpl_4FNHmnwUJd2idnxMGN4j11uwn1Qx, READY. Switches not read back. Later found unable to build (see Recipes). | - |
| Setup | Preview B (Muse Wonder) | done | muse-muse-1wld7lpa7, dpl_GXQwuZ6V62oaPjUAC1GpwMdjC1TV, READY. Switches not read back. Later found unable to build (see Long builds). | - |
| Setup | Reachable without a Vercel login redirect | failed | Plain curl gets 302 to Vercel sign-in because deployment protection is on. `vercel curl` gets 200 on /, /dashboard and /gallery. | - |
| Setup | Fix main's build failure | done | TS2322 in lib/train/tune/__tests__/loop.test.ts. Local commit 6bbf11bf, loop test 19 of 19. | $0 |
| Setup | Push tg-close-site and open a PR for the fix | blocked | Permission check denied the push. Not retried. See "Changed since" below. | - |
| Hygiene | Migration test covers 0028 to 0030 | passed | PR #18, 30 of 30. 0018 to 0030 compared with drizzle-kit. | $0 |
| Hygiene | tune-harness ingest records a failed run as failed | done | PR #18. 3 unit tests pass. The failing ingest path itself was never run. | $0 |
| Hygiene | Older branches compared with origin/main | done | PR #18 has the table. Docs brought in, no stranded product code found. Superseded calls rest on sampled lines. | $0 |
| Hygiene | IP addresses scrubbed from run logs | done | 4 removed. Addresses remain as config in 5 finished knowledge scripts. | $0 |
| Hygiene | Merged and clean worktrees removed | done | sim-tune, tune-loop, rl, verify, host-tuned. Branches kept. | $0 |
| Hygiene | One PR opened | done | #18, later merged. | $0 |
| Capabilities | Audit and mark capabilities ready | done | CAP_READY true for data, files, connect, jobs, live, media, code, runtime, hardware, games on tg-caps-ready. Ready means finished code, not proven. | - |
| Capabilities | New builder snapshot | done | snap_XXT4qDZEWLQ6xL8RgAvqd38c2kdM, 17 cap overlays. | - |
| Capabilities | Real saved-data build | passed | Test model. Build fdeb6cbb on muse-muse-hywjfy4ld, judge passed, no fix round. | $0.101 |
| Capabilities | Data survives a reload | passed | Test model. Platform's fixed checks in fdeb6cbb on all 3 milestones, 17 rows counted at the gateway. A separate browser check of mine did not complete. | - |
| Capabilities | Muse Code sessions in a real build | passed | Test model. Build 1b5664a8, muse-code-run passed on all 3 milestones. First try c6b68b1c failed on the IPv6 firewall bug ($0.071 is that try). | $0.071 |
| Capabilities | Muse Code product build finished | pending | 1b5664a8 still in a fix round at about 47 minutes. Judge failed round 2 on R6. Sessions' own cost not read. | $0.08 |
| Capabilities | Real builds of files, connect, jobs, live, media, runtime, hardware, games | not run | Fakes only. | $0 |
| Capabilities | Targeted tests | passed | lib/caps 625 pass, 1 stale test removed, 4 cancelled. 2 session.test.ts tests stay cancelled. Browse test and media flags-off fix not rerun. | $0 |
| Capabilities | Open a PR | done | #26. Now has merge conflicts with main. | $0 |
| Chained | CHAINED_BUILDS behind a flag, off | done | Fakes only. No real chain has run. Reached main through #22; #20 was closed. | $0 |
| Chained | PLATFORM_POWERS capability, off | done | Fakes only. No real power has run. Reached main through #22. | $0 |
| Chained | Targeted tests | passed | Fakes only. lib/chain 10 of 10, platform 18 of 18. workflow.scenario 60 of 62; the 2 failures are cap tests, not confirmed the same as base. | $0 |
| Chained | Real full Muse Muse test | not run | As instructed. docs/CHAINED_BUILDS.md and docs/PLATFORM_POWERS.md list the first-run checks. | $0 |
| Chained | Open PR | done | #20, closed. Replaced by #22, merged. | $0 |
| Recipes | Assigned Preview A (571jspu5f) | failed | 3 builds failed at provision, snapshot lacks muse-app overlay (5656253e, 68cfe510, abae14c1). hywjfy4ld served no recipes (411ebf7a, 253fc25f, 199e87d1). Verdicts below come from muse-muse-9h8b4wkkl and muse-muse-ljblsxqjl, deployed from tg-caps-ready. | - |
| Recipes | recipe-verified-agent (Larkfield Safety Review) | passed | Test model. 3be64261 live in about 55 minutes, 0 fix rounds, smoke 3, judge passed. Refine 4b455668 ran to completion but the answer was not read. [Demo](https://8a701wvtiqvp1x3e.public.blob.vercel-storage.com/demos/3be64261-5b4f-4a8c-857e-975870d150a7/demo-mluDNEcBeEPhkgs9gJrIFX5KIFP46Z.mp4) | $0.126 |
| Recipes | Larkfield stops and asks when evidence is missing | not run | Sandbox went down mid-run, 502. Only the page's wording claims this. | - |
| Recipes | recipe-case-agent | passed | Test model. 34a51495 live, 0 fix rounds, smoke 12, judge passed. In the browser, refine 9ca1e734's turn log said the proof model was unreachable and it drafted starter issues, so the model-driven run did not work there. Cause not found. [Demo](https://8a701wvtiqvp1x3e.public.blob.vercel-storage.com/demos/34a51495-bd01-4f10-9fc0-cfe62f17856e/demo-rSMk4VW77JSFXF0fGfsrAMirkp1g0W.mp4) | $0.091 |
| Recipes | Case agent stops and asks a person for evidence | failed | "Asked for evidence" appeared only in seeded sample turns. Filing without review confirmation was refused, so the sign-off gate holds. | - |
| Recipes | recipe-api + recipe-agent-patterns (Brief Desk) | passed | Test model. 40a4525e live, 0 fix rounds, smoke 5, judge passed. Refine 40892a0c returned an answer with a quoted section. [Demo](https://8a701wvtiqvp1x3e.public.blob.vercel-storage.com/demos/40a4525e-e0ee-46aa-b182-eab1e30a1d4b/demo-wz4Jmbl46Zso0PdCyyTRlTsHz4k7t3.mp4) | $0.082 |
| Recipes | recipe-code-sessions (Tidy Scripts) | passed | Test model, only with the IPv6 fix. 20d2a61e: gateway saw 1 task make files, 1 fix round, live. The browser result may have been a replay; the gateway check is the proof. d53def44 hit the bug first. [Demo](https://8a701wvtiqvp1x3e.public.blob.vercel-storage.com/demos/20d2a61e-d9a8-4bb2-a6a8-ed1d1abf4184/demo-BGLENe9W3CEQHdY6C4GAK5XZHvqvar.mp4) | $0.108 |
| Recipes | recipe-visual-reports + recipe-image (Harbor Report Studio) | passed | Test model. 03446f53 live, 0 fix rounds, smoke 6, judge passed. By hand only the numbers check ran; slides and image seen only in the judge's review. [Demo](https://8a701wvtiqvp1x3e.public.blob.vercel-storage.com/demos/03446f53-c68e-4f44-b1f0-c6d366bf6e64/demo-cr4NjwtLrO6W4grfcCH5JsqSmunuhe.mp4) | $0.101 |
| Recipes | recipe-voice + recipe-sam-media (Clip Scribe) | pending | Test model. 374f7806 live, smoke 8, judge passed. By hand, refine fcc0fa73 still showed "Transcribing the meeting…" after 45 s. Find objects not clicked. [Demo](https://8a701wvtiqvp1x3e.public.blob.vercel-storage.com/demos/374f7806-e9ae-4e02-a2ee-104e2572fa8c/demo-4O8VbvumxCrEpXOlSIJhs94yZkUliB.mp4) | $0.109 |
| Recipes | recipe-games (Lantern Run) | pending | Test model. ad21791c live in about 10 minutes, smoke 5, judge passed. Never played by hand. [Demo](https://8a701wvtiqvp1x3e.public.blob.vercel-storage.com/demos/ad21791c-a1ca-4548-96d3-faaf3b4857b7/demo-X6Jq5bY2hxhMy3cueDsyXYsJndMiES.mp4) | $0.031 |
| Recipes | recipe-simulated-loops (Mill Floor Sim) | passed | Test model. fd958df7 live, 0 fix rounds, smoke 6, judge passed. By hand, Approve on the gate reached stage 2 of 7. Not run to the end. [Demo](https://8a701wvtiqvp1x3e.public.blob.vercel-storage.com/demos/fd958df7-e462-4f90-b888-6d25327c76fd/demo-eqROp9fXkHKchAGCKz43mJgWYJTS6B.mp4) | $0.031 |
| Recipes | Why local Tidy Scripts failed (6172d951) | done | Sandbox firewall gave 403 on every start of a Muse Code task to the local gateway. The Preview did not hit this. | $0.085 |
| Recipes | Bug: IPv6 ranges in the sandbox firewall list | done | Vercel refused `::1/128`, so no Muse Code session or browse sandbox could start on Vercel. Fix proven by 20d2a61e. Still on main; the same fix is in #26. | - |
| Recipes | Push the fix and open the PR | blocked | Permission check denied it. tg-sandbox-cidr is not on origin. Local commit 436ec53c. | - |
| Recipes | Bug: sandbox previews don't hydrate in a browser | failed | Not fixed in the template. Adding `allowedDevOrigins: ['*.vercel.run']` through a refine made buttons work. Template fix needs a new snapshot. | - |
| Long builds | Long build over an hour with subagents on Muse Wonder | failed | b2996b46 on muse-muse-8dixe987o, muse-wonder-1.0 read back. 64 minutes, did not finish. First 5 milestones failed, each round cut at 5 to 8 minutes. 0 subagents started. Stopped by me in fix round 1 on a spend estimate that ran high. | $16.55 |
| Long builds | Keep editing a finished build | passed | Test model. cff8b53d live, edit 818cd8ac live, v2 has the new label in 4 files, on muse-muse-v4fpmmrh0. | $0.0941 |
| Long builds | Restore an old version | passed | Test model. 973bd621, v3 byte-identical to v1 in all 79 files. | $0 |
| Long builds | Download source.zip and check contents | passed | Test model. v1, v2, v3 all 200, about 266 KB, 79 files, no .env files. | - |
| Long builds | Download selfhost.zip | blocked | 404. RUNTIME_OUTPUTS off, and it needs a live link, which Previews don't have. | - |
| Long builds | Toggle code public and private | passed | Test model. Both 200, sourcePublic read back. Not tested from a second visitor. | - |
| Long builds | Open /p/<slug>/code in a browser | passed | Test model. Headless Chrome through a forwarder, screenshot viewed. Buttons not clicked. | - |
| Long builds | Extension zip download | blocked | 404. Needs a live link. Extension source is in source.zip. | - |
| Long builds | Automatic packaging as a build step | blocked | Step runs after deploy, which a Preview never reaches. | - |
| Long builds | Composio inside a product | blocked | COMPOSIO_API_KEY is not in Preview env. No key entered. | - |
| Long builds | Build log and PR | done | #27. Log only. It says about $24.13 Meta; the correct sum is about $24.15. | - |
| GPU | RL dry run (rl-grpo) | passed | Direct on H100, job 41e19483. Numbers made up, by design. | - |
| GPU | RL real short run, 15 steps on r30b | passed | Direct, harness. b5d05d97 after the fix: base 27 of 40, tuned 40 of 40. Only 15 steps on easy arithmetic. | - |
| GPU | Two-round real tuning loop on Llama 3.2 3B | passed | Direct, harness. Loop a56febc8 ran, but **tuning did not improve**: 6.67, then 6.67, then 6.54 overall, base about 2.5. Within judge noise. Writers $2.78, judges $2.99. | $5.77 |
| GPU | Small tuned Llama GGUF under 3 GB | passed | Direct. 2,019,377,312 bytes Q4_K_M, sha256 19f17967..., from adapter e1b00ffa. llama-cli on the A10 answered at 168.8 tokens/s. Published nowhere, not run on the laptop. | - |
| GPU | Real Glimmer tune (r30b) | passed | Direct on H100, harness. Job 1898e46c, judged ef05cf55. 120 steps, 900 rows, 40 kept-aside prompts, tuned won 40 of 40, 7.93 vs 2.5. Short run on an invented domain, an easy test. GPU about $1.86, judge $0.52. | $2.38 |
| GPU | GPU cleanup | done | 59a99e96 and 72ef7537 terminated and gone from the list. This work's GPU total about $4.16. | $4.16 |
| GPU | Bug fixes and PR | done | #25. rl.ts reloads the adapter for tuned answers. rl.test.ts 16 pass. Now has merge conflicts with main. | - |
| Lab | desktop_mac | passed | Direct. musemuse-dinner-split-helper.vercel.app on macOS 26.7, opened in 0.5 s. | $0 |
| Lab | android_emu | passed | Direct. Pixel 7 emulator, Android 15, opened in 1.1 s, screenshot viewed. | $0 |
| Lab | ios_sim | passed | Direct. iOS 26.5, opened in 3.5 s. | $0 |
| Lab | desktop_windows | passed | Direct. Windows Server 2022, opened in 2.1 s. Box confirmed stopped. | $0.01 |
| Lab | glasses_sim on iOS 26.5 | failed | Direct. Mock glasses answer no_eligible_device, same as Oct 31. Cause not known. | $0 |
| Lab | glasses_sim on iOS 18.4 | passed | Direct, mock glasses, on a test page and not a built glasses product. Connected, 1024x683 photo and 5.3 s of sound. | $0 |
| Lab | Fix for glasses on branch tg-lab-fixes | done | #24. 97 tests pass. Cold install under the new limit not re-run. Now has merge conflicts with main. | $0 |
| Lab | Device Farm Android check | passed | Direct custom test spec, not scripts/devices/devicefarm.ts. Real Galaxy S25, Android 16, run c6020d83, selftest ok, loaded in 1292 ms. Used profile offlinebase, not base-test as docs/DEVICES.md says. | $0.15 |
| Lab | gguf_emu runner | not run | Needs a public Hub file, and the Mac's release has no gguf_emu runner. | $0 |

The cost shown for Muse Code sessions is the failed first try, and the GPU cleanup row's $4.16 is the GPU total, so the Glimmer row's GPU share is also inside it. Use the budget table for totals, not a sum of this column.

## Earlier local-site results

Reported before this run. All on the cheap test model on a local site unless the row says otherwise. A local run has no live link. Details are in docs/BUILD_LOG.md, Nov 1 entries.

| Item | State | Evidence | Cost |
|---|---|---|---|
| VR | passed | 06fdb184 (orbit-sorter), emulated Quest, smoke 7, score reached 3 of 3. | $0.043 |
| Glasses | passed | 07844582 (shelf-whisper), fake bridge, smoke 4. Real glasses and iPhone app not run. | $0.034 |
| Extension | passed | 276b90da (margin-note), loaded in real Chromium, popup and action passed. Zip and /get/extension not run. | $0.030 |
| Gadget | passed | Retry 711530d6 (receipt-eye-two), simulated board, smoke 5. First try 8cc4e054 never reached the board. A real board not run. | $0.051 |
| Packages from an admin route | passed | Run 179bf577 on pantry-tally (28d38b03): android 38.5 MB with a debug key, mac 224 MB, windows 158 MB. Hashes matched. Not installed or opened. | $0.032 |
| Agent with web search | passed | 42f3ac39 (tide-scout), real Meta web search with sources, 3 fix rounds. | $0.044 |
| Legal case agent | passed | Test model, on a Preview. Reported as passed to this step; the traceable build here is 34a51495 above, with its limits. | see above |
| Harness fine-tune on Llama 3.2 3B | passed | Direct, harness. Job e1b00ffa, tuned 6.67 vs base 2.55, won 95 of 100. Not Glimmer. Dataset $0.22, judge $1.54, GPU about $0.39 of a $1.80 rental. | $1.76 Meta |
| Full builds bf7a2e2e and b500a0b8 | pending | Muse Wonder on a Preview. Briefs and scope checks ran. Final result not recorded on main. | not recorded |

## Spend by budget

Recorded figures only. Sandbox time, Muse Code sessions' own cost and any build that kept running after its agent stopped are not in these numbers.

| Budget | Cap | Item | Spent |
|---|---|---|---|
| Meta plus sandbox | $150 | Capabilities | about $0.25 |
| | | Recipes | about $0.76 |
| | | Long builds, including $7.40 on two tallies that ran on Muse Wonder by mistake | about $24.15 |
| | | Tuning writers and judges | about $6.29 |
| | | Earlier local site, Composio by estimate | about $2.07 |
| | | **Total recorded** | **about $33.52** |
| GPU | $50 | Spent before this run | $4 |
| | | This run | about $4.16 |
| | | **Total recorded** | **about $8.16** |
| AWS | $150 | Windows box | about $0.01 |
| | | Device Farm | about $0.15 |
| | | **Total new** | **about $0.16**, Mac host already billing at $15.60 a day and not counted |

Not recorded: the final cost of 1b5664a8, fcc0fa73, bf7a2e2e and b500a0b8.

## Changed since these results

Checked Nov 1 when this file was written.

- #17, #18, #19 and #22 are merged. #19 carries the type fix that the blocked tg-close-site push held, so a deploy from main no longer needs commit 6bbf11bf. The blocked item above stays blocked as a record of what happened.
- #20 was closed. #22 replaced it.
- main still lists IPv6 ranges in lib/caps/code/policy.ts, so **Muse Code sessions and browse can't start on Vercel from main**. The fix is on tg-caps-ready, in #26.
- #24, #25 and #26 show merge conflicts. #27 is mergeable.

## Not proven anywhere

- A finished long build on Muse Wonder, or any recipe on Muse Wonder.
- A published product from these tests. Previews don't publish, so the extension zip, selfhost.zip and automatic packaging are all untested.
- Platform launch of a tune, https callbacks, the sweep and Hugging Face upload.
- A real chain or platform power, and so the full Muse Muse test.
- Composio inside a product, a real board, real glasses, gguf_emu.
