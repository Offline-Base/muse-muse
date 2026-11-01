/**
 * The run room's reads against a real Postgres: an in-memory PGlite with the repo's migrations, standing in for Neon.
 * A run's job is the newest Muse Glimmer LoRA job whose params name its dataset (never another recipe's or another
 * dataset's), its eval items and judgements are read without the rest of the log, and loadTuneRun puts the run
 * together, with how many examples a dataset still being written holds. Nothing here reaches Neon or Lambda.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/tune/__tests__/store.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";

type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema> & {
  batch: (queries: PromiseLike<unknown>[]) => Promise<unknown[]>;
};

let client: import("@electric-sql/pglite").PGlite;
let testDb: TestDb;
let store: typeof import("@/lib/train/store");
let tune: typeof import("@/lib/train/tune/store");

const CEILINGS = { maxMinutes: 120, maxUsd: 5 };

describe("run room reads", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    const local: TestDb = Object.assign(drizzle({ client, schema: realSchema }), {
      batch: async (queries: PromiseLike<unknown>[]) => {
        const results: unknown[] = [];
        for (const q of queries) results.push(await q);
        return results;
      },
    });
    await migrate(local, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    testDb = local;
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    store = await import("@/lib/train/store");
    tune = await import("@/lib/train/tune/store");
  });

  after(async () => {
    mock.restoreAll();
    await client?.close();
  });

  async function newJob(recipe: "glimmer-lora" | "smoke" | "glimmer-serve", params: Record<string, string | number>, createdAt: Date) {
    const row = await store.createJob({
      recipe,
      title: "Tuned",
      params,
      instanceType: "gpu_1x_a100_sxm4",
      region: "us-east-1",
      priceCentsPerHour: 129,
      maxMinutes: 90,
      maxUsd: 5,
    });
    await testDb.update(realSchema.trainingJobs).set({ createdAt }).where(eq(realSchema.trainingJobs.id, row.id));
    return row.id;
  }

  it("finds the newest Muse Glimmer LoRA job trained on the dataset, and nothing else", async () => {
    const mine = await store.createDataset({ title: "a bakery's counter helper", task: "Answer made-up bakery questions.", requested: 40, writerModel: "muse-wonder-1.0" });
    const other = await store.createDataset({ title: "other", task: "Something else entirely here.", requested: 40, writerModel: "muse-wonder-1.0" });
    assert.equal(await tune.latestTuneJob(mine.id), null);
    const older = await newJob("glimmer-lora", { datasetId: mine.id, maxSteps: 120 }, new Date("2026-11-01T10:00:00Z"));
    const newer = await newJob("glimmer-lora", { datasetId: mine.id, maxSteps: 200 }, new Date("2026-11-01T11:00:00Z"));
    await newJob("glimmer-serve", { adapterJobId: newer, datasetId: mine.id }, new Date("2026-11-01T12:00:00Z"));
    await newJob("glimmer-lora", { datasetId: other.id }, new Date("2026-11-01T13:00:00Z"));
    assert.notEqual(older, newer);
    assert.equal((await tune.latestTuneJob(mine.id))?.id, newer);
    assert.equal(await tune.latestTuneJob("not-a-uuid"), null);

    await store.recordEvent(newer, { type: "log", text: "loading the model" });
    await store.recordEvent(newer, { type: "eval", index: 0, prompt: "Open Sunday?", reference: "8 to 2.", base: "Yes.", tuned: "8 to 2." });
    await store.recordEvent(newer, { type: "judgement", index: 0, baseScore: 3, tunedScore: 9, better: "tuned", note: "Gives the hours." });
    const events = await tune.tuneEvalEvents(newer);
    assert.deepEqual(events.map((e) => e.type), ["eval", "judgement"], "no log lines");
    assert.deepEqual(await tune.tuneEvalEvents("x"), []);

    const run = await tune.loadTuneRun(mine.id, new Date(), CEILINGS);
    assert.equal(run?.stage, "writing", "the dataset is still being written");
    assert.equal(run?.written, 0);
    assert.equal(run?.job?.id, newer, "the job made from it shows once there is one");
    assert.equal(await tune.loadTuneRun("1b2c3d4e-0000-4000-8000-0000000000ff", new Date(), CEILINGS), null);
  });
});
