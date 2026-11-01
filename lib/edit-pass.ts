import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { canActAsOwner, type SessionUser } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";

/**
 * Edit rights for shared guests (GUEST_EDITS, off by default). Every guest is one account, so the account can't say who
 * made what. The browser that made a build holds an httpOnly signed pass naming it, and that alone lets a guest refine
 * the product. /b links are public and localStorage history can be typed in, so neither ever counts.
 *
 * Refining only: canActAsOwner stays as it was for steering, downloads, connectors and everything else.
 */

export const EDIT_PASS_COOKIE = "mm_edit";
const PASS_VERSION = 1;
const PASS_DAYS = 90;
/** Newest kept. Keeps the cookie well under the 4 KB browsers allow. */
export const PASS_MAX_BUILDS = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The prefix keeps a pass from ever passing as a session, or a session as a pass, under the same secret. */
function sign(payload: string): string {
  return createHmac("sha256", env.sessionSecret).update(`edit-pass\0${payload}`).digest("base64url");
}

export function encodeEditPass(buildIds: readonly string[], now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ v: PASS_VERSION, ids: buildIds.slice(0, PASS_MAX_BUILDS), exp: now + PASS_DAYS * 86_400_000 }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The builds a pass names. Anything forged, expired or odd names none. */
export function decodeEditPass(value: string | undefined, now = Date.now()): string[] {
  if (!value) return [];
  const [payload, mac, extra] = value.split(".");
  if (!payload || !mac || extra !== undefined) return [];
  const given = Buffer.from(mac);
  const wanted = Buffer.from(sign(payload));
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return [];
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.v !== PASS_VERSION || typeof data.exp !== "number" || data.exp < now || !Array.isArray(data.ids)) return [];
    return data.ids.filter((id: unknown): id is string => typeof id === "string" && UUID.test(id)).slice(0, PASS_MAX_BUILDS);
  } catch {
    return [];
  }
}

export interface PassDeps {
  on(): boolean;
  readCookie(): Promise<string | undefined>;
  writeCookie(value: string): Promise<void>;
  /** The live, not taken down products of these builds that this account made and still owns. */
  productsOfBuilds(userId: string, buildIds: string[]): Promise<string[]>;
}

const realDeps: PassDeps = {
  on: () => env.guestEdits,
  readCookie: async () => (await cookies()).get(EDIT_PASS_COOKIE)?.value,
  writeCookie: async (value) => {
    (await cookies()).set(EDIT_PASS_COOKIE, value, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: PASS_DAYS * 86_400,
    });
  },
  productsOfBuilds: async (userId, buildIds) => {
    const rows = await db()
      .select({ id: schema.products.id })
      .from(schema.builds)
      .innerJoin(schema.products, eq(schema.builds.productId, schema.products.id))
      .where(
        and(
          inArray(schema.builds.id, buildIds),
          eq(schema.builds.userId, userId),
          eq(schema.products.ownerId, userId),
          isNull(schema.products.takenDownAt),
        ),
      );
    return rows.map((r) => r.id);
  },
};

const isSharedGuest = (user: SessionUser | null): user is SessionUser => Boolean(user?.openAccess && !user.isAdmin);

/** After a guest's new build starts: this browser's pass names it too. Nothing for anyone else, or with the flag off. */
export async function grantEditPass(user: SessionUser, buildId: string, deps: PassDeps = realDeps): Promise<void> {
  if (!deps.on() || !isSharedGuest(user)) return;
  const held = decodeEditPass(await deps.readCookie());
  await deps.writeCookie(encodeEditPass([buildId, ...held.filter((id) => id !== buildId)]));
}

/** The products this browser's pass lets this guest refine. Empty, with no cookie or database read, with the flag off. */
export async function guestEditProducts(user: SessionUser | null, deps: PassDeps = realDeps): Promise<Set<string>> {
  if (!deps.on() || !isSharedGuest(user)) return new Set();
  const held = decodeEditPass(await deps.readCookie());
  return new Set(held.length ? await deps.productsOfBuilds(user.id, held) : []);
}

/** Whether this viewer may refine this product: owner powers, or a guest's pass for it. */
export async function canEditProduct(
  user: SessionUser | null,
  product: { id: string; ownerId: string | null },
  deps: PassDeps = realDeps,
): Promise<boolean> {
  if (canActAsOwner(user, product.ownerId)) return true;
  return (await guestEditProducts(user, deps)).has(product.id);
}

/** Whether the refining rights come only from the pass, so the page can say they end with this browser's cookies. */
export function editsByPassOnly(user: SessionUser | null, ownerId: string | null, canEdit: boolean): boolean {
  return canEdit && !canActAsOwner(user, ownerId);
}

/**
 * For "Keep editing" links: of these products, the ones this viewer may change right now, each with the build whose
 * room holds its refine box. One query, and none for a guest with no pass.
 */
export async function editTargets(user: SessionUser | null, productIds: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const targets = new Map<string, string>();
  const ids = [...new Set(productIds.filter((id): id is string => Boolean(id)))];
  if (!user || !ids.length) return targets;
  const passed = await guestEditProducts(user);
  if (isSharedGuest(user) && !passed.size) return targets;
  const rows = await db()
    .select({
      id: schema.products.id,
      ownerId: schema.products.ownerId,
      status: schema.products.status,
      latestBuildId: schema.products.latestBuildId,
      takenDownAt: schema.products.takenDownAt,
    })
    .from(schema.products)
    .where(inArray(schema.products.id, ids));
  for (const row of rows) {
    if (row.status !== "live" && row.status !== "partial") continue;
    if (row.takenDownAt || !row.latestBuildId) continue;
    if (canActAsOwner(user, row.ownerId) || passed.has(row.id)) targets.set(row.id, row.latestBuildId);
  }
  return targets;
}
