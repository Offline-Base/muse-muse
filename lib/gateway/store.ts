import { and, eq, lt, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { DEFAULT_LIMITS } from "@/lib/gateway/policy";
import type { UsageContext } from "@/lib/usage";
import type { ModelUsage, ProductStatus } from "@/lib/types";

/** Database calls the gateway, the kill switch and the cleanup cron make. Kept here so the logic stays testable. */

export async function productStatusById(productId: string): Promise<ProductStatus | null> {
  const [row] = await db()
    .select({ status: schema.products.status })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1);
  return row?.status ?? null;
}

export async function productSlugById(productId: string): Promise<string | null> {
  const [row] = await db()
    .select({ slug: schema.products.slug })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1);
  return row?.slug ?? null;
}

/**
 * Fixed one-minute windows: one upsert that inserts each key at 1 or increments it, returning the new counts.
 * Keys must be distinct (Postgres won't update the same row twice in one statement).
 */
export async function hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>> {
  const unique = [...new Set(keys)];
  if (!unique.length) return {};
  const rows = await db()
    .insert(schema.rateLimits)
    .values(unique.map((key) => ({ key, windowStart, count: 1 })))
    .onConflictDoUpdate({
      target: [schema.rateLimits.key, schema.rateLimits.windowStart],
      set: { count: sql`${schema.rateLimits.count} + 1` },
    })
    .returning({ key: schema.rateLimits.key, count: schema.rateLimits.count });
  return Object.fromEntries(rows.map((r) => [r.key, r.count]));
}

/**
 * Adds `amount` to a counter in one statement, only when the total stays within `limit`, and returns the new total
 * (or null when it wouldn't fit). The upsert locks the row, so two calls can't both take the last of a budget.
 */
export async function reserveCounter(
  key: string,
  windowStart: Date,
  amount: number,
  limit: number,
): Promise<number | null> {
  const at = windowStart.toISOString();
  const rows = await db()
    .insert(schema.rateLimits)
    .select(sql`select ${key}, ${at}::timestamptz, ${amount}::int where ${amount}::int <= ${limit}::int`)
    .onConflictDoUpdate({
      target: [schema.rateLimits.key, schema.rateLimits.windowStart],
      set: { count: sql`${schema.rateLimits.count} + ${amount}::int` },
      setWhere: sql`${schema.rateLimits.count} + ${amount}::int <= ${limit}::int`,
    })
    .returning({ count: schema.rateLimits.count });
  return rows.length ? rows[0].count : null;
}

/** Adds `delta` to a counter (negative gives back), never below zero. Creates the row when the window has none. */
export async function adjustCounter(key: string, windowStart: Date, delta: number): Promise<void> {
  await db()
    .insert(schema.rateLimits)
    .values({ key, windowStart, count: Math.max(0, delta) })
    .onConflictDoUpdate({
      target: [schema.rateLimits.key, schema.rateLimits.windowStart],
      set: { count: sql`greatest(${schema.rateLimits.count} + ${delta}::int, 0)` },
    });
}

export async function counterValue(key: string, windowStart: Date): Promise<number> {
  const [row] = await db()
    .select({ count: schema.rateLimits.count })
    .from(schema.rateLimits)
    .where(and(eq(schema.rateLimits.key, key), eq(schema.rateLimits.windowStart, windowStart)))
    .limit(1);
  return row?.count ?? 0;
}

/** Start of the in-flight bucket that `now` falls in. */
export function inFlightBucket(now: Date, bucketMs: number = DEFAULT_LIMITS.inFlightBucketMs): Date {
  return new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
}

/**
 * Takes one of `limit` in-flight slots for `key` and returns the bucket to release it in, or null when all are taken.
 * Slots are rate_limits rows per bucket, and the check also counts the previous bucket's row, so calls that started
 * before the bucket rolled over keep holding theirs. One statement: the upsert locks the bucket's row, so two callers
 * can't both take the last slot. A slot that a crashed call never gave back stops counting two buckets later.
 */
export async function acquireInFlight(key: string, limit: number, now: Date): Promise<Date | null> {
  const bucket = inFlightBucket(now);
  const previous = new Date(bucket.getTime() - DEFAULT_LIMITS.inFlightBucketMs);
  const held = sql`coalesce((select p.count from rate_limits p where p.key = ${key} and p.window_start = ${previous.toISOString()}::timestamptz), 0)`;
  const rows = await db()
    .insert(schema.rateLimits)
    .select(sql`select ${key}, ${bucket.toISOString()}::timestamptz, 1 where ${held} < ${limit}`)
    .onConflictDoUpdate({
      target: [schema.rateLimits.key, schema.rateLimits.windowStart],
      set: { count: sql`${schema.rateLimits.count} + 1` },
      setWhere: sql`${schema.rateLimits.count} + ${held} < ${limit}`,
    })
    .returning({ count: schema.rateLimits.count });
  return rows.length ? bucket : null;
}

/** Gives back a slot taken by acquireInFlight. */
export async function releaseInFlight(key: string, bucket: Date): Promise<void> {
  await db()
    .update(schema.rateLimits)
    .set({ count: sql`greatest(${schema.rateLimits.count} - 1, 0)` })
    .where(and(eq(schema.rateLimits.key, key), eq(schema.rateLimits.windowStart, bucket)));
}

/**
 * Records a call's estimated cost as a usage row before it is forwarded, so budget checks count calls still running.
 * Returns the row id for settleSpend. If the call never settles (a crash), the estimate stays as its recorded cost.
 */
export async function reserveSpend(ctx: UsageContext, model: string | null, costUsd: number): Promise<string> {
  const [row] = await db()
    .insert(schema.usage)
    .values({
      source: ctx.source,
      endpoint: ctx.endpoint,
      productId: ctx.productId ?? null,
      buildId: ctx.buildId ?? null,
      tokenId: ctx.tokenId ?? null,
      model,
      costUsd,
    })
    .returning({ id: schema.usage.id });
  return row.id;
}

/** Replaces a reservation with the metered usage in one statement, or deletes it when the call used nothing. */
export async function settleSpend(id: string, item: ModelUsage | null): Promise<void> {
  const used = item && (item.inputTokens || item.outputTokens || item.images || item.videoFrames || item.audioSeconds || item.units || item.costUsd);
  if (!item || !used) {
    await db().delete(schema.usage).where(eq(schema.usage.id, id));
    return;
  }
  await db()
    .update(schema.usage)
    .set({
      model: item.model,
      inputTokens: Math.round(item.inputTokens),
      cachedInputTokens: Math.round(item.cachedInputTokens),
      outputTokens: Math.round(item.outputTokens),
      images: item.images ?? 0,
      videoFrames: item.videoFrames ?? 0,
      audioSeconds: item.audioSeconds ?? 0,
      units: item.units ?? 0,
      costUsd: item.costUsd,
    })
    .where(eq(schema.usage.id, id));
}

export async function deleteRateLimitsBefore(before: Date): Promise<number> {
  const rows = await db()
    .delete(schema.rateLimits)
    .where(lt(schema.rateLimits.windowStart, before))
    .returning({ key: schema.rateLimits.key });
  return rows.length;
}

/** The kill switch. Returns the updated slug and status, or null when no product has that slug. */
export async function setProductStatusBySlug(
  slug: string,
  status: Extract<ProductStatus, "disabled" | "live" | "partial">,
): Promise<{ slug: string; status: ProductStatus } | null> {
  const [row] = await db()
    .update(schema.products)
    .set({ status, updatedAt: new Date() })
    .where(eq(schema.products.slug, slug))
    .returning({ slug: schema.products.slug, status: schema.products.status });
  return row ?? null;
}
