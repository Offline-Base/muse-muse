import { and, eq, gte, isNull, ne, or, sql } from "drizzle-orm";
import type { SessionUser } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { fileStorageAvailable } from "@/lib/local-files";
import { platformSpendToday } from "@/lib/usage";

/** Builds count against a user's quota for 24 hours after they start. */
export const QUOTA_WINDOW_MS = 24 * 3_600_000;

/**
 * builds.workflow_run_id of a build imported from a local run (lib/promote/store.ts). It ran on a laptop, not here, so
 * it never counts against the quota of the guest account it belongs to on the live site. attachRun is the only other
 * writer of the column, and the build API never sends it.
 */
export const IMPORTED_RUN = "imported";

export function quotaWindowStart(now: Date): Date {
  return new Date(now.getTime() - QUOTA_WINDOW_MS);
}

/**
 * Builds per rolling 24 hours for anyone who isn't an admin: MAX_BUILDS_PER_USER_PER_DAY, read on every check so a
 * change reaches everyone at once. users.daily_build_quota is not read. signIn copies the env value into it only when
 * the row is created and nothing ever changes it, so it can't tell an admin's override from a stale copy, and trusting
 * it kept a raised limit from reaching anyone who had already signed in.
 */
export function dailyBuildQuota(): number {
  return env.maxBuildsPerUserPerDay;
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

/** Builds of any kind (new builds and refinements) the user started on this site since `since`. Imported ones don't count. */
export async function buildsStartedSince(userId: string, since: Date): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.builds)
    .where(
      and(
        eq(schema.builds.userId, userId),
        gte(schema.builds.startedAt, since),
        or(isNull(schema.builds.workflowRunId), ne(schema.builds.workflowRunId, IMPORTED_RUN)),
      ),
    );
  return Number(row?.n ?? 0);
}

/** True when today's platform-wide Meta spend has reached DAILY_SPEND_CAP_USD. */
export async function spendPaused(): Promise<boolean> {
  return spendPausedDecision(await platformSpendToday(), env.dailySpendCapUsd);
}

export type BuildAllowance =
  | { ok: true }
  | { ok: false; status: 429 | 503; error: "daily_limit" | "shared_limit" | "paused" | "no_storage" };

/**
 * The spend cap applies to everyone. The daily quota applies to everyone but admins. The shared guest (OPEN_ACCESS=guest)
 * gets "shared_limit" instead of "daily_limit", since the builds that used it up were usually someone else's.
 */
export async function checkBuildAllowed(user: SessionUser): Promise<BuildAllowance> {
  // Every build stores screenshots and a demo, so without file storage it would run for minutes and then fail.
  // BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID counts (lib/local-files.ts fileStorageAvailable).
  if (!fileStorageAvailable()) return { ok: false, status: 503, error: "no_storage" };
  if (await spendPaused()) return { ok: false, status: 503, error: "paused" };
  if (user.isAdmin) return { ok: true };
  const used = await buildsStartedSince(user.id, quotaWindowStart(new Date()));
  // Admin sessions returned above. users.is_admin can be true for an admin's shared-code session, which isn't admin.
  const decision = quotaDecision({ isAdmin: false, quota: dailyBuildQuota(), used });
  if (decision.allowed) return { ok: true };
  return { ok: false, status: 429, error: user.openAccess ? "shared_limit" : "daily_limit" };
}
