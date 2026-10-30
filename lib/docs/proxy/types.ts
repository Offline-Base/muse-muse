import type { DocsObjectKind } from "@/lib/docs/proxy/endpoints";
import type { UsageContext } from "@/lib/usage";
import type { ModelUsage } from "@/lib/types";

/**
 * A call's spend still held at its estimate, in a form that can be stored: a background response's hold waits in its
 * docs_objects row until Meta reports what the response used (lib/docs/proxy/background.ts).
 */
export interface DocsHoldState {
  /** The usage row holding the estimate (lib/gateway/store.ts reserveSpend). */
  reservation: string;
  model: string | null;
  /** The micro-dollars held on the IP's counter, and that counter's key and window (ISO 8601). */
  micros: number;
  usdKey: string;
  day: string;
}

/** The limits in force, read from the environment per request (lib/env.ts) so a test server can raise them. */
export interface DocsConfig {
  /** False when DOCS_LIVE=off: every live call answers 503 docs_paused. */
  live: boolean;
  perIpRequestsPerMinute: number;
  perIpRequestsPerDay: number;
  perIpInFlight: number;
  perIpDailyUsd: number;
  docsDailyCapUsd: number;
  /** DAILY_SPEND_CAP_USD, the platform's cap, which the docs count toward too. */
  platformDailyCapUsd: number;
}

/**
 * Everything the docs proxy touches outside the request, injected (as the gateway's GatewayDeps are) so tests run it
 * with no database and no network. lib/docs/proxy/deps.ts wires the real ones.
 */
export interface DocsDeps {
  config: DocsConfig;
  /** Increments each key's counter for the window and returns the new counts (lib/gateway/store.ts). */
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  /** Takes one of `limit` slots for the key, or null when all are taken (lib/gateway/store.ts). */
  acquireInFlight(key: string, limit: number, now: Date): Promise<Date | null>;
  releaseInFlight(key: string, slot: Date): Promise<void>;
  /** Adds `amount` to a counter only if the total stays within `limit`. Returns the new total, or null when it wouldn't. */
  reserveCounter(key: string, windowStart: Date, amount: number, limit: number): Promise<number | null>;
  /** Adds `delta` (negative to give back) to a counter, never below zero. */
  adjustCounter(key: string, windowStart: Date, delta: number): Promise<void>;
  counterValue(key: string, windowStart: Date): Promise<number>;
  /** Today's (UTC) docs spend and platform spend, reservations of calls still running included. */
  docsSpendToday(): Promise<number>;
  platformSpendToday(): Promise<number>;
  /** Records a call's estimated cost before it is forwarded; returns the reservation's id (lib/gateway/store.ts). */
  reserveSpend(ctx: UsageContext, model: string | null, costUsd: number): Promise<string>;
  /** Replaces the reservation with the metered usage, or removes it when `item` is null. */
  settleSpend(reservationId: string, item: ModelUsage | null): Promise<void>;
  recordUsage(ctx: UsageContext, items: ModelUsage[]): Promise<void>;
  /** Notes that this visitor created a file or a stored response, with a background response's held spend. */
  recordObject(object: { id: string; kind: DocsObjectKind; visitor: string; hold?: DocsHoldState | null }): Promise<void>;
  /** A background response's held spend, or null when it has none (or was settled already). */
  pendingHold(id: string): Promise<DocsHoldState | null>;
  /** Takes a background response's held spend off its row, once: a second caller gets null. */
  claimHold(id: string): Promise<DocsHoldState | null>;
  /** Which of these ids the visitor created, with their kinds. */
  ownedIds(visitor: string, ids: string[]): Promise<Array<{ id: string; kind: DocsObjectKind }>>;
  /** The visitor's objects of a kind, newest first. */
  visitorObjects(visitor: string, kind: DocsObjectKind, limit: number): Promise<string[]>;
  /** Forgets an object once it is deleted upstream. */
  forgetObject(id: string): Promise<void>;
  /** The upstream calls. */
  fetch: typeof fetch;
  upstreamKey(): string;
  upstreamBaseUrl?: string;
  /** Keeps work alive after the response (Next's after()). The promise is already running when it's passed. */
  defer(task: () => Promise<unknown>): void;
  now?(): Date;
  newVisitorId?(): string;
}
