/**
 * provisionSandbox with the muse-app look (MUSE_APP_LOOK, docs/BRAND.md), with the sandbox and Blob faked: off changes
 * nothing; on applies the overlay before anything from the user lands; a snapshot without the overlay fails on the live
 * site and gets it from this checkout on a local run.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/sandbox/__tests__/look.scenario.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { NATIVE_TEMPLATE_FILES } from "@/lib/native/template-source";
import { BUILDER_MARKER } from "@/lib/sandbox/paths";
import { readCapFiles, readTargetFiles, readTemplateFiles, templateHash } from "@/lib/sandbox/setup";

/** Everything the fake sandbox was asked to do, in order. */
let events: Array<{ kind: "run"; script: string; sudo: boolean; cwd?: string } | { kind: "write"; paths: string[] }> = [];
/** What each written file holds, by its path in the sandbox. */
let contents: Record<string, string> = {};
/** Whether the snapshot holds the muse-app overlay. */
let hasOverlay = true;
/** The snapshot's builder marker. */
let marker = "{}";

const fakeSandbox = {
  tags: { app: "musemuse", role: "product", product: "3f2a9c1e-77b0-4d2e-9f00-0123456789ab" },
  update: async () => {},
  runCommand: async (opts: { args: string[]; sudo?: boolean; cwd?: string }) => {
    const script = opts.args[1] ?? "";
    events.push({ kind: "run", script, sudo: Boolean(opts.sudo), cwd: opts.cwd });
    const probe = script.startsWith("[ -f ") && script.includes("/targets/muse-app/deps.json");
    return { exitCode: probe && !hasOverlay ? 1 : 0, stdout: async () => "", stderr: async () => "" };
  },
  writeFiles: async (batch: Array<{ path: string; content?: string | Buffer }>) => {
    events.push({ kind: "write", paths: batch.map((f) => f.path) });
    for (const f of batch) contents[f.path] = String(f.content ?? "");
  },
  readFileToBuffer: async ({ path }: { path: string }) => (path === BUILDER_MARKER ? Buffer.from(marker) : null),
};

const canMock = typeof (mock as { module?: unknown }).module === "function";
let builder: typeof import("../builder");
const SAVED = Object.fromEntries(["MODEL_API_KEY", "BUILDER_SNAPSHOT_ID", "PLATFORM_URL", "VERCEL"].map((n) => [n, process.env[n]]));

before(async () => {
  if (!canMock) return;
  mock.module("@vercel/sandbox", {
    namedExports: { APIError: class APIError extends Error {}, Sandbox: { getOrCreate: async () => fakeSandbox, get: async () => fakeSandbox } },
  });
  mock.module(new URL("../../storage.ts", import.meta.url).href, {
    namedExports: { putFile: async () => "https://blob/x", fetchBytes: async () => Buffer.from("x") },
  });
  builder = await import("../builder");
});

after(() => {
  for (const [n, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
});

beforeEach(() => {
  events = [];
  contents = {};
  hasOverlay = true;
  marker = "{}";
  process.env.MODEL_API_KEY = "test-model-key";
  process.env.BUILDER_SNAPSHOT_ID = "snap_test";
  process.env.PLATFORM_URL = "https://musemuse.example";
  delete process.env.VERCEL;
});

const provision = (museAppLook?: boolean, targets?: string[], extraFiles: Array<{ path: string; content: string }> = [{ path: "lib/native/bridge.ts", content: "export {};\n" }]) =>
  builder.provisionSandbox({
    buildId: "b1",
    productId: "3f2a9c1e-77b0-4d2e-9f00-0123456789ab",
    slug: "bird-finder",
    references: [],
    fixtures: [],
    promptMarkdown: "# Build this product\n",
    buildToken: "mm_build_x",
    gatewayUrl: "https://g",
    ...(museAppLook === undefined ? {} : { museAppLook }),
    ...(targets ? { targets, extraFiles } : {}),
  });

const runs = () => events.flatMap((e) => (e.kind === "run" ? [e] : []));
const isApply = (script: string) => script.includes("Look: muse-app");
/** Where in the event list the user's files (brief.md, .env.local) were written. */
const userFilesAt = () => events.findIndex((e) => e.kind === "write" && e.paths.some((p) => p.endsWith("/brief.md")));

describe("provisionSandbox and the muse-app look", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  it("leaves the template as it is when the flag is off", async () => {
    for (const flag of [undefined, false]) {
      events = [];
      await provision(flag);
      assert.equal(runs().filter((r) => isApply(r.script) || r.script.includes("/targets")).length, 0);
      assert.ok(userFilesAt() >= 0, "still writes the user's files");
    }
  });

  it("applies the overlay from the snapshot in the product, as the default user, before the user's files", async () => {
    await provision(true);
    const apply = events.findIndex((e) => e.kind === "run" && isApply(e.script));
    assert.ok(apply >= 0, "ran applyLookScript");
    const run = events[apply] as { cwd?: string; sudo: boolean };
    assert.equal(run.cwd, "/vercel/app");
    assert.equal(run.sudo, false);
    assert.ok(apply < userFilesAt(), "before brief.md and .env.local");
    assert.ok(!events.some((e) => e.kind === "write" && e.paths.some((p) => p.includes("/targets/"))), "the snapshot had it, so nothing was copied in");
  });

  it("applies the look, then a brief's targets, then their extra files and the user's files", async () => {
    await provision(true, ["web", "vr", "agent"]);
    const look = events.findIndex((e) => e.kind === "run" && isApply(e.script));
    const active = events.findIndex((e) => e.kind === "run" && e.sudo && e.script.includes("active.json"));
    const target = events.findIndex((e) => e.kind === "run" && e.script.includes("'Target: vr, agent'"));
    const extra = events.findIndex((e) => e.kind === "write" && e.paths.includes("/vercel/app/lib/native/bridge.ts"));
    assert.ok(look >= 0 && active >= 0 && target >= 0 && extra >= 0, JSON.stringify({ look, active, target, extra }));
    assert.ok(look < active && active < target && target <= userFilesAt() && extra <= userFilesAt(), "look, targets, then the files");
    assert.equal((events[target] as { cwd?: string }).cwd, "/vercel/app");
    for (const t of ["vr", "agent"]) assert.match((events[target] as { script: string }).script, new RegExp(`/vercel/musemuse/targets/${t}/files`));
    assert.doesNotMatch((events[target] as { script: string }).script, /muse-app/, "the look isn't a target");
  });

  it("fails on the live site when the snapshot is older than the overlay, before the user's files", async () => {
    hasOverlay = false;
    process.env.VERCEL = "1";
    await assert.rejects(provision(true), /doesn't have the muse-app overlay\. Make a new one with npm run snapshot before turning MUSE_APP_LOOK on/);
    assert.equal(userFilesAt(), -1);
    assert.ok(!runs().some((r) => isApply(r.script)));
  });

  it("adds the overlay from this checkout on a local run with an older snapshot, then applies it", async () => {
    hasOverlay = false;
    await provision(true);
    const copied = events.findIndex((e) => e.kind === "write" && e.paths.some((p) => p.includes("/targets/muse-app/files/app/muse-app.css")));
    assert.ok(copied >= 0, "wrote the overlay's files");
    const written = events.filter((e) => e.kind === "write").flatMap((e) => e.paths);
    assert.ok(!written.some((p) => p.includes("/targets/glasses/")), "only the overlay it needs");
    const install = events.findIndex((e) => e.kind === "run" && e.sudo && e.script.includes("cp -R"));
    const apply = events.findIndex((e) => e.kind === "run" && isApply(e.script));
    assert.ok(copied < install && install < apply && apply < userFilesAt(), "copy, install as root, apply, then the user's files");
  });

  it("writes a phone product's manifest and icon in the look's colors, and in meta-ui's with the flag off", async () => {
    const native = NATIVE_TEMPLATE_FILES.map((f) => ({ ...f }));
    const manifest = "/vercel/app/app/manifest.ts";
    const icon = "/vercel/app/lib/native/app-icon.tsx";
    await provision(true, ["web", "phone"], native);
    assert.match(contents[manifest]!, /background_color: "#ffffff"/);
    assert.match(contents[manifest]!, /theme_color: "#ffffff"/);
    assert.match(contents[icon]!, /background: "#0064d4"/);
    assert.equal(contents["/vercel/app/lib/native/bridge.ts"], native.find((f) => f.path === "lib/native/bridge.ts")!.content, "other files as they are");
    for (const flag of [undefined, false]) {
      contents = {};
      await provision(flag, ["web", "phone"], native);
      for (const f of native) assert.equal(contents[`/vercel/app/${f.path}`], f.content, `${f.path} with the flag ${flag}`);
    }
  });

  it("warns on a local run when the snapshot's template isn't this checkout's, and stays quiet otherwise", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    // The snapshot's own hash (setupBuilder, make-builder-snapshot.ts): the template, its targets, then its caps.
    const here = templateHash([...(await readTemplateFiles("template")), ...(await readTargetFiles("template")), ...(await readCapFiles("template"))]);
    marker = JSON.stringify({ templateHash: "a20419febcfc" });
    await provision(true);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0]!.arguments[0]), new RegExp(`snapshot snap_test has template a20419febcfc, and template/ here is ${here}\\..*TEST_MODEL swap.*npm run snapshot`));
    for (const m of [JSON.stringify({ templateHash: here }), "{}", "not json"]) {
      marker = m;
      await provision(true);
    }
    process.env.VERCEL = "1";
    marker = JSON.stringify({ templateHash: "a20419febcfc" });
    await provision(false);
    assert.equal(warn.mock.callCount(), 1, "same hash, no hash, a bad marker or the live site: no warning");
  });
});
