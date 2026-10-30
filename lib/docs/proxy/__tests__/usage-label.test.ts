/**
 * The usage page's numbers for docs rows (source "docs"), against an in-memory PGlite with the repo's migrations: they
 * get their own "Docs demos" series and row instead of joining "Building" and the platform's untied calls.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/proxy/__tests__/usage-label.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";

let client: import("@electric-sql/pglite").PGlite;
let testDb: import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;
let queries: typeof import("../../../queries");

describe("usage page: docs demos", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, {
      namedExports: { db: () => testDb, schema: realSchema },
    });
    queries = await import("../../../queries");
  });

  after(async () => {
    mock.restoreAll();
    await client?.close();
  });

  it("shows docs rows as Docs demos, apart from building and untied platform calls", async () => {
    const at = new Date();
    await testDb.insert(realSchema.usage).values([
      { source: "docs", endpoint: "responses", model: "muse-spark-1.3-contributor", inputTokens: 100, outputTokens: 50, costUsd: 0.01, at },
      { source: "docs", endpoint: "ask", model: "muse-spark-1.3-contributor", inputTokens: 200, outputTokens: 20, costUsd: 0.02, at },
      { source: "platform", endpoint: "responses", model: "muse-wonder-1.0", inputTokens: 1000, outputTokens: 10, costUsd: 0.5, at },
    ]);
    const f = queries.parseUsageFilters({});
    const usage = await queries.getUsage(f);
    assert.deepEqual(
      usage.tokens.map((s) => [s.key, s.label]),
      [
        ["gateway", "Products"],
        ["building", "Building"],
        ["docs", "Docs demos"],
      ],
    );
    const today = usage.days.length - 1;
    assert.equal(usage.tokens.find((s) => s.key === "docs")!.values[today], 370);
    assert.equal(usage.tokens.find((s) => s.key === "building")!.values[today], 1010);
    assert.ok(Math.abs(usage.spend.find((s) => s.key === "docs")!.values[today] - 0.03) < 1e-9);
    assert.equal(usage.totals.docsTokens, 370);
    assert.equal(usage.totals.buildingTokens, 1010);
    const docsRow = usage.products.find((p) => p.docs);
    assert.ok(docsRow, "a row of its own");
    assert.equal(docsRow.productId, null);
    assert.equal(docsRow.calls, 2);
    const untied = usage.products.find((p) => !p.docs && p.productId === null);
    assert.equal(untied?.calls, 1);
  });

  it("leaves the chart as it was when the docs ran nothing in the range", async () => {
    await testDb.delete(realSchema.usage);
    const usage = await queries.getUsage(queries.parseUsageFilters({}));
    assert.deepEqual(
      usage.spend.map((s) => s.key),
      ["gateway", "building"],
    );
    assert.equal(usage.totals.docsTokens, 0);
  });
});
