# Handoff

Where Muse Muse stands, for whoever picks it up next. Last written Nov 2, 2026, 10:24 AM ET.

Change a line here when its fact changes. History goes in docs/BUILD_LOG.md.

## Now

- **Production** runs main at PR #58 (`492975dd`), with the Make chat on (`MAKE_CHAT_ALL`).
- **Deadline:** due Nov 4, 9 PM ET, and Ethan submits by noon ET. Whoever is awake switches judges to Muse Wonder on Nov 4.
- **What we can say in public:** docs/MESSAGING.md (outside quotes, each marked checked or not, and what not to say). Then the marks in docs/STORY.md and docs/PROVE_RESULTS.md.

## Open PRs, Nov 2 morning

Nobody but the owner or Hussam merges. Hussam's PRs all say "Don't merge until told".

| PR | Who | What | State |
|---|---|---|---|
| #64 | Ethan (Claude) | docs/MESSAGING.md, this file, root CLAUDE.md, stale lines fixed | Docs plus one `/offline` sentence |
| #63 | Hussam | A product can answer from the Jetson fleet, behind `FLEET_PRODUCTS` | Needs a new builder snapshot, the owner's model choice, a `jik_` key and a total cap |
| #62 | Hussam | Receipt bench on the boards' models | Bolt 88% of fields, LFM3-VL 82%, jetson-02 Glimmer 0% valid JSON, and the board hung |
| #61 | Hussam | Who can read the text on each way Muse Muse reaches a model on hardware | Found that jetson-05's ngrok agent keeps request bodies; lists stale "private" copy |
| #60 | Hussam | The fleet on `/device`, and read-only fleet tools for Wonder | Conflicts with main |
| #59 | Ethan (Claude) | A plan checklist in the build and train rooms | Waiting to merge |
| #54 | Ethan (Claude) | Hero tune: sealed test and tooling | Draft, blocked before training |
| #46 | Ethan (Claude) | Hugging Face inventory | Open |

## Waiting on the owner

- **The five overnight items** from the Nov 2 audit. None is approved or started.
  1. Hero tune: a longer Glimmer tune for redaction and private spreadsheet analysis, scored on the sealed test against base. Up to $300 of GPU.
  2. "Own it" proof: download a real product and run it outside Muse Muse from its own instructions. $1 of Contributor.
  3. Judge path cleanup: recover the stranded tg-judges commit from 21:58, hide test products in the gallery without deleting them, and sort out the `/privacy` 404.
  4. A real browser pass on the Make flows, plus building the six Discover starters. $5 of Contributor.
  5. Repo and submission ready: the CI failures, a secret scan, a rewrite of docs/SUBMISSION.md from the owner's answers, Docker, and the shot list.
- **Lambda key:** the owner puts a rotated key in `~/mm-wt/hero-tune/.env.local`. This blocks item 1.
- **Terms 10.1(ix):** the owner reads it on training rows written by Muse Spark 1.3 Contributor, since it bears on the 7.93 vs 2.5 result.
- **Judging-week limits:** new visitors get 3 model starts per network per day (`trainer_ip_cap`). Raise it or not.
- **Gadget:** `DEVICE_MCP_URL` and `DEVICE_MCP_TOKEN` are unset in production, so the gadget isn't live there.
- **Keys:** rotate the fleet, Lambda, Hugging Face and Meta keys before the repo goes public.
- **Prompt Guard 2 on jetson-05:** accept Meta's license on Hugging Face, then run `/opt/prompt-guard/fetch.sh` on the board.
- **ngrok on jetson-05** keeps recent request bodies in memory (PR #61). Turning that off needs a tunnel restart.
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
- **CI:** unit tests already fail on main, 7 tests, the same on every PR. On Windows, line endings add failures in the brief goldens, `privacy-boundary` and the caps flags-off tests. Typecheck passes.
- **Running tests:**
  - Command: `npx tsx --experimental-test-module-mocks --test <files>`, only for the code you touched.
  - The real-route PGlite test is `lib/train/tune/__tests__/open-train.test.ts`.
  - Regenerate goldens with `TUNE_GOLDEN_WRITE=1` or `MAKE_GOLDEN_WRITE=1`, from a clean tree.
- **Company name:** the story tests still keep it out of the privacy paragraph and `/private`, though the owner lifted that rule on Nov 1.
- **ngrok's free plan** allows 20,000 requests a month across the fleet.
- **This laptop:**
  - Run about 3 heavy jobs at once at most, and keep 6 GB of disk free.
  - Idle worktrees had `node_modules` and `.next` removed on Nov 2. Use `cp -cR` from another worktree when one needs them back.
  - Never run Glimmer here.
