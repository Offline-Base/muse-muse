/**
 * {GATEWAY_URL}/data and /identity/user on a real Postgres (PGlite, migrated with drizzle/): every scope against every
 * principal, quotas, version_conflict, soft deletes and their counts, paging, deleteMine, the build namespace, the
 * gateway's record (CAP_PROOF.data), cleanup, the sign-in code's exchange and the owner's view.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/data/__tests__/data.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";
import { mintTestUserSession, mintUserCode, mintUserSession } from "@/lib/caps/data/identity";
import type { CapProduct, CapToken } from "@/lib/caps/gate";
import { BUILD_TEST_OWNER } from "@/lib/caps/principal";
import { mintOwnerSession } from "@/lib/tools/principal";
import { eq } from "drizzle-orm";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-data";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;
type Handler = typeof import("../handler");
type Store = typeof import("../store");
type DataDeps = import("../handler").DataDeps;
type Rules = import("@/lib/caps/data/types").DataCollectionRule[];

describe("data on a database", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let handler: Handler;
  let store: Store;
  let owner: typeof import("../owner");
  let limits: typeof import("../limits");
  let productId = "";
  let buildId = "";
  const NOW = new Date();
  const RULES: Rules = [
    { name: "groceries", scope: "shared", writes: "anyone" },
    { name: "notices", scope: "shared", writes: "owner" },
    { name: "posts", scope: "shared", writes: "signed_in" },
    { name: "notes", scope: "visitor" },
    { name: "drafts", scope: "owner" },
    { name: "lists", scope: "user" },
  ];

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    // Neon runs a batch as one transaction; PGlite has one connection, so in order is the same here (lib/db/client.ts).
    (testDb as unknown as { batch: (q: PromiseLike<unknown>[]) => Promise<unknown[]> }).batch = async (queries) => {
      const out: unknown[] = [];
      for (const q of queries) out.push(await q);
      return out;
    };
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    handler = await import("../handler");
    store = await import("../store");
    owner = await import("../owner");
    limits = await import("../limits");
    const [user] = await testDb.insert(realSchema.users).values({ email: "maker@example.com" }).returning();
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: "lists", name: "Lists", ownerId: user!.id, status: "live" }).returning();
    const [build] = await testDb
      .insert(realSchema.builds)
      .values({ inspirationId: muse!.id, userId: user!.id, productId: product!.id, brief: { data: { collections: RULES.slice(0, 2), signIn: "optional" } } as never })
      .returning();
    productId = product!.id;
    buildId = build!.id;
  });
  after(() => client?.close());
  beforeEach(async () => {
    await client.exec("delete from product_rows; delete from product_data_counts; delete from rate_limits;");
  });

  const live = (): CapToken => ({ id: "tok-live", productId, scope: "live", allowedModels: ["cap:data"], dailyBudgetUsd: 3, buildId: null });
  const buildTok = (): CapToken => ({ id: "tok-build", productId, scope: "build", allowedModels: ["cap:data"], dailyBudgetUsd: 10, buildId });
  const product = (): CapProduct => ({ status: "live", manifest: { caps: ["data"] }, liveUrl: "https://lists.example", takenDownAt: null, ownerId: "u1", ownerEmail: "maker@example.com", ownerIsAdmin: false, ownerBannedAt: null });

  const counters = new Map<string, number>();
  function deps(tok: CapToken = live(), over: Partial<DataDeps> = {}): DataDeps {
    return {
      servedCaps: () => ["data"],
      findToken: async () => tok,
      product: async () => product(),
      adminEmails: [],
      hitRateLimits: async (keys, w) => Object.fromEntries(keys.map((k) => [k, counters.set(`${k}@${w.toISOString()}`, (counters.get(`${k}@${w.toISOString()}`) ?? 0) + 1).get(`${k}@${w.toISOString()}`)!])),
      reserveCounter: async (key, w, amount, limit) => {
        const at = `${key}@${w.toISOString()}`;
        const next = (counters.get(at) ?? 0) + amount;
        if (next > limit) return null;
        counters.set(at, next);
        return next;
      },
      store: store.dataStore,
      quotas: () => ({ productRows: 10_000, productBytes: 50 * 1024 * 1024, dailyWrites: 5_000 }),
      signInOn: () => true,
      rules: async () => RULES,
      platformUrl: "https://musemuse.example",
      productSlug: async () => "lists",
      now: () => NOW,
      ...over,
    };
  }

  const VISITOR_A = "visitor_aaaaaaaaaaaaaaaa";
  const VISITOR_B = "visitor_bbbbbbbbbbbbbbbb";
  const ownerPass = () => mintOwnerSession({ productId, subject: "owner_subject" }, NOW).session;
  const userSession = (subject = "subj_ana") => mintUserSession({ productId, subject }, NOW).session;

  async function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; deps?: DataDeps } = {}) {
    const req = new Request(`https://musemuse.example/api/gateway/data/${path}`, {
      method,
      headers: { authorization: "Bearer mm_live_sample", ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const res = await handler.handleData(req, path.split("?")[0]!.split("/").filter(Boolean), opts.deps ?? deps());
    const json = (await res.json().catch(() => null)) as Record<string, unknown> & { error?: { code: string; message: string } };
    return { status: res.status, json, code: json?.error?.code };
  }
  const as = (who: { visitor?: string; owner?: boolean; user?: string; ip?: string }) => ({
    ...(who.visitor ? { "x-musemuse-visitor": who.visitor } : {}),
    ...(who.owner ? { "x-musemuse-owner": ownerPass() } : {}),
    ...(who.user ? { "x-musemuse-user": who.user } : {}),
    ...(who.ip ? { "x-musemuse-client-ip": who.ip } : {}),
  });

  it("shared items: everyone reads them; who writes follows the collection", async () => {
    // writes: owner
    assert.equal((await call("POST", "notices", { body: { data: { t: "x" } }, headers: as({ visitor: VISITOR_A }) })).code, "sign_in_required");
    const notice = await call("POST", "notices", { body: { data: { t: "Closed Monday" } }, headers: as({ owner: true }) });
    assert.equal(notice.status, 201);
    assert.equal(notice.json.version, 1);
    const read = await call("GET", `notices/${notice.json.id}`);
    assert.deepEqual(read.json.data, { t: "Closed Monday" }, "a product call with no one behind it reads shared items");
    // writes: anyone
    assert.equal((await call("POST", "groceries", { body: { data: { name: "Milk" } } })).code, "sign_in_required", "no visitor id at all");
    assert.equal((await call("POST", "groceries", { body: { data: { name: "Milk" } }, headers: as({ visitor: VISITOR_A }) })).status, 201);
    const seen = await call("POST", "groceries/query", { body: {}, headers: as({ visitor: VISITOR_B }) });
    assert.deepEqual((seen.json.items as Array<{ data: unknown }>).map((i) => i.data), [{ name: "Milk" }], "another browser sees it");
    // writes: signed_in
    assert.equal((await call("POST", "posts", { body: { data: { t: "hi" } }, headers: as({ visitor: VISITOR_A }) })).code, "sign_in_required");
    assert.equal((await call("POST", "posts", { body: { data: { t: "hi" } }, headers: as({ user: userSession() }) })).status, 201);
    // A scope that isn't the collection's, and a collection that isn't listed.
    assert.equal((await call("POST", "groceries?scope=visitor", { body: { data: {} }, headers: as({ visitor: VISITOR_A }) })).code, "cap_not_allowed");
    assert.equal((await call("POST", "secrets", { body: { data: {} }, headers: as({ owner: true }) })).code, "cap_not_allowed");
  });

  it("visitor items stay with one browser; owner items need the pass; user items follow the person", async () => {
    await call("POST", "notes", { body: { data: { t: "A's note" } }, headers: as({ visitor: VISITOR_A }) });
    const a = await call("POST", "notes/query", { body: {}, headers: as({ visitor: VISITOR_A }) });
    const b = await call("POST", "notes/query", { body: {}, headers: as({ visitor: VISITOR_B }) });
    assert.equal((a.json.items as unknown[]).length, 1);
    assert.equal((b.json.items as unknown[]).length, 0, "the second browser doesn't see it");
    assert.equal((await call("POST", "notes/query", { body: {} })).code, "sign_in_required");

    assert.equal((await call("POST", "drafts", { body: { data: { t: "x" } }, headers: as({ visitor: VISITOR_A }) })).code, "sign_in_required");
    assert.equal((await call("POST", "drafts", { body: { data: { t: "x" } }, headers: as({ owner: true }) })).status, 201);
    assert.equal((await call("POST", "drafts/query", { body: {}, headers: as({ owner: true }) })).json.items instanceof Array, true);

    const ana = userSession("subj_ana");
    assert.equal((await call("PUT", "lists/me", { body: { data: { items: ["eggs"] } }, headers: as({ visitor: VISITOR_A }) })).code, "sign_in_required");
    assert.equal((await call("PUT", "lists/me", { body: { data: { items: ["eggs"] } }, headers: as({ user: ana, visitor: VISITOR_A }) })).status, 200);
    const onPhone = await call("GET", "lists/me", { headers: as({ user: ana, visitor: VISITOR_B }) });
    assert.deepEqual(onPhone.json.data, { items: ["eggs"] }, "the same person on another browser");
    assert.equal((await call("GET", "lists/me", { headers: as({ user: userSession("subj_bo") }) })).status, 404, "another person has their own");
    const forged = ana.slice(0, -3) + "abc";
    assert.equal((await call("GET", "lists/me", { headers: as({ user: forged }) })).code, "sign_in_required");
  });

  it("refuses a body with unknown keys, an item over 64 KB, a non-object item, and a bad id", async () => {
    const h = as({ owner: true });
    assert.equal((await call("POST", "notices", { body: { data: {}, extra: 1 }, headers: h })).code, "invalid_arguments");
    assert.equal((await call("POST", "notices", { body: { data: [1, 2] }, headers: h })).code, "invalid_arguments");
    assert.equal((await call("POST", "notices", { body: { data: { t: "x".repeat(64 * 1024) } }, headers: h })).code, "invalid_arguments");
    assert.equal((await call("GET", "notices/has%20space", { headers: h })).code, "invalid_arguments");
    assert.equal((await call("POST", "Bad-Name", { body: { data: {} }, headers: h })).code, "invalid_arguments");
    assert.equal((await call("PATCH", "notices/a", { body: {}, headers: h })).status, 404);
  });

  it("put checks ifVersion (409 version_conflict), delete is soft and gives the quota back, and a put revives the id", async () => {
    const h = as({ owner: true });
    const made = await call("PUT", "notices/hours", { body: { data: { open: 9 } }, headers: h });
    assert.equal(made.json.version, 1);
    const next = await call("PUT", "notices/hours", { body: { data: { open: 10 }, ifVersion: 1 }, headers: h });
    assert.equal(next.json.version, 2);
    const stale = await call("PUT", "notices/hours", { body: { data: { open: 11 }, ifVersion: 1 }, headers: h });
    assert.equal(stale.status, 409);
    assert.equal(stale.code, "version_conflict");
    assert.equal((await call("PUT", "notices/missing", { body: { data: { a: 1 } , ifVersion: 3 }, headers: h })).code, "version_conflict", "ifVersion on nothing");
    const counts = async () => (await testDb.select().from(realSchema.productDataCounts))[0]!;
    assert.equal((await counts()).rows, 1);
    assert.deepEqual((await call("DELETE", "notices/hours", { headers: h })).json, { deleted: true });
    assert.equal((await call("GET", "notices/hours")).status, 404);
    assert.equal((await counts()).rows, 0);
    assert.equal((await counts()).bytes, 0);
    assert.deepEqual((await call("DELETE", "notices/hours", { headers: h })).json, { deleted: false });
    const revived = await call("PUT", "notices/hours", { body: { data: { open: 8 } }, headers: h });
    assert.equal(revived.json.version, 3, "a revived id keeps counting, so an old ifVersion still conflicts");
    assert.equal((await counts()).rows, 1);
  });

  it("holds every quota: the product's rows and bytes, collections, each person's rows, and the day's writes", async () => {
    const h = as({ owner: true });
    const tight = deps(live(), { quotas: () => ({ productRows: 2, productBytes: 50 * 1024 * 1024, dailyWrites: 5_000 }) });
    assert.equal((await call("POST", "notices", { body: { data: { n: 1 } }, headers: h, deps: tight })).status, 201);
    assert.equal((await call("POST", "notices", { body: { data: { n: 2 } }, headers: h, deps: tight })).status, 201);
    const full = await call("POST", "notices", { body: { data: { n: 3 } }, headers: h, deps: tight });
    assert.equal(full.status, 429);
    assert.equal(full.code, "quota_exceeded");
    assert.match(full.json.error!.message, /as many items as it can \(2\)/);
    // A put that replaces takes no new row, so it still fits.
    const ids = ((await call("POST", "notices/query", { body: {}, deps: tight })).json.items as Array<{ id: string }>).map((i) => i.id);
    assert.equal((await call("PUT", `notices/${ids[0]}`, { body: { data: { n: 9 } }, headers: h, deps: tight })).status, 200);
    const small = deps(live(), { quotas: () => ({ productRows: 100, productBytes: 30, dailyWrites: 5_000 }) });
    assert.match((await call("PUT", `notices/${ids[0]}`, { body: { data: { n: "x".repeat(40) } }, headers: h, deps: small })).json.error!.message, /as much as it can/);

    const L = limits.DATA_LIMITS as unknown as { rowsPerVisitor: number; collectionsPerProduct: number; anyoneWritesPerIpPerMinute: number };
    const before = { visitor: L.rowsPerVisitor, collections: L.collectionsPerProduct };
    L.rowsPerVisitor = 2;
    L.collectionsPerProduct = 3;
    try {
      for (const t of ["a", "b"]) assert.equal((await call("POST", "notes", { body: { data: { t } }, headers: as({ visitor: VISITOR_A }) })).status, 201);
      assert.match((await call("POST", "notes", { body: { data: { t: "c" } }, headers: as({ visitor: VISITOR_A }) })).json.error!.message, /as one person can \(2\)/);
      assert.equal((await call("POST", "notes", { body: { data: { t: "c" } }, headers: as({ visitor: VISITOR_B }) })).status, 201, "another visitor has their own count");
      assert.equal((await call("POST", "drafts", { body: { data: {} }, headers: h })).status, 201);
      assert.match((await call("POST", "groceries", { body: { data: {} }, headers: h })).json.error!.message, /already uses 3 collections/);
    } finally {
      L.rowsPerVisitor = before.visitor;
      L.collectionsPerProduct = before.collections;
    }
    const daily = deps(live(), { quotas: () => ({ productRows: 100, productBytes: 1e9, dailyWrites: 1 }) });
    await call("POST", "drafts", { body: { data: {} }, headers: h, deps: daily });
    const over = await call("POST", "drafts", { body: { data: {} }, headers: h, deps: daily });
    assert.equal(over.code, "rate_limited");
    assert.match(over.json.error!.message, /today's limit of 1/);
  });

  it("a shared collection anyone writes is limited per person a minute (by IP) and a day (by visitor)", async () => {
    const L = limits.DATA_LIMITS as unknown as { rowsPerVisitor: number; collectionsPerProduct: number; anyoneWritesPerIpPerMinute: number };
    const before = L.anyoneWritesPerIpPerMinute;
    L.anyoneWritesPerIpPerMinute = 1;
    try {
      const who = as({ visitor: VISITOR_A, ip: "203.0.113.9" });
      assert.equal((await call("POST", "groceries", { body: { data: { n: 1 } }, headers: who })).status, 201);
      assert.equal((await call("POST", "groceries", { body: { data: { n: 2 } }, headers: who })).code, "rate_limited");
      assert.equal((await call("POST", "groceries", { body: { data: { n: 3 } }, headers: as({ owner: true, ip: "203.0.113.9" }) })).status, 201, "the owner isn't held to it");
    } finally {
      L.anyoneWritesPerIpPerMinute = before;
    }
  });

  it("pages newest first with an exact cursor, filters on top-level fields, and orders oldest or recent", async () => {
    const h = as({ owner: true });
    for (let i = 0; i < 5; i++) await call("POST", "notices", { body: { data: { i, even: i % 2 === 0 } }, headers: h });
    const first = await call("POST", "notices/query", { body: { limit: 2 } });
    assert.deepEqual((first.json.items as Array<{ data: { i: number } }>).map((x) => x.data.i), [4, 3]);
    const second = await call("POST", "notices/query", { body: { limit: 2, after: first.json.next } });
    assert.deepEqual((second.json.items as Array<{ data: { i: number } }>).map((x) => x.data.i), [2, 1]);
    const third = await call("POST", "notices/query", { body: { limit: 2, after: second.json.next } });
    assert.deepEqual((third.json.items as Array<{ data: { i: number } }>).map((x) => x.data.i), [0]);
    assert.equal(third.json.next, null);
    const evens = await call("POST", "notices/query", { body: { where: { even: true }, order: "oldest" } });
    assert.deepEqual((evens.json.items as Array<{ data: { i: number } }>).map((x) => x.data.i), [0, 2, 4]);
    const ids = (first.json.items as Array<{ id: string }>).map((x) => x.id);
    await call("PUT", `notices/${ids[1]}`, { body: { data: { i: 30, even: false } }, headers: h });
    const recent = await call("POST", "notices/query", { body: { order: "recent", limit: 1 } });
    assert.equal((recent.json.items as Array<{ data: { i: number } }>)[0]!.data.i, 30);
    for (const bad of [{ where: { "a.b": 1 } }, { where: { a: { $gt: 1 } } }, { order: "random" }, { limit: 101 }, { limit: 0 }, { other: 1 }]) {
      assert.equal((await call("POST", "notices/query", { body: bad })).code, "invalid_arguments", JSON.stringify(bad));
    }
  });

  it("deleteMine removes this person's visitor and user items and nothing shared or anyone else's", async () => {
    const ana = userSession("subj_ana");
    await call("POST", "notes", { body: { data: { t: "mine" } }, headers: as({ visitor: VISITOR_A }) });
    await call("POST", "notes", { body: { data: { t: "theirs" } }, headers: as({ visitor: VISITOR_B }) });
    await call("PUT", "lists/me", { body: { data: { t: "mine too" } }, headers: as({ user: ana }) });
    await call("POST", "groceries", { body: { data: { t: "shared" } }, headers: as({ visitor: VISITOR_A }) });
    assert.equal((await call("DELETE", "_mine")).code, "sign_in_required");
    assert.deepEqual((await call("DELETE", "_mine", { headers: as({ visitor: VISITOR_A, user: ana }) })).json, { deleted: 2 });
    assert.equal(((await call("POST", "notes/query", { body: {}, headers: as({ visitor: VISITOR_B }) })).json.items as unknown[]).length, 1);
    assert.equal(((await call("POST", "groceries/query", { body: {} })).json.items as unknown[]).length, 1);
  });

  it("a build works in its own namespace, never sees live rows, and the gateway's record counts it", async () => {
    await call("POST", "groceries", { body: { data: { name: "real milk" } }, headers: as({ visitor: VISITOR_A }) });
    const b = deps(buildTok(), { rules: async () => RULES });
    const since = new Date(Date.now() - 1000);
    assert.equal((await call("POST", "groceries", { body: { data: { name: "test milk" } }, deps: b })).status, 201, "a build stands in for the owner");
    const test = mintTestUserSession({ productId, buildId, subject: "made_up" }, NOW).session;
    assert.equal((await call("PUT", "lists/me", { body: { data: { a: 1 } }, headers: as({ user: test }), deps: b })).status, 200);
    await call("POST", "notes", { body: { data: { a: 1 } }, headers: as({ visitor: VISITOR_A }), deps: b });
    const inBuild = await call("POST", "groceries/query", { body: {}, deps: b });
    assert.deepEqual((inBuild.json.items as Array<{ data: unknown }>).map((i) => i.data), [{ name: "test milk" }]);
    const inLive = await call("POST", "groceries/query", { body: {} });
    assert.deepEqual((inLive.json.items as Array<{ data: unknown }>).map((i) => i.data), [{ name: "real milk" }]);
    assert.deepEqual((await call("GET", "", { deps: b })).json, {
      collections: [
        { name: "groceries", scope: "shared", rows: 1, bytes: 20 },
        { name: "lists", scope: "user", rows: 1, bytes: 7 },
        { name: "notes", scope: "visitor", rows: 1, bytes: 7 },
      ],
    });
    assert.equal((await call("GET", "")).code, "sign_in_required", "only the owner or a build lists the collections");
    const proof = await store.dataProof(buildId, { since });
    assert.equal(proof.writes, 3);
    assert.equal(proof.shared, 1);
    assert.equal(proof.users, 1);
    assert.equal(proof.visitors, 1);
    assert.equal(proof["brief:groceries:shared:anyone"], 1, "the brief's collections, from the build's own row, with who writes them");
    assert.equal(proof["brief:notices:shared:owner"], 1);
    assert.equal((await store.dataProof(buildId, { since: new Date(Date.now() + 60_000) })).writes, 0, "nothing after since");
    await store.clearBuildNamespace(buildId);
    assert.equal(((await call("POST", "groceries/query", { body: {}, deps: b })).json.items as unknown[]).length, 0);
    assert.equal(((await call("POST", "groceries/query", { body: {} })).json.items as unknown[]).length, 1, "live rows stay");
  });

  it("the sweep removes rows deleted over an hour ago and crashed builds' namespaces", async () => {
    const h = as({ owner: true });
    const made = await call("POST", "notices", { body: { data: { a: 1 } }, headers: h });
    await call("DELETE", `notices/${made.json.id}`, { headers: h });
    await call("POST", "groceries", { body: { data: { a: 1 } }, deps: deps(buildTok()) });
    assert.equal(await store.sweepData(new Date()), 0, "nothing is old enough yet");
    assert.equal(await store.sweepData(new Date(Date.now() + 2 * 3_600_000)), 1, "the deleted row, an hour on");
    assert.equal(await store.sweepData(new Date(Date.now() + 25 * 3_600_000)), 1, "the build's row, a day on");
    assert.equal((await testDb.select().from(realSchema.productRows)).length, 0);
  });

  it("a sign-in code becomes a session once, for its own product; a build gets made-up people, 20 at most", async () => {
    const BIND = "bind_browser_aaaaaaaaaaaa";
    const exchange = (code: string, tok: CapToken = live(), bind: string | null = BIND) =>
      handler.handleIdentityUser(new Request("https://musemuse.example/api/gateway/identity/user", { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: JSON.stringify({ code, ...(bind ? { bind } : {}) }) }), deps(tok));
    const code = mintUserCode({ productId, subject: "subj_ana", name: "Ana", bind: BIND }, NOW);
    // Login CSRF: someone else's code, opened in a browser that didn't start the sign-in, signs no one in.
    const elsewhere = await exchange(code, live(), "bind_victim_bbbbbbbbbbbbbb");
    assert.equal(elsewhere.status, 403);
    assert.match(((await elsewhere.json()) as { error: { message: string } }).error.message, /didn't start this sign-in/);
    assert.equal((await exchange(code, live(), null)).status, 403, "no sign-in value at all");
    const first = await exchange(code);
    assert.equal(first.status, 200);
    const body = (await first.json()) as { session: string; user: { id: string; name: string } };
    assert.deepEqual(body.user, { id: "subj_ana", name: "Ana" });
    assert.match(body.session, /^us1\./);
    assert.equal(((await (await exchange(code)).json()) as { error: { code: string } }).error.code, "sign_in_required", "spent");
    const other = mintUserCode({ productId: randomUUID(), subject: "subj_ana", name: "Ana", bind: BIND }, NOW);
    assert.equal((await exchange(other)).status, 403, "another product's code");
    assert.equal((await exchange(mintUserCode({ productId, subject: "s", name: "", bind: BIND }, NOW), buildTok())).status, 403, "a build can't trade a real code");
    const off = await handler.handleIdentityUser(new Request("https://x.example/", { method: "POST", body: "{}" }), deps(live(), { signInOn: () => false }));
    assert.equal(off.status, 404);

    const test = (name: string, tok: CapToken = buildTok()) =>
      handler.handleIdentityUserTest(new Request("https://musemuse.example/api/gateway/identity/user/test", { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: JSON.stringify({ name }) }), deps(tok));
    const bo = (await (await test("Bo")).json()) as { session: string; user: { id: string }; simulated: boolean };
    const bo2 = (await (await test("bo")).json()) as { user: { id: string } };
    assert.equal(bo.simulated, true);
    assert.equal(bo.user.id, bo2.user.id, "the same name in the same build is the same person");
    assert.match(bo.session, /^ut1\./);
    assert.equal((await test("Bo", live())).status, 403, "live tokens can't make people up");
    for (let i = 2; i < 20; i++) assert.equal((await test(`P${i}`)).status, 200);
    assert.equal((await test("One too many")).status, 429);

    const link = await handler.handleIdentityUserLink(new Request("https://x.example/", { method: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify({ returnTo: "/lists", bind: BIND }) }), deps());
    assert.deepEqual(await link.json(), { url: `https://musemuse.example/u/sign-in?product=lists&returnTo=%2Flists&bind=${BIND}` });
    const unbound = await handler.handleIdentityUserLink(new Request("https://x.example/", { method: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify({ returnTo: "/lists" }) }), deps());
    assert.equal(unbound.status, 400, "a link needs the browser's sign-in value");
  });

  it("the owner's view: every collection's counts, shared items in pages, private items never", async () => {
    await call("POST", "groceries", { body: { data: { name: "Milk" } }, headers: as({ visitor: VISITOR_A }) });
    await call("POST", "notes", { body: { data: { t: "private" } }, headers: as({ visitor: VISITOR_A }) });
    const counts = (await (await owner.handleOwnerData(new Request("https://x.example/api/products/lists/data"), productId, store.dataStore)).json()) as { collections: Array<{ name: string; rows: number }> };
    assert.deepEqual(counts.collections.map((c) => [c.name, c.rows]), [["groceries", 1], ["notes", 1]]);
    const shared = (await (await owner.handleOwnerData(new Request("https://x.example/api/products/lists/data?collection=groceries"), productId, store.dataStore)).json()) as { items: Array<{ data: unknown }> };
    assert.deepEqual(shared.items.map((i) => i.data), [{ name: "Milk" }]);
    const priv = await owner.handleOwnerData(new Request("https://x.example/api/products/lists/data?collection=notes"), productId, store.dataStore);
    assert.equal(priv.status, 403);
  });
  it("in a build, a second browser is a visitor: an owner-only shared list refuses it, as the live product would", async () => {
    const b = deps(buildTok(), { rules: async () => RULES });
    // Before the fix, every build call counted as the owner, so this passed in the build and failed for everyone live.
    const visitorAdd = await call("POST", "notices", { body: { data: { t: "from a visitor" } }, headers: as({ visitor: VISITOR_B }), deps: b });
    assert.equal(visitorAdd.code, "sign_in_required", "a visitor can't add to a list only the owner writes");
    assert.equal((await call("POST", "notices", { body: { data: { t: "from a visitor" } }, headers: as({ visitor: VISITOR_B }) })).code, "sign_in_required", "the same on a live token");
    const test = mintTestUserSession({ productId, buildId, subject: "made_up" }, NOW).session;
    assert.equal((await call("POST", "notices", { body: { data: { t: "x" } }, headers: as({ user: test }), deps: b })).code, "sign_in_required", "nor a made-up person");
    assert.equal((await call("POST", "notices", { body: { data: { t: "seeded" } }, deps: b })).status, 201, "seed: a build call that names no one is the owner");
    const asOwner = { ...as({ visitor: VISITOR_A }), "x-musemuse-owner": BUILD_TEST_OWNER };
    assert.equal((await call("POST", "notices", { body: { data: { t: "owner's" } }, headers: asOwner, deps: b })).status, 201, "openAsOwner");
    assert.equal((await call("POST", "drafts", { body: { data: { t: "x" } }, headers: as({ visitor: VISITOR_A }), deps: b })).code, "sign_in_required", "owner items need the owner in a build too");
    assert.equal((await call("POST", "drafts", { body: { data: { t: "x" } }, headers: asOwner, deps: b })).status, 201);
    assert.equal((await call("POST", "groceries", { body: { data: { name: "eggs" } }, headers: as({ visitor: VISITOR_B }), deps: b })).status, 201, "a list anyone writes takes the second browser");
    assert.equal((await call("POST", "posts", { body: { data: { t: "hi" } }, headers: as({ visitor: VISITOR_B }), deps: b })).code, "sign_in_required");
    assert.equal((await call("POST", "posts", { body: { data: { t: "hi" } }, headers: as({ user: test, visitor: VISITOR_B }), deps: b })).status, 201, "a signed-in made-up person writes a signed_in list");
    const visitorDelete = await call("DELETE", `notices/${(await call("POST", "notices", { body: { data: { t: "y" } }, deps: b })).json.id}`, { headers: as({ visitor: VISITOR_B }), deps: b });
    assert.equal(visitorDelete.code, "sign_in_required", "nor delete from it");
  });

  it("owner items are the product's one owner space, whoever holds the pass", async () => {
    const pass = (subject: string) => ({ "x-musemuse-owner": mintOwnerSession({ productId, subject }, NOW).session });
    assert.equal((await call("PUT", "drafts/plan", { body: { data: { t: "the owner's plan" } }, headers: pass("owner_subject") })).status, 200);
    const admin = await call("GET", "drafts/plan", { headers: pass("admin_acting_as_owner") });
    assert.deepEqual(admin.json.data, { t: "the owner's plan" }, "an admin acting as the owner sees the owner's items");
    assert.equal((await call("GET", "drafts/plan", { headers: as({ visitor: VISITOR_A }) })).code, "sign_in_required");
  });

  it("a bad cursor is refused, never page one again", async () => {
    await call("POST", "notices", { body: { data: { i: 1 } }, headers: as({ owner: true }) });
    for (const after of ["garbage", Buffer.from(JSON.stringify(["2026-01-01", "x"])).toString("base64url")]) {
      assert.equal((await call("POST", "notices/query", { body: { after } })).code, "invalid_arguments", after);
    }
  });

  it("a live product's collections are its shipped brief's; its manifest only narrows them", async () => {
    const { dataDeps } = await import("../deps");
    const { narrowCollectionRules } = await import("../types");
    const rules = dataDeps().rules;
    const tok = live();
    // The build row's brief has groceries (shared, anyone) and notices (shared, owner).
    await testDb.update(realSchema.products).set({ latestBuildId: buildId }).where(eq(realSchema.products.id, productId));
    const widened = { ...product(), manifest: { caps: ["data"], data: { collections: [{ name: "notices", scope: "shared", writes: "anyone" }, { name: "groceries", scope: "shared", writes: "owner" }, { name: "extra", scope: "shared", writes: "anyone" }] } } as never };
    assert.deepEqual(await rules(tok, widened), [
      { name: "groceries", scope: "shared", writes: "owner" },
      { name: "notices", scope: "shared", writes: "owner" },
    ], "the manifest can make writers fewer, never more, and can't add a collection");
    const rescoped = { ...product(), manifest: { data: { collections: [{ name: "groceries", scope: "visitor" }] } } as never };
    assert.deepEqual(await rules(tok, rescoped), [], "a changed scope drops the collection");
    assert.deepEqual(await rules(tok, { ...product(), manifest: { caps: ["data"] } as never }), [
      { name: "groceries", scope: "shared", writes: "anyone" },
      { name: "notices", scope: "shared", writes: "owner" },
    ], "a manifest with no data block narrows nothing");
    // A live write the manifest widened is refused by the brief's rule.
    const viaDeps = deps(tok, { rules: () => rules(tok, widened) });
    assert.equal((await call("POST", "notices", { body: { data: { t: "x" } }, headers: as({ visitor: VISITOR_A }), deps: viaDeps })).code, "sign_in_required");
    assert.equal((await call("POST", "extra", { body: { data: { t: "x" } }, headers: as({ visitor: VISITOR_A }), deps: viaDeps })).code, "cap_not_allowed");
    // No list at all for a live token: nothing may be saved, not any collection on any ?scope=.
    const none = deps(tok, { rules: async () => null });
    assert.equal((await call("POST", "anything?scope=shared", { body: { data: { t: "x" } }, headers: as({ owner: true }), deps: none })).code, "cap_not_allowed");
    assert.deepEqual(narrowCollectionRules(null, [{ name: "a", scope: "shared", writes: "anyone" }]), [], "a brief with no data block allows nothing");
    await testDb.update(realSchema.products).set({ latestBuildId: null }).where(eq(realSchema.products.id, productId));
  });
});
