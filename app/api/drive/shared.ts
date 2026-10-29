/**
 * Helpers shared by the /api/drive routes and the order pages (docs/VIBE_TUNING.md, Feature 6). Not a route: Next only
 * serves route.ts files.
 */
import { timingSafeEqual } from "node:crypto";
import { AuthError, requireAdminOrAutomation, requireUser } from "@/lib/auth";
import { BROWSER_COOKIE, DRIVE_COOKIE_DAYS, cookieValue, isOrderSecret, orderCookieName } from "@/lib/drive/logic";
import { benchTokenHash } from "@/lib/drive/token";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";

export const noStore = { "cache-control": "no-store" };

function cookie(name: string, value: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${DRIVE_COOKIE_DAYS * 86_400}; HttpOnly; SameSite=Lax${secure}`;
}

/** Set-Cookie for an order's link secret, so this browser opens the order page without the link. */
export function orderCookie(orderId: string, secret: string): string {
  return cookie(orderCookieName(orderId), secret);
}

/** Set-Cookie for this browser's random quota id. */
export function browserCookie(browserId: string): string {
  return cookie(BROWSER_COOKIE, browserId);
}

/** The order's secret this request carries in its cookie, or null. */
export function cookieSecret(req: Request, orderId: string): string | null {
  const value = cookieValue(req.headers.get("cookie"), orderCookieName(orderId));
  return isOrderSecret(value) ? value : null;
}

/** True for a signed-in admin, confirmed against the database. Never throws: anyone it can't confirm isn't one. */
export async function viewerIsAdmin(): Promise<boolean> {
  try {
    return (await requireUser()).isAdmin === true;
  } catch {
    return false;
  }
}

/** True when "Authorization: Bearer <token>" carries the bench token, whose hash (benchTokenHash) is DRIVE_BENCH_TOKEN_HASH. */
export function hasBenchToken(req: Request): boolean {
  const expected = env.driveBenchTokenHash;
  const header = req.headers.get("authorization") ?? "";
  if (!expected || !header.startsWith("Bearer ")) return false;
  const got = Buffer.from(benchTokenHash(header.slice("Bearer ".length).trim()));
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The bench routes take the bench token (it can only read the queue of paid orders and report on them), or an admin
 * or automation, as requireAdminOrAutomation checks them. Anything else is a 401 or a 403.
 */
export async function requireBench(req: Request): Promise<void> {
  if (hasBenchToken(req)) return;
  try {
    await requireAdminOrAutomation(req);
  } catch (err) {
    // A token that is neither the bench's nor automation's is a 401, as a wrong job token is. Signed-in people who
    // aren't admins keep their 403.
    if (err instanceof AuthError && req.headers.get("authorization")?.startsWith("Bearer ")) throw new HttpError(401, "bad_token");
    throw err;
  }
}
