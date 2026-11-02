/**
 * The trust unit's HTTP routes (docs/CAPABILITIES.md, section 7), called as Next calls them, on a real Postgres (PGlite,
 * the repo's migrations) with the session and cookies faked: each answers 404 with its flag off before it checks who
 * is asking, refuses a builder or guest on the admin routes with 403, refuses a bad body with 400, and does its job.
 * No network: publishing is off here (no VERCEL_TOKEN), so a takedown's site step says "off".
 *
 *   npx tsx --test --experimental-test-module-mocks lib/trust/__tests__/routes.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

type Viewer = { id: string; email: string; isAdmin: boolean; openAccess?: boolean } | null;

describe("trust routes", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let viewer: Viewer = null;
  let authCalls = 0;
  let setCookies: Array<{ name: string; value: string }> = [];
  let AuthError: typeof import("@/lib/auth").AuthError;
  let reports: typeof import("@/app/api/reports/route");
  let adminReport: typeof import("@/app/api/admin/reports/[id]/route");
  let takedownRoute: typeof import("@/app/api/admin/products/[slug]/takedown/route");
  let banRoute: typeof import("@/app/api/admin/users/[id]/ban/route");
  let confirmRoute: typeof import("@/app/api/account/confirm/route");
  let TERMS_VERSION = "";
  const ENV = ["TRUST_REPORTS", "TRUST_AGE_GATE", "TRUST_LEGAL_PAGES"];
  const saved = { ...process.env };

  const json = (url: string, body: unknown, method = "POST", headers: Record<string, string> = {}) =>
    new Request(`https://musemuse.example${url}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const params = <T>(p: T) => ({ params: Promise.resolve(p) });
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

  before(async () => {
    process.env.GATEWAY_TOKEN_PEPPER = "pepper-for-trust-route-tests";
    delete process.env.VERCEL_TOKEN;
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    mock.module("next/headers", {
      namedExports: {
        cookies: async () => ({ get: () => undefined, set: (name: string, value: string) => void setCookies.push({ name, value }) }),
        headers: async () => new Headers(),
      },
    });
    const realAuth = (await import(at("../../auth.ts"))) as typeof import("../../auth");
    AuthError = realAuth.AuthError;
    const requireUser = async () => {
      authCalls += 1;
      if (!viewer) throw new AuthError("Sign in to build.", 401);
      return viewer;
    };
    const requireAdmin = async () => {
      const user = await requireUser();
      if (!user.isAdmin) throw new AuthError("Admins only.", 403);
      return user;
    };
    mock.module(at("../../auth.ts"), { namedExports: { ...realAuth, requireUser, requireAdmin } });
    reports = await import("@/app/api/reports/route");
    adminReport = await import("@/app/api/admin/reports/[id]/route");
    takedownRoute = await import("@/app/api/admin/products/[slug]/takedown/route");
    banRoute = await import("@/app/api/admin/users/[id]/ban/route");
    confirmRoute = await import("@/app/api/account/confirm/route");
    TERMS_VERSION = (await import("../terms")).TERMS_VERSION;
  });
  after(async () => {
    process.env = saved;
    await client.close();
  });
  beforeEach(() => {
    viewer = null;
    authCalls = 0;
    setCookies = [];
  });
  afterEach(() => {
    for (const k of ENV) delete process.env[k];
  });

  async function maker(email = `${randomUUID()}@example.com`) {
    const [user] = await testDb.insert(realSchema.users).values({ email }).returning();
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    return { user: user!, museId: muse!.id };
  }
  async function product(owner: { user: { id: string }; museId: string }) {
    const slug = `p-${randomUUID().slice(0, 8)}`;
    const [row] = await testDb.insert(realSchema.products).values({ slug, name: slug, ownerId: owner.user.id, inspirationId: owner.museId, status: "live" }).returning();
    await testDb.insert(realSchema.gatewayTokens).values({ productId: row!.id, tokenHash: randomUUID(), scope: "live", allowedModels: ["muse-wonder-1.0"], dailyBudgetUsd: 3 });
    return row!;
  }
  const admin = () => ({ id: randomUUID(), email: "admin@example.com", isAdmin: true });
  const builder = () => ({ id: randomUUID(), email: "maker@example.com", isAdmin: false });

  describe("POST /api/reports", () => {
    it("is 404 with the flag off and stores nothing", async () => {
      const res = await reports.POST(json("/api/reports", { slug: "x", reason: "broken" }));
      assert.equal(res.status, 404);
      assert.equal((await testDb.select().from(realSchema.abuseReports)).length, 0);
    });

    it("takes a privacy request from the Privacy page with TRUST_REPORTS off, limits it the same way, and keeps only an HMAC of the IP", async () => {
      const ip = { "x-forwarded-for": "203.0.113.44" };
      const send = () => reports.POST(json("/api/reports", { slug: "data-request", reason: "privacy", detail: "Delete my made-up note." }, "POST", ip));
      assert.equal((await send()).status, 404, "nothing while the Privacy page is off too");
      process.env.TRUST_LEGAL_PAGES = "1";
      assert.equal((await send()).status, 200);
      const [row] = await testDb.select().from(realSchema.abuseReports).where(eq(realSchema.abuseReports.productSlug, "data-request"));
      assert.equal(row!.reason, "privacy");
      assert.equal(row!.productId, null);
      assert.ok(!JSON.stringify(row).includes("203.0.113.44"));
      for (let i = 0; i < 2; i++) await send();
      assert.equal((await send()).status, 429);
      await testDb.delete(realSchema.abuseReports);
      assert.equal((await reports.POST(json("/api/reports", { slug: "data-request", reason: "harm" }))).status, 404, "other reasons stay off");
    });

    it("refuses a bad report with 400 and a sentence, files a good one under an HMAC of the IP, and limits a minute to 3", async () => {
      process.env.TRUST_REPORTS = "1";
      const owner = await maker();
      const p = await product(owner);
      const bad = await reports.POST(json("/api/reports", { slug: p.slug, reason: "spam" }));
      assert.equal(bad.status, 400);
      assert.match(await errorOf(bad), /\s/);
      const tooBig = await reports.POST(json("/api/reports", { slug: p.slug, reason: "broken", detail: "x".repeat(9000) }));
      assert.equal(tooBig.status, 413, "readJson's size limit");
      const ip = { "x-forwarded-for": "203.0.113.7" };
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await reports.POST(json("/api/reports", { slug: p.slug, reason: "harm", detail: "Mean." }, "POST", ip))).status);
      assert.deepEqual(statuses, [200, 200, 200, 429]);
      const rows = await testDb.select().from(realSchema.abuseReports).where(eq(realSchema.abuseReports.productId, p.id));
      assert.equal(rows.length, 3);
      assert.equal(rows[0]!.reporterKey.length, 32);
      assert.ok(!JSON.stringify(rows).includes("203.0.113.7"), "the IP isn't stored");
    });
  });

  describe("POST /api/admin/reports/[id]", () => {
    it("is 404 with the flag off before it asks who's calling", async () => {
      viewer = builder();
      const res = await adminReport.POST(json("/api/admin/reports/x", { status: "closed" }), params({ id: randomUUID() }));
      assert.equal(res.status, 404);
      assert.equal(authCalls, 0);
    });

    it("still needs an admin while only the Privacy page is on", async () => {
      process.env.TRUST_LEGAL_PAGES = "1";
      viewer = builder();
      const res = await adminReport.POST(json("/api/admin/reports/x", { status: "closed" }), params({ id: randomUUID() }));
      assert.equal(res.status, 403);
    });

    it("refuses a builder and a signed-out visitor, a bad status and an unknown report, and closes one for an admin", async () => {
      process.env.TRUST_REPORTS = "1";
      const [report] = await testDb.insert(realSchema.abuseReports).values({ productSlug: "gone", reason: "broken", reporterKey: "k".repeat(32) }).returning();
      const close = (id: string, status: unknown = "closed") => adminReport.POST(json(`/api/admin/reports/${id}`, { status }), params({ id }));
      assert.equal((await close(report!.id)).status, 401);
      viewer = builder();
      assert.equal((await close(report!.id)).status, 403);
      const handler = await maker(`admin-${randomUUID()}@example.com`);
      viewer = { id: handler.user.id, email: handler.user.email, isAdmin: true };
      assert.equal((await close(report!.id, "deleted")).status, 400);
      assert.equal((await close(randomUUID())).status, 404);
      assert.equal((await close("not-a-uuid")).status, 404);
      const res = await close(report!.id);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, id: report!.id, status: "closed" });
      const [row] = await testDb.select().from(realSchema.abuseReports).where(eq(realSchema.abuseReports.id, report!.id));
      assert.equal(row!.handledBy, handler.user.id);
      assert.ok(row!.handledAt);
    });
  });

  describe("/api/admin/products/[slug]/takedown", () => {
    it("is 404 with the flag off before it asks who's calling", async () => {
      viewer = admin();
      assert.equal((await takedownRoute.POST(json("/x", { reason: "Spam." }), params({ slug: "x" }))).status, 404);
      assert.equal((await takedownRoute.DELETE(json("/x", undefined, "DELETE"), params({ slug: "x" }))).status, 404);
      assert.equal(authCalls, 0);
    });

    it("refuses a builder, a missing reason and an unknown slug, takes a product down for an admin, and undoes it", async () => {
      process.env.TRUST_REPORTS = "1";
      const owner = await maker();
      const p = await product(owner);
      const down = (body: unknown, slug = p.slug) => takedownRoute.POST(json(`/api/admin/products/${slug}/takedown`, body), params({ slug }));
      viewer = builder();
      assert.equal((await down({ reason: "Spam." })).status, 403);
      viewer = admin();
      assert.equal((await down({})).status, 400);
      assert.equal((await down({ reason: "x".repeat(501) })).status, 400);
      assert.equal((await down({ reason: "Spam." }, "no-such-product")).status, 404);
      const res = await down({ reason: "Spam." });
      assert.equal(res.status, 200);
      const { result } = (await res.json()) as { result: { tokens: number; link: string } };
      assert.equal(result.tokens, 1);
      assert.equal(result.link, "none", "never published here");
      const [row] = await testDb.select().from(realSchema.products).where(eq(realSchema.products.id, p.id));
      assert.equal(row!.status, "disabled");
      assert.equal(row!.statusBeforeTakedown, "live");
      const undo = await takedownRoute.DELETE(json("/x", undefined, "DELETE"), params({ slug: p.slug }));
      assert.equal(undo.status, 200);
      const [back] = await testDb.select().from(realSchema.products).where(eq(realSchema.products.id, p.id));
      assert.equal(back!.status, "live");
      assert.equal(back!.takenDownAt, null);
    });
  });

  describe("/api/admin/users/[id]/ban", () => {
    it("is 404 with the flag off before it asks who's calling", async () => {
      viewer = admin();
      assert.equal((await banRoute.POST(json("/x", { reason: "Scams." }), params({ id: randomUUID() }))).status, 404);
      assert.equal(authCalls, 0);
    });

    it("refuses a builder, a bad id and a missing reason, won't ban an admin, bans a builder and lifts it", async () => {
      process.env.TRUST_REPORTS = "1";
      process.env.ADMIN_EMAILS = "admin@example.com";
      const owner = await maker();
      await product(owner);
      const ban = (id: string, body: unknown) => banRoute.POST(json(`/api/admin/users/${id}/ban`, body), params({ id }));
      viewer = builder();
      assert.equal((await ban(owner.user.id, { reason: "Scams." })).status, 403);
      viewer = admin();
      assert.equal((await ban("nope", { reason: "Scams." })).status, 404);
      assert.equal((await ban(owner.user.id, { reason: "  " })).status, 400);
      const theAdmin = await maker(`admin-${randomUUID()}@example.com`);
      process.env.ADMIN_EMAILS = `admin@example.com,${theAdmin.user.email}`;
      assert.equal((await ban(theAdmin.user.id, { reason: "No." })).status, 409);
      const res = await ban(owner.user.id, { reason: "Scams." });
      assert.equal(res.status, 200);
      const done = (await res.json()) as { ok: boolean; bannedAt: string; products: unknown[] };
      assert.equal(done.products.length, 1);
      const [user] = await testDb.select().from(realSchema.users).where(eq(realSchema.users.id, owner.user.id));
      assert.ok(user!.bannedAt);
      const lift = await banRoute.DELETE(json("/x", undefined, "DELETE"), params({ id: owner.user.id }));
      assert.equal(lift.status, 200);
      const [after] = await testDb.select().from(realSchema.users).where(eq(realSchema.users.id, owner.user.id));
      assert.equal(after!.bannedAt, null);
      delete process.env.ADMIN_EMAILS;
    });
  });

  describe("POST /api/account/confirm", () => {
    it("is 404 with TRUST_AGE_GATE off before it asks who's calling", async () => {
      assert.equal((await confirmRoute.POST(json("/api/account/confirm", { adult: true, termsVersion: TERMS_VERSION }))).status, 404);
      assert.equal(authCalls, 0);
    });

    it("needs a session, the box ticked and these terms, then records it on the account and in a cookie", async () => {
      process.env.TRUST_AGE_GATE = "1";
      const confirm = (body: unknown) => confirmRoute.POST(json("/api/account/confirm", body));
      assert.equal((await confirm({ adult: true, termsVersion: TERMS_VERSION })).status, 401);
      const owner = await maker();
      viewer = { id: owner.user.id, email: owner.user.email, isAdmin: false };
      assert.equal((await confirm({ adult: false, termsVersion: TERMS_VERSION })).status, 400);
      assert.equal((await confirm({ adult: true, termsVersion: "2020-01-01" })).status, 409);
      const res = await confirm({ adult: true, termsVersion: TERMS_VERSION });
      assert.equal(res.status, 200);
      const [user] = await testDb.select().from(realSchema.users).where(eq(realSchema.users.id, owner.user.id));
      assert.ok(user!.adultConfirmedAt);
      assert.equal(user!.termsVersion, TERMS_VERSION);
      assert.deepEqual(setCookies, [{ name: "mm_adult", value: TERMS_VERSION }]);
      // The shared guest: only the cookie, since the account is everyone's.
      setCookies = [];
      viewer = { id: randomUUID(), email: "guest@musemuse.invalid", isAdmin: false, openAccess: true };
      assert.equal((await confirm({ adult: true, termsVersion: TERMS_VERSION })).status, 200);
      assert.deepEqual(setCookies, [{ name: "mm_adult", value: TERMS_VERSION }]);
    });
  });
});
