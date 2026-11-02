# Handoff

Where Muse Muse stands, for whoever picks it up next. Last written Nov 2, 2026, 10:24 AM ET. The PR list and owner to-dos were updated at midday on tg-submission-kit.

Change a line here when its fact changes. History goes in docs/BUILD_LOG.md.

## Now

- **Production** runs main at PR #59 (`12a362a1`), with the Make chat on (`MAKE_CHAT_ALL`). Vercel blocked the deploys of #60, #61 and #62 because Hussam's commits aren't from a Vercel team member (checked Nov 2 from GitHub's commit statuses). The next merge authored by Ethan deploys all of main, theirs included.
- **Deadline:** due Nov 4, 9 PM ET, and Ethan submits by noon ET. Whoever is awake switches judges to Muse Wonder on Nov 4.
- **What we can say in public:** docs/MESSAGING.md (outside quotes, each marked checked or not, what the rules say, and what not to say). Then the marks in docs/STORY.md and docs/PROVE_RESULTS.md.
- **Submission kit:** the draft write-up and form answers in docs/SUBMISSION.md, the video script and shot list in docs/VIDEO.md.

## Open PRs, Nov 2 midday

Nobody but the owner or Hussam merges. Hussam's PRs all say "Don't merge until told". Merged since the morning: #59, #60, #61, #62, #64 and #65 (#65 fixed the unit tests main already failed).

| PR | Who | What | State |
|---|---|---|---|
| #63 | Hussam | A product can answer from the Jetson fleet, behind `FLEET_PRODUCTS` | Open. Turning the flag on needs a new builder snapshot, the owner's model choice, a `jik_` key and a total cap. Checks pass and it's up to date with main (Nov 2, 1 PM) |
| this PR | Ethan (Claude) | Set up for judging with no spend: judge path, copy and scrub, Muse Privacy proof, general and safety checks (off), submission kit, data rights, judge-path checker | Open. Merging it also deploys #60 to #62 |
| #54 | Ethan (Claude) | Hero tune: sealed test and tooling | Draft, blocked before training |
| #46 | Ethan (Claude) | Hugging Face inventory | Open. Found every OfflineBase repo answering as public (owner to-do 7) |

## Waiting on the owner

In order. To-do 1 decides 2 and 10. To-do 2 has to finish by Nov 3 afternoon, or the video uses its fallbacks. To-dos 4 to 8 must be done before the repo goes public. Times are estimates.

1. **Pick the demo story.** About 15 minutes, Ethan and Hussam.
   - Read docs/VIDEO.md. It recommends three acts: one sentence to a model and an app, Muse Privacy, then about 10 seconds of the Jetson. The inspo-first script it replaced is at `git show e290545d:docs/SUBMISSION.md`.
   - Reply "recommended" or "inspo-first", plus any changes. Then whoever is working takes "DRAFT" off docs/VIDEO.md and docs/SUBMISSION.md.
2. **Approve, or skip, the spend for one end-to-end chain run.** 5 minutes to decide. The run itself takes about 1 to 2 hours, by the lead.
   - What it buys: real footage for the shots tagged [needs the chain run] in docs/VIDEO.md, and maybe moving marks in docs/STORY.md up.
   - What the parts cost when run separately: data $0.22, a small Llama tune about 18 minutes on a Lambda A10, a blind judge $1.54 on Muse Wonder, a Glimmer tune $1.39 plus judging, a build $0.30 to $1.80 on Contributor (about $4 on Wonder).
   - Reply with a cap and a model. Estimate: about $25 on the small Llama leaves room for one retry. A rotated Lambda key has to be in place first (to-do 8).
3. **Read the `/privacy` and `/terms` draft, then turn on `TRUST_LEGAL_PAGES`.** About 40 minutes.
   - Read `lib/trust/terms.ts` (146 lines). It says it's a draft for the owner and counsel, not legal advice, dated Oct 31.
   - Send changes to the lead, or edit it yourself and bump `TERMS_VERSION` (signed-in builders are asked to accept a new version).
   - Turn it on: `printf '1' | vercel env add TRUST_LEGAL_PAGES production --force --scope ethan-6436s-projects && vercel redeploy https://muse-muse.vercel.app --scope ethan-6436s-projects`. Env changes need a new deployment.
   - Check `/privacy` and `/terms` signed out. With the flag off, both pages call `notFound()`, which is today's `/privacy` 404. The flag also gives new products their own privacy and terms pages.
4. **Pick a LICENSE.** About 10 minutes to choose; the lead adds the file in a PR.
   - The repo has none. The Official Rules allow open source "provided applicable open source licenses are followed", and the entrant keeps ownership while granting the organizers a license to use the submission (docs/MESSAGING.md, "What the rules say").
   - Choices: MIT, Apache-2.0 (adds a patent grant), or no license, which leaves a public repo readable but not reusable.
   - Whatever you pick, say what it doesn't cover: `content/meta-docs/` is Meta's text, `privacy/` comes from another repo, and model files carry Muse Spark Open's and Llama's own terms.
5. **Change the fleet's ngrok domain, and confirm the rented GPU machines are terminated.** About 40 minutes, with Hussam. Both addresses stay in git history, so they will be public with the repo.
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
8. **Rotate keys.** About 45 minutes, before the repo goes public and again after the event.
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
    - The portal (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit) needs a sign-in, and its fields aren't published.
    - Open it early, compare it with docs/SUBMISSION.md section 1, and add any field that's missing. The Representative names every team member.

Also waiting, from the Nov 2 audit. None is approved or started, except that item 5's docs (SUBMISSION.md and the shot list) are drafted on tg-submission-kit.
- Hero tune: a longer Glimmer tune for redaction and private spreadsheet analysis, scored on the sealed test against base. Up to $300 of GPU. Blocked on the rotated Lambda key.
- "Own it" proof: download a real product and run it outside Muse Muse from its own instructions. $1 of Contributor.
- Judge path cleanup: recover the stranded tg-judges commit from 21:58, hide test products in the gallery without deleting them, and sort out the `/privacy` 404 (see to-do 3).
- A real browser pass on the Make flows, plus building the six Discover starters. $5 of Contributor.
- Repo and submission ready: the CI failures, a secret scan, Docker.

Still open from before:
- **Gadget:** `DEVICE_MCP_URL` and `DEVICE_MCP_TOKEN` are unset in production, so the gadget isn't live there.
- **Prompt Guard 2 on jetson-05:** accept Meta's license on Hugging Face, then run `/opt/prompt-guard/fetch.sh` on the board.
- **Before quoting "0 leaks":** rerun `device_only_fresh_200` (Oct 30, 10 leaks, no cause recorded) or say both numbers.

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
  - Run about 3 heavy jobs at once at most, and keep 6 GB of disk free.
  - Idle worktrees had `node_modules` and `.next` removed on Nov 2. Use `cp -cR` from another worktree when one needs them back.
  - Never run Glimmer here.
