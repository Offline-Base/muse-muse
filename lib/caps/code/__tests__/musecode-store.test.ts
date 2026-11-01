/**
 * Muse Code sessions' database on an in-memory PGlite migrated with drizzle/: a session token lives only while its
 * session does (dead at stop and at its limit), never reaches findToken, shares the product's daily budget both ways,
 * and a build's totals count what a running session may still use (docs/CAPABILITIES.md, 15b).
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/code/__tests__/musecode-store.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-the-session-store";

describe("Muse Code sessions' rows", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let store: typeof import("../musecode/store");
  let gateway: typeof import("../musecode/gateway");
  let tokens: typeof import("@/lib/gateway/tokens");
  let tokenFor: typeof import("../musecode/token").sessionTokenFor;
  let productId = "";
  let parentId = "";
  const pepper = process.env.GATEWAY_TOKEN_PEPPER!;

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    store = await import("../musecode/store");
    gateway = await import("../musecode/gateway");
    tokens = await import("@/lib/gateway/tokens");
    tokenFor = (await import("../musecode/token")).sessionTokenFor;
    const [user] = await testDb.insert(realSchema.users).values({ email: "maker@example.com" }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: "cleaner", name: "Cleaner", ownerId: user!.id, status: "live" }).returning();
    productId = product!.id;
    const [parent] = await testDb.insert(realSchema.gatewayTokens).values({ productId, tokenHash: "parent-hash", scope: "live", allowedModels: ["muse-wonder-1.0", "cap:code"], dailyBudgetUsd: 3 }).returning();
    parentId = parent!.id;
  });
  after(() => client?.close());

  /** A session and its token row, as a start leaves them. */
  async function session(over: { status?: "starting" | "running"; endsAt?: Date; budget?: number; namespace?: string; product?: string; parent?: string } = {}) {
    const id = randomUUID();
    const endsAt = over.endsAt ?? new Date(Date.now() + 15 * 60_000);
    const token = tokenFor(id, pepper);
    const { id: tokenId } = await tokens.storeCodeSessionToken({ token, productId: over.product ?? productId, model: "muse-wonder-1.0", budgetUsd: over.budget ?? 1, expiresAt: endsAt });
    await store.codeSessionStore.insert({ id, productId: over.product ?? productId, namespace: over.namespace ?? "live", parentTokenId: over.parent ?? parentId, principal: "owner", subjectKey: "s1", model: "muse-wonder-1.0", sandboxName: `mm-${id}`, budgetUsd: over.budget ?? 1, limitMs: 900_000, endsAt });
    await store.codeSessionStore.update(id, { tokenId, status: over.status ?? "running", startedAt: new Date() });
    return { id, token, tokenId };
  }

  const spend = (tokenId: string | null, costUsd: number, at = new Date()) => testDb.insert(realSchema.usage).values({ source: "gateway", endpoint: "responses", productId, tokenId, model: "muse-wonder-1.0", costUsd, at });

  it("finds a session token only through its own lookup, and findToken never returns one", async () => {
    const s = await session();
    const found = await gateway.findSessionGatewayToken(s.token);
    assert.equal(found?.scope, "code_session");
    assert.deepEqual(found?.allowedModels, ["muse-wonder-1.0"]);
    assert.equal(await tokens.findToken(s.token), null);
    assert.equal(await gateway.findSessionGatewayToken("mm_live_notasessiontokenatallxxxxxxxxxx"), null);
    assert.equal(await gateway.findSessionGatewayToken(tokenFor(randomUUID(), pepper)), null);
  });

  it("is dead at stop, at its limit, and when its session has ended or its parent was revoked", async () => {
    const stopped = await session();
    await tokens.revokeTokenById(stopped.tokenId);
    assert.equal(await gateway.findSessionGatewayToken(stopped.token), null, "revoked at stop");
    const past = await session({ endsAt: new Date(Date.now() - 1_000) });
    assert.equal(await gateway.findSessionGatewayToken(past.token), null, "past its limit");
    const ended = await session();
    await store.codeSessionStore.update(ended.id, { status: "completed" });
    assert.equal(await gateway.findSessionGatewayToken(ended.token), null, "its session ended");
    const [other] = await testDb.insert(realSchema.gatewayTokens).values({ productId, tokenHash: "other-parent", scope: "live", allowedModels: [], dailyBudgetUsd: 3, revokedAt: new Date() }).returning();
    const orphan = await session({ parent: other!.id });
    assert.equal(await gateway.findSessionGatewayToken(orphan.token), null, "the product's token was revoked");
  });

  it("hands the gateway what's left as a budget, the smaller of the session's and the product's, shared both ways", async () => {
    const [parent] = await testDb.insert(realSchema.gatewayTokens).values({ productId, tokenHash: "budget-parent", scope: "live", allowedModels: [], dailyBudgetUsd: 1.5 }).returning();
    const s = await session({ parent: parent!.id });
    await spend(s.tokenId, 0.25);
    let t = await gateway.findSessionGatewayToken(s.token);
    assert.ok(Math.abs(t!.dailyBudgetUsd - 0.25 - 0.75) < 1e-6, `$1 session, $0.25 spent: ${t!.dailyBudgetUsd}`);
    await spend(parent!.id, 1);
    t = await gateway.findSessionGatewayToken(s.token);
    assert.ok(Math.abs(t!.dailyBudgetUsd - 0.25 - 0.25) < 1e-6, `$1.50 product, $1.25 spent together: ${t!.dailyBudgetUsd}`);
    // The product's own calls see the session's spend too.
    assert.ok(Math.abs((await store.familySpendToday(parent!.id)) - 1.25) < 1e-6);
    assert.ok(Math.abs((await store.familySpendToday(s.tokenId)) - 0.25) < 1e-6, "a session's token counts itself");
    // A session that crosses midnight keeps its whole-session limit.
    const late = await session({ parent: parent!.id, budget: 0.5 });
    await spend(late.tokenId, 0.4, new Date(Date.now() - 2 * 86_400_000));
    assert.ok((await store.sessionSpendUsd(late.tokenId)) > 0.39);
    const lateTok = await gateway.findSessionGatewayToken(late.token);
    assert.ok(lateTok!.dailyBudgetUsd < 0.11 + 1e-6, String(lateTok!.dailyBudgetUsd));
  });

  it("counts running sessions, for this product and in all, leaving out those past their limit and grace", async () => {
    const [user] = await testDb.insert(realSchema.users).values({ email: "other@example.com" }).returning();
    const [other] = await testDb.insert(realSchema.products).values({ slug: "other", name: "Other", ownerId: user!.id, status: "live" }).returning();
    const now = new Date();
    const before = await store.codeSessionStore.countActive(other!.id, now);
    await session({ product: other!.id });
    await session({ product: other!.id, endsAt: new Date(Date.now() - 3_600_000) });
    const after = await store.codeSessionStore.countActive(other!.id, now);
    assert.equal(after.product, 1);
    assert.equal(after.all, before.all + 1);
  });

  it("totals a build's sessions: a running one counts its whole budget and time, and one that never started counts nothing", async () => {
    const ns = `b:${randomUUID()}`;
    const now = new Date();
    assert.deepEqual(await store.codeSessionStore.buildTotals(ns, now), { sessions: 0, ms: 0, usd: 0, worked: 0 });
    const done = await session({ namespace: ns, budget: 0.5, endsAt: new Date(now.getTime() + 300_000) });
    await spend(done.tokenId, 0.1);
    await store.codeSessionStore.update(done.id, { status: "completed", startedAt: new Date(now.getTime() - 60_000), endedAt: now });
    const one = await store.codeSessionStore.buildTotals(ns, now);
    assert.equal(one.sessions, 1);
    assert.equal(one.ms, 60_000);
    assert.ok(Math.abs(one.usd - 0.1) < 1e-6);
    await session({ namespace: ns, budget: 0.4, endsAt: new Date(now.getTime() + 240_000) });
    const two = await store.codeSessionStore.buildTotals(ns, now);
    assert.equal(two.sessions, 2);
    assert.ok(two.ms >= 60_000 + 200_000);
    assert.ok(Math.abs(two.usd - 0.5) < 1e-6, "$0.10 spent and the running one's $0.40");
    const failed = randomUUID();
    await store.codeSessionStore.insert({ id: failed, productId, namespace: ns, parentTokenId: parentId, principal: "build", subjectKey: null, model: "muse-wonder-1.0", sandboxName: "x", budgetUsd: 0.1, limitMs: 1, endsAt: now });
    await store.codeSessionStore.update(failed, { status: "failed" });
    assert.equal((await store.codeSessionStore.buildTotals(ns, now)).sessions, 2);
    const proof = await store.museCodeProof(ns);
    assert.equal(proof.museCode, 2);
    assert.equal(proof.museCodeWorked, 0);
    await store.codeSessionStore.update(done.id, { worked: true });
    assert.equal((await store.museCodeProof(ns)).museCodeWorked, 1);
    assert.equal((await store.codeSessionStore.buildTotals(ns, now)).worked, 1, "what a third start asks");
  });

  it("proves a build's real run for all its verifies: a run from an earlier verify still counts", async () => {
    const ns = `b:${randomUUID()}`;
    const earlier = await session({ namespace: ns, budget: 0.1 });
    await store.codeSessionStore.update(earlier.id, { status: "completed", worked: true, endedAt: new Date() });
    await testDb.update(realSchema.codeSessions).set({ createdAt: new Date(Date.now() - 3_600_000) }).where(eq(realSchema.codeSessions.id, earlier.id));
    assert.deepEqual(await store.museCodeProof(ns), { museCode: 1, museCodeWorked: 1 });
  });

  it("clears a session's steps and final text past 24 hours, and keeps its row, counts and cost", async () => {
    const now = new Date();
    const old = await session();
    const fresh = await session();
    const still = await session();
    const text = { events: [{ n: 0, kind: "say", text: "It read people.csv" }], finalText: "The answer quotes a person's file", condense: { announced: ["x"] }, files: [{ path: "people.csv", bytes: 3 }], dropped: [{ path: "x", why: "y" }], reason: "Muse Code finished.", costUsd: 0.25, worked: true };
    await store.codeSessionStore.update(old.id, { status: "completed", endedAt: new Date(now.getTime() - 25 * 3_600_000), ...text });
    await store.codeSessionStore.update(fresh.id, { status: "completed", endedAt: new Date(now.getTime() - 3_600_000), ...text });
    await store.codeSessionStore.update(still.id, { ...text });
    assert.ok((await store.clearOldSessionText(new Date(now.getTime() - 24 * 3_600_000))) >= 1);
    const cleared = (await store.codeSessionStore.get(old.id))!;
    assert.deepEqual([cleared.events, cleared.finalText, cleared.condense, cleared.files, cleared.dropped, cleared.reason], [[], null, {}, [], [], null]);
    assert.equal(cleared.costUsd, 0.25);
    assert.equal(cleared.worked, true);
    assert.equal(cleared.tokenId, old.tokenId, "the day's spend still finds its token");
    assert.equal((await store.codeSessionStore.get(fresh.id))!.finalText, text.finalText);
    assert.equal((await store.codeSessionStore.get(still.id))!.finalText, text.finalText, "a running session is never cleared");
  });

  it("finds active sessions, sandbox names held, expired zips and a build's zips, and clears them", async () => {
    const now = new Date();
    const overdue = await session({ endsAt: new Date(now.getTime() - 120_000) });
    assert.ok((await store.activeSessionsWhere({})).some((r) => r.id === overdue.id));
    assert.ok((await store.activeSandboxNames()).has(`mm-${overdue.id}`));
    await store.codeSessionStore.update(overdue.id, { status: "expired", resultUrl: "https://b/x.zip", resultExpiresAt: new Date(now.getTime() - 1) });
    assert.ok(!(await store.activeSessionsWhere({})).some((r) => r.id === overdue.id));
    assert.ok((await store.expiredResults(now)).some((r) => r.id === overdue.id));
    await store.clearResult(overdue.id);
    assert.ok(!(await store.expiredResults(now)).some((r) => r.id === overdue.id));
    const ns = `b:${randomUUID()}`;
    const b = await session({ namespace: ns });
    await store.codeSessionStore.update(b.id, { status: "completed", resultUrl: "https://b/y.zip" });
    assert.deepEqual(await store.buildResultUrls(ns), ["https://b/y.zip"]);
    await store.deleteBuildSessions(ns);
    assert.equal(await store.codeSessionStore.get(b.id), null);
  });

  it("reads the brief behind a token: a build's own, or the live product's latest", async () => {
    const [user] = await testDb.select().from(realSchema.users).limit(1);
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    const brief = { code: { runtimes: [], browse: false, museCode: true } } as never;
    const [build] = await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId: user!.id, productId, brief }).returning();
    assert.deepEqual(await store.briefOfToken({ scope: "build", productId, buildId: build!.id }), brief);
    assert.equal(await store.briefOfToken({ scope: "build", productId, buildId: null }), null);
    assert.equal(await store.briefOfToken({ scope: "live", productId, buildId: null }), null, "no live build yet");
    await testDb.update(realSchema.products).set({ latestBuildId: build!.id });
    assert.deepEqual(await store.briefOfToken({ scope: "live", productId, buildId: null }), brief);
  });
});
