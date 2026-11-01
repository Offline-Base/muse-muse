/**
 * The board loop's rows on an in-memory PGlite migrated with drizzle/: the limits only the database can hold under a race,
 * and that a finished turn drops its prompt. Also: with BOARD_LOOP off, every route is a 404. No board, no model.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/board-loop/__tests__/store.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

describe("the board loop's rows", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let store: typeof import("../store");
  let jobId = "";

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    mock.module(new URL("../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    store = await import("../store");
    const [job] = await testDb
      .insert(realSchema.trainingJobs)
      .values({ recipe: "glimmer-lora", title: "Made-up", status: "succeeded", params: {}, instanceType: "x", region: "x", priceCentsPerHour: 0, maxMinutes: 1, maxUsd: 1, instanceName: "x" })
      .returning();
    jobId = job!.id;
  });
  after(() => client?.close());

  const newLoop = () => store.insertLoop({ adapterJobId: jobId, target: "simulated", title: "Made-up", quantJobId: null, createdBy: null });

  it("holds one going loop per kind of board, and frees it when that loop ends", async () => {
    const first = await newLoop();
    assert.ok(first);
    assert.equal(await newLoop(), null);
    assert.ok(await store.insertLoop({ adapterJobId: jobId, target: "fleet", title: "Made-up", quantJobId: null, createdBy: null }));
    await store.saveLoop({ ...first, status: "stopped" });
    assert.ok(await newLoop());
  });

  it("holds one open turn per visitor and one running per loop under the database's own indexes", async () => {
    const loop = (await store.insertLoop({ adapterJobId: jobId, target: "device", title: "Made-up", quantJobId: null, createdBy: null }))!;
    const { tryStore: s } = store;
    const a = (await s.addTurn(loop.id, "a", "Hi"))!;
    assert.equal(await s.addTurn(loop.id, "a", "Again"), null);
    const b = (await s.addTurn(loop.id, "b", "Hi"))!;
    assert.equal(await s.claim(a.id, new Date()), true);
    assert.equal(await s.claim(b.id, new Date()), false, "the board has one running slot");
    assert.equal(await s.claim(a.id, new Date()), false, "a turn can't be claimed twice");
    await s.finishTurn(a.id, { status: "done", answer: "Yo", tokens: 1, tokensPerSecond: 1, ms: 1, error: null }, new Date());
    assert.equal((await s.turn(a.id))!.prompt, null, "the prompt goes with the turn");
    assert.equal(await s.claim(b.id, new Date()), true);
  });

  it("is a 404 on every route with BOARD_LOOP off", async () => {
    delete process.env.BOARD_LOOP;
    const ctx = { params: Promise.resolve({ id: jobId, turnId: jobId }) };
    const req = (method: string) => new Request("http://localhost/x", { method, body: method === "POST" ? "{}" : undefined });
    const { GET: view } = await import("@/app/api/board-loop/[id]/route");
    const { POST: stop } = await import("@/app/api/board-loop/[id]/stop/route");
    const { GET: page, POST: join } = await import("@/app/api/board-loop/[id]/try/route");
    const { POST: poll } = await import("@/app/api/board-loop/turns/[turnId]/route");
    const { POST: begin } = await import("@/app/api/board-loop/route");
    for (const res of await Promise.all([begin(req("POST")), view(req("GET"), ctx), stop(req("POST"), ctx), page(req("GET"), ctx), join(req("POST"), ctx), poll(req("POST"), ctx)])) assert.equal(res.status, 404);
  });
});
