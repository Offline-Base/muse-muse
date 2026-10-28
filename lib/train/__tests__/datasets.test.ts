/**
 * Runs makeDataset and its real steps as plain functions, with the store, Meta, the spend cap and usage faked: the
 * prompts come in batches of 25 and are de-duplicated, the answers come 6 at a time in chunks of 24 and are appended at
 * the offset the workflow expects (so a retried chunk is never added or paid for twice), unusable answers are skipped,
 * every Meta call is recorded as platform usage and added to the dataset's cost, 10% is held out for eval, and the
 * dataset fails with a plain reason when the spend cap is reached or too few prompts are left. Nothing here calls Meta
 * or a database.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/datasets.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { evalIndexes } from "../logic";
import type { EvalExample, TrainExample } from "../types";

const DATASET_ID = "dddddddd-0000-4000-8000-000000000000";
const TASK = "Explain Python error messages to beginners, with a fix.";

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

class FakeStructuredOutputError extends Error {
  constructor(
    message: string,
    readonly usage: unknown[],
  ) {
    super(message);
  }
}

interface FakeDataset {
  id: string;
  status: "generating" | "ready" | "failed";
  task: string;
  requested: number;
  train: TrainExample[];
  eval: EvalExample[];
  costUsd: number;
  error: string | null;
}

let ds: FakeDataset;
let paused = false;
let calls: Array<{ fn: string; args: unknown[] }> = [];
/** What the prompt writer returns for a batch: by default `want` new prompts. */
let writePrompts: (want: number, batch: number) => string[] = (want, batch) =>
  Array.from({ length: want }, (_, i) => `Why does my code raise error ${batch}-${i}?`);
let writerThrows: Error | null = null;
/** What Meta answers for a prompt. */
let answer: (prompt: string) => { output_text: string; status: string } | Error = (prompt) => ({
  output_text: `Here is the fix for: ${prompt}`,
  status: "completed",
});
let inFlight = 0;
let peak = 0;

const called = (fn: string) => calls.filter((c) => c.fn === fn);
const head = () => ({ ...ds, train: undefined, eval: undefined, createdAt: new Date(), finishedAt: null });

const fakeStore = {
  getDataset: async (id: string) => (id === ds.id ? head() : null),
  datasetProgress: async (id: string) => (id === ds.id && ds.status === "generating" ? ds.train.length : null),
  appendTrainExamples: async (id: string, offset: number, items: TrainExample[]) => {
    calls.push({ fn: "appendTrainExamples", args: [offset, items.length] });
    if (id !== ds.id || ds.status !== "generating") return null;
    if (ds.train.length === offset) ds.train.push(...items);
    return ds.train.length;
  },
  addDatasetCost: async (_id: string, usd: number) => {
    ds.costUsd = Math.round((ds.costUsd + usd) * 1e6) / 1e6;
  },
  finishDataset: async (id: string, count: number) => {
    calls.push({ fn: "finishDataset", args: [count] });
    if (id !== ds.id || ds.status !== "generating" || ds.train.length !== count) return null;
    const picked = evalIndexes(count);
    ds.eval = picked.map((i) => ({ prompt: ds.train[i]!.messages[1]!.content, reference: ds.train[i]!.messages[2]!.content }));
    ds.train = ds.train.filter((_, i) => !picked.includes(i));
    ds.status = "ready";
    return head();
  },
  failDataset: async (id: string, error: string) => {
    calls.push({ fn: "failDataset", args: [error] });
    if (id !== ds.id || ds.status !== "generating") return false;
    ds.status = "failed";
    ds.error = error;
    return true;
  },
};

const fakeStructured = {
  StructuredOutputError: FakeStructuredOutputError,
  respondStructured: async (opts: { model: string; instructions: string; content: Array<{ text: string }>; schemaName: string }) => {
    const text = opts.content[0]!.text;
    calls.push({ fn: "respondStructured", args: [opts.model, opts.schemaName, text, opts.instructions] });
    if (writerThrows) throw writerThrows;
    const want = Number(/Write (\d+) new prompts/.exec(text)![1]);
    const batch = called("respondStructured").length - 1;
    const usage = [{ model: opts.model, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 2000, costUsd: 0.01 }];
    return { data: { prompts: writePrompts(want, batch) }, usage, issues: [], attempts: 1 };
  },
};

const fakeMeta = {
  metaPlatform: () => ({
    responses: {
      create: async (body: { model: string; instructions: string; input: string; max_output_tokens: number }) => {
        calls.push({ fn: "responses.create", args: [body] });
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        const res = answer(body.input);
        if (res instanceof Error) throw res;
        // 400 input and 400 output tokens of Spark 1.3: $0.0005 + $0.0017.
        return { ...res, usage: { input_tokens: 400, output_tokens: 400 } };
      },
    },
  }),
};

const canMock = typeof (mock as { module?: unknown }).module === "function";
let mod: typeof import("../datasets");

function reset(over: Partial<FakeDataset> = {}) {
  ds = { id: DATASET_ID, status: "generating", task: TASK, requested: 40, train: [], eval: [], costUsd: 0, error: null, ...over };
  paused = false;
  calls = [];
  writePrompts = (want, batch) => Array.from({ length: want }, (_, i) => `Why does my code raise error ${batch}-${i}?`);
  writerThrows = null;
  answer = (prompt) => ({ output_text: `Here is the fix for: ${prompt}`, status: "completed" });
  inFlight = 0;
  peak = 0;
}

describe("dataset workflow", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const at = (rel: string) => new URL(rel, import.meta.url).href;
    mock.module("workflow", { namedExports: { FatalError: FakeFatalError, RetryableError: FakeRetryableError } });
    mock.module(at("../store.ts"), { namedExports: fakeStore });
    mock.module(at("../../brief/structured.ts"), { namedExports: fakeStructured });
    mock.module(at("../../brief/media.ts"), { namedExports: { textPart: (text: string) => ({ type: "input_text", text }) } });
    mock.module(at("../../meta/platform.ts"), { namedExports: fakeMeta });
    mock.module(at("../../quota.ts"), { namedExports: { spendPaused: async () => paused } });
    mock.module(at("../../usage.ts"), {
      namedExports: { recordUsage: async (ctx: unknown, items: unknown[]) => void calls.push({ fn: "recordUsage", args: [ctx, items] }) },
    });
    mod = await import("../datasets");
  });

  after(() => mock.restoreAll());

  beforeEach(() => reset());

  it("writes prompts in batches, answers them, holds out eval and turns ready", async () => {
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "ready" });
    const writes = called("respondStructured");
    assert.equal(writes.length, 2, "25, then 15");
    assert.match(writes[0]!.args[2] as string, /Write 25 new prompts/);
    assert.match(writes[1]!.args[2] as string, /Write 15 new prompts/);
    // Two batches share the eight styles, four each.
    const [first4, last4] = [mod.stylesFor(0, 2), mod.stylesFor(1, 2)];
    assert.equal(new Set([...first4, ...last4]).size, 8, "two batches cover all eight styles");
    for (const style of first4) assert.ok((writes[0]!.args[2] as string).includes(`- ${style}`), style);
    for (const style of last4) assert.ok((writes[1]!.args[2] as string).includes(`- ${style}`), style);
    assert.doesNotMatch(writes[0]!.args[2] as string, /Already written/);
    assert.match(writes[1]!.args[2] as string, /Already written[^]*- Why does my code raise error 0-24\?/, "the next batch sees the last ones");
    assert.equal(writes[0]!.args[0], "muse-spark-1.3");

    // 40 answered in chunks of 24 and 16, 6 at a time.
    assert.deepEqual(called("appendTrainExamples").map((c) => c.args), [
      [0, 24],
      [24, 16],
    ]);
    assert.equal(called("responses.create").length, 40);
    assert.equal(peak, 6);
    const body = called("responses.create")[0]!.args[0] as { model: string; instructions: string; max_output_tokens: number };
    assert.equal(body.model, "muse-spark-1.3");
    assert.match(body.instructions, /You are an assistant for this task: Explain Python error messages/);
    assert.match(body.instructions, /under about 350 words/);

    assert.equal(ds.status, "ready");
    assert.equal(ds.eval.length, 8);
    assert.equal(ds.train.length, 32);
    const [first] = ds.train;
    assert.deepEqual(
      first!.messages.map((m) => m.role),
      ["system", "user", "assistant"],
    );
    assert.equal(first!.messages[0]!.content, body.instructions, "trained under the words it was written with");
    assert.equal(first!.messages[2]!.content, `Here is the fix for: ${first!.messages[1]!.content}`);
    assert.deepEqual(Object.keys(ds.eval[0]!), ["prompt", "reference"]);
  });

  it("leans each batch to one style once there are enough batches, and spreads them over fewer", () => {
    assert.deepEqual(
      Array.from({ length: 9 }, (_, b) => mod.stylesFor(b, 12).length),
      [1, 1, 1, 1, 1, 1, 1, 1, 1],
    );
    assert.notDeepEqual(mod.stylesFor(0, 12), mod.stylesFor(1, 12));
    assert.deepEqual(mod.stylesFor(8, 12), mod.stylesFor(0, 12), "the ninth batch starts the styles again");
    assert.equal(mod.stylesFor(0, 1).length, 8, "a one-batch dataset asks for every style");
    assert.equal(new Set([0, 1, 2].flatMap((b) => mod.stylesFor(b, 3))).size, 8, "three batches still cover all eight");
  });

  it("records every Meta call as platform usage and adds it to the dataset's cost", async () => {
    await mod.makeDataset({ datasetId: DATASET_ID });
    const recorded = called("recordUsage");
    for (const c of recorded) assert.deepEqual(c.args[0], { source: "platform", endpoint: "responses" });
    const items = recorded.flatMap((c) => c.args[1] as Array<{ costUsd: number }>);
    assert.equal(items.length, 2 + 40, "two prompt batches and 40 answers");
    // $0.01 per batch, $0.0022 per answer.
    assert.equal(ds.costUsd, 0.108);
  });

  it("asks for more prompts when batches repeat, and stops after a few extra batches", async () => {
    // Each batch repeats itself and part of the batch before.
    writePrompts = (want, batch) => Array.from({ length: want }, (_, i) => `Prompt ${batch * 12 + (i % 13)}`);
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "ready" });
    assert.ok(called("respondStructured").length > 2);
    const prompts = ds.train.map((e) => e.messages[1]!.content).concat(ds.eval.map((e) => e.prompt));
    assert.equal(new Set(prompts).size, prompts.length, "no prompt twice");
    assert.equal(prompts.length, 40);

    // A writer that keeps repeating itself: 2 batches for 40, plus 4 extra, then it goes on with what it has.
    reset({ requested: 40 });
    writePrompts = (want) => Array.from({ length: want }, (_, i) => `Same prompt ${i % 20}`);
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "ready" });
    assert.equal(called("respondStructured").length, 6);
    assert.equal(ds.train.length + ds.eval.length, 20);
  });

  it("fails with a plain reason when too few different prompts are left", async () => {
    writePrompts = () => ["Only this one?", "only THIS one", "Only this one"];
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "failed" });
    assert.equal(ds.status, "failed");
    assert.equal(ds.error, "Muse Spark 1.3 wrote only 1 different prompts, and a dataset needs 16.");
    assert.equal(called("responses.create").length, 0);
  });

  it("skips answers that failed, ran out of tokens, came back empty or ran too long, but still pays for them", async () => {
    let n = 0;
    answer = (prompt) => {
      n += 1;
      if (n === 1) return new Error("Meta timed out");
      if (n === 2) return { output_text: "Half an answ", status: "incomplete" };
      if (n === 3) return { output_text: "   ", status: "completed" };
      if (n === 4) return { output_text: "x".repeat(4001), status: "completed" };
      if (n === 5) return { output_text: "Use a try block \u2014 then log it.", status: "completed" };
      return { output_text: `Fix for ${prompt}`, status: "completed" };
    };
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "ready" });
    assert.equal(ds.train.length + ds.eval.length, 36);
    const answers = [...ds.train.map((e) => e.messages[2]!.content), ...ds.eval.map((e) => e.reference)];
    assert.ok(answers.includes("Use a try block, then log it."), "no em dashes");
    assert.deepEqual(called("appendTrainExamples").map((c) => c.args), [
      [0, 20],
      [20, 16],
    ]);
    // The timed-out call has no usage; the other three were billed.
    const answerUsage = called("recordUsage").flatMap((c) => c.args[1] as Array<{ inputTokens: number }>).filter((u) => u.inputTokens === 400);
    assert.equal(answerUsage.length, 39);
  });

  it("leaves out up to 2 chunks Meta never answered, and fails on the third", async () => {
    reset({ requested: 100 });
    // Chunks of 24: the prompts of chunks 1 and 3 (0-based) never get an answer.
    const dead = (prompt: string) => {
      const [batch, i] = /error (\d+)-(\d+)/.exec(prompt)!.slice(1).map(Number) as [number, number];
      const chunk = Math.floor((batch * 25 + i) / 24);
      return chunk === 1 || chunk === 3;
    };
    answer = (prompt) => (dead(prompt) ? new Error("Meta is down") : { output_text: `Fix for ${prompt}`, status: "completed" });
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "ready" });
    assert.equal(ds.train.length + ds.eval.length, 100 - 48);

    // Chunks 0, 2 and 4: the third one fails the dataset.
    reset({ requested: 100 });
    answer = (prompt) => {
      const [batch, i] = /error (\d+)-(\d+)/.exec(prompt)!.slice(1).map(Number) as [number, number];
      return Math.floor((batch * 25 + i) / 24) % 2 === 0 ? new Error("Meta is down") : { output_text: "ok", status: "completed" };
    };
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "failed" });
    assert.equal(ds.error, "Muse Spark 1.3 answered none of this chunk's prompts.");
  });

  it("stops the dataset once the platform's daily spend cap is reached", async () => {
    paused = true;
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "failed" });
    assert.equal(ds.error, "The platform's daily spend cap is reached, so the dataset stopped.");
    assert.equal(called("respondStructured").length + called("responses.create").length, 0);
  });

  it("charges a writer reply that never matched the schema, then fails", async () => {
    writerThrows = new FakeStructuredOutputError("training_prompts: no valid reply after a retry.", [
      { model: "muse-spark-1.3", inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, costUsd: 0.002 },
    ]);
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "failed" });
    assert.equal(ds.costUsd, 0.002);
    assert.equal(ds.error, "training_prompts: no valid reply after a retry.");
  });

  it("does nothing for a dataset that already finished", async () => {
    reset({ status: "ready" });
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "ready" });
    assert.equal(calls.length, 0);
  });

  describe("answerChunkStep", () => {
    const system = "You are an assistant for this task: test";
    const prompts = ["a?", "b?", "c?"];

    it("doesn't ask or pay again for a chunk an earlier attempt saved", async () => {
      assert.deepEqual(await mod.answerChunkStep({ datasetId: DATASET_ID, system, offset: 0, prompts }), { saved: 3 });
      calls = [];
      assert.deepEqual(await mod.answerChunkStep({ datasetId: DATASET_ID, system, offset: 0, prompts }), { saved: 3 });
      assert.equal(called("responses.create").length + called("recordUsage").length, 0);
      assert.equal(ds.train.length, 3);
    });

    it("retries a chunk with no usable answer, and refuses a dataset that stopped generating", async () => {
      answer = () => new Error("Meta is down");
      await assert.rejects(mod.answerChunkStep({ datasetId: DATASET_ID, system, offset: 0, prompts }), FakeRetryableError);
      ds.status = "failed";
      await assert.rejects(mod.answerChunkStep({ datasetId: DATASET_ID, system, offset: 0, prompts }), FakeFatalError);
    });
  });
});
