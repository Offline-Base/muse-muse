import { and, eq, sql } from "drizzle-orm";
import type { Brief } from "@/lib/brief/schema";
import { gpuProofLines } from "@/lib/caps/gpu/judge";
import { usesSharedGlimmer } from "@/lib/caps/gpu/marker";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { publicHost } from "@/lib/sandbox/policy";

/** How many answers a build's tests got, and how many asked for a closed window: the gateway's own record. */
export async function glimmerBuildCounts(buildId: string): Promise<Record<string, number>> {
  const usage = schema.usage;
  const rows = await db()
    .select({ model: usage.model, count: sql<number>`count(*)` })
    .from(usage)
    .where(and(eq(usage.buildId, buildId), eq(usage.source, "glimmer")))
    .groupBy(usage.model);
  return Object.fromEntries(rows.map((r) => [r.model ?? "", Number(r.count)]));
}

/**
 * What judgeStep adds to its fixed checks for a build on the shared endpoint, or null. A local run's sandbox can't reach the
 * gateway, so its record would say nothing about the product, and this says nothing there too.
 */
export async function gpuProofText(brief: Brief, buildId: string): Promise<string | null> {
  if (!usesSharedGlimmer(brief) || publicHost(env.platformUrl) === null) return null;
  return gpuProofLines(await glimmerBuildCounts(buildId)).join("\n");
}
