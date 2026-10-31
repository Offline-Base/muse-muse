import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TOOL_LIMITS } from "@/lib/tools/policy";
import { toolKey } from "@/lib/tools/keys";

/**
 * What the tool gateway signs: approvals here, and owner codes and sessions in lib/tools/principal.ts. Each use has its
 * own key from toolKey, so a token made for one can never pass as another.
 */

/** base64url HMAC of the parts. JSON keeps ["a", "bc"] and ["ab", "c"] apart. */
export function mac(label: string, parts: readonly string[]): string {
  return createHmac("sha256", toolKey(label)).update(JSON.stringify(parts)).digest("base64url");
}

export function sameMac(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function randomId(): string {
  return randomBytes(16).toString("base64url");
}

/** JSON with sorted keys at every depth, so two orderings of the same arguments are the same arguments. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function argumentsHash(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

export interface ApprovalScope {
  productId: string;
  /** Who it was asked of: the owner's subject, or "build". Another person's approval is no approval. */
  subject: string;
  slug: string;
  args: unknown;
}

const approvalParts = (s: ApprovalScope, nonce: string, exp: string) => [s.productId, s.subject, s.slug, argumentsHash(s.args), nonce, exp];

/** `ap1.<nonce>.<exp>.<sig>`, good for 10 minutes for these exact arguments, and used once (the nonce). */
export function mintApproval(scope: ApprovalScope, now: Date): string {
  const nonce = randomId();
  const exp = String(now.getTime() + TOOL_LIMITS.approvalValidMs);
  return `ap1.${nonce}.${exp}.${mac("approvals", approvalParts(scope, nonce, exp))}`;
}

/** The approval's nonce and expiry when it is good for this call, else null. Changed arguments fail here. */
export function checkApproval(id: string, scope: ApprovalScope, now: Date): { nonce: string; exp: Date } | null {
  const parts = id.split(".");
  if (parts.length !== 4 || parts[0] !== "ap1") return null;
  const [, nonce, exp, sig] = parts;
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs <= now.getTime()) return null;
  if (!sameMac(sig, mac("approvals", approvalParts(scope, nonce, exp)))) return null;
  return { nonce, exp: new Date(expMs) };
}

/** What the signed connect state says. Only the callback reads it, since the browser arrives with no product token. */
export interface ConnectState {
  productId: string;
  composioUserId: string;
  toolkit: string;
  requestId: string;
  returnTo: string;
  exp: number;
}

/** `cs1.<base64url JSON>.<sig>`. The JSON carries only ids and a path, and the browser sees it anyway. */
export function mintConnectState(state: Omit<ConnectState, "requestId" | "exp">, now: Date): string {
  const body = Buffer.from(
    JSON.stringify({ ...state, requestId: randomId(), exp: now.getTime() + TOOL_LIMITS.connectStateValidMs } satisfies ConnectState),
  ).toString("base64url");
  return `cs1.${body}.${mac("connect-state", [body])}`;
}

export function readConnectState(token: string, now: Date): ConnectState | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "cs1") return null;
  const [, body, sig] = parts;
  if (!sameMac(sig, mac("connect-state", [body]))) return null;
  let state: ConnectState;
  try {
    state = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ConnectState;
  } catch {
    return null;
  }
  return typeof state.exp === "number" && state.exp > now.getTime() ? state : null;
}
