import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adapterProblem,
  betterOf,
  BOOT_GRACE_MS,
  calibrationBins,
  certFingerprint,
  capEventBody,
  clampLimits,
  datasetSystemPrompt,
  DECIDE_T_MAX,
  DECIDE_T_MIN,
  decideCheck,
  decisionLogLoss,
  dedupePrompts,
  EVAL_TEXT_MAX,
  evalHoldoutCount,
  evalIndexes,
  evalSplit,
  EVENT_LOG_MAX,
  estimateCostUsd,
  fitTemperature,
  GLIMMER_OVERHEAD_MINUTES,
  GLIMMER_OVERHEAD_NO_CACHE_MINUTES,
  instanceNameFor,
  isNearDuplicate,
  judgeScore,
  type JobState,
  labelScores,
  PARAM_TEXT_MAX,
  promptWords,
  recipeDefaults,
  runEstimate,
  runFitProblem,
  serveEndsAt,
  serveFitProblem,
  SERVE_STOP_MARGIN_SECONDS,
  serveMinutes,
  SILENCE_MS,
  summarizeDecisions,
  summarizeJudgements,
  toDatasetView,
  toJobView,
  toLiveDemoView,
  type TrainJobRow,
  unjudgedNote,
  unjudgedSummary,
  usableMinutes,
  validateParams,
  wilsonRate,
} from "@/lib/train/logic";
import { applyTemperature, decisionItems, labelId, seededRandom, temperedDecision } from "@/lib/decide/format";
import type { CalibrationRow, DecideScoreItem, DecisionLabel, DecisionRow, DecisionScoringInput } from "@/lib/decide/types";
import type { Recipe, RecipeId } from "@/lib/train/types";

const MIN = 60_000;
const T0 = new Date("2026-10-27T12:00:00.000Z");
const after = (ms: number) => new Date(T0.getTime() + ms);

const recipe: Recipe = {
  id: "glimmer-lora",
  title: "Glimmer LoRA",
  description: "Test recipe.",
  gpus: [{ instanceType: "gpu_1x_a100", label: "A100" }],
  defaultMaxMinutes: 90,
  defaultMaxUsd: 4,
  params: [
    { key: "dataset", label: "Dataset URL", kind: "url", required: true },
    { key: "epochs", label: "Epochs", kind: "number", default: 1, min: 1, max: 5 },
    { key: "rank", label: "LoRA rank", kind: "number", min: 4, max: 64 },
    { key: "note", label: "Note", kind: "text" },
    { key: "style", label: "Style", kind: "text", default: "plain" },
  ],
  script: "def run(ctx):\n    return {}\n",
};

/** A running job launched at T0 with a heartbeat at T0 + 1 min: $1.20/hour, 60 minutes, $5. */
function job(over: Partial<JobState> = {}): JobState {
  return {
    status: "running",
    stopRequested: false,
    error: null,
    priceCentsPerHour: 120,
    maxMinutes: 60,
    maxUsd: 5,
    launchedAt: T0,
    firstHeartbeatAt: after(MIN),
    lastHeartbeatAt: after(MIN),
    ...over,
  };
}

const active = { status: "active" as const };

describe("estimateCostUsd", () => {
  const priced = { priceCentsPerHour: 120, launchedAt: T0, terminatedAt: null };

  it("is zero before launch", () => {
    assert.equal(estimateCostUsd({ ...priced, launchedAt: null }, after(30 * MIN)), 0);
    assert.equal(estimateCostUsd(priced, T0), 0);
    assert.equal(estimateCostUsd(priced, after(-MIN)), 0);
  });

  it("counts every started minute in full", () => {
    assert.equal(estimateCostUsd(priced, after(1)), 0.02);
    assert.equal(estimateCostUsd(priced, after(MIN)), 0.02);
    assert.equal(estimateCostUsd(priced, after(MIN + 1)), 0.04);
    assert.equal(estimateCostUsd(priced, after(60 * MIN)), 1.2);
    assert.equal(estimateCostUsd(priced, after(60 * MIN + 1)), 1.22);
  });

  it("stops at terminatedAt", () => {
    assert.equal(estimateCostUsd({ ...priced, terminatedAt: after(30 * MIN) }, after(600 * MIN)), 0.6);
  });
});

describe("clampLimits", () => {
  const ceilings = { maxMinutes: 120, maxUsd: 5 };

  it("caps the ask at the ceiling, and takes the recipe default only when nothing is asked", () => {
    assert.deepEqual(clampLimits(recipe, { maxMinutes: 30, maxUsd: 2 }, ceilings), { maxMinutes: 30, maxUsd: 2 });
    assert.deepEqual(clampLimits(recipe, { maxMinutes: 500, maxUsd: 50 }, ceilings), { maxMinutes: 120, maxUsd: 5 });
    assert.deepEqual(clampLimits(recipe, { maxMinutes: 110, maxUsd: 4.5 }, ceilings), { maxMinutes: 110, maxUsd: 4.5 }, "past the recipe's 90 and $4");
    assert.deepEqual(clampLimits(recipe, {}, { maxMinutes: 45, maxUsd: 1.5 }), { maxMinutes: 45, maxUsd: 1.5 });
    assert.deepEqual(clampLimits(recipe, {}, ceilings), { maxMinutes: 90, maxUsd: 4 });
    assert.deepEqual(clampLimits(recipe, { maxMinutes: 60 }, ceilings), { maxMinutes: 60, maxUsd: 4 }, "each limit on its own");
  });

  it("lets a glimmer job use raised ceilings when the admin asks for them", () => {
    const glimmer = { defaultMaxMinutes: 150, defaultMaxUsd: 14 };
    const raised = { maxMinutes: 300, maxUsd: 40 };
    assert.deepEqual(clampLimits(glimmer, { maxMinutes: 300, maxUsd: 40 }, raised), raised);
    assert.deepEqual(clampLimits(glimmer, {}, raised), { maxMinutes: 150, maxUsd: 14 });
  });

  it("never goes under 1 minute or $0.10", () => {
    assert.deepEqual(clampLimits(recipe, { maxMinutes: 0, maxUsd: 0 }, ceilings), { maxMinutes: 1, maxUsd: 0.1 });
    assert.deepEqual(clampLimits(recipe, { maxMinutes: -5, maxUsd: -1 }, ceilings), { maxMinutes: 1, maxUsd: 0.1 });
    assert.deepEqual(clampLimits(recipe, {}, { maxMinutes: 0, maxUsd: 0.01 }), { maxMinutes: 1, maxUsd: 0.1 });
  });

  it("ignores asks that aren't numbers and rounds down to whole minutes and cents", () => {
    assert.deepEqual(clampLimits(recipe, { maxMinutes: NaN, maxUsd: Infinity }, ceilings), { maxMinutes: 90, maxUsd: 4 });
    assert.deepEqual(clampLimits(recipe, { maxMinutes: Infinity }, { maxMinutes: Infinity, maxUsd: 5 }).maxMinutes, 90);
    assert.deepEqual(clampLimits(recipe, { maxMinutes: 30.9, maxUsd: 1.159 }, ceilings), { maxMinutes: 30, maxUsd: 1.15 });
    assert.equal(clampLimits(recipe, { maxUsd: 1.15 }, ceilings).maxUsd, 1.15);
  });
});

describe("validateParams", () => {
  const dataset = "https://huggingface.co/datasets/acme/qa";

  it("applies defaults and keeps given values", () => {
    assert.deepEqual(validateParams(recipe, { dataset }), {
      ok: true,
      value: { dataset, epochs: 1, style: "plain" },
    });
    assert.deepEqual(validateParams(recipe, { dataset, epochs: 3, rank: "16", note: "  hi  ", style: "" }), {
      ok: true,
      value: { dataset, epochs: 3, rank: 16, note: "hi", style: "plain" },
    });
  });

  it("refuses unknown keys, a missing required field and a non-object", () => {
    const unknown = validateParams(recipe, { dataset, allowNoGpu: true });
    assert.equal(unknown.ok, false);
    assert.match(!unknown.ok ? unknown.error : "", /Unknown parameter: allowNoGpu/);
    const missing = validateParams(recipe, { epochs: 2 });
    assert.deepEqual(missing, { ok: false, error: "Dataset URL is required." });
    assert.deepEqual(validateParams(recipe, { dataset: "   " }), { ok: false, error: "Dataset URL is required." });
    assert.equal(validateParams(recipe, [dataset]).ok, false);
    assert.equal(validateParams(recipe, "dataset").ok, false);
  });

  it("treats no params as an empty object", () => {
    const smoke: Recipe = { ...recipe, id: "smoke", params: [] };
    assert.deepEqual(validateParams(smoke, undefined), { ok: true, value: {} });
    assert.deepEqual(validateParams(smoke, null), { ok: true, value: {} });
    assert.deepEqual(validateParams(smoke, {}), { ok: true, value: {} });
    assert.equal(validateParams(smoke, { allowNoGpu: 1 }).ok, false);
  });

  it("checks number types and bounds", () => {
    assert.deepEqual(validateParams(recipe, { dataset, epochs: "lots" }), { ok: false, error: "Epochs must be a number." });
    assert.deepEqual(validateParams(recipe, { dataset, epochs: true }), { ok: false, error: "Epochs must be a number." });
    assert.deepEqual(validateParams(recipe, { dataset, epochs: 0 }), { ok: false, error: "Epochs must be at least 1." });
    assert.deepEqual(validateParams(recipe, { dataset, epochs: 6 }), { ok: false, error: "Epochs must be at most 5." });
    assert.equal(validateParams(recipe, { dataset, epochs: 5, rank: 64 }).ok, true);
  });

  it("trims text and cuts it to 2000 characters", () => {
    const r = validateParams(recipe, { dataset, note: `  ${"x".repeat(PARAM_TEXT_MAX + 50)}  ` });
    assert.equal(r.ok && String(r.value.note).length, PARAM_TEXT_MAX);
    assert.deepEqual(validateParams(recipe, { dataset, note: 42 }), { ok: false, error: "Note must be text." });
  });

  it("accepts only https URLs", () => {
    assert.deepEqual(validateParams(recipe, { dataset: ` ${dataset} ` }), {
      ok: true,
      value: { dataset, epochs: 1, style: "plain" },
    });
    for (const bad of ["http://huggingface.co/x", "ftp://example.com/x", "not a url", "file:///etc/passwd"]) {
      assert.deepEqual(validateParams(recipe, { dataset: bad }), { ok: false, error: "Dataset URL must be an https URL." });
    }
    assert.equal(validateParams(recipe, { dataset: `https://example.com/${"a".repeat(PARAM_TEXT_MAX)}` }).ok, false);
  });
});

describe("decideCheck", () => {
  it("waits on a healthy running or booting job", () => {
    assert.deepEqual(decideCheck(job(), active, after(5 * MIN)), { action: "wait" });
    const booting = job({ status: "booting", firstHeartbeatAt: null, lastHeartbeatAt: null });
    assert.deepEqual(decideCheck(booting, { status: "booting" }, after(5 * MIN)), { action: "wait" });
  });

  it("stops first when an admin asked, even after the runner said done", () => {
    const check = decideCheck(job({ stopRequested: true, status: "succeeded" }), null, after(5 * MIN));
    assert.equal(check.action, "terminate");
    assert.equal(check.action === "terminate" && check.status, "stopped");
  });

  it("ends with the status the runner already set", () => {
    const done = decideCheck(job({ status: "succeeded" }), active, after(5 * MIN));
    assert.deepEqual(done, { action: "terminate", status: "succeeded", reason: "The job finished." });
    const failed = decideCheck(job({ status: "failed", error: "CUDA out of memory" }), active, after(5 * MIN));
    assert.deepEqual(failed, { action: "terminate", status: "failed", reason: "CUDA out of memory" });
    const bare = decideCheck(job({ status: "failed" }), active, after(5 * MIN));
    assert.equal(bare.action === "terminate" && bare.reason, "The job reported a failure.");
  });

  it("fails when the instance is gone, terminated or preempted outside the platform", () => {
    for (const instance of [null, { status: "terminated" as const }, { status: "terminating" as const }, { status: "preempted" as const }]) {
      const check = decideCheck(job(), instance, after(5 * MIN));
      assert.equal(check.action === "terminate" && check.status, "failed", String(instance?.status));
    }
    const preempted = decideCheck(job(), { status: "preempted" }, after(5 * MIN));
    assert.equal(preempted.action === "terminate" && preempted.reason, "Lambda preempted the instance.");
    // A gone instance is reported before the time limit.
    const late = decideCheck(job(), { status: "terminated" }, after(600 * MIN));
    assert.match(late.action === "terminate" ? late.reason : "", /terminated outside/);
  });

  it("fails at the time limit, before the dollar limit", () => {
    const recent = job({ lastHeartbeatAt: after(59 * MIN) });
    assert.deepEqual(decideCheck(recent, active, after(60 * MIN - 1)), { action: "wait" });
    const check = decideCheck({ ...recent, maxUsd: 1 }, active, after(60 * MIN));
    assert.deepEqual(check, { action: "terminate", status: "failed", reason: "Reached the 60-minute limit." });
  });

  it("fails at the dollar limit", () => {
    // $1.20/hour reaches $0.50 at 25 minutes.
    const capped = job({ maxUsd: 0.5, lastHeartbeatAt: after(24 * MIN) });
    assert.deepEqual(decideCheck(capped, active, after(24 * MIN)), { action: "wait" });
    assert.deepEqual(decideCheck(capped, active, after(24 * MIN + 1)), {
      action: "terminate",
      status: "failed",
      reason: "Reached the $0.50 limit.",
    });
  });

  it("fails a job with no heartbeat 25 minutes after launch", () => {
    const booting = job({ status: "booting", firstHeartbeatAt: null, lastHeartbeatAt: null });
    assert.deepEqual(decideCheck(booting, { status: "booting" }, after(BOOT_GRACE_MS - 1)), { action: "wait" });
    assert.deepEqual(decideCheck(booting, { status: "booting" }, after(BOOT_GRACE_MS)), {
      action: "terminate",
      status: "failed",
      reason: "No heartbeat 25 minutes after launch.",
    });
  });

  it("fails a job silent for 10 minutes after its first heartbeat", () => {
    const quiet = job({ lastHeartbeatAt: after(10 * MIN) });
    assert.deepEqual(decideCheck(quiet, active, after(10 * MIN + SILENCE_MS - 1)), { action: "wait" });
    assert.deepEqual(decideCheck(quiet, active, after(10 * MIN + SILENCE_MS)), {
      action: "terminate",
      status: "failed",
      reason: "No heartbeat for 10 minutes.",
    });
    // Only the first heartbeat on record: silence counts from it.
    const once = job({ lastHeartbeatAt: null, firstHeartbeatAt: after(MIN) });
    assert.equal(decideCheck(once, active, after(MIN + SILENCE_MS)).action, "terminate");
  });

  it("fails an unhealthy instance last", () => {
    assert.deepEqual(decideCheck(job(), { status: "unhealthy" }, after(5 * MIN)), {
      action: "terminate",
      status: "failed",
      reason: "Lambda reports the instance as unhealthy.",
    });
    // Silence is reported ahead of unhealthy.
    const quiet = decideCheck(job(), { status: "unhealthy" }, after(MIN + SILENCE_MS));
    assert.match(quiet.action === "terminate" ? quiet.reason : "", /No heartbeat for/);
  });
});

describe("instanceNameFor", () => {
  it("is mm-train-<8 chars of the id>-<recipe>, lowercase and at most 64 characters", () => {
    assert.equal(instanceNameFor("3F2A9C1E-0000-4000-8000-000000000001", "smoke"), "mm-train-3f2a9c1e-smoke");
    assert.equal(instanceNameFor("3f2a9c1e-0000-4000-8000-000000000001", "glimmer-lora"), "mm-train-3f2a9c1e-glimmer-lora");
    const long = instanceNameFor("3f2a9c1e", "x".repeat(80) as RecipeId);
    assert.equal(long.length, 64);
    assert.match(long, /^mm-train-3f2a9c1e-x+$/);
  });
});

describe("toJobView", () => {
  const row: TrainJobRow = {
    id: "3f2a9c1e-0000-4000-8000-000000000001",
    recipe: "smoke",
    title: "Smoke test",
    status: "running",
    params: {},
    instanceType: "gpu_1x_a10",
    region: "us-east-1",
    priceCentsPerHour: 120,
    maxMinutes: 30,
    maxUsd: 1,
    instanceId: "i-123",
    instanceName: "mm-train-3f2a9c1e-smoke",
    instanceIp: "203.0.113.5",
    tokenHash: "secret-hash",
    workflowRunId: "run_1",
    stopRequested: false,
    progress: { step: 2, totalSteps: 3 },
    artifacts: [],
    summary: null,
    error: null,
    costUsd: 0,
    createdBy: null,
    createdAt: after(-MIN),
    launchedAt: T0,
    firstHeartbeatAt: after(MIN),
    lastHeartbeatAt: after(2 * MIN),
    finishedAt: null,
    terminatedAt: null,
    evalSummary: null,
    serveEndpoint: null,
    hub: null,
    judgeModel: null,
    productId: null,
  };

  it("uses ISO dates and a live cost estimate while running", () => {
    const view = toJobView(row, after(10 * MIN));
    assert.equal(view.costUsd, 0.2);
    assert.equal(view.createdAt, "2026-10-27T11:59:00.000Z");
    assert.equal(view.launchedAt, "2026-10-27T12:00:00.000Z");
    assert.equal(view.lastHeartbeatAt, "2026-10-27T12:02:00.000Z");
    assert.equal(view.finishedAt, null);
    assert.equal(view.terminatedAt, null);
    assert.deepEqual(view.progress, { step: 2, totalSteps: 3 });
    assert.equal("tokenHash" in view, false, "the token hash never reaches the page");
  });

  it("uses the final cost once terminated", () => {
    const done = { ...row, status: "succeeded" as const, costUsd: 0.42, finishedAt: after(20 * MIN), terminatedAt: after(21 * MIN) };
    const view = toJobView(done, after(600 * MIN));
    assert.equal(view.costUsd, 0.42);
    assert.equal(view.terminatedAt, "2026-10-27T12:21:00.000Z");
    assert.equal(view.evalSummary, null);
  });

  it("passes the eval summary through once judging wrote one", () => {
    const evalSummary = { items: 2, tunedWins: 1, baseWins: 0, ties: 1, avgBaseScore: 5, avgTunedScore: 6.5, judgeCostUsd: 0.01 };
    assert.deepEqual(toJobView({ ...row, evalSummary }, after(10 * MIN)).evalSummary, evalSummary);
  });

  it("names the judge from the record: Muse Spark 1.3 for a job judged before it was recorded, none before judging", () => {
    const evalSummary = { items: 2, tunedWins: 1, baseWins: 0, ties: 1, avgBaseScore: 5, avgTunedScore: 6.5, judgeCostUsd: 0.01 };
    assert.equal(toJobView({ ...row, evalSummary }, after(10 * MIN)).judgeModel, "muse-spark-1.3", "history keeps its judge");
    assert.equal(toJobView({ ...row, evalSummary, judgeModel: "muse-wonder-1.0" }, after(10 * MIN)).judgeModel, "muse-wonder-1.0");
    assert.equal(toJobView({ ...row, judgeModel: "muse-wonder-1.0" }, after(10 * MIN)).judgeModel, "muse-wonder-1.0", "judging");
    assert.equal(toJobView(row, after(10 * MIN)).judgeModel, null, "no judge yet");
    assert.equal(toJobView({ ...row, evalSummary: unjudgedSummary("Judging skipped: x.") }, after(10 * MIN)).judgeModel, null, "skipped");
  });

  it("names the story's model from the hub state: Muse Spark 1.3 for a story saved before it was recorded", () => {
    const hub = { status: "published" as const, story: "Told.", storyBy: "spark" as const };
    assert.equal(toJobView({ ...row, recipe: "glimmer-lora", hub }, after(MIN)).hub?.storyModel, "muse-spark-1.3");
    assert.equal(toJobView({ ...row, recipe: "glimmer-lora", hub: { ...hub, storyModel: "muse-wonder-1.0" } }, after(MIN)).hub?.storyModel, "muse-wonder-1.0");
    assert.equal(toJobView({ ...row, recipe: "glimmer-lora", hub: { ...hub, storyBy: "template" as const } }, after(MIN)).hub?.storyModel, null);
  });
});

describe("dataset params", () => {
  const withDataset: Recipe = {
    ...recipe,
    params: [{ key: "datasetId", label: "Dataset", kind: "dataset", required: true }],
  };

  it("takes a dataset id, lowercased, and refuses anything else", () => {
    const id = "3F2A9C1E-0000-4000-8000-000000000001";
    assert.deepEqual(validateParams(withDataset, { datasetId: ` ${id} ` }), { ok: true, value: { datasetId: id.toLowerCase() } });
    for (const bad of ["not-an-id", "https://huggingface.co/datasets/acme/qa", 7]) {
      assert.equal(validateParams(withDataset, { datasetId: bad }).ok, false, String(bad));
    }
    assert.deepEqual(validateParams(withDataset, {}), { ok: false, error: "Dataset is required." });
  });
});

describe("eval holdout", () => {
  it("holds out 10%, at least 8 and at most 40, and always leaves 8 to train on", () => {
    assert.equal(evalHoldoutCount(16), 8);
    assert.equal(evalHoldoutCount(20), 8);
    assert.equal(evalHoldoutCount(100), 10);
    assert.equal(evalHoldoutCount(250), 25);
    assert.equal(evalHoldoutCount(1000), 40);
    assert.equal(evalHoldoutCount(12), 4, "never under 8 for training");
    assert.equal(evalHoldoutCount(5), 0);
  });

  it("spreads the eval items evenly, distinct and in range", () => {
    for (const n of [16, 20, 37, 100, 999, 1000]) {
      const picked = evalIndexes(n);
      assert.equal(picked.length, evalHoldoutCount(n));
      assert.equal(new Set(picked).size, picked.length, `distinct for ${n}`);
      assert.ok(picked.every((i, k) => i >= 0 && i < n && (k === 0 || i > picked[k - 1]!)), `ascending for ${n}`);
    }
    assert.deepEqual(evalIndexes(20), [1, 3, 6, 8, 11, 13, 16, 18]);
    assert.deepEqual(evalIndexes(16), [1, 3, 5, 7, 9, 11, 13, 15]);
  });
});

describe("dedupePrompts", () => {
  it("drops blanks and prompts that differ only in case, spacing or punctuation, and stops at max", () => {
    const existing = ["How do I reset my password?"];
    const incoming = ["how do i reset my PASSWORD", "  ", "What is a LoRA adapter?", "What is a LoRA   adapter", "Third one", "Fourth"];
    assert.deepEqual(dedupePrompts(existing, incoming, 10), ["What is a LoRA adapter?", "Third one", "Fourth"]);
    assert.deepEqual(dedupePrompts(existing, incoming, 2), ["What is a LoRA adapter?", "Third one"]);
    assert.deepEqual(dedupePrompts([], ["Ünïcode café", "unicode cafe"], 5), ["Ünïcode café"], "accents fold");
  });
});

describe("near-duplicate prompts", () => {
  const near = (a: string, b: string) => isNearDuplicate(promptWords(a), promptWords(b));

  it("matches a reordering, a typo or a changed word, not a different question", () => {
    assert.equal(near("How do I reset my password?", "how can i reset my password"), true);
    assert.equal(near("Do you have gluten-free options?", "Gluten free options: do you have any?"), true);
    assert.equal(near("Why does my code raise TypeError: 'int' object is not subscriptable?", "why does my code raise TypeError: 'NoneType' object is not subscriptable"), true);
    assert.equal(near("What is a KeyError?", "What is an IndexError?"), false);
    assert.equal(near("Do you have gluten-free options?", "any gluten free stuff??"), false, "a paraphrase in other words");
    assert.equal(near("", "anything"), false);
  });

  it("holds out prompts with no near-duplicate, near the evenly spread positions", () => {
    const distinct = Array.from({ length: 20 }, (_, i) => `Topic${i} detail${i} example${i}?`);
    assert.deepEqual(evalSplit(distinct), { held: evalIndexes(20), dropped: [] }, "nothing near: the plain spread");

    // Position 1 is a near-duplicate of position 12, so the eval item moves to the closest prompt with none.
    const prompts = distinct.slice();
    prompts[1] = "How do I reset my password?";
    prompts[12] = "how can i reset my password";
    const { held, dropped } = evalSplit(prompts);
    assert.equal(held.length, 8);
    assert.equal(held.includes(1) || held.includes(12), false, "neither copy is held out");
    assert.deepEqual(held, [2, 3, 6, 8, 11, 13, 16, 18]);
    assert.deepEqual(dropped, []);
  });

  it("holds out a prompt's near-duplicates beside it when every prompt has one", () => {
    // Ten pairs: each prompt has exactly one near-duplicate.
    const prompts = Array.from({ length: 20 }, (_, i) => {
      const k = Math.floor(i / 2);
      return `topic${k} detail${k} example${k}${i % 2 ? " today" : ""}`;
    });
    const { held, dropped } = evalSplit(prompts);
    assert.equal(held.length, 8);
    const heldWords = held.map((i) => promptWords(prompts[i]!));
    const train = prompts.map((_, i) => i).filter((i) => !held.includes(i) && !dropped.includes(i));
    for (const i of train) {
      assert.equal(heldWords.some((w) => isNearDuplicate(w, promptWords(prompts[i]!))), false, `train ${i} is near an eval prompt`);
    }
    assert.deepEqual(held, [0, 1, 2, 3, 6, 7, 8, 9], "whole pairs, so nothing is dropped");
    assert.deepEqual(dropped, []);
    assert.deepEqual(evalSplit(prompts), { held, dropped }, "deterministic");
  });

  it("keeps 8 to train on even when every prompt is a near-duplicate of every other", () => {
    const prompts = Array.from({ length: 20 }, (_, i) => `write a short cover letter for a nurse job ${i % 2 ? "please" : "now"}`);
    const { held, dropped } = evalSplit(prompts);
    assert.equal(held.length, 8);
    assert.equal(20 - held.length - dropped.length, 8);
  });
});

describe("run estimates", () => {
  it("adds seconds a step for the GPU to a fixed overhead, larger without the cache", () => {
    const warm = runEstimate("glimmer-lora", { maxSteps: 120 }, "gpu_1x_h100_pcie", true)!;
    assert.deepEqual(warm, {
      steps: 120,
      secondsPerStep: 6,
      trainMinutes: 12,
      overheadMinutes: GLIMMER_OVERHEAD_MINUTES,
      minutes: 12 + GLIMMER_OVERHEAD_MINUTES,
      cached: true,
    });
    const cold = runEstimate("glimmer-lora", { maxSteps: "2000" }, "gpu_1x_a100_sxm4", false)!;
    assert.equal(cold.minutes, 400 + GLIMMER_OVERHEAD_NO_CACHE_MINUTES);
    assert.equal(runEstimate("glimmer-lora", {}, "gpu_1x_h100_sxm5", true)!.steps, 120, "the recipe's default steps");
    assert.equal(runEstimate("glimmer-lora", { maxSteps: 100 }, "gpu_8x_mystery", true)!.secondsPerStep, 12, "an unknown GPU counts as the slowest");
    assert.equal(runEstimate("glimmer-lora", { maxSteps: 2000, dryRun: 1 }, "gpu_1x_a100_sxm4", false), null, "a dry run doesn't train");
    assert.equal(runEstimate("smoke", {}, "gpu_1x_a10", false), null);
  });

  it("counts the minutes the dollar limit buys at the GPU's price", () => {
    assert.equal(usableMinutes({ maxMinutes: 150, maxUsd: 14 }, 429), 150);
    assert.equal(usableMinutes({ maxMinutes: 150, maxUsd: 5 }, 429), 69, "$5 at $4.29/h");
    // Every started minute counts in full, so $4.29 at $4.29/h is used up as the 60th minute starts.
    assert.equal(usableMinutes({ maxMinutes: 150, maxUsd: 4.29 }, 429), 59);
    assert.equal(usableMinutes({ maxMinutes: 150, maxUsd: 1 }, 75), 79, "$1 at $0.75/h");
    assert.equal(usableMinutes({ maxMinutes: 120, maxUsd: 5 }, 0), 120, "no price: the time limit");
    assert.equal(usableMinutes({ maxMinutes: 120, maxUsd: 5 }, null), 120);
  });

  it("agrees with decideCheck: a job runs its usable minutes and is stopped right after", () => {
    for (const [maxUsd, price] of [[4.29, 429], [5, 429], [1, 75], [2, 249], [14, 429]] as const) {
      const limits = { maxMinutes: 150, maxUsd };
      const usable = usableMinutes(limits, price);
      const at = (ms: number) => decideCheck(job({ ...limits, priceCentsPerHour: price, lastHeartbeatAt: after(ms) }), active, after(ms));
      assert.deepEqual(at(usable * MIN - 1), { action: "wait" }, `$${maxUsd} at ${price} cents an hour runs ${usable} minutes`);
      assert.equal(at(usable * MIN + 1).action, "terminate", `$${maxUsd} at ${price} cents an hour stops after ${usable} minutes`);
    }
  });

  it("says why a run doesn't fit, or nothing when it does", () => {
    const long = runEstimate("glimmer-lora", { maxSteps: 2000 }, "gpu_1x_h100_sxm5", true)!;
    assert.equal(runFitProblem(long, 300, "1x H100 SXM5 (80 GB)"), null, "167 + 20 fits 300");
    const problem = runFitProblem(long, 150, "1x H100 SXM5 (80 GB)")!;
    assert.equal(
      problem,
      "2000 training steps on 1x H100 SXM5 (80 GB) need about 187 minutes (167 of training at about 5 s a step, plus about 20 for booting, loading the model and answering the eval prompts), but this job's limits stop it after 150 minutes. Lower the training steps, raise the time or dollar limit, or pick a faster GPU.",
    );
    const cold = runEstimate("glimmer-lora", { maxSteps: 600 }, "gpu_1x_a100_sxm4", false)!;
    assert.match(runFitProblem(cold, 120, "1x A100 SXM4 (40 GB)")!, /installing the packages, downloading the model and answering the eval prompts, since this region has no model cache yet\)/);
    assert.equal(problem.includes(String.fromCharCode(0x2014)), false, "no em dash");
  });
});

describe("datasetSystemPrompt", () => {
  it("names the task and the length rule", () => {
    const system = datasetSystemPrompt("  Explain Python errors to beginners.  ");
    assert.match(system, /^You are an assistant for this task: Explain Python errors to beginners\.\n\n/);
    assert.match(system, /under about 350 words/);
    assert.doesNotMatch(system, /\u2014/);
  });
});

describe("toDatasetView", () => {
  it("uses ISO dates", () => {
    const view = toDatasetView({
      id: "d1",
      title: "Errors",
      task: "Explain errors.",
      status: "ready",
      requested: 100,
      trainCount: 88,
      evalCount: 10,
      costUsd: 0.5,
      error: null,
      createdBy: null,
      createdAt: T0,
      finishedAt: after(MIN),
      workflowRunId: "run",
      writerModel: null,
    });
    assert.deepEqual(view, {
      id: "d1",
      title: "Errors",
      task: "Explain errors.",
      status: "ready",
      requested: 100,
      trainCount: 88,
      evalCount: 10,
      costUsd: 0.5,
      error: null,
      createdAt: "2026-10-27T12:00:00.000Z",
      finishedAt: "2026-10-27T12:01:00.000Z",
      writerModel: "muse-spark-1.3",
    });
  });

  it("names the writer from the record: Muse Wonder when it says so, Muse Spark 1.3 when it has none", () => {
    const row = {
      id: "d2",
      title: "New",
      task: "Explain errors.",
      status: "generating" as const,
      requested: 40,
      trainCount: 0,
      evalCount: 0,
      costUsd: 0,
      error: null,
      createdBy: null,
      createdAt: T0,
      finishedAt: null,
      workflowRunId: null,
    };
    assert.equal(toDatasetView({ ...row, writerModel: "muse-wonder-1.0" }).writerModel, "muse-wonder-1.0");
    assert.equal(toDatasetView({ ...row, writerModel: null }).writerModel, "muse-spark-1.3", "history keeps its writer");
  });
});

describe("judging", () => {
  it("keeps better consistent with the scores, and lets the judge break a tie", () => {
    assert.equal(betterOf(4, 8, "base"), "tuned");
    assert.equal(betterOf(8, 4, "tuned"), "base");
    assert.equal(betterOf(6, 6, "tuned"), "tuned");
    assert.equal(betterOf(6, 6, "tie"), "tie");
  });

  it("clamps scores to whole numbers from 1 to 10", () => {
    assert.deepEqual([0, 1, 5.4, 5.6, 10, 11, Number.NaN].map(judgeScore), [1, 1, 5, 6, 10, 10, 1]);
  });

  it("summarizes wins, ties, average scores and cost", () => {
    const summary = summarizeJudgements([
      { baseScore: 4, tunedScore: 8, better: "tuned", costUsd: 0.0012 },
      { baseScore: 7, tunedScore: 5, better: "base", costUsd: 0.0011 },
      { baseScore: 6, tunedScore: 6, better: "tie", costUsd: 0 },
    ]);
    assert.deepEqual(summary, {
      items: 3,
      tunedWins: 1,
      baseWins: 1,
      ties: 1,
      avgBaseScore: 5.67,
      avgTunedScore: 6.33,
      judgeCostUsd: 0.0023,
    });
    assert.deepEqual(summarizeJudgements([]), {
      items: 0,
      tunedWins: 0,
      baseWins: 0,
      ties: 0,
      avgBaseScore: 0,
      avgTunedScore: 0,
      judgeCostUsd: 0,
    });
  });

  it("keeps why judging ended without a verdict on the summary itself", () => {
    const skipped = unjudgedSummary("Judging skipped: MODEL_API_KEY isn't set.");
    assert.equal(skipped.items, 0);
    assert.equal(unjudgedNote(skipped), "Judging skipped: MODEL_API_KEY isn't set.");
    assert.equal(unjudgedNote({ ...skipped, note: undefined } as never), "Judging ended without a verdict.");
    assert.equal(unjudgedNote(summarizeJudgements([{ baseScore: 4, tunedScore: 8, better: "tuned", costUsd: 0 }])), null);
    assert.equal(unjudgedNote(null), null);
    assert.equal(unjudgedSummary("x".repeat(400)).note.length, 300);
  });
});

describe("capEventBody", () => {
  it("keeps the last 4 KB of log text and errors", () => {
    const text = `start${"x".repeat(EVENT_LOG_MAX)}end`;
    const log = capEventBody({ type: "log", text });
    assert.equal(log.type === "log" && log.text.length, EVENT_LOG_MAX);
    assert.ok(log.type === "log" && log.text.endsWith("end"));
    const failed = capEventBody({ type: "failed", error: `${"y".repeat(10_000)}ValueError` });
    assert.ok(failed.type === "failed" && failed.error.endsWith("ValueError") && failed.error.length <= 4096);
  });

  it("cuts each eval field to 3,500 characters and keeps the index", () => {
    const long = "z".repeat(EVAL_TEXT_MAX + 100);
    assert.deepEqual(capEventBody({ type: "eval", index: 3, prompt: long, reference: "ref", base: long, tuned: "t" }), {
      type: "eval",
      index: 3,
      prompt: "z".repeat(EVAL_TEXT_MAX),
      reference: "ref",
      base: "z".repeat(EVAL_TEXT_MAX),
      tuned: "t",
    });
  });

  it("leaves short bodies alone", () => {
    const body = { type: "progress" as const, step: 1, totalSteps: 3, message: "tick" };
    assert.deepEqual(capEventBody(body), body);
    assert.deepEqual(capEventBody({ type: "done", metrics: { gpu: "A10", seconds: 4 } }), {
      type: "done",
      metrics: { gpu: "A10", seconds: 4 },
    });
  });
});

describe("live demo", () => {
  const ADAPTER = "aaaaaaaa-0000-4000-8000-000000000000";
  const serveRecipe: Recipe = {
    id: "glimmer-serve",
    title: "Try tuned Glimmer live",
    description: "Test recipe.",
    gpus: [{ instanceType: "gpu_1x_h100_sxm5", label: "1x H100 SXM5 (80 GB)" }],
    defaultMaxMinutes: 45,
    defaultMaxUsd: 3.29,
    usesCache: true,
    params: [
      { key: "adapterJobId", label: "Adapter", kind: "adapter", required: true },
      { key: "minutes", label: "Minutes live", kind: "number", default: 30, min: 10, max: 120 },
    ],
    script: "def run(ctx):\n    return {}\n",
  };
  const cert = "ab".repeat(32);
  /** A serve job launched at T0 on an H100 SXM5 ($4.29 an hour) with the default limits. */
  const serveJob = (over: Partial<TrainJobRow> = {}) => ({
    id: "bbbbbbbb-0000-4000-8000-000000000000",
    status: "running" as TrainJobRow["status"],
    stopRequested: false,
    params: { adapterJobId: ADAPTER, minutes: 30 } as Record<string, string | number>,
    maxMinutes: 45,
    maxUsd: 3.29,
    priceCentsPerHour: 429,
    launchedAt: T0 as Date | null,
    serveEndpoint: { ip: "203.0.113.9", port: 8443, certSha256: cert, startedAt: after(8 * MIN).toISOString() } as TrainJobRow["serveEndpoint"],
    ...over,
  });

  it("takes an adapter param as a job id, lowercased, and refuses anything else", () => {
    assert.deepEqual(validateParams(serveRecipe, { adapterJobId: ` ${ADAPTER.toUpperCase()} ` }), { ok: true, value: { adapterJobId: ADAPTER, minutes: 30 } });
    for (const bad of ["not-an-id", 7, ""]) {
      const result = validateParams(serveRecipe, { adapterJobId: bad });
      assert.equal(result.ok, false, String(bad));
    }
    assert.match((validateParams(serveRecipe, { adapterJobId: "x" }) as { error: string }).error, /one of the trained adapters/);
    assert.equal(validateParams(serveRecipe, { adapterJobId: ADAPTER, minutes: 5 }).ok, false);
  });

  it("sizes a serve job's default limits from its minutes, so the dollars never stop it first", () => {
    assert.deepEqual(recipeDefaults(serveRecipe, {}), { defaultMaxMinutes: 45, defaultMaxUsd: 3.29 });
    assert.deepEqual(recipeDefaults(serveRecipe, { minutes: 120 }), { defaultMaxMinutes: 135, defaultMaxUsd: 9.73 });
    assert.deepEqual(recipeDefaults(serveRecipe, { minutes: "10" }), { defaultMaxMinutes: 25, defaultMaxUsd: 1.86 });
    for (const minutes of [10, 30, 45, 60, 120]) {
      const d = recipeDefaults(serveRecipe, { minutes });
      const limits = { maxMinutes: d.defaultMaxMinutes, maxUsd: d.defaultMaxUsd };
      for (const price of [199, 329, 429]) assert.equal(usableMinutes(limits, price), limits.maxMinutes, `${minutes} minutes at ${price}`);
    }
    assert.deepEqual(recipeDefaults(recipe, { minutes: 120 }), { defaultMaxMinutes: 90, defaultMaxUsd: 4 }, "other recipes keep their own");
    assert.equal(serveMinutes({ minutes: 500 }), 120);
    assert.equal(serveMinutes({ minutes: 3 }), 10);
    assert.equal(serveMinutes({ minutes: "x" }), 30);
  });

  it("says when a serve job's limits can't cover its minutes plus 15 to boot", () => {
    assert.equal(serveFitProblem(30, 45, "1x H100 SXM5 (80 GB)"), null);
    assert.equal(
      serveFitProblem(60, 69, "1x H100 SXM5 (80 GB)"),
      "A 60-minute live demo needs about 75 minutes of GPU time (about 15 to boot and load the model), but this job's limits stop it after 69 minutes on 1x H100 SXM5 (80 GB). Pick fewer minutes, or raise the time or dollar limit.",
    );
  });

  it("serves only a glimmer-lora adapter that succeeded, wasn't a dry run and is on the cache", () => {
    const lora = { id: ADAPTER, recipe: "glimmer-lora" as RecipeId, status: "succeeded" as TrainJobRow["status"], params: { datasetId: "d" } as Record<string, string | number> };
    const plain = { cache_used: "yes", adapter_dir: `/lambda/nfs/muse-muse-cache-us-east-1/models/${ADAPTER}` };
    const cached = { ...plain, base_model: "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit" };
    assert.equal(adapterProblem(lora, cached), null);
    assert.equal(adapterProblem({ ...lora, params: { datasetId: "d", baseModel: "OfflineBase/Glimmer-30B-2026-Knowledge-unsloth-bnb-4bit" } }, plain), null, "the baseModel param counts too");
    // A LoRA from before the switch has r30b's shapes, so it would load on the r30b GPU and answer as nobody's model.
    assert.match(adapterProblem(lora, plain)!, /trained on plain Muse Glimmer/);
    assert.match(adapterProblem(lora, plain, { decide: true })!, /trained on plain Muse Glimmer/);
    assert.match(adapterProblem(lora, { ...plain, base_model: "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit" })!, /trained on plain Muse Glimmer/);
    assert.equal(adapterProblem(lora, plain, { uploadOnly: true }), null, "glimmer-publish loads no base, so an old adapter still uploads");
    assert.equal(adapterProblem(lora, { ...cached, adapter_dir: `${cached.adapter_dir}/` }), null);
    assert.match(adapterProblem(null, null)!, /doesn't exist/);
    assert.match(adapterProblem({ ...lora, recipe: "smoke" }, cached)!, /isn't a Muse Glimmer LoRA job/);
    assert.match(adapterProblem({ ...lora, status: "running" }, cached)!, /didn't succeed/);
    assert.match(adapterProblem({ ...lora, params: { dryRun: 1 } }, cached)!, /dry run/);
    assert.match(adapterProblem(lora, { ...cached, cache_used: "no" })!, /isn't on a model cache/);
    assert.match(adapterProblem(lora, { cache_used: "yes", adapter_dir: "/lambda/nfs/muse-muse-cache-us-east-1/models/other" })!, /isn't on a model cache/);
    assert.match(adapterProblem(lora, null)!, /isn't on a model cache/);
  });

  it("reads a SHA-256 fingerprint as 64 lowercase hex characters, from either form", () => {
    assert.equal(certFingerprint(cert), cert);
    assert.equal(certFingerprint("AB:".repeat(31) + "AB"), cert);
    assert.equal(certFingerprint(` ${cert.toUpperCase()} `), cert);
    for (const bad of [cert.slice(2), `${cert}00`, "zz".repeat(32), 42, null, "ab:".repeat(100)]) assert.equal(certFingerprint(bad), null, String(bad));
  });

  it("expects a demo to stop after its minutes, or at its limits when those come first", () => {
    assert.equal(serveEndsAt(serveJob())!.toISOString(), after(38 * MIN).toISOString(), "8 minutes to load, then 30");
    // The server stops SERVE_STOP_MARGIN_SECONDS (3 minutes) before the runner's deadline, the 45 minutes its limits allow.
    assert.equal(SERVE_STOP_MARGIN_SECONDS, 180);
    assert.equal(serveEndsAt(serveJob({ serveEndpoint: null }))!.toISOString(), after(42 * MIN).toISOString(), "before serving: the limit, less the margin");
    const late = serveJob({ serveEndpoint: { ip: "203.0.113.9", port: 8443, certSha256: cert, startedAt: after(20 * MIN).toISOString() } });
    assert.equal(serveEndsAt(late)!.toISOString(), after(42 * MIN).toISOString(), "a slow load leaves less than its minutes");
    assert.equal(serveEndsAt(serveJob({ launchedAt: null })), null);
  });

  it("shows the public page only the state, the minutes and when it ends", () => {
    const view = toLiveDemoView(serveJob(), after(10 * MIN));
    assert.deepEqual(view, { serveJobId: "bbbbbbbb-0000-4000-8000-000000000000", state: "live", minutes: 30, endsAt: after(38 * MIN).toISOString() });
    assert.ok(!JSON.stringify(view).includes("203.0.113.9") && !JSON.stringify(view).includes(cert));
    assert.equal(toLiveDemoView(serveJob({ serveEndpoint: null }), after(5 * MIN))?.state, "starting");
    assert.equal(toLiveDemoView(serveJob({ status: "booting", serveEndpoint: null }), after(MIN))?.state, "starting");
    const noIp = serveJob({ serveEndpoint: { ip: null, port: 8443, certSha256: cert, startedAt: after(8 * MIN).toISOString() } });
    assert.equal(toLiveDemoView(noIp, after(10 * MIN))?.state, "starting", "not live until Lambda reported its IP");
    assert.equal(toLiveDemoView(serveJob(), after(38 * MIN)), null, "its minutes are up");
    assert.equal(toLiveDemoView(serveJob({ status: "succeeded" }), after(10 * MIN)), null);
    assert.equal(toLiveDemoView(serveJob({ stopRequested: true }), after(10 * MIN)), null);
  });

  it("caps a serving event and shows the admin page when the demo started and ends, never the certificate", () => {
    const capped = capEventBody({ type: "serving", port: 8443, certSha256: "AB:".repeat(31) + "AB", model: "m".repeat(500), adapterJobId: ADAPTER });
    assert.deepEqual(capped, { type: "serving", port: 8443, certSha256: cert, model: "m".repeat(200), adapterJobId: ADAPTER });

    const base: TrainJobRow = {
      id: "bbbbbbbb-0000-4000-8000-000000000000",
      recipe: "glimmer-serve",
      title: "Live demo",
      status: "running",
      params: { adapterJobId: ADAPTER, minutes: 30 },
      instanceType: "gpu_1x_h100_sxm5",
      region: "us-east-1",
      priceCentsPerHour: 429,
      maxMinutes: 45,
      maxUsd: 3.29,
      instanceId: "i-1",
      instanceName: "mm-train-bbbbbbbb-glimmer-serve",
      instanceIp: "203.0.113.9",
      tokenHash: "h",
      workflowRunId: null,
      stopRequested: false,
      progress: null,
      artifacts: [],
      summary: null,
      error: null,
      costUsd: 0,
      createdBy: null,
      createdAt: T0,
      launchedAt: T0,
      firstHeartbeatAt: after(MIN),
      lastHeartbeatAt: after(9 * MIN),
      finishedAt: null,
      terminatedAt: null,
      evalSummary: null,
      serveEndpoint: serveJob().serveEndpoint,
      hub: null,
      judgeModel: null,
      productId: null,
    };
    const view = toJobView(base, after(10 * MIN));
    assert.deepEqual(view.serving, { startedAt: after(8 * MIN).toISOString(), endsAt: after(38 * MIN).toISOString() });
    assert.ok(!JSON.stringify(view).includes(cert));
    assert.equal(toJobView({ ...base, serveEndpoint: null }, after(10 * MIN)).serving, null);
    assert.equal("serving" in toJobView({ ...base, recipe: "smoke" }, after(10 * MIN)), false, "only a serve job has it");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Decision models: scoring (docs/DECISION_MODELS.md "Scoring (logic.ts)")

const approx = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const decisionLabel = (name: string): DecisionLabel => ({ id: labelId(name), name, description: "" });
/** A GPU score from probabilities over the shown letters: the log of each times the letter mass. */
const logs = (p: readonly number[], mass = 1) => p.map((x) => Math.log(x * mass));

describe("decision scoring: Wilson intervals", () => {
  it("matches an interval worked by hand", () => {
    // 8 right of 10, z = 1.96:
    //   p = 0.8, z^2 = 3.8416, z^2 / n = 0.38416, so the scale is 1 + 0.38416 = 1.38416
    //   center = (p + z^2 / 2n) / scale = (0.8 + 0.19208) / 1.38416 = 0.716738
    //   half = (z / scale) * sqrt(p (1 - p) / n + z^2 / 4n^2) = 1.416022 * sqrt(0.016 + 0.009604)
    //        = 1.416022 * 0.160012 = 0.226581
    //   low = 0.716738 - 0.226581 = 0.490157, high = 0.716738 + 0.226581 = 0.943319
    // Published Wilson tables give 0.4902 to 0.9433 for 8 of 10.
    const w = wilsonRate(8, 10);
    assert.equal(w.right, 8);
    assert.equal(w.total, 10);
    assert.equal(w.rate, 0.8);
    approx(w.low, 0.490157, 1e-6);
    approx(w.high, 0.943319, 1e-6);
  });

  it("stays inside 0 to 1 at the ends and knows nothing with no rows", () => {
    // 10 of 10: center = (1 + 0.19208) / 1.38416 = 0.861230, half = 1.416022 * sqrt(0.009604) = 1.416022 * 0.098 = 0.138770.
    const all = wilsonRate(10, 10);
    approx(all.low, 0.72246, 1e-5);
    assert.equal(all.high, 1);
    const none = wilsonRate(0, 5);
    assert.equal(none.low, 0);
    // 0 of 5: center = half = (3.8416 / 10) / 1.76832 = 0.217246, so high = 0.434493.
    approx(none.high, 0.434493, 1e-5);
    assert.deepEqual(wilsonRate(0, 0), { right: 0, total: 0, rate: 0, low: 0, high: 1 });
    for (const [k, n] of [[1, 3], [5, 6], [40, 80], [79, 80]] as const) {
      const w = wilsonRate(k, n);
      assert.ok(w.low <= w.rate && w.rate <= w.high, `${k} of ${n}`);
    }
    assert.throws(() => wilsonRate(6, 5), /right must be/);
  });
});

describe("decision scoring: per label, macro F1 and confusion", () => {
  const labels = ["Billing", "Shipping", "Account"].map(decisionLabel);

  it("scores each label and counts a none pick as a miss", () => {
    const { perLabel, macroF1, confusion } = labelScores(labels, [
      { label: "billing", pick: "billing" },
      { label: "billing", pick: "shipping" },
      { label: "shipping", pick: "shipping" },
      { label: "shipping", pick: null },
      { label: "account", pick: "account" },
      { label: "account", pick: "billing" },
    ]);
    // Rows are the right label, columns the pick, then none.
    assert.deepEqual(confusion, [
      [1, 1, 0, 0],
      [0, 1, 0, 1],
      [1, 0, 1, 0],
    ]);
    // Billing: picked twice, right once: precision 1/2, recall 1/2, F1 1/2. Shipping: the same (its none row is a miss
    // and no other label's false pick). Account: picked once and right, found 1 of 2: precision 1, recall 1/2, F1 2/3.
    assert.deepEqual(perLabel.map((l) => [l.id, l.precision, l.recall, l.support]), [
      ["billing", 0.5, 0.5, 2],
      ["shipping", 0.5, 0.5, 2],
      ["account", 1, 0.5, 2],
    ]);
    approx(perLabel[2]!.f1, 2 / 3);
    approx(macroF1, (0.5 + 0.5 + 2 / 3) / 3);
  });

  it("averages only the labels with test rows or picks", () => {
    const { perLabel, macroF1 } = labelScores(labels, [
      { label: "billing", pick: "billing" },
      { label: "billing", pick: "shipping" },
    ]);
    // Billing: precision 1, recall 1/2, F1 2/3. Shipping: no rows but picked once, F1 0, counted. Account: neither.
    approx(perLabel[0]!.f1, 2 / 3);
    assert.equal(perLabel[1]!.f1, 0);
    approx(macroF1, (2 / 3 + 0) / 2);
    assert.equal(labelScores(labels, []).macroF1, 0);
    assert.throws(() => labelScores(labels, [{ label: "x", pick: null }]), /isn't one of/);
    assert.throws(() => labelScores(labels, [{ label: "billing", pick: "x" }]), /isn't one of/);
  });
});

describe("decision scoring: ECE and reliability bins", () => {
  it("matches an ECE worked by hand", () => {
    // Top probabilities 0.95 (right), 0.85 (right), 0.82 (wrong), 0.55 (right):
    //   0.9 to 1 holds 0.95: accuracy 1, confidence 0.95, gap 0.05
    //   0.8 to 0.9 holds 0.85 and 0.82: accuracy 0.5, confidence 0.835, gap 0.335
    //   0.5 to 0.6 holds 0.55: accuracy 1, confidence 0.55, gap 0.45
    //   ECE = (1 * 0.05 + 2 * 0.335 + 1 * 0.45) / 4 = 1.17 / 4 = 0.2925
    const { ece, bins } = calibrationBins([
      { confidence: 0.95, right: true },
      { confidence: 0.85, right: true },
      { confidence: 0.82, right: false },
      { confidence: 0.55, right: true },
    ]);
    approx(ece, 0.2925);
    assert.equal(bins.length, 10);
    assert.deepEqual(bins.map((b) => b.rows), [0, 0, 0, 0, 0, 1, 0, 0, 2, 1]);
    assert.equal(bins[8]!.accuracy, 0.5);
    approx(bins[8]!.confidence, 0.835);
    assert.deepEqual(bins[3], { from: 0.3, to: 0.4, rows: 0, accuracy: 0, confidence: 0 });
  });

  it("puts 1 in the last bin and each edge in the bin it starts", () => {
    const { bins } = calibrationBins([
      { confidence: 1, right: true },
      { confidence: 0, right: false },
      { confidence: 0.5, right: true },
    ]);
    assert.equal(bins[9]!.rows, 1);
    assert.equal(bins[0]!.rows, 1);
    assert.equal(bins[5]!.rows, 1);
    assert.deepEqual(calibrationBins([]).ece, 0);
    assert.throws(() => calibrationBins([{ confidence: Number.NaN, right: true }]), /confidence/);
  });
});

describe("decision scoring: fitting T", () => {
  const rows = (n: number, p: number[], right: number): CalibrationRow[] => Array.from({ length: n }, () => ({ p, right }));

  it("finds the T worked out by hand", () => {
    // 20 dev rows give their first option 0.9 and their second 0.1 (none 0); the first is right on 15 of them.
    // At T the first option gets 0.9^(1/T) / (0.9^(1/T) + 0.1^(1/T)) = 1 / (1 + 9^(-1/T)). The dev log loss,
    // -(15 ln p + 5 ln (1 - p)) / 20, is lowest at p = 15 / 20 = 0.75, so 9^(-1/T) = 1/3, 1/T = ln 3 / ln 9 = 1/2, T = 2.
    //   loss at T = 2: -(15 ln 0.75 + 5 ln 0.25) / 20 = (4.315231 + 6.931472) / 20 = 0.562335
    //   loss at T = 1: -(15 ln 0.9 + 5 ln 0.1) / 20 = (1.580411 + 11.512925) / 20 = 0.654667
    const dev = [...rows(15, [0.9, 0.1, 0], 0), ...rows(5, [0.9, 0.1, 0], 1)];
    assert.deepEqual(fitTemperature(dev), { T: 2, calibrated: true });
    approx(decisionLogLoss(dev, 2), 0.562335, 1e-6);
    approx(decisionLogLoss(dev, 1), 0.654667, 1e-6);
    assert.ok(decisionLogLoss(dev, 1.9) > decisionLogLoss(dev, 2) && decisionLogLoss(dev, 2.1) > decisionLogLoss(dev, 2));
  });

  it("keeps T at 1 with fewer than 20 dev rows, or when no other T lowers the loss", () => {
    assert.deepEqual(fitTemperature(rows(19, [0.9, 0.1], 0)), { T: 1, calibrated: false });
    assert.deepEqual(fitTemperature([]), { T: 1, calibrated: false });
    // Even rows: every T gives the same loss.
    const even = Array.from({ length: 20 }, (_, i): CalibrationRow => ({ p: [0.5, 0.5], right: i % 2 }));
    assert.deepEqual(fitTemperature(even), { T: 1, calibrated: true });
  });

  it("stops at its bounds", () => {
    // Always right at 0.9: sharpening only helps, down to 0.25.
    assert.equal(fitTemperature(rows(20, [0.9, 0.1, 0], 0)).T, DECIDE_T_MIN);
    // Right half the time at 0.9: the best p is 0.5, which needs T without end, so 10.
    const half = [...rows(10, [0.9, 0.1], 0), ...rows(10, [0.9, 0.1], 1)];
    assert.equal(fitTemperature(half).T, DECIDE_T_MAX);
  });

  it("stays finite when the right option got 0", () => {
    const dev = [...rows(18, [0.7, 0.2, 0.1], 0), ...rows(2, [1, 0, 0], 2)];
    assert.ok(Number.isFinite(decisionLogLoss(dev, 1)));
    const { T } = fitTemperature(dev);
    assert.ok(T >= DECIDE_T_MIN && T <= DECIDE_T_MAX);
    assert.throws(() => fitTemperature([...dev, { p: [0.5, 0.5], right: 2 }]), /no right option/);
    assert.throws(() => decisionLogLoss([{ p: [-0.1, 1.1], right: 0 }], 1), /probability/);
    assert.throws(() => decisionLogLoss(dev, 0), /T must be/);
  });

  it("never changes the winner", () => {
    const random = seededRandom("fit-temperature");
    for (let set = 0; set < 20; set++) {
      const dev = Array.from({ length: 20 + set * 3 }, (): CalibrationRow => {
        const n = 3 + Math.floor(random() * 3);
        const raw = Array.from({ length: n }, () => random() ** 3);
        const sum = raw.reduce((s, x) => s + x, 0);
        return { p: raw.map((x) => x / sum), right: Math.floor(random() * n) };
      });
      const { T } = fitTemperature(dev);
      for (const row of dev) {
        const combined = { labels: row.p.slice(0, -1).map((p, i) => ({ id: `l${i}`, p })), none: row.p.at(-1)! };
        const soft = applyTemperature(combined, T);
        const at = (xs: number[]) => xs.indexOf(Math.max(...xs));
        assert.equal(at([...soft.labels.map((l) => l.p), soft.none]), at([...row.p]), `set ${set}, T ${T}`);
        const labels = combined.labels.map((l) => ({ id: l.id, name: l.id, description: "" }));
        assert.equal(temperedDecision(labels, combined, T).id, temperedDecision(labels, combined, 1).id);
      }
    }
  });
});

describe("decision scoring: summarizeDecisions", () => {
  const LABELS = ["Billing", "Shipping", "Account"].map(decisionLabel);
  const QUESTION = "Which team should handle this support ticket?";
  // The stand-in matches label names: rows 0, 1 (a tie, so the first label), 2 and 4 right; 3 and 5 wrong.
  const TEST_ROWS: DecisionRow[] = [
    { input: "billing question", label: "billing" },
    { input: "my card", label: "billing" },
    { input: "shipping delay", label: "shipping" },
    { input: "account of the parcel", label: "shipping" },
    { input: "account locked", label: "account" },
    { input: "password", label: "account" },
  ];
  // Probabilities over Billing, Shipping, Account and none, kept away from the bins' edges.
  const BASE = [
    [0.55, 0.15, 0.15, 0.15], // billing: picks Billing at 0.55, right
    [0.25, 0.45, 0.15, 0.15], // billing: picks Shipping at 0.45, wrong
    [0.05, 0.65, 0.15, 0.15], // shipping: picks Shipping at 0.65, right
    [0.15, 0.15, 0.15, 0.55], // shipping: picks none at 0.55, wrong
    [0.15, 0.05, 0.65, 0.15], // account: picks Account at 0.65, right
    [0.35, 0.25, 0.25, 0.15], // account: picks Billing at 0.35, wrong
  ];
  const BASE_MASS = [0.8, 0.6, 0.9, 0.7, 0.5, 0.4];
  const TUNED = [
    [0.85, 0.05, 0.05, 0.05], // right at 0.85
    [0.75, 0.15, 0.05, 0.05], // right at 0.75
    [0.05, 0.85, 0.05, 0.05], // right at 0.85
    [0.05, 0.75, 0.15, 0.05], // right at 0.75
    [0.05, 0.05, 0.85, 0.05], // right at 0.85
    [0.05, 0.55, 0.35, 0.05], // picks Shipping at 0.55, wrong
  ];
  // The decline check's renderings show the other two labels, then none: base declines rows 0 and 1, tuned all but 5.
  const BASE_DECLINE = [0, 1, 2, 3, 4, 5].map((r) => (r < 2 ? [0.2, 0.2, 0.6] : [0.6, 0.2, 0.2]));
  const TUNED_DECLINE = [0, 1, 2, 3, 4, 5].map((r) => (r < 5 ? [0.1, 0.1, 0.8] : [0.5, 0.2, 0.3]));

  function scenario(): DecisionScoringInput {
    const devRows = TEST_ROWS.slice(0, 4);
    const devItems = decisionItems({ question: QUESTION, labels: LABELS, rows: devRows, part: "dev" });
    const testItems = decisionItems({ question: QUESTION, labels: LABELS, rows: TEST_ROWS, part: "test" });
    const testScores = testItems.map(
      (it): DecideScoreItem =>
        it.decline
          ? { index: it.index, base: logs(BASE_DECLINE[it.row]!), tuned: logs(TUNED_DECLINE[it.row]!), baseMass: 1, tunedMass: 1 }
          : {
              index: it.index,
              base: logs(BASE[it.row]!, BASE_MASS[it.row]),
              tuned: logs(TUNED[it.row]!, 0.99),
              baseMass: BASE_MASS[it.row]!,
              tunedMass: 0.99,
            },
    );
    const devScores = devItems.map((it): DecideScoreItem => ({ index: it.index, base: logs(BASE[it.row]!), tuned: logs(TUNED[it.row]!), baseMass: 1, tunedMass: 1 }));
    return {
      labels: LABELS,
      trainCounts: { billing: 10, shipping: 12, account: 12 },
      dev: { rows: devRows, items: devItems, scores: devScores },
      test: { rows: TEST_ROWS, items: testItems, scores: testScores },
      tooLong: 2,
    };
  }

  it("scores base and tuned on the test rows", () => {
    const s = summarizeDecisions(scenario());
    assert.equal(s.kind, "decision");
    assert.deepEqual(s.labels, [
      { id: "billing", name: "Billing" },
      { id: "shipping", name: "Shipping" },
      { id: "account", name: "Account" },
    ]);
    assert.deepEqual([s.groups, s.devRows, s.testRows, s.unscoredRows, s.tooLong], [1, 4, 6, 0, 2]);
    // EvalSummary as a judged job reads it: tuned fixed rows 1 and 3, both got 0, 2 and 4, both missed 5.
    assert.deepEqual([s.items, s.tunedWins, s.baseWins, s.ties], [6, 2, 0, 4]);
    assert.deepEqual([s.avgBaseScore, s.avgTunedScore, s.judgeCostUsd], [0, 0, 0]);

    const base = s.base;
    const tuned = s.tuned!;
    assert.deepEqual(base.accuracy, wilsonRate(3, 6));
    assert.deepEqual(tuned.accuracy, wilsonRate(5, 6));
    assert.deepEqual(base.confusion, [
      [1, 1, 0, 0],
      [0, 1, 0, 1],
      [1, 0, 1, 0],
    ]);
    assert.deepEqual(tuned.confusion, [
      [2, 0, 0, 0],
      [0, 2, 0, 0],
      [0, 1, 1, 0],
    ]);
    // Base: F1 1/2, 1/2 and 2/3 (the labelScores case above). Tuned: Billing 1; Shipping picked 3 times, right twice,
    // found both: precision 2/3, recall 1, F1 0.8; Account found 1 of 2: F1 2/3.
    approx(base.macroF1, 5 / 9);
    approx(tuned.macroF1, (1 + 0.8 + 2 / 3) / 3);
    approx(tuned.perLabel[1]!.precision, 2 / 3);
    approx(tuned.perLabel[1]!.f1, 0.8);
    approx(base.noneRate, 1 / 6);
    assert.equal(tuned.noneRate, 0);
    assert.deepEqual(base.decline, { rows: 6, declined: 2, rate: 2 / 6 });
    assert.deepEqual(tuned.decline, { rows: 6, declined: 5, rate: 5 / 6 });

    // 4 dev rows are too few to fit T.
    assert.deepEqual([base.T, base.calibrated, tuned.T, tuned.calibrated], [1, false, 1, false]);
    // Base ECE by hand: 0.35 (wrong) alone in 0.3 to 0.4, gap 0.35; 0.45 (wrong) in 0.4 to 0.5, gap 0.45; 0.55 right
    // and 0.55 wrong in 0.5 to 0.6, accuracy 0.5, gap 0.05; 0.65 and 0.65, both right, in 0.6 to 0.7, gap 0.35.
    // ECE = (0.35 + 0.45 + 2 * 0.05 + 2 * 0.35) / 6 = 1.6 / 6.
    approx(base.ece.raw, 1.6 / 6);
    assert.equal(base.ece.withT, base.ece.raw);
    assert.deepEqual(base.reliability.map((b) => b.rows), [0, 0, 0, 1, 1, 2, 2, 0, 0, 0]);
    assert.equal(base.reliability[5]!.accuracy, 0.5);
    approx(base.reliability[5]!.confidence, 0.55);
    // Tuned: 0.55 wrong, gap 0.55; two 0.75s right, gap 0.25; three 0.85s right, gap 0.15.
    // ECE = (0.55 + 2 * 0.25 + 3 * 0.15) / 6 = 1.5 / 6 = 0.25.
    approx(tuned.ece.raw, 0.25);

    // Letter mass over the 12 test renderings: base 0.4, 0.5, 0.6, 0.7, 0.8, 0.9 and six 1s, so the median is
    // (0.9 + 1) / 2; tuned six 0.99s and six 1s.
    approx(base.letterMass.median, 0.95);
    approx(base.letterMass.min, 0.4);
    approx(tuned.letterMass.median, 0.995);
    approx(tuned.letterMass.min, 0.99);

    // Shipping and Account tie for the commonest train label, so the first: right on the 2 Shipping rows.
    assert.deepEqual(s.baselines.commonest, { id: "shipping", accuracy: wilsonRate(2, 6) });
    assert.deepEqual(s.baselines.standIn, { accuracy: wilsonRate(4, 6) });
  });

  it("gives the same summary for the same scores, in any order", () => {
    const input = scenario();
    const s = summarizeDecisions(input);
    assert.deepEqual(summarizeDecisions(scenario()), s);
    const shuffled = { ...input, test: { ...input.test, scores: [...input.test.scores].reverse() } };
    assert.deepEqual(summarizeDecisions(shuffled), s);
  });

  it("compares base and tuned on the same rows, counts a repeated index once, and leaves out what it can't score", () => {
    const input = scenario();
    const scores = input.test.scores.map((x) => ({ ...x }));
    // Row 5's only rendering lost its tuned score, so row 5 leaves both sides.
    scores[5] = { ...scores[5]!, tuned: null, tunedMass: null };
    // Index 6 is row 0's decline rendering: a score of the wrong length can't be used.
    scores[6] = { ...scores[6]!, base: [0, 0] };
    // A retried callback for index 0 with other numbers: the first one sent counts.
    scores.push({ ...scores[0]!, base: logs([0.05, 0.85, 0.05, 0.05]) });
    const s = summarizeDecisions({ ...input, test: { ...input.test, scores } });
    assert.deepEqual([s.items, s.testRows, s.unscoredRows], [5, 6, 1]);
    assert.deepEqual(s.base.accuracy, wilsonRate(3, 5));
    assert.deepEqual(s.tuned!.accuracy, wilsonRate(5, 5));
    assert.deepEqual([s.tunedWins, s.baseWins, s.ties], [2, 0, 3]);
    assert.deepEqual(s.base.decline, { rows: 5, declined: 1, rate: 0.2 });
    assert.deepEqual(s.tuned!.decline, { rows: 5, declined: 4, rate: 0.8 });
    assert.deepEqual(s.baselines.commonest.accuracy, wilsonRate(2, 5));
    assert.deepEqual(s.baselines.standIn.accuracy, wilsonRate(4, 5));
  });

  it("leaves out a row whose scores can't be log-probabilities", () => {
    const input = scenario();
    const scores = input.test.scores.map((x) => ({ ...x }));
    // Row 0's tuned scores put no probability on any letter. Read as an even split, they would pick Billing, row 0's
    // label, and credit tuned with a right answer it never gave.
    scores[0] = { ...scores[0]!, tuned: [-Infinity, -Infinity, -Infinity, -Infinity] };
    // Row 2's base scores came back as probabilities, not their logs: they hold more than all the probability.
    scores[2] = { ...scores[2]!, base: [...BASE[2]!] };
    const s = summarizeDecisions({ ...input, test: { ...input.test, scores } });
    // Rows 1, 3, 4 and 5 are left: base gets only row 4 right, tuned all but row 5.
    assert.deepEqual([s.items, s.testRows, s.unscoredRows], [4, 6, 2]);
    assert.deepEqual(s.base.accuracy, wilsonRate(1, 4));
    assert.deepEqual(s.tuned!.accuracy, wilsonRate(3, 4));
    assert.deepEqual([s.tunedWins, s.baseWins, s.ties], [2, 0, 2]);
    assert.deepEqual(s.tuned!.confusion, [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 1, 1, 0],
    ]);
    // Letter mass is only over the renderings left; the probabilities would have read as a healthy 1.
    approx(s.base.letterMass.min, 0.4);
    // The decline renderings were all scored as they should be.
    assert.deepEqual(s.base.decline, { rows: 6, declined: 2, rate: 2 / 6 });
    assert.deepEqual(s.baselines.commonest.accuracy, wilsonRate(1, 4));
    assert.deepEqual(s.baselines.standIn.accuracy, wilsonRate(2, 4));
  });

  it("fits T on dev only and shows ECE with it, without changing a pick", () => {
    const labels = ["Billing", "Shipping"].map(decisionLabel);
    const devRows = Array.from({ length: 20 }, (_, i): DecisionRow => ({ input: `dev ${i}`, label: i < 15 ? "billing" : "shipping" }));
    const testRows: DecisionRow[] = ["billing", "billing", "billing", "shipping"].map((label, i) => ({ input: `test ${i}`, label }));
    const devItems = decisionItems({ question: QUESTION, labels, rows: devRows, part: "dev" });
    const testItems = decisionItems({ question: QUESTION, labels, rows: testRows, part: "test" });
    const sure = [Math.log(0.9), Math.log(0.1), -Infinity];
    const score = (index: number): DecideScoreItem => ({ index, base: sure, tuned: null, baseMass: 1, tunedMass: null });
    const s = summarizeDecisions({
      labels,
      trainCounts: { billing: 30, shipping: 10 },
      dev: { rows: devRows, items: devItems, scores: devItems.map((it) => score(it.index)) },
      // Base only (scoreOnly), and the decline renderings were never scored.
      test: { rows: testRows, items: testItems, scores: testItems.filter((it) => !it.decline).map((it) => score(it.index)) },
    });
    // fitTemperature's case worked by hand: 0.9 on the first option, right on 15 of 20 dev rows, so T = 2, where a 0.9
    // becomes 0.75. On test every row picks Billing, right on 3 of 4.
    //   raw: all 4 rows in 0.9 to 1, confidence 0.9, accuracy 0.75, so ECE = 0.15
    //   with T: all 4 in 0.7 to 0.8, confidence 0.75, accuracy 0.75, so ECE = 0
    assert.equal(s.base.T, 2);
    assert.equal(s.base.calibrated, true);
    assert.deepEqual(s.base.accuracy, wilsonRate(3, 4));
    approx(s.base.ece.raw, 0.15);
    approx(s.base.ece.withT, 0);
    assert.equal(s.base.reliability[7]!.rows, 4);
    approx(s.base.reliability[7]!.confidence, 0.75);
    assert.equal(s.base.decline, null);
    assert.equal(s.tuned, null);
    assert.deepEqual([s.items, s.tunedWins, s.baseWins, s.ties], [4, 0, 0, 4]);
    assert.deepEqual(s.base.letterMass, { median: 1, min: 1 });
    assert.deepEqual(s.baselines.commonest, { id: "billing", accuracy: wilsonRate(3, 4) });
    // No word of "test 3" is in a label, so the stand-in ties to Billing on every row.
    assert.deepEqual(s.baselines.standIn.accuracy, wilsonRate(3, 4));
  });

  it("combines groups for more than 4 labels, and T keeps the pick", () => {
    const labels = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map(decisionLabel);
    const devRows = Array.from({ length: 20 }, (_, i): DecisionRow => ({ input: `dev ${i}`, label: "alpha" }));
    const testRows: DecisionRow[] = [{ input: "test", label: "alpha" }];
    const devItems = decisionItems({ question: QUESTION, labels, rows: devRows, part: "dev" });
    const testItems = decisionItems({ question: QUESTION, labels, rows: testRows, part: "test" });
    // Group 0 shows Alpha, Bravo, Charlie and none; group 1 Delta, Echo and none. Alpha (0.45, tied with Bravo and
    // first) beats Delta (0.4) once combined, and dividing each group's letters by T first would hand it to Delta.
    const score = (it: { index: number; group: number; decline: boolean }): DecideScoreItem => ({
      index: it.index,
      base: it.group === 0 ? logs([0.45, 0.45, 0.05, 0.05]) : logs([0.4, 0.3, 0.3]),
      tuned: null,
      baseMass: 1,
      tunedMass: null,
    });
    const s = summarizeDecisions({
      labels,
      trainCounts: {},
      dev: { rows: devRows, items: devItems, scores: devItems.map(score) },
      test: { rows: testRows, items: testItems, scores: testItems.filter((it) => !it.decline).map(score) },
    });
    assert.equal(s.groups, 2);
    // Alpha is always right on dev and shares the top with Bravo, so sharpening only helps: T goes to its bound.
    assert.equal(s.base.T, DECIDE_T_MIN);
    assert.deepEqual(s.base.accuracy, wilsonRate(1, 1));
    assert.deepEqual(s.base.confusion[0], [1, 0, 0, 0, 0, 0]);
    const combined = {
      labels: [
        { id: "alpha", p: (0.45 * 0.985) / 1.65 },
        { id: "bravo", p: (0.45 * 0.985) / 1.65 },
        { id: "charlie", p: (0.05 * 0.985) / 1.65 },
        { id: "delta", p: (0.4 * 0.985) / 1.65 },
        { id: "echo", p: (0.3 * 0.985) / 1.65 },
      ],
      none: 0.015,
    };
    approx(s.base.reliability.reduce((sum, b) => sum + b.confidence * b.rows, 0), temperedDecision(labels, combined, DECIDE_T_MIN).confidence);
    // No trainCounts: the first label is the commonest.
    assert.equal(s.baselines.commonest.id, "alpha");
  });

  it("refuses a layout that doesn't fit the rows or labels", () => {
    const input = scenario();
    assert.throws(() => summarizeDecisions({ ...input, labels: LABELS.slice(0, 1) }), /at least 2 labels/);
    assert.throws(() => summarizeDecisions({ ...input, labels: [LABELS[0]!, LABELS[0]!] }), /same id/);
    const far = [...input.test.items, { index: 99, row: 6, group: 0, labelIds: ["billing", null], decline: false }];
    assert.throws(() => summarizeDecisions({ ...input, test: { ...input.test, items: far } }), /row 6/);
    const unknown = TEST_ROWS.map((r, i) => (i === 0 ? { ...r, label: "refunds" } : r));
    assert.throws(() => summarizeDecisions({ ...input, test: { ...input.test, rows: unknown } }), /isn't one of/);
  });
});
