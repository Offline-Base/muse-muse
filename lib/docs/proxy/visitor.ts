import { createHash, randomBytes } from "node:crypto";
import { cookieValue } from "@/lib/drive/logic";
import { DOCS_VISITOR_COOKIE, DOCS_VISITOR_COOKIE_DAYS } from "@/lib/docs/proxy/policy";

/**
 * The docs visitor: a random id in the mm_docs cookie that names whose files and stored responses are whose, since
 * the docs need no sign-in. Only its SHA-256 is stored (docs_objects.visitor). The id has 128 random bits, so the hash
 * needs no pepper to be safe to keep.
 */

const VISITOR_ID = /^[A-Za-z0-9_-]{22}$/;

export interface DocsVisitor {
  /** The cookie's value. Never stored, never logged. */
  id: string;
  /** What docs_objects keeps. */
  hash: string;
  /** True when this request had no valid cookie, so the reply must set one. */
  isNew: boolean;
}

export function newVisitorId(): string {
  return randomBytes(16).toString("base64url");
}

export function visitorHash(id: string): string {
  return createHash("sha256").update(`docs-visitor:${id}`).digest("hex");
}

/** The visitor this request carries in its cookie, or a new one. */
export function visitorOf(req: Request, makeId: () => string = newVisitorId): DocsVisitor {
  const known = cookieValue(req.headers.get("cookie"), DOCS_VISITOR_COOKIE);
  const id = known && VISITOR_ID.test(known) ? known : makeId();
  return { id, hash: visitorHash(id), isNew: id !== known };
}

/** True when the request reached us over https (Vercel sets x-forwarded-proto), so the cookie gets Secure. */
export function isHttps(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Set-Cookie for the visitor id: httpOnly, SameSite=Lax, 30 days, only sent to /api/docs. */
export function visitorCookie(id: string, secure: boolean): string {
  const maxAge = DOCS_VISITOR_COOKIE_DAYS * 86_400;
  const attributes = `Path=/api/docs; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  return `${DOCS_VISITOR_COOKIE}=${id}; ${attributes}`;
}

/**
 * A safety identifier for this visitor (protocols/responses, "Safety identifiers"), so Meta can act on one docs visitor
 * who misuses a demo instead of on Muse Muse's whole key. A hash, so nothing identifying reaches Meta.
 */
export function safetyIdentifier(visitor: DocsVisitor): string {
  return `docs-${visitor.hash.slice(0, 32)}`;
}
