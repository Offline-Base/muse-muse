# Handoff

Where Muse Muse stands, for whoever picks it up next. Last written Nov 2, 2026, 10:24 AM ET. The PR list and owner to-dos were updated at midday on tg-submission-kit, and again in the evening on tg-submission-fields (the owner's edge answers, the going-public plan, the real form). Updated Nov 2 night on tg-mo-copy-public for the Meta-models-only ruling: O3, O5, O7, #67, to-do 2, to-do 4, H1, Prompt Guard, and the owner questions from the audit.

Change a line here when its fact changes. History goes in docs/BUILD_LOG.md.

## Now

- **Meta models only (organizer ruling, Nov 2, 3:57 PM; docs/MESSAGING.md, "What the rules say").** Llama does not count as a Meta model here, and every model the project calls at runtime must be Meta's. Until the fix plan from the Nov 2 audit lands, this overrides every line below that names Llama, LFM, Bolt or Prompt Guard:
  - Don't run the Kaggle notebook (it tunes Llama 3.2 3B), and don't start a Llama tune on the site. `TUNE_ANY_BASE` stays off.
  - The chain run (to-do 2) is on hold until it's re-costed on the default Glimmer base.
  - O5's Hugging Face repo will hold a Glimmer file, not `Llama-3.2-3B-ColdRoom-Watch-GGUF`.
  - The edge board model, Muse Privacy's device model (LFM3-VL-2B), #67's Llama 3.2 1B on jetson-04, Bolt on jetson-03 and 04, and Prompt Guard on jetson-05 all need a Meta model or must stay off in the demo.
- **Edge direction: SAM 3.1 on the boards (owner, Nov 2, about 8 PM ET).** Meta's SAM 3.1 runs as `sam3.service` on jetson-04 (`192.168.12.144:8790`, office network) and a laptop page calls it through the fleet (`scripts/edge/sam3/`, README there). The owner said this is the direction. docs/EDGE_PLAN.md, "Direction: SAM 3.1 on the boards", has what runs, what doesn't and what may be said.
- **Merged Nov 2 afternoon:** #67 (3:31 PM ET), #63, #68 (the edge track, 3:40 PM, deployed at `ee493e69`) and #69 (Learn, 4:07 PM). The tg-edge rows in the tables below are now on main.
- **Production** ran main at PR #59 (`12a362a1`) as of midday, with the Make chat on (`MAKE_CHAT_ALL`). Vercel blocked the deploys of #60, #61 and #62 because Hussam's commits aren't from a Vercel team member (checked Nov 2 from GitHub's commit statuses). #66, authored by Ethan, merged at 2:09 PM ET and should deploy all of main, theirs included; check its deploy on Vercel, since this file hasn't.
- **Deadline:** due Nov 4, 9 PM ET, and Ethan submits by noon ET. Whoever is awake switches judges to Muse Wonder on Nov 4.
- **What we can say in public:** docs/MESSAGING.md (outside quotes, each marked checked or not, what the rules say, and what not to say). Then the marks in docs/STORY.md and docs/PROVE_RESULTS.md.
- **Submission kit:** docs/SUBMISSION.md has every form field in order with a ready-to-paste answer and its source, the organizers' Nov 2 guidance, the Most Viral X post, and the edge and defense story as a headline beside frontier. The video script and shot list are in docs/VIDEO.md.
- **What the organizers said, Nov 2:** "Judges mainly work from your 3-minute demo video and your public GitHub repo, so the video is the core of the demo. Judges may also try the project themselves, using their own keys if needed, so the repo must run from its setup instructions. A hosted demo is optional." So the repo has to go public (see "Going public") and the README's setup has to work for a judge (docs/SUBMISSION.md, "What the organizers said").
- **Edge track (Nov 2):** a simulated cold-room watcher that is built so it keeps answering on a Jetson when the cloud is cut. The owner wants it as a headline beside frontier: defending infrastructure and being ready for any scenario. On `e4beadc1` (branch tg-edge, not merged to main) M1 to M6, M13 and M14's `MEASURED` half are built and unit-tested; nothing has run in a real build or on a board. The owner answered O1 to O8 (below). Units, Hussam's asks H1 to H5, the clock and when each claim may be said: docs/EDGE_PLAN.md. All flags off.
- **Modal as a second build host (Nov 2, branch tg-modal):** behind `SANDBOX_HOST=modal`, off by default, so builds stay on Vercel Sandbox. The Modal host passed a live smoke test; no Muse Code build has run on Modal and its builder image isn't made yet. To turn it on, the env names, and the security gaps: docs/MODAL_HOST.md.

## Open PRs, Nov 2 evening

Nobody but the owner or Hussam merges. Hussam's PRs all say "Don't merge until told". Merged since the morning: #59, #60, #61, #62, #64, #65 (it fixed the unit tests main already failed) and #66 (set up for judging with no spend, 2:09 PM ET).

| PR | Who | What | State |
|---|---|---|---|
| #63 | Hussam | A product can answer from the Jetson fleet, behind `FLEET_PRODUCTS` | Open. Turning the flag on needs a new builder snapshot, the owner's model choice, a `jik_` key and a total cap. Checks pass and it's up to date with main (Nov 2, 1 PM) |
| #67 | Hussam | Fine-tune Llama 3.2 1B on jetson-04 itself to read invented receipts, and serve it through the fleet and #63's product route | Merged Nov 2, 3:31 PM ET. Llama is not a Meta model here, so #67 is dropped from the submission and its numbers never go in public copy. Hussam removes the Llama files on jetson-04 (the 1B GGUF, the adapter and the drop-in, plus any Llama-3.2-3B), pending owner question 11 below. One fact stays useful: llama.cpp `--lora` over a GGUF base works on these boards |
| tg-edge | Ethan (Claude) | The edge track at `e4beadc1`: fallback, drills, edge target, board build, drill data, docs | Branch only, no PR yet. Merge before the repo goes public, or the edge lines have no code behind them |
| #54 | Ethan (Claude) | Hero tune: sealed test and tooling | Draft, blocked before training |
| #46 | Ethan (Claude) | Hugging Face inventory | Open. Found every OfflineBase repo answering as public (owner to-do 7) |

## Waiting on the owner

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
4. **Pick a LICENSE.** About 10 minutes to choose; the lead adds the file in a PR.
   - The repo has none. The Official Rules allow open source "provided applicable open source licenses are followed", and the entrant keeps ownership while granting the organizers a license to use the submission (docs/MESSAGING.md, "What the rules say").
   - Choices: MIT, Apache-2.0 (adds a patent grant), or no license, which leaves a public repo readable but not reusable.
   - Whatever you pick, say what it doesn't cover: `content/meta-docs/` is Meta's text, `privacy/` comes from another repo, and model files carry their own terms (Muse Glimmer's, and Muse Spark Open's for r30b, a Derivative of it).
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

Also waiting, from the Nov 2 audit. None is approved or started, except that item 5's docs (SUBMISSION.md and the shot list) are drafted on tg-submission-kit.
- Hero tune: a longer Glimmer tune for redaction and private spreadsheet analysis, scored on the sealed test against base. Up to $300 of GPU. Was blocked on the rotated Lambda key, which is now in place; still not approved.
- "Own it" proof: download a real product and run it outside Muse Muse from its own instructions. $1 of Contributor.
- Judge path cleanup: recover the stranded tg-judges commit from 21:58, hide test products in the gallery without deleting them, and sort out the `/privacy` 404 (see to-do 3).
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
8. Delete, rather than just flag off, the Llama, LFM, SpeechT5, EmbeddingGemma and Prompt Guard code before the repo goes public?
9. Drop read-aloud entirely, including the browser's own speech fallback?
10. Unset `BOARD_FLEET_URL` and `BOARD_FLEET_TOKEN` on production for judging, on top of the model allowlist?
11. Hussam deletes the Llama files on jetson-04 and Prompt Guard on jetson-05?
12. Send Cerebral Valley a one-line check that Glimmer on OpenRouter and a no-model fallback are fine?

## Going public

The organizers say judges work from the public repo, so it has to be public before Ethan submits. The plan below comes from a read-only scan of the whole history on Nov 2. The owner runs every command; no agent pushes, renames or changes visibility.

**What the scan found.** A fresh mirror: 1,494 commits (Oct 27 to Nov 2), 76 branches, 30 `refs/backup/*`, 69 `refs/pull/*`, 11,436 text blobs, plus commit messages and all PR and issue text. Regex scans only, since gitleaks and trufflehog aren't installed.
- **No real secrets** in any commit. Every token-shaped hit is a fake test string, and no `.env`, `.pem` or credentials file was ever committed.
- **Infrastructure detail worth scrubbing:** the AWS account id (ARNs, parameter paths, a bucket name), 5 EC2 instance ids, GPU machines' IPs, the fleet's ngrok admin domain (history only since #66, and the one that matters most, because it's the way in to the real boards), the Vercel team slug and preview hosts, and home-folder paths. PR #66 scrubbed the IPs and the ngrok host from the tree, but not the account id, 2 EC2 ids, the Vercel slug or the home paths.
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
- **Judge-path checker:** `node scripts/judge-check.mjs` walks the live site with GETs only and writes a report. Rerun it after each deploy.
- **Company name:** the story tests still keep it out of the privacy paragraph and `/private`, though the owner lifted that rule on Nov 1.
- **ngrok's free plan** allows 20,000 requests a month across the fleet.
- **This laptop:**
  - Run about 3 heavy jobs at once at most, and keep 6 GB of disk free. On Nov 2 evening it had about 8 to 14 GB free, so don't `npm install`, clone or download anything large. New worktrees link `node_modules` from `~/mm-wt/messaging` (`ln -s`) instead of installing.
  - Idle worktrees had `node_modules` and `.next` removed on Nov 2. Use `cp -cR` from another worktree when one needs them back.
  - Never run Glimmer here.
