/**
 * Starts a run from a verified plan (POST /api/train/runs): saves the dataset and starts the makeDataset workflow, the
 * way POST /api/train/datasets does. The run is that dataset, so its id is the run's id and its room is
 * /fine-tuning/runs/{id}. A plan for a dataset that already exists starts nothing new.
 *
 * Training doesn't start on its own yet: U3's tuneRun workflow (after tg-decide's D7) will poll the dataset, check the
 * examples and launch the GPU. Until then a ready run's room offers the full New job form (lib/train/tune/view.ts).
 */
import { start } from "workflow/api";
import { testModel } from "@/lib/env";
import { DATASET_MODEL, makeDataset } from "@/lib/train/datasets";
import { attachDatasetRun, createDataset, failDataset, getDataset } from "@/lib/train/store";
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
 * Saves the plan's dataset (its name as the title, written as a role for the short student prompt; its task; its size)
 * and starts makeDataset on it. The writer is Muse Wonder, or TEST_MODEL where that is on (never on production), so a
 * made-up test run costs a cent. `productId` is for B, the build room's own-model row, and is kept nowhere until 0025.
 */
export async function startTuneRun(i: {
  plan?: TrainPlanBody;
  datasetId?: string;
  callerId: string;
  productId?: string | null;
}): Promise<{ runId: string; href: string }> {
  const source = i.plan?.source ?? (i.datasetId ? { kind: "dataset" as const, datasetId: i.datasetId } : null);
  if (!source) throw new TuneStartError(400, "no_plan");
  if (source.kind === "build") throw new TuneStartError(400, "not_supported");
  if (source.kind === "dataset") {
    const existing = await getDataset(source.datasetId);
    if (!existing) throw new TuneStartError(404, "not_found");
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
  return { runId: dataset.id, href: runHref(dataset.id) };
}
