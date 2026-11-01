/**
 * applyCaps' backstop (docs/CAPABILITIES.md, 2.4a) in provisionSandbox, with the sandbox and Blob faked: on a local run
 * a missing overlay is copied in from this checkout; on the live site the build goes without that cap (dropCaps)
 * before anything is applied, or fails with one plain line when it can't; core missing, or a pristine verify.mjs from
 * before the caps step, drops every cap.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/__tests__/ready.scenario.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";

const canMock = typeof (mock as { module?: unknown }).module === "function";
let order: string[] = [];
let scripts: string[] = [];
let written: Array<{ path: string; text: string }> = [];
let files: Record<string, string> = {};
let missing: string[] = [];
let stale = false;

const fakeSandbox = {
  tags: undefined as Record<string, string> | undefined,
  update: async (u: Record<string, unknown>) => {
    if (u.tags) fakeSandbox.tags = u.tags as Record<string, string>;
    if (u.networkPolicy) order.push("lock");
  },
  extendTimeout: async () => undefined,
  runCommand: async (opts: { args: string[] }) => {
    const script = opts.args[1] ?? "";
    scripts.push(script);
    order.push(`run: ${script.split("\n").find((l) => l.trim() && !l.startsWith("set -")) ?? ""}`);
    const gone = missing.some((o) => script.includes(`/vercel/musemuse/caps/${o}/deps.json`) && script.trim().startsWith("[ -f"));
    const old = stale && script.includes("grep -q") && script.includes("musemuse_caps");
    return { exitCode: gone || old ? 1 : 0, stdout: async () => "", stderr: async () => "" };
  },
  writeFiles: async (batch: Array<{ path: string; content: string | Buffer }>) => {
    for (const f of batch) {
      written.push({ path: f.path, text: String(f.content) });
      order.push(`write: ${f.path}`);
    }
  },
  readFileToBuffer: async ({ path }: { path: string }) => (path in files ? Buffer.from(files[path]!) : null),
};

let builder: typeof import("@/lib/sandbox/builder");

const INPUT = {
  buildId: "b1",
  productId: "11111111-2222-4333-8444-555555555555",
  slug: "lists",
  references: [],
  fixtures: [],
  promptMarkdown: "# Build this product\n\n## Platform services\n\n### Saving data\n",
  buildToken: "mm_build_sample",
  gatewayUrl: "https://platform.example/api/gateway",
  caps: { caps: ["data", "runtime"], overlays: ["core", "data", "runtime"] },
  capEnv: "MUSEMUSE_PYTHON=local\n",
  capHosts: ["pypi.org"],
};
const SAVED = { MODEL_API_KEY: process.env.MODEL_API_KEY, BUILDER_SNAPSHOT_ID: process.env.BUILDER_SNAPSHOT_ID, VERCEL: process.env.VERCEL, MUSEMUSE_TEMPLATE_DIR: process.env.MUSEMUSE_TEMPLATE_DIR };

describe("the caps backstop at provision", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module("@vercel/sandbox", {
      namedExports: { APIError: class APIError extends Error {}, Sandbox: { get: async () => fakeSandbox, getOrCreate: async () => fakeSandbox } },
    });
    mock.module(new URL("../../storage.ts", import.meta.url).href, {
      namedExports: { putFile: async (p: string, k: string) => `https://blob/${p}/${k}`, fetchBytes: async () => Buffer.alloc(10, 1) },
    });
    builder = await import("@/lib/sandbox/builder");
  });
  beforeEach(() => {
    order = [];
    scripts = [];
    written = [];
    missing = [];
    stale = false;
    files = { "/vercel/musemuse/builder.json": "{}" };
    process.env.MODEL_API_KEY = "test-model-key";
    process.env.BUILDER_SNAPSHOT_ID = "snap_test";
    process.env.MUSEMUSE_TEMPLATE_DIR = new URL("../../../template", import.meta.url).pathname;
    delete process.env.VERCEL;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(SAVED)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  const brief = () => written.find((w) => w.path === "/vercel/app/brief.md")?.text ?? "";
  /** The caps commit applyCapsScript makes, or null when no caps were applied. */
  const commit = () => scripts.map((x) => x.match(/git commit -qm 'Caps: ([^']*)'/)?.[1]).find(Boolean) ?? null;
  const applied = () => commit() !== null;

  it("a local run copies a missing overlay in from this checkout and applies every cap", async () => {
    missing = ["data"];
    const asked: string[][] = [];
    await builder.provisionSandbox({ ...INPUT, dropCaps: async (c) => (asked.push(c), { promptMarkdown: "x" }) });
    assert.deepEqual(asked, [], "nothing is dropped locally");
    assert.ok(written.some((w) => w.path.includes("caps/data/files/lib/platform/data.ts")), "the data overlay was copied in");
    assert.ok(applied(), order.join("\n"));
  });

  it("the live site drops the cap whose overlay is missing before anything is applied, and builds the rest", async () => {
    process.env.VERCEL = "1";
    missing = ["data"];
    const asked: string[][] = [];
    await builder.provisionSandbox({
      ...INPUT,
      dropCaps: async (c) => (asked.push(c), { promptMarkdown: "# Build this product\n\nwithout saving\n", caps: { caps: ["runtime"], overlays: ["core", "runtime"] }, capEnv: "MUSEMUSE_PYTHON=local\n", capHosts: ["pypi.org"] }),
    });
    assert.deepEqual(asked, [["data"]]);
    assert.equal(brief(), "# Build this product\n\nwithout saving\n");
    assert.equal(commit(), "runtime", "the caps that are left are applied");
    const firstApply = order.findIndex((l) => l.startsWith("run:") && l.includes("musemuse.caps.json"));
    const lock = order.indexOf("lock");
    assert.ok(order.findIndex((l) => l.includes("/vercel/musemuse/caps/data/deps.json")) < lock, "checked before the egress lock and the first apply");
    assert.ok(firstApply === -1 || firstApply > lock);
  });

  it("core missing, or a verify.mjs from before the caps step, drops every cap and applies none", async () => {
    process.env.VERCEL = "1";
    for (const setup of [() => (missing = ["core"]), () => (stale = true)]) {
      order = [];
      scripts = [];
      written = [];
      missing = [];
      stale = false;
      setup();
      const asked: string[][] = [];
      await builder.provisionSandbox({ ...INPUT, dropCaps: async (c) => (asked.push(c), { promptMarkdown: "# plain\n" }) });
      assert.deepEqual(asked, [["data", "runtime"]]);
      assert.equal(applied(), false, order.join("\n"));
      assert.equal(brief(), "# plain\n");
      assert.ok(!written.find((w) => w.path === "/vercel/app/.env.local")!.text.includes("MUSEMUSE_PYTHON"), "no cap env left");
    }
  });

  it("without a way to drop it, the live site fails with one plain line naming the cap", async () => {
    process.env.VERCEL = "1";
    missing = ["runtime"];
    await assert.rejects(builder.provisionSandbox(INPUT), (err: Error) => {
      assert.equal(err.message, "This builder snapshot doesn't have runtime. An admin has to make a new builder snapshot (npm run snapshot) and commit lib/sandbox/snapshots.json.");
      return true;
    });
  });

  it("with every overlay there, nothing is dropped and the caps go in as before", async () => {
    process.env.VERCEL = "1";
    let asked = false;
    await builder.provisionSandbox({ ...INPUT, dropCaps: async () => ((asked = true), { promptMarkdown: "x" }) });
    assert.equal(asked, false);
    assert.equal(commit(), "data, runtime");
    assert.equal(brief(), INPUT.promptMarkdown);
  });
});
