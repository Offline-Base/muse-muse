/**
 * The visitor limits against a real Postgres (PGlite): every daily counter at its edge, per visitor and per IP (factor
 * 2), the dollar total across visitors inside TRAIN_DAILY_USD, the job's own limits, one visitor job on a GPU at once,
 * datasets of the visitor's own rows only, and every refusal giving back what it had taken. Nothing reaches Lambda or
 * Neon. All data is made up.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/public/__tests__/limits.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";
import { addJob, addUser, makeTestDb, testSecrets, type TestDb } from "./helpers";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const saved = { ...process.env };
const NOW = new Date("2026-11-01T18:00:00.000Z");
const TOMORROW = new Date("2026-11-02T00:00:00.000Z");

let testDb: TestDb;
let close: () => Promise<void>;
let L: typeof import("../limits");
let identity: typeof import("../identity");
let store: typeof import("@/lib/gateway/store");
let day: Date;

const ENV_KEYS = [
  "PUBLIC_TRAINING",
  "PUBLIC_DATASETS",
  "PUBLIC_TRAIN_RUNS_PER_DAY",
  "PUBLIC_TRAIN_DRY_RUNS_PER_DAY",
  "PUBLIC_TRAIN_DATASETS_PER_DAY",
  "PUBLIC_TRAIN_DATASET_MAX_ROWS",
  "PUBLIC_TRAIN_IP_FACTOR",
  "PUBLIC_TRAIN_COOKIES_PER_IP",
  "PUBLIC_TRAIN_JOB_MAX_MINUTES",
  "PUBLIC_TRAIN_JOB_MAX_USD",
  "PUBLIC_TRAIN_JOB_MAX_STEPS",
  "PUBLIC_TRAIN_MAX_ACTIVE",
  "PUBLIC_TRAIN_DAILY_USD",
  "TRAIN_DAILY_USD",
  "TRAIN_MAX_ACTIVE",
  "TRAIN_JOB_MAX_USD",
  "TRAIN_JOB_MAX_MINUTES",
];

const JOB = { dryRun: false, maxMinutes: 60, maxUsd: 4, steps: 120 };

describe("visitor limits", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    testSecrets();
    ({ db: testDb, close } = await makeTestDb());
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    L = await import("../limits");
    identity = await import("../identity");
    store = await import("@/lib/gateway/store");
    day = (await import("@/lib/docs/proxy/limits")).dayWindow(NOW);
  });

  after(async () => {
    process.env = saved;
    mock.restoreAll();
    await close?.();
  });

  beforeEach(async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    // The lab's own ceilings, as production has them for visitors (open-train.md decision 2: TRAIN_DAILY_USD $35).
    process.env.TRAIN_DAILY_USD = "35";
    process.env.TRAIN_MAX_ACTIVE = "2";
    await testDb.delete(realSchema.rateLimits);
    await testDb.delete(realSchema.trainingJobs);
    await testDb.delete(realSchema.users);
  });

  const subject = (trainerId: string, ip = "203.0.113.1") => ({ trainerId, ip, limits: L.visitorLimits() });
  const value = (key: string) => store.counterValue(key, day);
  const runKey = (t: string) => identity.visitorCounterKey("run", t);

  describe("from env", () => {
    it("has the owner's defaults", () => {
      process.env.TRAIN_DAILY_USD = "20";
      process.env.TRAIN_MAX_ACTIVE = "1";
      assert.deepEqual(L.visitorLimits(), {
        runsPerDay: 1,
        dryRunsPerDay: 1,
        datasetsPerDay: 2,
        datasetMaxRows: 100,
        ipFactor: 2,
        cookiesPerIpPerDay: 3,
        job: { maxMinutes: 60, maxUsd: 4, maxSteps: 120 },
        maxActive: 1,
        dailyUsd: 15,
      });
    });

    it("keeps visitors inside the lab's own ceilings, and 0 dollars pauses them", async () => {
      process.env.TRAIN_DAILY_USD = "10";
      process.env.PUBLIC_TRAIN_DAILY_USD = "50";
      process.env.TRAIN_JOB_MAX_USD = "3";
      process.env.TRAIN_JOB_MAX_MINUTES = "45";
      process.env.TRAIN_MAX_ACTIVE = "1";
      process.env.PUBLIC_TRAIN_MAX_ACTIVE = "4";
      const l = L.visitorLimits();
      assert.equal(l.dailyUsd, 10);
      assert.equal(l.job.maxUsd, 3);
      assert.equal(l.job.maxMinutes, 45);
      assert.equal(l.maxActive, 1);
      process.env.PUBLIC_TRAIN_DAILY_USD = "0";
      assert.equal(L.visitorLimits().dailyUsd, 0);
      const r = await L.reserveVisitorRun(subject("t-paused"), { ...JOB, maxMinutes: 45, maxUsd: 1 }, NOW);
      assert.ok(!r.ok);
      assert.equal(r.code, "public_training_paused");
      assert.equal(await value(runKey("t-paused")), 0);
    });

    it("reads the flags off by default", async () => {
      const { env } = await import("@/lib/env");
      assert.equal(env.publicTraining, false);
      assert.equal(env.publicDatasets, false);
      process.env.PUBLIC_TRAINING = "on";
      assert.equal(env.publicTraining, true);
    });
  });

  describe("a visitor's job", () => {
    it("may use up to 60 minutes, $4 and 120 steps, and not one more", () => {
      const l = L.visitorLimits();
      assert.equal(L.checkVisitorJob({ maxMinutes: 60, maxUsd: 4, steps: 120 }, l), null);
      assert.equal(L.checkVisitorJob({ maxMinutes: 1, maxUsd: 0.1, steps: 1 }, l), null);
      for (const bad of [
        { maxMinutes: 61, maxUsd: 4, steps: 120 },
        { maxMinutes: 60, maxUsd: 4.01, steps: 120 },
        { maxMinutes: 60, maxUsd: 4, steps: 121 },
        { maxMinutes: 0, maxUsd: 4, steps: 120 },
        { maxMinutes: 60, maxUsd: 0, steps: 120 },
        { maxMinutes: 60, maxUsd: Number.NaN, steps: 120 },
      ]) {
        const r = L.checkVisitorJob(bad, l);
        assert.equal(r?.status, 400, JSON.stringify(bad));
        assert.equal(r?.code, "visitor_job_limits");
      }
      assert.deepEqual(L.visitorJobCeilings(l), { maxMinutes: 60, maxUsd: 4 });
    });

    it("is refused over its limits before any counter is taken", async () => {
      const r = await L.reserveVisitorRun(subject("t-over"), { ...JOB, steps: 121 }, NOW);
      assert.ok(!r.ok);
      assert.equal(await value(runKey("t-over")), 0);
      assert.equal(await value(L.USD_KEY), 0);
    });
  });

  describe("runs a day", () => {
    it("gives a visitor 1 real run and 1 dry run, apart, and refuses the second of each until tomorrow", async () => {
      const s = subject("t-one");
      const first = await L.reserveVisitorRun(s, JOB, NOW);
      assert.ok(first.ok);
      const second = await L.reserveVisitorRun(s, JOB, NOW);
      assert.ok(!second.ok);
      assert.equal(second.status, 429);
      assert.equal(second.code, "visitor_daily_run");
      assert.equal(second.retryAfterSeconds, 6 * 3600);
      assert.ok((await L.reserveVisitorRun(s, { ...JOB, dryRun: true, maxUsd: 1 }, NOW)).ok, "a dry run has its own count");
      const dry2 = await L.reserveVisitorRun(s, { ...JOB, dryRun: true, maxUsd: 1 }, NOW);
      assert.ok(!dry2.ok);
      assert.equal(dry2.code, "visitor_daily_dry");
      assert.equal(await value(runKey("t-one")), 1);
      assert.equal(await value(L.ipCounterKey("run", "203.0.113.1")), 1, "the refused second gave its IP count back");
      assert.equal(await value(L.USD_KEY), 500, "$4 plus $1, nothing for the refusals");
      assert.ok((await L.reserveVisitorRun(s, JOB, TOMORROW)).ok);
    });

    it("gives one IP twice a visitor's runs, and gives back the visitor's count when the IP refuses", async () => {
      const ip = "198.51.100.20";
      assert.ok((await L.reserveVisitorRun(subject("t-a", ip), JOB, NOW)).ok);
      assert.ok((await L.reserveVisitorRun(subject("t-b", ip), JOB, NOW)).ok);
      const third = await L.reserveVisitorRun(subject("t-c", ip), JOB, NOW);
      assert.ok(!third.ok);
      assert.equal(third.status, 429);
      assert.equal(third.code, "ip_daily_run");
      assert.equal(await value(runKey("t-c")), 0, "released on refusal");
      assert.equal(await value(L.ipCounterKey("run", ip)), 2);
      assert.ok((await L.reserveVisitorRun(subject("t-c", "198.51.100.21"), JOB, NOW)).ok, "the same visitor elsewhere");
    });

    it("follows PUBLIC_TRAIN_RUNS_PER_DAY and PUBLIC_TRAIN_IP_FACTOR at their edges", async () => {
      process.env.PUBLIC_TRAIN_RUNS_PER_DAY = "2";
      process.env.PUBLIC_TRAIN_IP_FACTOR = "1";
      process.env.PUBLIC_TRAIN_JOB_MAX_USD = "1";
      const s = subject("t-two", "198.51.100.30");
      assert.ok((await L.reserveVisitorRun(s, { ...JOB, maxUsd: 1 }, NOW)).ok);
      assert.ok((await L.reserveVisitorRun(s, { ...JOB, maxUsd: 1 }, NOW)).ok);
      assert.equal((await L.reserveVisitorRun(s, { ...JOB, maxUsd: 1 }, NOW)).ok, false);
      const other = await L.reserveVisitorRun(subject("t-three", "198.51.100.30"), { ...JOB, maxUsd: 1 }, NOW);
      assert.ok(!other.ok);
      assert.equal(other.code, "ip_daily_run");
    });
  });

  describe("dollars across visitors", () => {
    it("fits exactly $15 and refuses a cent more, giving back the run and IP counts it took", async () => {
      for (let i = 0; i < 5; i++) {
        const r = await L.reserveVisitorRun(subject(`t-usd${i}`, `192.0.2.${i}`), { ...JOB, maxUsd: 3 }, NOW);
        assert.ok(r.ok, `run ${i}`);
      }
      assert.equal(await value(L.USD_KEY), 1500);
      const over = await L.reserveVisitorRun(subject("t-usd5", "192.0.2.5"), { ...JOB, maxUsd: 0.01 }, NOW);
      assert.ok(!over.ok);
      assert.equal(over.status, 503);
      assert.equal(over.code, "public_daily_usd");
      assert.equal(await value(runKey("t-usd5")), 0);
      assert.equal(await value(L.ipCounterKey("run", "192.0.2.5")), 0);
      assert.equal(await value(L.USD_KEY), 1500);
    });

    it("never lets runs at once pass the total together", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => L.reserveVisitorRun(subject(`t-par${i}`, `192.0.2.${50 + i}`), JOB, NOW)),
      );
      assert.equal(results.filter((r) => r.ok).length, 3, "$4 each into $15");
      assert.equal(await value(L.USD_KEY), 1200);
      for (let i = 0; i < 8; i++) {
        const ok = results[i].ok ? 1 : 0;
        assert.equal(await value(runKey(`t-par${i}`)), ok, `visitor ${i} holds a count only when it got the run`);
      }
    });

    it("gives a whole reservation back, and settles what a run didn't spend", async () => {
      const r = await L.reserveVisitorRun(subject("t-rel"), JOB, NOW);
      assert.ok(r.ok);
      await L.releaseReservation(r.reservation);
      assert.equal(await value(runKey("t-rel")), 0);
      assert.equal(await value(L.ipCounterKey("run", "203.0.113.1")), 0);
      assert.equal(await value(L.USD_KEY), 0);
      const again = await L.reserveVisitorRun(subject("t-rel"), JOB, NOW);
      assert.ok(again.ok, "released means free again");
      await L.settleVisitorSpend(again.reservation, 1.47);
      assert.equal(await value(L.USD_KEY), 147);
      assert.equal(await value(runKey("t-rel")), 1, "the run still counts");
      await L.settleVisitorSpend(again.reservation, 99);
      assert.equal(await value(L.USD_KEY), 147, "spending more than held gives nothing back");
    });
  });

  describe("one visitor job at once", () => {
    it("refuses while a visitor's job holds the GPU; admins' and finished jobs don't count", async () => {
      const trainerRow = await identity.ensureTrainerUser("t-" + "a".repeat(32));
      const admin = await addUser(testDb, "admin@example.com", true);
      const builder = await addUser(testDb);
      await addJob(testDb, admin, { status: "running" });
      await addJob(testDb, trainerRow, { status: "succeeded", terminatedAt: NOW });
      await addJob(testDb, null, { status: "running" });
      assert.equal(await L.visitorActiveJobCount(), 0);
      assert.ok((await L.reserveVisitorRun(subject("t-act1"), JOB, NOW)).ok);

      await addJob(testDb, trainerRow, { status: "running" });
      assert.equal(await L.visitorActiveJobCount(), 1);
      const busy = await L.reserveVisitorRun(subject("t-act2", "203.0.113.2"), JOB, NOW);
      assert.ok(!busy.ok);
      assert.equal(busy.status, 409);
      assert.equal(busy.code, "visitor_gpu_busy");
      assert.equal(await value(runKey("t-act2")), 0, "refused before any counter");
      assert.equal(await L.checkVisitorActive(L.visitorLimits(), 1), null, "the recheck after its own row is written");

      // A job that failed after launch but whose terminate isn't confirmed may still bill, so it still counts.
      await testDb.delete(realSchema.trainingJobs);
      await addJob(testDb, builder, { status: "failed", launchedAt: NOW, terminatedAt: null });
      assert.equal(await L.visitorActiveJobCount(), 1);
      const second = await addJob(testDb, builder, { status: "running" });
      assert.ok(second);
      assert.equal((await L.checkVisitorActive(L.visitorLimits(), 1))?.code, "visitor_gpu_busy", "two at once: each backs out");
    });
  });

  describe("datasets", () => {
    it("takes 1 to 100 of their own rows, 2 a day per visitor and 4 per IP", async () => {
      const s = subject("t-ds", "203.0.113.40");
      for (const rows of [0, 101, 1.5, -1]) {
        const r = await L.reserveVisitorDataset(s, { source: "rows", rows }, NOW);
        assert.ok(!r.ok);
        assert.equal(r.code, "visitor_dataset_rows", String(rows));
      }
      assert.equal(await value(identity.visitorCounterKey("dataset", "t-ds")), 0);
      assert.ok((await L.reserveVisitorDataset(s, { source: "rows", rows: 100 }, NOW)).ok);
      assert.ok((await L.reserveVisitorDataset(s, { source: "rows", rows: 1 }, NOW)).ok);
      const third = await L.reserveVisitorDataset(s, { source: "rows", rows: 10 }, NOW);
      assert.ok(!third.ok);
      assert.equal(third.code, "visitor_daily_dataset");
      assert.ok((await L.reserveVisitorDataset(subject("t-ds2", "203.0.113.40"), { source: "rows", rows: 5 }, NOW)).ok);
      assert.ok((await L.reserveVisitorDataset(subject("t-ds2", "203.0.113.40"), { source: "rows", rows: 5 }, NOW)).ok);
      const ip = await L.reserveVisitorDataset(subject("t-ds3", "203.0.113.40"), { source: "rows", rows: 5 }, NOW);
      assert.ok(!ip.ok);
      assert.equal(ip.code, "ip_daily_dataset");
      assert.equal(await value(identity.visitorCounterKey("dataset", "t-ds3")), 0, "released on refusal");
    });

    it("never lets Muse Wonder write a visitor's dataset, even with PUBLIC_DATASETS on; a ready lab dataset counts nothing", async () => {
      for (const flag of [undefined, "1"]) {
        if (flag) process.env.PUBLIC_DATASETS = flag;
        const r = await L.reserveVisitorDataset(subject("t-w"), { source: "wonder", rows: 10 }, NOW);
        assert.ok(!r.ok);
        assert.equal(r.status, 403);
        assert.equal(r.code, "visitor_rows_only");
        assert.equal(L.visitorDatasetSource("wonder")?.code, "visitor_rows_only");
      }
      const lab = await L.reserveVisitorDataset(subject("t-w"), { source: "lab_ready", rows: 0 }, NOW);
      assert.ok(lab.ok);
      assert.deepEqual(lab.reservation.items, []);
      assert.equal(await value(identity.visitorCounterKey("dataset", "t-w")), 0);
    });
  });
});
