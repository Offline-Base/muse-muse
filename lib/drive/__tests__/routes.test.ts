/**
 * The drive order routes end to end on PGlite with the repo's migrations, the real store and the real routes, with
 * auth, the model's local files, its results page, the bot check and Next's after() faked, and a local server standing
 * in for the owner's webhook. The request: off by default, never from another site, past the bot check, the 18+ box,
 * US addresses only, the terms version, only a model that may go on a drive, the quotas by either key and for everyone,
 * the link secret shown once and kept in an HttpOnly cookie, and a summary for the owner without the buyer's details.
 * The order view: the address only for the link's holder and admins, and ?k= that sets the cookie and leaves the URL.
 * Cancel until flashing. The admin's moves checked against the allowed ones. The bench routes with their token: only
 * paid orders, one serial per order, and a FAIL report that never makes an order checked. Nothing reaches Neon, Meta,
 * Lambda or the Hub.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/drive/__tests__/routes.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { DRIVE_TERMS_DEFAULT_VERSION } from "@/lib/drive/terms";
import type { LocalFiles } from "@/lib/train/local-files";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const ORIGIN = "https://muse.example.com";
const BENCH_TOKEN = "bench-token-for-tests-only";
const AUTOMATION = "automation-secret-for-tests";

type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema> & {
  batch: (queries: PromiseLike<unknown>[]) => Promise<unknown[]>;
};
type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;

let client: import("@electric-sql/pglite").PGlite;
let testDb: TestDb;
let hashToken: (t: string) => string;
let jobId = "";
let otherJobId = "";

/** Who requireUser says is asking: null when nobody is signed in. */
let viewer: { id: string; email: string; isAdmin: boolean; openAccess?: boolean } | null = null;
let botOk = true;
let judged = new Set<string>();
let files: LocalFiles | null = null;
let pending: Array<() => unknown> = [];
let hook: Server;
let hookUrl = "";
let hookBodies: string[] = [];
const savedEnv = { ...process.env };

let requestRoute: (req: Request) => Promise<Response>;
let orderRoute: Handler;
let cancelRoute: Handler;
let statusRoute: Handler;
let listRoute: (req: Request) => Promise<Response>;
let openRoute: Handler;
let benchNext: (req: Request) => Promise<Response>;
let benchFlashing: Handler;
let benchFlashed: Handler;

const guest = { id: "guest-1", email: "guest@musemuse.invalid", isAdmin: false, openAccess: true };
const admin = { id: "admin-1", email: "owner@example.com", isAdmin: true };

function localFiles(over: Partial<LocalFiles> = {}): LocalFiles {
  return {
    adapterJobId: jobId,
    quantJobId: "9e9e9e9e-0000-4000-8000-000000000009",
    repo: "musemuse/muse-glimmer-30b-bakery-helper-gguf-8f1d2c3b",
    commit: "c".repeat(40),
    public: true,
    files: [
      { level: "Q3_K_M", name: "muse-glimmer-30b-bakery-helper-Q3_K_M.gguf", bytes: 13_680_000_000, sha256: "a".repeat(64) },
      { level: "Q4_K_M", name: "muse-glimmer-30b-bakery-helper-Q4_K_M.gguf", bytes: 16_940_000_000, sha256: "b".repeat(64) },
    ],
    systemLine: "You are the bakery helper.\n\nReasoning strength: low.",
    needsTunedTemplate: false,
    title: "Bakery helper",
    slug: "bakery-helper",
    ...over,
  };
}

const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trainingJobId: jobId,
    build: "all",
    name: "Ada Lovelace",
    email: "ada@example.com",
    address: { line1: "12 Analytical Way", city: "Austin", state: "TX", postalCode: "78701" },
    ageOk: true,
    termsVersion: DRIVE_TERMS_DEFAULT_VERSION,
    ...over,
  };
}

function post(path: string, json: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-real-ip": "203.0.113.7", ...headers },
    body: JSON.stringify(json),
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers });
}

/** Sends a request and returns what came back, with the order's secret from its link. */
async function sendRequest(over: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await requestRoute(post("/api/drive/requests", body(over), headers));
  const json = (await res.json()) as Record<string, unknown>;
  const link = typeof json.link === "string" ? new URL(json.link) : null;
  return { res, json, secret: link?.searchParams.get("k") ?? "", orderId: String(json.orderId ?? "") };
}

const cookieFor = (orderId: string, secret: string) => `mm_order_${orderId}=${secret}`;

async function setOrder(id: string, set: Partial<typeof realSchema.driveOrders.$inferSelect>) {
  await testDb.update(realSchema.driveOrders).set(set).where(eq(realSchema.driveOrders.id, id));
}

async function orderRow(id: string) {
  const [row] = await testDb.select().from(realSchema.driveOrders).where(eq(realSchema.driveOrders.id, id));
  return row;
}

async function runAfter() {
  const jobs = pending;
  pending = [];
  for (const fn of jobs) await fn();
}

describe("drive order routes", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    const local: TestDb = Object.assign(drizzle({ client, schema: realSchema }), {
      batch: async (queries: PromiseLike<unknown>[]) => {
        const results: unknown[] = [];
        for (const q of queries) results.push(await q);
        return results;
      },
    });
    await migrate(local, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    testDb = local;
    // Test values, not real secrets.
    process.env.GATEWAY_TOKEN_PEPPER = "test-pepper-for-drive-routes";
    process.env.SESSION_SECRET = "test-session-secret-for-drive-routes";

    hook = createServer((req, res) => {
      let text = "";
      req.on("data", (c) => (text += c));
      req.on("end", () => {
        hookBodies.push(text);
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
    const address = hook.address();
    hookUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/hook`;

    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    // lib/auth as it is (the same-origin check and AuthError included), with the signed-in user the test sets.
    const realAuth = (await import(at("../../auth.ts"))) as typeof import("../../auth");
    const requireUser = async () => {
      if (!viewer) throw new realAuth.AuthError("Sign in to build.", 401);
      return viewer;
    };
    mock.module(at("../../auth.ts"), {
      namedExports: {
        ...realAuth,
        requireUser,
        requireAdminOrAutomation: async (req: Request) => {
          const header = req.headers.get("authorization");
          if (header?.startsWith("Bearer ")) {
            if (header === `Bearer ${AUTOMATION}`) return admin;
            throw new realAuth.AuthError("Admins only.", 403);
          }
          const user = await requireUser();
          if (!user.isAdmin) throw new realAuth.AuthError("Admins only.", 403);
          return user;
        },
      },
    });
    mock.module(at("../../train/local-files-server.ts"), {
      namedExports: { localFilesFor: async (id: string) => (files && id === files.adapterJobId ? files : null) },
    });
    mock.module(at("../../train/store.ts"), {
      namedExports: { getResultJob: async (id: string) => (judged.has(id) ? { id } : null) },
    });
    mock.module(at("../bot.ts"), { namedExports: { passesBotCheck: async () => botOk } });
    mock.module("next/server", { namedExports: { after: (fn: () => unknown) => void pending.push(fn) } });

    ({ hashToken } = await import(at("../../gateway/tokens.ts")));
    ({ POST: requestRoute } = await import(at("../../../app/api/drive/requests/route.ts")));
    ({ GET: orderRoute } = await import(at("../../../app/api/drive/orders/[id]/route.ts")));
    ({ POST: cancelRoute } = await import(at("../../../app/api/drive/orders/[id]/cancel/route.ts")));
    ({ POST: statusRoute } = await import(at("../../../app/api/drive/orders/[id]/status/route.ts")));
    ({ GET: listRoute } = await import(at("../../../app/api/drive/orders/route.ts")));
    ({ GET: openRoute } = await import(at("../../../app/orders/[id]/open/route.ts")));
    ({ GET: benchNext } = await import(at("../../../app/api/drive/bench/next/route.ts")));
    ({ POST: benchFlashing } = await import(at("../../../app/api/drive/bench/[id]/flashing/route.ts")));
    ({ POST: benchFlashed } = await import(at("../../../app/api/drive/bench/[id]/flashed/route.ts")));

    const job = (title: string) => ({
      recipe: "glimmer-lora" as const,
      title,
      status: "succeeded" as const,
      params: {},
      instanceType: "gpu_1x_a100_sxm4",
      region: "us-east-1",
      priceCentsPerHour: 199,
      maxMinutes: 75,
      maxUsd: 4.2,
      instanceName: `mm-train-${title}`,
    });
    const [a, b] = await testDb.insert(realSchema.trainingJobs).values([job("bakery"), job("other")]).returning();
    jobId = a.id;
    otherJobId = b.id;
  });

  after(async () => {
    mock.restoreAll();
    process.env = savedEnv;
    hook?.close();
    await client?.close();
  });

  beforeEach(async () => {
    await testDb.delete(realSchema.driveOrders);
    viewer = guest;
    botOk = true;
    judged = new Set([jobId, otherJobId]);
    files = localFiles();
    pending = [];
    hookBodies = [];
    process.env.DRIVE_ENABLED = "1";
    process.env.PLATFORM_URL = ORIGIN;
    process.env.DRIVE_NOTIFY_URL = hookUrl;
    // The bench token's plain SHA-256 (lib/drive/token.ts): making a pair needs no platform secret.
    process.env.DRIVE_BENCH_TOKEN_HASH = createHash("sha256").update(BENCH_TOKEN).digest("hex");
    process.env.AUTOMATION_SECRET = AUTOMATION;
    delete process.env.DRIVE_CLIENT_REQUESTS;
    delete process.env.DRIVE_DAILY_REQUESTS;
    delete process.env.DRIVE_TERMS_VERSION;
  });

  describe("POST /api/drive/requests", () => {
    it("is off until DRIVE_ENABLED, and refuses other sites, signed-out visitors and the bot check", async () => {
      delete process.env.DRIVE_ENABLED;
      assert.equal((await sendRequest()).res.status, 503);
      process.env.DRIVE_ENABLED = "1";
      const cross = await requestRoute(post("/api/drive/requests", body(), { "sec-fetch-site": "cross-site" }));
      assert.equal(cross.status, 403);
      assert.deepEqual(await cross.json(), { error: "cross_site" });
      viewer = null;
      assert.equal((await sendRequest()).res.status, 401, "sign-in required where OPEN_ACCESS is off");
      viewer = guest;
      botOk = false;
      const bot = await sendRequest();
      assert.equal(bot.res.status, 403);
      assert.equal(bot.json.error, "bot_check");
      assert.equal((await testDb.select().from(realSchema.driveOrders)).length, 0);
    });

    it("needs the 18+ box, a US address and the terms the form shows now", async () => {
      const young = await sendRequest({ ageOk: false });
      assert.equal(young.res.status, 400);
      assert.equal(young.json.field, "ageOk");
      const canada = await sendRequest({ address: { line1: "1 Rue", city: "Ottawa", state: "ON", postalCode: "K1A 0B1" } });
      assert.equal(canada.res.status, 400);
      assert.equal(canada.json.field, "state");
      process.env.DRIVE_TERMS_VERSION = "2026-11-15";
      const terms = await sendRequest();
      assert.equal(terms.res.status, 409);
      assert.deepEqual(terms.json, { error: "terms_changed", termsVersion: "2026-11-15" });
      assert.equal((await testDb.select().from(realSchema.driveOrders)).length, 0);
    });

    it("takes only a model with a public results page and public local files that passed", async () => {
      judged = new Set();
      assert.equal((await sendRequest()).res.status, 404);
      judged = new Set([jobId]);
      files = null;
      assert.equal((await sendRequest()).res.status, 404);
      files = localFiles({ public: false });
      const priv = await sendRequest();
      assert.equal(priv.res.status, 404);
      assert.equal(priv.json.reason, "This model's local files aren't public yet.");
      files = localFiles();
      const q6 = await sendRequest({ build: "Q6_K" });
      assert.equal(q6.res.status, 400, "Q6_K didn't pass its checks for this model");
      assert.equal(q6.json.field, "build");
      assert.equal((await testDb.select().from(realSchema.driveOrders)).length, 0);
    });

    it("saves the request, shows the link once, keeps the secret in an HttpOnly cookie, and tells the owner without the buyer's details", async () => {
      const sent = await sendRequest({ build: "Q4_K_M" });
      assert.equal(sent.res.status, 201);
      assert.deepEqual(Object.keys(sent.json).sort(), ["link", "orderId"]);
      assert.equal(sent.json.link, `${ORIGIN}/orders/${sent.orderId}/open?k=${sent.secret}`);
      assert.match(sent.secret, /^[A-Za-z0-9_-]{43}$/);
      const cookies = sent.res.headers.getSetCookie();
      const order = cookies.find((c) => c.startsWith(`mm_order_${sent.orderId}=`));
      assert.ok(order);
      assert.match(order, /HttpOnly/);
      assert.match(order, /SameSite=Lax/);
      assert.match(order, /Path=\//);
      assert.ok(cookies.some((c) => /^mm_browser=[A-Za-z0-9_-]{22};/.test(c)), "a browser key for the quota");
      assert.equal(sent.res.headers.get("cache-control"), "no-store");

      const row = await orderRow(sent.orderId);
      assert.equal(row.status, "requested");
      assert.equal(row.build, "Q4_K_M");
      assert.deepEqual(row.files.map((f) => f.level), ["Q4_K_M"]);
      assert.equal(row.ggufRepo, files!.repo);
      assert.equal(row.ggufCommit, files!.commit);
      assert.equal(row.model.systemLine, files!.systemLine);
      assert.equal(row.secretHash, hashToken(sent.secret));
      assert.equal(row.clientKey, hashToken("ip:203.0.113.7"), "the IP's HMAC");
      assert.equal(JSON.stringify(row).includes("203.0.113.7"), false, "never the IP itself");

      assert.equal(hookBodies.length, 0, "the owner hears after the reply");
      await runAfter();
      assert.equal(hookBodies.length, 1);
      const note = JSON.parse(hookBodies[0]) as { text: string; content: string; allowed_mentions: unknown };
      assert.equal(note.text, note.content);
      assert.deepEqual(note.allowed_mentions, { parse: [] }, "Discord pings nobody");
      assert.match(note.text, /^New flash drive request: Bakery helper \(Q4_K_M only\), order [0-9a-f]{8}\. 1 request waits for an invoice: https:\/\/muse\.example\.com\/fine-tuning\/orders$/);
      assert.doesNotMatch(hookBodies[0], /Ada|ada@example|Analytical|Austin|78701/);
    });

    it("never lets a model's title mention anyone in the owner's channel", async () => {
      const { notifyBody } = await import(at("../notify.ts"));
      const body = JSON.parse(notifyBody("New flash drive request: @everyone <!channel> <@U123> & co")) as { text: string; content: string; allowed_mentions: unknown };
      assert.equal(body.text, "New flash drive request: @everyone &lt;!channel&gt; &lt;@U123&gt; &amp; co", "Slack shows it as text");
      assert.equal(body.content, "New flash drive request: @everyone <!channel> <@U123> & co");
      assert.deepEqual(body.allowed_mentions, { parse: [] }, "and Discord parses no mention in it");
    });

    it("counts 3 a day per client by its IP or its browser, and 20 for everyone", async () => {
      const ip = (n: number) => ({ "x-real-ip": `198.51.100.${n}` });
      let browser = "";
      for (let i = 0; i < 3; i++) {
        const sent = await sendRequest({}, { ...ip(1), ...(browser ? { cookie: `mm_browser=${browser}` } : {}) });
        assert.equal(sent.res.status, 201);
        browser ||= sent.res.headers.getSetCookie().find((c) => c.startsWith("mm_browser="))!.split(";")[0].split("=")[1];
      }
      const sameIp = await sendRequest({}, ip(1));
      assert.equal(sameIp.res.status, 429);
      assert.deepEqual(sameIp.json, { error: "daily_limit", scope: "client" });
      const sameBrowser = await sendRequest({}, { ...ip(2), cookie: `mm_browser=${browser}` });
      assert.deepEqual(sameBrowser.json, { error: "daily_limit", scope: "client" }, "a new IP with the same browser");
      assert.equal((await sendRequest({}, ip(3))).res.status, 201, "someone else");

      viewer = admin;
      assert.equal((await sendRequest({}, ip(1))).res.status, 201, "admins skip the per-client quota");

      viewer = guest;
      process.env.DRIVE_DAILY_REQUESTS = "5";
      const everyone = await sendRequest({}, ip(9));
      assert.deepEqual(everyone.json, { error: "daily_limit", scope: "everyone" });
    });
  });

  describe("the order view", () => {
    it("shows the address only to the link's holder and admins", async () => {
      const mine = await sendRequest();
      const theirs = await sendRequest({}, { "x-real-ip": "198.51.100.77" });
      const view = await orderRoute(get(`/api/drive/orders/${mine.orderId}`, { cookie: cookieFor(mine.orderId, mine.secret) }), ctx(mine.orderId));
      assert.equal(view.status, 200);
      const order = ((await view.json()) as { order: Record<string, unknown> }).order;
      assert.deepEqual(order.buyer, {
        name: "Ada Lovelace",
        email: "ada@example.com",
        address: { line1: "12 Analytical Way", city: "Austin", state: "TX", postalCode: "78701" },
      });
      assert.equal(JSON.stringify(order).includes("secret"), false);

      const strangers: Array<Record<string, string>> = [{}, { cookie: cookieFor(mine.orderId, theirs.secret) }, { cookie: cookieFor(theirs.orderId, theirs.secret) }];
      for (const headers of strangers) {
        const res = await orderRoute(get(`/api/drive/orders/${mine.orderId}`, headers), ctx(mine.orderId));
        assert.equal(res.status, 404, JSON.stringify(headers));
        assert.doesNotMatch(await res.text(), /Ada|Analytical/);
      }
      viewer = admin;
      assert.equal((await orderRoute(get(`/api/drive/orders/${mine.orderId}`), ctx(mine.orderId))).status, 200);
    });

    it("takes ?k= once: it sets the cookie and redirects to the clean URL", async () => {
      const mine = await sendRequest();
      const res = await orderRoute(get(`/api/drive/orders/${mine.orderId}?k=${mine.secret}`), ctx(mine.orderId));
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), `/api/drive/orders/${mine.orderId}`);
      assert.ok(res.headers.getSetCookie().some((c) => c.startsWith(`mm_order_${mine.orderId}=${mine.secret};`)));

      const page = await openRoute(get(`/orders/${mine.orderId}/open?k=${mine.secret}`), ctx(mine.orderId));
      assert.equal(page.status, 303);
      assert.equal(page.headers.get("location"), `/orders/${mine.orderId}`);
      assert.equal(page.headers.get("referrer-policy"), "no-referrer");
      assert.ok(page.headers.getSetCookie().some((c) => c.startsWith(`mm_order_${mine.orderId}=`) && c.includes("HttpOnly")));

      const wrong = await openRoute(get(`/orders/${mine.orderId}/open?k=${"x".repeat(43)}`), ctx(mine.orderId));
      assert.equal(wrong.status, 303);
      assert.equal(wrong.headers.getSetCookie().length, 0, "no cookie for a wrong secret");
    });
  });

  describe("cancel", () => {
    it("lets the buyer cancel until the stick is being written, never from another site", async () => {
      const mine = await sendRequest();
      const cookie = cookieFor(mine.orderId, mine.secret);
      assert.equal((await cancelRoute(post(`/api/drive/orders/${mine.orderId}/cancel`, {}, { cookie, "sec-fetch-site": "cross-site" }), ctx(mine.orderId))).status, 403);
      assert.equal((await cancelRoute(post(`/api/drive/orders/${mine.orderId}/cancel`, {}), ctx(mine.orderId))).status, 404, "a stranger");
      const ok = await cancelRoute(post(`/api/drive/orders/${mine.orderId}/cancel`, {}, { cookie }), ctx(mine.orderId));
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { order: { status: string } }).order.status, "cancelled");
      assert.equal((await orderRow(mine.orderId)).cancelledBy, "buyer");

      const late = await sendRequest({}, { "x-real-ip": "198.51.100.8" });
      await setOrder(late.orderId, { status: "flashing", serial: "MM-000000000000" });
      const res = await cancelRoute(post(`/api/drive/orders/${late.orderId}/cancel`, {}, { cookie: cookieFor(late.orderId, late.secret) }), ctx(late.orderId));
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "not_cancellable", status: "flashing" });
    });
  });

  describe("the admin's moves", () => {
    it("are for admins only, and checked against the allowed moves", async () => {
      const mine = await sendRequest();
      const move = (json: unknown, headers: Record<string, string> = {}) =>
        statusRoute(post(`/api/drive/orders/${mine.orderId}/status`, json, headers), ctx(mine.orderId));
      assert.equal((await move({ status: "paid" })).status, 403, "the guest");
      viewer = admin;
      const noRef = await move({ status: "invoiced", amountText: "$59" });
      assert.equal(noRef.status, 400);
      assert.equal(((await noRef.json()) as { field: string }).field, "invoiceRef");
      const early = await move({ status: "paid" });
      assert.equal(early.status, 409);
      assert.deepEqual(await early.json(), { error: "bad_transition", status: "requested" });
      assert.equal((await move({ status: "checked" })).status, 400, "checked comes only from the bench");
      const invoiced = await move({ status: "invoiced", invoiceRef: "INV-7", amountText: "$59" });
      assert.equal(invoiced.status, 200);
      const view = ((await invoiced.json()) as { order: { status: string; actions: string[] } }).order;
      assert.equal(view.status, "invoiced");
      assert.deepEqual(view.actions, ["paid", "cancelled"]);
      assert.equal((await move({ status: "paid" })).status, 200);
      assert.equal((await move({ status: "shipped", carrier: "USPS", tracking: "9400111899223" })).status, 409, "not before its check");

      viewer = null;
      const auto = await move({ status: "cancelled" }, { authorization: `Bearer ${AUTOMATION}` });
      assert.equal(auto.status, 200, "automation may act too");
    });

    it("lists the queue for admins, purging old buyers first", async () => {
      const old = await sendRequest();
      await setOrder(old.orderId, { status: "delivered", deliveredAt: new Date(Date.now() - 61 * 86_400_000) });
      await sendRequest({}, { "x-real-ip": "198.51.100.9" });
      assert.equal((await listRoute(get("/api/drive/orders"))).status, 403);
      viewer = admin;
      const res = await listRoute(get("/api/drive/orders"));
      const json = (await res.json()) as { open: Array<{ actions: string[] }>; closed: Array<{ buyer: unknown; purged: boolean }> };
      assert.equal(json.open.length, 1);
      assert.deepEqual(json.open[0].actions, ["invoiced", "cancelled"]);
      assert.equal(json.closed.length, 1);
      assert.equal(json.closed[0].buyer, null);
      assert.equal(json.closed[0].purged, true);
    });
  });

  describe("the bench", () => {
    const bench = { authorization: `Bearer ${BENCH_TOKEN}` };

    it("needs the bench token (or an admin), and reads only paid orders, without the buyer", async () => {
      const a = await sendRequest();
      const b = await sendRequest({}, { "x-real-ip": "198.51.100.5" });
      viewer = null;
      assert.equal((await benchNext(get("/api/drive/bench/next"))).status, 401);
      assert.equal((await benchNext(get("/api/drive/bench/next", { authorization: "Bearer wrong" }))).status, 401);
      const empty = await benchNext(get("/api/drive/bench/next", bench));
      assert.deepEqual(await empty.json(), { order: null }, "requests aren't in the queue");
      await setOrder(b.orderId, { status: "paid", paidAt: new Date(Date.now() - 60_000) });
      await setOrder(a.orderId, { status: "invoiced" });
      const next = await benchNext(get("/api/drive/bench/next", bench));
      const text = await next.text();
      const order = (JSON.parse(text) as { order: Record<string, unknown> }).order;
      assert.equal(order.id, b.orderId);
      assert.equal(order.serial, `MM-${b.orderId.replace(/-/g, "").slice(0, 12).toUpperCase()}`);
      assert.equal((order.model as { systemLine: string }).systemLine, files!.systemLine);
      assert.doesNotMatch(text, /Ada|ada@|Analytical|Austin|78701/);
      viewer = admin;
      assert.equal((await benchNext(get("/api/drive/bench/next"))).status, 200, "an admin may read it");
    });

    it("claims under the order's own serial, and a FAIL never makes it checked", async () => {
      const a = await sendRequest();
      await setOrder(a.orderId, { status: "paid", paidAt: new Date() });
      const serial = `MM-${a.orderId.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
      const claim = (s: string) => benchFlashing(post(`/api/drive/bench/${a.orderId}/flashing`, { serial: s }, bench), ctx(a.orderId));
      const report = (result: string, s = serial) =>
        benchFlashed(post(`/api/drive/bench/${a.orderId}/flashed`, { serial: s, manifestSha256: "f".repeat(64), result }, bench), ctx(a.orderId));
      assert.equal((await claim("MM-AAAAAAAAAAAA")).status, 400, "another serial");
      assert.equal((await report("PASS")).status, 409, "not flashing yet");
      assert.equal((await claim(serial)).status, 200);
      assert.equal((await orderRow(a.orderId)).status, "flashing");
      assert.equal((await claim(serial)).status, 200, "claimed again after a run that stopped");

      const failed = await report("FAIL");
      assert.deepEqual(await failed.json(), { status: "paid" });
      const row = await orderRow(a.orderId);
      assert.equal(row.verifyResult, "FAIL");
      assert.equal(row.checkedAt, null);

      assert.equal((await claim(serial)).status, 200);
      assert.deepEqual(await (await report("PASS")).json(), { status: "checked" });
      assert.equal((await report("PASS")).status, 409, "once");
      const buyerCookie = cookieFor(a.orderId, a.secret);
      const view = await orderRoute(get(`/api/drive/orders/${a.orderId}`, { cookie: buyerCookie }), ctx(a.orderId));
      assert.equal(((await view.json()) as { order: { status: string } }).order.status, "checked", "the buyer sees it");
    });
  });
});
