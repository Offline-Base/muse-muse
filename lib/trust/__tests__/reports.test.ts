/**
 * Reports, takedown, ban, the builder's daily dollars and the 18+ confirmation (docs/CAPABILITIES.md, section 7), on a
 * real Postgres (PGlite in memory, the repo's migrations) with the db client mocked to it. No network.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/trust/__tests__/reports.test.ts
 *
 * Without the flag, node:test has no mock.module and the database part skips.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { fileReport, parseReport, reporterKey, REPORT_LIMITS, type ReportDeps } from "@/lib/trust/reports";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

describe("a report", () => {
  it("takes a slug, one of the reasons and up to 1,000 characters, and nothing else", () => {
    assert.deepEqual(parseReport({ slug: "Bird-Count", reason: "broken", detail: "  It shows a blank page. " }), {
      ok: true,
      value: { slug: "bird-count", reason: "broken", detail: "It shows a blank page." },
    });
    assert.equal(parseReport({ slug: "bird-count", reason: "privacy" }).ok, true, "detail is optional");
    for (const bad of [
      { slug: "../etc", reason: "broken" },
      { slug: "bird-count", reason: "spam" },
      { slug: "bird-count", reason: "broken", detail: "x".repeat(1001) },
      { slug: "bird-count", reason: "broken", detail: 42 },
      { slug: "bird-count", reason: "broken", email: "me@example.com" },
    ]) {
      const parsed = parseReport(bad as Record<string, unknown>);
      assert.equal(parsed.ok, false, JSON.stringify(bad));
      if (!parsed.ok) assert.ok(/\s/.test(parsed.error), "a sentence");
    }
  });

  it("keeps the reporter as a 32-character HMAC that never contains the IP", () => {
    const key = reporterKey("203.0.113.9", "secret");
    assert.equal(key.length, 32);
    assert.equal(key, reporterKey("203.0.113.9", "secret"));
    assert.notEqual(key, reporterKey("203.0.113.10", "secret"));
    assert.notEqual(key, reporterKey("203.0.113.9", "other secret"));
    assert.ok(!key.includes("203"));
  });

  it("is limited to 3 a minute and 5 a day per reporter", async () => {
    const counts = new Map<string, number>();
    const saved: unknown[] = [];
    let now = new Date("2026-11-01T10:00:00.000Z");
    const deps: ReportDeps = {
      hitRateLimits: async (keys, windowStart) => {
        const out: Record<string, number> = {};
        for (const k of keys) {
          const at = `${k}@${windowStart.toISOString()}`;
          counts.set(at, (counts.get(at) ?? 0) + 1);
          out[k] = counts.get(at)!;
        }
        return out;
      },
      findProductId: async (slug) => (slug === "bird-count" ? "p1" : null),
      insertReport: async (row) => void saved.push(row),
      now: () => now,
    };
    const input = { slug: "bird-count", reason: "broken" as const, detail: "" };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await fileReport(input, "k", deps));
    assert.deepEqual(results.map((r) => r.ok), [true, true, true, false]);
    now = new Date("2026-11-01T10:01:00.000Z");
    const more = [];
    for (let i = 0; i < 3; i++) more.push(await fileReport(input, "k", deps));
    assert.deepEqual(more.map((r) => r.ok), [true, true, false], "the day allows 5");
    assert.equal(saved.length, REPORT_LIMITS.perDay);
    assert.equal((await fileReport(input, "someone-else", deps)).ok, true);
    assert.deepEqual(saved[0], { productId: "p1", productSlug: "bird-count", reason: "broken", detail: "", reporterKey: "k" });
    // An unknown slug is still filed, with no product.
    await fileReport({ ...input, slug: "gone" }, "third", deps);
    assert.equal((saved.at(-1) as { productId: string | null }).productId, null);
  });
});

describe("on a database", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let takedown: typeof import("../takedown");
  let spend: typeof import("../spend");
  let account: typeof import("../account");
  let queries: typeof import("../../queries");
  const ENV = ["TRUST_REPORTS", "TRUST_AGE_GATE", "TRUST_SIGNED_IN_CAPS", "TRUST_BUILDER_DAILY_USD", "ADMIN_EMAILS"];

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    mock.module(new URL("../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    takedown = await import("../takedown");
    spend = await import("../spend");
    account = await import("../account");
    queries = await import("../../queries");
  });
  after(() => client.close());
  afterEach(() => {
    for (const k of ENV) delete process.env[k];
  });

  async function maker(email = `${randomUUID()}@example.com`) {
    const [user] = await testDb.insert(realSchema.users).values({ email }).returning();
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    return { user: user!, museId: muse!.id };
  }

  async function shipped(owner: { user: { id: string }; museId: string }, slug = `p-${randomUUID().slice(0, 8)}`) {
    const [product] = await testDb
      .insert(realSchema.products)
      .values({ slug, name: `Product ${slug}`, ownerId: owner.user.id, inspirationId: owner.museId, status: "live", liveUrl: `https://musemuse-${slug}.vercel.app`, vercelProjectId: `prj_${slug}` })
      .returning();
    const [build] = await testDb.insert(realSchema.builds).values({ inspirationId: owner.museId, userId: owner.user.id, productId: product!.id, status: "partial" }).returning();
    await testDb.update(realSchema.products).set({ latestBuildId: build!.id }).where(eq(realSchema.products.id, product!.id));
    await testDb.insert(realSchema.gatewayTokens).values([
      { productId: product!.id, tokenHash: randomUUID(), scope: "live", allowedModels: ["muse-wonder-1.0"], dailyBudgetUsd: 3 },
      { productId: product!.id, tokenHash: randomUUID(), scope: "live", allowedModels: ["muse-wonder-1.0"], dailyBudgetUsd: 3, revokedAt: new Date("2026-10-01T00:00:00.000Z") },
    ]);
    return { product: product!, buildId: build!.id };
  }

  const tokens = (productId: string) => testDb.select().from(realSchema.gatewayTokens).where(eq(realSchema.gatewayTokens.productId, productId));
  const row = async (productId: string) => (await testDb.select().from(realSchema.products).where(eq(realSchema.products.id, productId)))[0]!;

  function deps(alias: import("../takedown").TakedownDeps["alias"] = null) {
    return { ...takedown.dbTakedownDeps(alias), protectedEmail: (email: string) => email === "admin@example.com" || email === "guest@musemuse.invalid" };
  }

  it("a takedown hides the page and the gallery card, turns the product off, revokes its live tokens and its link", async () => {
    process.env.TRUST_REPORTS = "1";
    const owner = await maker();
    const { product } = await shipped(owner);
    assert.ok(await queries.getProductPage(product.slug));
    assert.ok((await queries.listShippedProducts()).some((c) => c.slug === product.slug));

    const calls: string[] = [];
    const alias = { remove: async (id: string, host: string) => void calls.push(`remove ${id} ${host}`), restore: async (id: string, host: string) => void calls.push(`restore ${id} ${host}`) };
    const done = await takedown.takedownProduct(product.slug, "Copies a real brand.", deps(alias));
    assert.ok(done.ok && done.result);
    assert.equal(done.result.tokens, 1, "only the active one");
    assert.equal(done.result.link, "removed");
    assert.deepEqual(calls, [`remove prj_${product.slug} musemuse-${product.slug}.vercel.app`]);

    const after1 = await row(product.id);
    assert.equal(after1.status, "disabled");
    assert.equal(after1.takedownReason, "Copies a real brand.");
    assert.ok(after1.takenDownAt);
    assert.equal(await queries.getProductPage(product.slug), null);
    assert.ok(!(await queries.listShippedProducts()).some((c) => c.slug === product.slug));
    assert.ok((await tokens(product.id)).every((t) => t.revokedAt), "every live token revoked");

    // An admin turning it back on with the kill switch doesn't bring the card back while it's taken down.
    await testDb.update(realSchema.products).set({ status: "live" }).where(eq(realSchema.products.id, product.id));
    assert.ok(!(await queries.listShippedProducts()).some((c) => c.slug === product.slug));
    await testDb.update(realSchema.products).set({ status: "disabled" }).where(eq(realSchema.products.id, product.id));

    const again = await takedown.takedownProduct(product.slug, "Twice.", deps(alias));
    assert.ok(again.ok && again.result === null, "a second takedown changes nothing");
    assert.equal((await row(product.id)).takedownReason, "Copies a real brand.");

    const undone = await takedown.undoTakedown(product.slug, deps(alias));
    assert.ok(undone.ok && undone.result);
    assert.equal(undone.result.tokens, 1, "only the token the takedown revoked comes back");
    assert.equal(undone.result.link, "restored");
    const restored = await row(product.id);
    assert.equal(restored.status, "partial", "the status its latest build shipped with");
    assert.equal(restored.takenDownAt, null);
    const back = await tokens(product.id);
    assert.equal(back.filter((t) => !t.revokedAt).length, 1);
    assert.equal(back.filter((t) => t.revokedAt?.toISOString() === "2026-10-01T00:00:00.000Z").length, 1, "an older revocation stays");
    assert.ok(await queries.getProductPage(product.slug));
  });

  it("a takedown still holds when its link can't be removed, and says why", async () => {
    const owner = await maker();
    const { product } = await shipped(owner);
    const alias = { remove: async () => { throw new Error("Vercel API removing it failed (403)"); }, restore: async () => {} };
    const done = await takedown.takedownProduct(product.slug, "Harmful.", deps(alias));
    assert.ok(done.ok && done.result);
    assert.match(done.result.link, /^failed: Vercel API removing it failed \(403\)/);
    assert.equal((await row(product.id)).status, "disabled");
    const off = await takedown.takedownProduct("no-such-product", "x", deps());
    assert.equal(off.ok, false);
  });

  it("a ban takes down every product of theirs at one moment, and lifting it undoes only those", async () => {
    const owner = await maker();
    const first = await shipped(owner);
    const second = await shipped(owner);
    const earlier = await shipped(owner);
    await takedown.takedownProduct(earlier.product.slug, "Taken down before the ban.", deps());

    const banned = await takedown.banUser(owner.user.id, "Scam products.", deps());
    assert.ok(banned.ok);
    assert.equal(banned.products.length, 2, "the one already down isn't touched");
    const user = (await testDb.select().from(realSchema.users).where(eq(realSchema.users.id, owner.user.id)))[0]!;
    assert.equal(user.banReason, "Scam products.");
    for (const p of [first, second]) {
      const r = await row(p.product.id);
      assert.equal(r.takenDownAt?.getTime(), user.bannedAt?.getTime());
      assert.equal(r.takedownReason, "Owner banned: Scam products.");
    }

    const lifted = await takedown.liftBan(owner.user.id, deps());
    assert.ok(lifted.ok);
    assert.deepEqual(lifted.products.map((p) => p.slug).sort(), [first.product.slug, second.product.slug].sort());
    assert.equal((await row(first.product.id)).takenDownAt, null);
    assert.ok((await row(earlier.product.id)).takenDownAt, "a takedown for another reason stays");
    assert.equal((await testDb.select().from(realSchema.users).where(eq(realSchema.users.id, owner.user.id)))[0]!.bannedAt, null);
  });

  it("refuses to ban an admin or the shared guest account", async () => {
    for (const email of ["admin@example.com", "guest@musemuse.invalid"]) {
      const who = await maker(email);
      const result = await takedown.banUser(who.user.id, "No.", deps());
      assert.ok(!result.ok && result.status === 409);
    }
    const missing = await takedown.banUser(randomUUID(), "No.", deps());
    assert.ok(!missing.ok && missing.status === 404);
  });

  it("counts every source of a builder's spend today once, and nobody else's", async () => {
    const owner = await maker();
    const other = await maker();
    const { product, buildId } = await shipped(owner);
    const { product: theirs } = await shipped(other);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 36 * 3_600_000);
    const [laterBuild] = await testDb.insert(realSchema.builds).values({ inspirationId: owner.museId, userId: owner.user.id }).returning();
    await testDb.insert(realSchema.usage).values([
      { source: "gateway", endpoint: "responses", productId: product.id, costUsd: 0.5 },
      { source: "tools", endpoint: "tools/execute", productId: product.id, units: 1, costUsd: 0 },
      { source: "muse_code", endpoint: "muse", productId: product.id, buildId, costUsd: 1.25 },
      { source: "platform", endpoint: "brief", buildId: laterBuild!.id, costUsd: 0.25 },
      { source: "gateway", endpoint: "responses", productId: product.id, costUsd: 9, at: yesterday },
      { source: "gateway", endpoint: "responses", productId: theirs.id, costUsd: 7 },
      { source: "docs", endpoint: "responses", costUsd: 3 },
    ]);
    assert.equal(await spend.builderSpendToday(owner.user.id, now), 2);
  });

  it("checkBuildAllowed's trust part: a ban, the 18+ confirmation and the builder's daily dollars", async () => {
    const owner = await maker();
    const session = { id: owner.user.id, email: owner.user.email, isAdmin: false };
    const noCookie = async () => null;
    assert.equal(await account.trustBuildRefusal(session, noCookie), null, "every flag off");

    process.env.TRUST_AGE_GATE = "1";
    const unconfirmed = await account.trustBuildRefusal(session, noCookie);
    assert.equal(unconfirmed?.status, 403);
    assert.match(unconfirmed!.error, /18 or older/);
    await account.recordConfirmation(owner.user.id);
    assert.equal(await account.trustBuildRefusal(session, noCookie), null);
    const guest = { id: randomUUID(), email: "guest@musemuse.invalid", isAdmin: false, openAccess: true };
    assert.equal((await account.trustBuildRefusal(guest, noCookie))?.status, 403);
    const { TERMS_VERSION } = await import("../terms");
    assert.equal(await account.trustBuildRefusal(guest, async () => TERMS_VERSION), null, "the guest's cookie");
    assert.equal((await account.trustBuildRefusal(guest, async () => "2020-01-01"))?.status, 403, "an older terms version asks again");

    process.env.TRUST_SIGNED_IN_CAPS = "1";
    process.env.TRUST_BUILDER_DAILY_USD = "1";
    const { product } = await shipped(owner);
    await testDb.insert(realSchema.usage).values({ source: "gateway", endpoint: "responses", productId: product.id, costUsd: 1.5 });
    const over = await account.trustBuildRefusal(session, noCookie);
    assert.equal(over?.status, 429);
    assert.match(over!.error, /\$1\.00/);
    process.env.ADMIN_EMAILS = owner.user.email;
    assert.equal(await account.trustBuildRefusal({ ...session, isAdmin: true }, noCookie), null, "admins have no builder cap");

    process.env.TRUST_REPORTS = "1";
    await testDb.update(realSchema.users).set({ bannedAt: new Date() }).where(eq(realSchema.users.id, owner.user.id));
    const banned = await account.trustBuildRefusal(session, noCookie);
    assert.equal(banned?.status, 403);
    assert.match(banned!.error, /can't sign in or build/);
  });

  it("sign-in refuses a banned builder, asks for the 18+ box once, and records it", async () => {
    const owner = await maker();
    const session = { id: owner.user.id, email: owner.user.email, isAdmin: false };
    assert.equal(account.trustSignInCheck({}), undefined, "nothing with the flags off");
    process.env.TRUST_AGE_GATE = "1";
    const { TERMS_VERSION } = await import("../terms");
    await assert.rejects(account.trustSignInCheck({})!(session), (err: unknown) => err instanceof account.TrustRefusal && err.status === 400);
    await assert.rejects(account.trustSignInCheck({ adult: true, termsVersion: "old" })!(session), account.TrustRefusal);
    await account.trustSignInCheck({ adult: true, termsVersion: TERMS_VERSION })!(session);
    const user = (await testDb.select().from(realSchema.users).where(eq(realSchema.users.id, owner.user.id)))[0]!;
    assert.ok(user.adultConfirmedAt);
    assert.equal(user.termsVersion, TERMS_VERSION);
    await account.trustSignInCheck({})!(session);
    assert.equal(await account.needsConfirmation(session, async () => null), false, "asked once");

    process.env.TRUST_REPORTS = "1";
    await testDb.update(realSchema.users).set({ bannedAt: new Date() }).where(eq(realSchema.users.id, owner.user.id));
    await assert.rejects(account.trustSignInCheck({})!(session), (err: unknown) => err instanceof account.TrustRefusal && err.status === 403);
  });
});
