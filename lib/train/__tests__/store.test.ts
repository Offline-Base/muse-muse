/**
 * The training store against a real Postgres: an in-memory PGlite with the repo's migrations, standing in for Neon.
 * Covers the SQL the safety checks lean on: which jobs count as holding a GPU, the daily cap's committed spend, the job
 * token check, that an ended job only changes through finishJob, the one launch claim per job, a late launch and an
 * outlived termination, and the sweep's heartbeat. Also eval items (one per index, a cap per job) and judgements, and
 * training datasets: appending answers only at the expected offset, the eval split, paging in SQL. Nothing here
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
      const ds = await store.createDataset({ title: "  Errors  ", task: " Explain Python errors. ", requested: 40 });
      assert.equal(ds.status, "generating");
      assert.equal(ds.title, "Errors");
      assert.equal(ds.task, "Explain Python errors.");
      assert.equal("train" in ds || "eval" in ds, false);
      const [listed] = await store.listDatasets();
      assert.equal(listed!.id, ds.id);
      assert.equal("train" in listed!, false);
      assert.equal((await store.getDataset(ds.id))!.requested, 40);
      assert.equal(await store.getDataset("not-a-uuid"), null);
    });

    it("appends answers only at the expected offset, so a retried chunk is never added twice", async () => {
      const ds = await store.createDataset({ title: "t", task: "task", requested: 40 });
      assert.equal(await store.appendTrainExamples(ds.id, 0, examples(0, 3)), 3);
      assert.equal(await store.appendTrainExamples(ds.id, 0, examples(0, 3)), 3, "the retry finds the chunk saved");
      assert.equal(await store.appendTrainExamples(ds.id, 3, examples(3, 2)), 5);
      assert.equal(await store.datasetProgress(ds.id), 5);
      await store.addDatasetCost(ds.id, 0.0012345);
      await store.addDatasetCost(ds.id, 0.001);
      assert.equal((await store.getDataset(ds.id))!.costUsd, 0.002235);
    });

    it("holds out the eval items, keeps the rest in order, and pages in SQL", async () => {
      const ds = await store.createDataset({ title: "t", task: "task", requested: 20 });
      await store.appendTrainExamples(ds.id, 0, examples(0, 20));
      assert.equal(await store.finishDataset(ds.id, 19), null, "refused when the count doesn't match");
      const done = await store.finishDataset(ds.id, 20);
      assert.equal(done!.status, "ready");
      assert.equal(done!.trainCount, 12);
      assert.equal(done!.evalCount, 8);
      assert.ok(done!.finishedAt);
      assert.equal(await store.finishDataset(ds.id, 20), null, "only once");
      assert.equal(await store.datasetProgress(ds.id), null, "no longer generating");
      assert.equal(await store.appendTrainExamples(ds.id, 20, examples(20, 1)), null);

      const evalPage = await store.datasetPage(ds.id, "eval", 0, 200);
      // evalIndexes(20) is [1, 3, 6, 8, 11, 13, 16, 18].
      assert.deepEqual(evalPage!.items, [1, 3, 6, 8, 11, 13, 16, 18].map((i) => ({ prompt: `q${i}`, reference: `a${i}` })));
      assert.equal(evalPage!.total, 8);
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

    it("fails only a dataset that is still generating", async () => {
      const ds = await store.createDataset({ title: "t", task: "task", requested: 20 });
      assert.equal(await store.failDataset(ds.id, "The spend cap was reached."), true);
      const failed = await store.getDataset(ds.id);
      assert.equal(failed!.status, "failed");
      assert.equal(failed!.error, "The spend cap was reached.");
      assert.ok(failed!.finishedAt);
      assert.equal(await store.failDataset(ds.id, "again"), false);
      assert.equal((await store.getDataset(ds.id))!.error, "The spend cap was reached.");
    });
  });
});
