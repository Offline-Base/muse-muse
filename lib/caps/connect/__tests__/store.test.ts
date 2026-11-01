/**
 * The connect cap on a real Postgres (in-memory PGlite, nothing on disk): the fetch cache, keys saved, replaced and
 * revoked through the real handler, one send per approval, the gateway's record for a build (/caps/proof) and cleanup.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/connect/__tests__/store.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";
import type { CapProduct, CapToken } from "@/lib/caps/gate";
import { newBoxKey, openSecret, parseKeyring } from "@/lib/secrets/box";
import { mintOwnerSession } from "@/lib/tools/principal";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-connect-store";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

describe("connect on a database", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let store: typeof import("../store");
  let handler: typeof import("../handler");
  let productId = "";
  let buildId = "";
  const ring = parseKeyring(newBoxKey())!;
  const BRIEF = { connect: { publicApis: ["nws"], keys: [{ service: "github", why: "Repos." }], sends: [{ channel: "email", why: "Plans." }] } };

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    (testDb as unknown as { batch: (q: PromiseLike<unknown>[]) => Promise<unknown[]> }).batch = async (queries) => {
      const out: unknown[] = [];
      for (const q of queries) out.push(await q);
      return out;
    };
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    store = await import("../store");
    handler = await import("../handler");
    const [user] = await testDb.insert(realSchema.users).values({ email: "maker@example.com" }).returning();
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: "planner", name: "Planner", ownerId: user!.id, status: "live" }).returning();
    const [build] = await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId: user!.id, productId: product!.id, brief: BRIEF as never }).returning();
    productId = product!.id;
    buildId = build!.id;
  });
  after(() => client?.close());

  const NOW = new Date();
  const live = (): CapToken => ({ id: "tok-live", productId, scope: "live", allowedModels: ["cap:connect"], dailyBudgetUsd: 3, buildId: null });
  const buildTok = (): CapToken => ({ id: "tok-build", productId, scope: "build", allowedModels: ["cap:connect"], dailyBudgetUsd: 3, buildId });
  const product = (): CapProduct => ({ status: "live", manifest: null, liveUrl: "https://planner.example", takenDownAt: null, ownerId: "u1", ownerEmail: "maker@example.com", ownerIsAdmin: false, ownerBannedAt: null });
  const counters = new Map<string, number>();

  function deps(tok: CapToken): import("../handler").ConnectDeps {
    return {
      servedCaps: () => ["connect"],
      findToken: async () => tok,
      product: async () => product(),
      adminEmails: [],
      hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 1])),
      reserveCounter: async (key, _w, amount, limit) => {
        const next = (counters.get(key) ?? 0) + amount;
        if (next > limit) return null;
        counters.set(key, next);
        return next;
      },
      recordUsage: async (ctx, items) => {
        await testDb.insert(realSchema.usage).values(items.map((u) => ({ source: ctx.source, endpoint: ctx.endpoint, productId: ctx.productId ?? null, buildId: ctx.buildId ?? null, tokenId: null, model: u.model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: u.units ?? 0, costUsd: 0 })));
      },
      store: store.connectStore,
      vaultOn: () => true,
      sendsOn: () => true,
      keyring: () => ring,
      rules: async () => BRIEF.connect as never,
      fetch: (async () => Response.json({ properties: { gridId: "LWX" } })) as typeof fetch,
      userAgent: "test",
      now: () => NOW,
    };
  }
  const owner = () => ({ "x-musemuse-owner": mintOwnerSession({ productId, subject: "owner-sub" }, NOW).session });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`https://platform.example/api/gateway/${path}`, { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("caches a public answer for its route's time, shared by every product", async () => {
    const res = await handler.handleFetch(post("fetch", { api: "nws", path: "/points/38.8894,-77.0352" }), deps(live()));
    assert.equal(res.status, 200);
    const [row] = await testDb.select().from(realSchema.publicFetchCache);
    assert.equal(row!.api, "nws");
    assert.equal(row!.expiresAt.getTime() - row!.fetchedAt.getTime(), 86_400_000);
    assert.deepEqual(JSON.parse(row!.body.toString("utf8")), { properties: { gridId: "LWX" } });
    assert.equal(((await res.json()) as { cached: boolean }).cached, false);
    const again = (await (await handler.handleFetch(post("fetch", { api: "nws", path: "/points/38.8894,-77.0352" }), deps(live()))).json()) as { cached: boolean };
    assert.equal(again.cached, true);
  });

  it("saves a key sealed, replaces it by name, revokes it, and keeps one active row", async () => {
    await handler.handleVault(post("vault", { service: "github", value: "ghp_firstMadeUpKey0001" }, owner()), [], deps(live()));
    await handler.handleVault(post("vault", { service: "github", value: "ghp_secondMadeUpKey002" }, owner()), [], deps(live()));
    const rows = await testDb.select().from(realSchema.productSecrets);
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => !r.revokedAt).length, 1);
    const active = rows.find((r) => !r.revokedAt)!;
    assert.equal(openSecret(active, ring, `vault:${productId}:live:github`), "ghp_secondMadeUpKey002");
    assert.ok(!JSON.stringify(rows).includes("ghp_"), "no row holds the plaintext");
    assert.equal(active.createdBy?.length, 32, "a subject key, not a raw id");
    const del = await handler.handleVault(new Request("https://platform.example/api/gateway/vault/github", { method: "DELETE", headers: { authorization: "Bearer x", ...owner() } }), ["github"], deps(live()));
    assert.equal(del.status, 200);
    assert.deepEqual(await store.connectStore.listKeys(productId, "live"), []);
  });

  it("records the build's sampled fetch, test key and simulated send in its record, and clears them when it ends", async () => {
    const since = new Date(Date.now() - 1000);
    const t = buildTok();
    await handler.handleFetch(post("fetch", { api: "nws", path: "/points/38.8894,-77.0352" }), deps(t));
    const canary = "mmtest_ABCDEFGHIJKLMNOPQRSTUVWX";
    await handler.handleVault(post("vault", { service: "github", value: canary }), [], deps(t));
    const first = (await (await handler.handleSend(post("send", { channel: "email", to: ["a@example.com"], subject: "Hi", body: "Plan" }), deps(t))).json()) as { confirmation: { id: string } };
    const sent = (await (await handler.handleSend(post("send", { channel: "email", to: ["a@example.com"], subject: "Hi", body: "Plan", approval: first.confirmation.id }), deps(t))).json()) as { simulated: boolean };
    assert.equal(sent.simulated, true);
    const proof = await store.connectProof(buildId, { since });
    const hash = createHash("sha256").update(canary).digest("hex").slice(0, 16);
    assert.deepEqual(proof, { fetches: 1, calls: 0, sends: 1, keys: 1, [`secret-sha:${hash}`]: 1, "brief:api:nws": 1, "brief:key:github": 1, "brief:send:email": 1 });
    const later = await store.connectProof(buildId, { since: new Date(Date.now() + 60_000) });
    assert.equal(later.fetches, 0);
    assert.equal(later[`secret-sha:${hash}`], 1, "the leak scan sees every test key of the build, whenever saved");
    // One approval, one row.
    await assert.rejects(async () =>
      testDb.insert(realSchema.productSends).values({ productId, namespace: `b:${buildId}`, channel: "email", recipientHash: "h", approvalNonce: (await testDb.select().from(realSchema.productSends))[0]!.approvalNonce, status: "simulated" }),
    );
    await store.clearConnectBuild(buildId);
    assert.equal((await testDb.select().from(realSchema.productSends)).length, 0);
    assert.equal((await testDb.select().from(realSchema.productSecrets)).filter((r) => r.namespace.startsWith("b:")).length, 0);
  });

  it("sweeps expired cache rows, keys revoked a day ago and a crashed build's test keys, and keeps live keys", async () => {
    const day = 24 * 3_600_000;
    const now = new Date();
    await testDb.insert(realSchema.publicFetchCache).values({ key: "old", api: "nws", status: 200, body: Buffer.from("{}"), fetchedAt: new Date(now.getTime() - 2 * day), expiresAt: new Date(now.getTime() - day) });
    const sealed = { productId, service: "github", ciphertext: Buffer.from([1]), iv: Buffer.alloc(12), tag: Buffer.alloc(16), keyVersion: 1 };
    await testDb.insert(realSchema.productSecrets).values([
      { ...sealed, name: "gone", revokedAt: new Date(now.getTime() - 2 * day) },
      { ...sealed, name: "crashed", namespace: "b:00000000-0000-4000-8000-000000000000", createdAt: new Date(now.getTime() - 2 * day) },
      { ...sealed, name: "kept" },
    ]);
    const removed = await store.sweepConnect(now);
    assert.ok(removed >= 3, String(removed));
    assert.ok(!(await testDb.select().from(realSchema.publicFetchCache)).some((r) => r.key === "old"));
    const names = (await testDb.select().from(realSchema.productSecrets)).map((r) => r.name);
    assert.ok(names.includes("kept"));
    assert.ok(!names.includes("gone") && !names.includes("crashed"), names.join());
    assert.ok(names.includes("github"), "a key revoked minutes ago stays until a day has passed");
  });
});
