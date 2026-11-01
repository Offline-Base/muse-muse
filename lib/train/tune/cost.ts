/**
 * A run's fixed defaults and what it is expected to cost and take (docs/TRAINING.md "Fine-tune like a build"). Pure and
 * browser-safe, so the plan card's Advanced fold shows the same numbers the server makes again on Start.
 */
import { datasetCostRange, datasetMinutes } from "@/components/train/format";
import { tokenCost } from "@/lib/meta/pricing";
import { DATASET_MAX_COUNT, evalHoldoutCount, runEstimate } from "@/lib/train/logic";
import type { TrainPlanCost, TuneSettings } from "@/lib/train/tune/types";

/** The model whose prices the estimates use: Muse Wonder writes the examples and scores the run. */
const PRICED_MODEL = "muse-wonder-1.0";

export const TUNE_STEPS = 120;
export const TUNE_LORA_RANK = 16;
export const TUNE_LEARNING_RATE = 0.0002;
/** The A100 SXM4 trained Muse Glimmer's measured runs (42 to 47 minutes, $1.39 to $1.59). */
export const TUNE_GPU = "gpu_1x_a100_sxm4";
export const TUNE_MAX_MINUTES = 90;
/** Minutes the platform takes to score base against tuned after the GPU shuts down. */
const SCORE_MINUTES = 5;

/** Words the person types, before their own rows are folded in. */
export const NOTE_MIN = 20;
export const NOTE_MAX = 1500;

/** The settings every run starts with: `examples` examples, the job's limits within the platform's ceilings. */
export function planSettings(examples: number, ceilings: { maxMinutes: number; maxUsd: number }): TuneSettings {
  return {
    examples: clampExamples(examples),
    recipe: "glimmer-lora",
    steps: TUNE_STEPS,
    loraRank: TUNE_LORA_RANK,
    learningRate: TUNE_LEARNING_RATE,
    studentPrompt: "short",
    publish: 0,
    gpu: TUNE_GPU,
    maxMinutes: Math.max(1, Math.min(TUNE_MAX_MINUTES, Math.floor(ceilings.maxMinutes))),
    maxUsd: Math.max(0.1, Math.floor(ceilings.maxUsd * 100 + 1e-6) / 100),
  };
}

/**
 * The fewest examples a run asks for. A run trains only with at least 16 to train on and 8 to score with (TUNE_MIN_TRAIN
 * and TUNE_MIN_EVAL in view.ts), so 24 at the least, and a dataset often comes back a little short of what it asked for.
 * 40 leaves room for that, where the datasets route's own 20 would fail every time after the writing was paid for.
 */
export const TUNE_MIN_EXAMPLES = 40;
/** The most a run asks for: the datasets route's own limit. */
export const TUNE_MAX_EXAMPLES = DATASET_MAX_COUNT;

/** A whole number of examples a run may ask for (TUNE_MIN_EXAMPLES to TUNE_MAX_EXAMPLES, 40 to 1000). */
export function clampExamples(n: number): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(TUNE_MAX_EXAMPLES, Math.max(TUNE_MIN_EXAMPLES, v)) : TUNE_MIN_EXAMPLES;
}

/**
 * Advanced's number of examples from a request body's `settings`: undefined when it isn't given, else a whole number
 * from TUNE_MIN_EXAMPLES to `max` (the caller's own most, tuneExamplesMax), or the 400's sentence.
 */
export function askedExamples(settings: unknown, max: number): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const asked = settings && typeof settings === "object" ? (settings as Record<string, unknown>).examples : undefined;
  if (asked === undefined) return { ok: true, value: undefined };
  const top = Math.min(TUNE_MAX_EXAMPLES, Math.floor(max));
  if (typeof asked !== "number" || !Number.isInteger(asked) || asked < TUNE_MIN_EXAMPLES || asked > top) {
    return { ok: false, error: `examples must be a whole number from ${TUNE_MIN_EXAMPLES} to ${top}.` };
  }
  return { ok: true, value: asked };
}

/** Rough tokens to judge one kept-aside prompt (the prompt, the reference and both answers in; a verdict out), low and high. */
const SCORE_PER_ITEM = {
  low: { inputTokens: 1000, outputTokens: 250 },
  high: { inputTokens: 2500, outputTokens: 900 },
};

/**
 * What a run with these settings is expected to cost and take. Writing and scoring are estimates at Muse Wonder's
 * prices (datasetCostRange: its cost per example isn't measured yet). The GPU is the job's hard dollar limit.
 */
export function planCost(s: TuneSettings): TrainPlanCost {
  const meta = datasetCostRange(s.examples);
  const items = evalHoldoutCount(s.examples);
  const train = runEstimate(s.recipe, { maxSteps: s.steps }, s.gpu, true);
  const trainMinutes = Math.min(s.maxMinutes, train?.minutes ?? s.maxMinutes);
  return {
    metaLowUsd: meta.low,
    metaHighUsd: meta.high,
    gpuMaxUsd: s.maxUsd,
    scoreLowUsd: Math.floor(tokenCost(PRICED_MODEL, SCORE_PER_ITEM.low) * items * 100) / 100,
    scoreHighUsd: Math.ceil(tokenCost(PRICED_MODEL, SCORE_PER_ITEM.high) * items * 100) / 100,
    minutes: datasetMinutes(s.examples) + trainMinutes + SCORE_MINUTES,
    trainMinutes,
  };
}

/** The most a run is expected to cost: the high estimates plus the GPU's limit. */
export function planMaxUsd(c: TrainPlanCost): number {
  return Math.round((c.metaHighUsd + c.gpuMaxUsd + c.scoreHighUsd) * 100) / 100;
}
