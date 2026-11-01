/**
 * The code cap's database (lib/caps/code/store.ts) on an in-memory PGlite migrated with drizzle/: codeProof names only
 * the parts whose routes are on, and a build's exec_runs rows go when it ends or, for a crashed build, after two days,
 * while live rows stay (CAP_CLEANUPS, docs/CAPABILITIES.md 2.9 and 15a).
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/code/__tests__/store.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

describe("the code cap's rows", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let store: typeof import("../store");
  let codeCleanup: typeof import("../cleanup");
  let cleanup: typeof import("../../cleanup");
  let productId = "";
  let buildId = "";
  let otherBuild = "";

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    store = await import("../store");
    codeCleanup = await import("../cleanup");
    cleanup = await import("../../cleanup");
    const [user] = await testDb.insert(realSchema.users).values({ email: "maker@example.com" }).returning();
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: "runner", name: "Runner", ownerId: user!.id, status: "live" }).returning();
    const brief = { code: { runtimes: ["pyodide", "exec"], browse: true } } as never;
    const [build] = await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId: user!.id, productId: product!.id, brief }).returning();
    const [old] = await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId: user!.id, productId: product!.id, brief }).returning();
    productId = product!.id;
    buildId = build!.id;
    otherBuild = old!.id;
  });
  after(() => client?.close());

  const row = (namespace: string, at = new Date()): typeof realSchema.execRuns.$inferInsert => ({ productId, namespace, kind: "exec", principal: "build", language: "python", status: "ok", createdAt: at });

  it("names in its proof only the brief's parts whose routes are on", async () => {
    const env = { CODE_EXEC: process.env.CODE_EXEC, CODE_BROWSE: process.env.CODE_BROWSE, BUILDER_SNAPSHOT_ID: process.env.BUILDER_SNAPSHOT_ID };
    try {
      delete process.env.CODE_EXEC;
      delete process.env.CODE_BROWSE;
      const off = await store.codeProof(buildId, { since: null });
      assert.equal(off["brief:pyodide"], 1);
      assert.equal(off["brief:exec"], undefined, "CODE_EXEC is off, so the checks don't ask for a server run");
      assert.equal(off["brief:browse"], undefined);
      Object.assign(process.env, { CODE_EXEC: "1", CODE_BROWSE: "1", BUILDER_SNAPSHOT_ID: "snap" });
      const on = await store.codeProof(buildId, { since: null });
      assert.equal(on["brief:exec"], 1);
      assert.equal(on["brief:browse"], 1);
    } finally {
      for (const [k, v] of Object.entries(env)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
    }
  });

  it("clears a build's rows when it ends, sweeps a crashed build's after two days, and keeps live rows", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - codeCleanup.CODE_BUILD_ROWS_MAX_AGE_MS - 60_000);
    await testDb.insert(realSchema.execRuns).values([row(`b:${buildId}`), row(`b:${otherBuild}`, old), row(`b:${otherBuild}`), row("live", old)]);
    const before = process.env.CODE_ENABLED;
    try {
      delete process.env.CODE_ENABLED;
      await cleanup.capsBuildEnded(buildId);
      assert.equal((await testDb.select().from(realSchema.execRuns)).length, 4, "with the code cap off, cleanup touches nothing");
    } finally {
      if (before === undefined) delete process.env.CODE_ENABLED;
      else process.env.CODE_ENABLED = before;
    }
    await codeCleanup.clearCodeBuildRuns(buildId);
    assert.equal(await codeCleanup.sweepCodeBuildRuns(now), 1);
    const left = (await testDb.select().from(realSchema.execRuns)).map((r) => r.namespace).sort();
    assert.deepEqual(left, [`b:${otherBuild}`, "live"]);
  });

  it("is registered for the code cap in CAP_CLEANUPS", () => {
    const entry = cleanup.CAP_CLEANUPS.find((c) => c.cap === "code");
    assert.ok(entry);
  });
});
