import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import type { CapProduct, CapToken } from "@/lib/caps/gate";
import { findToken } from "@/lib/gateway/tokens";

/**
 * The cap gate's database reads (docs/CAPABILITIES.md, 2.4), beside the gateway's own store (lib/gateway/store.ts),
 * whose rate limits, counters and spend rows the gate uses as they are.
 */

/** The product behind a token and its owner, in one read: checks 2 to 4. */
export async function capProduct(productId: string): Promise<CapProduct | null> {
  const [row] = await db()
    .select({
      status: schema.products.status,
      manifest: schema.products.manifest,
      liveUrl: schema.products.liveUrl,
      takenDownAt: schema.products.takenDownAt,
      ownerId: schema.products.ownerId,
      ownerEmail: schema.users.email,
      ownerIsAdmin: schema.users.isAdmin,
      ownerBannedAt: schema.users.bannedAt,
    })
    .from(schema.products)
    .innerJoin(schema.users, eq(schema.users.id, schema.products.ownerId))
    .where(eq(schema.products.id, productId))
    .limit(1);
  return row ?? null;
}

/** findToken, shaped for the gate. */
export async function capToken(raw: string): Promise<CapToken | null> {
  const row = await findToken(raw);
  if (!row) return null;
  return { id: row.id, productId: row.productId, scope: row.scope, allowedModels: row.allowedModels, dailyBudgetUsd: row.dailyBudgetUsd, buildId: row.buildId ?? null };
}

/** A product's slug. */
export async function productSlug(productId: string): Promise<string | null> {
  const [row] = await db().select({ slug: schema.products.slug }).from(schema.products).where(eq(schema.products.id, productId)).limit(1);
  return row?.slug ?? null;
}

/** A build's stored brief, for what a build token's caps may do. */
export async function buildBrief(buildId: string): Promise<unknown> {
  const [row] = await db().select({ brief: schema.builds.brief }).from(schema.builds).where(eq(schema.builds.id, buildId)).limit(1);
  return row?.brief ?? null;
}
