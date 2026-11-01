# Wave 3: capabilities so Muse Muse can one-shot most hackathon projects

Owner ask (Oct 31, ~15:15 EDT): "build out just about everything you listed there as capabilities, unless you really deem it
to be unnecessary", and keep "fine tune, then plug a flashdrive into a jetson and have it export the fine tuned model whether it
be fine tuned on the jetson or one of the cloud gpus".

Evidence: /private/tmp/claude-501/-Users-ethancastro/92498a9b-7e37-4123-a1e6-d24f91e9b55e/scratchpad/hack/ (all.json, rubric.md,
the reviewers' journal wf_667a6674-954). 8 real one-shot builds on Contributor: 6 live, 1 failed at the 25-minute round limit
(tile game with generated levels), 1 still running at time of writing.

## Who owns what

- Session "Muse Muse General": wave 2 merge and step 1 (agent tools, VR, glasses on), releases and pushes, the AWS Mac checks,
  the Muse Code spike. This session consumes its results and doesn't duplicate them.
- Session "Muse Muse Modernize Fine Tune": Glimmer training in ~/muse-muse. Read its model artifacts, never touch its runs.
- This session (wave 3): everything below. Branches tg-cap-*, worktrees ~/mm-wt/cap-*.
- Hussam owns muse-device/. Changes there stay small and in his style, and are listed for him.

## Agreed with General (Oct 31, ~15:30)

- Migration 0016 is reserved for General's `code_sessions` (Muse Code sessions), 0017 for General's decision models
  (tg-decide) if it needs one. Wave 3 units take 0018 and up, in merge order.
- General also holds 0027_replications (paper replication, tg-replicate), after 0026. Unit 4 adds MNIST and
  Fashion-MNIST registry entries once General sends verified sha256s and licenses.
- Decision models (tg-decide d842328, D0 to D2 done): DecideBackend in lib/decide/types.ts, score({prompts, letters, adapter,
  signal}) -> {logprobs, ms}, a null backend means 503 decide_offline; "Files a decision model produces" in
  docs/DECISION_MODELS.md for unit 12. General's D3 to D9 touch lib/train/{store,types,logic,workflow}.ts, recipes/glimmer.ts,
  recipes/runner.ts, recipes/serve.ts, append 0017 to lib/db/schema.ts, and add app/api/gateway/decide and
  template/lib/meta/decide.ts. Unit 11 imports these and edits serve.ts only in a marked block, based on tg-decide's merged state.
- Preview database (owner: "preview can get its own db or share idc"): one landing through General's tg-preview-db, which
  takes tg-cap-preview's 0a75160 (firewall bypass header) and the env.platformUrl and previewBypassSecret parts of 9e09de8,
  with General's own DB helper. Don't land tg-cap-preview separately. Owner steps: Neon branch "preview",
  PREVIEW_DATABASE_URL on Preview, Protection Bypass for Automation. No preview deploys of migration branches until done.
- Pushing (owner, Oct 31 ~19:25, via General): work goes to GitHub with git previews off until the preview database exists.
  a5c82b5 on tuned-model-options sets vercel.json `git.deploymentEnabled` to main only. A branch without that rule still
  gets a git preview on production's database, and its build runs scripts/migrate.ts there. So no tg-cap-* or review branch
  is pushed as a normal branch unless it already contains a5c82b5 or later; otherwise push it only as refs/backup/<branch>,
  which Vercel never builds. Workflow agents never push at all. General's push script skips tg-cap-* and tg-review-*.
- Gadgets and Models tabs (owner ask, Oct 31 ~19:40): General builds them on tg-nav-tabs. That means components/shell/nav.ts,
  components/icons.tsx, and public read-only pages at /gadgets and /models. Wave 3 units don't edit nav.ts or icons.tsx until
  General sends the landed hash. General owns both pages. Wave 3 fills two marked slots:
  - Unit 13 (hardware) puts its board list and pairing in the /gadgets slot, which replaces General's "Coming" note behind
    unit 13's flag. It links on to /device.
  - Unit 11 (gpu) puts owner-tuned models and paired inference devices in a "your own models" slot on /models, behind its
    flag.
  Neither slot may make a live call on page load or show an endpoint URL or token.
  LANDED (aee5943 on tuned-model-options, head e559003). nav.ts and icons.tsx are free again. The slots:
  - components/gadgets/BoardsSlot.tsx (unit 13). It holds the "Planned: connect your own board" note today. Replace its
    body behind your flag. With the flag off it must render exactly what it does now, which
    components/gadgets/__tests__/gadgets-page.test.tsx pins.
  - components/models/OwnModelsSlot.tsx (unit 11). It renders null today, after the tuned Glimmer list in
    app/models/page.tsx.
  Leave /gadgets's "Boards on hand" section (components/gadgets/info.ts HOUSE_BOARDS, the owner's pictures) as it is. Both
  pages are public: status words only.
- Preview database landed (General, 381935f on tuned-model-options). It's merged into tg-cap-int as 8fd1abf, and
  tg-cap-preview is gone. env.previewBypass is now {host, secret}, and builderNetworkPolicy takes platformBypass. The
  platform host's rules pin Host and refuse a bypass cookie.
- lib/sandbox/policy.ts is General's file. General is fixing the missing Host pin on api.meta.ai's Meta-key transform, which
  is live today. Wave 3 units don't edit policy.ts beyond what's already there: the engine's capHosts option (`??=`, so it
  never replaces a rule above it) and runtime's capHostRules (2c8c2d4). Host rules go in lib/caps/hosts.ts
  (CAP_BUILD_HOSTS, CAP_HOST_METHODS). Unit 9's own sandboxes use lib/caps/code/policy.ts. A unit that needs more in
  policy.ts lists it under blockers instead, and the coordinator asks General first.
- MIGRATIONS RENUMBERED (Oct 31 ~22:20, tg-cap-int 5645eac). General's 0017_decision_datasets landed (88ac98e) and 0016
  is retired for good. tg-cap-int's journal is now 0015, then 0017 (idx 17), 0018_trust (idx 18), 0019_engine (idx 19).
  Their snapshots are meta/0017_snapshot.json (General's), 0018_snapshot.json and 0019_snapshot.json. RULE FOR EVERY
  UNIT AND INTEGRATOR from here: a migration's journal idx equals its tag number (0020_data is idx 20), its snapshot is
  meta/<NNNN>_snapshot.json, and `when` follows section 4's rule.
  - A unit branch made before 5645eac carries its migration at a lower idx, with a snapshot file named for that idx. For
    example, tg-cap-data has 0020_data at idx 18 with meta/0018_snapshot.json, which collides with trust's.
  - When integrating such a branch, never merge the journal or snapshot files by hand. Take tg-cap-int's journal and
    snapshots, and append the unit's entry at idx = its tag number.
  - Build the unit's snapshot as tg-cap-int's newest snapshot plus the unit's own changes: the unit's snapshot minus the
    one before it. Set prevId to the newest snapshot's id, and keep the unit's id.
  - Then lib/db/__tests__/migrations.test.ts must pass. It checks that drizzle-kit generates each wave 3 SQL file exactly
    from the snapshot before it, and that generating now writes nothing. Append the tag to WAVE3_TAGS.
- MUSE CODE IN PRODUCTS (owner, Nov 1: "i want the builds to be able to run muse code in the build"). General dropped it
  (no lib/sandbox/session.ts before Nov 4), so wave 3 owns it as part of the code cap. It is built on tg-cap-musecode by
  workflow wf_95dcd8c6-d6f, to ~/mm-wt/_plan/muse-code-products.md and the spike, behind MUSE_CODE_ENABLED and
  MUSE_CODE_VISITORS, both off.
  - Migration 0028_code_sessions, journal idx 28.
  - The coordinator integrates it, never the workflow.
  - Units 11 and 13 don't touch lib/caps/code/session.ts or the /code/sessions routes.
- General's answers (Oct 31 ~00:05):
  - Nothing of General's mints or reads uc1, so data's `bind` change stands.
  - General won't build lib/sandbox/session.ts before Nov 4. lib/caps/code/session.ts is the real launcher now, and
    wave 3 owns its interface.
  - The media Blob mirror host is OK, on these conditions: it comes only from lib/caps/assets.json, https and GET only,
    Host pinned, no credentials, and it must be our own Blob public store (checked in mediaMirrorHosts, 55913f2).
- Cap readiness and the snapshot (General, Oct 31 ~20:45): applyCaps checks each cap's own marker. A cap whose overlay
  isn't in the builder snapshot is not ready: the brief never offers it, the build drops it with one plain build log line,
  and the live site can't break on an out-of-step snapshot. Spec is docs/CAPABILITIES.md 2.4a (tg-cap-int 1f806cf, then 441a650). The snapshot's caps come from a committed
  manifest, lib/sandbox/snapshots.json, keyed by BUILDER_SNAPSHOT_ID. There is no env var, and an unknown id means no caps
  plus one warning. UNIT 3
  (data) BUILDS IT along with the cap gate, and its review checks it. The next builder snapshot (Nov 2 morning, General)
  is made after tg-cap-int merges, so it carries template/caps anyway. Both together.
- Fine-tuning that looks like a build (owner, Oct 31 ~20:20): "A new fine tuning job should be almost as simple looking and
  just about as simple as a regular muse muse build", and Muse Muse should start fine-tune jobs, connect to gadgets, and run
  a hosted Muse Glimmer (the one being tuned). General designs it and owns the front door at /fine-tuning, on lib/train.
  HOLD LIFTED (20:50): General's contract for unit 11 is at the end of this file. Full design:
  ~/mm-wt/_plan/train-like-build.md. Unit 11 builds to that contract.
  - Import General's exports, never reimplement them: launchJob, startTuneRun, evalVerdict, GlimmerChatBackend,
    serveJobChatBackend and GLIMMER_SAMPLING.
  - If any of them isn't on tg-cap-int yet when unit 11 starts (launchJob waits for tg-decide D7), code against the TS
    contract block in train-like-build.md through one small adapter file, lib/caps/gpu/general.ts. Make the missing call
    answer 503 `not_ready` behind the flag, and list it under blockers, so the swap is one file.
  - Nobody serves a tuned model outside a window. askGlimmer falls back to Wonder and says so in one line.
  - The owner's answer on windows is pending. General updates it in this file.
  - LANDED (General, fine-tune stage 2, 7b6b139; on tg-cap-int from tg-cap-sync). Import the real files. No adapter is
    needed for these:
    - launchJob(input, caller) and launchJobRequest(body, caller) in lib/train/launch.ts.
    - startTuneRun in lib/train/tune/start.ts.
      - With a productId, it takes the product's one run a day (UTC). Otherwise it throws TuneStartError(429,
        "product_daily", {retryAfterSeconds}).
      - With TUNE_COMPOSER off, it throws TuneStartError(404, "not_found"). So "Train on my data" needs TUNE_COMPOSER as
        well as GPU_TRAIN_ON_DATA. Map both errors to plain answers.
    - evalVerdict(DecisionSummary) in lib/train/tune/verdict.ts.
    - lib/train/glimmer-serving.ts: GLIMMER_SAMPLING, GLIMMER_EOS_IDS, GlimmerChatBackend and
      serveJobChatBackend(adapterJobId, now).
      - The backend throws only ServeError: busy 409, stopping 503 glimmer_closed, timeout 504, anything else 502.
      - It refuses to start a chat with under 135 s left in a window.
      - The serve job answers POST /v1/chat/completions.
    - latestTuneJob skips jobs that failed before any GPU launched. ownModelFor uses it, through runsOfProduct.
    - The run's product id lives in rate_limits-style rows (docs/TRAINING.md, "which jobs are a run's").
      0025's training_jobs.product_id can be filled from there.
  - r30b base (General, Nov 1; merged on tuned-model-options locally, comes to tg-cap-int once pushed; the coordinator
    syncs it). MODEL is now OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit. Serve windows load r30b.
    - lib/train/base.ts: isSparkOpenDerivative(job) and recordedBase(job) are the single rule. Unit 11 uses them to show
      "Built with Muse Spark Open" and the Usage Policy points wherever a tuned model shows: own-model rows
      (OwnModelsSlot), the /glimmer gateway, product wording.
    - adapterProblem refuses to serve an adapter trained on plain Glimmer, at start time only. If unit 11 reads adapters
      through getDecisionModel or any other path, apply the same refusal there.
    - evalVerdict has an optional second argument, sparkOpen = false. Pass it for r30b-based jobs.
    - launchJob writes baseModel on glimmer-lora and glimmer-quantize jobs. A caller can't set it (400).
    - If tg-cap-int doesn't have lib/train/base.ts yet when unit 11 starts, go through lib/caps/gpu/general.ts for these
      two functions only, and list that under blockers.
    - The drive export's lab path gets isSparkOpenDerivative from the coordinator (not unit 11), using
      lib/drive/image.ts's DERIVATIVE_DRIVE_FILES and sparkOpen.
  Unit 13 (hardware) goes ahead as planned.
- Log everything (owner ask): wave 3 entries go in ~/mm-wt/_plan/wave3-log.md now, screenshots in
  ~/mm-wt/_plan/log-shots/, and move into docs/BUILD_LOG.md under their own headings when tg-cap-int merges.
- Migrations reach main (and previews, which share production's database) in number order. drizzle 0.45.4 applies only
  journal entries newer than the newest applied one, so a skipped 0016 or 0017 would never apply. Before any branch with 0018
  or higher goes to main or a preview, tell General: General lands 0016 and 0017 first (preferred) or renumbers above wave 3.
- Wave 2 landed: tuned-model-options = d8ffec4 (Oct 31). tg-cap-int is built from it.
- Wave 2 is merging on tg-wave2-merge (~/mm-wt/wave2-merge). Don't build on the separate tg-* wave 2 branches; units that need
  the owner pass, visitor cookie, sealed state or tool gateway (3 data, 5 connect, 6 jobs) start from tuned-model-options after
  General says it landed. Wave 2 unit reports: ~/mm-wt/_plan/wave2-results.json. Owner pass: POST
  /api/products/[slug]/owner-pass, 12 hours; principals build, product, visitor, owner; the tool callback needs mm_session.
- Decision models (General, tg-decide, design ~/mm-wt/_plan/decision-models.md and docs/DECISION_MODELS.md): fine-tuned Glimmer
  decision models in the {state, question, options} format, {GATEWAY_URL}/decide and a template decide() helper. Unit 11's
  shared Glimmer endpoint and per-product training build on that format and route instead of a second one. Unit 12's drive
  export reads its adapters and GGUFs as one more source. Scion (sinanuozdemir) has no license: ideas only.
  drizzle skips a migration older than the newest applied one, so numbers and journal timestamps are set at merge time if the
  merge order changes. If CAPABILITIES.md starts wave 3 at 0016, shift it by one.
- Unit 9 does Pyodide, QuickJS, /exec and browser automation only. Muse Code sessions are General's (tg-musecode). /exec
  imports General's sandbox launcher in lib/sandbox/session.ts rather than writing a second one.
  Spike facts: sessions route through the gateway with endpoint_transport {base_url, auth:"bearer"} and telemetry off,
  never auth:"none" (it turns Contributor into muse-spark-1.3); cold start 4 to 8 s, stop under 2 s; the session token is
  readable in the VM, so it gets a narrow scope; result zips must filter out the Muse Code binary.
- Unit 2 note: estimate.ts caps Wonder's max_output_tokens estimate at 32000 from 128000, which blocks a $1 session after
  about $0.24 of real spend. Fix it there if unit 2 touches estimate.ts.
- tg-ui-brand (General) is restyling the platform. Until it merges, wave 3 doesn't edit app/globals.css, app/layout.tsx,
  app/page.tsx, components/composer, components/chat, app/fonts, lib/sandbox/builder.ts envLocal, template/lib/meta/json.ts,
  and adds lib/brief/render.ts sections and template skills only in marked blocks, merged after it. New pages and UI use
  design tokens only (spec ~/mm-wt/ui-brand/docs/BRAND.md). ui-brand also makes a local build's product calls use TEST_MODEL.
- Unit 1's retired-Spark change (Contributor to Wonder) raises those products' cost about 40 times per call. List it as a cost
  change for the owner when it goes to a push.
- Unit 12 bases on ded4119 or later (the release's 15 muse-device and lib/device fixes). tuned-model-options 4120b77 has them.
- Unit 14 waits for General to say the AWS Mac checks pass (iPhone white screen, APK cache missing the .apk suffix, glasses app
  never opened). The fine-tune session also shares that Mac.
- Load: plan on 2 heavy agents for wave 3, counting the local site's builds, until General says otherwise.
- Never print process environments or command lines that may hold tokens (no `pgrep -fl`, no `ps -E`).

- 3D (owner, Oct 31): General owns it on tg-3d (~/mm-wt/threed, design ~/mm-wt/_plan/3d.md): the glTF/GLB asset pipeline, a
  three.js skill for non-VR products, Blender headless in builds, render jobs through lib/sandbox/session.ts. Unit 14's Phaser
  and Babylon skills use that GLB pipeline, not a second one. Unit 4 hosts a small vetted CC0 3D asset set (Poly Haven or
  similar) on Blob next to the datasets, in the manifest format tg-3d defines: "CC0 asset manifest, v1" in
  ~/mm-wt/_plan/3d.md (3d/manifest.json; CC0-1.0 only; GLB 2.0 at most 5 MB and 50k triangles, textures at most 2048 px, no
  Draco, meshopt OK, metres, Y up; 512 px previews; sha256 per file, checked by the product). No wave 3 unit edits three.js, R3F or
  template/targets/vr code; Babylon in unit 14 is a separate skill. Depth and 3D reconstruction models stay skipped.

- Offline (owner, Oct 31): General owns it on tg-offline (~/mm-wt/offline, design docs/OFFLINE.md coming). Proposed: unit
  10's self-host kit becomes the cloud mode of General's offline install, in General's shape; unit 13's board registry and
  offline's inference endpoint registry are one `devices` table (kind, endpoint, models, lan, pairing) in 0026; unit 12's
  drive plan can carry the offline kit as more plan entries. Settled with General (docs/OFFLINE.md, dd1602f): unit 13 owns the
  shared `devices` table and 0026 in offline's shape (CAPABILITIES.md section 19); pairing and the offline drive kit come after
  Nov 4; unit 10 builds the cloud kit now with `mode` reserved for "offline". Offline stays a demo branch until after Nov 4.

## Units

0. contract: docs/CAPABILITIES.md. Migrations from 0016, flags, gateway routes, template helpers and skills, brief fields,
   build-time stand-ins, judge checks, test plan, per capability. Everything else follows it.
1. trust (groundwork): sign-in tiers (stateless products stay open to guests; data, connectors, jobs, code, GPUs need a
   signed-in builder), per-builder daily caps, age 18+ gate, privacy and terms pages for the platform and in every product,
   restricted-territory block (x-vercel-ip-country), report link, takedown and per-builder ban, the deploy bug that silently
   drops files over 10 MB, live products' retired Spark 1.3 calls moved from Contributor to Wonder (Meta terms 6.2).
2. engine (one-shot reliability): round time by brief size (25 min now, more when it lists several capabilities), milestone
   builds that chain rounds for big systems, judge checks per capability (second browser sees saved data, a job fires and
   writes, a stand-in message shows as sent), per-build data namespace, a smoke check against the live URL after deploy.
3. data (A): product_rows + {GATEWAY_URL}/data with shared, visitor and owner scopes, quotas; end-user sign-in through Muse
   Muse with passkeys (no email service needed), signed code back to the product; data() and currentUser() helpers, skill,
   brief `data` block.
4. files and search (F): files() with quotas and no 24-hour expiry, full-text search helper, vetted public datasets on Blob that
   builds can read, citations the judge can see.
5. connect (B): fetchPublic allowlist of keyless public APIs with recorded samples for builds; more read-only Composio tools;
   a per-product key vault (bring your own keys, brokered, never in product code); messaging, payments and social posting
   only through the builder's own keys or accounts, one confirmation per send, off in production until the owner says so.
6. jobs (C): schedules in musemuse.json (15 min minimum), platform cron fan-out with job tokens and per-run budgets, webhooks
   into the gateway, checkpointed long agent runs across job ticks, results to data(), owner notification. Jobs read and
   notify; writes wait for a person. Schedules pause after 14 days with no owner visit.
7. live (D): near-live captions from 2 to 3 s chunks with chunk times, live shared updates (SSE over data), test mic fixture.
   Two-way realtime voice waits for Meta.
8. media (E): open-weights speech in the browser (license checked first), video from image sequences with ffmpeg.wasm, music
   as MIDI, SAM tiling and chunking past 16 objects and long video.
9. code (G): Pyodide and QuickJS in the browser; {GATEWAY_URL}/exec in a no-network sandbox with short limits; browser
   automation for a URL the user typed; Muse Code sessions owner-only, as designed, once the spike answers.
10. runtime (H): Python functions in products with PyPI in the build firewall; self-host kit output; VS Code extension and
    GitHub Action outputs as source; npm publishing only after the owner confirms name and account.
11. gpu (I): one shared Glimmer endpoint behind the gateway (off by default, demo windows, daily GPU cap), per-product
    "train on my data" after ship on the existing lab and caps, Meta open models only.
12. drive export (owner ask): a fine-tuned model goes onto a USB drive plugged into a Jetson, whether tuned on the board
    (muse-device train) or on a cloud GPU (lib/train). The board watches for a removable drive, pulls a cloud model by signed,
    hash-checked URL if needed, writes the same layout as lib/drive/image.ts (launchers, llama.cpp builds, Meta license and
    Usage Policy, model card, PROVENANCE.json), verifies every sha256 by reading back, syncs and unmounts, and reports in the
    lab and /device. exFAT for files over 4 GB. Tested with a loopback drive image; the real test needs the owner to plug a
    drive in. Reuses existing adapters and GGUFs before any new GPU run.
13. hardware (J): Web Serial, WebUSB and Web Bluetooth helper with a simulated port; read-only sensor and show_text board
    tools; per-owner board registry and an owner check on the gadget route (closes the release review's high finding).
14. native (K): browser extension output (Manifest V3, Load unpacked, Playwright check), the shell bridge gains notifications
    and Bluetooth LE once the AWS Mac checks pass, browser game engines (Phaser, Babylon) as skills.

Skipped on purpose: blockchain (5 projects, high risk), always-on servers and model proxies (Meta 10.1(i)), duplex realtime
voice and non-Meta video or voice providers, publishing apps or packages under the owner's accounts, phone numbers, 3D and
depth models.

## Limits

- Load: at most 4 heavy agents at once across this session and General. Cloud sandboxes for builds.
- Spend for wave 3 testing: Meta $30 (Contributor, made-up data, reminders off), Vercel Sandbox $15, Composio $5, GPU $10
  (reuse existing tuned models first). Shared Glimmer endpoint off unless the owner turns it on, $15 a day when on.
- Production: flags off until a capability passes a real test build. Every push to main goes to the owner first.
- Standing rules from MEMORY.md apply (no muse-spark-1.3, no Exa, no Apollo, no Glimmer on the laptop, never SSH to Jetsons
  from the laptop, never hold users' Gadget SDK tokens, no em dashes in user copy, no code from other repos).

## Schedule

- Oct 31: contract, coordination, trust and engine start.
- Nov 1: data, files, connect, jobs, drive export.
- Nov 2: code, live, media, hardware, gpu, runtime, native; one builder snapshot.
- Nov 3: a real test build per capability, fixes, flags on in production for what passed (owner OK), demo filming.
- Nov 4: fixes only, submit by 8 PM ET. Whatever isn't proven stays off and continues after.

## General's contract for unit 11 (fine-tune like a build, Oct 31 20:50)

Full design: ~/mm-wt/_plan/train-like-build.md (sections B, D, "Ownership split", the TS contract block). Builds on
CAPABILITIES section 17 as written: POST {GATEWAY_URL}/glimmer/v1/chat/completions (OpenAI shape), GLIMMER_MODEL selects
the model ("own" = the product's own tuned model), demo windows, POST /api/products/<slug>/train, 0025
(training_jobs.product_id, glimmer_windows).
- General exports, unit 11 imports (never reimplements): launchJob (lib/train/launch.ts, after tg-decide D7), startTuneRun
  (lib/train/tune/start.ts; /api/products/<slug>/train becomes a thin caller; returns {runId, href}, product_id written once
  0025 exists), evalVerdict (lib/train/tune/verdict.ts), GlimmerChatBackend + serveJobChatBackend + GLIMMER_SAMPLING
  (lib/train/glimmer-serving.ts; Meta's sampling always sent, eos [200001, 200008], never <|eom|> except trainChannel 0
  server-side).
- Unit 11 exports: ownModelFor(productId, now) -> {adapterJobId, trainChannel} | null (newest job with product_id that passes
  evalVerdict); the gateway route, windows, cap, canned build replies; askGlimmer({messages, own, request}) in the template
  that falls back to Wonder through metaClient on anything but a 400 and returns {text, by: "own"|"glimmer"|"wonder", note};
  errors 503 glimmer_closed, 503 glimmer_starting {retryAfterSeconds}, 409 busy, 404 own_model_not_ready, 504, 502.
- Writer line for unit 11's catalog entry: "When the muse wants its own trained model, pick muse-glimmer and say in need what
  it should learn; the product answers with Muse Wonder until that model passes and a window is open."
- Your open question, who serves a tuned model outside a demo window: nobody. No always-on server; outside a window the
  product answers with Muse Wonder and says so in one line. Owner, Oct 31 21:15: "Demo windows only": windows off by default, one
  30-minute window Nov 3 for filming plus windows an admin opens, GPU_GLIMMER_DAILY_USD $15.
- General builds now: the composer, plan, run room, PlanView, verdict, Where it runs (no files of yours). After D7 lands:
  launchJob and the chat route. Flags: General TUNE_COMPOSER, TUNE_FROM_BUILDS, TUNE_DEFAULT_EXAMPLES.
