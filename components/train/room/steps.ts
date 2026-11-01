/**
 * A run on the chat kit (docs/UI_MUSE_APP.md): the steps panel's rows (StepItem), the working step in the conversation,
 * how the panel's list ends, and the mascot for the stage. Plain data only, so the room and the tests share it.
 *
 *   Plan approved -> Writing examples -> Checking them -> Training on a GPU -> Scoring base against tuned -> Ready
 *
 * Only the steps a run has reached are rows, as in the build room. The tuneRun workflow checks the examples (checking),
 * then launches, and while it waits for a GPU or a cap the panel and the working step say why (the run's hold). Once a
 * run is ready, the room itself has Try it live and, for admins, the Hugging Face card and Local files.
 */
import type { StepItem, StepsEnd } from "@/components/chat/types";
import { datasetMinutes, jobWorkingText, progressText, roughMinutes, writerName } from "@/components/train/format";
import { usd } from "@/lib/format";
import type { TuneRunView, TuneStage } from "@/lib/train/tune/types";

/** The mascot picture for each stage (components/build/PlanCard.tsx PLAN_ART). */
export type TuneArt = "present" | "building" | "shield";

/**
 * Presenting while it is planned, failed or stopped; building while anything runs or waits; the pair once it's scored.
 * A ready run that wasn't scored presents (tuneArt): only a judged run gets the pair.
 */
export const TUNE_ART: Record<TuneStage, TuneArt> = {
  writing: "building",
  checking: "building",
  waiting: "building",
  training: "building",
  scoring: "building",
  ready: "shield",
  failed: "present",
  stopped: "present",
};

/** The mascot for this run: its stage's, except a ready run nothing was judged on, which presents. */
export function tuneArt(v: Pick<TuneRunView, "stage" | "verdict">): TuneArt {
  if (v.stage === "ready" && !v.verdict?.scored) return "present";
  return TUNE_ART[v.stage];
}

const ORDER: readonly TuneStage[] = ["writing", "checking", "waiting", "training", "scoring", "ready"];

/** True once the run is at or past `stage` (a failed or stopped run counts by what it reached). */
function reached(v: Pick<TuneRunView, "stage" | "dataset" | "job">, stage: TuneStage): boolean {
  if (v.stage === "failed" || v.stage === "stopped") {
    const at = v.job ? (v.job.status === "succeeded" ? "scoring" : "training") : v.dataset.status === "ready" ? "checking" : "writing";
    return ORDER.indexOf(stage) <= ORDER.indexOf(at);
  }
  return ORDER.indexOf(stage) <= ORDER.indexOf(v.stage);
}

function writingText(v: TuneRunView): string {
  const d = v.dataset;
  if (d.status === "generating") return `${v.written ?? 0} of ${d.requested} · ${usd(d.costUsd)} so far`;
  if (d.status === "failed") return v.problem ?? "The examples couldn't be written.";
  return `${d.trainCount + d.evalCount} examples by ${writerName(d)} · ${usd(d.costUsd)}`;
}

function trainingText(v: TuneRunView): string {
  const job = v.job;
  const limits = `${v.gpuLabel}, up to ${v.plan.maxMinutes} minutes and ${usd(v.plan.maxUsd)}`;
  if (!job) return limits;
  if (job.status === "succeeded") return `${v.gpuLabel} · ${usd(job.costUsd)}`;
  if (job.status === "failed" || job.status === "stopped") return v.problem ?? jobWorkingText(job);
  const progress = job.progress ? ` · ${progressText(job.progress)}` : "";
  return `${jobWorkingText(job)}${progress} · ${usd(job.costUsd)} so far`;
}

function scoringText(v: TuneRunView): string {
  if (v.verdict) return v.verdict.words;
  const judged = v.evals.filter((r) => r.judgement).length;
  return v.evals.length ? `Judged ${judged} of ${v.evals.length} kept-aside prompts` : "The 2026 Glimmer and the tuned model answer the kept-aside prompts";
}

/** The steps panel's rows. */
export function tuneSteps(v: TuneRunView): StepItem[] {
  const rows: StepItem[] = [
    {
      id: "plan",
      title: "Plan approved",
      description: `${v.dataset.requested} examples, ${v.plan.steps} training steps, up to ${usd(v.plan.maxUsd)} for the GPU`,
      state: "done",
    },
  ];
  const writingFailed = v.dataset.status === "failed" || (v.stage === "failed" && v.dataset.status === "generating");
  rows.push({
    id: "writing",
    title: "Writing examples",
    description: writingText(v),
    state: writingFailed ? "failed" : v.dataset.status === "ready" ? "done" : "running",
  });
  if (v.dataset.status !== "ready") return rows;
  const short = v.stage === "failed" && !v.job;
  rows.push({
    id: "checking",
    title: "Checking the examples",
    description: short ? (v.problem ?? "") : `${v.dataset.trainCount} to train on, ${v.dataset.evalCount} kept aside to score it`,
    state: short ? "failed" : v.stage === "checking" ? "running" : "done",
  });
  const held = waitingFor(v);
  if (held) rows.push({ id: "waiting", title: held.title, description: held.description, state: "running" });
  if (!v.job) return rows;
  const job = v.job;
  const ended = job.status === "succeeded" || job.status === "failed" || job.status === "stopped";
  rows.push({
    id: "training",
    title: "Training on a GPU",
    description: trainingText(v),
    state: !ended ? "running" : job.status === "succeeded" ? "done" : "failed",
  });
  if (!reached(v, "scoring") || job.status !== "succeeded") return rows;
  rows.push({ id: "scoring", title: "Scoring base against tuned", description: scoringText(v), state: v.stage === "scoring" ? "running" : "done" });
  if (v.stage === "ready") rows.push({ id: "ready", title: "Ready", description: v.verdict?.words ?? "Not scored.", state: "done" });
  return rows;
}

/** How the panel's list ends: Done once it's scored, Stopped or Didn't finish when it ended early, nothing while it runs or waits. */
export function tuneStepsEnd(v: Pick<TuneRunView, "stage">): StepsEnd | undefined {
  if (v.stage === "ready") return "done";
  if (v.stage === "stopped") return "stopped";
  if (v.stage === "failed") return "unfinished";
  return undefined;
}

/** What the run waits for, as the step's title: a GPU only when the wait is about one. */
const WAIT_TITLES: Partial<Record<NonNullable<TuneRunView["hold"]>["reason"], string>> = {
  daily_cap: "Waiting for the daily budget",
  paused: "Waiting for the spend cap",
  sweep_not_running: "Waiting for the GPU check",
  lambda_unavailable: "Waiting for Lambda",
};

/** While the tuneRun workflow waits to launch (a GPU, a cap, the sweep), what for and why; null otherwise, and when nothing is trying. */
function waitingFor(v: Pick<TuneRunView, "stage" | "hold">): { title: string; description: string } | null {
  if (v.stage !== "waiting" || !v.hold || v.hold.reason === "not_started" || v.hold.reason === "stopped") return null;
  return { title: WAIT_TITLES[v.hold.reason] ?? "Waiting for a GPU", description: v.hold.text };
}

/**
 * The working step in the conversation while something runs or the workflow waits to launch, or null once nothing does
 * (waiting on a person, ready, ended).
 */
export function tuneCurrentStep(v: TuneRunView): { title: string; description: string } | null {
  switch (v.stage) {
    case "writing":
      return { title: "Writing examples", description: `${writerName(v.dataset)} has written ${v.written ?? 0} of ${v.dataset.requested}. Writing them all takes ${roughMinutes(datasetMinutes(v.dataset.requested))}.` };
    case "checking":
      return { title: "Checking the examples", description: "Making sure there are enough to train on and to score with." };
    case "waiting": {
      return waitingFor(v);
    }
    case "training":
      return { title: "Training on a GPU", description: trainingText(v) };
    case "scoring":
      return { title: "Scoring base against tuned", description: scoringText(v) };
    default:
      return null;
  }
}

/** True while the room should keep asking for the run: until it's ready, failed or stopped, or waits on a person. */
export function tuneRunning(v: Pick<TuneRunView, "stage">): boolean {
  return v.stage === "writing" || v.stage === "checking" || v.stage === "training" || v.stage === "scoring";
}
