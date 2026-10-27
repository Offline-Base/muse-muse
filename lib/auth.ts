import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { cookies, headers } from "next/headers";
import { eq, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";

/**
 * Sign-in for the hackathon: an email, a personal password and an access code. Testers and judges share
 * PLATFORM_ACCESS_CODE. The first password typed for an email claims it, and every later sign-in must match it.
 * Admin (no daily cap, batch rebuilds, kill switch) needs an email in ADMIN_EMAILS and the separate ADMIN_ACCESS_CODE,
 * or OPEN_ACCESS=admin on a preview or localhost. The shared code never grants it. The session is an HMAC-signed cookie,
 * so there's no session table. Browsing is public. Building needs a session, unless OPEN_ACCESS turns sign-in off (see
 * effectiveOpenAccess).
 */
export const SESSION_COOKIE = "mm_session";
const SESSION_DAYS = 14;
/** Sessions signed with another version are refused. 2 added passwords and the admin code. */
const SESSION_VERSION = 2;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

export interface SessionUser {
  id: string;
  email: string;
  isAdmin: boolean;
  /** Sign-in is off (OPEN_ACCESS) and this visitor, who has no session of their own, acts as the shared account. */
  openAccess?: boolean;
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
    JSON.stringify({
      v: SESSION_VERSION,
      uid: user.id,
      email: user.email,
      adm: user.isAdmin,
      exp: Date.now() + SESSION_DAYS * 86_400_000,
    }),
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(value: string | undefined): SessionUser | null {
  if (!value) return null;
  const [payload, mac] = value.split(".");
  if (!payload || !mac || !safeEqual(mac, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.v !== SESSION_VERSION || typeof data.exp !== "number" || data.exp < Date.now()) return null;
    if (typeof data.uid !== "string" || typeof data.email !== "string") return null;
    return { id: data.uid, email: data.email, isAdmin: data.adm === true };
  } catch {
    return null;
  }
}

// ---------- Passwords ----------

const SCRYPT = { N: 16_384, r: 8, p: 1 };
const KEY_BYTES = 32;

function scryptKey(password: string, salt: Buffer, length: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFC"), salt, length, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** "scrypt$N$r$p$salt$hash", with the salt and hash in base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptKey(password, salt, KEY_BYTES, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  // Only parameters this file could have written, so a bad row can't make scrypt run for minutes.
  const sane = N >= 2 && N <= 2 ** 20 && (N & (N - 1)) === 0 && r >= 1 && r <= 32 && p >= 1 && p <= 16;
  if (!sane || !salt.length || expected.length < 16 || expected.length > 64) return false;
  const key = await scryptKey(password, salt, expected.length, { N, r, p, maxmem: 256 * N * r });
  return timingSafeEqual(key, expected);
}

// ---------- Open access ----------

/** The shared account everyone builds as under OPEN_ACCESS=guest. A ".invalid" address can never be a real one. */
export const GUEST_EMAIL = "guest@musemuse.invalid";

type OpenAccessMode = "off" | "guest" | "admin";

/** localhost, 127.x.x.x or [::1], with or without a port. */
export function isLoopbackHost(host: string | null): boolean {
  const name = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  return name === "localhost" || name === "[::1]" || /^127(\.\d{1,3}){3}$/.test(name);
}

/**
 * The OPEN_ACCESS mode that applies to this request. "admin" applies on Vercel previews, which deployment protection
 * keeps to the team, and on a local run only when the request's Host is localhost, so a tunnel never hands out admin.
 * Everywhere else, production included, it fails closed to "off". "guest" applies wherever it's set.
 *
 * The Host check can't stop someone on the same network who forges the header, which is why `npm run dev` listens on
 * localhost only.
 */
export function effectiveOpenAccess(mode: OpenAccessMode, vercelEnv: string | undefined, h: Headers): OpenAccessMode {
  if (mode !== "admin") return mode;
  if (vercelEnv === "preview") return "admin";
  if (vercelEnv === "production") return "off";
  const hosts = [h.get("host"), h.get("x-forwarded-host")].filter((v): v is string => v !== null);
  return hosts.length && hosts.every(isLoopbackHost) ? "admin" : "off";
}

/** Product owner powers (refining it): admins, and the owner, unless the "owner" is the guest everyone shares. */
export function canActAsOwner(user: SessionUser | null, ownerId: string | null | undefined): boolean {
  if (!user) return false;
  if (user.isAdmin) return true;
  return !user.openAccess && Boolean(ownerId) && user.id === ownerId;
}

/**
 * Who a visitor without a session acts as, or null while sign-in is required. "admin" mode needs an ADMIN_EMAILS
 * address to act as and falls back to the guest without one.
 */
export function openAccessIdentity(
  mode: OpenAccessMode,
  adminEmails: string[],
): { email: string; isAdmin: boolean } | null {
  if (mode === "off") return null;
  if (mode === "admin" && adminEmails[0]) return { email: adminEmails[0], isAdmin: true };
  return { email: GUEST_EMAIL, isAdmin: false };
}

/**
 * True when the browser says the request came from another site. An open-access visitor has no SameSite cookie, so
 * without this a page anywhere could post a form or a fetch that builds as them. Requests that carry neither header,
 * such as curl, aren't from a browser and pass: under open access they could call the API directly anyway.
 */
export function isCrossSite(h: Headers): boolean {
  const site = h.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = h.get("origin");
  if (!origin) return false;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

// ---------- Sign-in ----------

/** Which code was typed. The admin code counts only when it's set and differs from the shared one. */
export function codeKind(typed: string, shared: string, admin: string | undefined): "admin" | "shared" | null {
  const code = typed.trim();
  if (admin && admin !== shared && safeEqual(code, admin)) return "admin";
  return safeEqual(code, shared) ? "shared" : null;
}

/** Admin needs all three: a session signed in with the admin code, a row that still says admin, and a listed email. */
export function isAdminNow(
  session: SessionUser,
  row: { email: string; isAdmin: boolean } | null,
  adminEmails: string[],
): boolean {
  return Boolean(session.isAdmin && row?.isAdmin && row.email === session.email && adminEmails.includes(row.email));
}

export interface UserRecord {
  id: string;
  email: string;
  isAdmin: boolean;
  passwordHash: string | null;
}

export interface AuthStore {
  findByEmail(email: string): Promise<UserRecord | null>;
  /** Creates the user or sets their password, only while they have none. Null when someone else claimed it first. */
  claim(email: string, passwordHash: string): Promise<UserRecord | null>;
  setAdmin(id: string, isAdmin: boolean): Promise<void>;
}

export interface SignInConfig {
  accessCode: string;
  adminAccessCode: string | undefined;
  adminEmails: string[];
}

/**
 * Checks the code and password, claiming the email with this password on its first sign-in. Every wrong input
 * returns null, so the caller can give one generic error.
 */
export async function checkSignIn(
  input: { email: string; code: string; password: string },
  store: AuthStore,
  config: SignInConfig,
): Promise<SessionUser | null> {
  const email = input.email.trim().toLowerCase();
  const { password } = input;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200 || email === GUEST_EMAIL) return null;
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) return null;
  const kind = codeKind(input.code, config.accessCode, config.adminAccessCode);
  if (!kind) return null;
  const listed = config.adminEmails.includes(email);

  let row = await store.findByEmail(email);
  let claimed = false;
  if (!row?.passwordHash) {
    // Only the admin code can claim an admin's address, so nobody holding the shared code can take it first.
    if (listed && kind !== "admin") return null;
    const won = await store.claim(email, await hashPassword(password));
    if (won) {
      row = won;
      claimed = true;
    } else {
      row = await store.findByEmail(email);
    }
  }
  if (!row?.passwordHash) return null;
  if (!claimed && !(await verifyPassword(password, row.passwordHash))) return null;

  const isAdmin = listed && kind === "admin";
  // The row is what requireAdmin re-checks. A shared-code sign-in leaves it alone, so it doesn't end the admin's
  // session on another device, and an unlisted email always loses it.
  const rowAdmin = listed && (isAdmin || row.isAdmin);
  if (rowAdmin !== row.isAdmin) await store.setAdmin(row.id, rowAdmin);
  return { id: row.id, email: row.email, isAdmin };
}

// A function, so importing this file never touches the schema (tests swap the database module out).
const userColumns = () => ({
  id: schema.users.id,
  email: schema.users.email,
  isAdmin: schema.users.isAdmin,
  passwordHash: schema.users.passwordHash,
});

const dbStore: AuthStore = {
  async findByEmail(email) {
    const [row] = await db().select(userColumns()).from(schema.users).where(eq(schema.users.email, email)).limit(1);
    return row ?? null;
  },
  async claim(email, passwordHash) {
    const [row] = await db()
      .insert(schema.users)
      .values({ email, passwordHash, dailyBuildQuota: env.maxBuildsPerUserPerDay })
      .onConflictDoUpdate({ target: schema.users.email, set: { passwordHash }, setWhere: isNull(schema.users.passwordHash) })
      .returning(userColumns());
    return row ?? null;
  },
  async setAdmin(id, isAdmin) {
    await db().update(schema.users).set({ isAdmin }).where(eq(schema.users.id, id));
  },
};

/** Creates the user row if it's missing and leaves any password and admin flag as they are. */
async function ensureUser(email: string): Promise<{ id: string; email: string }> {
  const [row] = await db()
    .insert(schema.users)
    .values({ email, dailyBuildQuota: env.maxBuildsPerUserPerDay })
    .onConflictDoUpdate({ target: schema.users.email, set: { email } })
    .returning({ id: schema.users.id, email: schema.users.email });
  return row;
}

/** Open-access accounts by "email|admin", so each server instance writes the row once. A failure is retried. */
const openUsers = new Map<string, Promise<SessionUser>>();

function openAccessUser(h: Headers): Promise<SessionUser> | null {
  const who = openAccessIdentity(effectiveOpenAccess(env.openAccess, process.env.VERCEL_ENV, h), env.adminEmails);
  if (!who) return null;
  const key = `${who.email}|${who.isAdmin}`;
  let user = openUsers.get(key);
  if (!user) {
    user = ensureUser(who.email).then((row) => ({ id: row.id, email: row.email, isAdmin: who.isAdmin, openAccess: true }));
    user.catch((err) => {
      console.error("[auth] couldn't load the open-access account:", err);
      openUsers.delete(key);
    });
    openUsers.set(key, user);
  }
  return user;
}

/**
 * The signed-in user, or null. Works in server components, route handlers and server actions. While OPEN_ACCESS is
 * on, a visitor with no session gets the open-access account instead of null. A real session still wins.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const user = decodeSession(jar.get(SESSION_COOKIE)?.value);
  if (user) return { ...user, isAdmin: user.isAdmin && env.adminEmails.includes(user.email) };
  return (await openAccessUser(await headers())) ?? null;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

/**
 * The signed-in user. An admin flag is confirmed against the database, so the cookie alone never grants admin. The
 * open-access account comes from OPEN_ACCESS, not a cookie, so it's refused to requests from other sites instead.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Sign in to build.", 401);
  if (user.openAccess) {
    if (isCrossSite(await headers())) throw new AuthError("Requests from other sites can't build here.", 403);
    return user;
  }
  if (!user.isAdmin) return user;
  return { ...user, isAdmin: isAdminNow(user, await loadUser(user.id), env.adminEmails) };
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.isAdmin) throw new AuthError("Admins only.", 403);
  return user;
}

/**
 * For scripts such as scripts/rebuild-all.ts: "Authorization: Bearer <AUTOMATION_SECRET>" acts as the first
 * ADMIN_EMAILS user, whose row must exist: they signed in once, or opened a preview once while it had OPEN_ACCESS=admin.
 * Nobody's password is needed or claimed.
 * Only routes that call this accept the secret; everything else still needs a session.
 */
export async function requireAdminOrAutomation(req: Request): Promise<SessionUser> {
  const header = req.headers.get("authorization");
  const secret = env.automationSecret;
  if (!header?.startsWith("Bearer ")) return requireAdmin();
  if (!secret || !safeEqual(header.slice("Bearer ".length), secret)) throw new AuthError("Admins only.", 403);
  const email = env.adminEmails[0];
  const [row] = email ? await db().select().from(schema.users).where(eq(schema.users.email, email)).limit(1) : [];
  if (!row) {
    throw new AuthError(
      "The admin has to sign in once, or open a preview deployment once while it has OPEN_ACCESS=admin (production " +
        "ignores it), before automation can act for them.",
      403,
    );
  }
  return { id: row.id, email: row.email, isAdmin: true };
}

/**
 * Checks the access code and password, creates the user on first sign-in, and sets the session cookie.
 * Returns null when any of them is wrong.
 */
export async function signIn(email: string, code: string, password: string): Promise<SessionUser | null> {
  const user = await checkSignIn({ email, code, password }, dbStore, {
    accessCode: env.accessCode,
    adminAccessCode: env.adminAccessCode,
    adminEmails: env.adminEmails,
  });
  if (!user) return null;
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

/** Looks a user up fresh, for the daily quota and admin checks. Never returns the password hash. */
export async function loadUser(id: string) {
  const [row] = await db()
    .select({
      id: schema.users.id,
      email: schema.users.email,
      isAdmin: schema.users.isAdmin,
      dailyBuildQuota: schema.users.dailyBuildQuota,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);
  return row ?? null;
}
