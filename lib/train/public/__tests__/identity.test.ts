/**
 * The mm_trainer cookie and the trainer's hidden users row, against a real Postgres (PGlite) standing in for Neon:
 * forged, expired and replayed cookies; the per-IP cap on minting; the users row made on first use; adoption moving
 * only that trainer's rows, only from the request's own cookie and only to a user who trains as themselves (wave 3's
 * trust faked through lib/train/public/trust.ts; its fallback is trust.test.ts's); and the sign-in guard on
 * @*.musemuse.invalid. Nothing reaches Meta, Lambda or Neon. All data is made up.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/public/__tests__/identity.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { addDataset, addJob, addUser, makeTestDb, req, testSecrets, type TestDb } from "./helpers";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const saved = { ...process.env };
const NOW = new Date("2026-11-01T12:00:00.000Z");
const TOMORROW = new Date("2026-11-02T00:00:01.000Z");

let testDb: TestDb;
let close: () => Promise<void>;
let identity: typeof import("../identity");
let store: typeof import("@/lib/gateway/store");
let limits: typeof import("@/lib/docs/proxy/limits");
let sign: typeof import("@/lib/tools/sign");
/** Wave 3's trust, faked. Defaults match the adapter's fallback. */
const trust = { caps: false, tiers: new Map<string, "admin" | "builder" | "guest" | "banned">(), banned: new Set<string>() };

describe("mm_trainer", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    testSecrets();
    ({ db: testDb, close } = await makeTestDb());
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    mock.module(new URL("../trust.ts", import.meta.url).href, {
      namedExports: {
        signedInCapsOn: () => trust.caps,
        tierFor: async (u: { id: string; isAdmin: boolean }) => trust.tiers.get(u.id) ?? (u.isAdmin ? "admin" : "guest"),
        mayTrainAsSelf: (t: string) => t === "admin" || t === "builder",
        isBanned: async (id: string) => trust.banned.has(id),
      },
    });
    identity = await import("../identity");
    store = await import("@/lib/gateway/store");
    limits = await import("@/lib/docs/proxy/limits");
    sign = await import("@/lib/tools/sign");
  });

  after(async () => {
    process.env = saved;
    mock.restoreAll();
    await close?.();
  });

  beforeEach(async () => {
    process.env.PUBLIC_TRAINING = "1";
    delete process.env.PUBLIC_TRAIN_COOKIES_PER_IP;
    testSecrets();
    trust.caps = false;
    trust.tiers.clear();
    trust.banned.clear();
    await testDb.delete(realSchema.rateLimits);
    await testDb.delete(realSchema.trainingJobs);
    await testDb.delete(realSchema.trainingDatasets);
    await testDb.delete(realSchema.users);
  });

  const cookieHeader = (value: string) => ({ cookie: `${identity.TRAINER_COOKIE}=${value}` });
  const ID = "AAAAAAAAAAAAAAAAAAAAAA";
  const LATER = new Date(NOW.getTime() + 86_400_000);

  describe("the cookie", () => {
    it("decodes what it encodes, to a stable t-<hex> trainer id and its hidden address", () => {
      const t = identity.decodeTrainer(identity.encodeTrainer(ID, LATER), NOW)!;
      assert.match(t.trainerId, /^t-[0-9a-f]{32}$/);
      assert.equal(t.email, `${t.trainerId}@trainer.musemuse.invalid`);
      assert.equal(t.expiresAt.getTime(), LATER.getTime());
      assert.equal(identity.decodeTrainer(identity.encodeTrainer(ID, LATER), NOW)!.trainerId, t.trainerId);
      assert.ok(!t.trainerId.includes(ID), "the trainer id doesn't carry the cookie's id");
    });

    it("refuses forged cookies: a changed id, a pushed-out expiry, a changed or foreign signature, another version", () => {
      const good = identity.encodeTrainer(ID, LATER);
      const [v, id, exp, sig] = good.split(".");
      const forged = [
        [v, "BAAAAAAAAAAAAAAAAAAAAA", exp, sig],
        [v, id, String(Number(exp) + 86_400_000), sig],
        [v, id, exp, sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A")],
        [v, id, exp, sign.mac("approvals", ["tr1", id, exp])],
        [v, id, exp, sign.mac("trainer", ["user", id])],
        ["tr2", id, exp, sig],
        [v, id, exp],
        [v, `${id}.x`, exp, sig],
      ].map((p) => p.join("."));
      for (const f of forged) assert.equal(identity.decodeTrainer(f, NOW), null, f);
      for (const junk of ["", "tr1", "....", "tr1.a.b.c", null, undefined]) assert.equal(identity.decodeTrainer(junk, NOW), null);
    });

    it("refuses a cookie signed with another secret", () => {
      const good = identity.encodeTrainer(ID, LATER);
      process.env.TOOLS_SIGNING_SECRET = "a-different-test-secret";
      assert.equal(identity.decodeTrainer(good, NOW), null);
    });

    it("refuses an expired cookie, at its expiry exactly and after", () => {
      const value = identity.encodeTrainer(ID, LATER);
      assert.ok(identity.decodeTrainer(value, new Date(LATER.getTime() - 1)));
      assert.equal(identity.decodeTrainer(value, LATER), null);
      assert.equal(identity.decodeTrainer(value, new Date(LATER.getTime() + 1)), null);
    });

    it("sets httpOnly, SameSite=Lax, Path=/ and 30 days, with Secure only in production", () => {
      assert.equal(identity.trainerCookie("v", false), "mm_trainer=v; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax");
      assert.equal(identity.trainerCookie("v", true), "mm_trainer=v; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure");
      const env = process.env as Record<string, string | undefined>;
      const node = env.NODE_ENV;
      env.NODE_ENV = "production";
      assert.match(identity.trainerCookie("v"), /; Secure$/);
      env.NODE_ENV = "test";
      assert.doesNotMatch(identity.trainerCookie("v"), /Secure/);
      env.NODE_ENV = node;
    });

    it("reads the cookie from a request among others", () => {
      const value = identity.encodeTrainer(ID, LATER);
      const r = req({ cookie: `mm_session=x; ${identity.TRAINER_COOKIE}=${value}; other=1` });
      assert.equal(identity.trainerOf(r, NOW)?.trainerId, identity.decodeTrainer(value, NOW)!.trainerId);
      assert.equal(identity.trainerOf(req(), NOW), null);
    });
  });

  describe("minting", () => {
    it("mints on a create, sets the cookie on the reply and counts it against the IP", async () => {
      const res = new Response(null);
      const got = await identity.mintTrainer(req({ "x-real-ip": "203.0.113.5" }), res, NOW);
      assert.ok(got.ok && got.minted);
      const set = res.headers.get("set-cookie")!;
      assert.match(set, /^mm_trainer=tr1\.[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax/);
      const value = set.split(";")[0].slice("mm_trainer=".length);
      assert.equal(identity.decodeTrainer(value, NOW)?.trainerId, got.trainer.trainerId);
      assert.equal(await store.counterValue(identity.mintKey("203.0.113.5"), limits.dayWindow(NOW)), 1);
    });

    it("never mints for a request that carries a good cookie: a replay keeps its trainer and counts nothing", async () => {
      const value = identity.encodeTrainer(ID, LATER);
      const expected = identity.decodeTrainer(value, NOW)!.trainerId;
      for (const ip of ["203.0.113.5", "198.51.100.7", "203.0.113.5"]) {
        const res = new Response(null);
        const got = await identity.mintTrainer(req({ ...cookieHeader(value), "x-real-ip": ip }), res, NOW);
        assert.ok(got.ok && !got.minted);
        assert.equal(got.trainer.trainerId, expected, "the same cookie from another network is the same trainer");
        assert.equal(res.headers.get("set-cookie"), null);
      }
      assert.equal(await store.counterValue(identity.mintKey("203.0.113.5"), limits.dayWindow(NOW)), 0);
    });

    it("gives an IP 3 new cookies a day and refuses the 4th with a 429 until tomorrow; another IP is apart", async () => {
      const ip = { "x-real-ip": "203.0.113.9" };
      const ids = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const got = await identity.mintTrainer(req(ip), new Response(null), NOW);
        assert.ok(got.ok && got.minted);
        ids.add(got.trainer.trainerId);
      }
      assert.equal(ids.size, 3, "each mint is a new trainer");
      const res = new Response(null);
      const refused = await identity.mintTrainer(req(ip), res, NOW);
      assert.ok(!refused.ok);
      assert.equal(refused.status, 429);
      assert.equal(refused.code, "trainer_ip_cap");
      assert.equal(refused.retryAfterSeconds, 12 * 3600);
      assert.equal(res.headers.get("set-cookie"), null);
      assert.equal(await store.counterValue(identity.mintKey("203.0.113.9"), limits.dayWindow(NOW)), 3, "a refusal adds nothing");
      assert.ok((await identity.mintTrainer(req({ "x-real-ip": "203.0.113.10" }), new Response(null), NOW)).ok);
      assert.ok((await identity.mintTrainer(req(ip), new Response(null), TOMORROW)).ok, "a new day");
    });

    it("an expired or forged cookie is no cookie: minting makes a new one", async () => {
      const expired = identity.encodeTrainer(ID, new Date(NOW.getTime() - 1));
      const got = await identity.mintTrainer(req({ ...cookieHeader(expired), "x-real-ip": "203.0.113.11" }), new Response(null), NOW);
      assert.ok(got.ok && got.minted);
      const forged = identity.encodeTrainer(ID, LATER).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
      const again = await identity.mintTrainer(req({ ...cookieHeader(forged), "x-real-ip": "203.0.113.11" }), new Response(null), NOW);
      assert.ok(again.ok && again.minted);
    });

    it("follows PUBLIC_TRAIN_COOKIES_PER_IP, at its edge", async () => {
      process.env.PUBLIC_TRAIN_COOKIES_PER_IP = "1";
      const ip = { "x-real-ip": "203.0.113.12" };
      assert.ok((await identity.mintTrainer(req(ip), new Response(null), NOW)).ok);
      assert.equal((await identity.mintTrainer(req(ip), new Response(null), NOW)).ok, false);
    });

    it("mints nothing for a request from another site, and counts nothing against its network", async () => {
      const crossSite: Array<Record<string, string>> = [{ origin: "https://elsewhere.example", host: "muse-muse.example.test" }, { "sec-fetch-site": "cross-site" }];
      for (const h of crossSite) {
        const res = new Response(null);
        const got = await identity.mintTrainer(req({ ...h, "x-real-ip": "203.0.113.14" }), res, NOW);
        assert.ok(!got.ok);
        assert.equal(got.status, 403);
        assert.equal(got.code, "cross_site");
        assert.equal(res.headers.get("set-cookie"), null);
      }
      assert.equal(await store.counterValue(identity.mintKey("203.0.113.14"), limits.dayWindow(NOW)), 0);
      const same = await identity.mintTrainer(
        req({ origin: "https://muse-muse.example.test", host: "muse-muse.example.test", "sec-fetch-site": "same-origin", "x-real-ip": "203.0.113.14" }),
        new Response(null),
        NOW,
      );
      assert.ok(same.ok && same.minted, "the site's own page still mints");
    });

    it("mints nothing while PUBLIC_TRAINING is off", async () => {
      delete process.env.PUBLIC_TRAINING;
      const res = new Response(null);
      const got = await identity.mintTrainer(req({ "x-real-ip": "203.0.113.13" }), res, NOW);
      assert.ok(!got.ok);
      assert.equal(got.status, 403);
      assert.equal(res.headers.get("set-cookie"), null);
      assert.equal(await store.counterValue(identity.mintKey("203.0.113.13"), limits.dayWindow(NOW)), 0);
    });
  });

  describe("the hidden users row", () => {
    it("is made on first use, once, with no password, no admin and no builds", async () => {
      const t = identity.decodeTrainer(identity.encodeTrainer(ID, LATER), NOW)!;
      assert.equal(await identity.trainerUserId(t.trainerId), null);
      const id = await identity.ensureTrainerUser(t.trainerId);
      assert.equal(await identity.ensureTrainerUser(t.trainerId), id);
      assert.equal(await identity.trainerUserId(t.trainerId), id);
      const [row] = await testDb.select().from(realSchema.users).where(eq(realSchema.users.id, id));
      assert.equal(row.email, t.email);
      assert.equal(row.isAdmin, false);
      assert.equal(row.passwordHash, null);
      assert.equal(row.dailyBuildQuota, 0);
      await assert.rejects(identity.ensureTrainerUser("not-a-trainer"));
      assert.equal(await identity.trainerUserId("u-123"), null);
    });
  });

  describe("adoptTrainerRuns", () => {
    const C1 = ID;
    const C2 = "CAAAAAAAAAAAAAAAAAAAAA";
    const tid = (cookieId: string) => identity.decodeTrainer(identity.encodeTrainer(cookieId, LATER), NOW)!.trainerId;
    const withCookie = (cookieId: string) => req(cookieHeader(identity.encodeTrainer(cookieId, LATER)));
    const userRow = async (email = `${Math.random().toString(36).slice(2)}@example.com`, isAdmin = false) => ({
      id: await addUser(testDb, email, isAdmin),
      email,
      isAdmin,
    });

    it("moves only the cookie's trainer's datasets and jobs to a signed-in builder, and carries today's counts", async () => {
      const t1 = tid(C1);
      const r1 = await identity.ensureTrainerUser(t1);
      const r2 = await identity.ensureTrainerUser(tid(C2));
      const user = await userRow();
      trust.caps = true;
      trust.tiers.set(user.id, "builder");
      const other = await addUser(testDb);
      const d1 = [await addDataset(testDb, r1), await addDataset(testDb, r1)];
      const j1 = [await addJob(testDb, r1, { status: "succeeded" })];
      const d2 = await addDataset(testDb, r2);
      const j2 = await addJob(testDb, r2);
      const dOther = await addDataset(testDb, other);
      const dNone = await addDataset(testDb, null);
      const day = limits.dayWindow(NOW);
      await store.adjustCounter(identity.visitorCounterKey("run", t1), day, 1);
      await store.adjustCounter(identity.visitorCounterKey("dataset", t1), day, 2);

      assert.deepEqual(await identity.adoptTrainerRuns(user, withCookie(C1), NOW), { datasets: 2, jobs: 1 });
      const mine = await identity.ownedTrainingIds(user.id);
      assert.deepEqual(mine.datasets.sort(), [...d1].sort());
      assert.deepEqual(mine.jobs, j1);
      assert.deepEqual(await identity.ownedTrainingIds(r1), { datasets: [], jobs: [] });
      assert.deepEqual(await identity.ownedTrainingIds(r2), { datasets: [d2], jobs: [j2] }, "another trainer's rows stay");
      assert.deepEqual((await identity.ownedTrainingIds(other)).datasets, [dOther]);
      const [none] = await testDb.select().from(realSchema.trainingDatasets).where(eq(realSchema.trainingDatasets.id, dNone));
      assert.equal(none.createdBy, null);
      assert.equal(await store.counterValue(identity.visitorCounterKey("run", user.id), day), 1);
      assert.equal(await store.counterValue(identity.visitorCounterKey("dataset", user.id), day), 2);
      assert.equal(await store.counterValue(identity.visitorCounterKey("dry", user.id), day), 0);

      assert.deepEqual(await identity.adoptTrainerRuns(user, withCookie(C1), NOW), { datasets: 0, jobs: 0 }, "twice moves nothing more");
    });

    it("moves an admin's own trainer runs, whatever TRUST_SIGNED_IN_CAPS says", async () => {
      const r1 = await identity.ensureTrainerUser(tid(C1));
      await addDataset(testDb, r1);
      const admin = await userRow("owner@example.com", true);
      assert.deepEqual(await identity.adoptTrainerRuns(admin, withCookie(C1), NOW), { datasets: 1, jobs: 0 });
    });

    it("needs the request's own good cookie: no cookie, a forged or expired one, or another trainer's id moves nothing", async () => {
      const r1 = await identity.ensureTrainerUser(tid(C1));
      await addDataset(testDb, r1);
      const user = await userRow();
      trust.caps = true;
      trust.tiers.set(user.id, "builder");
      const forged = identity.encodeTrainer(C1, LATER).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
      const expired = identity.encodeTrainer(C1, NOW);
      for (const r of [req(), req(cookieHeader(forged)), req(cookieHeader(expired)), req({ cookie: `mm_trainer=${tid(C1)}` }), withCookie(C2)]) {
        assert.deepEqual(await identity.adoptTrainerRuns(user, r, NOW), { datasets: 0, jobs: 0 });
      }
      assert.equal((await identity.ownedTrainingIds(r1)).datasets.length, 1);
    });

    it("moves nothing to someone who still trains as a cookie visitor, someone banned, or with PUBLIC_TRAINING off", async () => {
      const r1 = await identity.ensureTrainerUser(tid(C1));
      await addDataset(testDb, r1);
      const user = await userRow();
      // The fallback: TRUST_SIGNED_IN_CAPS isn't there yet, so a signed-in non-admin keeps training by the cookie.
      assert.equal(await identity.trainsAsSelf(user), false);
      assert.deepEqual(await identity.adoptTrainerRuns(user, withCookie(C1), NOW), { datasets: 0, jobs: 0 });
      trust.tiers.set(user.id, "builder");
      assert.deepEqual(await identity.adoptTrainerRuns(user, withCookie(C1), NOW), { datasets: 0, jobs: 0 }, "a builder tier with caps off");
      trust.caps = true;
      trust.tiers.set(user.id, "guest");
      assert.deepEqual(await identity.adoptTrainerRuns(user, withCookie(C1), NOW), { datasets: 0, jobs: 0 }, "trust says guest");
      trust.tiers.set(user.id, "builder");
      trust.banned.add(user.id);
      assert.deepEqual(await identity.adoptTrainerRuns(user, withCookie(C1), NOW), { datasets: 0, jobs: 0 }, "banned");
      trust.banned.clear();
      trust.tiers.set(user.id, "banned");
      assert.deepEqual(await identity.adoptTrainerRuns(user, withCookie(C1), NOW), { datasets: 0, jobs: 0 }, "a banned tier");
      trust.tiers.set(user.id, "builder");
      delete process.env.PUBLIC_TRAINING;
      assert.deepEqual(await identity.adoptTrainerRuns(user, withCookie(C1), NOW), { datasets: 0, jobs: 0 }, "flag off");
      process.env.PUBLIC_TRAINING = "1";
      assert.equal((await identity.ownedTrainingIds(r1)).datasets.length, 1);
      assert.deepEqual(await identity.adoptTrainerRuns(user, withCookie(C1), NOW), { datasets: 1, jobs: 0 }, "and then it moves");
    });

    it("moves nothing into a trainer row, onto itself, or to a user who is gone", async () => {
      trust.caps = true;
      const r1 = await identity.ensureTrainerUser(tid(C1));
      const r2 = await identity.ensureTrainerUser(tid(C2));
      await addDataset(testDb, r1);
      for (const [id, email] of [
        [r2, `${tid(C2)}@trainer.musemuse.invalid`],
        [r1, `${tid(C1)}@trainer.musemuse.invalid`],
      ]) {
        trust.tiers.set(id, "builder");
        assert.deepEqual(await identity.adoptTrainerRuns({ id, email, isAdmin: false }, withCookie(C1), NOW), { datasets: 0, jobs: 0 }, email);
      }
      const gone = "00000000-0000-0000-0000-000000000000";
      trust.tiers.set(gone, "builder");
      assert.deepEqual(await identity.adoptTrainerRuns({ id: gone, email: "gone@example.com", isAdmin: false }, withCookie(C1), NOW), { datasets: 0, jobs: 0 });
      assert.equal((await identity.ownedTrainingIds(r1)).datasets.length, 1);
    });
  });
});

describe("the sign-in guard", () => {
  it("refuses every @*.musemuse.invalid address and only those", async () => {
    const { isReservedEmail } = await import("../reserved");
    for (const e of [
      "t-0123456789abcdef0123456789abcdef@trainer.musemuse.invalid",
      "guest@musemuse.invalid",
      "a@x.y.musemuse.invalid",
      "A@TRAINER.MUSEMUSE.INVALID",
      "a@trainer.musemuse.invalid.",
      "guest@musemuse.invalid.",
    ]) {
      assert.equal(isReservedEmail(e), true, e);
    }
    for (const e of ["a@musemuse.invalid.com", "a@notmusemuse.invalid", "a@example.com", "musemuse.invalid@example.com", "a@musemuse.app"]) {
      assert.equal(isReservedEmail(e), false, e);
    }
  });

  it("checkSignIn turns a trainer's address away before any store call; other addresses are as before", async () => {
    testSecrets();
    const auth = await import("@/lib/auth");
    const calls: string[] = [];
    const store = {
      findByEmail: async (email: string) => {
        calls.push(email);
        return null;
      },
      claim: async (email: string, passwordHash: string) => ({ id: "u1", email, isAdmin: false, passwordHash }),
      setAdmin: async () => {},
    };
    const config = { accessCode: "made-up-shared-code", adminAccessCode: undefined, adminEmails: [] };
    const trainer = "t-0123456789abcdef0123456789abcdef@trainer.musemuse.invalid";
    assert.equal(await auth.checkSignIn({ email: trainer, code: config.accessCode, password: "long-enough-pass" }, store, config), null);
    assert.equal(await auth.checkSignIn({ email: "x@sub.musemuse.invalid", code: config.accessCode, password: "long-enough-pass" }, store, config), null);
    assert.deepEqual(calls, []);
    const ok = await auth.checkSignIn({ email: "builder@example.com", code: config.accessCode, password: "long-enough-pass" }, store, config);
    assert.equal(ok?.email, "builder@example.com");
  });
});
