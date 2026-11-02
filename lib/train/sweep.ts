/**
 * The 5-minute training sweep (docs/TRAINING.md "Lifecycle"), the backstop behind each job's workflow and its own
 * done callback. Lambda bills until an instance is terminated, so this terminates any live instance whose job is
 * missing, ended, stopped by an admin, past decideCheck's boot grace or silence rule, past its time limit plus 10
 * minutes or past its dollar limit plus 10%, and fails jobs stuck before launch. So a job whose workflow is gone is
 * still held to its heartbeat rules and its Stop button. It also terminates a second instance under a job's name,
 * fails a launched job left open 30 minutes past its limit (its workflow is gone), stamps terminatedAt on an ended job
 * whose instance is gone, and counts the time of an instance that outlived its job's terminatedAt. When Lambda's
 * listing fails, instances whose ids jobs saved are still terminated by id.
 *
 * Only the platform's instances are ever touched: those named "mm-train-", and those a job claims by its saved
 * instance id or the "muse-muse-job" tag (so a renamed one is still found). No other instance on the account is.
 */
import { and, inArray, isNotNull, isNull, notInArray, or, type SQL } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getInstance, listInstances, terminateInstances, type LambdaInstance } from "@/lib/train/lambda";
import { decideCheck, estimateCostUsd, INSTANCE_NAME_PREFIX, type TrainJobRow } from "@/lib/train/logic";
import { extendTermination, finishJob, jobListColumns, recordEvent, setStatus } from "@/lib/train/store";
import { isTrainTerminal, TRAIN_TERMINAL, type TrainStatus } from "@/lib/train/types";

const MIN = 60_000;
/** An instance is terminated this long past its job's time limit. The workflow stops at 15, so this comes first. */
export const SWEEP_TIME_GRACE_MS = 10 * MIN;
/** An instance is terminated once its estimated cost passes the job's dollar limit by this factor. */
export const SWEEP_USD_FACTOR = 1.1;
/** A job still queued or launching this long after it was created is failed. */
export const STUCK_AFTER_MS = 15 * MIN;
/**
 * A job that launched and is still open this long past its time limit has lost its workflow (which stops at 15
 * minutes past). Failing it frees its slot under TRAIN_MAX_ACTIVE.
 */
export const ORPHAN_AFTER_LIMIT_MS = 30 * MIN;
/**
 * An ended job with no saved instance id, whose launch was sent, is only called "already gone" this long after it
 * ended: Lambda's listing can lag a fresh launch.
 */
export const UNLISTED_GRACE_MS = 10 * MIN;

const GONE: readonly LambdaInstance["status"][] = ["terminated", "terminating"];
const BEFORE_LAUNCH: readonly TrainStatus[] = ["queued", "launching"];
const STOP_REASON = "Someone asked to stop the job.";
/** The launch tag that names the job (lib/train/steps.ts). */
const JOB_TAG = "muse-muse-job";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ended = Extract<TrainStatus, "succeeded" | "failed" | "stopped">;

/** What the sweep reads and changes. Tests pass fakes; sweepDeps() wires Lambda and the database. */
export interface TrainSweepDeps {
  listInstances(): Promise<LambdaInstance[]>;
  /** One instance, or null when Lambda doesn't know the id. */
  getInstance(id: string): Promise<LambdaInstance | null>;
  terminateInstances(ids: string[]): Promise<void>;
  /** Jobs that haven't ended. */
  openJobs(): Promise<TrainJobRow[]>;
  /** Jobs that may own these instances: by instance_name, by saved instance_id, or by job id (from the job tag). */
  jobsForInstances(match: { names: string[]; instanceIds: string[]; jobIds: string[] }): Promise<TrainJobRow[]>;
  /** Jobs that ended after a launch but have no terminatedAt (Lambda didn't confirm the terminate at the time). */
  unterminatedJobs(): Promise<TrainJobRow[]>;
  finishJob: typeof finishJob;
  extendTermination: typeof extendTermination;
  setStatus: typeof setStatus;
  recordEvent: typeof recordEvent;
}

export interface TrainSweepResult {
  /** Live "mm-train-" instances Lambda listed, or null when the listing failed. */
  instances: number | null;
  terminated: Array<{ instanceId: string; name: string; jobId: string | null; reason: string }>;
  failedJobs: Array<{ jobId: string; reason: string }>;
  /** Open jobs an admin had asked to stop, ended here as "stopped" (not "failed") because their workflow hadn't. */
  stoppedJobs: Array<{ jobId: string; reason: string }>;
  errors: string[];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Where a job's clock starts: its launch, or its creation when an instance exists but the launch was never saved. */
function clockStart(job: TrainJobRow): Date {
  return job.launchedAt ?? job.createdAt;
}

/** For finishJob after terminating a job's instance: a launch that was never saved starts at createdAt, so its cost counts. */
function unsavedLaunch(job: TrainJobRow): { launchedAt?: Date } {
  return job.launchedAt ? {} : { launchedAt: job.createdAt };
}

/**
 * True when the job holds the launch claim (lib/train/steps.ts launchStep) but has no saved instance: the launch was
 * sent, or is still in flight, and Lambda may not list it yet.
 */
function launchSent(job: TrainJobRow): boolean {
  return job.status === "launching" && Boolean(job.tokenHash) && !job.instanceId;
}

const UNLISTED_NOTE = "Lambda doesn't list an instance for its launch yet, so a later sweep looks for it again.";

function isPrefixed(instance: LambdaInstance): boolean {
  return typeof instance.name === "string" && instance.name.startsWith(INSTANCE_NAME_PREFIX);
}

/** The job id in the instance's "muse-muse-job" tag (set at launch), or null. */
function taggedJobId(instance: LambdaInstance): string | null {
  const tag = instance.tags?.find((t) => t.key === JOB_TAG);
  return tag && UUID_RE.test(tag.value) ? tag.value.toLowerCase() : null;
}

/** True when the instance is this job's: its saved id, its "mm-train-" name, or its job tag. */
function belongsTo(instance: LambdaInstance, job: TrainJobRow): boolean {
  return (
    (job.instanceId !== null && instance.id === job.instanceId) ||
    (isPrefixed(instance) && instance.name === job.instanceName) ||
    taggedJobId(instance) === job.id
  );
}

/** How the sweep ends an open job: "stopped" when an admin asked, so the stop isn't recorded as a failure. */
function sweptStatus(job: TrainJobRow): "stopped" | "failed" {
  return job.stopRequested ? "stopped" : "failed";
}

function noteEnded(result: TrainSweepResult, job: TrainJobRow, reason: string): void {
  (job.stopRequested ? result.stoppedJobs : result.failedJobs).push({ jobId: job.id, reason });
}

/**
 * Why the sweep ends this open job, from its row and its instance's status (taken as active when Lambda couldn't be
 * asked), or null. A stop request comes first. The time and dollar limits get the sweep's grace, so a live workflow
 * acts first. Then decideCheck's own rules with the limits left out: no heartbeat 25 minutes after launch, 10 minutes
 * of silence after the first, and an unhealthy or preempted instance. So a job whose workflow is gone can't run on to
 * its limit on a dead runner.
 */
export function openJobReason(
  job: TrainJobRow,
  now: Date,
  instance: { status: LambdaInstance["status"] } = { status: "active" },
): string | null {
  if (job.stopRequested) return STOP_REASON;
  const start = clockStart(job);
  if (now.getTime() >= start.getTime() + job.maxMinutes * MIN + SWEEP_TIME_GRACE_MS) {
    return `Ran ${SWEEP_TIME_GRACE_MS / MIN} minutes past the job's ${job.maxMinutes}-minute limit.`;
  }
  const cost = estimateCostUsd({ priceCentsPerHour: job.priceCentsPerHour, launchedAt: start, terminatedAt: null }, now);
  // Rounded like estimateCostUsd, so $1 * 1.1 is $1.10 and not 1.1000000000000001.
  const ceiling = Math.round(job.maxUsd * SWEEP_USD_FACTOR * 1e6) / 1e6;
  if (cost >= ceiling) {
    return `Cost passed the job's $${job.maxUsd.toFixed(2)} limit by ${Math.round((SWEEP_USD_FACTOR - 1) * 100)}%.`;
  }
  const check = decideCheck({ ...job, launchedAt: start, maxMinutes: Infinity, maxUsd: Infinity }, instance, now);
  return check.action === "terminate" ? check.reason : null;
}

/**
 * Why the sweep terminates this instance, or null to leave it. `job` is the job it belongs to, if any. An instance
 * that isn't the one its job saved is a duplicate from a retried launch.
 */
export function sweepReason(instance: LambdaInstance, job: TrainJobRow | null, now: Date): string | null {
  if (!job) return "No training job has this instance.";
  if (isTrainTerminal(job.status)) return "The job already ended.";
  if (job.instanceId && job.instanceId !== instance.id) return "A second instance for the same job.";
  return openJobReason(job, now, instance);
}

/** Why the sweep fails this open job, or null. Jobs with a live instance are handled by sweepReason instead. */
export function staleReason(job: TrainJobRow, now: Date): string | null {
  const t = now.getTime();
  if (BEFORE_LAUNCH.includes(job.status) && t >= job.createdAt.getTime() + STUCK_AFTER_MS) {
    return `Still ${job.status} ${STUCK_AFTER_MS / MIN} minutes after it was created.`;
  }
  if (job.launchedAt && t >= job.launchedAt.getTime() + job.maxMinutes * MIN + ORPHAN_AFTER_LIMIT_MS) {
    return "The job stopped being checked, so it was ended.";
  }
  return null;
}

/**
 * The job this instance belongs to: the one that saved its id, else the one its job tag names, else (for an
 * "mm-train-" instance) the newest job with its name, since two jobs could share a name (same 8-character id prefix).
 */
function jobFor(instance: LambdaInstance, jobs: TrainJobRow[]): TrainJobRow | null {
  const saved = jobs.find((j) => j.instanceId === instance.id);
  if (saved) return saved;
  const tag = taggedJobId(instance);
  const tagged = tag ? jobs.find((j) => j.id === tag) : undefined;
  if (tagged) return tagged;
  if (!isPrefixed(instance)) return null;
  const named = jobs.filter((j) => j.instanceName === instance.name);
  return named.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

/**
 * Runs the sweep once. Each instance and job is handled on its own, so one failure doesn't stop the rest; failures
 * are listed in `errors`. A job whose instance is terminated here ends with finishJob (an open job as failed, or as
 * stopped when an admin asked; an ended one keeps its status and gets its terminatedAt and final cost).
 */
export async function sweepTraining(deps: TrainSweepDeps = sweepDeps(), now: Date = new Date()): Promise<TrainSweepResult> {
  const result: TrainSweepResult = { instances: null, terminated: [], failedJobs: [], stoppedJobs: [], errors: [] };

  // Every live instance on the account; belongsTo and jobFor decide which are the platform's.
  let all: LambdaInstance[] | null = null;
  try {
    all = (await deps.listInstances()).filter((i) => !GONE.includes(i.status));
    result.instances = all.filter(isPrefixed).length;
  } catch (err) {
    result.errors.push(`Listing Lambda instances failed: ${message(err)}`);
  }

  // Jobs stuck before launch, or left open past their limit, are ended. Their instances go with them.
  const handled = new Set<string>();
  let open: TrainJobRow[] = [];
  try {
    open = await deps.openJobs();
  } catch (err) {
    result.errors.push(`Reading open jobs failed: ${message(err)}`);
  }
  for (const job of open) {
    const reason = staleReason(job, now);
    if (!reason) continue;
    const status = sweptStatus(job);
    const error = status === "failed" ? { error: job.error || reason } : {};
    try {
      if (all) {
        const mine = all.filter((i) => !handled.has(i.id) && belongsTo(i, job));
        if (mine.length) await deps.terminateInstances(mine.map((i) => i.id));
        for (const i of mine) {
          handled.add(i.id);
          result.terminated.push({ instanceId: i.id, name: i.name ?? "", jobId: job.id, reason });
        }
        if (!mine.length && launchSent(job)) {
          // Lambda may not list the launch yet, so the job keeps its GPU slot and its cost counts until a later sweep
          // finds the instance or, UNLISTED_GRACE_MS on, calls it gone. launchStep saves an instance that still comes back.
          await deps.setStatus(job.id, status, { message: `${reason} ${UNLISTED_NOTE}`, set: { launchedAt: job.createdAt, ...error } });
        } else {
          await deps.finishJob(job.id, { status, reason, terminatedAt: now, ...(mine.length ? unsavedLaunch(job) : {}) });
        }
      } else if (job.instanceId) {
        // A saved id is always the job's own instance, so it is terminated by id without the listing.
        await deps.terminateInstances([job.instanceId]);
        handled.add(job.instanceId);
        result.terminated.push({ instanceId: job.instanceId, name: job.instanceName, jobId: job.id, reason });
        await deps.finishJob(job.id, { status, reason, terminatedAt: now });
      } else {
        // Only the listing can find an instance the job never saved, so the job ends without terminatedAt. The next
        // sweep terminates such an instance (its job has ended) and stamps terminatedAt. A launch that was sent counts
        // from createdAt, so the job keeps its GPU slot until then.
        const clock = launchSent(job) ? { launchedAt: job.createdAt } : {};
        await deps.setStatus(job.id, status, { message: reason, set: { ...clock, ...error } });
      }
      noteEnded(result, job, reason);
    } catch (err) {
      result.errors.push(`Failing job ${job.id} failed: ${message(err)}`);
    }
  }

  if (!all) {
    await sweepBySavedId(deps, open, handled, now, result);
    return result;
  }
  const listed = all;

  // An ended job whose instance isn't listed gets its terminatedAt (when it ended), so its cost stops growing. A saved
  // id is asked about first, since the listing can lag a fresh launch or miss a renamed instance.
  let unterminated: TrainJobRow[] = [];
  try {
    unterminated = await deps.unterminatedJobs();
  } catch (err) {
    result.errors.push(`Reading ended jobs failed: ${message(err)}`);
  }
  for (const job of unterminated) {
    if (!isTrainTerminal(job.status)) continue;
    if (listed.some((i) => belongsTo(i, job))) continue;
    const status = job.status as Ended;
    try {
      if (job.instanceId) {
        const instance = await deps.getInstance(job.instanceId);
        if (instance && !GONE.includes(instance.status)) {
          const reason = "The job already ended.";
          await deps.terminateInstances([instance.id]);
          handled.add(instance.id);
          result.terminated.push({ instanceId: instance.id, name: instance.name ?? job.instanceName, jobId: job.id, reason });
          await deps.finishJob(job.id, { status, reason: `The sweep terminated the instance: ${reason}`, terminatedAt: now });
          continue;
        }
      } else if (job.finishedAt && now.getTime() < job.finishedAt.getTime() + UNLISTED_GRACE_MS) {
        continue;
      }
      await deps.finishJob(job.id, { status, reason: "The instance was already gone.", terminatedAt: job.finishedAt ?? now });
    } catch (err) {
      result.errors.push(`Recording the end of job ${job.id} failed: ${message(err)}`);
    }
  }

  const rest = listed.filter((i) => !handled.has(i.id));
  if (!rest.length) return result;
  let jobs: TrainJobRow[];
  try {
    jobs = await deps.jobsForInstances({
      names: [...new Set(rest.filter(isPrefixed).map((i) => i.name as string))],
      instanceIds: rest.map((i) => i.id),
      jobIds: [...new Set(rest.map(taggedJobId).filter((id): id is string => id !== null))],
    });
  } catch (err) {
    result.errors.push(`Reading jobs for instances failed: ${message(err)}`);
    return result;
  }

  for (const instance of rest) {
    const job = jobFor(instance, jobs);
    // An instance that isn't named "mm-train-" and that no job claims is someone else's.
    if (!job && !isPrefixed(instance)) continue;
    const reason = sweepReason(instance, job, now);
    if (!reason) continue;
    const name = instance.name ?? "";
    try {
      await deps.terminateInstances([instance.id]);
      result.terminated.push({ instanceId: instance.id, name, jobId: job?.id ?? null, reason });
    } catch (err) {
      result.errors.push(`Terminating ${name} (${instance.id}) failed: ${message(err)}`);
      continue;
    }
    if (!job) continue;
    try {
      const duplicate = Boolean(job.instanceId && job.instanceId !== instance.id);
      if (job.terminatedAt) {
        // The job was recorded as terminated while this instance still ran (a launch that was never saved and that
        // Lambda listed late, or a duplicate), so its time up to now is added to the job's cost and the daily cap.
        await deps.extendTermination(job.id, { terminatedAt: now, reason: `The sweep terminated ${name} (${instance.id}): ${reason}` });
      } else if (isTrainTerminal(job.status)) {
        await deps.finishJob(job.id, {
          status: job.status as Ended,
          reason: `The sweep terminated the instance: ${reason}`,
          terminatedAt: now,
          ...unsavedLaunch(job),
        });
      } else if (duplicate) {
        // The job's workflow keeps watching its saved instance.
        await deps.recordEvent(job.id, { type: "terminated", reason: `The sweep terminated ${name} (${instance.id}): ${reason}` });
      } else {
        await deps.finishJob(job.id, {
          status: sweptStatus(job),
          reason: `The sweep terminated the instance: ${reason}`,
          terminatedAt: now,
          ...unsavedLaunch(job),
        });
        noteEnded(result, job, reason);
      }
    } catch (err) {
      result.errors.push(`Recording the sweep for job ${job.id} failed: ${message(err)}`);
    }
  }
  return result;
}

/**
 * When Lambda's listing failed: instances whose ids jobs saved are still terminated by id, since a saved id is always
 * the job's own instance and terminating one that is already gone counts as done. That covers ended jobs without
 * terminatedAt, and open jobs that openJobReason says to end (a stop request, a heartbeat rule, the limits with the
 * sweep's grace). terminatedAt is stamped now, which can only overstate the cost. An instance no job saved waits for
 * the listing.
 */
async function sweepBySavedId(
  deps: TrainSweepDeps,
  open: TrainJobRow[],
  handled: Set<string>,
  now: Date,
  result: TrainSweepResult,
): Promise<void> {
  const targets: Array<{ job: TrainJobRow; instanceId: string; reason: string; status: Ended; open: boolean }> = [];
  for (const job of open) {
    if (!job.instanceId || handled.has(job.instanceId) || staleReason(job, now)) continue;
    const reason = openJobReason(job, now);
    if (reason) targets.push({ job, instanceId: job.instanceId, reason, status: sweptStatus(job), open: true });
  }
  let ended: TrainJobRow[] = [];
  try {
    ended = await deps.unterminatedJobs();
  } catch (err) {
    result.errors.push(`Reading ended jobs failed: ${message(err)}`);
  }
  for (const job of ended) {
    if (!isTrainTerminal(job.status) || !job.instanceId || handled.has(job.instanceId)) continue;
    targets.push({ job, instanceId: job.instanceId, reason: "The job already ended.", status: job.status as Ended, open: false });
  }

  for (const { job, instanceId, reason, status, open: isOpen } of targets) {
    try {
      await deps.terminateInstances([instanceId]);
    } catch (err) {
      result.errors.push(`Terminating ${job.instanceName} (${instanceId}) by its saved id failed: ${message(err)}`);
      continue;
    }
    handled.add(instanceId);
    result.terminated.push({ instanceId, name: job.instanceName, jobId: job.id, reason });
    try {
      await deps.finishJob(job.id, { status, reason: `The sweep terminated the instance by its saved id: ${reason}`, terminatedAt: now });
      if (isOpen) noteEnded(result, job, reason);
    } catch (err) {
      result.errors.push(`Recording the sweep for job ${job.id} failed: ${message(err)}`);
    }
  }
}

/**
 * The real dependencies: the Lambda client and the database. Jobs are read without the hub state's small files
 * (jobListColumns), which the sweep never needs.
 */
export function sweepDeps(): TrainSweepDeps {
  const jobs = schema.trainingJobs;
  return {
    listInstances,
    getInstance,
    terminateInstances,
    openJobs: () =>
      db()
        .select(jobListColumns)
        .from(jobs)
        .where(notInArray(jobs.status, [...TRAIN_TERMINAL]))
        .limit(200),
    jobsForInstances: async ({ names, instanceIds, jobIds }) => {
      const match: SQL[] = [];
      if (names.length) match.push(inArray(jobs.instanceName, names));
      if (instanceIds.length) match.push(inArray(jobs.instanceId, instanceIds));
      if (jobIds.length) match.push(inArray(jobs.id, jobIds));
      if (!match.length) return [];
      return db()
        .select(jobListColumns)
        .from(jobs)
        .where(or(...match))
        .limit(500);
    },
    unterminatedJobs: () =>
      db()
        .select(jobListColumns)
        .from(jobs)
        .where(and(inArray(jobs.status, [...TRAIN_TERMINAL]), isNull(jobs.terminatedAt), isNotNull(jobs.launchedAt)))
        .limit(100),
    finishJob,
    extendTermination,
    setStatus,
    recordEvent,
  };
}
