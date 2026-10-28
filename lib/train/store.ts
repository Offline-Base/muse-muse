/**
 * Database calls for fine-tuning jobs (docs/TRAINING.md): training_jobs rows and their event log. The decisions live in
 * lib/train/logic.ts so they stay testable.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, gt, gte, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { db, schema } from "@/lib/db/client";
import { hashToken } from "@/lib/gateway/tokens";
import {
  capEventBody,
  EVALS_MAX,
  estimateCostUsd,
  evalSplit,
  instanceNameFor,
  type DatasetHead,
  type TrainJobRow,
} from "@/lib/train/logic";
import {
  isTrainTerminal,
  TRAIN_TERMINAL,
  type EvalExample,
  type EvalSummary,
  type RecipeId,
  type TrainArtifact,
  type TrainCallback,
  type TrainEventBody,
  type TrainEventView,
  type TrainExample,
  type TrainProgress,
  type TrainStatus,
} from "@/lib/train/types";

export type { DatasetHead, TrainJobRow };

/** The job token keeps working this long after the job ends, so the runner's last log lines still get in. */
export const TOKEN_GRACE_MS = 15 * 60_000;

/** Artifacts one job keeps. A run uploads a few files; past this an artifact callback is refused and not logged. */
export const ARTIFACTS_MAX = 50;

const TITLE_MAX = 200;
const MIB = 1024 ** 2;

// Kept here rather than imported from lib/http, which pulls in next/headers and doesn't belong in workflow steps.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres refuses a malformed uuid with an error, so unknown ids are answered before the query. */
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

const jobs = schema.trainingJobs;
const events = schema.trainingEvents;
const notTerminal = () => notInArray(jobs.status, [...TRAIN_TERMINAL]);
/** Jobs that haven't ended, or ended after a launch with the terminate not confirmed yet: Lambda may still be billing. */
const holdingGpu = () => or(notTerminal(), and(isNotNull(jobs.launchedAt), isNull(jobs.terminatedAt)));
const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const terminalList = () => sql.join(TRAIN_TERMINAL.map((s) => sql`${s}`), sql`, `);
const artifactCount = () => sql<number>`jsonb_array_length(coalesce(${jobs.artifacts}, '[]'::jsonb))`;

/**
 * estimateCostUsd in SQL, for finishJob's single statement: the hourly price over launch to termination, every started
 * minute counted in full, rounded to millionths. Zero without a launch.
 */
function costSql(launchedAt: SQL, terminatedAt: SQL): SQL<number> {
  return sql<number>`case
    when ${launchedAt} is null or ${terminatedAt} <= ${launchedAt} or ${jobs.priceCentsPerHour} <= 0 then 0
    else round(
      (${jobs.priceCentsPerHour}::numeric / 100) * ceil(extract(epoch from (${terminatedAt} - ${launchedAt})) / 60) / 60,
      6
    )::real
  end`;
}

export interface NewTrainJob {
  recipe: RecipeId;
  title: string;
  /** Already checked with validateParams. */
  params: Record<string, string | number>;
  instanceType: string;
  region: string;
  priceCentsPerHour: number;
  /** Already clamped with clampLimits. */
  maxMinutes: number;
  maxUsd: number;
  createdBy?: string | null;
}

/** Saves a queued job, with its instance name, and the first line of its log. */
export async function createJob(input: NewTrainJob): Promise<TrainJobRow> {
  const id = randomUUID();
  const [rows] = await db().batch([
    db()
      .insert(jobs)
      .values({
        id,
        recipe: input.recipe,
        title: input.title.trim().slice(0, TITLE_MAX) || input.recipe,
        status: "queued",
        params: input.params,
        instanceType: input.instanceType,
        region: input.region,
        priceCentsPerHour: input.priceCentsPerHour,
        maxMinutes: input.maxMinutes,
        maxUsd: input.maxUsd,
        instanceName: instanceNameFor(id, input.recipe),
        createdBy: input.createdBy ?? null,
      })
      .returning(),
    db()
      .insert(events)
      .values({ jobId: id, type: "status", payload: { type: "status", status: "queued", message: "Job queued." } }),
  ]);
  return rows[0];
}

/** One job, or null when the id is unknown or isn't a uuid. */
export async function getJob(jobId: string): Promise<TrainJobRow | null> {
  if (!isUuid(jobId)) return null;
  const [row] = await db().select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return row ?? null;
}

/** The newest jobs first. */
export async function listJobs(limit = 50): Promise<TrainJobRow[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  return db().select().from(jobs).orderBy(desc(jobs.createdAt)).limit(n);
}

/** A job's log after the given event id, oldest first. */
export async function listEvents(jobId: string, afterId = 0, limit = 500): Promise<TrainEventView[]> {
  if (!isUuid(jobId)) return [];
  const rows = await db()
    .select()
    .from(events)
    .where(and(eq(events.jobId, jobId), gt(events.id, Math.max(0, Math.floor(afterId) || 0))))
    .orderBy(asc(events.id))
    .limit(Math.max(1, Math.min(1000, limit)));
  return rows.map((r) => ({ id: r.id, type: r.type, payload: r.payload, at: r.at.toISOString() }));
}

/** Appends one row to a job's log, with its text cut to size first (capEventBody). */
export async function recordEvent(jobId: string, body: TrainEventBody): Promise<void> {
  const payload = capEventBody(body);
  await db().insert(events).values({ jobId, type: payload.type, payload });
}

/**
 * Moves a job that hasn't ended to a new status, stamps finishedAt for a terminal one, and logs it. Extra columns can
 * be set in the same update. A job that already ended keeps its status (use finishJob); returns false then.
 */
export async function setStatus(
  jobId: string,
  status: TrainStatus,
  opts: { message?: string; set?: Partial<typeof jobs.$inferInsert> } = {},
): Promise<boolean> {
  const now = new Date();
  const rows = await db()
    .update(jobs)
    .set({
      ...opts.set,
      status,
      ...(isTrainTerminal(status) ? { finishedAt: sql`coalesce(${jobs.finishedAt}, ${at(now)})` } : {}),
    })
    .where(and(eq(jobs.id, jobId), notTerminal()))
    .returning({ id: jobs.id });
  if (!rows.length) return false;
  await recordEvent(jobId, { type: "status", status, ...(opts.message ? { message: opts.message } : {}) });
  return true;
}

/** Stores the workflow run that drives the job. */
export async function attachRun(jobId: string, workflowRunId: string): Promise<void> {
  await db().update(jobs).set({ workflowRunId }).where(eq(jobs.id, jobId));
}

/**
 * Records the launched instance and moves the job to "booting". A heartbeat that already moved it to "running" is
 * kept, and so is a launch time already saved for this instance. Logs the instance and the status. Saving the same
 * instance again is fine (a retried save); a job that already holds another instance keeps it. Returns false when the
 * job already ended or holds another instance.
 */
export async function markLaunched(
  jobId: string,
  input: { instanceId: string; launchedAt: Date; ip?: string | null; tokenHash?: string },
): Promise<boolean> {
  const [row] = await db()
    .update(jobs)
    .set({
      instanceId: input.instanceId,
      launchedAt: sql`coalesce(${jobs.launchedAt}, ${at(input.launchedAt)})`,
      ...(input.ip !== undefined ? { instanceIp: input.ip } : {}),
      ...(input.tokenHash ? { tokenHash: input.tokenHash } : {}),
      status: sql`case when ${jobs.status} in ('queued', 'launching') then 'booting' else ${jobs.status} end`,
    })
    .where(
      and(eq(jobs.id, jobId), notTerminal(), or(isNull(jobs.instanceId), eq(jobs.instanceId, input.instanceId))),
    )
    .returning();
  if (!row) return false;
  await recordEvent(jobId, {
    type: "instance",
    instanceId: input.instanceId,
    instanceType: row.instanceType,
    region: row.region,
    ip: row.instanceIp,
  });
  if (row.status === "booting") await recordEvent(jobId, { type: "status", status: "booting", message: "Instance launched." });
  return true;
}

/** Stores the instance's public IP when Lambda reports a new one. */
export async function setInstanceIp(jobId: string, ip: string | null): Promise<void> {
  await db()
    .update(jobs)
    .set({ instanceIp: ip })
    .where(and(eq(jobs.id, jobId), sql`${jobs.instanceIp} is distinct from ${ip}`));
}

function progressOf(cb: Extract<TrainCallback, { type: "progress" }>): TrainProgress {
  const p: TrainProgress = {};
  if (typeof cb.step === "number" && Number.isFinite(cb.step)) p.step = cb.step;
  if (typeof cb.totalSteps === "number" && Number.isFinite(cb.totalSteps)) p.totalSteps = cb.totalSteps;
  if (typeof cb.loss === "number" && Number.isFinite(cb.loss)) p.loss = cb.loss;
  if (typeof cb.message === "string") p.message = cb.message;
  return p;
}

function artifactOf(a: TrainArtifact): TrainArtifact {
  return { name: String(a.name), kind: a.kind, url: String(a.url), bytes: Number(a.bytes) || 0 };
}

/**
 * Applies a callback from the job's runner to its row. Anything the runner sends shows it is alive: lastHeartbeatAt
 * moves, firstHeartbeatAt is set once, and "launching" or "booting" becomes "running". progress merges into the latest
 * progress, artifact is appended, done sets "succeeded" (with its summary) and failed sets "failed" (with its error),
 * both stamping finishedAt. Nothing changes for a job that already ended, or for an artifact once the job has
 * ARTIFACTS_MAX of them (artifactLimit then). Status changes are logged; the callback itself is logged by the caller
 * with recordEvent. Null when the job doesn't exist.
 */
export async function applyCallback(
  jobId: string,
  callback: TrainCallback,
  now: Date,
): Promise<{ applied: boolean; status: TrainStatus; artifactLimit?: true } | null> {
  if (!isUuid(jobId)) return null;
  const cb = capEventBody(callback) as TrainCallback;
  const alive = {
    lastHeartbeatAt: now,
    firstHeartbeatAt: sql`coalesce(${jobs.firstHeartbeatAt}, ${at(now)})`,
  };
  const toRunning = sql`case when ${jobs.status} in ('launching', 'booting') then 'running' else ${jobs.status} end`;
  let set: PgUpdateSetSource<typeof jobs>;
  switch (cb.type) {
    case "progress":
      set = {
        ...alive,
        status: toRunning,
        progress: sql`coalesce(${jobs.progress}, '{}'::jsonb) || ${JSON.stringify(progressOf(cb))}::jsonb`,
      };
      break;
    case "artifact":
      set = {
        ...alive,
        status: toRunning,
        artifacts: sql`coalesce(${jobs.artifacts}, '[]'::jsonb) || ${JSON.stringify([artifactOf(cb.artifact)])}::jsonb`,
      };
      break;
    case "done":
      set = { ...alive, status: "succeeded", finishedAt: now, summary: cb.summary ?? null };
      break;
    case "failed":
      set = { ...alive, status: "failed", finishedAt: now, error: cb.error || "The job failed." };
      break;
    default:
      set = { ...alive, status: toRunning };
  }
  // The cap is part of the update, so callbacks at once can't take a job past it.
  const room = cb.type === "artifact" ? sql`${artifactCount()} < ${ARTIFACTS_MAX}` : undefined;
  const [row] = await db()
    .update(jobs)
    .set(set)
    .where(and(eq(jobs.id, jobId), notTerminal(), room))
    .returning({ status: jobs.status, firstHeartbeatAt: jobs.firstHeartbeatAt });
  if (!row) {
    const [existing] = await db()
      .select({ status: jobs.status, artifacts: artifactCount() })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);
    if (!existing) return null;
    const full = cb.type === "artifact" && !isTrainTerminal(existing.status) && Number(existing.artifacts) >= ARTIFACTS_MAX;
    return full ? { applied: false, status: existing.status, artifactLimit: true } : { applied: false, status: existing.status };
  }
  if (cb.type === "done") {
    await recordEvent(jobId, { type: "status", status: "succeeded", message: "The job reported it finished." });
  } else if (cb.type === "failed") {
    await recordEvent(jobId, { type: "status", status: "failed", message: "The job reported a failure." });
  } else if (row.status === "running" && row.firstHeartbeatAt?.getTime() === now.getTime()) {
    await recordEvent(jobId, { type: "status", status: "running", message: "The runner reported in." });
  }
  return { applied: true, status: row.status };
}

/**
 * Asks the workflow to stop a job that hasn't ended: it terminates the instance on its next check. Logs the request,
 * again each time Stop is pressed again. Returns the job, or null when it is unknown or already ended.
 */
export async function requestStop(jobId: string): Promise<TrainJobRow | null> {
  if (!isUuid(jobId)) return null;
  const [row] = await db()
    .update(jobs)
    .set({ stopRequested: true })
    .where(and(eq(jobs.id, jobId), notTerminal()))
    .returning();
  if (!row) return null;
  await recordEvent(jobId, { type: "status", status: row.status, message: "An admin asked to stop the job." });
  return row;
}

/**
 * Ends a job once its instance is terminated: sets the final status, terminatedAt, the final cost and finishedAt, and
 * for "failed" the error (an error the runner already reported is kept). The final status is decided in the same
 * statement, from the row as it is then: a stop request makes it "stopped", a job that already ended keeps its own
 * status (a done or failed that landed while the caller was terminating wins), and only an open job takes
 * `input.status`. A second call keeps the first terminatedAt and finishedAt, so a retried step gives the same result.
 * Logs the termination once, however many calls overlap, and the status when it changed. Null when the job doesn't exist.
 *
 * `launchedAt` is for a job whose launch was never saved but whose instance was found and terminated: it becomes the
 * job's launch time (callers pass createdAt, which is earlier), so the cost of that instance is still counted.
 */
export async function finishJob(
  jobId: string,
  input: {
    status: Extract<TrainStatus, "succeeded" | "failed" | "stopped">;
    reason: string;
    terminatedAt: Date;
    launchedAt?: Date;
  },
): Promise<TrainJobRow | null> {
  if (!isUuid(jobId)) return null;
  // Neon's HTTP driver has no interactive transactions, so this is one statement. The CTE locks the row first: an
  // overlapping call waits for this one to commit, then reads the row as this one left it (read committed).
  const prior = db()
    .$with("prior")
    .as(
      db()
        .select({
          beforeId: sql<string>`${jobs.id}`.as("before_id"),
          beforeStatus: sql<TrainStatus>`${jobs.status}`.as("before_status"),
          firstTermination: sql<boolean>`${jobs.terminatedAt} is null`.as("first_termination"),
        })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .for("update"),
    );
  const status = sql<TrainStatus>`case
    when ${jobs.stopRequested} then 'stopped'
    when ${jobs.status} in (${terminalList()}) then ${jobs.status}
    else ${input.status}::text
  end`;
  const terminatedAt = sql`coalesce(${jobs.terminatedAt}, ${at(input.terminatedAt)})`;
  const launchedAt = sql`coalesce(${jobs.launchedAt}, ${input.launchedAt ? at(input.launchedAt) : sql`null::timestamptz`})`;
  const [row] = await db()
    .with(prior)
    .update(jobs)
    .set({
      status,
      launchedAt,
      terminatedAt,
      costUsd: costSql(launchedAt, terminatedAt),
      finishedAt: sql`coalesce(${jobs.finishedAt}, ${terminatedAt})`,
      error: sql`case when (${status}) = 'failed' then coalesce(nullif(${jobs.error}, ''), ${input.reason}::text) else ${jobs.error} end`,
    })
    .from(prior)
    .where(eq(jobs.id, prior.beforeId))
    .returning({ ...getTableColumns(jobs), beforeStatus: prior.beforeStatus, firstTermination: prior.firstTermination });
  if (!row) return null;
  const { beforeStatus, firstTermination, ...job } = row;
  if (firstTermination) await recordEvent(jobId, { type: "terminated", reason: input.reason });
  if (job.status !== beforeStatus) {
    // An open job only ends as something other than what was asked when an admin asked to stop it.
    const message = job.status === input.status ? input.reason : "Stopped by an admin.";
    await recordEvent(jobId, { type: "status", status: job.status, message });
  }
  return job;
}

/**
 * Jobs that may be holding a GPU, compared with TRAIN_MAX_ACTIVE before a launch: every job that hasn't ended, and
 * every ended job that launched but whose instance isn't confirmed terminated yet (the sweep stamps terminatedAt once
 * it is), since Lambda bills that instance until then.
 */
export async function activeJobCount(): Promise<number> {
  const [row] = await db().select({ n: sql<number>`count(*)::int` }).from(jobs).where(holdingGpu());
  return Number(row?.n ?? 0);
}

function startOfUtcDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Lambda spend today (UTC) across training jobs launched since midnight: the final cost of terminated jobs and the
 * running estimate of the rest. Compared with TRAIN_DAILY_USD before a launch.
 */
export async function trainingSpendToday(now: Date = new Date()): Promise<number> {
  const rows = await db()
    .select({
      priceCentsPerHour: jobs.priceCentsPerHour,
      launchedAt: jobs.launchedAt,
      terminatedAt: jobs.terminatedAt,
      costUsd: jobs.costUsd,
    })
    .from(jobs)
    .where(gte(jobs.launchedAt, startOfUtcDay(now)));
  const total = rows.reduce((sum, r) => sum + (r.terminatedAt ? r.costUsd : estimateCostUsd(r, now)), 0);
  return Math.round(total * 1e6) / 1e6;
}

/**
 * The most today's training can cost (UTC), for the TRAIN_DAILY_USD check before a launch. Like trainingSpendToday,
 * but every job that hasn't ended counts at its full dollar limit (or its estimate, once that is higher), whenever it
 * was created, and an ended job whose instance isn't confirmed terminated counts at its running estimate. So jobs
 * queued or running at the same time can't pass the cap between them.
 */
export async function trainingCommittedToday(now: Date = new Date()): Promise<number> {
  const rows = await db()
    .select({
      status: jobs.status,
      priceCentsPerHour: jobs.priceCentsPerHour,
      maxUsd: jobs.maxUsd,
      launchedAt: jobs.launchedAt,
      terminatedAt: jobs.terminatedAt,
      costUsd: jobs.costUsd,
    })
    .from(jobs)
    .where(or(gte(jobs.launchedAt, startOfUtcDay(now)), holdingGpu()));
  const total = rows.reduce((sum, r) => {
    if (!isTrainTerminal(r.status)) return sum + Math.max(r.maxUsd, estimateCostUsd(r, now));
    return sum + (r.terminatedAt ? r.costUsd : estimateCostUsd(r, now));
  }, 0);
  return Math.round(total * 1e6) / 1e6;
}

/**
 * Counts an upload grant's declared size against the job's bytes for the hour that starts at `hour`, unless that would
 * pass `capBytes`: then nothing is counted and the answer is false. One upsert, so grants at once can't pass the cap
 * between them. Counted in whole MiB in rate_limits (the hourly cleanup drops past hours), so 1 GB fits its counter.
 */
export async function reserveUploadBytes(jobId: string, bytes: number, hour: Date, capBytes: number): Promise<boolean> {
  const mib = Math.max(1, Math.ceil(bytes / MIB));
  const cap = Math.floor(capBytes / MIB);
  if (!isUuid(jobId) || mib > cap) return false;
  const limits = schema.rateLimits;
  const rows = await db()
    .insert(limits)
    .values({ key: `train-upload-bytes:${jobId}`, windowStart: hour, count: mib })
    .onConflictDoUpdate({
      target: [limits.key, limits.windowStart],
      set: { count: sql`${limits.count} + ${mib}` },
      setWhere: sql`${limits.count} + ${mib} <= ${cap}`,
    })
    .returning({ count: limits.count });
  return rows.length > 0;
}

/**
 * True when `token` is this job's token: its hash matches token_hash in constant time. False before a token exists and
 * from 15 minutes after the job ended.
 */
export async function verifyJobToken(jobId: string, token: string, now: Date = new Date()): Promise<boolean> {
  if (!isUuid(jobId) || typeof token !== "string" || !token || token.length > 512) return false;
  const [row] = await db()
    .select({ tokenHash: jobs.tokenHash, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!row?.tokenHash) return false;
  if (row.finishedAt && now.getTime() > row.finishedAt.getTime() + TOKEN_GRACE_MS) return false;
  const given = Buffer.from(hashToken(token), "utf8");
  const stored = Buffer.from(row.tokenHash, "utf8");
  return given.length === stored.length && timingSafeEqual(given, stored);
}

// ---------------------------------------------------------------------------------------------------------------
// Launch claims and late instances, for lib/train/steps.ts and lib/train/sweep.ts.

/**
 * Claims the job's one launch: a queued job with no token, no instance and no stop request moves to "launching" with
 * the new token's hash, in one guarded update, so two runs of launchStep can never both launch. Logs the status; a
 * failed log write doesn't undo the claim. False when another attempt already holds the claim, or the job was stopped
 * or ended.
 */
export async function claimLaunch(jobId: string, tokenHash: string, message: string): Promise<boolean> {
  if (!isUuid(jobId)) return false;
  const rows = await db()
    .update(jobs)
    .set({ status: "launching", tokenHash })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, "queued"),
        eq(jobs.stopRequested, false),
        isNull(jobs.tokenHash),
        isNull(jobs.instanceId),
      ),
    )
    .returning({ id: jobs.id });
  if (!rows.length) return false;
  try {
    await recordEvent(jobId, { type: "status", status: "launching", message });
  } catch (err) {
    console.error("[train] claimLaunch: logging the status failed", err instanceof Error ? err.message : err);
  }
  return true;
}

/**
 * Gives back a claim from claimLaunch after Lambda refused the launch, so nothing was launched: the job is queued with
 * no token again, and a retry can claim it. Only the claim with this token hash, on a job with no instance, is undone.
 */
export async function releaseLaunch(jobId: string, tokenHash: string): Promise<void> {
  if (!isUuid(jobId)) return;
  await db()
    .update(jobs)
    .set({ status: "queued", tokenHash: null })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "launching"), eq(jobs.tokenHash, tokenHash), isNull(jobs.instanceId)));
}

/**
 * Saves an instance on a job that has none, whatever its status: one that launched after its job had already ended
 * (markLaunched refuses those), or one only the workflow knew about. A saved launchedAt is kept. terminatedAt is
 * cleared, so the job counts as holding a GPU and its cost counts until terminateStep or the sweep terminates that
 * instance by id and finishJob stamps terminatedAt again. Logs the instance. False when the job is unknown or already
 * has an instance.
 */
export async function saveLateLaunch(jobId: string, input: { instanceId: string; launchedAt: Date }): Promise<boolean> {
  if (!isUuid(jobId)) return false;
  const [row] = await db()
    .update(jobs)
    .set({
      instanceId: input.instanceId,
      launchedAt: sql`coalesce(${jobs.launchedAt}, ${at(input.launchedAt)})`,
      terminatedAt: null,
    })
    .where(and(eq(jobs.id, jobId), isNull(jobs.instanceId)))
    .returning();
  if (!row) return false;
  await recordEvent(jobId, {
    type: "instance",
    instanceId: input.instanceId,
    instanceType: row.instanceType,
    region: row.region,
    ip: row.instanceIp,
  });
  return true;
}

/**
 * For an instance the sweep found still running after its job was recorded as terminated (a launch that was never
 * saved and that Lambda listed late, or a duplicate): moves terminatedAt to when that instance was terminated, never
 * earlier, and counts the cost again from launchedAt (createdAt when the launch was never saved, which also brings the
 * job into the daily sums), so the job page and TRAIN_DAILY_USD include that time. The cost never goes down. Logs the
 * reason. Null when the job is unknown or has no terminatedAt yet (finishJob is for that).
 */
export async function extendTermination(
  jobId: string,
  input: { terminatedAt: Date; reason: string },
): Promise<TrainJobRow | null> {
  if (!isUuid(jobId)) return null;
  const launchedAt = sql`coalesce(${jobs.launchedAt}, ${jobs.createdAt})`;
  const terminatedAt = sql`greatest(${jobs.terminatedAt}, ${at(input.terminatedAt)})`;
  const [row] = await db()
    .update(jobs)
    .set({ launchedAt, terminatedAt, costUsd: sql`greatest(${jobs.costUsd}, ${costSql(launchedAt, terminatedAt)})` })
    .where(and(eq(jobs.id, jobId), isNotNull(jobs.terminatedAt)))
    .returning();
  if (!row) return null;
  await recordEvent(jobId, { type: "terminated", reason: input.reason });
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// The sweep's heartbeat, for the launch gate in app/api/train/shared.ts.

/** The rate_limits key under which the sweep notes each run that Lambda's listing answered. */
const SWEEP_OK_KEY = "train-sweep-ok";

/**
 * Notes that the 5-minute sweep ran and Lambda's listing answered, so it could terminate anything that needed it. One
 * rate_limits row per minute (no new table); the hourly cleanup drops rows older than an hour, which is far longer than
 * the launch gate looks back.
 */
export async function recordSweepOk(now: Date = new Date()): Promise<void> {
  const limits = schema.rateLimits;
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  await db().insert(limits).values({ key: SWEEP_OK_KEY, windowStart: minute, count: 1 }).onConflictDoNothing();
}

/** The minute of the sweep's last run that Lambda's listing answered (recordSweepOk), or null when none is kept. */
export async function lastSweepOkAt(): Promise<Date | null> {
  const limits = schema.rateLimits;
  const [row] = await db()
    .select({ at: limits.windowStart })
    .from(limits)
    .where(eq(limits.key, SWEEP_OK_KEY))
    .orderBy(desc(limits.windowStart))
    .limit(1);
  return row?.at ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Eval items and their judgements, for the events route and lib/train/judge.ts.

type EvalCallback = Extract<TrainCallback, { type: "eval" }>;
type Judgement = Extract<TrainEventBody, { type: "judgement" }>;

/** The rows of a db().execute() result: Neon and PGlite both answer { rows }. */
function rowsOf(result: unknown): unknown[] {
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Logs an eval callback (cut to size with capEventBody) unless the job already has one with that index, which is a
 * retried callback, or already has `max` of them. The job row is locked first, so callbacks at once can't pass the cap
 * or record an index twice.
 */
export async function recordEvalEvent(jobId: string, body: EvalCallback, max = EVALS_MAX): Promise<"recorded" | "duplicate" | "limit"> {
  if (!isUuid(jobId)) return "limit";
  const payload = capEventBody(body) as EvalCallback;
  const index = String(payload.index);
  const [, inserted] = await db().batch([
    db().execute(sql`select id from training_jobs where id = ${jobId}::uuid for update`),
    db().execute(
      sql`insert into training_events (job_id, type, payload)
          select ${jobId}::uuid, 'eval', ${JSON.stringify(payload)}::jsonb
          where (select count(*) from training_events where job_id = ${jobId}::uuid and type = 'eval') < ${max}
            and not exists (
              select 1 from training_events where job_id = ${jobId}::uuid and type = 'eval' and payload->>'index' = ${index}
            )
          returning id`,
    ),
  ]);
  if (rowsOf(inserted).length) return "recorded";
  return (await eventAt(jobId, "eval", payload.index)) ? "duplicate" : "limit";
}

/** The first logged event of this type for the eval item at `index`, or null. */
async function eventAt(jobId: string, type: "eval" | "judgement", index: number): Promise<TrainEventBody | null> {
  if (!isUuid(jobId) || !Number.isInteger(index)) return null;
  const [row] = await db()
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.jobId, jobId), eq(events.type, type), sql`${events.payload}->>'index' = ${String(index)}`))
    .orderBy(asc(events.id))
    .limit(1);
  return row?.payload ?? null;
}

/** The indexes of the job's eval items, ascending, at most EVALS_MAX. */
export async function listEvalIndexes(jobId: string): Promise<number[]> {
  if (!isUuid(jobId)) return [];
  const rows = await db()
    .selectDistinct({ index: sql<number>`(${events.payload}->>'index')::int` })
    .from(events)
    .where(and(eq(events.jobId, jobId), eq(events.type, "eval")))
    .orderBy(sql`1`)
    .limit(EVALS_MAX);
  return rows.map((r) => Number(r.index)).filter(Number.isInteger);
}

/** The job's eval item at `index`, or null. */
export async function getEvalItem(jobId: string, index: number): Promise<EvalCallback | null> {
  const body = await eventAt(jobId, "eval", index);
  return body?.type === "eval" ? body : null;
}

/** The judgement already logged for the eval item at `index`, or null. */
export async function getJudgement(jobId: string, index: number): Promise<Judgement | null> {
  const body = await eventAt(jobId, "judgement", index);
  return body?.type === "judgement" ? body : null;
}

/** Saves the job's eval summary. It is written once judging ends and doesn't touch the job's status. */
export async function setEvalSummary(jobId: string, summary: EvalSummary): Promise<void> {
  if (!isUuid(jobId)) return;
  await db().update(jobs).set({ evalSummary: summary }).where(eq(jobs.id, jobId));
}

// ---------------------------------------------------------------------------------------------------------------
// Training datasets (lib/train/datasets.ts). Their examples can run to megabytes, so only the paging and the
// generating steps read them; everything else selects the head columns.

const datasets = schema.trainingDatasets;
const { train: _train, eval: _eval, ...datasetHeadColumns } = getTableColumns(datasets);

export interface NewDataset {
  title: string;
  task: string;
  /** Already checked: 20 to 1000. */
  requested: number;
  createdBy?: string | null;
}

/** Saves a dataset in "generating", with no examples yet. */
export async function createDataset(input: NewDataset): Promise<DatasetHead> {
  const [row] = await db()
    .insert(datasets)
    .values({
      title: input.title.trim().slice(0, TITLE_MAX) || "Dataset",
      task: input.task.trim(),
      requested: input.requested,
      createdBy: input.createdBy ?? null,
    })
    .returning(datasetHeadColumns);
  return row;
}

/** One dataset without its examples, or null when the id is unknown or isn't a uuid. */
export async function getDataset(datasetId: string): Promise<DatasetHead | null> {
  if (!isUuid(datasetId)) return null;
  const [row] = await db().select(datasetHeadColumns).from(datasets).where(eq(datasets.id, datasetId)).limit(1);
  return row ?? null;
}

/** The newest datasets first, without their examples. */
export async function listDatasets(limit = 100): Promise<DatasetHead[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 100));
  return db().select(datasetHeadColumns).from(datasets).orderBy(desc(datasets.createdAt)).limit(n);
}

/** Stores the workflow run that writes the dataset. */
export async function attachDatasetRun(datasetId: string, workflowRunId: string): Promise<void> {
  await db().update(datasets).set({ workflowRunId }).where(eq(datasets.id, datasetId));
}

/**
 * `limit` items of the dataset's train or eval examples from `offset` (0-based), the total count, the status and the
 * title, or null when the dataset is unknown. The slice is cut in SQL, so a page never loads the rest.
 */
export async function datasetPage(
  datasetId: string,
  part: "train" | "eval",
  offset: number,
  limit: number,
): Promise<{ status: DatasetHead["status"]; title: string; total: number; items: TrainExample[] | EvalExample[] } | null> {
  if (!isUuid(datasetId)) return null;
  const col = part === "train" ? datasets.train : datasets.eval;
  const from = Math.max(0, Math.floor(offset));
  const to = from + Math.max(0, Math.floor(limit));
  const [row] = await db()
    .select({
      status: datasets.status,
      title: datasets.title,
      total: sql<number>`jsonb_array_length(${col})`,
      items: sql<TrainExample[] | EvalExample[]>`coalesce((
        select jsonb_agg(t.e order by t.i) from jsonb_array_elements(${col}) with ordinality as t(e, i)
        where t.i > ${from} and t.i <= ${to}
      ), '[]'::jsonb)`,
    })
    .from(datasets)
    .where(eq(datasets.id, datasetId))
    .limit(1);
  return row ? { status: row.status, title: row.title, total: Number(row.total), items: row.items ?? [] } : null;
}

/** How many examples a generating dataset holds so far, or null when it is unknown or no longer generating. */
export async function datasetProgress(datasetId: string): Promise<number | null> {
  if (!isUuid(datasetId)) return null;
  const [row] = await db()
    .select({ length: sql<number>`jsonb_array_length(${datasets.train})` })
    .from(datasets)
    .where(and(eq(datasets.id, datasetId), eq(datasets.status, "generating")))
    .limit(1);
  return row ? Number(row.length) : null;
}

/*
 * While a dataset is generating, its eval column holds the answers of the chunk being written, as { prompt,
 * reference }, each saved as soon as Meta answers it (stageAnswer). The chunk then moves them onto train in one
 * statement (flushAnswers). So a retried chunk never asks or pays for a prompt again, and train is rewritten once a
 * chunk rather than once an answer. finishDataset fills eval with the held-out items.
 */

/** A generating dataset's examples so far and the prompts answered but not yet moved onto train, or null when it isn't generating. */
export async function answerProgress(datasetId: string): Promise<{ held: number; staged: string[] } | null> {
  if (!isUuid(datasetId)) return null;
  const [row] = await db()
    .select({
      held: sql<number>`jsonb_array_length(${datasets.train})`,
      staged: sql<string[]>`coalesce((
        select jsonb_agg(t.e ->> 'prompt' order by t.i) from jsonb_array_elements(${datasets.eval}) with ordinality as t(e, i)
      ), '[]'::jsonb)`,
    })
    .from(datasets)
    .where(and(eq(datasets.id, datasetId), eq(datasets.status, "generating")))
    .limit(1);
  return row ? { held: Number(row.held), staged: row.staged ?? [] } : null;
}

/**
 * Saves one answered prompt of the chunk being written, unless it is already saved (a retried write). False when the
 * dataset is unknown or no longer generating.
 */
export async function stageAnswer(datasetId: string, item: EvalExample): Promise<boolean> {
  if (!isUuid(datasetId)) return false;
  const one = JSON.stringify([{ prompt: item.prompt, reference: item.reference }]);
  const rows = await db()
    .update(datasets)
    .set({ eval: sql`${datasets.eval} || ${one}::jsonb` })
    .where(
      and(
        eq(datasets.id, datasetId),
        eq(datasets.status, "generating"),
        sql`not ${datasets.eval} @> jsonb_build_array(jsonb_build_object('prompt', ${item.prompt}::text))`,
      ),
    )
    .returning({ id: datasets.id });
  if (rows.length) return true;
  return (await datasetProgress(datasetId)) !== null;
}

/**
 * Moves the saved answers onto the end of train as training examples under `system`, in the order they were saved,
 * and empties the list, in one statement. Safe to run again: with nothing saved it changes nothing. Returns how many
 * examples train holds afterwards, or null when the dataset is unknown or no longer generating.
 */
export async function flushAnswers(datasetId: string, system: string): Promise<number | null> {
  if (!isUuid(datasetId)) return null;
  const [row] = await db()
    .update(datasets)
    .set({
      train: sql`${datasets.train} || coalesce((
        select jsonb_agg(
          jsonb_build_object('messages', jsonb_build_array(
            jsonb_build_object('role', 'system', 'content', ${system}::text),
            jsonb_build_object('role', 'user', 'content', t.e -> 'prompt'),
            jsonb_build_object('role', 'assistant', 'content', t.e -> 'reference')
          ))
          order by t.i
        )
        from jsonb_array_elements(${datasets.eval}) with ordinality as t(e, i)
      ), '[]'::jsonb)`,
      eval: sql`'[]'::jsonb`,
    })
    .where(and(eq(datasets.id, datasetId), eq(datasets.status, "generating")))
    .returning({ length: sql<number>`jsonb_array_length(${datasets.train})` });
  return row ? Number(row.length) : null;
}

/** Adds what a Meta call cost to the dataset, in millionths of a dollar. */
export async function addDatasetCost(datasetId: string, usd: number): Promise<void> {
  if (!isUuid(datasetId) || !(usd > 0)) return;
  await db()
    .update(datasets)
    .set({ costUsd: sql`round((${datasets.costUsd} + ${usd})::numeric, 6)::real` })
    .where(eq(datasets.id, datasetId));
}

/**
 * Turns a generating dataset that holds exactly `count` examples "ready": the items evalSplit picks from their prompts
 * move to eval as { prompt, reference } (the user and assistant messages), the near-duplicates of those it drops leave
 * train, the rest stay in train in order, and the counts and finishedAt are set. `note` goes in error, for a dataset
 * that stopped early (the page shows it). Null when it is unknown, no longer generating, or holds another count.
 */
export async function finishDataset(datasetId: string, count: number, note: string | null = null): Promise<DatasetHead | null> {
  if (!isUuid(datasetId)) return null;
  const generating = and(
    eq(datasets.id, datasetId),
    eq(datasets.status, "generating"),
    sql`jsonb_array_length(${datasets.train}) = ${count}`,
  );
  const [found] = await db()
    .select({
      prompts: sql<string[]>`coalesce((
        select jsonb_agg(coalesce(t.e #>> '{messages,1,content}', '') order by t.i)
        from jsonb_array_elements(${datasets.train}) with ordinality as t(e, i)
      ), '[]'::jsonb)`,
    })
    .from(datasets)
    .where(generating)
    .limit(1);
  if (!found) return null;
  const split = evalSplit(found.prompts ?? []);
  const among = (list: number[]) =>
    list.length ? sql`(t.i - 1) = any(array[${sql.join(list.map((i) => sql`${i}::int`), sql`, `)}]::int[])` : sql`false`;
  const held = among(split.held);
  const dropped = among(split.dropped);
  const [row] = await db()
    .update(datasets)
    .set({
      eval: sql`coalesce((
        select jsonb_agg(
          jsonb_build_object('prompt', t.e #>> '{messages,1,content}', 'reference', t.e #>> '{messages,2,content}')
          order by t.i
        )
        from jsonb_array_elements(${datasets.train}) with ordinality as t(e, i) where ${held}
      ), '[]'::jsonb)`,
      train: sql`coalesce((
        select jsonb_agg(t.e order by t.i) from jsonb_array_elements(${datasets.train}) with ordinality as t(e, i)
        where not (${held}) and not (${dropped})
      ), '[]'::jsonb)`,
      trainCount: count - split.held.length - split.dropped.length,
      evalCount: split.held.length,
      status: "ready",
      error: note ? note.slice(0, 2000) : null,
      finishedAt: new Date(),
    })
    .where(generating)
    .returning(datasetHeadColumns);
  return row ?? null;
}

/** Fails a dataset that is still generating, with a plain reason. False when it already finished. */
export async function failDataset(datasetId: string, error: string): Promise<boolean> {
  if (!isUuid(datasetId)) return false;
  const rows = await db()
    .update(datasets)
    .set({ status: "failed", error: error.slice(0, 2000) || "The dataset could not be written.", finishedAt: new Date() })
    .where(and(eq(datasets.id, datasetId), eq(datasets.status, "generating")))
    .returning({ id: datasets.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Lab results: the read-only view of /fine-tuning that anyone can open (docs/TRAINING.md "Lab results"). These reads
// select only what those pages show, so a job's instance id, IP, region, token hash, log, error and artifacts, and a
// dataset's note, author and workflow run, never leave the store for them. A ready dataset's samples come from
// datasetPage, a few of each.

const resultColumns = {
  id: jobs.id,
  recipe: jobs.recipe,
  title: jobs.title,
  status: jobs.status,
  params: jobs.params,
  instanceType: jobs.instanceType,
  costUsd: jobs.costUsd,
  createdAt: jobs.createdAt,
  launchedAt: jobs.launchedAt,
  finishedAt: jobs.finishedAt,
  terminatedAt: jobs.terminatedAt,
  evalSummary: jobs.evalSummary,
};

/** A job as the Lab results read it. */
export type ResultJobRow = Pick<TrainJobRow, keyof typeof resultColumns>;

/**
 * Jobs with results to show: succeeded, the GPU shut down, judged (an eval summary with items, so not an unjudged one)
 * and not a dry run, whose answers are fake. components/train/results.ts checks the same again (hasResults).
 */
const hasResults = () =>
  and(
    eq(jobs.status, "succeeded"),
    isNotNull(jobs.terminatedAt),
    sql`jsonb_typeof(${jobs.evalSummary}->'items') = 'number'`,
    sql`(${jobs.evalSummary}->>'items')::numeric > 0`,
    sql`(case when ${jobs.params}->>'dryRun' ~ '^[0-9]+([.][0-9]+)?$' then (${jobs.params}->>'dryRun')::numeric else 0 end) < 1`,
  );

/** Judged jobs, newest first. */
export async function listResultJobs(limit = 50): Promise<ResultJobRow[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  return db().select(resultColumns).from(jobs).where(hasResults()).orderBy(desc(jobs.createdAt)).limit(n);
}

/** One judged job, or null when the id is unknown, isn't a uuid, or the job has no results to show. */
export async function getResultJob(jobId: string): Promise<ResultJobRow | null> {
  if (!isUuid(jobId)) return null;
  const [row] = await db().select(resultColumns).from(jobs).where(and(eq(jobs.id, jobId), hasResults())).limit(1);
  return row ?? null;
}

/** Eval items and judgements read for one job: EVALS_MAX of each, with room for a judgement logged twice. */
const RESULT_EVENTS_MAX = EVALS_MAX * 4;

/**
 * A judged job's eval items and judgements, oldest first. Nothing else from its log (no log text, errors, instance or
 * artifact events), and nothing at all for a job without results.
 */
export async function listResultEvents(jobId: string): Promise<TrainEventView[]> {
  if (!isUuid(jobId)) return [];
  const judged = db().select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, jobId), hasResults()));
  const rows = await db()
    .select()
    .from(events)
    .where(and(eq(events.jobId, jobId), or(eq(events.type, "eval"), eq(events.type, "judgement")), sql`exists (${judged})`))
    .orderBy(asc(events.id))
    .limit(RESULT_EVENTS_MAX);
  return rows.map((r) => ({ id: r.id, type: r.type, payload: r.payload, at: r.at.toISOString() }));
}

const readyDatasetColumns = {
  id: datasets.id,
  title: datasets.title,
  task: datasets.task,
  status: datasets.status,
  requested: datasets.requested,
  trainCount: datasets.trainCount,
  evalCount: datasets.evalCount,
  costUsd: datasets.costUsd,
  createdAt: datasets.createdAt,
  finishedAt: datasets.finishedAt,
};

/** A ready dataset as the Lab results read it: no examples, note, author or workflow run. */
export type ReadyDatasetRow = Pick<DatasetHead, keyof typeof readyDatasetColumns>;

/** Ready datasets, newest first. */
export async function listReadyDatasets(limit = 50): Promise<ReadyDatasetRow[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  return db()
    .select(readyDatasetColumns)
    .from(datasets)
    .where(eq(datasets.status, "ready"))
    .orderBy(desc(datasets.createdAt))
    .limit(n);
}

/** One ready dataset, or null when the id is unknown, isn't a uuid, or it is still being written or failed. */
export async function getReadyDataset(datasetId: string): Promise<ReadyDatasetRow | null> {
  if (!isUuid(datasetId)) return null;
  const [row] = await db()
    .select(readyDatasetColumns)
    .from(datasets)
    .where(and(eq(datasets.id, datasetId), eq(datasets.status, "ready")))
    .limit(1);
  return row ?? null;
}
