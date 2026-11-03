/**
 * The money caps on a SAM tune run's own Meta calls (U6: hosted SAM 3.1 labels and Muse Image look-alikes). Every call is
 * held against three caps before it is sent, and nothing is sent when any of them says no:
 *
 * 1. the platform's DAILY_SPEND_CAP_USD (today's metered spend, as plan art checks it);
 * 2. SAM_TUNE_DAILY_USD, all SAM tune calls in one UTC day, a counter in rate_limits (lib/gateway/store.ts);
 * 3. the run's own cap (its max_usd, never above SAM_TUNE_MAX_USD), a counter of its own.
 *
 * The two counters are reserved with reserveCounter, which adds only while the total stays within the limit, so two
 * requests at once can't both get past a cap. A hold is settled after the call with adjustCounter: what the call cost
 * stays, the rest goes back. Counters are 32-bit integers, so amounts are micro-dollars.
 */
import { SAM_TUNE_DAY_KEY, SAM_TUNE_RUN_WINDOW, samMicros, samTuneDayWindow, samTuneRunKey } from "@/lib/train/sam/types";

export interface SpendDeps {
  /** lib/gateway/store.ts reserveCounter: the new total, or null when adding would pass the limit. */
  reserveCounter(key: string, windowStart: Date, amount: number, limit: number): Promise<number | null>;
  /** lib/gateway/store.ts adjustCounter: adds `delta` (negative gives back), never below zero. */
  adjustCounter(key: string, windowStart: Date, delta: number): Promise<void>;
  /** True while today's platform spend is under DAILY_SPEND_CAP_USD. */
  platformSpendOk(): Promise<boolean>;
  now(): Date;
}

export interface SpendLimits {
  runId: string;
  /** The run's cap in dollars: its max_usd, already held to SAM_TUNE_MAX_USD by runCapUsd. */
  runMaxUsd: number;
  /** SAM_TUNE_DAILY_USD. */
  dailyUsd: number;
}

export type SpendRefusal = "platform_cap" | "daily_cap" | "run_cap";

export interface SpendHold {
  /** Keeps `usd` of the hold as spent and gives the rest back. Call once. Never throws. */
  settle(usd: number): Promise<void>;
}

export type HoldResult = { ok: true; hold: SpendHold } | { ok: false; reason: SpendRefusal };

// The keys, units and windows are shared with U2's Start (lib/train/sam/types.ts), so SAM_TUNE_DAILY_USD is one cap.
// A day counter is windowed at the next UTC midnight and a run counter far in the future, because the hourly cleanup
// cron deletes rate_limits windows that started over an hour ago: today's midnight or the epoch would reset the caps
// every hour.
export { SAM_TUNE_DAY_KEY, samTuneRunKey } from "@/lib/train/sam/types";
/** A run's counter has one window for its whole life. */
export const RUN_WINDOW = SAM_TUNE_RUN_WINDOW;

export function micros(usd: number): number {
  return samMicros(usd);
}

/** The day counter's window: the next UTC midnight (types.ts samTuneDayWindow). */
export function utcDay(now: Date): Date {
  return samTuneDayWindow(now);
}

/** The cap a run's calls are held to: its own max_usd, never above SAM_TUNE_MAX_USD, never below zero. */
export function runCapUsd(rowMaxUsd: number | null | undefined, envMaxUsd: number): number {
  const row = typeof rowMaxUsd === "number" && Number.isFinite(rowMaxUsd) ? rowMaxUsd : envMaxUsd;
  return Math.max(0, Math.min(row, envMaxUsd));
}

/** What each refusal says to the person. No em dashes: this is shown on the page. */
export function refusalText(reason: SpendRefusal): string {
  switch (reason) {
    case "platform_cap":
      return "The platform has reached today's spend cap. Try again tomorrow.";
    case "daily_cap":
      return "SAM tuning has reached today's spend cap. Try again tomorrow.";
    case "run_cap":
      return "This run has reached its spend cap.";
  }
}

/**
 * Holds `usd` against every cap, in order: the platform check, then the day's counter, then the run's. A refusal
 * holds nothing (the day's amount is given back when the run's counter says no).
 */
export async function holdSpend(deps: SpendDeps, limits: SpendLimits, usd: number): Promise<HoldResult> {
  if (!(await deps.platformSpendOk())) return { ok: false, reason: "platform_cap" };
  const amount = micros(usd);
  const day = utcDay(deps.now());
  const dayKey = SAM_TUNE_DAY_KEY;
  const runKey = samTuneRunKey(limits.runId);
  if ((await deps.reserveCounter(dayKey, day, amount, micros(limits.dailyUsd))) === null) return { ok: false, reason: "daily_cap" };
  let ran: number | null = null;
  try {
    ran = await deps.reserveCounter(runKey, RUN_WINDOW, amount, micros(limits.runMaxUsd));
  } finally {
    if (ran === null) await deps.adjustCounter(dayKey, day, -amount).catch(() => undefined);
  }
  if (ran === null) return { ok: false, reason: "run_cap" };
  let settled = false;
  return {
    ok: true,
    hold: {
      async settle(spent: number) {
        if (settled) return;
        settled = true;
        const back = micros(spent) - amount;
        if (back === 0) return;
        await Promise.all([deps.adjustCounter(dayKey, day, back), deps.adjustCounter(runKey, RUN_WINDOW, back)]).catch((err) =>
          console.warn(`[sam tune] hold not settled: ${(err as Error).message}`),
        );
      },
    },
  };
}
