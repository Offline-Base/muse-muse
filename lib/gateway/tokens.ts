import { createHmac, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";

export type TokenScope = "build" | "live";

/** HMAC-SHA256 with the pepper. Only this hash is stored, so a database leak doesn't leak usable tokens. */
export function hashToken(token: string): string {
  return createHmac("sha256", env.gatewayTokenPepper).update(token).digest("hex");
}

/**
 * Mints a gateway token for a product. Build tokens go into the builder sandbox for smoke tests and expire. Live tokens
 * go into the product's Vercel env. The plaintext token is returned once and never stored.
 */
export async function mintToken(opts: {
  productId: string;
  scope: TokenScope;
  allowedModels: string[];
  dailyBudgetUsd: number;
  ttlHours?: number;
}): Promise<{ id: string; token: string }> {
  const token = `mm_${opts.scope}_${randomBytes(32).toString("base64url")}`;
  const [row] = await db()
    .insert(schema.gatewayTokens)
    .values({
      productId: opts.productId,
      tokenHash: hashToken(token),
      scope: opts.scope,
      allowedModels: opts.allowedModels,
      dailyBudgetUsd: opts.dailyBudgetUsd,
      expiresAt: opts.ttlHours ? new Date(Date.now() + opts.ttlHours * 3_600_000) : null,
    })
    .returning({ id: schema.gatewayTokens.id });
  return { id: row.id, token };
}

export type GatewayTokenRow = typeof schema.gatewayTokens.$inferSelect;

/** Finds an active token by its plaintext value. Null when unknown, revoked or expired. */
export async function findToken(token: string): Promise<GatewayTokenRow | null> {
  if (!/^mm_(build|live)_[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const [row] = await db()
    .select()
    .from(schema.gatewayTokens)
    .where(and(eq(schema.gatewayTokens.tokenHash, hashToken(token)), isNull(schema.gatewayTokens.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;
  return row;
}

/** Revokes every token of a scope for a product, for example the build token once the product ships. */
export async function revokeTokens(productId: string, scope?: TokenScope): Promise<void> {
  await db()
    .update(schema.gatewayTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.gatewayTokens.productId, productId),
        isNull(schema.gatewayTokens.revokedAt),
        ...(scope ? [eq(schema.gatewayTokens.scope, scope)] : []),
      ),
    );
}
