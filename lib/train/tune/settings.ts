/**
 * A run's fixed defaults and the limits Advanced may change them within (docs/TRAINING.md "Fine-tune like a build"). Pure
 * and browser-safe, with no import from components/, so the tuneRun workflow's steps (lib/train/tune/run-launch.ts) use
 * the same numbers as the plan card. cost.ts adds what a run costs and re-exports all of it.
 */
import { DATASET_MAX_COUNT, runEstimate } from "@/lib/train/logic";
import type { TuneSettings } from "@/lib/train/tune/types";
import type { DatasetView } from "@/lib/train/types";

export const TUNE_STEPS = 120;
export const TUNE_LORA_RANK = 16;
export const TUNE_LEARNING_RATE = 0.0002;
/** The A100 SXM4 trained Muse Glimmer's measured runs (42 to 47 minutes, $1.39 to $1.59). */
export const TUNE_GPU = "gpu_1x_a100_sxm4";
export const TUNE_MAX_MINUTES = 90;
/** Words the person types, before their own rows are folded in. */
export const NOTE_MIN = 20;
export const NOTE_MAX = 1500;

/**
 * The settings every run starts with: `examples` examples, `steps` training steps (TUNE_STEPS unless Advanced changed
 * them, held to the recipe's 10 to 2000), the job's limits within the platform's ceilings.
 */
export function planSettings(examples: number, ceilings: { maxMinutes: number; maxUsd: number }, steps: number = TUNE_STEPS): TuneSettings {
  return {
    examples: clampExamples(examples),
    recipe: "glimmer-lora",
    steps: clampSteps(steps),
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

/** The glimmer-lora recipe's own limits on its maxSteps param (lib/train/recipes/index.ts; a test keeps them equal). */
export const TUNE_MIN_STEPS = 10;
export const TUNE_MAX_STEPS = 2000;

/** A whole number of training steps the recipe takes (TUNE_MIN_STEPS to TUNE_MAX_STEPS). */
export function clampSteps(n: number): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(TUNE_MAX_STEPS, Math.max(TUNE_MIN_STEPS, v)) : TUNE_STEPS;
}

/**
 * The most training steps that fit in a run's time limit on its first GPU, where the model is cached (runEstimate), so
 * Advanced never offers a number the launch would refuse for its time. At least TUNE_MIN_STEPS.
 */
export function maxStepsFor(s: Pick<TuneSettings, "recipe" | "gpu" | "maxMinutes">): number {
  let lo = TUNE_MIN_STEPS;
  let hi = TUNE_MAX_STEPS;
  const fits = (steps: number) => (runEstimate(s.recipe, { maxSteps: steps }, s.gpu, true)?.minutes ?? 0) <= s.maxMinutes;
  if (fits(hi)) return hi;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Advanced's training steps from a request body's `settings`: undefined when they aren't given, else a whole number
 * from TUNE_MIN_STEPS to `max` (maxStepsFor the run's settings), or the 400's sentence.
 */
export function askedSteps(settings: unknown, max: number): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const asked = settings && typeof settings === "object" ? (settings as Record<string, unknown>).steps : undefined;
  if (asked === undefined) return { ok: true, value: undefined };
  const top = Math.max(TUNE_MIN_STEPS, Math.min(TUNE_MAX_STEPS, Math.floor(max)));
  if (typeof asked !== "number" || !Number.isInteger(asked) || asked < TUNE_MIN_STEPS || asked > top) {
    return { ok: false, error: `steps must be a whole number from ${TUNE_MIN_STEPS} to ${top}.` };
  }
  return { ok: true, value: asked };
}

/** A run trains only when its examples leave at least this many to train on and to score with. */
export const TUNE_MIN_TRAIN = 16;
export const TUNE_MIN_EVAL = 8;

/** Why a ready dataset can't train, or null when its counts are enough. */
export function examplesProblem(d: Pick<DatasetView, "trainCount" | "evalCount">): string | null {
  if (d.trainCount >= TUNE_MIN_TRAIN && d.evalCount >= TUNE_MIN_EVAL) return null;
  return `It has ${d.trainCount} examples to train on and ${d.evalCount} to score with, and a run needs at least ${TUNE_MIN_TRAIN} and ${TUNE_MIN_EVAL}.`;
}
