import { readTestUserSession, readUserSession } from "@/lib/caps/data/identity";
import { clientIpKey } from "@/lib/gateway/extract";
import { CLIENT_IP_HEADER, OWNER_HEADER, VISITOR_HEADER } from "@/lib/gateway/policy";
import { resolvePrincipal } from "@/lib/tools/principal";
import { mac } from "@/lib/tools/sign";

/**
 * Who is asking a cap route (docs/CAPABILITIES.md, 2.2). It wraps the tool gateway's resolvePrincipal (build, product,
 * visitor, owner) and adds `user`, a person who signed in with a passkey (unit 3), and `job` (unit 6, in its marked
 * block). Only the platform's signatures make someone strong; a visitor id is a cookie, which is enough to keep one
 * browser's rows apart and never enough for anything else.
 *
 * Unlike a tool call, a build's call can carry the others too: its tests use a visitor cookie and sign in made-up users,
 * so a second browser can be told apart from the first. A build stands in for the owner (it has none) only when the call
 * names no one else (seed, the build's own server calls), or when it sends BUILD_TEST_OWNER as its owner pass
 * (tests/caps/data.ts openAsOwner). A browser with a visitor id or a made-up person is that person, as on the live
 * product, so a shared collection's write rule is tested in the build too.
 */

export const USER_HEADER = "x-musemuse-user";
export const JOB_HEADER = "x-musemuse-job";

/**
 * The owner pass a build's tests send to act as the owner (openAsOwner sets it as the product's mm_owner cookie). Only a
 * build token reads it; on a live token it is no pass at all, since only the platform's signature makes an owner.
 */
export const BUILD_TEST_OWNER = "ot1.build-test-owner";

export type CapPrincipalKind = "build" | "product" | "visitor" | "owner" | "user" | "job";

export interface CapCaller {
  /** The strongest claim: build, then job, owner, user, visitor, product. */
  kind: CapPrincipalKind;
  /** The owner pass's subject when it verifies, or "build" for a build's call that names no one else (or BUILD_TEST_OWNER). */
  owner: string | null;
  /** A signed-in person's pairwise subject, when their session verifies (a made-up user's, in a build). */
  user: string | null;
  /** The visitor id the product forwarded (mm_vid). Weak: one browser. Only ever used through subjectKey. */
  visitor: string | null;
  /** Unit 6: the job run, when a job token verifies. */
  job: string | null;
  /** The end user's IP as a rate-limit key, never auth. */
  ip: string | null;
}

export interface CapTokenLike {
  productId: string;
  scope: string;
  buildId?: string | null;
}

const VISITOR_ID = /^[A-Za-z0-9_-]{16,128}$/;

/** Resolves every claim a cap call makes. A session that doesn't verify just isn't there. */
export function resolveCapCaller(req: Request, token: CapTokenLike, now: Date): CapCaller {
  const base = resolvePrincipal(req, token, now);
  const build = token.scope === "build";
  const rawVisitor = req.headers.get(VISITOR_HEADER)?.trim() ?? "";
  const visitor = VISITOR_ID.test(rawVisitor) ? rawVisitor : null;
  const userHeader = req.headers.get(USER_HEADER)?.trim() ?? "";
  let user: string | null = null;
  if (userHeader) {
    const session = build
      ? token.buildId
        ? readTestUserSession(userHeader, token.productId, token.buildId, now)
        : null
      : readUserSession(userHeader, token.productId, now);
    user = session?.subject ?? null;
  }
  const testOwner = build && req.headers.get(OWNER_HEADER)?.trim() === BUILD_TEST_OWNER;
  const owner = build ? (testOwner || (!rawVisitor && !userHeader) ? "build" : null) : base.kind === "owner" ? base.subject : null;
  // ---------- Wave 3, unit 6: jobs. A job token (x-musemuse-job) resolves here ----------
  const job: string | null = null;
  // ---------- end Wave 3, unit 6 ----------
  const kind: CapPrincipalKind = build ? "build" : job ? "job" : owner ? "owner" : user ? "user" : visitor ? "visitor" : "product";
  return { kind, owner, user, visitor, job, ip: clientIpKey(req.headers.get(CLIENT_IP_HEADER)) };
}

/** The headers a caller's claims came in, for tests and docs. */
export const CAP_IDENTITY_HEADERS = [VISITOR_HEADER, OWNER_HEADER, USER_HEADER, JOB_HEADER, CLIENT_IP_HEADER] as const;

export type SubjectKind = "visitor" | "owner" | "user" | "job";

/**
 * The key rows and files are stored under (2.2): mac("caps-subject", [kind, productId, subject]) cut to 32 characters,
 * never a raw id. The product is in it, so the same visitor id on two products gives two keys.
 */
export function subjectKey(kind: SubjectKind, productId: string, subject: string): string {
  return mac("caps-subject", [kind, productId, subject]).slice(0, 32);
}
