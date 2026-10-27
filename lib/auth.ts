import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";

/**
 * Sign-in for the hackathon: an email plus a shared access code (PLATFORM_ACCESS_CODE) that testers and judges get.
 * The session is an HMAC-signed cookie, so there's no session table. Browsing is public. Building needs a session.
 * Emails in ADMIN_EMAILS get admin (no daily cap, batch rebuilds, kill switch).
 */
export const SESSION_COOKIE = "mm_session";
const SESSION_DAYS = 14;

export interface SessionUser {
  id: string;
  email: string;
  isAdmin: boolean;
}

function sign(payload: string): string {
  return createHmac("sha256", env.sessionSecret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function encodeSession(user: SessionUser): string {
  const payload = Buffer.from(
    JSON.stringify({ uid: user.id, email: user.email, adm: user.isAdmin, exp: Date.now() + SESSION_DAYS * 86_400_000 }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(value: string | undefined): SessionUser | null {
  if (!value) return null;
  const [payload, mac] = value.split(".");
  if (!payload || !mac || !safeEqual(mac, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return { id: data.uid, email: data.email, isAdmin: Boolean(data.adm) };
  } catch {
    return null;
  }
}

/** The signed-in user, or null. Works in server components, route handlers and server actions. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  return decodeSession(jar.get(SESSION_COOKIE)?.value);
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Sign in to build.", 401);
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.isAdmin) throw new AuthError("Admins only.", 403);
  return user;
}

/**
 * Checks the access code, creates the user on first sign-in, and sets the session cookie.
 * Returns null when the code is wrong.
 */
export async function signIn(emailInput: string, code: string): Promise<SessionUser | null> {
  const email = emailInput.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return null;
  if (!safeEqual(code.trim(), env.accessCode)) return null;
  const isAdmin = env.adminEmails.includes(email);
  const [row] = await db()
    .insert(schema.users)
    .values({ email, isAdmin })
    .onConflictDoUpdate({ target: schema.users.email, set: { isAdmin } })
    .returning();
  const user: SessionUser = { id: row.id, email: row.email, isAdmin: row.isAdmin };
  const jar = await cookies();
  jar.set(SESSION_COOKIE, encodeSession(user), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
  return user;
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/** Looks a user up fresh, for the daily quota. */
export async function loadUser(id: string) {
  const [row] = await db().select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return row ?? null;
}
