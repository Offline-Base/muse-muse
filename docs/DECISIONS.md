# Decisions

| Date | Decision | Why |
|---|---|---|
| Oct 27 | Glimmer itself is the router | Glimmer's "assistant" model is a DFlash speculative-decoding drafter (model_type muse_glimmer_assistant, 5 draft layers), not a chat model |
| Oct 27 | Development runs Glimmer on OpenRouter (`meta/muse-glimmer-30b`) | Ethan asked for cloud only for now; the Mac has about 15 GB free. Cloud mode only reads folders marked `.synthetic` |
| Oct 27 | Jetson model is `mradermacher/Muse-Glimmer-30B-i1-GGUF` i1-IQ1_S (6.5 GB), IQ1_M (7.1 GB) as the comparison | Ethan asked to use a published quant instead of making our own; i1 files are imatrix quants of the base model |
| Oct 27 | No Jetson board is pulled from the fleet yet | Ethan's call; the Jetson path is tested in simulation |
| Oct 27 | The laptop dials out to the Jetson for heavy steps | The Mac is a managed work laptop that must not listen on the network |
| Oct 27 | Roster is 24 students, not 20 | The demo grades 24 essays, one per student |
| Oct 27 | Dreaming defaults to the prompt backend (rules rewritten each night); LoRA training is a cloud script | OpenRouter cannot load a LoRA adapter, and no local training |
| Oct 27 | The relay is new code in relay/ deployed as its own Worker | All work has to be in this repo |
| Oct 27 | The eval gives the router production inputs by default; hand labels only with `--oracle-labels` | Review finding: the connector never sends hand-labeled topics or the eval-only kinds, so labeled numbers overstated the shipped router |
| Oct 27 | A `.synthetic` marker counts only from the folder up to the workspace root | Review finding: a stray marker in a parent folder would have opened a real class folder to the cloud backend |
| Oct 27 | The simulation runs with no practice data by default; the practice run is an ablation | The practice set is labeled with the simulated teacher's own policy |
| Oct 27 | The device's model sees only tags in Muse's instructions and in the documents | Review finding: with real names in the prompt, an instruction could make it spell a name in a form no check knows |
| Oct 27 | t016 replaces t015 in the holdout | So the gate can see a leak of a name the roster does not know |
| Oct 27 | Glimmer's second pass for names runs on every result except dreaming reports, document lists included | The roster cannot know siblings, guardians or staff. It costs about one extra Glimmer call per result |
| Oct 27 | A result whose name pass or summary fails is held on the device ("Held on your device.") | Fail closed: no check, no release |
| Oct 27 | Learned "ask first" and "refuse" rules act as floors | Dreaming may only make the router stricter on its own; sharing more needs the model's call and the gate |
| Oct 27 | The relay accepts both dynamic client registration and client ID metadata documents | We have not seen which one Muse's client uses |
| Oct 27 | Pairing codes and client addresses are kept as HMAC-SHA256 under a Worker secret; at most 5 tries per code and 20 per address in 10 minutes | A copy of the relay's storage cannot be turned back into live codes, and a classroom behind one router can still pair several devices |
| Oct 27 | A second relay client with the same device secret stops the first (exit 3) instead of reconnecting | Two copies would otherwise knock each other off every second |
| Oct 27 | The practice set was written by Muse Spark 1.3 through the Meta Model API, not by Muse on its VM, and has no dreaming_report items | The plan's fallback. The teacher policy has no rule for dreaming reports. Ethan can redo the set in the Muse app and check it with `make_synthetic --check` |
| Oct 27 | On a Jetson the approval port can serve TLS with a self-signed certificate, which the laptop worker pins | The session cookie and the worker's essays would otherwise cross the home network in the clear |
| Oct 27 | At most 5 private tasks run or wait at once | A runaway caller cannot queue jobs without limit |
| Oct 27 | Every number we quote is cloud Glimmer on invented data until llama-server runs on a device | No local models on this Mac yet |
| Oct 27 | The demo's approval card is the tagged per-student table, not a class summary as the plan said | The connector sends grading results as per_student, and the router asks about per-student detail. A summary on the card is a product gap (`eval/reports/post_fix.md`) |
| Oct 27 | Final numbers live in `eval/reports/final*.md` and `eval/reports/final/`; earlier reports stay as they were | So the tuning and post-fix runs can still be compared |
| Oct 27 | The grading spot-check takes 10 of the 24 cloud-graded essays, evenly spaced by Glimmer's total | Covers weak to strong essays without hand picking |
| Oct 27 | The day-5 leak the eval's checker flagged in the final simulation stays in the record, explained, until the checker is fixed and the nights are rerun | A leak count is never edited after the fact, even a false positive (the verb "rose" matched the invented student Rose) |
| Oct 27 | No separate night-five eval in the final runs | The gate kept no night's rules, so the night-five router is the starting router and its 100-item score is final_cloud |
| Oct 27 | The device labels Muse's request with the policy's request topics (Glimmer, one extra call per result) and scans it for never-share keywords | On production inputs the gate kept no night's rules: who a result is for ("for families", "send to the principal") appears only in the request, so one rule mixed shares, asks and refusals. Glimmer beat a keyword list on held-out invented requests (eval/reports/request_topics.md) |
| Oct 27 | `reidentify` is not a request topic | Labeled that way it was wrong more often than right on invented requests, and it feeds a refuse floor. The router's first step still covers it |
| Oct 27 | An answer to a class-level request (`class_level` topic) is shown and shared as a summary | Approving a class average taught "share tagged" before, so dreaming could never learn share_summary from production inputs |
| Oct 27 | The eval's leak checker treats a one-word name that is also a common word like the guard does (counts only when capitalized) | "The average rose" was scored as a leak of the invented student Rose |
