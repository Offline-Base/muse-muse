# Owner runbook: Nov 3 afternoon to the Nov 4 submission

One list, in order, for Ethan (and Hussam where named). Written Nov 3, about 12:30 PM ET, on branch tg-e-runbook. Nothing in it has been run by an agent: no build, snapshot, GPU, deploy, Hugging Face write or env change. Every env name below was checked against `lib/env.ts` and the code that reads it, and every command against `package.json` and the script it calls.

The owner's Nov 3 direction answers set the scope: snapshot now, native packaging on and shown if it works, guest cap 25, fleet env on for filming only, partner hosting, a public Hugging Face page, the whole cookbook set, the four rebuilds, a filmed Spark Open GPU take, $100 spend cap through Nov 4, Muse Wonder for judging on Nov 4, code freeze Nov 4 8 AM ET, Ethan submits by 11:30 AM ET.

## How to read the commands

- Every command is one line. Run them in the order given, from the folder named in step 0.
- Nothing secret is ever written in a command. Where a value is needed, the command asks for it and you type or paste it at the prompt. `vercel env add NAME production --force ...` asks "What's the value of NAME?".
- Env changes on Vercel reach only a new deployment. Each block below ends with the one deploy that picks it up.
- `VERCEL_SCOPE` is the team slug from the project's Vercel dashboard URL. It stays out of the repo on purpose, so it is typed once per terminal in step 0.
- Times are ET. Costs are list-price estimates unless the build log has a measured number, which is named.

## 0. Set up one terminal (12:30 PM, 2 min, $0)

`~/mm-wt/overnight` has `.env.local` (the owner's), a Vercel link, `node_modules`, and no local changes (checked at 12:25 PM). It sits on an old detached commit, so move it to today's main first.

```
cd ~/mm-wt/overnight && git fetch -q origin && git checkout -q --detach origin/main && git log --oneline -1
```

```
read -r VERCEL_SCOPE
```

```
read -rs AUTOMATION_SECRET
```

Paste the automation secret (the same value as Production's `AUTOMATION_SECRET`) at the second prompt. It is only used by the `curl` lines below, as a header. `gh auth status` must show Ethan-Castro for the repo steps in section 11.

Check which names Production has (names only, no values):

```
vercel env ls production --scope "$VERCEL_SCOPE"
```

## 1. Builder snapshot (12:35 to 1:05 PM, 15 to 30 min, Vercel Sandbox time only)

Template changes from both overnight fix rounds and today's merges reach builds only through a new snapshot (63 template files changed since the last one). No Meta spend.

```
npm run snapshot
```

- It ends with `BUILDER_SNAPSHOT_ID=snap_...` and a line telling you to commit `lib/sandbox/snapshots.json`. Copy the id.
- If it fails on Sandbox credentials, stop. Don't `vercel env pull` over `.env.local`.

While it runs, do step 2a in a second terminal (also from `~/mm-wt/overnight`).

Set the id on Production and on Preview (Hussam's rover Preview builds from it too). Paste the id at each prompt; for Preview, leave the branch empty so it applies to all.

```
vercel env add BUILDER_SNAPSHOT_ID production --force --scope "$VERCEL_SCOPE"
```

```
vercel env add BUILDER_SNAPSHOT_ID preview --force --scope "$VERCEL_SCOPE"
```

Commit the manifest now, but push it in step 5, so one deploy picks up every env change below.

```
git add lib/sandbox/snapshots.json && git commit -q -m "Builder snapshot for the Nov 3 filming builds" && git log --oneline -1
```

## 2. Native packaging (1:05 to 1:20 PM, about 15 min, a few cents of Sandbox time)

From docs/NATIVE_READY.md. No EAS or Electron build is needed if 2a passes.

**2a. Check the Oct 31 packager snapshot still works (5 min).** The env prefix wins over `.env.local` (Node's env file never overrides a set variable).

```
PACKAGER_SNAPSHOT_ID=snap_VcblDXLuhpigJ8ZeukmR38j2PupJ npx tsx --env-file-if-exists=.env.local scripts/native/package-product.ts --name "Fern & Moss" --url https://example.com/ --kinds android --out .data/native-check --delete
```

- Pass: `android: made in ... s`, a size and signing line, then `sandbox deleted`.
- Fail ("snapshot not found" or a checksum mismatch): skip the rest of section 2 and say "is built so" for phone and desktop apps. The fallback (docs/NATIVE_READY.md steps 4 to 6) takes 1 to 1.5 hours, mostly the EAS queue, and doesn't fit today.

**2b. Turn it on (only if 2a passed).** Type `snap_VcblDXLuhpigJ8ZeukmR38j2PupJ`, then `phone,desktop`.

```
vercel env add PACKAGER_SNAPSHOT_ID production --force --scope "$VERCEL_SCOPE"
```

```
vercel env add NATIVE_TARGETS production --force --scope "$VERCEL_SCOPE"
```

- With both set, phone and desktop are offered to every new build, guests' included, and each such build packages its apps (a few cents of Sandbox time each, plus Blob storage).
- The real Android signing key (`NATIVE_APK_KEYSTORE_B64`) is optional; without it APKs carry the repack tool's debug key. docs/NATIVE_READY.md step 3 if wanted.

The aisle-together repackage waits for the deploy: step 6.

## 3. Judge-facing limits (1:20 PM, 5 min, $0)

| Name (checked) | Type | Why |
|---|---|---|
| `MAX_BUILDS_PER_USER_PER_DAY` | `25` | The guest build cap. It is the only build quota: every non-admin, per rolling 24 hours, read on every check (`lib/quota.ts`). All guests are one shared account, so 25 is the total for every judge and visitor together. `0` means the default of 3. |
| `STORY_PAGES` | `1` | `/offline`, the clearer `/private` and the frontier section on /how-it-works. Read at build time. |
| `DAILY_SPEND_CAP_USD` | today's total on www.musemuse.dev/usage plus 20, rounded up | Platform-wide, per UTC day (Nov 3's ends 7 PM ET). See the spend table. `0` is read as unset and falls back to 100, so the emergency stop is `0.01`. |

First open www.musemuse.dev/usage signed in and read today's total (the UTC day began 7 PM ET Nov 2, so it includes the overnight batch and tunes). Then:

```
vercel env add MAX_BUILDS_PER_USER_PER_DAY production --force --scope "$VERCEL_SCOPE"
```

```
vercel env add STORY_PAGES production --force --scope "$VERCEL_SCOPE"
```

```
vercel env add DAILY_SPEND_CAP_USD production --force --scope "$VERCEL_SCOPE"
```

What the cap covers: everything the site records in its usage table (Meta model calls, products' Muse Code sandbox sessions). Hosted endpoints and partner evals are refused if their planned cost doesn't fit under the cap minus today's spend (`planRun` in lib/train/host/limits.ts). The SageMaker Spark take and Vercel's own Sandbox bill are never in it.

## 4. Partner hosting and the Hugging Face page (1:25 PM, 5 min, $0 until step 8)

**Which partner.** Owner: Modal, Baseten and Fireworks, all or pick. Recommended: **Baseten** for the filmed eval, **Modal** as an optional second, **no Fireworks**: it refuses r30b adapters (no r30b base, no regex target modules) and its account answered 412 on Nov 2, and partner evals accept only `baseten` or `modal` (`isPartnerProvider`). Fireworks still appears honestly in the montage, as about 60% of the Spark Open rows' writer tag. If tg-e-partner-hosts lands with a different plan, its doc wins over this section.

Type `1`, `baseten`, `13`, then each key at its prompt (keys typed, never pasted into chat or a file):

```
vercel env add HOST_TUNED production --force --scope "$VERCEL_SCOPE"
```

```
vercel env add PARTNER_EVALS production --force --scope "$VERCEL_SCOPE"
```

```
vercel env add HOST_TUNED_DAILY_USD production --force --scope "$VERCEL_SCOPE"
```

```
vercel env add BASETEN_API_KEY production --force --scope "$VERCEL_SCOPE"
```

```
vercel env add HOST_HF_TOKEN production --force --scope "$VERCEL_SCOPE"
```

- `HOST_TUNED_DAILY_USD` 13 holds all hosting to the spend table's two evals ($7.04 plus $5.25). Default is 25.
- `HOST_HF_TOKEN`: a read-only Hugging Face token. Without it the platform's write `HF_TOKEN` is handed to the provider.
- Leave `PARTNER_EVAL_MAX_USD` (8) and `PARTNER_EVAL_MAX_MINUTES` (60) at their defaults.
- Optional Modal, only if you want the second eval: `vercel env add MODAL_TOKEN_ID production --force --scope "$VERCEL_SCOPE"` and `vercel env add MODAL_TOKEN_SECRET production --force --scope "$VERCEL_SCOPE"`.

**HF_PUBLIC: leave it unset.** The publish step decides visibility in `hubFinishStep` (lib/train/hub-steps.ts): public when `HF_PUBLIC` is unset and the run was not marked to upload by itself, or when `HF_PUBLIC` is set to a yes. So with it unset, a deliberate Publish of run ebad9aad (once its mark is cleared in step 7) goes public, while any auto upload stays private. That is the narrow way to do what the owner said yes to. If `vercel env ls` shows `HF_PUBLIC` (for example the `0` from the partner-eval notes), remove it:

```
vercel env rm HF_PUBLIC production --yes --scope "$VERCEL_SCOPE"
```

Only if step 7's SQL line can't be run: set `HF_PUBLIC` to `1` for the publish, and remove it right after, since it makes every later publish and auto upload public.

## 5. One push, one deploy (1:30 PM, 10 to 15 min, $0)

```
git fetch -q origin && git rebase -q origin/main && git push origin HEAD:main
```

Wait for the Production deploy to finish (Vercel dashboard, off camera). Then the run of show's after-deploy checks, and the judge-path walk:

```
node scripts/judge-check.mjs
```

```
curl -s https://www.musemuse.dev/offline -o /dev/null -w '%{http_code}\n'
```

`/offline` answers 200 once `STORY_PAGES` is live.

## 6. Repackage aisle-together (1:45 PM, 5 min, a few cents)

Only if 2a passed. It waits for the packager, about 1 to 2 minutes.

```
curl -sS -X POST https://www.musemuse.dev/api/admin/native/package -H "authorization: Bearer $AUTOMATION_SECRET" -H "content-type: application/json" -d '{"buildId":"6add62d3-43f5-4be3-a5ff-280d207f7375"}'
```

```
curl -sI https://www.musemuse.dev/p/aisle-together/get/android
```

- Pass: `"status":"done"` with an android package of about 39 MB, then 200. www.musemuse.dev/p/aisle-together, Get it, Phone shows the APK and a QR code.
- This is the first real run of the production Blob path for packages. Until it passes and a phone installs it, say "is built so" for Android, Mac and Windows apps.
- Optional fresh phone build (test model, made-up data, about 46 minutes, $0.30 to $1.80): pick Phone in the target picker. Drop it first if money is short.

## 7. Clear run ebad9aad's auto-publish mark, then publish deliberately (1:50 PM, 25 min, at most $1)

There is no checkbox for this on a finished run: the mark is a `rate_limits` row that `saveRunAutoPublish` wrote at start (lib/train/tune/run-store.ts). Clear it in the Neon console's SQL editor for Production's database. `UPDATE 1` or `UPDATE 0` are both fine (0 means it was never marked).

```
UPDATE rate_limits SET count = 0 WHERE key = 'tune-settings:ebad9aad-0167-495e-8679-c3fab7472720:auto-publish';
```

Then publish job 83ae46c8 (the button on its job page signed in, or):

```
curl -sS -X POST https://www.musemuse.dev/api/train/jobs/83ae46c8-4e57-4086-866c-da69a39a20d0/publish -H "authorization: Bearer $AUTOMATION_SECRET" -H 'content-type: application/json' -d '{}'
```

- Its adapter isn't on the Hub yet, so this starts a glimmer-publish job on Lambda's cheapest GPU, capped at 20 minutes and $1.
- What goes public: the model repo only. The dataset repo stays private whatever the setting, because Spark 1.3 Contributor wrote it (`keepDatasetPrivate`).
- Check signed out before saying "It's on Hugging Face": the model page answers 200 and its card reads right (no em dashes, the 19 of 20 and $1.75 numbers, "Built with Muse Spark Open", 18 and over).

## 8. Partner evals (2:15 to 3:00 PM, 25 to 40 min, $2.70 to $4.35 expected, $7.04 at most)

After step 7 says published (every partner path loads the adapter from the Hub).

```
curl -sS -X POST https://www.musemuse.dev/api/train/jobs/83ae46c8-4e57-4086-866c-da69a39a20d0/partner-eval -H "authorization: Bearer $AUTOMATION_SECRET" -H 'content-type: application/json' -d '{"provider":"baseten"}'
```

- 202 with a run id. Watch www.musemuse.dev/fine-tuning/runs/ebad9aad-0167-495e-8679-c3fab7472720 (refresh), which shows "Evaluated on Baseten" with wins, scores, latency and the GPU cost by the clock.
- After: Baseten's dashboard has no `mm-host-` model left. Log the result, the real time and Baseten's bill in docs/BUILD_LOG.md.
- Optional Modal, only after Baseten ends (one at a time), at most $4.85 plus up to 5 minutes of sweep lag: the same line with `{"provider":"modal"}`. Its first deploy may not fit the 4-minute sandbox and end "failed"; don't retry it.
- Turning both flags off waits for the 6:30 PM deploy in section 10, since each change needs a deploy. Nothing tunes before then, so nothing starts a paid eval on its own.

## 9. Builds on Contributor (start by 2:00 PM, live from about 3 to 4:30 PM)

All builds run on Spark 1.3 Contributor today, at $0.17 to $0.40 each measured overnight. On Wonder tomorrow they would cost about $4 each, so every build in this section starts today. Builds already running when Wonder is switched on stay on the deployment they started on.

**9a. The hero yard-sale build (H1 and H2), filmed.** Signed in with the builder code on www.musemuse.dev, screen-recording. Print its note:

```
npx tsx scripts/demo-batch.ts --set=showcase --dry
```

Paste it into the Make page. $0.40 to $1.20, capped at the build token's $10, 60 to 150 minutes. Don't also run `--set=showcase` from the script, or it builds twice. Go or no-go for filming H1 and H2: 4 PM.

**9b. The whole cookbook set, which includes the four rebuilds.** `npm run demo-batch` with no ids starts all 12 notes in `scripts/demo-batch.ts` (legal, api, alerts, charts, fridge, games, image, voice, stickers, computer-use, studio, verified). The four rebuilds are in it: computer-use (sim-desk-agent-demo), stickers (wag-sticker-studio), games (lantern-canal-drift), fridge (fresh-dot-fridge). So run one of these two lines, not both:

```
npm run demo-batch
```

```
npm run demo-batch -- computer-use stickers games fridge
```

- Recommended: the whole set (owner's answer). About $2 to $5 expected for 12, at most $21.60 at the README's $1.80 ceiling a build, but the daily cap stops it well before that.
- If docs/COOKBOOK.md has landed from the cookbook workflow by then, read it first: if it names a different set or new notes, use its command, check it with `-- --dry`, and don't run a set twice.
- Each new build gets a new slug; the old pages stay hidden. The links are saved in `.data/demo-batch-<time>.json`.

**9c. After they go live (before the freeze).** Open each new page and its live link. Put a working one on `GALLERY_FIRST`, and take a product off `HIDDEN_FROM_GALLERY`, both in `lib/gallery/hidden.ts`, only after its page shows no known issue. That's a code change, so it must be on main before Nov 4 8 AM.

## 10. Fleet vars, for filming only (on at 6:30 PM, off by 9:30 PM, $0 plus ngrok requests)

For a hosted product that looks with SAM 3.1 on jetson-04 through the fleet (`FLEET_SAM`, lib/caps/fleet/sam.ts). The H6 cable-out take itself runs on the board and doesn't need these. The rover shot stays on Hussam's Preview (`ROVER_ENABLED` there only), not here.

The risk while they're on: `BOARD_FLEET_TOKEN` is an admin `jpt_` token, which can run any command as root on every board, sitting in a public site's env. So: a dedicated token Hussam mints for this alone, on for the filming window only, revoked right after. `BOARD_FLEET_URL` also turns on the admin-only fleet card on /device and Wonder's read-only fleet tools.

On (6:30 PM). Values: the control plane's https address ending in `/admin`, Hussam's dedicated `jpt_` token, `nd_fe300e68e976228c` (jetson-04, checked online through the fleet's read-only list at 12:40 PM), then `1`. This same deploy also turns the partner flags off.

```
vercel env add BOARD_FLEET_URL production --force --scope "$VERCEL_SCOPE"
```

```
vercel env add BOARD_FLEET_TOKEN production --force --scope "$VERCEL_SCOPE"
```

```
vercel env add FLEET_SAM_NODE production --force --scope "$VERCEL_SCOPE"
```

```
vercel env add FLEET_SAM production --force --scope "$VERCEL_SCOPE"
```

```
vercel env rm PARTNER_EVALS production --yes --scope "$VERCEL_SCOPE"
```

```
vercel env rm HOST_TUNED production --yes --scope "$VERCEL_SCOPE"
```

```
vercel redeploy https://muse-muse.vercel.app --scope "$VERCEL_SCOPE"
```

- Keep `HOST_TUNED` on instead if a hosted-model shot still needs filming; remove it in the off block then.
- The product needs `EDGE_FIRST=1` on its own Vercel project, and must be a new edge build made after this deploy (HANDOFF to-do 17). Each look spends about 10 to 25 of ngrok's 20,000 monthly requests.

Off (right after the take, by 9:30 PM). Production only; leave the Preview entries on the fleet-integration branch as they are.

```
vercel env rm FLEET_SAM production --yes --scope "$VERCEL_SCOPE"
```

```
vercel env rm FLEET_SAM_NODE production --yes --scope "$VERCEL_SCOPE"
```

```
vercel env rm BOARD_FLEET_TOKEN production --yes --scope "$VERCEL_SCOPE"
```

```
vercel env rm BOARD_FLEET_URL production --yes --scope "$VERCEL_SCOPE"
```

```
vercel redeploy https://muse-muse.vercel.app --scope "$VERCEL_SCOPE"
```

Then Hussam revokes the dedicated `jpt_` token in the control plane. `/fleet/v1/segment` answers 404 again once the deploy is live:

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://www.musemuse.dev/api/gateway/fleet/v1/segment
```

404 means off (the route is app/api/gateway/fleet/v1/segment). A 401 means it is still on and only refused the missing token: check the deploy finished.

## 11. The Spark Open take (deploy by 3:00 PM, InService by 3:40 PM or delete, $41.43 at most)

`scripts/knowledge/spark-take.ts` sends 1 to 6 invented passages to Spark Open on a GPU we started, prints each kept row with its `muse-spark-open@<host>` tag, and saves them to `.data/spark-take/`. It never starts or stops a GPU; `scripts/knowledge/aws/spark_endpoint.py` does.

- **The box:** SageMaker `ml.g7e.48xlarge` (8 RTX PRO 6000, 768 GB), **$41.43 an hour** (from the script). Spark Open needs about 700 GB of GPU memory, so nothing smaller fits.
- **Recommended hard cap: 1 hour,** `--hours 1`. The deploy schedules the endpoint's deletion with EventBridge an hour later, so it stops billing even if the laptop is off. Treat the whole hour as billed: $41.43.
- **Go or no-go:** if the status isn't `InService` 40 minutes after deploy, run `delete` and use the fallback (hold the Hub dataset shot, drop the optional sentence). Twice on Oct 30 AWS had no machine; that cost nothing.

From `~/mm-wt/overnight`, with the AWS profile `offlinebase`. If this checkout has no `.data/aws/venv`, make it first (a small download):

```
python3 -m venv .data/aws/venv && .data/aws/venv/bin/pip install -q boto3
```

Rehearse with no server and no spend (rows say "Fake writer"):

```
npx tsx scripts/knowledge/spark-take.ts --dry-run
```

Clear any old endpoint and stop schedule first, so the new one-hour schedule is the one that holds (the script keeps an existing schedule):

```
.data/aws/venv/bin/python scripts/knowledge/aws/spark_endpoint.py delete
```

```
.data/aws/venv/bin/python scripts/knowledge/aws/spark_endpoint.py deploy --hours 1
```

Read `deleteAtUtc` in its output: it must be about one hour ahead, and the output must not say `"schedule": "kept"`. Poll until InService (film this):

```
.data/aws/venv/bin/python scripts/knowledge/aws/spark_endpoint.py status
```

In a second terminal, start the relay (it listens on 127.0.0.1:18787 and stays in the foreground):

```
.data/aws/venv/bin/python scripts/knowledge/aws/relay.py
```

The take (film this):

```
npx tsx scripts/knowledge/spark-take.ts --host sagemaker-own --yes
```

Tear down at once, and film `status` printing `absent`:

```
.data/aws/venv/bin/python scripts/knowledge/aws/spark_endpoint.py delete
```

```
.data/aws/venv/bin/python scripts/knowledge/aws/spark_endpoint.py status
```

Then log the take, the real minutes and the bill in docs/BUILD_LOG.md before saying "eight GPUs we rented on AWS" anywhere.

## 12. Going public (Nov 3, 9:30 PM, about 1 hour, $0)

Owner's answer: make the current repo public, keep the internal docs, and accept that the fleet's tunnel domain stays in git history.

- **The risk, in one line:** the control plane's public ngrok address stays readable in history, so anyone can find the door to the real boards and try tokens against it.
- **The minimum mitigation:** before the flip, Hussam rotates every control-plane admin token (`jpt_`) and every fleet key (`jik_`) in use, revokes the filming token from section 10, and confirms a request with no token is refused. Changing the ngrok domain (HANDOFF to-do 5) is better still, if there's time.

Before the flip, as code (so before the freeze): fill the two `[owner: ...]` placeholders in `NOTICE` (lines 15 and 64), and commit.

A private backup of everything first (about 60 MB):

```
git clone -q --mirror https://github.com/Offline-Base/muse-muse.git ~/mm-wt/_plan/muse-muse-backup-2026-11-03.git
```

Delete the backup refs (the HANDOFF fallback; stale branches can stay, per the owner):

```
git ls-remote origin 'refs/backup/*' | awk '{print ":"$2}' | xargs git push origin
```

Flip, then check signed out:

```
gh repo edit Offline-Base/muse-muse --visibility public --accept-visibility-change-consequences
```

```
curl -s -o /dev/null -w '%{http_code}\n' https://github.com/Offline-Base/muse-muse
```

200 means public. The close card's repo URL can go in the cut now. The full rewrite plan (filter-repo) stays in `~/mm-wt/_plan/public-repo/check_history.md` if the owner changes their mind later.

## 13. Code freeze (Nov 4, 8:00 AM)

- The last push to main is before 8:00 AM: the gallery edits from 9c, the NOTICE fill, any copy changes in docs/SUBMISSION.md and the video script (they name Contributor; after the Wonder switch they should say what judges will see).
- After 8:00 AM: no code pushes. Only env changes and `vercel redeploy` of the frozen commit, which is section 14.
- Mark the frozen commit (optional, a tag is not a deploy):

```
git fetch -q origin && git tag -a submission-2026-11-04 origin/main -m "Code freeze, Nov 4 8 AM ET" && git push origin submission-2026-11-04
```

## 14. Switch to Muse Wonder for judging (Nov 4, 8:05 to 8:30 AM, $0 until judges build)

**The one switch is `BUILDS_ON_CONTRIBUTOR`.** `next.config.ts` inlines it at build time, so the redeploy is not optional.

What else, checked in the code:
- `WONDER_DEMO_SLUGS` is not an env var. It is a constant in `lib/gateway/policy.ts` (voice-memo-tasks, class-capture-notes, gym-snap-coach), the products that stay on Wonder while the switch is on. With the switch off everything is on Wonder, so nothing to change.
- `TEST_MODEL` does nothing on Production: `testModel()` returns null when `VERCEL_ENV` is production. Don't set it there. It still applies on Previews and local runs, where test builds keep using it.
- `BRIEF_MODEL`, `JUDGE_MODEL`, `BUILD_MODEL`, `COMPLEX_BUILD_MODEL`: with the switch off, `model()` reads these. Unset means `muse-wonder-1.0` (`DEFAULT_PLATFORM_MODEL`). Open each in the Vercel dashboard: each must be `muse-wonder-1.0` or absent. If one says `muse-spark-1.3`, the code turns it into Contributor and that step stays on Contributor.

Set Nov 4's cap first (type `20`; see the spend table), then switch and redeploy:

```
vercel env add DAILY_SPEND_CAP_USD production --force --scope "$VERCEL_SCOPE"
```

```
vercel env rm BUILDS_ON_CONTRIBUTOR production --yes --scope "$VERCEL_SCOPE"
```

```
vercel redeploy https://muse-muse.vercel.app --scope "$VERCEL_SCOPE"
```

If `vercel redeploy` refuses the alias, use Redeploy on the latest Production deployment in the dashboard.

**What changes (from docs/JUDGING_WEEK.md and the code):**
- New builds: brief, build, fix rounds, judge, Muse Code sessions and test calls run on Muse Wonder. **About $4 a build** (the cap's comment in lib/env.ts; the highest guest build seen was $5.90), against $0.17 to $0.40 on Contributor. Wonder's price is 40 times Contributor's input and 100 times its output.
- Live products: every call that names Muse Wonder runs on Wonder at Wonder's price, including today's Contributor builds (their code names Wonder). Products refused under the switch (audio input, personal accounts, Muse Code tasks) work again. Products published under the switch keep showing their Contributor notice until republished. Each product's daily budget ($3 to $10) was set from Contributor prices, so busy products hit it much sooner.
- Fine-tuning, Prove it and docs demos move to Wonder; the notices on the build and fine-tune boxes go.
- Not changed: the prove-nightly cron stays on Contributor (`NIGHTLY_MODEL`), `TRAIN_CONTRIBUTOR_WRITER` stays on.
- At $20 a day and about $4 a build, roughly 4 judge builds fit before the site pauses, and paused means products stop answering too. That is the price of the $100 total; raise the cap the moment the budget allows.

Check, signed out: a product page's Models panel says "Muse Wonder" with no "in place of", and `scripts/dev/judge-watch.sh` passes with the real values:

```
JUDGE_CAP=20 JUDGE_BUILD_QUOTA=25 scripts/dev/judge-watch.sh
```

**Switching back** (type `1`):

```
vercel env add BUILDS_ON_CONTRIBUTOR production --force --scope "$VERCEL_SCOPE"
```

```
vercel redeploy https://muse-muse.vercel.app --scope "$VERCEL_SCOPE"
```

A product published while the switch was off carries no Contributor marker, so on Contributor its calls are refused until it is published again. Avoid publishing new products in between if you might switch back.

## 15. Submit (Nov 4, by 11:30 AM)

docs/SUBMISSION.md, "The form, field by field". Add both team members. The X post link goes in Most Viral. Upload and check the video link signed out first.

## Spend table: $100 through Nov 4

Counted from now. Ceilings are what each item can cost at most with the caps above; "expected" comes from the measured numbers in docs/BUILD_LOG.md. If the owner counts this morning's overnight spend in the $100, take it out of the first row (step 3 sets that row's cap from /usage for that reason).

| Item | When | Expected | Ceiling | What holds the ceiling |
|---|---|---|---|---|
| Meta credits, Nov 3 UTC day (to 7 PM ET): hero build, 12 cookbook builds, optional phone build, rehearsals, judging, visitors | 1 to 7 PM | $4 to $9 | $20 | `DAILY_SPEND_CAP_USD` = today's spend plus 20 |
| Meta credits, Nov 4 UTC day (7 PM ET Nov 3 on): rover asks on Wonder, evening rehearsals, judges on Wonder after 8 AM | evening, then Nov 4 | $5 to $15 | $20 | `DAILY_SPEND_CAP_USD` 20, set again at the switch |
| Hugging Face publish job (Lambda) | 2 PM | $0.10 to $0.50 | $1 | the publish recipe's 20 min and $1 |
| Baseten partner eval | 2:15 PM | $2.70 to $4.35 | $7.04 | 60-minute stop ($6.50) plus 5 min of sweep lag ($0.54); `HOST_TUNED_DAILY_USD` 13 |
| Modal partner eval (optional) | 3 PM | $2 to $4 | $5.25 | 60-minute stop ($4.85) plus sweep lag; `HOST_TUNED_DAILY_USD` 13 |
| Spark Open take, SageMaker g7e | 3 to 4 PM | $41.43 | $41.43 | `--hours 1` deletion schedule |
| Vercel (Sandbox for the snapshot, 13 builds, packaging; Blob) | all day | $2 to $4 | $5 | not capped by the app; Oct 26 to Nov 1 Sandbox charges were $3.61 in all |
| Fleet, ngrok, Device Farm, Fireworks | | $0 | $0 | nothing runs |
| **Total** | | **about $57 to $79** | **$99.72** | |

**If it doesn't fit, drop in this order:**
1. The Modal eval ($5.25). Baseten alone answers "hosted on a partner".
2. The optional fresh phone build ($1.80), if aisle-together's repackage passed.
3. The 8 cookbook builds that aren't rebuilds: run the four-id line in 9b instead (saves about $2 to $3 expected, up to $14 at the ceiling).
4. The Spark Open take ($41.43), the single largest line and the one AWS may not even have a machine for. The run of show's fallback holds the Hub dataset shot.
5. Last, the Nov 4 cap. Judges hitting "paused" is the costliest failure in front of them, so lower it only after everything above is gone.

After Nov 4 the $100 cap ends; judging runs to Nov 9 (docs/JUDGING_WEEK.md recommends $100 a day). Set the cap you'll accept for those days before 7 PM ET Nov 4.
