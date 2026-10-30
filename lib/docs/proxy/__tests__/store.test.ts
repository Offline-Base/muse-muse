/**
 * The docs store against a real Postgres: an in-memory PGlite with the repo's migrations (0009 adds docs_objects),
 * standing in for Neon. Covers the counters that move by more than one (reserve within a limit, give back, never below
 * zero), the day rows surviving the hourly prune, and docs_objects. Nothing here reaches Neon.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/proxy/__tests__/store.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";

type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

let client: import("@electric-sql/pglite").PGlite;
let testDb: TestDb;
let store: typeof import("../store");
let gatewayStore: typeof import("../../../gateway/store");
let limits: typeof import("../limits");

const NOW = new Date("2026-10-30T12:00:30.000Z");

describe("docs store", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
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
    store = await import("../store");
    gatewayStore = await import("../../../gateway/store");
    limits = await import("../limits");
  });

  after(async () => {
    mock.restoreAll();
    await client?.close();
  });

  beforeEach(async () => {
    await testDb.delete(realSchema.rateLimits);
    await testDb.delete(realSchema.docsObjects);
  });

  describe("counters", () => {
    it("reserves only within the limit, atomically, and reports the total", async () => {
      const day = limits.dayWindow(NOW);
      assert.equal(await store.reserveCounter("docs-usd:1.2.3.4", day, 1_500_000, 2_000_000), 1_500_000);
      assert.equal(await store.reserveCounter("docs-usd:1.2.3.4", day, 600_000, 2_000_000), null, "over the limit");
      assert.equal(await store.counterValue("docs-usd:1.2.3.4", day), 1_500_000, "a refused reservation adds nothing");
      assert.equal(await store.reserveCounter("docs-usd:1.2.3.4", day, 500_000, 2_000_000), 2_000_000, "exactly at the limit fits");
      assert.equal(await store.reserveCounter("docs-usd:5.6.7.8", day, 3_000_000, 2_000_000), null, "a first reservation over the limit");
      assert.equal(await store.counterValue("docs-usd:5.6.7.8", day), 0);
    });

    it("never lets parallel reservations pass the limit together", async () => {
      const day = limits.dayWindow(NOW);
      const results = await Promise.all(Array.from({ length: 10 }, () => store.reserveCounter("docs-usd:9.9.9.9", day, 300_000, 2_000_000)));
      assert.equal(results.filter((r) => r !== null).length, 6);
      assert.equal(await store.counterValue("docs-usd:9.9.9.9", day), 1_800_000);
    });

    it("adjusts up and down, never below zero, creating the row when needed", async () => {
      const day = limits.dayWindow(NOW);
      await store.adjustCounter("docs-usd:a", day, 1234);
      assert.equal(await store.counterValue("docs-usd:a", day), 1234);
      await store.adjustCounter("docs-usd:a", day, -234);
      assert.equal(await store.counterValue("docs-usd:a", day), 1000);
      await store.adjustCounter("docs-usd:a", day, -5000);
      assert.equal(await store.counterValue("docs-usd:a", day), 0);
      await store.adjustCounter("docs-usd:new", day, -10);
      assert.equal(await store.counterValue("docs-usd:new", day), 0);
    });

    it("day rows survive the hourly prune of windows older than an hour; minute rows don't", async () => {
      const day = limits.dayWindow(NOW);
      await gatewayStore.hitRateLimits(["docs-ip-day:1.2.3.4"], day);
      await gatewayStore.hitRateLimits(["docs-ip:1.2.3.4"], limits.minuteStart(new Date(NOW.getTime() - 2 * 3_600_000)));
      await store.adjustCounter("docs-usd:1.2.3.4", day, 42);
      // What the hourly cron runs (lib/gateway/cleanup.ts): prune windows that started over an hour ago.
      const pruned = await gatewayStore.deleteRateLimitsBefore(new Date(NOW.getTime() - 3_600_000));
      assert.equal(pruned, 1);
      assert.equal(await store.counterValue("docs-usd:1.2.3.4", day), 42);
      assert.equal(await store.counterValue("docs-ip-day:1.2.3.4", day), 1);
      // An hour after the day ends, its rows go too.
      assert.equal(await gatewayStore.deleteRateLimitsBefore(new Date(day.getTime() + 1)), 2);
    });
  });

  describe("docs_objects", () => {
    it("records what a visitor created and answers which ids are theirs", async () => {
      await store.recordDocsObject({ id: "file-1", kind: "file", visitor: "v1" });
      await store.recordDocsObject({ id: "resp_1", kind: "response", visitor: "v1" });
      await store.recordDocsObject({ id: "file-2", kind: "file", visitor: "v2" });
      await store.recordDocsObject({ id: "file-1", kind: "file", visitor: "v2" });
      const owned = await store.ownedDocsIds("v1", ["file-1", "file-2", "resp_1", "resp_x"]);
      assert.deepEqual(owned.map((o) => `${o.kind}:${o.id}`).sort(), ["file:file-1", "response:resp_1"]);
      assert.deepEqual(await store.ownedDocsIds("v2", ["file-1"]), [], "the first visitor to record an id keeps it");
      assert.deepEqual(await store.ownedDocsIds("v1", []), []);
    });

    it("lists a visitor's objects newest first, and forgets them", async () => {
      for (const [id, minutesAgo] of [
        ["file-old", 50],
        ["file-new", 5],
        ["file-mid", 20],
      ] as const) {
        await testDb.insert(realSchema.docsObjects).values({ id, kind: "file", visitor: "v1", createdAt: new Date(NOW.getTime() - minutesAgo * 60_000) });
      }
      assert.deepEqual(await store.visitorDocsObjects("v1", "file", 10), ["file-new", "file-mid", "file-old"]);
      assert.deepEqual(await store.visitorDocsObjects("v1", "file", 1), ["file-new"]);
      assert.deepEqual(await store.visitorDocsObjects("v1", "response", 10), []);
      await store.forgetDocsObject("file-mid");
      assert.deepEqual(await store.visitorDocsObjects("v1", "file", 10), ["file-new", "file-old"]);
    });

    it("finds stale objects oldest first, by kind, and forgets a batch", async () => {
      const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000);
      await testDb.insert(realSchema.docsObjects).values([
        { id: "file-2h", kind: "file", visitor: "v", createdAt: at(2) },
        { id: "file-3h", kind: "file", visitor: "v", createdAt: at(3) },
        { id: "file-now", kind: "file", visitor: "v", createdAt: at(0.1) },
        { id: "resp_2h", kind: "response", visitor: "v", createdAt: at(2) },
        { id: "resp_30h", kind: "response", visitor: "v", createdAt: at(30) },
      ]);
      assert.deepEqual(await store.staleDocsObjects("file", at(1), 10), ["file-3h", "file-2h"]);
      assert.deepEqual(await store.staleDocsObjects("response", at(24), 10), ["resp_30h"]);
      assert.equal(await store.forgetDocsObjects(["file-3h", "file-2h", "nope"]), 2);
      assert.equal(await store.forgetDocsObjects([]), 0);
      assert.deepEqual(await store.staleDocsObjects("file", at(1), 10), []);
    });

    it("keeps a background response's hold until it is claimed, and lets only one caller claim it", async () => {
      const hold = { reservation: "00000000-0000-0000-0000-000000000001", model: "muse-spark-1.3-contributor", micros: 108_135, usdKey: "docs-usd:1.2.3.4", day: "2026-10-31T00:00:00.000Z" };
      await store.recordDocsObject({ id: "resp_bg", kind: "response", visitor: "v1", hold });
      await store.recordDocsObject({ id: "resp_fg", kind: "response", visitor: "v1" });
      assert.deepEqual(await store.pendingDocsHold("resp_bg"), hold);
      assert.equal(await store.pendingDocsHold("resp_fg"), null);
      assert.equal(await store.pendingDocsHold("resp_none"), null);
      // The sweep's list: only rows that still hold, created before the cutoff.
      const later = new Date(Date.now() + 60_000);
      assert.deepEqual(await store.pendingDocsHolds(later, 10), [{ id: "resp_bg", hold }]);
      assert.deepEqual(await store.pendingDocsHolds(new Date(Date.now() - 3_600_000), 10), []);
      // Two claims at once: one gets the hold, the other nothing.
      const claims = await Promise.all([store.claimDocsHold("resp_bg"), store.claimDocsHold("resp_bg")]);
      assert.equal(claims.filter((c) => c !== null).length, 1);
      assert.deepEqual(claims.find((c) => c !== null), hold);
      assert.equal(await store.pendingDocsHold("resp_bg"), null);
      assert.equal(await store.claimDocsHold("resp_bg"), null);
      assert.deepEqual(await store.pendingDocsHolds(later, 10), []);
      // The row itself stays, so the visitor still owns the response.
      assert.deepEqual((await store.ownedDocsIds("v1", ["resp_bg"])).map((o) => o.id), ["resp_bg"]);
    });
  });

  describe("usage", () => {
    it("docsSpendToday counts only docs rows from today", async () => {
      const usage = await import("../../../usage");
      await testDb.insert(realSchema.usage).values([
        { source: "docs", endpoint: "responses", costUsd: 0.25, at: new Date() },
        { source: "docs", endpoint: "ask", costUsd: 0.5, at: new Date() },
        { source: "gateway", endpoint: "responses", costUsd: 9, at: new Date() },
        { source: "docs", endpoint: "responses", costUsd: 4, at: new Date(Date.now() - 2 * 86_400_000) },
      ]);
      assert.equal(await usage.docsSpendToday(), 0.75);
      assert.equal(await usage.platformSpendToday(), 9.75);
      await testDb.delete(realSchema.usage);
    });
  });
});
