/**
 * A run as its room shows it (GET /api/train/runs/{id} and the page at /fine-tuning/runs/{id}), from its dataset row,
 * the training job made from it, and that job's eval items. Pure: the route and the page read the rows and pass them in.
 */
import { evalRows, evalState, gpuName, isDatasetStalled, type EvalRow } from "@/components/train/format";
import { toDatasetView, toJobView, unjudgedNote, type DatasetHead, type TrainJobRow } from "@/lib/train/logic";
import { isJudged } from "@/lib/train/models";
import { recipeById } from "@/lib/train/recipes";
import { planCost, planSettings } from "@/lib/train/tune/cost";
import { examplesProblem } from "@/lib/train/tune/settings";
import { checkText, endedText, freshHeartbeat, isCheckCode, isWaitReason, NO_MARKS, waitText, type RunMarks } from "@/lib/train/tune/marks";
import { evalVerdict } from "@/lib/train/tune/verdict";
import type { RunVerdict, TuneHoldReason, TuneRunView, TuneSettings, TuneStage } from "@/lib/train/tune/types";
import type { DatasetView, TrainEventView, TrainJobView } from "@/lib/train/types";

// The examples check's counts live with the settings (no components/ import), for the tuneRun workflow's steps.
export { examplesProblem, TUNE_MIN_EVAL, TUNE_MIN_TRAIN } from "@/lib/train/tune/settings";

/** The full New job form with this dataset picked: the admins' "Use the full form" link beside Start training. */
export function fullFormHref(datasetId: string): string {
  return `/fine-tuning?dataset=${encodeURIComponent(datasetId)}#new-job`;
}

const num = (v: unknown, fallback: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The settings the run trains with: the job's own once there is one, else the defaults for the dataset's size with the
 * steps it was started with (Advanced, kept in its marks).
 */
function runSettings(d: DatasetView, job: TrainJobView | null, ceilings: { maxMinutes: number; maxUsd: number }, steps: number | null): TuneSettings {
  // The dataset's own size, as it was asked for, even outside what a new plan may ask for.
  const base = { ...planSettings(d.requested, ceilings, steps ?? undefined), examples: d.requested };
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
  hold: { reason: TuneHoldReason; text: string; since: string } | null;
}

/**
 * Where the run stands, from its dataset, its job, the job's eval items and the run's marks (its heartbeat, why it
 * ended, whether it was stopped). Ready examples with no job: stopped, failed the examples check, checking (a fresh
 * "checking" heartbeat), waiting for a reason (a fresh waiting heartbeat), or waiting with nothing trying to train on
 * them ("not_started", with why the last try ended when there was one).
 */
export function tuneStage(d: DatasetView, job: TrainJobView | null, evals: EvalRow[], now: number, marks: RunMarks = NO_MARKS): StageOf {
  const none = { hold: null };
  if (!job && marks.stopped) {
    return { stage: "stopped", problem: "This run was stopped before training.", hold: { reason: "stopped", text: "This run was stopped before training.", since: d.finishedAt ?? d.createdAt } };
  }
  if (d.status === "generating") {
    return isDatasetStalled(d, now)
      ? { stage: "failed", problem: "Writing the examples stopped partway, so this run can't go on.", ...none }
      : { stage: "writing", problem: null, ...none };
  }
  if (d.status === "failed") return { stage: "failed", problem: d.error?.trim() || "The examples couldn't be written.", ...none };
  const short = examplesProblem(d);
  if (short) return { stage: "failed", problem: short, ...none };
  if (!job) {
    if (marks.ended && isCheckCode(marks.ended)) return { stage: "failed", problem: checkText(marks.ended), ...none };
    const beat = freshHeartbeat(marks, now);
    if (beat?.state === "checking") return { stage: "checking", problem: null, ...none };
    if (beat && isWaitReason(beat.state)) {
      return { stage: "waiting", problem: null, hold: { reason: beat.state, text: waitText(beat.state), since: beat.since.toISOString() } };
    }
    const text = marks.ended ? `${endedText(marks.ended)} Start training tries again.` : "The examples are ready. Training hasn't started yet.";
    return { stage: "waiting", problem: null, hold: { reason: "not_started", text, since: d.finishedAt ?? d.createdAt } };
  }
  if (job.status === "failed") return { stage: "failed", problem: lastLine(job.error) || "Training failed.", ...none };
  if (job.status === "stopped") return { stage: "stopped", problem: "Training was stopped before it finished.", ...none };
  if (job.status !== "succeeded") return { stage: "training", problem: null, ...none };
  const scored = evalState(job, evals, now);
  if (scored.state === "judging" || scored.state === "answering") return { stage: "scoring", problem: null, ...none };
  return { stage: "ready", problem: null, ...none };
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
  /** What the run keeps in rate_limits (readRunMarks): its steps, heartbeat, ending and stop. None when left out. */
  marks?: RunMarks;
}

/** POST this to start training a run whose examples are ready (app/api/train/runs/[id]/start). */
export function startHref(datasetId: string): string {
  return `/api/train/runs/${encodeURIComponent(datasetId)}/start`;
}

export function tuneRunView(rows: RunRows, now: Date, ceilings: { maxMinutes: number; maxUsd: number }): TuneRunView {
  const dataset = toDatasetView(rows.dataset);
  const job = rows.job ? toJobView(rows.job, now) : null;
  const evals = job ? evalRows(rows.events) : [];
  const marks = rows.marks ?? NO_MARKS;
  const { stage, problem, hold } = tuneStage(dataset, job, evals, now.getTime(), marks);
  const settings = runSettings(dataset, job, ceilings, marks.steps);
  const judgeCost = job?.evalSummary?.judgeCostUsd ?? 0;
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
    hold,
    problem,
    costSoFarUsd: Math.round((dataset.costUsd + (job?.costUsd ?? 0) + (Number(judgeCost) || 0)) * 1e6) / 1e6,
    next: job
      ? { kind: "job", href: `/fine-tuning/${job.id}` }
      : stage === "waiting"
        ? { kind: "start", start: startHref(dataset.id), fullForm: fullFormHref(dataset.id) }
        : null,
  };
}
