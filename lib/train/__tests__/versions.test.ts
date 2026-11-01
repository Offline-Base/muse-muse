/**
 * Model versions: what a new version copies, and which jobs the public list may show (PGlite, no Neon or Lambda).
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/versions.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { newVersionPlan } from "@/lib/train/versions";

const FIELDS = ["datasetId", "mode", "maxSteps", "epochs", "learningRate", "scoreOnly", "dryRun", "publish", "why"].map((key) => ({
  key,
  ...(key === "maxSteps" || key === "publish" ? { modes: ["chat"] } : key === "epochs" ? { modes: ["decide"] } : {}),
}));
const job = (params: Record<string, string | number>, productId: string | null = null) => ({
  id: "j1",
  recipe: "glimmer-lora",
  title: "Helper",
  params,
  instanceType: "gpu_1x_a100",
  maxMinutes: 90,
  maxUsd: 5,
  productId,
});

describe("newVersionPlan", () => {
  it("copies only the recipe's settings, never the story, a dry run switch or an unknown key", () => {
    const plan = newVersionPlan(job({ datasetId: "d", maxSteps: 200, why: "story", scoreOnly: 1, baseModel: "x/y", repo: "x/y" }), FIELDS);
    assert.deepEqual(plan?.params, { datasetId: "d", maxSteps: 200, publish: 0 });
  });

  it("keeps publish off unless the source had it on", () => {
    assert.equal(newVersionPlan(job({ datasetId: "d" }), FIELDS)?.params.publish, 0);
    assert.equal(newVersionPlan(job({ datasetId: "d", publish: 0 }), FIELDS)?.params.publish, 0);
    assert.equal(newVersionPlan(job({ datasetId: "d", publish: 1 }), FIELDS)?.params.publish, 1);
  });

  it("offers nothing for a product's model, a dry run, another recipe or a job with no dataset", () => {
    assert.equal(newVersionPlan(job({ datasetId: "d" }, "p1"), FIELDS), null);
    assert.equal(newVersionPlan(job({ datasetId: "d", dryRun: 1 }), FIELDS), null);
    assert.equal(newVersionPlan({ ...job({ datasetId: "d" }), recipe: "smoke" }, FIELDS), null);
    assert.equal(newVersionPlan(job({}), FIELDS), null);
  });
});

const canMock = typeof (mock as { module?: unknown }).module === "function";

describe("listModelVersions", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let store: typeof import("@/lib/train/store");
  let testDb: import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = Object.assign(drizzle({ client, schema: realSchema }), {
      batch: async (queries: PromiseLike<unknown>[]) => {
        const results: unknown[] = [];
        for (const q of queries) results.push(await q);
        return results;
      },
    });
    await migrate(testDb, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    mock.module(new URL("../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    store = await import("@/lib/train/store");
  });

  after(async () => {
    mock.restoreAll();
    await client?.close();
  });

  async function newJob(params: Record<string, string | number>, judged = true, recipe: "glimmer-lora" | "smoke" = "glimmer-lora") {
    const row = await store.createJob({ recipe, title: "Tuned", params, instanceType: "gpu_1x_a100", region: "us-east-1", priceCentsPerHour: 129, maxMinutes: 90, maxUsd: 5 });
    if (judged) {
      await testDb
        .update(realSchema.trainingJobs)
        .set({ status: "succeeded", terminatedAt: new Date(), evalSummary: { items: 3, tunedWins: 2 } as never })
        .where(eq(realSchema.trainingJobs.id, row.id));
    }
    return row.id;
  }
  const newDataset = (title: string) => store.createDataset({ title, task: "Answer made-up bakery questions.", requested: 40, writerModel: "muse-wonder-1.0" });

  it("lists only judged, real jobs of this recipe on this dataset", async () => {
    const mine = await newDataset("mine");
    const other = await newDataset("other");
    const a = await newJob({ datasetId: mine.id });
    const b = await newJob({ datasetId: mine.id });
    const running = await newJob({ datasetId: mine.id }, false);
    await newJob({ datasetId: mine.id, dryRun: 1 });
    await newJob({ datasetId: mine.id }, true, "smoke");
    await newJob({ datasetId: other.id });
    const ids = (await store.listModelVersions(mine.id)).map((r) => r.id);
    assert.deepEqual(new Set(ids), new Set([a, b]));
    assert.equal(ids.length, 2);
    const admin = (await store.listDatasetRunsForAdmin(mine.id)).map((r) => r.id);
    assert.ok(admin.includes(running));
    assert.equal(admin.length, 3);
  });

  it("never lists a job on a product owner's private dataset", async () => {
    const owner = await testDb.insert(realSchema.users).values({ email: "o@example.com" } as never).returning();
    const product = await testDb
      .insert(realSchema.products)
      .values({ slug: "p-private", name: "P", ownerId: owner[0].id } as never)
      .returning();
    const ds = await newDataset("private");
    await testDb.update(realSchema.trainingDatasets).set({ productId: (product as { id: string }[])[0].id }).where(eq(realSchema.trainingDatasets.id, ds.id));
    await newJob({ datasetId: ds.id });
    assert.deepEqual(await store.listModelVersions(ds.id), []);
  });
});
