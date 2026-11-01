/**
 * The durable workflows for one fine-tuning job (docs/TRAINING.md "Lifecycle"). They only orchestrate: every side
 * effect lives in a "use step" function in ./steps.ts, ./judge.ts for judging, or ./hub-steps.ts for publishing.
 *
 *   trainJob: launch (idempotent; save the instance if the database didn't take it) -> check every 30 s until
 *             decideCheck says terminate, or maxMinutes + 15 minutes pass -> terminate
 *             -> for a job that succeeded with eval items: judge them, 4 at a time, then save the eval summary
 *                (a decide job, input mode "decide", is scored instead, after any ending: scoreDecisionStep in
 *                ./decide-steps.ts, docs/DECISION_MODELS.md "Scoring")
 *             -> publish to the Hugging Face Hub: a judged glimmer-lora job whose adapter files are on the Hub, the
 *                adapter job a glimmer-publish job uploaded for once that job succeeded, or a glimmer-quantize job's
 *                own GGUF repo once it succeeded
 *   publishToHub: the same publishing, when an admin presses Publish (app/api/train/jobs/[id]/publish)
 *
 * Lambda bills until an instance is terminated, so terminate runs in a finally block: after a normal ending, a
 * launch that threw, and the hard stop alike. The workflow keeps the id of the instance it launched, so terminate can
 * end it by id even while the database is down. A check that fails (the database stayed down through its retries)
 * doesn't end the watch: the next poll tries again, and the hard stop bounds the loop. The job's own done or failed
 * callback and the 5-minute sweep terminate it too.
 *
 * Judging starts only once terminate has returned, so it never keeps an instance billing, and nothing it does can
 * change the job's status: a judge step that fails is skipped, and a failure of the whole judging is swallowed.
 * Scoring a decide job follows the same rules. It calls no model, so it costs nothing, and it runs whatever the ending,
 * since the GPU sends its base scores before anything else can fail.
 * Publishing comes after judging, under the same rules: it never throws and never touches the job's status, and a
 * step that runs out of retries leaves the job's hub state "failed" with the reason, for Publish to try again.
 *
 * Start them with start() from "workflow/api" (app/api/train/jobs, app/api/train/jobs/[id]/publish). Never call them
 * directly.
 */
import { sleep } from "workflow";
import { scoreDecisionStep } from "@/lib/train/decide-steps";
import {
  hubDatasetStep,
  hubFailStep,
  hubFinishStep,
  hubGgufFinishStep,
  hubGgufStep,
  hubModelStep,
  hubPlanStep,
  hubStoryStep,
} from "@/lib/train/hub-steps";
import { judgePlanStep, judgeStep, saveEvalSummaryStep } from "@/lib/train/judge";
import { DECIDE_MODE, POLL_MS, type JobMode, type JudgedItem } from "@/lib/train/logic";
import { abandonStep, checkStep, launchStep, saveLaunchStep, terminateStep, type TrainEnding } from "@/lib/train/steps";
import type { TrainCheck, TrainStatus } from "@/lib/train/types";

export interface TrainJobInput {
  jobId: string;
  /**
   * "decide" for a glimmer-lora job in decide mode, which the jobs route sets: it is scored after its run
   * (scoreDecisionStep), never judged. Left out for every other job, so a chat job's run is as it was.
   */
  mode?: JobMode;
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

/** Eval items judged at once. */
const JUDGE_CONCURRENCY = 4;

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

/**
 * Judges the job's eval items with JUDGE_MODEL (Muse Wonder), JUDGE_CONCURRENCY at a time, then saves the eval summary.
 * An item whose judge step fails is left out of the summary. Never throws.
 */
async function judge(jobId: string): Promise<void> {
  try {
    const plan = await judgePlanStep(jobId);
    if (!plan.indexes.length) return;
    const judged: JudgedItem[] = [];
    for (let i = 0; i < plan.indexes.length; i += JUDGE_CONCURRENCY) {
      const group = plan.indexes.slice(i, i + JUDGE_CONCURRENCY);
      const verdicts = await Promise.all(group.map((index) => judgeStep(jobId, index, plan.task).catch(() => null)));
      for (const verdict of verdicts) if (verdict) judged.push(verdict);
    }
    await saveEvalSummaryStep(jobId, judged, plan.indexes.length);
  } catch {
    // Judging is an extra: the instance is already terminated and the job's status is settled.
  }
}

/**
 * Scores a decide job from its GPU's own log-probabilities and saves the eval summary (scoreDecisionStep: no judge, no
 * Meta call). Never throws.
 */
async function scoreDecisions(jobId: string): Promise<void> {
  try {
    await scoreDecisionStep(jobId);
  } catch {
    // Like judging, an extra: the instance is already terminated and the job's status is settled.
  }
}

/** A step error's first line, without the runtime's retries prefix, for the hub state's reason. */
function stepReason(err: unknown): string {
  const e = typeof err === "object" && err !== null ? (err as { message?: unknown }) : null;
  const raw = typeof e?.message === "string" ? e.message : typeof err === "string" ? err : "";
  const line = (raw.replace(RETRIES_EXHAUSTED, "").split("\n")[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  return line || "a step failed without saying why.";
}

/**
 * Publishes to the Hugging Face Hub what the ended job `jobId` (`status`) lets publish: itself when it is a judged
 * glimmer-lora job whose adapter files are on the Hub, or the adapter job a glimmer-publish job uploaded for, once that
 * job succeeded. hubPlanStep takes the publishing claim (or says why it waits); then the story, the dataset repo, the
 * model repo, and the dataset card and both repos' visibility, each step under that claim. A glimmer-quantize job that
 * succeeded publishes its own GGUF repo instead (the plan's kind "gguf"): the repo's commit, then its visibility and
 * the adapter card's pointer to it. `manual` is an admin's Publish, which also publishes a job whose "publish" param
 * is 0. Returns whether it published. Never throws: a step that ran out of retries fails the publishing, with its
 * reason, in the hub state, while the run still holds its claim.
 */
async function publish(jobId: string, status: TrainStatus, manual = false): Promise<boolean> {
  let held: { jobId: string; claim: string } | null = null;
  try {
    const plan = await hubPlanStep(jobId, status, manual);
    if (plan.action !== "publish") return false;
    held = { jobId: plan.jobId, claim: plan.claim };
    if (plan.kind === "gguf") {
      await hubGgufStep(held.jobId, held.claim);
      await hubGgufFinishStep(held.jobId, held.claim);
      return true;
    }
    await hubStoryStep(held.jobId, held.claim);
    await hubDatasetStep(held.jobId, held.claim);
    await hubModelStep(held.jobId, held.claim);
    await hubFinishStep(held.jobId, held.claim);
    return true;
  } catch (err) {
    if (held) {
      try {
        await hubFailStep(held.jobId, held.claim, stepReason(err));
      } catch {
        // The database stayed down: the claim goes stale after 30 minutes and Publish can start again.
      }
    }
    return false;
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
  if (input.mode === DECIDE_MODE) await scoreDecisions(jobId);
  else if (status === "succeeded") await judge(jobId);
  await publish(jobId, status);
  return { status };
}

export interface PublishToHubInput {
  jobId: string;
}

/**
 * Publishes a judged glimmer-lora job to the Hugging Face Hub now, when an admin pressed Publish and its adapter's
 * files are on the Hub (docs/TRAINING.md "Hugging Face Hub"), or a glimmer-quantize job's GGUF repo whose files are.
 * The same steps as after the job; a run already publishing the job holds the claim, and this one does nothing.
 */
export async function publishToHub(input: PublishToHubInput): Promise<{ published: boolean }> {
  "use workflow";
  return { published: await publish(input.jobId, "succeeded", true) };
}
