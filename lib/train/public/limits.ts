/**
 * What a visitor may start (open-train.md "Shape", owner's "Visitors from day one"): per visitor and per IP each UTC day,
 * real runs, dry runs and datasets of their own rows; each visitor job within 60 minutes, $4 and 120 steps; one visitor
 * job on a GPU at once; and $15 a day across every visitor, inside TRAIN_DAILY_USD. All from lib/env.ts.
 *
 * Counters are rate_limits rows at dayWindow (the end of the UTC day, so the hourly prune keeps them), taken with
 * reserveCounter: reserve first, in one statement that can't pass the limit, and give back with adjustCounter when a
 * later check refuses, as the gateway's counters do. A Reservation is plain data, so a later step can give it back
 * after a launch fails.
 *
 * One visitor job at a time (PUBLIC_TRAIN_MAX_ACTIVE) is a slot taken in one statement, not only a count of jobs
 * already on a GPU: two visitors starting at the same moment both see no job yet, so the count alone would let both
 * through. The slot is held from the reservation until the job ends (endVisitorRun) or the launch fails
 * (releaseReservation), and stops counting on its own within an hour if neither ever runs.
 */
import { and, eq, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { dayWindow, secondsUntil } from "@/lib/docs/proxy/limits";
import { env } from "@/lib/env";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import type { Refusal } from "@/lib/train/public/identity";
import { visitorCounterKey } from "@/lib/train/public/reserved";
import { TRAIN_TERMINAL } from "@/lib/train/types";

export interface VisitorLimits {
  runsPerDay: number;
  dryRunsPerDay: number;
  datasetsPerDay: number;
  datasetMaxRows: number;
  /** One IP may do this many times what one visitor may. */
  ipFactor: number;
  cookiesPerIpPerDay: number;
  job: { maxMinutes: number; maxUsd: number; maxSteps: number };
  maxActive: number;
  /** Every visitor together, per UTC day, already within TRAIN_DAILY_USD. */
  dailyUsd: number;
  /** What one IP's visitors may ever commit to GPUs, so clearing a cookie doesn't reset TRAIN_USER_LIMIT_USD. */
  ipLifetimeUsd?: number;
}

/** The limits as lib/env.ts sets them now. */
export function visitorLimits(): VisitorLimits {
  return {
    runsPerDay: env.publicTrainRunsPerDay,
    dryRunsPerDay: env.publicTrainDryRunsPerDay,
    datasetsPerDay: env.publicTrainDatasetsPerDay,
    datasetMaxRows: env.publicTrainDatasetMaxRows,
    ipFactor: env.publicTrainIpFactor,
    cookiesPerIpPerDay: env.publicTrainCookiesPerIp,
    job: { maxMinutes: env.publicTrainJobMaxMinutes, maxUsd: env.publicTrainJobMaxUsd, maxSteps: env.publicTrainJobMaxSteps },
    maxActive: env.publicTrainMaxActive,
    dailyUsd: env.publicTrainDailyUsd,
    ipLifetimeUsd: env.trainUserLimitUsd * Math.max(1, env.publicTrainIpFactor),
  };
}

/** Who the counters are for: the visitor's trainer id (or signed-in user id) and their IP key. */
export interface CounterSubject {
  trainerId: string;
  ip: string;
  limits: VisitorLimits;
}

export type CounterKind = "run" | "dry" | "dataset";

export const ipCounterKey = (kind: CounterKind, ip: string) => `train-pub:${kind}:ip:${ip}`;
/** One IP's committed GPU dollars for good, in whole cents, under a window that never starts. */
export const ipLifetimeKey = (ip: string) => `train-pub:usd:ip:${ip}`;
export const IP_LIFETIME_WINDOW = new Date("2100-01-01T00:00:00.000Z");
/** Every visitor's committed GPU dollars today, in whole cents. */
export const USD_KEY = "train-pub:usd";
/** The visitor GPU slots taken, per SLOT_BUCKET_MS bucket. */
export const SLOT_KEY = "train-pub:slot";
/**
 * A slot's row is the end of its 30-minute bucket, and a take also counts the bucket before, so a slot nobody gives
 * back stops counting 30 to 60 minutes after it was taken (the hourly prune of rate_limits keeps rows that young).
 * By then the job's own row, if one was written, holds its place through visitorActiveJobCount.
 */
export const SLOT_BUCKET_MS = 30 * 60_000;

export interface Reservation {
  items: Array<{ key: string; window: string; amount: number }>;
}

/** Gives a whole reservation back. Never below zero. */
export async function releaseReservation(r: Reservation): Promise<void> {
  await Promise.all(r.items.map((i) => adjustCounter(i.key, new Date(i.window), -i.amount)));
}

const cents = (usd: number) => (Number.isFinite(usd) && usd > 0 ? Math.ceil(usd * 100 - 1e-6) : 0);

const WORDS: Record<CounterKind, [string, string]> = {
  run: ["run", "runs"],
  dry: ["dry run", "dry runs"],
  dataset: ["dataset", "datasets"],
};
const count = (n: number, kind: CounterKind) => `${n} ${WORDS[kind][n === 1 ? 0 : 1]}`;

/** Takes one of the visitor's and one of their IP's `kind` for today, or gives back what it took and refuses. */
async function takeDaily(s: CounterSubject, kind: CounterKind, perVisitor: number, now: Date, held: Reservation): Promise<Refusal | null> {
  const day = dayWindow(now);
  const window = day.toISOString();
  const retryAfterSeconds = secondsUntil(day, now);
  const mine = visitorCounterKey(kind, s.trainerId);
  if ((await reserveCounter(mine, day, 1, perVisitor)) === null) {
    return { ok: false, status: 429, code: `visitor_daily_${kind}`, error: `Visitors can start ${count(perVisitor, kind)} a day. Try again tomorrow.`, retryAfterSeconds };
  }
  held.items.push({ key: mine, window, amount: 1 });
  const perIp = perVisitor * Math.max(1, s.limits.ipFactor);
  const ipKey = ipCounterKey(kind, s.ip);
  if ((await reserveCounter(ipKey, day, 1, perIp)) === null) {
    return { ok: false, status: 429, code: `ip_daily_${kind}`, error: `This network has started ${count(perIp, kind)} today, the most it can. Try again tomorrow.`, retryAfterSeconds };
  }
  held.items.push({ key: ipKey, window, amount: 1 });
  return null;
}

/** A visitor job's asked limits, checked against theirs (each at most, never above). */
export function checkVisitorJob(job: { maxMinutes: number; maxUsd: number; steps: number }, limits: VisitorLimits): Refusal | null {
  const { maxMinutes, maxUsd, maxSteps } = limits.job;
  const over =
    !(job.maxMinutes > 0 && job.maxMinutes <= maxMinutes) || !(job.maxUsd > 0 && job.maxUsd <= maxUsd) || !(job.steps > 0 && job.steps <= maxSteps);
  if (!over) return null;
  return {
    ok: false,
    status: 400,
    code: "visitor_job_limits",
    error: `A visitor's run can use up to ${maxMinutes} minutes, $${maxUsd.toFixed(2)} and ${maxSteps} steps.`,
  };
}

/** The ceilings a visitor's plan is made within (planSettings' `ceilings`). */
export function visitorJobCeilings(limits: VisitorLimits): { maxMinutes: number; maxUsd: number } {
  return { maxMinutes: limits.job.maxMinutes, maxUsd: limits.job.maxUsd };
}

const jobs = schema.trainingJobs;
const holdingGpu = () =>
  or(notInArray(jobs.status, [...TRAIN_TERMINAL]), and(isNotNull(jobs.launchedAt), isNull(jobs.terminatedAt)));

/**
 * Jobs holding a GPU (lib/train/store.ts activeJobCount's rule) that a visitor made: a trainer's hidden row or a
 * signed-in builder. A job by an admin row, or by any ADMIN_EMAILS address, doesn't count: automation acts as the first
 * ADMIN_EMAILS row, and an OPEN_ACCESS=admin preview's row, whose is_admin column may be false.
 */
export async function visitorActiveJobCount(): Promise<number> {
  const admins = env.adminEmails;
  const notAdmin = and(eq(schema.users.isAdmin, false), admins.length ? notInArray(schema.users.email, admins) : undefined);
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .innerJoin(schema.users, eq(schema.users.id, jobs.createdBy))
    .where(and(holdingGpu(), notAdmin));
  return Number(row?.n ?? 0);
}

/** The end of the slot bucket `now` is in: the slot's rate_limits row. */
export function slotWindow(now: Date): Date {
  return new Date((Math.floor(now.getTime() / SLOT_BUCKET_MS) + 1) * SLOT_BUCKET_MS);
}

/**
 * Takes one of `limit` visitor GPU slots in one statement (acquireInFlight's shape, with this file's bucket): the upsert
 * locks the bucket's row, so of visitors starting at once only `limit` get one. Returns the row's window, or null.
 */
async function takeSlot(limit: number, now: Date): Promise<Date | null> {
  const window = slotWindow(now);
  const previous = new Date(window.getTime() - SLOT_BUCKET_MS);
  const held = sql`coalesce((select p.count from rate_limits p where p.key = ${SLOT_KEY} and p.window_start = ${previous.toISOString()}::timestamptz), 0)`;
  const rows = await db()
    .insert(schema.rateLimits)
    .select(sql`select ${SLOT_KEY}, ${window.toISOString()}::timestamptz, 1 where ${held} < ${limit}::int`)
    .onConflictDoUpdate({
      target: [schema.rateLimits.key, schema.rateLimits.windowStart],
      set: { count: sql`${schema.rateLimits.count} + 1` },
      setWhere: sql`${schema.rateLimits.count} + ${held} < ${limit}::int`,
    })
    .returning({ count: schema.rateLimits.count });
  return rows.length ? window : null;
}

/**
 * 409 when visitor jobs already hold every slot. Before the job row exists, `including` is 0: refused at the max. After
 * it is written, pass 1 for an extra recheck (the jobs route's own pattern). reserveVisitorRun's slot is what keeps two
 * starts at once apart; this count is what holds a running job's place once the slot has aged out.
 */
export async function checkVisitorActive(limits: VisitorLimits, including: 0 | 1 = 0): Promise<Refusal | null> {
  const active = await visitorActiveJobCount();
  if (active - including < limits.maxActive) return null;
  return GPU_BUSY;
}

const GPU_BUSY: Refusal = {
  ok: false,
  status: 409,
  code: "visitor_gpu_busy",
  error: "Another visitor's run is on the GPU now. Try again once it finishes, in about an hour.",
};
const PAUSED: Refusal = { ok: false, status: 503, code: "public_training_paused", error: "Visitor training is paused today." };

export type ReserveResult = { ok: true; reservation: Reservation } | Refusal;

/**
 * Before a visitor job is written: the job's limits, no visitor job already on every GPU slot, then one of the
 * visitor's and their IP's runs (or dry runs) for today, then the job's whole dollar limit against every visitor's day,
 * then a GPU slot. Any refusal gives back what was taken. On success, keep the reservation with the job (it is plain
 * data): give it all back (releaseReservation) if the launch fails before a GPU starts, or call endVisitorRun once the
 * job ends. Never both.
 */
export async function reserveVisitorRun(
  s: CounterSubject,
  job: { dryRun: boolean; maxMinutes: number; maxUsd: number; steps: number },
  now: Date = new Date(),
): Promise<ReserveResult> {
  const bad = checkVisitorJob(job, s.limits);
  if (bad) return bad;
  if (s.limits.dailyUsd <= 0 || s.limits.maxActive <= 0) return PAUSED;
  const busy = await checkVisitorActive(s.limits);
  if (busy) return busy;
  const held: Reservation = { items: [] };
  const kind: CounterKind = job.dryRun ? "dry" : "run";
  const refused = await takeDaily(s, kind, job.dryRun ? s.limits.dryRunsPerDay : s.limits.runsPerDay, now, held);
  if (refused) {
    await releaseReservation(held);
    return refused;
  }
  const day = dayWindow(now);
  const amount = cents(job.maxUsd);
  if ((await reserveCounter(USD_KEY, day, amount, Math.floor(s.limits.dailyUsd * 100 + 1e-6))) === null) {
    await releaseReservation(held);
    return {
      ok: false,
      status: 503,
      code: "public_daily_usd",
      error: `Visitors together have used today's $${s.limits.dailyUsd.toFixed(2)} for training. Try again tomorrow.`,
      retryAfterSeconds: secondsUntil(day, now),
    };
  }
  held.items.push({ key: USD_KEY, window: day.toISOString(), amount });
  if (s.limits.ipLifetimeUsd !== undefined) {
    const key = ipLifetimeKey(s.ip);
    if ((await reserveCounter(key, IP_LIFETIME_WINDOW, amount, Math.floor(s.limits.ipLifetimeUsd * 100 + 1e-6))) === null) {
      await releaseReservation(held);
      return { ok: false, status: 429, code: "ip_lifetime_usd", error: "This network has used its whole GPU limit for visitors." };
    }
    held.items.push({ key, window: IP_LIFETIME_WINDOW.toISOString(), amount });
  }
  const slot = await takeSlot(s.limits.maxActive, now);
  if (!slot) {
    await releaseReservation(held);
    return GPU_BUSY;
  }
  held.items.push({ key: SLOT_KEY, window: slot.toISOString(), amount: 1 });
  return { ok: true, reservation: held };
}

/**
 * Gives back the part of a visitor job's dollar hold it didn't spend, so the day's total is what visitors actually
 * used. The counters for runs stay taken. endVisitorRun does this and frees the GPU slot; call that when a job ends.
 */
export async function settleVisitorSpend(r: Reservation, spentUsd: number): Promise<void> {
  for (const held of r.items) {
    if (held.key !== USD_KEY && !held.key.startsWith("train-pub:usd:ip:")) continue;
    const unspent = held.amount - Math.min(held.amount, cents(spentUsd));
    if (unspent > 0) await adjustCounter(held.key, new Date(held.window), -unspent);
  }
}

/**
 * Once a visitor job has ended (succeeded, failed after launch, stopped): settles its dollars (settleVisitorSpend) and
 * frees its GPU slot. Call it once per job, and not for a launch already given back with releaseReservation.
 */
export async function endVisitorRun(r: Reservation, spentUsd: number): Promise<void> {
  await settleVisitorSpend(r, spentUsd);
  await Promise.all(r.items.filter((i) => i.key === SLOT_KEY).map((i) => adjustCounter(i.key, new Date(i.window), -i.amount)));
}

/**
 * Where a visitor's dataset may come from. Their own rows, or a lab dataset that is already ready (no new dataset).
 * "contributor" is a folder's writer, and "tune_writer" a described run's own, both the owner's Nov 1 decision (OPEN_TRAIN;
 * docs/TRAINING.md "Anyone can fine-tune" lists Meta's terms for the owner). A bare "wonder" stays refused: PUBLIC_DATASETS
 * isn't read here, and no setting turns that on.
 */
export type VisitorDatasetSource = "rows" | "lab_ready" | "wonder" | "contributor" | "tune_writer";

export function visitorDatasetSource(source: VisitorDatasetSource): Refusal | null {
  if (source !== "wonder") return null;
  return {
    ok: false,
    status: 403,
    code: "visitor_rows_only",
    error: "Visitors train on one of the lab's ready datasets or on their own examples. Muse Muse doesn't write examples for visitors.",
  };
}

/**
 * Before a visitor's dataset of their own rows is written: 1 to datasetMaxRows rows, then one of the visitor's and
 * their IP's datasets for today. A refusal gives back what was taken. (piiFindings on the rows is content.ts's.)
 */
export async function reserveVisitorDataset(
  s: CounterSubject,
  input: { source: VisitorDatasetSource; rows: number },
  now: Date = new Date(),
): Promise<ReserveResult> {
  const source = visitorDatasetSource(input.source);
  if (source) return source;
  if (input.source === "lab_ready") return { ok: true, reservation: { items: [] } };
  const max = s.limits.datasetMaxRows;
  if (!Number.isInteger(input.rows) || input.rows < 1 || input.rows > max) {
    return { ok: false, status: 400, code: "visitor_dataset_rows", error: `A visitor's dataset has 1 to ${max} rows.` };
  }
  const held: Reservation = { items: [] };
  const refused = await takeDaily(s, "dataset", s.limits.datasetsPerDay, now, held);
  if (refused) {
    await releaseReservation(held);
    return refused;
  }
  return { ok: true, reservation: held };
}

const HELD_PREFIX = "tune-visitor-held:";
const HELD_WINDOW = IP_LIFETIME_WINDOW;

/** Keeps a launched visitor job's reservation with it (plain data, in rate_limits), for settleVisitorRuns to end. */
export async function holdVisitorJob(jobId: string, r: Reservation): Promise<void> {
  await db().insert(schema.rateLimits).values({ key: `${HELD_PREFIX}${jobId}:${JSON.stringify(r.items)}`, windowStart: HELD_WINDOW, count: 1 }).onConflictDoNothing();
}

/**
 * The 5-minute sweep's turn: every visitor job that ended with its GPU down gets endVisitorRun with what it really cost,
 * once. A failure leaves its row for the next sweep, and meanwhile only holds the visitors' day at the job's full limit.
 */
export async function settleVisitorRuns(): Promise<number> {
  const rows = await db()
    .select({ key: schema.rateLimits.key })
    .from(schema.rateLimits)
    .where(and(sql`${schema.rateLimits.key} like ${`${HELD_PREFIX}%`}`, eq(schema.rateLimits.windowStart, HELD_WINDOW)));
  let settled = 0;
  for (const { key } of rows) {
    const rest = key.slice(HELD_PREFIX.length);
    const at = rest.indexOf(":");
    const jobId = rest.slice(0, at);
    const [job] = await db().select({ status: jobs.status, terminatedAt: jobs.terminatedAt, costUsd: jobs.costUsd, launchedAt: jobs.launchedAt }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
    const done = !job || (TRAIN_TERMINAL.includes(job.status as (typeof TRAIN_TERMINAL)[number]) && (job.terminatedAt || !job.launchedAt));
    if (!done) continue;
    const items = JSON.parse(rest.slice(at + 1)) as Reservation["items"];
    // The row goes first: a crash here leaves money held, never given back twice.
    await db().delete(schema.rateLimits).where(and(eq(schema.rateLimits.key, key), eq(schema.rateLimits.windowStart, HELD_WINDOW)));
    await endVisitorRun({ items }, job?.costUsd ?? 0);
    settled++;
  }
  return settled;
}
