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
 * sweep cron notes each run whose Lambda listing answered.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/routes.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import type { TrainCallback } from "../types";

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
    return jobId === JOB_ID ? { ...jobRow({}), status: jobStatus, instanceId: "inst-1", terminatedAt: null, ...jobExtra } : null;
  },
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
};

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
        pickGpu: () => (gpuFree ? { instanceType: "gpu_1x_a10", region: "us-east-1", priceCentsPerHour: 75 } : null),
      },
    });
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
    lastSweep = new Date(Date.now() - 4 * MIN);
    sweepResult = { instances: 0, terminated: [], failedJobs: [], stoppedJobs: [], errors: [] };
    recordSweepFails = false;
    process.env.BLOB_READ_WRITE_TOKEN = FAKE_BLOB_TOKEN;
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
      assert.equal(input.maxMinutes, 30, "the recipe's 30 minutes, under the 500 asked");
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
