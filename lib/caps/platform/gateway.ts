import { and, eq, isNull } from "drizzle-orm";
import { capProduct } from "@/lib/caps/store";
import { db, schema } from "@/lib/db/client";
import type { GatewayToken } from "@/lib/gateway/handler";
import { CODE_SESSION_SCOPE } from "@/lib/gateway/policy";
import { hashToken } from "@/lib/gateway/tokens";

const SHAPE = /^mm_pk_[A-Za-z0-9_-]{43}$/;

export function isPowerKey(raw: string): boolean {
  return SHAPE.test(raw);
}

/**
 * Left to spend on a key, whichever day it's spent: a key's budget is its whole life's, not a day's, so the handler's
 * "spent today + estimate" check gets today's spend plus this.
 */
export function powerKeyLeftUsd(budgetUsd: number, spentUsd: number): number {
  return Math.max(0, budgetUsd - spentUsd);
}

/**
 * How the gateway finds a metered key (docs/PLATFORM_POWERS.md). Only while the platform cap is served. To the gateway it
 * is a session's token: POST /v1/responses only, its one model, fitted to what it has left. It dies at its expiry, when
 * revoked, and when its product is turned off, taken down or its owner banned.
 */
export async function findPowerKey(raw: string, spent: { total(id: string): Promise<number>; today(id: string): Promise<number> }): Promise<GatewayToken | null> {
  if (!isPowerKey(raw)) return null;
  const [row] = await db()
    .select()
    .from(schema.gatewayTokens)
    .where(and(eq(schema.gatewayTokens.tokenHash, hashToken(raw)), eq(schema.gatewayTokens.scope, "power_key" as "live"), isNull(schema.gatewayTokens.revokedAt)))
    .limit(1);
  if (!row || !row.expiresAt || row.expiresAt.getTime() <= Date.now()) return null;
  const product = await capProduct(row.productId);
  if (!product || product.status === "disabled" || product.status === "failed" || product.takenDownAt || product.ownerBannedAt) return null;
  const [total, today] = await Promise.all([spent.total(row.id), spent.today(row.id)]);
  return { id: row.id, productId: row.productId, scope: CODE_SESSION_SCOPE as GatewayToken["scope"], allowedModels: row.allowedModels, dailyBudgetUsd: today + powerKeyLeftUsd(row.dailyBudgetUsd, total), sessionSubject: row.id };
}
