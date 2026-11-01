/**
 * Whose connected accounts these are (docs/GITHUB_EXPORT.md). Every guest shares one user row in production, so a user id
 * can't name a guest. A guest's connections belong to this browser instead: a random httpOnly cookie, stored only as its
 * hash. No cookie, no connections, and nothing in a guest's request can name another guest's row.
 */
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { SessionUser } from "@/lib/auth";

export const BROWSER_COOKIE = "mm_connect";
const BROWSER_DAYS = 30;
const BROWSER_VALUE = /^[A-Za-z0-9_-]{43}$/;

export interface ConnectionOwner {
  kind: "user" | "browser";
  key: string;
}

/** A signed-in person by their account. Anyone on the shared open-access account, admin mode included, by this browser. */
export function connectionOwner(user: SessionUser | null, browserCookie: string | undefined): ConnectionOwner | null {
  if (!user) return null;
  if (!user.openAccess) return { kind: "user", key: user.id };
  if (!browserCookie || !BROWSER_VALUE.test(browserCookie)) return null;
  return { kind: "browser", key: createHash("sha256").update(`connect-browser\0${browserCookie}`).digest("hex") };
}

export const newBrowserValue = () => randomBytes(32).toString("base64url");

export async function currentConnectionOwner(user: SessionUser | null): Promise<ConnectionOwner | null> {
  return connectionOwner(user, (await cookies()).get(BROWSER_COOKIE)?.value);
}

/** The owner for someone about to connect: a guest with no binding yet gets one here, and only here. */
export async function bindConnectionOwner(user: SessionUser): Promise<ConnectionOwner> {
  const jar = await cookies();
  const held = connectionOwner(user, jar.get(BROWSER_COOKIE)?.value);
  if (held) return held;
  const value = newBrowserValue();
  jar.set(BROWSER_COOKIE, value, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: BROWSER_DAYS * 86_400 });
  return connectionOwner(user, value)!;
}
