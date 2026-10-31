import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { GUEST_EMAIL } from "@/lib/auth";
import { capsProductOff, capsWatchProductOff } from "@/lib/caps/cleanup";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import type { ProductStatus } from "@/lib/types";

/**
 * Takedown and ban (TRUST_REPORTS, docs/CAPABILITIES.md, section 7). Both are reversible by an admin:
 *
 * - A takedown sets products.taken_down_at and the reason, turns the product off (status "disabled", the kill switch the
 *   gateway, its MCP connector and the gallery already honor), revokes its live tokens at exactly taken_down_at, hides
 *   its page, and removes its public link from its Vercel project. Undoing it gives back only the tokens revoked at that
 *   moment, the status its latest build shipped with, and the link.
 * - A ban sets users.banned_at and refuses sign-in and builds, then takes down each of their products at the same
 *   moment, so lifting the ban undoes exactly those takedowns and none an admin made for another reason.
 */

export interface TakedownProduct {
  id: string;
  slug: string;
  ownerId: string;
  status: ProductStatus;
  takenDownAt: Date | null;
  vercelProjectId: string | null;
  liveUrl: string | null;
}

export interface TakedownDeps {
  now(): Date;
  findProduct(slug: string): Promise<TakedownProduct | null>;
  productsOf(userId: string): Promise<TakedownProduct[]>;
  /** Sets taken_down_at, the reason and status "disabled" when it isn't taken down already. False when it was. */
  markTakenDown(productId: string, at: Date, reason: string): Promise<boolean>;
  /** Clears the takedown and sets the status back. */
  clearTakedown(productId: string, status: ProductStatus): Promise<void>;
  /** Revokes every live token still active at `at`. Returns how many. */
  revokeLiveTokens(productId: string, at: Date): Promise<number>;
  /** Un-revokes the live tokens revoked at exactly `at` that haven't expired. Returns how many. */
  restoreLiveTokens(productId: string, at: Date): Promise<number>;
  /** The status the product's latest build shipped with. */
  shippedStatus(productId: string): Promise<ProductStatus | null>;
  /** Removes or puts back the product's public link on Vercel. Null when publishing is off here. */
  alias: { remove(projectId: string, host: string): Promise<void>; restore(projectId: string, host: string): Promise<void> } | null;
  /** Each cap pauses what it runs for the product (lib/caps/cleanup.ts). */
  productOff(productId: string): Promise<void>;
}

export interface TakedownResult {
  slug: string;
  takenDownAt: string;
  tokens: number;
  /** "removed" or "restored", "none" when it has no link, "off" when publishing is off here, or why it failed. */
  link: string;
}

function hostOf(liveUrl: string | null): string | null {
  if (!liveUrl) return null;
  try {
    return new URL(liveUrl).host || null;
  } catch {
    return null;
  }
}

async function linkStep(p: TakedownProduct, deps: TakedownDeps, how: "remove" | "restore"): Promise<string> {
  const host = hostOf(p.liveUrl);
  if (!p.vercelProjectId || !host) return "none";
  if (!deps.alias) return "off";
  try {
    await deps.alias[how](p.vercelProjectId, host);
    return how === "remove" ? "removed" : "restored";
  } catch (err) {
    // The rest of the takedown holds without it: its tokens are revoked and the gateway refuses it.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[trust] couldn't ${how} ${host} on its project:`, message);
    return `failed: ${message.slice(0, 200)}`;
  }
}

/** Takes one product down at `at`. Null when it was already down (nothing changes). */
async function takeDown(p: TakedownProduct, at: Date, reason: string, deps: TakedownDeps): Promise<TakedownResult | null> {
  if (p.takenDownAt) return null;
  if (!(await deps.markTakenDown(p.id, at, reason))) return null;
  const tokens = await deps.revokeLiveTokens(p.id, at);
  await deps.productOff(p.id);
  return { slug: p.slug, takenDownAt: at.toISOString(), tokens, link: await linkStep(p, deps, "remove") };
}

async function undo(p: TakedownProduct, deps: TakedownDeps): Promise<TakedownResult | null> {
  if (!p.takenDownAt) return null;
  const at = p.takenDownAt;
  const tokens = await deps.restoreLiveTokens(p.id, at);
  const shipped = await deps.shippedStatus(p.id);
  await deps.clearTakedown(p.id, shipped === "live" || shipped === "partial" ? shipped : "live");
  return { slug: p.slug, takenDownAt: at.toISOString(), tokens, link: await linkStep(p, deps, "restore") };
}

export const REASON_MAX_CHARS = 500;

export function cleanReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const reason = raw.trim().replace(/\s+/g, " ");
  return reason && reason.length <= REASON_MAX_CHARS ? reason : null;
}

export async function takedownProduct(slug: string, reason: string, deps: TakedownDeps): Promise<{ ok: true; result: TakedownResult | null } | { ok: false }> {
  const p = await deps.findProduct(slug);
  if (!p) return { ok: false };
  return { ok: true, result: await takeDown(p, deps.now(), reason, deps) };
}

export async function undoTakedown(slug: string, deps: TakedownDeps): Promise<{ ok: true; result: TakedownResult | null } | { ok: false }> {
  const p = await deps.findProduct(slug);
  if (!p) return { ok: false };
  return { ok: true, result: await undo(p, deps) };
}

export interface BanDeps extends TakedownDeps {
  findUser(id: string): Promise<{ id: string; email: string; bannedAt: Date | null } | null>;
  setBan(userId: string, at: Date | null, reason: string | null): Promise<void>;
  /** Admins and the shared guest account can't be banned. */
  protectedEmail(email: string): boolean;
}

export type BanResult =
  | { ok: true; bannedAt: string | null; products: TakedownResult[] }
  | { ok: false; status: 404 | 409; error: string };

/** Bans a builder at one moment and takes down each product of theirs at that same moment. */
export async function banUser(userId: string, reason: string, deps: BanDeps): Promise<BanResult> {
  const user = await deps.findUser(userId);
  if (!user) return { ok: false, status: 404, error: "not_found" };
  if (deps.protectedEmail(user.email)) return { ok: false, status: 409, error: "Admins and the shared guest account can't be banned. Take their products down one by one instead." };
  if (user.bannedAt) return { ok: true, bannedAt: user.bannedAt.toISOString(), products: [] };
  const at = deps.now();
  await deps.setBan(user.id, at, reason);
  const products: TakedownResult[] = [];
  for (const p of await deps.productsOf(user.id)) {
    const done = await takeDown(p, at, `Owner banned: ${reason}`.slice(0, REASON_MAX_CHARS), deps);
    if (done) products.push(done);
  }
  return { ok: true, bannedAt: at.toISOString(), products };
}

/** Lifts a ban and undoes the takedowns it made (those at the ban's exact moment). Others stay down. */
export async function liftBan(userId: string, deps: BanDeps): Promise<BanResult> {
  const user = await deps.findUser(userId);
  if (!user) return { ok: false, status: 404, error: "not_found" };
  if (!user.bannedAt) return { ok: true, bannedAt: null, products: [] };
  const at = user.bannedAt;
  await deps.setBan(user.id, null, null);
  const products: TakedownResult[] = [];
  for (const p of await deps.productsOf(user.id)) {
    if (p.takenDownAt?.getTime() !== at.getTime()) continue;
    const done = await undo(p, deps);
    if (done) products.push(done);
  }
  return { ok: true, bannedAt: null, products };
}

// ---------- The real wiring ----------

const PRODUCT_COLUMNS = {
  id: schema.products.id,
  slug: schema.products.slug,
  ownerId: schema.products.ownerId,
  status: schema.products.status,
  takenDownAt: schema.products.takenDownAt,
  vercelProjectId: schema.products.vercelProjectId,
  liveUrl: schema.products.liveUrl,
};

export function dbTakedownDeps(alias: TakedownDeps["alias"]): BanDeps {
  return {
    now: () => new Date(),
    async findProduct(slug) {
      const [row] = await db().select(PRODUCT_COLUMNS).from(schema.products).where(eq(schema.products.slug, slug)).limit(1);
      return row ?? null;
    },
    productsOf: (userId) => db().select(PRODUCT_COLUMNS).from(schema.products).where(eq(schema.products.ownerId, userId)),
    async markTakenDown(productId, at, reason) {
      const rows = await db()
        .update(schema.products)
        .set({ takenDownAt: at, takedownReason: reason, status: "disabled", updatedAt: at })
        .where(and(eq(schema.products.id, productId), isNull(schema.products.takenDownAt)))
        .returning({ id: schema.products.id });
      return rows.length > 0;
    },
    async clearTakedown(productId, status) {
      await db().update(schema.products).set({ takenDownAt: null, takedownReason: null, status, updatedAt: new Date() }).where(eq(schema.products.id, productId));
    },
    async revokeLiveTokens(productId, at) {
      const rows = await db()
        .update(schema.gatewayTokens)
        .set({ revokedAt: at })
        .where(and(eq(schema.gatewayTokens.productId, productId), eq(schema.gatewayTokens.scope, "live"), isNull(schema.gatewayTokens.revokedAt)))
        .returning({ id: schema.gatewayTokens.id });
      return rows.length;
    },
    async restoreLiveTokens(productId, at) {
      const rows = await db()
        .update(schema.gatewayTokens)
        .set({ revokedAt: null })
        .where(
          and(
            eq(schema.gatewayTokens.productId, productId),
            eq(schema.gatewayTokens.scope, "live"),
            eq(schema.gatewayTokens.revokedAt, at),
            sql`(${schema.gatewayTokens.expiresAt} is null or ${schema.gatewayTokens.expiresAt} > now())`,
          ),
        )
        .returning({ id: schema.gatewayTokens.id });
      return rows.length;
    },
    async shippedStatus(productId) {
      const [row] = await db()
        .select({ status: schema.builds.status })
        .from(schema.products)
        .innerJoin(schema.builds, eq(schema.builds.id, schema.products.latestBuildId))
        .where(eq(schema.products.id, productId))
        .limit(1);
      if (row) return row.status as ProductStatus;
      const [latest] = await db()
        .select({ status: schema.builds.status })
        .from(schema.builds)
        .where(eq(schema.builds.productId, productId))
        .orderBy(desc(schema.builds.startedAt))
        .limit(1);
      return (latest?.status as ProductStatus | undefined) ?? null;
    },
    alias,
    productOff: async (productId) => {
      if (capsWatchProductOff()) await capsProductOff(productId);
    },
    async findUser(id) {
      const [row] = await db().select({ id: schema.users.id, email: schema.users.email, bannedAt: schema.users.bannedAt }).from(schema.users).where(eq(schema.users.id, id)).limit(1);
      return row ?? null;
    },
    async setBan(userId, at, reason) {
      await db().update(schema.users).set({ bannedAt: at, banReason: reason }).where(eq(schema.users.id, userId));
    },
    protectedEmail: (email) => email === GUEST_EMAIL || env.adminEmails.includes(email),
  };
}
