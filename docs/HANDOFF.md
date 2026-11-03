# Handoff

Where Muse Muse stands, for whoever picks it up next. Last written Nov 2, 2026, 10:24 AM ET. The PR list and owner to-dos were updated at midday on tg-submission-kit, and again in the evening on tg-submission-fields (the owner's edge answers, the going-public plan, the real form). Updated Nov 2 night on tg-mo-copy-public for the Meta-models-only ruling: O3, O5, O7, #67, to-do 2, to-do 4, H1, Prompt Guard, and the owner questions from the audit.

Change a line here when its fact changes. History goes in docs/BUILD_LOG.md.

## Now

- **Meta models only (organizer ruling, Nov 2, 3:57 PM; docs/MESSAGING.md, "What the rules say").** Llama does not count as a Meta model here, and every model the project calls at runtime must be Meta's. Until the fix plan from the Nov 2 audit lands, this overrides every line below that names Llama, LFM, Bolt or Prompt Guard:
  - The Kaggle notebook (it tuned Llama 3.2 3B) is deleted from the tree on branch tg-meta-only-tree. Don't start a Llama tune on the site; `TUNE_ANY_BASE` stays off.
  - The chain run (to-do 2) is on hold until it's re-costed on the default Glimmer base.
  - O5's Hugging Face repo will hold a Glimmer file, not `Llama-3.2-3B-ColdRoom-Watch-GGUF`.
  - The edge board model, Muse Privacy's device model (LFM3-VL-2B), #67's Llama 3.2 1B on jetson-04, Bolt on jetson-03 and 04, and Prompt Guard on jetson-05 all need a Meta model or must stay off in the demo.
- **Edge direction: SAM 3.1 on the boards (owner, Nov 2, about 8 PM ET).** Meta's SAM 3.1 runs as `sam3.service` on jetson-04 (`192.168.12.144:8790`, office network) and a laptop page calls it through the fleet (`scripts/edge/sam3/`, README there). The owner said this is the direction. docs/EDGE_PLAN.md, "Direction: SAM 3.1 on the boards", has what runs, what doesn't and what may be said.
  - Branch `tg-edge-vision` (Nov 2, late, a PR, not merged) adds `segmentOrEdge` so an edge build can look with SAM on the board, four photo drills, and the fix for the 404 `model_not_found` bug #87 found. The jetson-04 photo-take kit for Hussam is docs/EDGE_DEMO.md, section 6. Nothing of it has run on a board or in a real build.
  - **Nov 3, early morning (docs/BUILD_LOG.md, Nov 3):** SAM 3.1 checked on jetson-04 (1.4 s a prompt). SAM 3.1 was tuned on jetson-03 for a new word, "muse" (the mascot), and the tuned file runs inside jetson-04's `sam3.service` when a request says `"tuned": "muse"`. One-bit Glimmer runs on jetson-02 at about 5 tokens a second with weak answers. Hosted products can reach SAM on jetson-04 through `{GATEWAY_URL}/fleet/v1/segment` once the owner turns on `FLEET_SAM` (to-do 17).
  - **Nov 3, mid-morning (branch `tg-p-sam-local`):** `scripts/edge/sam3/ui.py` has a Meta-or-tuned switch and a before-and-after view, and `compare.py` makes the before-and-after shot in one command. Both reach SAM straight with `SAM_URL` (office network or a cable to the board, no token), or through the fleet with `FLEET_URL`, which no longer defaults to the public tunnel. What "running locally" means for the video, Hussam's rebind and cable-out steps and the go or no-go check: `scripts/edge/sam3/LOCAL.md`. Steps to repeat the tune: `scripts/edge/sam3/tune/README.md`. None of it has run against a board yet.
  - **Nov 3, 10:30 AM (docs/GLIMMER_DEVICES.md, branch `tg-p-glimmer-devices`):** jetson-02's Glimmer loop is fixed only by skipping reasoning (its current drop-in); a system prompt, a JSON schema or a two-call thinking budget didn't make answers reliable. No better file fits jetson-02. One-bit Glimmer already ran on a Galaxy S25 in Device Farm on Nov 1 (1.94 tokens a second, 3 of 3 simple questions). Owner steps O1 to O4 and Hussam's H1 to H4 are in that file.
- **Merged Nov 2 afternoon:** #67 (3:31 PM ET), #63, #68 (the edge track, 3:40 PM, deployed at `ee493e69`) and #69 (Learn, 4:07 PM). The tg-edge rows in the tables below are now on main.
- **Production** ran main at PR #59 (`12a362a1`) as of midday, with the Make chat on (`MAKE_CHAT_ALL`). Vercel blocked the deploys of #60, #61 and #62 because Hussam's commits aren't from a Vercel team member (checked Nov 2 from GitHub's commit statuses). #66, authored by Ethan, merged at 2:09 PM ET and should deploy all of main, theirs included; check its deploy on Vercel, since this file hasn't.
- **Deadline:** due Nov 4, 9 PM ET, and Ethan submits by noon ET. Whoever is awake switches judges to Muse Wonder on Nov 4.
- **What we can say in public:** docs/MESSAGING.md (outside quotes, each marked checked or not, what the rules say, and what not to say). Then the marks in docs/STORY.md and docs/PROVE_RESULTS.md.
- **Submission kit:** docs/SUBMISSION.md has every form field in order with a ready-to-paste answer and its source, the organizers' Nov 2 guidance, the Most Viral X post, and the edge and defense story as a headline beside frontier. The video script and shot list are in docs/VIDEO.md.
- **What the organizers said, Nov 2:** "Judges mainly work from your 3-minute demo video and your public GitHub repo, so the video is the core of the demo. Judges may also try the project themselves, using their own keys if needed, so the repo must run from its setup instructions. A hosted demo is optional." So the repo has to go public (see "Going public") and the README's setup has to work for a judge (docs/SUBMISSION.md, "What the organizers said").
- **Edge track (Nov 2):** a simulated cold-room watcher that is built so it keeps answering on a Jetson when the cloud is cut. The owner wants it as a headline beside frontier: defending infrastructure and being ready for any scenario. On `e4beadc1` (branch tg-edge, not merged to main) M1 to M6, M13 and M14's `MEASURED` half are built and unit-tested; nothing has run in a real build or on a board. The owner answered O1 to O8 (below). Units, Hussam's asks H1 to H5, the clock and when each claim may be said: docs/EDGE_PLAN.md. All flags off.
- **The owner's shared accounts for builds (Nov 2 night, PR #95, branch tg-build-keys):** behind `BUILD_SHARED_KEYS`, off by default. Builds and changes by signed-in builders get the owner's dedicated Vercel, AWS, Lambda, Hugging Face, fleet, Composio, Fireworks, Baseten and Modal keys in the sandbox, and their products keep them. Waits on the owner to make dedicated keys and set the `BUILD_SHARED_*` vars. Nothing has run on a real build. Setup, the risk, the kill switch and limits per service: docs/BUILD_KEYS.md.
- **Modal as a second build host (Nov 2, branch tg-modal):** behind `SANDBOX_HOST=modal`, off by default, so builds stay on Vercel Sandbox. The Modal host passed a live smoke test; no Muse Code build has run on Modal and its builder image isn't made yet. To turn it on, the env names, and the security gaps: docs/MODAL_HOST.md.

## Owner decisions, Nov 2 night (plan-to-win form)

From the owner's answers to the plan-to-win form (rounds 1 and 2). These override older lines below where they disagree.
- **Story:** "Your own AI, on your own hardware, ready for any scenario." For shops, clinics and schools with equipment online and no engineering team, and anyone with an idea and no team. The video opens with Zuckerberg's line. The script is docs/VIDEO.md (rewritten on tg-video-v2).
- **The unplug shot:** the cold-room app Muse Muse built keeps running on jetson-04, and SAM 3.1 on the board keeps watching the door (PR tg-edge-vision). Hussam narrates it and picks the prop.
- **Muse Privacy stays in the video** (about 20 s, "a leak is a bad day too"), after its rerun on Glimmer, showing the real leak count (PR tg-privacy-glimmer). The tuned Glimmer 40 of 40 is shown.
- **Extras wanted, in this order if time runs short:** Muse Spark Open on Fireworks as a model products can use (PR tg-spark-open), the site hosted on jetson-03, Muse Code driven by Spark Open through a custom endpoint, Muse Code running builds on a Jetson, a one-bit Glimmer chat clip on jetson-02.
- **Repo:** flip the current repo public (not a fresh rewrite): a private backup copy first, non-Meta model code removed from main's tree (PR tg-public-ready, then tg-meta-only-tree), backup refs and stale branches deleted, Hussam changes the ngrok domain. Personal emails in history are fine. License Apache-2.0. Meta's docs stay at /docs; the owner says a Meta organizer allowed it (who and when still to be written in NOTICE).
- **Wonder stays off for now (owner, Nov 2 late night):** builds and products keep running on Muse Spark 1.3 Contributor (`BUILDS_ON_CONTRIBUTOR` stays on) until the owner says to flip. This replaces the plan to flip on Nov 4 below.
- **Judging week:** judges on Muse Wonder with `DAILY_SPEND_CAP_USD` 100. The 8 gallery products that look like the organizers' "skip these" list are hidden, not deleted (plus 6 broken or self-contradicting ones since Nov 3, until rebuilt; see "Rebuild after the snapshot"). Edge builds on in production after one preview check; Look first on after one test build passes on the new snapshot.
- **Keys in builds (PR tg-build-keys):** builds by anyone signed in with the builder code get the owner's service keys as real env values, and their products keep them. Built from dedicated `BUILD_SHARED_*` keys the owner creates, with leak checks and a kill switch (docs/BUILD_KEYS.md). Services: Vercel, AWS (limited user), Lambda, Hugging Face, fleet `jik_`, Composio, Fireworks, Baseten, Modal.
- **Spend cap for this push:** $25. X: a teaser Tuesday night, the 60-second cut Wednesday morning.

## Open PRs, Nov 2 evening

Since Nov 2 night (owner): no PRs for our own work. Fetch the latest main, test what you touched, and push straight to main (a push deploys production). Hussam's PRs stay his; they say "Don't merge until told". Merged since the morning: #59, #60, #61, #62, #64, #65 (it fixed the unit tests main already failed) and #66 (set up for judging with no spend, 2:09 PM ET).

| PR | Who | What | State |
|---|---|---|---|
| #93 | Ethan (Claude) | Products can call Muse Spark Open through the gateway (`/v1/chat/completions`, model `muse-spark-open`), metered and capped like Meta's models, behind `SPARK_OPEN_PRODUCTS` | Open, don't merge until told. Runs on Baseten by default (`SPARK_OPEN_PROVIDER`), since Fireworks' account behind `FIREWORKS_API_KEY` was suspended on Nov 2 (HTTP 412). One real call passed on Baseten. To turn on: add `BASETEN_API_KEY` to Production, set `SPARK_OPEN_PRODUCTS=1`, redeploy, then make a new builder snapshot so the writer can offer it. No build has used it yet |
| #63 | Hussam | A product can answer from the Jetson fleet, behind `FLEET_PRODUCTS` | Open. Turning the flag on needs a new builder snapshot, the owner's model choice, a `jik_` key and a total cap. Checks pass and it's up to date with main (Nov 2, 1 PM) |
| #67 | Hussam | Fine-tune Llama 3.2 1B on jetson-04 itself to read invented receipts, and serve it through the fleet and #63's product route | Merged Nov 2, 3:31 PM ET. Llama is not a Meta model here, so #67 is dropped from the submission and its numbers never go in public copy. Hussam removes the Llama files on jetson-04 (the 1B GGUF, the adapter and the drop-in, plus any Llama-3.2-3B), pending owner question 11 below. One fact stays useful: llama.cpp `--lora` over a GGUF base works on these boards |
| tg-edge | Ethan (Claude) | The edge track at `e4beadc1`: fallback, drills, edge target, board build, drill data, docs | Branch only, no PR yet. Merge before the repo goes public, or the edge lines have no code behind them |
| #95 | Ethan (Claude) | The owner's shared accounts for builds, behind `BUILD_SHARED_KEYS` (docs/BUILD_KEYS.md) | Open, don't merge until the owner has read the risk section. Flag off: no change. The skill and Demo Studio's caption guard need a new builder snapshot |
| #54 | Ethan (Claude) | Hero tune: sealed test and tooling | Draft, blocked before training |
| #46 | Ethan (Claude) | Hugging Face inventory | Open. Found every OfflineBase repo answering as public (owner to-do 7) |

## Waiting on the owner

**Overnight, Nov 3 (audits and two fix rounds, docs/BUILD_LOG.md from "Nov 3, 2026, 3 AM ET"):**
- **A new builder snapshot** (`npm run snapshot` in a linked worktree with .env.local, then commit lib/sandbox/snapshots.json). The template parts of both fix rounds reach builds only after it: phone tap and contrast checks, fallback recording, image and storage lints, model error causes, presigned uploads, ConfirmButton, UsageStrip, media-store, Tabs, overlay helper, ModelChip label.
- **Rebuild after the snapshot:** sim-desk-agent-demo (draws SVG, so its model never ran), wag-sticker-studio (old upload client, placeholder clip), lantern-canal-drift (soft-lock), fresh-dot-fridge (boxes at a tenth of their size). fable-case-ledger's memo works live after the gateway's output floor, but its page still shows the memo error as a known issue and is marked partial.
  - **Hidden from the gallery until then (branch tg-p-demos, Nov 3):** those five and cold-room-watcher-2 (its tagline says it keeps answering on the office board; its page says "Not connected to a board") are on `HIDDEN_FROM_GALLERY` in lib/gallery/hidden.ts. Their pages and links still work. The gallery now leads with handbook-proof-checker, room-restyle-studio, standup-scribe-notes, parking-policy-reader, paper-lantern-museum, then dinner-split-helper (`GALLERY_FIRST`).
  - **The command, once the new snapshot's deploy is live** (from a linked worktree with .env.local, like ~/mm-wt/overnight; the ids are checked with `--dry`):
    `npm run demo-batch -- computer-use stickers games fridge`
    computer-use remakes sim-desk-agent-demo, stickers remakes wag-sticker-studio, games remakes lantern-canal-drift, fridge remakes fresh-dot-fridge. These are new builds, so each gets a new slug; the old pages stay hidden.
  - **Cost, an estimate:** batch 2 builds on Contributor cost $0.27 to $0.40 each in Meta credits, so about $1.10 to $1.60 for the four (the README's ceiling is $1.80 a build, $7.20 in all), plus Vercel Sandbox minutes for 46 to 150 minutes a build. Nothing starts until the owner runs it.
  - **After they go live:** open each new page and its live link. Put a new one on `GALLERY_FIRST` only if it works; take one off `HIDDEN_FROM_GALLERY` only after its page shows no known issue. fable-case-ledger has no demo-batch id (it's `legal`, the case agent); rerun it with `npm run demo-batch -- legal` only if the owner wants it back.
- **Optional:** a Blob read-write token in Production (`BLOB_READ_WRITE_TOKEN`) would make uploads work in products built before the presigned change without rebuilding them.
- **Phone and desktop apps (branch tg-r3-native-honest):** none has ever been made on production, because `PACKAGER_SNAPSHOT_ID` isn't set there. Until it is, phone and desktop aren't offered and the site says so. docs/NATIVE_READY.md has the ordered steps; the short path reuses the Oct 31 snapshot and needs no EAS build. Then `scripts/backfill-live-urls.ts` (dry run first) for the long live links.
- **New default to know:** `LIVE_ACTION_CHECK` is on. Every ship makes one real call to the product on its live link and shows a failure or fallback as a known issue. Set it to 0 to hold it back.

In order. To-do 2 has to finish by Nov 3 afternoon (Tue 3 PM for the edge tune), or the video uses its fallbacks. To-dos 4 to 7 and "Going public" must be done before the repo goes public. Times are estimates.

1. **Pick the demo story.** Mostly settled Nov 2: O1 and O6 are yes, so the recommended script plus its edge act in docs/VIDEO.md ("Proposed revision: the edge act") is the plan. About 5 minutes left, Ethan and Hussam: confirm it, then take "DRAFT" off docs/VIDEO.md.
   - docs/VIDEO.md's three acts (one sentence to a model and an app, Muse Privacy, the Jetson) now end in the edge act, about 2:54. The inspo-first script it replaced is at `git show e290545d:docs/SUBMISSION.md`.
2. **The end-to-end chain run: approved Nov 2, $25 (O2), on hold for a re-cost.** Under the Meta-models-only ruling it moves to the default r30b Muse Glimmer base with `TUNE_ANY_BASE` kept off (owner question 2 below). It runs on the cold-room sentence with M2's code-written rows and should finish by Tue 3 PM. The rotated Lambda key is in place (to-do 8). The run itself takes about 1 to 2 hours, by the lead. Nothing has run.
   - What it buys: real footage for the shots tagged [needs the chain run] in docs/VIDEO.md, and maybe moving marks in docs/STORY.md up.
   - Re-cost, to be confirmed before launch: the audit estimates the r30b tune at about $1.39 on an A100 (42 to 48 minutes, from the lab's 40 of 40 run), plus about $2 on an A10 to requantize to IQ1_S for jetson-02, about $3.40 in all, which fits the $25 cap. Other parts: data $0.22, judging on Muse Wonder ($0.52 for the harness's 40-prompt Glimmer check), a build $0.30 to $1.80 on Contributor (about $4 on Wonder). No spend until the owner approves the new estimate.
   - The old backup, the Kaggle notebook on branch tg-kaggle-tune (O3), tunes Llama, so it is out. A backup is a second r30b tune on Lambda (about $1.39), or the stock IQ1_S already on jetson-02 labeled without "tuned".
3. **Read the `/privacy` and `/terms` draft, then turn on `TRUST_LEGAL_PAGES`.** About 40 minutes.
   - Read `lib/trust/terms.ts` (146 lines). It says it's a draft for the owner and counsel, not legal advice, dated Oct 31.
   - Send changes to the lead, or edit it yourself and bump `TERMS_VERSION` (signed-in builders are asked to accept a new version).
   - Turn it on: `printf '1' | vercel env add TRUST_LEGAL_PAGES production --force --scope "$VERCEL_SCOPE" && vercel redeploy https://muse-muse.vercel.app --scope "$VERCEL_SCOPE"`. Env changes need a new deployment.
   - Check `/privacy` and `/terms` signed out. With the flag off, both pages call `notFound()`, which is today's `/privacy` 404. The flag also gives new products their own privacy and terms pages.
4. **LICENSE: Apache-2.0, picked by the owner; the files are on branch tg-public-ready (Nov 2 night).** About 5 minutes left.
   - `LICENSE` (Apache License 2.0, "Copyright 2026 Offline Base"), `NOTICE`, and `"license": "Apache-2.0"` in package.json. `NOTICE` says what the license doesn't cover: `content/meta-docs/`, model files (Glimmer's terms, the Muse Model License for Muse Spark Open and its Derivatives), Meta's names and marks, and the third-party files in `app/fonts/`, `public/` and `template/`.
   - Fill the two placeholders in `NOTICE` before the flip: `[owner: who said so, and when]` (the Meta organizer who allowed the `content/meta-docs/` copy) and `[owner: how they were made, and their terms]` (the mascot in `public/muse/`).
5. **Change the fleet's ngrok domain, and confirm the rented GPU machines are terminated.** About 40 minutes, with Hussam. Both addresses stay in git history unless the rewrite in "Going public" runs, so do this either way.
   - ngrok: make a new domain in the ngrok dashboard. Hussam points jetson-05's tunnel at it through the fleet control plane. In the same restart, turn off the agent's request-body retention (PR #61). Set `BOARD_FLEET_URL` on production to the new domain and redeploy. Check `/device` signed out, then delete the old domain.
   - AWS: in the console for the knowledge run's account, check EC2 instances in us-east-1 and every other region used, plus SageMaker training jobs, endpoints and notebooks. Terminate anything still running. Delete storage nobody needs, because it bills too.
   - Lambda: check that the instance list is empty (PR #46 found it empty on Nov 2), and check persistent filesystems such as `muse-muse-cache-us-east-1`.
   - A terminated machine's address in history is harmless. A running one is exposed.
6. **Answer the training-data rights question.** About 30 minutes.
   - Read docs/DATA_RIGHTS.md (another branch is writing it Nov 2). It covers Meta Model API Terms 10.1(ix) and the training rows written by Muse Spark 1.3 Contributor.
   - Decide what may be shown and published. This decides whether the 7.93 vs 2.5 result goes in the submission, and which Hugging Face items on hold may stay up (to-do 7).
7. **Hugging Face visibility (PR #46).** About 30 minutes, after to-do 6.
   - Every OfflineBase repo now answers as public, including the 18 new ones, while their cards say private. Who changed it isn't known.
   - Read `docs/HUB_INVENTORY.md` on PR #46's branch (`tg-hub-inventory`). For each repo, pick public or private. Change it in the repo's Settings on huggingface.co, or fix its card to match.
   - On hold under Terms 10.1(ix), already up and public: 3 moss datasets, 3 moss and lab tunes, 1 lab tune whose writer is unknown, and the Moss IQ1_S. Then merge or close #46.
8. **Rotate keys.** The Lambda key was rotated Nov 2 (done). The others take about 45 minutes, before the repo goes public and again after the event. The Nov 2 history scan found no real secret in any commit, so this is hygiene, not a leak fix.
   - Services: Meta Model API, Lambda, Hugging Face, Vercel, the fleet control plane (`jik_`), ngrok, AWS, and Fireworks if a key was made for #51.
   - For each: make a new key in the service's dashboard, then put it where it's used. For Vercel production that's `vercel env add <NAME> production --force` and a redeploy; for the fleet, Hussam does it. Revoke the old key, then check the site still builds.
   - Never paste a value into chat, a doc or a commit. For the hero tune, the rotated Lambda key goes in `~/mm-wt/hero-tune/.env.local`.
9. **Production settings for judging.** About 15 minutes, plus a redeploy.
   - Contributor or Wonder: the switch is `BUILDS_ON_CONTRIBUTOR`, with the exact commands in docs/JUDGING_WEEK.md, "Flip to Wonder". First check that `BRIEF_MODEL`, `JUDGE_MODEL`, `BUILD_MODEL` and `COMPLEX_BUILD_MODEL` are `muse-wonder-1.0`. Wonder costs 40 times Contributor's input price and 100 times its output price. The plan was that whoever is awake flips judges to Wonder on Nov 4.
   - Daily cap: a `DAILY_SPEND_CAP_USD` of 0, empty or unset falls back to $100 (`number()` in `lib/env.ts`), so 0 does not turn spending off. Set the number you'll accept. A build on Wonder is about $4.
   - Judges share the guest account's `MAX_BUILDS_PER_USER_PER_DAY`. New visitors get 3 model starts per network per day (`trainer_ip_cap`). Raise them or not.
   - `STORY_PAGES` has to be on before recording (`/offline`, the longer `/private`). It's read at build time, so redeploy.
10. **Merge #63 when its checks pass.** About 5 minutes, owner or Hussam.
    - `gh pr checks 63 -R Offline-Base/muse-muse`, then merge on GitHub. `FLEET_PRODUCTS` stays off. Turning it on is a separate decision (see the table above).
11. **Hussam's Jetson shots.** About 1 to 2 hours, Hussam.
    - docs/VIDEO.md, shot 10: about 10 seconds of jetson-02 answering one short chat in real time, with its label.
    - Never a document task, never jetson-05, and no addresses, ngrok domain or fleet console in frame.
12. **The submission form.** About 30 minutes, Ethan, by noon ET Nov 4.
    - The portal (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit) needs a sign-in. docs/SUBMISSION.md, "The form, field by field", has every field in order with a ready-to-paste answer; fields tagged [owner] are yours, and those tagged [after the chain run] or [after the board take] change once those runs are logged.
    - **Team Members:** when the owner opened the form, only Hussam showed. Add Ethan too, so both are listed. Confirm Hussam's surname with Hussam.
    - **Most Viral:** an X post link. Post the 60-second cut (docs/VIDEO.md, "The 60-second X cut") before submitting, checked against docs/MESSAGING.md, "Don't say".
13. **The edge track: O1 to O8, answered Nov 2.** The full questions are in docs/EDGE_PLAN.md, "Owner decisions". Nothing spends or turns a flag on until the unit that needs it starts, and then only inside these caps.
    - O1, yes: reverse the Oct 31 "No Jetson or fleet endpoint in the Nov 4 demo" for an edge act in the video, keeping the Glimmer shot.
    - O2, yes, $25: the chain run on the cold-room sentence with M2's code-written rows, done by Tue 3 PM. The rotated Lambda key is in place.
    - O3, yes, changed: the backup tune was a free Kaggle notebook on branch tg-kaggle-tune. It tunes Llama, so it is out under the Nov 2 ruling. See to-do 2 for the Glimmer backup.
    - O4, yes, $5 of the $20 Contributor cap: `EDGE_BUILDS` and `EDGE_ENABLED` on a preview only, for 2 to 3 test builds.
    - O5, yes, changed by the Nov 2 ruling (owner question 1 below): the public Hugging Face repo will hold a Glimmer file, the tuned r30b IQ1_S, once M8 has one, not `Llama-3.2-3B-ColdRoom-Watch-GGUF`. Folder-row tunes can't be published to the Hub from the site (docs/CHAIN_RUN.md), so that file may be a hand upload.
    - O6, yes: the video re-cut in docs/VIDEO.md, "Proposed revision: the edge act".
    - O7, no, but it conflicts with the Nov 2 ruling (owner question 1 below): `deviceModelTarget` gives every device but a Jetson a small Llama today. The fix gives a Jetson one-bit Glimmer and other devices Glimmer or no model ("no Meta model fits this device"). Until then `QUANT_TARGETS` stays off.
    - O8, only if Hussam agrees: fallback level 2, which pulls the house uplink and takes jetson-05's tunnel and remote fleet access down during the take. Off until Hussam says yes.
14. **Merge the edge track (tg-edge) into main.** Owner or Hussam, before the repo goes public.
15. **Make the repo public.** About 1 hour, owner. See "Going public" below.
16. **Try Muse Muse in Meta's Muse app on Mac.** About 20 minutes, Ethan, only if the @Muse thread of Nov 2 (Muse on iOS, Android and Mac) checks out on a Meta page (docs/MESSAGING.md).
    - Add one live product's connector (`/api/mcp/<slug>`) and the Muse Privacy connector in the Muse app on Mac.
    - Run 3 prompts that use each. Record what worked and what didn't, with a screenshot, in docs/BUILD_LOG.md.
    - Until that's logged, don't say Muse Muse products work in the Muse app.

17. **Let hosted products call the boards (Nov 3).** About 10 minutes, owner, in `~/muse-muse`. Each `vercel env add` asks for the value; type it at the prompt, never in a chat or a file. Nothing here unsets anything.
    - SAM 3.1 on jetson-04 for products (`FLEET_SAM`, lib/caps/fleet/sam.ts):
      - `vercel env add BOARD_FLEET_URL production`: the control plane's https address ending in `/admin` (the value Preview's fleet-integration branch has). It also turns on the admin-only fleet card on /device and Wonder's read-only fleet tools in production.
      - `vercel env add BOARD_FLEET_TOKEN production`: an admin's `jpt_` token (exec is admin only). Best a dedicated one Hussam makes for this, so it can be revoked alone.
      - Recommended (Nov 3 review): leave `FLEET_SAM` off for judging. The admin token runs any command as root on every board, from a public app's env. The safer `jik_` route, proposed and not built, is in `scripts/edge/sam3/README.md`, "From a hosted product". If it goes on anyway, revoke the token the day judging ends.
      - `vercel env add FLEET_SAM_NODE production`: `nd_fe300e68e976228c` (jetson-04).
      - `vercel env add FLEET_SAM production`: `1`.
      - Then redeploy production (the next push to main does it). Check: an admin-owned edge product that looks with SAM, with `EDGE_FIRST=1` on that product's own Vercel project so the board goes first, shows "Seen on an office Jetson by Meta SAM 3.1". Products built before this deploy have the old `lib/meta/edge.ts`; a new edge build gets the new one. Each look spends about 10 to 25 of ngrok's 20,000 monthly requests.
    - One-bit Glimmer on jetson-02 for products (`FLEET_PRODUCTS`, since #63): `FLEET_PRODUCTS=1`, `FLEET_PRODUCTS_URL` (the same `/admin` address), `FLEET_PRODUCTS_KEY` (a `jik_` key from Hussam with `cloud_daily_limit` 0, H2) and `FLEET_PRODUCTS_MODEL=muse-glimmer-2026-iq1s-io-lowest`, each with `vercel env add <NAME> production`, plus a builder snapshot made from main so new builds get the helper. The board side ran Nov 3 through the control plane. Its answers are weak (docs/BUILD_LOG.md, Nov 3), so decide whether a judge should see them. `jetson-llama` on jetson-02 is started but not enabled: after a reboot, start it again through the fleet (`systemctl start jetson-llama`).

18. **Evaluate the overnight cold-room tune on Baseten and Modal (partner evals merged Nov 3 at 11:30; several partners per run on branch tg-e-partner-hosts, Nov 3 afternoon).** About 1.5 hours, owner, about $5 to $8 expected and about $13.30 at most. The owner says a partner prize is tied to this; its source is unconfirmed on the public pages (docs/SUBMISSION.md, "Lines left out"). Nothing of it has run. Steps and costs: docs/BUILD_LOG.md, Nov 3, "partner evals on several partners". In short: decide data rights Q2 for run ebad9aad, publish job 83ae46c8 privately (`HF_PUBLIC=0`), set `BASETEN_API_KEY`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `HOST_HF_TOKEN`, `HOST_TUNED=1` and `PARTNER_EVALS=baseten` on Production, then `POST /api/train/jobs/83ae46c8-4e57-4086-866c-da69a39a20d0/partner-eval` with `{"providers":["baseten","modal"]}`. Turn both flags off after. Fireworks can't take this job (r30b).

Also waiting, from the Nov 2 audit. None is approved or started, except that item 5's docs (SUBMISSION.md and the shot list) are drafted on tg-submission-kit.
- Hero tune: a longer Glimmer tune for redaction and private spreadsheet analysis, scored on the sealed test against base. Up to $300 of GPU. Was blocked on the rotated Lambda key, which is now in place; still not approved.
- "Own it" proof: download a real product and run it outside Muse Muse from its own instructions. $1 of Contributor.
- Judge path cleanup: recover the stranded tg-judges commit from 21:58, hide test products in the gallery without deleting them, and sort out the `/privacy` 404 (see to-do 3). Started on tg-public-ready: 8 products that look like the organizers' overdone list are hidden from the gallery lists (`lib/gallery/hidden.ts`), and dinner-split-helper goes first. Other test products are still listed.
- A real browser pass on the Make flows, plus building the six Discover starters. $5 of Contributor.
- Repo and submission ready: the CI failures, Docker, and the README's setup gaps from the Nov 2 clean-clone test (docs/SUBMISSION.md, "What the organizers said"). The secret scan of history ran Nov 2 (see "Going public").

Still open from before:
- **Gadget:** `DEVICE_MCP_URL` and `DEVICE_MCP_TOKEN` are unset in production, so the gadget isn't live there.
- **Prompt Guard 2 on jetson-05:** dropped. It is a Llama-family model, so don't fetch or enable it. Whether Hussam deletes `/opt/prompt-guard` and its unit waits on owner question 11 below.
- **Before quoting "0 leaks":** the "0 leaks on 300" and Oct 30 `device_only_fresh_200` numbers were measured with LFM3-VL-2B, so they are out of public copy. Quote only Glimmer runs: the Nov 2 rerun of `fresh_200_b` on today's defaults (0 leaks on 200 invented items, 71.5% decision accuracy, 101 approval requests, 50 needless; `privacy/eval/reports/glimmer_fresh_200_b_2026-11-02.md`, logged in privacy/docs/BUILD_LOG.md, owner-approved for the video), or the Oct 27 cloud run (0 leaks on 100).

## Open owner questions from the Meta-models audit

Nov 2 night, from the audit's fix plan. Yes or no each. Until answered, agents take the safe default: refuse, gate or hide, never delete.

1. Reverse O5 (the Llama cold-room Hugging Face repo) and O7 (keep `deviceModelTarget` as is)?
2. Run the chain run on r30b Glimmer with `TUNE_ANY_BASE` kept off?
3. Approve about $3.40 for the tuned cold-room Glimmer IQ1_S, only if Hussam's $0 schema gate passes?
4. Lift the "never jetson-02" rule for edge takes?
5. If the gate fails, accept a no-model, fixed-rule board fallback plus the shot-10 Glimmer clip as the edge act?
6. Muse Privacy's submission mode: Glimmer 30B on OpenRouter on invented data, with the "device-only" wording dropped?
7. If the Muse Privacy swap misses Tue 6 PM, cut Muse Privacy from the video and submission and take `privacy/` off the public branch?
8. Delete, rather than just flag off, the Llama, LFM, SpeechT5, EmbeddingGemma and Prompt Guard code before the repo goes public? **Answered yes (owner, Nov 2 night).** Done in part on branch tg-meta-only-tree (see "Meta-only tree" below); git history still shows it, which the owner accepted.
9. Drop read-aloud entirely, including the browser's own speech fallback?
10. Unset `BOARD_FLEET_URL` and `BOARD_FLEET_TOKEN` on production for judging, on top of the model allowlist? (Checked Nov 3: neither is set on production; both are on Preview for the `fleet-integration` branch only. The owner's Nov 3 rule: never unset them. To-do 17 adds them to production.)
11. Hussam deletes the Llama files on jetson-04 and Prompt Guard on jetson-05?
12. Send Cerebral Valley a one-line check that Glimmer on OpenRouter and a no-model fallback are fine?

## Meta-only tree (branch tg-meta-only-tree, Nov 2 night)

The owner decided to leave code that downloads, loads, trains, serves or calls non-Meta models out of the public tree. The branch's PR body has the full inventory.

- **Removed:** the Kaggle notebook (Llama 3.2 3B), the Jetson student chain in `scripts/knowledge/aws` (Nemotron Bolt and Gemma), `scripts/dev/receipt-eval-board.py` (#67's Llama adapter loader), the media cap's SpeechT5 read-aloud in `template/caps/media`, Llama adapter publishing in `lib/train` (a Llama-based job is now refused by `hubJobProblem`), and Prompt Guard in `privacy/`. The Llama harness results moved from `public/open-weights/` to `docs/log/open-weights/`, so the site no longer serves them.
- **Left, and why:**
  - Muse Privacy's LFM and EmbeddingGemma code (`privacy/base/config.py`, `local_llm.py`, `services.py`, `router.py`, `ui_app.py`, `scripts/start.sh`, `start_checker.sh`, `start_embedder.sh`, `bench_device.py`, `model_matrix.py`, `health.py`, `workspace/embed.py`, and about 15 tests that mock LFM). All of it is refused at load (`refuse_non_meta`). Removing it is about 30 files and moves the test suite's LFM mock to Glimmer, so it gets its own PR.
  - The board path, which is Hussam's: the drive's board-run export (a board's Llama 3.2 1B and the Llama license on a USB stick: `lib/drive/plan.ts`, `layout.ts`, `kit.ts`, `kit-files.json`, `scripts/drive-kit.ts`), `DEVICE_LLAMA_TRAINING` (`lib/env.ts`, `app/api/device/*`, `lib/device/agent.ts`, `components/device/DeviceTrain.tsx`) and `muse-device/`. Off behind `DRIVE_EXPORT_ENABLED` and `BOARD_TRAINING_OFF`; needs Hussam's yes.
  - Dead Llama branches that are unreachable now: the `FAMILIES` dict in `lib/train/recipes/glimmer.ts` (a golden-checked GPU recipe), `smallModelfile` in `lib/train/export/installers.ts`, the small-base branches behind the empty `QUANT_BASES`, and `licenseDuties`' Llama branch (kept so old Llama records stay labeled as Llama).
  - `native/lab`'s emulator runs whatever GGUF `pickSimTuneFile` (`lib/train/sim-tune.ts`) picks, with no Meta-name check. A one-line refusal there would close it.
  - `onnxruntime` and `tokenizers` in `privacy/pyproject.toml`, which only Prompt Guard used. Dropping them needs `uv lock` with the network.
  - The browser's own voice (`speechSynthesis` in the catalog's text-to-speech line, the glasses target, native `expo-speech`). It's the device's voice, not a model the project ships. Owner question 9.

## Going public

The organizers say judges work from the public repo, so it has to be public before Ethan submits. The plan below comes from a read-only scan of the whole history on Nov 2. The owner runs every command; no agent pushes, renames or changes visibility.

**What the scan found.** A fresh mirror: 1,494 commits (Oct 27 to Nov 2), 76 branches, 30 `refs/backup/*`, 69 `refs/pull/*`, 11,436 text blobs, plus commit messages and all PR and issue text. Regex scans only, since gitleaks and trufflehog aren't installed.
- **No real secrets** in any commit. Every token-shaped hit is a fake test string, and no `.env`, `.pem` or credentials file was ever committed.
- **Infrastructure detail worth scrubbing:** the AWS account id (ARNs, parameter paths, a bucket name), 5 EC2 instance ids, GPU machines' IPs, the fleet's ngrok admin domain (history only since #66, and the one that matters most, because it's the way in to the real boards), the Vercel team slug and preview hosts, and home-folder paths. PR #66 scrubbed the IPs and the ngrok host from the tree, but not the account id, 2 EC2 ids, the Vercel slug or the home paths. The ngrok host came back in scripts/edge/sam3 on Nov 3 and was scrubbed again on tg-p-demos: `FLEET_URL` is now required there, with a placeholder in its README.
- **Personal emails** in commit metadata (Ethan's and Hussam's Gmail). The other addresses are invented fixtures or upstream authors.

**Recommended: a fresh public repo with history rewritten by `git filter-repo`.**
- Clone only main, rewrite it with the replacement file, then push it to a new repo. No PR refs, backups or the 800 side-branch commits come along.
- `filter-repo` keeps author and committer dates, so the Oct 27 to Nov 2 timeline (all after the Oct 26 kickoff) stays provable. It rewrites short SHAs in commit messages too; SHAs quoted inside docs go stale.
- Keep the old repo private as provenance, and offer organizers read access if they ask. The PR pages are lost from the public copy.
- Not recommended: force-pushing a rewrite to the same repo (GitHub keeps all 69 `refs/pull/*`, so the old commits stay reachable), or squashing to one commit (it erases the evidence that the code was built during the event).
- Fallback if there's no time: publish as is after deleting the `refs/backup/*` refs and stale branches. Nothing needs rotating, but the account id, EC2 ids and ngrok domain stay visible, so first confirm the fleet admin behind ngrok requires its token, and change the ngrok domain (to-do 5).

**The files** are kept outside the repo, at `~/mm-wt/_plan/public-repo/`, and never committed:
- `replacements.txt`: the masked rules for `--replace-text`. A dry run found each rule matches exactly one distinct value with no collateral hits, and distinct originals map to distinct fakes.
- `scan-scripts/`: the scan and dry-run scripts.
- `check_history.md`: the full report, with the exact commands (install, clone, an optional author map for the emails, `filter-repo`, the verify greps, gitleaks, the rename and re-create, the visibility flip).

**Order, owner only:**
1. Merge tg-edge into main, and land the README fix, so the public copy has both.
2. Do to-dos 4 to 7 (LICENSE, ngrok domain and GPU machines, data rights, Hugging Face visibility).
3. Follow the commands in `~/mm-wt/_plan/public-repo/check_history.md`: install `git-filter-repo` and `gitleaks`, clone main alone into a new folder, run `filter-repo` with `replacements.txt`, then run the verify greps (every count must be 0), gitleaks over all history, and the one test that compares rewritten instance ids.
4. Rename the old repo to `muse-muse-dev`, create a new private `Offline-Base/muse-muse` from the rewritten clone, review it on GitHub, then make it public. The old name then points to the new repo, so README links keep working.
5. Check that the Vercel project is still linked (by repo id, to `muse-muse-dev`) and that production still deploys, and grep the setup docs for clone URLs a judge would use.

The single-branch clone is small (the full mirror was 60 MB), so it fits the laptop's disk.

## Waiting on Hussam: the edge track

Steps for each are in docs/EDGE_PLAN.md, "Hussam's asks". Under the Nov 2 ruling the edge model is Muse Glimmer 30B one-bit (IQ1_S) on jetson-02 (alias `muse-glimmer-2026-iq1s-io-lowest`), which needs the owner to lift "never jetson-02" for edge takes (owner question 4 below). Never jetson-05. Everything goes through the fleet control plane. Nothing below has run yet.

- **H1, replaced: the $0 schema gate on jetson-02, about 15 to 30 min.** Don't install Llama. Set `-c 2048` and prompt cache 0, desktop off, `muse-device` stopped. Rerun `receipt-bench.py` on 10 receipts with `response_format: json_schema` and `max_tokens` of about 400, and watch memory. Pass means valid JSON on 10 of 10, no hang and readable verdicts. If it passes, the cold-room Glimmer tune is planned (owner question 3). If it fails, the board fallback is fixed code, thresholds plus the probe-disagreement rule, with no model. Stop if it freezes once.
- **H2, about 0.5 h:** a `jik_` key with `cloud_daily_limit` 0, no `combo/` models and no `/v1/route`.
- **H3, Tue morning, about 1 h:** Node 20 on the drill board, confirm the USB-C device-link address, run M7's arm64 build there with EDGE_URL on loopback, check free memory with both running.
- **H4, Tue 3 to 5 PM, about 1 h:** install the tuned file, rerun the held-out set, report either way.
- **H5, Tue 7 to 9 PM, about 2 h:** two rehearsals and one take of the cut, no power cuts, nothing identifying in frame. Hard stop at 9 PM.
- **O8:** the owner allowed fallback level 2 (pulling the house uplink, which takes jetson-05's tunnel and remote fleet access down during the take) only if Hussam agrees. Say yes or no.
- **PR #67** (Hussam's on-board Llama 3.2 1B tune on jetson-04) is out of the submission: Llama isn't a Meta model here. Removing its files from jetson-04 waits on owner question 11. Bolt on jetson-03 and 04 can stay on the boards but never in frame.

## Fleet changes made Nov 2, through the fleet control plane

**jetson-02 (Hussam's test board).** LFM3-1.7B was replaced by Muse Muse's knowledge-run Glimmer.
- File: `/opt/jetson-gguf/models/muse-glimmer-stage-b-r30b-iq1s-io-lowest.gguf` (5.75 GB, from `OfflineBase/Muse-Glimmer-30B-2026-Knowledge-GGUF`).
- Service: `jetson-llama.service`, drop-in `/etc/systemd/system/jetson-llama.service.d/glimmer.conf`, llama.cpp b11970 on 127.0.0.1:11435, alias `muse-glimmer-2026-iq1s-io-lowest`.
- Settings that matter: `-c 4096 -np 1 -b 256 -ub 256 -ngl 999`. Also `--jinja --chat-template-file /opt/jetson-gguf/models/tuned-reasoning-off.jinja --reasoning-format none`; without these, chat fails with a "peg-native format" 500.
- Sampling: `--temp 0.2 --top-p 0.95 --top-k 64 --repeat-penalty 1.1 -n 128`, with `-r '<|eot|>' -r '<|end_of_text|>'` so the stop tokens don't print. Plus `--chat-template-kwargs '{"reasoning_strength":"low"}'`.
- Backups: `/root/jetson-llama.service.lfm3.bak` (the LFM3 unit) and `/root/glimmer.conf.bak`.
- Measured: 5 to 6 tokens a second, about 6.95 of 7.5 GB memory in use, about 400 MB of disk free, weak answers.
- On Hussam's 40-receipt bench (PR #62) it gave 0% valid JSON, and the board stopped answering at receipt 23 and needed a power cycle. It was back online by 10:20 AM.
- Treat it as a size demo, not a working model. It is a Derivative of Muse Spark Open: "Built with Muse Spark Open", 18 and over.
- Hussam's `muse-device` 0.3.0 still runs beside it on port 8765, with its C920 camera.

**jetson-05 (control plane).** Llama Prompt Guard 2 is staged in `/opt/prompt-guard` and is not running.
- What's there: a venv, `server.py` for 127.0.0.1:8770, and `prompt-guard.service`, which is disabled, starts only once `22M/config.json` exists, and is capped at 900 MB of memory.
- This broke the fleet's "keep jetson-05 out of experiments" rule, and the owner was told.
- To remove it, delete `/opt/prompt-guard` and the unit.

**Later Nov 2 (evening, ET), owner's go-ahead in chat.**
- jetson-02, 03, 04: `jetson-llama.service` stopped and disabled, so no model loads at boot. Bolt deleted on 03 and 04, Gemma's vision file on 04. Hussam's Llama 3.2 1B files on 04 were kept. jetson-02 still holds the Glimmer one-bit file.
- jetson-03 and 02: a separate session is setting up on-board LoRA training of Glimmer one-bit (Tether's QVAC llama.cpp fork, in `/opt/glimmer-train` on 03; file shares on 02's ports 8799 and 8800). Its own log covers it.
- jetson-04: SAM 3.1 (above). It is kept out of training while SAM runs.
- jetson-05: Prompt Guard removed (`/opt/prompt-guard` and its unit; it wasn't running). Hussam stopped LFM3-VL there at 5:58 PM ET. A different session is moving the control plane to the Raspberry Pi (`decision-tree`); the fleet was briefly unreachable at 6:35 PM ET.

## Fleet changes made Nov 3 (early morning ET), through the fleet control plane

Details and numbers: docs/BUILD_LOG.md, Nov 3. Nothing was deleted on a board, no board was rebooted, and no power mode changed.
- **jetson-02:** `jetson-llama.service` started with its existing Glimmer drop-in (`glimmer.conf`), **not enabled**, so it's gone after a reboot. `glimmer-guard` (a transient unit, `/run/glimmer-test/guard.sh`) kills it if available memory falls under 300 MB. Test notes and answers in `/run/glimmer-test/` (RAM, gone at reboot). Disk is still 191 MB free.
- **jetson-03:** new files only, about 70 MB: `/opt/sam3train/lib31/`, `/opt/sam3train/runs/muse31/` (the tuned SAM 3.1 delta, `muse31_delta_fp16.pt`, 61 MB), `/opt/sam3train/runs/nov3/` (scores), `/opt/sam3train/run_nov3.sh`, `configs/muse/muse31.yaml` in the sam3 clone.
- **jetson-04:** `sam3.service` restarted at 3:28 AM ET (about 1 minute down, 57 s to load) with the Nov 3 `server.py` (the Nov 2 one kept as `/opt/sam3/server.py.nov2`) and a drop-in, `/etc/systemd/system/sam3.service.d/tuned.conf`, that adds `--tuned muse=/opt/sam3/model/muse31_delta_fp16.pt` (61 MB, sha256 `737e8506...`). Meta's weights stay the default; GPU memory at rest went from 3,425 to 3,525 MB. Undo steps are in the drop-in. Also new: `/opt/sam3/muse-heldout/` (3 held-out images and `ask_muse.py`, 170 KB). It still listens only on the office address. The temporary SAM 3.1 tensor share (`sam31-share`, port 8797) was stopped after the tune.

**Disk candidates for Hussam to delete (his call; nothing was deleted):**
- jetson-02 (191 MB free): `/home/jetson-02/train/venv` (4.4 GB) and `/home/jetson-02/train/models` (1.7 GB, Qwen3.5 0.8B, not Meta), `/home/jetson-02/models/Qwen3.5-0.8B-Q4_K_M.gguf` (508 MB, not Meta), the four 13 MB adapters beside it, and `/opt/jetson-gguf/b11574` (182 MB; jetson-llama runs b11970). `sudo rm -rf <path>`; the journal is 125 MB (`sudo journalctl --vacuum-size=50M`).
- jetson-03 (about 500 MB free): `/var/backups/ollama-embeddinggemma2` (2.1 GB, an EmbeddingGemma backup, not Meta), `/opt/jetson-gguf/b11574` (868 MB, nothing runs it there), `/opt/sam3train/runs/muse1/checkpoints/checkpoint.pt` (349 MB: SAM 3 `muse1` with its optimizer state; its scores are logged), journal 590 MB.
- jetson-04 (about 2.4 GB free): `/opt/jetson-gguf/models/Llama-3.2-1B-Instruct-Q8_0.gguf` and `...-receipts-lora.gguf` (1.34 GB, Llama, owner question 11), journal 418 MB.

Everything on the boards goes through the fleet control plane, never SSH from the laptop.

## Gotchas

- **Previews act as admin.** Preview's environment has an `OPEN_ACCESS` that behaves as admin, so a Preview can't test guest rules: a no-code start returned 201 there. Test guest rules in unit tests or on production.
- **Preview deploys:** pass each switch with `-e` and `-b`, and reach the Preview with `vercel curl`.
- **`.env.local`:** `vercel link` writes a new `.env.local`. Delete it without reading it, then `git checkout .gitignore`. Never `vercel env pull` over `.env.local`.
- **Blocked deploys:** Vercel refuses to deploy a commit whose author isn't on the Vercel team. Hussam's #56 deploy was blocked, and later main deploys replaced it.
- **CI:** #65 (merged Nov 2) fixed the unit tests main already failed, so a red check on a PR is now its own. On Windows, line endings add failures in the brief goldens, `privacy-boundary` and the caps flags-off tests. Typecheck passes.
- **Running tests:**
  - Command: `npx tsx --experimental-test-module-mocks --test <files>`, only for the code you touched.
  - The real-route PGlite test is `lib/train/tune/__tests__/open-train.test.ts`.
  - Regenerate goldens with `TUNE_GOLDEN_WRITE=1` or `MAKE_GOLDEN_WRITE=1`, from a clean tree.
- **Not in CI:** `.tsx` tests outside `components/train/` don't run in CI. `components/models/__tests__/models-page.test.tsx` fails one case on main ("shows accuracy for a decide-kind tuned model", the 78 of 78 line is missing) and nobody has fixed it yet.
- **Judge-path checker:** `node scripts/judge-check.mjs` walks the live site with GETs only and writes a report. Rerun it after each deploy. It also opens each product on `HIDDEN_FROM_GALLERY` by its own page and flags one that shows in the gallery.
- **Hiding a product from the gallery:** add its slug to `HIDDEN_FROM_GALLERY` in `lib/gallery/hidden.ts`. It leaves the Gallery, the Make page's featured row, the dashboard's connector picks and `/vr`, and keeps its page, live link and connector. `GALLERY_FIRST` in the same file puts products first. `/gadgets` (Hussam's) still lists every gadget product. A hidden product drops out on the next deploy; nothing in the database changes.
- **Company name:** the story tests still keep it out of the privacy paragraph and `/private`, though the owner lifted that rule on Nov 1.
- **ngrok's free plan** allows 20,000 requests a month across the fleet.
- **This laptop:**
  - Run about 3 heavy jobs at once at most, and keep 6 GB of disk free. On Nov 2 evening it had about 8 to 14 GB free, so don't `npm install`, clone or download anything large. New worktrees link `node_modules` from `~/mm-wt/messaging` (`ln -s`) instead of installing.
  - Idle worktrees had `node_modules` and `.next` removed on Nov 2. Use `cp -cR` from another worktree when one needs them back.
  - Never run Glimmer here.
