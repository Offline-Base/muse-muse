/**
 * What a visitor's run takes when it starts (OPEN_TRAIN, docs/TRAINING.md "Anyone can fine-tune"), before anything is
 * written or billed: one start at a moment and one running run per person, starts per hour per person and IP, a dataset
 * of today's, and the estimate against every visitor's Meta budget for the day. The GPU's own limits are taken later, at
 * launch (reserveVisitorRun). A refusal gives back what it took.
 */
import { and, eq, gt, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { dayWindow, hourStart, minuteStart, secondsUntil } from "@/lib/docs/proxy/limits";
import { env } from "@/lib/env";
import { reserveCounter } from "@/lib/gateway/store";
import type { Refusal } from "@/lib/train/public/identity";
import { releaseReservation, reserveVisitorDataset, type CounterSubject, type Reservation, type ReserveResult, type VisitorDatasetSource } from "@/lib/train/public/limits";
import { TRAIN_TERMINAL } from "@/lib/train/types";

const HOUR_MS = 60 * 60_000;
/** A dataset still "generating" after this long has stalled, as the tuneRun workflow's own wait. It stops holding the place. */
const WRITING_HOLDS_MS = 6 * HOUR_MS;

/** True while this person has a run writing its examples or a job on a GPU. */
export async function personHasOpenRun(ownerId: string, now: Date = new Date()): Promise<boolean> {
  const d = schema.trainingDatasets;
  const [writing] = await db()
    .select({ id: d.id })
    .from(d)
    .where(and(eq(d.createdBy, ownerId), eq(d.status, "generating"), gt(d.createdAt, new Date(now.getTime() - WRITING_HOLDS_MS))))
    .limit(1);
  if (writing) return true;
  return personHasOpenJob(ownerId);
}

/** True while one of this person's jobs hasn't ended, or ended with its GPU not yet confirmed down. */
export async function personHasOpenJob(ownerId: string): Promise<boolean> {
  const j = schema.trainingJobs;
  const ended = sql.join(TRAIN_TERMINAL.map((s) => sql`${s}`), sql`, `);
  const [job] = await db()
    .select({ id: j.id })
    .from(j)
    .where(and(eq(j.createdBy, ownerId), or(sql`${j.status} not in (${ended})`, sql`${j.launchedAt} is not null and ${j.terminatedAt} is null`)))
    .limit(1);
  return Boolean(job);
}

const ONE_RUN: Refusal = { ok: false, status: 409, code: "visitor_one_run", error: "You already have a run going. Start another once it ends." };

const cents = (usd: number) => Math.ceil(Math.max(0, usd) * 100 - 1e-6);

/** Takes what a visitor's run needs to start, or refuses and gives everything back. */
export async function reserveVisitorStart(
  s: CounterSubject,
  input: { ownerId: string; source: VisitorDatasetSource; rows: number; metaUsd: number },
  now: Date = new Date(),
): Promise<ReserveResult> {
  const held: Reservation = { items: [] };
  const fail = async (r: Refusal): Promise<Refusal> => {
    await releaseReservation(held);
    return r;
  };
  const take = async (key: string, window: Date, amount: number, limit: number): Promise<boolean> => {
    if ((await reserveCounter(key, window, amount, limit)) === null) return false;
    held.items.push({ key, window: window.toISOString(), amount });
    return true;
  };

  // Two starts at the same moment both see no run yet, so this minute's one start comes before the look.
  const minute = minuteStart(now);
  if (!(await take(`tune-start-lock:${s.trainerId}`, minute, 1, 1))) return fail(ONE_RUN);
  if (await personHasOpenRun(input.ownerId, now)) return fail(ONE_RUN);

  const hour = hourStart(now);
  const hourly: Refusal = {
    ok: false,
    status: 429,
    code: "visitor_hourly",
    error: "That's as many runs as can start from here this hour. Try again later.",
    retryAfterSeconds: secondsUntil(new Date(hour.getTime() + HOUR_MS), now),
  };
  const perHour = env.openTrainStartsPerHour;
  if (!(await take(`tune-start:v:${s.trainerId}`, hour, 1, perHour))) return fail(hourly);
  if (!(await take(`tune-start:ip:${s.ip}`, hour, 1, perHour * Math.max(1, s.limits.ipFactor)))) return fail(hourly);

  const dataset = await reserveVisitorDataset(s, { source: input.source, rows: input.rows }, now);
  if (!dataset.ok) return fail(dataset);
  held.items.push(...dataset.reservation.items);

  const day = dayWindow(now);
  if (!(await take("tune-meta:visitors", day, cents(input.metaUsd), cents(env.openTrainMetaDailyUsd)))) {
    return fail({
      ok: false,
      status: 503,
      code: "visitor_meta_daily",
      error: "Visitors together have used today's budget for writing and scoring examples. Try again tomorrow.",
      retryAfterSeconds: secondsUntil(day, now),
    });
  }
  return { ok: true, reservation: held };
}

/** Plans per hour from one IP, and per day from every visitor: a plan is a paid call that comes before the start code. */
export const PLANS_PER_HOUR_PER_IP = 40;

export async function takeVisitorPlan(ip: string, now: Date = new Date()): Promise<Refusal | null> {
  const hour = hourStart(now);
  const day = dayWindow(now);
  if ((await reserveCounter(`tune-plan:ip:${ip}`, hour, 1, PLANS_PER_HOUR_PER_IP)) === null) {
    return { ok: false, status: 429, code: "rate_limited", error: "That's a lot of plans from this network this hour.", retryAfterSeconds: secondsUntil(new Date(hour.getTime() + HOUR_MS), now) };
  }
  if ((await reserveCounter("tune-plan:visitors", day, 1, env.openTrainPlansPerDay)) === null) {
    return { ok: false, status: 503, code: "visitor_plans_daily", error: "Visitors together have drafted today's plans. Try again tomorrow.", retryAfterSeconds: secondsUntil(day, now) };
  }
  return null;
}
