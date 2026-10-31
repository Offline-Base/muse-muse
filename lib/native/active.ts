import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { NATIVE_RUN_LIMIT_MS } from "@/lib/native/product-view";
import { newestBrief } from "@/lib/native/queries";
import { hasNativeWork } from "@/lib/native/targets";

/** How long after shipping a run may still be about to start: the workflow starts it once the build is final. */
const START_GRACE_MS = 90_000;

/**
 * True while a build's native run can still add events, so its build room's stream stays open (docs/NATIVE.md). With every
 * target flag off this answers false without touching the database, so the stream closes exactly as it always has. Errors
 * count as no: a viewer's stream must never hang on this. An agent's runs only checked a preview: they neither hold the stream
 * open nor say the run that ships has started.
 */
export async function nativeActive(buildId: string, now = Date.now()): Promise<boolean> {
  if (!env.enabledTargets.length) return false;
  try {
    const d = db();
    const runs = await d
      .select({ status: schema.nativeRuns.status })
      .from(schema.nativeRuns)
      .where(and(eq(schema.nativeRuns.buildId, buildId), ne(schema.nativeRuns.origin, "agent"), gt(schema.nativeRuns.createdAt, new Date(now - NATIVE_RUN_LIMIT_MS))))
      .orderBy(desc(schema.nativeRuns.createdAt))
      .limit(10);
    if (runs.some((r) => r.status === "planned" || r.status === "running")) return true;
    if (runs.length) return false;
    const [build] = await d
      .select({ brief: schema.builds.brief, productId: schema.builds.productId, finishedAt: schema.builds.finishedAt })
      .from(schema.builds)
      .where(and(eq(schema.builds.id, buildId), inArray(schema.builds.status, ["live", "partial"])))
      .limit(1);
    if (!build?.finishedAt || now - build.finishedAt.getTime() >= START_GRACE_MS) return false;
    // A refinement's build has no brief of its own, and its run checks the apps again.
    return hasNativeWork(build.brief ?? (build.productId ? await newestBrief(build.productId) : null));
  } catch (err) {
    console.error("[native] couldn't read this build's runs:", err instanceof Error ? err.message : err);
    return false;
  }
}
