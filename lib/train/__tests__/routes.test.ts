/**
 * Drives the training routes with the store, the Lambda client, auth, the workflow, Next's after() and Vercel Blob
 * faked. The two routes a job's instance calls with its job token, POST /api/train/jobs/{id}/events and .../upload:
 * the token is checked before the body is read, bodies over 16 KB are refused, only the fields each callback allows
 * are kept, an artifact must be the job's own Blob upload, callbacks are rate limited (done and failed never), an
 * ended job takes nothing but a late log, done terminates right after the reply, and so does a late callback from an
 * ended job's instance. An upload grant covers exactly one blob under models/<jobId>/, of the declared size and media
 * type, for as long as that file needs. POST /api/train/jobs: the sweep, active-job and daily checks come before
 * anything is created, and a job that raced another one backs out before its workflow starts. And POST .../stop can be
 * pressed again until the instance is confirmed terminated. A job only starts while the sweep has run lately, and the
 * sweep cron notes each run whose Lambda listing answered. Eval callbacks are checked, cut and kept once per index up to
 * a cap. GET .../dataset pages the job's dataset for its token only. /api/train/datasets validates and starts the
 * dataset workflow, refused while the spend cap is reached. A dataset param must name a ready dataset, and a recipe that
 * keeps the model cache prefers the regions that have it. A live demo (glimmer-serve) job must name an adapter that can
 * be served, launches only in that adapter's region with limits sized for its minutes, and only it may send a serving
 * callback, whose address is never taken from the runner. Its runner pages its adapter's dataset. A decision dataset
 * (docs/DECISION_MODELS.md) is checked and saved ready from JSON rows, CSV or JSONL, with every problem by line and
 * nothing spent; its page shows 5 rows a label; a decide job pages its train renderings and its dev and test items with
 * no answers and decide.json, reading only the rows a page renders, up to its own page count plus 120 an hour. A decide
 * job needs a decision dataset (and a decision dataset decide mode), its run estimate comes from that dataset, and its
 * scores come back as decide callbacks: checked, each index once, up to a cap, only from a decide job.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/routes.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import type { DecideItem, DecisionRows, DecisionSpec } from "@/lib/decide/types";
import { decideJson } from "@/lib/decide/format";
import { checkDecisionUpload, decideEpochs, decideRunSize, decisionPage, decisionPageCount, DECIDE_PAGE_SIZE } from "../decision-datasets";
import { runEstimate } from "../logic";
import type { TrainCallback } from "../types";
import { TICKET_LABELS, TICKET_QUESTION, ticketCsv, ticketRows } from "./decision-fixture";

const JOB_ID = "1234abcd-0000-4000-8000-000000000000";
const TOKEN = "good-job-token";
/** A stand-in for BLOB_READ_WRITE_TOKEN, not a real one. */
const FAKE_BLOB_TOKEN = "vercel_blob_rw_teststore_notarealtoken";
/** The public host of the fake token's store, where the job's uploads land. */
const BLOB_HOST = "teststore.public.blob.vercel-storage.com";
const MIN = 60_000;

type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;

let jobStatus = "running";
/** The rest of the job getJob answers with. */
let jobExtra: Record<string, unknown> = {};
let applied: { applied: boolean; status: string; artifactLimit?: true } | null = { applied: true, status: "running" };
/** What requestStop answers: the job when it hasn't ended, null once it has. */
let stopRow: Record<string, unknown> | null = null;
let terminateFails = false;
/** MiB granted per job this hour, for the fake reserveUploadBytes. */
let budget: Record<string, number> = {};
let calls: Array<{ fn: string; args: unknown[] }> = [];
let pending: Array<() => unknown> = [];
let grants: Array<Record<string, unknown>> = [];
let uploadHits: Record<string, number> = {};
/** What POST /api/train/jobs sees: each read takes the next value, and the last one repeats. */
let active: number[] = [0];
let committed: number[] = [0];
let gpuFree = true;
/** What the fake pickGpu launches when a GPU is free. */
let gpuPick = { instanceType: "gpu_1x_a10", region: "us-east-1", priceCentsPerHour: 75 };
/** When the sweep last ran with Lambda's listing answering, for the fake lastSweepOkAt. */
let lastSweep: Date | null = new Date();
/** What the faked sweepTraining answers the cron route, and whether recordSweepOk fails. */
let sweepResult: { instances: number | null; terminated: unknown[]; failedJobs: unknown[]; stoppedJobs: unknown[]; errors: string[] } = {
  instances: 0,
  terminated: [],
  failedJobs: [],
  stoppedJobs: [],
  errors: [],
};
let recordSweepFails = false;
/** What recordEvalEvent answers. */
let evalResult: "recorded" | "duplicate" | "limit" = "recorded";
/** What recordDecideEvent answers. */
let decideResult: "recorded" | "duplicate" | "limit" = "recorded";
/** Datasets the fake store knows, by id. */
let datasetRows: Record<string, Record<string, unknown>> = {};
/** What datasetPage answers: the dataset's status and how many items each part holds. */
let pageStatus = "ready";
let pageTotals: Record<string, number> = { train: 450, eval: 40 };
/** A decision dataset's split rows, by dataset id, for the fake decisionSplitRows. */
let decisionRowsById: Record<string, DecisionRows> = {};
let paused = false;
let startFails = false;
let cacheRegionsImpl: () => Promise<string[]> = async () => ["us-south-1"];
/** Jobs other than JOB_ID that getJob knows, by id. */
let otherJobs: Record<string, Record<string, unknown>> = {};
/** What getAdapterSource answers, by job id. */
let adapterSources: Record<string, { job: Record<string, unknown>; metrics: Record<string, unknown> | null }> = {};
/** What getLiveDemo answers. */
let liveDemo: Record<string, unknown> | null = null;
/** What earlierOpenServeJob answers: another demo of the same adapter created just before the new one. */
let earlierDemo: { id: string } | null = null;
const savedEnv = { ...process.env };

function next(list: number[]): number {
  return list.length > 1 ? list.shift()! : list[0]!;
}

const called = (fn: string) => calls.filter((c) => c.fn === fn);
const order = () => calls.map((c) => c.fn);
const ctx: Ctx = { params: Promise.resolve({ id: JOB_ID }) };

function post(path: string, body: unknown, token: string | null = TOKEN): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`https://muse.example.com/api/train/jobs/${JOB_ID}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: text,
  });
}

const fakeStore = {
  verifyJobToken: async (jobId: string, token: string) => {
    calls.push({ fn: "verifyJobToken", args: [jobId] });
    return jobId === JOB_ID && token === TOKEN;
  },
  applyCallback: async (jobId: string, cb: TrainCallback) => {
    calls.push({ fn: "applyCallback", args: [jobId, cb] });
    return applied;
  },
  recordEvent: async (jobId: string, body: unknown) => void calls.push({ fn: "recordEvent", args: [jobId, body] }),
  getJob: async (jobId: string) => {
    calls.push({ fn: "getJob", args: [jobId] });
    if (jobId !== JOB_ID) return otherJobs[jobId] ?? null;
    return { ...jobRow({}), status: jobStatus, instanceId: "inst-1", terminatedAt: null, ...jobExtra };
  },
  ownerRowsProblem: async () => null,
  getAdapterSource: async (jobId: string) => {
    calls.push({ fn: "getAdapterSource", args: [jobId] });
    return adapterSources[jobId] ?? null;
  },
  getLiveDemo: async (jobId: string) => {
    calls.push({ fn: "getLiveDemo", args: [jobId] });
    return liveDemo;
  },
  earlierOpenServeJob: async (adapterJobId: string, jobId: string) => {
    calls.push({ fn: "earlierOpenServeJob", args: [adapterJobId, jobId] });
    return earlierDemo;
  },
  // The local files jobs' reads (gguf-flow.test.ts covers them on PGlite): none here.
  earlierOpenQuantJob: async () => null,
  openQuantJob: async () => null,
  tunedAnswers: async () => new Map(),
  requestStop: async (jobId: string) => {
    calls.push({ fn: "requestStop", args: [jobId] });
    return stopRow;
  },
  reserveUploadBytes: async (jobId: string, bytes: number, _hour: Date, capBytes: number) => {
    const mib = Math.max(1, Math.ceil(bytes / 1024 ** 2));
    if ((budget[jobId] ?? 0) + mib > capBytes / 1024 ** 2) return false;
    budget[jobId] = (budget[jobId] ?? 0) + mib;
    return true;
  },
  finishJob: async (jobId: string, input: unknown) => {
    calls.push({ fn: "finishJob", args: [jobId, input] });
    return null;
  },
  activeJobCount: async () => next(active),
  recordSweepOk: async () => {
    calls.push({ fn: "recordSweepOk", args: [] });
    if (recordSweepFails) throw new Error("fetch failed");
  },
  lastSweepOkAt: async () => {
    calls.push({ fn: "lastSweepOkAt", args: [] });
    return lastSweep;
  },
  trainingCommittedToday: async () => next(committed),
  trainingSpendToday: async () => 0.25,
  createJob: async (input: Record<string, unknown>) => {
    calls.push({ fn: "createJob", args: [input] });
    return jobRow(input);
  },
  setStatus: async (...args: unknown[]) => {
    calls.push({ fn: "setStatus", args });
    return true;
  },
  attachRun: async (...args: unknown[]) => void calls.push({ fn: "attachRun", args }),
  listJobs: async () => [],
  recordEvalEvent: async (jobId: string, body: unknown, max: number) => {
    calls.push({ fn: "recordEvalEvent", args: [jobId, body, max] });
    return evalResult;
  },
  recordDecideEvent: async (jobId: string, body: unknown, max: number) => {
    calls.push({ fn: "recordDecideEvent", args: [jobId, body, max] });
    return decideResult;
  },
  getDataset: async (id: string) => {
    calls.push({ fn: "getDataset", args: [id] });
    return datasetRows[id] ?? null;
  },
  datasetPage: async (id: string, part: string, offset: number, limit: number) => {
    calls.push({ fn: "datasetPage", args: [id, part, offset, limit] });
    if (!datasetRows[id]) return null;
    const total = pageTotals[part] ?? 0;
    const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({ n: offset + i }));
    return { status: pageStatus, title: String(datasetRows[id].title), total, items };
  },
  decisionSplitRows: async (id: string, part: "train" | "dev" | "test", indexes?: number[]) => {
    calls.push({ fn: "decisionSplitRows", args: [id, part, indexes] });
    const rows = decisionRowsById[id];
    if (!rows) return null;
    const list = rows[part];
    const wanted = (indexes ?? list.map((_, i) => i)).filter((i) => i >= 0 && i < list.length);
    return { total: list.length, rows: new Map(wanted.map((i) => [i, list[i]!])) };
  },
  createDecisionDataset: async (input: { title: string; spec: DecisionSpec; rows: DecisionRows; createdBy?: string | null }) => {
    calls.push({ fn: "createDecisionDataset", args: [input] });
    const { spec } = input;
    return datasetRow({
      id: DATASET_ID,
      title: input.title,
      task: spec.question,
      kind: "decision",
      status: "ready",
      requested: spec.split.train + spec.split.dev + spec.split.test,
      trainCount: spec.split.train,
      evalCount: spec.split.test,
      decision: spec,
      writerModel: "person",
      createdBy: input.createdBy ?? null,
      finishedAt: new Date("2026-10-27T12:00:00.000Z"),
    });
  },
  createDataset: async (input: Record<string, unknown>) => {
    calls.push({ fn: "createDataset", args: [input] });
    return datasetRow({ ...input, id: DATASET_ID });
  },
  listDatasets: async () => Object.values(datasetRows),
  attachDatasetRun: async (...args: unknown[]) => void calls.push({ fn: "attachDatasetRun", args }),
  failDataset: async (...args: unknown[]) => {
    calls.push({ fn: "failDataset", args });
    return true;
  },
};

const DATASET_ID = "dddddddd-0000-4000-8000-000000000000";

function datasetRow(over: Record<string, unknown> = {}) {
  return {
    id: DATASET_ID,
    title: "Python errors",
    task: "Explain Python errors to beginners.",
    status: "generating",
    requested: 100,
    trainCount: 0,
    evalCount: 0,
    costUsd: 0,
    error: null,
    createdBy: "admin-1",
    createdAt: new Date("2026-10-27T12:00:00.000Z"),
    finishedAt: null,
    workflowRunId: null,
    ...over,
  };
}

function jobRow(input: Record<string, unknown>) {
  return {
    ...input,
    id: JOB_ID,
    status: "queued",
    instanceId: null,
    instanceIp: null,
    instanceName: "mm-train-1234abcd-smoke",
    tokenHash: null,
    workflowRunId: null,
    stopRequested: false,
    progress: null,
    artifacts: [],
    summary: null,
    error: null,
    costUsd: 0,
    createdAt: new Date(),
    launchedAt: null,
    firstHeartbeatAt: null,
    lastHeartbeatAt: null,
    finishedAt: null,
    terminatedAt: null,
  };
}

class FakeAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

class FakeLambdaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

const canMock = typeof (mock as { module?: unknown }).module === "function";
let events: Handler;
let upload: Handler;
let stopRoute: Handler;
let createJobRoute: (req: Request) => Promise<Response>;
let sweepCron: (req: Request) => Promise<Response>;
let jobDataset: (req: Request, ctx: Ctx) => Promise<Response>;
let createDatasetRoute: (req: Request) => Promise<Response>;
let listDatasetsRoute: (req: Request) => Promise<Response>;
let datasetDetail: (req: Request, ctx: Ctx) => Promise<Response>;
/** A recipe with a dataset param (glimmer-lora), when there is one. */
let datasetRecipe: { id: string; usesCache?: boolean } | undefined;

function createReq(body: unknown): Request {
  return new Request("https://muse.example.com/api/train/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("job token routes", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const at = (rel: string) => new URL(rel, import.meta.url).href;
    mock.module(at("../store.ts"), { namedExports: fakeStore });
    mock.module(at("../lambda.ts"), {
      namedExports: {
        LambdaApiError: FakeLambdaApiError,
        terminateInstances: async (ids: string[]) => {
          calls.push({ fn: "terminateInstances", args: [ids] });
          if (terminateFails) throw new FakeLambdaApiError(0, null, "Lambda timed out");
        },
        listInstanceTypes: async () => {
          calls.push({ fn: "listInstanceTypes", args: [] });
          return [];
        },
        pickGpu: (...args: unknown[]) => {
          calls.push({ fn: "pickGpu", args });
          return gpuFree ? gpuPick : null;
        },
        cacheRegions: async () => {
          calls.push({ fn: "cacheRegions", args: [] });
          return cacheRegionsImpl();
        },
      },
    });
    mock.module(at("../datasets.ts"), { namedExports: { DATASET_MODEL: "muse-wonder-1.0", makeDataset: async () => ({ status: "ready" }) } });
    mock.module(at("../../quota.ts"), { namedExports: { spendPaused: async () => paused } });
    mock.module(at("../../auth.ts"), {
      namedExports: { AuthError: FakeAuthError, requireAdminOrAutomation: async () => ({ id: "admin-1", email: "a@x", isAdmin: true }) },
    });
    mock.module(at("../workflow.ts"), { namedExports: { trainJob: async () => ({ status: "succeeded" }) } });
    mock.module(at("../sweep.ts"), {
      namedExports: {
        sweepTraining: async () => {
          calls.push({ fn: "sweepTraining", args: [] });
          return structuredClone(sweepResult);
        },
      },
    });
    mock.module("workflow/api", {
      namedExports: {
        start: async (_wf: unknown, args: unknown[]) => {
          calls.push({ fn: "start", args });
          if (startFails) throw new Error("queue unavailable");
          return { runId: "run-1" };
        },
      },
    });
    mock.module("next/server", { namedExports: { after: (fn: () => unknown) => void pending.push(fn) } });
    mock.module(at("../../gateway/store.ts"), {
      namedExports: {
        hitRateLimits: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, (uploadHits[k] = (uploadHits[k] ?? 0) + 1)])),
      },
    });
    mock.module("@vercel/blob/client", {
      namedExports: {
        generateClientTokenFromReadWriteToken: async (opts: Record<string, unknown>) => {
          grants.push(opts);
          return "vercel_blob_client_teststore_grant";
        },
      },
    });
    ({ POST: events } = await import(at("../../../app/api/train/jobs/[id]/events/route.ts")));
    ({ POST: upload } = await import(at("../../../app/api/train/jobs/[id]/upload/route.ts")));
    ({ POST: stopRoute } = await import(at("../../../app/api/train/jobs/[id]/stop/route.ts")));
    ({ POST: createJobRoute } = await import(at("../../../app/api/train/jobs/route.ts")));
    ({ GET: sweepCron } = await import(at("../../../app/api/cron/train-sweep/route.ts")));
    ({ GET: jobDataset } = await import(at("../../../app/api/train/jobs/[id]/dataset/route.ts")));
    ({ POST: createDatasetRoute, GET: listDatasetsRoute } = await import(at("../../../app/api/train/datasets/route.ts")));
    ({ GET: datasetDetail } = await import(at("../../../app/api/train/datasets/[id]/route.ts")));
    const { RECIPES } = (await import(at("../recipes/index.ts"))) as typeof import("../recipes/index");
    datasetRecipe = RECIPES.find((r) => r.params.some((p) => p.kind === "dataset"));
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
  });

  beforeEach(() => {
    jobStatus = "running";
    jobExtra = {};
    stopRow = null;
    terminateFails = false;
    budget = {};
    applied = { applied: true, status: "running" };
    calls = [];
    pending = [];
    grants = [];
    uploadHits = {};
    active = [0];
    committed = [0];
    gpuFree = true;
    gpuPick = { instanceType: "gpu_1x_a10", region: "us-east-1", priceCentsPerHour: 75 };
    lastSweep = new Date(Date.now() - 4 * MIN);
    sweepResult = { instances: 0, terminated: [], failedJobs: [], stoppedJobs: [], errors: [] };
    recordSweepFails = false;
    evalResult = "recorded";
    decideResult = "recorded";
    datasetRows = {};
    pageStatus = "ready";
    pageTotals = { train: 450, eval: 40 };
    decisionRowsById = {};
    paused = false;
    startFails = false;
    cacheRegionsImpl = async () => ["us-south-1"];
    otherJobs = {};
    adapterSources = {};
    liveDemo = null;
    earlierDemo = null;
    process.env.BLOB_READ_WRITE_TOKEN = FAKE_BLOB_TOKEN;
    // A fake value: Meta is never called here, the dataset route only checks that it is set.
    process.env.MODEL_API_KEY = "test-value-not-a-key";
    // Fake values: the Lambda client is faked, so nothing reads this as a key.
    process.env.LAMBDA_API_KEY = "test-value-not-a-key";
    process.env.PLATFORM_URL = "https://muse.example.com";
    process.env.TRAIN_MAX_ACTIVE = "1";
    process.env.TRAIN_DAILY_USD = "20";
    // A test value: the sweep route isn't called here, it only has to be set.
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.VERCEL_ENV = "production";
    delete process.env.TRAIN_ALLOW_OUTSIDE_PRODUCTION;
    delete process.env.TRAIN_JOB_MAX_USD;
    delete process.env.TRAIN_JOB_MAX_MINUTES;
  });

  describe("events", () => {
    it("refuses a missing or wrong token before reading the body", async () => {
      const big = JSON.stringify({ type: "log", text: "x".repeat(40_000) });
      for (const token of [null, "wrong", `${TOKEN} `.repeat(2)]) {
        const res = await events(post("events", big, token), ctx);
        assert.equal(res.status, 401, String(token));
      }
      const other = await events(post("events", { type: "heartbeat" }), { params: Promise.resolve({ id: "ffffffff-0000-4000-8000-000000000000" }) });
      assert.equal(other.status, 401, "the token only works for its own job");
      assert.equal(called("applyCallback").length, 0);
    });

    it("refuses a body over 16 KB and anything that isn't a callback", async () => {
      const big = await events(post("events", { type: "log", text: "x".repeat(17 * 1024) }), ctx);
      assert.equal(big.status, 413);
      assert.equal((await events(post("events", { type: "status", status: "succeeded" }), ctx)).status, 400);
      assert.equal((await events(post("events", "not json"), ctx)).status, 400);
      assert.equal(called("applyCallback").length, 0);
    });

    it("keeps only the fields each callback allows", async () => {
      const res = await events(post("events", { type: "progress", step: 3, loss: 0.5, totalSteps: "9", status: "succeeded" }), ctx);
      assert.equal(res.status, 204);
      assert.deepEqual(called("applyCallback")[0]!.args[1], { type: "progress", step: 3, loss: 0.5 });
    });

    it("takes an artifact only when it is this job's own upload on this deployment's Blob store", async () => {
      const art = (url: string) => ({ type: "artifact", artifact: { name: "a.bin", kind: "adapter", url, bytes: 3 } });
      const mine = `https://${BLOB_HOST}/models/${JOB_ID}/0123456789ab-a.bin`;
      assert.equal((await events(post("events", art(mine)), ctx)).status, 204);
      assert.deepEqual(called("applyCallback")[0]!.args[1], {
        type: "artifact",
        artifact: { name: "a.bin", kind: "adapter", url: mine, bytes: 3 },
      });
      const refused = [
        "javascript:alert(1)",
        `http://${BLOB_HOST}/models/${JOB_ID}/a.bin`,
        `https://x.public.blob.vercel-storage.com/models/${JOB_ID}/a.bin`,
        `https://otherstore.public.blob.vercel-storage.com/models/${JOB_ID}/a.bin`,
        `https://${BLOB_HOST}/models/ffffffff-0000-4000-8000-000000000000/a.bin`,
        `https://${BLOB_HOST}/models/${JOB_ID}/../ffffffff-0000-4000-8000-000000000000/a.bin`,
        `https://${BLOB_HOST}/models/${JOB_ID}/`,
        `https://${BLOB_HOST}/inspo/a.bin`,
        `https://${BLOB_HOST}/models/${JOB_ID}/a.bin?x=1`,
        `https://${BLOB_HOST}/models/${JOB_ID}/a.bin#x`,
        `https://user:pw@${BLOB_HOST}/models/${JOB_ID}/a.bin`,
        `https://${BLOB_HOST}:8443/models/${JOB_ID}/a.bin`,
        `https://${BLOB_HOST}.evil.example/models/${JOB_ID}/a.bin`,
        `https://lambda-labs-login.example/models/${JOB_ID}/a.bin`,
      ];
      for (const url of refused) assert.equal((await events(post("events", art(url)), ctx)).status, 400, url);
      delete process.env.BLOB_READ_WRITE_TOKEN;
      assert.equal((await events(post("events", art(mine)), ctx)).status, 400, "no store, so no artifact is the job's");
      assert.equal(called("applyCallback").length, 1);
    });

    it("refuses an artifact past the job's cap without logging it", async () => {
      applied = { applied: false, status: "running", artifactLimit: true };
      const art = { type: "artifact", artifact: { name: "a.bin", kind: "other", url: `https://${BLOB_HOST}/models/${JOB_ID}/a.bin`, bytes: 1 } };
      const res = await events(post("events", art), ctx);
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "artifact_limit" });
      assert.equal(called("recordEvent").length, 0);
      assert.equal(pending.length, 0);
    });

    it("limits a job to 120 heartbeat, progress, log and artifact callbacks a minute, but never done or failed", async () => {
      for (let i = 0; i < 120; i++) assert.equal((await events(post("events", { type: "heartbeat" }), ctx)).status, 204);
      const over = await events(post("events", { type: "log", text: "one more" }), ctx);
      assert.equal(over.status, 429);
      assert.deepEqual(await over.json(), { error: "rate_limited" });
      assert.equal(called("applyCallback").length, 120);
      applied = { applied: true, status: "succeeded" };
      assert.equal((await events(post("events", { type: "done" }), ctx)).status, 204);
      assert.equal((await events(post("events", { type: "failed", error: "x" }), ctx)).status, 204);
      assert.equal(called("applyCallback").length, 122);
    });

    it("logs a heartbeat only when it has a message", async () => {
      await events(post("events", { type: "heartbeat" }), ctx);
      assert.equal(called("recordEvent").length, 0);
      await events(post("events", { type: "heartbeat", message: "warming up" }), ctx);
      assert.equal(called("recordEvent").length, 1);
    });

    it("answers 409 once the job ended, but still keeps a late log", async () => {
      applied = { applied: false, status: "succeeded" };
      jobStatus = "succeeded";
      jobExtra = { terminatedAt: new Date() };
      assert.equal((await events(post("events", { type: "progress", step: 1 }), ctx)).status, 409);
      assert.equal((await events(post("events", { type: "done" }), ctx)).status, 409);
      assert.equal(called("recordEvent").length, 0);
      assert.equal((await events(post("events", { type: "log", text: "last line" }), ctx)).status, 204);
      assert.deepEqual(called("recordEvent")[0]!.args[1], { type: "log", text: "last line" });
      for (const fn of pending) await fn();
      assert.equal(called("terminateInstances").length, 0, "nothing to terminate once the instance is confirmed gone");
    });

    it("terminates an ended job's instance when it keeps reporting, even with its workflow gone", async () => {
      applied = { applied: false, status: "failed" };
      jobStatus = "failed";
      const res = await events(post("events", { type: "heartbeat" }), ctx);
      assert.equal(res.status, 409);
      assert.equal(pending.length, 1, "after the reply");
      await pending[0]!();
      assert.deepEqual(called("terminateInstances")[0]!.args[0], ["inst-1"]);
      const [, input] = called("finishJob")[0]!.args as [string, { status: string; reason: string }];
      assert.equal(input.status, "failed");
      assert.match(input.reason, /kept reporting after its job ended/);

      pending = [];
      assert.equal((await events(post("events", { type: "log", text: "late" }), ctx)).status, 204);
      assert.equal(pending.length, 0, "a late log is expected after the end and terminates nothing");
    });

    it("terminates the instance right after the reply to done or failed", async () => {
      jobStatus = "succeeded";
      applied = { applied: true, status: "succeeded" };
      const res = await events(post("events", { type: "done", summary: "ok", metrics: { gpu: "A10" } }), ctx);
      assert.equal(res.status, 204);
      assert.equal(called("terminateInstances").length, 0, "not before the reply");
      assert.equal(pending.length, 1);
      await pending[0]!();
      assert.deepEqual(called("terminateInstances")[0]!.args[0], ["inst-1"]);
      assert.equal((called("finishJob")[0]!.args[1] as { status: string }).status, "succeeded");
    });
  });

  describe("eval callbacks", () => {
    const evalBody = (over: Record<string, unknown> = {}) => ({
      type: "eval",
      index: 3,
      prompt: "How do I read a file?",
      reference: "Use open().",
      base: "Not sure.",
      tuned: "Use open() in a with block.",
      ...over,
    });

    it("keeps only the eval fields, cut to 3,500 characters, and logs the item once", async () => {
      const long = "x".repeat(4000);
      const res = await events(post("events", evalBody({ base: long, extra: "dropped" })), ctx);
      assert.equal(res.status, 204);
      const [, cb] = called("applyCallback")[0]!.args as [string, Record<string, unknown>];
      assert.deepEqual(cb, { ...evalBody(), base: "x".repeat(3500) }, "a sign of life, with nothing extra");
      const [jobId, body, max] = called("recordEvalEvent")[0]!.args as [string, Record<string, unknown>, number];
      assert.equal(jobId, JOB_ID);
      assert.deepEqual(body, cb);
      assert.equal(max, 120);
      assert.equal(called("recordEvent").length, 0, "logged through recordEvalEvent only");
    });

    it("refuses an eval item without an index or one of its texts", async () => {
      for (const over of [{ index: -1 }, { index: 1.5 }, { index: "3" }, { tuned: undefined }, { prompt: "  " }, { reference: 7 }]) {
        const res = await events(post("events", evalBody(over)), ctx);
        assert.equal(res.status, 400, JSON.stringify(over));
      }
      assert.equal(called("recordEvalEvent").length, 0);
    });

    it("answers 409 eval_limit past 120 items, and 204 for a retried one", async () => {
      evalResult = "limit";
      const over = await events(post("events", evalBody()), ctx);
      assert.equal(over.status, 409);
      assert.deepEqual(await over.json(), { error: "eval_limit", max: 120 });
      evalResult = "duplicate";
      assert.equal((await events(post("events", evalBody()), ctx)).status, 204);
    });

    it("takes an eval item over 16 KB, but no other callback that size and nothing over 64 KB", async () => {
      // 3,500 two-byte characters in each of four fields: about 28 KB on the wire.
      const wide = "\u00e9".repeat(3500);
      const big = evalBody({ prompt: wide, reference: wide, base: wide, tuned: wide });
      assert.equal((await events(post("events", big), ctx)).status, 204);
      assert.equal((await events(post("events", { type: "progress", message: wide.repeat(3) }), ctx)).status, 413);
      assert.equal((await events(post("events", evalBody({ base: "x".repeat(70_000) })), ctx)).status, 413);
    });

    it("answers 409 job_ended for an eval item once the job ended, without logging it", async () => {
      applied = { applied: false, status: "succeeded" };
      jobStatus = "succeeded";
      jobExtra = { terminatedAt: new Date() };
      assert.equal((await events(post("events", evalBody()), ctx)).status, 409);
      assert.equal(called("recordEvalEvent").length, 0);
    });
  });

  describe("decide callbacks", () => {
    const item = (index: number, over: Record<string, unknown> = {}) => ({
      index,
      base: [-0.11, -2.4, -4.0],
      tuned: [-0.02, -4.5, -6.1],
      baseMass: 0.97,
      tunedMass: 0.99,
      ...over,
    });
    const decideBody = (items: unknown, over: Record<string, unknown> = {}) => ({ type: "decide", part: "test", items, ...over });

    beforeEach(() => {
      jobExtra = { recipe: "glimmer-lora", params: { datasetId: DATASET_ID, mode: "decide", epochs: 2 } };
    });

    it("keeps only the score fields, each index once, and logs the callback through recordDecideEvent", async () => {
      const sent = decideBody([item(0, { extra: "dropped" }), item(1, { tuned: null, tunedMass: 0.5 }), item(0, { base: [-9, -9, -9] })]);
      const res = await events(post("events", sent), ctx);
      assert.equal(res.status, 204);
      const want = { type: "decide", part: "test", items: [item(0), item(1, { tuned: null, tunedMass: null })] };
      assert.deepEqual(called("applyCallback")[0]!.args[1], want, "a sign of life, the first of a repeated index");
      assert.deepEqual(called("recordDecideEvent")[0]!.args, [JOB_ID, want, 8000]);
      assert.equal(called("recordEvent").length + called("recordEvalEvent").length, 0, "logged through recordDecideEvent only");
    });

    it("refuses a part, an item or a size that isn't a decide callback's", async () => {
      const bad = [
        decideBody([item(0)], { part: "eval" }),
        decideBody([]),
        decideBody(Array.from({ length: 101 }, (_, i) => item(i))),
        decideBody("items"),
        decideBody([item(-1)]),
        decideBody([item(1.5)]),
        decideBody([item(8000)]),
        decideBody([item(0, { base: [-0.1] })]),
        decideBody([item(0, { base: [-1, -1, -1, -1, -1, -1] })]),
        decideBody([item(0, { base: [-0.1, "-2"] })]),
        decideBody([item(0, { baseMass: undefined })]),
        decideBody([item(0, { tuned: [-0.1, -0.2] })]),
        decideBody([item(0, { tunedMass: null })]),
        decideBody(["not an item"]),
      ];
      for (const body of bad) {
        const res = await events(post("events", body), ctx);
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 120));
        assert.match(((await res.json()) as { error: string }).error, /^Send the part \(dev or test\) and 1 to 100 items/);
      }
      assert.equal(called("applyCallback").length, 0);
    });

    it("takes decide scores only from a glimmer-lora job in decide mode, before applying them", async () => {
      for (const extra of [
        { recipe: "glimmer-lora", params: { datasetId: DATASET_ID } },
        { recipe: "glimmer-serve", params: { adapterJobId: "aaaaaaaa-0000-4000-8000-000000000000", minutes: 30, mode: "decide" } },
      ]) {
        jobExtra = extra;
        const res = await events(post("events", decideBody([item(0)])), ctx);
        assert.equal(res.status, 400);
        assert.match(((await res.json()) as { error: string }).error, /Only a Muse Glimmer LoRA job in decide mode sends decision scores/);
      }
      assert.equal(called("applyCallback").length + called("recordDecideEvent").length, 0);
    });

    it("answers 409 decide_limit past 8,000 items a job, 204 for a retry, and takes 100 items over 16 KB", async () => {
      decideResult = "limit";
      const over = await events(post("events", decideBody([item(0)])), ctx);
      assert.equal(over.status, 409);
      assert.deepEqual(await over.json(), { error: "decide_limit", max: 8000 });
      decideResult = "duplicate";
      assert.equal((await events(post("events", decideBody([item(0)])), ctx)).status, 204);
      decideResult = "recorded";
      // Full precision, as a runner that didn't round would send: about 30 KB.
      const lp = (k: number) => Math.log((k + 1) / 15);
      const wide = (i: number) => item(i, { base: [0, 1, 2, 3, 4].map(lp), tuned: [5, 4, 3, 2, 1].map(lp), baseMass: 1 / 3, tunedMass: 2 / 3 });
      const full = decideBody(Array.from({ length: 100 }, (_, i) => wide(i)));
      assert.ok(JSON.stringify(full).length > 16 * 1024);
      assert.equal((await events(post("events", full), ctx)).status, 204);
      assert.equal((await events(post("events", decideBody([item(0)], { pad: "x".repeat(70_000) })), ctx)).status, 413);
    });

    it("answers 409 job_ended once the job ended, without logging the scores", async () => {
      applied = { applied: false, status: "succeeded" };
      jobStatus = "succeeded";
      jobExtra = { recipe: "glimmer-lora", params: { datasetId: DATASET_ID, mode: "decide" }, terminatedAt: new Date() };
      assert.equal((await events(post("events", decideBody([item(0)])), ctx)).status, 409);
      assert.equal(called("recordDecideEvent").length, 0);
    });
  });

  describe("serving callbacks", () => {
    const CERT = "AB:".repeat(31) + "AB";
    const serving = (over: Record<string, unknown> = {}) => ({ type: "serving", port: 8443, certSha256: CERT, model: "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit", ...over });

    beforeEach(() => {
      jobExtra = { recipe: "glimmer-serve", params: { adapterJobId: "aaaaaaaa-0000-4000-8000-000000000000", minutes: 30 } };
    });

    it("keeps the port and the fingerprint, lowercased, and never an address from the runner", async () => {
      const res = await events(post("events", serving({ ip: "203.0.113.66", host: "evil.example.com", adapterJobId: "aaaaaaaa" })), ctx);
      assert.equal(res.status, 204);
      assert.deepEqual(called("applyCallback")[0]!.args[1], {
        type: "serving",
        port: 8443,
        certSha256: "ab".repeat(32),
        model: "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit",
        adapterJobId: "aaaaaaaa",
      });
      assert.equal(called("recordEvent").length, 1, "logged for the job page");
      assert.ok(!JSON.stringify(calls).includes("203.0.113.66"));
      assert.ok(!JSON.stringify(calls).includes("evil.example.com"));
    });

    it("refuses another port or anything that isn't a SHA-256 fingerprint", async () => {
      for (const bad of [
        serving({ port: 443 }),
        serving({ port: "8443" }),
        serving({ certSha256: "ab".repeat(31) }),
        serving({ certSha256: "zz".repeat(32) }),
        serving({ certSha256: undefined }),
      ]) {
        const res = await events(post("events", bad), ctx);
        assert.equal(res.status, 400, JSON.stringify(bad));
        assert.match(((await res.json()) as { error: string }).error, /port \(8443\) and its certificate's SHA-256 fingerprint/);
      }
      assert.equal(called("applyCallback").length, 0);
    });

    it("refuses a serving callback from a job that isn't glimmer-serve, before applying it", async () => {
      jobExtra = { recipe: "glimmer-lora", params: { datasetId: DATASET_ID } };
      const res = await events(post("events", serving()), ctx);
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, /Only a glimmer-serve job/);
      assert.equal(called("applyCallback").length + called("recordEvent").length, 0);
    });

    it("answers 409 job_ended once the job ended, and counts toward the job's callbacks a minute", async () => {
      applied = { applied: false, status: "succeeded" };
      assert.equal((await events(post("events", serving()), ctx)).status, 409);
      applied = { applied: true, status: "running" };
      for (let i = 1; i < 120; i++) await events(post("events", { type: "heartbeat" }), ctx);
      assert.equal((await events(post("events", serving()), ctx)).status, 429);
    });
  });

  describe("job dataset pages", () => {
    const pageReq = (query: string, token: string | null = TOKEN) =>
      new Request(`https://muse.example.com/api/train/jobs/${JOB_ID}/dataset${query}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });

    beforeEach(() => {
      jobExtra = { params: { datasetId: DATASET_ID } };
      datasetRows = { [DATASET_ID]: datasetRow({ status: "ready" }) };
    });

    it("refuses a missing or wrong token before reading anything", async () => {
      assert.equal((await jobDataset(pageReq("?part=train&page=0", null), ctx)).status, 401);
      assert.equal((await jobDataset(pageReq("?part=train&page=0", "wrong"), ctx)).status, 401);
      assert.equal(called("getJob").length + called("datasetPage").length, 0);
    });

    it("pages the job's own dataset, 100 at a time, with the next page until the last", async () => {
      const first = await jobDataset(pageReq("?part=train&page=0"), ctx);
      assert.equal(first.status, 200);
      const body = (await first.json()) as { items: Array<{ n: number }>; nextPage: number | null; title: string };
      assert.equal(body.items.length, 100);
      assert.equal(body.nextPage, 1);
      assert.equal(body.title, "Python errors", "the dataset's name, for glimmer-lora's short student prompt");
      assert.deepEqual(called("datasetPage")[0]!.args, [DATASET_ID, "train", 0, 100]);

      const last = (await (await jobDataset(pageReq("?part=train&page=4"), ctx)).json()) as { items: unknown[]; nextPage: number | null };
      assert.equal(last.items.length, 50);
      assert.equal(last.nextPage, null);
      assert.deepEqual(called("datasetPage")[1]!.args, [DATASET_ID, "train", 400, 100]);

      const held = (await (await jobDataset(pageReq("?part=eval"), ctx)).json()) as { items: unknown[]; nextPage: number | null };
      assert.equal(held.items.length, 40);
      assert.equal(held.nextPage, null);

      pageTotals = { train: 400 };
      const exact = (await (await jobDataset(pageReq("?part=train&page=3"), ctx)).json()) as { nextPage: number | null };
      assert.equal(exact.nextPage, null, "no empty page after an exact multiple");
    });

    it("refuses a bad part or page", async () => {
      for (const q of ["", "?part=all", "?part=train&page=-1", "?part=train&page=1.5", "?part=train&page=x", "?part=train&page=99999"]) {
        assert.equal((await jobDataset(pageReq(q), ctx)).status, 400, q);
      }
      assert.equal(called("datasetPage").length, 0);
    });

    it("answers 404 no_dataset for a job without one, and 409 while the dataset isn't ready", async () => {
      jobExtra = { params: {} };
      const none = await jobDataset(pageReq("?part=train"), ctx);
      assert.equal(none.status, 404);
      assert.deepEqual(await none.json(), { error: "no_dataset" });
      jobExtra = { params: { datasetId: "ffffffff-0000-4000-8000-00000000000f" } };
      assert.equal((await jobDataset(pageReq("?part=train"), ctx)).status, 404, "a dataset that is gone");
      jobExtra = { params: { datasetId: DATASET_ID } };
      pageStatus = "generating";
      const early = await jobDataset(pageReq("?part=train"), ctx);
      assert.equal(early.status, 409);
      assert.deepEqual(await early.json(), { error: "dataset_not_ready" });
    });

    it("pages a glimmer-serve job its adapter's dataset, for the short system line", async () => {
      const adapterId = "aaaaaaaa-0000-4000-8000-000000000000";
      jobExtra = { recipe: "glimmer-serve", params: { adapterJobId: adapterId, minutes: 30 } };
      otherJobs = { [adapterId]: { id: adapterId, recipe: "glimmer-lora", params: { datasetId: DATASET_ID } } };
      const res = await jobDataset(pageReq("?part=train&page=0"), ctx);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { title: string }).title, "Python errors");
      assert.deepEqual(called("datasetPage")[0]!.args, [DATASET_ID, "train", 0, 100]);

      otherJobs = {};
      assert.equal((await jobDataset(pageReq("?part=train"), ctx)).status, 404, "an adapter job that is gone");
      jobExtra = { recipe: "smoke", params: { adapterJobId: adapterId } };
      otherJobs = { [adapterId]: { id: adapterId, recipe: "glimmer-lora", params: { datasetId: DATASET_ID } } };
      assert.equal((await jobDataset(pageReq("?part=train"), ctx)).status, 404, "only glimmer-serve reads through its adapter");
    });

    it("limits a job to 120 pages an hour", async () => {
      for (let i = 0; i < 120; i++) assert.equal((await jobDataset(pageReq("?part=eval"), ctx)).status, 200);
      const over = await jobDataset(pageReq("?part=eval"), ctx);
      assert.equal(over.status, 429);
      assert.deepEqual(await over.json(), { error: "rate_limited" });
    });
  });

  describe("datasets", () => {
    const datasetReq = (body: unknown) =>
      new Request("https://muse.example.com/api/train/datasets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const task = "Explain Python error messages to beginners, with a fix.";

    it("lets Spark 1.3 Contributor write only where it's on and the task is said to be made up", async () => {
      const task = "Answer made-up questions for a pretend bakery in two warm sentences";
      const before = called("createDataset").length;
      delete process.env.TRAIN_CONTRIBUTOR_WRITER;
      const off = await createDatasetRoute(datasetReq({ task, count: 1000, writer: "contributor", madeUp: true }));
      assert.equal(off.status, 400);
      process.env.TRAIN_CONTRIBUTOR_WRITER = "1";
      try {
        const unconfirmed = await createDatasetRoute(datasetReq({ task, count: 1000, writer: "contributor" }));
        assert.equal(unconfirmed.status, 400);
        assert.match(((await unconfirmed.json()) as { error: string }).error, /made-up/);
        assert.equal((await createDatasetRoute(datasetReq({ task, count: 1000, writer: "muse-spark-1.3", madeUp: true }))).status, 400);
        assert.equal(called("createDataset").length, before, "nothing saved on a refusal");
        assert.equal((await createDatasetRoute(datasetReq({ task, count: 1000, writer: "contributor", madeUp: true }))).status, 201);
        assert.equal((called("createDataset")[before]!.args[0] as { writerModel: string }).writerModel, "muse-spark-1.3-contributor");
      } finally {
        delete process.env.TRAIN_CONTRIBUTOR_WRITER;
      }
    });

    it("saves a generating dataset with Muse Wonder as its writer and starts its workflow once", async () => {
      const res = await createDatasetRoute(datasetReq({ task, count: "150" }));
      assert.equal(res.status, 201);
      const input = called("createDataset")[0]!.args[0] as Record<string, unknown>;
      assert.deepEqual(input, { title: task, task, requested: 150, writerModel: "muse-wonder-1.0", createdBy: "admin-1" });
      assert.deepEqual(called("start").map((c) => c.args), [[{ datasetId: DATASET_ID }]]);
      assert.deepEqual(called("attachDatasetRun")[0]!.args, [DATASET_ID, "run-1"]);
      const body = (await res.json()) as { dataset: Record<string, unknown> };
      assert.equal(body.dataset.id, DATASET_ID);
      assert.equal(body.dataset.status, "generating");
      assert.equal(body.dataset.createdAt, "2026-10-27T12:00:00.000Z");
      assert.equal(body.dataset.writerModel, "muse-wonder-1.0");
      assert.equal("createdBy" in body.dataset, false);

      await createDatasetRoute(datasetReq({ title: "  Errors  ", task, count: 20 }));
      assert.equal((called("createDataset")[1]!.args[0] as { title: string }).title, "Errors");
      const long = `${task} Keep every answer short and kind.`;
      await createDatasetRoute(datasetReq({ task: long, count: 20 }));
      assert.equal((called("createDataset")[2]!.args[0] as { title: string }).title, "Explain Python error messages to beginners, with a fix.", "cut at a word");
    });

    it("refuses bad input before creating anything", async () => {
      const bad = [
        {},
        { task: "too short", count: 50 },
        { task: "x".repeat(2001), count: 50 },
        { task, count: 19 },
        { task, count: 1001 },
        { task, count: 50.5 },
        { task, count: "many" },
        { task },
        { task, count: 50, title: 7 },
      ];
      for (const body of bad) assert.equal((await createDatasetRoute(datasetReq(body))).status, 400, JSON.stringify(body));
      assert.equal(called("createDataset").length, 0);
    });

    it("refuses while the spend cap is reached or Meta isn't configured", async () => {
      paused = true;
      const res = await createDatasetRoute(datasetReq({ task, count: 50 }));
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: "paused" });
      paused = false;
      delete process.env.MODEL_API_KEY;
      const none = await createDatasetRoute(datasetReq({ task, count: 50 }));
      assert.equal(none.status, 503);
      assert.deepEqual(await none.json(), { error: "meta_not_configured" });
      assert.equal(called("createDataset").length + called("start").length, 0);
    });

    it("fails the dataset when its workflow can't start", async () => {
      startFails = true;
      const res = await createDatasetRoute(datasetReq({ task, count: 50 }));
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "start_failed" });
      assert.equal(called("failDataset")[0]!.args[0], DATASET_ID);
      assert.equal(called("attachDatasetRun").length, 0);
    });

    it("lists datasets and shows one with its first examples", async () => {
      datasetRows = { [DATASET_ID]: datasetRow({ status: "ready", trainCount: 410, evalCount: 40 }) };
      const list = (await (await listDatasetsRoute(new Request("https://muse.example.com/api/train/datasets"))).json()) as {
        datasets: Array<Record<string, unknown>>;
      };
      assert.equal(list.datasets.length, 1);
      assert.equal(list.datasets[0]!.trainCount, 410);
      assert.equal(list.datasets[0]!.writerModel, "muse-spark-1.3", "a dataset with no writer recorded keeps Muse Spark 1.3");

      const detailCtx: Ctx = { params: Promise.resolve({ id: DATASET_ID }) };
      const res = await datasetDetail(new Request(`https://muse.example.com/api/train/datasets/${DATASET_ID}`), detailCtx);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { dataset: { id: string }; sampleTrain: unknown[]; sampleEval: unknown[] };
      assert.equal(body.dataset.id, DATASET_ID);
      assert.equal(body.sampleTrain.length, 5);
      assert.equal(body.sampleEval.length, 5);
      assert.deepEqual(
        called("datasetPage").map((c) => c.args.slice(1)),
        [
          ["train", 0, 5],
          ["eval", 0, 5],
        ],
      );
      const missing = await datasetDetail(new Request("https://muse.example.com/api/train/datasets/x"), {
        params: Promise.resolve({ id: "ffffffff-0000-4000-8000-00000000000f" }),
      });
      assert.equal(missing.status, 404);
    });
  });

  describe("decision datasets", () => {
    const datasetReq = (body: unknown) =>
      new Request("https://muse.example.com/api/train/datasets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const tickets = (over: Record<string, unknown> = {}) => ({
      kind: "decision",
      title: "Ticket router",
      question: TICKET_QUESTION,
      labels: TICKET_LABELS,
      rows: ticketRows(),
      ...over,
    });

    it("saves a person's rows ready at once with \"person\" as the writer, spending nothing and starting no workflow", async () => {
      // Nothing is written by a model, so neither the key nor room under the spend cap is needed.
      delete process.env.MODEL_API_KEY;
      paused = true;
      const res = await createDatasetRoute(datasetReq(tickets()));
      assert.equal(res.status, 201);
      const input = called("createDecisionDataset")[0]!.args[0] as { title: string; spec: DecisionSpec; rows: DecisionRows; createdBy: string };
      assert.equal(input.title, "Ticket router");
      assert.equal(input.createdBy, "admin-1");
      assert.match(input.spec.seed, /^[0-9a-f]{24}$/, "a random seed of its own");
      const expected = checkDecisionUpload(tickets(), input.spec.seed);
      assert.ok(expected.ok);
      assert.deepEqual(input.spec, expected.spec);
      assert.deepEqual(input.rows, expected.rows);
      assert.equal(called("start").length + called("createDataset").length, 0);
      const body = (await res.json()) as { dataset: Record<string, unknown>; report: Record<string, unknown> };
      assert.equal(body.dataset.kind, "decision");
      assert.equal(body.dataset.status, "ready");
      assert.equal(body.dataset.writerModel, "person");
      assert.equal(body.dataset.task, TICKET_QUESTION);
      assert.deepEqual(body.dataset.decision, expected.spec);
      assert.equal(body.dataset.trainCount, 84);
      assert.equal(body.dataset.evalCount, 24);
      assert.equal("createdBy" in body.dataset, false);
      assert.deepEqual(body.report, expected.report);

      const seeds = new Set([input.spec.seed]);
      await createDatasetRoute(datasetReq({ ...tickets({ rows: undefined }), csv: ticketCsv(ticketRows()) }));
      await createDatasetRoute(datasetReq({ ...tickets({ rows: undefined }), jsonl: ticketRows().map((r) => JSON.stringify(r)).join("\n") }));
      for (const c of called("createDecisionDataset").slice(1)) seeds.add((c.args[0] as { spec: DecisionSpec }).spec.seed);
      assert.equal(seeds.size, 3, "each dataset gets its own seed");
    });

    it("answers 400 with every problem by line, before saving anything", async () => {
      const csv = ticketCsv(ticketRows()).split("\n");
      csv[2] = '"where is my parcel",Shiping';
      csv[9] = "a, b, Billing";
      const res = await createDatasetRoute(datasetReq({ ...tickets({ rows: undefined }), csv: csv.join("\n") }));
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string; problems: Array<{ line: number | null; message: string }> };
      assert.deepEqual(body.problems.map((p) => p.line), [3, 10], "a broken line and an unknown label, together");
      assert.match(body.error, /^The upload has 2 problems\. The first: The label "Shiping"/);
      csv[9] = '"fine",Billing';
      const unknown = (await (await createDatasetRoute(datasetReq({ ...tickets({ rows: undefined }), csv: csv.join("\n") }))).json()) as {
        problems: Array<{ line: number | null; message: string }>;
      };
      assert.deepEqual(unknown.problems, [{ line: 3, message: `The label "Shiping" isn't one of this decision's labels (line 3).` }]);
      const few = await createDatasetRoute(datasetReq(tickets({ rows: ticketRows([30, 19, 30, 30]) })));
      assert.equal(few.status, 400);
      assert.equal(((await few.json()) as { error: string }).error, '"Shipping" has 19 examples; each label needs at least 20.');
      assert.equal(called("createDecisionDataset").length, 0);
    });

    it("refuses an unknown kind, a chat body over 16 KB and any body over 4 MB", async () => {
      const odd = await createDatasetRoute(datasetReq({ kind: "decison", task: "Explain Python error messages to beginners.", count: 50 }));
      assert.equal(odd.status, 400, "a typo never starts a paid chat dataset");
      assert.equal(called("createDataset").length, 0);
      const chat = await createDatasetRoute(datasetReq({ task: "Explain Python error messages to beginners.", count: 50, note: "x".repeat(17 * 1024) }));
      assert.equal(chat.status, 413);
      // 9,000 characters of a 2-byte letter: under 16K characters, over 16 KB of bytes.
      const wide = await createDatasetRoute(datasetReq({ task: "Explain Python error messages to beginners.", count: 50, note: "é".repeat(9_000) }));
      assert.equal(wide.status, 413, "the chat limit counts bytes");
      assert.equal(called("createDataset").length, 0);
      const huge = await createDatasetRoute(datasetReq(tickets({ rows: undefined, csv: "x".repeat(4 * 1024 * 1024) })));
      assert.equal(huge.status, 413);
      const big = ticketRows().map((r, i) => ({ ...r, input: `${r.input} ${"long words here ".repeat(150)}`.slice(0, 2_900 - (i % 7)) }));
      assert.ok(JSON.stringify(big).length > 16 * 1024);
      assert.equal((await createDatasetRoute(datasetReq(tickets({ rows: big })))).status, 201, "a decision upload may be large");
    });

    it("shows a decision dataset with its spec and 5 rows a label, read by index", async () => {
      const checked = checkDecisionUpload(tickets(), "route-seed");
      assert.ok(checked.ok);
      datasetRows = { [DATASET_ID]: datasetRow({ kind: "decision", status: "ready", decision: checked.spec, writerModel: "person" }) };
      decisionRowsById = { [DATASET_ID]: checked.rows };
      const res = await datasetDetail(new Request(`https://muse.example.com/api/train/datasets/${DATASET_ID}`), { params: Promise.resolve({ id: DATASET_ID }) });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { dataset: { decision: DecisionSpec; kind: string }; sampleTrain: unknown[]; sampleEval: unknown[]; sampleRows: Record<string, unknown[]> };
      assert.equal(body.dataset.kind, "decision");
      assert.deepEqual(body.dataset.decision, checked.spec);
      assert.deepEqual(Object.keys(body.sampleRows), ["billing", "shipping", "account", "returns"]);
      assert.deepEqual(body.sampleRows.shipping, checked.rows.train.slice(21, 26));
      assert.deepEqual(body.sampleTrain, []);
      assert.deepEqual(called("decisionSplitRows")[0]!.args, [DATASET_ID, "train", [0, 1, 2, 3, 4, 21, 22, 23, 24, 25, 42, 43, 44, 45, 46, 63, 64, 65, 66, 67]]);
      assert.equal(called("datasetPage").length, 0);
    });
  });

  describe("decision dataset pages", () => {
    const pageReq = (query: string) =>
      new Request(`https://muse.example.com/api/train/jobs/${JOB_ID}/dataset${query}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    let spec: DecisionSpec;
    let rows: DecisionRows;
    const all = (list: DecisionRows["train"]) => new Map(list.map((r, i) => [i, r]));

    beforeEach(() => {
      const checked = checkDecisionUpload({ question: TICKET_QUESTION, labels: TICKET_LABELS, rows: ticketRows([60, 40, 40, 40]) }, "pages-seed");
      assert.ok(checked.ok);
      ({ spec, rows } = checked);
      jobExtra = { recipe: "glimmer-lora", params: { datasetId: DATASET_ID, mode: "decide", epochs: 2 } };
      datasetRows = { [DATASET_ID]: datasetRow({ kind: "decision", status: "ready", decision: spec, writerModel: "person" }) };
      decisionRowsById = { [DATASET_ID]: rows };
    });

    it("pages train renderings 50 at a time, reading only the rows each page renders", async () => {
      const first = await jobDataset(pageReq("?part=train&page=0"), ctx);
      assert.equal(first.status, 200);
      const body = (await first.json()) as { kind: string; items: unknown[]; nextPage: number | null; total: number; title: string };
      const expected = decisionPage(spec, "train", 2, 0, all(rows.train));
      assert.equal(body.kind, "decision");
      assert.equal(body.items.length, DECIDE_PAGE_SIZE);
      assert.deepEqual(body.items, expected.items);
      assert.equal(body.total, expected.total);
      assert.equal(body.nextPage, 1);
      assert.equal(body.title, "Python errors");
      const read = called("decisionSplitRows")[0]!.args as [string, string, number[]];
      assert.equal(read[1], "train");
      assert.ok(read[2].length <= DECIDE_PAGE_SIZE, "only this page's rows");
      assert.equal(called("datasetPage").length, 0);

      const last = Math.ceil(expected.total / DECIDE_PAGE_SIZE) - 1;
      const end = (await (await jobDataset(pageReq(`?part=train&page=${last}`), ctx)).json()) as { nextPage: number | null };
      assert.equal(end.nextPage, null);
      jobExtra = { recipe: "glimmer-lora", params: { datasetId: DATASET_ID, mode: "decide", epochs: 3 } };
      const three = (await (await jobDataset(pageReq("?part=train"), ctx)).json()) as { total: number };
      assert.equal(three.total, decisionPage(spec, "train", 3, 0, all(rows.train)).total, "the job's own epochs");
    });

    it("pages dev and eval (the test split) as items with no answer, the layout scoring reads back", async () => {
      for (const [part, split] of [["dev", "dev"], ["eval", "test"]] as const) {
        const res = await jobDataset(pageReq(`?part=${part}&page=0`), ctx);
        assert.equal(res.status, 200, part);
        const body = (await res.json()) as { items: DecideItem[]; total: number; nextPage: number | null };
        assert.deepEqual(body.items, decisionPage(spec, split, 2, 0, all(rows[split])).items);
        for (const item of body.items) assert.deepEqual(Object.keys(item).sort(), ["group", "index", "letters", "messages", "row"]);
        assert.equal(JSON.stringify(body).includes('"answer"'), false);
      }
      const eval1 = (await (await jobDataset(pageReq("?part=eval&page=1"), ctx)).json()) as { items: DecideItem[]; nextPage: number | null };
      assert.ok(eval1.items.length > 0);
      assert.equal(eval1.items[0]!.index, DECIDE_PAGE_SIZE);
    });

    it("carries decide.json on every page, with T = 1, for the GPU to write next to the adapter", async () => {
      const contract = decideJson({ question: spec.question, labels: spec.labels, T: 1 });
      for (const query of ["?part=train&page=0", "?part=train&page=1", "?part=dev", "?part=eval"]) {
        const body = (await (await jobDataset(pageReq(query), ctx)).json()) as { decideJson: unknown };
        assert.deepEqual(body.decideJson, contract, query);
      }
      datasetRows = { [DATASET_ID]: datasetRow({ status: "ready" }) };
      jobExtra = { recipe: "glimmer-lora", params: { datasetId: DATASET_ID } };
      const chat = (await (await jobDataset(pageReq("?part=train"), ctx)).json()) as Record<string, unknown>;
      assert.equal("decideJson" in chat || "kind" in chat, false, "a chat dataset's pages are as they were");
    });

    it("pages a decide adapter's dataset to its glimmer-serve job, with the adapter's mode", async () => {
      const adapterId = "aaaaaaaa-0000-4000-8000-000000000000";
      jobExtra = { recipe: "glimmer-serve", params: { adapterJobId: adapterId, minutes: 30 } };
      otherJobs = { [adapterId]: { id: adapterId, recipe: "glimmer-lora", params: { datasetId: DATASET_ID, mode: "decide", epochs: 1 } } };
      const res = await jobDataset(pageReq("?part=train"), ctx);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { total: number }).total, decisionPage(spec, "train", 1, 0, all(rows.train)).total);
    });

    it("pages a decision dataset only to a job in decide mode, and part=dev only for decision datasets", async () => {
      jobExtra = { recipe: "glimmer-lora", params: { datasetId: DATASET_ID } };
      const chatMode = await jobDataset(pageReq("?part=eval"), ctx);
      assert.equal(chatMode.status, 409);
      assert.deepEqual(await chatMode.json(), { error: "not_decide_mode" });
      assert.equal(called("decisionSplitRows").length, 0);
      datasetRows = { [DATASET_ID]: datasetRow({ status: "ready" }) };
      const dev = await jobDataset(pageReq("?part=dev"), ctx);
      assert.equal(dev.status, 400);
      assert.equal(called("datasetPage").length, 0);
    });

    it("lets a decide job read its own page count plus 120 an hour", async () => {
      const cap = decisionPageCount(spec, decideEpochs({ epochs: 2 })) + 120;
      assert.ok(cap > 120);
      for (let i = 0; i < cap; i++) assert.equal((await jobDataset(pageReq("?part=dev"), ctx)).status, 200, String(i));
      const over = await jobDataset(pageReq("?part=dev"), ctx);
      assert.equal(over.status, 429);
      assert.deepEqual(await over.json(), { error: "rate_limited" });
    });
  });

  describe("upload", () => {
    it("refuses a missing or wrong token", async () => {
      assert.equal((await upload(post("upload", { name: "a.bin", bytes: 3 }, null), ctx)).status, 401);
      assert.equal((await upload(post("upload", { name: "a.bin", bytes: 3 }, "wrong"), ctx)).status, 401);
      assert.equal(grants.length, 0);
    });

    it("grants exactly one blob: a path the platform picks, the declared size and type, no suffix, no overwrite", async () => {
      const before = Date.now();
      const res = await upload(
        post("upload", { name: "../../other/../adapter model.safetensors", bytes: 1234, contentType: "application/octet-stream" }),
        ctx,
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { clientToken: string; pathname: string };
      assert.match(body.pathname, new RegExp(`^models/${JOB_ID}/[0-9a-f]{12}-adapter-model\\.safetensors$`));
      assert.equal(body.clientToken, "vercel_blob_client_teststore_grant");
      const [grant] = grants;
      assert.equal(grant!.token, FAKE_BLOB_TOKEN);
      assert.equal(grant!.pathname, body.pathname);
      assert.equal(grant!.maximumSizeInBytes, 1234);
      assert.equal(grant!.addRandomSuffix, false);
      assert.equal(grant!.allowOverwrite, false);
      assert.deepEqual(grant!.allowedContentTypes, ["application/octet-stream"]);
      // 5 minutes plus 1 MB a second: a few KB gets just over 5 minutes, not an hour.
      const until = grant!.validUntil as number;
      assert.ok(until >= before + 5 * MIN && until <= Date.now() + 5 * MIN + 1_000, String(until - before));
      assert.ok(!JSON.stringify(body).includes(FAKE_BLOB_TOKEN), "the read-write token never goes to the instance");

      const again = (await (await upload(post("upload", { name: "adapter model.safetensors", bytes: 1234 }), ctx)).json()) as {
        pathname: string;
      };
      assert.notEqual(again.pathname, body.pathname, "each grant names a new blob");
    });

    it("gives a large file the time it needs, but never past 15 minutes after the job's time limit", async () => {
      const before = Date.now();
      jobExtra = { launchedAt: new Date(before), maxMinutes: 120 };
      await upload(post("upload", { name: "big.bin", bytes: 1024 ** 3, contentType: "application/octet-stream" }), ctx);
      const big = grants[0]!.validUntil as number;
      assert.ok(big >= before + 5 * MIN + 1024_000 && big <= Date.now() + 30 * MIN, String(big - before));

      // A launch that was never saved: 15 minutes at most.
      jobExtra = {};
      await upload(post("upload", { name: "unsaved.bin", bytes: 1024 ** 3 }), ctx);
      assert.ok((grants[1]!.validUntil as number) <= Date.now() + 15 * MIN);

      // Launched 40 minutes ago with a 30-minute limit: the token ends 5 minutes from now.
      jobExtra = { launchedAt: new Date(before - 40 * MIN), maxMinutes: 30 };
      await upload(post("upload", { name: "late.bin", bytes: 1024 ** 3 }), ctx);
      assert.equal(grants[2]!.validUntil, before - 40 * MIN + 45 * MIN);

      jobExtra = { launchedAt: new Date(before - 50 * MIN), maxMinutes: 30 };
      const over = await upload(post("upload", { name: "too-late.bin", bytes: 3 }), ctx);
      assert.equal(over.status, 409);
      assert.equal(grants.length, 3);
    });

    it("refuses media types and names a browser could open as a page", async () => {
      for (const contentType of ["text/html", "image/svg+xml", "application/xhtml+xml", "x", 7]) {
        const res = await upload(post("upload", { name: "a.bin", bytes: 3, contentType }), ctx);
        assert.equal(res.status, 400, String(contentType));
      }
      for (const name of ["index.html", "a.HTM", "logo.svg", "page.xhtml", "feed.xml"]) {
        const res = await upload(post("upload", { name, bytes: 3, contentType: "text/plain" }), ctx);
        assert.equal(res.status, 400, name);
      }
      assert.equal((await upload(post("upload", { name: "metrics.json", bytes: 3, contentType: "application/json" }), ctx)).status, 200);
      assert.deepEqual(grants.map((g) => g.allowedContentTypes), [["application/json"]]);
    });

    it("caps the bytes granted to one job per hour", async () => {
      for (let i = 0; i < 5; i++) assert.equal((await upload(post("upload", { name: `c${i}.bin`, bytes: 1024 ** 3 }), ctx)).status, 200);
      const over = await upload(post("upload", { name: "c5.bin", bytes: 1 }), ctx);
      assert.equal(over.status, 413);
      assert.equal(((await over.json()) as { error: string }).error, "upload_budget");
      assert.equal(grants.length, 5);
    });

    it("refuses files over 1 GB, an ended job, and answers 503 when there is no storage", async () => {
      assert.equal((await upload(post("upload", { name: "a.bin", bytes: 1024 ** 3 + 1 }), ctx)).status, 413);
      assert.equal((await upload(post("upload", { name: "///", bytes: 3 }), ctx)).status, 400);
      jobStatus = "failed";
      assert.equal((await upload(post("upload", { name: "a.bin", bytes: 3 }), ctx)).status, 409);
      jobStatus = "running";
      delete process.env.BLOB_READ_WRITE_TOKEN;
      const none = await upload(post("upload", { name: "a.bin", bytes: 3 }), ctx);
      assert.equal(none.status, 503);
      assert.deepEqual(await none.json(), { error: "no_storage" });
      assert.equal(grants.length, 0);
    });

    it("caps upload tokens per job per hour", async () => {
      for (let i = 0; i < 20; i++) assert.equal((await upload(post("upload", { name: `f${i}.bin`, bytes: 3 }), ctx)).status, 200);
      const over = await upload(post("upload", { name: "one-more.bin", bytes: 3 }), ctx);
      assert.equal(over.status, 429);
      assert.deepEqual(await over.json(), { error: "upload_limit" });
      assert.equal(grants.length, 20);
    });
  });

  describe("stop", () => {
    const stopReq = () => new Request(`https://muse.example.com/api/train/jobs/${JOB_ID}/stop`, { method: "POST", body: "{}" });

    it("terminates a running job's instance right away and records it as stopped", async () => {
      stopRow = { ...jobRow({}), status: "running", instanceId: "inst-1", stopRequested: true };
      const res = await stopRoute(stopReq(), ctx);
      assert.equal(res.status, 200);
      assert.deepEqual(called("terminateInstances")[0]!.args[0], ["inst-1"]);
      const [, input] = called("finishJob")[0]!.args as [string, { status: string; reason: string }];
      assert.equal(input.status, "stopped");
    });

    it("says the sweep takes over when Lambda doesn't answer, and can be pressed again", async () => {
      stopRow = { ...jobRow({}), status: "running", instanceId: "inst-1", stopRequested: true };
      terminateFails = true;
      const res = await stopRoute(stopReq(), ctx);
      assert.equal(res.status, 200);
      assert.equal(called("finishJob").length, 0);
      const [, log] = called("recordEvent")[0]!.args as [string, { text: string }];
      assert.match(log.text, /5-minute sweep will terminate the instance/);
      assert.doesNotMatch(log.text, /next check/);

      terminateFails = false;
      assert.equal((await stopRoute(stopReq(), ctx)).status, 200);
      assert.equal(called("finishJob").length, 1, "the second press terminated it");
    });

    it("terminates an ended job's instance again until it is confirmed, keeping the job's status", async () => {
      stopRow = null;
      jobStatus = "failed";
      const res = await stopRoute(stopReq(), ctx);
      assert.equal(res.status, 200);
      assert.deepEqual(called("terminateInstances")[0]!.args[0], ["inst-1"]);
      const [, input] = called("finishJob")[0]!.args as [string, { status: string }];
      assert.equal(input.status, "failed");
    });

    it("answers 409 once the instance is confirmed terminated or never existed, and 404 for an unknown job", async () => {
      jobStatus = "succeeded";
      jobExtra = { terminatedAt: new Date() };
      assert.equal((await stopRoute(stopReq(), ctx)).status, 409);
      jobExtra = { instanceId: null };
      assert.equal((await stopRoute(stopReq(), ctx)).status, 409);
      const other = await stopRoute(stopReq(), { params: Promise.resolve({ id: "ffffffff-0000-4000-8000-000000000000" }) });
      assert.equal(other.status, 404);
      assert.equal(called("terminateInstances").length, 0);
    });
  });

  describe("create job", () => {
    const created = () => called("createJob").length;

    it("refuses while the 5-minute sweep can't run here, before asking Lambda or creating anything", async () => {
      delete process.env.CRON_SECRET;
      const unset = await createJobRoute(createReq({ recipe: "smoke" }));
      assert.equal(unset.status, 503);
      assert.deepEqual(await unset.json(), { error: "sweep_not_configured", reason: "cron_secret_unset" });

      process.env.CRON_SECRET = "test-cron-secret";
      process.env.VERCEL_ENV = "preview";
      const preview = await createJobRoute(createReq({ recipe: "smoke" }));
      assert.equal(preview.status, 503);
      assert.deepEqual(await preview.json(), { error: "sweep_not_configured", reason: "not_production" });
      delete process.env.VERCEL_ENV;
      assert.equal((await createJobRoute(createReq({ recipe: "smoke" }))).status, 503, "a local run has no cron either");
      assert.equal(created() + called("listInstanceTypes").length, 0);

      process.env.TRAIN_ALLOW_OUTSIDE_PRODUCTION = "1";
      assert.equal((await createJobRoute(createReq({ recipe: "smoke" }))).status, 201, "an explicit opt-in for a test");
      delete process.env.CRON_SECRET;
      assert.equal((await createJobRoute(createReq({ recipe: "smoke" }))).status, 503, "the opt-in never lifts CRON_SECRET");
    });

    it("refuses until the sweep has run with Lambda answering in the last 15 minutes", async () => {
      lastSweep = null;
      const never = await createJobRoute(createReq({ recipe: "smoke" }));
      assert.equal(never.status, 503);
      assert.deepEqual(await never.json(), { error: "sweep_not_running", lastSweepAt: null });

      lastSweep = new Date(Date.now() - 16 * MIN);
      const stale = await createJobRoute(createReq({ recipe: "smoke" }));
      assert.equal(stale.status, 503);
      assert.deepEqual(await stale.json(), { error: "sweep_not_running", lastSweepAt: lastSweep.toISOString() });
      assert.equal(created() + called("listInstanceTypes").length, 0, "before asking Lambda or creating anything");

      process.env.TRAIN_ALLOW_OUTSIDE_PRODUCTION = "1";
      process.env.VERCEL_ENV = "preview";
      assert.equal((await createJobRoute(createReq({ recipe: "smoke" }))).status, 503, "the opt-in doesn't lift it either");

      lastSweep = new Date(Date.now() - 14 * MIN);
      assert.equal((await createJobRoute(createReq({ recipe: "smoke" }))).status, 201);
    });

    it("queues a job with clamped limits and starts its workflow once", async () => {
      const res = await createJobRoute(createReq({ recipe: "smoke", maxMinutes: 500, maxUsd: 0.5 }));
      assert.equal(res.status, 201);
      const input = called("createJob")[0]!.args[0] as Record<string, unknown>;
      assert.equal(input.maxMinutes, 120, "the ceiling's 120 minutes, under the 500 asked");
      assert.equal(input.maxUsd, 0.5);
      assert.equal(input.instanceType, "gpu_1x_a10");
      assert.equal(input.createdBy, "admin-1");
      assert.deepEqual(called("start").map((c) => c.args), [[{ jobId: JOB_ID }]]);
    });

    it("refuses when a job already holds the only GPU, before asking Lambda or creating anything", async () => {
      active = [1];
      const res = await createJobRoute(createReq({ recipe: "smoke" }));
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: "too_many_active", max: 1 });
      assert.equal(created() + called("listInstanceTypes").length, 0);
    });

    it("refuses when the job's dollar limit could take the day past the cap", async () => {
      committed = [19.5];
      const res = await createJobRoute(createReq({ recipe: "smoke" }));
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: "daily_cap", spentUsd: 0.25, committedUsd: 19.5, dailyUsd: 20, jobMaxUsd: 1 });
      assert.equal(created(), 0);
    });

    it("backs out without starting a workflow when another job started at the same moment", async () => {
      active = [0, 2];
      const res = await createJobRoute(createReq({ recipe: "smoke" }));
      assert.equal(res.status, 409);
      assert.equal(created(), 1);
      assert.equal(called("setStatus")[0]!.args[1], "failed");
      assert.equal(called("start").length, 0);

      calls = [];
      active = [0];
      committed = [19, 21];
      const cap = await createJobRoute(createReq({ recipe: "smoke" }));
      assert.equal(cap.status, 503);
      assert.equal(((await cap.json()) as { error: string }).error, "daily_cap");
      assert.equal(called("setStatus")[0]!.args[1], "failed");
      assert.equal(called("start").length, 0);
    });

    it("refuses a platform the instance couldn't report back to over https, and a GPU it can't get", async () => {
      process.env.PLATFORM_URL = "http://muse.example.com";
      const plain = await createJobRoute(createReq({ recipe: "smoke" }));
      assert.equal(plain.status, 503);
      assert.equal(((await plain.json()) as { error: string }).error, "platform_not_public");

      process.env.PLATFORM_URL = "https://muse.example.com";
      gpuFree = false;
      const none = await createJobRoute(createReq({ recipe: "smoke" }));
      assert.equal(none.status, 503);
      assert.equal(((await none.json()) as { error: string }).error, "no_capacity");
      assert.equal(created(), 0);
    });

    it("refuses bad input", async () => {
      for (const body of [{}, { recipe: "nope" }, { recipe: "smoke", maxUsd: -1 }, { recipe: "smoke", params: { allowNoGpu: true } }, { recipe: "smoke", instanceType: "gpu_8x_h100_sxm5" }]) {
        assert.equal((await createJobRoute(createReq(body))).status, 400, JSON.stringify(body));
      }
      assert.equal(created(), 0);
    });

    it("takes a dataset param only when it names a dataset that is ready", async (t) => {
      if (!datasetRecipe) return t.skip("no recipe has a dataset param");
      const ask = (datasetId?: string) => createJobRoute(createReq({ recipe: datasetRecipe!.id, params: datasetId ? { datasetId } : {} }));
      assert.equal((await ask()).status, 400, "required");
      assert.equal((await ask("not-a-dataset")).status, 400);
      const missing = await ask(DATASET_ID);
      assert.equal(missing.status, 400);
      assert.match(((await missing.json()) as { error: string }).error, /doesn't exist/);
      datasetRows = { [DATASET_ID]: datasetRow({ status: "generating" }) };
      assert.match(((await (await ask(DATASET_ID)).json()) as { error: string }).error, /still being written/);
      datasetRows = { [DATASET_ID]: datasetRow({ status: "failed" }) };
      assert.match(((await (await ask(DATASET_ID)).json()) as { error: string }).error, /failed/);
      assert.equal(created() + called("listInstanceTypes").length, 0, "before asking Lambda or creating anything");

      datasetRows = { [DATASET_ID]: datasetRow({ status: "ready" }) };
      const res = await ask(DATASET_ID.toUpperCase());
      assert.equal(res.status, 201);
      assert.equal(((called("createJob")[0]!.args[0] as { params: Record<string, unknown> }).params).datasetId, DATASET_ID);
    });

    it("lets the ceilings, not the recipe's defaults, cap what the admin asks for", async () => {
      process.env.TRAIN_JOB_MAX_MINUTES = "300";
      process.env.TRAIN_JOB_MAX_USD = "40";
      assert.equal((await createJobRoute(createReq({ recipe: "smoke", maxMinutes: 200, maxUsd: 3 }))).status, 201);
      assert.deepEqual(
        [(called("createJob")[0]!.args[0] as Record<string, unknown>).maxMinutes, (called("createJob")[0]!.args[0] as Record<string, unknown>).maxUsd],
        [200, 3],
        "past the smoke test's own 30 minutes and $1",
      );
      calls = [];
      assert.equal((await createJobRoute(createReq({ recipe: "smoke" }))).status, 201);
      const plain = called("createJob")[0]!.args[0] as Record<string, unknown>;
      assert.deepEqual([plain.maxMinutes, plain.maxUsd], [30, 1], "the recipe's defaults when nothing is asked");
    });

    it("refuses a glimmer run that can't fit its limits on the GPU it gets, before creating anything", async (t) => {
      if (!datasetRecipe?.usesCache) return t.skip("no recipe keeps the model cache");
      datasetRows = { [DATASET_ID]: datasetRow({ status: "ready" }) };
      gpuPick = { instanceType: "gpu_1x_a100_sxm4", region: "us-east-1", priceCentsPerHour: 249 };
      const ask = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        createJobRoute(createReq({ recipe: datasetRecipe!.id, params: { datasetId: DATASET_ID, ...params }, ...extra }));

      // 2000 steps at about 12 s each on an A100, plus 45 minutes in a region without the cache: past 120 minutes.
      const long = await ask({ maxSteps: 2000 });
      assert.equal(long.status, 400);
      const body = (await long.json()) as { error: string; estimateMinutes: number; usableMinutes: number };
      assert.deepEqual([body.estimateMinutes, body.usableMinutes], [445, 120]);
      assert.match(body.error, /^2000 training steps on 1x A100 SXM4 \(40 GB\) need about 445 minutes \(400 of training at about 12 s a step/);
      assert.match(body.error, /since this region has no model cache yet\), but this job's limits stop it after 120 minutes\./);
      assert.equal(created(), 0);

      // The same run with the cache in the region: 80 + 20 fits 120 minutes, but not 90.
      cacheRegionsImpl = async () => ["us-east-1"];
      assert.equal((await ask({ maxSteps: 400 })).status, 201);
      calls = [];
      const tight = await ask({ maxSteps: 400 }, { maxMinutes: 90 });
      assert.equal(tight.status, 400);
      assert.equal(((await tight.json()) as { estimateMinutes: number }).estimateMinutes, 100);

      // The dollar limit counts too: $2 buys 48 minutes at $2.49 an hour, and 200 steps need 40 + 20.
      const cheap = await ask({ maxSteps: 200 }, { maxUsd: 2 });
      assert.equal(cheap.status, 400);
      assert.equal(((await cheap.json()) as { usableMinutes: number }).usableMinutes, 48);

      // A dry run doesn't train, so it always fits.
      calls = [];
      assert.equal((await ask({ maxSteps: 2000, dryRun: 1 })).status, 201);
    });

    it("takes decide mode only with a decision dataset, and a decision dataset only in decide mode", async () => {
      const checked = checkDecisionUpload({ question: TICKET_QUESTION, labels: TICKET_LABELS, rows: ticketRows([30, 30, 30, 30]) }, "job-seed");
      assert.ok(checked.ok);
      const decision = datasetRow({ kind: "decision", status: "ready", decision: checked.spec, writerModel: "person" });
      const ask = (params: Record<string, unknown>) => createJobRoute(createReq({ recipe: "glimmer-lora", params: { datasetId: DATASET_ID, ...params } }));
      const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

      datasetRows = { [DATASET_ID]: decision };
      const chat = await ask({});
      assert.equal(chat.status, 400);
      assert.equal(await errorOf(chat), "Dataset: that is a decision dataset, so it trains in decide mode: set Mode to decide.");
      datasetRows = { [DATASET_ID]: datasetRow({ status: "ready" }) };
      const wrong = await ask({ mode: "decide" });
      assert.equal(wrong.status, 400);
      assert.equal(await errorOf(wrong), "Dataset: decide mode trains on a decision dataset, and that one is a chat dataset.");
      datasetRows = { [DATASET_ID]: decision };
      assert.equal((await ask({ mode: "decide", publish: 1 })).status, 400, "a person's rows are never published");
      assert.equal((await ask({ mode: "decide", maxSteps: 300 })).status, 400, "decide mode's steps come from its epochs");
      const chosen = await ask({ mode: "decide", baseModel: "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit" });
      assert.deepEqual([chosen.status, await errorOf(chosen)], [400, "Unknown parameter: baseModel."], "the platform writes the base, never a caller");
      assert.equal(created() + called("listInstanceTypes").length, 0, "before asking Lambda or creating anything");

      const res = await ask({ mode: "decide", epochs: 3 });
      assert.equal(res.status, 201);
      assert.deepEqual(called("start").map((c) => c.args), [[{ jobId: JOB_ID, mode: "decide" }]], "scored after its run, never judged");
      assert.deepEqual((called("createJob")[0]!.args[0] as { params: Record<string, unknown> }).params, {
        datasetId: DATASET_ID,
        mode: "decide",
        epochs: 3,
        learningRate: 0.0002,
        loraRank: 16,
        scoreOnly: 0,
        dryRun: 0,
        publish: 0,
        baseModel: "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit",
      });
    });

    it("refuses a decide run its limits would cut off, from what its dataset makes it train and score", async () => {
      gpuPick = { instanceType: "gpu_1x_a100_sxm4", region: "us-east-1", priceCentsPerHour: 249 };
      cacheRegionsImpl = async () => ["us-east-1"];
      const checked = checkDecisionUpload({ question: TICKET_QUESTION, labels: TICKET_LABELS, rows: ticketRows([60, 60, 60, 60]) }, "fit-seed");
      assert.ok(checked.ok);
      datasetRows = { [DATASET_ID]: datasetRow({ kind: "decision", status: "ready", decision: checked.spec, writerModel: "person" }) };
      const params = { datasetId: DATASET_ID, mode: "decide", epochs: 4 };
      const ask = (over: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        createJobRoute(createReq({ recipe: "glimmer-lora", params: { ...params, ...over }, ...extra }));
      const want = runEstimate("glimmer-lora", params, "gpu_1x_a100_sxm4", true, decideRunSize(checked.spec, params))!;
      assert.equal(want.what, "decide");

      const tight = await ask({}, { maxMinutes: want.minutes - 1 });
      assert.equal(tight.status, 400);
      const body = (await tight.json()) as { error: string; estimateMinutes: number; usableMinutes: number };
      assert.deepEqual([body.estimateMinutes, body.usableMinutes], [want.minutes, want.minutes - 1]);
      assert.ok(body.error.startsWith(`Training on ${want.renderings} renderings and scoring ${want.scored} prompts before and after on 1x A100 SXM4 (40 GB) needs about ${want.minutes} minutes`), body.error);
      assert.equal(created(), 0);

      assert.equal((await ask({}, { maxMinutes: want.minutes })).status, 201);
      calls = [];
      assert.equal((await ask({ dryRun: 1 }, { maxMinutes: 5 })).status, 201, "a dry run trains nothing, so it always fits");
    });

    it("prefers the regions that already hold the model cache, for a recipe that keeps one", async (t) => {
      if (!datasetRecipe?.usesCache) return t.skip("no recipe keeps the model cache");
      datasetRows = { [DATASET_ID]: datasetRow({ status: "ready" }) };
      const res = await createJobRoute(createReq({ recipe: datasetRecipe.id, params: { datasetId: DATASET_ID }, instanceType: "" }));
      assert.equal(res.status, 201);
      assert.deepEqual(called("pickGpu")[0]!.args.slice(2), [undefined, ["us-south-1"]]);

      calls = [];
      cacheRegionsImpl = async () => {
        throw new FakeLambdaApiError(502, null, "Lambda is down");
      };
      assert.equal((await createJobRoute(createReq({ recipe: datasetRecipe.id, params: { datasetId: DATASET_ID } }))).status, 201);
      assert.deepEqual(called("pickGpu")[0]!.args[3], [], "a preference only: every region when the listing fails");

      calls = [];
      assert.equal((await createJobRoute(createReq({ recipe: "smoke" }))).status, 201);
      assert.equal(called("cacheRegions").length, 0, "the smoke test keeps no cache");
      assert.deepEqual(called("pickGpu")[0]!.args[3], []);
    });
  });

  describe("create live demo job", () => {
    const ADAPTER = "aaaaaaaa-0000-4000-8000-000000000000";
    const created = () => called("createJob").length;
    const adapterJob = (over: Record<string, unknown> = {}) => ({
      id: ADAPTER,
      recipe: "glimmer-lora",
      status: "succeeded",
      region: "us-west-1",
      params: { datasetId: DATASET_ID, maxSteps: 120 },
      ...over,
    });
    const plainCached = { cache_used: "yes", adapter_dir: `/lambda/nfs/muse-muse-cache-us-west-1/models/${ADAPTER}` };
    const cached = { ...plainCached, base_model: "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit" };
    const ask = (params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
      createJobRoute(createReq({ recipe: "glimmer-serve", params: { adapterJobId: ADAPTER, ...params }, ...extra }));
    let serveRecipe: { id: string } | undefined;

    before(async () => {
      const { RECIPES } = (await import(new URL("../recipes/index.ts", import.meta.url).href)) as typeof import("../recipes/index");
      serveRecipe = RECIPES.find((r) => r.id === "glimmer-serve");
    });

    beforeEach(() => {
      adapterSources = { [ADAPTER]: { job: adapterJob(), metrics: cached } };
      gpuPick = { instanceType: "gpu_1x_h100_sxm5", region: "us-west-1", priceCentsPerHour: 429 };
    });

    it("refuses an adapter that can't be served, before asking Lambda or creating anything", async (t) => {
      if (!serveRecipe) return t.skip("no glimmer-serve recipe");
      const reasons: Array<[Record<string, unknown> | null, Record<string, unknown> | null, RegExp]> = [
        [null, null, /doesn't exist/],
        [adapterJob({ recipe: "smoke" }), cached, /isn't a Muse Glimmer LoRA job/],
        [adapterJob({ status: "failed" }), cached, /didn't succeed/],
        [adapterJob({ params: { datasetId: DATASET_ID, dryRun: 1 } }), cached, /dry run/],
        [adapterJob(), { cache_used: "no", adapter_dir: `/opt/muse/models/${ADAPTER}` }, /isn't on a model cache filesystem/],
        [adapterJob(), null, /isn't on a model cache filesystem/],
        // Trained on plain Glimmer before the switch: the demo GPU loads r30b, which it never trained on.
        [adapterJob(), plainCached, /trained on plain Muse Glimmer/],
      ];
      for (const [job, metrics, reason] of reasons) {
        adapterSources = job ? { [ADAPTER]: { job, metrics } } : {};
        const res = await ask();
        assert.equal(res.status, 400, String(reason));
        assert.match(((await res.json()) as { error: string }).error, reason);
      }
      assert.equal((await ask({ adapterJobId: "not-a-job" })).status, 400);
      assert.equal((await createJobRoute(createReq({ recipe: "glimmer-serve", params: {} }))).status, 400, "the adapter is required");
      assert.equal(created() + called("listInstanceTypes").length, 0);
    });

    it("still takes a plain-Glimmer adapter for glimmer-publish, which loads no base", async () => {
      adapterSources = { [ADAPTER]: { job: adapterJob(), metrics: plainCached } };
      const res = await createJobRoute(createReq({ recipe: "glimmer-publish", params: { adapterJobId: ADAPTER } }));
      const body = (await res.json()) as { error?: string };
      assert.doesNotMatch(String(body.error ?? ""), /plain Muse Glimmer/);
    });

    it("launches only in the adapter's region, with limits sized for its minutes", async (t) => {
      if (!serveRecipe) return t.skip("no glimmer-serve recipe");
      const res = await ask({ adapterJobId: ADAPTER.toUpperCase() });
      assert.equal(res.status, 201);
      const pick = called("pickGpu")[0]!.args;
      assert.deepEqual(pick.slice(3), [["us-west-1"], "us-west-1"], "pinned to the adapter's cache region");
      assert.equal(called("cacheRegions").length, 0, "no need to look for cache regions");
      const input = called("createJob")[0]!.args[0] as Record<string, unknown>;
      // The platform writes the adapter's trainChannel (0: trained before it), which the GPU's chat route reads.
      assert.deepEqual(input.params, { adapterJobId: ADAPTER, minutes: 30, trainChannel: 0 });
      // 30 minutes plus 15 to boot; dollars for 46 minutes at $4.29 an hour, rounded up to the cent.
      assert.deepEqual([input.maxMinutes, input.maxUsd], [45, 3.29]);
      assert.equal(input.region, "us-west-1");

      calls = [];
      assert.equal((await ask({ minutes: 20 })).status, 201);
      const twenty = called("createJob")[0]!.args[0] as Record<string, unknown>;
      assert.deepEqual([twenty.maxMinutes, twenty.maxUsd], [35, 2.58]);
      calls = [];
      assert.equal((await ask({ minutes: 20 }, { maxMinutes: 60, maxUsd: 4 })).status, 201);
      const asked = called("createJob")[0]!.args[0] as Record<string, unknown>;
      assert.deepEqual([asked.maxMinutes, asked.maxUsd], [60, 4], "what the admin asks for still wins under the ceilings");

      // An adapter trained with trainChannel 1 gets it on its serve job; a caller can never send it.
      calls = [];
      adapterSources = { [ADAPTER]: { job: adapterJob({ params: { datasetId: DATASET_ID, maxSteps: 120, trainChannel: 1 } }), metrics: cached } };
      assert.equal((await ask()).status, 201);
      assert.equal((called("createJob")[0]!.args[0] as { params: Record<string, unknown> }).params.trainChannel, 1);
      calls = [];
      const sent = await ask({ trainChannel: 1 });
      assert.equal(sent.status, 400);
      assert.match(((await sent.json()) as { error: string }).error, /Unknown parameter: trainChannel/);
      assert.equal(created(), 0);
    });

    it("refuses a demo its limits can't serve for all its minutes on the GPU it gets", async (t) => {
      if (!serveRecipe) return t.skip("no glimmer-serve recipe");
      // 60 minutes plus 15 is 75, but the $5 ceiling buys 69 minutes of an H100 SXM5 at $4.29 an hour.
      const res = await ask({ minutes: 60 });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string; estimateMinutes: number; usableMinutes: number };
      assert.deepEqual([body.estimateMinutes, body.usableMinutes], [75, 69]);
      assert.match(body.error, /^A 60-minute live demo needs about 75 minutes of GPU time .* stop it after 69 minutes on 1x H100 SXM5 \(80 GB\)\./);
      assert.equal(created(), 0);

      gpuPick = { instanceType: "gpu_1x_a100_sxm4", region: "us-west-1", priceCentsPerHour: 199 };
      assert.equal((await ask({ minutes: 60 })).status, 201, "an A100 fits the same limits");
    });

    it("answers no_capacity with the region when the adapter's region has no free GPU, and demo_running for a second demo", async (t) => {
      if (!serveRecipe) return t.skip("no glimmer-serve recipe");
      gpuFree = false;
      const none = await ask();
      assert.equal(none.status, 503);
      const body = (await none.json()) as { error: string; region: string };
      assert.deepEqual([body.error, body.region], ["no_capacity", "us-west-1"]);

      gpuFree = true;
      liveDemo = { serveJobId: "bbbbbbbb-0000-4000-8000-000000000000", state: "live", minutes: 30, endsAt: null };
      const twice = await ask();
      assert.equal(twice.status, 409);
      assert.deepEqual(await twice.json(), { error: "demo_running", serveJobId: "bbbbbbbb-0000-4000-8000-000000000000" });
      assert.equal(created(), 0);
    });

    it("backs out the later of two demos of one adapter asked for at the same moment, so only one GPU serves it", async (t) => {
      if (!serveRecipe) return t.skip("no glimmer-serve recipe");
      // Both passed the demo_running check; this one's row was created second.
      earlierDemo = { id: "cccccccc-0000-4000-8000-000000000000" };
      const later = await ask();
      assert.equal(later.status, 409);
      assert.deepEqual(await later.json(), { error: "demo_running", serveJobId: "cccccccc-0000-4000-8000-000000000000" });
      assert.deepEqual(called("earlierOpenServeJob")[0]!.args, [ADAPTER, JOB_ID], "asked about this new job's own row");
      const [, status, opts] = called("setStatus")[0]!.args as [string, string, { set: { error: string } }];
      assert.equal(status, "failed");
      assert.match(opts.set.error, /Another live demo of this adapter started at the same moment/);
      assert.equal(called("start").length, 0, "nothing launched");
      assert.ok(order().indexOf("createJob") < order().indexOf("earlierOpenServeJob"), "checked once the new row exists");

      // The earlier one finds none before it, and launches.
      earlierDemo = null;
      calls = [];
      assert.equal((await ask()).status, 201);
      assert.equal(called("earlierOpenServeJob").length, 1);
      assert.equal(called("start").length, 1);

      // Other recipes never ask.
      calls = [];
      assert.equal((await createJobRoute(createReq({ recipe: "smoke" }))).status, 201);
      assert.equal(called("earlierOpenServeJob").length, 0);
    });

    it("stores a serve job's minutes whole, so the limits, the page and the GPU count the same minutes", async (t) => {
      if (!serveRecipe) return t.skip("no glimmer-serve recipe");
      assert.equal((await ask({ minutes: 29.6 })).status, 201);
      const input = called("createJob")[0]!.args[0] as Record<string, unknown>;
      assert.deepEqual(input.params, { adapterJobId: ADAPTER, minutes: 29, trainChannel: 0 }, "rounded down, as serveMinutes and the GPU read it");
      assert.equal(input.maxMinutes, 29 + 15);
      calls = [];
      assert.equal((await ask({ minutes: "10.5" })).status, 201);
      assert.equal(((called("createJob")[0]!.args[0] as Record<string, unknown>).params as Record<string, unknown>).minutes, 10);
    });
  });

  describe("sweep cron", () => {
    const cronReq = (secret = "test-cron-secret") =>
      new Request("https://muse.example.com/api/cron/train-sweep", { headers: { authorization: `Bearer ${secret}` } });

    it("notes a run whose Lambda listing answered, which is what lets jobs start", async () => {
      const res = await sweepCron(cronReq());
      assert.equal(res.status, 200);
      assert.deepEqual(order(), ["sweepTraining", "recordSweepOk"]);
    });

    it("doesn't note a run whose listing failed, and reports a note that failed", async () => {
      sweepResult = { ...sweepResult, instances: null, errors: ["Listing Lambda instances failed: 502"] };
      assert.equal((await sweepCron(cronReq())).status, 500);
      assert.equal(called("recordSweepOk").length, 0);

      sweepResult = { ...sweepResult, instances: 2, errors: [] };
      recordSweepFails = true;
      const res = await sweepCron(cronReq());
      assert.equal(res.status, 500);
      const body = (await res.json()) as { result: { errors: string[] } };
      assert.match(body.result.errors[0]!, /Noting the sweep's run failed/);
    });

    it("refuses a wrong secret before sweeping", async () => {
      assert.equal((await sweepCron(cronReq("wrong"))).status, 401);
      assert.equal(called("sweepTraining").length, 0);
    });
  });
});
