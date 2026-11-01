import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

/** 00:00 UTC of now's day: when the builder's daily dollars reset, as every daily budget does. */
export function utcDayStart(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * What one builder's work spent today (UTC), every source counted (TRUST_BUILDER_DAILY_USD): each usage row of a
 * product they own (its gateway calls, tool calls, Muse Code and the platform's calls for it) and of a build they
 * started (the brief and judge before its product exists). A row that matches both counts once. Reservations of calls
 * still running are rows too, so they count.
 */
export async function builderSpendToday(userId: string, now: Date = new Date()): Promise<number> {
  const start = utcDayStart(now);
  const owned = db().select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.ownerId, userId));
  // A build that started before yesterday has stopped spending: the build wall is 90 minutes.
  const started = db()
    .select({ id: schema.builds.id })
    .from(schema.builds)
    .where(and(eq(schema.builds.userId, userId), gte(schema.builds.startedAt, new Date(start.getTime() - 86_400_000))));
  const [row] = await db()
    .select({ total: sql<number>`coalesce(sum(${schema.usage.costUsd}), 0)::float8` })
    .from(schema.usage)
    .where(and(gte(schema.usage.at, start), or(inArray(schema.usage.productId, owned), inArray(schema.usage.buildId, started))));
  return Number(row?.total ?? 0);
}
