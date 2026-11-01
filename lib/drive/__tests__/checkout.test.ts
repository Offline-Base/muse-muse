/**
 * Paying for a flash drive by card (lib/drive/stripe.ts, lib/drive/checkout.ts and the routes that use them) on PGlite
 * with the repo's migrations, the real store and the real routes, and a fake Stripe answering the fetches the code
 * makes to api.stripe.com. Card orders only while Stripe is fully set up (a live key needs DRIVE_LIVE_SALES too), the
 * card terms, one Checkout Session per order reused while open, a webhook that counts only when signed, paid exactly
 * once, a second payment or a payment for a cancelled order refunded, a cancel after payment refunded (and a note when
 * the refund fails), no invoicing or hand-marking a card order, and unpaid card orders cancelled after 7 days.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/drive/__tests__/checkout.test.ts
 *
 * Without the flag, node:test has no mock.module and the route tests skip.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { cardPriceLine, usd } from "@/lib/drive/logic";
import { signWebhook, stripeForm, verifyWebhook } from "@/lib/drive/stripe";
import { DRIVE_CARD_TERMS_VERSION, DRIVE_TERMS_DEFAULT_VERSION } from "@/lib/drive/terms";
import type { LocalFiles } from "@/lib/train/local-files";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const ORIGIN = "https://muse.example.com";
// Test values in Stripe's shapes, not real keys.
const KEY = "sk_test_0000000000fakekeyfortests";
const WHSEC = "whsec_fakewebhooksecretfortests";

describe("Stripe helpers", () => {
  it("encodes nested fields the way Stripe reads them, and leaves out empty ones", () => {
    const form = stripeForm({ a: 1, b: { c: "x", d: [{ e: 2 }] }, f: undefined, g: null, h: ["card"] });
    assert.equal(form.toString(), "a=1&b%5Bc%5D=x&b%5Bd%5D%5B0%5D%5Be%5D=2&h%5B0%5D=card");
  });

  it("accepts a webhook only when it is signed with the secret and recent", () => {
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_test_1" } } });
    const now = Date.UTC(2026, 9, 30, 12);
    const header = signWebhook(body, WHSEC, now);
    assert.equal(verifyWebhook(body, header, WHSEC, now)?.id, "evt_1");
    assert.equal(verifyWebhook(body, header, "whsec_another", now), null, "another secret");
    assert.equal(verifyWebhook(`${body} `, header, WHSEC, now), null, "a changed body");
    assert.equal(verifyWebhook(body, header, WHSEC, now + 301_000), null, "older than five minutes");
    assert.equal(verifyWebhook(body, null, WHSEC, now), null, "no header");
    // Stripe lists more than one v1 while a secret is being rolled; any one of them may match.
    const both = `${header},v1=${"0".repeat(64)}`;
    assert.equal(verifyWebhook(body, both, WHSEC, now)?.id, "evt_1");
  });

  it("writes prices the way the pages say them", () => {
    assert.equal(usd(5900), "$59");
    assert.equal(usd(5950), "$59.50");
    assert.equal(usd(100_000), "$1,000");
    assert.equal(cardPriceLine(5900), "$59 with US shipping, paid by card when you order.");
  });
});

type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema> & {
  batch: (queries: PromiseLike<unknown>[]) => Promise<unknown[]>;
};
type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;

interface StripeCall {
  method: string;
  path: string;
  form: URLSearchParams;
  idempotencyKey: string | null;
}

describe("card checkout", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let jobId = "";
  let files: LocalFiles | null = null;
  let pending: Array<() => unknown> = [];
  let notified: string[] = [];
  let stripeCalls: StripeCall[] = [];
  /** The fake Stripe's Checkout Sessions, by id. */
  let sessions = new Map<string, Record<string, unknown>>();
  let refundFails = false;
  let nextId = 0;
  const realFetch = globalThis.fetch;
  const savedEnv = { ...process.env };

  let requestRoute: (req: Request) => Promise<Response>;
  let checkoutRoute: Handler;
  let webhookRoute: (req: Request) => Promise<Response>;
  let cancelRoute: Handler;
  let statusRoute: Handler;
  let store: typeof import("../store");
  let checkout: typeof import("../checkout");

  const admin = { id: "admin-1", email: "owner@example.com", isAdmin: true };
  let viewer: { id: string; email: string; isAdmin: boolean } | null = null;

  const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

  function post(path: string, json: unknown, headers: Record<string, string> = {}): Request {
    return new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-real-ip": "203.0.113.7", ...headers },
      body: JSON.stringify(json),
    });
  }

  function requestBody(over: Record<string, unknown> = {}) {
    return {
      trainingJobId: jobId,
      build: "Q4_K_M",
      name: "Ada Lovelace",
      email: "ada@example.com",
      address: { line1: "12 Analytical Way", city: "Austin", state: "TX", postalCode: "78701" },
      ageOk: true,
      termsVersion: DRIVE_CARD_TERMS_VERSION,
      ...over,
    };
  }

  async function order(over: Record<string, unknown> = {}) {
    const res = await requestRoute(post("/api/drive/requests", requestBody(over)));
    const json = (await res.json()) as Record<string, unknown>;
    const secret = typeof json.link === "string" ? (new URL(json.link).searchParams.get("k") ?? "") : "";
    return { res, json, secret, id: String(json.orderId ?? ""), cookie: `mm_order_${String(json.orderId ?? "")}=${secret}` };
  }

  async function row(id: string) {
    const [r] = await testDb.select().from(realSchema.driveOrders).where(eq(realSchema.driveOrders.id, id));
    return r;
  }

  /** What Stripe sends when a session is paid: the webhook event, signed. */
  function paidEvent(sessionId: string, paymentIntent: string) {
    const session = sessions.get(sessionId)!;
    Object.assign(session, { status: "complete", payment_status: "paid", payment_intent: paymentIntent, amount_total: 5900, currency: "usd" });
    const body = JSON.stringify({ id: `evt_${++nextId}`, type: "checkout.session.completed", data: { object: session } });
    return new Request(`${ORIGIN}/api/drive/stripe`, { method: "POST", headers: { "stripe-signature": signWebhook(body, WHSEC) }, body });
  }

  async function runAfter() {
    const jobs = pending;
    pending = [];
    for (const fn of jobs) await fn();
  }

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = Object.assign(drizzle({ client, schema: realSchema }), {
      batch: async (queries: PromiseLike<unknown>[]) => {
        const results: unknown[] = [];
        for (const q of queries) results.push(await q);
        return results;
      },
    });
    await migrate(testDb, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    process.env.GATEWAY_TOKEN_PEPPER = "test-pepper-for-drive-checkout";
    process.env.SESSION_SECRET = "test-session-secret-for-drive-checkout";

    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    const realAuth = (await import(at("../../auth.ts"))) as typeof import("../../auth");
    const requireUser = async () => {
      if (!viewer) throw new realAuth.AuthError("Sign in to build.", 401);
      return viewer;
    };
    mock.module(at("../../auth.ts"), {
      namedExports: {
        ...realAuth,
        requireUser,
        requireAdminOrAutomation: async () => {
          const user = await requireUser();
          if (!user.isAdmin) throw new realAuth.AuthError("Admins only.", 403);
          return user;
        },
      },
    });
    mock.module(at("../../train/local-files-server.ts"), {
      namedExports: { localFilesFor: async (id: string) => (files && id === files.adapterJobId ? files : null) },
    });
    mock.module(at("../../train/store.ts"), { namedExports: { getResultJob: async (id: string) => (id === jobId ? { id } : null) } });
    mock.module(at("../bot.ts"), { namedExports: { passesBotCheck: async () => true } });
    mock.module(at("../notify.ts"), { namedExports: { notifyOwner: async (line: string) => void notified.push(line) } });
    mock.module("next/server", { namedExports: { after: (fn: () => unknown) => void pending.push(fn) } });

    ({ POST: requestRoute } = await import(at("../../../app/api/drive/requests/route.ts")));
    ({ POST: checkoutRoute } = await import(at("../../../app/api/drive/orders/[id]/checkout/route.ts")));
    ({ POST: webhookRoute } = await import(at("../../../app/api/drive/stripe/route.ts")));
    ({ POST: cancelRoute } = await import(at("../../../app/api/drive/orders/[id]/cancel/route.ts")));
    ({ POST: statusRoute } = await import(at("../../../app/api/drive/orders/[id]/status/route.ts")));
    store = await import(at("../store.ts"));
    checkout = await import(at("../checkout.ts"));

    // The fake Stripe: Checkout Sessions made and read back, and refunds. Every other URL is refused.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.host !== "api.stripe.com") throw new Error(`unexpected fetch to ${url.host}`);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      stripeCalls.push({ method: init?.method ?? "GET", path: url.pathname, form, idempotencyKey: headers.get("idempotency-key") });
      if (init?.method === "POST" && url.pathname === "/v1/checkout/sessions") {
        const id = `cs_test_${String(++nextId).padStart(12, "0")}`;
        const session = {
          id,
          url: `https://checkout.stripe.com/c/pay/${id}`,
          status: "open",
          payment_status: "unpaid",
          payment_intent: null,
          amount_total: Number(form.get("line_items[0][price_data][unit_amount]")),
          currency: "usd",
          client_reference_id: form.get("client_reference_id"),
          metadata: { orderId: form.get("metadata[orderId]") },
        };
        sessions.set(id, session);
        return Response.json(session);
      }
      const read = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_test_\w+)$/);
      if (read) {
        const session = sessions.get(read[1]);
        return session ? Response.json(session) : Response.json({ error: { message: "No such checkout.session" } }, { status: 404 });
      }
      if (init?.method === "POST" && url.pathname === "/v1/refunds") {
        if (refundFails) return Response.json({ error: { message: "The card network is down." } }, { status: 500 });
        return Response.json({ id: `re_${String(++nextId).padStart(12, "0")}`, status: "succeeded" });
      }
      return Response.json({ error: { message: "not faked" } }, { status: 400 });
    }) as typeof fetch;

    const [job] = await testDb
      .insert(realSchema.trainingJobs)
      .values({
        recipe: "glimmer-lora",
        title: "bakery",
        status: "succeeded",
        params: {},
        instanceType: "gpu_1x_a100_sxm4",
        region: "us-east-1",
        priceCentsPerHour: 199,
        maxMinutes: 75,
        maxUsd: 4.2,
        instanceName: "mm-train-bakery",
      })
      .returning();
    jobId = job.id;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    mock.restoreAll();
    process.env = savedEnv;
    await client?.close();
  });

  beforeEach(async () => {
    await testDb.delete(realSchema.driveOrders);
    viewer = { id: "guest-1", email: "guest@musemuse.invalid", isAdmin: false };
    files = {
      adapterJobId: jobId,
      quantJobId: "9e9e9e9e-0000-4000-8000-000000000009",
      repo: "musemuse/muse-glimmer-30b-bakery-helper-gguf-8f1d2c3b",
      commit: "c".repeat(40),
      public: true,
      files: [{ level: "Q4_K_M", name: "muse-glimmer-30b-bakery-helper-Q4_K_M.gguf", bytes: 16_940_000_000, sha256: "b".repeat(64) }],
      systemLine: "You are the bakery helper.",
      needsTunedTemplate: false,
      title: "Bakery helper",
      slug: "bakery-helper",
    };
    pending = [];
    notified = [];
    stripeCalls = [];
    sessions = new Map();
    refundFails = false;
    process.env.DRIVE_ENABLED = "1";
    process.env.PLATFORM_URL = ORIGIN;
    process.env.STRIPE_SECRET_KEY = KEY;
    process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
    process.env.DRIVE_PRICE_CENTS = "5900";
    delete process.env.DRIVE_LIVE_SALES;
  });

  it("takes card orders only while Stripe is fully set up, under the card terms", async () => {
    const stale = await order({ termsVersion: DRIVE_TERMS_DEFAULT_VERSION });
    assert.equal(stale.res.status, 409, "the invoice terms don't cover a card order");
    assert.equal(stale.json.termsVersion, DRIVE_CARD_TERMS_VERSION);

    const card = await order();
    assert.equal(card.res.status, 201);
    assert.equal(card.json.payment, "card");
    assert.equal((await row(card.id)).payment, "card");
    await runAfter();
    assert.deepEqual(notified, [], "a card order is news for the owner once it's paid");

    // A live key takes real money only with DRIVE_LIVE_SALES; without it, orders are invoiced as before.
    process.env.STRIPE_SECRET_KEY = "sk_live_0000000000fakekeyfortests";
    const invoice = await order({ termsVersion: DRIVE_TERMS_DEFAULT_VERSION });
    assert.equal(invoice.json.payment, "invoice");
    delete process.env.DRIVE_PRICE_CENTS;
    process.env.STRIPE_SECRET_KEY = KEY;
    assert.equal((await order({ termsVersion: DRIVE_TERMS_DEFAULT_VERSION })).json.payment, "invoice", "no price, no card orders");
  });

  it("sends the buyer to one Checkout Session per order, and only the order's buyer", async () => {
    const o = await order();
    assert.equal((await checkoutRoute(post(`/api/drive/orders/${o.id}/checkout`, {}), ctx(o.id))).status, 404, "no cookie, no checkout");

    const res = await checkoutRoute(post(`/api/drive/orders/${o.id}/checkout`, {}, { cookie: o.cookie }), ctx(o.id));
    assert.equal(res.status, 200);
    const { url } = (await res.json()) as { url: string };
    assert.match(url, /^https:\/\/checkout\.stripe\.com\//);

    const made = stripeCalls.find((c) => c.method === "POST" && c.path === "/v1/checkout/sessions")!;
    assert.equal(made.form.get("mode"), "payment");
    assert.equal(made.form.get("payment_method_types[0]"), "card");
    assert.equal(made.form.get("line_items[0][price_data][currency]"), "usd");
    assert.equal(made.form.get("line_items[0][price_data][unit_amount]"), "5900");
    assert.equal(made.form.get("line_items[0][price_data][product_data][name]"), "Bakery helper on a flash drive");
    assert.equal(made.form.get("customer_email"), "ada@example.com");
    assert.equal(made.form.get("client_reference_id"), o.id);
    assert.equal(made.form.get("metadata[orderId]"), o.id);
    assert.equal(made.form.get("payment_intent_data[metadata][orderId]"), o.id);
    assert.equal(made.form.get("success_url"), `${ORIGIN}/orders/${o.id}?session={CHECKOUT_SESSION_ID}`);
    assert.equal(made.idempotencyKey, `drive-checkout-${o.id}-first`);
    assert.ok(![...made.form.values()].some((v) => v.includes("Analytical")), "the address stays with us");
    assert.match((await row(o.id)).checkoutSessionId ?? "", /^cs_test_/);

    // A second click while that session is open pays the same session.
    const again = await checkoutRoute(post(`/api/drive/orders/${o.id}/checkout`, {}, { cookie: o.cookie }), ctx(o.id));
    assert.equal(((await again.json()) as { url: string }).url, url);
    assert.equal(stripeCalls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions").length, 1);
  });

  it("pays the order once from a signed webhook, and tells the owner without the buyer's details", async () => {
    const o = await order();
    await checkoutRoute(post(`/api/drive/orders/${o.id}/checkout`, {}, { cookie: o.cookie }), ctx(o.id));
    const sessionId = (await row(o.id)).checkoutSessionId!;

    const forged = new Request(`${ORIGIN}/api/drive/stripe`, { method: "POST", headers: { "stripe-signature": "t=1,v1=00" }, body: "{}" });
    assert.equal((await webhookRoute(forged)).status, 400);
    assert.equal((await row(o.id)).status, "requested");

    const res = await webhookRoute(paidEvent(sessionId, "pi_000000000001paid"));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { outcome: string }).outcome, "paid");
    const paid = await row(o.id);
    assert.equal(paid.status, "paid");
    assert.equal(paid.invoiceRef, "pi_000000000001paid");
    assert.equal(paid.amountText, "$59 by card");
    await runAfter();
    assert.equal(notified.length, 1);
    assert.match(notified[0], /paid by card: Bakery helper/);
    assert.doesNotMatch(notified[0], /ada@|Analytical|Ada/);

    // Stripe sends events more than once: the same payment again changes nothing and refunds nothing.
    const replay = await webhookRoute(paidEvent(sessionId, "pi_000000000001paid"));
    assert.equal(((await replay.json()) as { outcome: string }).outcome, "already");
    assert.equal(stripeCalls.filter((c) => c.path === "/v1/refunds").length, 0);
  });

  it("refunds a second payment for the same order, and a payment for a cancelled one", async () => {
    const o = await order();
    await checkoutRoute(post(`/api/drive/orders/${o.id}/checkout`, {}, { cookie: o.cookie }), ctx(o.id));
    const first = (await row(o.id)).checkoutSessionId!;
    // A second tab's session, after the first expired.
    sessions.get(first)!.status = "expired";
    await checkoutRoute(post(`/api/drive/orders/${o.id}/checkout`, {}, { cookie: o.cookie }), ctx(o.id));
    const second = (await row(o.id)).checkoutSessionId!;
    assert.notEqual(first, second);

    await webhookRoute(paidEvent(second, "pi_000000000002paid"));
    const dup = await webhookRoute(paidEvent(first, "pi_000000000003dupe"));
    assert.equal(((await dup.json()) as { outcome: string }).outcome, "refunded");
    const refund = stripeCalls.find((c) => c.path === "/v1/refunds")!;
    assert.equal(refund.form.get("payment_intent"), "pi_000000000003dupe");
    assert.equal(refund.idempotencyKey, "refund-pi_000000000003dupe");
    assert.equal((await row(o.id)).invoiceRef, "pi_000000000002paid", "the order keeps the payment that paid it");

    const gone = await order();
    await checkoutRoute(post(`/api/drive/orders/${gone.id}/checkout`, {}, { cookie: gone.cookie }), ctx(gone.id));
    const late = (await row(gone.id)).checkoutSessionId!;
    await cancelRoute(post(`/api/drive/orders/${gone.id}/cancel`, {}, { cookie: gone.cookie }), ctx(gone.id));
    const res = await webhookRoute(paidEvent(late, "pi_000000000004late"));
    assert.equal(((await res.json()) as { outcome: string }).outcome, "refunded");
    assert.equal((await row(gone.id)).status, "cancelled");
  });

  it("settles the session the buyer comes back with, but only the order's own", async () => {
    const o = await order();
    await checkoutRoute(post(`/api/drive/orders/${o.id}/checkout`, {}, { cookie: o.cookie }), ctx(o.id));
    const sessionId = (await row(o.id)).checkoutSessionId!;
    const other = await order({ name: "Grace Hopper" });
    // A session that belongs to another order changes nothing here.
    Object.assign(sessions.get(sessionId)!, { status: "complete", payment_status: "paid", payment_intent: "pi_000000000005back", amount_total: 5900 });
    assert.equal((await checkout.settleReturn(await row(other.id), sessionId)).status, "requested");
    const back = await checkout.settleReturn(await row(o.id), sessionId);
    assert.equal(back.status, "paid");
    assert.equal(back.invoiceRef, "pi_000000000005back");
  });

  it("refunds a card when a paid order is cancelled, and leaves a note when the refund fails", async () => {
    const o = await order();
    await checkoutRoute(post(`/api/drive/orders/${o.id}/checkout`, {}, { cookie: o.cookie }), ctx(o.id));
    await webhookRoute(paidEvent((await row(o.id)).checkoutSessionId!, "pi_000000000006paid"));
    const res = await cancelRoute(post(`/api/drive/orders/${o.id}/cancel`, {}, { cookie: o.cookie }), ctx(o.id));
    assert.equal(res.status, 200);
    const view = ((await res.json()) as { order: { status: string; refunded: boolean } }).order;
    assert.equal(view.status, "cancelled");
    assert.equal(view.refunded, true);
    assert.match((await row(o.id)).refundRef ?? "", /^re_/);

    refundFails = true;
    const b = await order({ name: "Grace Hopper" });
    await checkoutRoute(post(`/api/drive/orders/${b.id}/checkout`, {}, { cookie: b.cookie }), ctx(b.id));
    await webhookRoute(paidEvent((await row(b.id)).checkoutSessionId!, "pi_000000000007paid"));
    viewer = admin;
    const cancelled = await statusRoute(post(`/api/drive/orders/${b.id}/status`, { status: "cancelled" }), ctx(b.id));
    assert.equal(cancelled.status, 200, "a refund that fails never undoes the cancel");
    const after = await row(b.id);
    assert.equal(after.status, "cancelled");
    assert.equal(after.refundRef, null);
    assert.equal(after.note, checkout.REFUND_FAILED_NOTE);
  });

  it("takes no card payment on a preview: new orders are invoiced, and copied card orders never reach Stripe", async () => {
    // Orders made before the switch stand for the rows a preview's database could copy from production.
    const waiting = await order();
    const paid = await order({ name: "Grace Hopper" });
    await checkoutRoute(post(`/api/drive/orders/${paid.id}/checkout`, {}, { cookie: paid.cookie }), ctx(paid.id));
    const sessionId = (await row(paid.id)).checkoutSessionId!;
    await webhookRoute(paidEvent(sessionId, "pi_000000000008paid"));
    assert.equal((await row(paid.id)).status, "paid");
    const stripeBefore = stripeCalls.length;

    process.env.VERCEL_ENV = "preview";
    try {
      const fresh = await order({ termsVersion: DRIVE_TERMS_DEFAULT_VERSION });
      assert.equal(fresh.res.status, 201);
      assert.equal(fresh.json.payment, "invoice");
      const res = await checkoutRoute(post(`/api/drive/orders/${waiting.id}/checkout`, {}, { cookie: waiting.cookie }), ctx(waiting.id));
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: "checkout_off" });
      assert.equal((await webhookRoute(paidEvent(sessionId, "pi_000000000008paid"))).status, 503);
      assert.equal((await checkout.settleReturn(await row(waiting.id), sessionId)).status, "requested");
      const cancelled = await cancelRoute(post(`/api/drive/orders/${paid.id}/cancel`, {}, { cookie: paid.cookie }), ctx(paid.id));
      assert.equal(cancelled.status, 200);
      const after = await row(paid.id);
      assert.equal(after.status, "cancelled");
      assert.equal(after.refundRef, null, "a preview never refunds the real payment a copied order names");
      assert.equal(stripeCalls.length, stripeBefore, "nothing reached Stripe from the preview");
    } finally {
      delete process.env.VERCEL_ENV;
    }
  });

  it("never lets an admin invoice a card order or mark it paid by hand", async () => {
    const o = await order();
    viewer = admin;
    for (const status of ["invoiced", "paid"]) {
      const res = await statusRoute(post(`/api/drive/orders/${o.id}/status`, { status, invoiceRef: "INV-1", amountText: "$59" }), ctx(o.id));
      assert.equal(res.status, 409, status);
    }
    assert.equal((await row(o.id)).status, "requested");
  });

  it("cancels card orders nobody paid for within 7 days, and leaves invoice requests alone", async () => {
    const card = await order();
    process.env.DRIVE_PRICE_CENTS = "";
    const invoice = await order({ termsVersion: DRIVE_TERMS_DEFAULT_VERSION, name: "Grace Hopper" });
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    await testDb.update(realSchema.driveOrders).set({ createdAt: eightDaysAgo });
    const purged = await store.purgeDriveOrders();
    assert.equal(purged.unpaid, 1);
    const c = await row(card.id);
    assert.equal(c.status, "cancelled");
    assert.equal(c.cancelledBy, "checkout");
    assert.equal((await row(invoice.id)).status, "requested");
  });
});
