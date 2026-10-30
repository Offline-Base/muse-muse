import { docsErrors } from "@/lib/docs/proxy/errors";
import { DOCS_MODEL_REQUESTS_PER_MINUTE, DOCS_UPLOADS_PER_HOUR } from "@/lib/docs/proxy/policy";
import type { DocsDeps, DocsHoldState } from "@/lib/docs/proxy/types";
import { clientIpKey } from "@/lib/gateway/extract";
import type { UsageContext } from "@/lib/usage";
import type { ModelUsage } from "@/lib/types";

/**
 * The limits every live docs call goes through (docs/DOCS_MIRROR.md "Limits"). Per client IP, in rate_limits rows:
 * runs a minute and a day, calls in flight, and dollars a day as micro-dollars. Across every reader: runs a minute per
 * model and uploads an hour, since Meta's own limits and file storage are per team, not per key. Every docs call also
 * counts toward the docs' daily cap and the platform's.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const logged = (what: string) => (err: unknown) =>
  console.error(`[docs] ${what} failed:`, err instanceof Error ? err.message : err);
/** A counter row holds a Postgres integer, so a cap is kept under 2^31 micro-dollars ($2,000). */
const MAX_COUNTER = 2_000_000_000;

export const DOCS_KEYS = {
  minute: (ip: string) => `docs-ip:${ip}`,
  day: (ip: string) => `docs-ip-day:${ip}`,
  inFlight: (ip: string) => `docs-inflight:${ip}`,
  usd: (ip: string) => `docs-usd:${ip}`,
  /** Every reader's runs on one model in a minute. */
  model: (model: string) => `docs-model:${model}`,
  /** Every reader's uploads in an hour. */
  uploads: "docs-uploads",
};

/**
 * The client's IP as a rate-limit key (IPv6 by its /64). Vercel sets x-real-ip to the client, and the first
 * x-forwarded-for entry is the same address. Requests with neither share one "unknown" bucket, which errs strict.
 */
export function docsClientIp(headers: Headers): string {
  return clientIpKey(headers.get("x-real-ip")) ?? clientIpKey(headers.get("x-forwarded-for")) ?? "unknown";
}

export function minuteStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
}

export function hourStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * Where a per-day counter is kept: at the end of now's UTC day, the next 00:00 UTC. The hourly cleanup prunes
 * rate_limits windows that started over an hour ago, so a row stored at the day's start would be gone by 01:00.
 */
export function dayWindow(now: Date): Date {
  const end = new Date(now);
  end.setUTCHours(24, 0, 0, 0);
  return end;
}

export function secondsUntil(at: Date, now: Date): number {
  return Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 1000));
}

/** Dollars as whole micro-dollars, rounded up so a reservation never undercounts. */
export function toMicros(usd: number): number {
  return Number.isFinite(usd) && usd > 0 ? Math.ceil(usd * 1_000_000 - 1e-6) : 0;
}

/** 429 when this IP is over its runs a minute or a day, else null. Every call counts, free ones included. */
export async function checkRequestLimits(ip: string, deps: DocsDeps, now: Date): Promise<Response | null> {
  const cfg = deps.config;
  const minute = minuteStart(now);
  const day = dayWindow(now);
  const [perMinute, perDay] = await Promise.all([
    deps.hitRateLimits([DOCS_KEYS.minute(ip)], minute),
    deps.hitRateLimits([DOCS_KEYS.day(ip)], day),
  ]);
  if ((perMinute[DOCS_KEYS.minute(ip)] ?? 0) > cfg.perIpRequestsPerMinute) {
    const retryAfter = secondsUntil(new Date(minute.getTime() + MINUTE_MS), now);
    return docsErrors.rateLimited("minute", cfg.perIpRequestsPerMinute, retryAfter);
  }
  if ((perDay[DOCS_KEYS.day(ip)] ?? 0) > cfg.perIpRequestsPerDay) {
    return docsErrors.rateLimited("day", cfg.perIpRequestsPerDay, secondsUntil(day, now));
  }
  return null;
}

/**
 * 429 when every reader together has used this model's runs for the minute (DOCS_MODEL_REQUESTS_PER_MINUTE), else
 * null. Meta limits requests per team and model, and the docs share the team with the live products, so a ceiling
 * well under Meta's keeps a crowd of readers (or one reader on many IPs) from using up the team's limit.
 */
export async function checkModelLimit(model: string | null, deps: DocsDeps, now: Date): Promise<Response | null> {
  const limit = model ? DOCS_MODEL_REQUESTS_PER_MINUTE[model] : undefined;
  if (!model || !limit) return null;
  const minute = minuteStart(now);
  const key = DOCS_KEYS.model(model);
  const counts = await deps.hitRateLimits([key], minute);
  if ((counts[key] ?? 0) <= limit) return null;
  return docsErrors.modelBusy(model, limit, secondsUntil(new Date(minute.getTime() + MINUTE_MS), now));
}

/**
 * 429 when every reader together has made DOCS_UPLOADS_PER_HOUR uploads this hour, else null. Uploads are free, and
 * every file counts toward the team's shared storage until it expires an hour later, so this bounds what the docs
 * can hold at once.
 */
export async function checkUploadLimit(deps: DocsDeps, now: Date): Promise<Response | null> {
  const hour = hourStart(now);
  const counts = await deps.hitRateLimits([DOCS_KEYS.uploads], hour);
  if ((counts[DOCS_KEYS.uploads] ?? 0) <= DOCS_UPLOADS_PER_HOUR) return null;
  return docsErrors.uploadsBusy(DOCS_UPLOADS_PER_HOUR, secondsUntil(new Date(hour.getTime() + HOUR_MS), now));
}

/**
 * Takes one of the IP's in-flight slots for `run`, and gives it back once the call is metered (or right away when
 * nothing is left to meter). 429 when every slot is taken.
 */
export async function withInFlightSlot(
  ip: string,
  deps: DocsDeps,
  now: Date,
  run: () => Promise<{ response: Response; metering: Promise<void> | null }>,
): Promise<Response> {
  const key = DOCS_KEYS.inFlight(ip);
  const slot = await deps.acquireInFlight(key, deps.config.perIpInFlight, now);
  if (!slot) return docsErrors.tooManyInFlight(deps.config.perIpInFlight);
  const release = () => deps.releaseInFlight(key, slot).catch(logged("releasing an in-flight slot"));
  let metering: Promise<void> | null = null;
  try {
    const result = await run();
    metering = result.metering;
    return result.response;
  } finally {
    const pending = metering;
    if (pending) deps.defer(() => pending.finally(release));
    else await release();
  }
}

/** A call's estimated cost, held against every budget until the call is metered. */
export interface SpendHold {
  /** What is held, in a form a background response's row can keep until it is settled; null when nothing is. */
  state: DocsHoldState | null;
  /** Replaces the estimate with what the call used. */
  settle(items: ModelUsage[]): Promise<void>;
  /** Gives the whole estimate back: nothing reached Meta, or Meta refused the call. */
  cancel(): Promise<void>;
}

const usedUsd = (items: ModelUsage[]) => items.reduce((n, i) => n + i.costUsd, 0);

/** What the settle of a held call needs: the usage rows and the IP's counter. */
export type DocsSettleDeps = Pick<DocsDeps, "settleSpend" | "recordUsage" | "adjustCounter">;

/**
 * Replaces a held estimate with what the call used: the reservation row becomes the first item, any more are added,
 * and the IP's counter moves by the difference. Used when the reply is metered, and later for a background response.
 */
export async function settleHeld(deps: DocsSettleDeps, ctx: UsageContext, state: DocsHoldState, items: ModelUsage[]): Promise<void> {
  await deps.settleSpend(state.reservation, items[0] ?? null);
  if (items.length > 1) await deps.recordUsage(ctx, items.slice(1));
  const delta = toMicros(usedUsd(items)) - state.micros;
  if (delta) await deps.adjustCounter(state.usdKey, new Date(state.day), delta);
}

/** Gives a held estimate back: the reservation row is removed and the IP's counter goes down by what it held. */
async function releaseHeld(deps: DocsSettleDeps, state: DocsHoldState): Promise<void> {
  await Promise.all([
    deps.settleSpend(state.reservation, null).catch(logged("removing a reservation")),
    deps.adjustCounter(state.usdKey, new Date(state.day), -state.micros).catch(logged("giving back an IP reservation")),
  ]);
}

/**
 * Holds a call's estimate against the IP's dollars for the day, the docs' daily cap and the platform's cap: the IP's
 * micro-dollar counter is reserved atomically, then the estimate is written as a usage row (source "docs"), and only
 * then are the two daily totals read. Those totals are sums over usage rows, so reading them after writing this call's
 * row means calls that arrive together each count the others': at the cap, they can be refused together, but can never
 * all pass. Returns the refusal as a Response when a budget can't take the call. Free calls hold nothing.
 */
export async function holdSpend(
  deps: DocsDeps,
  ctx: UsageContext,
  model: string | null,
  estimate: number,
  ip: string,
  now: Date,
): Promise<SpendHold | Response> {
  const cfg = deps.config;
  const day = dayWindow(now);
  const usdKey = DOCS_KEYS.usd(ip);

  if (estimate <= 0) {
    return {
      state: null,
      async settle(items) {
        if (!items.length) return;
        await deps.recordUsage(ctx, items);
        const micros = toMicros(usedUsd(items));
        if (micros) await deps.adjustCounter(usdKey, day, micros);
      },
      async cancel() {},
    };
  }

  // A cap of 0 turns paid demos off and leaves the free calls running.
  if (cfg.docsDailyCapUsd <= 0 || cfg.perIpDailyUsd <= 0) return docsErrors.paidPaused();
  const resetSec = secondsUntil(day, now);
  const micros = toMicros(estimate);
  const capMicros = Math.min(toMicros(cfg.perIpDailyUsd), MAX_COUNTER);
  const total = micros > capMicros ? null : await deps.reserveCounter(usdKey, day, micros, capMicros);
  if (total === null) {
    const spent = await deps.counterValue(usdKey, day).catch(() => capMicros);
    return docsErrors.ipBudget(cfg.perIpDailyUsd, spent / 1_000_000, estimate, resetSec);
  }

  let reservation: string;
  try {
    reservation = await deps.reserveSpend(ctx, model, estimate);
  } catch (err) {
    await deps.adjustCounter(usdKey, day, -micros).catch(logged("giving back an IP reservation"));
    throw err;
  }
  const state: DocsHoldState = { reservation, model, micros, usdKey, day: day.toISOString() };
  let refusal: Response | null = null;
  try {
    // Both totals include this call's reservation now.
    const [docsSpent, platformSpent] = await Promise.all([deps.docsSpendToday(), deps.platformSpendToday()]);
    if (docsSpent > cfg.docsDailyCapUsd) refusal = docsErrors.docsBudget(resetSec);
    else if (platformSpent > cfg.platformDailyCapUsd) refusal = docsErrors.platformPaused();
  } catch (err) {
    await releaseHeld(deps, state);
    throw err;
  }
  if (refusal) {
    await releaseHeld(deps, state);
    return refusal;
  }
  return {
    state,
    settle: (items) => settleHeld(deps, ctx, state, items),
    cancel: () => releaseHeld(deps, state),
  };
}
