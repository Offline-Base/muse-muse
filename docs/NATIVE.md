# Where a product runs: the native contract

Every build still makes the Next.js web product. A brief can add targets, and every later unit builds on what this page
fixes. With every flag off, nothing changes: `lib/brief/__tests__/flags-off.test.ts` compares each prompt and schema, byte
for byte, with what they were before targets existed (`lib/brief/__tests__/golden/`).

The lab's own contract, with its routes and job inputs, is `docs/NATIVE_LAB.md`, which comes with the lab unit. Agent tools
are in `docs/AGENT_TOOLS.md`.

## Targets

`TARGETS` in `lib/brief/schema.ts`: `web`, `phone`, `desktop`, `vr`, `glasses`, `agent`.

- **Claude and ChatGPT plugins are not targets.** They are product outputs, next to the MCP server, the CLI and the skill
  file (`PRODUCT_OUTPUTS` in `lib/native/targets.ts`).
- **A stored brief** has an optional `targets: [{ id, why }]`. A brief without it is web only, so older briefs still parse.
- **`NewBriefSchema` and `NewBriefSchemaNoGadget`** don't have the field. Don't add it to them.
- **`newBriefSchemaFor({ gadgets, targets })`** is what the writer should use. With no target enabled it returns those two
  objects themselves. With targets it requires `targets`, limited to web and the enabled ones.

`lib/native/targets.ts`, all pure:

| Export | Does |
|---|---|
| `briefTargets(brief)` | Where a brief's product runs. Always web first, each once, unknown ids ignored |
| `hasNativeWork(brief)` | True for phone or desktop, the two that get packages |
| `validateTargets(value, enabled)` | Checks what a person or script asked for. Nothing asked for is an empty list |
| `applyTargets(brief, { enabled, requested })` | Settles the writer's answer. With nothing enabled it returns the same object |
| `TARGET_GUIDE` | What the writer is told about each target, used only once its flag is on |

Not wired yet: `writeBrief` still picks its schema the old way, and no prompt mentions targets. The targets unit does that
all at once, behind `env.enabledTargets`, with `requestedTargets` on `BriefInput`.

## Flags

All in `lib/env.ts`, all in `.env.example`, all off by default. A switch is on for `1`, `true`, `yes` or `on`, in any case.

| Variable | Getter | Means |
|---|---|---|
| `NATIVE_TARGETS` | `env.nativeTargets` | A comma list of `phone` and `desktop`. Other words are ignored |
| `VR_ENABLED` | `env.vrEnabled` | The writer may pick `vr` |
| `GLASSES_ENABLED` | `env.glassesEnabled` | The writer may pick `glasses` |
| `AGENTS_ENABLED` | `env.agentsEnabled` | The writer may pick `agent` |
| | `env.enabledTargets` | All of the above in `TARGETS` order, never `web`. Empty means today's behavior |
| `NATIVE_LAB` | `env.nativeLab` | Lab checks on the AWS boxes |
| `NATIVE_DEVICE_FARM` | `env.nativeDeviceFarm` | Admin builds may use Device Farm |
| `GLASSES_NATIVE_CHECKS` | `env.glassesNativeChecks` | The Simulator check for glasses. Never blocks shipping |

Spend settings: `NATIVE_SPEND_CAP_USD` (150), `NATIVE_SPEND_ALERT_USD` (120), `NATIVE_DEVICE_FARM_CAP_USD` (40),
`NATIVE_WINDOWS_CAP_USD` (15), `NATIVE_MAC_HOURLY_USD` (0.65), `NATIVE_WINDOWS_HOURLY_USD` (0.083),
`NATIVE_MAC_ALLOCATED_AT`, `NATIVE_MAC_RELEASE_AT`. `.env.example` has the rest: instance ids, `AWS_ROLE_ARN`, Device Farm's
ARNs, `PACKAGER_SNAPSHOT_ID` and the Android signing key.

## Tables

Migrations run in this order, and `lib/db/__tests__/migrations.test.ts` checks the journal against the folder and the schema.

| Migration | Adds |
|---|---|
| `0013_agents` | `tool_sessions`, `tool_connections`, `usage.units`, `builds.tool_fixtures` |
| `0014_native` | `native_runs`, `native_jobs`, `native_artifacts`, `native_spend`, `native_budget`, `native_labs`, `builds.requested_targets` |
| `0015_product_clips` | `products.extra_clips` |

- **Ids are UUIDs.** They fit the lab's job id rule, and they can't be guessed, which the Blob paths depend on.
- **`native_runs`** has a partial unique index on `(build_id, origin)` for `ship` and `refine`, which makes starting a run
  after shipping safe to repeat. `agent` and `owner` may start any number. `build_id` is required, since events go to that
  build's log.
- **`native_artifacts.check`** is the column `check_result`, because `check` is a reserved word in SQL.
- **`native_budget`** has no rows yet. The ledger inserts each lane with `onConflictDoNothing`. Lanes are in
  `NATIVE_BUDGET_LANES`, with `total` as the cap over the others.

The shapes that go in the `jsonb` columns are in `lib/native/types.ts`.

### Promoting a local product

`lib/promote/` copies a local run's rows to the live site. `lib/promote/__tests__/bundle.test.ts` fails on any new column of
`products` or `builds` until someone decides whether a bundle sends it. So far:

| Column | Sent? |
|---|---|
| `products.extra_clips` | Yes, when there are any. The files move too |
| `builds.requested_targets`, `builds.tool_fixtures` | Yes, when set |
| `native_*` | No. A run's results belong to the site that ran it. Start "Check again" on the live site |
| `tool_sessions`, `tool_connections` | No. Composio user ids and connections are per site |
| `usage.units` | No, as with all usage rows |

A bundle leaves these keys out when they're empty, so a product with no targets sends what it always did. A site on older
code refuses a bundle that has them, so deploy before promoting one that does.

## Blob

`native` and `clips` joined `STORED_PREFIXES` in `lib/local-files.ts`, which is now the one list. `BlobPrefix`, the promote
script's link finder and its upload route all read it.

| Path | What | Kept |
|---|---|---|
| `native/shells/<ver>/` | Shell templates | Per shell version |
| `native/products/<productId>/<runId>/` | `<slug>.apk`, `<slug>-mac.zip`, `<slug>-windows.zip` | Latest 2 per kind |
| `native/runs/<runId>/<jobId>/` | Shots, `clip.mp4`, `poster.jpg`, `report.json`, logs | 7 days for agent runs, kept for shipped runs |
| `clips/<productId>/` | Clips the owner uploaded | Kept |

## The native event

One new `BuildEventBody` variant in `lib/types.ts`, written to the build's `build_events`:

```ts
{ type: "native"; runId: string; origin: "ship" | "agent" | "owner" | "refine"; item: string; target: TargetId;
  state: "planned" | "queued" | "running" | "done" | "failed" | "skipped"; title: string; detail?: string;
  media?: Array<{ kind: "image" | "video"; url: string; posterUrl?: string | null; caption: string }>;
  artifact?: { kind: string; url: string; bytes: number }; queue?: { ahead: number; etaSeconds: number }; costUsd?: number }
```

- **`item`** is the step's id within the run, such as `package:android` or `check:ios_sim`.
- **`title`** is what the build room shows, in a plain sentence: "Packaged the Android app (41 MB)".
- **Each event says all that is true now**, except that `media`, `artifact` and `costUsd` stay from earlier events until a
  later one replaces them.

`condenseNativeEvents(events)` turns a build's log into `NativeRunView[]`: the latest state per step, `active` while any step
can still change, and the run's cost. It skips what it can't read, since events may come from a newer branch.

The build room ignores these events for now, apart from moving its stream's place. The UI unit adds the "Apps" step on top of
`condenseNativeEvents`, and keeps the stream open while a run is active.

## The "Get it" panel

`components/product/GetItPanel.tsx`, on the product page under the live frame:

```tsx
<GetItPanel slots={{ phone: <PhonePanel />, mcp: null }} />
```

- **One slot per target and per product output** (`GET_IT_SLOTS`): web, phone, desktop, vr, glasses, agent, mcp, cli, skill,
  claude_plugin, chatgpt.
- **A slot with nothing to show must be `null`.** The panel can't see inside a component, so one that renders nothing still
  gets a tab.
- **With nothing filled it renders nothing at all,** so today's pages look the same. With one it shows no tabs.
- **Today the page passes `slots={{}}`.** Each unit adds its slot there.

## QR codes

`lib/qr.ts`, with `components/product/QrCode.tsx` for pages. It is our own encoder, since the `qrcode` package isn't a
dependency: byte mode, level M, up to version 40 (2,331 bytes).

```tsx
<QrCode value={`${origin}/p/${slug}/get/android`} label="Download for Android" />
```

It stays black on white with its quiet zone in either theme. `qrSvg(text, { label })` gives the same as a string. Its tests
read codes back with a decoder written from the standard. macOS's QR detector read each size correctly on Oct 31, and the
tests pin those codes.
