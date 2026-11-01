/**
 * The durable workflow that takes a run from its examples to its training job (docs/TRAINING.md "Fine-tune like a
 * build", "Starting training"). It only orchestrates: every side effect lives in a "use step" function in
 * ./run-steps.ts.
 *
 *   tuneRun: check the run's dataset every 30 s until it is ready (or failed, gone, stopped, or still writing after
 *            6 hours) -> check the examples (checkExamplesStep: enough to train on and to score with, lengths, the
 *            content seam) -> launch training (launchRunStep: launchJob with the run's settings; publish 0 unless the run uploads by itself), and
 *            while the GPU is busy or a cap is hit, try again every 5 minutes for up to 2 hours, the waiting reason
 *            kept as the run's heartbeat. Never launches for a run that was stopped.
 *
 * The training job is a trainJob workflow of its own (launchJob starts it), so this one ends once the job exists. It
 * ends without a job when the check fails, the launch is refused, or two hours pass; the room then says why and offers
 * Start training (POST /api/train/runs/{id}/start), which tries the launch again and, if it has to wait, starts this
 * workflow once more on the ready dataset.
 *
 * Start it with start() from "workflow/api" (lib/train/tune/start.ts, app/api/train/runs/[id]/start). Never call it
 * directly.
 */
import { sleep } from "workflow";
import { TUNE_LAUNCH_WINDOW_MS, TUNE_RETRY_MS } from "@/lib/train/tune/marks";
import { checkExamplesStep, endRunStep, launchRunStep, runDatasetStep, type LaunchStepResult } from "@/lib/train/tune/run-steps";

export interface TuneRunInput {
  datasetId: string;
  /** Who started the run: the training job's created_by. */
  callerId: string;
  /** The run's training steps. */
  steps: number;
}

export type TuneRunStatus = "launched" | "failed" | "stopped" | "refused" | "gave_up";

export interface TuneRunResult {
  status: TuneRunStatus;
  jobId?: string;
}

/** How often the workflow looks at the dataset while it is written. */
const DATASET_POLL_MS = 30_000;
/** A dataset still writing after this long has stalled (its own workflow fails it); this one stops waiting. */
const WRITING_GIVE_UP_MS = 6 * 60 * 60_000;

export async function tuneRun(input: TuneRunInput): Promise<TuneRunResult> {
  "use workflow";
  const { datasetId } = input;
  try {
    const writingUntil = Date.now() + WRITING_GIVE_UP_MS;
    for (;;) {
      const d = await runDatasetStep(datasetId);
      if (d.stopped) return { status: "stopped" };
      if (d.status === "ready") break;
      if (d.status !== "generating" || Date.now() >= writingUntil) return { status: "failed" };
      await sleep(DATASET_POLL_MS);
    }

    const check = await checkExamplesStep(datasetId);
    if (!check.ok) return { status: "failed" };

    const giveUpAt = Date.now() + TUNE_LAUNCH_WINDOW_MS;
    for (;;) {
      const r: LaunchStepResult = await launchRunStep({ datasetId, callerId: input.callerId, steps: input.steps });
      if (r.kind === "launched") return { status: "launched", jobId: r.jobId };
      if (r.kind === "stopped") return { status: "stopped" };
      if (r.kind === "refused") return { status: "refused" };
      if (Date.now() + TUNE_RETRY_MS > giveUpAt) {
        await endRunStep(datasetId, `waited_${r.reason}`);
        return { status: "gave_up" };
      }
      await sleep(TUNE_RETRY_MS);
    }
  } catch {
    // A step ran out of retries (the database stayed down). The room shows Start training once no heartbeat is fresh.
    try {
      await endRunStep(datasetId, "error");
    } catch {
      // Still down: with no fresh heartbeat the room offers Start training anyway.
    }
    return { status: "failed" };
  }
}
