import { eq, lt, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import type { ProductStatus } from "@/lib/types";

/** Database calls the gateway, the kill switch and the cleanup cron make. Kept here so the logic stays testable. */

export async function productStatusById(productId: string): Promise<ProductStatus | null> {
  const [row] = await db()
    .select({ status: schema.products.status })
    .from(schema.products)
    .where(eq(schema.products.id, productId))
    .limit(1);
  return row?.status ?? null;
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
