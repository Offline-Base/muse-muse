/**
 * What a run is expected to cost and take (docs/TRAINING.md "Fine-tune like a build"), and its fixed defaults
 * (./settings.ts, re-exported here). Pure and browser-safe, so the plan card's Advanced fold shows the same numbers the
 * server makes again on Start.
 */
import { datasetCostRange, datasetMinutes } from "@/components/train/format";
import { tokenCost } from "@/lib/meta/pricing";
import { evalHoldoutCount, runEstimate } from "@/lib/train/logic";
import type { TrainPlanCost, TuneSettings } from "@/lib/train/tune/types";

export * from "@/lib/train/tune/settings";

/** The model whose prices the estimates use: Muse Wonder writes the examples and scores the run. */
const PRICED_MODEL = "muse-wonder-1.0";
/** Minutes the platform takes to score base against tuned after the GPU shuts down. */
const SCORE_MINUTES = 5;
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
