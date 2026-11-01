/**
 * The tuneRun workflow's steps ("use step", docs/TRAINING.md "Fine-tune like a build", "Starting training"). Each takes
 * and returns small plain values and is safe to run again: the launch looks for the run's job first and holds the
 * run's one launch claim while it launches, so a step that ran twice never starts two jobs.
 */
import { RetryableError } from "workflow";
import { getDataset } from "@/lib/train/store";
import { checkExamples, launchForRun, recordCheckEnded, type ExamplesCheck } from "@/lib/train/tune/run-launch";
import { readRunMarks, recordRunEnded, recordRunHeartbeat } from "@/lib/train/tune/run-store";
import type { DatasetStatus } from "@/lib/train/types";
import type { TuneWaitReason } from "@/lib/train/tune/marks";

/** How long a step waits before trying again after the database didn't answer. */
const DB_RETRY_AFTER = "30s";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A database call whose failure is retried after 30 s rather than 1 s. */
async function fromDb<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new RetryableError(`The database did not answer: ${message(err)}`, { retryAfter: DB_RETRY_AFTER });
  }
}

/** Where the run's examples stand, and whether the run was stopped. Null status when the dataset is gone. */
export async function runDatasetStep(datasetId: string): Promise<{ status: DatasetStatus | null; stopped: boolean }> {
  "use step";
  const [row, marks] = await fromDb(() => Promise.all([getDataset(datasetId), readRunMarks(datasetId)]));
  return { status: row?.status ?? null, stopped: marks.stopped };
}
runDatasetStep.maxRetries = 20;

/**
 * The examples check (checkExamples), with a "checking" heartbeat first so the room shows the step. A check that
 * fails records its ending, so the room says why.
 */
export async function checkExamplesStep(datasetId: string): Promise<ExamplesCheck> {
  "use step";
  await fromDb(() => recordRunHeartbeat(datasetId, "checking"));
  const check = await fromDb(() => checkExamples(datasetId));
  if (!check.ok) await fromDb(() => recordCheckEnded(datasetId, check));
  return check;
}
checkExamplesStep.maxRetries = 20;

export type LaunchStepResult =
  | { kind: "launched"; jobId: string }
  | { kind: "wait"; reason: TuneWaitReason }
  | { kind: "refused"; code: string }
  | { kind: "stopped" };

/**
 * One try at the launch (launchForRun): the run's job, a reason to wait and try again, a refusal, or stopped. Only
 * codes come back, never a refusal's body (the step's result is kept in the workflow's log).
 */
export async function launchRunStep(input: { datasetId: string; callerId: string; steps: number }): Promise<LaunchStepResult> {
  "use step";
  const r = await launchForRun(input);
  if (r.kind === "launched") return { kind: "launched", jobId: r.jobId };
  if (r.kind === "wait") return { kind: "wait", reason: r.reason };
  if (r.kind === "refused") return { kind: "refused", code: r.refusal.code.slice(0, 200) };
  return { kind: "stopped" };
}
launchRunStep.maxRetries = 3;

/** Records why the workflow ended without a job ("waited_<reason>" after two hours, "error" after a step gave up). */
export async function endRunStep(datasetId: string, code: string): Promise<void> {
  "use step";
  await fromDb(() => recordRunEnded(datasetId, code));
}
endRunStep.maxRetries = 20;
