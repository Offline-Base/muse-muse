/**
 * Publishing to the Hugging Face Hub end to end, with nothing real but the code under test: the store on an in-memory
 * PGlite with the repo's migrations, a fake Hub on localhost (fake-hub.ts) through HF_ENDPOINT, the real hub and publish
 * routes, the real steps and publishToHub, Muse Wonder (the story) and Lambda's capacity faked, and a fake GPU in
 * TypeScript doing what runner.py's hub_upload does (a plan, the bytes straight to the presigned URLs with no
 * credential, a report).
 *
 * POST /api/train/jobs/{id}/hub: the job token (and only that job's), a glimmer-publish job acting for its adapter job
 * only, the skip reasons, the size limits (a plan replaces the one before, so they hold for the job's state too), the
 * exact names published and the configs checked, small files committed by the platform and the rest planned through
 * the LFS bridge, presigned URLs never stored or logged, a Hub refusal saved and not tried again, and the report (only
 * from a running GPU, while its plan uploads). Publishing: under one claim per run, the dataset repo and the model repo
 * made private, committed, read back, then the dataset card and the visibility HF_PUBLIC asks for (put back when a
 * part fails, and saved as the Hub reports it), the cards and the run's record (the dataset and the judging, which
 * have no model on their records, credited to Muse Spark 1.3), the story from Muse Wonder (saved as its storyModel) or
 * the template, a second publish that commits only what changed, a shared dataset card that lists every public model and
 * never changes for a job that fails, an LFS object the Hub lost failing it, and POST .../publish (a why that clears,
 * one upload job for two presses, a Hub that refuses before any GPU) starting a glimmer-publish job through POST
 * /api/train/jobs, whose own upload and success publish the adapter. Nothing here reaches Neon, Lambda, Meta or the
 * real Hub.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/hub-flow.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import type { HubState, TrainEventBody } from "../types";
import { gitOidOf, startFakeHub, type FakeHub } from "./fake-hub";

/** Test values, not real secrets. */
const HF_TOKEN = "hf_test_publish_token_00000000000000";
const TOKEN = "job-token-of-the-adapter-job";
const PUBLISH_TOKEN = "job-token-of-the-publish-job";
const MB = 1024 * 1024;
const canMock = typeof (mock as { module?: unknown }).module === "function";
const savedEnv = { ...process.env };

type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema> & {
  batch: (queries: PromiseLike<unknown>[]) => Promise<unknown[]>;
};
type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;

class FakeFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalError";
  }
}
class FakeRetryableError extends Error {
  constructor(
    message: string,
    readonly options?: { retryAfter?: unknown },
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

let client: import("@electric-sql/pglite").PGlite;
let testDb: TestDb;
let fake: FakeHub;
let hubRoute: Handler;
let publishPost: Handler;
let publishGet: Handler;
let store: typeof import("../store");
let steps: typeof import("../hub-steps");
let wf: typeof import("../workflow");
let hashToken: (t: string) => string;
let started: Array<{ fn: string; args: unknown[] }> = [];
/** What the fake Muse Wonder answers for the story, or an error it throws. */
let storyReply: string | Error = "";
/** The status the fake Muse Wonder answers with: "incomplete" is a call that ran out of its output budget. */
let storyStatus: "completed" | "incomplete" = "completed";
let storyCalls = 0;
/** The model each story call asked for. */
let storyModels: string[] = [];
let paused = false;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function bytes(n: number, seed: number): Buffer {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = (i * 7 + seed * 13) % 256;
  return out;
}

/** The adapter folder a glimmer-lora run saves, roughly: weights and a sentencepiece model in LFS, configs inline. */
function adapterFolder(seed = 1): Map<string, Buffer> {
  return new Map([
    ["adapter_model.safetensors", bytes(200 * 1024, seed)],
    ["tokenizer.model", bytes(20 * 1024, seed + 1)],
    ["adapter_config.json", Buffer.from(JSON.stringify({ base_model_name_or_path: "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit", r: 16, revision: "ecedda395d4d099b477d135a9a573eedaa5a7aad" }, null, 2))],
    ["tokenizer_config.json", Buffer.from(JSON.stringify({ bos_token: "<|begin_of_text|>" }))],
    ["chat_template.jinja", Buffer.from("{{ bos_token }}{% for m in messages %}{{ m.content }}{% endfor %}")],
    ["README.md", Buffer.from("# PEFT's own card, which the platform replaces")],
  ]);
}
const SMALL = ["adapter_config.json", "tokenizer_config.json", "chat_template.jinja"];

function hubReq(jobId: string, token: string | null, body: unknown): [Request, Ctx] {
  return [
    new Request(`https://muse.example.com/api/train/jobs/${jobId}/hub`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: jobId }) },
  ];
}

function planBody(folder: Map<string, Buffer>, small = SMALL) {
  return {
    action: "plan",
    files: [...folder].map(([path, b]) => ({ path, size: b.length, sha256: sha(b), sample: b.subarray(0, 512).toString("base64") })),
    small: Object.fromEntries(small.filter((n) => folder.has(n)).map((n) => [n, folder.get(n)!.toString("base64")])),
  };
}

/**
 * What runner.py's hub_upload does, against the real route and the fake Hub's storage: the plan, each upload with no
 * credential (a multipart one part by part, then its completion), then the report. Returns the plan's answer.
 */
async function gpuUpload(jobId: string, token: string, folder: Map<string, Buffer>): Promise<{ status: number; plan: Record<string, unknown>; done?: number }> {
  const res = await hubRoute(...hubReq(jobId, token, planBody(folder)));
  const plan = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200 || plan.skip) return { status: res.status, plan };
  const uploaded: Array<{ path: string; oid: string; size: number }> = [];
  for (const u of plan.uploads as Array<Record<string, unknown>>) {
    const data = folder.get(String(u.path))!;
    if (u.transfer === "basic") {
      const put = await fetch(String(u.href), { method: "PUT", body: data as unknown as BodyInit, headers: u.header as Record<string, string> });
      assert.equal(put.status, 200);
    } else if (u.transfer === "multipart") {
      const chunk = Number(u.chunkSize);
      const etags: Array<{ partNumber: number; etag: string }> = [];
      for (const p of u.parts as Array<{ partNumber: number; url: string }>) {
        const put = await fetch(p.url, { method: "PUT", body: data.subarray((p.partNumber - 1) * chunk, p.partNumber * chunk) as unknown as BodyInit });
        assert.equal(put.status, 200);
        etags.push({ partNumber: p.partNumber, etag: put.headers.get("etag")! });
      }
      const done = await fetch(String(u.completionUrl), {
        method: "POST",
        headers: { accept: "application/vnd.git-lfs+json", "content-type": "application/vnd.git-lfs+json" },
        body: JSON.stringify({ oid: u.oid, parts: etags }),
      });
      assert.equal(done.status, 200);
    }
    uploaded.push({ path: String(u.path), oid: String(u.oid), size: Number(u.size) });
  }
  const done = await hubRoute(...hubReq(jobId, token, { action: "done", uploaded, failed: [] }));
  return { status: res.status, plan, done: done.status };
}

const DATASET_ID = "1b2c3d4e-0000-4000-8000-000000000002";
const SYSTEM = "You are an assistant for this task: Write a short app brief.\n\nAnswer the user's message directly and well.";

async function makeDataset(): Promise<void> {
  const train = Array.from({ length: 12 }, (_, i) => ({
    messages: [
      { role: "system" as const, content: SYSTEM },
      { role: "user" as const, content: `App idea ${i}: count birds` },
      { role: "assistant" as const, content: `**Name:** Bird Counter ${i}` },
    ],
  }));
  const evalItems = Array.from({ length: 2 }, (_, i) => ({ prompt: `Held out ${i}`, reference: `Reference ${i}` }));
  await testDb.insert(realSchema.trainingDatasets).values({
    id: DATASET_ID,
    title: "Muse Muse's brief writer",
    task: "Write a short app brief: name, tagline, flow, models, limits and the cost per run.",
    status: "ready",
    requested: 14,
    train,
    eval: evalItems,
    trainCount: 12,
    evalCount: 2,
    costUsd: 0.05,
    finishedAt: new Date(),
  });
}

/** A glimmer-lora job that is training (its GPU will plan an upload), with the job token TOKEN. */
async function makeJob(over: Partial<typeof realSchema.trainingJobs.$inferInsert> = {}): Promise<string> {
  const row = await store.createJob({
    recipe: "glimmer-lora",
    title: "Brief writer LoRA",
    params: { datasetId: DATASET_ID, maxSteps: 120, learningRate: 0.0002, loraRank: 16, studentPrompt: "short", dryRun: 0, publish: 1 },
    instanceType: "gpu_1x_a100_sxm4",
    region: "us-east-1",
    priceCentsPerHour: 199,
    maxMinutes: 150,
    maxUsd: 8,
  });
  await testDb
    .update(realSchema.trainingJobs)
    .set({ status: "running", tokenHash: hashToken(TOKEN), launchedAt: new Date(Date.now() - 40 * 60_000), ...over })
    .where(eq(realSchema.trainingJobs.id, row.id));
  return row.id;
}

/**
 * The job as judging leaves it: succeeded, its GPU shut down, its eval items judged and its done metrics logged (with
 * `metrics` over the usual ones).
 */
async function judged(jobId: string, metrics: Record<string, string | number> = {}): Promise<void> {
  const log = (payload: TrainEventBody) => testDb.insert(realSchema.trainingEvents).values({ jobId, type: payload.type, payload });
  await log({ type: "eval", index: 0, prompt: "Held out 0", reference: "Reference 0", base: "I can't.", tuned: "**Name:** Pier Gull Counter" });
  await log({ type: "eval", index: 1, prompt: "Held out 1", reference: "Reference 1", base: "Maybe.", tuned: "**Name:** Bakery Board" });
  await log({ type: "judgement", index: 0, baseScore: 2, tunedScore: 9, better: "tuned", note: "Full brief; the other refuses." });
  await log({ type: "judgement", index: 1, baseScore: 3, tunedScore: 8, better: "tuned", note: "Names the models." });
  await log({
    type: "done",
    summary: "LoRA r=16",
    metrics: {
      train_loss_final: 0.5188,
      steps: 120,
      max_steps: 120,
      student_system: "You are Muse Muse's brief writer.",
      gpu: "NVIDIA A100-SXM4-40GB",
      cache_used: "yes",
      adapter_dir: `/lambda/nfs/muse-muse-cache-us-east-1/models/${jobId}`,
      train_examples: 12,
      ...metrics,
    },
  });
  await testDb
    .update(realSchema.trainingJobs)
    .set({
      status: "succeeded",
      finishedAt: new Date(),
      terminatedAt: new Date(),
      costUsd: 1.39,
      evalSummary: { items: 2, tunedWins: 2, baseWins: 0, ties: 0, avgBaseScore: 2.5, avgTunedScore: 8.5, judgeCostUsd: 0.01 },
    })
    .where(eq(realSchema.trainingJobs.id, jobId));
}

const hubOf = async (jobId: string): Promise<HubState | null> => (await store.getJob(jobId))?.hub ?? null;
const logOf = async (jobId: string) =>
  (await store.listEvents(jobId)).filter((e) => e.payload.type === "log").map((e) => (e.payload as { text: string }).text);

describe("publishing to the Hugging Face Hub", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
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
    fake = await startFakeHub({ token: HF_TOKEN, multipartOver: 64 * 1024, chunkSize: 48 * 1024 });

    const at = (rel: string) => new URL(rel, import.meta.url).href;
    // The database first, so the real modules loaded below for their other exports use it too.
    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    const realLambda = await import("../lambda");
    const realAuth = await import("../../auth");
    const realQuota = await import("../../quota");
    mock.module("workflow", { namedExports: { FatalError: FakeFatalError, RetryableError: FakeRetryableError, sleep: async () => {} } });
    mock.module("workflow/api", {
      namedExports: {
        start: async (fn: { name: string }, args: unknown[]) => {
          started.push({ fn: fn.name, args });
          return { runId: `run-${started.length}` };
        },
      },
    });
    mock.module(at("../../auth.ts"), {
      namedExports: { ...realAuth, requireAdminOrAutomation: async () => ({ id: (await adminId()), email: "owner@example.com", isAdmin: true }) },
    });
    mock.module(at("../../quota.ts"), { namedExports: { ...realQuota, spendPaused: async () => paused } });
    mock.module(at("../lambda.ts"), {
      namedExports: {
        ...realLambda,
        listInstanceTypes: async () => [
          { name: "gpu_1x_rtx6000", description: "1x RTX 6000 (24 GB)", priceCentsPerHour: 50, gpus: 1, regionsWithCapacity: ["us-east-1"] },
        ],
        cacheRegions: async () => ["us-east-1"],
      },
    });
    mock.module(at("../../meta/platform.ts"), {
      namedExports: {
        metaPlatform: () => ({
          responses: {
            create: async (body: { model: string; max_output_tokens: number }) => {
              storyCalls += 1;
              storyModels.push(body.model);
              assert.ok(body.max_output_tokens >= 600, "room for the story and Muse Wonder's reasoning");
              if (storyReply instanceof Error) throw storyReply;
              const incomplete = storyStatus === "incomplete" ? { reason: "max_output_tokens" } : null;
              return { status: storyStatus, incomplete_details: incomplete, output_text: storyReply, usage: { input_tokens: 900, output_tokens: 180 } };
            },
          },
        }),
      },
    });
    store = await import("../store");
    steps = await import("../hub-steps");
    wf = await import("../workflow");
    ({ hashToken } = await import("../../gateway/tokens"));
    ({ POST: hubRoute } = await import(at("../../../app/api/train/jobs/[id]/hub/route.ts")));
    ({ POST: publishPost, GET: publishGet } = await import(at("../../../app/api/train/jobs/[id]/publish/route.ts")));
  });

  after(async () => {
    mock.restoreAll();
    process.env = savedEnv;
    await fake.close();
    await client?.close();
  });

  let admin: string | null = null;
  async function adminId(): Promise<string> {
    if (admin) return admin;
    const [row] = await testDb.insert(realSchema.users).values({ email: "owner@example.com", isAdmin: true }).returning();
    admin = row!.id;
    return admin;
  }

  beforeEach(async () => {
    for (const table of [realSchema.trainingEvents, realSchema.trainingJobs, realSchema.trainingDatasets, realSchema.rateLimits, realSchema.usage]) {
      await testDb.delete(table);
    }
    fake.repos.clear();
    fake.requests.length = 0;
    fake.leaks.length = 0;
    fake.transfers.length = 0;
    started = [];
    storyCalls = 0;
    storyModels = [];
    storyStatus = "completed";
    paused = false;
    storyReply =
      "Muse Muse turns an example or some inspo into a working product on Meta's models, and its first step is the brief writer. This adapter teaches Muse Glimmer 30B, an open model you can run on your own GPU, to write those briefs the way Muse Spark 1.3 does.\n\nThat way the brief writer can run on a model you host yourself.";
    Object.assign(process.env, {
      HF_TOKEN,
      HF_NAMESPACE: "muse-org",
      HF_ENDPOINT: fake.url,
      MODEL_API_KEY: "test-value-not-a-key",
      GATEWAY_TOKEN_PEPPER: "test-pepper-for-hub-tests",
      PLATFORM_URL: "https://muse.example.com",
      LAMBDA_API_KEY: "test-value-not-a-key",
      CRON_SECRET: "test-cron",
      VERCEL_ENV: "production",
      ADMIN_EMAILS: "owner@example.com",
    });
    delete process.env.HF_PUBLIC;
    delete process.env.TRAIN_MAX_ACTIVE;
    const { hubTiming } = await import("../hub");
    Object.assign(hubTiming, { timeoutMs: 2000, retries: 1, retryBaseMs: 1, retryMaxMs: 5 });
    await makeDataset();
  });

  describe("the GPU's upload", () => {
    it("plans the weights through the LFS bridge, keeps the small files, and takes the report", async () => {
      const jobId = await makeJob();
      const folder = adapterFolder();
      const { status, plan, done } = await gpuUpload(jobId, TOKEN, folder);
      assert.equal(status, 200);
      const repo = `muse-org/muse-glimmer-30b-brief-writer-lora-${jobId.slice(0, 8)}`;
      assert.equal(plan.repo, repo);
      const uploads = plan.uploads as Array<Record<string, unknown>>;
      assert.deepEqual(
        uploads.map((u) => [u.path, u.transfer]),
        [
          ["adapter_model.safetensors", "multipart"],
          ["tokenizer.model", "basic"],
        ],
        "the small files and PEFT's README get no upload",
      );
      const multi = uploads[0]!;
      assert.equal(multi.oid, sha(folder.get("adapter_model.safetensors")!));
      assert.equal((multi.parts as unknown[]).length, Math.ceil((200 * 1024) / (48 * 1024)));
      assert.deepEqual(fake.transfers, [["basic", "multipart"]], "never xet");
      assert.equal(done, 204);
      assert.deepEqual(fake.leaks, [], "the GPU sent no credential to storage");
      assert.doesNotMatch(JSON.stringify(plan), new RegExp(HF_TOKEN), "a verify action's credential never reaches the GPU");

      const model = fake.repo("model", repo)!;
      assert.equal(model.private, true, "made private");
      assert.equal(model.license, "apache-2.0");
      assert.equal(model.commits.length, 0, "nothing is committed before the job is judged");
      const hub = (await hubOf(jobId))!;
      assert.equal(hub.status, "uploaded");
      assert.equal(hub.uploaderJobId, jobId);
      assert.deepEqual(hub.files!.map((f) => f.path).sort(), ["adapter_model.safetensors", "tokenizer.model"]);
      assert.deepEqual(Object.keys(hub.small!).sort(), [...SMALL].sort());
      assert.equal(Buffer.from(hub.small!["adapter_config.json"]!, "base64").toString(), folder.get("adapter_config.json")!.toString());
      const stored = JSON.stringify(await store.getJob(jobId)) + JSON.stringify(await store.listEvents(jobId));
      assert.doesNotMatch(stored, /X-Amz|\/s3\/|lfs-complete/, "no upload URL is stored or logged");
      assert.ok((await logOf(jobId)).some((t) => /Hugging Face has all of the adapter's files/.test(t)));
    });

    it("takes a plan again (runner.py's after an expired URL) as the whole plan, in place of the one before", async () => {
      const jobId = await makeJob();
      const folder = adapterFolder();
      const first = await hubRoute(...hubReq(jobId, TOKEN, planBody(folder)));
      assert.equal(first.status, 200);
      const res = await hubRoute(...hubReq(jobId, TOKEN, planBody(folder)));
      const again = (await res.json()) as { uploads: Array<{ path: string; transfer: string }> };
      assert.deepEqual(again.uploads.map((u) => [u.path, u.transfer]), [["adapter_model.safetensors", "multipart"], ["tokenizer.model", "basic"]], "fresh URLs");
      let hub = (await hubOf(jobId))!;
      assert.deepEqual([hub.files!.length, Object.keys(hub.small!).length, hub.status], [2, 3, "uploading"]);

      // Once the files are up, a plan again finds them on the Hub, and they stay uploaded.
      await gpuUpload(jobId, TOKEN, folder);
      await hubRoute(...hubReq(jobId, TOKEN, planBody(folder)));
      hub = (await hubOf(jobId))!;
      assert.equal(hub.uploaded!.length, 2);

      // A plan is always whole: a small file that files doesn't name, or a plan without the config, isn't merged in.
      const weights = new Map([["adapter_model.safetensors", folder.get("adapter_model.safetensors")!]]);
      const partial = await hubRoute(...hubReq(jobId, TOKEN, { ...planBody(weights, []), small: planBody(folder).small }));
      assert.equal(partial.status, 400);
      const bare = await hubRoute(...hubReq(jobId, TOKEN, planBody(weights, [])));
      assert.equal(((await bare.json()) as { skip?: string }).skip, "adapter_config.json isn't in the plan's small files.");
    });

    it("keeps the job's state to one plan's caps, however many plans one GPU sends", async () => {
      const jobId = await makeJob();
      const folder = adapterFolder();
      const base = planBody(folder);
      // Three plans, each with 2 MB more of small files: only the latest plan's are kept.
      for (let p = 0; p < 3; p++) {
        const more = new Map(folder);
        more.set("vocab.json", Buffer.alloc(MB - 64, 97 + p));
        more.set("merges.txt", Buffer.alloc(MB - 64, 100 + p));
        const res = await hubRoute(...hubReq(jobId, TOKEN, planBody(more, [...SMALL, "vocab.json", "merges.txt"])));
        assert.equal(res.status, 200, await res.clone().text());
      }
      const hub = (await hubOf(jobId))!;
      const bytes = Object.values(hub.small ?? {}).reduce((n, b) => n + Buffer.from(b, "base64").length, 0);
      assert.ok(bytes < 3 * MB, `${bytes}`);
      assert.deepEqual(Object.keys(hub.small!).sort(), [...SMALL, "merges.txt", "vocab.json"].sort());
      // Small files must each be one that files names, and a plan can't carry more of them than HUB_FILES_MAX.
      const many: Record<string, string> = { ...base.small };
      for (let i = 0; i < 3000; i++) many[`x${i}.json`] = "";
      assert.equal((await hubRoute(...hubReq(jobId, TOKEN, { ...base, small: many }))).status, 413);
      const stray = { ...base, small: { ...base.small, "vocab.json": Buffer.from("{}").toString("base64") } };
      assert.equal((await hubRoute(...hubReq(jobId, TOKEN, stray))).status, 400, "not in files");
      // The list reads leave the small files out; the job itself has them, for publishing.
      const listed = (await store.listJobs(10)).find((j) => j.id === jobId)!;
      assert.equal(listed.hub?.small, undefined);
      assert.equal(listed.hub?.status, "uploading");
      assert.ok((await store.getJob(jobId))!.hub!.small);
    });

    it("refuses a missing or wrong token, and another job's", async () => {
      const jobId = await makeJob();
      const other = await makeJob();
      for (const token of [null, "wrong", PUBLISH_TOKEN]) {
        assert.equal((await hubRoute(...hubReq(jobId, token, planBody(adapterFolder())))).status, 401, String(token));
      }
      await testDb.update(realSchema.trainingJobs).set({ tokenHash: hashToken("the-other-token") }).where(eq(realSchema.trainingJobs.id, other));
      assert.equal((await hubRoute(...hubReq(other, TOKEN, planBody(adapterFolder())))).status, 401, "a token works for its own job only");
      assert.equal(fake.requests.length, 0);
    });

    it("skips with a plain reason, and saves an off Hub on the job", async () => {
      const skip = async (jobId: string, body: unknown = planBody(adapterFolder()), token = TOKEN) => {
        const res = await hubRoute(...hubReq(jobId, token, body));
        assert.equal(res.status, 200);
        return ((await res.json()) as { skip?: string }).skip;
      };
      const jobId = await makeJob();
      delete process.env.HF_TOKEN;
      assert.equal(await skip(jobId), "Publishing to Hugging Face is off here: HF_TOKEN isn't set.");
      assert.deepEqual([(await hubOf(jobId))?.status, (await hubOf(jobId))?.reason], ["off", "Publishing to Hugging Face is off here: HF_TOKEN isn't set."]);
      process.env.HF_TOKEN = HF_TOKEN;
      process.env.HF_NAMESPACE = "bad--name";
      assert.match((await skip(jobId))!, /HF_NAMESPACE isn't a Hugging Face user or organization name/);
      process.env.HF_NAMESPACE = "muse-org";

      const dry = await makeJob({ params: { datasetId: DATASET_ID, dryRun: 1 } });
      assert.match((await skip(dry))!, /dry run/);
      const off = await makeJob({ params: { datasetId: DATASET_ID, publish: 0 } });
      assert.equal(await skip(off), "Publish to Hugging Face is 0 for this job.");
      const ended = await makeJob({ status: "failed", finishedAt: new Date() });
      assert.equal(await skip(ended), "This job already ended.");
      const published = await makeJob({ hub: { status: "published" } });
      assert.equal(await skip(published), "It is already on Hugging Face.");
      const busy = await makeJob({ hub: { status: "publishing", updatedAt: new Date().toISOString() } });
      assert.equal(await skip(busy), "It is being published right now.");
      // A config the platform reads that it won't publish fails the upload, with the reason on the job.
      const auto = new Map([...adapterFolder(), ["tokenizer_config.json", Buffer.from(JSON.stringify({ auto_map: { AutoTokenizer: ["x--tok.T", null] } }))]]);
      const failing = await makeJob();
      const autoReason = "The adapter isn't published: tokenizer_config.json has an auto_map, which points a loader at code from another repo.";
      assert.equal(await skip(failing, planBody(auto)), autoReason);
      assert.deepEqual([(await hubOf(failing))?.status, (await hubOf(failing))?.reason], ["failed", autoReason]);
      const otherBase = new Map([...adapterFolder(), ["adapter_config.json", Buffer.from(JSON.stringify({ base_model_name_or_path: "someone-else/other-base", r: 16 }))]]);
      assert.match((await skip(await makeJob(), planBody(otherBase)))!, /adapter_config\.json names "someone-else\/other-base" as its base model, not unsloth\/Muse-Glimmer-30B-unsloth-bnb-4bit/);
      const noWeights = new Map([...adapterFolder()].filter(([p]) => p !== "adapter_model.safetensors"));
      assert.equal(await skip(jobId, planBody(noWeights)), "The folder has no adapter_model.safetensors.");
      assert.equal(await skip(jobId, planBody(adapterFolder(), [])), "adapter_config.json isn't in the plan's small files.");
      const smoke = await store.createJob({ recipe: "smoke", title: "Smoke", params: {}, instanceType: "gpu_1x_a10", region: "us-east-1", priceCentsPerHour: 75, maxMinutes: 30, maxUsd: 1 });
      await testDb.update(realSchema.trainingJobs).set({ status: "running", tokenHash: hashToken(TOKEN) }).where(eq(realSchema.trainingJobs.id, smoke.id));
      assert.equal(await skip(smoke.id), "This job's recipe doesn't publish to Hugging Face.");
      assert.equal(fake.repos.size, 0, "a skipped plan makes no repo");
    });

    it("plans only the adapter's and the tokenizer's own names, and drops a checked config that isn't inline", async () => {
      const jobId = await makeJob();
      const folder = new Map([
        ...adapterFolder(),
        ["config.json", Buffer.from(JSON.stringify({ auto_map: { AutoModel: "someone--code.X" } }))],
        ["model.safetensors", bytes(1000, 9)],
        ["requirements.txt", Buffer.from("something==1.0\n")],
        ["Muse_Muse_Run.json", Buffer.from("{}")],
        ["special_tokens_map.json", Buffer.from("{}")],
      ]);
      // special_tokens_map.json comes only as a file to upload, so the platform can't read it: it stays out too.
      const { plan } = await gpuUpload(jobId, TOKEN, folder);
      assert.deepEqual((plan.uploads as Array<{ path: string }>).map((u) => u.path), ["adapter_model.safetensors", "tokenizer.model"]);
      const hub = (await hubOf(jobId))!;
      assert.deepEqual(hub.files!.map((f) => f.path).sort(), ["adapter_model.safetensors", "tokenizer.model"]);
      assert.deepEqual(Object.keys(hub.small!).sort(), [...SMALL].sort());
    });

    it("saves a refusal of the Hub's on the job and says it isn't worth retrying, and leaves a Hub that is down to retry", async () => {
      const jobId = await makeJob();
      fake.fail(/^\/api\/repos\/create$/, [403], { error: "You don't have the rights to create a model under the namespace" });
      const refused = await hubRoute(...hubReq(jobId, TOKEN, planBody(adapterFolder())));
      assert.equal(refused.status, 409, "not a 5xx, so runner.py doesn't ask again");
      const body = (await refused.json()) as { error: string; message: string };
      assert.equal(body.error, "hub_refused");
      assert.match(body.message, /HTTP 403, You don't have the rights .* Check that HF_TOKEN can write repos under HF_NAMESPACE\.$/);
      assert.deepEqual([(await hubOf(jobId))?.status, (await hubOf(jobId))?.reason], ["failed", body.message], "the job page says why");
      assert.doesNotMatch(JSON.stringify(body), new RegExp(HF_TOKEN));

      const down = await makeJob();
      fake.fail(/\/preupload\/main$/, [503, 503]);
      const unavailable = await hubRoute(...hubReq(down, TOKEN, planBody(adapterFolder())));
      assert.equal(unavailable.status, 502);
      assert.equal(((await unavailable.json()) as { error: string }).error, "hub_unavailable");
      assert.equal((await hubOf(down))?.status ?? null, null, "nothing saved: runner.py asks again");
    });

    it("refuses what is too large, and what doesn't add up", async () => {
      const jobId = await makeJob();
      const base = planBody(adapterFolder());
      const send = async (body: unknown) => hubRoute(...hubReq(jobId, TOKEN, body));
      const huge = { ...base, files: [{ ...base.files[0]!, size: 11 * 1024 ** 3 }] };
      assert.equal((await send(huge)).status, 413);
      const many = { ...base, files: Array.from({ length: 101 }, (_, i) => ({ ...base.files[0]!, path: `f${i}.json` })) };
      assert.equal((await send(many)).status, 413);
      const big = Buffer.alloc(MB + 1, 97);
      const oneBig = new Map([...adapterFolder(), ["vocab.json", big]]);
      const res = await send(planBody(oneBig, [...SMALL, "vocab.json"]));
      assert.equal(res.status, 413);
      assert.equal(((await res.json()) as { error: string }).error, "small_too_large");
      const three = new Map([...adapterFolder(), ["a.json", Buffer.alloc(MB, 97)], ["b.json", Buffer.alloc(MB, 98)], ["c.json", Buffer.alloc(MB, 99)]]);
      assert.equal((await send(planBody(three, [...SMALL, "a.json", "b.json", "c.json"]))).status, 413, "3 MB of small files in all");
      assert.equal((await send("x".repeat(4_500_000))).status, 413, "the body itself");
      assert.equal((await send({ ...base, files: [{ ...base.files[0]!, sha256: "nothex" }] })).status, 400);
      assert.equal((await send({ ...base, files: [{ ...base.files[0]!, sample: Buffer.alloc(600).toString("base64") }] })).status, 400);
      assert.equal((await send({ ...base, small: { ...base.small, "adapter_config.json": "e30=" } })).status, 400, "it isn't the file files names");
      assert.equal((await send({ action: "nope" })).status, 400);
      assert.equal(fake.repos.size, 0);
    });

    it("checks the report against the plan, keeps a failure's reason without its URL, and limits calls", async () => {
      const jobId = await makeJob();
      const done = (body: unknown) => hubRoute(...hubReq(jobId, TOKEN, { action: "done", ...(body as object) }));
      assert.equal((await done({ uploaded: [] })).status, 409, "no plan yet");
      await hubRoute(...hubReq(jobId, TOKEN, planBody(adapterFolder())));
      assert.equal((await done({ uploaded: [{ path: "adapter_model.safetensors", oid: "a".repeat(64), size: 1 }] })).status, 400);
      const res = await done({
        uploaded: [],
        failed: [{ path: "tokenizer.model", error: "HTTP 500 from https://bucket.example/s3/x?X-Amz-Signature=deadbeefdeadbeef" }],
      });
      assert.equal(res.status, 204);
      const hub = (await hubOf(jobId))!;
      assert.equal(hub.status, "failed");
      assert.equal(hub.reason, "The GPU couldn't upload tokenizer.model to Hugging Face: HTTP 500 from [signed URL]");
      for (let i = 0; i < 60; i++) await done({ uploaded: [] });
      assert.equal((await done({ uploaded: [] })).status, 429, "61 calls in an hour");
    });

    it("takes a report only from a GPU still running, about its own plan, while that plan uploads", async () => {
      // A report after its job ended (the token still works for a while) changes nothing, even after publishing.
      const jobId = await makeJob();
      await gpuUpload(jobId, TOKEN, adapterFolder());
      await judged(jobId);
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: true });
      const late = await hubRoute(
        ...hubReq(jobId, TOKEN, { action: "done", uploaded: [], failed: [{ path: "adapter_model.safetensors", error: "see evil.example for the weights" }] }),
      );
      assert.equal(late.status, 409);
      assert.equal(((await late.json()) as { error: string }).error, "ended");
      assert.equal((await hubOf(jobId))!.status, "published");
      assert.ok((await store.getResultJob(jobId))?.hubLinks, "the public links stay");

      // A report while the platform publishes doesn't hand a second run the claim.
      const adapter = await makeJob();
      await judged(adapter);
      const publishJob = await store.createJob({ recipe: "glimmer-publish", title: "Publish to Hugging Face: x", params: { adapterJobId: adapter }, instanceType: "gpu_1x_rtx6000", region: "us-east-1", priceCentsPerHour: 50, maxMinutes: 20, maxUsd: 1 });
      await testDb.update(realSchema.trainingJobs).set({ status: "running", tokenHash: hashToken(PUBLISH_TOKEN) }).where(eq(realSchema.trainingJobs.id, publishJob.id));
      await gpuUpload(publishJob.id, PUBLISH_TOKEN, adapterFolder(4));
      assert.equal((await steps.hubPlanStep(adapter, "succeeded", true)).action, "publish");
      const files = (await hubOf(adapter))!.files!.map((f) => ({ path: f.path, oid: f.sha256, size: f.size }));
      const during = await hubRoute(...hubReq(publishJob.id, PUBLISH_TOKEN, { action: "done", uploaded: files, failed: [] }));
      assert.equal(during.status, 409);
      assert.equal(((await during.json()) as { error: string }).error, "not_uploading");
      assert.equal((await hubOf(adapter))!.status, "publishing");
      assert.deepEqual(await steps.hubPlanStep(adapter, "succeeded", true), { action: "none" }, "the claim is still the first run's");
    });
  });

  describe("publishing", () => {
    async function uploadedJudgedJob(over: Partial<typeof realSchema.trainingJobs.$inferInsert> = {}): Promise<string> {
      const jobId = await makeJob(over);
      await gpuUpload(jobId, TOKEN, adapterFolder());
      await judged(jobId);
      return jobId;
    }

    it("commits both repos, reads them back, makes them public, and saves where they are", async () => {
      const jobId = await uploadedJudgedJob();
      const out = await wf.publishToHub({ jobId });
      assert.deepEqual(out, { published: true }, JSON.stringify(await hubOf(jobId)).slice(0, 2000) + JSON.stringify(await logOf(jobId)));
      const hub = (await hubOf(jobId))!;
      const modelId = `muse-org/muse-glimmer-30b-brief-writer-lora-${jobId.slice(0, 8)}`;
      const dataId = "muse-org/muse-muse-brief-writer-1b2c3d4e";
      assert.equal(hub.status, "published");
      assert.equal(hub.public, true);
      assert.equal(hub.modelUrl, `${fake.url}/${modelId}`);
      assert.equal(hub.datasetUrl, `${fake.url}/datasets/${dataId}`);
      assert.equal(hub.storyBy, "spark");
      assert.equal(hub.storyModel, "muse-wonder-1.0", "Muse Wonder wrote the story, and the hub state says so");
      assert.deepEqual(storyModels, ["muse-wonder-1.0"], "never Muse Spark 1.3");
      assert.ok((await logOf(jobId)).includes("Hugging Face card: Muse Wonder wrote the story."));
      assert.match(hub.datasetCommit!, /^[0-9a-f]{40}$/);

      const data = fake.repo("dataset", dataId)!;
      assert.equal(data.private, false, "public once verified");
      const train = data.files.get("data/train.jsonl")!.content!.toString().trimEnd().split("\n").map((l) => JSON.parse(l));
      assert.equal(train.length, 12);
      assert.deepEqual(train[0].messages.map((m: { role: string }) => m.role), ["system", "user", "assistant"]);
      const evals = data.files.get("data/eval.jsonl")!.content!.toString().trimEnd().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(evals[1], { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: "Held out 1" }, { role: "assistant", content: "Reference 1" }] });
      assert.match(data.files.get("README.md")!.content!.toString(), /^---\npretty_name: "Muse Muse's brief writer"/);

      const model = fake.repo("model", modelId)!;
      assert.equal(model.private, false);
      assert.deepEqual([...model.files.keys()].sort(), [
        ".gitattributes",
        "LICENSE",
        "README.md",
        "adapter_config.json",
        "adapter_model.safetensors",
        "chat_template.jinja",
        "muse_muse_run.json",
        "tokenizer.model",
        "tokenizer_config.json",
      ]);
      const folder = adapterFolder();
      assert.deepEqual(model.files.get("adapter_model.safetensors")!.lfs, { oid: sha(folder.get("adapter_model.safetensors")!), size: 200 * 1024 });
      assert.equal(gitOidOf(model.files.get("adapter_config.json")!.content!), gitOidOf(folder.get("adapter_config.json")!), "the normalized copy, which for this one is the GPU's");
      assert.match(model.files.get("LICENSE")!.content!.toString(), /Apache License/);
      const card = model.files.get("README.md")!.content!.toString();
      assert.match(card, /^---\nbase_model: unsloth\/Muse-Glimmer-30B-unsloth-bnb-4bit\nbase_model_relation: adapter\n/);
      assert.match(card, /## Why this exists\n\nMuse Muse turns an example or some inspo/, "Muse Wonder's story");
      assert.ok(
        card.includes("host yourself.\n\nMuse Spark 1.3 wrote the dataset's 14 examples: 12 to train on and 2 held out. On 2 held-out prompts, judged blind by Muse Spark 1.3, the tuned model was better on 2 of 2, with an average score of 8.5 out of 10 against 2.5 for the base model."),
        "then the records' counts and result, with the writer and the judge the records name (none: Muse Spark 1.3)",
      );
      assert.doesNotMatch(card, /Muse Wonder/, "the card credits Muse Wonder with nothing but the story, which it doesn't sign");
      const dataCard = data.files.get("README.md")!.content!.toString();
      assert.ok(dataCard.includes(`## Models trained on it\n\n- [${modelId}](https://huggingface.co/${modelId}), from the run "Brief writer LoRA": https://muse-muse.vercel.app/fine-tuning/${jobId}\n`));
      assert.deepEqual(data.commits.map((c) => c.files.sort()), [["data/eval.jsonl", "data/train.jsonl"], ["LICENSE.md", "README.md"]], "the data, then the card and its terms once the model is in");
      assert.match(data.files.get("LICENSE.md")!.content!.toString(), /Muse Muse grants no license or other rights beyond what those terms allow/);
      assert.match(card, /\| Better on \| 0 of 2 \| 2 of 2 \|/);
      assert.match(card, /SYSTEM = "You are Muse Muse's brief writer\."/, "the run's own system line");
      assert.doesNotMatch(card, /PEFT's own card/);
      const run = JSON.parse(model.files.get("muse_muse_run.json")!.content!.toString());
      assert.equal(run.eval.items.length, 2);
      assert.equal(run.dataset.writer, "muse-spark-1.3", "a dataset with no writer recorded");
      assert.equal(run.eval.judge, "muse-spark-1.3", "a job with no judge recorded");
      assert.deepEqual([run.story.by, run.story.model], ["model", "muse-wonder-1.0"]);
      assert.equal(run.job.metrics.adapter_dir, undefined, "no cache path");
      assert.equal(model.commits.length, 1, "one commit for the model repo");
      assert.deepEqual(model.commits[0]!.lfsFiles.sort(), ["adapter_model.safetensors", "tokenizer.model"]);

      const usage = await testDb.select().from(realSchema.usage);
      assert.equal(usage.length, 1, "the story's call is recorded");
      assert.equal(usage[0]!.source, "platform");
      assert.ok((await logOf(jobId)).some((t) => t.startsWith("Published to Hugging Face: ")));
      assert.deepEqual(fake.leaks, []);
      const result = await store.getResultJob(jobId);
      assert.deepEqual(result?.hubLinks, { status: "published", modelUrl: hub.modelUrl, datasetUrl: hub.datasetUrl });
      const all = JSON.stringify(await store.listEvents(jobId)) + JSON.stringify(await store.getJob(jobId));
      assert.doesNotMatch(all, new RegExp(HF_TOKEN), "the HF token is never stored or logged");
    });

    it("credits Muse Wonder on every file for a dataset its record says it wrote and a run it judged", async () => {
      await testDb.update(realSchema.trainingDatasets).set({ writerModel: "muse-wonder-1.0" }).where(eq(realSchema.trainingDatasets.id, DATASET_ID));
      storyReply = (storyReply as string).replace("Muse Spark 1.3", "Muse Wonder");
      const jobId = await uploadedJudgedJob({ judgeModel: "muse-wonder-1.0" });
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: true });
      const hub = (await hubOf(jobId))!;
      const model = fake.repo("model", hub.modelRepo!)!;
      const data = fake.repo("dataset", "muse-org/muse-muse-brief-writer-1b2c3d4e")!;
      const card = model.files.get("README.md")!.content!.toString();
      const files = [card, model.files.get("muse_muse_run.json")!.content!.toString(), ...["README.md", "LICENSE.md"].map((p) => data.files.get(p)!.content!.toString())];
      for (const text of files) assert.doesNotMatch(text, /Muse Spark|Spark 1\.3|muse-spark/, text.slice(0, 80));
      assert.ok(card.includes("Muse Wonder wrote the dataset's 14 examples: 12 to train on and 2 held out. On 2 held-out prompts, judged blind by Muse Wonder,"));
      assert.match(card, /Muse Wonder \(`muse-wonder-1\.0`\) judged each pair blind/);
      assert.match(data.files.get("LICENSE.md")!.content!.toString(), /^Muse Wonder wrote every prompt and answer in this dataset/m);
      const run = JSON.parse(model.files.get("muse_muse_run.json")!.content!.toString());
      assert.deepEqual([run.dataset.writer, run.eval.judge, run.story.model], ["muse-wonder-1.0", "muse-wonder-1.0", "muse-wonder-1.0"]);
    });

    it("publishes again with only what changed, and a new why rewrites the story", async () => {
      const jobId = await uploadedJudgedJob();
      await wf.publishToHub({ jobId });
      const modelId = (await hubOf(jobId))!.modelRepo!;
      const model = fake.repo("model", modelId)!;
      const data = fake.repo("dataset", "muse-org/muse-muse-brief-writer-1b2c3d4e")!;
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: true });
      assert.equal(model.commits.length, 1, "nothing changed, so nothing is committed");
      assert.equal(data.commits.length, 2, "the data and the card, once");
      assert.equal(storyCalls, 1, "the saved story is kept");

      const res = await publishPost(
        new Request(`https://muse.example.com/api/train/jobs/${jobId}/publish`, { method: "POST", body: JSON.stringify({ why: "Because briefs should run offline." }) }),
        { params: Promise.resolve({ id: jobId }) },
      );
      assert.equal(res.status, 202);
      assert.equal(((await res.json()) as { started: string }).started, "publish");
      assert.deepEqual(started.map((s) => [s.fn, s.args]), [["publishToHub", [{ jobId }]]]);
      await wf.publishToHub({ jobId });
      assert.equal(storyCalls, 2, "written again around the why");
      assert.equal(model.commits.length, 2);
      assert.deepEqual(model.commits[1]!.files.sort(), ["README.md", "muse_muse_run.json"]);
      assert.deepEqual(model.commits[1]!.lfsFiles, []);
      assert.match(model.files.get("README.md")!.content!.toString(), /## Why this exists\n\nBecause briefs should run offline\.\n\nMuse Muse turns/);
    });

    it("prompts with the dataset's own system message on the card when the run used the full student prompt", async () => {
      const jobId = await makeJob({ params: { datasetId: DATASET_ID, studentPrompt: "full", dryRun: 0, publish: 1 } });
      await gpuUpload(jobId, TOKEN, adapterFolder());
      // glimmer.py's student_system metric only describes the message when the prompt is "full".
      await judged(jobId, { student_prompt: "full", student_system: `the dataset's own (${SYSTEM.length} characters)` });
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: true });
      const card = fake.repo("model", (await hubOf(jobId))!.modelRepo!)!.files.get("README.md")!.content!.toString();
      assert.ok(card.includes(`SYSTEM = ${JSON.stringify(SYSTEM)}`), "the message both models answered under");
      assert.doesNotMatch(card, /the dataset's own \(/);

      // A job from before the param (run 1) trained under the dataset's own message too.
      const old = await makeJob({ params: { datasetId: DATASET_ID, maxSteps: 120, dryRun: 0 } });
      await gpuUpload(old, TOKEN, adapterFolder(2));
      // Its done metrics have no student_prompt either, as judged() logs them.
      await judged(old, { student_system: "none" });
      assert.deepEqual(await wf.publishToHub({ jobId: old }), { published: true });
      const oldCard = fake.repo("model", (await hubOf(old))!.modelRepo!)!.files.get("README.md")!.content!.toString();
      assert.ok(oldCard.includes(`SYSTEM = ${JSON.stringify(SYSTEM)}`), "no param and no metric: the dataset's own message");
      assert.match(oldCard, /Both models answered under the dataset's whole task prompt/);
    });

    it("takes a copy of the why out of the model's story, which the card prints just before it", async () => {
      const why = "Because briefs should run offline.";
      const told = storyReply as string;
      storyReply = `${why}\n\n${told}`;
      const jobId = await uploadedJudgedJob({ params: { datasetId: DATASET_ID, studentPrompt: "short", dryRun: 0, publish: 1, why } });
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: true });
      const hub = (await hubOf(jobId))!;
      assert.deepEqual([hub.storyBy, hub.story], ["spark", told]);
      const card = fake.repo("model", hub.modelRepo!)!.files.get("README.md")!.content!.toString();
      assert.equal(card.split(why).length - 1, 1, "the why once, then the story");
      assert.ok(card.includes(`## Why this exists\n\n${why}\n\n${told.split("\n\n")[0]}`));
    });

    it("uses the template's story when Muse Wonder invents a number, runs out of tokens, fails or the cap is reached", async () => {
      storyReply = "It won 99 of 2 prompts.";
      const jobId = await uploadedJudgedJob();
      await wf.publishToHub({ jobId });
      assert.equal((await hubOf(jobId))!.storyBy, "template");
      assert.equal((await hubOf(jobId))!.storyModel, null, "the template's story has no model");
      assert.ok((await logOf(jobId)).some((t) => /the template's story, since it states counts or results itself \(won, 99, 2\)/.test(t)));
      storyStatus = "incomplete";
      const short = await uploadedJudgedJob();
      await wf.publishToHub({ jobId: short });
      assert.equal((await hubOf(short))!.storyBy, "template");
      assert.ok((await logOf(short)).some((t) => /the template's story, since the call stopped early \(max_output_tokens\)/.test(t)));
      storyStatus = "completed";
      const second = await uploadedJudgedJob();
      paused = true;
      await wf.publishToHub({ jobId: second });
      assert.equal(storyCalls, 2, "no call while the spend cap is reached");
      assert.equal((await hubOf(second))!.storyBy, "template");
    });

    it("keeps the repos private with HF_PUBLIC=0, and then the public pages get no links", async () => {
      process.env.HF_PUBLIC = "0";
      const jobId = await uploadedJudgedJob();
      await wf.publishToHub({ jobId });
      const hub = (await hubOf(jobId))!;
      assert.deepEqual([hub.status, hub.public], ["published", false]);
      assert.equal(fake.repo("model", hub.modelRepo!)!.private, true);
      assert.equal((await store.getResultJob(jobId))?.hubLinks ?? null, null);
    });

    it("keeps the repos private for any HF_PUBLIC it doesn't take as yes, and makes public ones private again for 0", async () => {
      process.env.HF_PUBLIC = "false";
      const jobId = await uploadedJudgedJob();
      await wf.publishToHub({ jobId });
      const hub = (await hubOf(jobId))!;
      assert.deepEqual([hub.status, hub.public, fake.repo("model", hub.modelRepo!)!.private], ["published", false, true]);

      // Published public, then HF_PUBLIC=0 and a new why: both repos go private, and the state says so as the Hub does.
      process.env.HF_PUBLIC = "1";
      const other = await uploadedJudgedJob();
      await wf.publishToHub({ jobId: other });
      const was = (await hubOf(other))!;
      assert.equal(was.public, true);
      process.env.HF_PUBLIC = "0";
      await store.updateHub(other, (h) => ({ ...h!, why: "A new why, written after HF_PUBLIC was set to 0", story: null, storyBy: null }));
      await wf.publishToHub({ jobId: other });
      const now = (await hubOf(other))!;
      assert.deepEqual([now.status, now.public], ["published", false]);
      assert.equal(fake.repo("model", now.modelRepo!)!.private, true);
      assert.equal(fake.repo("dataset", now.datasetRepo!)!.private, true, "no other public model uses the dataset");
      assert.equal((await store.getResultJob(other))?.hubLinks ?? null, null);
    });

    it("puts back the repo it made public when a later part fails, so a failure leaves both as they were", async () => {
      const jobId = await uploadedJudgedJob();
      fake.fail(/^\/api\/datasets\/.+\/settings$/, [403]);
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: false });
      const hub = (await hubOf(jobId))!;
      assert.equal(hub.status, "failed");
      assert.match(hub.reason!, /making muse-org\/muse-muse-brief-writer-1b2c3d4e public failed .*HTTP 403/);
      assert.equal(fake.repo("model", hub.modelRepo!)!.private, true, "made public, then private again");
      assert.equal(fake.repo("dataset", hub.datasetRepo!)!.private, true);
      assert.notEqual(hub.public, true);
      // Retry publishes it.
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: true });
      assert.deepEqual([fake.repo("model", hub.modelRepo!)!.private, fake.repo("dataset", hub.datasetRepo!)!.private], [false, false]);
    });

    it("keeps the shared dataset card for every public model, and never changes it for a job that fails", async () => {
      const a = await uploadedJudgedJob();
      await wf.publishToHub({ jobId: a });
      const data = fake.repo("dataset", "muse-org/muse-muse-brief-writer-1b2c3d4e")!;
      const aModel = (await hubOf(a))!.modelRepo!;
      const before = data.files.get("README.md")!.content!.toString();
      assert.ok(before.includes(aModel));

      // B fails at its model step: the public dataset card doesn't change, so it never names B's private repo or why.
      const b = await makeJob({ params: { datasetId: DATASET_ID, studentPrompt: "short", dryRun: 0, publish: 1, why: "B's private reason, for a card that never went out" } });
      await gpuUpload(b, TOKEN, adapterFolder(2));
      await judged(b);
      const bHub = (await hubOf(b))!;
      fake.repo("model", bHub.modelRepo!)!.objects.delete(bHub.files!.find((f) => f.path === "tokenizer.model")!.sha256);
      assert.deepEqual(await wf.publishToHub({ jobId: b }), { published: false });
      assert.equal(data.files.get("README.md")!.content!.toString(), before);
      assert.equal(fake.repo("model", bHub.modelRepo!)!.private, true);

      // C publishes: the card tells C's story and lists C, then A.
      const c = await uploadedJudgedJob({ params: { datasetId: DATASET_ID, studentPrompt: "short", dryRun: 0, publish: 1, why: "C's reason." } });
      assert.deepEqual(await wf.publishToHub({ jobId: c }), { published: true });
      const cModel = (await hubOf(c))!.modelRepo!;
      const after = data.files.get("README.md")!.content!.toString();
      const list = after.slice(after.indexOf("## Models trained on it"), after.indexOf("## License")).match(/^- \[([^\]]+)\]/gm)!;
      assert.deepEqual(list, [`- [${cModel}]`, `- [${aModel}]`]);
      assert.match(after, new RegExp(`As the card of \\[${cModel}\\]\\([^)]+\\), the latest model published from it, tells it:\\n\\nC's reason\\.`));
      assert.doesNotMatch(after, /B's private reason/);
    });

    it("fences off a run whose stale claim another run took: it stops without writing, and can't fail the new one", async () => {
      const jobId = await uploadedJudgedJob();
      const first = await steps.hubPlanStep(jobId, "succeeded", true);
      assert.equal(first.action, "publish");
      if (first.action !== "publish") return;
      // The first run went quiet for over 30 minutes, so Publish may claim the job again.
      await store.updateHub(jobId, (h) => ({ ...h!, updatedAt: new Date(Date.now() - 31 * 60_000).toISOString() }));
      const second = await steps.hubPlanStep(jobId, "succeeded", true);
      assert.equal(second.action, "publish");
      if (second.action !== "publish") return;
      assert.notEqual(second.claim, first.claim);
      await assert.rejects(steps.hubStoryStep(jobId, first.claim), /Another run took over publishing this job/);
      await steps.hubFailStep(jobId, first.claim, "the old run's failure");
      assert.equal((await hubOf(jobId))!.status, "publishing", "the old run can't fail the new one");
      await steps.hubStoryStep(jobId, second.claim);
      await steps.hubDatasetStep(jobId, second.claim);
      await steps.hubModelStep(jobId, second.claim);
      await steps.hubFinishStep(jobId, second.claim);
      assert.equal((await hubOf(jobId))!.status, "published");
      await assert.rejects(steps.hubFinishStep(jobId, first.claim), /Another run took over/, "nor change it after");
    });

    it("waits, without a claim, for a job that isn't judged or whose files aren't all up", async () => {
      const running = await makeJob();
      assert.deepEqual(await steps.hubPlanStep(running, "succeeded"), { action: "none" }, "not judged");
      const noFiles = await makeJob();
      await judged(noFiles);
      assert.deepEqual(await steps.hubPlanStep(noFiles, "succeeded"), { action: "none" });
      assert.deepEqual([(await hubOf(noFiles))?.status, (await hubOf(noFiles))?.reason], ["waiting", steps.NOT_UPLOADED]);
      // A job started with publish 0 never uploads (the plan route skips it), so here its files are made up there.
      const off = await uploadedJudgedJob();
      await testDb.update(realSchema.trainingJobs).set({ params: { datasetId: DATASET_ID, publish: 0, dryRun: 0 } }).where(eq(realSchema.trainingJobs.id, off));
      assert.deepEqual(await steps.hubPlanStep(off, "succeeded"), { action: "none" }, "publish 0");
      const pressed = await steps.hubPlanStep(off, "succeeded", true);
      assert.deepEqual([pressed.action, pressed.action === "publish" ? pressed.jobId : null], ["publish", off], "unless an admin presses Publish");
      assert.match(pressed.action === "publish" ? pressed.claim : "", /^[0-9a-f-]{36}$/, "with the claim's id");
      assert.equal((await hubOf(off))!.claim, pressed.action === "publish" ? pressed.claim : null);
      assert.deepEqual(await steps.hubPlanStep(off, "succeeded", true), { action: "none" }, "the claim is taken once");
    });

    it("never publishes a decision model, not even on an admin's Publish, and its GPU uploads nothing", async () => {
      const decided = { items: 2, tunedWins: 1, baseWins: 0, ties: 1, avgBaseScore: 0, avgTunedScore: 0, judgeCostUsd: 0, kind: "decision" };
      const paramsList: Array<Record<string, string | number>> = [
        { datasetId: DATASET_ID, mode: "decide", epochs: 2, learningRate: 0.0002, loraRank: 16, scoreOnly: 0, dryRun: 0, publish: 0 },
        { datasetId: DATASET_ID, mode: "decide", epochs: 2, dryRun: 0 },
      ];
      for (const params of paramsList) {
        const jobId = await makeJob({ params });
        const plan = await gpuUpload(jobId, TOKEN, adapterFolder());
        assert.equal(plan.status, 200);
        assert.equal(plan.plan.skip, "Publish to Hugging Face is 0 for this job.", "publish is 0 in decide mode, set or not");
        await judged(jobId);
        await testDb.update(realSchema.trainingJobs).set({ evalSummary: decided }).where(eq(realSchema.trainingJobs.id, jobId));
        const before = await hubOf(jobId);
        assert.deepEqual(await steps.hubPlanStep(jobId, "succeeded"), { action: "none" });
        assert.deepEqual(await steps.hubPlanStep(jobId, "succeeded", true), { action: "none" }, "an admin's Publish too");
        assert.deepEqual(await hubOf(jobId), before, "no claim, no waiting state");
        const res = await publishPost(
          new Request(`https://muse.example.com/api/train/jobs/${jobId}/publish`, { method: "POST", body: "{}" }),
          { params: Promise.resolve({ id: jobId }) },
        );
        assert.equal(res.status, 409);
        assert.deepEqual(await res.json(), {
          error: "not_publishable",
          reason: "It is a decision model, and publishing one (the adapter alone, with a decision card, never the person's rows) isn't built yet.",
        });
      }
      assert.equal(started.length, 0, "no upload job, no workflow");
      assert.equal(fake.repos.size, 0, "nothing reached the Hub");
    });

    it("fails publishing when the Hub lost an object, so Publish uploads it again with a glimmer-publish job", async () => {
      const jobId = await uploadedJudgedJob();
      const hub = (await hubOf(jobId))!;
      const repo = fake.repo("model", hub.modelRepo!)!;
      repo.objects.delete(hub.files!.find((f) => f.path === "tokenizer.model")!.sha256);
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: false });
      const failed = (await hubOf(jobId))!;
      assert.equal(failed.status, "failed");
      assert.match(failed.reason!, /^Publishing to Hugging Face failed: Hugging Face doesn't have tokenizer\.model in .+'s storage\. Publish uploads it again\.$/);
      assert.equal(failed.uploaded!.length, 1);
      assert.equal(repo.commits.length, 0, "nothing was committed");

      // Publish: the files aren't all up, so a glimmer-publish job starts through POST /api/train/jobs.
      await store.recordSweepOk(new Date());
      const ctx = { params: Promise.resolve({ id: jobId }) };
      const res = await publishPost(new Request(`https://muse.example.com/api/train/jobs/${jobId}/publish`, { method: "POST", body: "{}" }), ctx);
      assert.equal(res.status, 202, await res.clone().text());
      const body = (await res.json()) as { started: string; publishJobId: string; hub: { status: string; publishJobId: string } };
      assert.equal(body.started, "upload");
      const publishJob = (await store.getJob(body.publishJobId))!;
      assert.deepEqual([publishJob.recipe, publishJob.region, publishJob.params], ["glimmer-publish", "us-east-1", { adapterJobId: jobId }]);
      assert.deepEqual(started.map((s) => s.fn), ["trainJob"]);
      assert.deepEqual([body.hub.status, body.hub.publishJobId], ["waiting", publishJob.id]);
      const again = await publishPost(new Request(`https://muse.example.com/api/train/jobs/${jobId}/publish`, { method: "POST", body: "{}" }), ctx);
      assert.equal(again.status, 409, "one upload job at a time");

      // Its GPU uploads with its own token, for the adapter job only.
      await testDb.update(realSchema.trainingJobs).set({ status: "running", tokenHash: hashToken(PUBLISH_TOKEN) }).where(eq(realSchema.trainingJobs.id, publishJob.id));
      const upload = await gpuUpload(publishJob.id, PUBLISH_TOKEN, adapterFolder());
      assert.equal(upload.plan.repo, hub.modelRepo);
      assert.deepEqual((upload.plan.uploads as Array<{ path: string; transfer: string }>).map((u) => [u.path, u.transfer]), [
        ["adapter_model.safetensors", "none"],
        ["tokenizer.model", "basic"],
      ]);
      assert.equal((await hubOf(jobId))!.status, "uploaded", "the adapter job's state, not the publish job's");
      assert.equal(await hubOf(publishJob.id), null);

      // Its workflow ends: it succeeded, so the adapter job is published.
      await testDb.update(realSchema.trainingJobs).set({ status: "succeeded", terminatedAt: new Date() }).where(eq(realSchema.trainingJobs.id, publishJob.id));
      const plan = await steps.hubPlanStep(publishJob.id, "succeeded");
      assert.ok(plan.action === "publish" && plan.jobId === jobId, JSON.stringify(plan));
      await steps.hubStoryStep(jobId, plan.claim);
      await steps.hubDatasetStep(jobId, plan.claim);
      await steps.hubModelStep(jobId, plan.claim);
      await steps.hubFinishStep(jobId, plan.claim);
      assert.equal((await hubOf(jobId))!.status, "published");
      assert.equal((await hubOf(jobId))!.claim, null, "the claim is let go");
      assert.equal(repo.commits.length, 1);
    });

    it("marks the upload failed when the glimmer-publish job ends without succeeding", async () => {
      const jobId = await makeJob();
      await judged(jobId);
      const publishJob = await store.createJob({ recipe: "glimmer-publish", title: "Publish to Hugging Face: x", params: { adapterJobId: jobId }, instanceType: "gpu_1x_rtx6000", region: "us-east-1", priceCentsPerHour: 50, maxMinutes: 20, maxUsd: 1 });
      await store.updateHub(jobId, () => ({ status: "waiting", reason: "Uploading.", publishJobId: publishJob.id }));
      assert.deepEqual(await steps.hubPlanStep(publishJob.id, "failed"), { action: "none" });
      const hub = (await hubOf(jobId))!;
      assert.equal(hub.status, "failed");
      assert.match(hub.reason!, /ended as failed before the adapter's files were all on Hugging Face/);
    });
  });

  describe("the store's hub state", () => {
    it("lands writers at once without losing one, and hands a claim to one of them", async () => {
      const jobId = await makeJob();
      await store.updateHub(jobId, () => ({ status: "uploading", uploaded: [] }));
      // They all read the same state; the ones that lose the race read it again and land after.
      await Promise.all(["a", "b", "c"].map((x) => store.updateHub(jobId, (h) => ({ ...h!, uploaded: [...(h!.uploaded ?? []), x.repeat(64)] }))));
      assert.deepEqual((await hubOf(jobId))!.uploaded!.slice().sort(), ["a".repeat(64), "b".repeat(64), "c".repeat(64)]);
      const claims = await Promise.all(
        [1, 2, 3].map(() => store.updateHub(jobId, (h) => (h?.status === "publishing" ? null : { ...h!, status: "publishing" }))),
      );
      assert.equal(claims.filter(Boolean).length, 1, "one claim");
      assert.equal(await store.updateHub("not-a-uuid", () => ({ status: "off" })), null);
      assert.equal(await store.updateHub("8f1d2c3b-0000-4000-8000-00000000dead", () => ({ status: "off" })), null);
      assert.equal((await store.getJob(jobId))!.status, "running", "never the job's status");
    });

    it("gives the Lab reads the links only once published and public", async () => {
      const jobId = await makeJob();
      await judged(jobId);
      const links = async () => (await store.getResultJob(jobId))?.hubLinks ?? null;
      assert.equal(await links(), null);
      await store.updateHub(jobId, () => ({ status: "published", public: false, modelUrl: "https://huggingface.co/m", datasetUrl: null, reason: "private" }));
      assert.equal(await links(), null, "private repos");
      await store.updateHub(jobId, (h) => ({ ...h!, public: true }));
      assert.deepEqual(await links(), { status: "published", modelUrl: "https://huggingface.co/m", datasetUrl: null });
      assert.deepEqual((await store.listResultJobs())[0]!.hubLinks, { status: "published", modelUrl: "https://huggingface.co/m", datasetUrl: null });
    });
  });

  describe("POST and GET /api/train/jobs/{id}/publish", () => {
    const req = (jobId: string, body: unknown = {}) =>
      publishPost(new Request(`https://muse.example.com/api/train/jobs/${jobId}/publish`, { method: "POST", body: JSON.stringify(body) }), {
        params: Promise.resolve({ id: jobId }),
      });

    it("never publishes a job trained on a product owner's private rows", async () => {
      const owned = await store.createDataset({ title: "Private", task: "t", requested: 20, writerModel: "person", productId: "cccccccc-0000-4000-8000-000000000011" });
      const job = await makeJob({ params: { datasetId: owned.id, dryRun: 0, publish: 1 } });
      await judged(job);
      const res = await req(job);
      assert.equal(res.status, 409);
      assert.match(((await res.json()) as { reason: string }).reason, /private rows/);
    });

    it("keeps a product owner's private rows off the Hub on every other route too", async () => {
      const owned = await store.createDataset({ title: "Private", task: "t", requested: 20, writerModel: "person", productId: "cccccccc-0000-4000-8000-000000000011" });
      const job = await makeJob({ params: { datasetId: owned.id, dryRun: 0, publish: 1 } });
      await judged(job);

      // The platform's own publish after training, and an admin's.
      assert.deepEqual(await steps.hubPlanStep(job, "succeeded"), { action: "none" });
      assert.deepEqual(await steps.hubPlanStep(job, "succeeded", true), { action: "none" });

      // The adapter job's own upload plan, on a GPU that's already running.
      await testDb.update(realSchema.trainingJobs).set({ status: "running", tokenHash: hashToken(TOKEN) }).where(eq(realSchema.trainingJobs.id, job));
      const own = await gpuUpload(job, TOKEN, adapterFolder());
      assert.match(String(own.plan.skip), /private rows/);
      await judged(job);

      // Launching glimmer-publish directly names the adapter, and is refused before any GPU.
      const { launchJob } = await import("@/lib/train/launch");
      const launched = await launchJob({ recipe: "glimmer-publish", title: "Publish to Hugging Face: x", params: { adapterJobId: job } }, { userId: "owner-rows-test" });
      assert.equal(launched.ok, false);
      assert.match(launched.ok ? "" : launched.code, /private rows/);

      // A glimmer-publish job that exists anyway gets no upload plan and no claim.
      const publishJob = await store.createJob({ recipe: "glimmer-publish", title: "Publish to Hugging Face: x", params: { adapterJobId: job }, instanceType: "gpu_1x_rtx6000", region: "us-east-1", priceCentsPerHour: 50, maxMinutes: 20, maxUsd: 1 });
      await testDb.update(realSchema.trainingJobs).set({ status: "running", tokenHash: hashToken(PUBLISH_TOKEN) }).where(eq(realSchema.trainingJobs.id, publishJob.id));
      const upload = await gpuUpload(publishJob.id, PUBLISH_TOKEN, adapterFolder());
      assert.match(String(upload.plan.skip), /private rows/);
      assert.deepEqual(await steps.hubPlanStep(publishJob.id, "succeeded"), { action: "none" });

      assert.equal(fake.repos.size, 0, "nothing reached the Hub");

      // Files uploaded before their dataset was known to be a product's: the claim is the last check, and it holds.
      const early = await makeJob();
      await gpuUpload(early, TOKEN, adapterFolder());
      await judged(early);
      await testDb.update(realSchema.trainingJobs).set({ params: { datasetId: owned.id, dryRun: 0, publish: 1 } }).where(eq(realSchema.trainingJobs.id, early));
      assert.deepEqual(await steps.hubPlanStep(early, "succeeded", true), { action: "none" });
      assert.notEqual((await hubOf(early))!.status, "publishing");
    });

    it("refuses what can't be published, with the reason", async () => {
      const running = await makeJob();
      const res = await req(running);
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "not_publishable", reason: "It didn't succeed, so it has no adapter to publish." });
      assert.equal((await req("8f1d2c3b-0000-4000-8000-00000000dead")).status, 404);
      const done = await makeJob();
      await judged(done);
      delete process.env.HF_TOKEN;
      const off = await req(done);
      assert.equal(off.status, 503);
      assert.deepEqual(await off.json(), { error: "hub_off", reason: "HF_TOKEN isn't set" });
      process.env.HF_TOKEN = HF_TOKEN;
      await store.updateHub(done, (h) => ({ ...(h ?? {}), status: "publishing", updatedAt: new Date().toISOString() }));
      assert.equal((await req(done)).status, 409);
      assert.equal((await req(done, { why: 5 })).status, 400);
      assert.equal((await req(done, { why: "x".repeat(2001) })).status, 400);
      assert.equal(started.length, 0);
    });

    it("answers where it stands, never the small files", async () => {
      const jobId = await makeJob();
      await gpuUpload(jobId, TOKEN, adapterFolder());
      const res = await publishGet(new Request(`https://muse.example.com/api/train/jobs/${jobId}/publish`), { params: Promise.resolve({ id: jobId }) });
      const body = (await res.json()) as { hub: Record<string, unknown>; offReason: null };
      assert.equal(body.offReason, null);
      assert.equal(body.hub.status, "uploaded");
      assert.deepEqual([body.hub.filesUploaded, body.hub.filesTotal], [2, 2]);
      assert.doesNotMatch(JSON.stringify(body), /base_model_name_or_path|bos_token|e30=/);
    });

    it("clears a why the job started with, and pays for no new story when the why is the one the card has", async () => {
      const why = "Internal: for the Acme pilot, don't share";
      const jobId = await makeJob({ params: { datasetId: DATASET_ID, studentPrompt: "short", dryRun: 0, publish: 1, why } });
      await gpuUpload(jobId, TOKEN, adapterFolder());
      await judged(jobId);
      await wf.publishToHub({ jobId });
      assert.equal(storyCalls, 1);
      // The card's textarea starts with the why the card prints, so pressing Publish with it changes nothing.
      assert.equal((await req(jobId, { why })).status, 202);
      await wf.publishToHub({ jobId });
      assert.equal(storyCalls, 1, "the same why, so the same story");
      // An empty why clears it, the param's too.
      assert.equal((await req(jobId, { why: "   " })).status, 202);
      assert.equal((await hubOf(jobId))!.why, "");
      await wf.publishToHub({ jobId });
      const hub = (await hubOf(jobId))!;
      assert.doesNotMatch(fake.repo("model", hub.modelRepo!)!.files.get("README.md")!.content!.toString(), /Acme/);
      assert.doesNotMatch(fake.repo("dataset", hub.datasetRepo!)!.files.get("README.md")!.content!.toString(), /Acme/);
      const got = (await (await publishGet(new Request(`https://muse.example.com/api/train/jobs/${jobId}/publish`), { params: Promise.resolve({ id: jobId }) })).json()) as { hub: { why: string | null } };
      assert.equal(got.hub.why, null, "the card's textarea starts empty");
    });

    it("starts one upload job for two presses at once", async () => {
      process.env.TRAIN_MAX_ACTIVE = "3";
      const jobId = await makeJob();
      await judged(jobId);
      await store.recordSweepOk(new Date());
      const [a, b] = await Promise.all([req(jobId), req(jobId)]);
      assert.deepEqual([a.status, b.status].sort(), [202, 409], `${await a.clone().text()} ${await b.clone().text()}`);
      const loser = (await (a.status === 409 ? a : b).json()) as { error: string };
      assert.equal(loser.error, "upload_running");
      assert.equal((await store.listJobs(50)).filter((j) => j.recipe === "glimmer-publish").length, 1);
      assert.equal(started.filter((x) => x.fn === "trainJob").length, 1);
      assert.equal((await hubOf(jobId))!.uploadStartingAt, null, "the press let its claim go once the job started");
    });

    it("asks the Hub before it pays for an upload job, and starts none when the token can't write there", async () => {
      const jobId = await makeJob();
      await judged(jobId);
      await store.recordSweepOk(new Date());
      fake.fail(/^\/api\/repos\/create$/, [403], { error: "You don't have the rights to create a model under the namespace" });
      const res = await req(jobId);
      assert.equal(res.status, 409);
      const body = (await res.json()) as { error: string; reason: string };
      assert.equal(body.error, "hub_refused");
      assert.match(body.reason, /HTTP 403, You don't have the rights .* Check that HF_TOKEN can write repos under HF_NAMESPACE\.$/);
      assert.equal(started.length, 0);
      assert.equal((await store.listJobs(50)).filter((j) => j.recipe === "glimmer-publish").length, 0);
      assert.equal((await hubOf(jobId))?.uploadStartingAt ?? null, null);
    });
  });
});
