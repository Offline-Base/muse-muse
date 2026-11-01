/**
 * A run's fixed defaults and what it is expected to cost and take (docs/TRAINING.md "Fine-tune like a build"). Pure and
 * browser-safe, so the plan card's Advanced fold shows the same numbers the server makes again on Start.
 */
import { datasetCostRange, datasetMinutes } from "@/components/train/format";
import { tokenCost } from "@/lib/meta/pricing";
import { DATASET_MAX_COUNT, DATASET_MIN_COUNT, evalHoldoutCount, runEstimate } from "@/lib/train/logic";
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

/** A whole number of examples the datasets route takes (20 to 1000). */
export function clampExamples(n: number): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(DATASET_MAX_COUNT, Math.max(DATASET_MIN_COUNT, v)) : DATASET_MIN_COUNT;
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
