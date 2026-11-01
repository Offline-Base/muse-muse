import { and, eq, isNotNull, isNull, like, lt, or } from "drizzle-orm";
import { JOBS_LIMITS } from "@/lib/caps/jobs/limits";
import { db, schema } from "@/lib/db/client";

// Cleanup for the jobs cap's rows (CAP_CLEANUPS in lib/caps/cleanup.ts, docs/CAPABILITIES.md 2.9). Kept apart from
// lib/caps/jobs/store.ts, so the build pipeline's cleanup imports only the database.

/** When a build ends: its test runs, its test hooks and the notices its jobs left go. */
export async function clearJobsBuild(buildId: string): Promise<void> {
  const ns = `b:${buildId}`;
  await db().batch([
    db().delete(schema.jobRuns).where(eq(schema.jobRuns.namespace, ns)),
    db().delete(schema.productWebhooks).where(eq(schema.productWebhooks.namespace, ns)),
    db().delete(schema.ownerNotices).where(eq(schema.ownerNotices.namespace, ns)),
  ]);
}

/**
 * The hourly sweep: crashed builds' rows, finished runs after 30 days, read notices after 90, revoked hooks after a day, and
 * drafted messages nobody answered in 14 days, whose addresses and words go. What's left says so and can't be confirmed.
 */
export async function sweepJobs(now: Date): Promise<number> {
  const buildOld = new Date(now.getTime() - JOBS_LIMITS.buildNamespaceMaxAgeMs);
  const runsOld = new Date(now.getTime() - JOBS_LIMITS.keepRunsMs);
  const noticesOld = new Date(now.getTime() - JOBS_LIMITS.keepNoticesMs);
  const hooksOld = new Date(now.getTime() - JOBS_LIMITS.revokedKeepMs);
  const expired = await db()
    .update(schema.ownerNotices)
    .set({ kind: "job", title: "A message a job drafted was dropped", body: "Nobody answered it for 14 days, so it was dropped and never sent.", payload: null, resolvedAt: now })
    .where(and(eq(schema.ownerNotices.kind, "send_held"), isNull(schema.ownerNotices.resolvedAt), lt(schema.ownerNotices.createdAt, new Date(now.getTime() - JOBS_LIMITS.heldKeepMs))))
    .returning({ id: schema.ownerNotices.id });
  const runs = await db()
    .delete(schema.jobRuns)
    .where(or(and(like(schema.jobRuns.namespace, "b:%"), lt(schema.jobRuns.createdAt, buildOld)), and(isNotNull(schema.jobRuns.finishedAt), lt(schema.jobRuns.finishedAt, runsOld))))
    .returning({ id: schema.jobRuns.id });
  const notices = await db()
    .delete(schema.ownerNotices)
    .where(or(and(like(schema.ownerNotices.namespace, "b:%"), lt(schema.ownerNotices.createdAt, buildOld)), and(isNotNull(schema.ownerNotices.readAt), lt(schema.ownerNotices.readAt, noticesOld))))
    .returning({ id: schema.ownerNotices.id });
  const hooks = await db()
    .delete(schema.productWebhooks)
    .where(or(and(like(schema.productWebhooks.namespace, "b:%"), lt(schema.productWebhooks.createdAt, buildOld)), lt(schema.productWebhooks.revokedAt, hooksOld)))
    .returning({ id: schema.productWebhooks.id });
  return expired.length + runs.length + notices.length + hooks.length;
}
