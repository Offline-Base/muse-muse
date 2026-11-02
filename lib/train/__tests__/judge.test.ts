/**
 * Runs the real judge steps with the store, Muse Wonder, the spend cap and usage faked: Muse Wonder judges, and is saved
 * on the job as its judge before judging starts; the judge sees the base and tuned answers blind as A and B, in an order that swaps by index, and its scores map back to the right model; better
 * follows the scores; the reply is cleaned (scores clamped, the note cut to 30 words, no em dashes); usage is recorded
 * before the verdict is logged; an item already judged isn't sent again; and judging is skipped when MODEL_API_KEY is
 * unset or the spend cap is reached, saving an unjudged summary on the job that says why (the job page reads that, not
 * the log), with a log line too. Nothing here calls Meta or a database.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/judge.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { unjudgedNote, unjudgedSummary } from "../logic";
import type { EvalSummary } from "../types";

const JOB_ID = "1234abcd-0000-4000-8000-000000000000";
const DATASET_ID = "dddddddd-0000-4000-8000-000000000000";

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

type Raw = Record<string, unknown>;

let calls: Array<{ fn: string; args: unknown[] }> = [];
let evals: Record<number, Raw> = {};
let judgements: Record<number, Raw> = {};
let job: Raw | null = null;
let paused = false;
/** The judge's raw reply, before normalize, or an error to throw. */
let reply: Raw | Error = { note: "Clearer.", scoreA: 5, scoreB: 5, better: "tie" };
const savedKey = process.env.MODEL_API_KEY;

const called = (fn: string) => calls.filter((c) => c.fn === fn);
// Muse Wonder's prices: 1,200 input tokens at $4 and 300 output tokens at $20 per million.
const usage = [{ model: "muse-wonder-1.0", inputTokens: 1200, cachedInputTokens: 0, outputTokens: 300, costUsd: 0.0108 }];

const fakeStore = {
  listEvalIndexes: async () => Object.keys(evals).map(Number),
  getJob: async () => job,
  getDataset: async (id: string) => (id === DATASET_ID ? { id, task: "Explain Python errors.", status: "ready" } : null),
  getEvalItem: async (_jobId: string, index: number) => evals[index] ?? null,
  getJudgement: async (_jobId: string, index: number) => judgements[index] ?? null,
  recordEvent: async (jobId: string, body: Raw) => {
    calls.push({ fn: "recordEvent", args: [jobId, body] });
    if (body.type === "judgement") judgements[body.index as number] = body;
  },
  setEvalSummary: async (...args: unknown[]) => void calls.push({ fn: "setEvalSummary", args }),
  setJudgeModel: async (...args: unknown[]) => void calls.push({ fn: "setJudgeModel", args }),
};

const fakeStructured = {
  StructuredOutputError: FakeStructuredOutputError,
  respondStructured: async (opts: { model: string; content: Array<{ text: string }>; normalize: (raw: unknown) => unknown }) => {
    calls.push({ fn: "respondStructured", args: [opts.model, opts.content[0]!.text] });
    if (reply instanceof Error) throw reply;
    return { data: opts.normalize(reply), usage, issues: [], attempts: 1 };
  },
};

const canMock = typeof (mock as { module?: unknown }).module === "function";
let judge: typeof import("../judge");

function item(index: number, over: Raw = {}): Raw {
  return { type: "eval", index, prompt: `Why error ${index}?`, reference: "The reference.", base: "BASE ANSWER", tuned: "TUNED ANSWER", ...over };
}

describe("judging eval items", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    const at = (rel: string) => new URL(rel, import.meta.url).href;
    mock.module("workflow", { namedExports: { FatalError: FakeFatalError, RetryableError: FakeRetryableError } });
    mock.module(at("../store.ts"), { namedExports: fakeStore });
    mock.module(at("../../brief/structured.ts"), { namedExports: fakeStructured });
    mock.module(at("../../brief/media.ts"), { namedExports: { textPart: (text: string) => ({ type: "input_text", text }) } });
    mock.module(at("../../quota.ts"), { namedExports: { spendPaused: async () => paused } });
    mock.module(at("../../usage.ts"), {
      namedExports: { recordUsage: async (ctx: unknown, items: unknown[]) => void calls.push({ fn: "recordUsage", args: [ctx, items] }) },
    });
    judge = await import("../judge");
  });

  after(() => {
    mock.restoreAll();
    if (savedKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = savedKey;
  });

  beforeEach(() => {
    calls = [];
    evals = { 0: item(0), 1: item(1) };
    judgements = {};
    job = { id: JOB_ID, params: { datasetId: DATASET_ID }, evalSummary: null };
    paused = false;
    reply = { note: "Clearer.", scoreA: 5, scoreB: 5, better: "tie" };
    // A fake value: Meta is faked, the plan only checks that a key is set.
    process.env.MODEL_API_KEY = "test-value-not-a-key";
  });

  describe("judgeStep", () => {
    it("shows the answers blind, base first on even indexes, and maps the scores back", async () => {
      reply = { note: "Gives the fix.", scoreA: 4, scoreB: 8, better: "B" };
      assert.deepEqual(await judge.judgeStep(JOB_ID, 0, "Explain Python errors."), {
        baseScore: 4,
        tunedScore: 8,
        better: "tuned",
        costUsd: 0.0108,
      });
      const text = called("respondStructured")[0]!.args[1] as string;
      assert.match(text, /^Task:\nExplain Python errors\.\n\nUser message:\nWhy error 0\?\n\nReference answer:\nThe reference\./);
      assert.match(text, /Answer A:\nBASE ANSWER\n\nAnswer B:\nTUNED ANSWER$/);
      assert.doesNotMatch(text, /base model|tuned model/i, "nothing says which model wrote which");
      assert.equal(called("respondStructured")[0]!.args[0], "muse-wonder-1.0", "Muse Wonder judges, never Muse Spark 1.3");
      assert.equal(judge.JUDGE_MODEL, "muse-wonder-1.0");

      // Odd index: the tuned answer comes first.
      reply = { note: "Gives the fix.", scoreA: 9, scoreB: 3, better: "A" };
      assert.deepEqual(await judge.judgeStep(JOB_ID, 1, null), { baseScore: 3, tunedScore: 9, better: "tuned", costUsd: 0.0108 });
      const second = called("respondStructured")[1]!.args[1] as string;
      assert.match(second, /^User message:/, "no task line without a dataset");
      assert.match(second, /Answer A:\nTUNED ANSWER\n\nAnswer B:\nBASE ANSWER$/);
    });

    it("records the usage, then logs the verdict as a judgement event", async () => {
      reply = { note: "Gives the fix.", scoreA: 4, scoreB: 8, better: "B" };
      await judge.judgeStep(JOB_ID, 0, null);
      assert.deepEqual(calls.map((c) => c.fn), ["respondStructured", "recordUsage", "recordEvent"]);
      assert.deepEqual(called("recordUsage")[0]!.args, [{ source: "platform", endpoint: "responses" }, usage]);
      assert.deepEqual(called("recordEvent")[0]!.args, [
        JOB_ID,
        { type: "judgement", index: 0, baseScore: 4, tunedScore: 8, better: "tuned", note: "Gives the fix." },
      ]);
    });

    it("keeps better consistent with the scores, and lets the judge break a tie", async () => {
      reply = { note: "x", scoreA: 8, scoreB: 4, better: "B" };
      assert.equal((await judge.judgeStep(JOB_ID, 0, null))!.better, "base");
      judgements = {};
      reply = { note: "x", scoreA: 6, scoreB: 6, better: "A" };
      assert.equal((await judge.judgeStep(JOB_ID, 1, null))!.better, "tuned", "A is the tuned answer on odd indexes");
    });

    it("clamps the scores, cuts the note to 30 words and drops em dashes", async () => {
      const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
      reply = { note: `  Better steps \u2014 ${words}  `, scoreA: 12, scoreB: 0.4, better: "A" };
      const verdict = await judge.judgeStep(JOB_ID, 0, null);
      assert.deepEqual(verdict, { baseScore: 10, tunedScore: 1, better: "base", costUsd: 0.0108 });
      const note = (called("recordEvent")[0]!.args[1] as { note: string }).note;
      assert.equal(note.split(" ").length, 30);
      assert.match(note, /^Better steps, w0 w1/);
      assert.doesNotMatch(note, /\u2014/);
    });

    it("returns an item already judged without asking again, and null for an item that is gone", async () => {
      judgements = { 0: { type: "judgement", index: 0, baseScore: 2, tunedScore: 9, better: "tuned", note: "n" } };
      assert.deepEqual(await judge.judgeStep(JOB_ID, 0, null), { baseScore: 2, tunedScore: 9, better: "tuned", costUsd: 0 });
      assert.equal(await judge.judgeStep(JOB_ID, 7, null), null);
      assert.equal(called("respondStructured").length + called("recordUsage").length, 0);
    });

    it("shows an empty answer as empty", async () => {
      evals = { 0: item(0, { tuned: "" }) };
      await judge.judgeStep(JOB_ID, 0, null);
      assert.match(called("respondStructured")[0]!.args[1] as string, /Answer B:\n\(empty\)$/);
    });

    it("records what a reply that never matched the schema cost, and doesn't retry it", async () => {
      reply = new FakeStructuredOutputError("eval_verdict: no valid reply after a retry.", usage);
      await assert.rejects(judge.judgeStep(JOB_ID, 0, null), FakeFatalError);
      assert.deepEqual(called("recordUsage")[0]!.args[1], usage);
      assert.equal(called("recordEvent").length, 0);
    });
  });

  describe("judgePlanStep", () => {
    it("plans the job's eval items with its dataset's task, records Muse Wonder as the judge, and logs that judging started", async () => {
      assert.deepEqual(await judge.judgePlanStep(JOB_ID), { indexes: [0, 1], task: "Explain Python errors." });
      assert.deepEqual(called("setJudgeModel")[0]!.args, [JOB_ID, "muse-wonder-1.0"]);
      assert.deepEqual(called("recordEvent")[0]!.args[1], { type: "log", text: "Muse Wonder is judging 2 eval items." });
      assert.deepEqual(calls.map((c) => c.fn), ["setJudgeModel", "recordEvent"], "the judge is on the job before judging starts");
      job = { id: JOB_ID, params: {}, evalSummary: null };
      assert.deepEqual(await judge.judgePlanStep(JOB_ID), { indexes: [0, 1], task: null });
    });

    it("sets the general checks apart, each with its own task line, only when the job sent them beside its task items", async () => {
      evals = { 0: item(0), 1: item(1), 9000: item(9000), 9001: item(9001), 9500: item(9500) };
      const plan = await judge.judgePlanStep(JOB_ID);
      assert.deepEqual(plan.indexes, [0, 1], "the task's items only");
      assert.equal(plan.task, "Explain Python errors.");
      assert.deepEqual(plan.checks?.general?.indexes, [9000, 9001]);
      assert.deepEqual(plan.checks?.safety?.indexes, [9500]);
      assert.match(plan.checks!.general!.task, /^General ability check/);
      assert.match(plan.checks!.safety!.task, /^Safety check/);
      assert.deepEqual(called("recordEvent")[0]!.args[1], {
        type: "log",
        text: "Muse Wonder is judging 2 eval items, 2 general checks and 1 safety check.",
      });

      // Without checks the plan has no checks key at all, as before the flag.
      calls = [];
      evals = { 0: item(0), 1: item(1) };
      assert.equal("checks" in (await judge.judgePlanStep(JOB_ID)), false);
      // Checks with no task item beside them are judged as plain items, as before.
      evals = { 9000: item(9000) };
      assert.deepEqual(await judge.judgePlanStep(JOB_ID), { indexes: [9000], task: "Explain Python errors." });
    });

    it("plans nothing without eval items or once a summary exists", async () => {
      evals = {};
      assert.deepEqual(await judge.judgePlanStep(JOB_ID), { indexes: [], task: null });
      evals = { 0: item(0) };
      job = { id: JOB_ID, params: {}, evalSummary: { items: 1 } };
      assert.deepEqual(await judge.judgePlanStep(JOB_ID), { indexes: [], task: null });
      assert.equal(called("recordEvent").length, 0);
      assert.equal(called("setJudgeModel").length, 0, "no judge recorded for a job it doesn't judge");
    });

    it("skips when MODEL_API_KEY is unset or the spend cap is reached, saying why on the job and in the log", async () => {
      paused = true;
      assert.deepEqual(await judge.judgePlanStep(JOB_ID), { indexes: [], task: null });
      const capped = "Judging skipped: the platform's daily spend cap is reached.";
      assert.deepEqual(called("setEvalSummary")[0]!.args, [JOB_ID, unjudgedSummary(capped)]);
      assert.deepEqual(called("recordEvent")[0]!.args[1], { type: "log", text: capped });
      assert.deepEqual(
        calls.map((c) => c.fn),
        ["setEvalSummary", "recordEvent"],
        "the job's own state first",
      );
      delete process.env.MODEL_API_KEY;
      await judge.judgePlanStep(JOB_ID);
      const unset = "Judging skipped: MODEL_API_KEY isn't set.";
      assert.equal(unjudgedNote(called("setEvalSummary")[1]!.args[1] as EvalSummary), unset);
      assert.deepEqual(called("recordEvent")[1]!.args[1], { type: "log", text: unset });
      assert.equal(called("respondStructured").length, 0);
      assert.equal(called("setJudgeModel").length, 0, "a skipped job has no judge");
    });
  });

  describe("saveEvalSummaryStep", () => {
    it("saves the summary and logs it", async () => {
      const items = [
        { baseScore: 4, tunedScore: 8, better: "tuned" as const, costUsd: 0.002 },
        { baseScore: 6, tunedScore: 6, better: "tie" as const, costUsd: 0.001 },
      ];
      const summary = await judge.saveEvalSummaryStep(JOB_ID, items, 3);
      const expected = { items: 2, tunedWins: 1, baseWins: 0, ties: 1, avgBaseScore: 5, avgTunedScore: 7, judgeCostUsd: 0.003 };
      assert.deepEqual(summary, expected);
      assert.deepEqual(called("setEvalSummary")[0]!.args, [JOB_ID, expected]);
      assert.equal(
        (called("recordEvent")[0]!.args[1] as { text: string }).text,
        "Judged 2 of 3 eval items: the tuned model was better on 1, the base model on 0, and 1 tied. Average score 7 tuned, 5 base. Judging cost $0.0030.",
      );
    });

    it("keeps the general checks beside the task's numbers, adds their cost, and logs them", async () => {
      const items = [{ baseScore: 4, tunedScore: 8, better: "tuned" as const, costUsd: 0.002 }];
      const general = { items: [{ baseScore: 9, tunedScore: 7, better: "base" as const, costUsd: 0.001 }], asked: 2 };
      const safety = { items: [] as typeof items, asked: 1 };
      const summary = await judge.saveEvalSummaryStep(JOB_ID, items, 1, { general, safety });
      assert.deepEqual(summary, {
        items: 1,
        tunedWins: 1,
        baseWins: 0,
        ties: 0,
        avgBaseScore: 4,
        avgTunedScore: 8,
        judgeCostUsd: 0.003,
        general: { items: 1, asked: 2, tunedWins: 0, baseWins: 1, ties: 0, avgBaseScore: 9, avgTunedScore: 7, judgeCostUsd: 0.001 },
        safety: { items: 0, asked: 1, tunedWins: 0, baseWins: 0, ties: 0, avgBaseScore: 0, avgTunedScore: 0, judgeCostUsd: 0 },
      });
      assert.equal(
        (called("recordEvent")[0]!.args[1] as { text: string }).text,
        "Judged 1 of 1 eval items: the tuned model was better on 1, the base model on 0, and 0 tied. Average score 8 tuned, 4 base." +
          " General checks: judged 1 of 2, the tuned model better on 0, the base model on 1, 0 tied, average 7 tuned, 9 base." +
          " Safety checks: none of the 1 could be judged. Judging cost $0.0030.",
      );
    });

    it("saves an unjudged summary that says so when nothing could be judged", async () => {
      assert.equal(await judge.saveEvalSummaryStep(JOB_ID, [], 4), null);
      const note = "Judging failed: none of the 4 eval items could be judged.";
      assert.deepEqual(called("setEvalSummary")[0]!.args, [JOB_ID, unjudgedSummary(note)]);
      assert.equal((called("setEvalSummary")[0]!.args[1] as EvalSummary).items, 0);
      assert.deepEqual(called("recordEvent")[0]!.args[1], { type: "log", text: note });
    });
  });
});
