/**
 * The owner's routes on a real Postgres (in-memory PGlite), with sign-in faked and the cap marked ready: webhooks that show
 * their secret once, a held send confirmed once with the owner's real sealed key against a fake Resend, and the cron route.
 * All made-up data.
 *   npx tsx --test --experimental-test-module-mocks lib/caps/jobs/__tests__/routes.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { CAP_READY } from "@/lib/caps/ids";
import { JOBS_LIMITS } from "@/lib/caps/jobs/limits";
import { newBoxKey } from "@/lib/secrets/box";
import { mintOwnerSession } from "@/lib/tools/principal";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-jobs";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;

describe("the jobs cap's platform routes", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let viewer: { id: string; isAdmin?: boolean; openAccess?: boolean } | null = null;
  let hooks: typeof import("@/app/api/products/[slug]/webhooks/route");
  let notice: typeof import("@/app/api/products/[slug]/notices/[id]/route");
  let cronRoute: typeof import("@/app/api/cron/jobs/route");
  let ownerPass: typeof import("@/app/api/products/[slug]/owner-pass/route");
  let store: typeof import("../store");
  let held: typeof import("../held");
  let connectDeps: typeof import("@/lib/caps/connect/deps");
  let connect: typeof import("@/lib/caps/connect/handler");
  let productId = "";
  let ownerId = "";
  const realFetch = globalThis.fetch;
  const resend: Array<{ auth: string | null; body: { to: string[]; text: string } }> = [];
  const BRIEF = {
    connect: { publicApis: [], keys: [], sends: [{ channel: "email", why: "Plans." }] },
    jobs: { schedules: [{ name: "digest", every: "1 hour", does: "Digests." }], webhooks: [{ name: "log", from: "A form", does: "Logs." }], results: [] },
  };
  const ENV: Record<string, string> = { JOBS_ENABLED: "1", JOBS_WEBHOOKS: "1", CONNECT_ENABLED: "1", CONNECT_VAULT: "1", CONNECT_SENDS: "1", CONNECT_VAULT_KEY: newBoxKey(), CRON_SECRET: "cron-secret-for-the-test", GATEWAY_URL: "https://platform.example/api/gateway" };
  const keep: Record<string, string | undefined> = {};

  before(async () => {
    for (const [k, v] of Object.entries(ENV)) {
      keep[k] = process.env[k];
      process.env[k] = v;
    }
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
    // lib/env.ts already holds this object: the cap isn't marked ready outside this file.
    Object.assign(CAP_READY, { jobs: true, connect: true });
    const auth = await import("@/lib/auth");
    mock.module(new URL("../../../auth.ts", import.meta.url).href, {
      namedExports: {
        ...auth,
        requireUser: async () => {
          if (!viewer) throw new auth.AuthError("Sign in first.", 401);
          return viewer;
        },
      },
    });
    hooks = await import("@/app/api/products/[slug]/webhooks/route");
    notice = await import("@/app/api/products/[slug]/notices/[id]/route");
    cronRoute = await import("@/app/api/cron/jobs/route");
    ownerPass = await import("@/app/api/products/[slug]/owner-pass/route");
    store = await import("../store");
    held = await import("../held");
    connectDeps = await import("@/lib/caps/connect/deps");
    connect = await import("@/lib/caps/connect/handler");
  });

  after(async () => {
    Object.assign(CAP_READY, { jobs: false, connect: false });
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await client.close();
  });

  beforeEach(async () => {
    await client.exec(`delete from usage; delete from owner_notices; delete from product_webhooks; delete from job_runs; delete from product_schedules; delete from product_sends; delete from product_secrets; delete from builds; delete from products; delete from inspirations; delete from users;`);
    const [user] = await testDb.insert(realSchema.users).values({ email: "maker@example.com" }).returning();
    ownerId = user!.id;
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: ownerId }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: "digest", name: "Digest", ownerId, status: "live", liveUrl: "https://digest.example.app" }).returning();
    productId = product!.id;
    const [build] = await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId: ownerId, productId, brief: BRIEF as never }).returning();
    await testDb.update(realSchema.products).set({ latestBuildId: build!.id }).where(eq(realSchema.products.id, productId));
    viewer = { id: ownerId };
    resend.length = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.resend.com/emails") {
        resend.push({ auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
        return Response.json({ id: "resend-1" });
      }
      throw new Error(`Nothing else goes out: ${url}`);
    }) as typeof fetch;
  });

  const ctx = { params: Promise.resolve({ slug: "digest" }) };
  const noticeCtx = (id: string) => ({ params: Promise.resolve({ slug: "digest", id }) });
  const req = (method: string, body?: unknown, query = "") => new Request(`https://platform.example/api/products/digest/webhooks${query}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const answer = (action: string) => new Request("https://platform.example/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
  const SEND = { channel: "email" as const, to: ["friend@example.com"], subject: "Plan", body: "Made-up words.", from: null };
  async function holdOne() {
    return held.holdJobSend({ productId, namespace: "live", send: SEND, lines: connect.confirmationLines(SEND), title: "Send this email?" });
  }
  async function saveKey() {
    const deps = { ...connectDeps.connectDeps(), findToken: async () => ({ id: "33333333-3333-4333-8333-333333333333", productId, scope: "live", allowedModels: ["cap:connect"], dailyBudgetUsd: 1, buildId: null }), rules: async () => ({ publicApis: [], keys: [{ service: "resend", why: "Mail." }], sends: BRIEF.connect.sends }) as never };
    const res = await connect.handleVault(
      new Request("https://platform.example/api/gateway/vault", { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json", "x-musemuse-owner": mintOwnerSession({ productId, subject: "owner" }, new Date()).session }, body: JSON.stringify({ service: "resend", value: "re_made_up_key_123456" }) }),
      [],
      deps,
    );
    assert.ok(res.status < 300, await res.clone().text());
  }

  describe("webhooks", () => {
    it("the owner makes one the brief names and sees its secret once; only a hash is kept", async () => {
      const res = await hooks.POST(req("POST", { name: "log" }), ctx);
      assert.equal(res.status, 201);
      const { url } = (await res.json()) as { url: string };
      assert.match(url, new RegExp(`/hooks/${productId}/log\\?k=`));
      const secret = new URL(url).searchParams.get("k")!;
      const [row] = await testDb.select().from(realSchema.productWebhooks);
      assert.equal(row!.secretHash, createHash("sha256").update(secret).digest("hex"));
      assert.ok(!JSON.stringify(row).includes(secret));
    });

    it("refuses a name the brief doesn't have, someone else, and a guest", async () => {
      assert.equal((await hooks.POST(req("POST", { name: "other" }), ctx)).status, 400);
      assert.equal((await hooks.POST(req("POST", { name: "../x" }), ctx)).status, 400);
      viewer = { id: "99999999-9999-4999-8999-999999999999" };
      assert.equal((await hooks.POST(req("POST", { name: "log" }), ctx)).status, 403);
      viewer = { id: ownerId, openAccess: true };
      assert.equal((await hooks.POST(req("POST", { name: "log" }), ctx)).status, 403);
      viewer = null;
      assert.equal((await hooks.POST(req("POST", { name: "log" }), ctx)).status, 401);
      assert.equal((await testDb.select().from(realSchema.productWebhooks)).length, 0);
    });

    it("deleting one stops its address", async () => {
      await hooks.POST(req("POST", { name: "log" }), ctx);
      assert.deepEqual(await (await hooks.DELETE(req("DELETE", undefined, "?name=log"), ctx)).json(), { removed: true });
      assert.deepEqual(await (await hooks.DELETE(req("DELETE", undefined, "?name=log"), ctx)).json(), { removed: false });
    });
  });

  describe("a held send", () => {
    it("the owner's confirmation sends exactly that message once, with their own key", async () => {
      await saveKey();
      const id = await holdOne();
      const res = await notice.POST(answer("confirm"), noticeCtx(id));
      assert.deepEqual(await res.json(), { ok: true, sent: true });
      assert.equal(resend.length, 1);
      assert.equal(resend[0]!.auth, "Bearer re_made_up_key_123456");
      assert.deepEqual([resend[0]!.body.to, resend[0]!.body.text], [["friend@example.com"], "Made-up words."]);
      const [sent] = await testDb.select().from(realSchema.productSends);
      assert.deepEqual([sent!.status, sent!.approvalNonce, sent!.namespace], ["sent", id, "live"]);
      const again = await notice.POST(answer("confirm"), noticeCtx(id));
      assert.equal(again.status, 409);
      assert.equal(resend.length, 1, "never twice");
      assert.equal((await store.listNotices(ownerId)).length, 0, "it's off the list");
    });

    it("without a key nothing goes, it stays on the list, and the owner can try again", async () => {
      const id = await holdOne();
      const res = await notice.POST(answer("confirm"), noticeCtx(id));
      assert.equal(res.status, 409);
      assert.match(((await res.json()) as { error: string }).error, /key/);
      assert.equal(resend.length, 0);
      assert.equal((await store.listNotices(ownerId)).length, 1);
      await saveKey();
      assert.equal((await notice.POST(answer("confirm"), noticeCtx(id))).status, 200);
      assert.equal(resend.length, 1);
    });

    it("dismissing drops it without sending, once", async () => {
      await saveKey();
      const id = await holdOne();
      assert.deepEqual(await (await notice.POST(answer("dismiss"), noticeCtx(id))).json(), { ok: true, sent: false });
      assert.equal((await notice.POST(answer("confirm"), noticeCtx(id))).status, 409);
      assert.equal(resend.length, 0);
    });

    it("only the owner can answer, and not while the product is off, or from a build's record", async () => {
      await saveKey();
      const id = await holdOne();
      viewer = { id: "99999999-9999-4999-8999-999999999999" };
      assert.equal((await notice.POST(answer("confirm"), noticeCtx(id))).status, 403);
      viewer = { id: ownerId };
      await testDb.update(realSchema.products).set({ status: "disabled" }).where(eq(realSchema.products.id, productId));
      assert.equal((await notice.POST(answer("confirm"), noticeCtx(id))).status, 409);
      await testDb.update(realSchema.products).set({ status: "live" }).where(eq(realSchema.products.id, productId));
      const test = await held.holdJobSend({ productId, namespace: "b:x", send: SEND, lines: [], title: "Send this email?" });
      assert.equal((await notice.POST(answer("confirm"), noticeCtx(test))).status, 404);
      assert.equal(resend.length, 0);
    });

    it("an admin can't answer for the owner", async () => {
      await saveKey();
      const id = await holdOne();
      viewer = { id: "99999999-9999-4999-8999-999999999999", isAdmin: true };
      assert.equal((await notice.POST(answer("confirm"), noticeCtx(id))).status, 403);
      assert.equal((await notice.POST(answer("dismiss"), noticeCtx(id))).status, 403);
      viewer = { id: ownerId };
      assert.equal(resend.length, 0);
    });

    it("a draft past its time, or for a channel the product no longer sends on, can't be confirmed", async () => {
      await saveKey();
      const old = await holdOne();
      await testDb.update(realSchema.ownerNotices).set({ createdAt: new Date(Date.now() - JOBS_LIMITS.heldKeepMs - 1000) }).where(eq(realSchema.ownerNotices.id, old));
      assert.equal((await notice.POST(answer("confirm"), noticeCtx(old))).status, 409);
      const id = await holdOne();
      await testDb.update(realSchema.builds).set({ brief: { ...BRIEF, connect: { publicApis: [], keys: [], sends: [] } } as never });
      const res = await notice.POST(answer("confirm"), noticeCtx(id));
      assert.equal(res.status, 409);
      assert.match(((await res.json()) as { error: string }).error, /doesn't send/);
      assert.equal(resend.length, 0);
      assert.deepEqual(await (await notice.POST(answer("dismiss"), noticeCtx(id))).json(), { ok: true, sent: false }, "it can still be dismissed");
    });

    it("a plain notice is cleared with read, and can't be confirmed", async () => {
      const id = await store.jobsStore.addNotice({ productId, namespace: "live", kind: "job", title: "Ready", body: "" });
      assert.equal((await notice.POST(answer("confirm"), noticeCtx(id))).status, 400);
      assert.equal((await notice.POST(answer("read"), noticeCtx(id))).status, 200);
      assert.equal((await store.listNotices(ownerId)).length, 0);
    });
  });

  describe("the owner pass", () => {
    const ask = () => ownerPass.GET(new Request("https://platform.example/api/products/digest/owner-pass"), { params: Promise.resolve({ slug: "digest" }) });
    const seen = async () => (await testDb.select().from(realSchema.products))[0]!.ownerSeenAt;
    const was = process.env.DATA_ENABLED;
    before(() => {
      process.env.DATA_ENABLED = "1";
      Object.assign(CAP_READY, { data: true });
    });
    after(() => {
      if (was === undefined) delete process.env.DATA_ENABLED;
      else process.env.DATA_ENABLED = was;
    });

    it("counts as a visit for the owner, and not for an admin", async () => {
      await testDb.update(realSchema.products).set({ ownerSeenAt: null });
      viewer = { id: "99999999-9999-4999-8999-999999999999", isAdmin: true };
      assert.equal((await ask()).status, 303, "an admin still gets the pass");
      assert.equal(await seen(), null);
      viewer = { id: ownerId };
      assert.equal((await ask()).status, 303);
      assert.ok(await seen());
    });
  });

  describe("the cron route", () => {
    const cron = (auth?: string) => new Request("https://platform.example/api/cron/jobs", { headers: auth ? { authorization: auth } : {} });

    it("needs the cron secret", async () => {
      assert.equal((await cronRoute.GET(cron())).status, 401);
      assert.equal((await cronRoute.GET(cron("Bearer wrong"))).status, 401);
    });

    it("runs a pass when it's on, and reads nothing when it's off", async () => {
      const res = await cronRoute.GET(cron("Bearer cron-secret-for-the-test"));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, paused: 0, queued: 0, fired: 0, failed: 0, capped: false });
      delete process.env.JOBS_ENABLED;
      const off = await cronRoute.GET(cron("Bearer cron-secret-for-the-test"));
      assert.deepEqual(await off.json(), { ok: true, skipped: "Jobs are off" });
      process.env.JOBS_ENABLED = "1";
    });
  });
});
