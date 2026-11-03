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
/** Fails only the start calls it says yes to (the second is tuneRun's). */
let startFailsWhen: () => boolean = () => false;
let draft: Record<string, unknown> = {};
let structuredFails = false;
let runView: Record<string, unknown> | null = null;
const BUILD_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const PRODUCT_ID = "cccccccc-0000-4000-8000-000000000001";
let builds: Record<string, { buildId: string; productId: string; productName: string; ownerId: string; offers: boolean }> = {};

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
        createImportedDataset: async () => null,
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
    mock.module(at("../run-store.ts"), {
      namedExports: {
        saveRunTrainer: async () => {},
        latestTuneJob: async () => null,
        readRunMarks: async () => ({ steps: null, stopped: false, ended: null, heartbeat: null }),
        saveRunSteps: async (...args: unknown[]) => void calls.push({ fn: "saveRunSteps", args }),
        saveRunProduct: async (...args: unknown[]) => void calls.push({ fn: "saveRunProduct", args }),
        saveRunVisitor: async () => {},
        saveRunAutoPublish: async () => {},
        saveRunBase: async () => {},
        saveRunDatasetOnly: async () => {},
      },
    });
    mock.module(at("../build-source.ts"), {
      namedExports: {
        buildForTune: async (id: string) => {
          calls.push({ fn: "buildForTune", args: [id] });
          return builds[id] ?? null;
        },
      },
    });
    // The tuneRun workflow is started, never run, here (lib/train/tune/__tests__/run-flow.test.ts runs it on PGlite).
    mock.module(at("../run.ts"), { namedExports: { tuneRun: async () => ({ status: "launched" }) } });
    mock.module(at("../../datasets.ts"), { namedExports: { DATASET_MODEL: "muse-wonder-1.0", makeDataset: async () => ({ status: "ready" }) } });
    mock.module("workflow/api", {
      namedExports: {
        start: async (_wf: unknown, args: unknown[]) => {
          calls.push({ fn: "start", args });
          if (startFails || startFailsWhen()) throw new Error("queue unavailable");
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
    startFailsWhen = () => false;
    structuredFails = false;
    runView = { id: DATASET_ID, stage: "writing" };
    delete process.env.TUNE_FROM_BUILDS;
    builds = { [BUILD_ID]: { buildId: BUILD_ID, productId: PRODUCT_ID, productName: "Feeder Count", ownerId: "owner-1", offers: true } };
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

    it("says who will write a described run's examples, and refuses a dataset-only plan before the model call when MAKE_CHAT_ALL is off", async () => {
      const res = await planRoute(req("/api/train/plan", { note: NOTE }));
      assert.equal(((await res.json()) as { writerModel?: string }).writerModel, "muse-spark-1.3-contributor");
      const before = called("respondStructured").length;
      delete process.env.MAKE_CHAT_ALL;
      const off = await planRoute(req("/api/train/plan", { note: NOTE, settings: { datasetOnly: true } }));
      assert.equal(off.status, 404);
      assert.equal(((await off.json()) as { error: string }).error, "dataset_only_off");
      assert.equal(called("respondStructured").length, before, "no plan call was paid for");
      process.env.MAKE_CHAT_ALL = "1";
      try {
        assert.equal((await planRoute(req("/api/train/plan", { note: NOTE, settings: { datasetOnly: true } }))).status, 200);
      } finally {
        delete process.env.MAKE_CHAT_ALL;
      }
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
      // The datasets route's own 20 would always end short of 16 to train on and 8 to score with.
      const twenty = await planRoute(req("/api/train/plan", { note: NOTE, settings: { examples: 20 } }));
      assert.deepEqual([twenty.status, await twenty.json()], [400, { error: "examples must be a whole number from 40 to 1000." }]);
      process.env.TUNE_DEFAULT_EXAMPLES = "20";
      assert.equal(((await draftOne()).settings as { examples: number }).examples, 40, "a small default is held to 40");
    });

    it("takes 50 long rows once the composer cut them for the task (planRows)", async () => {
      const { planRows } = await import("@/lib/train/tune/examples");
      const long = Array.from({ length: 50 }, (_, i) => ({ prompt: `Made-up question ${i} ${"about cakes ".repeat(120)}`, answer: `Made-up reply ${i} ${"warm and short ".repeat(250)}` }));
      assert.ok(JSON.stringify(long).length > 128 * 1024, "the rows as written are over the limit");
      const rows = planRows(long);
      assert.ok(JSON.stringify(rows).length < 32 * 1024, `cut, they are ${JSON.stringify(rows).length} characters`);
      const plan = await draftOne({ examples: rows });
      assert.equal((plan.examples as { given: number }).given, 50);
      const { foldExamples } = await import("@/lib/train/tune/examples");
      assert.deepEqual(foldExamples(NOTE, rows, 2000), foldExamples(NOTE, long, 2000), "cutting first changes nothing in the task");
      const raw = await planRoute(req("/api/train/plan", { note: NOTE, examples: long.map((r) => ({ prompt: r.prompt.slice(0, 1500), answer: r.answer.slice(0, 4000) })) }));
      assert.deepEqual([raw.status, await raw.json()], [413, { error: "body_too_large" }]);
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
      // Then the run keeps its steps and the tuneRun workflow starts on it, to train it once the examples are ready.
      assert.deepEqual(called("saveRunSteps")[0]!.args, [DATASET_ID, 120]);
      assert.deepEqual(called("start")[1]!.args, [{ datasetId: DATASET_ID, callerId: "admin-1", steps: 120 }]);
      assert.equal(called("start").length, 2);
    });

    it("takes Advanced's training steps, up to as many as fit in the run's time limit", async () => {
      const res = await runsRoute(req("/api/train/runs", { plan: await draftOne(), settings: { steps: 300 } }));
      assert.equal(res.status, 201);
      assert.deepEqual(called("saveRunSteps")[0]!.args, [DATASET_ID, 300]);
      assert.equal((called("start")[1]!.args[0] as { steps: number }).steps, 300);
      for (const steps of [5, 2000, 120.5, "200"]) {
        const bad = await runsRoute(req("/api/train/runs", { plan: await draftOne(), settings: { steps } }));
        assert.equal(bad.status, 400, String(steps));
        assert.match(((await bad.json()) as { error: string }).error, /^steps must be a whole number from 10 to 350\.$/);
      }
      assert.equal(called("createDataset").length, 1, "a bad number starts nothing");
    });

    it("still starts the examples when the tuneRun workflow can't start", async () => {
      const plan = await draftOne();
      let n = 0;
      startFailsWhen = () => ++n === 2;
      const res = await runsRoute(req("/api/train/runs", { plan }));
      assert.equal(res.status, 201, "the room offers Start training once the examples are ready");
      assert.equal(called("failDataset").length, 0);
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
      const short = await runsRoute(req("/api/train/runs", { plan: await draftOne(), settings: { examples: 20 } }));
      assert.equal(short.status, 400, "20 can't leave 16 to train on and 8 to score with");
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

  describe("from a build (TUNE_FROM_BUILDS)", () => {
    it("refuses fromBuildId with the flag off, before the model", async () => {
      const res = await planRoute(req("/api/train/plan", { note: NOTE, fromBuildId: BUILD_ID }));
      assert.equal(res.status, 404);
      assert.deepEqual([called("buildForTune").length, called("respondStructured").length], [0, 0]);
    });

    it("plans for the build's product: the source is signed with the plan, for its owner or an admin", async () => {
      process.env.TUNE_FROM_BUILDS = "1";
      const plan = await draftOne({ fromBuildId: BUILD_ID });
      assert.deepEqual(plan.source, { kind: "build", buildId: BUILD_ID, productId: PRODUCT_ID });
      // The product's owner (were the composer open to them) may too; anyone else may not.
      caller = { id: "owner-1", email: "maker@example.com", isAdmin: false };
      assert.equal((await planRoute(req("/api/train/plan", { note: NOTE, fromBuildId: BUILD_ID }))).status, 200);
      caller = { id: "someone-else", email: "someone@example.com", isAdmin: false };
      const other = await planRoute(req("/api/train/plan", { note: NOTE, fromBuildId: BUILD_ID }));
      assert.deepEqual([other.status, await other.json()], [403, { error: "not_owner" }]);
      caller = { id: "admin-1", email: "owner@example.com", isAdmin: true };
      const missing = await planRoute(req("/api/train/plan", { note: NOTE, fromBuildId: "bbbbbbbb-0000-4000-8000-0000000000ff" }));
      assert.deepEqual([missing.status, await missing.json()], [404, { error: "build_not_found" }]);
      assert.equal((await planRoute(req("/api/train/plan", { note: NOTE, fromBuildId: 7 }))).status, 404);
      builds[BUILD_ID]!.offers = false;
      const notReady = await planRoute(req("/api/train/plan", { note: NOTE, fromBuildId: BUILD_ID }));
      assert.deepEqual([notReady.status, await notReady.json()], [409, { error: "build_not_ready" }]);
      assert.equal(called("respondStructured").length, 2, "only the two good plans asked the model");
    });

    it("starts a build plan like a task plan, keeps its product with the run, once a product a day", async () => {
      process.env.TUNE_FROM_BUILDS = "1";
      const plan = await draftOne({ fromBuildId: BUILD_ID });
      const res = await runsRoute(req("/api/train/runs", { plan }));
      assert.equal(res.status, 201, await res.clone().text());
      assert.equal(called("createDataset").length, 1);
      assert.deepEqual(called("saveRunProduct")[0]!.args, [DATASET_ID, PRODUCT_ID, BUILD_ID]);
      assert.equal(counters[`tune-product-day:${PRODUCT_ID}`], 1);

      // A second plan for the same product the same day: 429, and that plan may still start tomorrow.
      const again = await draftOne({ fromBuildId: BUILD_ID, note: `${NOTE} Gift boxes too.` });
      const second = await runsRoute(req("/api/train/runs", { plan: again }));
      assert.equal(second.status, 429);
      const body = (await second.json()) as { error: string; retryAfterSeconds: number };
      assert.equal(body.error, "product_daily");
      assert.ok(body.retryAfterSeconds > 0 && body.retryAfterSeconds <= 86_400, String(body.retryAfterSeconds));
      assert.equal(counters[`tune-run:${again.token as string}`], 0, "the plan's one start is given back");
      assert.equal(called("createDataset").length, 1, "nothing more was written");

      // A start that fails gives the product's day back.
      counters = {};
      startFails = true;
      assert.equal((await runsRoute(req("/api/train/runs", { plan: again }))).status, 500);
      assert.equal(counters[`tune-product-day:${PRODUCT_ID}`], 0);
    });

    it("checks a build plan again at Start: the flag still on, and the build still offering its own model", async () => {
      process.env.TUNE_FROM_BUILDS = "1";
      const plan = await draftOne({ fromBuildId: BUILD_ID });
      process.env.TUNE_FROM_BUILDS = "0";
      const off = await runsRoute(req("/api/train/runs", { plan }));
      assert.deepEqual([off.status, await off.json()], [404, { error: "not_found" }]);
      process.env.TUNE_FROM_BUILDS = "1";
      builds[BUILD_ID]!.offers = false;
      const notReady = await runsRoute(req("/api/train/runs", { plan }));
      assert.deepEqual([notReady.status, await notReady.json()], [409, { error: "build_not_ready" }]);
      assert.equal(called("createDataset").length, 0);
      assert.equal(counters[`tune-run:${plan.token as string}`] ?? 0, 0, "the plan may still start");
      builds[BUILD_ID]!.offers = true;
      assert.equal((await runsRoute(req("/api/train/runs", { plan }))).status, 201);
    });

    it("refuses a build plan past the spend cap, as a task plan", async () => {
      process.env.TUNE_FROM_BUILDS = "1";
      const plan = await draftOne({ fromBuildId: BUILD_ID });
      paused = true;
      assert.equal((await runsRoute(req("/api/train/runs", { plan }))).status, 503);
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
