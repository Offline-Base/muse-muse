import { DATA_LIMITS } from "@/lib/caps/data/limits";
import { mac, randomId, sameMac } from "@/lib/tools/sign";

/**
 * End users of products (docs/CAPABILITIES.md, 2.2 and section 9): the sign-in code the platform sends back to a
 * product after a passkey, the 30-day session the product keeps, and the made-up users a build's tests sign in. Each
 * has its own signing label (toolKey), so one can never pass as another, or as an owner pass.
 *
 * A user's subject is pairwise: mac("end-user", [endUserId, productId]) cut to 32, so no two products can match the same
 * person, and no product ever sees the end user's own id.
 */

const SAFE_FIELD = /^[A-Za-z0-9_-]+$/;

function mintDotted(prefix: string, label: string, fields: string[]): string {
  return [prefix, ...fields, mac(label, fields)].join(".");
}

function readDotted(token: string, prefix: string, label: string, count: number): string[] | null {
  if (typeof token !== "string" || token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== count + 2 || parts[0] !== prefix) return null;
  const fields = parts.slice(1, -1);
  if (!fields.every((f) => SAFE_FIELD.test(f))) return null;
  return sameMac(parts[parts.length - 1]!, mac(label, fields)) ? fields : null;
}

const notExpired = (exp: string, now: Date) => {
  const ms = Number(exp);
  return Number.isFinite(ms) && ms > now.getTime() ? new Date(ms) : null;
};

/** The subject a product knows a person by. */
export function endUserSubject(endUserId: string, productId: string): string {
  return mac("end-user", [endUserId, productId]).slice(0, 32);
}

/** What the person typed as their name, cleaned: one line, no control characters, at most 40 characters. */
export function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, DATA_LIMITS.displayNameMax).trim();
  return name || null;
}

const nameField = (name: string) => Buffer.from(name, "utf8").toString("base64url") || "-";
const readName = (field: string) => (field === "-" ? "" : (cleanDisplayName(Buffer.from(field, "base64url").toString("utf8")) ?? ""));

/**
 * `uc1.<product>.<subject>.<name>.<nonce>.<exp>.<sig>`: what the platform sends to the product's live origin after a
 * passkey, good for 5 minutes and spent once (the nonce). The name is base64url, since the product gets it anyway.
 */
export function mintUserCode(o: { productId: string; subject: string; name: string }, now: Date): string {
  return mintDotted("uc1", "user-code", [o.productId, o.subject, nameField(o.name), randomId(), String(now.getTime() + DATA_LIMITS.signInCodeValidMs)]);
}

export function readUserCode(code: string, now: Date): { productId: string; subject: string; name: string; nonce: string; exp: Date } | null {
  const fields = readDotted(code, "uc1", "user-code", 5);
  if (!fields) return null;
  const [productId, subject, name, nonce, exp] = fields as [string, string, string, string, string];
  const at = notExpired(exp, now);
  return at ? { productId, subject, name: readName(name), nonce, exp: at } : null;
}

/** `us1.<product>.<subject>.<exp>.<sig>`: what the product keeps in its HttpOnly mm_user cookie for 30 days. */
export function mintUserSession(o: { productId: string; subject: string }, now: Date): { session: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + DATA_LIMITS.userSessionValidMs);
  return { session: mintDotted("us1", "user-session", [o.productId, o.subject, String(expiresAt.getTime())]), expiresAt };
}

/** Null when forged, expired, or made for another product. */
export function readUserSession(session: string, productId: string, now: Date): { subject: string; expiresAt: Date } | null {
  const fields = readDotted(session, "us1", "user-session", 3);
  if (!fields) return null;
  const [owner, subject, exp] = fields as [string, string, string];
  const at = notExpired(exp, now);
  return owner === productId && at ? { subject, expiresAt: at } : null;
}

/** The subject of a made-up user in one build: the same name in the same build is the same person. */
export function testUserSubject(buildId: string, name: string): string {
  return mac("end-user-test", [buildId, name.toLowerCase()]).slice(0, 32);
}

/**
 * `ut1.<product>.<build>.<subject>.<exp>.<sig>`: a made-up user's session in one build. The gateway takes it only from
 * that build's own token, so it can never reach a product's live rows.
 */
export function mintTestUserSession(o: { productId: string; buildId: string; subject: string }, now: Date): { session: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + DATA_LIMITS.testSessionValidMs);
  return { session: mintDotted("ut1", "user-test-session", [o.productId, o.buildId, o.subject, String(expiresAt.getTime())]), expiresAt };
}

export function readTestUserSession(session: string, productId: string, buildId: string, now: Date): { subject: string; expiresAt: Date } | null {
  const fields = readDotted(session, "ut1", "user-test-session", 4);
  if (!fields) return null;
  const [owner, build, subject, exp] = fields as [string, string, string, string];
  const at = notExpired(exp, now);
  return owner === productId && build === buildId && at ? { subject, expiresAt: at } : null;
}

/**
 * The state a passkey ceremony carries between its options and its verify (`pk1.<kind>.<body>.<sig>`), so the platform
 * keeps no row for it: the challenge, the product, and for a new passkey the end user id and name it will have. Spent
 * once by its challenge.
 */
export interface PasskeyState {
  kind: "register" | "login";
  challenge: string;
  productId: string;
  returnTo: string;
  /** register only. */
  endUserId?: string;
  name?: string;
  exp: number;
}

export function mintPasskeyState(state: Omit<PasskeyState, "exp">, now: Date): string {
  const body = Buffer.from(JSON.stringify({ ...state, exp: now.getTime() + DATA_LIMITS.challengeValidMs })).toString("base64url");
  return `pk1.${state.kind}.${body}.${mac("passkey-state", [state.kind, body])}`;
}

export function readPasskeyState(token: unknown, kind: PasskeyState["kind"], now: Date): PasskeyState | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "pk1" || parts[1] !== kind) return null;
  const [, , body, sig] = parts as [string, string, string, string];
  if (!SAFE_FIELD.test(body) || !sameMac(sig, mac("passkey-state", [kind, body]))) return null;
  try {
    const state = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PasskeyState;
    return state.kind === kind && typeof state.exp === "number" && state.exp > now.getTime() ? state : null;
  } catch {
    return null;
  }
}
