/**
 * UI smoke test (throwaway). Exercises the pure build-room derivation, formatting, rebuild join, WAV encoding and
 * file-name helpers, then server-renders the client components with a realistic event log to catch crashes.
 * Run: npx tsx scripts/dev/ui-smoke.tsx
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { BuildRoom } from "@/components/build/BuildRoom";
import { deriveRoom, groupLog, railStates } from "@/components/build/derive";
import { StackedBars } from "@/components/charts/StackedBars";
import { ProductCard } from "@/components/product/ProductCard";
import type { BuildView } from "@/components/view-types";
import { encodeWav } from "@/lib/client/audio";
import { referenceKind } from "@/lib/client/prepare";
import { safeFileName } from "@/lib/client/upload";
import { compact, duration, initials, relativeTime, safeNext, usd } from "@/lib/format";
import { joinRebuilds, parseUsageFilters, safeQuery } from "@/lib/queries";
import type { Brief, BuildEvent } from "@/lib/types";

const brief: Brief = {
  verdict: "partly",
  refusal: null,
  name: "Feeder Count",
  slug: "feeder-count",
  tagline: "Counts and outlines the birds in a short feeder video.",
  user: "Backyard bird watchers",
  inspiration: {
    summary: "A short phone video of birds at a feeder.",
    references: [{ index: 0, kind: "video", describes: "Three sparrows at a tube feeder" }],
    borrow: ["The job: count birds", "Calm green mood"],
    dontCopy: ["The feeder brand logo"],
  },
  primaryFlow: ["Upload a clip", "See each bird outlined", "Get a count"],
  screens: [{ name: "Upload", purpose: "Pick a clip" }],
  capabilities: [
    { need: "Find and track birds", model: "sam-3.1", why: "Segments objects across frames" },
    { need: "Name the species", model: "muse-wonder-1.0", why: "Reads the frames" },
  ],
  inputs: [{ kind: "video", required: true, notes: "Under 30 s" }],
  outputs: [{ kind: "overlay", notes: "Masks" }],
  limits: ["Species names are guesses."],
  complexity: "standard",
  estimatedCostPerRunUsd: 0.04,
  costNotes: "50 frames at the SAM minimum plus one Spark call.",
  fixtures: [{ kind: "video", description: "The user's clip", fromUserSample: true }],
  actions: [{ name: "count_birds", description: "Count birds in a clip" }],
};

const t0 = Date.parse("2026-10-27T12:00:00Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
let id = 0;
const ev = (s: number, body: Record<string, unknown>) => ({ ...body, id: ++id, at: at(s) }) as BuildEvent;

const events: BuildEvent[] = [
  ev(0, { type: "status", status: "briefing", step: "brief" }),
  ev(14, { type: "brief", brief }),
  ev(14, { type: "cost", totalUsd: 0.02, addedUsd: 0.02, what: "brief" }),
  ev(15, { type: "status", status: "provisioning", step: "provision" }),
  ev(40, { type: "status", status: "building", step: "build" }),
  ev(41, {
    type: "muse",
    round: 0,
    lines: [
      { kind: "start", text: "Started" },
      { kind: "say", text: "I'll read the " },
      { kind: "say", text: "brief first." },
    ],
  }),
  ev(50, {
    type: "muse",
    round: 0,
    lines: [
      { kind: "tool", tool: "read_file", ok: true, text: "Read text file `brief.md`.\n1|# Build" },
      { kind: "tool", tool: "read_file", ok: true, text: "Read text file `AGENTS.md`." },
      { kind: "tool", tool: "shell", ok: false, text: "npm run typecheck failed" },
      { kind: "edit", files: 2, added: 40, removed: 3, text: "Edited 2 files" },
    ],
  }),
  ev(60, { type: "preview", url: "https://sb-abc.vercel.run" }),
  ev(200, {
    type: "muse",
    round: 0,
    lines: [
      { kind: "usage", text: "Input 1.2M · Output 31K" },
      { kind: "done", text: "Built the upload and count flow." },
    ],
  }),
  ev(200, { type: "cost", totalUsd: 0.96, addedUsd: 0.94, what: "muse code" }),
  ev(201, { type: "status", status: "verifying", step: "verify" }),
  ev(260, {
    type: "verify",
    round: 0,
    summary: {
      passed: false,
      steps: [
        { name: "typecheck", ok: true, ms: 4200 },
        { name: "smoke", ok: false, ms: 9100, detail: "Expected a count" },
      ],
      failureOutput: "Error: expected 3 birds",
    },
    screenshots: [{ url: "https://example.com/a.png", caption: "Upload" }],
  }),
  ev(261, { type: "status", status: "fixing", step: "fix" }),
  ev(300, { type: "muse", round: 1, lines: [{ kind: "edit", files: 1, added: 5, removed: 1, text: "Edited 1 file" }] }),
  ev(310, { type: "status", status: "verifying", step: "verify" }),
  ev(360, {
    type: "verify",
    round: 1,
    summary: { passed: true, steps: [{ name: "smoke", ok: true, ms: 8000 }], failureOutput: "" },
    screenshots: [],
  }),
  ev(370, { type: "judge", round: 1, verdict: { pass: true, reasons: ["The count shows."], mismatches: [] } }),
  ev(371, { type: "status", status: "recording", step: "record" }),
  ev(420, { type: "recording", url: "https://example.com/demo.mp4" }),
  ev(421, { type: "status", status: "deploying", step: "deploy" }),
  ev(500, { type: "deploy", url: "https://musemuse-feeder-count.vercel.app" }),
  ev(510, { type: "log", text: "Muse Code made 41 tool calls." }),
  ev(511, { type: "status", status: "live" }),
];

const build: BuildView = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "build",
  message: null,
  rebuildOf: null,
  productId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  inspirationId: "44444444-4444-4444-8444-444444444444",
  status: "building",
  step: "build",
  brief: null,
  buildModel: "muse-wonder-1.0",
  museSessionId: "7661c49d-b561-4b2e-8cce-541a6cb64df2",
  fixRounds: 1,
  previewUrl: null,
  costUsd: 0,
  error: null,
  startedAt: at(0),
  finishedAt: null,
};

// ---- derive ----
const midway = deriveRoom(build, events.slice(0, 9));
assert.equal(midway.status, "building");
assert.equal(midway.previewUrl, "https://sb-abc.vercel.run");
assert.deepEqual(
  midway.segments.map((s) => s.key),
  ["brief", "muse:0"],
);
const midRail = railStates(midway, "build");
assert.equal(midRail.brief, "done");
assert.equal(midRail.provision, "done");
assert.equal(midRail.build, "active");
assert.equal(midRail.check, "pending");

const room = deriveRoom(build, events);
assert.equal(room.status, "live");
assert.equal(room.terminal, true);
assert.equal(room.liveUrl, "https://musemuse-feeder-count.vercel.app");
assert.equal(room.recordingUrl, "https://example.com/demo.mp4");
assert.equal(room.costUsd, 0.96);
assert.equal(room.fixRounds, 1);
assert.deepEqual(
  room.segments.map((s) => s.key),
  ["brief", "muse:0", "check:0", "muse:1", "check:1", "record", "deploy"],
);
const checks = room.segments.filter((s) => s.type === "check");
assert.deepEqual(
  checks.map((c) => (c.type === "check" ? c.index : -1)),
  [0, 1],
);
const brief0 = room.segments[0];
assert.equal(brief0.costUsd, 0.02);
assert.equal(room.segments[1].costUsd, 0.94);
assert.equal(room.segments[1].startAt, at(40), "muse turn starts at the building status");
const rail = railStates(room, "build");
assert.ok(Object.values(rail).every((s) => s === "done"));

const failed = deriveRoom(build, [
  ...events.slice(0, 13),
  ev(270, { type: "error", message: "Checks failed 3 times" }),
  ev(271, { type: "status", status: "failed" }),
]);
const failRail = railStates(failed, "build");
assert.equal(failRail.check, "failed");
assert.equal(failRail.build, "done");
assert.equal(failRail.record, "skipped");
assert.equal(failed.lastError, "Checks failed 3 times");

const refused = deriveRoom(build, [
  ev(0, { type: "status", status: "briefing" }),
  ev(5, { type: "status", status: "refused", message: "Clones a real brand" }),
]);
assert.equal(railStates(refused, "build").brief, "failed");

const { groups, summary } = groupLog([
  { kind: "say", text: "Hel" },
  { kind: "say", text: "lo" },
  { kind: "tool", text: "Read a\nmore", tool: "read_file", ok: true },
  { kind: "edit", text: "x", files: 2, added: 3, removed: 1 },
  { kind: "say", text: " " },
  { kind: "done", text: "Done." },
]);
assert.equal(groups[0].type === "say" && groups[0].text, "Hello");
assert.equal(groups[1].type, "activity");
assert.equal(groups[2].type, "done", "whitespace-only prose is dropped");
assert.equal(summary.tools, 1);
assert.equal(summary.added, 3);

// ---- format ----
assert.equal(compact(344_300), "344.3k");
assert.equal(compact(1_200_000), "1.2M");
assert.equal(compact(950), "950");
assert.equal(usd(0), "$0.00");
assert.equal(usd(0.004), "$0.004");
assert.equal(usd(1.123), "$1.12");
assert.equal(duration(14_500), "14.5 s");
assert.equal(duration(252_000), "4 m 12 s");
assert.equal(duration(3_780_000), "1 h 3 m");
assert.equal(initials("ethan.castro@example.com"), "EC");
assert.equal(relativeTime(at(0), t0 + 5 * 60_000), "5 m ago");
assert.equal(safeNext("//evil.com"), "/");
assert.equal(safeNext("/b/abc?refine=1"), "/b/abc?refine=1");
assert.equal(safeNext("https://evil.com"), "/");

// ---- client helpers ----
assert.equal(safeFileName("Résumé final (2).PDF"), "Resume-final-2.pdf");
assert.equal(safeFileName("../../etc/passwd"), "passwd");
assert.equal(safeFileName(".env"), "env");
assert.equal(safeFileName("photo.JPEG"), "photo.jpeg");
assert.equal(referenceKind({ type: "audio/x-m4a", name: "memo.m4a" }), "audio");
assert.equal(referenceKind({ type: "", name: "memo.m4a" }), "audio");
assert.equal(referenceKind({ type: "video/webm", name: "x.webm" }), null);
assert.equal(referenceKind({ type: "image/heic", name: "x.heic" }), "image");
const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 16000);
const bytes = Buffer.from(await wav.arrayBuffer());
assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
assert.equal(bytes.readUInt16LE(22), 1, "mono");
assert.equal(bytes.readUInt32LE(24), 16000, "16 kHz");
assert.equal(bytes.readUInt16LE(34), 16, "16-bit");
assert.equal(bytes.readUInt32LE(40), 8, "4 samples x 2 bytes");
assert.equal(bytes.readInt16LE(46), 16383);
assert.equal(wav.type, "audio/wav");

// ---- queries (pure parts and the not-connected path) ----
const saved = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;
const nc = await safeQuery(async () => 1);
assert.deepEqual(nc.ok ? null : nc.reason, "not_configured");
if (saved) process.env.DATABASE_URL = saved;
const empty = joinRebuilds([], []);
assert.equal(empty.totals.of, 30);
assert.equal(empty.totals.rebuilt, 0);
assert.equal(empty.missing.length, 4);
const joined = joinRebuilds(
  [
    {
      id: "b2",
      rebuildOf: "docs-to-blog-rag",
      status: "live",
      startedAt: new Date(t0 + 600_000),
      finishedAt: new Date(t0 + 1_200_000),
      costUsd: 1.1,
    },
    {
      id: "b1",
      rebuildOf: "docs-to-blog-rag",
      status: "failed",
      startedAt: new Date(t0),
      finishedAt: new Date(t0 + 300_000),
      costUsd: 0.5,
    },
  ],
  [
    {
      slug: "doc-blogger",
      name: "Doc Blogger",
      status: "live",
      liveUrl: "https://x.vercel.app",
      demoVideoUrl: null,
      demoPosterUrl: null,
      rebuildOf: "docs-to-blog-rag",
    },
  ],
);
assert.equal(joined.totals.rebuilt, 1);
assert.equal(joined.totals.totalMs, 900_000);
assert.ok(Math.abs(joined.totals.totalCostUsd - 1.6) < 1e-9);
const card = joined.videos.find((v) => v.id === "docs-to-blog-rag")!;
assert.equal(card.latestBuild?.id, "b2");
assert.equal(card.attempts, 2);
const f = parseUsageFilters({ product: "nope", model: "sam-3.1", range: "30", view: "model", end: "2999-01-01" });
assert.equal(f.productId, null);
assert.equal(f.model, "sam-3.1");
assert.equal(f.rangeDays, 30);
assert.equal(f.view, "model");
assert.ok(f.end <= new Date().toISOString().slice(0, 10));

// ---- render ----
const common = {
  product: {
    id: build.productId!,
    slug: "feeder-count",
    name: "Feeder Count",
    tagline: brief.tagline,
    ownerId: build.userId,
    inspirationId: build.inspirationId,
    rebuildOf: null,
    manifest: null,
    latestBuildId: build.id,
    liveUrl: "https://musemuse-feeder-count.vercel.app",
    demoVideoUrl: null,
    demoPosterUrl: null,
    transcriptUrl: null,
    status: "live" as const,
    createdAt: at(0),
    updatedAt: at(500),
  },
  inspiration: {
    id: build.inspirationId,
    note: "Count the birds for me",
    references: [
      {
        url: "https://example.com/feeder.jpg",
        kind: "image" as const,
        fileName: "feeder.jpg",
        contentType: "image/jpeg",
        size: 1000,
      },
      {
        url: "https://example.com/memo.wav",
        kind: "audio" as const,
        fileName: "memo.wav",
        contentType: "audio/wav",
        size: 1000,
      },
    ],
    createdAt: at(0),
  },
  history: [],
  tokens: { input: 1_200_000, cached: 600_000, output: 31_000 },
  canRefine: false,
  signedIn: false,
  origin: "https://musemuse.example",
  serverNow: t0 + 600_000,
  focusRefine: false,
  rebuild: null,
  maxFixRounds: 3,
};
const liveHtml = renderToString(
  createElement(BuildRoom, { ...common, build: { ...build, status: "live", finishedAt: at(511) }, events }),
);
for (const needle of [
  "Feeder Count",
  "Show thinking",
  "Checks passed, try 2",
  "live.",
  "/api/mcp/feeder-count",
  "Count the birds for me",
]) {
  assert.ok(liveHtml.includes(needle), `live render includes ${needle}`);
}
assert.ok(!liveHtml.includes("—"), "no em dashes in the build room");
const runningHtml = renderToString(createElement(BuildRoom, { ...common, build, events: events.slice(0, 9) }));
assert.ok(runningHtml.includes("Live preview"), "preview iframe while building");
assert.ok(runningHtml.includes('role="log"'), "streaming log is a live region");
assert.ok(runningHtml.includes("Muse Code is working"));
const fixingHtml = renderToString(createElement(BuildRoom, { ...common, build, events: events.slice(0, 13) }));
assert.ok(!fixingHtml.includes("Muse Code is working"), "a finished round isn't shown as live while fixing starts");
assert.ok(fixingHtml.includes("Muse Code is fixing what failed"));

const chartHtml = renderToString(
  createElement(StackedBars, {
    days: ["2026-10-25", "2026-10-26", "2026-10-27"],
    series: [
      { key: "gateway", label: "Products", values: [10, 2000, 50], color: "var(--chart-1)" },
      { key: "building", label: "Building", values: [0, 1_200_000, 0], color: "var(--chart-2)" },
    ],
    unit: "tokens",
    label: "Tokens",
  }),
);
assert.ok(chartHtml.includes("<svg") && chartHtml.includes("Oct 26"));
const emptyChart = renderToString(
  createElement(StackedBars, { days: ["2026-10-27"], series: [], unit: "usd", label: "Spend" }),
);
assert.ok(emptyChart.includes("No usage in this range"));

const cardHtml = renderToString(
  createElement(ProductCard, {
    p: {
      slug: "feeder-count",
      name: "Feeder Count",
      tagline: "Counts birds",
      status: "partial",
      liveUrl: null,
      demoVideoUrl: null,
      demoPosterUrl: null,
      muse: "Count my birds",
      models: ["sam-3.1"],
      buildMs: 360_000,
      costUsd: 1.12,
      fixRounds: 2,
      rebuildOf: null,
    },
  }),
);
assert.ok(cardHtml.includes("Built in 6 m") && cardHtml.includes("2 fix rounds") && cardHtml.includes("SAM 3.1"));

console.log("ui-smoke: all checks passed");
