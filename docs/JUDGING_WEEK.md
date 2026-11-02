# Judging week

Reviewed Nov 2, 2026 (UTC) against production, read-only. Env values were not read, only names, so anything about a value is marked for the owner to confirm.

## Daily check, 2 minutes

```bash
scripts/dev/judge-watch.sh
```

It uses public URLs only, needs no key, and makes one model call of about $0.0001. It checks the sidebar pages, one live product, the gateway and cron routes (both must refuse a stranger with 401), today's spend against the cap, the docs demos, and the shared guest's builds. It exits 1 on any FAIL.

Options: `JUDGE_CAP=150 scripts/dev/judge-watch.sh`, `JUDGE_BUILD_QUOTA=10`, `JUDGE_PRODUCT=some-slug`, or a base URL as the first argument. Set `JUDGE_CAP` and `JUDGE_BUILD_QUOTA` to the real production values, since the script can't read them.

Then, by hand, because the script can't see these:

1. Open one live product and run it once. The script's model call uses the docs key (`DOCS_MODEL_API_KEY`). Products use `MODEL_API_KEY`, and only this step or a build proves that one.
2. Vercel dashboard, muse-muse, Cron Jobs: the last runs are green.
3. Lambda console: no `mm-train-` instance you don't expect.
4. Meta console: credit left against the worst case below.

## What to set before judges arrive

Both are production changes, for the owner. A new value only reaches a new production deployment.

| Setting | Recommend | Why |
| --- | --- | --- |
| `DAILY_SPEND_CAP_USD` | **100** | See below. The last value in the build log is 150, so confirm what's set |
| `MAX_BUILDS_PER_USER_PER_DAY` | **25** | Every visitor shares one guest. The code default is 3 |

```bash
printf '100' | vercel env add DAILY_SPEND_CAP_USD production --force --scope ethan-6436s-projects
printf '25' | vercel env add MAX_BUILDS_PER_USER_PER_DAY production --force --scope ethan-6436s-projects
```

Then merge anything to main, or `vercel redeploy https://muse-muse.vercel.app --scope ethan-6436s-projects`.

**Emergency stop.** `DAILY_SPEND_CAP_USD=0` does not pause anything: `number()` in `lib/env.ts` ignores 0 and falls back to 100. Use `0.01`. The same goes for the build quota, where 0 means the default of 3.

## Why a $100 cap

Judge traffic is not known, so this is an assumption: 20 visitors in a day, 10 of them start a build, and each runs a product 3 times.

| Item | Contributor builds (today) | If Contributor goes off |
| --- | --- | --- |
| 10 builds | $9 ($0.92 each, the highest of the last three) | $59 ($5.90 each, the highest in the guest's list) |
| 60 product runs at $0.30 | $18 | $18 |
| Docs demos | $1 | $1 |
| **Day** | **about $28** | **about $78** |

- **The biggest real days:** Oct 28 at $69.26 and Nov 1 at $65.71, both from `/usage`. Those were the owner's batches, not visitors.
- **Too low costs far more than too high.** At the cap, building stops and shipped products lose their model calls for the rest of the UTC day, in front of a judge. Another $50 on a busy day costs only $50.
- **Exposure:** at most $800 over 8 days, about $225 at the assumed traffic. If Meta credit left is under $800, lower the cap and say so here. Credit left is not something I can see.
- **The cap is shared.** A $69 batch of the owner's leaves $31 for judges that day, so run no batches on production this week.

## Findings

### Fixed in this PR

- **Screenshots would disappear before judging.** The hourly cleanup deleted `screens/` after 7 days, which starts Nov 3 for the Oct 27 builds and Nov 4 for the 27 shipped on Oct 28. Those are the check screenshots in the build rooms. Now 30 days. Merge before Nov 3 00:00 UTC to keep them all. A deleted screenshot does not come back.
- **The paused message was wrong.** It said "Everything that already shipped still works", but the gateway refuses shipped products' calls at the cap (`platform_paused`). It now says so, and gives the reset time.
- **The guest limit message was a dead end.** It said to sign in, and signing in needs an access code judges don't have. It now points to the Gallery.

### Checked, fine

- **Tokens.** No stored OIDC token in production: `VERCEL_OIDC_TOKEN` is not in the env names, and Blob uses `BLOB_STORE_ID` with the request's token. The Vercel account's "Muse token" expires Jan 25, 2027, its other token never does. The only OIDC expiry seen so far was a local `.env.local`.
- **GPU spend.** Starting a training run needs an admin or automation, and `OPEN_TRAIN` is not set, so a judge can't start one. `TRAIN_DAILY_USD`, `TRAIN_JOB_MAX_USD` and `TRAIN_MAX_ACTIVE` are set.
- **Crons.** All 7 are registered and `CRON_SECRET` is set. `prove-nightly` is off, since `PROVE_NIGHTLY` is not set.
- **Vercel.** Pro, active, not soft-blocked. Charges for Oct 26 to Nov 1: Sandbox memory $1.98, snapshots $0.84, Sandbox transfer $0.79. Blob was not in the top 10. Infrastructure is not the money risk.

### What a visitor sees at each limit

| Limit | Default | Visitor sees |
| --- | --- | --- |
| Platform cap | see above | "Muse Muse reached today's spending cap..." in the composer. Products get 503 `platform_paused` |
| Shared guest builds | rolling 24 h | "The shared guest account has used its builds..." |
| One product's day | $3 to $10, by its cost per run | The product gets an over-budget error. How each product shows it was not checked |
| Gateway rate | 120 a minute per product, 20 per end user, 4 in flight | 429 |
| Docs demos | $25 a day, $2 and 400 calls per IP, 20 a minute | `ErrorBox` explains it with a countdown |

A room of judges behind one address shares the per-IP limits. 20 a minute should be plenty, but it has not been load tested.

### Not proven

- **Crons firing.** `vercel logs` returned no records for any window I tried, so that says nothing either way. Check the dashboard.
- **Deletion itself.** Read from the code. Screenshots from Oct 28 still answer 200 today.
- **Other keys.** `MODEL_API_KEY`, `HF_TOKEN` and `LAMBDA_API_KEY` show no expiry anywhere I can read. The guest's builds of the last 2 hours imply the Meta key works. HF and Lambda were not exercised.
- **Limits of Blob storage, Neon and Vercel Spend Management.** Not visible from here. If Neon runs out, `/usage` loses its table and the script fails. Look at all three once.
- **Concurrent builds.** No load test, and I didn't find a platform-wide limit beyond the guest quota.
- **Native lab.** Admin routes were checked, and its ledger has its own cap. Whether a guest build can request a native target with `NATIVE_TARGETS` set was not traced.

## Things judges will notice

- `/gadgets` says "Not set up". The script warns about it until a board is connected.
- `/privacy` and `/terms` answer 404. Nothing in the sidebar links them: Muse Privacy is at `/private`, which answers 200. `/media` loads with no sidebar link.
- "My builds" shows every visitor's builds, since they all share the guest.

## After judging

Rotate the Vercel token and the Lambda key (already on the list in `docs/SUBMISSION.md`), and put the cap back down.
