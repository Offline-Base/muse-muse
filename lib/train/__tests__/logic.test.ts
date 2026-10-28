import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  betterOf,
  BOOT_GRACE_MS,
  capEventBody,
  clampLimits,
  datasetSystemPrompt,
  decideCheck,
  dedupePrompts,
  EVAL_TEXT_MAX,
  evalHoldoutCount,
  evalIndexes,
  evalSplit,
  EVENT_LOG_MAX,
  estimateCostUsd,
  GLIMMER_OVERHEAD_MINUTES,
  GLIMMER_OVERHEAD_NO_CACHE_MINUTES,
  instanceNameFor,
  isNearDuplicate,
  judgeScore,
  type JobState,
  PARAM_TEXT_MAX,
  promptWords,
  runEstimate,
  runFitProblem,
  SILENCE_MS,
  summarizeJudgements,
  toDatasetView,
  toJobView,
  type TrainJobRow,
  unjudgedNote,
  unjudgedSummary,
  usableMinutes,
  validateParams,
} from "@/lib/train/logic";
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
    });
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
