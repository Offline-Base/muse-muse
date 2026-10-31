/**
 * The drive orders store against a real Postgres: an in-memory PGlite with the repo's migrations, standing in for Neon.
 * Covers the SQL the rules lean on: the quotas by either key over a rolling 24 hours and for everyone, requests at once
 * at a quota's edge, the link secret checked as an HMAC, every move guarded by the status it comes from, the bench's
 * queue order (a claimed order first, then the oldest paid), one serial per order, a FAIL that never reaches checked,
 * and the purge (buyers 60 days after delivery or cancellation, quota keys after 30). Nothing here reaches Neon.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/drive/__tests__/store.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import type { DriveOrderRow, DriveRequest } from "../logic";

const DAY = 86_400_000;
const canMock = typeof (mock as { module?: unknown }).module === "function";
const savedPepper = process.env.GATEWAY_TOKEN_PEPPER;

type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema> & {
  batch: (queries: PromiseLike<unknown>[]) => Promise<unknown[]>;
};

let client: import("@electric-sql/pglite").PGlite;
let testDb: TestDb;
let store: typeof import("../store");
let jobId: string;

const NOW = new Date("2026-10-28T15:00:00.000Z");
const LIMITS = { perClient: 3, everyone: 20 };

const request = (): DriveRequest => ({
  trainingJobId: jobId,
  build: "all",
  name: "Ada Lovelace",
  email: "ada@example.com",
  address: { line1: "12 Analytical Way", city: "Austin", state: "TX", postalCode: "78701" },
  termsVersion: "2026-10-28",
});

let secrets = 0;

/** Saves a request from the given client and browser at `now`, as the request route does. */
async function requestFrom(ip: string, browser: string, now = NOW, limits = LIMITS) {
  const secret = `secret-${secrets++}`;
  const { hashToken } = await import("../../gateway/tokens");
  const result = await store.createOrder(
    {
      request: request(),
      files: [{ level: "Q4_K_M", name: "muse-glimmer-30b-bakery-helper-Q4_K_M.gguf", bytes: 16_940_000_000, sha256: "a".repeat(64) }],
      repo: "musemuse/muse-glimmer-30b-bakery-helper-gguf-8f1d2c3b",
      commit: "c".repeat(40),
      model: { title: "Bakery helper", slug: "bakery-helper", systemLine: "You are the bakery helper.\n\nReasoning strength: low.", needsTunedTemplate: false, quantJobId: jobId },
      imageVersion: "2026.10.28-b11669",
      secretHash: hashToken(secret),
      clientKey: store.clientKeyOf(ip),
      browserKey: store.browserKeyOf(browser),
    },
    limits,
    now,
  );
  return { result, secret };
}

async function saved(ip = "203.0.113.7", browser = "browser-a", now = NOW): Promise<{ order: DriveOrderRow; secret: string }> {
  const { result, secret } = await requestFrom(ip, browser, now);
  assert.ok(result.ok, "the request was saved");
  return { order: result.order, secret };
}

async function setRow(id: string, set: Partial<DriveOrderRow>): Promise<void> {
  await testDb.update(realSchema.driveOrders).set(set).where(eq(realSchema.driveOrders.id, id));
}

describe("drive orders store", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    // As lib/db/client.ts does for PGlite: Neon runs a batch as one transaction, PGlite runs it in order.
    const local: TestDb = Object.assign(drizzle({ client, schema: realSchema }), {
      batch: async (queries: PromiseLike<unknown>[]) => {
        const results: unknown[] = [];
        for (const q of queries) results.push(await q);
        return results;
      },
    });
    await migrate(local, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    testDb = local;
    // A test value for the HMAC, not a real pepper.
    process.env.GATEWAY_TOKEN_PEPPER = "test-pepper-for-drive-store-tests";
    mock.module(new URL("../../db/client.ts", import.meta.url).href, {
      namedExports: { db: () => testDb, schema: realSchema },
    });
    store = await import("../store");
    const [job] = await testDb
      .insert(realSchema.trainingJobs)
      .values({
        recipe: "glimmer-lora",
        title: "Bakery helper",
        status: "succeeded",
        params: {},
        instanceType: "gpu_1x_a100_sxm4",
        region: "us-east-1",
        priceCentsPerHour: 199,
        maxMinutes: 75,
        maxUsd: 4.2,
        instanceName: "mm-train-test-glimmer-lora",
      })
      .returning();
    jobId = job.id;
  });

  after(async () => {
    mock.restoreAll();
    if (savedPepper === undefined) delete process.env.GATEWAY_TOKEN_PEPPER;
    else process.env.GATEWAY_TOKEN_PEPPER = savedPepper;
    await client?.close();
  });

  beforeEach(async () => {
    await testDb.delete(realSchema.driveOrders);
  });

  describe("createOrder", () => {
    it("saves a request with what goes on the drive, the buyer and the consent", async () => {
      const { order } = await saved();
      assert.equal(order.status, "requested");
      assert.equal(order.trainingJobId, jobId);
      assert.equal(order.files[0].level, "Q4_K_M");
      assert.equal(order.model.slug, "bakery-helper");
      assert.equal(order.address?.state, "TX");
      assert.equal(order.termsAcceptedAt.toISOString(), NOW.toISOString());
      assert.equal(order.ageOkAt.toISOString(), NOW.toISOString());
      assert.equal(order.createdAt.toISOString(), NOW.toISOString());
      assert.match(order.clientKey!, /^[0-9a-f]{64}$/, "an HMAC, never the IP");
      assert.equal(order.clientKey!.includes("203.0.113.7"), false);
    });

    it("counts a client's requests by its IP's key or its browser's key, over a rolling 24 hours", async () => {
      for (let i = 0; i < 3; i++) await saved("203.0.113.7", `browser-${i}`);
      const sameIp = await requestFrom("203.0.113.7", "browser-new");
      assert.deepEqual(sameIp.result, { ok: false, limit: "client" });

      await testDb.delete(realSchema.driveOrders);
      for (let i = 0; i < 3; i++) await saved(`198.51.100.${i + 1}`, "browser-a");
      const sameBrowser = await requestFrom("192.0.2.50", "browser-a");
      assert.deepEqual(sameBrowser.result, { ok: false, limit: "client" }, "a VPN alone doesn't reset the browser's count");

      // A day later the earlier three no longer count.
      const tomorrow = new Date(NOW.getTime() + DAY + 60_000);
      assert.ok((await requestFrom("192.0.2.50", "browser-a", tomorrow)).result.ok);
      assert.ok((await requestFrom("203.0.113.99", "browser-z")).result.ok, "someone else is unaffected");
    });

    it("stops everyone at the daily total", async () => {
      for (let i = 0; i < 20; i++) await saved(`198.51.100.${i + 1}`, `browser-${i}`);
      const over = await requestFrom("203.0.113.200", "browser-200");
      assert.deepEqual(over.result, { ok: false, limit: "everyone" });
    });

    it("never lets requests at once pass a quota", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => requestFrom("203.0.113.7", `browser-${i}`, NOW, { perClient: 2, everyone: 20 })),
      );
      assert.equal(results.filter((r) => r.result.ok).length, 2);
      assert.equal((await testDb.select().from(realSchema.driveOrders)).length, 2);
    });
  });

  describe("the link secret", () => {
    it("opens the order only with its own secret", async () => {
      const a = await saved();
      const b = await saved("198.51.100.2", "browser-b");
      assert.equal((await store.orderForSecret(a.order.id, a.secret))?.id, a.order.id);
      assert.equal(await store.orderForSecret(a.order.id, b.secret), null);
      assert.equal(await store.orderForSecret(a.order.id, `${a.secret}x`), null);
      assert.equal(await store.orderForSecret(a.order.id, null), null);
      assert.equal(await store.orderForSecret("not-a-uuid", a.secret), null);
      assert.notEqual(a.order.secretHash, a.secret, "only the HMAC is stored");
    });
  });

  describe("moves", () => {
    it("takes the admin's moves only from where they're allowed, stamping each", async () => {
      const { order } = await saved();
      assert.equal(await store.adminMove(order.id, { to: "paid" }, NOW), null, "not paid before it is invoiced");
      const invoiced = await store.adminMove(order.id, { to: "invoiced", invoiceRef: "INV-7", amountText: "$59" }, NOW);
      assert.equal(invoiced?.status, "invoiced");
      assert.equal(invoiced?.invoiceRef, "INV-7");
      assert.equal(invoiced?.invoicedAt?.toISOString(), NOW.toISOString());
      assert.equal(await store.adminMove(order.id, { to: "invoiced", invoiceRef: "INV-8", amountText: "$1" }, NOW), null, "once");
      const paid = await store.adminMove(order.id, { to: "paid", note: "Paid by card" }, NOW);
      assert.equal(paid?.status, "paid");
      assert.equal(paid?.note, "Paid by card");
      assert.equal(await store.adminMove(order.id, { to: "shipped", carrier: "USPS", tracking: "9400" }, NOW), null, "not before its check");
    });

    it("lets the buyer cancel until the stick is being written", async () => {
      const a = await saved();
      const cancelled = await store.buyerCancel(a.order.id, NOW);
      assert.equal(cancelled?.status, "cancelled");
      assert.equal(cancelled?.cancelledBy, "buyer");
      assert.equal(await store.buyerCancel(a.order.id, NOW), null, "once");

      const b = await saved("198.51.100.2", "browser-b");
      await setRow(b.order.id, { status: "flashing", serial: "MM-000000000001" });
      assert.equal(await store.buyerCancel(b.order.id, NOW), null);
      assert.equal((await store.adminMove(b.order.id, { to: "cancelled" }, NOW))?.cancelledBy, "admin", "an admin still can");
    });

    it("never moves two clicks at once twice", async () => {
      const { order } = await saved();
      const both = await Promise.all([
        store.adminMove(order.id, { to: "invoiced", invoiceRef: "A", amountText: "$59" }, NOW),
        store.adminMove(order.id, { to: "invoiced", invoiceRef: "B", amountText: "$59" }, NOW),
      ]);
      assert.equal(both.filter(Boolean).length, 1);
    });
  });

  describe("the bench", () => {
    it("takes an order it already claimed first, then the oldest paid one", async () => {
      assert.equal(await store.benchNext(), null);
      const a = await saved("198.51.100.1", "a");
      const b = await saved("198.51.100.2", "b");
      const c = await saved("198.51.100.3", "c");
      await setRow(a.order.id, { status: "paid", paidAt: new Date(NOW.getTime() + 2 * DAY) });
      await setRow(b.order.id, { status: "paid", paidAt: new Date(NOW.getTime() + DAY) });
      await setRow(c.order.id, { status: "invoiced" });
      assert.equal((await store.benchNext())?.id, b.order.id, "the oldest paid");
      assert.ok(await store.claimFlashing(a.order.id, "MM-AAAAAAAAAAAA", NOW));
      assert.equal((await store.benchNext())?.id, a.order.id, "a claimed order first");
    });

    it("claims a paid order once per serial, and never another order's or a request's", async () => {
      const { order } = await saved();
      assert.equal(await store.claimFlashing(order.id, "MM-AAAAAAAAAAAA", NOW), null, "only paid orders");
      await setRow(order.id, { status: "paid", paidAt: NOW });
      const claimed = await store.claimFlashing(order.id, "MM-AAAAAAAAAAAA", NOW);
      assert.equal(claimed?.status, "flashing");
      assert.equal(claimed?.serial, "MM-AAAAAAAAAAAA");
      assert.ok(await store.claimFlashing(order.id, "MM-AAAAAAAAAAAA", NOW), "the same serial again, after a run that stopped");
      assert.equal(await store.claimFlashing(order.id, "MM-BBBBBBBBBBBB", NOW), null, "one serial per order");
    });

    it("moves a PASS to checked, and puts a FAIL back in the queue without ever reaching checked", async () => {
      const { order } = await saved();
      await setRow(order.id, { status: "paid", paidAt: NOW });
      await store.claimFlashing(order.id, "MM-AAAAAAAAAAAA", NOW);
      const report = { serial: "MM-AAAAAAAAAAAA", manifestSha256: "f".repeat(64), result: "FAIL" as const };
      assert.equal(await store.reportFlashed(order.id, { ...report, serial: "MM-BBBBBBBBBBBB" }, NOW), null, "another serial");
      const failed = await store.reportFlashed(order.id, report, NOW);
      assert.equal(failed?.status, "paid");
      assert.equal(failed?.verifyResult, "FAIL");
      assert.equal(failed?.checkedAt, null);
      assert.equal(await store.reportFlashed(order.id, { ...report, result: "PASS" }, NOW), null, "only while flashing");

      await store.claimFlashing(order.id, "MM-AAAAAAAAAAAA", NOW);
      const passed = await store.reportFlashed(order.id, { ...report, result: "PASS", imageVersion: "2026.11.01-b11669" }, NOW);
      assert.equal(passed?.status, "checked");
      assert.equal(passed?.verifyResult, "PASS");
      assert.equal(passed?.manifestSha256, "f".repeat(64));
      assert.equal(passed?.imageVersion, "2026.11.01-b11669", "the version the bench wrote");
    });
  });

  describe("purgeDriveOrders", () => {
    it("clears buyers 60 days after delivery or cancellation, or 74 after shipping when nobody marked it delivered, and quota keys after 30 days", async () => {
      const old = new Date(NOW.getTime() - 61 * DAY);
      const recent = new Date(NOW.getTime() - 59 * DAY);
      const delivered = await saved("198.51.100.1", "a");
      const deliveredRecently = await saved("198.51.100.2", "b");
      const cancelled = await saved("198.51.100.3", "c");
      const shipped = await saved("198.51.100.4", "d");
      const fresh = await saved("198.51.100.5", "e");
      const shippedRecently = await saved("198.51.100.6", "f");
      const invoice = { invoiceRef: "INV-7 Ada Lovelace", amountText: "$59" };
      await setRow(delivered.order.id, { status: "delivered", deliveredAt: old, tracking: "9400", note: "Left at door", ...invoice, createdAt: new Date(old.getTime() - 5 * DAY) });
      await setRow(deliveredRecently.order.id, { status: "delivered", deliveredAt: recent, createdAt: new Date(recent.getTime() - 5 * DAY) });
      await setRow(cancelled.order.id, { status: "cancelled", cancelledAt: old, createdAt: old });
      // The review's case: shipped long ago and never marked Delivered.
      await setRow(shipped.order.id, { status: "shipped", shippedAt: new Date(NOW.getTime() - 300 * DAY), tracking: "9400 1000", ...invoice, createdAt: new Date(NOW.getTime() - 301 * DAY) });
      await setRow(shippedRecently.order.id, { status: "shipped", shippedAt: new Date(NOW.getTime() - 73 * DAY), createdAt: new Date(NOW.getTime() - 74 * DAY) });

      assert.deepEqual(await store.purgeDriveOrders(NOW), { buyers: 3, keys: 5, unpaid: 0 });
      const get = async (id: string) => (await store.getOrder(id))!;
      for (const id of [delivered.order.id, cancelled.order.id, shipped.order.id]) {
        const r = await get(id);
        assert.equal(r.name, null);
        assert.equal(r.email, null);
        assert.equal(r.address, null);
        assert.equal(r.tracking, null);
        assert.equal(r.note, null);
        assert.equal(r.invoiceRef, null, "an invoice's reference can name the buyer");
        assert.equal(r.amountText, null);
        assert.equal(r.purgedAt?.toISOString(), NOW.toISOString());
        assert.equal(r.files.length, 1, "what went on the drive stays");
      }
      assert.equal((await get(deliveredRecently.order.id)).email, "ada@example.com");
      assert.equal((await get(shippedRecently.order.id)).email, "ada@example.com", "a shipped order waits 14 days for its delivery, then 60");
      assert.equal((await get(shippedRecently.order.id)).clientKey, null, "but its quota keys go after 30 days");
      assert.ok((await get(fresh.order.id)).clientKey, "a new order keeps its keys");
      assert.deepEqual(await store.purgeDriveOrders(NOW), { buyers: 0, keys: 0, unpaid: 0 }, "safe to run again");
    });
  });
});
