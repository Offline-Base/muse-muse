/**
 * A judged adapter's local files end to end (docs/TRAINING.md "Local files"), with nothing real but the code under
 * test: the store on an in-memory PGlite with the repo's migrations, the fake Hub (fake-hub.ts) through HF_ENDPOINT, the
 * real hub, publish, dataset, quantize and jobs routes, the real steps and publishToHub, Muse Spark 1.3 and Lambda's
 * capacity faked, and a fake GPU in TypeScript doing what runner.py's hub_upload does.
 *
 * The GPU's plan for a glimmer-quantize job: it acts for itself, only its builds and small files are taken, each build up
 * to 32 GB, the small files checked byte for byte before anything uploads, a plan whose part URLs would pass about
 * 3.5 MB answered 413 so the GPU plans one file at a time (and one file that alone passes it refused), and the report.
 * Publishing: gated on the job's checks and its adapter's state, the GGUF repo committed and read back with its card,
 * its LICENSE and its record, public beside a public adapter and private otherwise, the adapter's card given a
 * README-only commit that points to it, nothing committed twice. An adapter made private takes its GGUF repo with it,
 * a public card never names a private repo, a second job's failed publishing never takes a published repo off the
 * public pages, and a repo published while the adapter itself was publishing still gets the pointer. Make local files
 * (GET and POST /api/train/jobs/{id}/quantize) and the jobs route's checks and platform-written params, the dataset
 * route's pages with the adapter's own answers, and localFilesFor. Nothing here reaches Neon, Lambda, Meta or the real
 * Hub.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/gguf-flow.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import type { HubState, TrainEventBody } from "../types";
import { startFakeHub, type FakeHub } from "./fake-hub";

/** Test values, not real secrets. */
const HF_TOKEN = "hf_test_gguf_token_000000000000000000";
const TOKEN = "job-token-of-the-adapter-job";
const QUANT_TOKEN = "job-token-of-the-quantize-job";
const GB = 1024 ** 3;
const canMock = typeof (mock as { module?: unknown }).module === "function";
const savedEnv = { ...process.env };
const META = readFileSync(new URL("./fixtures/meta-chat-template.jinja", import.meta.url), "utf8");
const TUNED = META.replace("else 'high' -%}", "else 'low' -%}").replace(
  "{%- if add_generation_prompt -%}\n    {{- '<|start|>assistant' -}}\n{%- endif -%}",
  "{%- if add_generation_prompt -%}\n    {{- '<|start|>assistant to=user<|message|>' -}}\n{%- endif -%}",
);

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
let quantGet: Handler;
let quantPost: Handler;
let datasetGet: Handler;
let store: typeof import("../store");
let wf: typeof import("../workflow");
let cards: typeof import("../hub-cards");
let localFilesFor: typeof import("../local-files-server").localFilesFor;
let hashToken: (t: string) => string;
let started: Array<{ fn: string; args: unknown[] }> = [];

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const ROLE = "You are Muse Muse's brief writer.";
const DATASET_ID = "1b2c3d4e-0000-4000-8000-000000000002";
const SYSTEM = "You are an assistant for this task: Write a short app brief.\n\nAnswer the user's message directly and well.";

function req(url: string, init: RequestInit & { token?: string } = {}): Request {
  const { token, ...rest } = init;
  return new Request(`https://muse.example.com${url}`, {
    ...rest,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(rest.headers ?? {}) },
  });
}
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

/** The adapter folder a glimmer-lora run saves, roughly. */
function adapterFolder(): Map<string, Buffer> {
  return new Map([
    ["adapter_model.safetensors", randomBytes(40 * 1024)],
    ["adapter_config.json", Buffer.from(JSON.stringify({ base_model_name_or_path: "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit", r: 16, revision: "ecedda395d4d099b477d135a9a573eedaa5a7aad" }, null, 2))],
    ["tokenizer_config.json", Buffer.from(JSON.stringify({ bos_token: "<|begin_of_text|>" }))],
  ]);
}

/** A quantize job's GGUF folder, as QUANT_PY leaves it: the builds that passed and the small files the platform checks. */
function ggufFolder(slug = "brief-writer", levels = ["Q3_K_M", "Q4_K_M", "Q6_K"], channel: 0 | 1 = 0): Map<string, Buffer> {
  const files = new Map<string, Buffer>(levels.map((l, i) => [`muse-glimmer-30b-${slug}-${l}.gguf`, Buffer.concat([Buffer.from("GGUF\x03\x00\x00\x00"), randomBytes(20_000 + i * 5_000)])]));
  files.set("system", Buffer.from(`${ROLE}\n\nReasoning strength: low.`));
  files.set("params", Buffer.from(cards.ggufParams(channel)));
  if (channel === 0) files.set("tuned.jinja", Buffer.from(TUNED));
  return files;
}

const SMALL = new Set(["system", "params", "tuned.jinja", "adapter_config.json", "tokenizer_config.json"]);

function planBody(folder: Map<string, Buffer>, only?: string[], sizes: Record<string, number> = {}) {
  return {
    action: "plan",
    files: [...folder].map(([path, b]) => ({ path, size: sizes[path] ?? b.length, sha256: sha(b), sample: b.subarray(0, 512).toString("base64") })),
    small: Object.fromEntries([...folder].filter(([n]) => SMALL.has(n)).map(([n, b]) => [n, b.toString("base64")])),
    ...(only ? { only } : {}),
  };
}

/** What runner.py's hub_upload does: the plan (one file at a time after a 413 plan_too_large), the bytes, the report. */
async function gpuUpload(jobId: string, token: string, folder: Map<string, Buffer>): Promise<{ status: number; plans: number; done?: number; body: Record<string, unknown> }> {
  let res = await hubRoute(req(`/api/train/jobs/${jobId}/hub`, { method: "POST", token, body: JSON.stringify(planBody(folder)) }), ctx(jobId));
  let body = (await res.json()) as Record<string, unknown>;
  const answers: Array<Record<string, unknown>> = [];
  let plans = 1;
  if (res.status === 413 && body.error === "plan_too_large") {
    for (const name of folder.keys()) {
      res = await hubRoute(req(`/api/train/jobs/${jobId}/hub`, { method: "POST", token, body: JSON.stringify(planBody(folder, [name])) }), ctx(jobId));
      plans += 1;
      body = (await res.json()) as Record<string, unknown>;
      if (res.status !== 200) return { status: res.status, plans, body };
      answers.push(body);
    }
  } else {
    if (res.status !== 200 || body.skip) return { status: res.status, plans, body };
    answers.push(body);
  }
  const uploaded: Array<{ path: string; oid: string; size: number }> = [];
  for (const plan of answers) {
    for (const u of plan.uploads as Array<Record<string, unknown>>) {
      const data = folder.get(String(u.path))!;
      if (u.transfer === "basic") {
        assert.equal((await fetch(String(u.href), { method: "PUT", body: data as unknown as BodyInit })).status, 200);
      } else if (u.transfer === "multipart") {
        const chunk = Number(u.chunkSize);
        const etags: Array<{ partNumber: number; etag: string }> = [];
        for (const p of u.parts as Array<{ partNumber: number; url: string }>) {
          const put = await fetch(p.url, { method: "PUT", body: data.subarray((p.partNumber - 1) * chunk, p.partNumber * chunk) as unknown as BodyInit });
          etags.push({ partNumber: p.partNumber, etag: put.headers.get("etag")! });
        }
        await fetch(String(u.completionUrl), { method: "POST", headers: { accept: "application/vnd.git-lfs+json", "content-type": "application/vnd.git-lfs+json" }, body: JSON.stringify({ oid: u.oid, parts: etags }) });
      }
      uploaded.push({ path: String(u.path), oid: String(u.oid), size: Number(u.size) });
    }
  }
  const done = await hubRoute(req(`/api/train/jobs/${jobId}/hub`, { method: "POST", token, body: JSON.stringify({ action: "done", uploaded, failed: [] }) }), ctx(jobId));
  return { status: res.status, plans, done: done.status, body };
}

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

async function makeJob(recipe: "glimmer-lora" | "glimmer-quantize", params: Record<string, string | number>, token: string, over: Partial<typeof realSchema.trainingJobs.$inferInsert> = {}): Promise<string> {
  const row = await store.createJob({ recipe, title: recipe === "glimmer-lora" ? "Brief writer LoRA" : "Local files: Brief writer LoRA", params, instanceType: "gpu_1x_a100_sxm4", region: "us-east-1", priceCentsPerHour: 199, maxMinutes: 110, maxUsd: 3.7 });
  await testDb
    .update(realSchema.trainingJobs)
    .set({ status: "running", tokenHash: hashToken(token), launchedAt: new Date(Date.now() - 40 * 60_000), ...over })
    .where(eq(realSchema.trainingJobs.id, row.id));
  return row.id;
}

const log = (jobId: string, payload: TrainEventBody) => testDb.insert(realSchema.trainingEvents).values({ jobId, type: payload.type, payload });

/** A glimmer-lora job judged, its adapter on the region's cache, and published on the fake Hub (public by default). */
async function publishedAdapter(over: Record<string, string | number> = {}): Promise<string> {
  const jobId = await makeJob("glimmer-lora", { datasetId: DATASET_ID, maxSteps: 120, learningRate: 0.0002, loraRank: 16, studentPrompt: "short", dryRun: 0, publish: 1, ...over }, TOKEN);
  const up = await gpuUpload(jobId, TOKEN, adapterFolder());
  assert.equal(up.done, 204, JSON.stringify(up.body));
  await log(jobId, { type: "eval", index: 0, prompt: "Held out 0", reference: "Reference 0", base: "I can't.", tuned: "**Name:** Pier Gull Counter" });
  await log(jobId, { type: "eval", index: 1, prompt: "Held out 1", reference: "Reference 1", base: "Maybe.", tuned: "**Name:** Bakery Board" });
  await log(jobId, { type: "judgement", index: 0, baseScore: 2, tunedScore: 9, better: "tuned", note: "Full brief." });
  await log(jobId, { type: "judgement", index: 1, baseScore: 3, tunedScore: 8, better: "tuned", note: "Names the models." });
  await log(jobId, {
    type: "done",
    summary: "LoRA r=16",
    metrics: { student_prompt: "short", student_system: ROLE, cache_used: "yes", adapter_dir: `/lambda/nfs/muse-muse-cache-us-east-1/models/${jobId}`, steps: 120, train_examples: 12 },
  });
  await testDb
    .update(realSchema.trainingJobs)
    .set({ status: "succeeded", finishedAt: new Date(), terminatedAt: new Date(), costUsd: 1.39, evalSummary: { items: 2, tunedWins: 2, baseWins: 0, ties: 0, avgBaseScore: 2.5, avgTunedScore: 8.5, judgeCostUsd: 0.01 } })
    .where(eq(realSchema.trainingJobs.id, jobId));
  assert.deepEqual(await wf.publishToHub({ jobId }), { published: true });
  return jobId;
}

const quantParams = (adapterJobId: string, over: Record<string, string | number> = {}) => ({ adapterJobId, publish: 1, levels: "Q3_K_M,Q4_K_M,Q6_K", slug: "brief-writer", trainChannel: 0, ...over });

/** The done metrics QUANT_PY reports for a folder whose builds all passed. */
function quantMetrics(folder: Map<string, Buffer>, over: Record<string, string | number> = {}): Record<string, string | number> {
  const m: Record<string, string | number> = { checks_passed: "yes", hub_uploaded: "yes", system: ROLE, train_channel: 0, channel_final: 2, channel_total: 2, agreement: 2, agreement_total: 2, tensors: 1436, llamacpp: "b11669", llamacpp_commit: "620d2225cc436ab0b001e3200e590e3b286ef9ab", merge_base: "unsloth/Muse-Glimmer-30B", merge_base_revision: "c".repeat(40) };
  for (const [name, bytes] of folder) {
    const level = /-(Q3_K_M|Q4_K_M|Q6_K)\.gguf$/.exec(name)?.[1];
    if (!level) continue;
    const k = level.toLowerCase();
    Object.assign(m, { [`${k}_passed`]: "yes", [`${k}_bytes`]: bytes.length, [`${k}_sha256`]: sha(bytes), [`${k}_kl_mean`]: 0.01, [`${k}_kl_p99`]: 0.1, [`${k}_top_token_pct`]: 95 });
  }
  return { ...m, ...over };
}

/** The quantize job as its runner and the workflow leave it: done with metrics, succeeded, its GPU shut down. */
async function finished(jobId: string, metrics: Record<string, string | number>): Promise<void> {
  await log(jobId, { type: "done", summary: "Local files", metrics });
  await testDb.update(realSchema.trainingJobs).set({ status: "succeeded", finishedAt: new Date(), terminatedAt: new Date(), costUsd: 2.59 }).where(eq(realSchema.trainingJobs.id, jobId));
}

const hubOf = async (jobId: string): Promise<HubState | null> => (await store.getJob(jobId))?.hub ?? null;
const logOf = async (jobId: string) => (await store.listEvents(jobId)).filter((e) => e.payload.type === "log").map((e) => (e.payload as { text: string }).text);

describe("local files: a judged adapter's GGUF repo", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
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
    fake = await startFakeHub({ token: HF_TOKEN, multipartOver: 24 * 1024, chunkSize: 16 * 1024 });

    const at = (rel: string) => new URL(rel, import.meta.url).href;
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
      namedExports: { ...realAuth, requireAdminOrAutomation: async () => ({ id: await adminId(), email: "owner@example.com", isAdmin: true }) },
    });
    mock.module(at("../../quota.ts"), { namedExports: { ...realQuota, spendPaused: async () => false } });
    mock.module(at("../lambda.ts"), {
      namedExports: {
        ...realLambda,
        listInstanceTypes: async () => [
          { name: "gpu_1x_a100_sxm4", description: "1x A100 SXM4 (40 GB)", priceCentsPerHour: 199, gpus: 1, regionsWithCapacity: ["us-east-1"] },
          { name: "gpu_1x_rtx6000", description: "1x RTX 6000 (24 GB)", priceCentsPerHour: 50, gpus: 1, regionsWithCapacity: ["us-east-1"] },
        ],
        cacheRegions: async () => ["us-east-1"],
      },
    });
    mock.module(at("../../meta/platform.ts"), {
      namedExports: {
        metaPlatform: () => ({
          responses: {
            create: async () => ({ status: "completed", output_text: "Muse Muse made this adapter so the brief writer's task can run on a model you host yourself.", usage: { input_tokens: 900, output_tokens: 80 } }),
          },
        }),
      },
    });
    store = await import("../store");
    wf = await import("../workflow");
    cards = await import("../hub-cards");
    ({ localFilesFor } = await import("../local-files-server"));
    ({ hashToken } = await import("../../gateway/tokens"));
    ({ POST: hubRoute } = await import(at("../../../app/api/train/jobs/[id]/hub/route.ts")));
    ({ POST: publishPost, GET: publishGet } = await import(at("../../../app/api/train/jobs/[id]/publish/route.ts")));
    ({ POST: quantPost, GET: quantGet } = await import(at("../../../app/api/train/jobs/[id]/quantize/route.ts")));
    ({ GET: datasetGet } = await import(at("../../../app/api/train/jobs/[id]/dataset/route.ts")));
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
    fake.multipartOver = 24 * 1024;
    fake.chunkSize = 16 * 1024;
    started = [];
    Object.assign(process.env, {
      HF_TOKEN,
      HF_NAMESPACE: "muse-org",
      HF_ENDPOINT: fake.url,
      MODEL_API_KEY: "test-value-not-a-key",
      GATEWAY_TOKEN_PEPPER: "test-pepper-for-gguf-tests",
      PLATFORM_URL: "https://muse.example.com",
      LAMBDA_API_KEY: "test-value-not-a-key",
      CRON_SECRET: "test-cron",
      VERCEL_ENV: "production",
      ADMIN_EMAILS: "owner@example.com",
      QUANT_ENABLED: "1",
      TRAIN_MAX_ACTIVE: "5",
    });
    delete process.env.HF_PUBLIC;
    const { hubTiming } = await import("../hub");
    Object.assign(hubTiming, { timeoutMs: 2000, retries: 1, retryBaseMs: 1, retryMaxMs: 5 });
    await makeDataset();
  });

  describe("the GPU's plan", () => {
    it("acts for the job itself: its builds through the LFS bridge, its small files kept, and the report", async () => {
      const adapterId = await publishedAdapter();
      const jobId = await makeJob("glimmer-quantize", quantParams(adapterId), QUANT_TOKEN);
      const folder = ggufFolder();
      folder.set("bf16.gguf", Buffer.from("GGUF the conversion"));
      folder.set("muse-glimmer-30b-brief-writer-Q8_0.gguf", Buffer.from("GGUF the reference"));
      folder.set("README.md", Buffer.from("# not ours"));
      const up = await gpuUpload(jobId, QUANT_TOKEN, folder);
      assert.equal(up.status, 200, JSON.stringify(up.body));
      assert.equal(up.done, 204);
      const repo = `muse-org/muse-glimmer-30b-brief-writer-gguf-${adapterId.slice(0, 8)}`;
      assert.equal(up.body.repo, repo, "named after the adapter's repo, the training job's id last");
      assert.deepEqual(
        (up.body.uploads as Array<{ path: string; transfer: string }>).map((u) => [u.path, u.transfer]),
        [
          ["muse-glimmer-30b-brief-writer-Q3_K_M.gguf", "basic"],
          ["muse-glimmer-30b-brief-writer-Q4_K_M.gguf", "multipart"],
          ["muse-glimmer-30b-brief-writer-Q6_K.gguf", "multipart"],
        ],
        "only the builds get uploads; the reference, the conversion and a README stay out",
      );
      const hub = (await hubOf(jobId))!;
      assert.equal(hub.status, "uploaded");
      assert.equal(hub.uploaderJobId, jobId);
      assert.deepEqual(Object.keys(hub.small ?? {}).sort(), ["params", "system", "tuned.jinja"]);
      assert.deepEqual((hub.files ?? []).map((f) => f.path).sort(), [...folder.keys()].filter((n) => /-Q(3|4|6)_K(_M)?\.gguf$/.test(n)).sort());
      assert.equal((await hubOf(adapterId))!.status, "published", "the adapter's own state is never touched");
      assert.equal(fake.repo("model", repo)!.private, true, "made private");
      assert.ok((await logOf(jobId)).some((t) => /Hugging Face has all of the local files/.test(t)));
      assert.deepEqual(fake.leaks, []);
    });

    it("takes builds up to 32 GB, and refuses one bigger, a name or a small file that isn't the job's", async () => {
      const adapterId = await publishedAdapter();
      const jobId = await makeJob("glimmer-quantize", quantParams(adapterId), QUANT_TOKEN);
      const folder = ggufFolder();
      const q6 = "muse-glimmer-30b-brief-writer-Q6_K.gguf";
      const big = await hubRoute(req(`/api/train/jobs/${jobId}/hub`, { method: "POST", token: QUANT_TOKEN, body: JSON.stringify(planBody(folder, undefined, { [q6]: 32 * GB + 1 })) }), ctx(jobId));
      assert.equal(big.status, 413);
      assert.deepEqual(await big.json(), { error: "too_large", path: q6, maxBytes: 32 * GB });
      const unknown = await hubRoute(req(`/api/train/jobs/${jobId}/hub`, { method: "POST", token: QUANT_TOKEN, body: JSON.stringify(planBody(folder, ["nope.gguf"])) }), ctx(jobId));
      assert.equal(unknown.status, 400);

      const wrong = ggufFolder();
      wrong.set("system", Buffer.from("You are a helpful assistant.\n\nReasoning strength: low."));
      const res = await hubRoute(req(`/api/train/jobs/${jobId}/hub`, { method: "POST", token: QUANT_TOKEN, body: JSON.stringify(planBody(wrong)) }), ctx(jobId));
      assert.deepEqual(await res.json(), { skip: "The local files aren't published: its system file isn't the system message the adapter trained with." });
      assert.equal((await hubOf(jobId))!.status, "failed", "saved, so the job page says why");

      const bare = ggufFolder();
      bare.delete("tuned.jinja");
      const skip = await hubRoute(req(`/api/train/jobs/${jobId}/hub`, { method: "POST", token: QUANT_TOKEN, body: JSON.stringify(planBody(bare)) }), ctx(jobId));
      assert.deepEqual(await skip.json(), { skip: "tuned.jinja isn't in the plan's small files." }, "an adapter trained before trainChannel needs it");
      const noBuilds = new Map([...ggufFolder()].filter(([n]) => !n.endsWith(".gguf")));
      const none = await hubRoute(req(`/api/train/jobs/${jobId}/hub`, { method: "POST", token: QUANT_TOKEN, body: JSON.stringify(planBody(noBuilds)) }), ctx(jobId));
      assert.deepEqual(await none.json(), { skip: "The folder has none of the job's GGUF builds." });
      // A glimmer-lora job's GPU can't send a GGUF build, and an adapter's file keeps its 10 GB cap.
      const lora = await makeJob("glimmer-lora", { datasetId: DATASET_ID, studentPrompt: "short", dryRun: 0, publish: 1 }, TOKEN);
      const asAdapter = await hubRoute(req(`/api/train/jobs/${lora}/hub`, { method: "POST", token: TOKEN, body: JSON.stringify(planBody(ggufFolder())) }), ctx(lora));
      assert.deepEqual(await asAdapter.json(), { skip: "The folder has no adapter_model.safetensors." });
      const heavy = await hubRoute(req(`/api/train/jobs/${lora}/hub`, { method: "POST", token: TOKEN, body: JSON.stringify(planBody(adapterFolder(), undefined, { "adapter_model.safetensors": 10 * GB + 1 })) }), ctx(lora));
      assert.equal(heavy.status, 413);
    });

    it("answers 413 plan_too_large when the part URLs would pass about 3.5 MB, so the GPU plans one file at a time", async () => {
      const adapterId = await publishedAdapter();
      const jobId = await makeJob("glimmer-quantize", quantParams(adapterId), QUANT_TOKEN);
      fake.multipartOver = 1024;
      fake.chunkSize = 1024 * 1024;
      const folder = ggufFolder();
      const sizes = Object.fromEntries([...folder.keys()].filter((n) => n.endsWith(".gguf")).map((n) => [n, 10 * GB]));
      const whole = await hubRoute(req(`/api/train/jobs/${jobId}/hub`, { method: "POST", token: QUANT_TOKEN, body: JSON.stringify(planBody(folder, undefined, sizes)) }), ctx(jobId));
      assert.equal(whole.status, 413);
      const body = (await whole.json()) as Record<string, unknown>;
      assert.deepEqual([body.error, body.perFile, body.maxBytes], ["plan_too_large", true, 3_500_000]);
      assert.equal(await hubOf(jobId), null, "a plan the GPU can't use isn't saved");
      for (const name of Object.keys(sizes)) {
        const one = await hubRoute(req(`/api/train/jobs/${jobId}/hub`, { method: "POST", token: QUANT_TOKEN, body: JSON.stringify(planBody(folder, [name], sizes)) }), ctx(jobId));
        assert.equal(one.status, 200, name);
        const text = await one.text();
        assert.ok(Buffer.byteLength(text) <= 3_500_000 && Buffer.byteLength(text) > 1_000_000, `${Buffer.byteLength(text)}`);
        const answer = JSON.parse(text) as { uploads: Array<{ path: string; parts: unknown[] }> };
        assert.deepEqual(answer.uploads.map((u) => u.path), [name], "only the file asked about");
        assert.equal(answer.uploads[0]!.parts.length, 10 * 1024);
      }
      const hub = (await hubOf(jobId))!;
      assert.equal(hub.files!.length, 3, "the plan the job keeps is still every build");
      assert.equal(hub.status, "uploading");
      // One 30 GB build alone passes it too, and one file's parts can't be paged.
      const huge = { ...sizes, "muse-glimmer-30b-brief-writer-Q6_K.gguf": 30 * GB };
      const alone = await hubRoute(req(`/api/train/jobs/${jobId}/hub`, { method: "POST", token: QUANT_TOKEN, body: JSON.stringify(planBody(folder, ["muse-glimmer-30b-brief-writer-Q6_K.gguf"], huge)) }), ctx(jobId));
      assert.equal(alone.status, 413);
      const refused = (await alone.json()) as Record<string, unknown>;
      assert.deepEqual([refused.error, refused.path, refused.parts, refused.perFile], ["plan_too_large", "muse-glimmer-30b-brief-writer-Q6_K.gguf", 30 * 1024, undefined]);
      assert.match(String(refused.message), /can't be paged yet/);
    });
  });

  describe("publishing", () => {
    async function uploadedQuant(adapterId: string, folder = ggufFolder(), over: Record<string, string | number> = {}): Promise<string> {
      const jobId = await makeJob("glimmer-quantize", quantParams(adapterId, over), QUANT_TOKEN);
      const up = await gpuUpload(jobId, QUANT_TOKEN, folder);
      assert.equal(up.done, 204, JSON.stringify(up.body));
      await finished(jobId, quantMetrics(folder));
      return jobId;
    }

    it("commits the GGUF repo with its card, reads it back, makes it public beside a public adapter, and points the adapter's card to it", async () => {
      const adapterId = await publishedAdapter();
      const adapterRepo = (await hubOf(adapterId))!.modelRepo!;
      const adapterCommits = fake.repo("model", adapterRepo)!.commits.length;
      const folder = ggufFolder();
      const jobId = await uploadedQuant(adapterId, folder);
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: true });
      const hub = (await hubOf(jobId))!;
      const repo = `muse-org/muse-glimmer-30b-brief-writer-gguf-${adapterId.slice(0, 8)}`;
      assert.equal(hub.status, "published");
      assert.equal(hub.public, true);
      assert.equal(hub.modelUrl, `${fake.url}/${repo}`);
      assert.match(hub.modelCommit!, /^[0-9a-f]{40}$/);
      const gguf = fake.repo("model", repo)!;
      assert.equal(gguf.private, false);
      assert.deepEqual([...gguf.files.keys()].sort(), [
        ".gitattributes",
        "LICENSE",
        "README.md",
        "muse-glimmer-30b-brief-writer-Q3_K_M.gguf",
        "muse-glimmer-30b-brief-writer-Q4_K_M.gguf",
        "muse-glimmer-30b-brief-writer-Q6_K.gguf",
        "muse_muse_quant.json",
        "params",
        "system",
        "tuned.jinja",
      ]);
      for (const [name, bytes] of folder) {
        if (name.endsWith(".gguf")) assert.deepEqual(gguf.files.get(name)!.lfs, { oid: sha(bytes), size: bytes.length }, name);
        else assert.ok(gguf.files.get(name)!.content!.equals(bytes), name);
      }
      const card = gguf.files.get("README.md")!.content!.toString();
      assert.match(card, /^---\nbase_model: meta-models\/Muse-Glimmer-30B\nbase_model_relation: finetune\n/);
      assert.ok(card.includes(`GGUF files of [${adapterRepo}](https://huggingface.co/${adapterRepo})`));
      assert.ok(card.includes(`- muse-org/muse-muse-brief-writer-1b2c3d4e`), "the dataset repo the adapter's run published");
      assert.ok(card.includes("gave a final answer to 2 of 2 held-out prompts"));
      assert.ok(card.includes(`at commit \`${(await hubOf(adapterId))!.modelCommit}\``), "the adapter at the commit that published it");
      const record = JSON.parse(gguf.files.get("muse_muse_quant.json")!.content!.toString()) as { builds: Array<{ level: string; sha256: string }> };
      assert.deepEqual(record.builds.map((b) => b.level), ["Q3_K_M", "Q4_K_M", "Q6_K"]);
      assert.match(gguf.files.get("LICENSE")!.content!.toString(), /Apache License/);
      assert.equal(gguf.commits.length, 1);
      assert.deepEqual(gguf.commits[0]!.lfsFiles.sort(), [...folder.keys()].filter((n) => n.endsWith(".gguf")).sort());

      // The adapter's card now points local apps to it, in one README-only commit.
      const adapter = fake.repo("model", adapterRepo)!;
      assert.equal(adapter.commits.length, adapterCommits + 1);
      assert.deepEqual(adapter.commits.at(-1)!.files, ["README.md"]);
      assert.deepEqual(adapter.commits.at(-1)!.lfsFiles, []);
      assert.ok(adapter.files.get("README.md")!.content!.toString().includes(`take [${repo}](https://huggingface.co/${repo})`));
      assert.ok((await logOf(jobId)).some((t) => t.startsWith(`Hugging Face: ${adapterRepo}'s card now points to ${repo}`)));

      // Publishing again commits nothing new, in either repo, and so does publishing the adapter again.
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: true });
      assert.equal(gguf.commits.length, 1);
      assert.equal(adapter.commits.length, adapterCommits + 1);
      assert.deepEqual(await wf.publishToHub({ jobId: adapterId }), { published: true });
      assert.equal(adapter.commits.length, adapterCommits + 1, "the adapter's own card keeps the pointer");

      const files = (await localFilesFor(adapterId))!;
      assert.deepEqual([files.repo, files.commit, files.public, files.quantJobId, files.needsTunedTemplate], [repo, hub.modelCommit, true, jobId, true]);
      assert.deepEqual(files.files.map((f) => [f.level, f.name, f.bytes, f.sha256]), [...folder].filter(([n]) => n.endsWith(".gguf")).map(([n, b]) => [/-(Q\d_K(?:_M)?)\.gguf$/.exec(n)![1], n, b.length, sha(b)]));
      assert.equal(files.systemLine, `${ROLE}\n\nReasoning strength: low.`);
      assert.deepEqual([files.title, files.slug], ["Muse Muse's brief writer", "brief-writer"]);
      const all = JSON.stringify(await store.listEvents(jobId)) + JSON.stringify(await store.getJob(jobId));
      assert.doesNotMatch(all, new RegExp(HF_TOKEN));
      assert.doesNotMatch(all, /X-Amz|\/s3\/|lfs-complete/, "no upload URL is stored or logged");
    });

    it("keeps the GGUF repo private beside a private adapter, and with HF_PUBLIC off", async () => {
      process.env.HF_PUBLIC = "0";
      const adapterId = await publishedAdapter();
      assert.equal((await hubOf(adapterId))!.public, false);
      const jobId = await uploadedQuant(adapterId);
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: true });
      const hub = (await hubOf(jobId))!;
      assert.equal(hub.public, false);
      assert.equal(fake.repo("model", hub.modelRepo!)!.private, true);
      // A private adapter's card may name its private GGUF repo: both are the owner's test.
      const adapter = fake.repo("model", (await hubOf(adapterId))!.modelRepo!)!;
      assert.ok(adapter.files.get("README.md")!.content!.toString().includes(hub.modelRepo!));
      assert.equal((await localFilesFor(adapterId))!.public, false);
      // A public adapter's card never names a private GGUF repo.
      delete process.env.HF_PUBLIC;
      const open = await publishedAdapter({ maxSteps: 121 });
      await store.updateHub(open, (h) => ({ ...h!, public: true }));
      const quiet = await uploadedQuant(open);
      process.env.HF_PUBLIC = "0";
      assert.deepEqual(await wf.publishToHub({ jobId: quiet }), { published: true });
      assert.equal((await hubOf(quiet))!.public, false);
      const openCard = fake.repo("model", (await hubOf(open))!.modelRepo!)!.files.get("README.md")!.content!.toString();
      assert.ok(!openCard.includes("-gguf-"), "the public card doesn't point to it");
    });

    it("takes the GGUF repo private with its adapter, and points a public card only to a public repo", async () => {
      const adapterId = await publishedAdapter();
      const jobId = await uploadedQuant(adapterId);
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: true });
      const repo = (await hubOf(jobId))!.modelRepo!;
      const adapterRepo = (await hubOf(adapterId))!.modelRepo!;
      assert.equal(fake.repo("model", repo)!.private, false);
      assert.equal((await localFilesFor(adapterId))!.public, true);

      // The owner takes the run private the way the lab does it: HF_PUBLIC=0, then Publish again on the adapter. The GGUF
      // repo holds the merged weights, so it goes private with it, and no page or drive order offers the files.
      process.env.HF_PUBLIC = "0";
      assert.deepEqual(await wf.publishToHub({ jobId: adapterId }), { published: true });
      assert.equal(fake.repo("model", adapterRepo)!.private, true);
      assert.equal(fake.repo("model", repo)!.private, true);
      assert.equal((await hubOf(jobId))!.public, false);
      const hidden = (await localFilesFor(adapterId))!;
      assert.deepEqual([hidden.repo, hidden.public], [repo, false]);
      assert.ok((await logOf(adapterId)).includes(`Hugging Face: ${repo} holds this adapter's local files, so it was made private with it.`));

      // Public again: the adapter's card leaves out the GGUF repo, which stays private until its own Publish.
      delete process.env.HF_PUBLIC;
      assert.deepEqual(await wf.publishToHub({ jobId: adapterId }), { published: true });
      assert.equal(fake.repo("model", adapterRepo)!.private, false);
      assert.ok(!fake.repo("model", adapterRepo)!.files.get("README.md")!.content!.toString().includes("-gguf-"), "a public card never names a private repo");
      assert.equal((await localFilesFor(adapterId))!.public, false);
      // Its own Publish makes it public beside the public adapter, and the adapter's card points to it again.
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: true });
      assert.equal(fake.repo("model", repo)!.private, false);
      assert.ok(fake.repo("model", adapterRepo)!.files.get("README.md")!.content!.toString().includes(`take [${repo}]`));
      assert.equal((await localFilesFor(adapterId))!.public, true);
    });

    it("never takes a published GGUF repo off the public pages when the files are made again, even when that run fails", async () => {
      const adapterId = await publishedAdapter();
      const first = await uploadedQuant(adapterId);
      assert.deepEqual(await wf.publishToHub({ jobId: first }), { published: true });
      const repo = (await hubOf(first))!.modelRepo!;
      // Make local files again: a second job uploads to the same repo, and its publishing fails on a build the Hub lost.
      const folder = ggufFolder();
      const again = await uploadedQuant(adapterId, folder);
      fake.repo("model", repo)!.objects.delete(sha(folder.get("muse-glimmer-30b-brief-writer-Q4_K_M.gguf")!));
      assert.deepEqual(await wf.publishToHub({ jobId: again }), { published: false });
      assert.equal((await hubOf(again))!.status, "failed");
      assert.equal(fake.repo("model", repo)!.private, false, "the repo the first job published stays public");
      const files = (await localFilesFor(adapterId))!;
      assert.deepEqual([files.quantJobId, files.public], [first, true], "and the pages still offer the first job's files");
    });

    it("points the adapter's card to a GGUF repo published while the adapter itself was publishing", async () => {
      const adapterId = await publishedAdapter();
      const jobId = await uploadedQuant(adapterId);
      const steps = await import("../hub-steps");
      const plan = await steps.hubPlanStep(adapterId, "succeeded", true);
      assert.equal(plan.action, "publish");
      const claim = (plan as { claim: string }).claim;
      await steps.hubStoryStep(adapterId, claim);
      await steps.hubDatasetStep(adapterId, claim);
      await steps.hubModelStep(adapterId, claim);
      // Meanwhile the local files job published its repo and found the adapter busy, so it left the pointer to this run.
      const repo = `muse-org/muse-glimmer-30b-brief-writer-gguf-${adapterId.slice(0, 8)}`;
      assert.equal((await hubOf(jobId))!.modelRepo, repo);
      await store.updateHub(jobId, (h) => ({ ...h!, status: "published", public: true, publishedAt: new Date().toISOString() }));
      const adapter = fake.repo("model", (await hubOf(adapterId))!.modelRepo!)!;
      const commits = adapter.commits.length;
      assert.ok(!adapter.files.get("README.md")!.content!.toString().includes(repo), "the model step's card came before it");
      await steps.hubFinishStep(adapterId, claim);
      assert.equal(adapter.commits.length, commits + 1);
      assert.deepEqual(adapter.commits.at(-1)!.files, ["README.md"], "one README-only commit");
      assert.ok(adapter.files.get("README.md")!.content!.toString().includes(`take [${repo}]`));
      assert.equal((await hubOf(adapterId))!.cardGguf, repo);
    });

    it("waits while the adapter isn't published, fails for good when a build never arrived, and checks every file again", async () => {
      const adapterId = await publishedAdapter();
      const folder = ggufFolder();
      const jobId = await uploadedQuant(adapterId, folder);
      await store.updateHub(adapterId, (h) => ({ ...h!, status: "failed", reason: "A publish again failed." }));
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: false });
      let hub = (await hubOf(jobId))!;
      assert.equal(hub.status, "waiting");
      assert.match(hub.reason!, /Its adapter isn't published on Hugging Face right now/);
      const refused = await publishPost(req(`/api/train/jobs/${jobId}/publish`, { method: "POST", body: "{}" }), ctx(jobId));
      assert.equal(refused.status, 409);
      assert.match(((await refused.json()) as { reason: string }).reason, /Publish the adapter, then this/);
      await store.updateHub(adapterId, (h) => ({ ...h!, status: "published", reason: null }));

      // A build the Hub lost fails the publishing: the files were only on the job's GPU.
      fake.repo("model", hub.modelRepo!)!.objects.delete(sha(folder.get("muse-glimmer-30b-brief-writer-Q4_K_M.gguf")!));
      assert.deepEqual(await wf.publishToHub({ jobId }), { published: false });
      hub = (await hubOf(jobId))!;
      assert.equal(hub.status, "failed");
      assert.match(hub.reason!, /doesn't have muse-glimmer-30b-brief-writer-Q4_K_M\.gguf .* Make local files again\./);

      // A job whose report never came keeps nothing to publish.
      const lost = await makeJob("glimmer-quantize", quantParams(adapterId), QUANT_TOKEN);
      await hubRoute(req(`/api/train/jobs/${lost}/hub`, { method: "POST", token: QUANT_TOKEN, body: JSON.stringify(planBody(ggufFolder())) }), ctx(lost));
      await finished(lost, quantMetrics(ggufFolder()));
      assert.deepEqual(await wf.publishToHub({ jobId: lost }), { published: false });
      assert.equal((await hubOf(lost))!.reason, "Not every GGUF file reached Hugging Face before the job ended, and the files were only on its GPU. Make local files again.");
      const press = await publishPost(req(`/api/train/jobs/${lost}/publish`, { method: "POST", body: "{}" }), ctx(lost));
      assert.equal(press.status, 409);

      // A job that ended without succeeding marks an upload it left unfinished as failed.
      const dead = await makeJob("glimmer-quantize", quantParams(adapterId), QUANT_TOKEN);
      await hubRoute(req(`/api/train/jobs/${dead}/hub`, { method: "POST", token: QUANT_TOKEN, body: JSON.stringify(planBody(ggufFolder())) }), ctx(dead));
      const { hubPlanStep } = await import("../hub-steps");
      assert.deepEqual(await hubPlanStep(dead, "failed"), { action: "none" });
      assert.match((await hubOf(dead))!.reason!, /ended as failed/);
      const newest = (await localFilesFor(adapterId))!;
      assert.deepEqual([newest.quantJobId, newest.repo, newest.public], [lost, null, false], "the newest job that passed, with no repo for a page to link");
    });

    it("answers Publish for a quantize job: refusals with their reason, then the workflow", async () => {
      const adapterId = await publishedAdapter();
      const running = await makeJob("glimmer-quantize", quantParams(adapterId), QUANT_TOKEN);
      let res = await publishPost(req(`/api/train/jobs/${running}/publish`, { method: "POST", body: "{}" }), ctx(running));
      assert.deepEqual([res.status, ((await res.json()) as { reason: string }).reason], [409, "It didn't succeed, so it has no files to publish."]);
      const jobId = await uploadedQuant(adapterId);
      delete process.env.HF_TOKEN;
      res = await publishPost(req(`/api/train/jobs/${jobId}/publish`, { method: "POST", body: "{}" }), ctx(jobId));
      assert.deepEqual(await res.json(), { error: "hub_off", reason: "HF_TOKEN isn't set" });
      process.env.HF_TOKEN = HF_TOKEN;
      res = await publishPost(req(`/api/train/jobs/${jobId}/publish`, { method: "POST", body: "{}" }), ctx(jobId));
      assert.equal(res.status, 202);
      assert.deepEqual(started.map((s) => s.fn), ["publishToHub"]);
      const got = (await (await publishGet(req(`/api/train/jobs/${jobId}/publish`), ctx(jobId))).json()) as { hub: { status: string; filesTotal: number } };
      assert.deepEqual([got.hub.status, got.hub.filesTotal], ["uploaded", 3]);
    });
  });

  describe("Make local files", () => {
    const get = async (id: string) => {
      const res = await quantGet(req(`/api/train/jobs/${id}/quantize`), ctx(id));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const press = async (id: string) => {
      const res = await quantPost(req(`/api/train/jobs/${id}/quantize`, { method: "POST", body: "{}" }), ctx(id));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    it("starts a quantize job through the jobs route, with the params the platform writes, in the adapter's region", async () => {
      await store.recordSweepOk(new Date());
      const adapterId = await publishedAdapter();
      let state = await get(adapterId);
      assert.equal(state.status, 200);
      assert.deepEqual([state.body.quantOff, state.body.hubOff, state.body.problem, state.body.latest, state.body.files], [null, null, null, null, null]);
      const out = await press(adapterId);
      assert.equal(out.status, 202, JSON.stringify(out.body));
      const job = (await store.getJob(String(out.body.quantJobId)))!;
      assert.equal(job.recipe, "glimmer-quantize");
      assert.deepEqual(job.params, { adapterJobId: adapterId, publish: 1, levels: "Q3_K_M,Q4_K_M,Q6_K", slug: "brief-writer", trainChannel: 0 });
      assert.deepEqual([job.region, job.instanceType, job.maxMinutes, job.maxUsd], ["us-east-1", "gpu_1x_a100_sxm4", 110, 3.7]);
      assert.equal(job.title, "Local files: Brief writer LoRA");
      assert.deepEqual(started.map((s) => s.fn), ["trainJob"]);
      state = await get(adapterId);
      assert.equal((state.body.latest as { id: string }).id, job.id);
      const again = await press(adapterId);
      assert.deepEqual([again.status, again.body.error, again.body.quantJobId], [409, "quant_running", job.id]);
    });

    it("refuses with the reason when it is off, the adapter isn't judged, trained under the full prompt or isn't published", async () => {
      await store.recordSweepOk(new Date());
      const adapterId = await publishedAdapter();
      delete process.env.QUANT_ENABLED;
      assert.equal((await get(adapterId)).body.quantOff, "QUANT_ENABLED isn't on");
      assert.deepEqual((await press(adapterId)).body, { error: "quant_off", reason: "QUANT_ENABLED isn't on" });
      process.env.QUANT_ENABLED = "1";
      delete process.env.HF_TOKEN;
      assert.deepEqual((await press(adapterId)).body, { error: "hub_off", reason: "HF_TOKEN isn't set" });
      process.env.HF_TOKEN = HF_TOKEN;

      await store.updateHub(adapterId, (h) => ({ ...h!, status: "failed" }));
      assert.match(String((await get(adapterId)).body.problem), /^Publish the adapter to Hugging Face first/);
      assert.equal((await press(adapterId)).body.error, "adapter_not_published");
      await store.updateHub(adapterId, (h) => ({ ...h!, status: "published" }));

      await testDb.update(realSchema.trainingJobs).set({ evalSummary: null }).where(eq(realSchema.trainingJobs.id, adapterId));
      const unjudged = await press(adapterId);
      assert.deepEqual([unjudged.status, unjudged.body.error], [400, "Adapter: that job isn't judged yet, so its local files would have no results to stand on."]);
      await testDb.update(realSchema.trainingJobs).set({ evalSummary: { items: 2, tunedWins: 2, baseWins: 0, ties: 0, avgBaseScore: 2.5, avgTunedScore: 8.5, judgeCostUsd: 0.01 }, params: { datasetId: DATASET_ID, studentPrompt: "full", dryRun: 0, publish: 1 } }).where(eq(realSchema.trainingJobs.id, adapterId));
      await log(adapterId, { type: "done", metrics: { student_prompt: "full", cache_used: "yes", adapter_dir: `/lambda/nfs/x/models/${adapterId}` } });
      assert.match(String((await press(adapterId)).body.error), /whole task prompt/);
      assert.equal((await press("8f1d2c3b-0000-4000-8000-00000000dead")).status, 404);
      assert.deepEqual(started, [], "no GPU started");
    });

    it("never lets a caller choose the builds, the slug or the channel", async () => {
      await store.recordSweepOk(new Date());
      const adapterId = await publishedAdapter();
      const { POST: jobsPost } = await import(new URL("../../../app/api/train/jobs/route.ts", import.meta.url).href);
      const res = await jobsPost(req("/api/train/jobs", { method: "POST", body: JSON.stringify({ recipe: "glimmer-quantize", params: { adapterJobId: adapterId, levels: "Q8_0" } }) }));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Unknown parameter: levels." });
    });
  });

  describe("the job's own reads", () => {
    it("pages a quantize job its adapter's dataset, each held-out item with the adapter's own answer", async () => {
      const adapterId = await publishedAdapter();
      const jobId = await makeJob("glimmer-quantize", quantParams(adapterId), QUANT_TOKEN);
      const page = async (part: string) => (await (await datasetGet(req(`/api/train/jobs/${jobId}/dataset?part=${part}&page=0`, { token: QUANT_TOKEN }), ctx(jobId))).json()) as { items: Array<Record<string, unknown>>; title: string };
      const evals = await page("eval");
      assert.deepEqual(evals.items, [
        { prompt: "Held out 0", reference: "Reference 0", tuned: "**Name:** Pier Gull Counter" },
        { prompt: "Held out 1", reference: "Reference 1", tuned: "**Name:** Bakery Board" },
      ]);
      assert.equal(evals.title, "Muse Muse's brief writer");
      const train = await page("train");
      assert.equal(train.items.length, 12);
      assert.ok(!("tuned" in train.items[0]!));
    });

    it("finds local files only for a job that passed and uploaded, the newest one first", async () => {
      const adapterId = await publishedAdapter();
      assert.equal(await localFilesFor(adapterId), null);
      const failed = await makeJob("glimmer-quantize", quantParams(adapterId), QUANT_TOKEN, { status: "failed", finishedAt: new Date(), terminatedAt: new Date() });
      await log(failed, { type: "done", metrics: quantMetrics(ggufFolder()) });
      const notUp = await makeJob("glimmer-quantize", quantParams(adapterId), QUANT_TOKEN);
      await finished(notUp, quantMetrics(ggufFolder(), { hub_uploaded: "no" }));
      assert.equal(await localFilesFor(adapterId), null, "a failed job and one whose files never reached the Hub");
      const folder = ggufFolder("brief-writer", ["Q3_K_M", "Q4_K_M"]);
      const ok = await makeJob("glimmer-quantize", quantParams(adapterId), QUANT_TOKEN);
      assert.equal((await gpuUpload(ok, QUANT_TOKEN, folder)).done, 204);
      await finished(ok, quantMetrics(folder, { q6_k_passed: "no", q6_k_kl_mean: 0.009 }));
      let files = (await localFilesFor(adapterId))!;
      assert.equal(files.quantJobId, ok);
      assert.deepEqual(files.files.map((f) => f.level), ["Q3_K_M", "Q4_K_M"], "the build that failed its check isn't offered");
      assert.deepEqual([files.repo, files.commit, files.public], [null, null, false], "not published yet");
      assert.deepEqual(await wf.publishToHub({ jobId: ok }), { published: true });
      files = (await localFilesFor(adapterId))!;
      assert.deepEqual([files.quantJobId, files.repo, files.public], [ok, `muse-org/muse-glimmer-30b-brief-writer-gguf-${adapterId.slice(0, 8)}`, true]);
      assert.match(files.commit!, /^[0-9a-f]{40}$/);

      // A newer job that passed doesn't hide the published files until its own are published.
      const again = ggufFolder();
      const next = await makeJob("glimmer-quantize", quantParams(adapterId), QUANT_TOKEN);
      assert.equal((await gpuUpload(next, QUANT_TOKEN, again)).done, 204);
      await finished(next, quantMetrics(again));
      assert.equal((await localFilesFor(adapterId))!.quantJobId, ok);
      assert.deepEqual(await wf.publishToHub({ jobId: next }), { published: true });
      files = (await localFilesFor(adapterId))!;
      assert.deepEqual([files.quantJobId, files.files.length], [next, 3]);
      assert.equal(await localFilesFor("not-a-uuid"), null);
    });
  });
});
