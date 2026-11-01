/**
 * The gpu unit's database on an in-memory PGlite migrated with drizzle/ (never a shared database): one open window, the day's
 * reservations, owner rows only, and training_jobs.product_id filled from a run's record. No GPU, no model call.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/gpu/__tests__/store.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;
const NOW = new Date("2026-11-03T15:00:00Z");

describe("the gpu unit's rows", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let store: typeof import("../store");
  let runStore: typeof import("@/lib/train/tune/run-store");
  let ownRows: typeof import("../own-rows");
  let productId = "";
  let userId = "";
  let adapterId = "";

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    store = await import("../store");
    runStore = await import("../../../train/tune/run-store");
    ownRows = await import("../own-rows");
    const [user] = await testDb.insert(realSchema.users).values({ email: "maker@example.com" }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: "corner", name: "Corner Bakery", ownerId: user!.id, status: "live" }).returning();
    userId = user!.id;
    productId = product!.id;
    const [job] = await testDb
      .insert(realSchema.trainingJobs)
      .values({ recipe: "glimmer-lora", title: "Bakery helper", status: "succeeded", params: { datasetId: "00000000-0000-4000-8000-000000000042", baseModel: "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit" }, instanceType: "gpu", region: "r", priceCentsPerHour: 100, maxMinutes: 60, maxUsd: 5, instanceName: "n", evalSummary: { items: 20, tunedWins: 16, baseWins: 3, ties: 1, avgTunedScore: 8.5, avgBaseScore: 3.1 } as never })
      .returning();
    adapterId = job!.id;
  });
  after(() => client?.close());

  const input = (over = {}) => ({ startsAt: NOW, endsAt: new Date(NOW.getTime() + 60_000), createdBy: userId, capUsd: 3, adapterJobId: adapterId, sparkOpen: false, reservationId: null, ...over });

  it("holds at most one open window, whatever is asked at once", async () => {
    const [a, b] = await Promise.all([store.insertGlimmerWindow(input()), store.insertGlimmerWindow(input())]);
    assert.equal([a, b].filter(Boolean).length, 1);
    const open = (a ?? b)!;
    assert.equal((await store.openGlimmerWindow(NOW))?.id, open.id);
    assert.equal(await store.openGlimmerWindow(new Date(NOW.getTime() - 1000)), null, "not before it starts");
    assert.equal(await store.openGlimmerWindow(open.endsAt), null, "not at its end");
    assert.equal((await store.moveGlimmerWindow(open.id, { status: "closing" }))?.status, "closing");
    assert.equal((await store.moveGlimmerWindow(open.id, { status: "closed", costUsd: 1.25 }))?.costUsd, 1.25);
    assert.equal(await store.moveGlimmerWindow(open.id, { status: "closed", costUsd: 9 }), null, "settled once");
    assert.ok(await store.insertGlimmerWindow(input()), "the next one can open");
  });

  it("counts today's windows at cost, or their cap while unsettled, and none that never got a GPU", async () => {
    const today = await store.glimmerReservedToday(new Date());
    assert.equal(today, 1.25 + 3);
    const open = await store.openGlimmerWindow(NOW);
    await store.moveGlimmerWindow(open!.id, { status: "failed", costUsd: 0 });
    assert.equal(await store.glimmerReservedToday(new Date()), 1.25);
    assert.equal(await store.glimmerReservedToday(new Date(Date.now() + 2 * 86_400_000)), 0, "a new day starts clean");
    assert.deepEqual(await store.unsettledGlimmerWindows(), []);
  });

  it("reads only the owner's live rows, in the named collections", async () => {
    const row = (scope: string, namespace: string, collection: string, ownerKey: string | null, docId: string, deletedAt: Date | null = null) => ({ productId, namespace, collection, scope: scope as never, ownerKey, docId, data: { prompt: docId, answer: "a" }, bytes: 10, deletedAt });
    await testDb.insert(realSchema.productRows).values([
      row("owner", "live", "faq", "k", "owner-live"),
      row("owner", "live", "other", "k", "owner-other-collection"),
      row("owner", "live", "faq", "k", "owner-deleted", NOW),
      row("owner", "b:build", "faq", "k", "owner-in-a-build"),
      row("shared", "live", "faq", null, "shared-row"),
      row("visitor", "live", "faq", "v", "visitor-row"),
      row("user", "live", "faq", "u", "user-row"),
    ]);
    const got = await store.ownerRowsOf(productId, ["faq"], 100);
    assert.deepEqual(got.map((r) => (r.data as { prompt: string }).prompt), ["owner-live"]);
  });

  it("fills a job's product from its run's record, and then finds it", async () => {
    assert.deepEqual(await store.productAdapterJobs(productId), []);
    await runStore.saveRunProduct("00000000-0000-4000-8000-000000000042", productId, null);
    await store.fillProductIds(productId);
    assert.deepEqual((await store.productAdapterJobs(productId)).map((j) => j.id), [adapterId]);
  });

  it("shows the owner their own models in status words, and nobody else", async () => {
    const view = await ownRows.ownModelsOf(userId, NOW);
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0]!.title, "Bakery helper");
    assert.equal(view.rows[0]!.passed, true);
    assert.equal(view.rows[0]!.sparkOpen, true);
    assert.deepEqual(view.devices, []);
    const [other] = await testDb.insert(realSchema.users).values({ email: "other@example.com" }).returning();
    assert.deepEqual((await ownRows.ownModelsOf(other!.id, NOW)).rows, []);
  });

  it("/models reads a Derivative's base from the job's done metrics, as the window does", async () => {
    const trainStore = await import("@/lib/train/store");
    const [job] = await testDb
      .insert(realSchema.trainingJobs)
      .values({ recipe: "glimmer-lora", title: "Base only in metrics", status: "succeeded", params: {}, productId, instanceType: "gpu", region: "r", priceCentsPerHour: 100, maxMinutes: 60, maxUsd: 5, instanceName: "n" })
      .returning();
    await trainStore.recordEvent(job!.id, { type: "done", metrics: { base_model: "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit" } } as never);
    const row = (await ownRows.ownModelsOf(userId, NOW)).rows.find((r) => r.jobId === job!.id);
    assert.equal(row?.sparkOpen, true);
    await testDb.delete(realSchema.trainingEvents).where(eq(realSchema.trainingEvents.jobId, job!.id));
    await testDb.delete(realSchema.trainingJobs).where(eq(realSchema.trainingJobs.id, job!.id));
  });

  it("/models writes nothing, and the hourly fill links a run's job instead", async () => {
    const runId = "00000000-0000-4000-8000-000000000077";
    const [job] = await testDb
      .insert(realSchema.trainingJobs)
      .values({ recipe: "glimmer-lora", title: "Not linked yet", status: "succeeded", params: { datasetId: runId }, instanceType: "gpu", region: "r", priceCentsPerHour: 100, maxMinutes: 60, maxUsd: 5, instanceName: "n" })
      .returning();
    await runStore.saveRunProduct(runId, productId, null);
    const titles = async () => (await ownRows.ownModelsOf(userId, NOW)).rows.map((r) => r.title);
    assert.ok(!(await titles()).includes("Not linked yet"));
    const [still] = await testDb.select().from(realSchema.trainingJobs).where(eq(realSchema.trainingJobs.id, job!.id));
    assert.equal(still!.productId, null, "a page read wrote nothing");
    assert.ok((await store.fillAllProductIds()) >= 1);
    assert.ok((await titles()).includes("Not linked yet"));
    assert.equal(await store.fillAllProductIds(), 0, "nothing left to fill");
    await testDb.delete(realSchema.trainingJobs).where(eq(realSchema.trainingJobs.id, job!.id));
  });

  it("counts a build's Glimmer calls for the gateway's record", async () => {
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId }).returning();
    const [build] = await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId, productId }).returning();
    const row = (model: string) => ({ source: "glimmer" as const, endpoint: "/glimmer/v1/chat/completions", productId, buildId: build!.id, model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd: 0 });
    await testDb.insert(realSchema.usage).values([row("glimmer-canned"), row("glimmer-canned"), row("glimmer-closed")]);
    const { glimmerBuildCounts } = await import("../proof");
    assert.deepEqual(await glimmerBuildCounts(build!.id), { "glimmer-canned": 2, "glimmer-closed": 1 });
  });
});
