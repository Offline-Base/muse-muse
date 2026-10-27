import { and, eq, gte, sql } from "drizzle-orm";
import type { SessionUser } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { platformSpendToday } from "@/lib/usage";

/** Builds count against a user's quota for 24 hours after they start. */
export const QUOTA_WINDOW_MS = 24 * 3_600_000;

export function quotaWindowStart(now: Date): Date {
  return new Date(now.getTime() - QUOTA_WINDOW_MS);
}

/** The user's own quota when their row has one, else the platform default. */
export function effectiveQuota(rowQuota: number | null | undefined, fallback: number): number {
  return typeof rowQuota === "number" && Number.isFinite(rowQuota) && rowQuota >= 0 ? rowQuota : fallback;
}

/** Admins are exempt. Everyone else may start `quota` builds per rolling 24 hours. */
export function quotaDecision(input: { isAdmin: boolean; quota: number; used: number }): {
  allowed: boolean;
  remaining: number | null;
} {
  if (input.isAdmin) return { allowed: true, remaining: null };
  const remaining = Math.max(0, input.quota - input.used);
  return { allowed: remaining > 0, remaining };
}

export function spendPausedDecision(spentUsd: number, capUsd: number): boolean {
  return spentUsd >= capUsd;
}

/** Builds of any kind (new builds and refinements) the user started since `since`. */
export async function buildsStartedSince(userId: string, since: Date): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.builds)
    .where(and(eq(schema.builds.userId, userId), gte(schema.builds.startedAt, since)));
  return Number(row?.n ?? 0);
}

/** True when today's platform-wide Meta spend has reached DAILY_SPEND_CAP_USD. */
export async function spendPaused(): Promise<boolean> {
  return spendPausedDecision(await platformSpendToday(), env.dailySpendCapUsd);
}

export type BuildAllowance = { ok: true } | { ok: false; status: 429 | 503; error: "daily_limit" | "paused" };

/** The spend cap applies to everyone. The daily quota applies to everyone but admins. */
export async function checkBuildAllowed(user: SessionUser): Promise<BuildAllowance> {
  if (await spendPaused()) return { ok: false, status: 503, error: "paused" };
  if (user.isAdmin) return { ok: true };
  const [row] = await db()
    .select({ quota: schema.users.dailyBuildQuota, isAdmin: schema.users.isAdmin })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);
  const used = await buildsStartedSince(user.id, quotaWindowStart(new Date()));
  const decision = quotaDecision({
    isAdmin: row?.isAdmin ?? false,
    quota: effectiveQuota(row?.quota, env.maxBuildsPerUserPerDay),
    used,
  });
  return decision.allowed ? { ok: true } : { ok: false, status: 429, error: "daily_limit" };
}
