import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { familySpendToday, sessionByToken, sessionSpendUsd } from "@/lib/caps/code/musecode/store";
import { isSessionToken } from "@/lib/caps/code/musecode/token";
import { db, schema } from "@/lib/db/client";
import type { GatewayToken } from "@/lib/gateway/handler";
import { findCodeSessionToken } from "@/lib/gateway/tokens";

/**
 * How the gateway finds a Muse Code session's token (docs/CAPABILITIES.md, 15b), wired in lib/gateway/deps.ts only
 * while MUSE_CODE_ENABLED is on. A session token is live only while its row is not revoked or past its end, and its
 * session is still starting or running: dead at stop or at the limit.
 *
 * Its budget is worked out per call. The handler compares `spent today + estimate` with `dailyBudgetUsd`, so the token
 * is handed over with `dailyBudgetUsd` set to its spend today plus what is left, the smaller of:
 *   - its session's own budget less all it has spent ($1, or a build's share of its $0.50), and
 *   - the daily budget of the token that started it, less that token's spend today and its sessions' (shared).
 * Fitting (fitOutputToBudget, on for every code_session token) then sizes max_output_tokens to that, so Wonder's
 * 128,000-token ask can't stop a $1 session after $0.24.
 */
export function sessionLeftUsd(input: { sessionBudgetUsd: number; sessionSpentUsd: number; parentBudgetUsd: number; familySpentTodayUsd: number }): number {
  return Math.max(0, Math.min(input.sessionBudgetUsd - input.sessionSpentUsd, input.parentBudgetUsd - input.familySpentTodayUsd));
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function spentToday(tokenId: string): Promise<number> {
  const [row] = await db().select({ total: sql<number>`coalesce(sum(${schema.usage.costUsd}), 0)` }).from(schema.usage).where(and(eq(schema.usage.tokenId, tokenId), gte(schema.usage.at, startOfUtcDay())));
  return Number(row?.total ?? 0);
}

/** A session token as the gateway sees it, or null when it is dead. */
export async function findSessionGatewayToken(raw: string): Promise<GatewayToken | null> {
  if (!isSessionToken(raw)) return null;
  const row = await findCodeSessionToken(raw);
  if (!row) return null;
  const session = await sessionByToken(row.id);
  if (!session || (session.status !== "starting" && session.status !== "running") || session.endsAt.getTime() <= Date.now()) return null;
  const [parent] = session.parentTokenId
    ? await db().select({ dailyBudgetUsd: schema.gatewayTokens.dailyBudgetUsd }).from(schema.gatewayTokens).where(and(eq(schema.gatewayTokens.id, session.parentTokenId), isNull(schema.gatewayTokens.revokedAt))).limit(1)
    : [];
  // The token that started it was revoked (the product was redeployed, turned off or taken down): the session ends too.
  if (!parent) return null;
  const [total, today, family] = await Promise.all([sessionSpendUsd(row.id), spentToday(row.id), familySpendToday(session.parentTokenId!)]);
  const left = sessionLeftUsd({ sessionBudgetUsd: row.dailyBudgetUsd, sessionSpentUsd: total, parentBudgetUsd: parent.dailyBudgetUsd, familySpentTodayUsd: family });
  return { id: row.id, productId: row.productId, scope: row.scope, allowedModels: row.allowedModels, dailyBudgetUsd: today + left, sessionSubject: session.subjectKey ?? session.id };
}
