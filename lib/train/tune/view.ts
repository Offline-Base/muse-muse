/**
 * A run as its room shows it (GET /api/train/runs/{id} and the page at /fine-tuning/runs/{id}), from its dataset row,
 * the training job made from it, and that job's eval items. Pure: the route and the page read the rows and pass them in.
 */
import { evalRows, evalState, gpuName, isDatasetStalled, type EvalRow } from "@/components/train/format";
import { toDatasetView, toJobView, unjudgedNote, type DatasetHead, type TrainJobRow } from "@/lib/train/logic";
import { isJudged } from "@/lib/train/models";
import { recipeById } from "@/lib/train/recipes";
import { planCost, planSettings } from "@/lib/train/tune/cost";
import { evalVerdict } from "@/lib/train/tune/verdict";
import type { RunVerdict, TuneRunView, TuneSettings, TuneStage } from "@/lib/train/tune/types";
import type { DatasetView, TrainEventView, TrainJobView } from "@/lib/train/types";

/** A run trains only when its examples leave at least this many to train on and to score with. */
export const TUNE_MIN_TRAIN = 16;
export const TUNE_MIN_EVAL = 8;

/** Why a ready dataset can't train, or null when its counts are enough. */
export function examplesProblem(d: Pick<DatasetView, "trainCount" | "evalCount">): string | null {
  if (d.trainCount >= TUNE_MIN_TRAIN && d.evalCount >= TUNE_MIN_EVAL) return null;
  return `It has ${d.trainCount} examples to train on and ${d.evalCount} to score with, and a run needs at least ${TUNE_MIN_TRAIN} and ${TUNE_MIN_EVAL}.`;
}

/** The full New job form with this dataset picked: what Ready to train opens until U3's Start training replaces it. */
export function fullFormHref(datasetId: string): string {
  return `/fine-tuning?dataset=${encodeURIComponent(datasetId)}#new-job`;
}

const num = (v: unknown, fallback: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** The settings the run trains with: the job's own once there is one, else the defaults for the dataset's size. */
function runSettings(d: DatasetView, job: TrainJobView | null, ceilings: { maxMinutes: number; maxUsd: number }): TuneSettings {
  // The dataset's own size, as it was asked for, even outside what a new plan may ask for.
  const base = { ...planSettings(d.requested, ceilings), examples: d.requested };
  if (!job) return base;
  const p = job.params ?? {};
  return {
    ...base,
    steps: num(p.maxSteps, base.steps),
    loraRank: num(p.loraRank, base.loraRank),
    learningRate: num(p.learningRate, base.learningRate),
    gpu: job.instanceType || base.gpu,
    maxMinutes: job.maxMinutes,
    maxUsd: job.maxUsd,
  };
}

interface StageOf {
  stage: TuneStage;
  problem: string | null;
}

/** Where the run stands, from its dataset, its job and the job's eval items. */
export function tuneStage(d: DatasetView, job: TrainJobView | null, evals: EvalRow[], now: number): StageOf {
  if (d.status === "generating") {
    return isDatasetStalled(d, now)
      ? { stage: "failed", problem: "Writing the examples stopped partway, so this run can't go on." }
      : { stage: "writing", problem: null };
  }
  if (d.status === "failed") return { stage: "failed", problem: d.error?.trim() || "The examples couldn't be written." };
  const short = examplesProblem(d);
  if (short) return { stage: "failed", problem: short };
  if (!job) return { stage: "waiting", problem: null };
  if (job.status === "failed") return { stage: "failed", problem: lastLine(job.error) || "Training failed." };
  if (job.status === "stopped") return { stage: "stopped", problem: "Training was stopped before it finished." };
  if (job.status !== "succeeded") return { stage: "training", problem: null };
  const scored = evalState(job, evals, now);
  if (scored.state === "judging" || scored.state === "answering") return { stage: "scoring", problem: null };
  return { stage: "ready", problem: null };
}

function lastLine(text: string | null | undefined): string {
  return (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 300) ?? "";
}

/**
 * The verdict once the job trained and judging ended, from the same evalState EvalResults shows: passed or not with its
 * sentence when it was judged, else why it wasn't scored (judging timed out, judged nothing, or there was nothing to
 * judge), which never passes. Null while it trains or is scored, and for a job that didn't succeed. The words always say
 * whether it passed, so the room can show them as they are.
 */
export function runVerdict(job: TrainJobView | null, evals: EvalRow[], now: number): RunVerdict | null {
  if (!job || job.status !== "succeeded") return null;
  const scored = evalState(job, evals, now);
  if (scored.state === "judged") return { ...evalVerdict(scored.summary), scored: isJudged(scored.summary) };
  // The reason saved on the job (a spend cap, a skipped judge) comes first, even with no eval items to show.
  const note = unjudgedNote(job.evalSummary);
  if (note) return { passed: false, scored: false, words: `${note} It wasn't scored, so it hasn't passed.` };
  if (scored.state === "unjudged") return { passed: false, scored: false, words: `${scored.reason} It wasn't scored, so it hasn't passed.` };
  if (scored.state === "none") return { passed: false, scored: false, words: "It had no kept-aside prompts to score, so it hasn't passed." };
  return null;
}

export interface RunRows {
  dataset: DatasetHead;
  /** Examples written so far while the dataset is being written (datasetProgress). */
  written: number | null;
  job: TrainJobRow | null;
  events: TrainEventView[];
}

export function tuneRunView(rows: RunRows, now: Date, ceilings: { maxMinutes: number; maxUsd: number }): TuneRunView {
  const dataset = toDatasetView(rows.dataset);
  const job = rows.job ? toJobView(rows.job, now) : null;
  const evals = job ? evalRows(rows.events) : [];
  const { stage, problem } = tuneStage(dataset, job, evals, now.getTime());
  const settings = runSettings(dataset, job, ceilings);
  const judgeCost = job?.evalSummary?.judgeCostUsd ?? 0;
  const since = dataset.finishedAt ?? dataset.createdAt;
  return {
    id: dataset.id,
    title: dataset.title,
    task: dataset.task,
    stage,
    plan: { ...settings, ...planCost(settings) },
    gpuLabel: gpuName(recipeById("glimmer-lora"), settings.gpu),
    dataset,
    written: dataset.status === "generating" ? (rows.written ?? 0) : null,
    job,
    evals,
    verdict: runVerdict(job, evals, now.getTime()),
    hold: stage === "waiting" ? { reason: "not_started", text: "The examples are ready. Training hasn't started yet.", since } : null,
    problem,
    costSoFarUsd: Math.round((dataset.costUsd + (job?.costUsd ?? 0) + (Number(judgeCost) || 0)) * 1e6) / 1e6,
    next: job ? { kind: "job", href: `/fine-tuning/${job.id}` } : stage === "waiting" ? { kind: "full_form", href: fullFormHref(dataset.id) } : null,
  };
}
