/**
 * Fireworks training: the cost gate, the limits and the REST calls, with fakes only. Nothing reaches Fireworks, Meta or a
 * database, and nothing is spent. All data is made up.
 *
 *   npx tsx --test lib/train/fireworks/__tests__/fireworks.test.ts
 */
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { fireworksApi, FireworksError, liveQuote } from "@/lib/train/fireworks/api";
import { evalAnswersUsd } from "@/lib/train/fireworks/cost";
import { launchFireworksJob, planFromQuote, type FwLaunchDeps, type FwPlan } from "@/lib/train/fireworks/launch";
import { answerRateFrom, evalCeilingUsd, holdFor, moneyUsd, offerFrom, quoteFrom } from "@/lib/train/fireworks/quote";
import { batchJsonl, parseBatchOutput, trainJsonl } from "@/lib/train/fireworks/rows";
import { gpuBudget } from "@/lib/train/gpu-budget";
import { staleReason } from "@/lib/train/sweep";
import type { TrainJobRow } from "@/lib/train/logic";

const MODELS = "> Muse Glimmer 30B SFT is free to train until November 30, 2026.\\\n> No credit card required.";
const PRICING = "<p>Muse Glimmer 30B SFT is free via UI and Serverless Training API until 11/30 <span>x</span></p>";
const SERVERLESS = "| More than 16B parameters | \\$0.90 |";
const NOV = new Date("2026-11-02T00:00:00Z");
const saved = { ...process.env };

after(() => {
  process.env = saved;
});

describe("the cost gate", () => {
  const quote = (over: Partial<Parameters<typeof quoteFrom>[0]> = {}) => quoteFrom({ modelsPage: MODELS, pricingPage: PRICING, serverlessPage: SERVERLESS, tunable: true, now: NOV, ...over });

  it("confirms $0 training only while both live pages state it", () => {
    const q = quote();
    assert.ok(q.ok);
    assert.equal(q.trainingUsd, 0);
    assert.equal(q.ratePerMTokens, 0.9);
    assert.equal(q.until, "2026-12-01T08:00:00.000Z");
    assert.match(q.words, /free via UI/);
  });
  it("never assumes free: a page without the offer, or pages that disagree, refuse", () => {
    assert.equal(quote({ modelsPage: "Models" }).ok, false);
    assert.equal(quote({ pricingPage: "Models 16.1B - 80B $3.00" }).ok, false);
    assert.equal(offerFrom(MODELS, PRICING.replace("11/30", "12/31")), null);
    assert.equal(offerFrom(MODELS.replace("Muse Glimmer 30B", "Other Model"), PRICING), null);
  });
  it("refuses once the date has passed, to the second, in Pacific time", () => {
    assert.equal(quote({ now: new Date("2026-12-01T07:59:59Z") }).ok, true);
    assert.equal(quote({ now: new Date("2026-12-01T08:00:00Z") }).ok, false);
  });
  it("refuses when the catalog doesn't say tunable, or answering has no price", () => {
    assert.equal(quote({ tunable: false }).ok, false);
    assert.equal(quote({ serverlessPage: "" }).ok, false);
  });
  it("prefers the model's own price row, at its higher side", () => {
    assert.equal(answerRateFrom("| [Muse Glimmer 30B](x) | \\$0.20 / \\$0.02 / \\$0.80 | y |\n| More than 16B parameters | \\$0.90 |"), 0.8);
  });
  it("is no quote when a page can't be read", async () => {
    const q = await liveQuote({ baseTunable: async () => true }, (async () => new Response("no", { status: 500 })) as typeof fetch, NOV);
    assert.equal(q.ok, false);
  });
  it("refuses a run with no quote, and everything with the flag off", () => {
    process.env.FIREWORKS_TUNE = "1";
    const r = planFromQuote({ ok: false, reason: "no" }, 8);
    assert.equal(r.ok === false && r.code, "fireworks_cost_unconfirmed");
    delete process.env.FIREWORKS_TUNE;
    const off = planFromQuote(quote(), 8);
    assert.equal(off.ok === false && off.code, "fireworks_off");
  });
  it("reads a job's own quote, and another currency never passes as cheap", () => {
    assert.equal(moneyUsd(undefined), null);
    assert.equal(moneyUsd({ currencyCode: "USD", units: "0", nanos: 0 }), 0);
    assert.equal(moneyUsd({ currencyCode: "USD", units: "1", nanos: 500_000_000 }), 1.5);
    assert.equal(moneyUsd({ currencyCode: "EUR", units: "0" }), Infinity);
  });
});

describe("what a run holds", () => {
  it("counts scoring's ceiling, at least the smallest job's limit, and skips scoring above the cap", () => {
    assert.equal(evalCeilingUsd(20, 0.9), 0.1);
    assert.deepEqual(holdFor(100, 0.9, 1), { scoring: true, evalMaxUsd: 0.46, holdUsd: 0.46 });
    assert.deepEqual(holdFor(8, 0.9, 0), { scoring: false, evalMaxUsd: 0.04, holdUsd: 0.1 });
    assert.equal(holdFor(0, 0.9, 1).scoring, false);
  });
  it("charges the whole ceiling when no tokens are reported", () => {
    assert.equal(evalAnswersUsd(0, 0.9, 0.46), 0.46);
    assert.equal(evalAnswersUsd(100_000, 0.9, 0.46), 0.09);
  });
});

describe("launch limits", () => {
  const plan: FwPlan = { scoring: true, evalMaxUsd: 0.46, holdUsd: 0.46, ratePerMTokens: 0.9 };
  const input = { datasetId: "d", title: "A made-up helper", loraRank: 16, learningRate: 0.0002, maxMinutes: 60, plan };
  let rows: { status: "running"; priceCentsPerHour: number; maxUsd: number; launchedAt: null; terminatedAt: null; costUsd: number; createdBy: string }[];
  let created: Array<{ maxUsd: number; params: Record<string, unknown>; priceCentsPerHour: number }>;
  let failed: string[];
  let started: string[];
  const deps = (over: Partial<FwLaunchDeps> = {}): FwLaunchDeps => ({
    activeJobCount: async () => rows.length,
    gpuBudgetFor: async (id) => gpuBudget(rows, id, { userUsd: 100, totalUsd: 3000 }, NOV),
    trainingCommittedToday: async () => rows.reduce((n, r) => n + r.maxUsd, 0),
    createJob: async (j) => {
      created.push(j as (typeof created)[number]);
      rows.push({ status: "running", priceCentsPerHour: 0, maxUsd: j.maxUsd, launchedAt: null, terminatedAt: null, costUsd: 0, createdBy: "u" });
      return { id: "job-1" } as TrainJobRow;
    },
    setStatus: async (id) => {
      failed.push(id);
    },
    attachRun: async () => {},
    startWorkflow: async (id) => {
      started.push(id);
      return "wrun";
    },
    ...over,
  });

  beforeEach(() => {
    rows = [];
    created = [];
    failed = [];
    started = [];
    process.env.FIREWORKS_TUNE = "1";
    process.env.FIREWORKS_API_KEY = "made-up";
    process.env.TRAIN_MAX_ACTIVE = "2";
    process.env.TRAIN_DAILY_USD = "1";
  });

  it("writes its hold on the job's row, so it counts against every limit, with no upload", async () => {
    const r = await launchFireworksJob(input, { userId: "u" }, deps());
    assert.ok(r.ok);
    assert.equal(created[0]!.maxUsd, 0.46);
    assert.equal(created[0]!.params.trainer, "fireworks");
    assert.equal(created[0]!.params.baseModel, "accounts/fireworks/models/muse-glimmer-30b");
    assert.equal(created[0]!.params.publish, 0);
    assert.deepEqual(started, ["job-1"]);
  });
  it("is off with the flag and without a key, before touching anything", async () => {
    delete process.env.FIREWORKS_TUNE;
    const off = await launchFireworksJob(input, { userId: "u" });
    assert.equal(off.ok === false && off.code, "fireworks_off");
    process.env.FIREWORKS_TUNE = "1";
    delete process.env.FIREWORKS_API_KEY;
    const none = await launchFireworksJob(input, { userId: "u" });
    assert.equal(none.ok === false && none.code, "fireworks_not_configured");
  });
  it("refuses past TRAIN_MAX_ACTIVE", async () => {
    rows = [1, 2].map(() => ({ status: "running", priceCentsPerHour: 0, maxUsd: 0.1, launchedAt: null, terminatedAt: null, costUsd: 0, createdBy: "x" }));
    const r = await launchFireworksJob(input, { userId: "u" }, deps());
    assert.equal(r.ok === false && r.code, "too_many_active");
    assert.equal(created.length, 0);
  });
  it("refuses past the person's lifetime limit rather than lowering its hold", async () => {
    rows = [{ status: "running", priceCentsPerHour: 0, maxUsd: 99.8, launchedAt: null, terminatedAt: null, costUsd: 0, createdBy: "u" }];
    const r = await launchFireworksJob(input, { userId: "u" }, deps({ activeJobCount: async () => 0, trainingCommittedToday: async () => 0 }));
    assert.equal(r.ok === false && r.code, "gpu_limit");
    assert.equal(created.length, 0);
  });
  it("refuses past the daily cap", async () => {
    const r = await launchFireworksJob(input, { userId: "u" }, deps({ trainingCommittedToday: async () => 0.8 }));
    assert.equal(r.ok === false && r.code, "daily_cap");
  });
  it("backs out when another start took the slot at the same moment, and starts no workflow", async () => {
    process.env.TRAIN_MAX_ACTIVE = "1";
    let reads = 0;
    const r = await launchFireworksJob(input, { userId: "u" }, deps({ activeJobCount: async () => (reads++ === 0 ? 0 : 2) }));
    assert.equal(r.ok === false && r.code, "too_many_active");
    assert.deepEqual(failed, ["job-1"]);
    assert.deepEqual(started, []);
  });
  it("fails the row when its workflow can't start", async () => {
    const r = await launchFireworksJob(input, { userId: "u" }, deps({ startWorkflow: async () => { throw new Error("down"); } }));
    assert.equal(r.ok === false && r.code, "start_failed");
    assert.deepEqual(failed, ["job-1"]);
  });
});

describe("Fireworks' formats", () => {
  it("swaps in the one-line system message, drops rows with no answer or too long", () => {
    const out = trainJsonl(
      [
        { messages: [{ role: "system", content: "long" }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }] },
        { messages: [{ role: "user", content: "no answer" }] },
        { messages: [{ role: "user", content: "x".repeat(9000) }, { role: "assistant", content: "y" }] },
      ],
      "You are a made-up helper.",
    );
    assert.equal(out.count, 1);
    assert.deepEqual(JSON.parse(out.jsonl).messages[0], { role: "system", content: "You are a made-up helper." });
  });
  it("round trips a kept-aside prompt through batch input and output, with or without a body", () => {
    const input = JSON.parse(batchJsonl([{ prompt: "p", reference: "r" }], "s", 1024));
    assert.equal(input.custom_id, "0");
    assert.equal(input.body.max_tokens, 1024);
    assert.ok(!JSON.stringify(input).includes('"r"'));
    const a = parseBatchOutput(`${JSON.stringify({ custom_id: "0", response: { choices: [{ message: { content: " a " } }], usage: { total_tokens: 5 } } })}\nnot json\n${JSON.stringify({ custom_id: "1", response: { body: { choices: [{ message: { content: "b" } }], usage: { total_tokens: 7 } } } })}`);
    assert.deepEqual([...a.answers], [[0, "a"], [1, "b"]]);
    assert.equal(a.tokens, 12);
  });
});

describe("the REST client", () => {
  function fake(reply: (url: string, init?: RequestInit) => Response) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const send = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return reply(String(url), init);
    }) as typeof fetch;
    return { calls, api: fireworksApi({ apiKey: () => "made-up-key", accountId: () => "acct", fetch: send }) };
  }
  it("creates a flat job body and reads back what an earlier try made", async () => {
    const { calls, api } = fake((u) => (u.includes("?supervised") ? new Response("{}", { status: 409 }) : Response.json({ state: "JOB_STATE_RUNNING" })));
    const job = await api.createSftJob("j", { baseModel: "b" });
    assert.equal(job.state, "JOB_STATE_RUNNING");
    assert.match(calls[0]!.url, /accounts\/acct\/supervisedFineTuningJobs\?supervisedFineTuningJobId=j/);
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { baseModel: "b" });
  });
  it("marks a billing refusal, and its message carries neither the key nor Fireworks' words", async () => {
    const { api } = fake(() => new Response("add a payment method, key made-up-key", { status: 412 }));
    await assert.rejects(api.createSftJob("j", {}), (e: FireworksError) => {
      assert.equal(e.billing, true);
      assert.ok(!e.message.includes("made-up-key"));
      return true;
    });
  });
  it("treats deleting what's gone as done, and only base tunable when the catalog says exactly so", async () => {
    const gone = fake(() => new Response("", { status: 404 }));
    await gone.api.deleteModel("m");
    assert.equal(await gone.api.baseTunable(), false);
    const yes = fake(() => Response.json({ supervisedLoraTunable: true }));
    assert.equal(await yes.api.baseTunable(), true);
    assert.equal(yes.calls[0]!.url, "https://api.fireworks.ai/v1/accounts/fireworks/models/muse-glimmer-30b");
  });
  it("names an adapter's files without handing out signed addresses", async () => {
    const { api } = fake(() => Response.json({ filenameToSignedUrls: { "adapter_model.safetensors": "https://signed.example/secret" } }));
    assert.deepEqual(await api.modelFiles("m"), ["adapter_model.safetensors"]);
  });
});

describe("the sweep", () => {
  it("leaves a queued-on-Fireworks job with no instance alone until past its limit", () => {
    const launchedAt = new Date("2026-11-02T00:00:00Z");
    const job = { status: "running", createdAt: launchedAt, launchedAt, maxMinutes: 60 } as TrainJobRow;
    assert.equal(staleReason(job, new Date("2026-11-02T01:00:00Z")), null);
    assert.ok(staleReason(job, new Date("2026-11-02T01:31:00Z")));
  });
});
