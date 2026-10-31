/**
 * The queries behind the "Get it" panel, on a real Postgres: an in-memory PGlite with the repo's migrations. Nothing here
 * reaches Neon.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/native/__tests__/queries.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";
import type { ProductClip } from "@/lib/types";

const canMock = typeof (mock as { module?: unknown }).module === "function";

type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

const USER = "00000000-0000-4000-8000-000000000001";
const INSPIRATION = "00000000-0000-4000-8000-000000000002";
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let client: import("@electric-sql/pglite").PGlite;
let testDb: TestDb;
let queries: typeof import("../queries");
let active: typeof import("../active");
let store: typeof import("../../gateway/store");

async function product(n: number, opts: { status?: "live" | "partial" | "failed" | "disabled"; targets?: string[]; clips?: ProductClip[]; liveUrl?: string | null; buildStatus?: "live" | "building"; finishedAt?: Date | null } = {}) {
  const id = uuid(n);
  const buildId = uuid(n + 1000);
  await testDb.insert(realSchema.products).values({ id, slug: `p-${n}`, name: `Product ${n}`, ownerId: USER, inspirationId: INSPIRATION, status: opts.status ?? "live", liveUrl: opts.liveUrl === undefined ? `https://p-${n}.example` : opts.liveUrl, extraClips: opts.clips ?? [] });
  await testDb.insert(realSchema.builds).values({
    id: buildId,
    inspirationId: INSPIRATION,
    userId: USER,
    productId: id,
    status: opts.buildStatus ?? "live",
    brief: { name: `Product ${n}`, targets: (opts.targets ?? ["web"]).map((t) => ({ id: t, why: "A test." })) } as never,
    finishedAt: opts.finishedAt === undefined ? new Date("2026-10-31T10:00:00.000Z") : opts.finishedAt,
  });
  return { id, buildId };
}

async function run(p: { id: string; buildId: string }, n: number, origin: "ship" | "agent" | "owner" | "refine", status: "planned" | "running" | "done" = "done", createdAt = new Date()) {
  const id = uuid(n);
  await testDb.insert(realSchema.nativeRuns).values({ id, productId: p.id, buildId: p.buildId, origin, targets: ["web", "phone"], status, createdAt });
  return id;
}

const briefIds = (brief: { targets?: Array<{ id: string }> } | null) => brief?.targets?.map((t) => t.id);

describe("native queries", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    mock.module(new URL("../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    queries = await import("../queries");
    active = await import("../active");
    store = await import("../../gateway/store");
  });

  after(async () => {
    mock.restoreAll();
    await client?.close();
  });

  beforeEach(async () => {
    await client.exec("truncate rate_limits, native_artifacts, native_jobs, native_runs, builds, products, inspirations, users cascade");
    await testDb.insert(realSchema.users).values({ id: USER, email: "owner@example.com" });
    await testDb.insert(realSchema.inspirations).values({ id: INSPIRATION, userId: USER, note: "A note", references: [] });
  });

  describe("readProductNative", () => {
    it("is empty for a product with no runs, but keeps its owner's clips", async () => {
      const clip = { url: "https://blob.example/clip.mp4", posterUrl: null, caption: "Filmed on a Meta Quest 3", addedAt: "2026-10-31T12:00:00.000Z" };
      const p = await product(1, { clips: [clip] });
      const view = await queries.readProductNative(p.id, ["web"]);
      assert.deepEqual(view, { targets: ["web"], packages: [], checks: [], clips: [clip], working: false });
    });

    it("reads packages and checks, without replaced files or an agent's checks of a preview", async () => {
      const p = await product(2);
      const ship = await run(p, 1, "ship");
      const agent = await run(p, 2, "agent");
      const job = uuid(3);
      await testDb.insert(realSchema.nativeJobs).values([
        { id: job, runId: ship, buildId: p.buildId, productId: p.id, lane: "mac", kind: "android_emu", status: "done", input: { v: 1, limitSeconds: 300 }, result: { outcome: "passed", summary: "It opened." }, expiresAt: new Date(), createdAt: new Date("2026-10-31T12:10:00.000Z") },
        { id: uuid(4), runId: agent, buildId: p.buildId, productId: p.id, lane: "mac", kind: "ios_sim", status: "done", input: { v: 1, limitSeconds: 300 }, result: { outcome: "failed", summary: "The preview broke." }, expiresAt: new Date() },
      ]);
      await testDb.insert(realSchema.nativeArtifacts).values([
        { id: uuid(5), productId: p.id, runId: ship, kind: "android_apk", url: "https://blob.example/new.apk", pathname: "a", bytes: 41_000_000, createdAt: new Date("2026-10-31T12:00:00.000Z") },
        { id: uuid(6), productId: p.id, runId: ship, kind: "android_apk", url: "https://blob.example/replaced.apk", pathname: "b", supersededAt: new Date(), createdAt: new Date("2026-10-31T12:05:00.000Z") },
        { id: uuid(7), productId: p.id, runId: agent, kind: "mac_zip", url: "https://blob.example/agent.zip", pathname: "c" },
        { id: uuid(8), productId: p.id, runId: ship, jobId: job, kind: "clip", url: "https://blob.example/clip.mp4", pathname: "d", caption: "On an Android emulator", createdAt: new Date("2026-10-31T12:10:00.000Z") },
      ]);
      const view = await queries.readProductNative(p.id, ["web", "phone"]);
      assert.deepEqual(view.packages.map((x) => [x.download, x.url, x.state]), [["android", "https://blob.example/new.apk", "passed"]]);
      assert.deepEqual(view.checks.map((c) => [c.id, c.state, c.clip?.caption]), [[job, "passed", "On an Android emulator"]]);
    });

    it("keeps packages on offer however much media later runs leave", async () => {
      const p = await product(20);
      const ship = await run(p, 1, "ship");
      await testDb.insert(realSchema.nativeArtifacts).values([
        { id: uuid(2), productId: p.id, runId: ship, kind: "android_apk", url: "https://blob.example/a.apk", pathname: "a", bytes: 41_000_000, createdAt: new Date("2026-10-31T10:00:00.000Z") },
        { id: uuid(3), productId: p.id, runId: ship, kind: "mac_zip", url: "https://blob.example/m.zip", pathname: "m", bytes: 215_000_000, createdAt: new Date("2026-10-31T10:00:00.000Z") },
      ]);
      const refine = await run(p, 4, "refine");
      const newer = (i: number) => new Date(Date.parse("2026-10-31T11:00:00.000Z") + i * 1000);
      await testDb.insert(realSchema.nativeArtifacts).values(
        Array.from({ length: 130 }, (_, i) => ({ id: uuid(100 + i), productId: p.id, runId: refine, kind: "shot" as const, url: `https://blob.example/s${i}.png`, pathname: `s${i}`, createdAt: newer(i) })),
      );
      const view = await queries.readProductNative(p.id, ["web", "phone", "desktop"]);
      assert.deepEqual(view.packages.map((x) => [x.download, x.url]).sort(), [["android", "https://blob.example/a.apk"], ["mac", "https://blob.example/m.zip"]]);
    });

    it("offers the newest of each package, and an old one doesn't take a new one's place", async () => {
      const p = await product(21);
      const ship = await run(p, 1, "ship");
      await testDb.insert(realSchema.nativeArtifacts).values([
        { id: uuid(2), productId: p.id, runId: ship, kind: "android_apk", url: "https://blob.example/old.apk", pathname: "a", createdAt: new Date("2026-10-31T10:00:00.000Z") },
        { id: uuid(3), productId: p.id, runId: ship, kind: "android_apk", url: "https://blob.example/new.apk", pathname: "b", createdAt: new Date("2026-10-31T11:00:00.000Z") },
        { id: uuid(4), productId: p.id, runId: ship, kind: "windows_zip", url: "https://blob.example/w.zip", pathname: "c", createdAt: new Date("2026-10-31T09:00:00.000Z") },
      ]);
      const view = await queries.readProductNative(p.id, ["web", "phone", "desktop"]);
      assert.deepEqual(view.packages.map((x) => [x.download, x.url]).sort(), [["android", "https://blob.example/new.apk"], ["windows", "https://blob.example/w.zip"]]);
    });

    it("says it's working while a run is, and not for an agent's", async () => {
      const a = await product(3);
      await run(a, 1, "agent", "running");
      assert.equal((await queries.readProductNative(a.id, ["web"])).working, false);
      await run(a, 2, "ship", "running");
      assert.equal((await queries.readProductNative(a.id, ["web"])).working, true);
    });
  });

  describe("newestBrief", () => {
    it("reads the newest build that has one, since a refinement's has none", async () => {
      const p = await product(22, { targets: ["web", "phone"] });
      await testDb.insert(realSchema.builds).values({ id: uuid(23), inspirationId: INSPIRATION, userId: USER, productId: p.id, kind: "refine", status: "live", brief: null });
      assert.deepEqual(briefIds(await queries.newestBrief(p.id)), ["web", "phone"]);
      assert.equal(await queries.newestBrief(uuid(24)), null);
    });
  });

  describe("shippedProductBySlug", () => {
    it("finds a shipped product and where it runs, from its newest brief", async () => {
      const p = await product(4, { targets: ["web", "vr"] });
      assert.deepEqual(await queries.shippedProductBySlug("p-4"), { id: p.id, name: "Product 4", liveUrl: "https://p-4.example", targets: ["web", "vr"] });
    });

    it("has nothing for a product that didn't ship, was turned off, or a slug that can't be one", async () => {
      await product(5, { status: "failed" });
      await product(6, { status: "disabled" });
      assert.equal(await queries.shippedProductBySlug("p-5"), null);
      assert.equal(await queries.shippedProductBySlug("p-6"), null);
      assert.equal(await queries.shippedProductBySlug("../etc"), null);
    });
  });

  describe("listVrProducts", () => {
    it("lists only shipped products whose newest brief has vr", async () => {
      await product(7, { targets: ["web", "vr"] });
      await product(8, { targets: ["web", "phone"] });
      await product(9, { targets: ["web", "vr"], status: "disabled" });
      await product(10, { targets: ["web", "vr"], liveUrl: null });
      await product(11);
      assert.deepEqual((await queries.listVrProducts()).map((p) => p.slug), ["p-7"]);
    });
  });

  describe("download counts", () => {
    it("adds up, and the hourly prune leaves them alone", async () => {
      await store.adjustCounter(queries.downloadsKey("a"), queries.DOWNLOADS_WINDOW, 1);
      await store.adjustCounter(queries.downloadsKey("a"), queries.DOWNLOADS_WINDOW, 1);
      await store.adjustCounter("native-get-ip:1.2.3.4", new Date("2026-01-01T00:00:00.000Z"), 1);
      assert.equal(await store.deleteRateLimitsBefore(new Date("2026-10-31T00:00:00.000Z")), 1);
      assert.deepEqual([...(await queries.downloadCounts(["a", "b"]))], [["a", 2], ["b", 0]]);
      assert.deepEqual([...(await queries.downloadCounts([]))], []);
    });
  });

  describe("nativeActive", () => {
    const NOW = Date.parse("2026-10-31T12:00:00.000Z");
    const withFlag = async (value: string | undefined, fn: () => Promise<void>) => {
      const before = process.env.NATIVE_TARGETS;
      if (value === undefined) delete process.env.NATIVE_TARGETS;
      else process.env.NATIVE_TARGETS = value;
      try {
        await fn();
      } finally {
        if (before === undefined) delete process.env.NATIVE_TARGETS;
        else process.env.NATIVE_TARGETS = before;
      }
    };

    it("is false with every flag off, whatever the rows say", async () => {
      const p = await product(12);
      await run(p, 1, "ship", "running", new Date(NOW));
      await withFlag(undefined, async () => assert.equal(await active.nativeActive(p.buildId, NOW), false));
    });

    it("follows the build's runs while the flag is on", async () => {
      const p = await product(13);
      const id = await run(p, 1, "ship", "running", new Date(NOW - 60_000));
      await withFlag("phone", async () => {
        assert.equal(await active.nativeActive(p.buildId, NOW), true);
        await testDb.update(realSchema.nativeRuns).set({ status: "done" });
        assert.equal(await active.nativeActive(p.buildId, NOW), false, id);
      });
    });

    it("stops waiting on a run that has been going for hours", async () => {
      const p = await product(14);
      await run(p, 1, "ship", "running", new Date(NOW - 3 * 3_600_000));
      await withFlag("phone", async () => assert.equal(await active.nativeActive(p.buildId, NOW), false));
    });

    it("waits a little for a run about to start, only when the brief asks for apps", async () => {
      const justNow = new Date(NOW - 10_000);
      const apps = await product(15, { targets: ["web", "phone"], finishedAt: justNow });
      const web = await product(16, { finishedAt: justNow });
      const old = await product(17, { targets: ["web", "phone"], finishedAt: new Date(NOW - 600_000) });
      await withFlag("phone", async () => {
        assert.equal(await active.nativeActive(apps.buildId, NOW), true);
        assert.equal(await active.nativeActive(web.buildId, NOW), false);
        assert.equal(await active.nativeActive(old.buildId, NOW), false);
      });
    });

    it("doesn't take a finished agent's run for the ship run having started", async () => {
      const p = await product(18, { targets: ["web", "phone"], finishedAt: new Date(NOW - 1_000) });
      await run(p, 1, "agent", "done", new Date(NOW - 300_000));
      await withFlag("phone", async () => assert.equal(await active.nativeActive(p.buildId, NOW), true));
    });

    it("doesn't hold the stream for an agent's run, which only checked a preview", async () => {
      const stuck = await product(19, { targets: ["web", "phone"], finishedAt: new Date(NOW - 600_000) });
      await run(stuck, 1, "agent", "running", new Date(NOW - 700_000));
      await withFlag("phone", async () => assert.equal(await active.nativeActive(stuck.buildId, NOW), false));
    });

    it("isn't crowded out by an agent's many runs", async () => {
      const p = await product(25, { targets: ["web", "phone"], finishedAt: new Date(NOW - 600_000) });
      await run(p, 1, "ship", "running", new Date(NOW - 500_000));
      for (let i = 0; i < 12; i++) await run(p, 10 + i, "agent", "done", new Date(NOW - 100_000 + i));
      await withFlag("phone", async () => assert.equal(await active.nativeActive(p.buildId, NOW), true));
    });

    it("waits for a refinement's run, going by the brief of the build before it", async () => {
      const refineOf = async (n: number, p: { id: string }, finishedAt: Date) => {
        await testDb.insert(realSchema.builds).values({ id: uuid(n), inspirationId: INSPIRATION, userId: USER, productId: p.id, kind: "refine", status: "live", brief: null, finishedAt });
        return uuid(n);
      };
      const justNow = new Date(NOW - 1_000);
      const phone = await refineOf(30, await product(26, { targets: ["web", "phone"] }), justNow);
      const web = await refineOf(31, await product(27), justNow);
      const old = await refineOf(32, await product(28, { targets: ["web", "phone"] }), new Date(NOW - 600_000));
      await withFlag("phone", async () => {
        assert.equal(await active.nativeActive(phone, NOW), true);
        assert.equal(await active.nativeActive(web, NOW), false);
        assert.equal(await active.nativeActive(old, NOW), false);
      });
    });
  });
});
