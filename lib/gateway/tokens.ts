import { createHmac, randomBytes } from "node:crypto";
import { and, eq, isNull, lt, ne } from "drizzle-orm";
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
  /** A build token's build, for briefs with caps: their rows and files live in its namespace b:<buildId> (0019_engine). */
  buildId?: string;
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
      ...(opts.buildId ? { buildId: opts.buildId } : {}),
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

/**
 * Revokes every live token of a product except `keepId`, the one its newest deployment uses, or all of them when it's
 * null. registerStep and an imported product's publish (lib/promote/steps.ts) call it once the product is live.
 */
export async function revokeLiveTokensExcept(productId: string, keepId: string | null): Promise<void> {
  await db()
    .update(schema.gatewayTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.gatewayTokens.productId, productId),
        eq(schema.gatewayTokens.scope, "live"),
        isNull(schema.gatewayTokens.revokedAt),
        keepId ? ne(schema.gatewayTokens.id, keepId) : undefined,
      ),
    );
}

/** Stamps revokedAt on build tokens past their expiry, so they show as revoked too. Returns how many. */
export async function revokeExpiredBuildTokens(now: Date = new Date()): Promise<number> {
  const rows = await db()
    .update(schema.gatewayTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.gatewayTokens.scope, "build"),
        isNull(schema.gatewayTokens.revokedAt),
        lt(schema.gatewayTokens.expiresAt, now),
      ),
    )
    .returning({ id: schema.gatewayTokens.id });
  return rows.length;
}

// ---------- Wave 3, unit 9: Muse Code session tokens (docs/CAPABILITIES.md, 15b) ----------

/**
 * Stores a Muse Code session's token, made by sessionTokenFor (lib/caps/code/musecode/token.ts): scope code_session,
 * its one model, its session's budget, dead at `expiresAt` (the session's limit) or when revoked at stop. Only the hash
 * is stored. findToken never returns these: they are looked up by findCodeSessionToken, for /v1/responses only.
 */
export async function storeCodeSessionToken(opts: { token: string; productId: string; model: string; budgetUsd: number; expiresAt: Date }): Promise<{ id: string }> {
  const [row] = await db()
    .insert(schema.gatewayTokens)
    .values({ productId: opts.productId, tokenHash: hashToken(opts.token), scope: "code_session", allowedModels: [opts.model], dailyBudgetUsd: opts.budgetUsd, expiresAt: opts.expiresAt })
    .returning({ id: schema.gatewayTokens.id });
  return { id: row.id };
}

/** An active session token's row by its plaintext, or null when unknown, revoked, expired or not a session token. */
export async function findCodeSessionToken(token: string): Promise<GatewayTokenRow | null> {
  if (!/^mm_cs_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await db()
    .select()
    .from(schema.gatewayTokens)
    .where(and(eq(schema.gatewayTokens.tokenHash, hashToken(token)), eq(schema.gatewayTokens.scope, "code_session"), isNull(schema.gatewayTokens.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (!row.expiresAt || row.expiresAt < new Date()) return null;
  return row;
}

/** Revokes one token now: a session's at stop. */
export async function revokeTokenById(id: string, now: Date = new Date()): Promise<void> {
  await db().update(schema.gatewayTokens).set({ revokedAt: now }).where(and(eq(schema.gatewayTokens.id, id), isNull(schema.gatewayTokens.revokedAt)));
}
