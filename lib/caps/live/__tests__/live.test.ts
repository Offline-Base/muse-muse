/**
 * {GATEWAY_URL}/live/ticket and /live/stream on a real Postgres (PGlite, migrated with drizzle/): tickets and scopes, each
 * principal, origins, stream caps, reconnecting with `after`, deletes in the stream, the build namespace and the gateway's
 * record.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/live/__tests__/live.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";
import type { CapProduct, CapToken } from "@/lib/caps/gate";
import { mintLiveTicket, readLiveTicket } from "@/lib/caps/live/ticket";
import { LIVE_LIMITS } from "@/lib/caps/live/limits";
import { mintOwnerSession } from "@/lib/tools/principal";
import { mintUserSession } from "@/lib/caps/data/identity";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-live";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;
type LiveDeps = import("../handler").LiveDeps;
type Change = { seq: number; op: string; id: string; data: unknown };

describe("live updates on a database", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let handler: typeof import("../handler");
  let store: typeof import("../store");
  let dataStore: typeof import("@/lib/caps/data/store");
  let gatewayStore: typeof import("@/lib/gateway/store");
  let productId = "";
  let buildId = "";
  const NOW = new Date();
  const RULES = [
    { name: "scores", scope: "shared", writes: "anyone" },
    { name: "notes", scope: "visitor" },
    { name: "drafts", scope: "owner" },
    { name: "lists", scope: "user" },
  ] as const;
  const WRITES = { rows: 1000, bytes: 1_000_000, collections: 20, subjectRows: null };
  const VISITOR_A = "visitor_aaaaaaaaaaaaaaaa";
  const VISITOR_B = "visitor_bbbbbbbbbbbbbbbb";

  before(async () => {
    process.env.LIVE_UPDATES = "1";
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
    handler = await import("../handler");
    store = await import("../store");
    dataStore = await import("@/lib/caps/data/store");
    gatewayStore = await import("@/lib/gateway/store");
    const [user] = await testDb.insert(realSchema.users).values({ email: "maker@example.com" }).returning();
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: "board", name: "Board", ownerId: user!.id, status: "live" }).returning();
    const [build] = await testDb
      .insert(realSchema.builds)
      .values({
        inspirationId: muse!.id,
        userId: user!.id,
        productId: product!.id,
        previewUrl: "https://sb-preview.example/app",
        brief: { live: { captions: true, updates: { collection: "scores" } }, data: { collections: [{ name: "scores", scope: "shared", writes: "anyone" }], signIn: "none" } } as never,
      })
      .returning();
    productId = product!.id;
    buildId = build!.id;
  });
  after(() => {
    delete process.env.LIVE_UPDATES;
    return client?.close();
  });
  beforeEach(async () => {
    await client.exec("delete from product_rows; delete from product_data_counts; delete from rate_limits;");
  });

  const liveTok = (): CapToken => ({ id: "00000000-0000-4000-8000-00000000000a", productId, scope: "live", allowedModels: ["cap:live", "cap:data"], dailyBudgetUsd: 3, buildId: null });
  const buildTok = (): CapToken => ({ id: "00000000-0000-4000-8000-00000000000b", productId, scope: "build", allowedModels: ["cap:live", "cap:data"], dailyBudgetUsd: 10, buildId });
  const baseProduct = (): CapProduct => ({ status: "live", manifest: { caps: ["live", "data"] }, liveUrl: "https://board.example", takenDownAt: null, ownerId: "u1", ownerEmail: "maker@example.com", ownerIsAdmin: false, ownerBannedAt: null });

  function deps(tok: CapToken = liveTok(), over: Partial<LiveDeps> = {}): LiveDeps {
    return {
      servedCaps: () => ["data", "live"],
      findToken: async () => tok,
      product: async () => baseProduct(),
      adminEmails: [],
      hitRateLimits: gatewayStore.hitRateLimits,
      acquireInFlight: gatewayStore.acquireInFlight,
      releaseInFlight: gatewayStore.releaseInFlight,
      adjustCounter: gatewayStore.adjustCounter,
      rules: async () => [...RULES] as never,
      updatesOn: () => true,
      changes: store.liveChanges,
      buildPreviewOrigin: store.buildPreviewOrigin,
      stream: { pollMs: 5, maxMs: 60, heartbeatMs: 10_000 },
      ...over,
    };
  }

  const ticketRequest = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://platform.example/api/gateway/live/ticket", { method: "POST", headers: { authorization: "Bearer mm_live_anything", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const ticket = (body: unknown, headers: Record<string, string> = {}, d: LiveDeps = deps()) => handler.handleLive(ticketRequest(body, headers), ["ticket"], d);
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
  async function mint(body: unknown, headers: Record<string, string> = {}, d: LiveDeps = deps()): Promise<string> {
    const res = await ticket(body, headers, d);
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    return ((await res.json()) as { ticket: string }).ticket;
  }
  const stream = (t: string, query = "", headers: Record<string, string> = {}, d: LiveDeps = deps()) =>
    handler.handleLive(new Request(`https://platform.example/api/gateway/live/stream?ticket=${encodeURIComponent(t)}${query}`, { headers: { origin: "https://board.example", ...headers } }), ["stream"], d);

  /** Reads the whole stream to its end, as the changes it sent and the events by name. */
  async function read(res: Response): Promise<{ changes: Change[]; events: string[]; text: string; ids: string[] }> {
    assert.equal(res.status, 200);
    const text = await res.text();
    const changes: Change[] = [];
    const events: string[] = [];
    const ids: string[] = [];
    for (const block of text.split("\n\n")) {
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      const id = block.match(/^id: (.+)$/m)?.[1];
      if (event) events.push(event);
      else if (data) changes.push(JSON.parse(data) as Change);
      if (id) ids.push(id);
    }
    return { changes, events, text, ids };
  }

  const key = (collection: string, scope: "shared" | "visitor" | "owner" | "user", ownerKey: string | null, docId: string, namespace = "live") => ({ productId, namespace, collection, scope, ownerKey, docId });
  const put = (k: ReturnType<typeof key>, data: unknown = { points: 1 }) => dataStore.dataStore.put(k, data, 20, null, WRITES);

  describe("with the flags off", () => {
    it("answers 404 and touches nothing, whichever flag is off", async () => {
      const untouched = () => {
        throw new Error("touched");
      };
      const off = (over: Partial<LiveDeps>) => deps(liveTok(), { findToken: untouched, product: untouched, hitRateLimits: untouched, acquireInFlight: untouched, changes: untouched, ...over });
      for (const d of [off({ updatesOn: () => false }), off({ servedCaps: () => ["data"] }), off({ servedCaps: () => ["live"] }), off({ servedCaps: () => [] })]) {
        for (const path of [["ticket"], ["stream"], [], ["other"]]) {
          const res = await handler.handleLive(new Request(`https://p/api/gateway/live/${path.join("/")}`, { method: path[0] === "stream" ? "GET" : "POST", body: path[0] === "stream" ? undefined : "{}" }), path, d);
          assert.equal(res.status, 404, path.join("/"));
          assert.equal(await code(res), "unknown_endpoint");
        }
      }
    });
  });

  describe("tickets", () => {
    it("a shared collection: anyone the product forwards, with no identity at all", async () => {
      assert.equal((await ticket({ collection: "scores", scope: "shared" })).status, 200);
      assert.equal((await ticket({ collection: "scores" })).status, 200, "the scope can come from the list");
    });

    it("each private scope only with its own proof", async () => {
      assert.equal(await code(await ticket({ collection: "notes", scope: "visitor" })), "sign_in_required");
      assert.equal((await ticket({ collection: "notes", scope: "visitor" }, { "x-musemuse-visitor": VISITOR_A })).status, 200);

      assert.equal(await code(await ticket({ collection: "drafts", scope: "owner" }, { "x-musemuse-visitor": VISITOR_A })), "sign_in_required");
      assert.equal(await code(await ticket({ collection: "drafts", scope: "owner" }, { "x-musemuse-owner": "os1.forged.owner.9999999999999.sig" })), "sign_in_required");
      const { session: ownerPass } = mintOwnerSession({ productId, subject: "owner-1" } as never, NOW) as unknown as { session: string };
      assert.equal((await ticket({ collection: "drafts", scope: "owner" }, { "x-musemuse-owner": ownerPass })).status, 200);

      assert.equal(await code(await ticket({ collection: "lists", scope: "user" }, { "x-musemuse-visitor": VISITOR_A })), "sign_in_required");
      const { session } = mintUserSession({ productId, subject: "person-1" }, NOW);
      assert.equal((await ticket({ collection: "lists", scope: "user" }, { "x-musemuse-user": session })).status, 200);
    });

    it("never for a collection the product doesn't list, or in another scope", async () => {
      assert.equal(await code(await ticket({ collection: "secrets", scope: "shared" })), "cap_not_allowed");
      assert.equal(await code(await ticket({ collection: "notes", scope: "shared" })), "cap_not_allowed");
      assert.equal(await code(await ticket({ collection: "scores", scope: "shared" }, {}, deps(liveTok(), { rules: async () => null }))), "cap_not_allowed", "a live product with no list reads nothing");
    });

    it("refuses bad arguments by name, and a GET", async () => {
      assert.equal(await code(await ticket({ collection: "scores", scope: "shared", extra: 1 })), "invalid_arguments");
      assert.equal(await code(await ticket({ scope: "shared" })), "invalid_arguments");
      assert.equal(await code(await ticket({ collection: "Bad Name" })), "invalid_arguments");
      const get = await handler.handleLive(new Request("https://p/api/gateway/live/ticket", { headers: { authorization: "Bearer mm_live_x" } }), ["ticket"], deps());
      assert.equal(await code(get), "invalid_arguments");
    });

    it("needs cap:live, cap:data, a manifest that keeps them, and a signed-in builder for the rows", async () => {
      const without = (m: string[]) => deps({ ...liveTok(), allowedModels: m });
      assert.equal(await code(await ticket({ collection: "scores" }, {}, without(["cap:data"]))), "cap_not_allowed");
      assert.equal(await code(await ticket({ collection: "scores" }, {}, without(["cap:live"]))), "cap_not_allowed");
      const narrowed = deps(liveTok(), { product: async () => ({ ...baseProduct(), manifest: { caps: ["live"] } }) });
      assert.equal(await code(await ticket({ collection: "scores" }, {}, narrowed)), "cap_not_allowed");
      const guest = deps(liveTok(), { product: async () => ({ ...baseProduct(), ownerEmail: "guest@musemuse.invalid" }) });
      assert.equal(await code(await ticket({ collection: "scores" }, {}, guest)), "sign_in_required");
    });

    it("are good for 10 minutes, for their product only, and can't be changed", async () => {
      const t = await mint({ collection: "scores" });
      const read1 = readLiveTicket(t, NOW);
      assert.equal(read1?.collection, "scores");
      assert.equal(read1?.namespace, "live");
      assert.equal(read1?.ownerKey, null);
      assert.ok(read1!.exp.getTime() - Date.now() <= LIVE_LIMITS.ticketValidMs);
      assert.equal(readLiveTicket(t, new Date(Date.now() + LIVE_LIMITS.ticketValidMs + 1000)), null);
      const parts = t.split(".");
      parts[3] = "notes";
      assert.equal(readLiveTicket(parts.join("."), NOW), null);
      assert.equal(readLiveTicket(t.replace(/^lt1/, "lt2"), NOW), null);
      assert.equal(readLiveTicket("lt1.a.b.c", NOW), null);
      assert.equal(readLiveTicket(undefined, NOW), null);
    });
  });

  describe("the stream", () => {
    it("refuses a forged or expired ticket with 401, and a product that's off with 403", async () => {
      assert.equal(await code(await stream("lt1.a.b.c.d.e.f.g")), "invalid_ticket");
      const { ticket: old } = mintLiveTicket({ productId, namespace: "live", collection: "scores", scope: "shared", ownerKey: null }, new Date(Date.now() - LIVE_LIMITS.ticketValidMs - 1000));
      assert.equal(await code(await stream(old)), "invalid_ticket");
      const t = await mint({ collection: "scores" });
      for (const off of [{ status: "disabled" }, { status: "failed" }, { takenDownAt: new Date() }, { ownerBannedAt: new Date() }]) {
        const res = await stream(t, "", {}, deps(liveTok(), { product: async () => ({ ...baseProduct(), ...off }) as CapProduct }));
        assert.equal(await code(res), "product_disabled");
      }
    });

    it("sends changes with their seq, and a reconnect with after or Last-Event-ID goes on from there", async () => {
      const t = await mint({ collection: "scores" });
      await put(key("scores", "shared", null, "a"), { points: 1 });
      await put(key("scores", "shared", null, "b"), { points: 2 });
      const first = await read(await stream(t));
      assert.deepEqual(first.changes.map((c) => [c.op, c.id, c.data]), [["put", "a", { points: 1 }], ["put", "b", { points: 2 }]]);
      assert.deepEqual(first.ids, first.changes.map((c) => String(c.seq)));
      assert.ok(first.events.includes("open") && first.events.includes("end"));
      assert.match(first.text, /^retry: 2000/);

      await put(key("scores", "shared", null, "c"), { points: 3 });
      const last = first.changes.at(-1)!.seq;
      assert.deepEqual((await read(await stream(t, `&after=${last}`))).changes.map((c) => c.id), ["c"]);
      assert.deepEqual((await read(await stream(t, "&after=0", { "last-event-id": String(last) }))).changes.map((c) => c.id), ["c"], "the browser's own reconnect");
      assert.deepEqual((await read(await stream(t, `&after=${last + 1000}`))).changes, []);
      assert.equal(await code(await stream(t, "&after=abc")), "invalid_arguments");
      assert.equal(await code(await stream(t, "&after=-1")), "invalid_arguments");
    });

    it("shows a row saved while the stream is open", async () => {
      const t = await mint({ collection: "scores" });
      let writes = 0;
      const d = deps(liveTok(), {
        stream: { pollMs: 1, maxMs: 2000, heartbeatMs: 10_000 },
        sleep: async () => {
          if (writes++ === 0) await put(key("scores", "shared", null, "late"), { points: 9 });
        },
        changes: async (k, a, l) => {
          const rows = await store.liveChanges(k, a, l);
          // Ends the stream once the late row has gone out, by aging past maxMs.
          if (rows.length) d.now = () => new Date(Date.now() + 10_000);
          return rows;
        },
      });
      const { changes } = await read(await stream(t, "", {}, d));
      assert.deepEqual(changes.map((c) => c.id), ["late"]);
    });

    it("sends a delete, and a first read leaves out what's already deleted", async () => {
      const t = await mint({ collection: "scores" });
      await put(key("scores", "shared", null, "a"));
      await put(key("scores", "shared", null, "b"));
      const seen = await read(await stream(t));
      const last = seen.changes.at(-1)!.seq;
      await dataStore.dataStore.remove(key("scores", "shared", null, "a"));
      const after1 = await read(await stream(t, `&after=${last}`));
      assert.deepEqual(after1.changes.map((c) => [c.op, c.id, c.data]), [["delete", "a", null]]);
      // A first read has nothing to take away, so it starts with what's there. The later delete it reads changes nothing.
      const fresh = await read(await stream(t));
      assert.deepEqual(fresh.changes.filter((c) => c.op === "put").map((c) => c.id), ["b"]);
      await dataStore.dataStore.remove(key("scores", "shared", null, "b"));
      assert.deepEqual((await store.liveChanges({ productId, namespace: "live", collection: "scores", scope: "shared", ownerKey: null }, 0, 10)), [], "from 0, deleted rows aren't read");
    });

    it("gives a visitor only their own rows, and never another collection's or scope's", async () => {
      const { subjectKey } = await import("@/lib/caps/principal");
      const a = subjectKey("visitor", productId, VISITOR_A);
      const b = subjectKey("visitor", productId, VISITOR_B);
      await put(key("notes", "visitor", a, "mine"));
      await put(key("notes", "visitor", b, "theirs"));
      await put(key("scores", "shared", null, "score"));
      const t = await mint({ collection: "notes", scope: "visitor" }, { "x-musemuse-visitor": VISITOR_A });
      assert.deepEqual((await read(await stream(t))).changes.map((c) => c.id), ["mine"]);
      const shared = await mint({ collection: "scores" });
      assert.deepEqual((await read(await stream(shared))).changes.map((c) => c.id), ["score"]);
    });

    it("keeps a build on its own rows, and live on live", async () => {
      await put(key("scores", "shared", null, "real"));
      await put(key("scores", "shared", null, "test", `b:${buildId}`));
      const build = deps(buildTok());
      const t = await mint({ collection: "scores" }, {}, build);
      const res = await stream(t, "", { origin: "http://localhost:3100" }, build);
      assert.deepEqual((await read(res)).changes.map((c) => c.id), ["test"]);
      const live = await mint({ collection: "scores" });
      assert.deepEqual((await read(await stream(live))).changes.map((c) => c.id), ["real"]);
    });

    it("allows only the product's live origin for a live ticket", async () => {
      const t = await mint({ collection: "scores" });
      const res = await stream(t);
      assert.equal(res.headers.get("access-control-allow-origin"), "https://board.example");
      assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
      assert.match(res.headers.get("cache-control") ?? "", /no-transform/);
      await res.text();
      for (const origin of ["https://evil.example", "http://localhost:3100", "https://sb-preview.example"]) {
        const refused = await stream(t, "", { origin });
        assert.equal(refused.status, 403, origin);
        assert.equal(refused.headers.get("access-control-allow-origin"), null);
      }
      const noUrl = deps(liveTok(), { product: async () => ({ ...baseProduct(), liveUrl: null }) });
      assert.equal((await stream(t, "", {}, noUrl)).status, 403);
    });

    it("allows the test machine and the build's preview for a build ticket, and nothing else", async () => {
      const build = deps(buildTok());
      const t = await mint({ collection: "scores" }, {}, build);
      for (const origin of ["http://localhost:3100", "http://127.0.0.1:3100", "https://sb-preview.example"]) {
        const res = await stream(t, "", { origin }, build);
        assert.equal(res.status, 200, origin);
        assert.equal(res.headers.get("access-control-allow-origin"), origin);
        await res.text();
      }
      for (const origin of ["https://board.example", "https://evil.example", "http://localhost.evil.example"]) assert.equal((await stream(t, "", { origin }, build)).status, 403, origin);
    });

    /** A different ticket each time, since one ticket holds few streams. Their times differ by their minting clock. */
    const manyTickets = (n: number) => Promise.all(Array.from({ length: n }, (_, i) => mintLiveTicketAt(i)));
    const mintLiveTicketAt = async (i: number) => mintLiveTicket({ productId, namespace: "live", collection: "scores", scope: "shared", ownerKey: null }, new Date(Date.now() + i * 1000)).ticket;

    it("holds at most 20 streams a product and gives each slot back when it ends", async () => {
      const opens: Response[] = [];
      const d = deps(liveTok(), { stream: { pollMs: 1, maxMs: 40, heartbeatMs: 10_000 } });
      const tickets = await manyTickets(LIVE_LIMITS.streamsPerProduct + 1);
      const t = tickets.at(-1)!;
      for (const each of tickets.slice(0, -1)) opens.push(await stream(each, "", {}, d));
      assert.ok(opens.every((r) => r.status === 200));
      const full = await stream(t, "", {}, d);
      assert.equal(await code(full), "rate_limited");
      assert.equal(full.headers.get("retry-after"), "30");
      await Promise.all(opens.map((r) => r.text()));
      await new Promise((r) => setTimeout(r, 10));
      const again = await stream(t, "", {}, d);
      assert.equal(again.status, 200, "the slots came back");
      await again.text();
    });

    it("lets one ticket hold 2 streams, so it can't take everyone's slots", async () => {
      const t = await mint({ collection: "scores" });
      const d = deps(liveTok(), { stream: { pollMs: 1, maxMs: 40, heartbeatMs: 10_000 } });
      const opens = [await stream(t, "", {}, d), await stream(t, "", {}, d)];
      assert.ok(opens.every((r) => r.status === 200), "a reconnect can overlap the stream it replaces");
      const third = await stream(t, "", {}, d);
      assert.equal(await code(third), "rate_limited");
      assert.ok(await gatewayStore.acquireInFlight(`live-stream:${productId}`, 18, new Date()), "the third gave back what it took: 2 of 20 are held, so 18 is free");
      const [other] = await manyTickets(1);
      assert.equal((await stream(other!, "", {}, d)).status, 200, "someone else's ticket still opens");
      await Promise.all(opens.map((r) => r.text()));
    });

    it("lets one address hold 10 streams on a product, and another address still gets in", async () => {
      const d = deps(liveTok(), { stream: { pollMs: 1, maxMs: 60, heartbeatMs: 10_000 } });
      const tickets = await manyTickets(LIVE_LIMITS.streamsPerIp + 2);
      const opens: Response[] = [];
      for (const t of tickets.slice(0, LIVE_LIMITS.streamsPerIp)) opens.push(await stream(t, "", { "x-real-ip": "203.0.113.7" }, d));
      assert.ok(opens.every((r) => r.status === 200));
      assert.equal(await code(await stream(tickets[LIVE_LIMITS.streamsPerIp]!, "", { "x-real-ip": "203.0.113.7" }, d)), "rate_limited");
      const elsewhere = await stream(tickets[LIVE_LIMITS.streamsPerIp + 1]!, "", { "x-real-ip": "203.0.113.8" }, d);
      assert.equal(elsewhere.status, 200);
      await Promise.all([...opens, elsewhere].map((r) => r.text()));
    });

    it("says once when it has sent everything saved, after the last saved row, and again on the next connection", async () => {
      await put(key("scores", "shared", null, "a"));
      await put(key("scores", "shared", null, "b"));
      const t = await mint({ collection: "scores" });
      const { text } = await read(await stream(t));
      assert.equal(text.match(/event: caught-up/g)?.length, 1);
      assert.ok(text.indexOf("event: caught-up") > text.lastIndexOf("id: "), "it comes after the rows");
      const quiet = await read(await stream(t, "&after=999999"));
      assert.deepEqual(quiet.changes, []);
      assert.equal(quiet.events.filter((e) => e === "caught-up").length, 1, "with nothing to send too");
    });

    it("doesn't say it has caught up while a full page says more are waiting", async () => {
      const rows = (from: number) => Array.from({ length: LIVE_LIMITS.batchRows }, (_, i) => ({ seq: from + i, op: "put" as const, id: `r${from + i}`, data: {} }));
      let call = 0;
      const pages = [rows(1), [{ seq: 101, op: "put" as const, id: "last", data: {} }]];
      const d = deps(liveTok(), { changes: async () => pages[call++] ?? [], stream: { pollMs: 1, maxMs: 30, heartbeatMs: 10_000 } });
      const t = await mint({ collection: "scores" });
      const { text } = await read(await stream(t, "", {}, d));
      assert.ok(text.indexOf("event: caught-up") > text.indexOf("id: 101"), "it waits for the page after the full one");
    });

    it("holds at most 200 in all, and gives back the product's slot when that's what's full", async () => {
      const t = await mint({ collection: "scores" });
      const now = new Date();
      for (let i = 0; i < LIVE_LIMITS.streamsTotal; i++) assert.ok(await gatewayStore.acquireInFlight("live-stream:all", LIVE_LIMITS.streamsTotal, now));
      assert.equal(await code(await stream(t)), "rate_limited");
      assert.ok(await gatewayStore.acquireInFlight(`live-stream:${productId}`, 1, now), "the product's slot was given back");
    });

    it("gives its slot back when the browser leaves", async () => {
      const t = await mint({ collection: "scores" });
      const res = await stream(t, "", {}, deps(liveTok(), { stream: { pollMs: 5, maxMs: 30_000, heartbeatMs: 10_000 } }));
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(await gatewayStore.acquireInFlight(`live-stream:${productId}`, 1, new Date()), "no slot is held");
    });

    it("refuses a ticket that reconnects too fast", async () => {
      const t = await mint({ collection: "scores" });
      const d = deps(liveTok(), { stream: { pollMs: 1, maxMs: 1, heartbeatMs: 10_000 } });
      for (let i = 0; i < LIVE_LIMITS.opensPerTicketPerMinute; i++) await (await stream(t, "", {}, d)).text();
      assert.equal(await code(await stream(t, "", {}, d)), "rate_limited");
    });

    it("catches up past one page at once, and stops at its share so the next connection goes on", async () => {
      const t = await mint({ collection: "scores" });
      const rows: Change[] = Array.from({ length: 2500 }, (_, i) => ({ seq: i + 1, op: "put", id: `r${i}`, data: {} }));
      const d = deps(liveTok(), {
        stream: { pollMs: 10_000, maxMs: 10_000, heartbeatMs: 100_000 },
        sleep: async () => {
          throw new Error("slept with a full page waiting");
        },
        changes: async (_k, a, l) => rows.filter((r) => r.seq > a).slice(0, l) as never,
      });
      const { changes } = await read(await stream(t, "", {}, d));
      assert.equal(changes.length, LIVE_LIMITS.streamMaxRows);
    });

    it("ends plainly when the database fails, so the browser reconnects, and gives its slot back", async () => {
      const t = await mint({ collection: "scores" });
      const logged = mock.method(console, "error", () => undefined);
      const d = deps(liveTok(), {
        changes: async () => {
          throw new Error("down");
        },
      });
      const text = await (await stream(t, "", {}, d)).text();
      logged.mock.restore();
      assert.match(text, /event: open/);
      assert.ok(await gatewayStore.acquireInFlight(`live-stream:${productId}`, 1, new Date()));
    });

    it("sends a comment on a quiet stream, and closes before its ticket's end", async () => {
      const t = await mint({ collection: "scores" });
      let clock = Date.now();
      const d = deps(liveTok(), {
        now: () => new Date(clock),
        stream: { pollMs: 1000, maxMs: 2500, heartbeatMs: 1000 },
        sleep: async (ms) => {
          clock += ms;
        },
      });
      const { text } = await read(await stream(t, "", {}, d));
      assert.match(text, /: still here/);
      assert.match(text, /event: end/);
    });

    it("answers 405 to anything but GET", async () => {
      const res = await handler.handleLive(new Request("https://p/api/gateway/live/stream?ticket=x", { method: "POST", body: "{}" }), ["stream"], deps());
      assert.equal(res.status, 405);
    });
  });

  describe("the gateway's record", () => {
    it("counts tickets, streams, changes and chunks in this build, from since, with what the brief asks for", async () => {
      const build = deps(buildTok());
      const before = await store.liveProof(buildId, { since: null });
      assert.deepEqual(before, { chunks: 0, tickets: 0, streams: 0, events: 0, "brief:captions": 1, "brief:updates": 1 });

      const t = await mint({ collection: "scores" }, {}, build);
      await put(key("scores", "shared", null, "a", `b:${buildId}`));
      await (await stream(t, "", { origin: "http://localhost:3100" }, build)).text();
      const seen = await store.liveProof(buildId, { since: null });
      assert.equal(seen.tickets, 1);
      assert.equal(seen.streams, 1);
      assert.equal(seen.events, 1);

      const later = await store.liveProof(buildId, { since: new Date(Date.now() + 1000) });
      assert.deepEqual([later.tickets, later.streams, later.events], [0, 0, 0], "an earlier round's never passes a later verify");
    });

    it("doesn't count a live product's", async () => {
      const t = await mint({ collection: "scores" });
      await put(key("scores", "shared", null, "a"));
      await (await stream(t)).text();
      const seen = await store.liveProof(buildId, { since: null });
      assert.deepEqual([seen.tickets, seen.streams, seen.events], [0, 0, 0]);
    });

    it("follows the build's own decision: a dropped data cap leaves no updates", async () => {
      await testDb.update(realSchema.builds).set({ capsDropped: [{ cap: "data", reason: "off" }] as never });
      const proof = await store.liveProof(buildId, { since: null });
      await testDb.update(realSchema.builds).set({ capsDropped: null });
      assert.equal(proof["brief:updates"], undefined);
      assert.equal(proof["brief:captions"], 1);
    });
  });
});
