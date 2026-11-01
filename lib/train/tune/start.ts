/**
 * Starts a run from a verified plan (POST /api/train/runs): saves the dataset and starts the makeDataset workflow, the
 * way POST /api/train/datasets does. The run is that dataset, so its id is the run's id and its room is
 * /fine-tuning/runs/{id}. A plan for a dataset that already exists starts nothing new.
 *
 * Then it starts the tuneRun workflow (lib/train/tune/run.ts), which waits for the examples, checks them and launches
 * the training job through launchJob with the run's settings and publish 0. A tuneRun that couldn't start leaves the
 * examples writing, and the room offers Start training once they're ready (lib/train/tune/view.ts).
 */
import { start } from "workflow/api";
import { testModel } from "@/lib/env";
import { DATASET_MODEL, makeDataset } from "@/lib/train/datasets";
import { attachDatasetRun, createDataset, failDataset, getDataset } from "@/lib/train/store";
import { TUNE_STEPS } from "@/lib/train/tune/settings";
import { freshHeartbeat } from "@/lib/train/tune/marks";
import { tuneRun } from "@/lib/train/tune/run";
import { latestTuneJob, readRunMarks, saveRunProduct, saveRunSteps } from "@/lib/train/tune/run-store";
import type { TrainPlanBody } from "@/lib/train/tune/types";

/** A refusal startTuneRun's caller turns into a JSON reply with this status and code. */
export class TuneStartError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** The room's address for a run. */
export function runHref(runId: string): string {
  return `/fine-tuning/runs/${runId}`;
}

/**
 * Starts the tuneRun workflow for a run, which trains it once its examples are ready. Logged, never thrown: without
 * it the examples are still written, and the room offers Start training once they're ready.
 */
export async function startTraining(datasetId: string, callerId: string, steps: number): Promise<boolean> {
  try {
    await start(tuneRun, [{ datasetId, callerId, steps }]);
    return true;
  } catch (err) {
    console.error("[train/tune] start tuneRun", err);
    return false;
  }
}

/**
 * Saves the plan's dataset (its name as the title, written as a role for the short student prompt; its task; its size)
 * and starts makeDataset on it. The writer is Muse Wonder, or TEST_MODEL where that is on (never on production), so a
 * made-up test run costs a cent. The plan's training steps are kept with the run (saveRunSteps), and tuneRun starts
 * on it. A plan or `datasetId` for a dataset that already exists starts nothing new, except tuneRun for a chat dataset
 * with no training job and nothing already trying to train it (no fresh heartbeat), so unit 11's "Train on my data"
 * trains a ready dataset the same way. A build plan (B, the build room's "Its own model") starts like a task plan. The
 * product a run is for (`productId`, or a build plan's own) is kept with the run (saveRunProduct, in rate_limits, no
 * migration) until wave 3's 0025 adds training_jobs.product_id and fills it from there.
 */
export async function startTuneRun(i: {
  plan?: TrainPlanBody;
  datasetId?: string;
  callerId: string;
  productId?: string | null;
}): Promise<{ runId: string; href: string }> {
  const source = i.plan?.source ?? (i.datasetId ? { kind: "dataset" as const, datasetId: i.datasetId } : null);
  if (!source) throw new TuneStartError(400, "no_plan");
  const productId = i.productId ?? (source.kind === "build" ? source.productId : null);
  const buildId = source.kind === "build" ? source.buildId : null;
  const keepProduct = (runId: string) =>
    productId ? saveRunProduct(runId, productId, buildId).catch((err) => console.error("[train/tune] save product", err)) : Promise.resolve();
  if (source.kind === "dataset") {
    const existing = await getDataset(source.datasetId);
    if (!existing) throw new TuneStartError(404, "not_found");
    await keepProduct(existing.id);
    if (existing.kind !== "decision" && existing.status !== "failed") {
      const [job, marks] = await Promise.all([latestTuneJob(existing.id), readRunMarks(existing.id)]);
      if (!job && !marks.stopped && !freshHeartbeat(marks, Date.now())) {
        const steps = i.plan?.settings.steps ?? marks.steps ?? TUNE_STEPS;
        if (i.plan) await saveRunSteps(existing.id, steps).catch((err) => console.error("[train/tune] save steps", err));
        await startTraining(existing.id, i.callerId, steps);
      }
    }
    return { runId: existing.id, href: runHref(existing.id) };
  }
  const plan = i.plan!;
  const dataset = await createDataset({
    title: plan.name,
    task: plan.task,
    requested: plan.settings.examples,
    writerModel: testModel() ?? DATASET_MODEL,
    createdBy: i.callerId,
  });
  let workflowRunId: string;
  try {
    workflowRunId = (await start(makeDataset, [{ datasetId: dataset.id }])).runId;
  } catch (err) {
    console.error("[train/tune] start", err);
    await failDataset(dataset.id, "The dataset's workflow could not start, so nothing was written.").catch((e) =>
      console.error("[train/tune] markStartFailed", e),
    );
    throw new TuneStartError(500, "start_failed");
  }
  await attachDatasetRun(dataset.id, workflowRunId).catch((err) => console.error("[train/tune] attachRun", err));
  await keepProduct(dataset.id);
  await saveRunSteps(dataset.id, plan.settings.steps).catch((err) => console.error("[train/tune] save steps", err));
  await startTraining(dataset.id, i.callerId, plan.settings.steps);
  return { runId: dataset.id, href: runHref(dataset.id) };
}
