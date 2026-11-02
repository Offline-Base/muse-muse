/**
 * Training a run's examples (docs/TRAINING.md "Fine-tune like a build", "Starting training"): the examples check and
 * the launch, shared by the tuneRun workflow's steps (./run-steps.ts) and POST /api/train/runs/{id}/start. The launch
 * goes through launchJob (lib/train/launch.ts), so it passes every check a job from the full form passes, with the
 * run's own settings, and publish 0 unless the run was started to upload by itself (./auto-publish.ts).
 */
import { spendPaused } from "@/lib/quota";
import { env } from "@/lib/env";
import { limitCeilings } from "@/lib/train/gate";
import { launchJob, type LaunchRefusal } from "@/lib/train/launch";
import { ADAPTER_RECIPE } from "@/lib/train/logic";
import { datasetPage, getDataset, requestStop } from "@/lib/train/store";
import { autoPublishOk } from "@/lib/train/tune/auto-publish";
import { CHECK_CODES, type CheckCode, type TuneWaitReason } from "@/lib/train/tune/marks";
import { contentFindings } from "@/lib/train/tune/examples";
import { personHasOpenJob } from "@/lib/train/public/open-start";
import { holdVisitorJob, releaseReservation, reserveVisitorRun, visitorJobCeilings, visitorLimits, type Reservation } from "@/lib/train/public/limits";
import {
  latestTuneJob,
  markCode,
  readRunMarks,
  readRunProduct,
  recordRunEnded,
  recordRunHeartbeat,
  releaseLaunchClaim,
  takeLaunchClaim,
} from "@/lib/train/tune/run-store";
import { examplesProblem, planSettings } from "@/lib/train/tune/settings";
import type { TrainExample } from "@/lib/train/types";

/** Muse Glimmer trains on at most this many tokens a conversation; longer ones are dropped by the GPU (MAX_SEQ_LENGTH). */
const MAX_SEQ_TOKENS = 2048;
/** Characters a token, roughly, for English text: a conversation over MAX_SEQ_TOKENS * this is counted as too long. */
const CHARS_PER_TOKEN = 4;
/** Train examples the check reads at most: the datasets route's own limit. */
const CHECK_ROWS_MAX = 1000;

export type ExamplesCheck = { ok: true; train: number; eval: number } | { ok: false; code: CheckCode | "missing" | "not_ready" };

/** A conversation's length in characters: every message's content. */
function chars(example: TrainExample): number {
  return (example.messages ?? []).reduce((n, m) => n + (typeof m?.content === "string" ? m.content.length : 0), 0);
}

/**
 * Whether a ready dataset can be trained on as a run: a chat dataset (decision rows train from the full form), at
 * least 16 to train on and 8 to score with (examplesProblem), still 16 once the conversations too long for Muse
 * Glimmer are left out, and nothing the content seam finds (contentFindings, open-train's piiFindings once it lands).
 */
export async function checkExamples(datasetId: string): Promise<ExamplesCheck> {
  const dataset = await getDataset(datasetId);
  if (!dataset) return { ok: false, code: "missing" };
  if (dataset.status !== "ready") return { ok: false, code: "not_ready" };
  if (dataset.kind === "decision") return { ok: false, code: "decision" };
  if (examplesProblem(dataset)) return { ok: false, code: "too_few" };
  const page = await datasetPage(datasetId, "train", 0, CHECK_ROWS_MAX);
  const train = (page?.items ?? []) as TrainExample[];
  const fit = train.filter((e) => chars(e) <= MAX_SEQ_TOKENS * CHARS_PER_TOKEN);
  // The GPU drops what's too long and trains on the rest, so only too few left is a problem.
  if (examplesProblem({ trainCount: fit.length, evalCount: dataset.evalCount })) return { ok: false, code: "too_long" };
  const rows = train.map((e) => ({
    prompt: e.messages.find((m) => m.role === "user")?.content ?? "",
    answer: e.messages.find((m) => m.role === "assistant")?.content ?? "",
  }));
  if (contentFindings({ note: dataset.task, rows }).length) return { ok: false, code: "content" };
  return { ok: true, train: dataset.trainCount, eval: dataset.evalCount };
}

/** What one try at launching a run's training came to. */
export type RunLaunch =
  | { kind: "launched"; jobId: string; already: boolean }
  | { kind: "wait"; reason: TuneWaitReason; refusal: LaunchRefusal | null }
  | { kind: "refused"; refusal: LaunchRefusal }
  | { kind: "stopped" };

/** The launch refusals that pass on their own (a GPU frees, a job ends, the sweep runs), so the launch is tried again. */
export function waitReasonFor(r: LaunchRefusal): TuneWaitReason | null {
  if (r.code === "no_capacity") return "gpu_busy";
  if (r.code === "too_many_active" || r.code === "demo_running") return "too_many_active";
  // Backed out for another start at the same moment: it may fit next time. Any other gpu_limit ends the run.
  if (r.code === "gpu_limit" && r.body?.raced === true) return "too_many_active";
  if (r.code === "daily_cap") return "daily_cap";
  if (r.code === "sweep_not_running") return "sweep_not_running";
  if (r.code === "lambda_unavailable") return "lambda_unavailable";
  return null;
}

export interface RunLaunchInput {
  datasetId: string;
  /** Who started the run (or pressed Start training): the job's created_by. */
  callerId: string;
  /** The run's training steps (TUNE_STEPS unless Advanced changed them). */
  steps: number;
  /**
   * A tuning loop's round: the source job's own settings and this round's dollar limit, in place of the run's defaults
   * (lib/train/tune/loop-steps.ts). Publish stays whatever these params say, and every launch check still applies.
   */
  job?: { params: Record<string, string | number>; instanceType: string; maxMinutes: number; maxUsd: number };
  now?: Date;
}

/**
 * One try at training the run's examples. Never launches for a run that was stopped (checked again once the claim is
 * held, and once the job exists, which a stop at that moment stops too), or one that already has a job
 * (that job is the answer). Waits, rather than launching, while the platform's Meta spend cap is reached (scoring
 * needs it), while another launcher holds the run's claim, and for every launch refusal that passes on its own
 * (waitReasonFor). The job is glimmer-lora with the run's settings: its dataset, steps, LoRA rank, learning rate, the
 * short student prompt and publish 0 (1 only when autoPublishOk still says so), on the A100 SXM4 first, with the run's limits. Records the heartbeat for a wait
 * and the ending for a refusal.
 */
export async function launchForRun(input: RunLaunchInput): Promise<RunLaunch> {
  const { datasetId } = input;
  const now = input.now ?? new Date();
  const marks = await readRunMarks(datasetId, now);
  if (marks.stopped) return { kind: "stopped" };
  const existing = await latestTuneJob(datasetId);
  if (existing) return { kind: "launched", jobId: existing.id, already: true };
  const wait = async (reason: TuneWaitReason, refusal: LaunchRefusal | null = null): Promise<RunLaunch> => {
    await recordRunHeartbeat(datasetId, reason, now);
    return { kind: "wait", reason, refusal };
  };
  if (await spendPaused()) return wait("paused");

  const dataset = await getDataset(datasetId);
  if (!dataset) return refused(datasetId, { ok: false, status: 404, code: "not_found" });
  const claim = await takeLaunchClaim(datasetId, now);
  if (!claim) return wait("launching");
  try {
    // A launcher that held the claim just before this one may have started the job.
    const raced = await latestTuneJob(datasetId);
    if (raced) return { kind: "launched", jobId: raced.id, already: true };
    // Stopped while this launcher waited for the claim.
    if ((await readRunMarks(datasetId, now)).stopped) return { kind: "stopped" };
    // A visitor's run stays within their limits, whatever was kept with it, and never uploads.
    const visitor = marks.visitor ?? null;
    const limits = visitorLimits();
    const s = visitor
      ? planSettings(dataset.requested, visitorJobCeilings(limits), Math.min(input.steps, limits.job.maxSteps))
      : planSettings(dataset.requested, limitCeilings(), input.steps);
    let held: Reservation | null = null;
    if (visitor) {
      if (input.job) return refused(datasetId, { ok: false, status: 403, code: "forbidden" });
      if (dataset.createdBy && (await personHasOpenJob(dataset.createdBy))) return wait("too_many_active");
      const taken = await reserveVisitorRun(
        { ...visitor, limits },
        { dryRun: false, maxMinutes: s.maxMinutes, maxUsd: s.maxUsd, steps: s.steps },
        now,
      );
      if (!taken.ok) {
        if (taken.code === "visitor_gpu_busy") return wait("too_many_active");
        if (taken.code === "public_daily_usd") return wait("daily_cap");
        return refused(datasetId, { ok: false, status: taken.status, code: taken.code, body: { reason: taken.error } });
      }
      held = taken.reservation;
    }
    const giveBack = () => (held ? releaseReservation(held).catch((err) => console.error("[train/tune] release visitor run", err)) : Promise.resolve());
    const uploads =
      !visitor &&
      marks.autoPublish === true &&
      autoPublishOk({ flag: env.tuneAutoPublish, hubOff: env.hubOffReason, asked: true, dataset, runProductId: (await readRunProduct(datasetId))?.productId ?? null });
    let launched: Awaited<ReturnType<typeof launchJob>>;
    try {
      launched = await launchJob(
      {
        recipe: ADAPTER_RECIPE,
        title: dataset.title,
        params: input.job?.params ?? {
          datasetId,
          maxSteps: s.steps,
          loraRank: s.loraRank,
          learningRate: s.learningRate,
          studentPrompt: s.studentPrompt,
          publish: uploads ? 1 : s.publish,
        },
        instanceType: input.job?.instanceType ?? s.gpu,
        maxMinutes: input.job?.maxMinutes ?? s.maxMinutes,
        maxUsd: input.job?.maxUsd ?? s.maxUsd,
        ...(marks.base ? { base: marks.base, baseGpuAuto: true } : {}),
      },
      { userId: input.callerId },
      );
    } catch (err) {
      await giveBack();
      throw err;
    }
    if (!launched.ok) await giveBack();
    if (launched.ok) {
      if (held) await holdVisitorJob(launched.job.id, held).catch((err) => console.error("[train/tune] keep visitor hold", err));
      // Stopped while the launch ran (POST runs/{id}/stop marks the run, then stops the job it finds): the job stops
      // too, so a stop and a launch at the same moment never leave a GPU training.
      if ((await readRunMarks(datasetId, now)).stopped) {
        await requestStop(launched.job.id).catch((err) => console.error("[train/tune] stop the raced job", err));
        return { kind: "stopped" };
      }
      return { kind: "launched", jobId: launched.job.id, already: false };
    }
    const reason = waitReasonFor(launched);
    return reason ? await wait(reason, launched) : await refused(datasetId, launched);
  } finally {
    await releaseLaunchClaim(datasetId, claim).catch((err) => console.error("[train/tune] release claim", err));
  }
}

async function refused(datasetId: string, refusal: LaunchRefusal): Promise<RunLaunch> {
  await recordRunEnded(datasetId, markCode(refusal.code));
  return { kind: "refused", refusal };
}

/** Records the check's ending for a run whose examples can't be trained on, so the room says why. */
export async function recordCheckEnded(datasetId: string, check: Extract<ExamplesCheck, { ok: false }>): Promise<void> {
  if ((CHECK_CODES as readonly string[]).includes(check.code)) await recordRunEnded(datasetId, check.code);
}
