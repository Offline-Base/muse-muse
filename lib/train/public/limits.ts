/**
 * What a visitor may start (open-train.md "Shape", owner's "Visitors from day one"): per visitor and per IP each UTC day,
 * real runs, dry runs and datasets of their own rows; each visitor job within 60 minutes, $4 and 120 steps; one visitor
 * job on a GPU at once; and $15 a day across every visitor, inside TRAIN_DAILY_USD. All from lib/env.ts.
 *
 * Counters are rate_limits rows at dayWindow (the end of the UTC day, so the hourly prune keeps them), taken with
 * reserveCounter: reserve first, in one statement that can't pass the limit, and give back with adjustCounter when a
 * later check refuses, as the gateway's counters do. A Reservation is plain data, so a later step can give it back
 * after a launch fails.
 */
import { and, eq, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { dayWindow, secondsUntil } from "@/lib/docs/proxy/limits";
import { env } from "@/lib/env";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import { visitorCounterKey, type Refusal } from "@/lib/train/public/identity";
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
/** Every visitor's committed GPU dollars today, in whole cents. */
export const USD_KEY = "train-pub:usd";

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
 * Jobs holding a GPU (lib/train/store.ts activeJobCount's rule) that a non-admin made: a visitor trainer's hidden row or
 * a signed-in builder. Admins' and automation's jobs (their rows are admin) don't count.
 */
export async function visitorActiveJobCount(): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .innerJoin(schema.users, eq(schema.users.id, jobs.createdBy))
    .where(and(holdingGpu(), eq(schema.users.isAdmin, false)));
  return Number(row?.n ?? 0);
}

/**
 * 409 when visitor jobs already hold every slot. Before the job row exists, `including` is 0: refused at the max. After
 * it is written, pass 1, so two starts at once each see the other and back out (the jobs route's own recheck).
 */
export async function checkVisitorActive(limits: VisitorLimits, including: 0 | 1 = 0): Promise<Refusal | null> {
  const active = await visitorActiveJobCount();
  if (active - including < limits.maxActive) return null;
  return {
    ok: false,
    status: 409,
    code: "visitor_gpu_busy",
    error: "Another visitor's run is on the GPU now. Try again once it finishes, in about an hour.",
  };
}

export type ReserveResult = { ok: true; reservation: Reservation } | Refusal;

/**
 * Before a visitor job is written: the job's limits, a free visitor slot, then one of the visitor's and their IP's runs
 * (or dry runs) for today, then the job's whole dollar limit against every visitor's day. Any refusal gives back what was
 * taken. On success, hold the reservation until the job row exists and give it back (releaseReservation) if the launch
 * fails before a GPU starts.
 */
export async function reserveVisitorRun(
  s: CounterSubject,
  job: { dryRun: boolean; maxMinutes: number; maxUsd: number; steps: number },
  now: Date = new Date(),
): Promise<ReserveResult> {
  const bad = checkVisitorJob(job, s.limits);
  if (bad) return bad;
  if (s.limits.dailyUsd <= 0) return { ok: false, status: 503, code: "public_training_paused", error: "Visitor training is paused today." };
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
  return { ok: true, reservation: held };
}

/**
 * Once a visitor job has ended: gives back the part of its dollar hold it didn't spend, so the day's total is what
 * visitors actually used. The counters for runs stay taken.
 */
export async function settleVisitorSpend(r: Reservation, spentUsd: number): Promise<void> {
  const usd = r.items.find((i) => i.key === USD_KEY);
  if (!usd) return;
  const unspent = usd.amount - Math.min(usd.amount, cents(spentUsd));
  if (unspent > 0) await adjustCounter(USD_KEY, new Date(usd.window), -unspent);
}

/**
 * Where a visitor's dataset may come from. Their own rows, or a lab dataset that is already ready (no new dataset).
 * Never Muse Wonder writing it: PUBLIC_DATASETS isn't read here, so no setting can turn that on for visitors (Meta
 * terms 10.1(ix)); it needs its own reviewed change.
 */
export type VisitorDatasetSource = "rows" | "lab_ready" | "wonder";

export function visitorDatasetSource(source: VisitorDatasetSource): Refusal | null {
  if (source === "rows" || source === "lab_ready") return null;
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
