// Platform file (Muse Muse platform services). Don't edit: call these from your pages and routes.
//
// People who sign in to this product with a passkey through Muse Muse. There's no email and no password. The platform
// signs a 30-day session (us1, or ut1 for a made-up person in a build's tests), and this product keeps it in its
// HttpOnly mm_user cookie, so page scripts never see it. The gateway checks the signature on every data call; this file
// only reads the cookie, so use it to show who is signed in, never to decide who may see what.
import type { RequestLike } from "@/lib/meta/client";

export const USER_COOKIE = "mm_user";
export const USER_NAME_COOKIE = "mm_user_name";
export const USER_HEADER = "x-musemuse-user";

const USER_SESSION = /^u[st]1\.[A-Za-z0-9._~-]{16,700}$/;

export interface CurrentUser {
  /** This product's id for the person. Another product knows them by another id. */
  id: string;
  /** What they typed when they made their passkey, up to 40 characters. Can be empty. */
  name: string;
}

function cookieHeader(from?: RequestLike | null): string {
  if (!from) return "";
  const headers = "get" in from && typeof from.get === "function" ? from : (from as { headers: { get(name: string): string | null } }).headers;
  return headers.get("cookie") ?? "";
}

function readCookie(from: RequestLike | null | undefined, name: string): string | null {
  for (const part of cookieHeader(from).split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** The session this browser holds, if any. It proves nothing by itself: only the gateway can check it. */
export function userSession(from?: RequestLike | null): string | null {
  const session = readCookie(from, USER_COOKIE);
  return session && USER_SESSION.test(session) ? session : null;
}

/** Who is signed in on this browser, or null. Read from the cookies, so it's for showing, not for access. */
export function currentUser(from?: RequestLike | null, now: Date = new Date()): CurrentUser | null {
  const session = userSession(from);
  if (!session) return null;
  const parts = session.split(".");
  const id = parts[0] === "ut1" ? parts[3] : parts[2];
  const exp = Number(parts[parts.length - 2]);
  if (!id || !Number.isFinite(exp) || exp <= now.getTime()) return null;
  let name = "";
  try {
    name = decodeURIComponent(readCookie(from, USER_NAME_COOKIE) ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 40);
  } catch {
    name = "";
  }
  return { id, name };
}

/** The link that signs someone in and brings them back to `returnTo`, a path on this site. */
export function signInHref(returnTo = "/"): string {
  return `/api/musemuse/user?returnTo=${encodeURIComponent(returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/")}`;
}

/** The header a gateway call carries for the signed-in person, or none. */
export function userHeaders(from?: RequestLike | null): Record<string, string> {
  const session = userSession(from);
  return session ? { [USER_HEADER]: session } : {};
}

export function isUserSession(value: unknown): value is string {
  return typeof value === "string" && USER_SESSION.test(value);
}

/** The two cookies a sign-in sets: the session (HttpOnly) and the name to show. */
export function userCookies(session: string, expiresAt: string, name: string): string[] {
  const seconds = Math.max(60, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000) || 30 * 24 * 3600);
  return [
    `${USER_COOKIE}=${session}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`,
    `${USER_NAME_COOKIE}=${encodeURIComponent(name.slice(0, 40))}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`,
  ];
}

/**
 * mm_signin holds a random value while this browser signs in (10 minutes, only on the sign-in route). The platform puts
 * the same value in the code it sends back, and the gateway takes the code only with it, so a sign-in link someone else
 * started can't sign this browser in as them.
 */
export const SIGN_IN_COOKIE = "mm_signin";
const SIGN_IN_BIND = /^[A-Za-z0-9_-]{16,64}$/;
const SIGN_IN_PATH = "/api/musemuse/user";

export function signInBind(from?: RequestLike | null): string | null {
  const value = readCookie(from, SIGN_IN_COOKIE);
  return value && SIGN_IN_BIND.test(value) ? value : null;
}

export function signInCookie(bind: string): string {
  return `${SIGN_IN_COOKIE}=${bind}; Path=${SIGN_IN_PATH}; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSignInCookie(): string {
  return `${SIGN_IN_COOKIE}=; Path=${SIGN_IN_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function clearUserCookies(): string[] {
  return [USER_COOKIE, USER_NAME_COOKIE].map((name) => `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}
