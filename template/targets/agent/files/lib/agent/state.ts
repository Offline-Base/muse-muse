import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Seals what a run needs to go on later, so it can wait in the browser for a confirmation, a connection or Keep going.
 * The key comes from this product's token, so a browser can't change the state or swap in another product's response
 * id, which covers for the gateway not checking who owns a previous_response_id. AES-GCM signs it and also hides it:
 * the state holds tool results the page never shows.
 */

const PREFIX = "rs1";
/** How long a sealed state lasts. */
export const STATE_TTL_MS = 60 * 60 * 1000;
/** Far bigger than a real state. Anything longer is refused before it's decrypted. */
const MAX_SEALED_CHARS = 512 * 1024;

export class AgentStateError extends Error {
  constructor(
    readonly code: "invalid" | "expired",
    message: string,
  ) {
    super(message);
    this.name = "AgentStateError";
  }
}

function stateKey(): Buffer {
  const token = process.env.PRODUCT_TOKEN;
  if (!token) throw new Error("Missing PRODUCT_TOKEN on the server. The Muse Muse platform sets it when it deploys the product.");
  return createHash("sha256").update(`musemuse-run-state:${token}`).digest();
}

/** `scope` ties the state to one route's tools and to who ran it, so it can't go on under other tools or without the owner. */
export function sealState(state: unknown, opts: { scope: string; now?: number }): string {
  const now = opts.now ?? Date.now();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", stateKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ exp: now + STATE_TTL_MS, scope: opts.scope, state }), "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

/** sealState, or undefined when the result is too big for openState to take back: a photo in a run's first turn can do it. */
export function sealToResume(state: unknown, opts: { scope: string; now?: number }): string | undefined {
  const sealed = sealState(state, opts);
  return sealed.length <= MAX_SEALED_CHARS ? sealed : undefined;
}

/** The state, or AgentStateError when it isn't one this product sealed for this scope, or it's over an hour old. */
export function openState<T>(sealed: unknown, opts: { scope: string; now?: number }): T {
  const invalid = () => new AgentStateError("invalid", "This run can't be picked up. Start it again.");
  if (typeof sealed !== "string" || sealed.length > MAX_SEALED_CHARS) throw invalid();
  const [prefix, iv, body, tag, extra] = sealed.split(".");
  if (prefix !== PREFIX || !iv || !body || !tag || extra !== undefined) throw invalid();
  let payload: { exp?: unknown; scope?: unknown; state?: unknown };
  try {
    const decipher = createDecipheriv("aes-256-gcm", stateKey(), Buffer.from(iv, "base64url"), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8"));
  } catch {
    throw invalid();
  }
  if (payload.scope !== opts.scope) throw invalid();
  if (typeof payload.exp !== "number" || payload.exp <= (opts.now ?? Date.now())) {
    throw new AgentStateError("expired", "This run waited too long to be picked up. Start it again.");
  }
  return payload.state as T;
}
