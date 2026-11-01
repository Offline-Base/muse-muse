import { createHmac } from "node:crypto";

/**
 * A Muse Code session's own gateway token (docs/CAPABILITIES.md, 15b). The agent's shell inside the session can read
 * it (the spike: shell env and /proc), so it is scoped to its one session: scope `code_session`, POST /v1/responses only,
 * its one model, its session's budget, and dead at stop or at the session's limit (a gateway_tokens row with
 * expires_at, revoked at stop).
 *
 * It is derived from the session id and GATEWAY_TOKEN_PEPPER, so it is never stored: the platform remakes it in memory
 * when it needs to scan what the session showed for it (lib/caps/code/musecode/redact.ts). Only its hash is stored, as
 * for every gateway token.
 */
export const CODE_SESSION_SCOPE = "code_session";

const PREFIX = "mm_cs_";
const SHAPE = /^mm_cs_[A-Za-z0-9_-]{43}$/;

export function sessionTokenFor(sessionId: string, pepper: string): string {
  if (!pepper) throw new Error("GATEWAY_TOKEN_PEPPER is not set, so no session token can be made.");
  return `${PREFIX}${createHmac("sha256", pepper).update(`musemuse-code-session:${sessionId}`).digest("base64url")}`;
}

/** True for a string shaped like a session token. Says nothing about whether it is live. */
export function isSessionToken(raw: string): boolean {
  return SHAPE.test(raw);
}
