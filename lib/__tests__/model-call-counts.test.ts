/**
 * modelCallCounts, the calls per model on /models, against an in-memory PGlite with the repo's migrations: one count per
 * model since a time, with rows that have no model (tool calls) and rows from before that time left out.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/__tests__/model-call-counts.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips. Nothing here reaches Neon.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";

const DAY = 86_400_000;
const canMock = typeof (mock as { module?: unknown }).module === "function";

let client: import("@electric-sql/pglite").PGlite;
let testDb: import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;
let queries: typeof import("../queries");

const NOW = Date.parse("2026-10-31T19:00:00.000Z");
const SINCE = new Date(NOW - 30 * DAY);

function call(model: string | null, at: number, source: (typeof realSchema.usage.$inferInsert)["source"] = "platform") {
  return { source, endpoint: model ? "responses" : "tool", model, at: new Date(at) };
}

describe("modelCallCounts", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
    mock.module(new URL("../db/client.ts", import.meta.url).href, {
      namedExports: { db: () => testDb, schema: realSchema },
    });
    queries = await import("../queries");
  });

  after(async () => {
    mock.restoreAll();
    await client?.close();
  });

  beforeEach(async () => {
    await testDb.delete(realSchema.usage);
  });

  it("is empty with no usage records", async () => {
    assert.deepEqual(await queries.modelCallCounts(SINCE), {});
  });

  it("counts each model's calls since the time, across sources", async () => {
    await testDb.insert(realSchema.usage).values([
      call("muse-wonder-1.0", NOW - 1_000),
      call("muse-wonder-1.0", NOW - 2 * DAY, "gateway"),
      call("muse-wonder-1.0", NOW - 29 * DAY, "docs"),
      call("muse-spark-1.3-contributor", NOW - 3_000, "gateway"),
      call("muse-image-1.0", NOW - 5 * DAY),
    ]);
    assert.deepEqual(await queries.modelCallCounts(SINCE), {
      "muse-wonder-1.0": 3,
      "muse-spark-1.3-contributor": 1,
      "muse-image-1.0": 1,
    });
  });

  it("leaves out rows with no model and rows from before the time, and counts one at the time itself", async () => {
    await testDb.insert(realSchema.usage).values([
      call(null, NOW - 1_000, "tools"),
      call(null, NOW - 2_000, "tools"),
      call("muse-wonder-1.0", NOW - 40 * DAY),
      call("muse-wonder-1.0", SINCE.getTime() - 1),
      call("sam-3.1", SINCE.getTime()),
    ]);
    assert.deepEqual(await queries.modelCallCounts(SINCE), { "sam-3.1": 1 });
  });

  it("returns plain numbers, never strings from the driver", async () => {
    await testDb.insert(realSchema.usage).values([call("muse-wonder-1.0", NOW - 1_000), call("muse-wonder-1.0", NOW - 2_000)]);
    const counts = await queries.modelCallCounts(SINCE);
    assert.equal(typeof counts["muse-wonder-1.0"], "number");
    assert.equal(counts["muse-wonder-1.0"], 2);
  });
});
