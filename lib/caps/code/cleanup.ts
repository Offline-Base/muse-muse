import { and, eq, like, lt } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

// Cleanup for the code cap's exec_runs rows (CAP_CLEANUPS in lib/caps/cleanup.ts, docs/CAPABILITIES.md 2.9). Kept apart
// from lib/caps/code/store.ts, which reads briefs through lib/caps/store.ts, so the build pipeline's cleanup imports only
// the database. The namespace is b:<buildId> (lib/caps/proof.ts buildNamespace).

/** A build's run rows are only for its own checks. They go when the build ends (CAP_CLEANUPS). */
export async function clearCodeBuildRuns(buildId: string): Promise<void> {
  await db().delete(schema.execRuns).where(eq(schema.execRuns.namespace, `b:${buildId}`));
}

/** Build run rows older than two days, from builds that crashed before their cleanup ran. Live rows stay as the run log. */
export const CODE_BUILD_ROWS_MAX_AGE_MS = 48 * 3_600_000;

export async function sweepCodeBuildRuns(now: Date): Promise<number> {
  const gone = await db()
    .delete(schema.execRuns)
    .where(and(like(schema.execRuns.namespace, "b:%"), lt(schema.execRuns.createdAt, new Date(now.getTime() - CODE_BUILD_ROWS_MAX_AGE_MS))))
    .returning({ id: schema.execRuns.id });
  return gone.length;
}
