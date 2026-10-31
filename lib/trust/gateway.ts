import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { gatewayError } from "@/lib/gateway/errors";
import type { GatewayToken } from "@/lib/gateway/handler";
import { builderSpendToday } from "@/lib/trust/spend";
import { builderTier } from "@/lib/trust/tiers";

/**
 * The gateway's trust check (docs/CAPABILITIES.md, section 7), one marked line in lib/gateway/handler.ts right after
 * the token and product checks. Only wired while TRUST_REPORTS or TRUST_SIGNED_IN_CAPS is on (lib/gateway/deps.ts), so
 * with both off the gateway reads nothing new.
 */
export interface ProductTrust {
  takenDownAt: Date | null;
  ownerId: string;
  ownerEmail: string;
  ownerIsAdmin: boolean;
  ownerBannedAt: Date | null;
}

export interface TrustGatewayDeps {
  productTrust(productId: string): Promise<ProductTrust | null>;
  builderSpendToday(userId: string): Promise<number>;
  signedInCaps: boolean;
  builderDailyUsd: number;
  adminEmails: readonly string[];
}

/**
 * 403 product_disabled for a taken-down product or a banned owner's, and, with TRUST_SIGNED_IN_CAPS, 429
 * budget_exceeded for a live token whose signed-in owner's products have spent TRUST_BUILDER_DAILY_USD today. Admins
 * and the shared guest account have no builder cap: the guest's products are each held to their own daily budget and
 * the platform's cap, as today. Build tokens are left to their build's own budget, and checkBuildAllowed stops new
 * builds once the builder is over. Null lets the call go on.
 */
export async function trustCheck(token: Pick<GatewayToken, "productId" | "scope">, deps: TrustGatewayDeps): Promise<Response | null> {
  const p = await deps.productTrust(token.productId);
  if (!p) return null;
  if (p.takenDownAt || p.ownerBannedAt) {
    return gatewayError(403, "permission_error", "product_disabled", "This product was taken down on Muse Muse.", { retry: false });
  }
  if (!deps.signedInCaps || token.scope !== "live") return null;
  const tier = builderTier({ email: p.ownerEmail, isAdmin: p.ownerIsAdmin && deps.adminEmails.includes(p.ownerEmail) });
  if (tier !== "builder") return null;
  const cap = deps.builderDailyUsd;
  const spent = await deps.builderSpendToday(p.ownerId);
  if (spent < cap) return null;
  return gatewayError(
    429,
    "insufficient_quota",
    "budget_exceeded",
    cap === 0
      ? "This product's Meta calls are paused on Muse Muse today."
      : `The person who made this product has used their $${cap.toFixed(2)} daily Meta budget across their products. It resets at 00:00 UTC.`,
    { retry: false },
  );
}

/** One read: the product's takedown and its owner's ban and admin flag. */
export async function productTrust(productId: string): Promise<ProductTrust | null> {
  const [row] = await db()
    .select({
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

/** The real wiring, or null while neither flag that needs it is on. */
export function trustGatewayDeps(): TrustGatewayDeps | null {
  if (!env.trustReports && !env.trustSignedInCaps) return null;
  return {
    productTrust,
    builderSpendToday: (userId) => builderSpendToday(userId),
    signedInCaps: env.trustSignedInCaps,
    builderDailyUsd: env.trustBuilderDailyUsd,
    adminEmails: env.adminEmails,
  };
}
