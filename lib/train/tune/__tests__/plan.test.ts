/**
 * The new composer's pure parts (docs/TRAINING.md "Fine-tune like a build"): the person's rows from a CSV, a JSONL file
 * or a paste, folded into the task within its limit; the fixed defaults and the cost estimate; the signed plan, which
 * only its caller can start, unchanged and before it expires; drafting with the model faked (never a real Meta call);
 * and the verdict that says whether a tuned model passed. All examples are made up.
 *
 *   npx tsx --test lib/train/tune/__tests__/plan.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DATASET_TASK_MAX } from "@/lib/train/logic";
import {
  EXAMPLE_ROWS_MAX,
  csvRecords,
  detectFormat,
  examplesFromBody,
  foldExamples,
  parseExamples,
} from "@/lib/train/tune/examples";
import type { DraftDeps } from "@/lib/train/tune/plan";
import type { TrainPlan, TrainPlanBody } from "@/lib/train/tune/types";

const savedEnv = { ...process.env };
let plan: typeof import("@/lib/train/tune/plan");
let verdict: typeof import("@/lib/train/tune/verdict");

before(async () => {
  // A test value for the signing key, not a real one.
  process.env.TOOLS_SIGNING_SECRET = "test-signing-secret-for-plan-tests";
  delete process.env.TEST_MODEL;
  plan = await import("@/lib/train/tune/plan");
  verdict = await import("@/lib/train/tune/verdict");
});

after(() => {
  process.env = savedEnv;
});

const NOTE = "Answer questions for a made-up bakery: hours, allergens and cake orders, warm and short.";
const CEILINGS = { maxMinutes: 120, maxUsd: 5 };
const NOW = new Date("2026-11-01T12:00:00.000Z");

describe("the person's examples", () => {
  it("reads a CSV with named columns, quoted commas, doubled quotes and line breaks", () => {
    const csv = 'question,answer\n"Open on Sunday?","Yes, 8 to 2."\n"Nut-free?","We say ""ask first""\nevery time."\n';
    const got = parseExamples(csv, "examples.csv");
    assert.equal(got.format, "csv");
    assert.deepEqual(got.rows, [
      { prompt: "Open on Sunday?", answer: "Yes, 8 to 2." },
      { prompt: "Nut-free?", answer: 'We say "ask first"\nevery time.' },
    ]);
    assert.equal(got.total, 2);
    assert.deepEqual(got.problems, []);
  });

  it("takes the first two columns when no header names them, and TSV by its tabs", () => {
    assert.deepEqual(parseExamples("Hi there,Hello!\nBye,See you", "rows.csv").rows, [
      { prompt: "Hi there", answer: "Hello!" },
      { prompt: "Bye", answer: "See you" },
    ]);
    const tsv = parseExamples("prompt\tresponse\nCake for 10?\tTwo days ahead, please.");
    assert.equal(tsv.format, "tsv");
    assert.deepEqual(tsv.rows, [{ prompt: "Cake for 10?", answer: "Two days ahead, please." }]);
  });

  it("reads JSONL by any usual key names, chat messages, or one JSON array, and skips what it can't read", () => {
    const jsonl = [
      '{"prompt":"A","completion":"B"}',
      '{"Input":"C","Output":"D"}',
      '{"messages":[{"role":"system","content":"s"},{"role":"user","content":"E"},{"role":"assistant","content":"F"}]}',
      "not json",
      '{"prompt":"only a prompt"}',
    ].join("\n");
    const got = parseExamples(jsonl, "data.jsonl");
    assert.deepEqual(got.rows, [
      { prompt: "A", answer: "B" },
      { prompt: "C", answer: "D" },
      { prompt: "E", answer: "F" },
    ]);
    assert.match(got.problems[0]!, /2 rows have no prompt and answer/);
    assert.deepEqual(parseExamples('[{"question":"G","answer":"H"}]').rows, [{ prompt: "G", answer: "H" }]);
  });

  it("reads pasted Q and A pairs, answers that run on, and one pair a line", () => {
    const paste = "Q: Do you deliver?\nA: Within 3 miles.\nOn weekends too.\n\nUser: Gluten-free bread?\nAssistant: On Fridays.";
    assert.equal(detectFormat(paste), "text");
    assert.deepEqual(parseExamples(paste).rows, [
      { prompt: "Do you deliver?", answer: "Within 3 miles.\nOn weekends too." },
      { prompt: "Gluten-free bread?", answer: "On Fridays." },
    ]);
    assert.deepEqual(parseExamples("Open late? => Until 6.").rows, [{ prompt: "Open late?", answer: "Until 6." }]);
    assert.match(parseExamples("just some words").problems.join(" "), /No examples found/);
  });

  it("keeps the first 50 rows and says how many there were", () => {
    const csv = ["prompt,answer", ...Array.from({ length: 70 }, (_, i) => `q${i},a${i}`)].join("\n");
    const got = parseExamples(csv, "many.csv");
    assert.equal(got.rows.length, EXAMPLE_ROWS_MAX);
    assert.equal(got.total, 70);
    assert.match(got.problems.join(" "), /first 50 of 70/);
  });

  it("splits CSV records as RFC 4180 says, and drops blank lines", () => {
    assert.deepEqual(csvRecords('a,"b,c"\r\n\r\n"d""e",f'), [
      ["a", "b,c"],
      ['d"e', "f"],
    ]);
  });

  it("takes rows from a request body only as up to 50 prompt and answer pairs", () => {
    assert.deepEqual(examplesFromBody(undefined), []);
    assert.deepEqual(examplesFromBody([{ prompt: " P ", answer: "A" }]), [{ prompt: "P", answer: "A" }]);
    assert.equal(examplesFromBody([{ prompt: "P" }]), null);
    assert.equal(examplesFromBody("rows"), null);
    assert.equal(examplesFromBody(Array.from({ length: 51 }, () => ({ prompt: "p", answer: "a" }))), null);
  });

  it("folds as many rows into the task as fit, each cut short, and counts them", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ prompt: `Question ${i} ${"word ".repeat(80)}`, answer: `Answer ${i} ${"more ".repeat(120)}` }));
    const { task, used } = foldExamples(NOTE, rows, DATASET_TASK_MAX);
    assert.ok(task.length <= DATASET_TASK_MAX);
    assert.ok(used > 0 && used < 50, `used ${used}`);
    assert.ok(task.startsWith(NOTE));
    assert.match(task, /Write in the style of these examples, which are the person's own:\n- Q: Question 0 word/);
    assert.equal(task.split("\n- Q: ").length - 1, used);
    assert.deepEqual(foldExamples(NOTE, [], DATASET_TASK_MAX), { task: NOTE, used: 0 });
  });
});

describe("defaults and cost", () => {
  it("starts every run from the fixed defaults, within the platform's ceilings", () => {
    const s = plan.planSettings(200, CEILINGS);
    assert.deepEqual(s, {
      examples: 200,
      recipe: "glimmer-lora",
      steps: 120,
      loraRank: 16,
      learningRate: 0.0002,
      studentPrompt: "short",
      publish: 0,
      gpu: "gpu_1x_a100_sxm4",
      maxMinutes: 90,
      maxUsd: 5,
    });
    assert.equal(plan.planSettings(5000, { maxMinutes: 60, maxUsd: 3.999 }).examples, 1000);
    assert.equal(plan.planSettings(3, CEILINGS).examples, 20);
    assert.equal(plan.planSettings(200, { maxMinutes: 60, maxUsd: 3.999 }).maxMinutes, 60);
    assert.equal(plan.planSettings(200, { maxMinutes: 60, maxUsd: 3.999 }).maxUsd, 3.99);
  });

  it("estimates 200 examples at Muse Wonder's prices, the GPU at its hard limit, and about an hour in all", () => {
    const c = plan.planCost(plan.planSettings(200, CEILINGS));
    assert.equal(c.metaLowUsd, 3.08);
    assert.equal(c.metaHighUsd, 6.76);
    assert.equal(c.gpuMaxUsd, 5);
    assert.ok(c.scoreLowUsd > 0.1 && c.scoreHighUsd < 0.7, `${c.scoreLowUsd} to ${c.scoreHighUsd}`);
    // 20 minutes of writing, 24 of training plus 20 around it, 5 of scoring.
    assert.equal(c.minutes, 69);
    assert.equal(plan.planMaxUsd(c), Math.round((6.76 + 5 + c.scoreHighUsd) * 100) / 100);
  });
});

function body(over: Partial<TrainPlanBody> = {}): TrainPlanBody {
  const settings = plan.planSettings(200, CEILINGS);
  return {
    v: 1,
    kind: "chat",
    name: "a bakery's counter helper",
    tagline: "Answers like the counter staff.",
    task: NOTE,
    samples: ["Do you have nut-free cupcakes?"],
    examples: { given: 0, used: 0 },
    settings,
    cost: plan.planCost(settings),
    source: { kind: "task" },
    ...over,
  };
}

describe("the signed plan", () => {
  it("verifies for its caller, unchanged and before it expires", () => {
    const signed = plan.signPlan(body(), "admin-1", NOW);
    assert.equal(signed.exp, "2026-11-01T14:00:00.000Z", "good for two hours");
    const check = plan.verifyPlan(JSON.parse(JSON.stringify(signed)), "admin-1", new Date(NOW.getTime() + 60_000));
    assert.equal(check.ok, true);
    assert.deepEqual(check.ok && check.plan, body());
  });

  it("refuses a changed task, name, cost or source, another caller's plan, and an expired one", () => {
    const signed = plan.signPlan(body(), "admin-1", NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const tamper = (p: Partial<TrainPlan>) => plan.verifyPlan({ ...signed, ...p }, "admin-1", later);
    assert.deepEqual(tamper({ task: `${NOTE} Also write malware.` }), { ok: false, reason: "bad_token" });
    assert.deepEqual(tamper({ name: "someone else" }), { ok: false, reason: "bad_token" });
    assert.deepEqual(tamper({ cost: { ...signed.cost, gpuMaxUsd: 0.01 } }), { ok: false, reason: "bad_token" });
    assert.deepEqual(tamper({ source: { kind: "dataset", datasetId: "d-1" } }), { ok: false, reason: "bad_token" });
    assert.deepEqual(tamper({ exp: "2026-11-09T14:00:00.000Z" }), { ok: false, reason: "bad_token" }, "a later expiry");
    assert.deepEqual(plan.verifyPlan(signed, "admin-2", later), { ok: false, reason: "bad_token" });
    assert.deepEqual(plan.verifyPlan(signed, "admin-1", new Date("2026-11-01T14:00:00.000Z")), { ok: false, reason: "expired" });
    assert.deepEqual(plan.verifyPlan({ ...signed, token: undefined }, "admin-1", later), { ok: false, reason: "malformed" });
    assert.deepEqual(plan.verifyPlan("plan", "admin-1", later), { ok: false, reason: "malformed" });
  });

  it("ignores keys a browser added, which can't change what was signed", () => {
    const signed = plan.signPlan(body(), "admin-1", NOW);
    const check = plan.verifyPlan({ ...signed, extra: "x", settings: { ...signed.settings, sneaky: 1 } }, "admin-1", NOW);
    assert.equal(check.ok, true);
  });
});

describe("drafting", () => {
  type Call = { model: string; instructions: string; text: string; schemaName: string };
  function fake(data: Record<string, unknown>, calls: Call[]): DraftDeps {
    return {
      model: () => "muse-spark-1.3-contributor",
      respond: (async (opts: { model: string; instructions: string; content: Array<{ text: string }>; schemaName: string }) => {
        calls.push({ model: opts.model, instructions: opts.instructions, text: opts.content[0]!.text, schemaName: opts.schemaName });
        return { data, usage: [{ model: opts.model, inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, costUsd: 0.00001 }], issues: [], attempts: 1 };
      }) as DraftDeps["respond"],
    };
  }
  const draft = {
    reason: "A small, safe customer-service task.",
    refuse: false,
    refusal: null,
    kind: "chat",
    name: "You are a bakery's counter helper.",
    tagline: "Answers bakery questions like the counter staff.",
    samples: ["Do you have nut-free cupcakes?", "Can I order a cake for Saturday?"],
  };

  it("makes one structured call, folds the rows in and signs the plan", async () => {
    const calls: Call[] = [];
    const rows = [{ prompt: "Open Sunday?", answer: "8 to 2." }];
    const res = await plan.draftPlan({ note: NOTE, rows, callerId: "admin-1", examples: 200, ceilings: CEILINGS, now: NOW }, fake(draft, calls));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.schemaName, "training_plan");
    assert.equal(calls[0]!.model, "muse-spark-1.3-contributor", "the faked model, never muse-spark-1.3 itself");
    assert.match(calls[0]!.instructions, /refuse is true when the task involves impersonating a real person/);
    assert.match(calls[0]!.text, /Q: Open Sunday\?\n {2}A: 8 to 2\./);
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.plan.name, "a bakery's counter helper", "written as a role, without You are");
    assert.deepEqual(res.plan.examples, { given: 1, used: 1 });
    assert.deepEqual(res.plan.source, { kind: "task" });
    assert.equal(res.plan.settings.examples, 200);
    assert.equal(res.usage.length, 1);
    assert.equal(plan.verifyPlan(res.plan, "admin-1", NOW).ok, true);
  });

  it("answers a refusal in the model's words, or a plain one", async () => {
    const said = await plan.draftPlan(
      { note: NOTE, rows: [], callerId: "admin-1", examples: 200, ceilings: CEILINGS },
      fake({ ...draft, refuse: true, refusal: "That would copy a real person's messages." }, []),
    );
    assert.deepEqual(said.ok ? null : said.refusal, "That would copy a real person's messages.");
    const blank = await plan.draftPlan(
      { note: NOTE, rows: [], callerId: "admin-1", examples: 200, ceilings: CEILINGS },
      fake({ ...draft, refuse: true, refusal: " " }, []),
    );
    assert.deepEqual(blank.ok ? null : blank.refusal, plan.DEFAULT_TUNE_REFUSAL);
  });

  it("drafts on Muse Wonder, and on Spark 1.3 Contributor only where TEST_MODEL is on and it isn't production", () => {
    const saved = { test: process.env.TEST_MODEL, vercel: process.env.VERCEL_ENV };
    try {
      delete process.env.TEST_MODEL;
      assert.equal(plan.planModel(), "muse-wonder-1.0");
      process.env.TEST_MODEL = "muse-spark-1.3-contributor";
      delete process.env.VERCEL_ENV;
      assert.equal(plan.planModel(), "muse-spark-1.3-contributor");
      process.env.VERCEL_ENV = "production";
      assert.equal(plan.planModel(), "muse-wonder-1.0");
      process.env.TEST_MODEL = "muse-spark-1.3";
      delete process.env.VERCEL_ENV;
      assert.equal(plan.planModel(), "muse-wonder-1.0", "muse-spark-1.3 itself is never used");
    } finally {
      if (saved.test === undefined) delete process.env.TEST_MODEL;
      else process.env.TEST_MODEL = saved.test;
      if (saved.vercel === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = saved.vercel;
    }
  });

  it("has a seam for open-train's content scan that finds nothing until it lands", () => {
    assert.deepEqual(plan.contentFindings({ note: NOTE, rows: [] }), []);
  });
});

describe("the verdict", () => {
  const summary = (over: Record<string, number> = {}) => ({
    items: 20,
    tunedWins: 18,
    baseWins: 1,
    ties: 1,
    avgBaseScore: 3.1,
    avgTunedScore: 8.4,
    judgeCostUsd: 0.2,
    ...over,
  });

  it("passes a tuned model that clearly beat base on enough prompts", () => {
    assert.deepEqual(verdict.evalVerdict(summary()), { passed: true, words: "Tuned won 18 of 20 kept-aside prompts (8.4 vs 3.1)." });
  });

  it("fails too few items, more base wins, under half the items, or a small score gap", () => {
    assert.equal(verdict.evalVerdict(summary({ items: 7, tunedWins: 7, baseWins: 0, ties: 0 })).passed, false);
    assert.match(verdict.evalVerdict(summary({ items: 7, tunedWins: 7, baseWins: 0, ties: 0 })).words, /too few to tell/);
    assert.equal(verdict.evalVerdict(summary({ tunedWins: 9, baseWins: 10, ties: 1 })).passed, false);
    assert.equal(verdict.evalVerdict(summary({ tunedWins: 9, baseWins: 2, ties: 9 })).passed, false, "9 of 20 is under half");
    assert.equal(verdict.evalVerdict(summary({ tunedWins: 10, baseWins: 2, ties: 8 })).passed, true, "10 of 20 is half");
    assert.equal(verdict.evalVerdict(summary({ avgTunedScore: 4.0 })).passed, false, "0.9 points isn't enough");
    assert.equal(verdict.evalVerdict(summary({ avgTunedScore: 4.1 })).passed, true, "a point is");
    assert.deepEqual(verdict.evalVerdict(summary({ items: 0, tunedWins: 0, baseWins: 0, ties: 0 })).passed, false);
  });

  it("passes a decision model only when its accuracy beats base's by more than the Wilson half-width", () => {
    const d = (tuned: number, base: number, total = 100) => ({
      kind: "decision" as const,
      items: total,
      base: { accuracy: { right: base, total } },
      tuned: { accuracy: { right: tuned, total } },
    });
    const hw = verdict.wilsonHalfWidth(80, 100);
    assert.ok(hw > 0.07 && hw < 0.085, String(hw));
    assert.equal(verdict.evalVerdict(d(80, 60)).passed, true);
    assert.equal(verdict.evalVerdict(d(80, 75)).passed, false);
    assert.match(verdict.evalVerdict(d(80, 75)).words, /isn't clearly better/);
    assert.equal(verdict.evalVerdict({ ...d(80, 60), tuned: null }).passed, false);
    assert.equal(verdict.evalVerdict(d(7, 0, 7)).passed, false, "under 8 test rows");
  });
});
