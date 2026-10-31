# The device lab

The lab checks each product on an iPhone simulator, an Android emulator, a Mac and Windows, and records a clip of each. It
runs on two AWS boxes, which take no inbound connections. An agent on each box asks the platform for work.

The agent and its files live in `native/lab/`. This document is the contract between that code and the parts that come
later: the routes under `app/api/native/agent/`, the `native_jobs` queue and the sweep. Write those against this page.

| File | What it is |
|---|---|
| `native/lab/agent.mjs` | The agent: claim loop, idle stop, clean shutdown |
| `native/lab/lib/execute.mjs` | One job from start to finish: deadline, heartbeats, uploads, the finish call |
| `native/lab/jobs/` | The runners: `ios_sim`, `android_emu`, `desktop_mac`, `desktop_windows`, `glasses_sim` |
| `native/lab/compose.mjs` | The clip: a recording in a generic device frame on a Meta-blue backdrop, 1920x1080, with a caption and a poster |
| `native/lab/control.mjs` | The box's side of the SSM control document |
| `native/lab/ssm/MuseLab-Control.json` | The SSM document: enum actions only |
| `native/lab/setup/` | `mac.sh`, `windows.ps1`, and the LaunchAgent plist |

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

Clear the job's stored selftest report in the same step, since a retry keeps its job id and selftest token. The agent also
ignores a report dated before its launch, as a second guard, so keep the shell's `at` as it was sent.

### POST /api/native/agent/jobs/{id}/heartbeat

Job token. Sent every 15 s, and once at the start.

```json
{ "phase": "record", "attempt": 1 }
```

`phase` is one of `start`, `download`, `boot`, `install`, `media`, `record`, `autopilot`, `selftest`, `report`, `compose`,
`upload`.

| Status | Meaning |
|---|---|
| 200 | `{ "cancel": false }`. With `true`, the agent stops the job and finishes it with code `canceled` |
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
  "pathname": "native/runs/<runId>/<jobId>/clip.mp4",
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
  validUntil: Date.now() + 15 * 60_000,
  ...limits,
  ...blobAuth(),
});
const { presignedUrlPayload } = await handleUploadPresigned({
  body: { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: null, multipart } },
  request,
  webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY || NO_CALLBACK_KEY,
  getSignedToken: async () => ({ token, urlOptions: { ...limits, addRandomSuffix: false, allowOverwrite: true } }),
});
```

`allowOverwrite` is there because a retried job writes to the same pathnames. Only ever issue pathnames under
`native/runs/<runId>/<jobId>/`, from the job row and never from the request.

For a local platform with no Blob store, a slot can be `{ "name", "method": "put", "pathname", "url", "headers" }`. The
agent PUTs the bytes there and expects `{ "url", "pathname" }` back. Nothing but the local dev server should do this.

### POST /api/native/agent/jobs/{id}/selftest

Job token. Body `{}`. Answers `{ "report": <report> }` with what the shell posted to `/api/native/selftest` for this job, or
`{ "report": null }` if it hasn't posted yet. A 410 reads as no report. The agent polls this until 70 s after launch when the
report doesn't reach it any other way, which is the normal case on iOS (see "What the shells do"). That's long enough for the
report the shell's own 60 s watchdog sends for a page that hangs.

Selftest tokens are the HMAC tokens from `lib/native/lab-token.ts`. They have to name the job, so that this route can find
the report.

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

**Trust nothing here for money or for the gallery.** Treat `artifacts[].url` as a claim, and check that its pathname sits
under this job's folder before storing it.

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

- **`selftestSeconds`** (8 to 20, default 12) on the desktop kinds sets how long the frames play for. The shell itself
  records for 12 s.
- **`glasses_sim`** also takes `scenario` (`capture-and-ask`, the default) and `media`: `{ photo: { url }, feed?: { url },
  question?: { url } }`. Without a feed, the lab makes one from the photo. It's H.265, as Meta's mock camera requires.

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
  The design also asks for no `window.onerror`, which isn't checked yet: the autopilot's checkpoints don't carry page errors, so
  a product that throws an uncaught error and still shows a result passes. The shell has the list in `internal.pageErrors()`,
  and could add it to the `result` checkpoint.

## What the shells do

Checked against `native/shell-mobile` and `native/shell-desktop` on the `tg-shells` branch as of Oct 31.

**Phone, lab variant, iOS.** Launch arguments, read in `launchArgsToRequest`: `-museUrl`, `-museSelftest 1`, `-museToken`,
`-musePlatform`.

**Phone, lab variant, Android.** A deep link, read in `parseDeepLink`:
`musemuse-lab://check?url=...&selftest=1&token=...&platform=...`.

**The health report on phones.** The agent looks in this order:

1. `Documents/selftest.json` (iOS only). **The shell doesn't write this yet.**
2. A `MUSE_SELFTEST <json>` line in the device log. Android's logcat gets this in release builds. Logcat cuts lines at about
   4 KB, so the shell should keep the line under 3.5 KB by trimming `errors`.
3. The platform's copy, through the selftest route above. It only counts if its `at` is after this launch.

iOS release builds drop `console.log` below the error level, so on iOS only 1 and 3 will work. Adding this to `report` in
`ProductScreen.js` makes iOS independent of the network:

```js
const file = new File(Paths.document, "selftest.json");
if (!file.exists) file.create();
file.write(JSON.stringify(result));
```

**Desktop.** `<exe> --muse-selftest=<dir>`. The shell writes `selftest.json`, `frames/00001.jpg` and so on, and
`stills/01.png` and so on. The frame names are a count, so the lab times frames by when they were written. The exit code is 1
whenever the shell's own report isn't ok, so the lab only treats an exit code as a crash when there's no report.

The app opens the URL in its `muse-product.json`. For `variant: "lab"`, the lab rewrites that file for the job, then on a Mac
signs the app again, ad hoc, because the change breaks the resource seal. A `product` app is left exactly as it shipped, so
its signature check means something.

**Glasses.** The lab copies media into the shell's `Documents`: `mock-feed.mov`, `mock-photo.jpg` and `mock-question.wav`
(the shell doesn't read the last one yet). It launches the app, waits 2 s, and sends
`musemuse://check?url=...&mock=1&run=autopilot`. If no checkpoint shows up in 60 s, it launches again with `-museUrl`,
`-museMock 1` and `-museRun autopilot`, adds a warning, and counts the load limit from that launch, because the system may hold
a link back to ask for permission. The wait is that long because the first checkpoint only comes once the page has loaded.

The autopilot writes `Documents/autopilot.jsonl`, one `{ step, ok, detail, at }` per line, with the steps `start`, `connect`
(detail is the mode), `primary`, `result`, `timeout` and `error`. It has no checkpoint for the capture itself, so that's
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

**Pinning a bundle.** `update-agent` can't take a URL, so the pin lives in Parameter Store at `/musemuse/lab/<lane>/bundle`, as
`{ "version", "url", "sha256" }`. Make the bundle with:

```
tar -czf musemuse-lab-0.1.0.tgz -C native/lab --exclude __tests__ .
```

Upload it to Blob, then put the pin in Parameter Store. The box only downloads from Blob, and checks the checksum.

**This widens one IAM line in the design.** The instance profile needs `ssm:GetParameter` on `/musemuse/lab/<lane>/*`, not only
on `.../token`. The profile also needs `AmazonSSMManagedInstanceCore`. Nothing else.

## Setting up the Mac

A dedicated `mac2.metal` host in us-east-1, 300 GB gp3, with no key pair and a security group with no inbound rules. It's never
stopped during the event. Reach it only through SSM Session Manager.

1. Install Xcode 26.4 or later. Either bring the .xip over, or sign in once over screen sharing through an SSM port-forward.
2. Unpack `native/lab` on the box, then run it as `ec2-user`:
   ```
   MUSE_LAB_PLATFORM=https://muse-muse.vercel.app AWS_REGION=us-east-1 bash setup/mac.sh
   ```
   Set `MUSE_LAB_USER_PASSWORD` if you want to know the password for screen sharing. Otherwise it's random and unseen.
3. Put the lab token in Parameter Store, then reboot. Auto-login starts the agent in the GUI session.
4. Check `~/musemuse-lab/logs/agent.log`. Its first line lists the kinds the box can run.

**The script resizes APFS, turns on auto-login and turns off sleep and the screen lock.** It installs Homebrew's `node@22`,
`ffmpeg`, `ffmpeg-full`, `openjdk@17` and `awscli`, the Android tools with an arm64 `android-35` `google_apis` image and the AVD
`mm_pixel`, and the LaunchAgent.

Then run the native lane's spikes on the box. Until then, none of this has run on one:

| Spike | How to check it |
|---|---|
| S1, the emulator | An `android_emu` job passes with a real clip. Boots in under 3 minutes |
| S2, simctl from a LaunchAgent | An `ios_sim` job passes with a real clip. Fallback: `launchctl asuser` from an SSM session |
| S3, Electron in the GUI session | A `desktop_mac` job passes with frames |
| S12, large uploads | A 150 MB file goes up through a multipart slot |
| Glasses S2 | A `glasses_sim` job reaches `result` with the mock glasses |

## Setting up Windows

An on-demand `t3.large` running Windows Server 2022, 60 GB, with shutdown behavior left at `stop`, and no inbound rules.

1. Unpack `native/lab` on the box.
2. In an elevated PowerShell:
   ```
   powershell -ExecutionPolicy Bypass -File setup\windows.ps1 -Platform https://muse-muse.vercel.app -Region us-east-1
   ```
3. Put the lab token in Parameter Store, then reboot. The box signs in by itself as the standard user `musemuse`, and a Scheduled
   Task starts the agent in that session, with no RDP attached (spike S4).

The agent stops the box after 20 idle minutes. Starting it again is the platform's job: `ec2:StartInstances`, then wait up to 6
minutes for a claim call. The idle clock runs whatever the platform answers, so a box that gets 401s or 404s, because the routes
or the flags aren't live yet, still stops itself. If the `shutdown` command fails, the agent stays up and tries again each minute.

**`windows.ps1` hasn't run yet.** No machine here has PowerShell, so only its contents are tested. Check these on the first box:

| Check | How |
|---|---|
| The box signs in and the agent starts | `agent.log` shows a claim call, with no RDP attached (spike S4) |
| The idle stop works | The box stops after 20 idle minutes. Check `agent.log` for `idle shutdown failed` |
| A restart leaves one agent | `restart-agent`, then `tasklist /fi "imagename eq node.exe"` shows one `node.exe`. `schtasks /End` only stops the PowerShell wrapper, so the restart also ends the pid in `data\agent.pid` with `taskkill` |

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

## Security

- **The box takes nothing inbound.** It has no SSH keys, and it reaches out over HTTPS only.
- **No tool runs through a shell.** Every command is an argv array. The one place a real shell is involved is `adb shell`, which
  joins its arguments on the device, so those go through `shQuote`.
- **Tokens stay out of logs and uploads.** The logger and the uploaded `log.txt` and `report.json` hide them by value and by
  shape. Tests check both.
- **Product content stays in sandboxed renderers.** Captions never carry product text. On Windows, the agent runs as the
  standard user `musemuse`. **On the Mac it runs as `ec2-user`, who has passwordless sudo,** and `setup/mac.sh` relies on that.
  So a renderer or simulator escape on the Mac can reach root. Only the sandbox stands in the way there.
- **Downloads** come only from Blob or the platform, with no redirects, and are checked against their sha256.
- **Target URLs** must be public https, which keeps the box's metadata service (`169.254.169.254`) and anything local out of
  reach of a job.
