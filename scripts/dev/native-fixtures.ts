/**
 * Fills a local PGlite database with a product for each state of the "Get it" panel and the build room's Apps step, so
 * they can be looked at with no sandbox, no lab and no keys:
 *
 *   DATABASE_URL=pglite:.data/getit npx tsx scripts/migrate.ts
 *   DATABASE_URL=pglite:.data/getit npx tsx scripts/dev/native-fixtures.ts
 *   npx tsx scripts/dev/native-fixtures.ts serve 3169                # The stand-in for the products' live sites
 *   DATABASE_URL=pglite:.data/getit OPEN_ACCESS=admin NATIVE_TARGETS=phone,desktop VR_ENABLED=1 GLASSES_ENABLED=1 \
 *     MUSE_ENGINE=serve npx next dev --webpack -H localhost -p 3161
 *
 * Then open /p/<slug> and /b/<id> for each one it prints, and /vr. That is a visitor. Add ADMIN_EMAILS=fixture@example.com
 * for the owner, and NEXT_PUBLIC_LOCAL_FILES=1 PLATFORM_URL=http://localhost:3161 to try adding a clip. Leave out the flags to
 * see that the panel stays away. Seed again after 2 hours: a run older than that counts as stuck, so seed fresh to see a live one.
 * get-every-state also has a public action and a finished Prove it run, so with PRODUCT_OUTPUTS=1 its Get it panel shows
 * the MCP, CLI, Skill, Claude and ChatGPT tabs with their results, and its build room the "Tested what it comes with" row.
 *
 * Every clip and picture is a stand-in. `serve` answers for the live sites, and for the clip when given a file after the port.
 */
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { IDS as ROOM_IDS, brief as baseBrief, inspiration, picture } from "@/components/build/__tests__/room-fixture";
import type { TargetId } from "@/lib/brief/schema";
import { localDbDir } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import type { NativeArtifactKind, NativeCheck, NativeJobKind, NativeJobResult, NativeJobStatus, NativeRunStatus } from "@/lib/native/types";
import type { BuildEventBody, Manifest, NativeEventBody, ProductClip, ProveEventBody } from "@/lib/types";

const SITE_PORT = 3169;
const SITE = `http://localhost:${SITE_PORT}`;
const BLOB = "https://blob.example/native";
const CLIP = `${SITE}/clip.mp4`;

// ---------- The data ----------

const uuid = (group: number, n: number) => `${String(group).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface JobFixture {
  kind: NativeJobKind;
  status: NativeJobStatus;
  result?: NativeJobResult;
  media?: boolean;
  /** Made before the newest package, so it shouldn't vouch for it. */
  stale?: boolean;
}

interface ProductFixture {
  slug: string;
  name: string;
  targets: TargetId[];
  run?: NativeRunStatus;
  packages?: Array<{ kind: NativeArtifactKind; bytes: number; check?: NativeCheck | null; size?: string }>;
  jobs?: JobFixture[];
  deviceFarm?: { device: string; check: NativeCheck };
  clips?: ProductClip[];
  events?: Array<Omit<NativeEventBody, "type" | "runId" | "origin">>;
  /** The build is still going, with an agent's checks in its log. */
  building?: boolean;
  origin?: NativeEventBody["origin"];
  /** musemuse.json, for a product whose actions make the outputs (MCP, CLI, skill and plugins). */
  manifest?: Manifest;
  /** A Prove it run of those outputs, written after the deploy. */
  prove?: Array<Omit<ProveEventBody, "type" | "runId" | "origin">>;
}

const passed = (summary: string, name: string, os: string, loadMs = 2100): NativeJobResult => ({ outcome: "passed", informational: false, summary, device: { name, os }, loadMs });

const shot = (label: string, hue: number) => picture(label, hue);

const makingEvents: ProductFixture["events"] = [
  { item: "package:android", target: "phone", state: "done", title: "Packaged the Android app (41 MB)", artifact: { kind: "android_apk", url: `${BLOB}/a.apk`, bytes: 41_000_000 } },
  { item: "package:mac", target: "desktop", state: "running", title: "Packaging the Mac app" },
  { item: "package:windows", target: "desktop", state: "failed", title: "Couldn't package the Windows app", detail: "The Windows template wasn't there. Try again." },
  { item: "check:android_emu", target: "phone", state: "running", title: "Checking on an Android emulator (Pixel 7, Android 15)" },
  { item: "check:ios_sim", target: "phone", state: "queued", title: "Waiting for the Mac lab", queue: { ahead: 2, etaSeconds: 240 } },
  { item: "check:desktop_mac", target: "desktop", state: "queued", title: "Waiting for the Mac lab", queue: { ahead: 0, etaSeconds: 60 } },
  { item: "check:desktop_windows", target: "desktop", state: "skipped", title: "Not checked on Windows this time: the Windows lab didn't start. The download is ready but untested." },
  { item: "device_farm:android", target: "phone", state: "planned", title: "A real Android phone on AWS Device Farm is next" },
];

const doneEvents: ProductFixture["events"] = [
  { item: "package:android", target: "phone", state: "done", title: "Packaged the Android app (41 MB)", artifact: { kind: "android_apk", url: `${BLOB}/a.apk`, bytes: 41_000_000 } },
  { item: "package:mac", target: "desktop", state: "done", title: "Packaged the Mac app (215 MB)", artifact: { kind: "mac_zip", url: `${BLOB}/m.zip`, bytes: 215_000_000 } },
  { item: "check:android_emu", target: "phone", state: "done", title: "Checked on an Android emulator (Pixel 7, Android 15): opened in 2.1 s", media: [{ kind: "video", url: CLIP, posterUrl: shot("Android emulator", 140), caption: "On an Android emulator (Pixel 7, Android 15)" }] },
  { item: "check:ios_sim", target: "phone", state: "done", title: "Checked on an iPhone simulator (iOS 18.4): opened in 1.8 s", media: [{ kind: "image", url: shot("iPhone simulator", 200), caption: "On an iPhone simulator (iOS 18.4)" }, { kind: "video", url: CLIP, caption: "On an iPhone simulator (iOS 18.4), the clip" }] },
  { item: "check:desktop_windows", target: "desktop", state: "failed", title: "Didn't pass on Windows: the page stayed blank", detail: "The screen was one flat color." },
  { item: "device_farm:android", target: "phone", state: "done", title: "Real Galaxy S25 on AWS Device Farm: 4 device minutes, $0.68", costUsd: 0.68, media: [{ kind: "video", url: CLIP, posterUrl: shot("Galaxy S25", 30), caption: "On a real Galaxy S25 (AWS Device Farm)" }] },
];

const feederManifest: Manifest = {
  name: "Feeder Count",
  slug: "get-every-state",
  tagline: baseBrief.tagline,
  inspiration: "A short clip from a backyard bird feeder.",
  models: [{ id: "muse-wonder-1.0", usedFor: "Finding and counting the birds in each frame" }],
  actions: [
    {
      name: "count_birds",
      description: "Counts the birds in a short feeder clip.",
      input: { type: "object", properties: { clipUrl: { type: "string" } }, required: ["clipUrl"] },
      output: { type: "object", properties: { count: { type: "number" } } },
      who: "anyone",
      annotations: { readOnly: true },
    },
  ],
  fixtures: [],
  limits: ["Clips up to 30 seconds."],
  estimatedCostPerRunUsd: 0.02,
};

const proveEvents: ProductFixture["prove"] = [
  { item: "stage", state: "done", title: "Tested what it comes with", detail: "2 of 3 outputs worked" },
  {
    item: "mcp",
    state: "done",
    title: "MCP server: worked",
    checks: [
      { label: "Listed its tools", ok: true },
      { label: "Called count_birds", ok: true },
    ],
    media: { url: CLIP, posterUrl: shot("MCP run", 200), caption: "The MCP run" },
    costUsd: 0.08,
  },
  {
    item: "cli",
    state: "failed",
    title: "CLI: didn't work",
    detail: "The command exited with code 1.",
    checks: [
      { label: "Installed", ok: true },
      { label: "Ran count_birds", ok: false },
    ],
    costUsd: 0.04,
  },
  { item: "skill", state: "skipped", title: "Skill: not tested", detail: "The run reached its spend cap first." },
];

const PRODUCTS: ProductFixture[] = [
  {
    slug: "get-every-state",
    name: "Feeder Count",
    targets: ["web", "phone", "desktop", "vr", "glasses"],
    run: "done",
    packages: [
      { kind: "android_apk", bytes: 41_000_000 },
      { kind: "mac_zip", bytes: 215_000_000 },
      { kind: "windows_zip", bytes: 115_000_000 },
    ],
    jobs: [
      { kind: "android_emu", status: "done", media: true, result: passed("Checked on an Android emulator (Pixel 7, Android 15): opened in 2.1 s.", "Pixel 7", "15") },
      { kind: "ios_sim", status: "done", media: true, result: passed("Checked on an iPhone simulator (iOS 18.4): opened in 1.8 s.", "", "18.4") },
      { kind: "desktop_mac", status: "done", media: true, result: passed("Checked on a Mac (macOS 15.4): opened in 1.2 s.", "", "15.4") },
      { kind: "desktop_windows", status: "failed", result: { outcome: "lab_error", summary: "Not checked on Windows: the lab couldn't start the app.", error: { code: "internal", message: "An unexpected error." } } },
      { kind: "glasses_sim", status: "done", media: true, result: { ...passed("Checked on an iPhone simulator with Meta's mock glasses (iOS 18.4).", "", "18.4"), informational: true } },
    ],
    deviceFarm: { device: "Galaxy S25", check: "passed" },
    clips: [{ url: CLIP, posterUrl: shot("Filmed on a Quest", 280), caption: "Filmed on a Meta Quest 3", addedAt: "2026-10-31T12:00:00.000Z" }],
    events: doneEvents,
    manifest: feederManifest,
    prove: proveEvents,
  },
  {
    slug: "get-failed-check",
    name: "Failed Check",
    targets: ["web", "phone", "desktop"],
    run: "partial",
    packages: [
      { kind: "android_apk", bytes: 41_000_000 },
      { kind: "mac_zip", bytes: 215_000_000 },
      { kind: "windows_zip", bytes: 115_000_000 },
    ],
    jobs: [
      {
        kind: "android_emu",
        status: "failed",
        media: true,
        result: { outcome: "failed", summary: "Didn't pass on an Android emulator (Pixel 7, Android 15).", device: { name: "Pixel 7", os: "15" }, reasons: ["The screen stayed blank for 60 seconds.", "The app closed once while the page loaded."] },
      },
      { kind: "ios_sim", status: "done", result: { outcome: "failed", summary: "Didn't pass on an iPhone simulator (iOS 18.4).", device: { name: "", os: "18.4" }, reasons: ["The page answered with HTTP 500."] } },
      { kind: "desktop_mac", status: "claimed" },
    ],
    events: doneEvents,
  },
  {
    slug: "get-being-made",
    name: "Being Made",
    targets: ["web", "phone", "desktop"],
    run: "running",
    packages: [],
    jobs: [{ kind: "android_emu", status: "claimed" }, { kind: "ios_sim", status: "queued" }, { kind: "desktop_mac", status: "queued" }],
    events: makingEvents,
  },
  { slug: "get-nothing-made", name: "Nothing Made", targets: ["web", "phone", "desktop"], run: "failed", events: [{ item: "package:android", target: "phone", state: "failed", title: "Couldn't package the Android app", detail: "The packager stopped." }, { item: "package:mac", target: "desktop", state: "failed", title: "Couldn't package the Mac app" }] },
  { slug: "get-not-checked", name: "Not Checked", targets: ["web", "phone"], run: "done", packages: [{ kind: "android_apk", bytes: 38_000_000 }], jobs: [{ kind: "android_emu", status: "done", stale: true, result: passed("An older package passed here.", "Pixel 7", "15") }] },
  { slug: "get-vr-only", name: "Tide Pool VR", targets: ["web", "vr"] },
  { slug: "get-glasses-only", name: "What Am I Looking At", targets: ["web", "glasses"] },
  { slug: "get-web-only", name: "Web Only", targets: ["web"] },
  { slug: "get-agent-trying", name: "Still Building", targets: ["web", "phone"], building: true, run: "running", origin: "agent", events: [{ item: "check:android_emu", target: "phone", state: "done", title: "Checked the preview on an Android emulator (Pixel 7, Android 15)", media: [{ kind: "image", url: shot("Preview on Android", 160), caption: "The preview on an Android emulator" }] }, { item: "check:ios_sim", target: "phone", state: "queued", title: "Waiting for the Mac lab", queue: { ahead: 1, etaSeconds: 120 } }] },
];

async function seed() {
  const dir = localDbDir(process.env.DATABASE_URL ?? "");
  if (!dir) throw new Error("Set DATABASE_URL to pglite:<folder>.");
  const client = new PGlite(dir);
  const d = drizzle({ client, schema });
  const started = Date.now() - 600_000;

  await d.insert(schema.users).values({ id: ROOM_IDS.user, email: "fixture@example.com" }).onConflictDoNothing();
  await d.insert(schema.inspirations).values({ id: ROOM_IDS.inspiration, userId: ROOM_IDS.user, note: inspiration.note, references: inspiration.references }).onConflictDoNothing();

  for (const [i, f] of PRODUCTS.entries()) {
    const group = 90 + i;
    const productId = uuid(group, 1);
    const buildId = uuid(group, 2);
    const runId = uuid(group, 3);
    const brief = { ...baseBrief, name: f.name, slug: f.slug, targets: f.targets.map((id) => ({ id, why: "A fixture." })) };
    const status = f.building ? ("building" as const) : ("live" as const);
    await d.insert(schema.products).values({ id: productId, slug: f.slug, name: f.name, tagline: baseBrief.tagline, ownerId: ROOM_IDS.user, inspirationId: ROOM_IDS.inspiration, status, liveUrl: f.building ? null : `${SITE}/?p=${f.slug}`, extraClips: f.clips ?? [], manifest: f.manifest ?? null }).onConflictDoNothing();
    await d
      .insert(schema.builds)
      .values({ id: buildId, inspirationId: ROOM_IDS.inspiration, userId: ROOM_IDS.user, kind: "build", productId, status, step: f.building ? "build" : "deploy", brief, buildModel: "muse-wonder-1.0", costUsd: 0.9, startedAt: new Date(started), finishedAt: f.building ? null : new Date(started + 500_000) })
      .onConflictDoNothing();
    await d.update(schema.products).set({ latestBuildId: buildId }).where(eqId(productId));

    const body: BuildEventBody[] = f.building
      ? [{ type: "status", status: "building", message: "Muse Code is building." }]
      : [{ type: "status", status: "live", message: "It's live." }, { type: "deploy", url: `${SITE}/?p=${f.slug}` }];
    if (f.run) {
      await d.insert(schema.nativeRuns).values({ id: runId, productId, buildId, origin: f.origin ?? "ship", targets: f.targets, status: f.run, createdAt: new Date(started + 510_000) }).onConflictDoNothing();
      for (const e of f.events ?? []) body.push({ type: "native", runId, origin: f.origin ?? "ship", ...e });
    }
    for (const payload of body) await d.insert(schema.buildEvents).values({ buildId, type: payload.type, payload, at: new Date(started + 505_000) });
    // Prove it runs after the build is final, so its events come after the deploy and the apps.
    for (const [n, e] of (f.prove ?? []).entries()) {
      const payload: ProveEventBody = { type: "prove", runId: uuid(group, 4), origin: "ship", ...e };
      await d.insert(schema.buildEvents).values({ buildId, type: "prove", payload, at: new Date(started + 560_000 + n * 1000) });
    }

    const packageAt = new Date(started + 520_000);
    for (const [n, p] of (f.packages ?? []).entries()) {
      await d
        .insert(schema.nativeArtifacts)
        .values({ id: uuid(group, 100 + n), productId, runId, kind: p.kind, url: `${BLOB}/${f.slug}/${p.kind}`, pathname: `native/products/${productId}/${runId}/${p.kind}`, bytes: p.bytes, check: p.check ?? null, createdAt: packageAt })
        .onConflictDoNothing();
    }
    for (const [n, j] of (f.jobs ?? []).entries()) {
      const jobId = uuid(group, 200 + n);
      const at = new Date(j.stale ? started + 515_000 : started + 530_000 + n * 1000);
      const lane = j.kind === "desktop_windows" ? ("windows" as const) : ("mac" as const);
      await d
        .insert(schema.nativeJobs)
        .values({ id: jobId, runId, buildId, productId, lane, kind: j.kind, status: j.status, input: { v: 1, limitSeconds: 300 }, result: j.result ?? null, expiresAt: new Date(Date.now() + 3_600_000), createdAt: at })
        .onConflictDoNothing();
      if (j.media) {
        const label = j.result?.summary ?? j.kind;
        const caption = `On ${j.kind.includes("android") ? "an Android emulator" : j.kind.includes("desktop") ? "a Mac" : "an iPhone simulator"}. Recorded in the Muse Muse device lab. Not an official Meta product.`;
        const media: Array<[NativeArtifactKind, string, string | null]> = [["clip", CLIP, caption], ["poster", shot(label.slice(0, 24), 150 + n * 40), null], ["shot", shot("Screenshot 1", 120 + n * 40), "The first screen"], ["shot", shot("Screenshot 2", 90 + n * 40), "After it loaded"]];
        for (const [m, [kind, url, cap]] of media.entries()) {
          await d.insert(schema.nativeArtifacts).values({ id: uuid(group, 300 + n * 10 + m), productId, runId, jobId, kind, url, pathname: `native/runs/${runId}/${jobId}/${kind}-${m}`, bytes: 1000, caption: cap, createdAt: at }).onConflictDoNothing();
        }
      }
    }
    if (f.deviceFarm) {
      const at = new Date(started + 540_000);
      const { device, check } = f.deviceFarm;
      await d.insert(schema.nativeArtifacts).values({ id: uuid(group, 500), productId, runId, kind: "clip", platform: "android", device, url: CLIP, pathname: `native/runs/${runId}/df/clip.mp4`, bytes: 1000, check, caption: `On a real ${device} (AWS Device Farm)`, createdAt: at }).onConflictDoNothing();
      await d.insert(schema.nativeArtifacts).values({ id: uuid(group, 501), productId, runId, kind: "poster", platform: "android", device, url: shot(device, 30), pathname: `native/runs/${runId}/df/poster.jpg`, bytes: 1000, createdAt: at }).onConflictDoNothing();
    }
    console.log(`${f.slug}: /p/${f.slug}  /b/${buildId}`);
  }
  await client.close();
}

function eqId(id: string) {
  return sql`${schema.products.id} = ${id}`;
}

function serve(port: number, clipFile: string | undefined) {
  createServer((req, res) => {
    if (req.url?.startsWith("/clip.mp4") && clipFile && existsSync(clipFile)) {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      createReadStream(clipFile).pipe(res);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Feeder Count</title><body style="margin:0;font:16px system-ui;background:#fbf7ef;color:#222"><header style="padding:18px 20px;background:#2d5a3d;color:#fff;font-size:20px">Feeder Count</header><main style="padding:20px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))"><p style="margin:0;grid-column:1/-1">Drop a short clip of your feeder.</p><div style="height:200px;border:2px dashed #2d5a3d;border-radius:16px;display:grid;place-items:center">Upload a clip</div><div style="height:200px;background:#e8e0cf;border-radius:16px;display:grid;place-items:center">The count shows here</div><button style="height:48px;border:0;border-radius:24px;background:#2d5a3d;color:#fff;font:inherit;grid-column:1/-1">Count the birds</button></main>`,
    );
  }).listen(port, "localhost", () => console.log(`live sites on http://localhost:${port}`));
}

if (process.argv[2] === "serve") serve(Number(process.argv[3]) || SITE_PORT, process.argv[4]);
else await seed();
