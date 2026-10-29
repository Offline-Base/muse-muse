/**
 * Runs makeDataset and its real steps as plain functions, with the store, Meta, the spend cap and usage faked: Muse
 * Wonder writes every prompt and answer, at Muse Wonder's prices, never Muse Spark 1.3; the prompts come in batches of
 * 25 and are de-duplicated, the answers come 6 at a time in chunks of 12, each one charged and saved as it returns
 * and moved onto the dataset once a chunk (so a retried chunk never asks or pays for an answer it already has),
 * unusable answers are skipped, every Meta call is recorded as platform usage and added to the
 * dataset's cost, a step past its time hands its last prompts to the next one, 10% is held out for eval with no
 * near-duplicate of an eval prompt left in train, a late error keeps what was paid for as a smaller ready dataset with a
 * note, and the dataset fails with a plain reason when the spend cap is reached early or too few prompts are left.
 * Nothing here calls Meta or a database.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/datasets.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { evalSplit, isNearDuplicate, promptWords } from "../logic";
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

/**
 * The writer's default prompt: mostly words no other prompt has, so no two are near-duplicates (lib/train/logic.ts
 * isNearDuplicate) and the eval split is the plain even spread.
 */
const promptAt = (batch: number, i: number) => `Why does error ${batch}-${i} hit k${batch}x${i}a k${batch}x${i}b k${batch}x${i}c?`;

let ds: FakeDataset;
let paused = false;
let calls: Array<{ fn: string; args: unknown[] }> = [];
/** What the prompt writer returns for a batch: by default `want` new prompts. */
let writePrompts: (want: number, batch: number) => string[] = (want, batch) =>
  Array.from({ length: want }, (_, i) => promptAt(batch, i));
let writerThrows: Error | null = null;
/** What Meta answers for a prompt. */
let answer: (prompt: string) => { output_text: string; status: string } | Error = (prompt) => ({
  output_text: `Here is the fix for: ${prompt}`,
  status: "completed",
});
let inFlight = 0;
let peak = 0;
/** Database writes that fail before they work, by name: each failure counts down. */
let failing: Record<string, number> = {};

const called = (fn: string) => calls.filter((c) => c.fn === fn);
const head = () => ({ ...ds, train: undefined, eval: undefined, createdAt: new Date(), finishedAt: null });

function write(fn: string) {
  if ((failing[fn] ?? 0) > 0) {
    failing[fn] -= 1;
    throw new Error(`${fn}: fetch failed`);
  }
}

// Like the real store: while generating, eval holds the answers saved for the chunk being written.
const fakeStore = {
  getDataset: async (id: string) => (id === ds.id ? head() : null),
  answerProgress: async (id: string) =>
    id === ds.id && ds.status === "generating" ? { held: ds.train.length, staged: ds.eval.map((e) => e.prompt) } : null,
  stageAnswer: async (id: string, item: EvalExample) => {
    write("stageAnswer");
    calls.push({ fn: "stageAnswer", args: [item.prompt] });
    if (id !== ds.id || ds.status !== "generating") return false;
    if (!ds.eval.some((e) => e.prompt === item.prompt)) ds.eval.push(item);
    return true;
  },
  flushAnswers: async (id: string, system: string) => {
    write("flushAnswers");
    if (id !== ds.id || ds.status !== "generating") return null;
    for (const e of ds.eval) {
      ds.train.push({
        messages: [
          { role: "system", content: system },
          { role: "user", content: e.prompt },
          { role: "assistant", content: e.reference },
        ],
      });
    }
    ds.eval = [];
    calls.push({ fn: "flushAnswers", args: [ds.train.length] });
    return ds.train.length;
  },
  addDatasetCost: async (_id: string, usd: number) => {
    write("addDatasetCost");
    ds.costUsd = Math.round((ds.costUsd + usd) * 1e6) / 1e6;
  },
  finishDataset: async (id: string, count: number, note: string | null = null) => {
    calls.push({ fn: "finishDataset", args: [count, note] });
    if (id !== ds.id || ds.status !== "generating" || ds.train.length !== count) return null;
    const { held, dropped } = evalSplit(ds.train.map((e) => e.messages[1]!.content));
    ds.eval = held.map((i) => ({ prompt: ds.train[i]!.messages[1]!.content, reference: ds.train[i]!.messages[2]!.content }));
    ds.train = ds.train.filter((_, i) => !held.includes(i) && !dropped.includes(i));
    ds.status = "ready";
    ds.error = note;
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
      create: async (body: { model: string; instructions: string; input: string; max_output_tokens: number }, opts: unknown) => {
        calls.push({ fn: "responses.create", args: [body, opts] });
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        const res = answer(body.input);
        if (res instanceof Error) throw res;
        // 400 input and 400 output tokens of Muse Wonder: $0.0016 + $0.008.
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
  writePrompts = (want, batch) => Array.from({ length: want }, (_, i) => promptAt(batch, i));
  writerThrows = null;
  answer = (prompt) => ({ output_text: `Here is the fix for: ${prompt}`, status: "completed" });
  inFlight = 0;
  peak = 0;
  failing = {};
  if (mod) {
    // A failed write is tried again at once, so the tests don't wait.
    mod.ANSWER_STEP_TIMING.startByMs = 120_000;
    mod.ANSWER_STEP_TIMING.saveRetryMs = [0, 0, 0, 0];
  }
}

/** All the dataset's prompts once it is ready: train, then eval. */
const allPrompts = () => ds.train.map((e) => e.messages[1]!.content).concat(ds.eval.map((e) => e.prompt));

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
      namedExports: {
        recordUsage: async (ctx: unknown, items: unknown[]) => {
          write("recordUsage");
          calls.push({ fn: "recordUsage", args: [ctx, items] });
        },
      },
    });
    mod = await import("../datasets");
    reset();
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
    assert.match(writes[1]!.args[2] as string, /Already written[^]*- Why does error 0-24 hit k0x24a k0x24b k0x24c\?/, "the next batch sees the last ones");
    assert.equal(writes[0]!.args[0], "muse-wonder-1.0", "Muse Wonder writes the prompts");
    assert.equal(mod.DATASET_MODEL, "muse-wonder-1.0");

    // 40 answered in chunks of 12, 6 at a time, each saved as it came and moved onto the dataset once a chunk.
    assert.deepEqual(
      called("flushAnswers").map((c) => c.args[0]),
      [12, 24, 36, 40, 40],
      "and once more as it finishes, with nothing left to move",
    );
    assert.equal(called("stageAnswer").length, 40);
    assert.equal(called("responses.create").length, 40);
    assert.equal(peak, 6);
    const body = called("responses.create")[0]!.args[0] as { model: string; instructions: string; max_output_tokens: number };
    assert.deepEqual(called("responses.create")[0]!.args[1], { timeout: 90_000, maxRetries: 1 }, "a prompt takes 3 minutes at most");
    assert.equal(body.model, "muse-wonder-1.0", "and answers them, never Muse Spark 1.3");
    assert.equal(body.max_output_tokens, 4000, "the answer plus room for Muse Wonder's reasoning");
    assert.match(body.instructions, /You are an assistant for this task: Explain Python error messages/);
    assert.match(body.instructions, /under about 350 words/);

    assert.equal(ds.status, "ready");
    assert.equal(ds.error, null, "no note on a dataset that wasn't cut short");
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

  it("shows a batch what earlier batches of its style wrote, on top of the latest prompts", () => {
    const byBatch = Array.from({ length: 17 }, (_, b) => Array.from({ length: 25 }, (_, i) => `batch ${b} prompt ${i}`));
    const avoid = mod.avoidList(byBatch, 17, 40);
    // Batch 17 leans to batch 9's and batch 1's style: their prompts first, newest batch first, then the latest 40.
    assert.deepEqual(avoid.slice(0, 40), [
      ...byBatch[9]!,
      ...byBatch[1]!.slice(0, 15),
    ]);
    assert.deepEqual(avoid.slice(40), [...byBatch[15]!.slice(10), ...byBatch[16]!]);
    // A prompt among the latest is shown once, and each is cut to 140 characters.
    const near = [[`${"x".repeat(200)}`], ["b1"], ["b2"]];
    assert.deepEqual(mod.avoidList(near, 3, 1), ["x".repeat(140), "b1", "b2"]);
    assert.deepEqual(mod.avoidList([], 0, 4), []);
  });

  it("records every Meta call as platform usage and adds it to the dataset's cost", async () => {
    await mod.makeDataset({ datasetId: DATASET_ID });
    const recorded = called("recordUsage");
    for (const c of recorded) assert.deepEqual(c.args[0], { source: "platform", endpoint: "responses" });
    const items = recorded.flatMap((c) => c.args[1] as Array<{ costUsd: number }>);
    assert.equal(items.length, 2 + 40, "two prompt batches and 40 answers");
    assert.equal(recorded.length, 2 + 40, "each call recorded as it returns");
    // $0.01 per batch, $0.0096 per answer at Muse Wonder's prices.
    assert.equal(ds.costUsd, 0.404);
    const answers = items.slice(2) as Array<{ model?: string; costUsd: number }>;
    assert.ok(answers.every((u) => u.model === "muse-wonder-1.0" && u.costUsd === 0.0096), "priced as Muse Wonder");
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
    assert.equal(ds.error, "Muse Wonder wrote only 1 different prompts, and a dataset needs 16.");
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
    assert.deepEqual(
      called("flushAnswers").map((c) => c.args[0]),
      [8, 20, 32, 36, 36],
    );
    // The timed-out call has no usage; the other three were billed.
    const answerUsage = called("recordUsage").flatMap((c) => c.args[1] as Array<{ inputTokens: number }>).filter((u) => u.inputTokens === 400);
    assert.equal(answerUsage.length, 39);
  });

  /** The chunk of 12 a default prompt "error <batch>-<i>" falls in. */
  const chunkOf = (prompt: string) => {
    const [batch, i] = /error (\d+)-(\d+)/.exec(prompt)!.slice(1).map(Number) as [number, number];
    return Math.floor((batch * 25 + i) / 12);
  };

  it("leaves out up to 2 chunks Meta never answered, and stops at the third with what it has", async () => {
    reset({ requested: 100 });
    answer = (prompt) => ([1, 3].includes(chunkOf(prompt)) ? new Error("Meta is down") : { output_text: `Fix for ${prompt}`, status: "completed" });
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "ready" });
    assert.equal(ds.train.length + ds.eval.length, 100 - 24);
    assert.equal(ds.error, null);

    // Chunks 0, 2 and 4 never answer: the third one stops the answers, and the 24 answered so far are kept.
    reset({ requested: 100 });
    answer = (prompt) => (chunkOf(prompt) % 2 === 0 ? new Error("Meta is down") : { output_text: "ok", status: "completed" });
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "ready" });
    assert.equal(ds.train.length + ds.eval.length, 24);
    assert.equal(
      ds.error,
      "Stopped early, once 24 of the 100 examples asked for were answered. Muse Wonder answered none of the prompts in 3 chunks, so the dataset stopped.",
    );
    assert.equal(called("responses.create").filter((c) => chunkOf((c.args[0] as { input: string }).input) > 4).length, 0, "nothing asked after it stopped");

    // With fewer than 16 answered by then, it fails.
    reset({ requested: 100 });
    answer = (prompt) => (chunkOf(prompt) === 1 ? { output_text: "ok", status: "completed" } : new Error("Meta is down"));
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "failed" });
    assert.equal(ds.error, "Muse Wonder answered none of the prompts in 3 chunks, so the dataset stopped.");
  });

  it("keeps what it paid for when the spend cap is reached partway through the answers", async () => {
    reset({ requested: 100 });
    let asked = 0;
    answer = (prompt) => {
      if (++asked === 30) paused = true;
      return { output_text: `Fix for ${prompt}`, status: "completed" };
    };
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "ready" });
    // The chunk that crossed the cap finishes; the next one doesn't start.
    assert.equal(called("responses.create").length, 36);
    assert.equal(ds.train.length + ds.eval.length, 36);
    assert.equal(ds.eval.length, 8);
    assert.equal(
      ds.error,
      "Stopped early, once 36 of the 100 examples asked for were answered. The platform's daily spend cap is reached, so the dataset stopped.",
    );
    assert.equal(ds.costUsd, Math.round((4 * 0.01 + 36 * 0.0096) * 1e6) / 1e6, "every call it made is on the dataset");

    // Too few by then: it fails, and says why.
    reset({ requested: 100 });
    asked = 0;
    answer = (prompt) => {
      if (++asked === 6) paused = true;
      return { output_text: `Fix for ${prompt}`, status: "completed" };
    };
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "failed" });
    assert.equal(ds.error, "The platform's daily spend cap is reached, so the dataset stopped.");
  });

  it("keeps what it paid for when the database stays down late, and fails only with too few", async () => {
    reset({ requested: 60 });
    let asked = 0;
    answer = (prompt) => {
      // Past the third chunk every save fails, beyond the step's own tries.
      if (++asked === 37) failing = { stageAnswer: 1_000 };
      return { output_text: `Fix for ${prompt}`, status: "completed" };
    };
    const status = await mod.makeDataset({ datasetId: DATASET_ID });
    assert.deepEqual(status, { status: "ready" });
    assert.equal(ds.train.length + ds.eval.length, 36);
    assert.match(ds.error!, /^Stopped early, once 36 of the 60 examples asked for were answered\. The database did not answer: stageAnswer: fetch failed\.$/);
  });

  it("goes on with the prompts it has when a late prompt batch fails, but not past the spend cap", async () => {
    reset({ requested: 60 });
    writePrompts = (want, batch) => {
      if (batch === 2) throw new Error("Meta is down");
      return Array.from({ length: want }, (_, i) => promptAt(batch, i));
    };
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "ready" });
    assert.equal(ds.train.length + ds.eval.length, 50, "the two batches written");

    reset({ requested: 60 });
    writePrompts = (want, batch) => {
      if (batch === 0) throw new Error("Meta is down");
      return [];
    };
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "failed" }, "nothing to go on with");
    assert.equal(ds.error, "Meta is down");

    reset({ requested: 60 });
    writePrompts = (want, batch) => {
      paused = true;
      return Array.from({ length: want }, (_, i) => promptAt(batch, i));
    };
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "failed" });
    assert.equal(ds.error, "The platform's daily spend cap is reached, so the dataset stopped.");
    assert.equal(called("responses.create").length, 0);
  });

  it("keeps the near-duplicates of an eval prompt out of train", async () => {
    // Batch 0's second prompt (position 1, an eval pick) and batch 1's fourth (position 28) ask the same thing.
    writePrompts = (want, batch) =>
      Array.from({ length: want }, (_, i) =>
        batch === 0 && i === 1 ? "How do I reset my password?" : batch === 1 && i === 3 ? "how can i reset my password" : promptAt(batch, i),
      );
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "ready" });
    assert.equal(allPrompts().length, 40);
    const evalWords = ds.eval.map((e) => promptWords(e.prompt));
    for (const e of ds.train) {
      const words = promptWords(e.messages[1]!.content);
      assert.equal(evalWords.some((w) => isNearDuplicate(w, words)), false, e.messages[1]!.content);
    }
  });

  it("hands the prompts a step had no time to start to the next one", async () => {
    mod.ANSWER_STEP_TIMING.startByMs = 0;
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "ready" });
    // Each step starts only its first round of 6.
    assert.deepEqual(
      called("flushAnswers").map((c) => c.args[0]),
      [6, 12, 18, 24, 30, 36, 40, 40],
    );
    assert.equal(called("responses.create").length, 40);
    assert.equal(new Set(allPrompts()).size, 40);
  });

  it("stops the dataset once the platform's daily spend cap is reached", async () => {
    paused = true;
    assert.deepEqual(await mod.makeDataset({ datasetId: DATASET_ID }), { status: "failed" });
    assert.equal(ds.error, "The platform's daily spend cap is reached, so the dataset stopped.");
    assert.equal(called("respondStructured").length + called("responses.create").length, 0);
  });

  it("charges a writer reply that never matched the schema, then fails", async () => {
    writerThrows = new FakeStructuredOutputError("training_prompts: no valid reply after a retry.", [
      { model: "muse-wonder-1.0", inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, costUsd: 0.002 },
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
      assert.deepEqual(await mod.answerChunkStep({ datasetId: DATASET_ID, system, offset: 0, prompts }), { saved: 3, done: 3 });
      calls = [];
      assert.deepEqual(await mod.answerChunkStep({ datasetId: DATASET_ID, system, offset: 0, prompts }), { saved: 3, done: 3 });
      assert.equal(called("responses.create").length + called("recordUsage").length, 0);
      assert.equal(ds.train.length, 3);
    });

    it("asks a retried step only the prompts no earlier attempt saved", async () => {
      answer = (prompt) => (prompt === "c?" ? new Error("Meta timed out") : { output_text: `Fix for ${prompt}`, status: "completed" });
      // The move onto the dataset fails past the step's own tries, so the runtime retries the step.
      failing = { flushAnswers: 5 };
      await assert.rejects(mod.answerChunkStep({ datasetId: DATASET_ID, system, offset: 0, prompts }), FakeRetryableError);
      assert.deepEqual(ds.eval.map((e) => e.prompt), ["a?", "b?"], "the two answers are saved");
      assert.equal(ds.train.length, 0);

      calls = [];
      answer = (prompt) => ({ output_text: `Fix for ${prompt}`, status: "completed" });
      assert.deepEqual(await mod.answerChunkStep({ datasetId: DATASET_ID, system, offset: 0, prompts }), { saved: 3, done: 3 });
      assert.deepEqual(called("responses.create").map((c) => (c.args[0] as { input: string }).input), ["c?"], "only the one never answered");
      assert.equal(called("recordUsage").length, 1);
      assert.deepEqual(ds.train.map((e) => e.messages[1]!.content), ["a?", "b?", "c?"]);
    });

    it("tries a failed save again inside the step instead of asking and paying again", async () => {
      failing = { recordUsage: 2, addDatasetCost: 1, stageAnswer: 3 };
      assert.deepEqual(await mod.answerChunkStep({ datasetId: DATASET_ID, system, offset: 0, prompts }), { saved: 3, done: 3 });
      assert.equal(called("responses.create").length, 3);
      assert.equal(called("recordUsage").length, 3, "each call recorded once");
      assert.equal(ds.costUsd, 0.0288);
      assert.equal(ds.train.length, 3);
    });

    it("retries a chunk Meta never answered, but not one it billed and every answer was unusable", async () => {
      answer = () => new Error("Meta is down");
      await assert.rejects(mod.answerChunkStep({ datasetId: DATASET_ID, system, offset: 0, prompts }), FakeRetryableError);
      calls = [];
      answer = () => ({ output_text: "Half an answ", status: "incomplete" });
      await assert.rejects(mod.answerChunkStep({ datasetId: DATASET_ID, system, offset: 0, prompts }), (err: Error) => {
        assert.ok(err instanceof FakeFatalError, "asked again, it would most likely pay for the same");
        assert.equal(err.message, "Muse Wonder answered none of this chunk's prompts.");
        return true;
      });
      assert.equal(called("responses.create").length, 3);
      assert.equal(called("recordUsage").length, 3, "the unusable answers are still paid for and recorded");
      ds.status = "failed";
      await assert.rejects(mod.answerChunkStep({ datasetId: DATASET_ID, system, offset: 0, prompts }), FakeFatalError);
    });

    it("starts no new prompt past its time and says how far it got", async () => {
      mod.ANSWER_STEP_TIMING.startByMs = 0;
      const twelve = Array.from({ length: 12 }, (_, i) => `p${i}?`);
      assert.deepEqual(await mod.answerChunkStep({ datasetId: DATASET_ID, system, offset: 0, prompts: twelve }), { saved: 6, done: 6 });
      assert.deepEqual(
        called("responses.create").map((c) => (c.args[0] as { input: string }).input),
        twelve.slice(0, 6),
      );
    });
  });
});
