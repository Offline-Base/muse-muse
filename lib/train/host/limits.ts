/**
 * The hard limits on what hosted endpoints may spend (docs/TRAINING.md, "Run it on a hosted GPU"). Pure. The platform
 * pays and production guests share one account, so every number here is enforced in code, and each decision leans toward
 * refusing a start or stopping what runs.
 */
import { HOST_OPEN, type HostEndpoint, type HostPrice, type StopReason } from "@/lib/train/host/types";

export interface HostLimits {
  dailyUsd: number;
  maxLive: number;
  idleMinutes: number;
  maxMinutes: number;
}

/** A run shorter than this could spend its whole time starting, so it isn't started. */
export const MIN_RUN_MINUTES = 30;
/** How long an endpoint may stay "starting" before the sweep stops it. */
export const START_TIMEOUT_MINUTES = 45;
/**
 * Past the deploy route's 5 minute limit: a row with no ref older than this has no running function left to save one, so
 * the deploy died. Younger, a deploy may still be creating the resource, so a stop by name could miss it.
 */
export const DEPLOY_WINDOW_MINUTES = 6;

/**
 * Run it's demo window: the stop time asked for, held to `maxMinutes` (HOST_TUNED_MAX_MINUTES), so it can only be
 * shorter. Null: none asked, so the usual limit. "invalid": not a whole number, or under MIN_RUN_MINUTES.
 */
export function demoWindowMinutes(asked: unknown, maxMinutes: number): number | null | "invalid" {
  if (asked === undefined || asked === null) return null;
  if (typeof asked !== "number" || !Number.isInteger(asked) || asked < MIN_RUN_MINUTES) return "invalid";
  return Math.min(asked, maxMinutes);
}

const isOpen = (e: Pick<HostEndpoint, "status">) => HOST_OPEN.includes(e.status);
const startOfDay = (now: Date) => {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};
const upCents = (usd: number) => Math.ceil(usd * 100 - 1e-9) / 100;

/** The clock's cost so far: the rate for every minute it has existed. A scale-to-zero provider may bill less, never more. */
export function accruedUsd(e: Pick<HostEndpoint, "hourlyUsd" | "createdAt" | "stoppedAt">, now: Date): number {
  const end = e.stoppedAt ?? now;
  return Math.max(0, ((end.getTime() - e.createdAt.getTime()) / 3_600_000) * e.hourlyUsd);
}

type SpendRow = Pick<HostEndpoint, "status" | "hourlyUsd" | "reservedUsd" | "costUsd" | "createdAt" | "stoppedAt">;

/** What the day's budget has already promised: every open endpoint's reservation (even one started yesterday), and today's closed ones' costs. */
export function heldToday(rows: readonly SpendRow[], now: Date): number {
  const day = startOfDay(now).getTime();
  return rows.reduce((sum, e) => {
    if (isOpen(e)) return sum + Math.max(e.reservedUsd, accruedUsd(e, now));
    return e.createdAt.getTime() >= day ? sum + (e.costUsd ?? 0) : sum;
  }, 0);
}

/** What has really run up: below heldToday while reservations aren't used yet. At the cap, everything stops. */
export function spentToday(rows: readonly SpendRow[], now: Date): number {
  const day = startOfDay(now).getTime();
  return rows.reduce((sum, e) => {
    if (isOpen(e)) return sum + accruedUsd(e, now);
    return e.createdAt.getTime() >= day ? sum + (e.costUsd ?? 0) : sum;
  }, 0);
}

export type RunPlan = { ok: true; minutes: number; reserveUsd: number } | { ok: false; code: "budget_exceeded"; message: string };

const money = (usd: number) => `$${usd.toFixed(2)}`;

/**
 * How long a new endpoint may run and what it reserves first. An hourly endpoint gets as many minutes as the money left
 * covers, up to maxMinutes, so it can't outspend what it reserved: its stop time is set from that reservation.
 */
export function planRun(price: HostPrice, limits: HostLimits, money_: { heldToday: number; platformSpend: number; platformCap: number }): RunPlan {
  const left = Math.min(limits.dailyUsd - money_.heldToday, money_.platformCap - money_.platformSpend);
  const refuse = (need: number): RunPlan => ({
    ok: false,
    code: "budget_exceeded",
    message: `Hosting this needs at least ${money(need)}, and only ${money(Math.max(0, left))} is left today of the ${money(limits.dailyUsd)} hosting budget and the platform's daily cap. Stop a running endpoint, or try after midnight UTC.`,
  });
  if (price.capUsd !== undefined) {
    if (left < price.capUsd) return refuse(price.capUsd);
    return { ok: true, minutes: Math.min(limits.maxMinutes, price.maxMinutes ?? limits.maxMinutes), reserveUsd: upCents(price.capUsd) };
  }
  if (!(price.hourlyUsd > 0)) return refuse(0.01);
  const need = (MIN_RUN_MINUTES / 60) * price.hourlyUsd;
  const allowed = Math.min(limits.maxMinutes, price.maxMinutes ?? limits.maxMinutes);
  // Rounding a reservation up to cents never takes it past what is left: minutes round down first.
  const minutes = Math.min(allowed, Math.floor((left / price.hourlyUsd) * 60));
  if (minutes < MIN_RUN_MINUTES) return left < need ? refuse(need) : { ok: false, code: "budget_exceeded", message: "Hosting limits leave too little time for this endpoint to start." };
  return { ok: true, minutes, reserveUsd: upCents((minutes / 60) * price.hourlyUsd) };
}

/** Why this endpoint must stop now, or null. spent is spentToday; a failed read of it means stop (see sweep). */
export function stopReasonFor(
  e: Pick<HostEndpoint, "status" | "stopsAt" | "readyAt" | "lastUsedAt" | "createdAt"> & { ref?: HostEndpoint["ref"] },
  ctx: { limits: HostLimits; spent: number; on: boolean; now: Date },
): StopReason | null {
  if (e.status !== "starting" && e.status !== "live") return null;
  const now = ctx.now.getTime();
  if (!ctx.on) return "flag_off";
  if (ctx.limits.dailyUsd <= 0 || ctx.spent >= ctx.limits.dailyUsd) return "daily_cap";
  if (now >= e.stopsAt.getTime()) return "max_time";
  if (now - e.createdAt.getTime() >= ctx.limits.maxMinutes * 60_000) return "max_time";
  if (e.status === "starting" && e.ref === null && now - e.createdAt.getTime() >= DEPLOY_WINDOW_MINUTES * 60_000) return "deploy_failed";
  if (e.status === "starting") return now - e.createdAt.getTime() >= START_TIMEOUT_MINUTES * 60_000 ? "start_timeout" : null;
  const lastActive = Math.max(e.lastUsedAt?.getTime() ?? 0, e.readyAt?.getTime() ?? 0, e.createdAt.getTime());
  return now - lastActive >= ctx.limits.idleMinutes * 60_000 ? "idle" : null;
}

/** With more running than allowed (the limit was lowered), the ones to stop: most recently started first. */
export function excessEndpoints<T extends Pick<HostEndpoint, "createdAt">>(running: readonly T[], maxLive: number): T[] {
  const newestFirst = [...running].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return newestFirst.slice(0, Math.max(0, running.length - maxLive));
}

/** A free slot from 1 to maxLive, or null. A unique index on live slots is what really holds the limit under a race. */
export function freeSlot(open: readonly Pick<HostEndpoint, "slot">[], maxLive: number): number | null {
  const taken = new Set(open.map((e) => e.slot));
  for (let slot = 1; slot <= maxLive; slot += 1) if (!taken.has(slot)) return slot;
  return null;
}

/**
 * Who may start, stop and talk to endpoints. Admins, until HOST_TUNED_OPEN widens it to signed-in people. Nobody without a
 * session of their own: not the shared guest, and not OPEN_ACCESS=admin's stand-in admin, since this spends real money.
 * The one exception is the public Try box's own, smaller limits (lib/train/host/try.ts), which don't go through this.
 */
export function mayDeploy(user: { isAdmin: boolean; openAccess?: boolean } | null, open: boolean): boolean {
  if (!user) return false;
  if (user.openAccess) return false;
  return user.isAdmin || open;
}

/** Of those, who may on this model: an admin, or whoever trained it. The model page is public, so seeing it isn't enough. */
export function mayUseModel(user: { id: string; isAdmin: boolean }, createdBy: string | null | undefined): boolean {
  return user.isAdmin || (Boolean(createdBy) && createdBy === user.id);
}

export const STOP_WORDS: Record<StopReason, string> = {
  person: "Stopped by hand.",
  idle: "Stopped: nobody used it for the idle limit.",
  max_time: "Stopped: it reached its time limit.",
  start_timeout: "Stopped: it took too long to start.",
  daily_cap: "Stopped: the daily hosting budget ran out.",
  too_many: "Stopped: more endpoints were running than the limit allows.",
  flag_off: "Stopped: hosting was turned off.",
  cant_check: "Stopped: the budget couldn't be checked, so it stopped to be safe.",
  provider_failed: "Stopped: the provider said it failed.",
  deploy_failed: "It couldn't be deployed.",
};
