import { and, eq, inArray, lt, notInArray } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { emit, setBuildStatus } from "@/lib/events";
import { TERMINAL_STATUSES } from "@/lib/types";

/** The longest legitimate build is about 100 minutes (DESIGN.md step caps), so 3 hours means the run is gone. */
export const STALE_AFTER_MS = 3 * 3_600_000;

/**
 * Fails builds that stopped reporting progress, for example when the workflow runtime itself gave up. Without this a
 * crashed run stays non-terminal and blocks refinements of its product as "busy". Products that never shipped are
 * marked failed too. Returns how many builds it failed.
 */
export async function failStaleBuilds(now: Date = new Date()): Promise<number> {
  const stale = await db()
    .select({ id: schema.builds.id, productId: schema.builds.productId })
    .from(schema.builds)
    .where(
      and(
        notInArray(schema.builds.status, [...TERMINAL_STATUSES]),
        lt(schema.builds.startedAt, new Date(now.getTime() - STALE_AFTER_MS)),
      ),
    )
    .limit(50);
  for (const build of stale) {
    await setBuildStatus(build.id, "failed", {
      message: "This build stopped reporting progress, so it was stopped.",
      set: { error: "Stopped after 3 hours without finishing." },
    });
    await emit(build.id, { type: "error", message: "This build stopped reporting progress, so it was stopped." });
  }
  const productIds = stale.map((b) => b.productId).filter((id): id is string => Boolean(id));
  if (productIds.length) {
    await db()
      .update(schema.products)
      .set({ status: "failed", updatedAt: now })
      .where(and(inArray(schema.products.id, productIds), eq(schema.products.status, "building")));
  }
  return stale.length;
}
