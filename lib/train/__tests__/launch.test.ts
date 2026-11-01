/**
 * launchJob (lib/train/launch.ts), the launch checks POST /api/train/jobs moved out of the route, against a real Postgres
 * (an in-memory PGlite with the repo's migrations) with Lambda's listing faked and the workflow runtime recording what
 * it would start. The typed contract (launchJob) and the route's body form (launchJobRequest) give the same results,
 * a refusal is {ok: false, status, code, body?} exactly as the route answers it, a job is created by the caller and its
 * trainJob workflow started, and two launches past the cap at once leave one. Nothing reaches Neon or Lambda, and
 * nothing is spent. The route's own replies are pinned, unchanged, by routes.test.ts.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/launch.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const savedEnv = { ...process.env };
const DATASET_ID = "dddddddd-0000-4000-8000-0000000000aa";
const A100 = { name: "gpu_1x_a100_sxm4", description: "1x A100 SXM4 (40 GB)", priceCentsPerHour: 129, gpus: 1, regionsWithCapacity: ["us-east-1"] };

type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema> & {
  batch: (queries: PromiseLike<unknown>[]) => Promise<unknown[]>;
};

class FakeError extends Error {}
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
let launch: typeof import("@/lib/train/launch");
let store: typeof import("@/lib/train/store");
let jobsRoute: (req: Request) => Promise<Response>;
let started: Array<{ fn: string; args: unknown[] }> = [];
let startFails = false;
let capacity = true;
let admin = "";

describe("launchJob", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
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
    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    const realLambda = await import("@/lib/train/lambda");
    mock.module("workflow", { namedExports: { FatalError: FakeError, RetryableError: FakeError, sleep: async () => {} } });
    mock.module("workflow/api", {
      namedExports: {
        start: async (fn: { name: string }, args: unknown[]) => {
          started.push({ fn: fn.name, args });
          if (startFails) throw new Error("queue unavailable");
          return { runId: `wrun-${started.length}` };
        },
      },
    });
    mock.module(at("../lambda.ts"), {
      namedExports: {
        ...realLambda,
        listInstanceTypes: async () => [{ ...A100, regionsWithCapacity: capacity ? ["us-east-1"] : [] }],
        cacheRegions: async () => ["us-east-1"],
      },
    });
    mock.module(at("../workflow.ts"), { namedExports: { trainJob: async function trainJob() {} } });
    mock.module(at("../../auth.ts"), {
      namedExports: { AuthError: FakeAuthError, requireAdminOrAutomation: async () => ({ id: admin, email: "owner@example.com", isAdmin: true }) },
    });
    launch = await import("@/lib/train/launch");
    store = await import("@/lib/train/store");
    ({ POST: jobsRoute } = await import(at("../../../app/api/train/jobs/route.ts")));
    const [a] = await testDb.insert(realSchema.users).values({ email: "owner@example.com", isAdmin: true }).returning();
    admin = a!.id;
  });

  after(async () => {
    mock.restoreAll();
    process.env = savedEnv;
    await client?.close();
  });

  beforeEach(async () => {
    for (const table of [realSchema.trainingEvents, realSchema.trainingJobs, realSchema.trainingDatasets, realSchema.rateLimits]) await testDb.delete(table);
    Object.assign(process.env, {
      PLATFORM_URL: "https://muse.example.com",
      // Stand-ins, not real values: the gate only checks that they are set.
      LAMBDA_API_KEY: "test-value-not-a-key",
      CRON_SECRET: "test-cron",
      VERCEL_ENV: "production",
      TRAIN_MAX_ACTIVE: "1",
      TRAIN_DAILY_USD: "20",
      TRAIN_JOB_MAX_USD: "5",
    });
    started = [];
    startFails = false;
    capacity = true;
    await store.recordSweepOk(new Date());
    const train = Array.from({ length: 40 }, (_, i) => ({
      messages: [
        { role: "system" as const, content: "You are a made-up helper." },
        { role: "user" as const, content: `Made-up question ${i}?` },
        { role: "assistant" as const, content: "A made-up answer." },
      ],
    }));
    await testDb.insert(realSchema.trainingDatasets).values({
      id: DATASET_ID,
      title: "a made-up helper",
      task: "Answer made-up questions.",
      status: "ready",
      requested: 50,
      train,
      eval: Array.from({ length: 10 }, (_, i) => ({ prompt: `Kept ${i}?`, reference: "Made up." })),
      trainCount: 40,
      evalCount: 10,
      finishedAt: new Date(),
    });
  });

  const input = (over: Record<string, unknown> = {}) => ({
    recipe: "glimmer-lora" as const,
    params: { datasetId: DATASET_ID, maxSteps: 120, publish: 0 },
    instanceType: "gpu_1x_a100_sxm4",
    maxMinutes: 90,
    maxUsd: 5,
    ...over,
  });

  const viaRoute = async (body: Record<string, unknown>) => {
    const res = await jobsRoute(new Request("https://muse.example.com/api/train/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("creates the job for its caller and starts its trainJob workflow", async () => {
    const r = await launch.launchJob(input({ title: "  A made-up title  " }), { userId: admin });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.job.recipe, "glimmer-lora");
    assert.equal(r.job.title, "A made-up title");
    assert.equal(r.job.createdBy, admin);
    assert.deepEqual([r.job.instanceType, r.job.region, r.job.priceCentsPerHour, r.job.maxMinutes, r.job.maxUsd], ["gpu_1x_a100_sxm4", "us-east-1", 129, 90, 5]);
    assert.deepEqual(started, [{ fn: "trainJob", args: [{ jobId: r.job.id }] }]);
    assert.equal((await store.getJob(r.job.id))?.workflowRunId, "wrun-1");
  });

  it("refuses as the route answers: the status, the code or the 400's sentence, and the reply's extra fields", async () => {
    const cases: Array<[Record<string, unknown>, { status: number; code: string; body?: Record<string, unknown> }]> = [
      [{ recipe: "nope" }, { status: 400, code: "Pick a recipe." }],
      [{ title: 5 }, { status: 400, code: "title must be text." }],
      [{ instanceType: "gpu_8x_h100" }, { status: 400, code: "That GPU isn't one this recipe can use." }],
      [{ maxUsd: -1 }, { status: 400, code: "maxUsd must be a positive number." }],
      [{ params: { datasetId: "1b2c3d4e-0000-4000-8000-0000000000ff" } }, { status: 400, code: "Dataset: that dataset doesn't exist." }],
    ];
    for (const [over, want] of cases) {
      const r = await launch.launchJobRequest(input(over), { userId: admin });
      assert.deepEqual(r, { ok: false, ...want }, JSON.stringify(over));
      const res = await viaRoute(input(over));
      assert.deepEqual(res, { status: want.status, body: { error: want.code, ...(want.body ?? {}) } }, `the route: ${JSON.stringify(over)}`);
    }
    // A form's numeric string is a limit too.
    assert.equal((await launch.launchJobRequest(input({ maxMinutes: "60" }), { userId: admin })).ok, true);
    assert.equal(started.length, 1);
  });

  it("waits on the same gates: the sweep, the active jobs, the day's cap and Lambda's capacity", async () => {
    capacity = false;
    const busy = await launch.launchJob(input(), { userId: admin });
    assert.equal(!busy.ok && busy.code, "no_capacity");
    assert.equal(!busy.ok && busy.status, 503);
    assert.ok(!busy.ok && Array.isArray(busy.body?.options));
    capacity = true;
    assert.equal((await launch.launchJob(input(), { userId: admin })).ok, true);
    assert.deepEqual(await launch.launchJob(input(), { userId: admin }), { ok: false, status: 409, code: "too_many_active", body: { max: 1 } });
    process.env.TRAIN_MAX_ACTIVE = "4";
    process.env.TRAIN_DAILY_USD = "7";
    const cap = await launch.launchJob(input(), { userId: admin });
    assert.equal(!cap.ok && cap.code, "daily_cap");
    assert.deepEqual(!cap.ok && Object.keys(cap.body ?? {}).sort(), ["committedUsd", "dailyUsd", "jobMaxUsd", "spentUsd"]);
    await testDb.delete(realSchema.rateLimits);
    const sweep = await launch.launchJob(input(), { userId: admin });
    assert.equal(!sweep.ok && sweep.code, "sweep_not_running");
    delete process.env.LAMBDA_API_KEY;
    assert.deepEqual(await launch.launchJob(input(), { userId: admin }), { ok: false, status: 503, code: "lambda_not_configured" });
  });

  it("refuses a run its limits would cut off, before anything is created", async () => {
    const r = await launch.launchJob(input({ params: { datasetId: DATASET_ID, maxSteps: 2000 } }), { userId: admin });
    assert.equal(!r.ok && r.status, 400);
    assert.ok(!r.ok && typeof r.body?.estimateMinutes === "number" && typeof r.body?.usableMinutes === "number");
    assert.equal((await testDb.select().from(realSchema.trainingJobs)).length, 0);
  });

  it("fails the job and answers start_failed when its workflow can't start", async () => {
    startFails = true;
    assert.deepEqual(await launch.launchJob(input(), { userId: admin }), { ok: false, status: 500, code: "start_failed" });
    const [row] = await testDb.select().from(realSchema.trainingJobs);
    assert.equal(row!.status, "failed");
    assert.match(String(row!.error), /could not start/);
  });

  it("backs out the later of two launches that both passed the checks", async () => {
    process.env.TRAIN_MAX_ACTIVE = "1";
    const [a, b] = await Promise.all([launch.launchJob(input(), { userId: admin }), launch.launchJob(input(), { userId: admin })]);
    const oks = [a, b].filter((r) => r.ok).length;
    assert.ok(oks <= 1, "never two past TRAIN_MAX_ACTIVE");
    const open = (await testDb.select().from(realSchema.trainingJobs)).filter((j) => j.status !== "failed");
    assert.equal(open.length, oks);
  });
});
