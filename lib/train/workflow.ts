/**
 * The durable workflow for one fine-tuning job (docs/TRAINING.md "Lifecycle"). It only orchestrates: every side
 * effect lives in a "use step" function in ./steps.ts.
 *
 *   trainJob: launch (idempotent; save the instance if the database didn't take it) -> check every 30 s until
 *             decideCheck says terminate, or maxMinutes + 15 minutes pass -> terminate
 *
 * Lambda bills until an instance is terminated, so terminate runs in a finally block: after a normal ending, a
 * launch that threw, and the hard stop alike. The workflow keeps the id of the instance it launched, so terminate can
 * end it by id even while the database is down. A check that fails (the database stayed down through its retries)
 * doesn't end the watch: the next poll tries again, and the hard stop bounds the loop. The job's own done or failed
 * callback and the 5-minute sweep terminate it too.
 *
 * Start it with start() from "workflow/api" (app/api/train/jobs). Never call it directly.
 */
import { sleep } from "workflow";
import { POLL_MS } from "@/lib/train/logic";
import { abandonStep, checkStep, launchStep, saveLaunchStep, terminateStep, type TrainEnding } from "@/lib/train/steps";
import type { TrainCheck, TrainStatus } from "@/lib/train/types";

export interface TrainJobInput {
  jobId: string;
}

export interface TrainJobResult {
  status: TrainStatus;
}

/** The loop stops this long after the job's own time limit, whatever the checks say. */
const HARD_STOP_GRACE_MS = 15 * 60_000;
/** When neither terminateStep nor abandonStep got through, terminate waits this long and tries both again... */
const TERMINATE_PAUSE_MS = 60_000;
/** ...until this long after it began. Then the job is left to the sweep. */
const TERMINATE_GIVE_UP_MS = 60 * 60_000;

/** The runtime wraps a step error that used up its retries in a FatalError with this prefix. */
const RETRIES_EXHAUSTED = /^Step "[^"]*" failed after \d+ retr(?:y|ies): /;

/**
 * A plain reason for a job that stopped on an error. Duck-typed, since errors hydrated inside the workflow sandbox
 * may come from another realm's Error. Only the first line is kept.
 */
function errorReason(stage: "launch" | "check", err: unknown): string {
  const e = typeof err === "object" && err !== null ? (err as { message?: unknown }) : null;
  const raw = typeof e?.message === "string" ? e.message : typeof err === "string" ? err : "";
  const line = (raw.replace(RETRIES_EXHAUSTED, "").split("\n")[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const what = stage === "launch" ? "The launch failed" : "Checking on the job failed";
  return line ? `${what}: ${line}` : `${what}.`;
}

/**
 * Terminates and records the ending. When Lambda never confirms, the job is ended anyway and the sweep takes over.
 * When neither step gets through (each retries for about 10 minutes), both are tried again every minute for an hour.
 */
async function terminate(jobId: string, ending: TrainEnding, instanceId: string | undefined): Promise<TrainStatus> {
  const giveUpAt = Date.now() + TERMINATE_GIVE_UP_MS;
  for (;;) {
    try {
      return await terminateStep(jobId, ending, instanceId);
    } catch {
      // Lambda or the database stayed down through every retry.
    }
    try {
      return await abandonStep(jobId, ending, instanceId);
    } catch {
      // The database is still down.
    }
    // The sweep terminates instances of jobs that ran past their limit, and fails jobs stuck before launch.
    if (Date.now() >= giveUpAt) return "failed";
    await sleep(TERMINATE_PAUSE_MS);
  }
}

export async function trainJob(input: TrainJobInput): Promise<TrainJobResult> {
  "use workflow";
  const { jobId } = input;
  let stage: "launch" | "check" = "launch";
  let ending: TrainEnding = { status: "failed", reason: "The job ended before it was checked." };
  let status: TrainStatus = "failed";
  let instanceId: string | undefined;
  try {
    const first = await launchStep(jobId);
    instanceId = first.instanceId;
    const launch = first.action === "save" ? await saveLaunchStep(jobId, first) : first;
    instanceId = launch.instanceId ?? instanceId;
    if (launch.action === "end") {
      ending = { status: launch.status, reason: launch.reason };
    } else {
      stage = "check";
      const limitMinutes = launch.maxMinutes + HARD_STOP_GRACE_MS / 60_000;
      const hardStopAt = Date.now() + limitMinutes * 60_000;
      for (;;) {
        await sleep(POLL_MS);
        if (Date.now() >= hardStopAt) {
          ending = { status: "failed", reason: `Stopped after ${limitMinutes} minutes, past the job's time limit.` };
          break;
        }
        let check: TrainCheck;
        try {
          check = await checkStep(jobId);
        } catch {
          // Says nothing about the job itself, so the watch goes on; the hard stop still bounds it.
          continue;
        }
        if (check.action === "terminate") {
          ending = { status: check.status, reason: check.reason };
          break;
        }
      }
    }
  } catch (err) {
    ending = { status: "failed", reason: errorReason(stage, err) };
  } finally {
    status = await terminate(jobId, ending, instanceId);
  }
  return { status };
}
