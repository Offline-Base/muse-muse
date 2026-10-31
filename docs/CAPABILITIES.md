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
| 0018 | `0018_trust` | 1 | `users.adult_confirmed_at`, `users.terms_version`, `users.terms_accepted_at`, `users.banned_at`, `users.ban_reason`; `products.taken_down_at`, `products.takedown_reason`; table `abuse_reports` | 1793431670646 |
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

- `lib/platform/python.ts`: `callPython(request, name, input)`. On Vercel it POSTs to the deployment's own
  `/api/py/<name>`; with `MUSEMUSE_PYTHON_URL` to that address; anywhere else, and in every build
  (`MUSEMUSE_PYTHON=local`, from `CAP_ENV.runtime`), it runs the file through the runner. Only in a build
  (`MUSEMUSE_PYTHON_NOTES=1`, also from `CAP_ENV.runtime`) each call that answered is noted in
  `test-results/caps/runtime-calls.jsonl`; a deployed or self-hosted product notes nothing. Throws `CapError {code, status, message}` in plain words.
- `scripts/py-local.mjs`: runs one `handler` class the way an HTTP server would, through a socket made of buffers,
  standard library only, with a 10 second limit, 4.5 MB each way, and none of the server's env (so no token reaches
  Python on a build). `install` puts pinned wheels from PyPI in `~/.cache/musemuse/python/<python>-<hash>`, never in the
  product folder, so nothing large is deployed, and bootstraps pip from its own sha256-checked wheel when a Python has none.
  `doctor`, `call` and `serve` for Muse Code and for `next dev`.
- `api/py/musemuse_health.py` (GET `{"ok": true, "python"}`), `vercel.json` (only `functions["api/py/*.py"]`:
  `maxDuration` 10 and `excludeFiles` for node_modules, .next and the app's own folders; the health function makes sure
  the pattern always matches), `.python-version` (3.14, the builder snapshot's Python), `requirements.txt` (a comment).
- `tests/caps/runtime.ts` (`expectPythonAction(request, action, input)` records `python-action` only when the call log
  grew during the call), `scripts/caps/runtime.mjs` and the `muse-python` skill.

**Fixed checks** (`scripts/caps/runtime.mjs`, run from `CAPS_DIR` with the platform's own runner beside it): `python`
(a Python runs, and its minor version is the one `.python-version` gives Vercel), `requirements` (every line
`name==version`, no web framework), `functions` (every `api/py/*.py` loads and has the handler class, and there is at
least one besides the health function), `health`, `python-action` (from the smoke test's record), `rerun` (the platform
runs each function the smoke test used again on the same input and the reply has the same shape). None needs the
gateway's record, so they can pass on a local run.

**Live check.** `lib/caps/live.ts`, `CAP_LIVE_PATHS`: routes a cap adds to unit 2's live check, each GET must answer 200
with `{"ok": true}`. Runtime adds `/api/py/musemuse_health`, failing as "its Python functions don't run on the live link".
`liveCheckStep` passes them only when there are some, so a product without them gets exactly today's check.

**Outputs** (`RUNTIME_OUTPUTS`, off). Not `PRODUCT_OUTPUTS`, so Prove it doesn't run them. `RUNTIME_OUTPUTS` in
`lib/native/targets.ts`, Get it tabs "VS Code", "GitHub Action" and "Self-host" after the product outputs.

- `GET /p/<slug>/get/vscode.zip` (`lib/outputs/vscode.ts`): a VS Code extension, for any live product with public actions.
  Fixed code (`lib/outputs/runtime-assets/vscode-extension.cjs`) reads `product.json`; each public action is a command
  that asks for its fields (the editor's selection in the first text field), POSTs to the live action and opens the reply
  as JSON; a `baseUrl` setting points it at a self-hosted copy. `publisher: "local"`, `engines.vscode ^1.90.0`. Packaging:
  `npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license` (no repository or license is
  chosen for the builder).
- `GET /p/<slug>/get/github-action.zip` (`lib/outputs/github-action.ts`): a JavaScript action on `node24` with inputs
  `action`, `input` (JSON), `base-url`, `timeout-seconds` and outputs `result` and `ok`, to unzip into
  `.github/actions/<slug>/`. Every value in `action.yml` is a JSON string, which YAML reads the same way, and
  `actionMetadataProblems` checks GitHub's metadata rules.
- `GET /p/<slug>/get/selfhost.zip` (`lib/outputs/selfhost.ts`, `runtime-serve.ts`): the cloud kit, **for the product's
  owner only** (canActAsOwner; 403 for anyone else), since it is the product's whole source and its owner decides who
  gets it. Its files are the live deployment's own, read back from Vercel (`/v13/deployments/<live host>`, which must be
  the product's project, then `/v6/deployments/<id>/files` and `/v8/.../files/<uid>`, each file checked against its
  SHA-1), at most 600 files and 24 MB, 6 kits an hour per product. Left out: env files, `.mcp.json`, brief.md, AGENTS.md,
  BUILD_NOTES.md, `.agents/`, `tests/`, `fixtures/` (a person's own samples can be there), `inspo/`, platform scripts
  but the Python runner, Playwright's config, executables (ELF, Mach-O, PE). Anything shaped like a Muse Muse token stops
  the kit. Public files over 512 KB stay on the live product and `scripts/kit-fetch.mjs` downloads them, checking each
  sha256. Added: `.env.example` (`PRODUCT_TOKEN=` for the owner's own Meta key and `GATEWAY_URL=https://api.meta.ai`,
  which the template's `gatewayEnv()` turns into `https://api.meta.ai/v1`, so the product's code is unchanged),
  `README-SELF-HOST.md` (how to run it, and what doesn't work without Muse Muse: big uploads, the gadget, Glimmer, agent
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
  extension with a stand-in for VS Code's API).

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
- Oct 31 (integration 1, tg-cap-int with the UI brand): build on these shapes. `judgeInstructions(brief, { museAppLook })`
  starts from the look's house style, then the target notes, then `capsJudgeNotes(brief)`. Provisioning applies the
  muse-app look, then a brief's targets, then its caps; every overlay sits in `TARGETS_DIR` through `installTargets`
  except caps, which stay in `CAPS_DIR`. Verify and demo restore the template's platform files, the targets', the look's,
  then the caps'. A snapshot's `templateHash` covers `template/`, `template/targets` and `template/caps`.


- Oct 31: first version (unit 0).
