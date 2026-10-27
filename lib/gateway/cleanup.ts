import { createHash, timingSafeEqual } from "node:crypto";
import type { BlobPrefix } from "@/lib/storage";

const HOUR = 3_600_000;

export interface CleanupDeps {
  deleteBlobsOlderThan(prefix: BlobPrefix, olderThan: Date): Promise<number>;
  deleteRateLimitsBefore(before: Date): Promise<number>;
  revokeExpiredBuildTokens(now: Date): Promise<number>;
  /** Fails builds that stopped reporting progress (lib/pipeline/sweep.ts). Optional so tests can leave it out. */
  failStaleBuilds?(now: Date): Promise<number>;
}

export type CleanupResult = Record<string, { ok: true; count: number } | { ok: false; error: string }>;

/** True when the request carries "Authorization: Bearer <CRON_SECRET>" (what Vercel Cron sends). */
export function cronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

/**
 * The hourly cleanup. Each task runs on its own, so one failure (say Blob is down) doesn't stop the rest.
 *   uploads/ older than 24 h, screens/ older than 7 days, rate_limits windows older than 1 h, expired build tokens,
 *   and builds that stopped reporting progress.
 */
export async function runCleanup(deps: CleanupDeps, now: Date = new Date()): Promise<CleanupResult> {
  const tasks: Record<string, () => Promise<number>> = {
    uploads: () => deps.deleteBlobsOlderThan("uploads", new Date(now.getTime() - 24 * HOUR)),
    screens: () => deps.deleteBlobsOlderThan("screens", new Date(now.getTime() - 7 * 24 * HOUR)),
    rateLimits: () => deps.deleteRateLimitsBefore(new Date(now.getTime() - HOUR)),
    expiredBuildTokens: () => deps.revokeExpiredBuildTokens(now),
  };
  const failStale = deps.failStaleBuilds;
  if (failStale) tasks.staleBuilds = () => failStale(now);
  const entries = await Promise.all(
    Object.entries(tasks).map(async ([name, task]) => {
      try {
        return [name, { ok: true as const, count: await task() }] as const;
      } catch (err) {
        return [name, { ok: false as const, error: err instanceof Error ? err.message : String(err) }] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
