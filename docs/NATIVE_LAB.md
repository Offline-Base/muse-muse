# The device lab

The lab checks each product on an iPhone simulator, an Android emulator, a Mac and Windows, and records a clip of each. It
runs on two AWS boxes, which take no inbound connections. An agent on each box asks the platform for work.

The agent and its files live in `native/lab/`. This document is the contract between that code and the platform: the routes
under `app/api/native/agent/`, the `native_jobs` queue and the sweep. "The platform's side" below says where those live.

| File | What it is |
|---|---|
| `native/lab/agent.mjs` | The agent: claim loop, idle stop, clean shutdown |
| `native/lab/lib/execute.mjs` | One job from start to finish: deadline, heartbeats, uploads, the finish call |
| `native/lab/jobs/` | The runners: `ios_sim`, `android_emu`, `desktop_mac`, `desktop_windows`, `glasses_sim` |
| `native/lab/compose.mjs` | The clip: a recording in a generic device frame on a Meta-blue backdrop, 1920x1080, with a caption and a poster |
| `native/lab/control.mjs` | The box's side of the SSM control document |
| `native/lab/ssm/MuseLab-Control.json` | The SSM document: enum actions only |
| `native/lab/setup/` | `mac.sh`, `mac-finish.sh`, `mac-checks.sh`, `windows.ps1`, `imds-credentials.sh`, `publish-bundle.sh`, and the LaunchAgent plist |
| `native/lab/tools/check.mjs` | Runs one real job on a box with a local stand-in for the platform |
| `native/lab/tools/glasses-check.html` | A small page with the glasses template's contract, for checking `glasses_sim` without a product |
| `native/lab/iam/` | The instance role's two inline policies, as they are in the account |

The agent needs Node 22 and has no npm dependencies. If `@aws-sdk/client-ssm` is installed it reads its token with that,
and otherwise with the `aws` CLI.

Run the tests from the repo root:

```
npx tsx --test --test-concurrency=4 --experimental-test-module-mocks native/lab/__tests__/*.test.mjs
```

`e2e.test.mjs` runs the real agent as a process, with a real signed Mac app and the real ffmpeg, against a local stand-in
for the platform. `blob.test.mjs` runs the real Blob SDK next to our client and compares what each sends.

## HTTP contract

All four routes take and return JSON over HTTPS, and the agent refuses redirects. There are two kinds of token, both sent
as `Authorization: Bearer <token>`:

- **The lab token** only claims jobs. There's one per lane. Store its sha256 in `native_labs`, and put the token itself in
  Parameter Store at `/musemuse/lab/<lane>/token` (`mac` or `windows`).
- **The job token** is issued at claim. It covers that job's heartbeat, upload, selftest and finish, and nothing else. Store
  its sha256 in `native_jobs.token_hash`, and let it expire 15 minutes after `deadline_at`.

**A job token only works while its run owns the job.** A job the sweep re-queued can still have an old run out there, so the
heartbeat, upload, selftest and finish routes all require `status = 'claimed'` and a matching `token_hash` in the same `WHERE`
clause, and answer 410 otherwise. The sweep clears `token_hash` when it re-queues. Without this, an old run's finish could close
a queued job while its retry is claiming it.

### POST /api/native/agent/claim

Lab token. Sent every 10 s.

```jsonc
{
  "lane": "mac",                 // must match the token's lane, or 403
  "version": "0.1.0",            // the agent's version, for native_labs
  "kinds": ["ios_sim", "android_emu"], // what it can take right now. Can be empty.
  "slots": 1,
  "running": ["job_abc"],        // jobs it's working on
  "capabilities": { "ffmpeg": { "ok": true, "drawtext": true } }, // tool status, for the admin page
  "waitSeconds": 10              // how long the route may hold the request open
}
```

- **Every call counts as presence.** Update `native_labs.last_seen_at`, `state` and `version`, and do this first.
- **An empty `kinds`** is only a presence ping, because the box is busy. Answer 204 at once.
- **`waitSeconds`** is an upper limit. Holding is optional: the route can answer 204 right away, and the agent waits out the
  rest of the 10 s. If it holds, stay under the function's `maxDuration`.

| Status | Meaning |
|---|---|
| 200 | `{ "job": <job> }`, see below |
| 204 | No work |
| 401 | Bad token. The agent reads Parameter Store again and retries once |
| 429 and 5xx | The agent backs off, from 5 s up to 60 s, and honors `Retry-After` |

The job:

```jsonc
{
  "id": "job_abc",               // A-Z a-z 0-9 _ -, up to 64 characters
  "kind": "ios_sim",
  "token": "<job token>",        // 16 to 512 of A-Z a-z 0-9 . _ ~ -
  "attempt": 1,
  "runId": "nr_x",
  "input": { }                   // see "Job inputs"
}
```

The claim is one atomic statement, so a job goes to one box only:

```sql
UPDATE native_jobs SET status='claimed', claimed_at=now(), heartbeat_at=now(), attempts=attempts+1,
  token_hash=$h, deadline_at=now() + (input->>'limitSeconds')::int * interval '1 second'
WHERE id = (SELECT id FROM native_jobs WHERE lane=$lane AND status='queued' AND expires_at > now() AND kind = ANY($kinds)
            ORDER BY priority DESC, created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *;
```

The token only exists in plaintext for this one response, so generate it before the statement and return it beside the row.

Clear the job's stored selftest report in the same step, since a retry keeps its job id. Each claim also makes a new selftest
token that names the attempt, so a shell left over from an earlier attempt gets a 410. The agent also ignores a report dated
before its launch, as a second guard, so keep the shell's `at` as it was sent.

### POST /api/native/agent/jobs/{id}/heartbeat

Job token. Sent every 15 s, and once at the start.

```json
{ "phase": "record", "attempt": 1 }
```

`phase` is one of `start`, `download`, `boot`, `install`, `probe`, `media`, `record`, `autopilot`, `selftest`, `report`,
`compose`, `upload`.

| Status | Meaning |
|---|---|
| 200 | `{ "cancel": false }`. With `true`, the agent stops the job and finishes it with code `canceled`. The platform never sends `true`: canceling closes the row, so the agent gets a 410, which it treats the same |
| 401, 404, 410 | The agent takes it as a cancel. See "A job token only works while its run owns the job" |
| Anything else, or no answer | The agent keeps going and tries again in 15 s |

Update `heartbeat_at`. The sweep fails any job silent for 90 s, re-queues it once, and clears its `token_hash`.

### POST /api/native/agent/jobs/{id}/upload

Job token. Called once near the end of a job, for all its files at once.

```json
{ "files": [{ "name": "clip.mp4", "contentType": "video/mp4", "bytes": 4200000, "sha256": "<hex>" }] }
```

Answer `{ "uploads": [<slot>, ...] }` with one slot per file you accept. A file with no slot is skipped with a warning, and
the job still finishes. A 410 loses the files the same way. Accept these names only, up to these sizes:

| Name | Role | Type | Limit |
|---|---|---|---|
| `shot-1.jpg` to `shot-4.jpg` | shot | image/jpeg | 2 MB |
| `clip.mp4` | clip | video/mp4 | 16 MB |
| `poster.jpg` | poster | image/jpeg | 2 MB |
| `report.json` | report | application/json | 1 MB |
| `log.txt`, `logcat.txt` | log | text/plain | 1 MB |

The slot, for Blob:

```jsonc
{
  "name": "clip.mp4",
  "method": "blob",
  "pathname": "native/runs/<runId>/<jobId>/<attempt>/clip.mp4",
  "multipart": false,            // true over 16 MB
  "presignedUrlPayload": { "delegationToken": "...", "signature": "...", "params": { } }
}
```

Make the payload the way `lib/pipeline/inspo-upload.ts` does, with one `issueSignedToken` per file. Production has no
read-write token, only OIDC:

```ts
const limits = { allowedContentTypes: [contentType], maximumSizeInBytes: limit };
const token = await issueSignedToken({
  pathname,
  operations: ["put"],
  validUntil: Date.now() + 5 * 60_000,
  ...limits,
  ...blobAuth(),
});
const { presignedUrlPayload } = await handleUploadPresigned({
  body: { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: null, multipart } },
  request,
  webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY || NO_CALLBACK_KEY,
  getSignedToken: async () => ({ token, urlOptions: { ...limits, addRandomSuffix: false } }),
});
```

Each attempt has its own folder, so a slot from an old run can't touch a retry's files, and no slot can replace a file that's
there. If Blob's reply to a PUT is lost after the file landed, the agent's retry is refused and reports the file as lost, with a
warning. Only ever issue pathnames under `native/runs/<runId>/<jobId>/<attempt>/`, from the job row and never from the request.
A slot lasts 5 minutes, because it can't be revoked and the agent gives a job's uploads 2.

For a local platform with no Blob store, a slot can be `{ "name", "method": "put", "pathname", "url", "headers" }`. The
agent PUTs the bytes there and expects `{ "url", "pathname" }` back. Nothing but the local dev server should do this.

### POST /api/native/agent/jobs/{id}/selftest

Job token. Body `{}`. Answers `{ "report": <report> }` with what the shell posted to `/api/native/selftest` for this job, or
`{ "report": null }` if it hasn't posted yet. A 410 reads as no report. The agent polls this until 70 s after launch when the
report doesn't reach it any other way, which is the normal case on iOS (see "What the shells do"). That's long enough for the
report the shell's own 60 s watchdog sends for a page that hangs.

Selftest tokens are the HMAC tokens from `lib/native/lab-token.ts`. They name the job, so that this route can find the report,
and the attempt, so that only the run in progress can write it. They last as long as the job token does.

### POST /api/native/agent/jobs/{id}/finish

Job token. The agent retries up to 6 times.

```jsonc
{
  "outcome": "passed",           // passed, failed or lab_error
  "informational": false,        // true for glasses_sim, on a lab_error too: never blocks shipping
  "summary": "Checked on an Android emulator (Pixel 7, Android 15): opened in 2.1 s.", // for the build room
  "device": { "name": "Pixel 7", "os": "15" },
  "checks": [{ "id": "loaded", "ok": true, "detail": "The page answered with HTTP 200." }], // ok: null is only a note
  "reasons": [],                 // why it failed, in plain sentences
  "warnings": [],                // console errors, a lost upload
  "captionBurned": true,         // false: show artifact.caption beside the clip
  "loadMs": 2100,
  "durationMs": 58000,
  "attempt": 1,
  "agentVersion": "0.1.0",
  "artifacts": [{ "name": "clip.mp4", "role": "clip", "url": "...", "pathname": "...", "bytes": 4200000,
                  "sha256": "...", "contentType": "video/mp4", "caption": "On an Android emulator (Pixel 7, Android 15)" }],
  "error": null                  // on lab_error: { "code": "...", "message": "..." }
}
```

| Status | Meaning |
|---|---|
| 2xx | Done. Set the job to `done` or `failed`, and add `native_artifacts` rows |
| 401, 404, 409, 410 | The agent gives up quietly. The job expired or already finished |
| Anything else | The agent retries, up to about a minute |

**Trust nothing here for money or for the gallery.** Treat `artifacts[].url` as a claim: keep a file only if its pathname sits under
this attempt's folder and its host is this platform's own Blob store. Store a link made from that pathname, not the box's string,
and each name once. `informational` is set from the job's kind, whatever the box sends.

**`outcome: failed` means the product didn't pass.** `lab_error` means the check never ran, so the product isn't to blame.
Show them differently: the summary already does ("Not checked on...").

### Lab error codes

| Code | Meaning | Retry once? |
|---|---|---|
| `invalid_input` | The job failed validation. It's a platform bug | No |
| `tool_missing` | The box lacks a tool. Fix the box | No |
| `download_failed` | A download failed | Yes |
| `checksum_mismatch` | A download didn't match its checksum | No |
| `simulator_failed` | The iPhone simulator wouldn't start | Yes |
| `emulator_failed` | The Android emulator wouldn't start | Yes |
| `install_failed` | The package wouldn't unpack or install | No |
| `timeout` | The job passed `limitSeconds` | Yes |
| `canceled` | The platform canceled it. No uploads happen | No |
| `agent_restarted` | The agent was stopped mid-job | Yes |
| `internal` | An unexpected error. The message is generic and the log has the detail | Yes |

`RETRYABLE_CODES` in `native/lab/lib/errors.mjs` is the same list.

## The platform's side

All of it is off with `NATIVE_LAB` off: every route answers 404 before it reads anything, `/usage` has no card, and `enqueueJob`
refuses. Everything here is covered by `lib/native/__tests__/`.

| File | What it is |
|---|---|
| `app/api/native/agent/claim`, `jobs/[id]/heartbeat`, `upload`, `selftest`, `finish` | The routes above. `claim` doesn't hold the request open: it answers at once and the agent waits out its 10 s |
| `app/api/native/agent/jobs/[id]/files/[name]` | The local "put" slot. A 404 on Vercel or with a Blob store |
| `app/api/native/selftest` | The shell's report. Takes the selftest token, keeps the body as sent, apart from text Postgres can't store |
| `app/api/cron/native-sweep` | The sweep, every 5 minutes |
| `lib/native/queue.ts` | Everything that moves a `native_jobs` row |
| `lib/native/lab-token.ts` | The lab, job and selftest tokens |
| `lib/native/lab-box.ts` | Starting and stopping Windows, restarting the Mac's agent, a box's presence |
| `lib/native/aws.ts` | The calls to EC2 and SSM |
| `lib/native/ledger.ts` | The spend ledger |
| `scripts/native/lab.ts` | Sets a lane's token |

**The queue.**

```ts
// The input comes from docs/NATIVE_LAB.md, "Job inputs", without selftest. Pass selftest: true for a lab shell's job, and each
// claim adds a token for that attempt.
const job = await enqueueJob({ runId, buildId, productId, kind: "ios_sim", tier: "ship", input, selftest: true });
if (job.ok) job.jobId, job.ahead, job.etaSeconds; else job.reason, job.message;
```

| `tier` | Priority | Waits for up to | Use it for |
|---|---|---|---|
| `agent` | 30 | 10 minutes | An agent mid-build, with someone waiting. A build can have one such run going |
| `ship` | 20 | 45 minutes | A check after shipping. If it expires, a `backfill` copy takes its place |
| `batch` | 20 | 90 minutes | The same, from a batch of rebuilds |
| `backfill` | 10 | 6 hours | A second try for an expired check |

Other limits: 30 jobs queued or running in all, and 2 of each kind per product. The design says 2 per product, but it also gives
each check its own job, and a phone and desktop product has four, so the limit is per kind.

`enqueueJob` can answer `lab_off`, `bad_input`, `queue_full`, `product_full`, `agent_busy` or `box_down`. A Windows job starts the
Windows box itself, and `box_down` means the box can't start, so the job isn't queued. Every step goes in the build's log as a
`native` event, with `item` as `check:<kind>`, so the build room needs no polling for lab checks. `runJobs(runId)`,
`queuePosition(jobId)` and `cancelAgentJobs(buildId)` are the rest of what callers need. `lib/native/lab-box.ts` has
`labView(lane)` for whether a box is online, and `wakeWindows()` to start Windows early.

**A retry.** A job gets 2 attempts. A silent job or a lab error with a code from the retry table goes back to `queued`, with
`token_hash`, the deadline and the report cleared. After that it's `failed`, with `outcome: lab_error`. The statuses:

| Status | Means | `result.outcome` |
|---|---|---|
| `done` | The check ran and passed | `passed` |
| `failed` | The check ran and the product didn't pass, or the lab couldn't run it | `failed` or `lab_error` |
| `expired` | It waited too long, and it may have a `backfill` copy | None |
| `canceled` | The build ended under an agent's check | None |

**The sweep.** Each task runs on its own, so AWS being down can't stop the queue's:

1. A claimed job silent for 90 s, or past its token's life, is re-queued or failed.
2. A queued job past its TTL is expired.
3. Windows: see below.
4. The Mac: if its agent is silent and SSM says the box is online, it sends `restart-agent`, at most once per 10 minutes. Nothing
   in the platform can stop the Mac.
5. The ledger: commits the Mac's cost, and logs an error while spend is past the alert line.

**Windows.** The sweep reads the box's EC2 state and does one thing:

| The box | Then |
|---|---|
| Running, and the agent hasn't spoken for 10 minutes | Stop it, and don't start it again for an hour. This is the backstop: the agent's own idle stop can't run if it crash-loops or never starts. The 10 minutes count from the start, and a start takes up to 6 to reach its first claim |
| Running, with no jobs for 30 minutes | Stop it. The agent's own stop is at 20, so a healthy box stops itself first |
| Running, near the end of what the ledger holds | Hold 2 more hours. If the ledger refuses, stop it |
| Running, and started by hand | Note the session, so its hours reach the ledger |
| Stopped, with a session open | Commit the hours and give back the holds |
| Stopped, with a job queued | Start it, if the ledger allows and no block applies |

**Two things the sweep can't cover.** With `NATIVE_LAB` off the sweep is a 404, so only the box's own idle stop is left. And it
skips a box with no `native_labs` row, because nothing can claim without a token and it has nowhere to note a session, so run
`scripts/native/lab.ts` before starting Windows with the flag on. Once it's set up, a box you've signed in to with its agent
stopped counts as silent: the sweep stops it after 10 minutes, and it can't start by itself for an hour.

**The role.** `lib/native/aws.ts` signs its own requests rather than using `@aws-sdk/client-ec2` and `client-ssm`, which would be
tens of megabytes for two small protocols. It offers only what the policy allows: start, stop and read the Windows box, and
`MuseLab-Control` with one of its enum actions on a box whose id is in the env. It reads credentials through Vercel's OIDC token
and `AWS_ROLE_ARN`, and its region is always `NATIVE_AWS_REGION`.

**The ledger.**

```ts
const held = await reserve("device_farm", usd, { ref: runArn, runId });  // { ok: true } or { ok: false, reason, message }
await commit("device_farm", { usd: actual, holdUsd: usd, ref: runArn, runId });
await release("device_farm", usd, { ref: runArn });
await commitIf("windows", { usd, holdUsd }, claim);  // A commit that lands only if `claim`, a SQL statement, returns a row
await canSpend("device_farm", usd);  // A plan's guess. Only reserve promises anything
```

Caps come from `lib/env.ts`: $150 total, $40 Device Farm, $15 Windows, and the alert at $120. A hold takes both its budget and the
total, or neither, under a row lock, so two callers can't both take the last of a cap. Every change takes those locks first and in
the same order, so two can't deadlock. A Windows session's close and its bill land together through `commitIf`, so a failure leaves
the session open for the next sweep. The Mac has no cap of its own: `syncMacHost`
commits its rate from `NATIVE_MAC_ALLOCATED_AT` to `NATIVE_MAC_RELEASE_AT`, with a 24-hour minimum, and that counts against the
total. A commit always lands, even past a cap, and then later holds are refused.

**Tokens.** `scripts/native/lab.ts <lane> <file> [instance id]` makes a lane's token, stores its hash and writes it to a file only
you can read. It never prints it. Put the file's contents in Parameter Store, then delete the file. Running it again is how you
revoke a box's access: the old lab token stops working, and that lane's running jobs go back in the queue in the same step, so
their job tokens end too. A rotation mid-job costs that job a run, and it uses up an attempt.

**Not built:** deleting an agent run's files after 7 days (the table in docs/NATIVE.md), and rate limits on these routes, which are
token-only.

## Job inputs

`validateJob` in `native/lab/lib/validate.mjs` is the source of truth, and it's strict because these values reach simctl, adb
and the apps. A job that fails finishes with `invalid_input`. Fields common to every kind:

```jsonc
{
  "v": 1,
  "limitSeconds": 300,            // 30 to 900. Required
  "target": { "url": "https://x.vercel.app/" },  // https, public host, no port, no credentials
  "product": { "name": "Demo", "slug": "demo" }, // optional
  "recordSeconds": 15,            // 6 to 25, default 15. Phone kinds
  "shots": 2,                     // 1 to 4, default 2
  "selftest": { "token": "...", "platformUrl": "https://muse-muse.vercel.app" }, // lab shells only. platformUrl is optional
  "device": { "name": "Pixel 7" }, // optional. Only shown in the caption: it doesn't pick the simulator or emulator
  "app": { }                      // see below
}
```

`app` always has `kind`, `variant`, `version`, `url` and `sha256`, and can have `bytes`. `url` must be on Vercel Blob or the
platform itself.

| Job kind | Lane | `app.kind` | `app.variant` | Extra | Suggested `limitSeconds` |
|---|---|---|---|---|---|
| `ios_sim` | mac | `ios_sim_app` (a .tar.gz of the .app) | `lab` | `bundleId` | 300 |
| `android_emu` | mac | `apk` | `lab`, `product` | `packageName` | 420 |
| `desktop_mac` | mac | `mac_zip` | `lab`, `product` | | 240 |
| `desktop_windows` | windows | `windows_zip` | `lab`, `product` | `exeName` (optional) | 240 |
| `glasses_sim` | mac | `ios_sim_app` | `glasses` | `bundleId` | 420 |
| `gguf_emu` | mac | None: see below | | `gguf`, `prompts`, `systemLine`, `maxTokens` | 900 |

- **`selftestSeconds`** (8 to 20, default 12) on the desktop kinds sets how long the frames play for. The shell itself
  records for 12 s.
- **`glasses_sim`** also takes `scenario` (`capture-and-ask`, the default) and `media`: `{ photo: { url }, feed?: { url },
  question?: { url } }`. Without a feed, the lab makes one from the photo. It's H.265, as Meta's mock camera requires.

- **`gguf_emu`** runs a tuned model on the emulator (docs/TRAINING.md "Emulator runs"). It has no `target`, `app` or `selftest`.
  `gguf` is `{ repo, commit, name, sha256, bytes }`, a public file on the Hugging Face Hub. `lib/hub-download.mjs` follows redirects
  only to the Hub's own hosts, sends no token, and needs the exact size and checksum. The box offers this kind only once
  `setup/llama-android.sh` has built `llama-server`. It shares the emulator with `android_emu`, so the two never run together. Its
  finish call adds `simTune`, which the route keeps for this kind only. The file must fit in the emulator's RAM and disk: `mm_pixel`
  has 4 GB and 8 GB.

## Pass rules

`native/lab/lib/rules.mjs`, tested in `__tests__/rules.test.mjs`. A check passes when all of these hold:

1. The app launched, and didn't crash.
2. The page loaded below HTTP 400, or the status is unknown and it loaded with no error.
3. It ended up on the product's own origin.
4. The screen isn't blank.
5. The bridge handshake answered.
6. On a Mac, `codesign --verify --deep --strict` passes.

Console errors only warn. A timeout fails the check. Gatekeeper's answer is recorded and never counts, since rejecting an
ad hoc app is expected.

- **Blank:** one flat color, or nearly flat with under 20 characters of text. A canvas page with no text passes on its pixels.
- **The shell's own `ok` is ignored.** It has no pixels, so it calls a canvas page blank. The lab decides for itself.
- **A per-product APK has no selftest,** because it has no way to take the token. Its check rests on launch, no crash and
  pixels, and adds a note saying so. Use the lab APK with the product's URL for a full check.
- **`glasses_sim` is informational.** It passes when the page loads in 60 s, the mock glasses connect, the main button shows
  up, and a result appears in 120 s. Its `informational: true` means it never blocks shipping or hides a download.
  The design also asks for no `window.onerror`. That one only warns, like console errors in the other checks: the checkpoint
  that ends the run carries the shell's `internal.pageErrors()`, so a product that throws and still shows a result passes with
  a warning.

## What the shells do

Checked against `native/shell-mobile` and `native/shell-desktop` as of Oct 31.

**Phone, lab variant, iOS.** Launch arguments, read in `launchArgsToRequest`: `-museUrl`, `-museSelftest 1`, `-museToken`,
`-musePlatform`.

**Phone, lab variant, Android.** A deep link, read in `parseDeepLink`:
`musemuse-lab://check?url=...&selftest=1&token=...&platform=...`.

**The health report on phones.** The agent looks in this order:

1. `Documents/selftest.json` (iOS only). The shell writes the whole report here, so iOS doesn't depend on the log or the network.
2. A `MUSE_SELFTEST <json>` line in the device log. Android's logcat gets this in release builds. Logcat cuts lines at about
   4 KB, so the shell keeps the line under 3.5 KB: it keeps as many `errors` as fit, says how many it left out in
   `errorsLeftOut`, and drops the `warnings` copy of them. The lab's warnings count those too.
3. The platform's copy, through the selftest route above. It only counts if its `at` is after this launch.

iOS release builds drop `console.log` below the error level, so on iOS only 1 and 3 will work.

**The Android bridge timing check.** On Android the shim can arrive after a page's first inline script, and a selftest can't see
that, because its handshake runs after load. So on the first `android_emu` job with a lab shell, before it records, the runner
(`jobs/android_probe.mjs`) serves its own page on `http://10.0.2.2:<port>/` for up to 45 s. That page's head script writes what
it saw into `document.title`, and the shell's report brings the title back, posted to the same local server or read from
logcat. The job's `checks` then have a note with `id: "bridge_timing"` and `ok: null`, saying whether `window.MuseNative` was
there and how many ms later it showed up. The answer is also saved in `android-bridge-timing.json` in the data folder, and that
file stops the check running again. Delete it to ask again. No answer is a note too, and the next Android job tries again.
It never changes a job's verdict, and a job with too little time left leaves it for the next one.

**Desktop.** `<exe> --muse-selftest=<dir>`. The shell writes `selftest.json`, `frames/00001.jpg` and so on, and
`stills/01.png` and so on. The frame names are a count, so the lab times frames by when they were written. The exit code is 1
whenever the shell's own report isn't ok, so the lab only treats an exit code as a crash when there's no report.

The app opens the URL in its `muse-product.json`. For `variant: "lab"`, the lab rewrites that file for the job, then on a Mac
signs the app again, ad hoc, because the change breaks the resource seal. A `product` app is left exactly as it shipped, so
its signature check means something.

**Glasses.** The lab copies media into the shell's `Documents`: `mock-feed.mov`, `mock-photo.jpg` and `mock-question.wav`. Mock
mode's `stopRecording` returns that question as a recording from the glasses, or silence when there's none, and never touches
the microphone. The lab launches the app with `-museUrl`, `-museMock 1` and `-museRun autopilot`, and counts the load limit
from when the launch call returns. It doesn't use the `musemuse://check` link: `simctl openurl` stops at a system "Open in
Muse Glasses Lab?" dialog that nobody is there to answer, and the dialog stays on screen for later jobs.

**When the phone kinds look.** The shell reports once, after the page has loaded and scrolled for 8 s, or at its 60 s
watchdog. So `ios_sim` and `android_emu` wait for that report, counted from when the launch call returns, then take their
screenshots in the next 3 s, and keep recording for at least `recordSeconds` in all. The clip is the last `recordSeconds` of
the recording, so a slow page's wait isn't what people see. A per-product APK has no report, so it gets until 30 s after its
`recordSeconds` would have ended to draw something. Launches get 120 s, and a failed one logs why in the job's log.

The autopilot writes `Documents/autopilot.jsonl`, one `{ step, ok, detail, at }` per line, with the steps `start`, `connect`
(detail is the mode), `primary`, `result`, `timeout` and `error`. Those last three also carry `errors`, up to 20 of the page's
uncaught errors and `console.error` calls, when there are any. It has no checkpoint for the capture itself, so that's
covered by the result.

## The clip

`compose.mjs` draws its own backdrop and frame, so no device maker's imagery ships. Clips are at most 25 s and about 12 MB.

The caption comes only from the lab's own device facts, never from the product. It says what really ran: "On an Android
emulator (Pixel 7, Android 15)", "On an iPhone simulator (iOS 18.4)", "On an iPhone simulator with simulated Meta glasses (iOS
18.4)". A second line says "Recorded in the Muse Muse device lab. Not an official Meta product."

Captions use ffmpeg's `drawtext` with the vendored Inter font (SIL OFL, see `assets/Inter.LICENSE.txt`). The Homebrew `ffmpeg`
formula has no `drawtext`, so `setup/mac.sh` also installs `ffmpeg-full`. Without it, a Mac draws the caption through
`lib/caption.jxa` in the system font. A box with neither still makes a clip, with `captionBurned: false`, so the platform must
show the caption as text beside it. That rule keeps the clip honest in every case.

## Control

`ssm/MuseLab-Control.json` is the only way the platform reaches a box. Its one parameter is an enum, and no other input goes
in.

| Action | What it does |
|---|---|
| `status` | Prints JSON: the agent's state, its release, free disk and whether the emulator is up |
| `restart-agent` | Restarts the LaunchAgent or the Scheduled Task |
| `update-agent` | Installs the bundle pinned in Parameter Store, then restarts |
| `cleanup` | Shuts down simulators and the emulator, clears job folders, restarts the agent |
| `reboot` | Reboots in 1 minute. It never stops the Mac, because stopping scrubs it for up to 4.5 hours |

Create it with:

```
aws ssm create-document --region us-east-1 --name MuseLab-Control --document-type Command --document-format JSON \
  --content file://native/lab/ssm/MuseLab-Control.json
```

The document exists in the account as `MuseLab-Control` version 1, and it matches this file.

**Pinning a bundle.** `update-agent` can't take a URL, so the pin lives in Parameter Store at `/musemuse/lab/<lane>/bundle`, as
`{ "version", "url", "sha256" }`. From a laptop with the lab's AWS profile, at a committed tree:

```
AWS_PROFILE=offlinebase AWS_REGION=us-east-1 bash native/lab/setup/publish-bundle.sh
```

That puts the bundle in `s3://muse-knowledge-<account id>/lab/bundles/` and pins it for both lanes. The box checks the checksum.
Blob URLs work too, but the lab has no Blob upload of its own. Both boxes ran `update-agent` this way, and it left the old release
in place. A stopped Windows box can't take a control call, so start it first. On Windows, `update-agent` runs as SYSTEM, so the
bundle waits in `C:\MuseLab\control`, which only SYSTEM and Administrators can write to. In `C:\MuseLab\data` the lab user could
swap it between its checksum and the unpacking, and the next control call would run the swapped code as SYSTEM.

**The instance role, `musemuse-lab`,** is `AmazonSSMManagedInstanceCore` plus the two inline policies in `native/lab/iam/`.
`AmazonSSMManagedInstanceCore` allows `ssm:GetParameter` and `ssm:GetParameters` on every parameter, so an allow can't keep the
lanes apart. `lab-token-read` does it with explicit denies: reading `/musemuse/lab/mac/*` is denied unless the call comes from the
Mac instance, and `/musemuse/lab/windows/*` unless it comes from the Windows one. Checked on Oct 31 with real calls from each box:
each reads its own lane, and the other lane's `token-sha256` and `bundle` answer `AccessDeniedException`, by `get-parameter` and
`get-parameters`. Don't check this with `iam simulate-principal-policy`: given `ec2:SourceInstanceARN`, it reports a deny even for a
box reading its own lane, which the real calls and the agents' claims show is wrong. `lab-files` allows reading `lab/bundles/*` and `lab/shells/*` and
writing `lab/checks/*` in the bucket. Each lane also has `/musemuse/lab/<lane>/token-sha256`, which is the value `native_labs`
needs. Apply a change to the policies with:

```
aws iam put-role-policy --profile offlinebase --role-name musemuse-lab --policy-name lab-token-read --policy-document file://native/lab/iam/lab-token-read.json
aws iam put-role-policy --profile offlinebase --role-name musemuse-lab --policy-name lab-files --policy-document file://native/lab/iam/lab-files.json
```

**The platform role, `musemuse-platform-native`,** can send only `MuseLab-Control` to the two instances, read command results and
instance state, and start and stop only the Windows instance.

## What's on the boxes

As of Oct 31, about 19:30 UTC. Account <account id>, us-east-1, tagged `Project=musemuse-lab`. No inbound ports, and SSM Run Command is
the only way in.

| | Mac | Windows |
|---|---|---|
| Instance | `<mac instance id>`, `mac2.metal` on host `<mac host id>` | `<windows instance id>`, `t3.large` |
| State | Running. Never stop it: stopping scrubs the host for up to 4.5 hours | Stopped, on release `0.1.1-50123fa`. It stopped itself after 20 idle minutes at about 19:15 UTC, then ran once more for that release and was stopped from a laptop at 19:24 UTC |
| OS | macOS 26.7, 300 GB gp3, about 224 GB free | Windows Server 2022, 60 GB gp3, about 38 GB free |
| Session | `ec2-user` signed in by auto-login | `musemuse`, a standard user, signed in by auto sign-in, 1920x1080 |
| Agent | LaunchAgent `ai.musemuse.lab`, release `0.1.1-1a60ff7` in `~/musemuse-lab` | Scheduled Task `MuseLabAgent`, release `0.1.1-50123fa` in `C:\MuseLab`. Both lanes are pinned to `0.1.1-1a60ff7`, whose only change since is Android's, so the next `update-agent` on Windows changes nothing it runs |
| Offers | `ios_sim`, `glasses_sim`, `android_emu`, `desktop_mac` | `desktop_windows` |
| Tools | Node 22, ffmpeg with `drawtext`, `openjdk@17`, `aws`. Xcode 26.6, selected, its license accepted, with the iOS 26.5 simulator runtime. The Android command line tools with `platform-tools`, `emulator`, `platforms;android-35` and the arm64 Google APIs image, their licenses accepted, and the AVD `mm_pixel` | Node 22.22.2, ffmpeg with `drawtext`, `aws` |
| Left running | The simulator `Muse Lab iPhone` and the emulator `emulator-5554`, which the agent keeps up between jobs | |
| Files | `~/musemuse-lab/shells/`: `mac-template.zip`, `lab-ios-sim.tar.gz`, `lab-android.apk`, `glasses-ios-sim.tar.gz` (the builds in `native/releases.json`), `mock-photo.jpg` | `C:\MuseLab\shells\windows-template.zip` |

**The bucket** has this under `s3://muse-knowledge-<account id>/lab/`:

- `bundles/`: the pinned agent bundle.
- `shells/`: `mac-template.zip` (217 MB) and `windows-template.zip` (158 MB), the desktop shell built on the boxes from `native/shell-desktop`
  at this branch's base, plus its source `shell-desktop-src.tgz`, `mock-photo.jpg` and `glasses-check.html`.
- `checks/`: the real clips and reports. `mac-1/`, `mac-2/`, `windows-1/`, `windows-2/` and `windows-3/` are the desktop kinds.
  `20261031T181351Z/` is the first run of the phone kinds, which failed. `warm-1851/`, `glasses-1858/`, `final-1920/`, `final2-1926/` and
`cold-1928/` are the runs after the fixes, and `final2-1926/` has the Android and Mac clips from the final release.
- `xcode-26.6.tar.zst` (2.7 GB). The owner said yes to the licenses and an Xcode check has passed, so it could go now. It's kept until
  the teardown, because it's the only quick way to put Xcode on a new host, and it costs about $0.06 a month.
- `s12/` is gone: the role can't write there any more.

**The agents poll the live site.** The claim route isn't deployed yet, and the site answers routes it doesn't have with a 200 HTML page,
so `agent.log` shows `claim answered with a page, not JSON` once a minute. That's expected until the routes land. Nothing is claimed.

**The token and password.** Both lanes' lab tokens are in Parameter Store as SecureStrings, and nobody has seen them. The Mac's `ec2-user`
password and the Windows `musemuse` password are random and were never shown. To use screen sharing on the Mac, set a new one by
running `mac.sh` with `MUSE_LAB_USER_PASSWORD`.

**Rebuilding the desktop templates.** Unpack `native/shell-desktop` on the box and run `npm ci`. On the Mac run `npx electron-builder --mac`,
which takes about 2 minutes, and keep the zip. On Windows run `npx electron-builder --win dir`, then
`tar.exe -a -c -f windows-template.zip -C dist\win-unpacked .`.

### What it cost so far

Cost Explorer shows nothing useful yet: it lags a day and credits net it to about $0. This comes from instance times, at the
rates the AWS Pricing API gives for us-east-1 on demand. The budget `musemuse-lab` is set at $150.

| Item | Time | Cost |
|---|---|---|
| Windows, running | 3.18 h (first setup), 0.38 h (checks) and 0.43 h (review fixes), 3.99 h in all, on Oct 31, at $0.1108/h, the Windows rate | $0.44 |
| Mac host | Since 06:01 UTC on Oct 31 at $0.65/h, with a 24 h minimum per allocation | About $8.50 by 19:00 UTC on Oct 31. About $75 by Nov 5, 01:00 UTC |
| EBS and S3 | 360 GB gp3 and 3 GB of S3 | Under $5 through Nov 4 |

### Teardown

Nothing stops the Mac host by itself. It bills $15.60 a day, so left running the lab passes its $150 budget around Nov 9. After
the hackathon closes at 9 PM ET on Nov 4, from a laptop with the lab's AWS profile:

1. Terminate both instances:
   `aws ec2 terminate-instances --profile offlinebase --region us-east-1 --instance-ids <mac instance id> <windows instance id>`
2. Release the host once its scrub is done and its 24 h minimum has passed. Until then the call is refused, so try again later:
   `aws ec2 release-hosts --profile offlinebase --region us-east-1 --host-ids <mac host id>`
3. Clear the lab's files: `aws s3 rm --profile offlinebase --recursive s3://muse-knowledge-<account id>/lab/`
4. Delete the parameters under `/musemuse/lab/`, the `MuseLab-Control` document and the two roles, if nothing else will use them.

## The licenses

**The owner said yes to the Xcode and Android SDK licenses on Oct 31.** At 18:13:51 UTC the main session ran `setup/mac-finish.sh` with
`MUSE_LAB_ACCEPT_LICENSES=1` (SSM command `a30352bd`). Xcode's license shows accepted at 18:15 UTC
(`IDEXcodeVersionForAgreedToGMLicense` 26.6), and the SDK, the image and the AVD went in. The command took 13 minutes and exited 1,
because all three checks after it failed:

| Kind | First result | Cause | Now |
|---|---|---|---|
| `android_emu` | `lab_error`, `install_failed` | adb refuses a file whose name doesn't end in `.apk`, and the download cache names files by their sha256 | The runner copies the download to `app.apk`. Then the clip failed: stopping the local adb right after `pkill` ended the session, and the device killed screenrecord before it wrote the moov atom. The runner now waits for screenrecord to go first. Passes, with a clip |
| `ios_sim` | Failed: "The screen stayed blank" | On a cold simulator the report came 23 s after launch. The screenshots and the 15 s clip had already ended on the shell's white loading screen | Shots follow the report, and the clip keeps the end of the recording. Passes on the warm simulator, and on a freshly booted one at 19:28 UTC. That page loaded in 1.7 s, though, so the 23 s case itself has only been checked in the unit tests |
| `glasses_sim` | Failed: "The app didn't open" | `simctl launch` ran past its 45 s limit just after the install, and the reason wasn't logged | 120 s, a 5 s pause after an install, the reason in the log, and launch arguments instead of the deep link. Opens and loads. Then its clip never finished encoding: a frame that lasted 60 s began before the clip's start, and a seek dropped it. Clips are now trimmed after `fps` fills the gaps, and every encode has an end. Still fails at the mock glasses, see below |

`setup/mac.sh` now leaves Xcode selected on a run without the flag once the license is accepted, so it's safe to run again for a new
screen sharing password. Run without the flag on Oct 31, it kept Xcode and the four kinds. The flag isn't needed again.

### Checking the phone kinds

This runs the three phone checks on the shell builds on the box, accepts nothing and spends nothing:

```
aws ssm send-command --profile offlinebase --region us-east-1 --instance-ids <mac instance id> \
  --document-name AWS-RunShellScript --parameters '{"executionTimeout":["1800"],"commands":["sudo -u ec2-user -H env AWS_REGION=us-east-1 bash /Users/ec2-user/musemuse-lab/current/setup/mac-checks.sh"]}' \
  --query Command.CommandId --output text
```

Results go to `~/musemuse-lab/checks/<time>/` and `lab/checks/<time>/`, and exit code 0 means all three passed. `ios_sim` and
`android_emu` open the live site. The live site isn't a glasses product, so `glasses_sim` opens `glasses-check.html` from the bucket,
which keeps the glasses template's contract.

**`glasses_sim` runs on iOS 18.4, on its own simulator.** The same shell build (`68c9d5ab`) answers `no_eligible_device` from the mock
glasses on iOS 26.5 and reaches ready on iOS 18.4, so the runner uses `Muse Lab iPhone 18` (`MUSE_LAB_GLASSES_SIMULATOR`), an iPhone 16 on
the iOS 18 runtime. Without that runtime the job ends in `simulator_failed`, not as a product failure. `ios_sim` stays on the newest runtime.
Seen on Nov 1: fails on 26.5 (`lab/checks/direct-1101-2047/glasses_sim/`), passes on 18.4 (`lab/checks/direct-1101-2047-g18/` and, with the runner's own choice of
simulator, `lab/checks/direct-1101-2047-fixed/`). Why 26.5 fails isn't known: the shell's own message is still lost in release builds. Mock glasses only.

## Checking a box by hand

`tools/check.mjs` runs one real job on the box, with a small stand-in for the platform on 127.0.0.1. It starts a temporary agent in the GUI
session, keeps the job's files in `--out`, and spends nothing. It's how a box gets tested while the routes aren't live.

```
node ~/musemuse-lab/current/tools/check.mjs --kind desktop_mac --app ~/musemuse-lab/shells/mac-template.zip \
  --target https://muse-muse.vercel.app/ --out ~/musemuse-lab/checks/mine --limit 240
```

Run it as `ec2-user` on the Mac. Run it as SYSTEM through SSM on Windows, where it registers a temporary task in the `musemuse` session and
removes it after. Start the Windows box first, and remember the idle stop is running.

## Setting up the Mac

A dedicated `mac2.metal` host, 300 GB gp3, with no key pair and a security group with no inbound rules. Reach it only through SSM.

1. Put Xcode at `/Applications/Xcode.app`. This box has 26.6.
2. Unpack `native/lab` on the box, then run it as `ec2-user`:
   ```
   MUSE_LAB_PLATFORM=https://muse-muse.vercel.app AWS_REGION=us-east-1 bash setup/mac.sh
   ```
   Set `MUSE_LAB_USER_PASSWORD` if you want to know the password for screen sharing. Otherwise it's random and unseen. Running it again
   leaves auto-login alone, keeps Xcode selected once its license is accepted, and, run from `~/musemuse-lab/current/setup/`, stays on
   the installed release. "The disk resize didn't run" on a second run is normal: the disk is already full size.
3. Put the lab token in Parameter Store, then reboot. Auto-login starts the agent in the GUI session.
4. Check `~/musemuse-lab/logs/agent.log`. Its first lines list the kinds the box can run.

**The script resizes APFS, turns on auto-login and turns off sleep and the screen lock.** It installs Homebrew's `node@22`, `ffmpeg`,
`ffmpeg-full`, `openjdk@17` and `awscli`, and the LaunchAgent. The Xcode and Android steps only run with `MUSE_LAB_ACCEPT_LICENSES=1`,
which has been done on this box. See "The licenses".

Two things macOS 26 does that the script handles:

- **Auto-login.** `sysadminctl -autologin set` fails with `SACSetAutoLoginPassword error:22` and still exits 0, so the script writes
  `/etc/kcpassword` itself, readable only by root. A reboot on Oct 31 signed `ec2-user` in with this, and the agent started.
- **The metadata address.** The Local Network privacy check refuses `169.254.169.254` to `ec2-user`'s Homebrew tools with `No route to
  host`. Root isn't affected, and only a person at the screen could answer the prompt. So the agent couldn't read its token, and the
  `aws` CLI said `NoCredentials`. `~/.aws/config` now uses `setup/imds-credentials.sh` as its `credential_process`, which gets the instance
  role's credentials with Apple's own `curl`. Anything new on the Mac that wants the role has to use the `aws` CLI or that script.
- **Restarting the agent.** `launchctl bootstrap` right after `bootout` fails with an I/O error while the old agent is still shutting
  down, which left no agent running on Oct 31. The script now tries again for up to 90 s.

## Setting up Windows

An on-demand `t3.large` running Windows Server 2022, 60 GB, with shutdown behavior left at `stop`, and no inbound rules.

1. Unpack `native/lab` on the box.
2. In an elevated PowerShell:
   ```
   powershell -ExecutionPolicy Bypass -File setup\windows.ps1 -Platform https://muse-muse.vercel.app -Region us-east-1
   ```
3. Put the lab token in Parameter Store, then reboot. The box signs in by itself as the standard user `musemuse`, and a Scheduled
   Task starts the agent in that session, with no RDP attached.

Auto sign-in is Windows' own, with the password as an LSA secret, so there's no third-party tool and no license to accept.
`Set-DisplayResolution` in the agent's start script gives the session 1920x1080.

**Permissions.** The control document runs `C:\MuseLab\current\control.mjs` as SYSTEM, so the lab user mustn't be able to change
anything under `C:\MuseLab` but `data` and `logs`. A new folder on C: inherits a grant that lets any user add files, so the script
removes inheritance from `C:\MuseLab` and grants SYSTEM and Administrators full control and Users read and run. `C:\MuseLab\control`
is SYSTEM and Administrators only. Checked on Oct 31 by writing as `musemuse` in session 1: `data` and `logs` took the write, and
`C:\MuseLab`, `current`, `releases`, `control`, `shells` and `current\control.mjs` refused it. `tools/check.mjs` grants the lab user
its own `--out` folder, so keep that under `C:\MuseLab\data`.

The agent stops the box after 20 idle minutes. Starting it again is the platform's job: `ec2:StartInstances`, then wait for a claim call.
It took about 30 seconds from the start call to the agent's first log line, so 6 minutes is plenty. The idle clock runs whatever the
platform answers, so a box that gets 401s or 404s, because the routes or the flags aren't live yet, still stops itself. If the `shutdown`
command fails, the agent stays up and tries again each minute.

## Spike results

All run on the real boxes on Oct 31, with the local stand-in. The clips are in the bucket under `checks/`. The phone kinds ran after the
owner's yes to the licenses.

| Spike | Result | What really ran |
|---|---|---|
| S3, Electron in the GUI session | **Passed** | The real universal desktop shell, built on the box, in `ec2-user`'s session against the live site. All checks passed, 27 frames, a framed 1920x1080 clip. `codesign --verify --deep --strict` passes and Gatekeeper rejects it, as expected for an ad hoc app |
| S4, Windows with no RDP | **Passed** | After a reboot and after a stop and start: `musemuse` signed in on the console, one `node.exe` in session 1, and a check passed with a framed clip. Session 1 measured 1920x1080 after the reboot (08:52 UTC) and after a stop and start (18:53 UTC). Nobody ever used RDP |
| Windows restart | **Passed** | `restart-agent` and `update-agent` each left exactly one `node.exe`, with the pid file right |
| Taskkill filters | **Passed** | `/F /T /FI "PID eq 4" /FI "IMAGENAME eq node.exe"` left the System process alone and exited 0 |
| Windows idle stop | **Passed** | At 09:12:17 UTC, 20 minutes to the second after the agent's start: `idle shutdown` in the log, event 1074 from `shutdown.exe` for `musemuse`, and EC2 state reason `Client.InstanceInitiatedShutdown`. It fired again at about 18:18 UTC on the claim-failure path after the final update, with the same state reason |
| S12, large uploads | **Passed** | 150 MiB and 215 MiB of random bytes and each box's real zip (217 MB Mac, 158 MB Windows). All reached S3, at 67 to 200 MB/s, and the 215 MiB objects' ETags end in `-27`, so they went up as multipart. The lab's own Blob client also sent each through a local server that reassembled the parts: same sha256, peak memory about 250 MB. Real Vercel Blob wasn't hit, because the routes that issue its tokens aren't live |
| S1, the emulator | **Passed** | The emulator booted in about 61 s on the first run and stays up between jobs. The lab APK opened the live site by its deep link: loaded,
bridge handshake, not blank, the report through logcat, and a framed 1920x1080 clip at 19:26 UTC on `0.1.1-1a60ff7`. Still untested
from wave 1's list: the 250 ms backstop, the microphone path, cleartext and the head-script probe |
| S2, simctl from a LaunchAgent | **Passed** | `ios_sim` from the check tool's LaunchAgent in `ec2-user`'s GUI session: launched, loaded the live site, bridge handshake, not blank, a framed clip. At 18:41 UTC on the old code and at 18:51 UTC on `0.1.1-db1609a`, both on a warm simulator. The first run, on a cold simulator, failed as blank, which the fix above addresses, but a cold run hasn't been repeated |
| Glasses S2 | **Passed on iOS 18.4, Nov 1. Fails on iOS 26.5** | On 18.4: mock glasses connect, the main button is pressed, a result shows a 1024x683 photo and 5.3 s of sound, with a framed clip. On 26.5 the mock glasses answer `no_eligible_device`. See "Checking the phone kinds" |

## Running it against a local platform

```
MUSE_LAB_PLATFORM=http://127.0.0.1:3000 MUSE_LAB_ALLOW_INSECURE=1 MUSE_LAB_TOKEN_FILE=/path/to/token \
MUSE_LAB_ROOT=/tmp/lab MUSE_LAB_KINDS=desktop_mac node native/lab/agent.mjs
```

`MUSE_LAB_ALLOW_INSECURE` only works when the platform is on loopback.

| Setting | Default | Meaning |
|---|---|---|
| `MUSE_LAB_LANE` | From the OS | `mac` or `windows` |
| `MUSE_LAB_PLATFORM` | `https://muse-muse.vercel.app` | Must be https, except on loopback |
| `MUSE_LAB_ROOT` | `~/musemuse-lab`, `C:\MuseLab` | Everything of the agent's |
| `MUSE_LAB_SLOTS` | `1` | `1` or `2`. Two jobs never share the simulator or the emulator |
| `MUSE_LAB_KINDS` | All it can run | Narrows what it offers |
| `MUSE_LAB_IDLE_MINUTES` | 20 on Windows, off on the Mac | When it stops the box |
| `MUSE_LAB_FFMPEG` | Found | A specific ffmpeg |
| `MUSE_LAB_AVD`, `MUSE_LAB_ANDROID_LABEL` | `mm_pixel`, `Pixel 7` | The emulator and its name in captions |
| `MUSE_LAB_SIMULATOR`, `MUSE_LAB_IPHONE_TYPE` | `Muse Lab iPhone`, newest plain iPhone | The simulator |
| `MUSE_LAB_GLASSES_SIMULATOR` | `Muse Lab iPhone 18` | The simulator for `glasses_sim`, on iOS 18 |

## Security

- **The box takes nothing inbound.** It has no SSH keys, and it reaches out over HTTPS only.
- **No tool runs through a shell.** Every command is an argv array. The one place a real shell is involved is `adb shell`, which
  joins its arguments on the device, so those go through `shQuote`.
- **Tokens stay out of logs and uploads.** The logger and the uploaded `log.txt` and `report.json` hide them by value and by
  shape. Tests check both.
- **Each lane reads only its own parameters,** through explicit denies in the instance role. See "Control".
- **Product content stays in sandboxed renderers.** Captions never carry product text. On Windows, the agent runs as the
  standard user `musemuse`, who can't change anything SYSTEM runs. See "Setting up Windows". **On the Mac it runs as `ec2-user`, who has passwordless sudo,** and `setup/mac.sh` relies on that.
  So a renderer or simulator escape on the Mac can reach root. Only the sandbox stands in the way there. The license step that needed
  the sudo has run, so it could now be narrowed to what a second `mac.sh` run needs, or removed. That's the owner's call.
- **Downloads** come only from Blob or the platform, with no redirects, and are checked against their sha256.
- **Target URLs** must be public https, which keeps the box's metadata service (`169.254.169.254`) and anything local out of
  reach of a job.
