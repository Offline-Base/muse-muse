# Wave 3 status

Written Nov 1, 2026, about 02:30 EDT. Branch tg-cap-int, head 34d6608. Sources: this run's checks, docs/CAPABILITIES.md,
docs/DRIVE_EXPORT.md, wave3-log.md.

## Where it stands

- All 15 unit branches are merged into tg-cap-int (tg-cap-musecode counted as its own).
- Every capability is built and tested with fakes. None has passed a real test build.
- Every CAP_READY line is false. Turning on a cap's flag alone serves nothing.
- Nothing from wave 3 is in production. Wave 3 branches are on GitHub only as backup refs.

## Final checks (this run, nice -n 10, DATABASE_URL unset)

| Check | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| lib and components, .test.ts | 5509 | 5501 | 0 | 8 |
| lib, components and app, .test.tsx (50 files) | 792 | 792 | 0 | 0 |
| template/scripts | 700 | 698 | 0 | 2 |
| muse-device, test_server and test_drive | 147 | 144 | 0 | 3 |

- tsc: clean, exit 0.
- The working tree stayed clean after the checks.
- The 8 skipped .test.ts tests are live Meta tests. They need MODEL_API_KEY, which was not set.
- The template skips are the real Pyodide test, the real speech model test and loading the extension in full Chromium. Each
  needs a file or a browser that isn't set up here. So in this run those three did not run. Earlier unit runs did them.
- muse-device's test_drive_loop.py was not run. It has never run: it needs Linux as root.
- No model call, sandbox, Blob, Vercel or Composio call in this run. Spend $0.
- No next build, as the rules say. No wave 3 branch has ever had one.

Goldens: the 11 brief goldens match tuned-model-options exactly. The 7 goldens in lib/caps/__tests__/golden are new files and
their tests pass. The log's last check that these goldens equal the code without wave 3 was at the UI brand merge (Oct 31,
18:57). This run did not repeat that clean-copy check.

## What blocks every unit's real test build

Section 22 asks for one real test build per capability. Almost none ran, all for the same reasons:

1. A local run's sandbox can't reach a localhost gateway. A build needs a public PLATFORM_URL or the preview database.
2. A credentialed run wasn't available. The token on this machine expired Oct 29, and `vercel env pull` to a temp file was refused
   by the permission classifier (Credential Materialization). No unit worked around it.
3. The builder snapshot doesn't hold template/caps yet. General's next snapshot (Nov 2 morning) comes after tg-cap-int merges.
   A manifest entry in lib/sandbox/snapshots.json follows it.
4. A platform dev server doesn't serve from a worktree with a symlinked node_modules. So nothing on the platform side was seen in
   a browser.

## Per unit

### 1. Trust

- Built: sign-in tiers, a builder's daily dollars, 18+ gate, platform and product legal pages, geo block, report link, takedown,
  ban, Spark to Wonder, the big-file deploy fix. Migration 0018.
- Flags: TRUST_SIGNED_IN_CAPS, TRUST_BUILDER_DAILY_USD, TRUST_AGE_GATE, TRUST_LEGAL_PAGES, TRUST_GEO_BLOCK, TRUST_GEO_COUNTRIES,
  TRUST_REPORTS, TRUST_SPARK_TO_WONDER, TRUST_DEPLOY_TOTAL_MB.
- The deploy fix has no flag (decision 1). So it is a production change once merged, on purpose.
- Proven by tests: a guest gets no builder caps, a banned owner's token gets 403, country block with Next's matcher, takedown,
  the real collect script with 11 MB and 100 MB files, the overlay in a product copy.
- Untested: the guest test build, next build with the overlay, the trust spec in Playwright, pause and unpause and domain removal
  on the real Vercel API, whether 100 MB is per file or in all, the age cookie in a frame on Safari.
- Spend: Meta $0.000872 (one brief on Contributor). Sandbox $0.

### 2. Engine

- Built: round time by brief size, chained milestones, verify and fix after a first round hits its cap, exact logic rule, the
  live check, the caps frame and registries, output fit for Wonder. Migration 0019.
- Flags: ENGINE_CHECK_ON_TIMEOUT, ENGINE_ROUND_SCALING, ENGINE_ROUND_MAX_MINUTES, ENGINE_MILESTONES, ENGINE_LIVE_SMOKE,
  ENGINE_EXACT_LOGIC, ENGINE_FIT_OUTPUT.
- Proven by real builds, the only unit with them: the tile game note went live locally in 8 minutes for $0.026, and a milestone
  build ran its chain on a real sandbox. The tile game's brief came out smaller, so it doesn't prove the old timeout is fixed.
- Untested: a first round that really hits its cap and then ships (scenario tests only), the live check on a published deploy, the
  3-cap milestone build, the new verify.mjs and playwright.config.ts in a real sandbox.
- After the next snapshot: run one no-caps build and compare its verify steps with today's, before any push.
- Spend: Meta $0.144 recorded, plus about $1.10 to $2.30 estimated for smoke-test calls that went straight to Meta on Wonder and
  weren't metered. These broke the TEST_MODEL rule. Their data was made up. The total is about $1.25 to $2.45 of its $3. Sandbox not
  totaled.

### 3. Data

- Built: the cap gate, who is asking, {GATEWAY_URL}/data with shared, visitor and owner scopes, quotas, passkey sign-in for products'
  own users, data() and currentUser(), snapshot readiness (2.4a). Migration 0020.
- Flags: DATA_ENABLED, DATA_SIGN_IN, DATA_PRODUCT_ROWS, DATA_PRODUCT_MB, DATA_DAILY_WRITES.
- Proven by tests: gate order and refusals, each scope against each caller on PGlite, quotas, forged and expired codes, WebAuthn
  with a fake authenticator, readiness with a missing cap.
- Untested: the grocery list build, real passkeys in a browser, Neon, the second browser check in Playwright.
- Known gap: decision 13 isn't met. Nothing deletes a product, owners can't delete others' private rows, end users can't delete
  their passkeys.
- Spend: $0.

### 4. Files and search

- Built: files() with quotas, search with citations, vetted datasets, the CC0 3D manifest rules. Migration 0021.
- Flags: FILES_ENABLED, FILES_SEARCH, FILES_DATASETS, FILES_PRODUCT_MB, FILES_MAX_FILE_MB, FILES_BLOB_STORE_ID.
- Proven by tests: tickets, quotas, scopes, signed links, search chunks and privacy, datasets, all on PGlite with a fake Blob store.
- Untested: the notes library build, presigned uploads against real Blob and its CORS, a private store at all, Neon's text search,
  checkFiles in Playwright.
- Spend: $0.

### 5. Connect

- Built: fetchPublic allowlist with recorded samples, a per-product key vault, brokered calls, email and chat sends with one
  confirmation each. Migration 0022.
- Not built: more Composio tools. CONNECT_MORE_TOOLS exists and nothing reads it. It needs a Composio sync.
- Flags: CONNECT_ENABLED, CONNECT_VAULT, CONNECT_VAULT_KEY, CONNECT_SENDS, CONNECT_SENDS_PRODUCTION, CONNECT_MORE_TOOLS.
- Proven by tests: allowlist paths, vault round trip with no value in any answer, one send per approval, sends off, against fakes.
- Untested: the weather planner build, a live /fetch from a deployed gateway, any real Resend or Slack send. The four services' build
  samples are made up.
- Spend: $0. Composio $0.

### 6. Jobs

- Built: schedules, cron fan-out, job tokens, per-run dollars, webhooks, checkpoints, held sends, owner notices, the 14-day pause.
  Migration 0023.
- Flags: JOBS_ENABLED, JOBS_WEBHOOKS, JOBS_DAILY_RUNS, JOBS_DAILY_USD, JOBS_RUN_USD, JOBS_PAUSE_DAYS, JOBS_PRODUCT_DAILY_RUNS,
  JOBS_PRODUCT_DAILY_USD.
- Proven by tests: time zones, the floor, refusals, and a scenario with only Meta's answer faked: a digest fired twice, a checkpoint
  resumed, a webhook into a log, then the real cron code. It ran under plain Node.
- Untested: the digest build, the Vercel cron firing, Next's fetch wrapper with ours in a running server, the owner's panels in a browser,
  a real import.
- Spend: $0.

### 7. Live

- Built: captions from 2 to 3 second chunks, live updates over SSE, a test mic fixture.
- Flags: LIVE_ENABLED, LIVE_UPDATES, LIVE_CAPTION_MINUTES.
- Proven by tests: scopes, tickets, reconnects, stream caps, the fake mic in real Chromium. Real Muse Voice Transcribe ran once on the
  fixture. A change showed in a second browser in 1789 ms.
- Untested: the build, the stream on Vercel and Neon, Safari, a real microphone, the poll's cost at the row quota. No daily stream
  budget exists, and only LIVE_UPDATES stops it.
- About 5 people can caption at once on one product. Past that, words are lost with no error.
- The fixture is still made with macOS `say`. The classifier refused running espeak-ng from npm.
- Spend: Meta under $0.001. Sandbox $0.

### 8. Media

- Built: SpeechT5 speech in the browser (MIT), video with WebCodecs and our own MP4 writer (no ffmpeg), MIDI, SAM tiling.
- Flags: MEDIA_ENABLED, MEDIA_SPEECH, MEDIA_VIDEO, MEDIA_MUSIC, MEDIA_SAM_TILING.
- Proven by tests and measurements: real speech and real video in Chromium on this laptop, tile math, MIDI bytes, the assets route.
  Nobody has listened to the voice.
- Untested: the three builds, the Blob mirror, the sandbox's Linux Chromium (H.264 and voices), SAM against the real API, phones, Safari,
  Firefox.
- Spend: $0.

### 9. Code

- Built: Pyodide and QuickJS in a sealed frame, {GATEWAY_URL}/exec, {GATEWAY_URL}/browse. Migration 0024.
- Flags: CODE_ENABLED, CODE_EXEC, CODE_EXEC_VISITORS, CODE_EXEC_DAILY_USD, CODE_EXEC_SNAPSHOT_ID, CODE_BROWSE, CODE_BROWSE_DAILY_USD.
- Proven by tests: limits, a hostile program blocked in the frame in Chromium, real Pyodide run once with PYODIDE_TEST_DIR.
- Untested: any real sandbox, including that "deny-all" blocks everything. QuickJS itself (stand-in engine only). Firefox and Safari.
  The static files on a real deploy.
- Spend: $0.

### 9b. Muse Code in products

- Built: {GATEWAY_URL}/code/sessions, a sibling sandbox per session that reaches only POST /v1/responses, a one-session token at $1 and
  15 minutes, a result zip with no binary, a secret scan, a sweep, the template kit. Migration 0028.
- Flags: MUSE_CODE_ENABLED, MUSE_CODE_VISITORS.
- It adds a cron, /api/cron/musecode-sweep, every 2 minutes. It answers skipped with the part off, but it does run.
- Proven by tests: scope, body and ceiling rules, the zip, the tar, the kill script, redaction, replay mode.
- Untested: no real session has run. The gateway hop through the firewall, Wonder (refusing muse-spark-1.3 could break its background
  models), the context-limit key, Vercel's sandbox calls, the CodeRun screen past its first render.
- Spend: $0 of $2 and $1.

### 10. Runtime

- Built: Python functions in products with a guard and a safety scan, PyPI GET only in the build firewall, VS Code extension, GitHub
  Action and self-host kit outputs.
- Flags: RUNTIME_ENABLED, RUNTIME_OUTPUTS.
- Proven: one real sandbox probe (numpy through the GET-only rule, POST and PUT refused), the guard under the local runner, the extension
  packaged with vsce.
- Untested: the build, Python functions on a real Vercel deployment (the main question), the deployment files API, the Action on a real
  runner, the extension in real VS Code.
- Spend: Meta $0. Sandbox under $0.01.

### 11. GPU

- Built: POST {GATEWAY_URL}/glimmer/v1/chat/completions, admin demo windows under a daily cap, ownModelFor, askGlimmer with a Wonder
  fallback, train on my data, the /models slot. Migration 0025.
- Flags: GPU_GLIMMER_SHARED, GPU_GLIMMER_DAILY_USD, GPU_GLIMMER_ALL_PRODUCTS, GPU_TRAIN_ON_DATA. Train on my data also needs General's
  TUNE_COMPOSER.
- Proven by tests: windows and the cap, private reads, the real launchJob and chat backend on PGlite with Lambda and the GPU's answer
  faked.
- Untested: the build, a real window, a reply from a real model, a non-admin's link to the run room (only admins can open it until
  PUBLIC_TRAINING).
- Spend: $0. GPU $0.
- Small leftover found in this run: lib/train/base.ts is on tg-cap-int now, but lib/caps/gpu/general.ts is still the temporary seam. It
  keeps its own copy of the r30b rule, and verdictFor doesn't pass sparkOpen to evalVerdict. From reading verdict.ts, the effect is
  wording: the verdict says "base" where it should say "the 2026 Glimmer it started from". Section 17a's note on this is stale too.
  Not fixed here, since this step is read-mostly. It's a one-file swap.

### 12. Drive export

- Built: one layout shared with bench drives, the plan, the drive kit list, board tools in muse-device/drive.py, admin routes, the
  /device card, the owner's script, license duties for Derivatives of Muse Spark Open.
- Flags: DRIVE_EXPORT_ENABLED, DRIVE_EXPORT_PRODUCTS.
- The product tools (drive_status, export_to_drive) waited on units 11 and 13, which have now merged. PRODUCT_GADGET_TOOLS doesn't list them, so products can't call them yet.
- Proven by tests: plan tests, bench images byte for byte the same, 63 Python tests with fake drives, route rules. The default model
  is r30b's IQ1_S, and its license files are in S3.
- Untested: everything that only runs on Linux. The loopback test has never run. udisks, polkit, a real stick, a real mount, the launchers
  on Windows and a clean Mac, the card in a browser, scripts/drive-export.ts, the cloud half (no quantize run yet).
- Not deployed to any board. The kit isn't uploaded.
- Spend: none recorded.

### 13. Hardware

- Built: DeviceLink over serial, USB and Bluetooth with a simulated port, read_sensor and show_text, the shared devices table, the owner
  check on /gadget, the board list in the /gadgets slot, the /device card. Migration 0026.
- Flags: HARDWARE_ENABLED, HARDWARE_BOARD_TOOLS, HARDWARE_BOARD_REGISTRY, HARDWARE_GADGET_OWNER_CHECK, HARDWARE_BOARD_KEY.
- Proven by tests: the owner check closes the release review's high finding in tests, with another owner's board, bans, forged passes and
  visitors refused. DeviceLink in real Chromium on the simulated port. The real muse-device server over MCP on loopback.
- Untested: the build, a real device in a browser, the tools on a real board (0.5.0 isn't deployed), the pages clicked in a browser.
- Spend: none recorded.

### 14. Native

- Built: browser extension output (Manifest V3, Load unpacked, a checker, a download), Phaser and Babylon skills.
- Not built: the shell bridge (notifications, Bluetooth LE). It waits for General's AWS Mac checks. Its flags aren't in lib/env.ts yet.
- Flags: NATIVE_EXTENSION, NATIVE_GAME_ENGINES.
- Proven: both game starters and the extension starter ran in real Chromium on this laptop, with a blank and a frozen canvas failing as
  they should. A manifest with broad permissions is refused.
- Untested: both builds, full Chromium on the snapshot, phaser and Babylon install time through the firewall, a Vercel deploy, the zip on
  the real store, context menu and side panel flows, meshopt GLBs with Babylon.
- Spend: Meta $0. Sandbox $0.

## Spend

| What | Amount |
|---|---|
| Meta, 8 one-shot builds before the units (Contributor) | $0.36 |
| Meta, engine, recorded | $0.144 |
| Meta, engine's unmetered smoke calls on Wonder, estimate | $1.10 to $2.30 |
| Meta, trust and live | under $0.002 |
| Vercel Sandbox, runtime's probe | under $0.01 |
| Vercel Sandbox, the 8 builds and the engine's builds | not totaled |
| Composio, GPU | $0 |

Meta in all: about $1.61 to $2.81 of $30. The test builds still to come have nearly all their unit budgets left.

## Before tg-cap-int can go to main

- Migration 0027 (General's replications) isn't on tg-cap-int. 0028 is. PENDING_WAVE3 names it. Drizzle skips an older migration, so 0027
  must land before 0028 reaches a shared database, or be renumbered.
- Local main has 98 commits tg-cap-int lacks: 116 files, mostly scripts and docs, no migrations. tuned-model-options is fully in
  (0 commits behind).
- Six crons will exist in vercel.json. musecode-sweep and jobs are new. Both routes answer skipped with their parts off (read in the code; never fired on Vercel).
- wave3-log.md and docs/BUILD_LOG_WAVE3.md should move into docs/BUILD_LOG.md at the merge.
- Every push to main goes to the owner first.

## Owner decisions still open

Access for real tests, the first thing that unblocks the rest:

1. One credentialed run: a fresh VERCEL_OIDC_TOKEN, or run it yourself. Without it, no unit gets its real test build.
2. The preview database steps: Neon branch "preview", PREVIEW_DATABASE_URL on Preview, Protection Bypass for Automation. Or a tunnel
   for PLATFORM_URL.
3. npm run snapshot after the merge, for template/caps and its manifest entry.

Costs and terms:

4. TRUST_SPARK_TO_WONDER: about 40 to 100 times the price per call on live products that still call retired Spark 1.3.
5. TRUST_GEO_COUNTRIES=meta, and how builds from India handle Muse Image: block them, skip generated fixture images, or accept it.
6. Legal drafts: review of Terms and Privacy with counsel.
7. Meta terms 1, 3.1, 6.2 and 10.1(i), for CODE_EXEC_VISITORS, MUSE_CODE_VISITORS, and whether jobs with nobody present count as access
   on behalf of a third party.
8. Whether the guest account gets a builder cap. A ban can't stop a person while guest mode is on.
9. TRUST_DEPLOY_TOTAL_MB: 100 on Hobby, up to 1000 on Pro.

Data and files:

10. DATA_SIGN_IN: whether products' own users may sign in at all, and the privacy line for it.
11. Decision 13: a product-delete path, a retention sweep, or privacy text saying rows stay until deleted on request.
12. Decision 14: make a private Blob store and set FILES_BLOB_STORE_ID, or accept the public fallback and say so on the privacy page.
13. Mirror the penguins CSV, and choose which CC0 3D assets to vet first.

Connect and jobs:

14. CONNECT_SENDS_PRODUCTION: when, if ever, and which channels. Email and chat are built.
15. Whether connect's four services are the right first set. The privacy page doesn't yet say a product can keep keys or send.
16. JOBS_WEBHOOKS: a stranger with the address can queue runs on a product, within the caps. Four busy products can use up JOBS_DAILY_USD.
17. CONNECT_MORE_TOOLS and Composio zero data retention (decision 17), if those tools get built at all.

Live and media:

18. LIVE_CAPTION_MINUTES: 10 stops a real lecture. 60 carries the flagship, about $0.18 an hour. Also the address multiple of 5, the
    notice's wording, the fixture, and that captions send people's speech to Meta.
19. The speech model and its licenses, and mirroring about 192 MB to Blob. That opens the whole Blob host, GET only, to media builds.
    Pinning it to /assets/ needs General to change lib/sandbox/policy.ts.
20. Pyodide's 13 MB in every code product.
21. Extension zips on the public Blob path, and what happens to them when a product is deleted.

Runtime, GPU, drive and hardware:

22. A deploy of one Python product to answer the Vercel question. Whether the self-host kit stays owner-only. npm stays off until you
    confirm a name and an account.
23. Decision 11: the license reading and when windows open. The Nov 3 filming window is about $1.50 for 30 minutes. A window and a
    training run block each other (TRAIN_MAX_ACTIVE 1).
24. Drive: deploying to jetson-02 (Hussam or a fleet job), the $3.70 quantize run, uploading the 120 MB kit, the session cookie in the
    owner's script, drives given to other people, board exports carrying Qwen's license, and plugging in a real stick.
25. Hardware: HARDWARE_BOARD_KEY before the registry, the owner check on before DEVICE_MCP_URL reaches production, Hussam deploying
    muse-device 0.5.0. Once the check is on, every live gadget product needs a link.
26. Muse Code: a third try if both of a build's real tasks fail, and rewording "deleted after 15 minutes", since the zip and steps
    last 24 hours.
27. Trust: check pause and unpause on a throwaway project before TRUST_REPORTS.
28. Flags on in production: Nov 3, only for capabilities that passed a real test build, with your OK.
