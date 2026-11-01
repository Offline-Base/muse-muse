# Wave 3 capabilities: the contract

Unit 0 of wave 3 (`~/mm-wt/_plan/wave3.md`, owner-approved Oct 31). Every other unit, 1 to 14, builds against this page,
so up to 4 builders can work at once without colliding. Nothing here is built yet.

Read sections 1 to 6 first. Then read your own unit's section. Don't edit another unit's section. If this contract is wrong
for your unit, change only your own section and add one line under "Changes to this contract" at the end, in the same
commit.

Line numbers below are from `tg-cap-contract` at 4120b77. Wave 2's merge moves them, so search for the names.

## 1. Ground rules

- **Branches.** `tg-cap-<unit>` in `~/mm-wt/cap-<unit>`, started from `main` after wave 2 merges. Until then, units 1 and 2
  may start from `tg-cap-contract` and rebase. `node_modules` is a symlink: never run `npm install` there and never stage it.
  Stage named paths only, never `git add -A`. No pushes: every push to `main` goes to the owner first.
- **Flags.** Every new behavior sits behind a flag in `lib/env.ts`, off by default, read with the file's own helpers:
  `flag()` for switches ("1", "true", "yes", "on"), `dollars()` for money where 0 pauses, `number()` for counts,
  `optional()` for strings. A cap's flag does nothing until its unit sets `CAP_READY` (section 2.1).
- **Flags on in production** only for a capability that passed a real test build, with the owner's OK (Nov 3).
- **Test builds** run on `TEST_MODEL=muse-spark-1.3-contributor` with made-up data only, reminders off, never on production.
  Meta may train on that tier (terms 6.2), so no real person's words go there.
- **Wave 3 testing spend:** Meta $30, Vercel Sandbox $15, Composio $5, GPU $10. The shared Glimmer endpoint stays off unless
  the owner turns it on, at $15 a day when on. Section 6 splits these by unit.
- **Load:** at most 4 heavy agents at once, across this session and "Muse Muse General". Builds run in cloud sandboxes.
- **Standing rules:** no `muse-spark-1.3`, no Exa, no Apollo, no Glimmer on the laptop, never SSH to a Jetson from the
  laptop (boards go through the fleet control plane or the board's own MCP server), never hold anyone's Gadget SDK token,
  no em dashes in anything a person reads, no code copied from other repos. `muse-device/` is Hussam's: keep changes small
  and in his style, and list each one for him in your unit's doc.

### What "byte-identical with every flag off" means

With every wave 3 flag off, production must do exactly what it does today. Concretely:

1. Every prompt and schema the brief writer, Muse Code and the judge get is unchanged. Golden:
   `lib/brief/__tests__/flags-off.test.ts` and its 11 files in `golden/`. Each unit adds its flag names to `FLAGS` and its
   brief key to the "differs only by" list. No golden file may change.
2. A build with no caps gets the same sandbox: the same files, `.env.local`, network policy, token allowlist, round caps,
   verify steps and deploy env. Golden: a new `lib/caps/__tests__/flags-off.test.ts` (unit 2), with `golden/policy.json`
   (`builderNetworkPolicy` for a sample), `golden/steps.json` (`STEPS`), `golden/allowed-models.json` (`allowedModelsFor` on
   the sample brief), `golden/env-local.txt`, `golden/deploy-env.json`, `golden/judge-content.json` (the judge's content
   parts for a sample) and an empty extra-files list.
3. Existing gateway routes answer as they do now. Golden: the existing handler tests stay green unchanged. A new
   `lib/gateway/__tests__/caps-off.test.ts` (unit 2, each unit adds its routes) checks that every wave 3 route answers 404
   with its flag off and touches no dependency.
4. A product with no `musemuse.caps.json` verifies and records exactly as today. Golden:
   `template/scripts/__tests__/caps-off.test.mjs` (unit 2): the summary's steps and the Playwright projects are unchanged.
5. Migrations are additive only: new tables, and new nullable or defaulted columns. No renames, no drops, no backfills.
   `lib/db/__tests__/migrations.test.ts` checks a database at 0015 keeps its rows.
6. The board's existing tools answer as today (`muse-device/test_server.py`). New board tools are reached only behind
   their unit's flags: `PRODUCT_GADGET_TOOLS` and the admin device routes filter them.

The one allowed difference: a path that answered Next's 404 page now answers the gateway's JSON 404
(`unknown_endpoint`). The status stays 404.

## 2. Shared pieces every unit uses

### 2.1 Cap ids and the registry (unit 2 writes it)

A "cap" is a platform service a brief can ask for. Trust, engine and drive export aren't caps: they aren't in a brief.
GPU isn't one either, since `muse-glimmer` is already a product model.

```ts
// lib/caps/ids.ts. Unit 2 creates it with every line below. Each unit then changes only its own CAP_READY line.
export const CAP_IDS = ["data", "files", "connect", "jobs", "live", "media", "code", "runtime", "hardware", "extension", "games"] as const;
export type CapId = (typeof CAP_IDS)[number];
export const CAP_UNIT: Record<CapId, number> = { data: 3, files: 4, connect: 5, jobs: 6, live: 7, media: 8, code: 9, runtime: 10, hardware: 13, extension: 14, games: 14 };
/** The flag that lets the brief writer pick the cap and turns its routes on. */
export const CAP_FLAG: Record<CapId, string> = {
  data: "DATA_ENABLED", files: "FILES_ENABLED", connect: "CONNECT_ENABLED", jobs: "JOBS_ENABLED", live: "LIVE_ENABLED",
  media: "MEDIA_ENABLED", code: "CODE_ENABLED", runtime: "RUNTIME_ENABLED", hardware: "HARDWARE_ENABLED",
  extension: "NATIVE_EXTENSION", games: "NATIVE_GAME_ENGINES",
};
/** False until the unit merges with its routes, overlay and checks. One line per cap, so merges never collide. */
export const CAP_READY: Record<CapId, boolean> = {
  data: false,
  files: false,
  connect: false,
  jobs: false,
  live: false,
  media: false,
  code: false,
  runtime: false,
  hardware: false,
  extension: false,
  games: false,
};
/** Products with this cap need a signed-in builder (unit 1). Stateless caps stay open to guests. */
export const CAP_NEEDS_BUILDER: Record<CapId, boolean> = {
  data: true, files: true, connect: true, jobs: true, live: false, media: false, code: true, runtime: true,
  hardware: true, extension: false, games: false,
};
export const capMarker = (id: CapId) => `cap:${id}`;
```

`env.enabledCaps` (unit 2, in `lib/env.ts`) is `CAP_IDS.filter((c) => CAP_READY[c] && flag(CAP_FLAG[c]))`. On production
(`VERCEL_ENV=production`) without `TRUST_SIGNED_IN_CAPS`, it also drops every cap with `CAP_NEEDS_BUILDER`. Ids are a
plain constant file with no imports, so `lib/env.ts` can read it without an import cycle.

### 2.2 Who is asking

The gateway learns who is behind a product's call from headers the product's own server forwards. Only the platform's
signatures make someone strong. A cookie alone is never enough for anything private.

| Principal | How the gateway knows | Header from the product's server | Made by | Lasts |
|---|---|---|---|---|
| `build` | The token's scope is `build` | none | provision | the build |
| `product` | A product token and nothing else | none | | |
| `visitor` | `mm_vid` cookie (agent kit's `lib/platform/identity.ts`) | `x-musemuse-visitor` | the product | a year. Weak: one browser, no recovery |
| `owner` | `os1.<product>.<subject>.<exp>.<sig>` (tg-tools `lib/tools/principal.ts`) | `x-musemuse-owner` | `/identity/owner` | 12 hours |
| `user` | `us1.<product>.<subject>.<exp>.<sig>` (unit 3) | `x-musemuse-user` | `/identity/user`, after a passkey | 30 days |
| `job` | `jr1.<product>.<run>.<exp>.<sig>` (unit 6) | `x-musemuse-job` | the jobs cron | 10 minutes |

- Every signature uses `mac(label, fields)` and `sameMac` from tg-tools `lib/tools/sign.ts`, with a key from `toolKey(label)`
  (`lib/tools/keys.ts`). One label per use. Nonces are spent with `reserveCounter("<label>:<nonce>", exp, 1, 1)`, as the
  owner code is.
- Rows and files are stored under a **subject key**, never a raw id: `mac("caps-subject", [kind, productId, subject])`
  cut to 32 characters. A user's subject is already pairwise: `mac("end-user", [endUserId, productId])`, so no two
  products can match the same person.
- `lib/caps/principal.ts` (unit 3) resolves all six. It wraps tg-tools' `resolvePrincipal` and adds `user` (unit 3) and
  `job` (unit 6, in its own marked block).

### 2.3 Tokens and markers

- `allowedModelsFor(brief)` (`lib/pipeline/logic.ts:101`) appends `capMarker(id)` for each cap block the brief has, after
  the models and the agent markers. A brief with no cap blocks gives the same array as today.
- The product's `musemuse.json` may narrow its caps (its `caps` list), never widen them, as it does for tools.
- Build tokens get `gateway_tokens.build_id` (unit 2, migration 0019). The **build namespace** is `b:<buildId>`. Live
  tokens use `live`. A build never sees live rows or files, so Muse Code never reads a real person's data.

### 2.4 The cap gate (unit 3 writes it, every cap route uses it)

`lib/caps/gate.ts`, with deps injected like `GatewayDeps` (`lib/gateway/handler.ts`) and built from the same store
(`lib/gateway/store.ts`), so tests need no database. Check order, `CAP_CHECKS`:

1. **flag**: the route's flag is off, or `CAP_READY` is false: 404 `unknown_endpoint`, and nothing else is touched.
2. **token**: bearer, by hash. The product isn't disabled, failed or taken down (unit 1).
3. **marker**: the token has `cap:<id>`, the manifest allows it.
4. **builder**: when `CAP_NEEDS_BUILDER`, the product's owner is a signed-in builder, not the guest, not banned (unit 1).
5. **principal**: who is asking (2.2), and whether this scope or action allows them.
6. **arguments**: size cap, only known keys (others refused, not dropped), no private or localhost URLs.
7. **rate**: `hitRateLimits` per token, per IP (`x-musemuse-client-ip`), per subject.
8. **in flight**: `acquireInFlight` where a call holds something (a sandbox, a stream).
9. **quota**: rows, bytes, files, daily counts.
10. **budget**: the token's daily spend, the cap's own daily dollars, the builder's daily dollars (unit 1),
    `DAILY_SPEND_CAP_USD`, and a job run's budget (unit 6).
11. **reserve**: `reserveSpend(ctx, model, worstCaseUsd)` writes a usage row first, for routes that cost money.
12. **work**: a build token gets its stand-in (2.7) or the build namespace.
13. **settle**: `settleSpend(reservation, measured)`, give the slot back, answer.

Errors use `gatewayError` with the tool gateway's codes (`TOOL_ERRORS`): `invalid_arguments` 400, `cap_not_allowed` 403,
`sign_in_required` 403, `rate_limited` 429, `quota_exceeded` 429 (new), `budget_exceeded` 429, `run_limit` 429,
`cap_failed` 502, `caps_paused` 503 (a daily dollar cap set to 0). "Needs a confirmation" and "needs a connection" stay
200 answers that the product shows as a card, as in `docs/AGENT_TOOLS.md`.

**Money.** Only routes that spend write usage rows, with a new `source`: `exec`, `browse`, `code_session`, `glimmer`.
Routes that only count write `source` `fetch`, `vault` or `sends` rows at $0 with `units`, which `recordUsage` keeps.
Data and files spend nothing at Meta: they count in `rate_limits` day windows and in their own count tables. Every
usage row counts toward `DAILY_SPEND_CAP_USD`. Model calls a cap makes go through `/v1`, so the product's Meta budget
covers them as today.

### 2.4a Cap readiness and the builder snapshot (unit 3 writes it; agreed with General, Oct 31)

A cap whose overlay isn't in the builder snapshot is not ready. The brief never offers it, and the build never relies on
it, so a snapshot that is out of step with the code can't break the live site. Today `applyCaps` checks only `core`'s
marker and throws on Vercel. Unit 3 replaces that with a check for every overlay, in two layers:

1. **Brief time.**
   - `scripts/make-builder-snapshot.ts` records the cap overlays it installed as `capOverlays: string[]` in `BuilderInfo`
     (`lib/sandbox/setup.ts`).
   - It also appends `{ createdAt, templateHash, capOverlays }` under the new id to a committed manifest,
     `lib/sandbox/snapshots.json`. It keeps printing `BUILDER_SNAPSHOT_ID=...`, plus one line saying to commit the
     manifest with the id change.
   - No new env var (General, Oct 31). Vercel env writes are the owner's, and a second var that moves with every id would
     drift. A new BUILDER_SNAPSHOT_ID needs a redeploy anyway, so the manifest ships in the same deploy. Snapshot ids aren't
     credentials, so committing them is fine.
   - `env.snapshotCaps`: when `process.env.VERCEL` is set, it is `snapshots[BUILDER_SNAPSHOT_ID]?.capOverlays`. An id
     missing from the manifest, or no id, gives `[]` and one `console.warn` naming the id ("not in
     lib/sandbox/snapshots.json, so no caps"). Locally it is `null`: the checkout's `template/caps` is used, as today.
   - The manifest starts empty, and the Nov 2 snapshot is its first entry. Don't guess at older ids.
   - `env.enabledCaps` then also requires `core` and every overlay the cap can need to be listed. A cap can need its own
     id, or every pick in `CAP_OVERLAY_PICK` (games needs both games-phaser and games-babylon; list the picks as
     `CAP_OVERLAYS_ALL` in `lib/caps/overlays.ts`).
   - So the writer schema, the writer rules and the catalog leave the cap out.
2. **Build time.**
   - A new `capsForBuild(brief)` in `lib/caps/ready.ts` runs once, before anything reads the brief's caps. It returns
     the build's working copy of the brief, with every cap block set to null whose cap isn't in `env.enabledCaps`:
     flag off, not ready, or not on the snapshot.
   - The stored brief keeps its blocks, so a later build on a newer snapshot can use them.
   - Everything after it uses the working copy: `overlaysFor`, `allowedModelsFor`'s markers, the build prompt,
     `capBuildEnv`, the fixed checks and the judge notes.
   - For each dropped cap the build log gets one plain line, for example "This build goes without Python functions:
     the builder snapshot doesn't have them yet." Use "is switched off" when the flag is off.
   - This also closes runtime's open low finding: a stored brief with a runtime block got the overlay and PyPI with
     the flag off.
3. **Backstop.**
   - `applyCaps` checks `${CAPS_DIR}/<overlay>/deps.json` for every overlay in its list. The helper is
     `capOverlayMarker(overlay)` in `lib/sandbox/paths.ts`, and `CORE_CAPS_MARKER` becomes `capOverlayMarker("core")`.
   - Locally, missing overlays are still copied from the checkout.
   - On Vercel it returns the missing overlays instead of throwing. If the build prompt isn't rendered yet, the pipeline
     drops those caps exactly as in 2, with the same log line.
   - If the prompt already exists, the round fails with one plain line naming the cap and "make a new builder snapshot".
     Never a raw stack.
   - The stale verify check (`CAPS_VERIFY_MARKER`) works the same way.

Tests:
- With every flag off, the goldens are unchanged, whatever the manifest holds.
- On `VERCEL=1`, a ready, flagged cap missing from the snapshot's `capOverlays` is left out of `enabledCaps`, the schema
  and the catalog.
- An unknown id gives `[]` and the one warning.
- Every snapshot id named in `.env.example` or the docs, if any, is in the manifest.
- A stored brief with that cap's block builds without it and logs the line.
- A fake sandbox missing one overlay's marker drops that cap on Vercel and installs it locally.
- `core` missing drops every cap.

Owns: `lib/caps/ready.ts` and `lib/sandbox/snapshots.json`. It also makes marked edits to unit 2's `env.enabledCaps`,
`applyCaps` and `paths.ts`, adds one field to `BuilderInfo`, and adds the manifest write and one printed line to the
snapshot script. The README's snapshot steps say to commit the manifest. General owns the snapshot itself and has agreed
to these.

### 2.5 Template overlays (unit 2 writes the plumbing)

Caps reuse wave 2's target overlay mechanism (tg-vr `lib/sandbox/tasks.ts`, `applyTargetScript` and
`restoreTargetFilesScript`), side by side with it.

| Thing | Where |
|---|---|
| Overlays in the repo | `template/caps/<overlay>/files/**`, `deps.json` (exact versions), `platform-files.json` (paths put back before every verify and demo) |
| Overlays | `core` (unit 2: any cap), `trust` (unit 1: any trust product flag), `data`, `files`, `connect`, `jobs`, `live`, `media`, `code`, `runtime`, `hardware`, `extension`, `games-phaser`, `games-babylon` |
| In the sandbox | `CAPS_DIR = /vercel/musemuse/caps`, root-owned and read-only. `ACTIVE_CAPS_FILE = CAPS_DIR/active.json` |
| In the product | `musemuse.caps.json`: `{"caps":["data","jobs"],"overlays":["core","data","jobs"]}`. Verify, Playwright and the tests read it |
| Applying | `applyCapsScript(overlays)` runs right after `applyTargetScript`, copies files, installs deps, commits `Caps: data, jobs` |
| Restoring | `restoreCapFilesScript()` runs beside `restoreTargetFilesScript()` before every verify and demo |
| Old snapshots | provisioning copies `template/caps` in when the snapshot lacks it, as targets do (`builder.ts`, tg-vr) |

Rules:

- **No collisions.** An overlay may not write a path the base template, a target overlay or another cap overlay writes. Two
  exceptions, both checked byte for byte by a template test: `core` ships `lib/platform/identity.ts` as an exact copy of the
  agent kit's, and `trust` replaces `components/Footer.tsx`.
- **Helpers are platform files.** `lib/platform/<name>.ts` helpers, `tests/caps/<id>.ts` and `scripts/caps/<id>.mjs` are
  listed in `platform-files.json`, so an edit can't fake a pass. Products wrap them, never edit them.
- **Product routes the platform owns** are static segments: `app/api/musemuse/<name>/route.ts`. Next serves a static segment
  before the agent kit's `app/api/musemuse/[...path]` catch-all, so the two never touch. A template test applies the agent
  overlay and one cap route together and calls both.
- **Helpers take the request**, like `metaClient(request)`, so identity headers travel. They throw `CapError {code, status,
  message}` with plain words. Server helpers never run in the browser.
- **Skills** go in the overlay at `.agents/skills/muse-<id>/SKILL.md`. Nobody edits `template/AGENTS.md` (section 3).
- **Extra build env.** `capBuildEnv(brief)` and `capDeployEnv(brief, token)` (unit 2, `lib/caps/env.ts`) add lines to
  `.env.local` and to the product's Vercel env. Each unit registers its own. With no caps, both are empty, so
  `envLocal` (`builder.ts:271`) writes what it does today.

### 2.6 Brief, catalog, prompt and judge hooks (unit 2 writes them once)

Each unit puts its text in its own files, `lib/caps/<id>/{brief,catalog,render,judge}.ts`, and adds one line to a
registry. The shared files get one edit each, from unit 2.

| Hook | Shared file, one edit by unit 2 | Registry each unit adds one line to |
|---|---|---|
| Brief fields | `lib/brief/schema.ts`: `BriefSchema` extends with every registered field as `.nullable().optional()`. `newBriefSchemaFor({ gadgets, targets, personalTools, caps, milestones })` adds `.nullable()` fields for enabled caps only. With `caps: []` and no milestones it returns the same object as today | `lib/caps/brief-fields.ts`, `CAP_BRIEF_FIELDS`, in plan order |
| Writer rules | `lib/prompts/brief.ts`: `briefInstructions()` appends `capsWriterRules(enabled)` only when `enabled` isn't empty | `lib/caps/<id>/brief.ts` exports its rule lines |
| Catalog | `lib/prompts/catalog.ts`: the cache key gains the enabled caps. With caps on, the first and third "How products run" bullets come from `howProductsRun(enabled)` and each cap's block follows the agent block. With none on, the text is today's, byte for byte | `lib/caps/catalog.ts`, `CAP_CATALOG` |
| Build prompt | `lib/brief/render.ts`: `...capsBuildLines(brief)` right after `...agentLines(brief)`. It writes `## Platform services` with a `###` per cap block | `lib/caps/render.ts`, `CAP_RENDER` |
| Refine and markdown | `renderRefinePrompt` gets `capsRefineLines(brief)` after `refineTargetLines`; `briefToMarkdown` gets `capsMarkdown(brief)` after the Agent section | same |
| Judge notes | `lib/prompts/judge.ts`: `judgeInstructions` appends `capsJudgeNotes(brief)` after the glasses note | `lib/caps/judge.ts`, `CAP_JUDGE` |
| Judge evidence | `lib/judge.ts`: one text part, `capsProofText(verify)`, before the screenshots (`judge.ts:99`) | from the verify summary |

Every cap field is required-but-nullable in the writer's schema when its cap is on, since Meta's strict output needs every
property. The stored `BriefSchema` takes every field as optional, so older briefs parse.

Every cap section of the build prompt says, in this order: what the brief asks for, the skill to read first, the helpers,
the scope and privacy rules, the limits a user sees, what the build's stand-in returns, and the smoke test's rules. When a
line of `template/AGENTS.md` doesn't hold for this brief (for example "Don't store personal data unless the brief says to",
"Uploaded files stay in memory", "The build machine can reach only npm, the Meta API and the Muse Muse gateway"), the cap
section says so in plain words, naming the rule.

### 2.7 Build-time stand-ins

The build firewall (`lib/sandbox/policy.ts`) lets a sandbox reach only `api.meta.ai` (Muse Code's routes), npm and the
platform host. So every outside service is played by the gateway for build tokens, in wave 2's pattern: a canned output
picked by `hash(normalized arguments) % n` (`cannedOutput`, tg-tools `lib/tools/canned.ts`), same each verify run, with
per-build overrides in `builds.tool_fixtures` under keys `cap:<id>:<name>`. Replies from a stand-in carry
`simulated: true`.

| Unit | Live | What a build token gets |
|---|---|---|
| 3 data | real rows in `live` | real rows in `b:<buildId>`, deleted at the end. Made-up users from `/identity/user/test` |
| 4 files, search | Blob, kept | real Blob under the build's prefix and a real index, deleted at the end |
| 4 datasets | vetted public files | the same files, through the gateway |
| 5 fetchPublic | the allowlisted API, cached | a recorded sample of that API |
| 5 vault calls | the builder's key, brokered | the service's recorded sample |
| 5 sends | a confirmation, then the builder's key | the same confirmation card, then `{simulated: true, id: "sim_..."}` |
| 6 jobs | the platform's cron | `/jobs/test-fire` gives a build job token, and the test calls the product's own job route |
| 6 webhooks | the public hook URL | the test posts a signed sample payload |
| 7 captions | Muse Voice Transcribe per chunk | the same real calls, from a fake microphone playing a fixture WAV |
| 7 live updates | SSE | the same SSE, on the build namespace |
| 8 media | the browser | the browser, with large files from `/assets` |
| 9 exec | a no-network sandbox | the same, at most 5 runs per build |
| 9 browse | a sandbox that reaches one host | a recorded page from `lib/caps/code/pages/` |
| 9 Muse Code | a session sandbox | replay, plus at most 2 real sessions ($0.50, 5 minutes), as the design in `~/mm-wt/_plan/muse-code-products.md` says |
| 10 Python | Vercel's Python runtime | PyPI open during the build (GET only), and a local runner |
| 11 Glimmer | the shared endpoint in a demo window | canned replies |
| 12 drive | the board | a simulated board whose export ends in PASS (`docs/DRIVE_EXPORT.md`) |
| 13 hardware | a real port or board | a simulated port, and the simulated gadget |
| 14 extension, games | the browser | the browser |

### 2.8 Fixed checks, verify and the judge (unit 2 writes the frame)

A capability counts as working only when a check the product can't fake says so.

- **Proofs.** The platform's test helpers, `tests/caps/<id>.ts`, record what happened while the smoke test runs, to
  `test-results/caps/<id>.json`: `{cap, checks: [{id, ok, detail, shot?}]}`.
- **The gateway's own record.** `GET {GATEWAY_URL}/caps/proof` (build token only, unit 2) answers what the gateway saw for
  the build namespace: rows written, files stored, jobs fired, sends simulated, sessions run. Each unit registers its
  counters there. Product code can't write this record.
- **The verify step.** `template/scripts/verify.mjs` gains a `caps` step after `smoke`, only when `musemuse.caps.json`
  exists. It runs `scripts/caps-check.mjs`, which runs each active cap's `scripts/caps/<id>.mjs` against both records. A
  failed check fails verify, so it goes into the fix prompt as a failing step.
- **The judge.** It gets `capsProofText` (2.6) and each cap's note. It never decides a fixed check. It checks screens.
- **Smoke rules for every cap:** use the caps helpers, assert structure and never a stand-in's words, keep each cap's real
  calls within its unit's number, and show each proven thing on a judge screenshot with a plain caption ("Second browser,
  after a reload").

### 2.9 Cleanup and sweeps (unit 2 writes the registry)

`lib/caps/cleanup.ts`: `registerCapCleanup({ cap, buildEnded(buildId), productOff(productId), sweep(now) })`.
`cleanupStep` (`build-steps.ts:247`) calls `buildEnded`. Disabling or taking down a product calls `productOff`. The hourly
cron (`app/api/cron/cleanup/route.ts`) calls `sweep`, which also clears build namespaces older than 24 hours from builds
that crashed. Every unit that stores anything registers.

### 2.10 Storage prefixes

`STORED_PREFIXES` in `lib/local-files.ts` gains, in plan order: `caps` (unit 4: `caps/files/`, also used by unit 9 for
`caps/browse/` and `caps/code/`), `assets` (unit 8), `extensions` (unit 14). Unit 12 uses `drive-kit/`, as its doc says.

## 3. Shared files and their rules

| File | Who edits it | Rule |
|---|---|---|
| `lib/env.ts` | every unit | One block per unit at the end of `env`, under `// ---------- Wave 3, unit N: <name> (docs/CAPABILITIES.md) ----------`, in plan order. Getters only, with the file's helpers. Unit 2's block has `enabledCaps` |
| `.env.example` | every unit with a setting | The same blocks in the same order. Each setting with its default and one plain line |
| `lib/caps/ids.ts` | unit 2 creates, each cap unit one line | Only your own `CAP_READY` line, in the merge that makes the cap work |
| `lib/caps/{brief-fields,catalog,render,judge,env,cleanup,hosts}.ts` registries | unit 2 creates, units one line each | Plan order. Your text lives in `lib/caps/<id>/` |
| `lib/brief/schema.ts` | unit 2 (the hook), unit 9 (`muse_code` in `TARGETS`) | No unit adds a field here directly |
| `lib/prompts/catalog.ts`, `lib/prompts/brief.ts`, `lib/brief/render.ts`, `lib/prompts/judge.ts`, `lib/judge.ts` | unit 2 | The hooks in 2.6, once. Unit 11 changes the `muse-glimmer` line only through its catalog entry |
| `lib/sandbox/policy.ts` | unit 2 | A `capHosts` option that reads `CAP_BUILD_HOSTS` in `lib/caps/hosts.ts`. Only unit 10 adds hosts there. Unit 9's own sandboxes get their policies from `lib/caps/code/policy.ts` |
| `lib/sandbox/{builder,tasks,paths,setup}.ts` | unit 2 | Overlays and round time. Other units ask unit 2 |
| `lib/pipeline/{steps,workflow,build-steps,logic}.ts` | unit 2 | Other units register hooks (2.5, 2.8, 2.9) instead |
| `template/AGENTS.md` | nobody | Every build reads it, flags or not. Cap text goes in the cap's skill and its build prompt section |
| `template/scripts/verify.mjs`, `template/playwright.config.ts` | unit 2 | The `caps` step, a `MUSEMUSE_BASE_URL` override for the live check, and a hook that merges `scripts/caps/<id>.browser.json` launch args for active caps. Units 7 and 14 add their JSON |
| `template/musemuse.schema.json` | unit 2 (`caps`), each cap unit (its own property) | Optional properties only, in plan order. `required` and `additionalProperties` stay as they are |
| `lib/types.ts` | unit 2 | Adds the `caps`, `milestone` and `live_check` build events |
| `lib/db/schema.ts` | units with a migration | New tables at the end of the file under `// ---------- Wave 3, NNNN_tag (unit N) ----------`, in number order. New columns on existing tables go inside the table with a comment naming the migration |
| `drizzle/`, `drizzle/meta/_journal.json`, `lib/db/__tests__/migrations.test.ts` | units with a migration | Section 4 |
| `lib/promote/__tests__/bundle.test.ts` | units 1, 2, 6 (new `products` and `builds` columns) | Decide sent or not, as in section 4's table |
| `lib/brief/__tests__/flags-off.test.ts` | every unit | Add your flag names to `FLAGS` and your brief key to the "differs only by" list, one line each, plan order |
| `lib/gateway/handler.ts` | units 1, 7, 9 | One marked line each, calling into your own module. Nothing else |
| `lib/gateway/{policy,tokens,estimate}.ts` | unit 2 (`build_id`), unit 9 (`code_session` scope and its estimate) | |
| `lib/gateway/gadget.ts` | unit 13, then unit 12's product tools after it | |
| `lib/tools/catalog.source.ts` | unit 5 | More read-only tools, then `npm run tools:sync` |
| `lib/native/targets.ts`, `components/product/GetItPanel.tsx` slots | units 9, 10, 14 | Your own entries only, plan order |
| `lib/local-files.ts` | units 4, 8, 14 | Append your prefix, plan order |
| `app/api/cron/cleanup/route.ts` | unit 2 | One `sweepCaps()` line |
| `vercel.json` | unit 6 | The jobs cron |
| `muse-device/server.py`, `muse-device/test_server.py` | units 12, 13 | Small, in Hussam's style, each change listed for him |
| `docs/CAPABILITIES.md` | every unit | Your own section, and one line under "Changes to this contract" |

## 4. Migrations

No wave 2 branch adds a migration. All ten worktrees (`tools`, `agentkit`, `brief`, `vr`, `outputs`, `shells2`, `getit`,
`labroutes`, `packager`, `labboxes`), and `tg-musecode`, end at `0015_product_clips`, journal time 1793431490646. The
Muse Code design's `code_sessions` table belongs to the Muse Muse General session (tg-musecode), as `0016_code_sessions`. `0017` is reserved for its decision models (tg-decide). Both use this section's journal rule.

| No. | Tag | Unit | Adds | Journal `when` |
|---|---|---|---|---|
| 0018 | `0018_trust` | 1 | `users.adult_confirmed_at`, `users.terms_version`, `users.terms_accepted_at`, `users.banned_at`, `users.ban_reason`; `products.taken_down_at`, `products.takedown_reason`, `products.status_before_takedown`; table `abuse_reports` | 1793431670646 |
| 0019 | `0019_engine` | 2 | `gateway_tokens.build_id` (uuid, references builds, indexed); `builds.round_plan` (jsonb); `builds.live_check` (jsonb) | 1793431730646 |
| 0020 | `0020_data` | 3 | tables `end_users`, `end_user_passkeys`, `product_rows`, `product_data_counts` | 1793431790646 |
| 0021 | `0021_files` | 4 | tables `product_files`, `product_search_docs` | 1793431850646 |
| 0022 | `0022_connect` | 5 | tables `product_secrets`, `product_sends`, `public_fetch_cache` | 1793431910646 |
| 0023 | `0023_jobs` | 6 | tables `product_schedules`, `job_runs`, `product_webhooks`, `owner_notices`; `products.owner_seen_at` | 1793431970646 |
| 0024 | `0024_code` | 9 | table `exec_runs` | 1793432030646 |
| 0025 | `0025_gpu` | 11 | table `glimmer_windows`; `training_jobs.product_id` | 1793432090646 |
| 0026 | `0026_hardware` | 13 | tables `boards`, `product_boards` | 1793432150646 |

Units 7, 8, 10, 12 and 14 have no migration. Live updates read `product_rows.seq` from 0020. Drive export keeps its state
on the board (`docs/DRIVE_EXPORT.md`). A unit that finds it needs one takes the next free number after 0026, in merge order.

Rules:

- **The journal time** of migration NNNN is `1793431490646 + (NNNN - 15) * 60000`, as in the table, whatever the clock said
  when it was generated. Drizzle applies a migration only when its time is above the last one a database ran, and the
  migrations test checks that times only go up. A fixed rule keeps that true whichever unit generates first.
- **Merge in number order.** A migration merges only after every lower number has merged or been dropped. A unit that is
  ready early waits, or the person merging gives it the next free number, sets its time by the rule, and updates this table
  in the same commit.
- **Generate on top of the merged predecessor**, with `npx drizzle-kit generate --name <tag>`, so the snapshot's `prevId`
  chains. Then set `when` by the rule.
- **Never run a wave 3 migration against a shared database before it merges.** Test on PGlite
  (`lib/db/__tests__/migrations.test.ts`) or a throwaway database. A shared database that ran a migration with a later time
  would skip the next ones.
- **The migrations test:** the first unit to merge replaces `"names the unit's three migrations in the agreed order"` with a
  list of 0013 to 0015 plus `WAVE3_TAGS`. Each unit appends its tag there and adds a check that a database at the
  number before keeps its rows and gets the new columns' defaults.
- **Promoting a local product** (`lib/promote/`): `builds.round_plan` is sent when set. Nothing else from wave 3 is:
  `products.taken_down_at`, `takedown_reason`, `owner_seen_at`, `builds.live_check`, `gateway_tokens.build_id` and every
  new table belong to the site that made them, as `native_*` and `tool_*` rows do (`docs/NATIVE.md`).

## 5. Flags

All off or at their defaults. "Writer" means the brief writer may pick the cap.

| Unit | Variable | Getter | Default | Means |
|---|---|---|---|---|
| 1 | `TRUST_SIGNED_IN_CAPS` | `trustSignedInCaps` | off | Caps marked `CAP_NEEDS_BUILDER` need a signed-in builder. Guests get the writer without them |
| 1 | `TRUST_BUILDER_DAILY_USD` | `trustBuilderDailyUsd` | 5 | What one builder's products may spend together per UTC day. Read only with the flag above |
| 1 | `TRUST_AGE_GATE` | `trustAgeGate` | off | 18 and over on platform sign-in and in new products |
| 1 | `TRUST_LEGAL_PAGES` | `trustLegalPages` | off | Privacy and terms pages on the platform and in new products |
| 1 | `TRUST_GEO_BLOCK`, `TRUST_GEO_COUNTRIES` | `trustGeoBlock`, `trustGeoCountries` | off, empty | Restricted territories blocked by `x-vercel-ip-country`. An empty list blocks nothing |
| 1 | `TRUST_REPORTS` | `trustReports` | off | Report link, takedown and ban |
| 1 | `TRUST_DEPLOY_BIG_FILES` | `trustDeployBigFiles` | off | Files over 10 MB deploy, or the deploy fails naming them. Never dropped silently |
| 1 | `TRUST_SPARK_TO_WONDER` | `trustSparkToWonder` | off | Live products' retired Spark 1.3 calls run on Muse Wonder, not Contributor |
| 2 | `ENGINE_CHECK_ON_TIMEOUT` | `engineCheckOnTimeout` | off | A first round that hits its cap goes on to verify and fix rounds |
| 2 | `ENGINE_ROUND_SCALING`, `ENGINE_ROUND_MAX_MINUTES` | `engineRoundScaling`, `engineRoundMaxMinutes` | off, 45 | Round time grows with the brief |
| 2 | `ENGINE_MILESTONES` | `engineMilestones` | off | Big briefs build in chained rounds |
| 2 | `ENGINE_LIVE_SMOKE` | `engineLiveSmoke` | off | The smoke test runs against the live URL before a product is marked live |
| 2 | | `enabledCaps` | [] | Section 2.1 |
| 3 | `DATA_ENABLED` | `dataEnabled` | off | Writer, `/data` routes |
| 3 | `DATA_SIGN_IN` | `dataSignIn` | off | End-user passkey sign-in |
| 3 | `DATA_PRODUCT_ROWS`, `DATA_PRODUCT_MB`, `DATA_DAILY_WRITES` | | 10000, 50, 5000 | Per product, live namespace |
| 4 | `FILES_ENABLED`, `FILES_SEARCH`, `FILES_DATASETS` | | off | Writer and `/files`; search; vetted datasets |
| 4 | `FILES_PRODUCT_MB`, `FILES_MAX_FILE_MB` | | 500, 25 | |
| 5 | `CONNECT_ENABLED` | `connectEnabled` | off | Writer, `fetchPublic` |
| 5 | `CONNECT_MORE_TOOLS` | | off | More read-only tools through the tool gateway |
| 5 | `CONNECT_VAULT`, `CONNECT_VAULT_KEY` | | off, none | The key vault, and its 32-byte base64 key. Platform only |
| 5 | `CONNECT_SENDS`, `CONNECT_SENDS_PRODUCTION` | | off, off | Sends off production; the second is the owner's switch for production |
| 6 | `JOBS_ENABLED`, `JOBS_WEBHOOKS` | | off | Writer, schedules and enqueue; webhooks |
| 6 | `JOBS_DAILY_RUNS`, `JOBS_DAILY_USD`, `JOBS_RUN_USD`, `JOBS_PAUSE_DAYS` | | 2000, 5, 0.10, 14 | |
| 7 | `LIVE_ENABLED`, `LIVE_UPDATES`, `LIVE_CAPTION_MINUTES` | | off, off, 10 | Writer and captions; live updates (needs `DATA_ENABLED`); caption minutes per visitor per day |
| 8 | `MEDIA_ENABLED`, `MEDIA_SPEECH`, `MEDIA_VIDEO`, `MEDIA_MUSIC`, `MEDIA_SAM_TILING` | | off | Writer; each part |
| 9 | `CODE_ENABLED` | | off | Writer, Pyodide and QuickJS |
| 9 | `CODE_EXEC`, `CODE_EXEC_VISITORS`, `CODE_EXEC_DAILY_USD`, `CODE_EXEC_SNAPSHOT_ID` | | off, off, 3, none | `/exec` |
| 9 | `CODE_BROWSE`, `CODE_BROWSE_DAILY_USD` | | off, 2 | `/browse` |
| 9 | `MUSE_CODE_ENABLED`, `MUSE_CODE_VISITORS` | | off, off | The `muse_code` target, as designed |
| 10 | `RUNTIME_ENABLED`, `RUNTIME_OUTPUTS`, `RUNTIME_NPM_PUBLISH` | | off | Writer and Python functions; source outputs; npm publishing |
| 11 | `GPU_GLIMMER_SHARED`, `GPU_GLIMMER_DAILY_USD`, `GLIMMER_ENDPOINT_URL`, `GLIMMER_ENDPOINT_KEY` | | off, 15, none, none | The shared Glimmer endpoint |
| 11 | `GPU_TRAIN_ON_DATA` | | off | "Train on my data" after ship |
| 12 | `DRIVE_EXPORT_ENABLED`, `DRIVE_EXPORT_PRODUCTS` | | off, off | As `docs/DRIVE_EXPORT.md` says |
| 13 | `HARDWARE_ENABLED`, `HARDWARE_BOARD_TOOLS`, `HARDWARE_BOARD_REGISTRY`, `HARDWARE_GADGET_OWNER_CHECK` | | off | Writer and browser links; `read_sensor` and `show_text`; boards per owner; the owner check |
| 14 | `NATIVE_EXTENSION`, `NATIVE_GAME_ENGINES`, `NATIVE_BRIDGE_NOTIFY`, `NATIVE_BRIDGE_BLE` | | off | Extension output; game engines; shell bridge parts |

## 6. Build order, dependencies and test spend

| Day | Units | Waits on |
|---|---|---|
| Oct 31 | 0 contract; 1 trust; 2 engine | Wave 2 merge for unit 2's overlay and hook edits |
| Nov 1 | 3 data, 5 connect, 12 drive export; then 4 files and 6 jobs once 3's gate and principal land | 3 needs 1 and 2. 4, 5 and 6 need 3. 12 needs nothing from wave 3 |
| Nov 2 | 9 code, 7 live, 8 media, 13 hardware, 11 gpu, 10 runtime, 14 native, in waves of at most 4 | 7 needs 3. 8 and 9 need 1's big-file fix. 13 needs 5's crypto. 11 needs 3. 14 needs wave 2's outputs, Get it and shells, and General's AWS Mac checks for the bridge |
| Nov 3 | One real test build per capability, fixes, flags on for what passed with the owner's OK, demo filming | |
| Nov 4 | Fixes only. Submit by 8 PM ET | |

| Unit | Depends on in wave 3 | Depends on wave 2 or elsewhere |
|---|---|---|
| 1 trust | | auth (`lib/auth.ts`), publish (`lib/publish/vercel.ts`) |
| 2 engine | | tg-brief (targets in schema, render, judge; `extraFiles`), tg-vr (overlays), tg-outputs (workflow end, `extraHosts`) |
| 3 data | 1, 2 | tg-tools (owner pass, `sign.ts`, `keys.ts`, `principal.ts`), tg-agentkit (`identity.ts`, the `musemuse` route) |
| 4 files | 2, 3 | gateway uploads (`lib/gateway/uploads.ts`) |
| 5 connect | 2, 3 | tg-tools (approvals, catalog, sync) |
| 6 jobs | 2, 3; 5 for held sends | |
| 7 live | 2, 3 | gateway asr |
| 8 media | 1 (big files), 2 | |
| 9 code | 1 (big files, tiers), 2 | tg-tools, tg-brief, tg-agentkit; the Muse Code spike (done, `tg-musecode` 23525cb) |
| 10 runtime | 2 (`CAP_BUILD_HOSTS`, live check) | tg-outputs (outputs pattern) |
| 11 gpu | 3 | `lib/train` (serve, datasets, caps) |
| 12 drive export | 13 for product tools only | `lib/drive`, `lib/train`, `lib/device`, `muse-device` |
| 13 hardware | 5 (`lib/secrets/box.ts`), 2 | `lib/gateway/gadget.ts` |
| 14 native | 2 | tg-outputs, tg-getit, tg-shells2; General's AWS Mac checks |

Test spend, out of the wave's limits. Unused money stays unspent.

| Unit | Meta | Vercel Sandbox | Composio | GPU |
|---|---|---|---|---|
| 1, 3, 4, 6, 7, 8, 10, 13, 14 | $1.50 each | $0.75 each | | |
| 2 engine (tile game rebuild, a 3-cap milestone build, the live check on Wonder) | $3 | $2 | | |
| 5 connect | $1.50 | $0.75 | $5 | |
| 9 code (exec, browse, 2 Muse Code sessions) | $2.50 | $3 | | |
| 11 gpu | $1 | $0.50 | | $10 shared with 12 |
| 12 drive export | | | | the quantize run, if the owner allows it |
| Reserve | $5 | $1 | | |

## 7. Unit 1: trust (groundwork)

**Scope.** Sign-in tiers, per-builder daily caps, an 18+ gate, privacy and terms pages for the platform and in every new
product, the restricted-territory block, a report link, takedown and per-builder ban, the deploy bug that drops files over
10 MB, and live products' retired Spark 1.3 calls moved to Wonder (Meta terms 6.2).

**Migration 0018_trust.** `users`: `adult_confirmed_at` timestamptz, `terms_version` text, `terms_accepted_at` timestamptz,
`banned_at` timestamptz, `ban_reason` text. `products`: `taken_down_at` timestamptz, `takedown_reason` text. Table
`abuse_reports`: `id` uuid, `product_id` uuid null, `product_slug` text, `reason` text (`illegal`, `harm`, `privacy`,
`copyright`, `impersonation`, `broken`, `other`), `detail` text up to 1,000, `reporter_key` text (an HMAC of the IP, 32
characters), `status` text default `open`, `handled_by` uuid null, `handled_at`, `created_at`; index on `(status, created_at)`.

**Routes.**

| Method and path | Auth | Does | Limits |
|---|---|---|---|
| `GET /terms`, `GET /privacy` | anyone | Platform pages, versioned by a `TERMS_VERSION` constant in `lib/trust/terms.ts` | |
| `POST /api/account/confirm` `{adult, termsVersion}` | signed-in builder | Records 18+ and the terms version. Sign-in asks once | |
| `GET /report/<slug>`, `POST /api/reports` `{slug, reason, detail}` | anyone | Files a report | 3 a minute and 5 a day per IP |
| `GET /admin/reports`, `POST /api/admin/reports/<id>` | admin | Reviews and closes | |
| `POST /api/admin/products/<slug>/takedown` `{reason}` | admin | Sets `taken_down_at`, revokes live tokens, hides the page and gallery card, removes the public alias | |
| `POST /api/admin/users/<id>/ban` `{reason}` | admin | Sets `banned_at`, refuses sign-in, takes down every product of theirs | |

**Gateway.** One marked line in `handler.ts` after the token check calls `trustCheck(token)` in `lib/trust/gateway.ts`: a
taken-down product or a banned owner gets 403 `product_disabled`; over `TRUST_BUILDER_DAILY_USD` gets 429
`budget_exceeded`. With `TRUST_SPARK_TO_WONDER`, `handler.ts:193` maps `muse-spark-1.3` to `muse-wonder-1.0` for live tokens
instead of to Contributor. Build tokens keep `TEST_MODEL`. The estimate and the budget then follow Wonder's price.

**Deploy fix.** `lib/publish/vercel.ts:17` `MAX_FILE_BYTES` and the walker at about line 118 skip big files, and the caller
drops the `skipped` list. With `TRUST_DEPLOY_BIG_FILES`: check Vercel's real per-file limit for API deployments, upload
what fits, and fail the deploy naming any file that doesn't. Units 8 and 9 need this for wasm and model files.

**Template overlay `trust`** (applied to every new build while any of `TRUST_AGE_GATE`, `TRUST_LEGAL_PAGES`,
`TRUST_GEO_BLOCK`, `TRUST_REPORTS` is on): `proxy.ts` (check this Next version's name for middleware in
`node_modules/next/dist/docs/`) for the geo block and age gate; `app/(musemuse)/privacy/page.tsx`,
`app/(musemuse)/terms/page.tsx`, `app/(musemuse)/age/page.tsx`; `components/Footer.tsx` with "Built with Muse Muse. Not an
official Meta product.", Privacy, Terms and Report. The platform writes `musemuse.privacy.json` from the brief: which
models get which inputs, what caps store and for how long, Composio's retention when tools are used, 18+, and that Meta's
terms apply. The pages render that file, so they match what the product does. The gate is off when `MUSEMUSE_BUILD=1`
(written to `.env.local` only for builds through `capBuildEnv`), so tests reach the product.

**Brief.** No field. `capsForBuilder(user)` in `lib/trust/tiers.ts` gives a guest no `CAP_NEEDS_BUILDER` caps. Writer
rule, only when trust is on and the builder is a guest: "This person isn't signed in, so the product can't save data,
connect accounts, run jobs, run code or use GPUs. Build the version that works without them and list that as a limit."

**Checks.** `scripts/caps/trust.mjs` (in the `trust` overlay): `/privacy` and `/terms` answer 200, the footer has all three
links, `proxy.ts` is the pristine copy. Judge note: none. Smoke rule: none.

**Owns.** `lib/trust/**`, `app/terms`, `app/privacy`, `app/report`, `app/admin/reports`, `app/api/account/confirm`,
`app/api/reports`, `app/api/admin/{products,users}/**`, the platform's `proxy.ts`, `template/caps/trust/**`,
`lib/publish/vercel.ts` (the big-file part), the 0018 migration. Shared: `handler.ts` (one line), `lib/quota.ts`
(`checkBuildAllowed` reads the ban).

**Guards.** Meta terms: 18+, a privacy policy per product (6.2), restricted territories blocked by us (Meta doesn't route by
location), AI disclosure (the footer and the model lines on the privacy page). `TRUST_GEO_COUNTRIES` comes from Meta's
Geographic Use Policy, confirmed by the owner. A report never shows the reporter's IP. Takedown is reversible by an admin.
Spark to Wonder raises a live product's cost per call about 40 times on input and 100 times on output ($0.10 and $0.20
per million on Contributor, $4 and $20 on Wonder), so its daily budget covers fewer runs.

### 7a. As built (tg-cap-trust, Oct 31)

Built on `tg-cap-int` (9a1d7dd). Every flag is off by default, and with all of them off nothing new is written. Two
harmless differences remain with every flag off, and no golden covers them: `reopenSandbox` tries to read the trust
record (`TRUST_RECORD_DIR/musemuse.trust.json`), which isn't there in a product built without the overlay, so the read
fails quietly; and every verify and demo script carries the trust restore block, which does nothing without that
record (unit 2's caps restore is there unconditionally too). Otherwise the brief goldens, `flags-off-surface` and
`caps-off` pass unchanged with the trust flags added to their lists.

**The legal text is a draft.** The platform's Terms and Privacy (`lib/trust/terms.ts`) and each product's privacy and terms
pages (`template/caps/trust`) are plain-language drafts for the owner and counsel to review. They are not legal advice.
The source files say so.

**Migration 0018_trust**, as planned, plus `products.status_before_takedown` (text, null), which a takedown fills and its
undo clears. Its journal index is 16 and `0019_engine` moved to 17, with 0019's SQL unchanged and its snapshot (now
`0017_snapshot.json`) keeping its id and following 0018's. Generating 0019 on top of 0018 writes its statements exactly,
and `drizzle-kit generate` finds no drift. The migrations test checks that a database at 0015 keeps its users and
products, which read null for every new column.

**Renumbered (Oct 31, after General's 0017 landed as 88ac98e).** 0016 is retired for good, since 0017 landed first.
The journal now runs 0015, 0017_decision_datasets (General's, idx 17), 0018_trust (idx 18), 0019_engine (idx 19), each
`when` by section 4's rule. 0018's and 0019's snapshots are `0018_snapshot.json` and `0019_snapshot.json`, rebuilt on
0017's chain: General's 0017 snapshot plus trust's changes, then engine's. No table was changed on both sides. Each
keeps its id. The migrations test checks that drizzle-kit generates each wave 3 file exactly from the snapshot before
it, and that generating now writes nothing. A database that ran 0015 then 0019 now skips 0017 and 0018, and the local
check names both. The next wave 3 migration takes 0020, then 0021 and on, in merge order. The old blocker below is
history.

**Merge blocker (history): the numbering.** Keep this branch off main and off previews until General's 0016 and 0017 land. Then
renumber 0018 and 0019 above them, regenerate both snapshots on top of General's (the `prevId` chain), and set `when` by
section 4's rule. Two things make it worse than an ordering question:

- The snapshot files are drizzle-kit's index names, `0016_snapshot.json` and `0017_snapshot.json`, the same names
  General's two will have. The renumbering regenerates them; never merge them by hand.
- A database that ran `tg-cap-int`'s or `tg-cap-engine`'s journal (0019_engine straight after 0015) skips 0018 for good,
  since its time is older, and then every full select of `users` or `products` fails on the new columns, including
  `getProductPage` with every flag off. The local ones that likely did: `~/mm-wt/cap-int/.data/pglite-cap-int` and
  `~/mm-wt/cap-engine/.data/pglite-cap-engine` (not opened from here). Recreate them before running a merged branch on
  them. `scripts/migrate.ts` now checks a local PGlite folder first and stops with a message naming the migration it
  would skip (`lib/db/migration-order.ts`; checked on a throwaway PGlite in this worktree: exit 1 naming 0018_trust). The
  Neon path is unchanged.

**Sign-in tiers** (`TRUST_SIGNED_IN_CAPS`, `lib/trust/tiers.ts`). `builderTier` is admin, builder (signed in with the
shared code, decision 3), guest (the shared `OPEN_ACCESS=guest` account) or banned. `capsForBuilder(tier)` gives a guest or
a banned builder only caps without `CAP_NEEDS_BUILDER`. `briefStep` passes `briefTierFor(build.userId)` to `writeBrief`
(a new optional `builder` field), which uses its caps for the writer's schema, catalog and caps rules, and adds the guest
rule as one more line of "Writing the brief". With the flag off, `briefTierFor` returns undefined and reads nothing.
`tierMayUseBuilderCaps` and `productTrust` (`lib/trust/gateway.ts`) are what unit 3's gate check 4 needs. GPUs aren't a
cap: unit 11 should check the tier itself.

**The builder's daily dollars** (`TRUST_BUILDER_DAILY_USD`, read only with `TRUST_SIGNED_IN_CAPS`). `builderSpendToday`
sums every usage row today of a product the builder owns or a build they started (gateway, tools, Muse Code, the brief and
judge), each row once. Two places stop at the cap: the gateway's trust check answers 429 `budget_exceeded` for a live
token, and `checkBuildAllowed` refuses a new build (429 with a sentence, which the composer now shows). Build tokens of a
running build keep their own $10 budget, so a build isn't cut off halfway. Admins and the shared guest have no builder
cap: the guest's products are each held to their own daily budget and `DAILY_SPEND_CAP_USD` as today, and a $5 cap on the
one account every guest shares would turn off all of them at once. The check counts what was spent before the call, not
the call's estimate, so calls running at that moment can go a little over. The tool gateway gets the same trust check
(`lib/tools/handler.ts`, one marked line after its product check, wired in `lib/tools/deps.ts` with the same flags),
since tool calls settle real dollars and `builderSpendToday` counts them: an over-cap builder's live tool calls answer
429 `budget_exceeded` before anything is reserved. Uploads and gadget calls spend nothing and already refuse a disabled
product, which a takedown makes it.

**The gateway** gets one marked line after the product check (`deps.trustCheck`, wired in `lib/gateway/deps.ts` only
while `TRUST_REPORTS` or `TRUST_SIGNED_IN_CAPS` is on): a taken-down product or a banned owner's gets 403
`product_disabled` before rate limits, and the builder cap as above. **Spark to Wonder**: a marked block where the handler
maps `muse-spark-1.3`. With `TRUST_SPARK_TO_WONDER` a live token's call runs on `muse-wonder-1.0`, says so in
`x-musemuse-note`, and is estimated and metered at Wonder's price; build tokens keep Contributor. Built and off
(decision 2).

**18+** (`TRUST_AGE_GATE`). Sign-in shows the box and refuses (400, a sentence) someone who hasn't confirmed for the current
`TERMS_VERSION`, then records `adult_confirmed_at`, `terms_version` and `terms_accepted_at`. Someone who confirmed before
can leave it unticked, so it asks once per terms version. `POST /api/account/confirm` covers sessions from before the flag
and the shared guest, whose confirmation is a cookie (`mm_adult`, a year) because the account is shared. The sign-in page
shows the box to anyone who still needs it, and `checkBuildAllowed` refuses a build until then (403, "Open Sign in to
confirm").

**Platform pages** (`TRUST_LEGAL_PAGES`): `/terms` and `/privacy` (404 with the flag off), linked under the sidebar's
disclaimer with the disclaimer's own style, so the shell's CSS is unchanged. The privacy draft says what reaches Muse Spark
1.3 Contributor, the tier Meta may train on: test builds (made-up data), changes to products first built on Spark 1.3
(`refineBuildModel` resumes those on Contributor whatever the flags say), and, while `TRUST_SPARK_TO_WONDER` is off, those
products' own calls. A test ties the text to `refineBuildModel`.

**Restricted territories** (`TRUST_GEO_BLOCK`, `TRUST_GEO_COUNTRIES`). The list is ISO codes and region codes, and `meta`
stands for section 3 of Meta's Geographic Use Policy ("Last updated: October 12, 2026", read Oct 31): AF, BY, KH, CN, HK,
MO, CU, ER, ET, HT, IR, IQ, LY, MM, NI, KP, PK, RU, SO, SY, VE, EH, and Crimea, Sevastopol, Donetsk and Luhansk as UA-43,
UA-40, UA-14 and UA-09 (`x-vercel-ip-country-region`). Section 2.2 also restricts Muse Image in India, so a product that
calls `muse-image-1.0` adds IN, and with any list on the platform blocks the docs playground's Muse Image routes
(`/api/docs/v1/images/*`) from India with a 451 JSON answer. Not covered, and listed for the owner under decision 4: the
playground's `/responses` with `muse-image-1.0` (the model is in the body, which a rewrite can't read), and the fixture
images and Muse Image test calls a build makes for a builder in India (the build steps have no request to read). On the platform this is not a `proxy.ts`: it is `next.config.ts` rewrites on the country
headers to a 451 route (`app/api/trust/unavailable`), built from the env when the config loads, so with the flag off the
config is unchanged and no proxy runs on every request. The gateway, cron and Next's assets aren't blocked. A change to
the list needs a redeploy, as any env change on Vercel does. Tested through Next's own config matcher
(`unstable_getResponseFromNextConfig`).

**Reports, takedown, ban** (`TRUST_REPORTS`). `/report/<slug>` and `POST /api/reports` take a reason and up to 1,000
characters from anyone, 3 a minute and 5 a day per reporter, where the reporter is an HMAC of the IP cut to 32 characters
(key `toolKey("trust-reports")`); the IP isn't stored. Deletion requests come here as "privacy" (decision 13).
`/admin/reports` lists open reports first, never the reporter, with close, dismiss, reopen, take down, undo, ban and lift.
A takedown sets `taken_down_at` and the reason, sets the status to `disabled` (the kill switch the gateway, MCP connector,
gallery and refinements already honor), revokes the live tokens at exactly `taken_down_at`, runs `capsProductOff`, hides
the product page, and pauses the product's Vercel project (`POST /v1/projects/{id}/pause`, the route `@vercel/sdk` 1.28's
`pauseProject` calls), which blocks its active production deployment at every address: its domain, the team alias and
the deployment's own URL. Removing only the domain left those up, since products have no deployment protection. When
pausing fails, the takedown removes the production domain instead (`DELETE /v9/projects/{id}/domains/{host}`), and
`/admin/reports` says the site may still be up. Undo gives back only the tokens revoked at that moment, exactly the
status the takedown replaced (`status_before_takedown`, so a failed product stays failed and one turned off with the kill
switch stays off; one still building then gets what its build ended as), unpauses the project and adds the domain back
in case the backup removed it. A ban sets `banned_at`, refuses sign-in (403) and builds, ends the account's existing
sessions (`getSessionUser` reads `banned_at` for a real session while `TRUST_REPORTS` is on), and takes down every
product of the builder at the same moment, so lifting it undoes exactly those. A ban stops the account, not the person:
while `OPEN_ACCESS=guest` is on, a banned person can sign out and build as the shared guest. Admins and the shared guest
can't be banned (409). The product page has a Report button.

**Deploy fix** (decision 1, unflagged, no `TRUST_DEPLOY_BIG_FILES`). Vercel's limits page says the source files that can be
uploaded are limited to 100 MB on Hobby and 1 GB on Pro, which may mean each file or all of them together, so the platform
holds both to the lower number: no file over 100 MB, and no more than `TRUST_DEPLOY_TOTAL_MB` (default 100; raise it on a
Pro team) in all. `collectDeployFiles` reads the index first and fails the deploy step as a `FatalError` naming the files
("over Vercel's 100.0 MB limit for one file", or "add up to ..., over the ... one deployment takes", biggest first) before
any file is read into memory or any deployment is made. Nothing is left out without a word. Uploads send views of the
collected blob, not copies, so 8 parallel uploads no longer hold 8 more copies. A deploy refused this way revokes the live
token minted for it; other deploy errors retry the step as before. Units 8 and 9 can ship wasm and model files up to
100 MB, within the total.

**The trust overlay** (`template/caps/trust`, `lib/trust/overlay.ts`). It isn't applied through `overlaysFor` or the caps
file: a product with only trust would get a caps step with no caps, which fails. Instead provisioning applies it after
the caps, while any of `TRUST_AGE_GATE`, `TRUST_LEGAL_PAGES`, `TRUST_GEO_BLOCK` or `TRUST_REPORTS` is on: the platform
writes `musemuse.trust.json` (the flags, the territory list, the Report link) and `musemuse.privacy.json` (each model, what
it does and which inputs it gets; what it keeps, from the caps or "nothing on a server"; Composio when an agent uses tools
beyond web search; temporary uploads) from the brief, keeps both root-owned in `/vercel/musemuse/trust`, and commits the
overlay as "Trust: privacy, terms, age gate, report link". Files: `proxy.ts` (the geo block with a 451 page, and the age
gate for page visits, off under `MUSEMUSE_BUILD=1`), `lib/platform/trust.ts`, `components/Footer.tsx` (the template's
contract and sentence, plus "It uses AI, which can make mistakes." and Privacy, Terms and Report), `/privacy`, `/terms` and
`/age` in `app/(musemuse)/`, `app/api/musemuse/age/route.ts` (a year's cookie for these terms; SameSite=None and
Partitioned on https so it works in a frame; it goes back only to a path on the same product, refusing control
characters and backslashes, so `/<tab>/evil.example` can't become an open redirect), `tests/musemuse-trust.spec.ts` and
the `muse-trust` skill. All are platform files: every verify and demo puts them and the two records back
(`restoreTrustFilesScript`, a no-op in a product without the overlay). What says a product has the overlay is its
root-owned record, never the commit message, so a reset, squash or amend can't skip the restore. `.env.local` gets `MUSEMUSE_BUILD=1` at provision, and on every change for a product built with the overlay,
whatever the flags say then. brief.md gets a "Trust pages" section after the platform services. The check is the
platform spec, which runs inside smoke, not `scripts/caps/trust.mjs`: trust has no caps step. A snapshot from before the
overlay gets it copied in on a local run; the live site refuses until `npm run snapshot` is run again.

**Tests.** `lib/trust/__tests__/`: tiers (7), gateway (9, through the real handler), geo (7, with Next's matcher), reports,
takedown, ban, spend and 18+ on PGlite (10), overlay (9, apply and restore in bash on a git repo), provision scenario (4),
terms text (2). `lib/publish/__tests__/big-files.scenario.test.ts` (3): the real collect script keeps an 11 MB file and lists
a file just over 100 MB, an 11 MB file is in the deployment's file list with its digest, and a deploy with the big one fails
by name before any deployment. `template/scripts/__tests__/trust.test.mjs` (9): no path collides but the Footer, the
Footer's contract, and in a product copy with the overlay the proxy (451 by country and region, the gate's redirect, off
under `MUSEMUSE_BUILD=1`), the age route's cookie, the pages rendered from the two files, and the template's `tsc`.
Migrations: 0018 keeps rows. Full suite at the end: 3956 tests, 3948 pass, 0 fail, 8 skipped (live Meta tests without a
key); `.test.tsx` 587 of 587; template 427 of 427; tsc clean.

After the review fixes, each fix has a test that fails without it (each was checked by putting the old file back): the
age route refuses tab, newline, CRLF, NUL and backslash escapes (template `trust.test.mjs`); restore after a squash
(overlay, 10); the privacy text against `refineBuildModel` (terms, 3); undo of a failed, turned-off, partial and
still-building product (reports, 11, with the pause and its domain backup); the pause and unpause calls (`alias.test.ts`,
3); tool calls over the builder cap and of a taken-down product (gateway, 13); a banned session (`session.test.ts`, 3);
the total-size refusal without reading the blob, and uploads as views (big files, 5); the refused deploy's token
(build steps scenario); the docs Muse Image routes from India (geo, 9); the skipped-migration check on PGlite
(`lib/db/__tests__/migration-order.test.ts`, 5). New route tests (`routes.test.ts`, 10): every trust route answers 404
with its flag off before asking who's calling, 401 or 403 to a visitor or builder, 400 to a bad body, and does its job.
Full suite: 3989 tests, 3981 pass, 0 fail, 8 skipped (the same live Meta tests); `.test.tsx` 587 of 587; template 427 of
427; tsc clean. Spend for the fixes: $0 (no Meta, no Sandbox, no Vercel call).

**The real test build still hasn't run** (section 22). Nothing in this round could run it either: it needs a fresh
`VERCEL_OIDC_TOKEN` from the owner, then `npm run snapshot`. Until it runs, every trust product flag stays off on
production: with any of `TRUST_AGE_GATE`, `TRUST_LEGAL_PAGES`, `TRUST_GEO_BLOCK` or `TRUST_REPORTS` on and today's
snapshot, `applyTrust` refuses every new build ("This builder snapshot doesn't have the trust overlay"). It stays a
refusal rather than skipping the overlay with a log line, for two reasons: unit 2's `applyCaps` refuses the same way, and
a product built without the overlay while the flags say it has one would ship with no geo block, age gate or privacy
page, which is what the flags exist to prevent. In the first round: a local build needs a fresh `VERCEL_OIDC_TOKEN` for Vercel Sandbox (the one on this
machine expired Oct 29), and pulling one was refused by the permission classifier ("Credential Materialization"). A local
site with throwaway secrets and every trust flag on was started to look at the pages, but its Turbopack dev server couldn't
find Next through the worktree's symlinked `node_modules`, so it served 500s and was stopped. What did run for real: one
brief on `TEST_MODEL` (Contributor, $0.000872) for a made-up note asking for a shared family grocery list saved across
phones, written as a guest with `TRUST_SIGNED_IN_CAPS` on. It came back "partly", web only, with the limit "No sign in and
no cloud save. The list stays only in this browser local storage." Sandbox spend $0.

**Not proven yet.** Pausing and unpausing a project on the real Vercel API (check once on a throwaway project before
`TRUST_REPORTS` goes on, and what a paused project serves at each address), and whether Vercel's 100 MB is per file or in
all (one real API deploy). `next build` of a product with the overlay (Turbopack with `proxy.ts`, the `(musemuse)` route group and
the JSON imports): the template test typechecks and runs the files directly, but no sandbox built one. The trust spec has
never run in Playwright. The Vercel domain removal and re-adding are tested against a fake API only. The age cookie in a
frame on Safari depends on its support for Partitioned cookies. The platform pages were checked by tests, not in a
browser. Run one guest build with every trust flag on (section 22) before any of these flags goes to production.

**For the owner.** Decisions 2 (Spark to Wonder: built, off, about 40 to 100 times the price per call) and 4 (confirm
`TRUST_GEO_COUNTRIES=meta`, including the Muse Image and India rule, and pick how builds from India handle Muse Image:
block build starts from India while a list is on, skip generated fixture images for builders there, which needs the
builder's country saved on the build, or accept it). The Vercel plan, for `TRUST_DEPLOY_TOTAL_MB` (100 on Hobby, up to
1000 on Pro). That a ban can't stop a person while guest mode is on. Whether the shared guest account should have a builder
cap. Review of the Terms and Privacy drafts with counsel. The builder snapshot needs `npm run snapshot` before any trust
flag is on in production. Nothing in `muse-device/` changed.

## 8. Unit 2: engine (one-shot reliability)

**Scope.** Round time by brief size, a capped first round that still gets checked, milestone builds, the caps frame
(registry, overlays, hooks, verify step, proof route, cleanup), the per-build data namespace, and a smoke check against the
live URL after deploy.

**Why the tile game hit the 25-minute limit, as far as code can tell.** Build 6c99bf4b ("Tinker Tile Trials", the Chip's
Challenge-style note), complex, 3 screens, 3 actions (a level grid, a tile sheet image, hints), a solver check, on
Contributor, $0.049, failed after 25:52 with "Muse Code ran past its 25-minute limit and was stopped."

1. `lib/pipeline/steps.ts:28` gives every build round 25 minutes, whatever the brief's size.
2. `lib/pipeline/workflow.ts:500` fails the build the moment the first round hits that cap: no verify, no judge, no fix
   round. Fix rounds that hit their cap are still checked (`workflow.ts:292`, "it may have fixed enough"). So 25 minutes of
   work were thrown away unseen. This is the main cause in code.
3. The round includes Muse Code's own `npm run verify` runs ("Done means" in `template/AGENTS.md`). verify allows itself up
   to 2 + 5 + 10 + 15 minutes (typegen, tsc, `next build`, the 900 s smoke), and the workflow's own verify budget is 8
   minutes (`steps.ts:30`). Two or three full verify runs fill a round.
4. The smoke test calls real models (`template/AGENTS.md`, "Tests"). A test that waits for a generated level to pass a solver
   is slow and can fail at random, which invites more verify runs.
5. It spent $0.049 on Contributor, the same as the builds that finished in 11 to 14 minutes ($0.03 to $0.05). So the extra
   time likely went to commands (builds, tests, waits), not model turns. This is an inference: the round's own log isn't in
   the evidence folder. Read build 6c99bf4b's `build_events` before changing anything.
6. Not a cause: the sandbox's 60-minute session (`builder.ts:114`) and its 40-minute work window (`builder.ts:126`).

**Engine changes, exact places.**

| Place | Change | Flag |
|---|---|---|
| `lib/pipeline/steps.ts:28-31` | Add `roundCapMs(brief, kind)`: 25 minutes plus 5 per cap block, plus 5 when complex, at most `ENGINE_ROUND_MAX_MINUTES`. Fix rounds 12 to 15 minutes and verify 8 to 10 minutes when the brief has caps. Add `MAX_BUILD_WALL_MS` (90 minutes) | `ENGINE_ROUND_SCALING` |
| `lib/pipeline/workflow.ts:498` and `:571` | `capMs: roundCapMs(...)` instead of `stepTimeoutMs("build")` | same |
| `workflow.ts:500` and `:576` | A timed-out first round logs "Muse Code was stopped at its time limit. Checking what it built." and goes on to `preview` and `checkAndFix`, like a fix round | `ENGINE_CHECK_ON_TIMEOUT` |
| `workflow.ts`, between `:504` and `:506` | Milestones: for each milestone after the first, run verify strict with no judge, write `milestone-<n>.md` (`renderMilestonePrompt`), resume the same session as round n. A milestone that fails verify gets its failures in the next milestone's prompt | `ENGINE_MILESTONES` |
| `workflow.ts:295` | Fix rounds number from `milestones + fix`, so logs never share a round. Milestones plus fixes stay under `REFINE_ROUND_STRIDE` (10) | same |
| `workflow.ts` `ship()`, after `:387` (`emitStep deploy`) and before `registerStep` `:391` | The live check: `liveSmokeStep` reruns `tests/smoke.spec.ts` from the build's sandbox with `MUSEMUSE_BASE_URL=<liveUrl>`, the firewall opened to the live host for that run (`extraHosts`, from tg-outputs). Pass: live. Fail: partial, with "It passed on the build machine, but failed on its live link: <reason>", saved in `builds.live_check`. Skipped when publishing is off | `ENGINE_LIVE_SMOKE` |
| `lib/pipeline/build-steps.ts:411-449` `provisionStep` | Passes the brief's overlays and `capBuildEnv`; mints the build token with `buildId` | caps only |
| `build-steps.ts:247` `cleanupStep` | Calls `capsBuildEnded(buildId)` after revoking the build token | caps only |
| `build-steps.ts` `startDeployStep` (about `:900`) | Adds `capDeployEnv(brief, liveToken)` to the product's env | caps only |
| `lib/pipeline/logic.ts:101` | `allowedModelsFor` appends cap markers | caps only |
| `lib/sandbox/builder.ts:696` (`startMuse`) | `ensureTime(sandbox, capMs + POLL_WORK_MS)` instead of `LONG_WORK_MS`, so a 45-minute round has its session time. `StartMuseInput` gains `capMs` | `ENGINE_ROUND_SCALING` |
| `builder.ts:271` `envLocal` | Appends `capBuildEnv` lines. None without caps | caps only |
| `builder.ts` provisioning (tg-vr's target block, about `:386-401`) | Installs `template/caps` when missing, runs `applyCapsScript` after `applyTargetScript` | caps only |
| `lib/sandbox/tasks.ts`, `paths.ts`, `setup.ts` | `applyCapsScript`, `restoreCapFilesScript`, `CAPS_DIR`, `ACTIVE_CAPS_FILE`, `CAPS_FILE`; the snapshot copies `template/caps` read-only | caps only |
| `lib/judge.ts:99` and `:109` | `capsProofText` before the screenshots; `judgeInstructions(brief)` (tg-brief) already carries the notes | caps only |
| `lib/brief/render.ts` | The hooks in 2.6. Under caps or milestones only, the Budget section adds: "Run `npm run verify` at most twice in a round. The platform runs it again after you stop." and "When the product makes something that must pass a check (a solvable level, valid code), test one generated item for real and the rest with fixtures." | caps or milestones |

**Migration 0019_engine.** `gateway_tokens.build_id` uuid null, references `builds`, indexed. `builds.round_plan` jsonb null
(`{capMinutes, milestones: [{title, state}]}`). `builds.live_check` jsonb null (`{ok, at, reason?, url}`).

**Brief.** `milestones: [{ title (up to 60), doneMeans (up to 300) }]`, 2 or 3, or null, in the writer's schema only with
`ENGINE_MILESTONES`. Writer rule: "Fill milestones only when the brief lists 3 or more platform services, or is complex
with 3 screens. Each milestone ends with something that runs." Build prompt: `## Milestones`, and round 0 builds only the
first.

**Routes.** `GET {GATEWAY_URL}/caps/proof` (build token only): what the gateway saw for the build namespace, by cap (2.8).
No other new route.

**Events** (`lib/types.ts`): `{type: "caps", cap, check, ok, detail}`, `{type: "milestone", index, of, title, state}`,
`{type: "live_check", ok, url, reason?}`. The build room shows them as lines. The product page leaves them out.

**Checks.** Template tests for the caps step (pass, fail, no caps file). Judge: no new note.

**Owns.** `lib/caps/{ids,brief-fields,catalog,render,judge,env,cleanup,hosts,proof}.ts`, `lib/caps/__tests__/flags-off.test.ts`
and its golden, `template/caps/core/**` (with unit 3's `user.ts`), `scripts/caps-check.mjs`, `tests/caps/index.ts`, the
0019 migration, and every shared file section 3 gives to unit 2.

**Guards.** A longer round costs more Muse Code time, which is why it scales with the brief and has a ceiling. Milestones
multiply Muse Code spend, so they need their flag and stop at 3. The live check makes no model call (decision 15), so it
costs nothing.

### 8a. As built (tg-cap-engine, Oct 31)

Built on `tg-cap-contract` (378f387), then merged with wave 2 (d8ffec4) by intent in 56663cd, with the hooks where 2.5
and 2.6 put them beside wave 2's. Every flag is off by default. The review fixes after the merge are listed at the end
of this section.

**Round time.** `roundCapMs` (`lib/pipeline/steps.ts`) with `ENGINE_ROUND_SCALING`: a first round (and each milestone round)
gets 25 minutes, plus 5 when complex, plus 5 when the brief lists 6 or more screens and actions together, plus 5 per cap
block, at most `ENGINE_ROUND_MAX_MINUTES` (45, held to 25 through 90). Fix rounds get 12, or 15 when complex or with caps.
Verify gets 8 plus 1 per cap block, at most 10. The tile game note (complex, 3 screens, 3 actions) gets 35 minutes. The
plan is worked out once in `briefStep` (`BriefSummary.plan`, saved to `builds.round_plan`), and the workflow reads it, so a
replay takes the same caps. With a plan, `MAX_BUILD_WALL_MS` (90 minutes) applies: a milestone or fix round that wouldn't
fit is not started, and the verify before it runs as the last one (warn mode). The room check before a verify keeps time
for that verify and its judge, a fix round, and the verify and judge after it (`JUDGE_RESERVE_MS`, 3 minutes per judge).
A fix round whose cap inside the wall is null at its start, because the verify and judge used the margin, isn't started
either. A scaled round passes `capMs` to
`startMuse`, which keeps the cap plus 15 minutes of sandbox session.

**A first round that hits its cap** (`ENGINE_CHECK_ON_TIMEOUT`): logs "Muse Code was stopped at its time limit. Checking
what it built." and goes on to preview, verify and fix rounds, for new builds only. A refinement that hits its cap stops
as today ("The live version was kept."), flag or not: the judge checks the product's brief, not the change, so a
half-made change could pass and replace the live version. With the flag off the failure message names the round's real
cap ("past its 35-minute limit"), which is today's text at 25.

**Milestones** (`ENGINE_MILESTONES`): `milestones` (2 or 3, `{title, doneMeans}`) is in the writer's schema only under the
flag (`newBriefSchemaFor({ ..., milestones })`), and always optional in the stored brief. `normalizeRawBrief` clamps each
title to 60 and doneMeans to 300 characters, keeps the first 3 and turns fewer than 2 into null, so an overrun doesn't
fail the brief. brief.md gets `## Milestones` right after Done means, only when the round plan saved in
`builds.round_plan` has milestones (the plan the workflow runs), never from the stored brief alone. Between milestones: a strict verify with no judge, then `milestone-<n>.md`
(`renderMilestonePrompt`, `lib/engine/prompts.ts`) with that verify's failures, in the same session as round n - 1. Fix
rounds number from the last milestone's round and stay under `REFINE_ROUND_STRIDE`. Each step is a `milestone` event and
updates `builds.round_plan`.

**Exact logic** (`ENGINE_EXACT_LOGIC`, new): one writer rule. When a product's main promise depends on exact logic (a
deterministic guard, a solvable level, totals that add up, a valid file), the brief says that logic is plain code the
product runs (a parser, a solver, a validator or a rules table) and a model only reads the input or explains the result.

**Big-build budget lines.** brief.md's Budget says "Run `npm run verify` at most twice in a round" and "test one generated
item for real and the rest with fixtures" when the brief has caps or milestones, or either round flag is on (the contract
said caps or milestones only: the tile game needs them most, and has neither).

**The live check** (`ENGINE_LIVE_SMOKE`, `lib/engine/live-check.ts`, `liveCheckStep`): after the deploy event and before
register, no model call. GET `/` must answer 200 with an HTML page (3 tries); each action route in musemuse.json must
answer OPTIONS with POST allowed (Next answers OPTIONS itself, so no product code runs and no model is called); a product
with caps must answer `/api/musemuse/health` with `{"ok":true}` (the core overlay's route). A failure ships as partial with
"It passed on the build machine, but failed on its live link: <reason>", saved in `builds.live_check`. Skipped when
publishing is off, which is every local run (decision 6). It does not rerun the smoke test: the base URL override is in
Playwright for when that's wanted.

**The caps frame.** Registries in `lib/caps/` (one object per hook, keyed by cap id; a cap's brief key is its id),
`env.enabledCaps`, and the hooks beside wave 2's: the brief schema after `targets` and `agent`; the writer's engine rules
in "Writing the brief", then where it runs, then each cap's section; the catalog's caps blocks after the agent block,
with the agent phrase kept in the third bullet; `capsBuildLines` right after `agentLines`, `capsRefineLines` (bullets)
right after `refineTargetLines`, `capsMarkdown` right after the Agent section; `capsJudgeNotes` inside
`judgeInstructions(brief)` after the glasses note; `judgeContent` with `capsProofText` before the screenshots. Then cap
markers in `allowedModelsFor` after the models and agent markers, `capBuildEnv` after `envLocal`'s lines in `.env.local`
at provision and on every change (envLocal itself is untouched), `capDeployEnv`, `capHosts` in the build policy next to
wave 2's `extraHosts`, `gateway_tokens.build_id` on the build token of a brief with caps at provision and on every change,
`capsBuildEnded` in cleanup, `sweepCaps` in the cron (left out of its answer while nothing sweeps), and `capsProductOff`
when an admin turns a product off (`productOff` pauses, never deletes). `GET {GATEWAY_URL}/caps/proof`
(`app/api/gateway/caps/proof/route.ts`) answers a build token tied to a build with `{buildId, namespace: "b:<id>", since,
caps}` from `CAP_PROOF`, and 404 `unknown_endpoint` while no cap is enabled. `?since=<ISO time>` counts only from then:
each counter is `(buildId, { since })` and must honor it. It refuses a disabled or failed product's token and allows 30
reads a minute per token.

**The manifest.** `template/musemuse.schema.json` has an optional `caps` list of cap ids. `lib/caps/manifest.ts`:
`allowedCapIds(token, manifest)` narrows a live token's caps by it and never widens them (a refinement's build token
skips it, as for tools), for unit 3's gate (check 3). `startDeployStep` narrows a cap product's live token by the
manifest it deploys; a product with no caps isn't read there.

**Overlays.** `template/caps/<overlay>/` beside `template/targets/`, never copied into a product as it is. `core` ships
`scripts/caps-check.mjs`, `tests/caps/index.ts` (`recordCapCheck`), `app/api/musemuse/health/route.ts` and the `muse-caps`
skill, all platform files. Provisioning writes the root-owned `CAPS_DIR/active.json`, applies the overlays after the
template (files, exact deps, `musemuse.caps.json`, commit "Caps: data, jobs") and appends the caps' env lines. Every
verify and demo puts the platform files and `musemuse.caps.json` back first (a no-op without `active.json`). The snapshot
script installs `template/caps` read-only; a local run on an older snapshot copies it in, and refreshes the platform
files when the pristine `verify.mjs` has no caps step (as targets do), and the live site refuses with a plain message.
Provisioning applies the caps right after the targets. Core ships `lib/platform/identity.ts` as an exact copy of the agent
kit's, checked byte for byte with the agent overlay applied beside it (`caps-agent.test.mjs`).

**verify.** A `caps` step after smoke, only with `musemuse.caps.json`. In a build sandbox it runs the read-only copy,
`CAPS_DIR/core/files/scripts/caps-check.mjs --root <product> --since <verify's start>`: the list of caps comes from
`CAPS_DIR/active.json`, each checker from its overlay in `CAPS_DIR`, and the gateway's address and build token from
`CAPS_DIR/gateway.json`, root-owned and read-only, which provision and every change write (moved into place from a file,
so the token is never in a command line). Nothing in the product folder decides it, and `.env.local` is never read for
it. Each cap's `check({ record, proof, gateway, gatewayProblem, root })` runs against the smoke test's record and what the
gateway saw since this verify started; a cap with no checker or no record fails. When the gateway's record can't be read,
each failed check says why. On a local run `gateway.json` has no address and says the build machine can't reach the
gateway, and `provisionStep` says so once in the build room. The summary gains `caps: [{cap, checks}]`, each check becomes a `caps` event, and
the judge sees them as decided. Playwright merges `scripts/caps/<id>.browser.json` args into the smoke project and takes
`MUSEMUSE_BASE_URL` (no local server then). The config's logic is inline TypeScript: importing the `.mjs` helpers would
break every product's `tsc`.

**The Wonder estimate** (agreed with General). `fitOutputToBudget` (`lib/gateway/estimate.ts`): when a Responses call's
estimate is over the budget left, `max_output_tokens` is set to the most output the rest pays for after the input, so the
estimate stays a ceiling, and the call is refused only below 1,024 output tokens. A Muse Code turn of about 30,000 input
tokens with `max_output_tokens` 128000 is estimated at about $0.76, which used to stop a $1 session after about $0.24. On
for `code_session` tokens (unit 9) and, behind `ENGINE_FIT_OUTPUT`, for build tokens. Never for live tokens (their users
get the clean budget message, not a reply cut short), and never for a `json_schema` reply (cut-off JSON doesn't parse).
After a fitted call reserves, the token's spend is read again with that reservation in it, and when another call raced
for the same remainder this one is refused and its reservation removed. Two marked blocks in `lib/gateway/handler.ts`
with a `fitOutputToBudget` dep, a shared-file edit this section adds. The scope name `code_session` must be confirmed with
General (tg-musecode's `TokenScope` doesn't have it yet).

**Migration 0019_engine.** As planned. Its journal index is 16 and its snapshot `meta/0016_snapshot.json` until 0016 to
0018 merge: the merger renumbers both, regenerating the snapshot on top of 0018. The migrations test allows wave 3 tags
ahead of their index, checks their journal times by the rule, and checks that a database at 0015 keeps its rows.

**Goldens.** `lib/caps/__tests__/flags-off-surface.test.ts` runs the real code with the sandbox, database, token store,
deploy and model faked, and snapshots what a product with no caps gets: the network policy `provisionSandbox` and
`reopenSandbox` set (public and local runs), every file and command at provision, the `.env.local` provision and reopen
write, `STEPS`, the token allowlist, `startDeployStep`'s env, and the judge's instructions and content. It uses only APIs
d8ffec4 has, and its goldens are its own output on d8ffec4 alone (an extracted copy with that one file added). The branch
passes it unchanged. `template/scripts/__tests__/playwright-off.test.mjs` does the same for Playwright's config, web and
VR. `lib/caps/__tests__/flags-off.test.ts` checks every hook and registry is empty with the flags off.
`lib/gateway/__tests__/caps-off.test.ts`. `caps-off.test.mjs`: verify run for real in a bare folder reports the same six
steps. The brief goldens are byte for byte d8ffec4's.

**What the two failed builds' events show** (read Oct 31 from the local site that ran them). Both briefs were complex
with 3 screens and 3 actions. 6c99bf4b (the tile game) had its code written 7 minutes into the round. The other 18 minutes
went to shell runs about two minutes apart (verify runs: it read its own judge screenshots at minute 12) and to edit after
edit of `app/api/actions/generate_level/route.ts`, where a model-made level had to pass the solver. d5255100 (ForgeBot, the
robot URDF designer) had its code by minute 8 and spent 17 more on the same loop around `generate_robot_proposal`, and
edited the template's `lib/meta/queue.ts` along the way. So point 3 and point 4 above hold: the time went to verify runs
and a smoke test waiting on generated items, not to writing code. With the round flags each gets a 35-minute first round
and the "verify at most twice" and "one generated item for real" lines, and with `ENGINE_CHECK_ON_TIMEOUT` the platform's
own verify and fix rounds see what was built instead of throwing it away.

**Test builds** (Oct 31, the local site from this worktree on a throwaway PGlite database, Muse Code on `TEST_MODEL`
Contributor, made-up notes, reminders off, with `ENGINE_CHECK_ON_TIMEOUT`, `ENGINE_ROUND_SCALING`, `ENGINE_MILESTONES` and
`ENGINE_EXACT_LOGIC` on). The costs below are what the builds recorded. They leave out the products' own calls: on a local
run the product calls Meta directly through the firewall, not through the gateway, so those calls ran on Muse Wonder and
Muse Image, not on `TEST_MODEL`, and weren't metered. With the made-up data only, but not the rule that every real model
call in tests is on `TEST_MODEL`. See the spend line after the table.

| Build | Note | Brief | Result |
|---|---|---|---|
| dc4de384 | The tile game note again | Complex, 2 screens, 2 actions (the writer made it smaller this time), plan 30 minutes, no milestones. The level check is code: "checks it with code for walls, item reach and exit path" | First round 4 minutes, verify and judge passed on the first try, live in 8.0 minutes for $0.026 (no link of its own: a local run). Screenshots in the run's `shots/` |
| 60956185 | A tabletop campaign helper: scene planner, battle maps with tokens on a grid, session recap | Complex, 3 screens, 3 actions, 3 milestones from the writer, plan 35 minutes. Exact logic: "The app checks with code that every token sits on an open square" | Milestone rounds 0, 1 and 2 took 4, 11 and 7 minutes. The strict verify after milestones 1 and 2 failed in smoke (a test waiting on model-made scenes timed out), and each failure went into the next milestone's prompt. After milestone 3, verify failed only on a too-tall judge screenshot; fix round 1 ran as Muse Code round 3, then verify and judge passed and it went live in 36.5 minutes for $0.087. `builds.round_plan` ended failed, failed, passed. Poster in `shots/milestones-poster.jpg` |
| a32e8572 | The same note, an earlier try | 3 milestones, plan 35 minutes | Cut off in milestone 1 when the earlier builder session stopped and took the local site with it. The local workflow store doesn't pick runs up again after a restart, and the build room's stop needs a round on the build row, so its sandbox ran until its session ended. Not counted |

The tile game passing once shows the flags don't get in the way. It doesn't prove they fixed the failure: this run's
brief was smaller and its first round never came near its cap. The milestone build proves the chain end to end on a real
sandbox: prompts, round numbers, strict verifies, events, the round plan and the fix round after it. A milestone's state
is what the strict verify right after it found, so "failed" on an early milestone that a later round fixed is expected.

**Spend.** Recorded: $0.026 + $0.087 + $0.031 = $0.144. Not recorded, estimated from the builds' events and the briefs'
own per-run estimates: dc4de384 ran its smoke test about 3 times (1 platform verify, about 1 of Muse Code's own, the demo)
at $0.04 a run, about $0.12; 60956185 about 9 times (4 platform verifies, about 4 of Muse Code's, the demo) at $0.11, about
$0.99; a32e8572 at most one run, under $0.09. So the products' own calls were about $1.10 to $1.20, up to about $2.30 if
each smoke test ran the flow twice, and the unit's Meta spend about $1.25 to $2.45 of its $3. The review's fix round
(Oct 31, evening) made no model call and no sandbox run. No more engine test builds that call product models until
ui-brand's TEST_MODEL change for local runs lands, or local builds go through a gateway they can reach.

**Not proven yet.** A first round that really hits its cap and then ships has scenario tests only. The live check needs a
published deploy, which local runs never make (decision 6). No cap overlay but core exists, so no build has run the caps
step for real, and the "3-cap brief with milestones" build in section 22 waits for three caps to be ready. The fit is
tested against the handler with fakes, not a real Muse Code session (unit 9 has none yet). The new `verify.mjs` and
`playwright.config.ts` have never run in a real sandbox: every test build ran on the existing snapshot's pristine copies.
After the next `npm run snapshot`, run one no-caps local build before any push and compare its verify summary's step names
and Playwright projects with today's.

**Cap test builds can't prove a gateway check on the local site.** A local run's sandbox can't reach the gateway
(`PLATFORM_URL` is localhost), so `/caps/proof` and every stand-in the gateway plays are out of reach, and any check that
needs the gateway's record fails there, now with that reason. Decision 6 makes the local site the place for test builds.
So cap test builds (units 3 to 14, and this unit's 3-cap build) need a public `PLATFORM_URL` (a tunnel to the local
site) or decision 6's preview database. For General and the owner.

**For unit 3.** The gate should refuse a build-scope token with no `build_id` rather than fall back to `live`. Counters
registered in `CAP_PROOF` take `(buildId, { since })` and count only from `since`. Check 3 (marker) uses
`allowedCapIds(token, manifest)`.

**Review fixes after the merge** (Oct 31): goldens rewritten as real surfaces from d8ffec4; refinements of a cap product
keep the build namespace and the caps' env lines; the gateway record, read-only checkers and per-run window above; the
wall holds; refinements that hit their cap keep the live version; the fit limited and race-checked; manifest caps;
milestones clamped and rendered from the plan; core's `identity.ts`; the judge's proof lines carry no product text. Process:
these fixes ran tests only, on in-memory PGlite where a test needs one (no `DATABASE_URL`). The earlier run's PGlite was in
the session scratchpad rather than the worktree, and its `VERCEL_OIDC_TOKEN` came from `vercel env pull` into a temp file
(mode 600, deleted at once, never over a `.env.local`, no value printed); General confirms that pattern.

## 9. Unit 3: data (A)

**Scope.** Rows on the shared database with shared, visitor, owner and user scopes and quotas; end-user sign-in through
Muse Muse with passkeys (no email service needed), with a signed code back to the product; `data()` and `currentUser()`;
the `muse-data` skill; the brief's `data` block. Also the cap gate and principal (2.2, 2.4), which later units reuse.

**Migration 0020_data.**

- `end_users`: `id` uuid, `display_name` text null (what the person typed, up to 40), `created_at`, `last_seen_at`.
- `end_user_passkeys`: `id` uuid, `end_user_id`, `credential_id` text unique, `public_key` bytea, `counter` bigint,
  `transports` jsonb, `created_at`, `last_used_at`.
- `product_rows`: `id` uuid, `product_id`, `namespace` text (`live` or `b:<buildId>`), `collection` text, `scope` text,
  `owner_key` text null (subject key; null for shared), `doc_id` text, `data` jsonb, `bytes` integer, `version` integer,
  `seq` bigint from a sequence, set on every write (unit 7 streams it), `created_at`, `updated_at`, `deleted_at` null (soft
  delete, purged after an hour). Unique `(product_id, namespace, collection, scope, owner_key, doc_id)`; index
  `(product_id, namespace, seq)`.
- `product_data_counts`: `(product_id, namespace)` key, `rows` integer, `bytes` bigint, updated in the same statement as
  each write, so quotas need no count query.

**Routes.**

| Method and path | Auth | Does | Limits |
|---|---|---|---|
| `POST {GATEWAY_URL}/data/<collection>?scope=` `{data}` | product or build token, `cap:data`, the scope's principal | Creates a doc, returns `{id, version}` | 64 KB a doc; quotas below |
| `GET {GATEWAY_URL}/data/<collection>/<id>?scope=` | same | Reads one | 120 a minute per token |
| `PUT {GATEWAY_URL}/data/<collection>/<id>?scope=` `{data, ifVersion?}` | same | Replaces; 409 `version_conflict` | |
| `DELETE {GATEWAY_URL}/data/<collection>/<id>?scope=` | same | Soft delete | |
| `POST {GATEWAY_URL}/data/<collection>/query` `{scope, where?, order?, limit?, after?}` | same | Lists, newest first by default. `where` is equality on top-level fields | 100 a page |
| `DELETE {GATEWAY_URL}/data/_mine` | visitor or user | Deletes every row this person has in this product | |
| `GET {GATEWAY_URL}/data` | owner or build | Collections with counts | |
| `POST {GATEWAY_URL}/identity/user` `{code}` | product token | Trades a sign-in code for a 30-day `us1` session and `{id, name}` | 10 a minute per IP |
| `POST {GATEWAY_URL}/identity/user/test` `{name}` | build token only | A session for a made-up user | 20 per build |
| `GET {PLATFORM_URL}/u/sign-in?product=<slug>&returnTo=<path>` | browser | The passkey page | |
| `POST {PLATFORM_URL}/api/u/passkey/{register,login}/{options,verify}` | browser, same origin | WebAuthn ceremonies, relying party the platform host | 10 a minute per IP |
| `GET {PLATFORM_URL}/api/products/<slug>/data` | the product's builder, or admin | Browse and export shared collections; private scopes as counts only | |

Scopes: **shared** rows are readable by anyone on the product; writes need the owner unless the manifest's collection says
`"writes": "anyone"` (then 30 writes a minute per IP and 500 a day per visitor). **visitor** rows need the visitor header.
**owner** rows need a valid owner pass. **user** rows need a valid user session. A sign-in code goes back only to the
product's registered live origin (`products.live_url`), never to a URL in the request. The code is
`uc1.<product>.<subject>.<nonce>.<exp>.<sig>`, 5 minutes, spent once.

Quotas (live namespace): 10,000 rows, 50 MB, 20 collections, 5,000 writes a day per product; 200 rows per visitor; 1,000 per
user. Build namespace: 500 rows, 5 MB. Spend: none. Counts in `rate_limits` day windows and `product_data_counts`.

**Template.** Overlay `data`: `lib/platform/data.ts` (`data(request).collection(name, { scope }).create / get / put / delete
/ query`, `deleteMine(request)`), `components/platform/SignIn.tsx`, `.agents/skills/muse-data/SKILL.md`,
`tests/caps/data.ts` (`secondBrowser(page, fn)`, `signInAs(page, name)`, `seed(collection, docs)`), `scripts/caps/data.mjs`.
In `core`: `lib/platform/user.ts` (`currentUser(request)`, `signInHref(returnTo)`), `app/api/musemuse/user/route.ts`
(`GET ?code=` sets `mm_user`, HttpOnly, Secure, SameSite=Lax), `app/api/musemuse/user-sign-out/route.ts`.

**Brief.** `data: { collections: [{ name: /^[a-z][a-z0-9_]{0,31}$/, scope: "shared" | "visitor" | "owner" | "user", holds,
personal: boolean }] (1 to 6), signIn: "none" | "optional" | "required" }`. Catalog: "Saving: a product can save items
through the platform, so they survive a reload and others can see them. Shared items everyone sees; visitor items stay
with one browser; user items follow a person who signs in with a passkey through Muse Muse. Pick it only when the muse
needs saved items. Personal details go only in visitor, owner or user collections." The first "How products run" bullet
then says saving works through the platform when the brief has a `data` block. Build prompt `### Saving data`: the
collections as a table, the helper calls, the scope rules, the quota a user sees, "Never save what this list doesn't name",
and "Rows in this build are test rows, deleted when it ends."

**Checks.** Fixed: a shared item saved in one browser shows in a second browser after a reload; a visitor item doesn't; a
user item shows for the same test user in the second browser; the manifest's collections match the brief's; the gateway's
record shows the writes. Judge: "This product saves data. The screenshot captioned 'Second browser' shows what another
person sees after a reload. Fail it if an item the brief says is shared is missing there." Smoke: one `secondBrowser` pass,
at most 20 data calls.

**Owns.** `lib/caps/data/**`, `lib/caps/{gate,principal}.ts`, `app/api/gateway/data/**`,
`app/api/gateway/identity/user/**`, `app/u/sign-in`, `app/api/u/**`, `app/api/products/[slug]/data`,
`template/caps/data/**`, `user.ts` and its routes in `core`, the 0020 migration.

**Guards.** Products never see a credential or a raw end-user id. Personal fields only in non-shared scopes, said on the
privacy page. Live rows never reach a build. Data never goes to Contributor: live products call Wonder, and test builds see
only made-up rows. A person can delete what they saved (`deleteMine`). The owner sees private scopes as counts only.
Needs a signed-in builder.

## 10. Unit 4: files and search (F)

**Scope.** `files()` with quotas and no 24-hour expiry, a full-text search helper, vetted public datasets on Blob that
builds can read, and citations the judge can see. Today's `/uploads` keeps its one-day life for model input.

**Migration 0021_files.** `product_files`: `id` uuid, `product_id`, `namespace`, `scope`, `owner_key` null, `name`,
`content_type`, `bytes` bigint, `sha256`, `blob_path`, `status` (`pending`, `ready`), `created_at`, `deleted_at`.
`product_search_docs`: `id` uuid, `product_id`, `namespace`, `scope`, `owner_key` null, `source` jsonb (`{fileId}` or
`{collection, docId}`), `title`, `body` text, `tsv` tsvector generated from title and body with the `simple`
configuration (any language), GIN index, `created_at`.

**Routes.**

| Method and path | Auth | Does | Limits |
|---|---|---|---|
| `POST {GATEWAY_URL}/files/ticket` `{name, contentType, bytes, scope}` | `cap:files`, the scope's principal | A client upload token for Blob under `caps/files/<productId>/<namespace>/<id>`, as `/uploads` does | 25 MB a file |
| `POST {GATEWAY_URL}/files/<id>/done` | same | Checks size and type at Blob, marks it ready | |
| `GET {GATEWAY_URL}/files?scope=&after=`, `GET {GATEWAY_URL}/files/<id>` | same | Lists; one file's facts and its read URL | 100 a page |
| `DELETE {GATEWAY_URL}/files/<id>` | same | Deletes the Blob and the row | |
| `POST {GATEWAY_URL}/search/index` `{source, title, text}` | `cap:files` | Adds text to the product's index | 1 MB a doc, 2,000 docs |
| `POST {GATEWAY_URL}/search/query` `{q, scope, limit}` | same | Ranked hits with a snippet and a citation `{source, name, offset}` | 10 hits, 30 a minute |
| `GET {GATEWAY_URL}/datasets`, `GET {GATEWAY_URL}/datasets/<id>/<file>` | any product or build token | The vetted list; one file, streamed or redirected | 60 a minute |

Quotas: 500 MB and 2,000 files per product, 50 MB per visitor or user; a build gets 50 MB, deleted at its end. Spend: none
at Meta. Bytes count against the quota. Text from a PDF or a photo comes from the product's own Wonder call, on its Meta
budget. Datasets live in `lib/caps/files/datasets.json`: id, title, license, source, why, files with bytes and sha256.

**Template.** Overlay `files`: `lib/platform/files.ts` (server `files(request).list / get / delete`, browser
`uploadFile(file, { scope })`), `lib/platform/search.ts` (`search(request).index / query`),
`components/platform/Citation.tsx` (with `data-citation`), skill `muse-files`, `tests/caps/files.ts`, `scripts/caps/files.mjs`.
The build's firewall gets `blobUploads` when the brief has files.

**Brief.** `files: { holds, scope, search: boolean, datasets: string[] (up to 3, catalog ids) }`. Catalog lists the vetted
datasets by id and license. Build prompt `### Files and search`.

**Checks.** Fixed: an uploaded fixture is listed after a reload; a search for a fixture phrase returns it, and the screen
shows a `Citation` for it; a dataset read shows in the gateway's record. Judge: "Answers built from the person's files or
a dataset show where they came from. Fail it when an answer that says it comes from a file shows no source." Smoke: one
upload, one search, one dataset read.

**Owns.** `lib/caps/files/**`, `app/api/gateway/{files,search,datasets}/**`, `template/caps/files/**`, the dataset mirror
script `scripts/caps/mirror-datasets.ts`, the 0021 migration.

**Guards.** Content types on an allowlist; anything that isn't an image, audio, video or PDF is served as an attachment,
never as a page. Takedown and `productOff` delete the files. Dataset licenses must allow redistribution, and the citation
shows the license. Needs a signed-in builder.

## 11. Unit 5: connect (B)

**Scope.** `fetchPublic` over an allowlist of keyless public APIs with recorded samples for builds; more read-only tools
through the tool gateway; a per-product key vault (bring your own keys, brokered, never in product code); messaging,
payments and social posting only through the builder's own keys or accounts, one confirmation per send, off in production
until the owner says so. Also `lib/secrets/box.ts`, which unit 13 reuses.

**Migration 0022_connect.** `product_secrets`: `id`, `product_id`, `name`, `service`, `ciphertext` bytea, `iv`, `tag`,
`key_version`, `created_by` (subject key), `created_at`, `revoked_at`; one active row per `(product_id, name)`.
`product_sends`: `id`, `product_id`, `channel`, `recipient_hash`, `approval_nonce`, `status`, `provider_id`, `created_at`.
`public_fetch_cache`: `key` text primary (hash of the normalized request), `api`, `status`, `content_type`, `body` bytea,
`fetched_at`, `expires_at`.

**Routes.**

| Method and path | Auth | Does | Limits | Spend |
|---|---|---|---|---|
| `POST {GATEWAY_URL}/fetch` `{api, path, query}` | `cap:connect`, any principal | One call to an allowlisted API, cached | 60 a minute per product, 20 per IP, 2,000 a day; 1 MB | `fetch` rows, $0 |
| `GET {GATEWAY_URL}/vault` | owner | Key names only | | |
| `POST {GATEWAY_URL}/vault` `{name, service, value}`, `DELETE {GATEWAY_URL}/vault/<name>` | owner | Stores encrypted; revokes | 10 keys | |
| `POST {GATEWAY_URL}/vault/call` `{name, method, path, body?}` | the service entry's principals | The gateway adds the key to the service's own auth header and calls its host | 500 a day per product | `vault` rows, $0 to us |
| `POST {GATEWAY_URL}/send` `{channel, to, body, approval?}` | owner | First answers `needs_confirmation`; repeated with the approval, sends with the builder's own key or account | 10 a day, 5 recipients each | `sends` rows, $0 to us |

Allowlists live in `lib/caps/connect/apis.json` (id, base URL, allowed paths, parameters, cache seconds, the API's terms
link, its own rate) and `lib/caps/connect/services.json` (id, hosts, auth header shape, allowed methods and paths, whether
visitors may trigger it). Each API's terms are checked before it goes in. Candidates to check: US weather (api.weather.gov),
Wikipedia's REST API, Open Library, REST Countries, USGS earthquakes. Recorded samples:
`lib/caps/connect/samples/<api>.json`. Approvals use tg-tools `mintApproval` and `checkApproval`; changed arguments fail.
More tools: read-only entries in `lib/tools/catalog.source.ts`, then `npm run tools:sync -- --check`.

**Template.** Overlay `connect`: `lib/platform/fetch-public.ts`, `lib/platform/secrets.ts` (`secrets(request).list / call`),
`lib/platform/send.ts`, `components/platform/{ConfirmSend,KeySettings}.tsx`, skill `muse-connect`, `tests/caps/connect.ts`,
`scripts/caps/connect.mjs`.

**Brief.** `connect: { publicApis: string[], keys: [{ service, why }], sends: [{ channel: "email" | "sms" | "chat" |
"social" | "payment", why }] }`. The third "How products run" bullet then names the allowlisted APIs and says other
services need the builder's own key. Build prompt `### Outside services`.

**Checks.** Fixed: a fetch returned the API's sample and the screen shows it; a send showed its confirmation card, the
test pressed Confirm, and the screen says sent as a sample; no key text appears in the product's source or pages (the
checker scans the build output for vault values the build was given). Judge: "Messages, payments and posts in this test
are samples. A card that says 'Sent (sample)' is the product working." Smoke: one fetch, one confirmed send.

**Owns.** `lib/caps/connect/**`, `lib/secrets/box.ts`, `app/api/gateway/{fetch,vault,send}/**`, `template/caps/connect/**`,
its catalog entries, the 0022 migration.

**Guards.** Keys: AES-256-GCM with `CONNECT_VAULT_KEY`, decrypted only inside the gateway function, never logged, never
returned. Payments only through the builder's own hosted checkout links: the product never touches card details. Every
send is confirmed once by the owner (Meta's Acceptable Use Policy: no consequential actions without a person). Sends stay
off on production until `CONNECT_SENDS_PRODUCTION`. Builder accounts only, never Muse Muse's. Composio keeps payloads up to
a year without zero data retention, as `docs/AGENT_TOOLS.md` says. Needs a signed-in builder.

## 12. Unit 6: jobs (C)

**Scope.** Schedules in `musemuse.json` (15 minutes at least), a platform cron fan-out with job tokens and per-run budgets,
webhooks into the gateway, long agent runs checkpointed across ticks, results to `data()`, and owner notices. Jobs read and
notify. Writes to the outside wait for a person. Schedules pause after 14 days with no owner visit.

**Migration 0023_jobs.** `product_schedules`: `id`, `product_id`, `name`, `every_minutes`, `at_minute` null, `tz`,
`next_run_at`, `last_run_at`, `paused_at`, `pause_reason`, `created_at`; unique `(product_id, name)`. `job_runs`: `id`,
`product_id`, `schedule_id` null, `webhook_id` null, `name`, `trigger` (`schedule`, `webhook`, `enqueue`, `test`),
`namespace`, `status`, `attempt`, `tick`, `checkpoint` jsonb, `input` jsonb, `budget_usd`, `cost_usd`, `error`,
`created_at`, `started_at`, `finished_at`. `product_webhooks`: `id`, `product_id`, `name`, `secret_hash`, `created_at`,
`revoked_at`. `owner_notices`: `id`, `product_id`, `kind`, `title`, `body`, `created_at`, `read_at`.
`products.owner_seen_at` timestamptz null, set when the owner opens the product's page or gets an owner pass.

**Routes.**

| Method and path | Auth | Does | Limits |
|---|---|---|---|
| `GET /api/cron/jobs` (every 5 minutes, `CRON_SECRET`) | Vercel cron | Finds due schedules and queued runs, mints a `jr1` token, POSTs `<liveUrl>/api/jobs/<name>` with `x-musemuse-job`, 60 s timeout, 10 at a time | `JOBS_DAILY_RUNS` |
| `POST {GATEWAY_URL}/jobs/verify` | product token plus `x-musemuse-job` | The product's handler proves the call came from the platform; returns `{runId, name, input, checkpoint, budgetUsd}` | |
| `POST {GATEWAY_URL}/jobs/checkpoint` `{state, done}` | same | Saves up to 64 KB; the next tick resumes | 10 ticks a run |
| `POST {GATEWAY_URL}/jobs/enqueue` `{name, input}` | `cap:jobs`, any principal | Queues a run for the next tick | 50 a day per product |
| `POST {GATEWAY_URL}/jobs/notify` `{title, body}` | job | An owner notice in Muse Muse | 10 a day |
| `POST {GATEWAY_URL}/hooks/<productId>/<name>?k=<secret>` | anyone with the secret | Stores the payload and queues the named job | 64 KB, 60 a minute, 1,000 a day |
| `POST {GATEWAY_URL}/jobs/test-fire` `{name, input}` | build token only | A build job token for the test to call the product's own route | 10 per build |
| `POST /api/products/<slug>/webhooks`, `DELETE ...` | the builder | Makes a hook and shows its secret once | 2 per product |

Every model call in a run carries `x-musemuse-job`, and the gateway holds and settles the run's dollars the way
`lib/gateway/runs.ts` does for agent runs. A run stops at `JOBS_RUN_USD` (default $0.10, at most $0.50). A job principal may
write only to collections the manifest marks `"jobWrites": true`. A send from a job becomes an approval the owner confirms
later. Schedules come from the manifest at deploy (`register`), and a refinement updates them.

**Template.** Overlay `jobs`: `lib/platform/jobs.ts` (`jobHandler(name, fn)`, `enqueue`, `checkpoint`, `notifyOwner`), skill
`muse-jobs`, `tests/caps/jobs.ts` (`fireJob(request, name, input)`), `scripts/caps/jobs.mjs`. The product writes
`app/api/jobs/<name>/route.ts` with `jobHandler`.

**Brief.** `jobs: { schedules: [{ name, every, does }] (up to 3), webhooks: [{ name, from, does }] (up to 2) }`. Build
prompt `### Background jobs`. It also replaces, for this brief only, the Budget line "never wait for it, retry it or
schedule anything" with: "Background work goes only through the jobs helper. Nothing in your session keeps running after
it ends."

**Checks.** Fixed: a test-fired job ran, its run is `done` in the gateway's record, it wrote a row to its results collection,
and the screen shows that result. A webhook's sample payload led to a run. Judge: "A background job ran during this test.
Its result should show on a screen, such as 'Last digest'." Smoke: two job runs at most.

**Owns.** `lib/caps/jobs/**`, `app/api/cron/jobs`, `app/api/gateway/{jobs,hooks}/**`, `app/api/products/[slug]/webhooks`,
the owner notices on the dashboard, `template/caps/jobs/**`, `vercel.json` (the cron), the 0023 migration.

**Guards.** Per-run budget, the product's daily budget and `JOBS_DAILY_USD`. No sends, payments or posts without a person.
15 minutes at least. Paused after 14 days without the owner, and when the product is off. A job never runs on a build's
product from the cron. Needs a signed-in builder. Meta 10.1(i) asks whether runs with nobody present count as access "on
behalf of" a third party: see the owner questions.

## 13. Unit 7: live (D)

**Scope.** Near-live captions from 2 to 3 second chunks with chunk times, live shared updates (SSE over data), and a test
microphone fixture. Two-way realtime voice waits for Meta.

**Migration.** None. Updates read `product_rows.seq` and `deleted_at` from 0020.

**Routes.**

| Method and path | Auth | Does | Limits |
|---|---|---|---|
| `POST {GATEWAY_URL}/v1/asr/transcribe` (existing) with `x-musemuse-live: <session>` | product token with `cap:live` | One chunk. One marked line in `handler.ts` raises the per-IP limit for this endpoint to 30 a minute for `cap:live` tokens | `LIVE_CAPTION_MINUTES` audio minutes per visitor per day |
| `POST {GATEWAY_URL}/live/ticket` `{collection, scope}` | `cap:live`, a principal who may read that scope | An `lt1` read ticket, 10 minutes | |
| `GET {GATEWAY_URL}/live/stream?ticket=&after=<seq>` | the ticket | SSE of `{seq, op, id, data}`, polled every 1.5 s, closed at 55 s; the browser reconnects with `after` | 20 streams per product, 200 in all |

CORS on the stream allows only the product's live origin, or the build's preview origin for a build ticket. Spend: captions
are Muse Voice Transcribe calls on the product's Meta budget. Streams cost function time, which the stream caps bound.

**Template.** Overlay `live`: `lib/platform/captions.ts` (`useCaptions()`: records chunks, converts with `toWav16k`, posts to
the product's own route, returns `[{text, startMs, endMs}]` with a short overlap so words aren't cut),
`lib/platform/live.ts` (`useLive(collection, scope)`), `app/api/musemuse/live-ticket/route.ts`, skill `muse-live`,
`tests/caps/live.ts`, `scripts/caps/live.mjs`, `scripts/caps/live.browser.json` (Chromium's fake media device and
`--use-file-for-fake-audio-capture=fixtures/talk.wav`).

**Brief.** `live: { captions: boolean, updates: { collection } | null }`. Catalog: "Near-live captions: the browser sends 2 to
3 second pieces, so text appears a few seconds behind. No two-way voice conversation yet." Build prompt `### Live`.

**Checks.** Fixed: at least two caption chunks with times came from the fake microphone; a change in one browser showed in a
second within 5 seconds with no reload. Judge: "Captions came from a sample recording. The screenshot captioned 'Second
browser' was taken without a reload." Smoke: at most 6 chunks.

**Owns.** `lib/caps/live/**`, `app/api/gateway/live/**`, `template/caps/live/**`, one line in `handler.ts`.

**Guards.** The microphone needs a click and the browser's own permission prompt. The product says audio goes to Muse Voice
Transcribe. Updates obey data's scopes: a ticket can only read what its holder could read.

## 14. Unit 8: media (E)

**Scope.** Open-weights speech in the browser (license checked first), video from image sequences with ffmpeg.wasm, music
as MIDI, and SAM tiling and chunking past 16 objects and long video.

**Migration.** None.

**Routes.** `GET {GATEWAY_URL}/assets/<sha256>`: a vetted large file (wasm, model weights) from the Blob mirror, listed in
`lib/caps/assets.json` (name, bytes, sha256, license, source). Public, immutable, `Access-Control-Allow-Origin: *`,
`Cross-Origin-Resource-Policy: cross-origin`, 120 a minute per IP. Unit 9 adds Pyodide's files to the same list. A file
small enough for the product's own deploy is served from there instead.

**Template.** Overlay `media`: `lib/platform/speech.ts` (`speak(text)` with the vetted model, falling back to the browser's
own speech), `lib/platform/video.ts` (`imagesToVideo(frames, { fps })` on single-thread ffmpeg.wasm, so it needs no
cross-origin isolation), `lib/platform/midi.ts` (`toMidi(notes)`, `playNotes(notes)`), `lib/platform/sam-tiles.ts`
(`findAll(image, phrase, { tiles })`, overlapping tiles merged by box overlap; `videoChunks(file)` under SAM's frame limit),
skill `muse-media`, `tests/caps/media.ts`, `scripts/caps/media.mjs`.

**Brief.** `media: { speech: boolean, video: boolean, music: boolean, samTiling: boolean }`. Catalog replaces the matching
"Not available on the Model API yet" workarounds for this brief: video from images, speech in the browser. Build prompt
`### Media in the browser`.

**Checks.** Fixed: a made video has a duration over 0 and plays in a `<video>`; a MIDI file starts with `MThd` and has notes;
speech produced audio; tiling ran on more than one tile and merged without duplicates (unit tests prove the merge; the
build only records counts). Judge: "Video and audio made in the browser may look and sound plain in this test." Smoke: at
most 4 SAM tiles.

**Owns.** `lib/caps/media/**`, `lib/caps/assets.json`, `app/api/gateway/assets/**`, `scripts/caps/mirror-assets.ts`,
`template/caps/media/**`.

**Guards.** Licenses before code: the speech model's license and whether it is Meta's, and ffmpeg's core build, which
bundles GPL codecs. Both go to the owner (section 21). SAM costs per frame with a minimum, so tiles and chunks are capped
and shown as a limit. Large files depend on unit 1's deploy fix or the assets route.

### 14a. As built (tg-cap-media, Nov 1)

Built on `tg-cap-int` at ead9ff0. Every flag is off, `CAP_READY.media` stays false, and there is no migration.

**Brief** (changed from the plan, by this unit). `media: { why (up to 200), speech, video, music, samTiling } | null`.
`why` was added, as the other caps have one. Each part has its own flag on top of `MEDIA_ENABLED` (`env.mediaParts`):
the writer's rules and the catalog name only the parts that are on (registry entries read when the text is built; the
catalog's cache key gains the parts), and `normalizeRawBrief` sets a part whose flag is off to false and makes a block
with no part left null. Build prompt `### Media in the browser` in 2.6's order, with a `- Media parts:` line the checker
reads. Catalog: while `speech` or `video` is on, its "Not available on the Model API yet" line is replaced through a new
registry, `CAP_WORKAROUNDS` in `lib/caps/catalog.ts`, and one marked edit in `lib/prompts/catalog.ts`.

**Licenses (decision 7).** No non-commercial model, no GPL code, no ffmpeg.

| Part | What | License |
|---|---|---|
| Speech model | microsoft/speecht5_tts, as Xenova/speecht5_tts 1723781b, int8 `encoder_model_quantized.onnx` (88.4 MB) and `decoder_model_merged_quantized.onnx` (71.1 MB) | MIT (Microsoft) |
| Vocoder | microsoft/speecht5_hifigan, as Xenova/speecht5_hifigan cf980c36, `model_quantized.onnx` (18.3 MB) | MIT (Microsoft) |
| Voice | x-vector `cmu_us_slt_arctic-wav-arctic_a0508` from Matthijs/cmu-arctic-xvectors 5c1297a9 (2 KB, inlined), from the CMU ARCTIC databases | MIT; CMU ARCTIC is free for any use |
| Runtime | onnxruntime-web 1.30.0 (Sep 14), `ort.wasm.bundle.min.mjs` and `ort-wasm-simd-threaded.wasm` (14.2 MB) | MIT (Microsoft) |
| Video, MIDI, pitch, tiles | written for Muse Muse: an MP4 writer, a MIDI writer and reader, YIN pitch finding, tiling and merging | ours |

Not Meta's: Meta's open speech models (MMS-TTS and the like) are CC-BY-NC, so decision 7 rules them out. Turned down:
Kokoro-82M (Apache 2.0 weights) because `kokoro-js` needs the `phonemizer` package, which is labeled Apache 2.0 but
bundles eSpeak NG (GPL-3.0) compiled to wasm (read from the package); ffmpeg.wasm (GPL core); `mp4-muxer` (MIT but
deprecated) and `mediabunny` (MPL-2.0), replaced by our own MP4 writer. The product ships `public/notices/media.txt`
with these and the MIT text, and the checker requires a link to it.

**Assets route.** `GET {GATEWAY_URL}/assets/<sha256>` (`lib/caps/media/assets.ts`, `app/api/gateway/assets/[sha256]`):
404 `unknown_endpoint` touching nothing unless a cap that lists files is on; only hashes in `lib/caps/assets.json` whose
cap is on (else 404 `asset_not_found`); GET, HEAD and OPTIONS; 120 a minute per address (`x-real-ip`, then
`x-forwarded-for`); `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`. On Vercel a 302 to
the Blob mirror (cached a day); on a local run it streams `.data/files/data/assets/<sha256>` when its size matches;
503 `asset_unavailable` when not mirrored. The list is checked at load: sha256, size, https source, a license from a
permissive list (MIT, Apache-2.0, BSD, ISC, MPL-2.0, CC0-1.0), each hash once. `scripts/caps/mirror-assets.ts` checks
every source (npm tarballs read in place) and with `--apply` uploads to Blob at `assets/<sha256>` and writes the URLs
into the list as `mirror`, or writes the local copies. `STORED_PREFIXES` gains `assets`. Unit 9 adds Pyodide's files
to the same list with `cap: "code"`.

**Build env and firewall.** A media brief's `.env.local` gets `NEXT_PUBLIC_MUSEMUSE_ASSETS_URL` (the gateway's
`/assets`) and `NEXT_PUBLIC_MUSEMUSE_MEDIA_SMOKE=1`; the deploy gets the first only. `CAP_BUILD_HOSTS.media` is the
mirror's Blob host, GET only (`CAP_HOST_METHODS`), so the test browser can follow the redirect; it is empty until the
files are mirrored, so today it adds nothing.

**Overlay `media`** (all platform files, no packages): `lib/platform/media-assets.ts` (`fetchAsset`: size and sha256
checked before use, kept in Cache Storage, `MediaError`), `speech.ts` (`speak`, `prepareSpeech`, `stopSpeech`; the
runtime is imported from a Blob URL of its checked bytes, one thread, no special headers; falls back to
`speechSynthesis` with a one-line note; tokenizer matches SpeechT5's own), `video.ts` (`imagesToVideo`: WebCodecs H.264
when the browser has it, else VP9, then `mp4.ts`; MediaRecorder in real time without WebCodecs), `mp4.ts` (`muxMp4`,
`readMp4Info`, index before data), `midi.ts` (`toMidi`, `parseMidi`, `playNotes`, `notesFromAudio`, `noteName`),
`sam-tiles.ts` (`tileGrid`, `mergeTileBoxes`, `runTiles`, `findAll`, `planVideoChunks`, `videoChunks`), `sam-boxes.ts`
(`samBoxes(request, tile, phrase)` on the server through `metaClient`), `public/notices/media.txt`,
`tests/caps/media.ts` (`expectVideoPlays`, `expectMidi`, `expectSpeech`, `expectTiles`, each saving the file it checked to
`test-results/caps/media/`), `scripts/caps/media.mjs`, skill `muse-media`.

**SAM and the daily budget.** A product's daily budget is at least $3 (`lib/gateway/policy.ts`). `findAll` starts with
4 tiles and splits a tile that comes back with 16 objects into 4 more only while calls are left, at most 16 a photo
(about $0.04); a full tile it can't split marks the count `capped` ("at least"). Seams: overlapping tiles (15%), and
boxes merge by IoU 0.5, by a piece cut at its tile's inner edge lying mostly inside another box, or by two pieces cut on
facing sides of a seam and lined up along it. `videoChunks` keeps 5 frames a second, chunks of at most 300 frames and
900 in all (about $0.18 a run, each chunk billed at least 50 frames), H.264 only since SAM rejects VP9. In a build's
test run `findAll` holds a page to 4 SAM calls in all, and the checker fails more than 4.

**Checks.** Fixed (`scripts/caps/media.mjs`), for the parts brief.md lists: `video` (the test saw the `<video>` play with
a duration over 0, and the saved MP4's own index has a duration and frames), `music` (the saved file starts with `MThd`
and has note-ons, read from its bytes), `speech` (speak answered with audio from the model or the browser's voice),
`tiles` (2 to 4 tiles, merged count at most the raw count); and `no-cdn` and `notices`. Judge note: "Video and audio made
in the browser may look and sound plain in this test", plus the "at least" line with tiling.

**Measured** (Nov 1, this laptop, no sandbox, no model API call, $0). Speech in Node on onnxruntime-web, one thread:
int8 3.7 s for 3.2 s of audio; the 4-bit files took 13.4 s for 4.8 s, so int8 was kept. In Playwright's Chromium:
opening the model 0.4 s, 1.9 s to make 1.95 s of audio; a first `speak()` 4.7 s including the 192 MB download from a
local server and playback, the second 1.9 s with nothing downloaded. Ten 320x240 frames at 5 a second: H.264 MP4 of
15,050 bytes (VP9 20,115), 2.0 s, plays in `<video>`, and ffprobe reads 10 frames and 2.0 s. Template tests: 24 pass
(the real-model one with `MEDIA_TEST_ASSETS_DIR`). Nobody has listened to the voice: the samples have speech-like
loudness over time, not a check that the words are clear.

**Not proven.**

- No real test build (section 22's slideshow-to-video maker, hummed melody to MIDI, crowd counter). A local run's sandbox
  can't reach the local gateway (8a), so the speech model can't load there; a credentialed run or a public
  `PLATFORM_URL` is needed. Spend so far: Meta $0, Vercel Sandbox $0.
- The files aren't mirrored: mirroring writes to the Blob store, which is the owner's call. Until then `/assets` answers
  503 and speech uses the browser's voice. The Blob mirror's CORS headers on the redirected response are untested.
- The build sandbox's Linux Chromium: whether it has an H.264 encoder (else VP9, which plays, but `videoChunks` throws)
  and any system voice (else, with no mirrored model, `expectSpeech` fails).
- `samBoxes` against the real SAM API, and `findAll`'s merge on real photos: unit tests with made-up boxes only.
- `next build` of a product with the overlay (the runtime's `import()` of a Blob URL carries `webpackIgnore` and
  `turbopackIgnore`), Safari and Firefox, phones, memory on a phone for a 190 MB model.

**Shared files this unit touched**, each small: the registries in `lib/caps/` (media lines, `CAP_WORKAROUNDS`, the
media hosts), `lib/env.ts` (its block), `.env.example`, `lib/brief/normalize.ts` and `lib/prompts/catalog.ts` (marked
blocks), `lib/local-files.ts` (`assets`), `lib/storage.ts` (a comment), `lib/brief/__tests__/flags-off.test.ts` (the part
flags) and `lib/gateway/__tests__/caps-off.test.ts` (the route). No golden changed. No `muse-device/` changes.

**For the owner.** (1) The speech model choice and its licenses above (decision 7's reading). (2) Mirroring about 192 MB
to the Blob store (`scripts/caps/mirror-assets.ts --apply`), which also opens that Blob host, GET only, to media builds.
(3) The three test builds, on a credentialed run, within $1.50 Meta and $0.75 Sandbox.

## 15. Unit 9: code (G)

**Scope.** Pyodide and QuickJS in the browser; `{GATEWAY_URL}/exec` in a no-network sandbox with short limits; browser
automation for a URL the user typed; Muse Code sessions, owner-only, as `~/mm-wt/_plan/muse-code-products.md` designs them
(the spike answered on Oct 31, $0.053).

**Migration 0024_code.** `exec_runs`: `id`, `product_id`, `kind` (`exec`, `browse`), `principal`, `subject_key`, `language`,
`status`, `ms`, `cost_usd`, `created_at`. `code_sessions` is General's (0016), not this unit's; it was: `id`, `product_id`, `sandbox_name`, `token_id`,
`status`, `cost_usd`, `started_at`, `ended_at`, `visitor_key`, `result_path`, `files`.

**Routes.**

| Method and path | Auth | Does | Limits | Spend |
|---|---|---|---|---|
| `POST {GATEWAY_URL}/exec` `{language: "python" \| "node", code, stdin?, files?}` | `cap:code`; owner or user, visitors only with `CODE_EXEC_VISITORS` | Runs in a fresh sandbox from `CODE_EXEC_SNAPSHOT_ID` with an empty allow list, 1 vCPU, 15 s | 64 KB code, 1 MB files, 64 KB output; 20 a day per person, 200 per product; 2 at once per product, 4 in all | reserve 15 s at the posted price, settle measured; `exec`; `CODE_EXEC_DAILY_USD` |
| `POST {GATEWAY_URL}/browse` `{url, input, actions?}` | `cap:code`; owner or user | Opens one URL that appears in `input` (the person's own words), in a sandbox whose firewall allows only that host; returns title, text and a screenshot (Blob, 24 hours) | 30 s; at most 5 click, type or wait actions; 5 a day per person, 50 per product; 2 at once in all | `browse`; `CODE_BROWSE_DAILY_USD` |
| `POST /code/sessions`, `GET /code/sessions/:id/events?after=`, `POST .../steer`, `POST .../stop`, `GET .../result` | as the design: token scope `code_session`, the owner pass | Muse Code in a session sandbox | $1 and 15 minutes a session; 2 per product, 8 in all | the product's Meta budget through `/v1/responses`; sandbox time as `code_session` |

`lib/caps/code/policy.ts` holds `execPolicy()` (allow nothing) and `browsePolicy(host)`. Browse refuses IP literals,
private addresses and password fields. The `code_session` scope, its model list (Contributor only under `TEST_MODEL`, Wonder
live, `muse-spark-1.3` refused) and its smaller assumed output go in `lib/gateway/{tokens,policy,estimate}.ts` and one
marked line in `handler.ts`.

**Template.** Overlay `code`: `lib/platform/pyodide.ts`, `lib/platform/quickjs.ts` (browser, npm packages, files served from
the product or `/assets`), `lib/platform/exec.ts`, `lib/platform/browse.ts` (server), `components/platform/CodeOutput.tsx`,
skill `muse-code-run`, `tests/caps/code.ts`, `scripts/caps/code.mjs`. Target overlay `template/targets/muse_code/` exactly as
the design lists: `lib/muse-code/client.ts` with replay mode, `app/api/muse-code/...`, `CodeRun`, skill
`muse-code-in-product`.

**Brief.** `code: { runtimes: ("pyodide" | "quickjs" | "exec")[], browse: boolean }`, and the `muse_code` target in
`TARGETS` with its `TARGET_GUIDE` entry (`lib/native/targets.ts`). Wording for Muse Code, from the design: "Runs Muse Code
in a private temporary workspace. It's deleted after 15 minutes, and your task is sent to Meta." Build prompt
`### Running code`.

**Checks.** Fixed: a fixture program's exact stdout came back from `/exec` and shows; Pyodide or QuickJS ran in the page; a
browse showed the recorded page's marker; a Muse Code session's result has files and shows its final text (an exit code
alone doesn't count, per the spike). Judge: "Pages opened in this test are samples." Smoke: 3 exec runs and 1 browse; Muse
Code as the design says.

**Owns.** `lib/caps/code/**`, `app/api/gateway/{exec,browse,code}/**`, `template/caps/code/**`, `template/targets/muse_code/**`,
the session sweep, the 0024 migration, its lines in the shared gateway files.

**Guards.** Exec has no network and no secrets. Browse reaches one host, only one the person typed, and never logs in. Muse
Code: Meta terms 1, 3.1, 6.2 and 10.1(i), the binary kept out of result zips (workspace only, no symlinks, no ELF files, sha
matches dropped, 50 MB), visitors off until the owner decides. The Acceptable Use Policy bars malware and unauthorized
scanning, and we answer for what we run. Needs a signed-in builder.

## 16. Unit 10: runtime (H)

**Scope.** Python functions in products, with PyPI open in the build firewall; a self-host kit output; VS Code extension and
GitHub Action outputs as source; npm publishing only after the owner confirms the name and the account.

**Migration.** None. An npm publish, if the owner allows one, is a build event.

**Firewall.** `CAP_BUILD_HOSTS.runtime = ["pypi.org", "files.pythonhosted.org"]`, GET only, in the same rule shape as
`api.meta.ai`'s (a GET match passes, then a 403). Only for a brief whose `runtime.python` is set.

**First hour.** Check whether Vercel serves `api/*.py` Python functions beside a Next.js app in one project, and how
`next start` can reach them in a build. If it can't, Python runs through unit 9's `/exec`, and `runtime.python` stays off.

**Routes.** `GET /p/<slug>/get/selfhost.zip` (cloud mode now; the kit's manifest has a `mode` field, with "offline" reserved for General's offline install after Nov 4), `GET /p/<slug>/get/vscode.zip`, `GET /p/<slug>/get/github-action.zip`, made
from the product's source and `musemuse.json` the way tg-outputs makes the CLI and skill. `POST
/api/products/<slug>/publish/npm` (the builder, then an admin, with `RUNTIME_NPM_PUBLISH`).

**Template.** Overlay `runtime`: `scripts/py-local.mjs` (runs `api/*.py` locally for tests), skill `muse-python`,
`tests/caps/runtime.ts`, `scripts/caps/runtime.mjs`. The outputs are generated by the platform, not written by Muse Code.

**Brief.** `runtime: { python: { why } | null, outputs: ("self_host" | "vscode" | "github_action")[] }`. Build prompt
`### Python and outputs`, which also says the build machine can reach PyPI for this brief.

**Checks.** Fixed: a Python function answered its action through the local runner, and through the live URL in unit 2's live
check; `npx @vscode/vsce package --no-dependencies` makes a `.vsix`; `action.yml` validates; the self-host kit builds with
a placeholder key. Judge: none. Smoke: one Python action.

**Owns.** `lib/caps/runtime/**`, `lib/outputs/{selfhost,vscode,github-action}.ts`, the three get routes, its
`CAP_BUILD_HOSTS` line, its `lib/native/targets.ts` and Get it entries, `template/caps/runtime/**`.

**Guards.** The self-host kit runs on the self-hoster's own Meta key and never carries a product token, the gateway URL,
`MODEL_API_KEY` or Muse Code's binary (Meta 3.1 bars sharing a key). Nothing is published anywhere without the owner.
Needs a signed-in builder.

### 16a. As built (tg-cap-runtime, Oct 31)

Built on `tg-cap-int` at 9a1d7dd (wave 2, the UI brand and units 0, 2 and 12). Every flag is off, `CAP_READY.runtime`
stays false, and no migration was needed.

**The first hour's question.** Vercel's own docs (read Oct 31, last updated Aug 2026) still serve file-based Python
functions from `/api`: each `.py` file is a function at its own path, with `class handler(BaseHTTPRequestHandler)`, `app`
or `application`, packages from `requirements.txt`, Python 3.12 by default and 3.13 or 3.14 through `.python-version`.
For new projects that mix Python with another framework they point to Services, which is in Beta. A Python framework in
`requirements.txt` (Flask, FastAPI, Django) makes Vercel run the whole project as that app. So products use file-based
functions at `api/py/<name>.py`, next to the Next.js app, with no web framework, and `next start` can't serve them: in a
build the product's server runs them on the build machine through the local runner. That this works on a real deploy is
not proven: local runs never publish (decision 6), and this unit made no deploy. The live check below tests it on the
first deploy of a Python product. If Vercel doesn't build `api/py/*.py` beside a Next.js project created with
`framework: "nextjs"`, the fallback is Services or unit 9's `/exec`, and `runtime` stays off.

**Brief** (changed from the plan, by this unit). `runtime: { why, functions: [{ name, does }] (1 to 4), packages: PyPI
names (up to 8) } | null`. Outputs aren't in the brief: the platform makes them for every live product (below), so the
writer never has to pick them, and a block with only outputs would have put a product through the caps step with nothing
to check. `normalizeRawBrief` cleans the block in a marked block (snake case names once each, `musemuse_health` taken,
versions, markers and web frameworks dropped from packages, null with no function). Writer rules: only for work Python's
libraries do best, JSON in and out under 10 seconds, no web framework, and Python never calls a model or another service.
Catalog: `runtime (Python functions)`. Build prompt `### Python functions`, in the order 2.6 gives, naming the
`template/AGENTS.md` line about npm, Meta and the gateway that doesn't hold for this brief. Judge: none.

**Firewall.** `CAP_BUILD_HOSTS.runtime = ["pypi.org", "files.pythonhosted.org"]`. `CAP_HOST_METHODS` (also in
`lib/caps/hosts.ts`) limits both to GET, which `capHostRules` in `lib/sandbox/policy.ts` writes in api.meta.ai's shape:
a GET match whose transform pins the `Host` header to the allowed host (Vercel's firewall docs advise it against domain
fronting, and PyPI sits behind a shared CDN), then the firewall's own 403. A host with no method list is allowed with no
rules, as before.

**Overlay** `template/caps/runtime`, every file but `requirements.txt` a platform file:

- **What a Python endpoint is.** `/api/py/<name>` is a public address: anyone can POST to it without the TypeScript
  action's checks. On Vercel the function also runs with the deployment's env, `PRODUCT_TOKEN` and `GATEWAY_URL`
  included, since project env vars reach every function. So every function starts with the platform's guard (in the
  skill, and written by `py-local.mjs new <name>`): at import it removes `PRODUCT_TOKEN`, `GATEWAY_URL` and
  `VERCEL_OIDC_TOKEN` from `os.environ`, and its `parse_request` answers 403 to any call without `X-MuseMuse-Python`,
  an HMAC-SHA256 of `"musemuse-python-v1"` keyed with `PRODUCT_TOKEN` that `callPython` sends. A function also checks
  its own input, and never reads input text as code (no `eval`, `exec`, `pickle`, `yaml.load`, pandas `eval` or
  `query`, `sympify`, `parse_expr`, and no input string passed to sympy). Limits, honestly: removing a variable from
  `os.environ` stops ordinary code reading it, not code that reads `/proc/self/environ`; the header stops direct calls,
  not a product whose own action passes a visitor's text to something unsafe, which the `safe` check catches only when
  it is written plainly. With no `PRODUCT_TOKEN` (the local runner, a kit run off Vercel) the guard lets every call
  through, and those machines serve on 127.0.0.1 only.
- `lib/platform/python.ts`: `callPython(request, name, input)`. On Vercel it POSTs to the deployment's own
  `/api/py/<name>` with the guard's header; with `MUSEMUSE_PYTHON_URL` to that address; anywhere else, and in every
  build (`MUSEMUSE_PYTHON=local`, from `CAP_ENV.runtime`), it runs the file through the runner. Only in a build
  (`MUSEMUSE_PYTHON_NOTES=1`, also from `CAP_ENV.runtime`) each call that answered is noted in
  `test-results/caps/runtime-calls.jsonl`, whatever its size: name, bytes, sha256 and the reply's shape, and the input
  itself only up to 64 KB (`LOG_MAX_INPUT_BYTES`). A deployed or self-hosted product notes nothing. Throws `CapError
  {code, status, message}` in plain words.
- `scripts/py-local.mjs`: runs one `handler` class the way an HTTP server would, through a socket made of buffers,
  standard library only, with a 10 second limit, 4.5 MB each way, and none of the server's env. On a build the
  product's folder, `.env.local` with the build token included, is still on disk beside it; the runner adds a Python
  audit hook that refuses to open any `.env*` file, which stops ordinary code, and is not a sandbox. `install` puts
  pinned wheels from PyPI in `~/.cache/musemuse/python/<python>-<hash>`, never in the product folder, so nothing large
  is deployed. pip writes into a folder of its own that is renamed into place when it finishes. When a Python has no
  pip, `install` bootstraps it from its PyPI wheel; the sha256 it checks comes from the same PyPI reply, so it is a
  transfer check only. A call never installs: with packages that aren't installed it fails at once, saying to run
  `install` (`serve` installs before it listens). `doctor`, `new`, `call` and `serve` for Muse Code and for `next dev`.
- `api/py/musemuse_health.py` (GET `{"ok": true, "python"}`), `vercel.json` (only `functions["api/py/*.py"]`:
  `maxDuration` 10 and `excludeFiles` for node_modules, .next and the app's own folders; the health function makes sure
  the pattern always matches), `.python-version` (3.14, the builder snapshot's Python), `requirements.txt` (a comment).
- `tests/caps/runtime.ts` (`expectPythonAction(request, action, input)` records `python-action` only when the call log
  grew during the call), `scripts/caps/runtime.mjs` and the `muse-python` skill.

**Fixed checks** (`scripts/caps/runtime.mjs`, run from `CAPS_DIR` with the platform's own runner beside it): `python`
(a Python runs, and its minor version is the one `.python-version` gives Vercel), `requirements` (every line
`name==version`, no web framework), `size` (the installed packages take at most 450 MB of Vercel's 500 MB for one
Python function, uncompressed, from its Python runtime docs read Oct 31; every function deploys with all of
`requirements.txt`), `functions` (every `api/py/*.py` loads and has the handler class, and there is at least one
besides the health function), `safe` (an `ast` scan of each function for `eval`, `exec`, `compile`, `__import__`,
`sympify`, `parse_expr`, `.eval`, `.query`, `read_pickle`, `yaml.load`, `allow_pickle=True`, `os.system` and the like,
and imports of `pickle`, `marshal`, `dill`, `shelve`, `joblib`, `subprocess`, `ctypes`, `numexpr`), `guard` (each
function, loaded with a stand-in token made for the check, clears it from `os.environ`, answers 403 to a call without
the header and answers one with it), `health`, `python-action` (from the smoke test's record), `rerun` (the platform
runs each function the smoke test used again on the same input and the reply has the same shape; when every noted
call was over 64 KB, it passes saying none was kept to run again). None needs the gateway's record, so they can pass
on a local run.

**What the checks rest on** (contract 2.8 asks for checks the product can't fake, and these aren't all that):
`python-action` reads the smoke test's record, which a product test can write with `recordCapCheck`, and `rerun` reads
the call log, which the product's own server process appends to. The log is read before any of the product's Python
runs in the checks, so a function's top-level code can't plant lines, and `rerun` makes a real function answer with
the shape the log claims. Nothing registers with `/caps/proof`, because Python calls never reach the gateway. A
per-verify nonce in the server's env would stop a product test, not the product's server, from writing notes; it needs
unit 2's verify and Playwright files, so it isn't built. Once a public host exists, the live check can call one Python
action itself.

**Live check.** `lib/caps/live.ts`, `CAP_LIVE_PATHS`: routes a cap adds to unit 2's live check, each GET must answer 200
with `{"ok": true}`. Runtime adds `/api/py/musemuse_health`, failing as "its Python functions don't run on the live link".
`liveCheckStep` passes them only when there are some, so a product without them gets exactly today's check.

**Outputs** (`RUNTIME_OUTPUTS`, off). Not `PRODUCT_OUTPUTS`, so Prove it doesn't run them. With the flag off, all
three paths answer exactly what `/p/[slug]/get/[kind]` answered them before (404, "There's no download by that name."). `RUNTIME_OUTPUTS` in
`lib/native/targets.ts`, Get it tabs "VS Code", "GitHub Action" and "Self-host" after the product outputs.

- `GET /p/<slug>/get/vscode.zip` (`lib/outputs/vscode.ts`): a VS Code extension, for any live product with public actions.
  Fixed code (`lib/outputs/runtime-assets/vscode-extension.cjs`) reads `product.json`; each public action is a command
  that asks for its fields (the editor's selection in the first text field), POSTs to the live action and opens the reply
  as JSON; a `baseUrl` setting points it at a self-hosted copy, with `scope: "application"` so a repository's
  `.vscode/settings.json` can't send the selected text elsewhere. `publisher: "local"`, `engines.vscode ^1.90.0`. Packaging:
  `npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license` (no repository or license is
  chosen for the builder).
- `GET /p/<slug>/get/github-action.zip` (`lib/outputs/github-action.ts`): a JavaScript action on `node24` with inputs
  `action`, `input` (JSON), `base-url`, `timeout-seconds` and outputs `result` and `ok`, to unzip into
  `.github/actions/<slug>/`. Every value in `action.yml` is a JSON string, which YAML reads the same way, and
  `actionMetadataProblems` checks GitHub's metadata rules. GitHub evaluates `${{ }}` in `with:` values and input
  defaults, so the README's workflow leaves out an example that holds `${{`, and the builder's words in `action.yml`
  have it broken apart (`$ {{`).
- `GET /p/<slug>/get/selfhost.zip` (`lib/outputs/selfhost.ts`, `runtime-serve.ts`): the cloud kit, **for the product's
  owner only** (canActAsOwner; 403 for anyone else), since it is the product's whole source and its owner decides who
  gets it. Its files are the live deployment's own, read back from Vercel (`/v13/deployments/<live host>`, which must be
  the product's project, then `/v6/deployments/<id>/files` and `/v8/.../files/<uid>`, each file checked against its
  SHA-1), at most 600 files and 24 MB, 6 kits an hour per product. Left out: env files, `.mcp.json`, brief.md, AGENTS.md,
  BUILD_NOTES.md, `.agents/`, `tests/`, `fixtures/` (a person's own samples can be there), `inspo/`, platform scripts
  but the Python runner, Playwright's config, executables (ELF, Mach-O, PE). Anything shaped like a Muse Muse token stops
  the kit. Public files over 512 KB stay on the live product and `scripts/kit-fetch.mjs` downloads them, checking each
  sha256. Every file the kit keeps is scanned for a token, whatever its name or extension. Kits are counted per hour:
  6 per product, 12 per owner across products, 60 for the site (`reserveKit`, giving back what a refused kit took). The
  route refuses a request whose `Sec-Fetch-Site` is anything but `same-origin` or `none`, so a page on another site
  can't start one on the owner's cookie, and its HEAD counts nothing and reads nothing. Added: `.env.example`
  (`PRODUCT_TOKEN=` for the owner's own Meta key and `GATEWAY_URL=https://api.meta.ai`,
  which the template's `gatewayEnv()` turns into `https://api.meta.ai/v1`, so the product's code is unchanged),
  `README-SELF-HOST.md` (how to run it, `npx vercel deploy --prod` since a protected preview turns away the product's
  calls to its own Python functions, and what doesn't work without Muse Muse: big uploads, the gadget, Glimmer, agent
  tools and platform services, read from the source), and `musemuse-kit.json` (`kit: 1`, `mode: "cloud"`, every file's
  sha256; `"offline"` is reserved and the generator refuses it). A kit over 4 MB answers 413 with a plain message.
- **npm.** Decision 9: no publish route and no `RUNTIME_NPM_PUBLISH` flag. The extension, the action and the kit are
  ready to publish, and nothing publishes them.

**Shared files this unit touched**, each small: `lib/sandbox/policy.ts` (`capHostRules` for cap hosts),
`lib/engine/live-check.ts` and `lib/pipeline/build-steps.ts` `liveCheckStep` (`capPaths`, marked), `lib/brief/normalize.ts`
(marked block), `lib/native/targets.ts` and `components/product/GetItPanel.tsx` (its own entries),
`app/p/[slug]/page.tsx` (one line), `lib/env.ts` and `.env.example` (its block), the registries, and two assertions
in the flags-off tests that were written while no cap had a brief block (`Object.keys(CAP_BRIEF_FIELDS)` was `[]`; the
stored schema lists cap blocks before milestones). No golden file changed.

**Measured.** A sandbox probe on the current builder snapshot (Oct 31, one sandbox, 2 vCPUs, 12 seconds, no model call):
python3 is 3.14.4 with pip 25.1.1 and the firewall's CA in `PIP_CERT`; `numpy==2.3.4` installed through the GET-only rule
in 2.8 s; a function using it answered through the runner; all six checks passed against a recorded call; a POST to
pypi.org and a PUT to files.pythonhosted.org got the firewall's 403; upload.pypi.org wasn't reachable. Spend: Meta $0,
Vercel Sandbox under $0.01.

**Not proven.**

- No real test build. A local site build needs a fresh `VERCEL_OIDC_TOKEN`; `vercel env pull` into a private temp file
  was refused by this session's permission checks, and the unit didn't work around it. So no brief writer, Muse Code round,
  `next build` with `api/py/` beside it, Playwright smoke with `expectPythonAction` or verify caps step has run for real,
  and the self-host kit's build with a placeholder key and `vsce package` haven't run either.
- Python functions on a Vercel deployment (the first hour's question), and so the live check's Python route.
- The Vercel deployment files API: the reply format of `/v8/.../files/<uid>` (both readings are tried and the SHA-1
  decides), that a file's `uid` is its SHA-1, and whether the tree sits under `src/` (both are handled).
- The GitHub Action on a real runner, and the extension in a real VS Code (both ran here against a local server, the
  extension with a stand-in for VS Code's API). The review of d35ef4a packaged the extension with
  `@vscode/vsce@3.6.0 package --no-dependencies --allow-missing-repository --skip-license`: 6 files, 5.45 KB, named as
  `vsixFileName` says.
- The guard on Vercel: that a `handler` subclassing a class from the same file loads, that `parse_request` runs before
  dispatch there as it does under `http.server`, and that the request's headers reach it. The local runner proves it
  under the standard library's own server classes only.

**For unit 2.** A stored brief with a `runtime` block gets the overlay, PyPI and the build env even with
`RUNTIME_ENABLED` off and `CAP_READY.runtime` false: `briefCaps` reads only the brief, and an admin bundle import
(`lib/promote/bundle.ts`) stores a brief's blocks as they came. Before this unit no cap had a brief block, so it couldn't
happen. The fix belongs in unit 2's files: filter `briefCaps` (or `capsFileFor`, `capBuildHosts`, `capBuildEnv` and the
render) by `env.enabledCaps` at provision and refine, or drop off caps' blocks on import. Not changed here, since every
cap's tests and the flags-off goldens run through `briefCaps`.

**For General.** `applyCaps` in `lib/sandbox/builder.ts` checks only core's marker, so on a snapshot made with core
before `template/caps/runtime` existed, a runtime brief fails at `applyCapsScript` ("the runtime cap overlay isn't in this
sandbox") on the live site. The next `npm run snapshot` must include it. `.python-version` follows the snapshot's Python
(3.14 today): a snapshot with another Python fails the `python` check on purpose until the file changes with it.

**For the owner.** Allow one credentialed local run (`vercel env pull` to a private temp file) for this unit's test
build, or run it yourself; a preview or production deploy of one Python product to answer the Vercel question; whether
the self-host kit stays owner-only; and decision 9 stands until you confirm a name and an account. No `muse-device/`
changes.

## 17. Unit 11: gpu (I)

**Scope.** One shared Glimmer endpoint behind the gateway (off by default, demo windows, a daily GPU cap), and per-product
"train on my data" after ship, on the existing lab and its caps. Meta's open models only.

**Migration 0025_gpu.** `glimmer_windows`: `id`, `starts_at`, `ends_at`, `created_by`, `cap_usd`, `status`, `cost_usd`,
`created_at`. `training_jobs.product_id` uuid null, references `products`.

**Routes.**

| Method and path | Auth | Does | Limits |
|---|---|---|---|
| `POST {GATEWAY_URL}/glimmer/v1/chat/completions` | a live token with the `glimmer` marker | Forwards to `GLIMMER_ENDPOINT_URL` during an open window | 200 a day per product, 10 a minute per IP |
| `POST /api/admin/glimmer/windows`, `DELETE ...` | admin | Opens or closes a window; starting the endpoint uses `lib/train/serve.ts` | `GPU_GLIMMER_DAILY_USD` |
| `POST /api/products/<slug>/train` `{collections, recipe}` | the product's signed-in builder | Builds a dataset from owner and shared rows (`lib/train/datasets.ts`), starts a lab job with today's caps (`TRAIN_JOB_MAX_USD`, `TRAIN_DAILY_USD`), sets `product_id` | one at a time |

Spend: a window's GPU hours are reserved when it opens, at the instance's price, and settled when it closes, as
`glimmer` usage. Requests count as units. Outside a window the route answers 503 `glimmer_closed`, and the product shows its
offline message.

**Template.** No overlay. When the brief picks `muse-glimmer` and `GPU_GLIMMER_SHARED` is on, `allowedModelsFor` keeps a
`glimmer` marker, and `capDeployEnv` sets the existing helper's own variables (`template/lib/meta/glimmer.ts`):
`GLIMMER_URL={GATEWAY_URL}/glimmer/v1`, `GLIMMER_API_KEY=<live token>`, `GLIMMER_MODEL=muse-glimmer`.

**Brief.** No field. The catalog's `muse-glimmer` line (`catalog.ts:101`), through unit 11's catalog entry when the flag is
on: "Reachable through Muse Muse only during demo windows. Outside them the product must say so and offer the hosted
model."

**Checks.** Build tokens get canned Glimmer replies; fixed check: the reply shows, and a closed window shows the offline
message. Judge: "Glimmer's answers in this test are samples."

**Owns.** `lib/caps/gpu/**`, `app/api/gateway/glimmer/**`, `app/api/admin/glimmer/**`, `app/api/products/[slug]/train`, the
0025 migration.

**Guards.** Off by default. No Glimmer on the laptop, ever. Demo windows only, under the daily cap. Training uses only owner
and shared rows, never visitor or user rows. Meta's open-model license and Acceptable Use Policy pass down to every product.
Reuse existing tuned models before any new GPU run.

**Who may train (owner, Oct 31 21:15; agreed with General).**
- Hosted Glimmer runs in demo windows only: one 30-minute window on Nov 3, plus any window an admin opens, under
  `GPU_GLIMMER_DAILY_USD` $15.
- Visitors can fine-tune from day one at General's `/fine-tuning`, behind `PUBLIC_TRAINING`. They need no sign-in: the
  platform's builder sign-in needs the shared access code (decision 3), which visitors don't have.
- A visitor's identity is General's signed `mm_trainer` cookie.
  - A signed-in builder (`builderTier` gives admin or builder) trains as their user id instead. Runs made under their
    cookie move to that id when they sign in.
  - A banned user (a session with `bannedAt`) is refused.
- Visitor limits:
  - one run a day per trainer, and also per IP, since a cookie can be cleared
  - 60 minutes or $4 a run
  - $15 a day across all visitors
  - nothing published without an admin
- Visitors train on the lab's ready datasets or their own rows, never on Wonder-written data.
- This is not a trust exception: GPUs aren't a cap, and trust leaves the GPU tier check to this unit (section 7).
- A product's own training stays with the product's signed-in builder. That covers `POST /api/products/<slug>/train`, and
  a brief that asks for its own tuned model under General's `TUNE_FROM_BUILDS`.
- The guest writer rule (`GUEST_WRITER_RULE`) is unchanged.

## 18. Unit 12: drive export (owner ask)

The detailed design is `docs/DRIVE_EXPORT.md` (committed 62a5a06). This section only fixes how it meets the rest of
wave 3. Where the two differ, change one of them on purpose, in the same commit.

- **Flags:** `DRIVE_EXPORT_ENABLED` (the `/device` card and the admin routes) and `DRIVE_EXPORT_PRODUCTS` (the product gadget
  tools), both off.
- **Migration:** none. An export's state lives on the board, as a training run's does.
- **Routes:** `app/api/device/drive/route.ts` (`GET` status and URL refresh, `POST` start or arm, `DELETE` stop) and
  `app/api/device/drive/erase/route.ts`, all `requireAdmin`, as that doc says. No gateway route until unit 13. The generic
  admin route `/api/device` lists and calls none of the five drive tools, flag off or on (`lib/device/drive-tools.ts`, 1.6).
- **Board tools** (`muse-device/server.py`, with the work in a new `muse-device/drive.py`, standard library only, for Hussam):
  `drive_status` (with the board's finished runs), `export_source`, `export_model`, `erase_drive`, `stop_export`. The same
  layout as `lib/drive/image.ts`, through the shared plan in `lib/drive/plan.ts`. Every sha256 is read back from the drive.
  exFAT when a file is 4 GiB or more. Sync, unmount, power off, and the card says "Safe to unplug". Built on `tg-cap-drive`,
  not deployed; `docs/DRIVE_EXPORT.md` "Built" has the tests and what isn't proven.
- **Sources:** a board run (`~/models`) or a lab model (`localFilesFor`), pulled by a signed, hash-checked URL. No new GPU
  run.
- **Product tools** (`drive_status`, `export_to_drive`) wait for unit 13's registry and owner check, and for unit 11's
  "train on my data".
- **Build stand-in:** a simulated board whose export ends in PASS (`lib/device/drive-sim.ts`), wired in with the product tools.
- **Test:** Python tests with fake drives, a Linux loopback image, then the real test with a drive the owner plugs in.
  Board deploys go through Hussam or a fleet job with the owner's OK, never SSH from the laptop.
- **Owns:** everything that doc lists, plus its lines in `lib/env.ts` and `.env.example`.

## 19. Unit 13: hardware (J)

**Scope.** A Web Serial, WebUSB and Web Bluetooth helper with a simulated port; read-only sensor and `show_text` board tools;
a per-owner board registry and an owner check on the gadget route, which closes the release review's high finding (today
every guest-built live product with the gadget option reaches the one real board).

**Migration 0026_hardware.** One shared `devices` table, also used by offline (General's tg-offline, docs/OFFLINE.md
dd1602f), which adopts it when it merges. `devices`: `id`, `owner_user_id`, `name`, `kind` (`muse_device`, `inference`),
`mcp_url_ciphertext` null, `token_ciphertext` null, `endpoint_url_ciphertext` null, `iv`, `tag`, `key_version`, `models`
jsonb (filled by a probe that really calls the model and records JSON-schema support and vision), `lan` boolean, `trust`
(`loopback`, `pinned_tls`, `plain_http_opt_in`), `cert_spki_sha256` null, `pair_code_hash` null, `paired_at` null,
`allow_plain_http` boolean default false, `health` jsonb (last status, failures, median latency), `created_at`,
`last_seen_at`, `revoked_at`. `product_boards`: `product_id` primary, `board_id` (references `devices`), `visitors` boolean
default false, `created_at`. Unit 13 uses `kind = muse_device` rows. Pairing (8-character one-time code plus a 6-digit check
number on both screens, then SPKI pinning) is offline's and lands after Nov 4; until then, admins register boards by URL
and token as below, and offline's branch keeps a copy of the same shape so the two don't drift.

**Routes.**

| Method and path | Auth | Does |
|---|---|---|
| `POST /api/boards` `{name, mcpUrl, token}`, `GET /api/boards`, `DELETE /api/boards/<id>` | signed-in builder | Registers a `muse-device` board (a `devices` row with `kind = muse_device`), encrypted with `lib/secrets/box.ts` (unit 5). Checks it with `describe_device` first |
| `POST /api/products/<slug>/board` `{boardId, visitors}` | the product's builder | Links one of their boards to one of their products |
| `GET` and `POST {GATEWAY_URL}/gadget` (existing) | as today, plus the owner check | With `HARDWARE_GADGET_OWNER_CHECK`, a live token reaches only the board its product's owner linked, and a visitor only when `visitors` is on. Otherwise 503 `gadget_offline` |

`PRODUCT_GADGET_TOOLS` gains `read_sensor` (read only) and `show_text` (up to 200 characters, 6 a minute) with
`HARDWARE_BOARD_TOOLS`. The build's simulated gadget answers both. `muse-device/server.py` gains the two tools, small, for
Hussam.

**Template.** Overlay `hardware`: `lib/platform/hardware.ts` (`connectSerial`, `connectUsb`, `connectBluetooth` with feature
checks and a plain message where the browser can't), `components/platform/ConnectDevice.tsx`, skill `muse-hardware`,
`tests/caps/hardware.ts` (a fake `navigator.serial`, `usb` and `bluetooth` injected with `addInitScript`),
`scripts/caps/hardware.mjs`.

**Brief.** `hardware: { links: ("serial" | "usb" | "bluetooth")[], boardTools: boolean, why }`. Catalog: "Browser links work
in Chrome and Edge on a computer or Android, after a click. Not in Safari or on iPhone." Build prompt `### Devices`.

**Checks.** Fixed: the simulated port got the bytes the product sent, and the product showed the reply; a board tool call
reached the simulator. Judge: "Device readings in this test come from a simulated device." Smoke: one link session.

**Owns.** `lib/caps/hardware/**`, `app/api/boards/**`, `app/api/products/[slug]/board`, its changes to
`lib/gateway/gadget.ts` and its simulator, `template/caps/hardware/**`, the 0026 migration, the two board tools.

**Guards.** These are `muse-device` board tokens for the owner's own boards. The registry never takes a Gadget SDK token,
and its form says so. Never `run_command`. Turn on the owner check before `DEVICE_MCP_URL` reaches production. Needs a
signed-in builder.

## 20. Unit 14: native (K)

**Scope.** A browser extension output (Manifest V3, Load unpacked, a Playwright check); the shell bridge gains notifications
and Bluetooth LE once the AWS Mac checks pass; browser game engines (Phaser, Babylon) as skills.

**Migration.** None. The extension zip is stored at `extensions/<productId>/latest.zip`.

**Routes.** `GET /p/<slug>/get/extension` (the zip) and a Get it slot `extension` with "Load unpacked" steps, beside
tg-outputs' outputs.

**Template.** Overlay `extension`: `extension/manifest.json`, `extension/popup.html`, `extension/popup.ts`,
`extension/background.ts`, skill `muse-extension`, `tests/caps/extension.ts` (a persistent Chromium context with
`--load-extension`), `scripts/caps/extension.mjs`, `scripts/caps/extension.browser.json`. The popup calls only the
product's own action routes. Overlays `games-phaser` and `games-babylon`: the engine at an exact version in `deps.json`,
skills `muse-phaser` and `muse-babylon`, `tests/caps/games.ts`.

**Brief.** `extension: { does, permissions: ("activeTab" | "storage" | "contextMenus" | "sidePanel")[] } | null` and
`gameEngine: "phaser" | "babylon" | null`. Build prompt `### Browser extension` and `### Game engine`.

**Bridge.** Notifications and BLE in tg-shells2's bridge (`lib/native/bridge.ts`), only after General's AWS Mac checks pass,
behind `NATIVE_BRIDGE_NOTIFY` and `NATIVE_BRIDGE_BLE`. Until then this part stays unbuilt.

**Checks.** Fixed: the extension loaded with no manifest errors, its popup rendered, and one action call returned; a game
canvas isn't blank and changes after one key press. Judge: "The extension popup was opened in a test browser. Game
screenshots come from software rendering, so plain lighting and jagged edges are expected."

**Owns.** `lib/caps/{extension,games}/**`, `template/caps/{extension,games-phaser,games-babylon}/**`, the get route, its
`lib/native/targets.ts` and Get it entries, the bridge parts.

**Guards.** Least permissions: never `<all_urls>`, no remote code (Manifest V3 bars it), host permission for the product's
own origin only. Nothing goes to a store: Load unpacked only. Phaser and Babylon licenses (MIT, Apache 2.0) go in the
product's notices.

### 20a. As built (tg-cap-native, Oct 31)

Built on `tg-cap-int` at 247ea04 (wave 2, the UI brand, units 0, 2, 10 and 12). Every flag is off, `CAP_READY.extension`
and `CAP_READY.games` stay false, and no migration was needed. The shell bridge (notifications, Bluetooth LE) is not
built: it waits for General's AWS Mac checks, so `NATIVE_BRIDGE_NOTIFY` and `NATIVE_BRIDGE_BLE` aren't in `lib/env.ts` yet.

**Brief** (changed from the plan, by this unit). `extension: { does (up to 300), permissions: ("activeTab" | "storage" |
"contextMenus" | "sidePanel")[] } | null`, as planned. The game engine's key is `games`, not `gameEngine`, since 8a keys
a cap's block by its id: `games: { engine: "phaser" | "babylon", why (up to 200), controls (up to 200) } | null`.
`normalizeRawBrief` cleans both in a marked block: permissions in Chrome's spelling, each once, in manifest order, broad
ones dropped; engine names like "Babylon.js" become `babylon`; any other engine, or a brief with the `vr` target, makes
`games` null (VR has its own 3D stack, which no wave 3 unit edits). Writer rules, catalog entries ("a browser extension",
"game engines (Phaser for 2D, Babylon.js for 3D)"), build prompt sections `### Browser extension` and `### Game engine`
in the order 2.6 gives, refine lines, markdown, and one judge note each.

**Extension, in the build.** Overlay `extension`: `extension/manifest.json`, `popup.html`, `popup.ts`, `popup.css`
(the product's tokens), `background.ts` as starting points; platform files `extension/platform.ts` (`productAction`,
`currentPage`, `ProductError`), `extension/config.d.ts` (the shape of the platform's `config.js`, and the reference that
brings in `@types/chrome`: this TypeScript, 6.0.3, includes no `@types` package on its own, measured),
`scripts/extension-pack.mjs`, `scripts/caps/extension.mjs`, `tests/caps/extension.ts`, skill `muse-extension`.
`deps.json` adds `@types/chrome` 0.3.5 (dev). Each `.ts` file is compiled on its own with the product's TypeScript
(`transpileModule`), so no bundler and no packages, and imports end in `.js`. The packer checks what the platform will:
the manifest keys it allows (refusing `host_permissions`, `content_scripts`, `content_security_policy`,
`web_accessible_resources`, `externally_connectable`, `key` and others by name), only the four permissions and only
those brief.md's `- Permissions:` line lists, Manifest V3 with a module service worker, and a file scan (no `eval`,
`new Function`, `import()`, `importScripts`, inline scripts or `on*=` handlers, scripts or styles from other sites,
frames, `chrome.scripting`, `chrome.tabs.captureVisibleTab` and the capture APIs, bare imports, and no `fetch`,
`XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon` outside `platform.js`). The scan reads text, so it catches
plain cases; the browser's policy below is the real guard for the network. Nothing but the scan stops a screenshot of
the visible tab, which `activeTab` allows, so the copy's "can't read pages" rests on it. Paths: plain names, no segment
starting with `.` or `_` (Chrome keeps `_` names), and, on both sides (`pathClashes`), no two names that differ only in
capital letters, no name that is the platform's `manifest.json` or `config.js` in other letters, and no folder named like
a file. The sandbox's disk tells case apart, but macOS and Windows disks don't, and there `MANIFEST.JSON` replaced the
platform's manifest on unzip (the review's probe).

**Extension, the policy.** The platform writes the manifest's `host_permissions` (the product's own origin only) and
`content_security_policy.extension_pages`: `default-src 'self'; script-src 'self'; object-src 'self'; img-src 'self'
data: blob: <origin>; connect-src <origin>; frame-src 'none'; form-action 'none'; base-uri 'none'`. Measured in Chromium
143: Chrome accepts it, a `fetch` to another origin fails from the popup and from the service worker, while the product's
own action answers, and an image, a CSS background and a font from another origin never reach it (with the earlier
policy, which had no `default-src`, all three did). A policy can't stop navigation (`chrome.tabs.create`,
`window.open`), which opens a page the person sees.

**Extension, the checks.** Fixed (`scripts/caps/extension.mjs`): `manifest` (the packer's rules on the product's files
as they are), `loaded` and `popup` (the platform builds the extension pointed at a closed port, loads it into its own
Chromium with `--load-extension`, waits for the service worker and opens the popup, which must render with no script
error and no product behind it), and `action`. Compiling needs TypeScript and loading needs Playwright, and the only
copies in a build are the product's. So the checker runs the CAPS_DIR packer (`check --root`) and loader
(`scripts/caps/extension-load.mjs`) as child processes and reads only their exit code and last JSON line: nothing from
the product's node_modules runs in the caps check's process, so it can't change another cap's checks (the review's
probe did, with a TypeScript shim). A product that rewrote its own TypeScript or Playwright can still fake its own
`manifest`, `loaded` and `popup`; what ships doesn't rest on them, since the platform checks the bundle again and writes
the manifest itself. In a platform build, a `brief.md` with no `- Permissions:` line allows none (a test folder allows all
four). Editing the line can still widen what verify allows, while the zip ships with the stored brief's permissions and
says what it left out; closing that needs the platform to write the permissions into CAPS_DIR at provision.
`action` is from the test's record: `expectExtensionAction` saw the popup call one of the product's actions and got
JSON. The test goes in `tests/extension.spec.ts`, not the smoke spec: the extension runs
in a browser of its own, which the demo video can't show, and the demo runs only `tests/smoke.spec.ts`. No
`scripts/caps/extension.browser.json`: the helper launches its own persistent context. Extensions need Chromium's full
headless mode (`channel: "chromium"`); Playwright's headless shell never starts the service worker (measured).

**Extension, after deploy.** A new generic hook: `lib/caps/ship.ts` (`CAPS_SHIPPING`, pure, read by the workflow) and
`lib/caps/ship-run.ts` (`CAP_SHIP`, `runCapsShip`). `ship()` in `lib/pipeline/workflow.ts` calls `capsShipStep`
(`lib/pipeline/build-steps.ts`) after the deploy and the live check and before register, both in marked blocks, only
when an enabled cap ships, so with every flag off there's no extra step. For a brief with an extension, the step runs
the platform's packer from `CAPS_DIR` in the sandbox (`bundle`), then the platform checks the bundle again
(`lib/caps/extension/{manifest,scan,package}.ts`), keeps only the permissions the brief lists (saying which it left
out), writes its own manifest and `config.js` for the live origin, zips it and saves it at
`extensions/<productId>/latest.zip` (`putBlobAt`, replaced on each ship, the public store like the platform's other
files). A refinement packages it again. When packaging fails, an older zip is taken down (`removeExtensionZip`), since it
came from older files. Any failure is one build room line (`runCapsShipStep` in `lib/caps/ship-run.ts` says so even when
the brief can't be read), and the product is live either way.

**Extension, the download.** `GET /p/<slug>/get/extension` (`lib/caps/extension/download.ts`): with the cap off it
answers exactly what `/p/[slug]/get/[kind]` answered this path before (checked against `answerDownload` in a test), and
touches nothing. On: a shipped product whose newest brief has an extension and whose zip exists gets a 302 to the zip
as a download, with `v=<when it was saved>` so a browser that kept an older zip (Blob allows a month) fetches the new one;
20 an hour per address and 2,000 a day for the site, as the native downloads; HEAD isn't counted.
`CAP_OUTPUTS = ["extension"]` in `lib/native/targets.ts` and an "Extension" tab in the Get it panel
(`components/product/ExtensionPanel.tsx`): the link, the Load unpacked steps, that it's in no store, and what each
permission lets it do, in plain words. The page asks whether the zip is there (`extensionZipReady`, only with the flag
on, for a live brief with an extension); when it isn't, the tab says it isn't ready yet instead of linking to a 404.

**Games.** Overlays `games` (shared: `tests/caps/games.ts`, `scripts/caps/games.mjs`, `lib/platform/assets3d.ts`, skill
`muse-games`), `games-phaser` (`phaser` 4.2.1, `components/game/PhaserGame.tsx`, `lib/platform/phaser-assets.ts`,
`public/notices/phaser.txt`, skill `muse-phaser`) and `games-babylon` (`@babylonjs/core`, `@babylonjs/loaders` and
`babylonjs-gltf2interface` 9.29.0, `components/game/BabylonScene.tsx`, `lib/platform/babylon-glb.ts`,
`public/notices/babylonjs.txt` with the Apache 2.0 license and Babylon's NOTICE, skill `muse-babylon`).
`CAP_OVERLAY_PICK.games` gives `["games", "games-<engine>"]`. Versions are at least two weeks old (Phaser 4.2.1, July 9;
Babylon 9.29.0, Oct 1). No `games.browser.json`: Playwright 1.64 adds `--enable-unsafe-swiftshader` to every Chromium
launch, so WebGL works in the smoke, demo and studio runs alike. `expectGameResponds(page, { key, shots })` reads canvas
screenshots in Node (a small PNG reader, so the game's page is never touched): `canvas` passes when it shows 3 or more
colors with some spread, `key-press` when at least 0.2% of it changes after the key. It also watches two idle windows as
long as the key press: when the canvas changes on its own, the key press must change at least twice the most it did plus
0.2%, so a canvas that animates by itself and ignores keys fails (the review's probe passed before). Fixed checks:
`engine` (exact version in package.json and node_modules, and imported by the product's code; the CAPS_DIR copy reads
which engine from `CAPS_DIR/active.json`, never the product's `musemuse.caps.json`), `no-cdn` (no engine, decoder, model or script URL from another site), `notices` (the notice file, and
a link to it from the page), then `canvas` and `key-press` from the record.

**3D models, against General's GLB pipeline.** tg-3d's helpers aren't fixed yet (7f826bb is the spike), so these are
written against "CC0 asset manifest, v1" in `~/mm-wt/_plan/3d.md`: `parseAssetManifest` keeps CC0-1.0 assets within the
limits (GLB 5 MB, 50k triangles, previews 1 MB) and lists the rest with a reason; `fetchVerified` checks size and
sha256 before anything uses a file; `glbInfo` and `checkGlb` read the GLB's header and JSON and refuse files that point
outside themselves or need a decoder from another site. Babylon: `loadAssetModel(scene, asset, base)` and
`loadOwnModel(scene, "/models/x.glb")`, both through `LoadAssetContainerAsync` only after the checks. Phaser draws 2D, so
an asset shows as its preview picture (`addAssetPreview`). The set isn't reachable from a build yet, so the prompt says
to build scenes from shapes until it is.

**Measured** (Oct 31, on this laptop, no sandbox, no model call). The two starters, bundled with esbuild from the pinned
packages and run in Playwright 1.64.1's headless shell (Chromium 156) on SwiftShader WebGL ("ANGLE (Google, Vulkan 1.3.0
(SwiftShader Device (LLVM 10.0.0)))"): Phaser `canvas` and `key-press` pass (1.9% changed), Babylon pass (8.1%); a blank
canvas fails `canvas` and a frozen one fails `key-press`. Minified client code: 1.58 MB (Phaser), 1.85 MB (Babylon).
Real Babylon loaded a verified GLB (2 triangles), refused a wrong sha256, a Draco GLB and an off-site path, with no
off-site request and no page error. The extension starter, built by the packer with TypeScript 6.0.3, loaded in a full
Chromium 143 headless, its popup found the product page through `currentPage`, its action call arrived with
`x-musemuse-client: extension`, and the policy blocked another origin. All overlays typecheck together with the
template's tsconfig against `@types/chrome` 0.3.5, Phaser 4.2.1 and Babylon 9.29.0.

**Not proven.**

- No real test build. A credentialed local run (or a sandbox probe) needs Vercel credentials; reading the 3D spike's
  credential script was refused by this session's permission checks, and the unit didn't work around it. So no brief
  writer, Muse Code round, verify caps step in a sandbox, deploy or ship step has run for real.
- That the builder snapshot has Playwright's full Chromium (`npx playwright install chromium` installs it beside the
  headless shell since Playwright 1.49, so it should). Without it `loaded` and `popup` fail with "Chromium didn't start".
- `npm install` time for `phaser` (112 MB unpacked) and Babylon (79 MB) through the build firewall, and the products'
  `next build` with them.
- A Vercel deploy that typechecks `extension/` (it needs `@types/chrome`, a devDependency, which Vercel installs).
- `putBlobAt` and `head` for the zip on the real store; the route's redirect on Vercel.
- Context menu and side panel flows: the helper exercises the popup only.
- Meshopt GLBs: manifest v1 allows meshopt, but Babylon fetches its meshopt decoder from its own site, so the Babylon
  helper refuses them until a decoder is vendored (General or unit 4).

**Shared files this unit touched**, each small: `lib/pipeline/workflow.ts` and `lib/pipeline/build-steps.ts` (marked
blocks), `lib/pipeline/__tests__/workflow.scenario.test.ts` (the fake step, a mock for `lib/caps/ship.ts`, three
scenarios, and the flags-off sum), `lib/brief/normalize.ts` (marked block), the registries in `lib/caps/`,
`lib/local-files.ts` (`extensions`), `lib/native/targets.ts` (`CAP_OUTPUTS`), `components/product/GetItPanel.tsx`
(the slot), `app/p/[slug]/page.tsx` (the slot, and the zip lookup behind the flag), `components/product/__tests__/get-it.test.tsx` (two assertions) and
`.env.example` (its block). No golden file changed; the flags-off tests pick up the two caps through `CAP_IDS` and
`CAP_BRIEF_FIELDS`. No `muse-device/` changes.

**For unit 2 and General.** The after-deploy hook is generic: another cap adds an id to `CAPS_SHIPPING` and an entry to
`CAP_SHIP`. The cleanup registry has no hook for a deleted product, so a zip stays on Blob after its product is gone
(the route refuses it, since the product isn't shipped); registering a sweep would change the cron's flags-off answer,
so none is registered. When tg-3d fixes its helper names, `lib/platform/assets3d.ts` should match or import them.

**For the owner.** Two test builds wait for a credentialed run: an extension that saves a page note through the
product's action, and a small Phaser game (section 22). Spend so far: Meta $0, Vercel Sandbox $0, no GPU, no Composio.

## 21. Open questions only the owner can answer

1. **Bug fixes under a flag.** The 10 MB deploy drop is a bug. Should its fix ship unflagged (it changes today's behavior
   from silent loss to an upload or a clear failure), or stay behind `TRUST_DEPLOY_BIG_FILES`?
2. **Spark to Wonder.** Approve `TRUST_SPARK_TO_WONDER` on production? Live products that still call Spark 1.3 then cost
   Wonder's price, so their daily budgets cover fewer runs.
3. **Who can be a signed-in builder** on production, where guest mode is on: anyone with the shared access code, open
   sign-up, or invited people only?
4. **Restricted territories:** confirm `TRUST_GEO_COUNTRIES` from Meta's Geographic Use Policy. And should existing live
   products be redeployed to get the privacy page, the age gate and the geo block?
5. **The 18+ gate in every product:** required for every product, or only ones that save data or reach outside services?
6. **Where test builds run.** The live check and webhooks need a public host, and local runs never publish. Can wave 3 test
   on a preview deployment, and with its own database (your groundwork decision 3)?
7. **Licenses:** which open-weights speech model (Meta's own speech models are, as far as I know, non-commercial; others
   aren't Meta's), and whether ffmpeg.wasm's GPL core is acceptable in products.
8. **Sends on production:** when, if ever, to turn on `CONNECT_SENDS_PRODUCTION`, and which channels.
9. **npm publishing.** The plan's skip list says no publishing under your accounts, and unit 10 says npm after you confirm.
   Which holds?
10. **Visitors for exec, browse and Muse Code:** off until you have read Meta terms 1, 3.1, 6.2 and 10.1(i), or Meta confirms
    in writing. The same reading bears on scheduled jobs that run with nobody present.
11. **The shared Glimmer endpoint:** when to open demo windows, and whether serving Glimmer to strangers' products fits its
    license.
12. **Train on my data:** may a product's shared rows be used, or owner rows only? What consent wording do end users see?
13. **End-user data:** how long rows and files are kept, and who answers a deletion request a person sends by email.
14. **Files on a public Blob store** with unguessable names: acceptable, or move product files to a private store?
15. **The live check spends on Wonder** through the live token, about $0.30 a build. Acceptable?
16. **Board registry:** may builders register their own `muse-device` boards, or only admins for now?
17. **Composio retention** for the extra read-only tools: settle zero data retention before they reach anyone but owners?
18. **Drive export:** the five decisions at the end of `docs/DRIVE_EXPORT.md`.

### 21a. Decided by the planner on Oct 31 (the owner can overrule any of these)

Build to these defaults. Only the items marked **owner** wait for the owner, and their flags stay off until then.

1. The 10 MB deploy fix ships unflagged. It's a bug fix: a file that was silently dropped now uploads or fails clearly. Its
   golden is updated, not kept.
2. **Owner.** `TRUST_SPARK_TO_WONDER` is built and stays off. It goes to the owner as a cost change at push time.
3. Signed-in builders on production: anyone with the existing access code. Admins can ban. No open sign-up yet.
4. `TRUST_GEO_COUNTRIES` is the Restricted Territories list in Meta's Geographic Use Policy (read Oct 31). Existing live
   products get the trust pages at their next rebuild. No mass redeploy without the owner's OK.
5. The 18+ gate goes in every product, because Meta's terms set 18 for end users. One tap, remembered in that browser, and
   off under `MUSEMUSE_BUILD=1`.
6. **Owner.** Preview's own database. Until it exists, test builds run on the local site, and the live check and webhooks
   are proven with local stand-ins only.
7. Speech: no non-commercial model. Use an open model under Apache 2.0 or MIT that runs in the browser, and record its
   license. Video: assemble with WebCodecs and MediaRecorder, not ffmpeg.wasm's GPL core.
8. **Owner.** `CONNECT_SENDS_PRODUCTION` stays off, and the owner names channels later.
9. No npm publishing. Unit 10 makes publish-ready packages and stops there, until the owner confirms a name and an account.
10. Exec, browse and scheduled jobs: owner and signed-in builders only. Scheduled jobs run only on the owner's own products,
    and they read and notify. Visitors stay off until the Meta terms question is answered.
11. **Owner.** Glimmer demo windows stay off. The owner sets the spend and confirms the license reading.
12. Train on my data: owner rows and owner uploads only, never shared or visitor rows, behind an explicit owner action.
13. End-user rows and files are deleted with the product, owners can delete any time, end users can delete their own rows,
    and requests come through the report link.
14. Product files go to a private Blob store and are read through signed gateway URLs. If the private store can't be reached
    the way the platform's credentials work, use the public store with unguessable names, say so on the privacy page, and
    report it.
15. The live check makes no model call: it loads the page and a health route. It costs $0.
16. Board registry: admins only for now.
17. Extra read-only Composio tools: owners only until zero data retention is settled.
18. Drive export: board exports of Qwen fine-tunes are allowed (the owner asked for "fine tuned on the jetson") and carry
    Qwen's license, labeled clearly. The stage 2 Glimmer GGUF may go only onto the owner's own stick. **Owner:** the deploy to
    a board (Hussam, or a fleet job they approve), the $3.70 quantize run (asked when the code is ready), and drives given
    to other people.

## 22. What "done" means, per unit

Every unit, on top of its list:

- Its unit tests and template tests pass, and so does the full suite it touches.
- The flags-off goldens hold (section 1), with its flags added to `FLAGS`.
- One real test build on `TEST_MODEL` with made-up data, on its own flag, within its spend line in section 6, recorded in
  its doc with the build id, cost, time and screenshots.
- Its doc says what it did, what it measured, what isn't proven, and what the owner must decide. No em dashes.
- Its `CAP_READY` line flips only in the merge that does all of the above.

**Unit 1, trust.** Unit: `lib/trust/__tests__/{tiers,gateway,geo,reports}.test.ts` (a guest gets no builder caps, a banned
owner's token gets 403, a taken-down product's page and gallery card are gone, the builder cap counts every source); the
deploy test with an 11 MB file (uploads or fails by name, never drops); Spark to Wonder only for live tokens. Template:
`trust` overlay test (pages, footer, gate off under `MUSEMUSE_BUILD=1`, geo block by header). Migrations: 0018 keeps rows.
Build: a stateless product built as a guest with every trust flag on shows privacy, terms, the age gate and a report link;
the same note asking to save data gets a web-only brief with the limit.

**Unit 2, engine.** Unit: `roundCapMs` cases; workflow scenario tests for a timed-out first round that ships after a fix,
milestones with fix round numbering, the live check's pass and fail; `capsProofText`; the cleanup registry. Template: the
`caps` step (pass, fail, no file), the Playwright hook, the base URL override. Goldens: `lib/caps/__tests__/flags-off.test.ts`
and `caps-off.test.mjs`, all green with flags off. Build: rebuild the tile game note with `ENGINE_CHECK_ON_TIMEOUT` and
`ENGINE_ROUND_SCALING`, and one 3-cap brief with milestones; the live check on one preview deploy.

**Unit 3, data.** Unit: gate check order with every refusal; scopes (each principal against each scope); quotas and
`version_conflict`; codes and sessions (forged, expired, other product, spent nonce); WebAuthn with a fake authenticator;
`deleteMine`. Template: the helpers against a fake gateway, `secondBrowser`. Build: a shared grocery list with sign-in, where
a second browser sees the item and a visitor-scope note stays private.

**Unit 4, files.** Unit: tickets, done checks, quotas, search ranking and citations, datasets by hash. Template: `uploadFile`,
`Citation`. Build: a notes library that answers from an uploaded file and a dataset with sources shown.

**Unit 5, connect.** Unit: allowlist paths and parameters, the cache, the vault's encryption round trip and that no route
returns a value, brokered calls only to the service's hosts, approvals that refuse changed arguments, sends off on
production. Template: `ConfirmSend`, `fetchPublic`. Build: a weather planner on one public API that drafts an email and
sends it as a confirmed sample. Composio within $5.

**Unit 6, jobs.** Unit: due-schedule math with time zones, the 15-minute floor, token minting and verify, per-run budget
stop, checkpoint resume, job write rules, held sends, the 14-day pause, webhooks with a wrong secret. Template: `jobHandler`
refuses a call without a valid token. Build: a daily digest test-fired twice, the second resuming a checkpoint, and a
webhook into a log.

**Unit 7, live.** Unit: chunk overlap and dedupe, the asr limit raised only for `cap:live`, caption minutes, tickets and
scopes, stream reconnect with `after`, deletes in the stream. Template: the fake microphone. Build: lecture captions from a
fixture WAV and a shared scoreboard seen in a second browser.

**Unit 8, media.** Unit: tile math and merging, MIDI bytes, the assets route's hash allowlist. Template: video from 10
frames, speech fallback. Build: a slideshow-to-video maker, a hummed-melody-to-MIDI toy from a fixture, a crowd counter on
tiles. Licenses settled with the owner first.

**Unit 9, code.** Unit: exec limits and the empty network policy, browse's URL-in-input rule and private-address refusals,
`code_session` scope and model list, the result zip filter. Template: Pyodide and QuickJS in the page, the Muse Code
client's replay. Build: a Python snippet runner, a page summarizer on the recorded page, a CSV cleanup with one real Muse
Code session. Sandbox spend within $3.

**Unit 10, runtime.** Unit: the PyPI rule (GET passes, POST refused), the three output generators. Template: the local
Python runner. Build: a product with one Python action, plus its self-host kit and VS Code extension built and checked.

**Unit 11, gpu.** Unit: windows open and close within the cap, 503 outside a window, the deploy env, dataset building from
owner and shared rows only. Build: a Glimmer chat product built on canned replies, then one call in a short demo window
only if the owner opens one; "train on my data" reusing an existing adapter, no new GPU run unless the owner allows one.

**Unit 12, drive export.** As `docs/DRIVE_EXPORT.md`'s test plan: plan tests, Python tests with fake drives, the loopback
test, then the real drive with the owner. No product build until unit 13 lands.

**Unit 13, hardware.** Unit: registry encryption, the owner check (another owner's board refused, visitors off by default),
the two tools' limits. Template: the fake serial port. Build: a serial thermometer reader on the simulated port, and
`show_text` on the simulated board.

**Unit 14, native.** Unit: the manifest generator refuses broad permissions. Template: the extension loads in Playwright; a
game canvas changes on a key press. Build: an extension that saves a page note through the product's action, and a small
Phaser game.

## Changes to this contract

- Oct 31: unit 13's table is the shared `devices` table (offline's shape); unit 10's kit reserves `mode: "offline"`.

- Oct 31: migrations renumbered from 0018 (0016 and 0017 are the General session's), `code_sessions` moved to General,
  section 21a added with the planner's decisions.
- Oct 31 (unit 2): section 8a added. New flags `ENGINE_EXACT_LOGIC` and `ENGINE_FIT_OUTPUT`; round size also counts
  screens plus actions; the big-build budget lines also come with the round flags; the live check loads the page, action
  routes (OPTIONS) and the caps health route instead of rerunning the smoke test (decision 15); `lib/gateway/handler.ts`
  gets one marked block from unit 2 (the Wonder estimate fit); cap registries are objects keyed by cap id, and a cap's
  brief key is its id.
- Oct 31 (unit 2): 8a records the two failed builds' events and the engine's test builds. Section 22's "3-cap brief with
  milestones" waits for three caps to be ready; a milestone build with no caps stands in for it until then.
- Oct 31 (unit 2, after wave 2 merged): `CAP_PROOF` counters take `(buildId, { since })`; `/caps/proof` takes `?since=`;
  verify runs the read-only `CAPS_DIR` copy of the caps check, which reads `CAPS_DIR/gateway.json`, never `.env.local`;
  `ENGINE_CHECK_ON_TIMEOUT` applies to new builds only; `ENGINE_FIT_OUTPUT` applies to build tokens only, and
  `lib/gateway/handler.ts` gets a second marked block from unit 2 (the race re-check); `lib/caps/manifest.ts` for the
  gate's marker check; the goldens are the real surfaces in `flags-off-surface.test.ts` and `playwright-off.test.mjs`.
- Nov 1 (unit 12): section 18 says the board tools are built, `drive_status` lists finished runs, and where the build stand-in lives.
- Oct 31 (unit 12, review fixes): section 18 says `/api/device` filters the drive tools, as 1.6 asks.
- Oct 31 (unit 10): section 16a added. The runtime brief block is Python only (`why`, `functions`, `packages`); the outputs
  aren't in the brief and go to every live product under `RUNTIME_OUTPUTS`, the self-host kit to its owner only;
  `CAP_HOST_METHODS` makes PyPI GET only; `lib/caps/live.ts` (`CAP_LIVE_PATHS`) adds cap routes to the live check; no
  `RUNTIME_NPM_PUBLISH` flag (decision 9).
- Oct 31 (unit 10, review fixes on d35ef4a): 16a says Python endpoints are public and run with the deployment's env,
  adds the guard, the `safe`, `guard` and `size` checks, notes for every Python call (input kept up to 64 KB), no
  install on the call path, the kit's per-owner and site caps, and what the runtime checks rest on.
- Oct 31 (unit 14): section 20a added. The game engine's brief key is `games` (`{engine, why, controls}`), per 8a; a shared
  `games` overlay beside `games-phaser` and `games-babylon`; no `*.browser.json` (Playwright adds SwiftShader itself);
  the extension's test is `tests/extension.spec.ts`; a generic after-deploy hook (`lib/caps/ship.ts`, marked blocks in
  `workflow.ts` and `build-steps.ts`); `CAP_OUTPUTS` in `lib/native/targets.ts` for the Get it slot; the bridge flags
  wait until the bridge is built.
- Oct 31 (unit 14, review fixes): 20a updated. Path clash rules on both sides; the extension policy adds `default-src`,
  `img-src` and `form-action`; the scan refuses page capture; the extension checker runs the packer and a new loader
  (`scripts/caps/extension-load.mjs`) as child processes; `key-press` must beat idle drift; the games checker reads
  `CAPS_DIR/active.json`; the download link is versioned, a failed repackage takes the old zip down, and the Get it tab
  says when there's no zip; `runCapsShipStep` always leaves a line.
- Oct 31 (integration 1, tg-cap-int with the UI brand): build on these shapes. `judgeInstructions(brief, { museAppLook })`
  starts from the look's house style, then the target notes, then `capsJudgeNotes(brief)`. Provisioning applies the
  muse-app look, then a brief's targets, then its caps; every overlay sits in `TARGETS_DIR` through `installTargets`
  except caps, which stay in `CAPS_DIR`. Verify and demo restore the template's platform files, the targets', the look's,
  then the caps'. A snapshot's `templateHash` covers `template/`, `template/targets` and `template/caps`.
- Oct 31 (unit 1): section 7a added. 0018 sits at journal index 16 and 0019 at 17; the platform's geo block is
  `next.config.ts` rewrites, not a `proxy.ts`; the trust overlay is applied by its own script after the caps (not through
  `overlaysFor` or the caps file) and checked by a platform spec in smoke; the big-file fix has no flag (decision 1);
  `lib/gateway/handler.ts` gets a second marked block from unit 1 (Spark to Wonder); `writeBrief` takes an optional
  `builder`; `lib/sandbox/tasks.ts` restores the trust overlay after the caps.
- Oct 31 (unit 1, review fixes): 0018 also adds `products.status_before_takedown` (section 4's 0018 row); a new setting,
  `TRUST_DEPLOY_TOTAL_MB` (100), in unit 1's env block; `lib/tools/handler.ts` and `lib/tools/deps.ts` get one marked trust
  line (tool calls); `lib/auth.ts` `getSessionUser` reads `banned_at` while `TRUST_REPORTS` is on; `scripts/migrate.ts`
  checks a local PGlite folder for migrations drizzle would skip; `collectDeployFiles` returns `{ files }` and throws
  `DeployFilesTooBigError` itself. Unit 2's shared files this branch edits, for unit 2 before the merge:
  `lib/sandbox/builder.ts` (`ProvisionInput.trust`, `applyTrust` after the caps in `provisionSandbox`, the trust record
  read and `withTrustEnv` in `reopenSandbox`), `lib/sandbox/tasks.ts` (`restoreTrustFilesScript` after the caps' restore),
  `lib/pipeline/build-steps.ts` (`trustOverlayStep`; `briefStep` passes the builder's tier; `provisionStep` passes
  `trust` to the prompt and the sandbox; `startDeployStep` revokes its live token on a `FatalError`), `lib/prompts/brief.ts`
  (`briefInstructions(opts)`), `lib/prompts/catalog.ts` (`catalogSummary(caps)`), `lib/brief/render.ts` (the Trust pages
  section after the caps) and `lib/brief/write.ts` (`BriefInput.builder`).
- Oct 31 (integration 2, tg-cap-int with trust): the local PGlite skip check runs in `runMigrations`' local path
  (`lib/db/migrate.ts`), since the preview database moved `scripts/migrate.ts`'s logic there. It returns trust's message
  and exit 1 instead of migrating; Neon paths are unchanged. Section 4's 0018 row names `products.status_before_takedown`.


- Nov 1 (unit 8): section 14a added. The media block gains `why`; each part is gated by its own flag; `CAP_WORKAROUNDS`
  replaces the catalog's speech and video lines; `CAP_BUILD_HOSTS.media` is the Blob mirror's host, GET only, once
  mirrored; speech is SpeechT5 (MIT), video is WebCodecs with our own MP4 writer (no ffmpeg).

- Oct 31: first version (unit 0).
