/**
 * The training store against a real Postgres: an in-memory PGlite with the repo's migrations, standing in for Neon.
 * Covers the SQL the safety checks lean on: which jobs count as holding a GPU, the daily cap's committed spend, the job
 * token check, that an ended job only changes through finishJob, the one launch claim per job, a late launch and an
 * outlived termination, and the sweep's heartbeat. Also eval items (one per index, a cap per job) and judgements, a
 * decide job's scores (each index once per part, a cap per job, read back by part), and
 * training datasets: each answer saved once as it comes and moved onto train once a chunk, the eval split (keeping
 * near-duplicates of eval prompts out of train), a stopped-early note, paging in SQL. And the live demo: a serving
 * callback's endpoint (with the IP Lambda reported, kept in step with it), the adapters a serve job can serve, the
 * newest open demo of an adapter, and the proxy's one-at-a-time slot. Decision datasets: saved ready with their spec,
 * "person" as their writer and their rows out of every head read, and read back by index, cut in SQL. Nothing here
 * reaches Neon or Lambda.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/store.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import type { TrainJobRow } from "../logic";

const MIN = 60_000;
const canMock = typeof (mock as { module?: unknown }).module === "function";
const savedPepper = process.env.GATEWAY_TOKEN_PEPPER;

type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema> & {
  batch: (queries: PromiseLike<unknown>[]) => Promise<unknown[]>;
};

let client: import("@electric-sql/pglite").PGlite;
let testDb: TestDb;
let store: typeof import("../store");
let hashToken: (token: string) => string;

/** A queued smoke job, then the given columns written straight to its row. */
async function job(over: Partial<TrainJobRow> = {}): Promise<TrainJobRow> {
  const row = await store.createJob({
    recipe: "smoke",
    title: "Smoke test",
    params: {},
    instanceType: "gpu_1x_a10",
    region: "us-east-1",
    priceCentsPerHour: 60,
    maxMinutes: 30,
    maxUsd: 1,
  });
  if (!Object.keys(over).length) return row;
  const [updated] = await testDb.update(realSchema.trainingJobs).set(over).where(eq(realSchema.trainingJobs.id, row.id)).returning();
  return updated!;
}

describe("training store", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    // As lib/db/client.ts does for PGlite: Neon runs a batch as one transaction, PGlite runs it in order.
    const local: TestDb = Object.assign(drizzle({ client, schema: realSchema }), {
      batch: async (queries: PromiseLike<unknown>[]) => {
        const results: unknown[] = [];
        for (const q of queries) results.push(await q);
        return results;
      },
    });
    await migrate(local, { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
    testDb = local;
    // A test value for the HMAC, not a real pepper.
    process.env.GATEWAY_TOKEN_PEPPER = "test-pepper-for-store-tests";
    mock.module(new URL("../../db/client.ts", import.meta.url).href, {
      namedExports: { db: () => testDb, schema: realSchema },
    });
    store = await import("../store");
    ({ hashToken } = await import("../../gateway/tokens"));
  });

  after(async () => {
    mock.restoreAll();
    if (savedPepper === undefined) delete process.env.GATEWAY_TOKEN_PEPPER;
    else process.env.GATEWAY_TOKEN_PEPPER = savedPepper;
    await client?.close();
  });

  beforeEach(async () => {
    await testDb.delete(realSchema.trainingEvents);
    await testDb.delete(realSchema.trainingJobs);
    await testDb.delete(realSchema.trainingDatasets);
  });

  describe("activeJobCount", () => {
    it("counts unfinished jobs and ended ones whose instance isn't confirmed terminated", async () => {
      const now = Date.now();
      await job(); // queued
      await job({ status: "running", launchedAt: new Date(now - 5 * MIN) });
      await job({ status: "failed", launchedAt: new Date(now - 5 * MIN), finishedAt: new Date(now) }); // abandoned
      await job({ status: "succeeded", launchedAt: new Date(now - 5 * MIN), terminatedAt: new Date(now), finishedAt: new Date(now) });
      await job({ status: "failed", finishedAt: new Date(now) }); // never launched
      assert.equal(await store.activeJobCount(), 3);
    });
  });

  describe("trainingCommittedToday", () => {
    it("counts unfinished jobs at their full dollar limit, so two at once can't pass the cap", async () => {
      const now = new Date(Date.UTC(2026, 9, 27, 12, 0, 0));
      await job({ maxUsd: 2 }); // queued, not launched yet
      await job({ status: "running", maxUsd: 3, launchedAt: new Date(now.getTime() - 10 * MIN) });
      // Terminated today: its final cost.
      await job({
        status: "succeeded",
        launchedAt: new Date(now.getTime() - 60 * MIN),
        terminatedAt: new Date(now.getTime() - 30 * MIN),
        finishedAt: new Date(now.getTime() - 30 * MIN),
        costUsd: 0.3,
      });
      // Ended, terminate unconfirmed: its running estimate, 60 cents an hour for 60 minutes.
      await job({ status: "failed", launchedAt: new Date(now.getTime() - 60 * MIN), finishedAt: new Date(now.getTime() - 50 * MIN) });
      // Terminated yesterday: not today's spend.
      await job({
        status: "succeeded",
        launchedAt: new Date(now.getTime() - 26 * 60 * MIN),
        terminatedAt: new Date(now.getTime() - 25 * 60 * MIN),
        finishedAt: new Date(now.getTime() - 25 * 60 * MIN),
        costUsd: 9,
      });
      // $2 + $3 at their limits, $0.30 final and $0.60 estimated.
      assert.equal(await store.trainingCommittedToday(now), 5.9);
      // What has actually been spent today, for the page: the running job's 10 minutes ($0.10), not its limit.
      assert.equal(await store.trainingSpendToday(now), 1);
    });

    it("counts an unfinished job at its estimate once that passes its limit", async () => {
      const now = new Date(Date.UTC(2026, 9, 27, 12, 0, 0));
      await job({ status: "running", maxUsd: 0.5, launchedAt: new Date(now.getTime() - 120 * MIN) });
      assert.equal(await store.trainingCommittedToday(now), 1.2);
    });
  });

  describe("verifyJobToken", () => {
    it("accepts only this job's token, and only until 15 minutes after the job ended", async () => {
      const token = "job-token-for-tests";
      const row = await job({ status: "running", tokenHash: hashToken(token) });
      const other = await job({ status: "running", tokenHash: hashToken("another-token") });
      const now = new Date();
      assert.equal(await store.verifyJobToken(row.id, token, now), true);
      assert.equal(await store.verifyJobToken(row.id, "wrong", now), false);
      assert.equal(await store.verifyJobToken(other.id, token, now), false, "the token works for its own job only");
      assert.equal(await store.verifyJobToken("not-a-uuid", token, now), false);
      assert.notEqual(row.tokenHash, token, "only the hash is stored");

      const ended = new Date(now.getTime() - 14 * MIN);
      await testDb.update(realSchema.trainingJobs).set({ status: "succeeded", finishedAt: ended }).where(eq(realSchema.trainingJobs.id, row.id));
      assert.equal(await store.verifyJobToken(row.id, token, now), true, "late log lines still get in");
      assert.equal(await store.verifyJobToken(row.id, token, new Date(ended.getTime() + 16 * MIN)), false);
    });

    it("refuses every token before one was made", async () => {
      const row = await job();
      assert.equal(await store.verifyJobToken(row.id, "anything"), false);
    });
  });

  describe("ended jobs", () => {
    it("ignore setStatus, markLaunched, callbacks and stop requests", async () => {
      const row = await job({ status: "stopped", stopRequested: true, finishedAt: new Date() });
      assert.equal(await store.setStatus(row.id, "running"), false);
      assert.equal(await store.markLaunched(row.id, { instanceId: "inst-1", launchedAt: new Date() }), false);
      assert.deepEqual(await store.applyCallback(row.id, { type: "done" }, new Date()), { applied: false, status: "stopped" });
      assert.equal(await store.requestStop(row.id), null);
      const after = await store.getJob(row.id);
      assert.equal(after!.status, "stopped");
      assert.equal(after!.instanceId, null);
    });

    it("finishJob keeps the first terminatedAt, and counts an unsaved launch from the time it is given", async () => {
      const t0 = Date.now();
      const createdAt = new Date(t0 - 20 * MIN);
      const row = await job({ status: "launching", createdAt });
      const first = new Date(t0 - 2 * MIN);
      const done = await store.finishJob(row.id, { status: "failed", reason: "The launch failed.", terminatedAt: first, launchedAt: createdAt });
      assert.equal(done!.terminatedAt!.getTime(), first.getTime());
      assert.equal(done!.launchedAt!.getTime(), createdAt.getTime());
      assert.equal(done!.costUsd, 0.18, "18 minutes at 60 cents an hour");
      assert.equal(done!.error, "The launch failed.");

      const again = await store.finishJob(row.id, { status: "failed", reason: "again", terminatedAt: new Date(), launchedAt: new Date() });
      assert.equal(again!.terminatedAt!.getTime(), first.getTime());
      assert.equal(again!.launchedAt!.getTime(), createdAt.getTime());
      assert.equal(again!.costUsd, 0.18);
      const terminatedEvents = (await store.listEvents(row.id)).filter((e) => e.type === "terminated");
      assert.equal(terminatedEvents.length, 1);
    });

    it("finishJob keeps a done that landed while the caller was terminating", async () => {
      const t0 = Date.now();
      const row = await job({ status: "running", instanceId: "inst-1", launchedAt: new Date(t0 - 10 * MIN) });
      // The workflow decided on its time limit, then the runner's done got in before finishJob.
      await store.applyCallback(row.id, { type: "done", summary: "ok" }, new Date(t0 - 5_000));
      const done = await store.finishJob(row.id, { status: "failed", reason: "Reached the 30-minute limit.", terminatedAt: new Date(t0) });
      assert.equal(done!.status, "succeeded");
      assert.equal(done!.error, null);
      assert.equal(done!.costUsd, 0.1, "10 minutes at 60 cents an hour");
      const statuses = (await store.listEvents(row.id)).filter((e) => e.type === "status").map((e) => e.payload);
      assert.equal(statuses.filter((p) => p.type === "status" && p.status === "failed").length, 0, "no failed status logged");
    });

    it("finishJob ends a job an admin asked to stop as stopped, whatever the caller asked", async () => {
      const t0 = Date.now();
      const row = await job({ status: "running", instanceId: "inst-1", launchedAt: new Date(t0 - 5 * MIN) });
      await store.requestStop(row.id);
      const done = await store.finishJob(row.id, { status: "failed", reason: "The sweep terminated the instance.", terminatedAt: new Date(t0) });
      assert.equal(done!.status, "stopped");
      assert.equal(done!.error, null);
      const last = (await store.listEvents(row.id)).at(-1)!;
      assert.deepEqual(last.payload, { type: "status", status: "stopped", message: "Stopped by an admin." });
    });

    it("finishJob calls that overlap log one termination and agree on the ending", async () => {
      const t0 = Date.now();
      const row = await job({ status: "running", instanceId: "inst-1", launchedAt: new Date(t0 - 3 * MIN) });
      const [a, b] = await Promise.all([
        store.finishJob(row.id, { status: "succeeded", reason: "The job finished.", terminatedAt: new Date(t0) }),
        store.finishJob(row.id, { status: "failed", reason: "Reached the limit.", terminatedAt: new Date(t0 + 30_000) }),
      ]);
      assert.equal(a!.status, b!.status, "the second call keeps the first one's status");
      assert.equal(a!.terminatedAt!.getTime(), b!.terminatedAt!.getTime());
      assert.equal(a!.costUsd, b!.costUsd);
      const log = await store.listEvents(row.id);
      assert.equal(log.filter((e) => e.type === "terminated").length, 1);
      assert.equal(log.filter((e) => e.type === "status" && e.payload.type === "status" && e.payload.status !== "queued").length, 1);
    });

    it("finishJob answers null for an unknown or malformed id", async () => {
      const input = { status: "failed" as const, reason: "x", terminatedAt: new Date() };
      assert.equal(await store.finishJob("ffffffff-0000-4000-8000-000000000000", input), null);
      assert.equal(await store.finishJob("not-a-uuid", input), null);
    });
  });

  describe("artifacts", () => {
    const artifact = (i: number) => ({
      type: "artifact" as const,
      artifact: { name: `f${i}.bin`, kind: "other" as const, url: `https://s.public.blob.vercel-storage.com/models/x/f${i}.bin`, bytes: i },
    });

    it("keeps at most ARTIFACTS_MAX per job and says when the cap refused one", async () => {
      const row = await job({ status: "running" });
      const now = new Date();
      for (let i = 0; i < store.ARTIFACTS_MAX; i++) {
        assert.deepEqual(await store.applyCallback(row.id, artifact(i), now), { applied: true, status: "running" });
      }
      assert.deepEqual(await store.applyCallback(row.id, artifact(999), now), {
        applied: false,
        status: "running",
        artifactLimit: true,
      });
      const after = await store.getJob(row.id);
      assert.equal(after!.artifacts.length, store.ARTIFACTS_MAX);
      assert.equal(after!.artifacts.some((a) => a.name === "f999.bin"), false);
      // Other callbacks still get through.
      assert.deepEqual(await store.applyCallback(row.id, { type: "heartbeat" }, now), { applied: true, status: "running" });
    });
  });

  describe("launches", () => {
    it("claimLaunch claims once, refuses stopped or claimed jobs, and releaseLaunch gives back only its own claim", async () => {
      const row = await job();
      assert.equal(await store.claimLaunch(row.id, "h1", "Launching."), true);
      assert.equal(await store.claimLaunch(row.id, "h2", "Launching."), false);
      let after = await store.getJob(row.id);
      assert.equal(after!.status, "launching");
      assert.equal(after!.tokenHash, "h1");
      await store.releaseLaunch(row.id, "h2");
      assert.equal((await store.getJob(row.id))!.tokenHash, "h1", "only the matching claim is released");
      await store.releaseLaunch(row.id, "h1");
      after = await store.getJob(row.id);
      assert.equal(after!.status, "queued");
      assert.equal(after!.tokenHash, null);
      assert.equal(await store.claimLaunch(row.id, "h3", "Launching."), true);
      const stopped = await job({ stopRequested: true });
      assert.equal(await store.claimLaunch(stopped.id, "h", "Launching."), false);
      const launching = (await store.listEvents(row.id)).filter((e) => e.payload.type === "status" && e.payload.status === "launching");
      assert.equal(launching.length, 2);
    });

    it("claimLaunch: of two claims at once, exactly one wins", async () => {
      const row = await job();
      const results = await Promise.all([store.claimLaunch(row.id, "a", "x"), store.claimLaunch(row.id, "b", "x")]);
      assert.deepEqual(results.sort(), [false, true]);
    });

    it("markLaunched takes the same instance again but never replaces another one", async () => {
      const t0 = Date.now();
      const row = await job({ status: "launching", tokenHash: "h" });
      const first = new Date(t0 - 2 * MIN);
      assert.equal(await store.markLaunched(row.id, { instanceId: "inst-1", launchedAt: first }), true);
      assert.equal(await store.markLaunched(row.id, { instanceId: "inst-1", launchedAt: new Date(t0) }), true, "a retried save");
      assert.equal(await store.markLaunched(row.id, { instanceId: "inst-2", launchedAt: new Date(t0) }), false);
      const after = await store.getJob(row.id);
      assert.equal(after!.instanceId, "inst-1");
      assert.equal(after!.status, "booting");
      assert.equal(after!.launchedAt!.getTime(), first.getTime(), "the first launch time is kept");
    });

    it("saveLateLaunch saves an instance on an ended job and clears terminatedAt, once", async () => {
      const t0 = new Date(Date.now() - 10 * MIN);
      const row = await job({ status: "failed", finishedAt: t0, terminatedAt: t0 });
      const at = new Date(Date.now() - 3 * MIN);
      assert.equal(await store.saveLateLaunch(row.id, { instanceId: "i-1", launchedAt: at }), true);
      let after = await store.getJob(row.id);
      assert.equal(after!.instanceId, "i-1");
      assert.equal(after!.launchedAt!.getTime(), at.getTime());
      assert.equal(after!.terminatedAt, null);
      assert.equal(after!.status, "failed");
      assert.equal(await store.activeJobCount(), 1, "it holds a GPU again");
      assert.equal(await store.saveLateLaunch(row.id, { instanceId: "i-2", launchedAt: new Date() }), false);
      after = await store.getJob(row.id);
      assert.equal(after!.instanceId, "i-1");
      await store.finishJob(row.id, { status: "failed", reason: "x", terminatedAt: new Date() });
      assert.equal(await store.activeJobCount(), 0);
    });

    it("extendTermination moves terminatedAt later only and recounts the cost from createdAt", async () => {
      const t0 = Date.now();
      const created = new Date(t0 - 60 * MIN);
      const t1 = new Date(t0 - 50 * MIN);
      const row = await job({ status: "failed", createdAt: created, finishedAt: t1, terminatedAt: t1, launchedAt: null, costUsd: 0 });
      const now = new Date(t0);
      const later = await store.extendTermination(row.id, { terminatedAt: now, reason: "late" });
      assert.equal(later!.launchedAt!.getTime(), created.getTime());
      assert.equal(later!.terminatedAt!.getTime(), now.getTime());
      assert.equal(later!.costUsd, 0.6, "60 minutes at 60 cents an hour");
      const earlier = await store.extendTermination(row.id, { terminatedAt: t1, reason: "again" });
      assert.equal(earlier!.terminatedAt!.getTime(), now.getTime(), "never earlier");
      assert.equal(earlier!.costUsd, 0.6);
      const open = await job();
      assert.equal(await store.extendTermination(open.id, { terminatedAt: now, reason: "x" }), null);
    });
  });

  describe("the sweep's heartbeat", () => {
    it("lastSweepOkAt answers the minute of the latest recordSweepOk", async () => {
      await testDb.delete(realSchema.rateLimits);
      assert.equal(await store.lastSweepOkAt(), null);
      const t = Date.UTC(2026, 9, 27, 12, 0, 0);
      await store.recordSweepOk(new Date(t + 5 * MIN + 30_000));
      await store.recordSweepOk(new Date(t + 5 * MIN + 45_000)); // the same minute again
      await store.recordSweepOk(new Date(t));
      assert.equal((await store.lastSweepOkAt())!.getTime(), t + 5 * MIN);
      // A rate limit under another key doesn't count.
      await testDb.insert(realSchema.rateLimits).values({ key: "train-upload:x", windowStart: new Date(t + 30 * MIN), count: 1 });
      assert.equal((await store.lastSweepOkAt())!.getTime(), t + 5 * MIN);
    });
  });

  describe("reserveUploadBytes", () => {
    it("counts declared bytes per job per hour and refuses a grant that would pass the cap without counting it", async () => {
      const row = await job({ status: "running" });
      const hour = new Date(Date.UTC(2026, 9, 27, 12));
      const GIB = 1024 ** 3;
      assert.equal(await store.reserveUploadBytes(row.id, GIB, hour, 2 * GIB), true);
      assert.equal(await store.reserveUploadBytes(row.id, 1.5 * GIB, hour, 2 * GIB), false, "1 GiB + 1.5 GiB passes the cap");
      assert.equal(await store.reserveUploadBytes(row.id, GIB, hour, 2 * GIB), true, "the refused grant wasn't counted");
      assert.equal(await store.reserveUploadBytes(row.id, 1, hour, 2 * GIB), false, "2 GiB already granted");
      assert.equal(await store.reserveUploadBytes(row.id, 1, new Date(hour.getTime() + 60 * MIN), 2 * GIB), true, "a new hour");
      const other = await job({ status: "running" });
      assert.equal(await store.reserveUploadBytes(other.id, GIB, hour, 2 * GIB), true, "each job has its own budget");
      assert.equal(await store.reserveUploadBytes(row.id, 3 * GIB, new Date(hour.getTime() + 120 * MIN), 2 * GIB), false);
    });
  });
  describe("eval items and judgements", () => {
    const item = (index: number, extra: Record<string, string> = {}) => ({
      type: "eval" as const,
      index,
      prompt: `prompt ${index}`,
      reference: "ref",
      base: "base answer",
      tuned: "tuned answer",
      ...extra,
    });

    it("records one item per index, cut to size, and refuses past the cap", async () => {
      const row = await job({ status: "running" });
      assert.equal(await store.recordEvalEvent(row.id, item(0, { base: "b".repeat(5000) }), 3), "recorded");
      assert.equal(await store.recordEvalEvent(row.id, item(0), 3), "duplicate", "a retried callback");
      assert.equal(await store.recordEvalEvent(row.id, item(2), 3), "recorded");
      assert.equal(await store.recordEvalEvent(row.id, item(1), 3), "recorded");
      assert.equal(await store.recordEvalEvent(row.id, item(3), 3), "limit");
      assert.equal(await store.recordEvalEvent(row.id, item(2), 3), "duplicate", "a retry past the cap is still a retry");
      assert.deepEqual(await store.listEvalIndexes(row.id), [0, 1, 2]);
      const first = await store.getEvalItem(row.id, 0);
      assert.equal(first!.base.length, 3500);
      assert.equal(first!.prompt, "prompt 0");
      assert.equal(await store.getEvalItem(row.id, 9), null);
      const other = await job({ status: "running" });
      assert.deepEqual(await store.listEvalIndexes(other.id), [], "each job has its own items");
      assert.equal(await store.recordEvalEvent(other.id, item(0), 3), "recorded");
    });

    it("finds a judgement by index and saves the eval summary without touching the status", async () => {
      const row = await job({ status: "succeeded", finishedAt: new Date(), terminatedAt: new Date() });
      assert.equal(await store.getJudgement(row.id, 4), null);
      await store.recordEvent(row.id, { type: "judgement", index: 4, baseScore: 3, tunedScore: 8, better: "tuned", note: "Clearer." });
      assert.deepEqual(await store.getJudgement(row.id, 4), {
        type: "judgement",
        index: 4,
        baseScore: 3,
        tunedScore: 8,
        better: "tuned",
        note: "Clearer.",
      });
      const summary = { items: 1, tunedWins: 1, baseWins: 0, ties: 0, avgBaseScore: 3, avgTunedScore: 8, judgeCostUsd: 0.001 };
      await store.setEvalSummary(row.id, summary);
      const after = await store.getJob(row.id);
      assert.deepEqual(after!.evalSummary, summary);
      assert.equal(after!.status, "succeeded");
    });

    it("saves the judge's model on the job, and a job from before has none", async () => {
      const row = await job({ status: "succeeded", finishedAt: new Date(), terminatedAt: new Date() });
      assert.equal((await store.getJob(row.id))!.judgeModel, null, "null reads as Muse Spark 1.3");
      await store.setJudgeModel(row.id, "muse-wonder-1.0");
      assert.equal((await store.getJob(row.id))!.judgeModel, "muse-wonder-1.0");
      await store.setJudgeModel("not-a-uuid", "muse-wonder-1.0");
    });
  });

  describe("decide scores", () => {
    const score = (index: number, tuned = true) => ({
      index,
      base: [-0.2, -1.9, -4.1],
      tuned: tuned ? [-0.05, -3.2, -6.0] : null,
      baseMass: 0.98,
      tunedMass: tuned ? 0.99 : null,
    });
    const decide = (part: "dev" | "test", indexes: number[], tuned = true) => ({ type: "decide" as const, part, items: indexes.map((i) => score(i, tuned)) });

    it("logs each index once per part, only the new items of a retry, and nothing past the cap", async () => {
      const row = await job({ status: "running" });
      assert.equal(await store.recordDecideEvent(row.id, decide("dev", [0, 1, 2]), 10), "recorded");
      assert.equal(await store.recordDecideEvent(row.id, decide("dev", [0, 1, 2]), 10), "duplicate", "a retried callback");
      assert.equal(await store.recordDecideEvent(row.id, decide("test", [0, 1]), 10), "recorded", "test's index 0 isn't dev's");
      assert.equal(await store.recordDecideEvent(row.id, decide("dev", [2, 3, 4]), 10), "recorded", "a retry with new items keeps only those");
      assert.equal(await store.recordDecideEvent(row.id, decide("test", [2, 3, 4, 5]), 10), "limit", "7 logged, and 4 more would pass 10");
      assert.equal(await store.recordDecideEvent(row.id, decide("test", [2, 3, 4]), 10), "recorded", "exactly 10");
      assert.equal(await store.recordDecideEvent(row.id, decide("test", [5]), 10), "limit");
      assert.equal(await store.recordDecideEvent(row.id, decide("test", [0]), 10), "duplicate", "a retry past the cap is still a retry");

      const scores = await store.decideScores(row.id);
      assert.deepEqual(scores.dev.map((s) => s.index), [0, 1, 2, 3, 4]);
      assert.deepEqual(scores.test.map((s) => s.index), [0, 1, 2, 3, 4]);
      assert.deepEqual(scores.dev[0], score(0), "as sent");
      const rows = await testDb.select().from(realSchema.trainingEvents).where(eq(realSchema.trainingEvents.jobId, row.id));
      const logged = rows.filter((r) => r.type === "decide").map((r) => (r.payload as { part: string; items: unknown[] }));
      assert.deepEqual(logged.map((p) => [p.part, p.items.length]), [["dev", 3], ["test", 2], ["dev", 2], ["test", 3]]);

      const other = await job({ status: "running" });
      assert.deepEqual(await store.decideScores(other.id), { dev: [], test: [] }, "each job has its own scores");
      assert.equal(await store.recordDecideEvent(other.id, decide("dev", [0], false)), "recorded");
      assert.deepEqual((await store.decideScores(other.id)).dev, [score(0, false)]);
      assert.equal(await store.recordDecideEvent("not-a-uuid", decide("dev", [0])), "limit");
      assert.deepEqual(await store.decideScores("not-a-uuid"), { dev: [], test: [] });
    });

    it("keeps scores apart from the job's eval items and its other events", async () => {
      const row = await job({ status: "running" });
      await store.recordEvent(row.id, { type: "log", text: "scoring" });
      await store.recordEvalEvent(row.id, { type: "eval", index: 0, prompt: "p", reference: "r", base: "b", tuned: "t" });
      assert.equal(await store.recordDecideEvent(row.id, decide("test", [0])), "recorded");
      assert.deepEqual(await store.listEvalIndexes(row.id), [0]);
      assert.deepEqual((await store.decideScores(row.id)).test.map((s) => s.index), [0]);
      assert.equal(await store.recordEvalEvent(row.id, { type: "eval", index: 1, prompt: "p", reference: "r", base: "b", tuned: "t" }, 2), "recorded", "decide items don't count as eval items");
    });
  });

  describe("datasets", () => {
    const example = (i: number) => ({
      messages: [
        { role: "system" as const, content: "sys" },
        { role: "user" as const, content: `q${i}` },
        { role: "assistant" as const, content: `a${i}` },
      ],
    });
    const examples = (from: number, n: number) => Array.from({ length: n }, (_, k) => example(from + k));

    it("creates a generating dataset without examples, and lists it without them", async () => {
      const ds = await store.createDataset({ title: "  Errors  ", task: " Explain Python errors. ", requested: 40, writerModel: "muse-wonder-1.0" });
      assert.equal(ds.status, "generating");
      assert.equal(ds.writerModel, "muse-wonder-1.0", "the writer is saved with it");
      assert.equal(ds.title, "Errors");
      assert.equal(ds.task, "Explain Python errors.");
      assert.equal("train" in ds || "eval" in ds, false);
      const [listed] = await store.listDatasets();
      assert.equal(listed!.id, ds.id);
      assert.equal("train" in listed!, false);
      assert.equal((await store.getDataset(ds.id))!.requested, 40);
      assert.equal(await store.getDataset("not-a-uuid"), null);
    });

    /** Saves `n` answers from `from` and moves them onto train, as one answer step does. */
    async function answer(id: string, from: number, n: number) {
      for (let i = from; i < from + n; i++) assert.equal(await store.stageAnswer(id, { prompt: `q${i}`, reference: `a${i}` }), true);
      return store.flushAnswers(id, "sys");
    }

    it("saves each answer once as it comes, and moves them onto train once a chunk", async () => {
      const ds = await store.createDataset({ title: "t", task: "task", requested: 40, writerModel: "muse-wonder-1.0" });
      assert.deepEqual(await store.answerProgress(ds.id), { held: 0, staged: [] });
      assert.equal(await store.stageAnswer(ds.id, { prompt: "q0", reference: "a0" }), true);
      assert.equal(await store.stageAnswer(ds.id, { prompt: "q1", reference: "a1" }), true);
      assert.equal(await store.stageAnswer(ds.id, { prompt: "q0", reference: "a0 again" }), true, "a retried write");
      assert.deepEqual(await store.answerProgress(ds.id), { held: 0, staged: ["q0", "q1"] }, "saved once each");
      assert.equal(await store.datasetProgress(ds.id), 0, "not in train yet");

      assert.equal(await store.flushAnswers(ds.id, "sys"), 2);
      assert.equal(await store.flushAnswers(ds.id, "sys"), 2, "nothing left to move");
      assert.deepEqual(await store.answerProgress(ds.id), { held: 2, staged: [] });
      const train = await store.datasetPage(ds.id, "train", 0, 10);
      assert.deepEqual(train!.items, [example(0), example(1)], "the training examples, under the system message");
      assert.equal(await answer(ds.id, 2, 3), 5);

      await store.addDatasetCost(ds.id, 0.0012345);
      await store.addDatasetCost(ds.id, 0.001);
      assert.equal((await store.getDataset(ds.id))!.costUsd, 0.002235);
      assert.equal(await store.stageAnswer("ffffffff-0000-4000-8000-000000000000", { prompt: "q", reference: "a" }), false);
    });

    it("holds out the eval items, keeps the rest in order, and pages in SQL", async () => {
      const ds = await store.createDataset({ title: "t", task: "task", requested: 20, writerModel: "muse-wonder-1.0" });
      await answer(ds.id, 0, 20);
      assert.equal(await store.finishDataset(ds.id, 19), null, "refused when the count doesn't match");
      const done = await store.finishDataset(ds.id, 20);
      assert.equal(done!.status, "ready");
      assert.equal(done!.trainCount, 12);
      assert.equal(done!.evalCount, 8);
      assert.equal(done!.error, null);
      assert.ok(done!.finishedAt);
      assert.equal(await store.finishDataset(ds.id, 20), null, "only once");
      assert.equal(await store.datasetProgress(ds.id), null, "no longer generating");
      assert.equal(await store.stageAnswer(ds.id, { prompt: "late", reference: "x" }), false);
      assert.equal(await store.flushAnswers(ds.id, "sys"), null);

      const evalPage = await store.datasetPage(ds.id, "eval", 0, 200);
      // evalIndexes(20) is [1, 3, 6, 8, 11, 13, 16, 18].
      assert.deepEqual(evalPage!.items, [1, 3, 6, 8, 11, 13, 16, 18].map((i) => ({ prompt: `q${i}`, reference: `a${i}` })));
      assert.equal(evalPage!.total, 8);
      assert.equal(evalPage!.title, "t");
      const train = await store.datasetPage(ds.id, "train", 0, 200);
      assert.deepEqual(
        (train!.items as Array<{ messages: Array<{ content: string }> }>).map((e) => e.messages[1]!.content),
        [0, 2, 4, 5, 7, 9, 10, 12, 14, 15, 17, 19].map((i) => `q${i}`),
      );
      const second = await store.datasetPage(ds.id, "train", 5, 5);
      assert.deepEqual(
        (second!.items as Array<{ messages: Array<{ content: string }> }>).map((e) => e.messages[1]!.content),
        ["q9", "q10", "q12", "q14", "q15"],
      );
      assert.deepEqual((await store.datasetPage(ds.id, "train", 400, 200))!.items, []);
      assert.equal(second!.status, "ready");
      assert.equal(await store.datasetPage("ffffffff-0000-4000-8000-000000000000", "train", 0, 5), null);
    });

    it("keeps an eval prompt's near-duplicates out of train, and notes a dataset that stopped early", async () => {
      const ds = await store.createDataset({ title: "t", task: "task", requested: 40, writerModel: "muse-wonder-1.0" });
      for (let i = 0; i < 20; i++) {
        // Position 1 (an evalIndexes pick) and 12 ask the same thing in slightly different words.
        const prompt = i === 1 ? "How do I reset my password?" : i === 12 ? "how can i reset my password" : `q${i}`;
        await store.stageAnswer(ds.id, { prompt, reference: `a${i}` });
      }
      assert.equal(await store.flushAnswers(ds.id, "sys"), 20);
      const note = "Stopped early, once 20 of the 40 examples asked for were answered. The spend cap is reached.";
      const done = await store.finishDataset(ds.id, 20, note);
      assert.equal(done!.status, "ready");
      assert.equal(done!.error, note, "the page shows it");
      assert.equal(done!.evalCount + done!.trainCount, 20);
      const evalPrompts = ((await store.datasetPage(ds.id, "eval", 0, 50))!.items as Array<{ prompt: string }>).map((e) => e.prompt);
      const trainPrompts = ((await store.datasetPage(ds.id, "train", 0, 50))!.items as Array<{ messages: Array<{ content: string }> }>).map(
        (e) => e.messages[1]!.content,
      );
      assert.equal(evalPrompts.length, 8);
      const resets = [...evalPrompts, ...trainPrompts].filter((p) => /reset my password/i.test(p));
      assert.equal(resets.length, 2, "both are kept");
      assert.equal(evalPrompts.some((p) => /reset my password/i.test(p)), false, "neither is held out next to the other in train");
    });

    it("fails only a dataset that is still generating", async () => {
      const ds = await store.createDataset({ title: "t", task: "task", requested: 20, writerModel: "muse-wonder-1.0" });
      assert.equal(await store.failDataset(ds.id, "The spend cap was reached."), true);
      const failed = await store.getDataset(ds.id);
      assert.equal(failed!.status, "failed");
      assert.equal(failed!.error, "The spend cap was reached.");
      assert.ok(failed!.finishedAt);
      assert.equal(await store.failDataset(ds.id, "again"), false);
      assert.equal((await store.getDataset(ds.id))!.error, "The spend cap was reached.");
    });
  });

  describe("decision datasets", () => {
    /** A made-up ticket upload, checked and split as the datasets route does it. */
    async function upload(counts?: number[]) {
      const { checkDecisionUpload } = await import("../decision-datasets");
      const { TICKET_LABELS, TICKET_QUESTION, ticketRows } = await import("./decision-fixture");
      const result = checkDecisionUpload({ title: "Ticket router", question: TICKET_QUESTION, labels: TICKET_LABELS, rows: ticketRows(counts) }, "store-seed");
      assert.ok(result.ok);
      return result;
    }

    it("saves a decision dataset ready at once, with its spec, kind and \"person\" as its writer, and no rows in its head", async () => {
      const { spec, rows, title } = await upload();
      const ds = await store.createDecisionDataset({ title, spec, rows, createdBy: null });
      assert.equal(ds.kind, "decision");
      assert.equal(ds.status, "ready");
      assert.equal(ds.writerModel, "person", "never null, which would read as Muse Spark 1.3");
      assert.equal(ds.task, spec.question);
      assert.equal(ds.title, "Ticket router");
      assert.equal(ds.requested, 120);
      assert.equal(ds.trainCount, 84);
      assert.equal(ds.evalCount, 24, "the test rows");
      assert.ok(ds.finishedAt);
      assert.deepEqual(ds.decision, spec);
      for (const head of [ds, await store.getDataset(ds.id), (await store.listDatasets())[0]]) {
        assert.equal(head!.id, ds.id);
        assert.equal("decisionRows" in head! || "train" in head! || "eval" in head!, false, "rows stay out of every head read");
      }
      const [stored] = await testDb.select().from(realSchema.trainingDatasets).where(eq(realSchema.trainingDatasets.id, ds.id));
      assert.deepEqual(stored!.decisionRows, rows);
      assert.deepEqual(stored!.train, [], "train and eval stay empty, so no chat reader changes");
      assert.deepEqual(stored!.eval, []);
      assert.deepEqual((await store.datasetPage(ds.id, "train", 0, 10))!.items, []);
      assert.equal((await store.getReadyDataset(ds.id))!.title, "Ticket router");
    });

    it("refuses rows that don't match the spec's counts", async () => {
      const { spec, rows, title } = await upload();
      await assert.rejects(store.createDecisionDataset({ title, spec, rows: { ...rows, test: rows.test.slice(1) } }), /test rows don't match/);
      assert.equal((await store.listDatasets()).length, 0);
    });

    it("reads a split's rows by index, cut in SQL, or all of them", async () => {
      const { spec, rows, title } = await upload();
      const ds = await store.createDecisionDataset({ title, spec, rows });
      const some = await store.decisionSplitRows(ds.id, "train", [0, 5, 83, 84, -1]);
      assert.equal(some!.total, 84);
      assert.deepEqual([...some!.rows.keys()], [0, 5, 83], "past the end and negative indexes are left out");
      assert.deepEqual(some!.rows.get(5), rows.train[5]);
      assert.deepEqual(some!.rows.get(83), rows.train[83]);
      const test = await store.decisionSplitRows(ds.id, "test");
      assert.deepEqual([...test!.rows.values()], rows.test);
      assert.deepEqual(await store.decisionSplitRows(ds.id, "dev", []), { total: 12, rows: new Map() });
      assert.equal(await store.decisionSplitRows("not-a-uuid", "dev"), null);
      assert.equal(await store.decisionSplitRows(ds.id, "eval" as "dev"), null);
    });

    it("reads a chat dataset as kind chat with no decision rows", async () => {
      const chat = await store.createDataset({ title: "t", task: "Explain Python errors.", requested: 20, writerModel: "muse-wonder-1.0" });
      assert.equal(chat.kind, "chat");
      assert.equal(chat.decision, null);
      assert.equal(await store.decisionSplitRows(chat.id, "train"), null);
      const [stored] = await testDb.select().from(realSchema.trainingDatasets).where(eq(realSchema.trainingDatasets.id, chat.id));
      assert.deepEqual(stored!.decisionRows, {});
    });
  });

  describe("Lab results (read-only, for everyone)", () => {
    const summary = { items: 2, tunedWins: 1, baseWins: 0, ties: 1, avgBaseScore: 4.5, avgTunedScore: 7.5, judgeCostUsd: 0.004 };
    /** Columns a public page must never get. */
    const HIDDEN = ["instanceId", "instanceIp", "instanceName", "region", "tokenHash", "workflowRunId", "error", "artifacts", "summary", "progress", "createdBy", "maxUsd", "maxMinutes"];
    const judged = (over: Partial<TrainJobRow> = {}) =>
      job({
        recipe: "glimmer-lora",
        title: "Bakery LoRA",
        params: { datasetId: "1b2c3d4e-0000-4000-8000-000000000002", maxSteps: 120, dryRun: 0 },
        status: "succeeded",
        instanceId: "i-0123456789",
        instanceIp: "203.0.113.9",
        error: "Traceback in /home/ubuntu/secret",
        launchedAt: new Date(Date.now() - 40 * MIN),
        finishedAt: new Date(Date.now() - 5 * MIN),
        terminatedAt: new Date(Date.now() - 4 * MIN),
        evalSummary: summary,
        ...over,
      });

    it("lists only succeeded, shut down, judged jobs that aren't dry runs, with no hidden columns", async () => {
      const shown = await judged();
      await judged({ status: "running", terminatedAt: null, finishedAt: null });
      await judged({ status: "failed" });
      await judged({ status: "stopped" });
      await judged({ terminatedAt: null }); // the GPU isn't confirmed gone
      await judged({ evalSummary: null }); // judging hasn't finished
      await judged({ evalSummary: { ...summary, items: 0, tunedWins: 0, ties: 0, note: "Judging skipped: no key." } as never });
      await judged({ params: { datasetId: "1b2c3d4e-0000-4000-8000-000000000002", dryRun: 1 } }); // fake answers
      const rows = await store.listResultJobs();
      assert.deepEqual(rows.map((r) => r.id), [shown.id]);
      for (const key of HIDDEN) assert.equal(key in rows[0]!, false, key);
      assert.deepEqual(rows[0]!.evalSummary, summary);
    });

    it("gets one judged job, and nothing for any other job or a bad id", async () => {
      const shown = await judged();
      const running = await judged({ status: "running", terminatedAt: null });
      const failed = await judged({ status: "failed" });
      const row = await store.getResultJob(shown.id);
      assert.equal(row!.title, "Bakery LoRA");
      assert.equal(row!.judgeModel, null, "a job judged before the judge was recorded: Muse Spark 1.3");
      for (const key of HIDDEN) assert.equal(key in row!, false, key);
      const wonder = await judged({ judgeModel: "muse-wonder-1.0" });
      assert.equal((await store.getResultJob(wonder.id))!.judgeModel, "muse-wonder-1.0");
      assert.equal(await store.getResultJob(running.id), null);
      assert.equal(await store.getResultJob(failed.id), null);
      assert.equal(await store.getResultJob("not-a-uuid"), null);
    });

    it("reads only a judged job's eval items and judgements, never the rest of its log", async () => {
      const item = { type: "eval" as const, index: 0, prompt: "Open Sunday?", reference: "Until 4.", base: "Yes.", tuned: "Until 4 pm." };
      const shown = await judged();
      await store.recordEvalEvent(shown.id, item);
      await store.recordEvent(shown.id, { type: "log", text: "token=abc /home/ubuntu/secret" });
      await store.recordEvent(shown.id, { type: "judgement", index: 0, baseScore: 3, tunedScore: 9, better: "tuned", note: "Gives the hours." });
      const list = await store.listResultEvents(shown.id);
      assert.deepEqual(list.map((e) => e.type), ["eval", "judgement"]);
      assert.equal(JSON.stringify(list).includes("secret"), false);

      const running = await judged({ status: "running", terminatedAt: null });
      await store.recordEvalEvent(running.id, item);
      assert.deepEqual(await store.listResultEvents(running.id), [], "nothing for a job without results");
      assert.deepEqual(await store.listResultEvents("not-a-uuid"), []);
    });

    it("lists and gets only ready datasets, without their examples or note", async () => {
      const insert = (over: Partial<typeof realSchema.trainingDatasets.$inferInsert>) =>
        testDb
          .insert(realSchema.trainingDatasets)
          .values({ title: "Bakery helper", task: "Answer bakery questions.", requested: 40, ...over })
          .returning()
          .then((r) => r[0]!);
      const ready = await insert({
        status: "ready",
        trainCount: 30,
        evalCount: 8,
        train: [{ messages: [{ role: "user", content: "q" }] }],
        error: "Stopped early, once 38 of the 40 examples asked for were answered.",
      });
      const writing = await insert({ status: "generating" });
      const failed = await insert({ status: "failed", error: "It failed." });
      const rows = await store.listReadyDatasets();
      assert.deepEqual(rows.map((r) => r.id), [ready.id]);
      for (const key of ["train", "eval", "error", "createdBy", "workflowRunId"]) assert.equal(key in rows[0]!, false, key);
      assert.equal(rows[0]!.trainCount, 30);
      assert.equal(rows[0]!.writerModel, null, "a dataset from before the writer was recorded: Muse Spark 1.3");
      const wonder = await insert({ status: "ready", trainCount: 30, evalCount: 8, writerModel: "muse-wonder-1.0" });
      assert.equal((await store.getReadyDataset(wonder.id))!.writerModel, "muse-wonder-1.0");
      assert.equal((await store.getReadyDataset(ready.id))!.title, "Bakery helper");
      assert.equal(await store.getReadyDataset(writing.id), null);
      assert.equal(await store.getReadyDataset(failed.id), null);
      assert.equal(await store.getReadyDataset("not-a-uuid"), null);
    });
  });
  describe("live demo", () => {
    const ADAPTER_CERT = "ab".repeat(32);
    const lora = (over: Partial<TrainJobRow> = {}) =>
      job({
        recipe: "glimmer-lora",
        title: "Brief writer LoRA",
        params: { datasetId: "1b2c3d4e-0000-4000-8000-000000000002", maxSteps: 120, dryRun: 0 },
        status: "succeeded",
        region: "us-east-1",
        launchedAt: new Date(Date.now() - 60 * MIN),
        finishedAt: new Date(Date.now() - 10 * MIN),
        terminatedAt: new Date(Date.now() - 9 * MIN),
        ...over,
      });
    /** Logs the done callback a glimmer-lora job sends, with the adapter where the recipe saved it. */
    const done = async (id: string, metrics: Record<string, string | number>) =>
      store.recordEvent(id, { type: "done", summary: "LoRA r=16.", metrics: { steps: 120, ...metrics } });
    const onCache = (id: string) => ({ cache_used: "yes", adapter_dir: `/lambda/nfs/muse-muse-cache-us-east-1/models/${id}` });
    const serveJob = (adapterJobId: string, over: Partial<TrainJobRow> = {}) =>
      job({
        recipe: "glimmer-serve",
        title: "Live demo",
        params: { adapterJobId, minutes: 30 },
        status: "running",
        instanceType: "gpu_1x_h100_sxm5",
        priceCentsPerHour: 429,
        maxMinutes: 45,
        maxUsd: 3.29,
        instanceId: "i-serve",
        instanceIp: "203.0.113.9",
        tokenHash: "serve-token-hash",
        launchedAt: new Date(Date.now() - 10 * MIN),
        ...over,
      });
    const serving = { type: "serving" as const, port: 8443, certSha256: ADAPTER_CERT, model: "glimmer", adapterJobId: "x" };

    it("stores a serving callback's endpoint with the IP Lambda reported, and replaces it on the next one", async () => {
      const row = await serveJob("aaaaaaaa-0000-4000-8000-000000000000", { status: "booting" });
      const first = new Date(Date.now() - 2 * MIN);
      assert.deepEqual(await store.applyCallback(row.id, serving, first), { applied: true, status: "running" });
      let saved = (await store.getJob(row.id))!;
      assert.deepEqual(saved.serveEndpoint, { ip: "203.0.113.9", port: 8443, certSha256: ADAPTER_CERT, startedAt: first.toISOString() });
      assert.equal(saved.lastHeartbeatAt?.getTime(), first.getTime(), "a sign of life");

      const restarted = { ...serving, certSha256: "cd".repeat(32) };
      await store.applyCallback(row.id, restarted, new Date());
      saved = (await store.getJob(row.id))!;
      assert.equal(saved.serveEndpoint?.certSha256, "cd".repeat(32), "a restarted server's new certificate");

      // Lambda reports a new IP: the endpoint follows it, and a lost one stays lost rather than wiping the endpoint.
      await store.setInstanceIp(row.id, "198.51.100.20");
      assert.equal((await store.getJob(row.id))!.serveEndpoint?.ip, "198.51.100.20");
      await store.setInstanceIp(row.id, null);
      const lost = (await store.getJob(row.id))!;
      assert.equal(lost.serveEndpoint?.ip, null);
      assert.equal(lost.serveEndpoint?.port, 8443);

      const plain = await job({ status: "running" });
      await store.setInstanceIp(plain.id, "198.51.100.21");
      assert.equal((await store.getJob(plain.id))!.serveEndpoint, null, "no endpoint appears on another job");

      const ended = await serveJob("aaaaaaaa-0000-4000-8000-000000000000", { status: "succeeded", finishedAt: new Date() });
      assert.equal((await store.applyCallback(ended.id, serving, new Date()))!.applied, false);
      assert.equal((await store.getJob(ended.id))!.serveEndpoint, null);
    });

    it("lists only adapters a serve job can serve, with their dataset's title, and reads one with its done metrics", async () => {
      await testDb.insert(realSchema.trainingDatasets).values({
        id: "1b2c3d4e-0000-4000-8000-000000000002",
        title: "Muse Muse's brief writer",
        task: "Write briefs.",
        requested: 40,
        status: "ready",
      });
      const good = await lora();
      await done(good.id, onCache(good.id));
      const dry = await lora({ params: { datasetId: "1b2c3d4e-0000-4000-8000-000000000002", dryRun: 1 } });
      await done(dry.id, onCache(dry.id));
      const uncached = await lora();
      await done(uncached.id, { cache_used: "no", adapter_dir: `/opt/muse/models/${uncached.id}` });
      const elsewhere = await lora();
      await done(elsewhere.id, onCache(good.id)); // an adapter folder that isn't its own
      const failed = await lora({ status: "failed" });
      await done(failed.id, onCache(failed.id));
      await lora(); // succeeded, but no done event logged

      const options = await store.listAdapterOptions();
      assert.deepEqual(options.map((o) => o.jobId), [good.id]);
      assert.deepEqual(options[0], {
        jobId: good.id,
        title: "Brief writer LoRA",
        region: "us-east-1",
        datasetTitle: "Muse Muse's brief writer",
        finishedAt: good.finishedAt!.toISOString(),
        evalSummary: null,
      });

      const source = await store.getAdapterSource(good.id);
      assert.equal(source!.job.id, good.id);
      assert.equal(source!.metrics!.cache_used, "yes");
      assert.equal(source!.metrics!.steps, 120);
      // The latest done event is the one that counts.
      await done(good.id, { cache_used: "no" });
      assert.equal((await store.getAdapterSource(good.id))!.metrics!.cache_used, "no");
      assert.equal((await store.getAdapterSource(failed.id))!.metrics!.cache_used, "yes");
      const none = await lora();
      assert.equal((await store.getAdapterSource(none.id))!.metrics, null);
      assert.equal(await store.getAdapterSource("not-a-uuid"), null);
    });

    it("finds an adapter's newest open demo, live only with a usable endpoint, and gives the proxy what it needs", async () => {
      const adapter = await lora();
      const id = adapter.id;
      assert.equal(await store.getLiveDemo(id), null);
      assert.equal(await store.liveServeTarget(id), null);

      const older = await serveJob(id, { status: "succeeded", finishedAt: new Date() });
      const demo = await serveJob(id, { status: "booting" });
      const starting = await store.getLiveDemo(id.toUpperCase());
      assert.equal(starting!.serveJobId, demo.id);
      assert.equal(starting!.state, "starting");
      assert.equal(await store.liveServeTarget(id), null, "not live before it serves");

      await store.applyCallback(demo.id, serving, new Date(Date.now() - MIN));
      const live = (await store.getLiveDemo(id))!;
      assert.equal(live.state, "live");
      assert.equal(live.minutes, 30);
      assert.ok(!JSON.stringify(live).includes("203.0.113.9") && !JSON.stringify(live).includes(ADAPTER_CERT), "nothing about the GPU");
      assert.deepEqual(await store.liveServeTarget(id), {
        jobId: demo.id,
        tokenHash: "serve-token-hash",
        ip: "203.0.113.9",
        port: 8443,
        certSha256: ADAPTER_CERT,
      });

      // Its minutes are up: 30 after it started serving.
      assert.equal(await store.liveServeTarget(id, new Date(Date.now() + 30 * MIN)), null);
      assert.equal(await store.getLiveDemo(id, new Date(Date.now() + 30 * MIN)), null);
      // Another adapter's demo is never this one's.
      assert.equal(await store.getLiveDemo((await lora()).id), null);

      await store.requestStop(demo.id);
      assert.equal(await store.getLiveDemo(id), null, "an admin asked to stop it");
      assert.equal(await store.liveServeTarget(id), null);
      assert.notEqual(older.id, demo.id);
    });

    it("names the earlier of two open demos of one adapter, by the database's own clock, so only the later backs out", async () => {
      const adapter = "abababab-0000-4000-8000-000000000000";
      /** Sets a row's created_at to the microsecond, finer than a JS Date. */
      const createdAt = (id: string, at: string) => client.query("update training_jobs set created_at = $1::timestamptz where id = $2", [at, id]);
      const first = await serveJob(adapter, { status: "booting" });
      const second = await serveJob(adapter, { status: "queued" });
      // 12 microseconds apart: the same millisecond in JS, so only the database can tell them apart.
      await createdAt(first.id, "2026-10-28T12:00:00.123400Z");
      await createdAt(second.id, "2026-10-28T12:00:00.123412Z");
      assert.deepEqual(await store.earlierOpenServeJob(adapter, second.id), { id: first.id });
      assert.equal(await store.earlierOpenServeJob(adapter.toUpperCase(), first.id), null, "the first has none before it");

      // At the very same moment the smaller id is the earlier, so one of the two still wins.
      const tieA = await serveJob(adapter, { status: "queued" });
      const tieB = await serveJob(adapter, { status: "queued" });
      for (const row of [first, second, tieA, tieB]) await createdAt(row.id, "2026-10-28T12:00:00.123400Z");
      const [low, high] = [first.id, second.id, tieA.id, tieB.id].sort();
      assert.equal(await store.earlierOpenServeJob(adapter, low!), null);
      assert.deepEqual(await store.earlierOpenServeJob(adapter, high!), { id: low });

      // Only open demos of the same adapter count: not one that ended, one asked to stop, another adapter's, or a
      // training job.
      const lone = "cdcdcdcd-0000-4000-8000-000000000000";
      const ended = await serveJob(lone, { status: "failed", finishedAt: new Date() });
      const stopped = await serveJob(lone, { stopRequested: true });
      const otherAdapter = await serveJob("efefefef-0000-4000-8000-000000000000");
      const training = await lora({ status: "running", params: { adapterJobId: lone } as never });
      const mine = await serveJob(lone, { status: "queued" });
      for (const row of [ended, stopped, otherAdapter, training]) await createdAt(row.id, "2026-10-28T11:00:00Z");
      await createdAt(mine.id, "2026-10-28T12:00:00Z");
      assert.equal(await store.earlierOpenServeJob(lone, mine.id), null);
      assert.equal(await store.earlierOpenServeJob(lone, "not-a-uuid"), null);
      assert.equal(await store.earlierOpenServeJob("not-a-uuid", mine.id), null);
    });

    it("lets the proxy send a demo one prompt at a time, and frees a lost slot within two windows", async () => {
      const demo = await serveJob("aaaaaaaa-0000-4000-8000-000000000000");
      const t = new Date(Math.floor(Date.now() / store.DEMO_SLOT_MS) * store.DEMO_SLOT_MS + 1000);
      const slot = await store.takeDemoSlot(demo.id, t);
      assert.ok(slot instanceof Date);
      assert.equal(await store.takeDemoSlot(demo.id, t), null, "busy while one is answered");
      const [a, b] = await Promise.all([store.takeDemoSlot(demo.id, t), store.takeDemoSlot(demo.id, t)]);
      assert.deepEqual([a, b], [null, null]);
      await store.releaseDemoSlot(demo.id, slot!);
      const again = await store.takeDemoSlot(demo.id, t);
      assert.ok(again, "free once given back");

      // A call that never gave its slot back still holds the next window, and no longer the one after.
      assert.equal(await store.takeDemoSlot(demo.id, new Date(t.getTime() + store.DEMO_SLOT_MS)), null);
      assert.ok(await store.takeDemoSlot(demo.id, new Date(t.getTime() + 2 * store.DEMO_SLOT_MS)));
      const other = await serveJob("aaaaaaaa-0000-4000-8000-000000000000");
      assert.ok(await store.takeDemoSlot(other.id, t), "each demo has its own slot");
      assert.equal(await store.takeDemoSlot("not-a-uuid", t), null);
    });
  });
});
