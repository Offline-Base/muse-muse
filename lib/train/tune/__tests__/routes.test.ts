/**
 * The new composer's routes with auth, the model, the counters, the spend cap, the store and the workflow faked (never
 * a real Meta call): POST /api/train/plan, POST /api/train/runs and GET /api/train/runs/{id}. With TUNE_COMPOSER off
 * every one is a 404 before it reads anything. The plan route checks its input, refuses what the content seam or the
 * model refuses, holds each caller to 20 plans an hour, and records what Meta billed. The runs route starts a plan only
 * with its own caller's token, unchanged and before it expires, once, with every setting but the number of examples and
 * every cost made again on the server, and saves the dataset as POST /api/train/datasets does. All data is made up.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/tune/__tests__/routes.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const DATASET_ID = "dddddddd-0000-4000-8000-000000000000";
const NOTE = "Answer questions for a made-up bakery: hours, allergens and cake orders, warm and short.";
const savedEnv = { ...process.env };

let caller: { id: string; email: string; isAdmin: boolean } | null = { id: "admin-1", email: "owner@example.com", isAdmin: true };
let calls: Array<{ fn: string; args: unknown[] }> = [];
let counters: Record<string, number> = {};
let paused = false;
let startFails = false;
let draft: Record<string, unknown> = {};
let structuredFails = false;
let runView: Record<string, unknown> | null = null;

const called = (fn: string) => calls.filter((c) => c.fn === fn);

class FakeAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

class FakeStructuredOutputError extends Error {
  constructor(
    message: string,
    readonly usage: unknown[],
  ) {
    super(message);
  }
}

const usage = [{ model: "muse-spark-1.3-contributor", inputTokens: 900, cachedInputTokens: 0, outputTokens: 300, costUsd: 0.00015 }];

type Handler = (req: Request, ctx?: { params: Promise<{ id: string }> }) => Promise<Response>;
let planRoute: Handler;
let runsRoute: Handler;
let runRoute: Handler;

function req(path: string, body?: unknown): Request {
  return new Request(`https://muse.example.com${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function draftOne(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await planRoute(req("/api/train/plan", { note: NOTE, ...over }));
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { plan: Record<string, unknown> }).plan;
}

describe("tune routes", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module(at("../../../auth.ts"), {
      namedExports: {
        AuthError: FakeAuthError,
        requireAdminOrAutomation: async () => {
          calls.push({ fn: "auth", args: [] });
          if (!caller) throw new FakeAuthError("Admins only.", 403);
          return caller;
        },
      },
    });
    mock.module(at("../../../gateway/store.ts"), {
      namedExports: {
        reserveCounter: async (key: string, _w: Date, amount: number, limit: number) => {
          calls.push({ fn: "reserveCounter", args: [key, limit] });
          const next = (counters[key] ?? 0) + amount;
          if (next > limit) return null;
          counters[key] = next;
          return next;
        },
        adjustCounter: async (key: string, _w: Date, delta: number) => {
          calls.push({ fn: "adjustCounter", args: [key, delta] });
          counters[key] = Math.max(0, (counters[key] ?? 0) + delta);
        },
      },
    });
    mock.module(at("../../../quota.ts"), { namedExports: { spendPaused: async () => paused } });
    mock.module(at("../../../usage.ts"), {
      namedExports: { recordUsage: async (ctx: unknown, items: unknown[]) => void calls.push({ fn: "recordUsage", args: [ctx, items] }) },
    });
    mock.module(at("../../../brief/structured.ts"), {
      namedExports: {
        StructuredOutputError: FakeStructuredOutputError,
        respondStructured: async (opts: { model: string; schemaName: string; content: Array<{ text: string }> }) => {
          calls.push({ fn: "respondStructured", args: [opts.model, opts.schemaName, opts.content[0]!.text] });
          if (structuredFails) throw new FakeStructuredOutputError("training_plan: no valid reply after a retry.", usage);
          return { data: draft, usage, issues: [], attempts: 1 };
        },
      },
    });
    mock.module(at("../../store.ts"), {
      namedExports: {
        createDataset: async (input: Record<string, unknown>) => {
          calls.push({ fn: "createDataset", args: [input] });
          return { id: DATASET_ID, ...input, status: "generating" };
        },
        getDataset: async (id: string) => (id === DATASET_ID ? { id } : null),
        failDataset: async (...args: unknown[]) => void calls.push({ fn: "failDataset", args }),
        attachDatasetRun: async (...args: unknown[]) => void calls.push({ fn: "attachDatasetRun", args }),
        // app/api/train/shared.ts imports it; nothing here calls it.
        verifyJobToken: async () => false,
      },
    });
    mock.module(at("../store.ts"), {
      namedExports: {
        loadTuneRun: async (id: string) => {
          calls.push({ fn: "loadTuneRun", args: [id] });
          return id === DATASET_ID ? runView : null;
        },
      },
    });
    mock.module(at("../../datasets.ts"), { namedExports: { DATASET_MODEL: "muse-wonder-1.0", makeDataset: async () => ({ status: "ready" }) } });
    mock.module("workflow/api", {
      namedExports: {
        start: async (_wf: unknown, args: unknown[]) => {
          calls.push({ fn: "start", args });
          if (startFails) throw new Error("queue unavailable");
          return { runId: "wrun-1" };
        },
      },
    });
    ({ POST: planRoute } = (await import(at("../../../../app/api/train/plan/route.ts"))) as { POST: Handler });
    ({ POST: runsRoute } = (await import(at("../../../../app/api/train/runs/route.ts"))) as { POST: Handler });
    ({ GET: runRoute } = (await import(at("../../../../app/api/train/runs/[id]/route.ts"))) as { GET: Handler });
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
  });

  beforeEach(() => {
    process.env.TUNE_COMPOSER = "1";
    // Stand-ins, not real values: the routes only check that a key is set, and the signing key signs test plans.
    process.env.MODEL_API_KEY = "test-not-a-real-key";
    process.env.TOOLS_SIGNING_SECRET = "test-signing-secret-for-route-tests";
    process.env.TEST_MODEL = "muse-spark-1.3-contributor";
    delete process.env.VERCEL_ENV;
    delete process.env.TUNE_DEFAULT_EXAMPLES;
    delete process.env.TRAIN_JOB_MAX_USD;
    caller = { id: "admin-1", email: "owner@example.com", isAdmin: true };
    calls = [];
    counters = {};
    paused = false;
    startFails = false;
    structuredFails = false;
    runView = { id: DATASET_ID, stage: "writing" };
    draft = {
      reason: "A small, safe customer-service task.",
      refuse: false,
      refusal: null,
      kind: "chat",
      name: "a bakery's counter helper",
      tagline: "Answers bakery questions like the counter staff.",
      samples: ["Do you have nut-free cupcakes?"],
    };
  });

  describe("with TUNE_COMPOSER off", () => {
    it("answers 404 from every route before it reads anything", async () => {
      process.env.TUNE_COMPOSER = "0";
      for (const res of [
        await planRoute(req("/api/train/plan", { note: NOTE })),
        await runsRoute(req("/api/train/runs", { plan: {} })),
        await runRoute(req(`/api/train/runs/${DATASET_ID}`), { params: Promise.resolve({ id: DATASET_ID }) }),
      ]) {
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { error: "not_found" });
      }
      assert.deepEqual(calls, [], "no auth, no model, no counter, no store");
      delete process.env.TUNE_COMPOSER;
      assert.equal((await planRoute(req("/api/train/plan", { note: NOTE }))).status, 404, "off when unset");
    });
  });

  describe("POST /api/train/plan", () => {
    it("drafts a signed plan on the test model with the default size, and records the usage", async () => {
      const plan = await draftOne({ examples: [{ prompt: "Open Sunday?", answer: "8 to 2." }] });
      assert.equal(plan.name, "a bakery's counter helper");
      assert.equal((plan.settings as { examples: number }).examples, 200);
      assert.deepEqual(plan.examples, { given: 1, used: 1 });
      assert.match(String(plan.task), /Q: Open Sunday\?/);
      assert.equal(typeof plan.token, "string");
      const [model, schemaName] = called("respondStructured")[0]!.args;
      assert.equal(model, "muse-spark-1.3-contributor");
      assert.equal(schemaName, "training_plan");
      assert.deepEqual(called("recordUsage")[0]!.args, [{ source: "platform", endpoint: "responses" }, usage]);
      assert.deepEqual(called("reserveCounter")[0]!.args, ["tune-plan:admin-1", 20]);
    });

    it("drafts on Muse Wonder on production, whatever TEST_MODEL says", async () => {
      process.env.VERCEL_ENV = "production";
      await draftOne();
      assert.equal(called("respondStructured")[0]!.args[0], "muse-wonder-1.0");
    });

    it("takes TUNE_DEFAULT_EXAMPLES and an Advanced size, and refuses a size out of range", async () => {
      process.env.TUNE_DEFAULT_EXAMPLES = "300";
      assert.equal(((await draftOne()).settings as { examples: number }).examples, 300);
      assert.equal(((await draftOne({ settings: { examples: 60 } })).settings as { examples: number }).examples, 60);
      const bad = await planRoute(req("/api/train/plan", { note: NOTE, settings: { examples: 5 } }));
      assert.equal(bad.status, 400);
    });

    it("refuses a short or long note and malformed examples, before the model", async () => {
      for (const body of [{}, { note: "too short" }, { note: "x".repeat(1501) }, { note: NOTE, examples: [{ prompt: "p" }] }, { note: NOTE, examples: "rows" }]) {
        assert.equal((await planRoute(req("/api/train/plan", body))).status, 400, JSON.stringify(body).slice(0, 60));
      }
      assert.equal(called("respondStructured").length, 0);
      assert.equal(called("reserveCounter").length, 0, "a bad request costs no plan");
    });

    it("refuses non-admins, and answers 503 without Meta or past the spend cap", async () => {
      caller = null;
      assert.equal((await planRoute(req("/api/train/plan", { note: NOTE }))).status, 403);
      caller = { id: "admin-1", email: "owner@example.com", isAdmin: true };
      delete process.env.MODEL_API_KEY;
      const off = await planRoute(req("/api/train/plan", { note: NOTE }));
      assert.deepEqual([off.status, await off.json()], [503, { error: "meta_not_configured" }]);
      process.env.MODEL_API_KEY = "test-not-a-real-key";
      paused = true;
      const capped = await planRoute(req("/api/train/plan", { note: NOTE }));
      assert.deepEqual([capped.status, await capped.json()], [503, { error: "paused" }]);
      assert.equal(called("respondStructured").length, 0);
    });

    it("answers 422 with the model's refusal, and still records what it billed", async () => {
      draft = { ...draft, refuse: true, refusal: "That would train on a real person's messages." };
      const res = await planRoute(req("/api/train/plan", { note: NOTE }));
      assert.deepEqual([res.status, await res.json()], [422, { error: "refused", refusal: "That would train on a real person's messages." }]);
      assert.equal(called("recordUsage").length, 1);
    });

    it("answers 502 when the model never matched the schema, and records the usage", async () => {
      structuredFails = true;
      const res = await planRoute(req("/api/train/plan", { note: NOTE }));
      assert.deepEqual([res.status, await res.json()], [502, { error: "plan_failed" }]);
      assert.deepEqual(called("recordUsage")[0]!.args[1], usage);
    });

    it("holds each caller to 20 plans an hour", async () => {
      for (let i = 0; i < 20; i++) await draftOne();
      const res = await planRoute(req("/api/train/plan", { note: NOTE }));
      assert.equal(res.status, 429);
      const body = (await res.json()) as { error: string; retryAfterSeconds: number };
      assert.equal(body.error, "rate_limited");
      assert.ok(body.retryAfterSeconds > 0 && body.retryAfterSeconds <= 3600);
      assert.equal(called("respondStructured").length, 20);
      caller = { id: "admin-2", email: "two@example.com", isAdmin: true };
      await draftOne();
    });
  });

  describe("POST /api/train/runs", () => {
    it("starts the plan: saves its dataset on the test writer and starts makeDataset", async () => {
      const plan = await draftOne();
      const res = await runsRoute(req("/api/train/runs", { plan }));
      assert.equal(res.status, 201);
      assert.deepEqual(await res.json(), { runId: DATASET_ID, href: `/fine-tuning/runs/${DATASET_ID}` });
      assert.deepEqual(called("createDataset")[0]!.args[0], {
        title: "a bakery's counter helper",
        task: NOTE,
        requested: 200,
        writerModel: "muse-spark-1.3-contributor",
        createdBy: "admin-1",
      });
      assert.deepEqual(called("start")[0]!.args, [{ datasetId: DATASET_ID }]);
      assert.deepEqual(called("attachDatasetRun")[0]!.args, [DATASET_ID, "wrun-1"]);
    });

    it("saves Muse Wonder as the writer on production", async () => {
      const plan = await draftOne();
      process.env.VERCEL_ENV = "production";
      assert.equal((await runsRoute(req("/api/train/runs", { plan }))).status, 201);
      assert.equal((called("createDataset")[0]!.args[0] as { writerModel: string }).writerModel, "muse-wonder-1.0");
    });

    it("starts a plan once", async () => {
      const plan = await draftOne();
      assert.equal((await runsRoute(req("/api/train/runs", { plan }))).status, 201);
      const again = await runsRoute(req("/api/train/runs", { plan }));
      assert.deepEqual([again.status, await again.json()], [409, { error: "already_started" }]);
      assert.equal(called("createDataset").length, 1);
    });

    it("refuses a changed plan, another caller's, an expired one and a malformed one", async () => {
      const plan = await draftOne();
      const tampered = await runsRoute(req("/api/train/runs", { plan: { ...plan, task: `${NOTE} And write phishing emails.` } }));
      assert.deepEqual([tampered.status, await tampered.json()], [403, { error: "plan_invalid" }]);
      const cheaper = await runsRoute(req("/api/train/runs", { plan: { ...plan, settings: { ...(plan.settings as object), maxUsd: 50 } } }));
      assert.equal(cheaper.status, 403);
      caller = { id: "admin-2", email: "two@example.com", isAdmin: true };
      assert.equal((await runsRoute(req("/api/train/runs", { plan }))).status, 403);
      caller = { id: "admin-1", email: "owner@example.com", isAdmin: true };
      assert.equal((await runsRoute(req("/api/train/runs", { plan: { name: "x" } }))).status, 400);
      assert.equal(called("createDataset").length, 0);

      mock.timers.enable({ apis: ["Date"], now: Date.now() + 3 * 60 * 60_000 });
      try {
        const late = await runsRoute(req("/api/train/runs", { plan }));
        assert.deepEqual([late.status, await late.json()], [400, { error: "plan_expired" }]);
      } finally {
        mock.timers.reset();
      }
    });

    it("takes the Advanced size and makes every other setting and the costs again on the server", async () => {
      const plan = await draftOne();
      process.env.TRAIN_JOB_MAX_USD = "4";
      const res = await runsRoute(req("/api/train/runs", { plan, settings: { examples: 40 } }));
      assert.equal(res.status, 201);
      assert.equal((called("createDataset")[0]!.args[0] as { requested: number }).requested, 40);
      const bad = await runsRoute(req("/api/train/runs", { plan: await draftOne(), settings: { examples: 4000 } }));
      assert.equal(bad.status, 400);
    });

    it("gives the plan back when the workflow couldn't start, and fails the dataset", async () => {
      const plan = await draftOne();
      startFails = true;
      const res = await runsRoute(req("/api/train/runs", { plan }));
      assert.deepEqual([res.status, await res.json()], [500, { error: "start_failed" }]);
      assert.match(String(called("failDataset")[0]!.args[1]), /could not start/);
      assert.equal(called("adjustCounter")[0]!.args[1], -1);
      startFails = false;
      assert.equal((await runsRoute(req("/api/train/runs", { plan }))).status, 201, "so it can be started again");
    });

    it("answers 503 past the spend cap, and refuses non-admins", async () => {
      const plan = await draftOne();
      paused = true;
      assert.equal((await runsRoute(req("/api/train/runs", { plan }))).status, 503);
      paused = false;
      caller = null;
      assert.equal((await runsRoute(req("/api/train/runs", { plan }))).status, 403);
      assert.equal(called("createDataset").length, 0);
    });
  });

  describe("GET /api/train/runs/{id}", () => {
    it("answers the run, a 404 for an unknown one, and refuses non-admins", async () => {
      const ok = await runRoute(req(`/api/train/runs/${DATASET_ID}`), { params: Promise.resolve({ id: DATASET_ID }) });
      assert.deepEqual([ok.status, await ok.json()], [200, { run: runView }]);
      const missing = await runRoute(req("/api/train/runs/x"), { params: Promise.resolve({ id: "x" }) });
      assert.equal(missing.status, 404);
      caller = null;
      assert.equal((await runRoute(req(`/api/train/runs/${DATASET_ID}`), { params: Promise.resolve({ id: DATASET_ID }) })).status, 403);
    });
  });
});
