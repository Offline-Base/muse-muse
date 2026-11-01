/**
 * Starting training for a run (docs/TRAINING.md "Fine-tune like a build", "Starting training") against a real Postgres:
 * an in-memory PGlite with the repo's migrations, the real store and the real launch checks (launchJob), with Lambda
 * faked (a listing whose capacity each test sets), the workflow runtime faked (start() records, sleep() moves a fake
 * clock) and Meta never called. Covers the examples check, launchForRun (the job it starts, the reasons it waits, a
 * refusal, a stopped run, the launch claim), the tuneRun workflow run as a plain function, POST /api/train/runs/{id}/start
 * and startTuneRun for a dataset that already exists. Nothing here reaches Neon, Lambda or Meta, and nothing is spent.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/tune/__tests__/run-flow.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const savedEnv = { ...process.env };
const GPU_A100 = { name: "gpu_1x_a100_sxm4", description: "1x A100 SXM4 (40 GB)", priceCentsPerHour: 129, gpus: 1, regionsWithCapacity: ["us-east-1"] };

type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema> & {
  batch: (queries: PromiseLike<unknown>[]) => Promise<unknown[]>;
};

class FakeFatalError extends Error {}
class FakeRetryableError extends Error {
  constructor(
    message: string,
    readonly options?: { retryAfter?: unknown },
  ) {
    super(message);
  }
}
class FakeAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

let client: import("@electric-sql/pglite").PGlite;
let testDb: TestDb;
let store: typeof import("@/lib/train/store");
let runStore: typeof import("@/lib/train/tune/run-store");
let tuneStore: typeof import("@/lib/train/tune/store");
let launch: typeof import("@/lib/train/tune/run-launch");
let wf: typeof import("@/lib/train/tune/run");
let start: typeof import("@/lib/train/tune/start");
let startRoute: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

/** What Lambda lists: each call takes the next, and the last repeats. */
let listings: Array<Array<typeof GPU_A100>> = [[GPU_A100]];
let paused = false;
let started: Array<{ fn: string; args: unknown[] }> = [];
let sleeps: number[] = [];
/** Runs on each fake sleep, before the clock moves: a test's way to change the world while the workflow waits. */
let onSleep: (n: number) => Promise<void> = async () => {};
let advanced = 0;
let caller: { id: string; email: string; isAdmin: boolean } | null = null;
let admin = "";
let visitor = "";

const CEILINGS = { maxMinutes: 120, maxUsd: 5 };

describe("starting training for a run", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
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
    await migrate(local, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    testDb = local;

    mock.module(at("../../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    const realLambda = await import("@/lib/train/lambda");
    const realQuota = await import("@/lib/quota");
    mock.module("workflow", {
      namedExports: {
        FatalError: FakeFatalError,
        RetryableError: FakeRetryableError,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          await onSleep(sleeps.length);
          advanced += ms;
        },
      },
    });
    mock.module("workflow/api", {
      namedExports: {
        start: async (fn: { name: string }, args: unknown[]) => {
          started.push({ fn: fn.name, args });
          return { runId: `wrun-${started.length}` };
        },
      },
    });
    mock.module(at("../../../auth.ts"), {
      namedExports: {
        AuthError: FakeAuthError,
        requireAdminOrAutomation: async () => {
          if (!caller) throw new FakeAuthError("Admins only.", 403);
          return caller;
        },
      },
    });
    mock.module(at("../../../quota.ts"), { namedExports: { ...realQuota, spendPaused: async () => paused } });
    mock.module(at("../../lambda.ts"), {
      namedExports: {
        ...realLambda,
        listInstanceTypes: async () => (listings.length > 1 ? listings.shift()! : listings[0]!),
        cacheRegions: async () => ["us-east-1"],
      },
    });
    // The training job's own workflow is started, never run, here (lib/train/__tests__ covers it).
    mock.module(at("../../workflow.ts"), { namedExports: { trainJob: async function trainJob() {} } });
    mock.module(at("../../datasets.ts"), { namedExports: { DATASET_MODEL: "muse-wonder-1.0", makeDataset: async function makeDataset() {} } });

    store = await import("@/lib/train/store");
    runStore = await import("@/lib/train/tune/run-store");
    tuneStore = await import("@/lib/train/tune/store");
    launch = await import("@/lib/train/tune/run-launch");
    wf = await import("@/lib/train/tune/run");
    start = await import("@/lib/train/tune/start");
    ({ POST: startRoute } = await import(at("../../../../app/api/train/runs/[id]/start/route.ts")));

    const [a] = await testDb.insert(realSchema.users).values({ email: "owner@example.com", isAdmin: true }).returning();
    const [v] = await testDb.insert(realSchema.users).values({ email: "visitor@example.com", isAdmin: false }).returning();
    admin = a!.id;
    visitor = v!.id;
  });

  after(async () => {
    mock.restoreAll();
    process.env = savedEnv;
    await client?.close();
  });

  beforeEach(async () => {
    for (const table of [realSchema.trainingEvents, realSchema.trainingJobs, realSchema.trainingDatasets, realSchema.rateLimits]) {
      await testDb.delete(table);
    }
    Object.assign(process.env, {
      TUNE_COMPOSER: "1",
      PLATFORM_URL: "https://muse.example.com",
      // Stand-ins, not real values: the gate only checks that they are set.
      LAMBDA_API_KEY: "test-value-not-a-key",
      CRON_SECRET: "test-cron",
      VERCEL_ENV: "production",
      TRAIN_MAX_ACTIVE: "1",
      TRAIN_DAILY_USD: "20",
      TRAIN_JOB_MAX_USD: "5",
      TRAIN_JOB_MAX_MINUTES: "120",
    });
    listings = [[GPU_A100]];
    paused = false;
    started = [];
    sleeps = [];
    onSleep = async () => {};
    advanced = 0;
    caller = { id: admin, email: "owner@example.com", isAdmin: true };
    // The 5-minute sweep ran just now, so the launch gate is open.
    await store.recordSweepOk(new Date());
  });

  /** A chat dataset with `train` and `evalN` made-up examples, each `chars` long, ready unless said otherwise. */
  async function dataset(o: { train?: number; evalN?: number; chars?: number; status?: "ready" | "generating" | "failed"; kind?: "chat" | "decision"; createdBy?: string } = {}) {
    const n = o.train ?? 40;
    const evalN = o.evalN ?? 10;
    const filler = "x".repeat(Math.max(0, (o.chars ?? 60) - 20));
    const row = await store.createDataset({
      title: "a made-up bakery's counter helper",
      task: "Answer questions for a made-up bakery.",
      requested: n + evalN,
      writerModel: "muse-spark-1.3-contributor",
      createdBy: o.createdBy ?? admin,
    });
    const train = Array.from({ length: n }, (_, i) => ({
      messages: [
        { role: "system" as const, content: "You are a made-up bakery's counter helper." },
        { role: "user" as const, content: `Open on day ${i}?` },
        { role: "assistant" as const, content: `Yes, 8 to 2. ${filler}` },
      ],
    }));
    const evalItems = Array.from({ length: evalN }, (_, i) => ({ prompt: `Cakes ${i}?`, reference: "Order a day ahead." }));
    const status = o.status ?? "ready";
    await testDb
      .update(realSchema.trainingDatasets)
      .set({
        status,
        kind: o.kind ?? "chat",
        train: status === "generating" ? [] : train,
        eval: status === "generating" ? [] : evalItems,
        trainCount: status === "generating" ? 0 : n,
        evalCount: status === "generating" ? 0 : evalN,
        finishedAt: status === "generating" ? null : new Date(),
      })
      .where(eq(realSchema.trainingDatasets.id, row.id));
    return row.id;
  }

  const jobsOf = (datasetId: string) =>
    testDb.select().from(realSchema.trainingJobs).then((rows) => rows.filter((r) => (r.params as Record<string, unknown>).datasetId === datasetId));
  const startReq = (id: string) => new Request(`https://muse.example.com/api/train/runs/${id}/start`, { method: "POST", body: "{}" });
  const post = async (id: string) => {
    const res = await startRoute(startReq(id), { params: Promise.resolve({ id }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  describe("the examples check", () => {
    it("passes enough short chat examples, and says why it can't train the rest", async () => {
      assert.deepEqual(await launch.checkExamples(await dataset()), { ok: true, train: 40, eval: 10 });
      assert.deepEqual(await launch.checkExamples(await dataset({ train: 10 })), { ok: false, code: "too_few" });
      assert.deepEqual(await launch.checkExamples(await dataset({ evalN: 4 })), { ok: false, code: "too_few" });
      assert.deepEqual(await launch.checkExamples(await dataset({ kind: "decision" })), { ok: false, code: "decision" });
      assert.deepEqual(await launch.checkExamples(await dataset({ chars: 9000 })), { ok: false, code: "too_long" }, "over 2,048 tokens each");
      assert.deepEqual(await launch.checkExamples(await dataset({ status: "generating" })), { ok: false, code: "not_ready" });
      assert.deepEqual(await launch.checkExamples("1b2c3d4e-0000-4000-8000-0000000000ff"), { ok: false, code: "missing" });
    });
  });

  describe("launchForRun", () => {
    it("starts one Muse Glimmer LoRA job with the run's settings and publish 0, through launchJob", async () => {
      const id = await dataset();
      const r = await launch.launchForRun({ datasetId: id, callerId: admin, steps: 300 });
      assert.equal(r.kind, "launched");
      const [job, ...more] = await jobsOf(id);
      assert.equal(more.length, 0);
      assert.equal(job!.recipe, "glimmer-lora");
      assert.equal(job!.title, "a made-up bakery's counter helper");
      assert.deepEqual(job!.params, { datasetId: id, dryRun: 0, maxSteps: 300, loraRank: 16, learningRate: 0.0002, studentPrompt: "short", publish: 0 });
      assert.deepEqual([job!.instanceType, job!.region, job!.maxMinutes, job!.maxUsd, job!.createdBy], ["gpu_1x_a100_sxm4", "us-east-1", 90, 5, admin]);
      assert.deepEqual(started.map((s) => s.fn), ["trainJob"], "the job's own workflow");
      assert.equal(job!.workflowRunId, "wrun-1");

      // Asked again (the workflow's next try, or Start training), it is the same job, never a second.
      const again = await launch.launchForRun({ datasetId: id, callerId: admin, steps: 300 });
      assert.deepEqual(again, { kind: "launched", jobId: job!.id, already: true });
      assert.equal((await jobsOf(id)).length, 1);
      // The claim was given back.
      assert.ok(await runStore.takeLaunchClaim(id));
    });

    it("waits, with the reason as the heartbeat, while no GPU is free, the GPU is in use, the day's cap or the sweep say no, or Meta is paused", async () => {
      const id = await dataset();
      listings = [[{ ...GPU_A100, regionsWithCapacity: [] }]];
      let r = await launch.launchForRun({ datasetId: id, callerId: admin, steps: 120 });
      assert.equal(r.kind === "wait" && r.reason, "gpu_busy");
      assert.equal(r.kind === "wait" && r.refusal?.code, "no_capacity");
      let run = await tuneStore.loadTuneRun(id, new Date(), CEILINGS);
      assert.equal(run?.stage, "waiting");
      assert.equal(run?.hold?.reason, "gpu_busy");
      assert.match(run!.hold!.text, /No Muse Glimmer GPU is free/);
      assert.equal(run?.next?.kind, "start");

      listings = [[GPU_A100]];
      const other = await dataset();
      assert.equal((await launch.launchForRun({ datasetId: other, callerId: admin, steps: 120 })).kind, "launched");
      r = await launch.launchForRun({ datasetId: id, callerId: admin, steps: 120 });
      assert.equal(r.kind === "wait" && r.reason, "too_many_active", "TRAIN_MAX_ACTIVE is 1 and the other run's job holds it");

      process.env.TRAIN_MAX_ACTIVE = "3";
      process.env.TRAIN_DAILY_USD = "6";
      r = await launch.launchForRun({ datasetId: id, callerId: admin, steps: 120 });
      assert.equal(r.kind === "wait" && r.reason, "daily_cap", "$5 committed plus this run's $5 is past $6");

      process.env.TRAIN_DAILY_USD = "20";
      await testDb.delete(realSchema.rateLimits).where(eq(realSchema.rateLimits.key, "train-sweep-ok"));
      r = await launch.launchForRun({ datasetId: id, callerId: admin, steps: 120 });
      assert.equal(r.kind === "wait" && r.reason, "sweep_not_running");

      paused = true;
      r = await launch.launchForRun({ datasetId: id, callerId: admin, steps: 120 });
      assert.equal(r.kind === "wait" && r.reason, "paused");
      assert.equal((await jobsOf(id)).length, 0, "nothing was launched for it");

      run = await tuneStore.loadTuneRun(id, new Date(), CEILINGS);
      assert.equal(run?.hold?.reason, "paused", "the newest reason");
    });

    it("refuses what won't pass on its own, and the room says why with Start training", async () => {
      const id = await dataset();
      delete process.env.LAMBDA_API_KEY;
      const r = await launch.launchForRun({ datasetId: id, callerId: admin, steps: 120 });
      assert.deepEqual(r, { kind: "refused", refusal: { ok: false, status: 503, code: "lambda_not_configured" } });
      const run = await tuneStore.loadTuneRun(id, new Date(), CEILINGS);
      assert.equal(run?.stage, "waiting");
      assert.equal(run?.hold?.reason, "not_started");
      assert.equal(run?.hold?.text, "Training didn't start: Lambda isn't connected on this deployment. Start training tries again.");
    });

    it("never launches for a stopped run, and waits while another launcher holds the claim", async () => {
      const stopped = await dataset();
      await runStore.markRunStopped(stopped);
      assert.deepEqual(await launch.launchForRun({ datasetId: stopped, callerId: admin, steps: 120 }), { kind: "stopped" });
      assert.equal((await tuneStore.loadTuneRun(stopped, new Date(), CEILINGS))?.stage, "stopped");

      const held = await dataset();
      assert.ok(await runStore.takeLaunchClaim(held));
      const r = await launch.launchForRun({ datasetId: held, callerId: admin, steps: 120 });
      assert.equal(r.kind === "wait" && r.reason, "launching");
      assert.equal((await jobsOf(held)).length + (await jobsOf(stopped)).length, 0);
      assert.equal(await runStore.takeLaunchClaim(held, new Date(Date.now() + 10 * 60_000)) !== null, true, "a claim nobody gave back lapses");
    });

    it("keeps the run's steps, its ending and its stop under a window the hourly prune never reaches", async () => {
      const id = await dataset();
      await runStore.saveRunSteps(id, 250);
      await runStore.saveRunSteps(id, 260);
      await runStore.recordRunEnded(id, "waited_gpu_busy");
      await runStore.recordRunEnded(id, "Dataset: a sentence, not a code.");
      const marks = await runStore.readRunMarks(id);
      assert.equal(marks.steps, 260);
      assert.equal(marks.ended, "refused", "one ending, the latest, as a code");
      const { deleteRateLimitsBefore } = await import("@/lib/gateway/store");
      await deleteRateLimitsBefore(new Date());
      assert.equal((await runStore.readRunMarks(id)).steps, 260);
      await runStore.clearRunEnded(id);
      assert.equal((await runStore.readRunMarks(id)).ended, null);
    });
  });

  describe("the tuneRun workflow", () => {
    let realNow: () => number;
    before(() => {
      realNow = Date.now.bind(Date);
      mock.method(Date, "now", () => realNow() + advanced);
    });
    after(() => (Date.now as unknown as { mock?: { restore(): void } }).mock?.restore());

    it("waits for the examples, checks them, waits for a GPU, then launches once", async () => {
      const id = await dataset({ status: "generating" });
      listings = [[{ ...GPU_A100, regionsWithCapacity: [] }], [{ ...GPU_A100, regionsWithCapacity: [] }], [GPU_A100]];
      onSleep = async (n) => {
        if (n === 2) {
          await testDb
            .update(realSchema.trainingDatasets)
            .set({ status: "ready" })
            .where(eq(realSchema.trainingDatasets.id, id));
          await dataset().then(async (filled) => {
            // Copy a filled dataset's rows onto this one: the examples are now written.
            const [src] = await testDb.select().from(realSchema.trainingDatasets).where(eq(realSchema.trainingDatasets.id, filled));
            await testDb
              .update(realSchema.trainingDatasets)
              .set({ train: src!.train, eval: src!.eval, trainCount: src!.trainCount, evalCount: src!.evalCount, finishedAt: new Date() })
              .where(eq(realSchema.trainingDatasets.id, id));
            await testDb.delete(realSchema.trainingDatasets).where(eq(realSchema.trainingDatasets.id, filled));
          });
        }
      };
      const result = await wf.tuneRun({ datasetId: id, callerId: admin, steps: 200 });
      const [job, ...more] = await jobsOf(id);
      assert.deepEqual(result, { status: "launched", jobId: job!.id });
      assert.equal(more.length, 0);
      assert.equal((job!.params as { maxSteps: number }).maxSteps, 200);
      assert.equal((job!.params as { publish: number }).publish, 0);
      assert.deepEqual(sleeps, [30_000, 30_000, 5 * 60_000, 5 * 60_000], "the dataset every 30 s, then the launch every 5 minutes");
      const beats = await testDb.select().from(realSchema.rateLimits);
      assert.ok(beats.some((b) => b.key === `tune-run:${id}:checking`));
      assert.ok(beats.some((b) => b.key === `tune-run:${id}:gpu_busy`));
    });

    it("gives up after 2 hours of waiting, and says why", async () => {
      const id = await dataset();
      listings = [[{ ...GPU_A100, regionsWithCapacity: [] }]];
      const result = await wf.tuneRun({ datasetId: id, callerId: admin, steps: 120 });
      assert.deepEqual(result, { status: "gave_up" });
      assert.equal(sleeps.length, 23, "tried at 0, 5, ..., 115 minutes: 24 tries, 23 waits");
      assert.equal((await jobsOf(id)).length, 0);
      assert.equal((await runStore.readRunMarks(id)).ended, "waited_gpu_busy");
    });

    it("never launches for a run stopped while it waited, and fails a run whose examples fail the check", async () => {
      const id = await dataset();
      listings = [[{ ...GPU_A100, regionsWithCapacity: [] }]];
      onSleep = async (n) => {
        if (n === 1) await runStore.markRunStopped(id);
      };
      assert.deepEqual(await wf.tuneRun({ datasetId: id, callerId: admin, steps: 120 }), { status: "stopped" });
      assert.equal((await jobsOf(id)).length, 0);

      const short = await dataset({ train: 8 });
      sleeps = [];
      assert.deepEqual(await wf.tuneRun({ datasetId: short, callerId: admin, steps: 120 }), { status: "failed" });
      assert.deepEqual(sleeps, [], "no launch tried");
      assert.equal((await runStore.readRunMarks(short)).ended, "too_few");
      assert.equal((await tuneStore.loadTuneRun(short, new Date(), CEILINGS))?.stage, "failed");

      const gone = await dataset({ status: "failed" });
      assert.deepEqual(await wf.tuneRun({ datasetId: gone, callerId: admin, steps: 120 }), { status: "failed" });
    });

    it("ends on a refusal without trying again", async () => {
      const id = await dataset();
      delete process.env.CRON_SECRET;
      assert.deepEqual(await wf.tuneRun({ datasetId: id, callerId: admin, steps: 120 }), { status: "refused" });
      assert.equal((await runStore.readRunMarks(id)).ended, "sweep_not_configured");
      assert.deepEqual(sleeps, []);
    });
  });

  describe("POST /api/train/runs/{id}/start", () => {
    it("starts training now: 201 with the job's page, then 409 already_training", async () => {
      const id = await dataset();
      await runStore.saveRunSteps(id, 240);
      const first = await post(id);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const [job] = await jobsOf(id);
      assert.deepEqual(first.body, { jobId: job!.id, href: `/fine-tuning/${job!.id}` });
      assert.equal((job!.params as { maxSteps: number }).maxSteps, 240, "the steps the run was started with");
      const again = await post(id);
      assert.deepEqual(again, { status: 409, body: { error: "already_training", jobId: job!.id, href: `/fine-tuning/${job!.id}` } });
      assert.equal((await tuneStore.loadTuneRun(id, new Date(), CEILINGS))?.stage, "training");
    });

    it("answers 202 with why it waits, and starts the tuneRun workflow unless one is already trying", async () => {
      const id = await dataset();
      listings = [[{ ...GPU_A100, regionsWithCapacity: [] }]];
      const res = await post(id);
      assert.equal(res.status, 202);
      assert.equal((res.body.hold as { reason: string }).reason, "gpu_busy");
      assert.deepEqual(started, [{ fn: "tuneRun", args: [{ datasetId: id, callerId: admin, steps: 120 }] }]);
      // Now the workflow's heartbeat is fresh, so a second press only asks again.
      started = [];
      assert.equal((await post(id)).status, 202);
      assert.deepEqual(started, []);
    });

    it("refuses what it can't train, a stopped run, examples still being written, another person's run, and with the flag off", async () => {
      assert.deepEqual((await post(await dataset({ train: 8 }))).body, {
        error: "too_few",
        reason: "There weren't enough examples to train on and to score with, so training didn't start.",
      });
      const stopped = await dataset();
      await runStore.markRunStopped(stopped);
      assert.deepEqual(await post(stopped), { status: 409, body: { error: "stopped" } });
      assert.deepEqual(await post(await dataset({ status: "generating" })), { status: 409, body: { error: "not_ready" } });
      assert.equal((await post("1b2c3d4e-0000-4000-8000-0000000000ff")).status, 404);

      const theirs = await dataset();
      caller = { id: visitor, email: "visitor@example.com", isAdmin: false };
      assert.deepEqual(await post(theirs), { status: 403, body: { error: "forbidden" } });
      caller = null;
      assert.equal((await post(theirs)).status, 403);
      caller = { id: admin, email: "owner@example.com", isAdmin: true };
      process.env.TUNE_COMPOSER = "0";
      assert.deepEqual(await post(theirs), { status: 404, body: { error: "not_found" } });
      assert.equal((await jobsOf(theirs)).length, 0);
    });

    it("answers launchJob's own refusal, and keeps it for the room", async () => {
      const id = await dataset();
      delete process.env.LAMBDA_API_KEY;
      assert.deepEqual(await post(id), { status: 503, body: { error: "lambda_not_configured" } });
      assert.equal((await runStore.readRunMarks(id)).ended, "lambda_not_configured");
    });
  });

  describe("startTuneRun", () => {
    it("starts tuneRun for a ready dataset that has no job and nothing trying it, and nothing for one that does", async () => {
      const id = await dataset();
      assert.deepEqual(await start.startTuneRun({ datasetId: id, callerId: admin }), { runId: id, href: `/fine-tuning/runs/${id}` });
      assert.deepEqual(started, [{ fn: "tuneRun", args: [{ datasetId: id, callerId: admin, steps: 120 }] }]);

      started = [];
      await launch.launchForRun({ datasetId: id, callerId: admin, steps: 120 });
      started = [];
      await start.startTuneRun({ datasetId: id, callerId: admin });
      assert.deepEqual(started, [], "it has a job");

      const decision = await dataset({ kind: "decision" });
      await start.startTuneRun({ datasetId: decision, callerId: admin });
      assert.deepEqual(started, [], "decision rows train from the full form");
    });
  });
});
