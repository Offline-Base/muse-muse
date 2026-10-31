/**
 * The lab's queue (docs/NATIVE_LAB.md): native_jobs, and everything that moves a row in it.
 *
 * A job token only works while its run owns the job, so every token-holding call is one statement that names
 * status = 'claimed', the token's hash and its expiry in the same WHERE. Nothing here reads a row and then decides, which
 * is what keeps an old run's finish from closing a job its retry has claimed.
 *
 * Every state change also goes in the build's log as a `native` event. A lost event never fails the change: the row is
 * what counts, and the workflow reads rows.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { emit } from "@/lib/events";
import { cleanForJsonb } from "@/lib/native/agent-http";
import { hashLabToken, newJobToken, selftestToken } from "@/lib/native/lab-token";
import {
  JOB_KIND_LANE,
  NATIVE_JOB_KINDS,
  NATIVE_JOB_PRIORITY,
  type NativeArtifactKind,
  type NativeCheck,
  type NativeJobInput,
  type NativeJobKind,
  type NativeJobResult,
  type NativeLane,
  type NativeSelftestReport,
} from "@/lib/native/types";
import type { TargetId } from "@/lib/brief/schema";
import type { NativeEventBody, NativeItemState, NativeOrigin } from "@/lib/types";

const MINUTE = 60_000;

/** How urgent a job is, and so its priority and how long it may wait in the queue. */
export const NATIVE_JOB_TIERS = {
  /** An agent mid-build, with someone waiting. Its preview URL won't last. */
  agent: { priority: NATIVE_JOB_PRIORITY.agent, ttlMs: 10 * MINUTE },
  /** A check after shipping. */
  ship: { priority: NATIVE_JOB_PRIORITY.ship, ttlMs: 45 * MINUTE },
  /** Shipping checks from a batch of rebuilds, which wait behind each other. */
  batch: { priority: NATIVE_JOB_PRIORITY.ship, ttlMs: 90 * MINUTE },
  /** A second try for a check that waited too long, or a release check. */
  backfill: { priority: NATIVE_JOB_PRIORITY.backfill, ttlMs: 360 * MINUTE },
} as const;
export type NativeJobTier = keyof typeof NATIVE_JOB_TIERS;

/** At most this many jobs queued or running, across every product. */
export const QUEUE_LIMIT = 30;
/**
 * At most this many of one kind queued or running per product. The design says 2 per product, but it also gives each check
 * its own job and a phone and desktop product has four checks, so the limit is per kind.
 */
export const PRODUCT_KIND_LIMIT = 2;
/** How many times a job may be claimed. The first attempt and one retry. */
export const MAX_JOB_ATTEMPTS = 2;
/** A claimed job that hasn't sent a heartbeat for this long has lost its box. */
export const SILENT_AFTER_MS = 90_000;
/** A job token stops working this long after the job's deadline. */
const TOKEN_GRACE_MS = 15 * MINUTE;
const TOKEN_GRACE = sql`interval '15 minutes'`;
/** A rough time per job, for "about 4 minutes" in the build room. */
const ETA_SECONDS_PER_JOB = 90;
/** The codes a job may retry once on. native/lab/lib/errors.mjs has the same list, and a test holds them together. */
export const RETRYABLE_LAB_ERRORS: readonly string[] = ["download_failed", "simulator_failed", "emulator_failed", "timeout", "agent_restarted", "internal"];

const ACTIVE = ["queued", "claimed"] as const;

export type NativeJob = typeof schema.nativeJobs.$inferSelect;

/** What the build room calls the device, and the line after "Checked on". */
const KIND_LABELS: Record<NativeJobKind, { device: string; target: TargetId }> = {
  ios_sim: { device: "an iPhone simulator", target: "phone" },
  android_emu: { device: "an Android emulator", target: "phone" },
  desktop_mac: { device: "a Mac", target: "desktop" },
  desktop_windows: { device: "Windows", target: "desktop" },
  glasses_sim: { device: "an iPhone simulator with simulated glasses", target: "glasses" },
};
const LANE_LABELS: Record<NativeLane, string> = { mac: "Mac", windows: "Windows" };

/** The id `native` events name this check by. */
export function checkItem(kind: NativeJobKind): string {
  return `check:${kind}`;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? rows : [];
}

/** Adds a check's progress to its build's log. Never throws: the job's row already says what happened. */
async function emitJob(
  job: Pick<NativeJob, "runId" | "buildId" | "kind">,
  state: NativeItemState,
  title: string,
  extra: Pick<NativeEventBody, "detail" | "media" | "queue"> = {},
): Promise<void> {
  try {
    const [run] = await db().select({ origin: schema.nativeRuns.origin }).from(schema.nativeRuns).where(eq(schema.nativeRuns.id, job.runId));
    const origin: NativeOrigin = run?.origin ?? "ship";
    await emit(job.buildId, {
      type: "native",
      runId: job.runId,
      origin,
      item: checkItem(job.kind),
      target: KIND_LABELS[job.kind].target,
      state,
      title,
      ...extra,
    });
  } catch (err) {
    console.error("[native/queue] could not log a check's progress:", err instanceof Error ? err.message : err);
  }
}

function queueTitle(lane: NativeLane, ahead: number, etaSeconds: number): string {
  if (ahead === 0) return `Next up on the ${LANE_LABELS[lane]} lab.`;
  const minutes = Math.max(1, Math.round(etaSeconds / 60));
  return `Waiting for the ${LANE_LABELS[lane]} lab: ${ahead} ${ahead === 1 ? "check" : "checks"} ahead, about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

export interface EnqueueInput {
  runId: string;
  buildId: string;
  productId: string;
  kind: NativeJobKind;
  tier: NativeJobTier;
  /** Everything but the selftest token, which each claim makes. See docs/NATIVE_LAB.md, "Job inputs". */
  input: NativeJobInput;
  /** A lab shell's job: each claim hands over a selftest token. Per-product apps have no way to take one. */
  selftest?: boolean;
}

export type EnqueueResult =
  | { ok: true; jobId: string; ahead: number; etaSeconds: number }
  | { ok: false; reason: "lab_off" | "bad_input" | "queue_full" | "product_full" | "agent_busy" | "box_down"; message: string };

export interface EnqueueDeps {
  /** Starts the Windows box for a Windows job. A test's fake, or lib/native/lab-box.ts. */
  wakeWindows?: () => Promise<{ started: boolean; reason: string }>;
}

/** What wakeWindows can answer that means the job can never run this time. "racing" means another caller is on it. */
const BOX_WONT_START = ["no_box", "over_budget", "blocked", "failed"];

/**
 * Queues a check, under the limits on the queue, the product and the build. The limits and the insert hold one advisory
 * lock, so two callers can't both take the last place. Refused jobs leave no row. A Windows job also starts the Windows box,
 * since it stops itself when idle. If the box can't start, the job comes straight out again: nothing would ever run it.
 */
export async function enqueueJob(input: EnqueueInput, deps: EnqueueDeps = {}): Promise<EnqueueResult> {
  if (!env.nativeLab) return { ok: false, reason: "lab_off", message: "The device lab is off." };
  const limit = input.input.limitSeconds;
  if (input.input.v !== 1 || !Number.isInteger(limit) || limit < 30 || limit > 900) {
    return { ok: false, reason: "bad_input", message: "A job needs input.v 1 and limitSeconds from 30 to 900." };
  }
  const tier = NATIVE_JOB_TIERS[input.tier];
  const lane = JOB_KIND_LANE[input.kind];
  const jobId = randomUUID();
  const expiresAt = new Date(Date.now() + tier.ttlMs);
  const stored: NativeJobInput = input.selftest ? { ...input.input, selftest: { platformUrl: env.platformUrl } } : input.input;
  const active = sql`status in ('queued', 'claimed')`;
  const [, inserted] = await db().batch([
    db().execute(sql`select pg_advisory_xact_lock(hashtext('native_jobs_enqueue'))`),
    db().execute(sql`insert into native_jobs (id, run_id, build_id, product_id, lane, kind, priority, input, expires_at)
        select ${jobId}::uuid, ${input.runId}::uuid, ${input.buildId}::uuid, ${input.productId}::uuid, ${lane}, ${input.kind},
               ${tier.priority}::int, ${JSON.stringify(cleanForJsonb(stored))}::jsonb, ${expiresAt.toISOString()}::timestamptz
        where (select count(*) from native_jobs where ${active}) < ${QUEUE_LIMIT}
          and (select count(*) from native_jobs where ${active} and product_id = ${input.productId}::uuid and kind = ${input.kind}) < ${PRODUCT_KIND_LIMIT}
          and (${tier.priority}::int <> ${NATIVE_JOB_PRIORITY.agent}::int or not exists (
                select 1 from native_jobs where ${active} and build_id = ${input.buildId}::uuid
                  and priority = ${NATIVE_JOB_PRIORITY.agent}::int and run_id <> ${input.runId}::uuid))
        returning id`),
  ]);
  if (!rowsOf(inserted).length) return refusal(input);
  if (lane === "windows") {
    const wake = deps.wakeWindows ?? (async () => (await import("@/lib/native/lab-box")).wakeWindows());
    const woke = await wake().catch((err: unknown) => {
      console.error("[native/queue] could not wake the Windows box:", err instanceof Error ? err.message : err);
      return { started: false, reason: "failed" };
    });
    if (!woke.started && BOX_WONT_START.includes(woke.reason)) {
      await db().delete(schema.nativeJobs).where(and(eq(schema.nativeJobs.id, jobId), eq(schema.nativeJobs.status, "queued")));
      const message = `Not checked on ${KIND_LABELS[input.kind].device} this time: the Windows lab didn't start.`;
      await emitJob({ runId: input.runId, buildId: input.buildId, kind: input.kind }, "skipped", message);
      return { ok: false, reason: "box_down", message };
    }
  }
  const position = await queuePosition(jobId);
  const ahead = position?.ahead ?? 0;
  const etaSeconds = position?.etaSeconds ?? 0;
  await emitJob({ runId: input.runId, buildId: input.buildId, kind: input.kind }, "queued", queueTitle(lane, ahead, etaSeconds), {
    queue: { ahead, etaSeconds },
  });
  return { ok: true, jobId, ahead, etaSeconds };
}

/** Why an insert found no room. This only explains a refusal that has already happened, so its read can be plain. */
async function refusal(input: EnqueueInput): Promise<Extract<EnqueueResult, { ok: false }>> {
  const active = await db()
    .select({ buildId: schema.nativeJobs.buildId, productId: schema.nativeJobs.productId, kind: schema.nativeJobs.kind, priority: schema.nativeJobs.priority })
    .from(schema.nativeJobs)
    .where(inArray(schema.nativeJobs.status, [...ACTIVE]));
  if (active.length >= QUEUE_LIMIT) return { ok: false, reason: "queue_full", message: "The device lab's queue is full. Try again in a few minutes." };
  if (active.filter((j) => j.productId === input.productId && j.kind === input.kind).length >= PRODUCT_KIND_LIMIT) {
    return { ok: false, reason: "product_full", message: "This product already has that check waiting." };
  }
  return { ok: false, reason: "agent_busy", message: "This build already has a device run going. Wait for it to finish." };
}

/** How many jobs run before this one, for "2 checks ahead, about 4 minutes". Null when it isn't queued. */
export async function queuePosition(jobId: string): Promise<{ ahead: number; etaSeconds: number } | null> {
  const [job] = await db().select().from(schema.nativeJobs).where(eq(schema.nativeJobs.id, jobId));
  if (!job || job.status !== "queued") return null;
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.nativeJobs)
    .where(
      and(
        eq(schema.nativeJobs.lane, job.lane),
        or(
          eq(schema.nativeJobs.status, "claimed"),
          and(
            eq(schema.nativeJobs.status, "queued"),
            // Higher priority first, then older first, as the claim orders them.
            sql`(${job.priority}::int, ${schema.nativeJobs.createdAt}) < (${schema.nativeJobs.priority}, ${job.createdAt.toISOString()}::timestamptz)`,
          ),
        ),
      ),
    );
  const ahead = Number(row?.n ?? 0);
  return { ahead, etaSeconds: ahead * ETA_SECONDS_PER_JOB };
}

export interface ClaimedJob {
  /** The row, with this attempt's selftest token in its input. The token is only in this reply, never in the row. */
  job: NativeJob;
  /** The job's token, in plain text for this one reply. */
  token: string;
}

/** A lab shell's input for one attempt. Its token dies when the job token does. */
function withSelftestToken(job: NativeJob): NativeJobInput {
  const selftest = job.input.selftest as { platformUrl?: string } | undefined;
  if (!selftest) return job.input;
  const expiresAt = new Date((job.deadlineAt ?? new Date()).getTime() + TOKEN_GRACE_MS);
  return { ...job.input, selftest: { ...selftest, token: selftestToken(job.id, job.attempts, expiresAt) } };
}

/**
 * Gives the next job for this lane to one box, or null. One statement, so a job goes to one box only. It clears the stored
 * selftest report in the same step, since a retry keeps its job id.
 */
export async function claimJob(lane: NativeLane, kinds: readonly string[]): Promise<ClaimedJob | null> {
  const offered = kinds.filter((kind): kind is NativeJobKind => (NATIVE_JOB_KINDS as readonly string[]).includes(kind) && JOB_KIND_LANE[kind as NativeJobKind] === lane);
  if (!offered.length) return null;
  const token = newJobToken();
  const next = sql`(select id from native_jobs
      where lane = ${lane} and status = 'queued' and expires_at > now() and kind in (${sql.join(offered.map((kind) => sql`${kind}`), sql`, `)})
      order by priority desc, created_at for update skip locked limit 1)`;
  const [job] = await db()
    .update(schema.nativeJobs)
    .set({
      status: "claimed",
      claimedAt: sql`now()`,
      heartbeatAt: sql`now()`,
      attempts: sql`${schema.nativeJobs.attempts} + 1`,
      tokenHash: hashLabToken(token),
      selftest: null,
      deadlineAt: sql`now() + (${schema.nativeJobs.input}->>'limitSeconds')::int * interval '1 second'`,
    })
    .where(eq(schema.nativeJobs.id, next))
    .returning();
  if (!job) return null;
  await emitJob(job, "running", `Checking on ${KIND_LABELS[job.kind].device}.`);
  return { job: { ...job, input: withSelftestToken(job) }, token };
}

/** The row test for "this token's run owns this job". Every token-holding call goes through it. */
function ownedBy(jobId: string, token: string) {
  return and(
    eq(schema.nativeJobs.id, jobId),
    eq(schema.nativeJobs.status, "claimed"),
    eq(schema.nativeJobs.tokenHash, hashLabToken(token)),
    sql`${schema.nativeJobs.deadlineAt} + ${TOKEN_GRACE} > now()`,
  );
}

/** Notes a heartbeat. False when the token's run no longer owns the job. */
export async function recordHeartbeat(jobId: string, token: string): Promise<boolean> {
  const rows = await db()
    .update(schema.nativeJobs)
    .set({ heartbeatAt: sql`now()` })
    .where(ownedBy(jobId, token))
    .returning({ id: schema.nativeJobs.id });
  return rows.length > 0;
}

/** The job, when this token's run owns it. */
export async function ownedJob(jobId: string, token: string): Promise<NativeJob | null> {
  const [job] = await db().select().from(schema.nativeJobs).where(ownedBy(jobId, token));
  return job ?? null;
}

/**
 * Keeps what the shell posted, as sent apart from text Postgres can't store. False when this attempt isn't the one running,
 * so nothing is waiting for it. A shell left over from the last attempt can't write over this one's report.
 */
export async function saveSelftest(jobId: string, attempt: number, report: NativeSelftestReport): Promise<boolean> {
  const rows = await db()
    .update(schema.nativeJobs)
    .set({ selftest: cleanForJsonb(report) })
    .where(and(eq(schema.nativeJobs.id, jobId), eq(schema.nativeJobs.status, "claimed"), eq(schema.nativeJobs.attempts, attempt)))
    .returning({ id: schema.nativeJobs.id });
  return rows.length > 0;
}

export interface FinishedArtifact {
  kind: NativeArtifactKind;
  platform: string | null;
  device: string | null;
  caption: string | null;
  url: string;
  pathname: string;
  bytes: number;
  sha256: string | null;
}

export type FinishResult = { state: "gone" } | { state: "retrying" | "finished"; job: Pick<NativeJob, "id" | "status"> };

const REQUEUE = {
  status: "queued" as const,
  tokenHash: null,
  claimedAt: null,
  heartbeatAt: null,
  deadlineAt: null,
  selftest: null,
  result: null,
};

/**
 * Closes a job with what the agent reported. One statement sets the row and adds its artifacts, so a job can't end up closed
 * with its files lost. A lab error the box may do better at gets its one retry instead, and keeps no files.
 */
export async function finishJob(
  job: NativeJob,
  token: string,
  reported: NativeJobResult,
  reportedArtifacts: FinishedArtifact[],
): Promise<FinishResult> {
  // A product's own text is in here, and it mustn't be able to turn its failed check into a lab error.
  const result = cleanForJsonb(reported);
  const artifacts = cleanForJsonb(reportedArtifacts);
  const code = (result.error as { code?: unknown } | null | undefined)?.code;
  const retry = result.outcome === "lab_error" && typeof code === "string" && RETRYABLE_LAB_ERRORS.includes(code) && job.attempts < MAX_JOB_ATTEMPTS;
  if (retry) {
    const rows = await db().update(schema.nativeJobs).set(REQUEUE).where(ownedBy(job.id, token)).returning({ id: schema.nativeJobs.id });
    if (!rows.length) return { state: "gone" };
    await emitJob(job, "queued", `Trying the check on ${KIND_LABELS[job.kind].device} again.`, { detail: result.summary });
    return { state: "retrying", job: { id: job.id, status: "queued" } };
  }
  const status = result.outcome === "passed" ? "done" : "failed";
  const check: NativeCheck | null = result.outcome === "lab_error" ? null : result.outcome;
  const closed = await db().execute(sql`with closed as (
      update native_jobs set status = ${status}, result = ${JSON.stringify(result)}::jsonb, finished_at = now(), token_hash = null
      where ${ownedBy(job.id, token)}
      returning id, run_id, product_id
    ), added as (
      insert into native_artifacts (product_id, run_id, job_id, kind, platform, device, caption, url, pathname, bytes, sha256, check_result)
      select closed.product_id, closed.run_id, closed.id, a.kind, a.platform, a.device, a.caption, a.url, a.pathname, a.bytes, a.sha256, ${check}::text
      from closed cross join jsonb_to_recordset(${JSON.stringify(artifacts)}::jsonb)
        as a(kind text, platform text, device text, caption text, url text, pathname text, bytes integer, sha256 text)
      returning id
    )
    select id from closed`);
  if (!rowsOf(closed).length) return { state: "gone" };
  await emitJob(job, result.outcome === "lab_error" ? "skipped" : status === "done" ? "done" : "failed", result.summary, {
    media: mediaOf(artifacts),
  });
  return { state: "finished", job: { id: job.id, status } };
}

/** The pictures and clip a check left, for the build room. The caption always says what really ran. */
function mediaOf(artifacts: FinishedArtifact[]): NativeEventBody["media"] {
  const poster = artifacts.find((a) => a.kind === "poster")?.url ?? null;
  const media: NonNullable<NativeEventBody["media"]> = [];
  for (const a of artifacts) if (a.kind === "clip") media.push({ kind: "video", url: a.url, posterUrl: poster, caption: a.caption ?? "" });
  for (const a of artifacts) if (a.kind === "shot") media.push({ kind: "image", url: a.url, caption: a.caption ?? "" });
  return media.length ? media : undefined;
}

/** Puts a lane's running jobs back in the queue and ends their tokens. Only the statement, so it can share a caller's batch. */
export function requeueLaneJobs(lane: NativeLane) {
  return db()
    .update(schema.nativeJobs)
    .set(REQUEUE)
    .where(and(eq(schema.nativeJobs.lane, lane), eq(schema.nativeJobs.status, "claimed")))
    .returning();
}

/** Tells the build room about jobs requeueLaneJobs took back. */
export async function noteLaneJobsRequeued(jobs: NativeJob[]): Promise<void> {
  await Promise.all(jobs.map((job) => emitJob(job, "queued", `The lab's token changed, so the check on ${KIND_LABELS[job.kind].device} will run again.`)));
}

/** Ends what an agent run has going, since its preview URL is going away. A running box learns from its next heartbeat. */
export async function cancelAgentJobs(buildId: string): Promise<number> {
  if (!env.nativeLab) return 0;
  const rows = await db()
    .update(schema.nativeJobs)
    .set({ status: "canceled", tokenHash: null, finishedAt: sql`now()` })
    .where(
      and(
        eq(schema.nativeJobs.buildId, buildId),
        eq(schema.nativeJobs.priority, NATIVE_JOB_PRIORITY.agent),
        inArray(schema.nativeJobs.status, [...ACTIVE]),
      ),
    )
    .returning();
  await Promise.all(rows.map((job) => emitJob(job, "skipped", `Stopped the check on ${KIND_LABELS[job.kind].device}: the build ended.`)));
  return rows.length;
}

/** Every job of a run, for whoever is waiting on it. */
export async function runJobs(runId: string): Promise<NativeJob[]> {
  return db().select().from(schema.nativeJobs).where(eq(schema.nativeJobs.runId, runId));
}

function lostResult(job: NativeJob): NativeJobResult {
  return {
    outcome: "lab_error",
    informational: job.kind === "glasses_sim",
    summary: `Not checked on ${KIND_LABELS[job.kind].device}: the lab stopped answering.`,
    error: { code: "internal", message: "The lab stopped sending heartbeats." },
  };
}

/**
 * Jobs whose box went quiet. Each gets one more try, and after that it fails as a lab error. Clearing token_hash is what
 * makes a late call from the old run answer 410. A job past its deadline plus the token's grace counts too, for a box that
 * keeps sending heartbeats but never finishes.
 */
export async function requeueSilentJobs(now: Date = new Date()): Promise<{ requeued: number; failed: number }> {
  const quietSince = new Date(now.getTime() - SILENT_AFTER_MS);
  const stale = await db()
    .select()
    .from(schema.nativeJobs)
    .where(
      and(
        eq(schema.nativeJobs.status, "claimed"),
        or(lte(schema.nativeJobs.heartbeatAt, quietSince), sql`${schema.nativeJobs.deadlineAt} + ${TOKEN_GRACE} <= ${now.toISOString()}::timestamptz`),
      ),
    );
  let requeued = 0;
  let failed = 0;
  for (const job of stale) {
    // Matching the attempt means a job that finished or was claimed again since the read is left alone.
    const same = and(eq(schema.nativeJobs.id, job.id), eq(schema.nativeJobs.status, "claimed"), eq(schema.nativeJobs.attempts, job.attempts));
    if (job.attempts < MAX_JOB_ATTEMPTS) {
      const rows = await db().update(schema.nativeJobs).set(REQUEUE).where(same).returning({ id: schema.nativeJobs.id });
      if (rows.length) {
        requeued += 1;
        await emitJob(job, "queued", `The lab went quiet, so the check on ${KIND_LABELS[job.kind].device} will run again.`);
      }
    } else {
      const result = lostResult(job);
      const rows = await db()
        .update(schema.nativeJobs)
        .set({ status: "failed", tokenHash: null, finishedAt: now, result })
        .where(same)
        .returning({ id: schema.nativeJobs.id });
      if (rows.length) {
        failed += 1;
        await emitJob(job, "skipped", result.summary);
      }
    }
  }
  return { requeued, failed };
}

/**
 * Queued jobs that waited too long. A shipped product's check gets a low-priority second try, which can wait hours, since
 * the live URL stays up. An agent's check doesn't: its preview is gone by then.
 */
export async function expireQueuedJobs(now: Date = new Date(), deps: EnqueueDeps = {}): Promise<{ expired: number; backfilled: number }> {
  const expired = await db()
    .update(schema.nativeJobs)
    .set({ status: "expired", tokenHash: null, finishedAt: now })
    .where(and(eq(schema.nativeJobs.status, "queued"), lte(schema.nativeJobs.expiresAt, now)))
    .returning();
  let backfilled = 0;
  for (const job of expired) {
    const again = job.priority === NATIVE_JOB_PRIORITY.ship;
    await emitJob(
      job,
      again ? "queued" : "skipped",
      again
        ? `The device lab was busy, so the check on ${KIND_LABELS[job.kind].device} will run later.`
        : `Not checked on ${KIND_LABELS[job.kind].device} this time: the device lab was busy.`,
    );
    if (!again) continue;
    const { selftest, ...input } = job.input;
    const queued = await enqueueJob(
      {
        runId: job.runId,
        buildId: job.buildId,
        productId: job.productId,
        kind: job.kind,
        tier: "backfill",
        input: input as NativeJobInput,
        selftest: Boolean(selftest),
      },
      deps,
    ).catch((err) => {
      console.error("[native/queue] could not queue a second try:", err instanceof Error ? err.message : err);
      return null;
    });
    if (queued?.ok) {
      backfilled += 1;
      continue;
    }
    // The build room last heard "will run later", so it needs telling. box_down has already said so.
    if (queued?.reason !== "box_down") await emitJob(job, "skipped", `Not checked on ${KIND_LABELS[job.kind].device} this time: the device lab was busy.`);
  }
  return { expired: expired.length, backfilled };
}

/** Queued and running jobs on a lane, and when one last touched it, for the idle backstop. */
export async function laneActivity(lane: NativeLane): Promise<{ queued: number; claimed: number; lastJobAt: Date | null }> {
  const [row] = await db()
    .select({
      queued: sql<number>`count(*) filter (where ${schema.nativeJobs.status} = 'queued' and ${schema.nativeJobs.expiresAt} > now())::int`,
      claimed: sql<number>`count(*) filter (where ${schema.nativeJobs.status} = 'claimed')::int`,
      lastJobAt: sql<string | Date | null>`max(greatest(${schema.nativeJobs.claimedAt}, ${schema.nativeJobs.heartbeatAt}, ${schema.nativeJobs.finishedAt}))`,
    })
    .from(schema.nativeJobs)
    .where(eq(schema.nativeJobs.lane, lane));
  return {
    queued: Number(row?.queued ?? 0),
    claimed: Number(row?.claimed ?? 0),
    lastJobAt: row?.lastJobAt ? new Date(row.lastJobAt) : null,
  };
}
