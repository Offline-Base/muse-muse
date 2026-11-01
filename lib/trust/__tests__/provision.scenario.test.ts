/**
 * provisionSandbox and reopenSandbox with the trust overlay, with the sandbox and Blob faked: the records go in
 * root-owned before the overlay is applied, both before the user's files land, .env.local gets MUSEMUSE_BUILD=1, and a
 * change to a product built with the overlay keeps it. Without the overlay, nothing of it happens.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/trust/__tests__/provision.scenario.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { parseGeoCountries } from "@/lib/trust/geo";
import { trustOverlayFor } from "@/lib/trust/overlay";

const canMock = typeof (mock as { module?: unknown }).module === "function";
let order: string[] = [];
let sudo: string[] = [];
let written: Array<{ path: string; text: string }> = [];
let files: Record<string, string> = {};
/** Answers each command; unset, every command passes. */
let onCommand: ((script: string) => number) | null = null;

const fakeSandbox = {
  tags: undefined as Record<string, string> | undefined,
  update: async (u: Record<string, unknown>) => {
    if (u.tags) fakeSandbox.tags = u.tags as Record<string, string>;
  },
  extendTimeout: async () => undefined,
  runCommand: async (opts: { args: string[]; sudo?: boolean }) => {
    const script = opts.args[1] ?? "";
    order.push(`run: ${script.split("\n").find((l) => l.trim() && !l.startsWith("set -")) ?? ""}`);
    if (opts.sudo) sudo.push(script);
    return { exitCode: onCommand ? onCommand(script) : 0, stdout: async () => "", stderr: async () => "" };
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
  slug: "bird-count",
  references: [],
  fixtures: [{ fileName: "feeder.jpg", url: "https://b/feeder.jpg" }],
  promptMarkdown: "# Build this product\n",
  buildToken: "mm_build_sample",
  gatewayUrl: "https://platform.example/api/gateway",
};
const TRUST = trustOverlayFor(BRIEF, {
  slug: "bird-count",
  platformUrl: "https://platform.example",
  flags: { ageGate: true, legalPages: true, geoBlock: true, geoCountries: parseGeoCountries("meta"), reports: true },
});
const SAVED = { MODEL_API_KEY: process.env.MODEL_API_KEY, BUILDER_SNAPSHOT_ID: process.env.BUILDER_SNAPSHOT_ID, VERCEL: process.env.VERCEL };

describe("the trust overlay at provision", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module("@vercel/sandbox", {
      namedExports: { APIError: class APIError extends Error {}, Sandbox: { get: async () => fakeSandbox, getOrCreate: async () => fakeSandbox } },
    });
    mock.module(new URL("../../storage.ts", import.meta.url).href, {
      namedExports: { putFile: async (p: string, k: string) => `https://blob/${p}/${k}`, fetchBytes: async () => Buffer.alloc(1000, 1) },
    });
    builder = await import("@/lib/sandbox/builder");
  });
  beforeEach(() => {
    order = [];
    sudo = [];
    written = [];
    onCommand = null;
    files = { "/vercel/musemuse/builder.json": "{}" };
    process.env.MODEL_API_KEY = "test-model-key";
    process.env.BUILDER_SNAPSHOT_ID = "snap_test";
    delete process.env.VERCEL;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(SAVED)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  it("keeps the records root-owned, applies the overlay before the user's files, and turns the gate off for tests", async () => {
    await builder.provisionSandbox({ ...INPUT, trust: TRUST });
    const at = (match: (line: string) => boolean) => order.findIndex(match);
    const records = at((l) => l === "write: /vercel/musemuse/run/trust/musemuse.trust.json");
    const owned = at((l) => l.startsWith("run: mkdir -p '/vercel/musemuse/trust'"));
    const apply = at((l) => l.includes("Trust: privacy, terms, age gate, report link"));
    const brief = at((l) => l === "write: /vercel/app/brief.md");
    assert.ok(records >= 0 && owned > records && apply > owned && brief > apply, order.join("\n"));
    assert.ok(sudo.some((s) => s.includes("chown root:root '/vercel/musemuse/trust'/musemuse.trust.json") && s.includes("chmod 444")), "root-owned and read-only");
    const trust = JSON.parse(written.find((w) => w.path.endsWith("/run/trust/musemuse.trust.json"))!.text);
    assert.equal(trust.reportUrl, "https://platform.example/report/bird-count");
    assert.ok(JSON.parse(written.find((w) => w.path.endsWith("/run/trust/musemuse.privacy.json"))!.text).models.length);
    const envLocal = written.filter((w) => w.path === "/vercel/app/.env.local");
    assert.equal(envLocal.length, 1);
    assert.match(envLocal[0]!.text, /\nPRODUCT_TOKEN=[^\n]+\nMUSEMUSE_BUILD=1\n$/);
  });

  it("does none of it without the overlay", async () => {
    await builder.provisionSandbox(INPUT);
    assert.ok(!order.some((l) => l.includes("/vercel/musemuse/trust") || l.includes("Trust: ")), order.join("\n"));
    assert.ok(!written.some((w) => w.path.includes("/trust/")));
    assert.ok(!written.find((w) => w.path === "/vercel/app/.env.local")!.text.includes("MUSEMUSE_BUILD"));
  });

  it("a change keeps MUSEMUSE_BUILD=1 for a product built with the overlay, and adds nothing to one without", async () => {
    const base = { sandboxName: "product-bird-count-11111111", productId: INPUT.productId, buildToken: "mm_build_change", gatewayUrl: INPUT.gatewayUrl, newReferences: [] };
    await builder.reopenSandbox(base);
    const plain = written.find((w) => w.path === "/vercel/app/.env.local")!.text;
    assert.ok(!plain.includes("MUSEMUSE_BUILD"));
    written = [];
    files["/vercel/musemuse/trust/musemuse.trust.json"] = "{}";
    await builder.reopenSandbox(base);
    assert.equal(written.find((w) => w.path === "/vercel/app/.env.local")!.text, `${plain}MUSEMUSE_BUILD=1\n`);
  });

  it("refuses on the live site when the snapshot has no trust overlay, and copies it in on a local run", async () => {
    onCommand = (script) => (script.includes("/vercel/musemuse/caps/trust/platform-files.json") ? 1 : 0);
    process.env.MUSEMUSE_TEMPLATE_DIR = new URL("../../../template", import.meta.url).pathname;
    try {
      await builder.provisionSandbox({ ...INPUT, trust: TRUST });
      assert.ok(written.some((w) => w.path.includes("caps/trust/files/proxy.ts")), "the overlay was copied in from this checkout");
      process.env.VERCEL = "1";
      await assert.rejects(builder.provisionSandbox({ ...INPUT, trust: TRUST }), /doesn't have the trust overlay/);
    } finally {
      delete process.env.MUSEMUSE_TEMPLATE_DIR;
    }
  });
});
