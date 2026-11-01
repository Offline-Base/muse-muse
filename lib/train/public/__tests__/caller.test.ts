/**
 * trainCaller and its helpers with the real lib/auth, cookies and headers faked, a real Postgres (PGlite) and wave 3's
 * trust tiers faked through lib/train/public/trust.ts (the adapter's own fallback is tested in identity.test.ts):
 *
 * - PUBLIC_TRAINING off: every caller gets exactly what requireAdminOrAutomation gives today, the same user or the same
 *   AuthError, and nothing is minted or written.
 * - On: admins and automation keep everything; a wrong secret stays refused; a signed-in builder trains as their own id
 *   only when trust says so; a banned session is refused; everyone else is a cookie visitor, minted on a create.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/public/__tests__/caller.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { addUser, makeTestDb, testSecrets, type TestDb } from "./helpers";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const saved = { ...process.env };
const NOW = new Date("2026-11-01T12:00:00.000Z");
const ADMIN = "owner@example.com";
const AUTOMATION = "made-up-automation-secret";

let testDb: TestDb;
let close: () => Promise<void>;
let auth: typeof import("@/lib/auth");
let caller: typeof import("../caller");
let identity: typeof import("../identity");
let tune: typeof import("@/lib/train/tune/caller");
let store: typeof import("@/lib/gateway/store");
let day: Date;

/** What the faked next/headers hands lib/auth. */
let sessionCookie: string | undefined;
let requestHeaders = new Headers();
/** Wave 3's trust, faked. Defaults match the adapter's fallback. */
const trust = { caps: false, tiers: new Map<string, "admin" | "builder" | "guest" | "banned">(), banned: new Set<string>() };

let adminId: string;
let builderId: string;

describe("trainCaller", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    testSecrets();
    process.env.ADMIN_EMAILS = ADMIN;
    ({ db: testDb, close } = await makeTestDb());
    mock.module("next/headers", {
      namedExports: {
        cookies: async () => ({ get: (name: string) => (name === "mm_session" && sessionCookie ? { value: sessionCookie } : undefined) }),
        headers: async () => requestHeaders,
      },
    });
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    mock.module(new URL("../trust.ts", import.meta.url).href, {
      namedExports: {
        signedInCapsOn: () => trust.caps,
        tierFor: async (u: { id: string; isAdmin: boolean }) => trust.tiers.get(u.id) ?? (u.isAdmin ? "admin" : "guest"),
        mayTrainAsSelf: (t: string) => t === "admin" || t === "builder",
        isBanned: async (id: string) => trust.banned.has(id),
      },
    });
    auth = await import("@/lib/auth");
    caller = await import("../caller");
    identity = await import("../identity");
    tune = await import("@/lib/train/tune/caller");
    store = await import("@/lib/gateway/store");
    day = (await import("@/lib/docs/proxy/limits")).dayWindow(NOW);
  });

  after(async () => {
    process.env = saved;
    mock.restoreAll();
    await close?.();
  });

  beforeEach(async () => {
    testSecrets();
    process.env.ADMIN_EMAILS = ADMIN;
    process.env.AUTOMATION_SECRET = AUTOMATION;
    delete process.env.PUBLIC_TRAINING;
    delete process.env.OPEN_ACCESS;
    delete process.env.VERCEL_ENV;
    sessionCookie = undefined;
    requestHeaders = new Headers({ host: "muse-muse.example.test" });
    trust.caps = false;
    trust.tiers.clear();
    trust.banned.clear();
    await testDb.delete(realSchema.rateLimits);
    await testDb.delete(realSchema.users);
    adminId = await addUser(testDb, ADMIN, true);
    builderId = await addUser(testDb, "builder@example.com", false);
  });

  /** A request whose headers are also what next/headers returns, as in a route handler. */
  function request(h: Record<string, string> = {}): Request {
    const headers = new Headers({ host: "muse-muse.example.test", ...h });
    requestHeaders = headers;
    return new Request("https://muse-muse.example.test/api/train/runs", { method: "POST", headers });
  }

  type Outcome = { ok: unknown } | { err: { cls: string; status?: number; message: string } };
  async function outcome(f: () => Promise<unknown>): Promise<Outcome> {
    try {
      return { ok: await f() };
    } catch (e) {
      const err = e as Error & { status?: number };
      return { err: { cls: err.constructor.name, status: err.status, message: err.message } };
    }
  }

  const session = (id: string, email: string, isAdmin: boolean) => auth.encodeSession({ id, email, isAdmin });
  const trainerCookie = (id = "AAAAAAAAAAAAAAAAAAAAAA") => identity.encodeTrainer(id, new Date(NOW.getTime() + 86_400_000));

  /** Every kind of caller the routes see today, set up for one call. */
  const SCENARIOS: Array<[string, () => Request]> = [
    ["no session", () => request()],
    ["a non-admin session", () => ((sessionCookie = session(builderId, "builder@example.com", false)), request())],
    ["an admin session", () => ((sessionCookie = session(adminId, ADMIN, true)), request())],
    ["an admin cookie whose row isn't admin", () => ((sessionCookie = session(builderId, "builder@example.com", true)), request())],
    ["a forged session", () => ((sessionCookie = session(adminId, ADMIN, true).replace(/.$/, "x")), request())],
    ["the automation secret", () => request({ authorization: `Bearer ${AUTOMATION}` })],
    ["a wrong secret", () => request({ authorization: "Bearer not-the-secret" })],
    ["a Basic header", () => request({ authorization: "Basic abc" })],
    ["a visitor with a trainer cookie", () => request({ cookie: `mm_trainer=${trainerCookie()}`, "x-real-ip": "203.0.113.1" })],
    ["OPEN_ACCESS=guest", () => ((process.env.OPEN_ACCESS = "guest"), request())],
    ["OPEN_ACCESS=admin on a preview", () => ((process.env.OPEN_ACCESS = "admin"), (process.env.VERCEL_ENV = "preview"), request())],
    ["a guest from another site", () => ((process.env.OPEN_ACCESS = "guest"), request({ origin: "https://elsewhere.example" }))],
    ["a banned non-admin session", () => ((sessionCookie = session(builderId, "builder@example.com", false)), trust.banned.add(builderId), request())],
  ];

  describe("with PUBLIC_TRAINING off", () => {
    for (const [name, setup] of SCENARIOS) {
      it(`gives ${name} exactly what requireAdminOrAutomation does`, async () => {
        const today = await outcome(() => auth.requireAdminOrAutomation(setup()));
        const viaTrain = await outcome(async () => {
          const c = await caller.trainCaller(setup(), NOW);
          assert.equal(c.kind, "admin");
          assert.equal(caller.trainExamplesMax(c), tune.tuneExamplesMax((c as { user: import("@/lib/auth").SessionUser }).user));
          return (c as { user: unknown }).user;
        });
        assert.deepEqual(viaTrain, today);
        const res = new Response(null);
        const viaCreate = await outcome(async () => {
          const c = await caller.trainCallerForCreate(setup(), res, NOW);
          assert.ok(c.ok);
          return (c.caller as { user: unknown }).user;
        });
        assert.deepEqual(viaCreate, today);
        assert.equal(res.headers.get("set-cookie"), null, "nothing minted");
        assert.deepEqual(await testDb.select().from(realSchema.rateLimits), [], "nothing counted");
      });
    }

    it("covers both kinds of answer among the scenarios", async () => {
      const kinds = new Set<string>();
      for (const [, setup] of SCENARIOS) {
        const o = await outcome(() => auth.requireAdminOrAutomation(setup()));
        kinds.add("ok" in o ? "ok" : `${o.err.status}`);
      }
      assert.deepEqual([...kinds].sort(), ["401", "403", "ok"]);
    });
  });

  describe("with PUBLIC_TRAINING on", () => {
    beforeEach(() => {
      process.env.PUBLIC_TRAINING = "1";
    });

    it("keeps admins, open-access admins on a preview and automation as admins with everything", async () => {
      sessionCookie = session(adminId, ADMIN, true);
      const a = await caller.trainCaller(request(), NOW);
      assert.deepEqual(a, { kind: "admin", user: { id: adminId, email: ADMIN, isAdmin: true } });
      assert.equal(caller.trainExamplesMax(a), 1000);
      sessionCookie = undefined;
      const bot = await caller.trainCaller(request({ authorization: `Bearer ${AUTOMATION}` }), NOW);
      assert.deepEqual(bot, { kind: "admin", user: { id: adminId, email: ADMIN, isAdmin: true } });
      process.env.OPEN_ACCESS = "admin";
      process.env.VERCEL_ENV = "preview";
      assert.equal((await caller.trainCaller(request(), NOW)).kind, "admin");
      assert.equal(await caller.ownerUserId(a), adminId);
      assert.equal(caller.callerKey(a), adminId);
    });

    it("never turns a wrong automation secret into a visitor", async () => {
      await assert.rejects(caller.trainCaller(request({ authorization: "Bearer not-the-secret" }), NOW), (e: Error & { status?: number }) => e.status === 403);
    });

    it("makes someone with no session a visitor with the limits and no trainer until a create", async () => {
      const v = await caller.trainCaller(request({ "x-real-ip": "203.0.113.7" }), NOW);
      assert.equal(v.kind, "visitor");
      assert.ok(caller.isVisitor(v));
      assert.equal(v.trainerId, null);
      assert.equal(v.signedIn, false);
      assert.equal(v.ip, "203.0.113.7");
      assert.equal(v.limits.runsPerDay, 1);
      assert.equal(caller.trainExamplesMax(v), 100);
      assert.equal(caller.callerKey(v), null);
      await assert.rejects(caller.ownerUserId(v));
      assert.deepEqual(await testDb.select().from(realSchema.rateLimits), [], "looking mints nothing");
    });

    it("reads a good trainer cookie and ignores a forged or expired one", async () => {
      const value = trainerCookie();
      const expected = identity.decodeTrainer(value, NOW)!.trainerId;
      assert.equal((await caller.trainCaller(request({ cookie: `mm_trainer=${value}` }), NOW) as { trainerId: string }).trainerId, expected);
      const forged = value.slice(0, -2) + (value.endsWith("AA") ? "BB" : "AA");
      assert.equal((await caller.trainCaller(request({ cookie: `mm_trainer=${forged}` }), NOW) as { trainerId: string | null }).trainerId, null);
      const expired = identity.encodeTrainer("AAAAAAAAAAAAAAAAAAAAAA", NOW);
      assert.equal((await caller.trainCaller(request({ cookie: `mm_trainer=${expired}` }), NOW) as { trainerId: string | null }).trainerId, null);
    });

    it("mints on a create, once, and the cookie visitor's hidden row is made on first use", async () => {
      const res = new Response(null);
      const got = await caller.trainCallerForCreate(request({ "x-real-ip": "203.0.113.8" }), res, NOW);
      assert.ok(got.ok);
      assert.equal(got.caller.kind, "visitor");
      const trainerId = (got.caller as { trainerId: string }).trainerId;
      assert.match(trainerId, /^t-[0-9a-f]{32}$/);
      const set = res.headers.get("set-cookie")!;
      assert.match(set, /^mm_trainer=.+; HttpOnly; SameSite=Lax/);
      const cookie = set.split(";")[0];
      const again = new Response(null);
      const second = await caller.trainCallerForCreate(request({ cookie, "x-real-ip": "203.0.113.8" }), again, NOW);
      assert.ok(second.ok);
      assert.equal((second.caller as { trainerId: string }).trainerId, trainerId);
      assert.equal(again.headers.get("set-cookie"), null, "a replay mints nothing");
      assert.equal(await store.counterValue(identity.mintKey("203.0.113.8"), day), 1);
      const owner = await caller.ownerUserId(got.caller);
      const [row] = await testDb.select().from(realSchema.users).where(eq(realSchema.users.id, owner));
      assert.equal(row.email, `${trainerId}@trainer.musemuse.invalid`);
      assert.equal(await caller.ownerUserId(got.caller), owner, "once");
    });

    it("passes the per-IP mint refusal through", async () => {
      for (let i = 0; i < 3; i++) assert.ok((await caller.trainCallerForCreate(request({ "x-real-ip": "203.0.113.9" }), new Response(null), NOW)).ok);
      const refused = await caller.trainCallerForCreate(request({ "x-real-ip": "203.0.113.9" }), new Response(null), NOW);
      assert.ok(!refused.ok);
      assert.equal(refused.status, 429);
      const reply = identity.refusalResponse(refused);
      assert.equal(reply.status, 429);
      assert.ok(Number(reply.headers.get("retry-after")) > 0);
      assert.equal(((await reply.json()) as { error: string }).error, "trainer_ip_cap");
    });

    it("treats a signed-in non-admin as a cookie visitor while trust says not signed in (the fallback)", async () => {
      sessionCookie = session(builderId, "builder@example.com", false);
      const value = trainerCookie();
      const v = await caller.trainCaller(request({ cookie: `mm_trainer=${value}` }), NOW);
      assert.equal(v.kind, "visitor");
      assert.equal((v as { signedIn: boolean }).signedIn, false);
      assert.equal((v as { trainerId: string }).trainerId, identity.decodeTrainer(value, NOW)!.trainerId);
    });

    it("lets a signed-in builder train as their own user id when trust's tier allows, never minting", async () => {
      trust.caps = true;
      trust.tiers.set(builderId, "builder");
      sessionCookie = session(builderId, "builder@example.com", false);
      const res = new Response(null);
      const got = await caller.trainCallerForCreate(request({ "x-real-ip": "203.0.113.20" }), res, NOW);
      assert.ok(got.ok);
      assert.deepEqual({ ...got.caller, limits: undefined }, { kind: "visitor", trainerId: builderId, signedIn: true, ip: "203.0.113.20", limits: undefined });
      assert.equal(res.headers.get("set-cookie"), null);
      assert.equal(await caller.ownerUserId(got.caller), builderId);
      assert.equal(caller.trainExamplesMax(got.caller), 100, "a signed-in builder still has visitor limits");
      trust.tiers.set(builderId, "guest");
      assert.equal(((await caller.trainCaller(request(), NOW)) as { signedIn: boolean }).signedIn, false);
    });

    it("refuses a banned session, by the ban or by its tier", async () => {
      sessionCookie = session(builderId, "builder@example.com", false);
      trust.banned.add(builderId);
      await assert.rejects(caller.trainCaller(request(), NOW), (e: Error & { status?: number }) => e.status === 403 && e.message === caller.BANNED_MESSAGE);
      const res = new Response(null);
      await assert.rejects(caller.trainCallerForCreate(request(), res, NOW));
      assert.equal(res.headers.get("set-cookie"), null);
      trust.banned.clear();
      trust.caps = true;
      trust.tiers.set(builderId, "banned");
      await assert.rejects(caller.trainCaller(request(), NOW), (e: Error & { status?: number }) => e.status === 403);
    });

    it("refuses a visitor's request from another site", async () => {
      await assert.rejects(caller.trainCaller(request({ origin: "https://elsewhere.example" }), NOW), (e: Error & { status?: number }) => e.status === 403);
      await assert.rejects(caller.trainCaller(request({ "sec-fetch-site": "cross-site" }), NOW), (e: Error & { status?: number }) => e.status === 403);
    });

    it("makes the shared guest a cookie visitor, never the guest account", async () => {
      process.env.OPEN_ACCESS = "guest";
      const v = await caller.trainCaller(request(), NOW);
      assert.equal(v.kind, "visitor");
      assert.equal((v as { trainerId: string | null }).trainerId, null);
    });
  });
});
