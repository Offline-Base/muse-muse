import { LIVE_LIMITS } from "@/lib/caps/live/limits";
import { DATA_SCOPES, type DataScope } from "@/lib/caps/data/types";
import { mac, sameMac } from "@/lib/tools/sign";

/**
 * An `lt1` read ticket (docs/CAPABILITIES.md, section 13): lets a browser read one collection, in one scope, of one
 * caller, for 10 minutes. An EventSource can't send a header, so it travels in the stream's address, and the product's
 * token never reaches the browser. It names rows and nothing else: it can't write, and its holder could read those rows
 * anyway through the product. `lt1.<product>.<namespace>.<collection>.<scope>.<ownerKey or ->.<exp>.<sig>`, with the
 * namespace in base64url since b:<buildId> has a colon.
 */
export interface LiveTicket {
  productId: string;
  namespace: string;
  collection: string;
  scope: DataScope;
  /** The rows' owner_key: a subject key, never a raw id. Null for shared rows. */
  ownerKey: string | null;
  exp: Date;
}

const FIELD = /^[A-Za-z0-9_-]+$/;
const LABEL = "live-ticket";

export function mintLiveTicket(ticket: Omit<LiveTicket, "exp">, now: Date): { ticket: string; expiresAt: Date } {
  const exp = new Date(now.getTime() + LIVE_LIMITS.ticketValidMs);
  const fields = [ticket.productId, Buffer.from(ticket.namespace, "utf8").toString("base64url"), ticket.collection, ticket.scope, ticket.ownerKey ?? "-", String(exp.getTime())];
  return { ticket: ["lt1", ...fields, mac(LABEL, fields)].join("."), expiresAt: exp };
}

/** The ticket when its signature is good and it hasn't expired, else null. */
export function readLiveTicket(raw: unknown, now: Date): LiveTicket | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  const parts = raw.split(".");
  if (parts.length !== 8 || parts[0] !== "lt1") return null;
  const fields = parts.slice(1, -1);
  if (!fields.every((f) => FIELD.test(f))) return null;
  if (!sameMac(parts[7]!, mac(LABEL, fields))) return null;
  const [productId, namespace, collection, scope, ownerKey, exp] = fields as [string, string, string, string, string, string];
  const ms = Number(exp);
  if (!Number.isFinite(ms) || ms <= now.getTime() || !(DATA_SCOPES as readonly string[]).includes(scope)) return null;
  return { productId, namespace: Buffer.from(namespace, "base64url").toString("utf8"), collection, scope: scope as DataScope, ownerKey: ownerKey === "-" ? null : ownerKey, exp: new Date(ms) };
}
