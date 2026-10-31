import { createHmac } from "node:crypto";
import { CLIENT_IP_HEADER, OWNER_HEADER, VISITOR_HEADER } from "@/lib/gateway/policy";
import { clientIpKey } from "@/lib/gateway/extract";
import type { CatalogTool } from "@/lib/tools/composio/sync";
import { toolKey } from "@/lib/tools/keys";
import { TOOL_LIMITS } from "@/lib/tools/policy";
import { mac, randomId, sameMac } from "@/lib/tools/sign";
import type { ToolPrincipal } from "@/lib/tools/ids";

/**
 * Who is asking (docs/AGENT_TOOLS.md). Products have no sign-in yet, so anyone reaching a product is a visitor, and only
 * a pass the platform signed makes someone the owner. A cookie alone is never enough for somebody's Gmail.
 */

export interface Principal {
  kind: ToolPrincipal;
  /** Stable id of the person behind a personal connection. Null for anyone who has none. */
  subject: string | null;
}

/** A session that doesn't verify just leaves the caller as a visitor: it may still use the public tools. */
export function resolvePrincipal(req: Request, token: { productId: string; scope: string }, now: Date): Principal {
  if (token.scope === "build") return { kind: "build", subject: "build" };
  const session = readOwnerSession(req.headers.get(OWNER_HEADER)?.trim() ?? "", token.productId, now);
  if (session) return { kind: "owner", subject: session.subject };
  return { kind: req.headers.get(VISITOR_HEADER)?.trim() ? "visitor" : "product", subject: null };
}

/** The tiers a principal reaches. `user` isn't resolved until platform sign-in exists. */
export function tierAllowed(principal: Principal, tool: Pick<CatalogTool, "tier">): boolean {
  if (tool.tier === "public") return true;
  return principal.kind === "build" || principal.kind === "owner" || principal.kind === "user";
}

/** Rate limit keys for the person behind the call, hashed so a raw visitor id is never stored. */
export function visitorKeys(req: Request, productId: string): string[] {
  const keys: string[] = [];
  const ip = clientIpKey(req.headers.get(CLIENT_IP_HEADER));
  if (ip) keys.push(`tools-ip:${productId}:${ip}`);
  const visitor = req.headers.get(VISITOR_HEADER)?.trim().slice(0, 128);
  if (visitor) keys.push(`tools-visitor:${productId}:${mac("visitor-limits", [visitor]).slice(0, 32)}`);
  return keys;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase and unpadded. */
function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return bits ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

/** p: a product's public tools. o: an owner's accounts. The product is in the HMAC, so no id is shared across products. */
export type ComposioUserKind = "p" | "o";

export function composioUserId(kind: ComposioUserKind, productId: string, subject: string): string {
  const digest = createHmac("sha256", toolKey("composio-users")).update(`${kind}:${productId}:${subject}`).digest();
  return `mm${kind}_${base32(digest).slice(0, 32)}`;
}

/** The id everyone on a product's public tools shares: one session per product. */
export const productComposioUserId = (productId: string) => composioUserId("p", productId, "product");

/**
 * The subject of a pass: whoever asked for it, not the product's owner. An admin may act as owner on a product, and this
 * gives them their own connection there rather than the owner's mail.
 */
export function ownerSubject(userId: string): string {
  return mac("owner-subject", [userId]).slice(0, 32);
}

const SAFE_FIELD = /^[A-Za-z0-9_-]+$/;

function mintDotted(prefix: string, label: string, fields: string[]): string {
  return [prefix, ...fields, mac(label, fields)].join(".");
}

function readDotted(token: string, prefix: string, label: string, count: number): string[] | null {
  const parts = token.split(".");
  if (parts.length !== count + 2 || parts[0] !== prefix) return null;
  const fields = parts.slice(1, -1);
  if (!fields.every((f) => SAFE_FIELD.test(f))) return null;
  return sameMac(parts[parts.length - 1], mac(label, fields)) ? fields : null;
}

/** `oc1.<productId>.<subject>.<nonce>.<exp>.<sig>`: 5 minutes, and the exchange spends the nonce. */
export function mintOwnerCode(o: { productId: string; subject: string }, now: Date): string {
  return mintDotted("oc1", "owner-code", [o.productId, o.subject, randomId(), String(now.getTime() + TOOL_LIMITS.ownerCodeValidMs)]);
}

export function readOwnerCode(code: string, now: Date): { productId: string; subject: string; nonce: string; exp: Date } | null {
  const fields = readDotted(code, "oc1", "owner-code", 4);
  if (!fields) return null;
  const [productId, subject, nonce, exp] = fields;
  const expMs = Number(exp);
  return Number.isFinite(expMs) && expMs > now.getTime() ? { productId, subject, nonce, exp: new Date(expMs) } : null;
}

/** `os1.<productId>.<subject>.<exp>.<sig>`: what the product keeps in its HttpOnly mm_owner cookie for 12 hours. */
export function mintOwnerSession(o: { productId: string; subject: string }, now: Date): { session: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + TOOL_LIMITS.ownerSessionValidMs);
  return { session: mintDotted("os1", "owner-session", [o.productId, o.subject, String(expiresAt.getTime())]), expiresAt };
}

/** Null when forged, expired, or made for another product. */
export function readOwnerSession(session: string, productId: string, now: Date): { subject: string; expiresAt: Date } | null {
  const fields = readDotted(session, "os1", "owner-session", 3);
  if (!fields) return null;
  const [sessionProduct, subject, exp] = fields;
  const expMs = Number(exp);
  if (sessionProduct !== productId || !Number.isFinite(expMs) || expMs <= now.getTime()) return null;
  return { subject, expiresAt: new Date(expMs) };
}

/** A path on the product's own site to come back to, or null. Anything that could leave the site is refused. */
export function safeReturnPath(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "/";
  if (typeof value !== "string" || value.length > 512) return null;
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\s\p{Cc}]/u.test(value)) return null;
  try {
    // Anything a browser would read as another origin fails this.
    const parsed = new URL(value, "https://product.invalid");
    return parsed.origin === "https://product.invalid" ? value : null;
  } catch {
    return null;
  }
}
