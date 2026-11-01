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
 *   its page, and pauses its Vercel project, so its site isn't served at any address (lib/trust/alias.ts). Undoing it
 *   gives back only the tokens revoked at that moment, the exact status it had before (kept in
 *   products.status_before_takedown), and the site.
 * - A ban sets users.banned_at and refuses sign-in and builds, then takes down each of their products at the same
 *   moment, so lifting the ban undoes exactly those takedowns and none an admin made for another reason.
 */

export interface TakedownProduct {
  id: string;
  slug: string;
  ownerId: string;
  status: ProductStatus;
  takenDownAt: Date | null;
  /** The status the takedown replaced, or null when it isn't down. */
  statusBeforeTakedown: ProductStatus | null;
  vercelProjectId: string | null;
  liveUrl: string | null;
}

export interface TakedownDeps {
  now(): Date;
  findProduct(slug: string): Promise<TakedownProduct | null>;
  productsOf(userId: string): Promise<TakedownProduct[]>;
  /**
   * Sets taken_down_at, the reason and status "disabled", keeping the status it replaces in status_before_takedown, when
   * it isn't taken down already. False when it was.
   */
  markTakenDown(productId: string, at: Date, reason: string): Promise<boolean>;
  /** Clears the takedown and sets the status back. */
  clearTakedown(productId: string, status: ProductStatus): Promise<void>;
  /** Revokes every live token still active at `at`. Returns how many. */
  revokeLiveTokens(productId: string, at: Date): Promise<number>;
  /** Un-revokes the live tokens revoked at exactly `at` that haven't expired. Returns how many. */
  restoreLiveTokens(productId: string, at: Date): Promise<number>;
  /** The status of the product's latest build (a BuildStatus), for a product that was still building when taken down. */
  shippedStatus(productId: string): Promise<string | null>;
  /**
   * The product's site on Vercel (lib/trust/alias.ts): pause and unpause its project, and remove or put back its
   * production domain, the backup when pausing fails. Null when publishing is off here.
   */
  alias: {
    pause(projectId: string): Promise<void>;
    unpause(projectId: string): Promise<void>;
    remove(projectId: string, host: string): Promise<void>;
    restore(projectId: string, host: string): Promise<void>;
  } | null;
  /** Each cap pauses what it runs for the product (lib/caps/cleanup.ts). */
  productOff(productId: string): Promise<void>;
}

export interface TakedownResult {
  slug: string;
  takenDownAt: string;
  tokens: number;
  /**
   * What happened to its site: "paused" or "unpaused"; "link removed" when pausing failed and only the production
   * domain could be removed, with why; "none" when it was never published; "off" when publishing is off here; or
   * "failed: <why>", when the site may still be up.
   */
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

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

/**
 * Takes the product's site down: pauses its Vercel project, which stops its production deployment at every address.
 * When that fails, removes its production domain instead, so at least its link stops. The rest of the takedown holds
 * either way: its tokens are revoked and the gateway refuses it.
 */
async function siteDown(p: TakedownProduct, deps: TakedownDeps): Promise<string> {
  if (!p.vercelProjectId) return "none";
  if (!deps.alias) return "off";
  try {
    await deps.alias.pause(p.vercelProjectId);
    return "paused";
  } catch (err) {
    const paused = messageOf(err);
    console.error(`[trust] couldn't pause project ${p.vercelProjectId}:`, paused);
    const host = hostOf(p.liveUrl);
    if (!host) return `failed: ${paused}`;
    try {
      await deps.alias.remove(p.vercelProjectId, host);
      return `link removed, but pausing failed: ${paused}`;
    } catch (err2) {
      console.error(`[trust] couldn't remove ${host} from its project:`, messageOf(err2));
      return `failed: ${paused}; ${messageOf(err2)}`;
    }
  }
}

/** Puts the site back: unpauses the project, then adds the production domain back in case the takedown removed it. */
async function siteUp(p: TakedownProduct, deps: TakedownDeps): Promise<string> {
  if (!p.vercelProjectId) return "none";
  if (!deps.alias) return "off";
  const problems: string[] = [];
  try {
    await deps.alias.unpause(p.vercelProjectId);
  } catch (err) {
    problems.push(messageOf(err));
    console.error(`[trust] couldn't unpause project ${p.vercelProjectId}:`, problems.at(-1));
  }
  const host = hostOf(p.liveUrl);
  if (host) {
    try {
      // A domain that's still there counts as restored (productAlias.restore).
      await deps.alias.restore(p.vercelProjectId, host);
    } catch (err) {
      problems.push(messageOf(err));
      console.error(`[trust] couldn't add ${host} back to its project:`, problems.at(-1));
    }
  }
  return problems.length ? `failed: ${problems.join("; ")}` : "unpaused";
}

/** Takes one product down at `at`. Null when it was already down (nothing changes). */
async function takeDown(p: TakedownProduct, at: Date, reason: string, deps: TakedownDeps): Promise<TakedownResult | null> {
  if (p.takenDownAt) return null;
  if (!(await deps.markTakenDown(p.id, at, reason))) return null;
  const tokens = await deps.revokeLiveTokens(p.id, at);
  await deps.productOff(p.id);
  return { slug: p.slug, takenDownAt: at.toISOString(), tokens, link: await siteDown(p, deps) };
}

/**
 * The status undoing a takedown puts back: exactly the one the takedown replaced, so a failed product stays failed and
 * one an admin had turned off stays off. A product that was still building then gets what its latest build ended as
 * (registerStep keeps a disabled product disabled, so the takedown hid it), and one still building stays "building".
 * With nothing to go on (a row from before status_before_takedown), it stays off for an admin to turn on.
 */
export function statusAfterUndo(before: ProductStatus | null, latestBuild: string | null): ProductStatus {
  if (before && before !== "building") return before;
  if (latestBuild === "live" || latestBuild === "partial" || latestBuild === "failed") return latestBuild;
  if (latestBuild === "refused") return "failed";
  if (latestBuild) return "building";
  return before ?? "disabled";
}

async function undo(p: TakedownProduct, deps: TakedownDeps): Promise<TakedownResult | null> {
  if (!p.takenDownAt) return null;
  const at = p.takenDownAt;
  const tokens = await deps.restoreLiveTokens(p.id, at);
  const latest = p.statusBeforeTakedown && p.statusBeforeTakedown !== "building" ? null : await deps.shippedStatus(p.id);
  await deps.clearTakedown(p.id, statusAfterUndo(p.statusBeforeTakedown, latest));
  return { slug: p.slug, takenDownAt: at.toISOString(), tokens, link: await siteUp(p, deps) };
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
  statusBeforeTakedown: schema.products.statusBeforeTakedown,
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
        // Postgres reads the right-hand side from the row before the update, so this keeps the status being replaced.
        .set({ takenDownAt: at, takedownReason: reason, statusBeforeTakedown: sql<ProductStatus>`${schema.products.status}`, status: "disabled", updatedAt: at })
        .where(and(eq(schema.products.id, productId), isNull(schema.products.takenDownAt)))
        .returning({ id: schema.products.id });
      return rows.length > 0;
    },
    async clearTakedown(productId, status) {
      await db()
        .update(schema.products)
        .set({ takenDownAt: null, takedownReason: null, statusBeforeTakedown: null, status, updatedAt: new Date() })
        .where(eq(schema.products.id, productId));
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
      if (row) return row.status;
      const [latest] = await db()
        .select({ status: schema.builds.status })
        .from(schema.builds)
        .where(eq(schema.builds.productId, productId))
        .orderBy(desc(schema.builds.startedAt))
        .limit(1);
      return latest?.status ?? null;
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
