/**
 * Runs the real training steps in steps.ts with the Lambda client and the store faked: the launch happens once even
 * when a step is retried, runs twice at once or the database fails right after it, only the token's hash is stored
 * and it is stored before the launch, the token stays out of step results and errors, terminate finds every instance
 * under the job's name and terminates the workflow's instance before reading the database, a check survives a
 * Lambda or database outage, a recipe with usesCache launches with its region's cache filesystem mounted, the
 * runner's deadline is never after the job's time limit, a glimmer-serve job (only it) launches with the demo
 * firewall ruleset attached and its serving key in job.json, and a glimmer-publish job mounts only the cache already in
 * its adapter's region. Nothing here calls Lambda or a database.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/steps.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import type { LambdaInstance } from "../lambda";
import type { TrainJobRow } from "../logic";

const MIN = 60_000;
const JOB_ID = "1234abcd-0000-4000-8000-000000000000";
const NAME = "mm-train-1234abcd-smoke";

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

class FakeLambdaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "LambdaApiError";
  }
}

type LaunchInput = {
  name: string;
  instanceType: string;
  region: string;
  userData: string;
  sshKeyName: string;
  tags: Array<{ key: string; value: string }>;
  fileSystemNames?: string[];
  firewallRulesetIds?: string[];
};
type Filesystem = { id: string; name: string; region: string; mountPoint: string; inUse: boolean; bytesUsed: number | null };
type Ruleset = { id: string; name: string; region: string; rules: unknown[]; instanceIds: string[] };

let job: TrainJobRow | null = null;
let listing: LambdaInstance[] = [];
let calls: Array<{ fn: string; args: unknown[] }> = [];
let launchImpl: (input: LaunchInput) => Promise<string> = async () => "inst-1";
let listImpl: (() => Promise<LambdaInstance[]>) | null = null;
let getImpl: (id: string) => Promise<LambdaInstance | null> = async (id) => listing.find((i) => i.id === id) ?? null;
let ensureImpl: (region: string) => Promise<Filesystem> = async (region) => cacheFs(region);
let findFsImpl: (region: string) => Promise<Filesystem | null> = async (region) => cacheFs(region);
let firewallImpl: (region: string) => Promise<Ruleset> = async (region) => serveRuleset(region);
/** How many more calls to each store function fail, as a database outage would. */
let dbDown: Record<string, number> = {};

function down(fn: string): void {
  if ((dbDown[fn] ?? 0) <= 0) return;
  dbDown[fn] -= 1;
  throw new Error(`${fn}: fetch failed`);
}

/** Stands in for the peppered HMAC: one-way, so the plaintext can't be read back out of it. */
const fakeHash = (token: string) => createHash("sha256").update(`pepper:${token}`).digest("hex");
const terminal = (s: string) => s === "succeeded" || s === "failed" || s === "stopped";
const called = (fn: string) => calls.filter((c) => c.fn === fn);
/** The fake row as the steps left it (read through a call, so an earlier assertion's narrowing doesn't stick). */
const current = (): TrainJobRow => job!;
const order = () => calls.map((c) => c.fn);

function row(over: Partial<TrainJobRow> = {}): TrainJobRow {
  return {
    id: JOB_ID,
    recipe: "smoke",
    title: "Smoke test",
    status: "queued",
    params: {},
    instanceType: "gpu_1x_a10",
    region: "us-east-1",
    priceCentsPerHour: 75,
    maxMinutes: 30,
    maxUsd: 1,
    instanceId: null,
    instanceName: NAME,
    instanceIp: null,
    tokenHash: null,
    workflowRunId: "run",
    stopRequested: false,
    progress: null,
    artifacts: [],
    summary: null,
    error: null,
    costUsd: 0,
    createdBy: null,
    createdAt: new Date(Date.now() - 2 * MIN),
    launchedAt: null,
    firstHeartbeatAt: null,
    lastHeartbeatAt: null,
    finishedAt: null,
    terminatedAt: null,
    evalSummary: null,
    serveEndpoint: null,
    hub: null,
    ...over,
  };
}

function cacheFs(region: string): Filesystem {
  const name = `muse-muse-cache-${region}`;
  return { id: `fs-${region}`, name, region, mountPoint: `/lambda/nfs/${name}`, inUse: false, bytesUsed: null };
}

function serveRuleset(region: string): Ruleset {
  return { id: `fw-${region}`, name: `muse-muse-serve-${region}`, region, rules: [], instanceIds: [] };
}

function instance(over: Partial<LambdaInstance> & { id: string }): LambdaInstance {
  return { name: NAME, status: "booting", ip: null, instanceType: "gpu_1x_a10", region: "us-east-1", ...over };
}

/** The job.json the user data carries, decoded. */
function jobJson(userData: string): {
  token: string;
  callbackBase: string;
  jobId: string;
  cacheDir?: string;
  deadlineEpoch: number;
  serveKey?: string;
  params: Record<string, unknown>;
} {
  const lines = userData.split("\n");
  const at = lines.findIndex((l) => l.includes("/opt/muse/job.json"));
  const content = lines.slice(at).find((l) => l.trim().startsWith("content:"))!;
  const b64 = content.trim().slice("content: ".length).replace(/^"|"$/g, "");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

const fakeStore = {
  getJob: async (id: string) => {
    calls.push({ fn: "getJob", args: [id] });
    down("getJob");
    return job && job.id === id ? { ...job } : null;
  },
  setStatus: async (id: string, status: TrainJobRow["status"], opts: { message?: string; set?: Partial<TrainJobRow> } = {}) => {
    calls.push({ fn: "setStatus", args: [id, status, opts] });
    down("setStatus");
    if (!job || terminal(job.status)) return false;
    job = { ...job, ...opts.set, status };
    return true;
  },
  claimLaunch: async (id: string, tokenHash: string, message: string) => {
    calls.push({ fn: "claimLaunch", args: [id, tokenHash, message] });
    down("claimLaunch");
    if (!job || job.status !== "queued" || job.stopRequested || job.tokenHash || job.instanceId) return false;
    job = { ...job, status: "launching", tokenHash };
    return true;
  },
  releaseLaunch: async (id: string, tokenHash: string) => {
    calls.push({ fn: "releaseLaunch", args: [id, tokenHash] });
    down("releaseLaunch");
    if (job && job.status === "launching" && job.tokenHash === tokenHash && !job.instanceId) {
      job = { ...job, status: "queued", tokenHash: null };
    }
  },
  markLaunched: async (id: string, input: { instanceId: string; launchedAt: Date; ip?: string | null }) => {
    calls.push({ fn: "markLaunched", args: [id, input] });
    down("markLaunched");
    // As the real one: an ended job, or one that holds another instance, is left alone; a saved launch time is kept.
    if (!job || terminal(job.status) || (job.instanceId && job.instanceId !== input.instanceId)) return false;
    const status = job.status === "queued" || job.status === "launching" ? "booting" : job.status;
    job = { ...job, instanceId: input.instanceId, launchedAt: job.launchedAt ?? input.launchedAt, status };
    if (input.ip !== undefined) job.instanceIp = input.ip;
    return true;
  },
  saveLateLaunch: async (id: string, input: { instanceId: string; launchedAt: Date }) => {
    calls.push({ fn: "saveLateLaunch", args: [id, input] });
    down("saveLateLaunch");
    if (!job || job.instanceId) return false;
    job = { ...job, instanceId: input.instanceId, launchedAt: job.launchedAt ?? input.launchedAt, terminatedAt: null };
    return true;
  },
  finishJob: async (id: string, input: { status: TrainJobRow["status"]; reason: string; terminatedAt: Date; launchedAt?: Date }) => {
    calls.push({ fn: "finishJob", args: [id, input] });
    down("finishJob");
    if (!job) return null;
    job = {
      ...job,
      status: input.status,
      launchedAt: job.launchedAt ?? input.launchedAt ?? null,
      terminatedAt: job.terminatedAt ?? input.terminatedAt,
    };
    return { ...job };
  },
  recordEvent: async (...args: unknown[]) => {
    calls.push({ fn: "recordEvent", args });
    down("recordEvent");
  },
  setInstanceIp: async (id: string, ip: string | null) => {
    calls.push({ fn: "setInstanceIp", args: [id, ip] });
    down("setInstanceIp");
    if (job) job.instanceIp = ip;
  },
};

const fakeLambda = {
  LambdaApiError: FakeLambdaApiError,
  listInstances: async () => {
    calls.push({ fn: "listInstances", args: [] });
    return listImpl ? listImpl() : [...listing];
  },
  findInstanceByName: async (name: string) => {
    calls.push({ fn: "findInstanceByName", args: [name] });
    return listing.find((i) => i.name === name && i.status !== "terminated" && i.status !== "terminating") ?? null;
  },
  getInstance: async (id: string) => {
    calls.push({ fn: "getInstance", args: [id] });
    return getImpl(id);
  },
  launchInstance: async (input: LaunchInput) => {
    calls.push({ fn: "launchInstance", args: [input] });
    return launchImpl(input);
  },
  terminateInstances: async (ids: string[]) => void calls.push({ fn: "terminateInstances", args: [ids] }),
  ensureFilesystem: async (region: string) => {
    calls.push({ fn: "ensureFilesystem", args: [region] });
    return ensureImpl(region);
  },
  ensureServeFirewall: async (region: string) => {
    calls.push({ fn: "ensureServeFirewall", args: [region] });
    return firewallImpl(region);
  },
  findCacheFilesystem: async (region: string) => {
    calls.push({ fn: "findCacheFilesystem", args: [region] });
    return findFsImpl(region);
  },
};

const canMock = typeof (mock as { module?: unknown }).module === "function";
let steps: typeof import("../steps");
let serve: typeof import("../serve");
/** The serve recipe, when lib/train/recipes has it. */
let serveRecipe: { id: string } | undefined;
/** The publish recipe, when lib/train/recipes has it. */
let publishRecipe: { id: string } | undefined;
const savedEnv = { ...process.env };

describe("training steps", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const at = (rel: string) => new URL(rel, import.meta.url).href;
    mock.module(at("../lambda.ts"), { namedExports: fakeLambda });
    mock.module(at("../store.ts"), { namedExports: fakeStore });
    mock.module(at("../../gateway/tokens.ts"), { namedExports: { hashToken: fakeHash } });
    mock.module("workflow", { namedExports: { FatalError: FakeFatalError, RetryableError: FakeRetryableError } });
    steps = await import("../steps");
    serve = await import("../serve");
    const { RECIPES } = (await import(at("../recipes/index.ts"))) as typeof import("../recipes/index");
    serveRecipe = RECIPES.find((r) => r.id === "glimmer-serve");
    publishRecipe = RECIPES.find((r) => r.id === "glimmer-publish");
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
  });

  beforeEach(() => {
    job = row();
    listing = [];
    calls = [];
    dbDown = {};
    listImpl = null;
    getImpl = async (id) => listing.find((i) => i.id === id) ?? null;
    ensureImpl = async (region) => cacheFs(region);
    findFsImpl = async (region) => cacheFs(region);
    firewallImpl = async (region) => serveRuleset(region);
    launchImpl = async (input) => {
      listing.push(instance({ id: "inst-1", name: input.name }));
      return "inst-1";
    };
    process.env.PLATFORM_URL = "https://muse.example.com";
    // A test value for the serving key's HMAC, not a real pepper.
    process.env.GATEWAY_TOKEN_PEPPER = "test-pepper-for-steps";
    delete process.env.VERCEL_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.TRAIN_SSH_KEY_NAME;
  });

  /** The retry wait a step asked for, when it threw a RetryableError. */
  const retryAfter = (err: unknown) => (err instanceof FakeRetryableError ? err.options?.retryAfter : undefined);

  describe("launchStep", () => {
    it("launches once, storing only the token's hash, before the launch, and keeping the token out of its result", async () => {
      const result = await steps.launchStep(JOB_ID);
      assert.deepEqual(result, { action: "watch", maxMinutes: 30, instanceId: "inst-1" });

      const [launch] = called("launchInstance");
      assert.equal(called("launchInstance").length, 1);
      const input = launch!.args[0] as LaunchInput;
      assert.equal(input.name, NAME);
      assert.equal(input.instanceType, "gpu_1x_a10");
      assert.equal(input.region, "us-east-1");
      assert.equal(input.sshKeyName, "muse-muse-platform");
      assert.deepEqual(input.tags, [
        { key: "muse-muse", value: "train" },
        { key: "muse-muse-job", value: JOB_ID },
      ]);

      const sent = jobJson(input.userData);
      assert.equal(sent.callbackBase, `https://muse.example.com/api/train/jobs/${JOB_ID}`);
      assert.match(sent.token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");

      const [claim] = called("claimLaunch");
      assert.equal(claim!.args[1], fakeHash(sent.token));
      assert.ok(order().indexOf("claimLaunch") < order().indexOf("launchInstance"), "the hash is stored before the launch");
      assert.equal(job!.tokenHash, fakeHash(sent.token));
      assert.notEqual(job!.tokenHash, sent.token);

      assert.ok(!JSON.stringify(result).includes(sent.token));
      for (const c of calls.filter((x) => x.fn !== "launchInstance")) {
        assert.ok(!JSON.stringify(c.args).includes(sent.token), `${c.fn} never sees the plaintext token`);
      }
      assert.equal(job!.instanceId, "inst-1");
      assert.equal(job!.status, "booting");
    });

    it("adopts an instance a timed-out launch started, on the retry, with its clock at createdAt", async () => {
      let token = "";
      launchImpl = async (input) => {
        token = jobJson(input.userData).token;
        listing.push(instance({ id: "inst-1", name: input.name }));
        throw new FakeLambdaApiError(0, "timeout", "Lambda API POST /instance-operations/launch timed out after 20 s");
      };
      await assert.rejects(steps.launchStep(JOB_ID), (err: Error) => {
        assert.ok(err instanceof FakeRetryableError, "a timeout is retried");
        assert.equal(retryAfter(err), "2m");
        assert.ok(!err.message.includes(token));
        return true;
      });
      assert.equal(job!.status, "launching");
      assert.equal(job!.instanceId, null);
      assert.equal(called("releaseLaunch").length, 0, "the claim is kept, since the instance may exist");

      const retry = await steps.launchStep(JOB_ID);
      assert.deepEqual(retry, { action: "watch", maxMinutes: 30, instanceId: "inst-1" });
      assert.equal(called("launchInstance").length, 1, "never launched twice");
      assert.equal(job!.instanceId, "inst-1");
      assert.equal(job!.tokenHash, fakeHash(token), "the token in the adopted instance still matches");
      // Lambda doesn't say when it launched, so the clock starts at createdAt: never late.
      assert.equal(job!.launchedAt?.getTime(), job!.createdAt.getTime());
    });

    it("terminates its instance at once when the open job already holds another one, and watches that one", async () => {
      launchImpl = async (input) => {
        // Another run saved a different instance while this launch was in flight.
        job = { ...current(), instanceId: "inst-other", launchedAt: new Date(), status: "booting" };
        listing.push(instance({ id: "inst-new", name: input.name }));
        return "inst-new";
      };
      const result = await steps.launchStep(JOB_ID);
      assert.deepEqual(result, { action: "watch", maxMinutes: 30, instanceId: "inst-other" });
      assert.deepEqual(called("terminateInstances").map((c) => c.args[0]), [["inst-new"]]);
      assert.equal(current().instanceId, "inst-other", "the saved instance is kept");
      assert.equal(called("saveLateLaunch").length, 0);
    });

    it("never launches again when an ambiguous launch's instance doesn't show up in the listing", async () => {
      launchImpl = async () => {
        throw new FakeLambdaApiError(502, null, "Lambda API POST /instance-operations/launch failed (502)");
      };
      await assert.rejects(steps.launchStep(JOB_ID), FakeRetryableError);
      for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(steps.launchStep(JOB_ID), (err: Error) => {
          assert.ok(err instanceof FakeRetryableError);
          assert.equal(retryAfter(err), "2m", "waits for the listing");
          assert.match(err.message, /isn't launched again/);
          return true;
        });
      }
      assert.equal(called("launchInstance").length, 1);
      assert.equal(called("claimLaunch").length, 1, "the retries never even try to claim");
    });

    it("gives the claim back after a 429, so the retry launches, once", async () => {
      let first = true;
      launchImpl = async (input) => {
        if (first) {
          first = false;
          throw new FakeLambdaApiError(429, "global/rate-limited", "Lambda API POST /instance-operations/launch failed (429)");
        }
        listing.push(instance({ id: "inst-2", name: input.name }));
        return "inst-2";
      };
      await assert.rejects(steps.launchStep(JOB_ID), (err: Error) => retryAfter(err) === "30s");
      assert.equal(job!.status, "queued");
      assert.equal(job!.tokenHash, null);

      assert.deepEqual(await steps.launchStep(JOB_ID), { action: "watch", maxMinutes: 30, instanceId: "inst-2" });
      assert.equal(called("launchInstance").length, 2);
      assert.equal(called("claimLaunch").length, 2);
      assert.equal(job!.tokenHash, fakeHash(jobJson((called("launchInstance")[1]!.args[0] as LaunchInput).userData).token));
    });

    it("launches once when two runs of the step overlap", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      launchImpl = async (input) => {
        await gate;
        listing.push(instance({ id: "inst-1", name: input.name }));
        return "inst-1";
      };
      const a = steps.launchStep(JOB_ID);
      const b = steps.launchStep(JOB_ID);
      const settledB = await Promise.allSettled([b]);
      release();
      const [ra] = await Promise.allSettled([a]);
      assert.equal(called("launchInstance").length, 1, "only the run holding the claim launches");
      assert.deepEqual(ra.status === "fulfilled" ? ra.value : ra.reason, { action: "watch", maxMinutes: 30, instanceId: "inst-1" });
      const rb = settledB[0]!;
      assert.equal(rb.status, "rejected");
      assert.equal(retryAfter((rb as PromiseRejectedResult).reason), "2m", "the other one waits to adopt it");
    });

    it("keeps the instance id when the database fails right after the launch, and never launches again", async () => {
      dbDown = { markLaunched: 1 };
      const result = await steps.launchStep(JOB_ID);
      assert.equal(result.action, "save");
      assert.equal(result.instanceId, "inst-1");
      assert.equal(called("launchInstance").length, 1);
      assert.equal(job!.instanceId, null, "not saved yet");

      // Even if the step ran again, it would not launch a second instance (the claim is held).
      listing = [];
      await assert.rejects(steps.launchStep(JOB_ID), FakeRetryableError);
      assert.equal(called("launchInstance").length, 1);

      assert.deepEqual(await steps.saveLaunchStep(JOB_ID, result as import("../steps").UnsavedLaunch), {
        action: "watch",
        maxMinutes: 30,
        instanceId: "inst-1",
      });
      assert.equal(job!.instanceId, "inst-1");
      assert.equal(job!.status, "booting");
      assert.equal(called("launchInstance").length, 1);
    });

    it("saveLaunchStep waits 30 s while the database is down", async () => {
      dbDown = { markLaunched: 1 };
      const launch = { action: "save", maxMinutes: 30, instanceId: "inst-1", launchedAt: new Date().toISOString() } as const;
      await assert.rejects(steps.saveLaunchStep(JOB_ID, launch), (err: Error) => retryAfter(err) === "30s");
      assert.equal(called("launchInstance").length, 0);
    });

    it("treats Lambda refusing the launch as fatal, gives the claim back, and blanks the token out of the error", async () => {
      launchImpl = async (input) => {
        const echoed = jobJson(input.userData).token;
        throw new FakeLambdaApiError(400, "global/invalid-parameters", `user_data was refused near "${echoed}"`);
      };
      let token = "";
      await assert.rejects(steps.launchStep(JOB_ID), (err: Error) => {
        token = jobJson((called("launchInstance")[0]!.args[0] as LaunchInput).userData).token;
        assert.ok(err instanceof FakeFatalError);
        assert.ok(!err.message.includes(token));
        assert.match(err.message, /\[job token\]/);
        return true;
      });
      assert.equal(called("launchInstance").length, 1);
      assert.equal(job!.tokenHash, null, "nothing launched, so no claim is left");

      // terminateStep then finishes the job as usual instead of waiting for an instance that can't exist.
      await steps.terminateStep(JOB_ID, { status: "failed", reason: "The launch failed." });
      assert.equal(called("finishJob").length, 1);
    });

    it("doesn't launch a job that was stopped or already launched", async () => {
      job = row({ stopRequested: true });
      assert.deepEqual(await steps.launchStep(JOB_ID), { action: "end", status: "stopped", reason: "Stopped by an admin." });
      job = row({ status: "booting", instanceId: "inst-1", launchedAt: new Date(), tokenHash: "h" });
      assert.deepEqual(await steps.launchStep(JOB_ID), { action: "watch", maxMinutes: 30, instanceId: "inst-1" });
      assert.equal(called("launchInstance").length, 0);
      assert.equal(called("findInstanceByName").length, 0);
    });

    it("refuses an instance under the job's name that it never launched", async () => {
      listing = [instance({ id: "inst-x" })];
      await assert.rejects(steps.launchStep(JOB_ID), FakeFatalError);
      assert.equal(called("launchInstance").length, 0);
      assert.equal(job!.instanceId, null);
    });

    it("refuses a platform URL the instance couldn't safely report back to", async () => {
      for (const url of ["http://muse.example.com", "http://localhost:3000"]) {
        process.env.PLATFORM_URL = url;
        calls = [];
        await assert.rejects(steps.launchStep(JOB_ID), FakeFatalError, url);
        assert.equal(called("findInstanceByName").length + called("launchInstance").length, 0, url);
      }
      assert.equal(job!.tokenHash, null);
    });

    it("launches a usesCache recipe with its region's cache filesystem mounted and cacheDir in job.json", async () => {
      job = row({ recipe: "glimmer-lora", instanceName: "mm-train-1234abcd-glimmer-lora", region: "us-west-1", params: { datasetId: "ds-1" } });
      const result = await steps.launchStep(JOB_ID);
      assert.equal(result.action, "watch");
      assert.deepEqual(called("ensureFilesystem").map((c) => c.args), [["us-west-1"]]);
      assert.ok(order().indexOf("ensureFilesystem") < order().indexOf("claimLaunch"), "the cache is ready before the claim");
      const input = called("launchInstance")[0]!.args[0] as LaunchInput;
      assert.deepEqual(input.fileSystemNames, ["muse-muse-cache-us-west-1"]);
      assert.equal(input.region, "us-west-1");
      assert.equal(jobJson(input.userData).cacheDir, "/lambda/nfs/muse-muse-cache-us-west-1");
    });

    it("stamps the runner's deadline before the launch, so it is never after launchedAt plus maxMinutes", async () => {
      const before = Date.now();
      let sentAt = 0;
      launchImpl = async (input) => {
        sentAt = Date.now();
        listing.push(instance({ id: "inst-1", name: input.name }));
        return "inst-1";
      };
      job = row({ maxMinutes: 150, maxUsd: 100 });
      await steps.launchStep(JOB_ID);
      const { deadlineEpoch } = jobJson((called("launchInstance")[0]!.args[0] as LaunchInput).userData);
      const launchedAt = job!.launchedAt!.getTime();
      assert.ok(launchedAt >= before && launchedAt <= sentAt, "launchedAt is the request's time");
      assert.ok(Number.isInteger(deadlineEpoch));
      assert.ok(deadlineEpoch * 1000 <= launchedAt + 150 * MIN, "the runner stops no later than the platform's limit");
      assert.ok(deadlineEpoch * 1000 > before + 150 * MIN - 1000, "and not much earlier");
    });

    it("stamps the runner's deadline at the dollar limit when that runs out before the time limit", async () => {
      const before = Date.now();
      // $1 at $0.75 an hour reaches the limit in its 80th minute, which decideCheck stops at once.
      job = row({ maxMinutes: 150, maxUsd: 1, priceCentsPerHour: 75 });
      await steps.launchStep(JOB_ID);
      const { deadlineEpoch } = jobJson((called("launchInstance")[0]!.args[0] as LaunchInput).userData);
      const launchedAt = job!.launchedAt!.getTime();
      assert.ok(deadlineEpoch * 1000 <= launchedAt + 79 * MIN, "no later than the dollar limit");
      assert.ok(deadlineEpoch * 1000 > before + 79 * MIN - 1000, "and not much earlier");
    });

    it("never touches filesystems for a recipe without usesCache", async () => {
      await steps.launchStep(JOB_ID);
      assert.equal(called("ensureFilesystem").length, 0);
      const input = called("launchInstance")[0]!.args[0] as LaunchInput;
      assert.equal(input.fileSystemNames, undefined);
      assert.equal(jobJson(input.userData).cacheDir, undefined);
    });

    it("fails the launch, with nothing claimed or launched, when the cache filesystem can't be made", async () => {
      job = row({ recipe: "glimmer-lora", instanceName: "mm-train-1234abcd-glimmer-lora", params: { datasetId: "ds-1" } });
      ensureImpl = async () => {
        throw new FakeLambdaApiError(400, "global/quota-exceeded", "Lambda API POST /filesystems failed (400 global/quota-exceeded): Quota exceeded.");
      };
      await assert.rejects(steps.launchStep(JOB_ID), (err: Error) => {
        assert.ok(err instanceof FakeFatalError, "fatal, so the create is never retried");
        assert.match(err.message, /model cache filesystem in us-east-1 could not be found or created, so nothing was launched/);
        assert.match(err.message, /Quota exceeded/);
        return true;
      });
      assert.equal(called("ensureFilesystem").length, 1);
      assert.equal(called("claimLaunch").length + called("launchInstance").length, 0);
      assert.equal(job!.tokenHash, null);
    });

    it("adopts an existing instance of a usesCache job without asking for the filesystem again", async () => {
      job = row({ recipe: "glimmer-lora", instanceName: "mm-train-1234abcd-glimmer-lora", status: "launching", tokenHash: "h" });
      listing = [instance({ id: "inst-9", name: "mm-train-1234abcd-glimmer-lora" })];
      const result = await steps.launchStep(JOB_ID);
      assert.deepEqual(result, { action: "watch", maxMinutes: 30, instanceId: "inst-9" });
      assert.equal(called("ensureFilesystem").length, 0);
    });

    const ADAPTER = "aaaaaaaa-0000-4000-8000-000000000000";
    const serveRow = (over: Partial<TrainJobRow> = {}) =>
      row({
        recipe: "glimmer-serve",
        instanceName: "mm-train-1234abcd-glimmer-serve",
        instanceType: "gpu_1x_h100_sxm5",
        region: "us-east-1",
        priceCentsPerHour: 429,
        maxMinutes: 45,
        maxUsd: 3.29,
        params: { adapterJobId: ADAPTER, minutes: 30 },
        ...over,
      });

    it("launches a glimmer-serve job with its cache mounted, the demo firewall attached and its serving key in job.json", async (t) => {
      if (!serveRecipe) return t.skip("no glimmer-serve recipe");
      job = serveRow();
      const result = await steps.launchStep(JOB_ID);
      assert.equal(result.action, "watch");
      assert.deepEqual(called("findCacheFilesystem").map((c) => c.args), [["us-east-1"]], "the cache already there");
      assert.equal(called("ensureFilesystem").length, 0, "never a new, empty one: it wouldn't hold the adapter");
      assert.deepEqual(called("ensureServeFirewall").map((c) => c.args), [["us-east-1"]]);
      assert.ok(order().indexOf("ensureServeFirewall") < order().indexOf("claimLaunch"), "the ruleset is ready before the claim");

      const input = called("launchInstance")[0]!.args[0] as LaunchInput;
      assert.deepEqual(input.firewallRulesetIds, ["fw-us-east-1"]);
      assert.deepEqual(input.fileSystemNames, ["muse-muse-cache-us-east-1"]);
      const sent = jobJson(input.userData);
      assert.equal(sent.cacheDir, "/lambda/nfs/muse-muse-cache-us-east-1");
      assert.deepEqual(sent.params, { adapterJobId: ADAPTER, minutes: 30 });
      // The key is the HMAC of the stored hash, so the proxy can derive it again and nothing stores it.
      assert.equal(sent.serveKey, serve.serveKeyFor(JOB_ID, fakeHash(sent.token)));
      assert.match(sent.serveKey!, /^[0-9a-f]{64}$/);
      assert.equal(job!.tokenHash, fakeHash(sent.token));
      assert.notEqual(sent.serveKey, sent.token);

      assert.ok(!JSON.stringify(result).includes(sent.serveKey!), "the key stays out of the step's result");
      for (const c of calls.filter((x) => x.fn !== "launchInstance")) {
        assert.ok(!JSON.stringify(c.args).includes(sent.serveKey!), `${c.fn} never sees the serving key`);
      }
    });

    it("never attaches a firewall ruleset or a serving key for any other recipe", async () => {
      for (const over of [{}, { recipe: "glimmer-lora" as const, instanceName: "mm-train-1234abcd-glimmer-lora", params: { datasetId: "ds-1" } }]) {
        job = row(over);
        listing = [];
        calls = [];
        await steps.launchStep(JOB_ID);
        assert.equal(called("ensureServeFirewall").length, 0);
        const input = called("launchInstance")[0]!.args[0] as LaunchInput;
        assert.equal(input.firewallRulesetIds, undefined);
        assert.equal(jobJson(input.userData).serveKey, undefined);
      }
    });

    it("fails a glimmer-serve launch, with nothing claimed or launched, when the firewall ruleset can't be made", async (t) => {
      if (!serveRecipe) return t.skip("no glimmer-serve recipe");
      job = serveRow();
      firewallImpl = async () => {
        throw new FakeLambdaApiError(400, "global/quota-exceeded", "Lambda API POST /firewall-rulesets failed (400 global/quota-exceeded): Quota exceeded.");
      };
      await assert.rejects(steps.launchStep(JOB_ID), (err: Error) => {
        assert.ok(err instanceof FakeFatalError, "fatal, so the create is never retried");
        assert.match(err.message, /live demo's firewall ruleset in us-east-1 could not be found or created, so nothing was launched/);
        assert.match(err.message, /Quota exceeded/);
        return true;
      });
      assert.equal(called("ensureServeFirewall").length, 1);
      assert.equal(called("claimLaunch").length + called("launchInstance").length, 0);
      assert.equal(job!.tokenHash, null);
    });

    it("fails a glimmer-serve launch, with nothing claimed or launched, when the region has no model cache", async (t) => {
      if (!serveRecipe) return t.skip("no glimmer-serve recipe");
      job = serveRow();
      findFsImpl = async () => null;
      await assert.rejects(steps.launchStep(JOB_ID), (err: Error) => {
        assert.ok(err instanceof FakeFatalError);
        assert.match(err.message, /no model cache filesystem in us-east-1, so the adapter this job serves isn't there/);
        return true;
      });
      findFsImpl = async () => {
        throw new FakeLambdaApiError(503, null, "Lambda API GET /filesystems failed (503): upstream down");
      };
      await assert.rejects(steps.launchStep(JOB_ID), (err: Error) => {
        assert.ok(err instanceof FakeFatalError);
        assert.match(err.message, /model cache filesystem in us-east-1 could not be listed, so nothing was launched: .*upstream down/);
        return true;
      });
      assert.equal(called("ensureFilesystem").length + called("ensureServeFirewall").length, 0);
      assert.equal(called("claimLaunch").length + called("launchInstance").length, 0);
      assert.equal(job!.tokenHash, null);
    });

    it("blanks the serving key and the token out of a refused launch's error", async (t) => {
      if (!serveRecipe) return t.skip("no glimmer-serve recipe");
      job = serveRow();
      let sent: { token: string; serveKey?: string } | null = null;
      launchImpl = async (input) => {
        sent = jobJson(input.userData);
        throw new FakeLambdaApiError(400, "global/invalid-parameters", `Bad user data near ${sent.serveKey} and ${sent.token}`);
      };
      await assert.rejects(steps.launchStep(JOB_ID), (err: Error) => {
        assert.ok(err instanceof FakeFatalError);
        assert.ok(!err.message.includes(sent!.serveKey!), err.message);
        assert.ok(!err.message.includes(sent!.token), err.message);
        assert.match(err.message, /\[serving key\] and \[job token\]/);
        return true;
      });
      assert.equal(called("releaseLaunch").length, 1, "nothing launched, so the claim goes back");
    });

    it("launches a glimmer-publish job with the cache already in its adapter's region, and no firewall or serving key", async (t) => {
      if (!publishRecipe) return t.skip("no glimmer-publish recipe");
      const publishRow = () =>
        row({
          recipe: "glimmer-publish",
          instanceName: "mm-train-1234abcd-glimmer-publish",
          instanceType: "gpu_1x_a10",
          region: "us-east-1",
          priceCentsPerHour: 129,
          maxMinutes: 20,
          maxUsd: 1,
          params: { adapterJobId: ADAPTER },
        });
      job = publishRow();
      const result = await steps.launchStep(JOB_ID);
      assert.equal(result.action, "watch");
      assert.deepEqual(called("findCacheFilesystem").map((c) => c.args), [["us-east-1"]], "the cache that holds the adapter");
      assert.equal(called("ensureFilesystem").length, 0, "never a new, empty one");
      assert.equal(called("ensureServeFirewall").length, 0, "it opens no port");
      const input = called("launchInstance")[0]!.args[0] as LaunchInput;
      assert.deepEqual(input.fileSystemNames, ["muse-muse-cache-us-east-1"]);
      assert.equal(input.firewallRulesetIds, undefined);
      const sent = jobJson(input.userData);
      assert.equal(sent.cacheDir, "/lambda/nfs/muse-muse-cache-us-east-1");
      assert.equal(sent.serveKey, undefined);
      assert.deepEqual(sent.params, { adapterJobId: ADAPTER });

      // A region with no cache has no adapter to read, so nothing is claimed or launched.
      job = publishRow();
      calls = [];
      listing = [];
      findFsImpl = async () => null;
      await assert.rejects(steps.launchStep(JOB_ID), (err: Error) => {
        assert.ok(err instanceof FakeFatalError);
        assert.match(err.message, /no model cache filesystem in us-east-1, so the adapter this job reads isn't there and nothing was launched/);
        return true;
      });
      assert.equal(called("ensureFilesystem").length + called("claimLaunch").length + called("launchInstance").length, 0);
    });

    it("adopts an existing glimmer-serve instance without asking for the firewall or the cache again", async (t) => {
      if (!serveRecipe) return t.skip("no glimmer-serve recipe");
      job = serveRow({ status: "launching", tokenHash: "h" });
      listing = [instance({ id: "inst-9", name: "mm-train-1234abcd-glimmer-serve" })];
      const result = await steps.launchStep(JOB_ID);
      assert.deepEqual(result, { action: "watch", maxMinutes: 45, instanceId: "inst-9" });
      assert.equal(called("ensureServeFirewall").length + called("ensureFilesystem").length + called("findCacheFilesystem").length, 0);
    });

    it("saves a launch that lands after the job ended, and hands its id to terminateStep", async () => {
      launchImpl = async (input) => {
        listing.push(instance({ id: "inst-1", name: input.name }));
        job = { ...job!, status: "stopped", stopRequested: true, terminatedAt: new Date() };
        return "inst-1";
      };
      const result = await steps.launchStep(JOB_ID);
      assert.deepEqual(result, { action: "end", status: "stopped", reason: "Stopped by an admin.", instanceId: "inst-1" });
      assert.equal(job!.instanceId, "inst-1", "saved on the ended job");
      assert.equal(job!.terminatedAt, null, "so it counts as holding a GPU until it is terminated");

      // Lambda's listing doesn't show it yet: it is terminated by id anyway.
      listing = [];
      calls = [];
      await steps.terminateStep(JOB_ID, { status: "stopped", reason: "Stopped by an admin." }, result.instanceId);
      assert.deepEqual(called("terminateInstances")[0]!.args[0], ["inst-1"]);
      assert.ok(current().terminatedAt instanceof Date);
    });
  });

  describe("terminateStep", () => {
    it("terminates the saved instance and every other live one under the job's name, then finishes the job", async () => {
      job = row({ status: "running", instanceId: "inst-1", launchedAt: new Date(Date.now() - 5 * MIN), tokenHash: "h" });
      listing = [
        instance({ id: "inst-1", status: "active" }),
        instance({ id: "inst-2", status: "booting" }),
        instance({ id: "inst-3", status: "terminated" }),
        instance({ id: "inst-4", name: "mm-train-ffffffff-smoke", status: "active" }),
      ];
      const status = await steps.terminateStep(JOB_ID, { status: "failed", reason: "Reached the 30-minute limit." });
      assert.equal(status, "failed");
      assert.deepEqual(called("terminateInstances").map((c) => c.args[0]), [["inst-1"], ["inst-2"]]);
      const [finish] = called("finishJob");
      const input = finish!.args[1] as { status: string; terminatedAt: Date; launchedAt?: Date };
      assert.equal(input.status, "failed");
      assert.ok(input.terminatedAt instanceof Date);
      assert.equal(input.launchedAt, undefined, "a saved launch keeps its own time");
    });

    it("terminates the workflow's instance before it reads the database, and waits out an outage 30 s at a time", async () => {
      job = row({ status: "running", instanceId: "inst-1", launchedAt: new Date(Date.now() - 5 * MIN), tokenHash: "h" });
      listing = [instance({ id: "inst-1", status: "active" })];
      dbDown = { getJob: 2 };
      for (let attempt = 0; attempt < 2; attempt++) {
        calls = [];
        await assert.rejects(steps.terminateStep(JOB_ID, { status: "failed", reason: "x" }, "inst-1"), (err: Error) => {
          assert.equal(retryAfter(err), "30s", "not a plain error, which would retry after 1 s");
          return true;
        });
        assert.deepEqual(called("terminateInstances").map((c) => c.args[0]), [["inst-1"]]);
        assert.ok(order().indexOf("terminateInstances") < order().indexOf("getJob"));
      }
      calls = [];
      assert.equal(await steps.terminateStep(JOB_ID, { status: "failed", reason: "x" }, "inst-1"), "failed");
      assert.deepEqual(called("terminateInstances").flatMap((c) => c.args[0] as string[]), ["inst-1"], "not terminated a second time in one run");
      assert.equal(called("finishJob").length, 1);
    });

    it("retries a failed finishJob after 30 s", async () => {
      job = row({ status: "running", instanceId: "inst-1", launchedAt: new Date(), tokenHash: "h" });
      dbDown = { finishJob: 1 };
      await assert.rejects(steps.terminateStep(JOB_ID, { status: "failed", reason: "x" }, "inst-1"), (err: Error) => retryAfter(err) === "30s");
      assert.equal(await steps.terminateStep(JOB_ID, { status: "failed", reason: "x" }, "inst-1"), "failed");
    });

    it("counts the cost of an instance only the workflow knew about from createdAt", async () => {
      job = row({ status: "launching", tokenHash: "h" });
      listing = [instance({ id: "inst-7" })];
      await steps.terminateStep(JOB_ID, { status: "failed", reason: "The launch failed: The database did not answer" }, "inst-7");
      assert.deepEqual(called("terminateInstances").map((c) => c.args[0]), [["inst-7"], []], "the listing doesn't add it twice");
      const input = called("finishJob")[0]!.args[1] as { launchedAt?: Date };
      assert.equal(input.launchedAt?.getTime(), job!.createdAt.getTime());
    });

    it("counts an unsaved launch's cost from createdAt once it finds and terminates that instance", async () => {
      job = row({ status: "launching", tokenHash: "h" });
      listing = [instance({ id: "inst-9" })];
      await steps.terminateStep(JOB_ID, { status: "failed", reason: "The launch failed." });
      assert.deepEqual(called("terminateInstances").map((c) => c.args[0]), [["inst-9"]]);
      const input = called("finishJob")[0]!.args[1] as { launchedAt?: Date };
      assert.equal(input.launchedAt?.getTime(), job!.createdAt.getTime());
    });

    it("keeps the GPU slot of a launch Lambda doesn't list yet, for the sweep to look at", async () => {
      job = row({ status: "launching", tokenHash: "h" });
      const status = await steps.terminateStep(JOB_ID, { status: "failed", reason: "The launch failed: timed out" });
      assert.equal(status, "failed");
      assert.equal(called("finishJob").length, 0, "no terminatedAt while an instance may exist");
      assert.equal(job!.status, "failed");
      assert.equal(job!.terminatedAt, null);
      assert.equal(job!.launchedAt?.getTime(), job!.createdAt.getTime(), "its cost counts from createdAt meanwhile");
      const [set] = called("setStatus");
      assert.match((set!.args[2] as { message: string }).message, /sweep/);
    });

    it("leaves a stuck launch the sweep already ended that way to the sweep", async () => {
      // The sweep failed it while the launch was in flight: ended, clock at createdAt, no terminatedAt.
      const createdAt = new Date(Date.now() - 20 * MIN);
      job = row({ status: "failed", tokenHash: "h", createdAt, launchedAt: createdAt, finishedAt: new Date(), error: "Still launching" });
      const status = await steps.terminateStep(JOB_ID, { status: "failed", reason: "The job ended while it was launching." });
      assert.equal(status, "failed");
      assert.equal(called("listInstances").length, 1, "it looked");
      assert.equal(called("finishJob").length, 0, "no terminatedAt while the instance may still show up");
      assert.equal(job!.terminatedAt, null);

      // Once the listing shows the instance, it is terminated and the ending recorded.
      calls = [];
      listing = [instance({ id: "inst-late", status: "active" })];
      await steps.terminateStep(JOB_ID, { status: "failed", reason: "x" });
      assert.deepEqual(called("terminateInstances").map((c) => c.args[0]), [["inst-late"]]);
      assert.equal(called("finishJob").length, 1);
    });

    it("retries when the listing fails and nothing was saved, and finishes anyway once the saved one is terminated", async () => {
      listImpl = async () => {
        throw new FakeLambdaApiError(503, null, "Lambda API GET /instances failed (503)");
      };
      job = row({ status: "launching", tokenHash: "h" });
      await assert.rejects(steps.terminateStep(JOB_ID, { status: "failed", reason: "x" }), FakeRetryableError);
      assert.equal(called("finishJob").length, 0, "not marked terminated while an unsaved instance may exist");

      calls = [];
      job = row({ status: "running", instanceId: "inst-1", launchedAt: new Date(), tokenHash: "h" });
      assert.equal(await steps.terminateStep(JOB_ID, { status: "failed", reason: "x" }), "failed");
      assert.deepEqual(called("terminateInstances").map((c) => c.args[0]), [["inst-1"]]);
      assert.equal(called("finishJob").length, 1);

      // The workflow's own id is enough too, even before the database has it.
      calls = [];
      job = row({ status: "launching", tokenHash: "h" });
      assert.equal(await steps.terminateStep(JOB_ID, { status: "failed", reason: "x" }, "inst-5"), "failed");
      assert.deepEqual(called("terminateInstances").map((c) => c.args[0]), [["inst-5"]]);
      assert.equal(called("finishJob").length, 1);
    });

    it("keeps the runner's own ending, and a stop request wins over both", async () => {
      job = row({ status: "succeeded", instanceId: "inst-1", launchedAt: new Date(), tokenHash: "h" });
      assert.equal(await steps.terminateStep(JOB_ID, { status: "failed", reason: "late check" }), "succeeded");
      job = row({ status: "succeeded", stopRequested: true, instanceId: "inst-1", launchedAt: new Date(), tokenHash: "h" });
      assert.equal(await steps.terminateStep(JOB_ID, { status: "succeeded", reason: "The job finished." }), "stopped");
    });
  });

  describe("abandonStep", () => {
    it("ends the job without terminatedAt, saving an instance only the workflow knew about", async () => {
      job = row({ status: "launching", tokenHash: "h" });
      assert.equal(await steps.abandonStep(JOB_ID, { status: "failed", reason: "x" }, "inst-3"), "failed");
      assert.equal(job!.instanceId, "inst-3", "so the sweep can terminate it by id");
      assert.equal(job!.launchedAt?.getTime(), job!.createdAt.getTime());
      assert.equal(job!.terminatedAt, null);
      assert.equal(job!.status, "failed");
    });

    it("waits 30 s at a time while the database is down", async () => {
      job = row({ status: "running", instanceId: "inst-1", launchedAt: new Date(), tokenHash: "h" });
      dbDown = { setStatus: 1 };
      await assert.rejects(steps.abandonStep(JOB_ID, { status: "failed", reason: "x" }), (err: Error) => retryAfter(err) === "30s");
      assert.equal(await steps.abandonStep(JOB_ID, { status: "failed", reason: "x" }), "failed");
    });
  });

  describe("checkStep", () => {
    it("keeps enforcing the time limit from the database when Lambda doesn't answer", async () => {
      getImpl = async () => {
        throw new FakeLambdaApiError(0, "timeout", "timed out");
      };
      job = row({ status: "running", instanceId: "inst-1", launchedAt: new Date(Date.now() - 5 * MIN), firstHeartbeatAt: new Date(), lastHeartbeatAt: new Date(), tokenHash: "h" });
      assert.deepEqual(await steps.checkStep(JOB_ID), { action: "wait" });
      job = { ...job!, launchedAt: new Date(Date.now() - 31 * MIN) };
      assert.deepEqual(await steps.checkStep(JOB_ID), { action: "terminate", status: "failed", reason: "Reached the 30-minute limit." });
    });

    it("rides out a database blip 30 s at a time instead of failing the check within seconds", async () => {
      job = row({ status: "running", instanceId: "inst-1", launchedAt: new Date(), firstHeartbeatAt: new Date(), lastHeartbeatAt: new Date(), tokenHash: "h" });
      listing = [instance({ id: "inst-1", status: "active" })];
      dbDown = { getJob: 1 };
      await assert.rejects(steps.checkStep(JOB_ID), (err: Error) => {
        assert.equal(retryAfter(err), "30s");
        return true;
      });
      assert.deepEqual(await steps.checkStep(JOB_ID), { action: "wait" });
    });

    it("still decides when saving a new IP fails", async () => {
      job = row({ status: "booting", instanceId: "inst-1", launchedAt: new Date(), tokenHash: "h" });
      listing = [instance({ id: "inst-1", status: "active", ip: "203.0.113.7" })];
      dbDown = { setInstanceIp: 1 };
      assert.deepEqual(await steps.checkStep(JOB_ID), { action: "wait" });
      job = { ...job!, launchedAt: new Date(Date.now() - 31 * MIN) };
      dbDown = { setInstanceIp: 1 };
      assert.deepEqual(await steps.checkStep(JOB_ID), { action: "terminate", status: "failed", reason: "Reached the 30-minute limit." });
    });

    it("stores a new IP, and fails a job whose instance Lambda no longer has", async () => {
      job = row({ status: "booting", instanceId: "inst-1", launchedAt: new Date(), tokenHash: "h" });
      listing = [instance({ id: "inst-1", status: "active", ip: "203.0.113.7" })];
      assert.deepEqual(await steps.checkStep(JOB_ID), { action: "wait" });
      assert.equal(job!.instanceIp, "203.0.113.7");
      listing = [];
      assert.deepEqual(await steps.checkStep(JOB_ID), { action: "terminate", status: "failed", reason: "The instance is gone from Lambda." });
    });

    it("ends a stopped job without asking Lambda", async () => {
      job = row({ status: "running", stopRequested: true, instanceId: "inst-1", launchedAt: new Date(), tokenHash: "h" });
      assert.deepEqual(await steps.checkStep(JOB_ID), { action: "terminate", status: "stopped", reason: "Stopped by an admin." });
      assert.equal(called("getInstance").length, 0);
    });
  });
});
