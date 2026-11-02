/**
 * provisionStep with a stored brief whose cap this build can't have (docs/CAPABILITIES.md, 2.4a), on a real Postgres
 * (PGlite) with the sandbox, Blob, token minting and the workflow runtime faked: the build goes without the cap, says so
 * in one plain line, saves the decision once, and the stored brief keeps its block.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/__tests__/ready-provision.scenario.test.ts
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import { CAP_READY } from "@/lib/caps/ids";
import * as realSchema from "@/lib/db/schema";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { SNAPSHOTS } from "@/lib/sandbox/snapshots";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

let scripts: string[] = [];
let written: Record<string, string> = {};
let minted: Array<{ allowedModels: string[]; buildId?: string }> = [];
let missing: string[] = [];

const fakeSandbox = {
  tags: undefined as Record<string, string> | undefined,
  update: async (u: Record<string, unknown>) => {
    if (u.tags) fakeSandbox.tags = u.tags as Record<string, string>;
  },
  extendTimeout: async () => undefined,
  runCommand: async (opts: { args: string[] }) => {
    const script = opts.args[1] ?? "";
    scripts.push(script);
    const gone = missing.some((o) => script.trim().startsWith("[ -f") && script.includes(`/vercel/musemuse/caps/${o}/deps.json`));
    return { exitCode: gone ? 1 : 0, stdout: async () => "", stderr: async () => "" };
  },
  writeFiles: async (batch: Array<{ path: string; content: string | Buffer }>) => {
    for (const f of batch) written[f.path] = String(f.content);
  },
  readFileToBuffer: async ({ path }: { path: string }) => (path.endsWith("/builder.json") ? Buffer.from("{}") : null),
};

class FakeFatalError extends Error {}

const DATA = { collections: [{ name: "groceries", scope: "shared", writes: "anyone", holds: "One thing to buy.", personal: false }], signIn: "none" };
const ENV = ["DATA_ENABLED", "VERCEL", "VERCEL_ENV", "BUILDER_SNAPSHOT_ID", "MODEL_API_KEY", "PLATFORM_URL", "GATEWAY_TOKEN_PEPPER", "TRUST_SIGNED_IN_CAPS", "MUSE_APP_LOOK"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const ready = CAP_READY as Record<string, boolean>;

describe("provisioning a stored brief with a cap the build can't have", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let steps: typeof import("@/lib/pipeline/build-steps");
  let ids = { buildId: "", productId: "" };

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    (testDb as unknown as { batch: (q: PromiseLike<unknown>[]) => Promise<unknown[]> }).batch = async (queries) => {
      const out: unknown[] = [];
      for (const q of queries) out.push(await q);
      return out;
    };
    const at = (rel: string) => new URL(rel, import.meta.url).href;
    mock.module("@vercel/sandbox", { namedExports: { APIError: class APIError extends Error {}, Sandbox: { get: async () => fakeSandbox, getOrCreate: async () => fakeSandbox } } });
    mock.module(at("../../storage.ts"), { namedExports: { fetchBytes: async () => Buffer.alloc(10, 1), putFile: async (p: string, k: string) => `https://blob/${p}/${k}`, putExactFile: async (k: string) => `https://blob/${k}`, blobAuth: () => ({}) } });
    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    mock.module(at("../../gateway/tokens.ts"), {
      namedExports: {
        mintToken: async (opts: { allowedModels: string[]; buildId?: string }) => (minted.push(opts), { id: "00000000-0000-4000-8000-000000000001", token: "mm_build_sample" }),
        revokeTokens: async () => undefined,
        revokeLiveTokensExcept: async () => undefined,
        hashToken: (t: string) => t,
        findToken: async () => null,
      },
    });
    mock.module("workflow", { namedExports: { FatalError: FakeFatalError, RetryableError: FakeFatalError, getStepMetadata: () => ({ attempt: 1 }), sleep: async () => undefined } });
    steps = await import("@/lib/pipeline/build-steps");
  });
  after(() => client?.close());

  beforeEach(async () => {
    for (const k of ENV) delete process.env[k];
    Object.assign(process.env, { MODEL_API_KEY: "test-model-key", PLATFORM_URL: "http://localhost:3000", GATEWAY_TOKEN_PEPPER: "pepper", BUILDER_SNAPSHOT_ID: "snap_test_scenario" });
    scripts = [];
    written = {};
    minted = [];
    missing = [];
    fakeSandbox.tags = undefined;
    const [user] = await testDb.insert(realSchema.users).values({ email: `${Math.random()}@example.com` }).returning();
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id, note: "A shared grocery list" }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: `lists-${Math.random().toString(36).slice(2, 8)}`, name: "Lists", ownerId: user!.id }).returning();
    const [build] = await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId: user!.id, productId: product!.id, brief: { ...BRIEF, data: DATA } as never }).returning();
    ids = { buildId: build!.id, productId: product!.id };
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    ready.data = false;
    delete SNAPSHOTS.snap_test_scenario;
  });

  const provision = () => steps.provisionStep({ ...ids, slug: "lists", fixtures: [] });
  const lines = async () => (await testDb.select().from(realSchema.buildEvents).where(eq(realSchema.buildEvents.buildId, ids.buildId))).map((e) => (e.payload as { text?: string }).text);
  const row = async () => (await testDb.select().from(realSchema.builds).where(eq(realSchema.builds.id, ids.buildId)))[0]!;
  const caps = () => scripts.map((s) => s.match(/git commit -qm 'Caps: ([^']*)'/)?.[1]).find(Boolean) ?? null;

  it("with the flag off: no overlay, no marker, no prompt section, one line, the decision saved once, the stored block kept", async () => {
    await provision();
    assert.equal(caps(), null);
    assert.ok(!minted[0]!.allowedModels.includes("cap:data"));
    assert.equal(minted[0]!.buildId, undefined, "no caps, so no build namespace");
    assert.ok(!written["/vercel/app/brief.md"]!.includes("Saving data"));
    assert.deepEqual(await lines(), ["This build goes without saved data: it is switched off."]);
    const r = await row();
    assert.deepEqual(r.capsDropped, [{ cap: "data", reason: "off" }]);
    assert.deepEqual((r.brief as { data?: unknown }).data, DATA, "the stored brief keeps its block for a later build");
    await provision();
    assert.deepEqual(await lines(), ["This build goes without saved data: it is switched off."], "a retry says nothing again");
  });

  it("on and ready, locally: the cap goes in, and the decision says nothing was dropped", async () => {
    ready.data = true;
    process.env.DATA_ENABLED = "1";
    await provision();
    assert.equal(caps(), "data");
    assert.ok(minted[0]!.allowedModels.includes("cap:data"));
    assert.equal(minted[0]!.buildId, ids.buildId);
    assert.ok(written["/vercel/app/brief.md"]!.includes("### Saving data"));
    assert.deepEqual((await row()).capsDropped, []);
    assert.deepEqual((await lines()).filter((l) => l?.startsWith("This build goes without")), []);
  });

  it("on Vercel with a snapshot the manifest says lacks it: dropped at brief time with the snapshot's line", async () => {
    ready.data = true;
    process.env.DATA_ENABLED = "1";
    process.env.VERCEL = "1";
    SNAPSHOTS.snap_test_scenario = { createdAt: "", templateHash: "", capOverlays: ["core"] };
    await provision();
    assert.equal(caps(), null);
    assert.deepEqual(await lines(), ["This build goes without saved data: the builder snapshot doesn't have it yet."]);
    assert.deepEqual((await row()).capsDropped, [{ cap: "data", reason: "snapshot" }]);
  });

  it("on Vercel when the manifest is wrong and the sandbox lacks the overlay: the backstop drops it the same way", async () => {
    ready.data = true;
    process.env.DATA_ENABLED = "1";
    process.env.VERCEL = "1";
    SNAPSHOTS.snap_test_scenario = { createdAt: "", templateHash: "", capOverlays: ["core", "data"] };
    missing = ["data"];
    await provision();
    assert.equal(caps(), null);
    assert.ok(!written["/vercel/app/brief.md"]!.includes("Saving data"), "the prompt was written without it");
    assert.deepEqual(await lines(), ["This build goes without saved data: the builder snapshot doesn't have it yet."]);
    assert.deepEqual((await row()).capsDropped, [{ cap: "data", reason: "snapshot" }]);
  });
});
