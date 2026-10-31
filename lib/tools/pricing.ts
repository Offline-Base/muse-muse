import type { CatalogFunction } from "@/lib/tools/composio/sync";
import type { ModelUsage } from "@/lib/types";

/**
 * What a tool call costs us. A reservation holds the upper bound, then settles to what the provider says it charged.
 * The per-call fees aren't reported in any reply, so they are booked at the higher published figure.
 */

/** Composio's Pro overage rate per tool call, booked even on Hobby to be safe. */
export const COMPOSIO_CALL_USD = 0.0003;
/** Composio's premium on managed OAuth apps. Its pricing table and FAQ disagree, and this is the higher figure. */
export const COMPOSIO_MANAGED_APP_USD = 0.0005;

/** The most a call should cost: the list price is above what Instant charges, and personal tools have none. */
export function estimateToolUsd(fn: Pick<CatalogFunction, "estimateUsd" | "instant">): number {
  return fn.instant ? fn.estimateUsd + COMPOSIO_CALL_USD : COMPOSIO_CALL_USD + COMPOSIO_MANAGED_APP_USD;
}

/** `instantCharge.amount` as a number, or null when the reply has none or it isn't a real amount. */
export function chargeOf(reply: { instantCharge?: { amount?: unknown } | null }): number | null {
  const raw = reply.instantCharge?.amount;
  if (raw === undefined || raw === null || raw === "") return null;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/**
 * What to book for a reply. A charge settles at the charge plus the call fee, and a failed call with no charge at $0
 * (the spike's failure and this unit's check both showed no charge). A success with no charge keeps the estimate, the
 * way the docs proxy settles what it can't read.
 */
export function settledToolUsd(fn: Pick<CatalogFunction, "estimateUsd" | "instant">, reply: { resultType?: string; instantCharge?: { amount?: unknown } | null }): number {
  const charge = chargeOf(reply);
  if (charge !== null) return charge + COMPOSIO_CALL_USD;
  if (reply.resultType !== "completed") return 0;
  return estimateToolUsd(fn);
}

export function toolUsage(slug: string, costUsd: number): ModelUsage {
  return { model: `composio:${slug}`, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd };
}
