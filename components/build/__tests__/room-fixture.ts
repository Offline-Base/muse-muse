import type { BuildView, InspirationView, ProductView } from "@/components/view-types";
import type { Brief, BuildEvent, BuildEventBody, MuseLogLine } from "@/lib/types";

/**
 * Stored builds for the build room: one on the session bridge with one of everything, still running, one that failed,
 * one that shipped, and a plain `muse exec` build. The tests map them onto the kit, and scripts/dev/room-fixtures.ts
 * puts them in a local database so the room can be looked at.
 */

const t0 = Date.parse("2026-10-31T12:00:00.000Z");
export const at = (s: number) => new Date(t0 + s * 1000).toISOString();

/** A flat picture standing in for a screenshot. */
export const picture = (label: string, hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="hsl(${hue} 40% 86%)"/><rect x="64" y="64" width="1152" height="96" rx="16" fill="hsl(${hue} 50% 70%)"/><rect x="64" y="208" width="540" height="528" rx="24" fill="hsl(${hue} 45% 76%)"/><rect x="676" y="208" width="540" height="240" rx="24" fill="hsl(${hue} 45% 76%)"/><rect x="676" y="496" width="540" height="240" rx="24" fill="hsl(${hue} 45% 76%)"/><text x="96" y="125" font-family="sans-serif" font-size="40" fill="#222">${label}</text></svg>`,
  )}`;

export const PREVIEW = `data:text/html,${encodeURIComponent(
  `<!doctype html><title>Preview</title><body style="margin:0;font:18px system-ui;background:#fbf7ef;color:#222"><header style="padding:24px 32px;background:#2d5a3d;color:#fff;font-size:24px">Feeder Count</header><main style="padding:32px"><p>Drop a short clip of your feeder.</p><div style="height:220px;border:2px dashed #2d5a3d;border-radius:16px;display:grid;place-items:center">Upload a clip</div></main>`,
)}`;

export const brief: Brief = {
  verdict: "partly",
  refusal: null,
  name: "Feeder Count",
  slug: "feeder-count",
  tagline: "Counts and outlines the birds in a short feeder video.",
  user: "Backyard bird watchers",
  inspiration: {
    summary: "A short phone video of birds at a feeder.",
    references: [{ index: 0, kind: "image", describes: "Three sparrows at a tube feeder" }],
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

const ENGINE_LINE = "Muse Code runs this round on its session host, so its owner can steer it. It has 6 agent slots, every reminder and the platform's hooks and build tools.";

const question: MuseLogLine = {
  kind: "question",
  itemId: "question:ui-1",
  text: "Muse Code asks: Which layout should the results use?",
  detail: {
    question: {
      userInputId: "ui-1",
      questions: [{ id: "layout", header: "Layout", text: "Which layout should the results use?", options: ["Grid", "List"], descriptions: ["Square tiles", ""] }],
    },
  },
};

/** A session bridge round with one of everything, as the condenser makes it. */
export const bridgeLines: MuseLogLine[] = [
  { kind: "start", text: "Started" },
  { kind: "goal", itemId: "goal", text: "Goal: Build Feeder Count", detail: { goal: { objective: "Build Feeder Count.\n\n1. `npm run verify` exits 0.", status: "active", percentComplete: 40 } } },
  {
    kind: "todo",
    itemId: "todos",
    text: "Todo list: 1 of 3 done",
    detail: {
      todos: [
        { text: "Write the upload page", status: "completed" },
        { text: "Add the count route", status: "inProgress" },
        { text: "An old idea", status: "cancelled" },
      ],
    },
  },
  { kind: "reasoning", itemId: "r1", text: "The brief wants the upload first." },
  { kind: "say", itemId: "m1", text: "I'm starting with the upload page, then the route that counts birds." },
  { kind: "tool", itemId: "d1", tool: "mcp__musemuse__docs_read", ok: true, text: "Read a Meta docs page", detail: { status: "completed", source: { kind: "docs", title: "media-segmentation" } } },
  { kind: "tool", itemId: "d2", tool: "mcp__musemuse__docs_search", ok: true, text: "Searched the docs", detail: { status: "completed", source: { kind: "docs-search", title: "track objects in video" } } },
  { kind: "tool", itemId: "d3", tool: "mcp__musemuse__models_list", ok: true, text: "Listed the models", detail: { status: "completed" } },
  { kind: "tool", itemId: "d4", tool: "read_skill", ok: true, text: "Read a skill", detail: { status: "completed", source: { kind: "skill", title: "meta-ui" } } },
  { kind: "status", itemId: "w0", text: "Web search", detail: { source: { kind: "web", title: "sparrow field marks" } } },
  { kind: "edit", itemId: "t1#patch", files: 3, added: 120, removed: 4, text: "Edited 3 files (+120 −4)" },
  { kind: "tool", itemId: "t1", tool: "edit_file", ok: true, text: "Edited `app/page.tsx`", detail: { status: "completed" } },
  { kind: "tool", itemId: "t2", tool: "bash", text: "Install the packages", detail: { status: "inProgress" } },
  { kind: "subagent", itemId: "s1", text: "Subagent scout finished: Found 3 pages.", ok: true, detail: { status: "completed", agentPath: "main/scout/1", label: "scout" } },
  { kind: "subagent", itemId: "s2", text: "Subagent helper is working", detail: { status: "inProgress", agentPath: "main/scout/1/helper/1", label: "helper" } },
  { kind: "hook", itemId: "h1", text: "PreToolUse hook blocked: .env belongs to the platform", ok: false, detail: { status: "blocked", hookEvent: "preToolUse" } },
  { kind: "compaction", itemId: "k1", text: "Muse Code compacted its context from 812k to 41k tokens", detail: { status: "compacted" } },
  {
    kind: "workflow",
    itemId: "w1",
    text: "Workflow check-everything is running",
    detail: {
      status: "inProgress",
      label: "check-everything",
      phase: "Check",
      workflowRunId: "run-1",
      children: [
        { label: "Typecheck", status: "completed" },
        { label: "Smoke test", status: "running" },
      ],
    },
  },
  { kind: "steer", itemId: "command:c1", text: "Use a grid, not a list.", ok: true, detail: { delivery: "steer", status: "delivered" } },
  { kind: "steer", itemId: "command:c2", text: "Too late?", ok: false, detail: { delivery: "steer", status: "refused", error: "no turn is running" } },
  ...["verify", "goal", "skill", "todo"].map((name, i): MuseLogLine => ({ kind: "reminder", itemId: `o${i}`, text: `${name} observer ran`, ok: true, detail: { reminder: name, status: "completed" } })),
  question,
];

const owner: BuildEventBody[] = [
  { type: "control", round: 0, action: "steer", text: "Use a grid, not a list.", ok: true, commandIds: ["c1"] },
  { type: "control", round: 0, action: "steer", text: "Too late?", ok: true, commandIds: ["c2"] },
];

const execLines: MuseLogLine[] = [
  { kind: "start", text: "Started" },
  { kind: "say", text: "I'll write the upload page first." },
  ...Array.from({ length: 6 }, (_, i): MuseLogLine => ({ kind: "tool", tool: "bash", ok: true, text: `Run step ${i + 1}` })),
  { kind: "edit", files: 2, added: 40, removed: 1, text: "Edited 2 files (+40 −1)" },
  { kind: "tool", tool: "read_file", ok: false, text: "Couldn't read `missing.ts`" },
  { kind: "usage", text: "Input 12k · Output 3k" },
  { kind: "done", text: "The upload page and the count route are in. It counts birds in a clip and outlines each one." },
];

const shots = [
  { url: picture("Upload", 140), caption: "The upload page" },
  { url: picture("Results", 200), caption: "Birds outlined" },
];

const passing = { passed: true, steps: [{ name: "typecheck", ok: true, ms: 12000 }, { name: "build", ok: true, ms: 41000 }, { name: "start", ok: true, ms: 3000 }, { name: "console", ok: true }, { name: "smoke", ok: true, ms: 9000 }], failureOutput: "" };
const failing = {
  passed: false,
  steps: [{ name: "typecheck", ok: true, ms: 12000 }, { name: "build", ok: false, ms: 21000, detail: "Module not found: ./count" }, { name: "start", ok: false }],
  failureOutput: "Error: Module not found: Can't resolve './count'\n  at app/api/route.ts:3",
};

const opening: BuildEventBody[] = [
  { type: "status", status: "briefing", step: "brief" },
  { type: "brief", brief },
  { type: "cost", totalUsd: 0.02, addedUsd: 0.02, what: "brief" },
  { type: "status", status: "provisioning", step: "provision" },
  { type: "status", status: "building", step: "build" },
];

const running: BuildEventBody[] = [
  ...opening,
  { type: "log", text: ENGINE_LINE },
  { type: "muse", round: 0, lines: bridgeLines },
  { type: "cost", totalUsd: 0.62, addedUsd: 0.6, what: "muse" },
  { type: "preview", url: PREVIEW },
  ...owner,
];

const failed: BuildEventBody[] = [
  ...opening,
  { type: "muse", round: 0, lines: execLines },
  { type: "cost", totalUsd: 0.5, addedUsd: 0.48, what: "muse" },
  { type: "status", status: "previewing", step: "preview" },
  { type: "preview", url: PREVIEW },
  { type: "status", status: "verifying", step: "verify" },
  { type: "verify", round: 0, summary: failing, screenshots: [] },
  { type: "status", status: "fixing", step: "fix" },
  { type: "log", text: "Muse Code runs this round with muse exec." },
  { type: "muse", round: 1, lines: [{ kind: "say", text: "The route imported a file I hadn't written. Adding it." }, { kind: "tool", tool: "edit_file", ok: true, text: "Edited `app/api/count.ts`" }, { kind: "done", text: "Added the missing file." }] },
  { type: "cost", totalUsd: 0.81, addedUsd: 0.31, what: "fix" },
  { type: "status", status: "verifying", step: "verify" },
  { type: "verify", round: 1, summary: passing, screenshots: shots },
  { type: "judge", round: 1, verdict: { pass: false, reasons: ["The upload button does nothing."], mismatches: ["The brief asks for a count, and the page shows none."] } },
  { type: "error", message: "The checks didn't pass after the last fix round." },
  { type: "status", status: "failed", step: "verify", message: "The checks didn't pass after the last fix round." },
];

const finished: BuildEventBody[] = [
  ...opening,
  { type: "log", text: "Muse Code runs this round on its session host, so its owner can steer it." },
  { type: "muse", round: 0, lines: [...bridgeLines.filter((l) => l.kind !== "question"), { kind: "done", text: "Feeder Count is ready. Drop in a clip, and it outlines each bird and gives you a count." }] },
  { type: "cost", totalUsd: 0.9, addedUsd: 0.88, what: "muse" },
  ...owner,
  { type: "status", status: "previewing", step: "preview" },
  { type: "preview", url: PREVIEW },
  { type: "status", status: "verifying", step: "verify" },
  { type: "verify", round: 0, summary: passing, screenshots: shots },
  { type: "judge", round: 0, verdict: { pass: true, reasons: ["The upload page matches the brief."], mismatches: [] } },
  { type: "status", status: "recording", step: "record" },
  { type: "recording", url: "/fixture-demo.mp4", posterUrl: picture("Demo", 40) },
  { type: "status", status: "deploying", step: "deploy" },
  { type: "deploy", url: "https://feeder-count.example.com" },
  { type: "status", status: "live", step: "deploy" },
];

const exec: BuildEventBody[] = [
  ...opening,
  { type: "muse", round: 0, lines: execLines.filter((l) => l.kind !== "done" && l.kind !== "usage") },
  { type: "cost", totalUsd: 0.2, addedUsd: 0.18, what: "muse" },
];

const stamp = (bodies: BuildEventBody[]): BuildEvent[] => bodies.map((b, i) => ({ ...b, id: i + 1, at: at(10 * (i + 1)) }) as BuildEvent);

export const IDS = {
  user: "00000000-0000-4000-8000-000000000001",
  inspiration: "00000000-0000-4000-8000-000000000002",
  products: {
    running: "00000000-0000-4000-8000-00000000000a",
    failed: "00000000-0000-4000-8000-00000000000b",
    finished: "00000000-0000-4000-8000-00000000000c",
    exec: "00000000-0000-4000-8000-00000000000d",
  },
  running: "11111111-1111-4111-8111-111111111111",
  failed: "22222222-2222-4222-8222-222222222222",
  finished: "33333333-3333-4333-8333-333333333333",
  exec: "44444444-4444-4444-8444-444444444444",
} as const;

const buildView = (name: keyof typeof IDS.products, id: string, status: BuildView["status"], step: string, over: Partial<BuildView> = {}): BuildView => ({
  id,
  kind: "build",
  message: null,
  rebuildOf: null,
  productId: IDS.products[name],
  userId: IDS.user,
  inspirationId: IDS.inspiration,
  status,
  step,
  brief,
  buildModel: "muse-wonder-1.0",
  museSessionId: "0a3f3611-f27d-498f-b5a6-999d1d24fdbe",
  fixRounds: 0,
  previewUrl: null,
  costUsd: 0,
  error: null,
  startedAt: at(0),
  finishedAt: null,
  ...over,
});

export const inspiration: InspirationView = {
  id: IDS.inspiration,
  note: "Count the birds at my feeder from a short video and outline each one.",
  references: [
    { url: picture("Feeder", 90), kind: "image", fileName: "feeder.jpg", contentType: "image/jpeg", size: 1000 },
    { url: "https://example.com/feeder-notes.pdf", kind: "pdf", fileName: "feeder-notes.pdf", contentType: "application/pdf", size: 1000 },
  ],
  createdAt: at(0),
};

const productView = (name: keyof typeof IDS.products, latest: string, status: ProductView["status"]): ProductView => ({
  id: IDS.products[name],
  slug: `feeder-count-${name}`,
  name: "Feeder Count",
  tagline: brief.tagline,
  ownerId: IDS.user,
  status,
  liveUrl: status === "live" ? "https://feeder-count.example.com" : null,
  latestBuildId: latest,
  demoVideoUrl: null,
  demoPosterUrl: null,
  inspirationId: IDS.inspiration,
  rebuildOf: null,
  manifest: null,
  transcriptUrl: null,
  createdAt: at(0),
  updatedAt: at(600),
});

export const tokens = { input: 412_000, cached: 90_000, output: 38_000 };

export const FIXTURES = {
  running: {
    build: buildView("running", IDS.running, "building", "build", { previewUrl: PREVIEW, costUsd: 0.62 }),
    product: productView("running", IDS.running, "building"),
    events: stamp(running),
  },
  failed: {
    build: buildView("failed", IDS.failed, "failed", "verify", { previewUrl: PREVIEW, costUsd: 0.81, fixRounds: 1, error: "The checks didn't pass after the last fix round.", finishedAt: at(400) }),
    product: productView("failed", IDS.failed, "failed"),
    events: stamp(failed),
  },
  finished: {
    build: buildView("finished", IDS.finished, "live", "deploy", { previewUrl: PREVIEW, costUsd: 0.9, finishedAt: at(600) }),
    product: productView("finished", IDS.finished, "live"),
    events: stamp(finished),
  },
  exec: {
    build: buildView("exec", IDS.exec, "building", "build", { costUsd: 0.2, museSessionId: null }),
    product: productView("exec", IDS.exec, "building"),
    events: stamp(exec),
  },
};
