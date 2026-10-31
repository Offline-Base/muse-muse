// The shell's side of the bridge, with no React Native in it so it can be tested on its own.
//
// What it guarantees:
// - Nothing is answered unless the message came from an allowed origin and carries this page load's nonce. A message
//   from anywhere else is dropped with no reply, since a reply would tell the sender something.
// - Every request that passes those checks gets exactly one reply, even if its handler hangs.
// - A reply is sent only while the page on screen is still on an allowed origin.

import { BRIDGE_METHODS, METHOD_TIMEOUT_MS, MUSE_NATIVE_VERSION } from "./protocol";
import type { BridgeErrorCode, BridgeMethod, BridgeReply, BridgeRequest } from "./protocol";
import { validateParams } from "./validate";

/** A failure the page is allowed to see. Anything else thrown by a handler becomes a generic message. */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export type BridgeHandler = (params: never) => unknown | Promise<unknown>;
export type BridgeHandlers = Partial<Record<BridgeMethod, BridgeHandler>>;

export interface RateLimit {
  max: number;
  perMs: number;
}

/** Stops a page from filling the screen with notifications or share sheets. */
export const DEFAULT_RATE_LIMITS: Partial<Record<BridgeMethod, RateLimit>> = {
  notify: { max: 6, perMs: 60_000 },
  share: { max: 10, perMs: 60_000 },
  takePhoto: { max: 10, perMs: 60_000 },
  haptic: { max: 60, perMs: 60_000 },
};

export interface RouterOptions {
  handlers: BridgeHandlers;
  nonce: string;
  isAllowedOrigin(origin: string): boolean;
  /** The URL of the page on screen right now, checked again just before each reply. */
  currentUrl(): string | null;
  send(reply: BridgeReply): void;
  timeouts?: Partial<Record<BridgeMethod, number>>;
  limits?: Partial<Record<BridgeMethod, RateLimit>>;
  maxInFlight?: number;
  now?(): number;
}

export type ReceiveOutcome =
  | { status: "dropped"; reason: "origin" | "too_large" | "malformed" | "nonce" | "duplicate" | "disposed" }
  | { status: "replied"; ok: boolean; code?: BridgeErrorCode }
  | { status: "unsent"; reason: "origin" | "disposed" };

export interface BridgeRouter {
  receive(raw: string, sourceUrl: string): Promise<ReceiveOutcome>;
  inFlight(): number;
  /** Call when the page goes away. Waiting handlers can finish, but they no longer reply. */
  dispose(): void;
}

const MAX_MESSAGE_CHARS = 256_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The origin of an http or https URL, or null for anything else (about:blank, file:, data: and the like). */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Compares every character, so timing can't reveal the nonce one character at a time. */
function sameNonce(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseRequest(raw: string): Partial<BridgeRequest> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Partial<BridgeRequest>)
      : null;
  } catch {
    return null;
  }
}

export function createRouter(options: RouterOptions): BridgeRouter {
  const { handlers, nonce, isAllowedOrigin, currentUrl, send } = options;
  const limits = options.limits ?? DEFAULT_RATE_LIMITS;
  const maxInFlight = options.maxInFlight ?? 16;
  const now = options.now ?? Date.now;
  const waiting = new Set<string>();
  const callTimes = new Map<BridgeMethod, number[]>();
  let disposed = false;

  function isLimited(method: BridgeMethod): boolean {
    const limit = limits[method];
    if (!limit) return false;
    const cutoff = now() - limit.perMs;
    const recent = (callTimes.get(method) ?? []).filter((t) => t > cutoff);
    const limited = recent.length >= limit.max;
    if (!limited) recent.push(now());
    callTimes.set(method, recent);
    return limited;
  }

  function deliver(reply: BridgeReply): ReceiveOutcome {
    if (disposed) return { status: "unsent", reason: "disposed" };
    const origin = originOf(currentUrl());
    if (!origin || !isAllowedOrigin(origin)) return { status: "unsent", reason: "origin" };
    send(reply);
    return reply.ok ? { status: "replied", ok: true } : { status: "replied", ok: false, code: reply.error.code };
  }

  function fail(id: string, code: BridgeErrorCode, message: string): ReceiveOutcome {
    return deliver({ v: MUSE_NATIVE_VERSION, id, ok: false, error: { code, message } });
  }

  async function run(id: string, method: BridgeMethod, handler: BridgeHandler, params: unknown) {
    const limitMs = options.timeouts?.[method] ?? METHOD_TIMEOUT_MS[method];
    waiting.add(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BridgeError("timeout", "That took too long. Please try again.")), limitMs);
      });
      const result = await Promise.race([Promise.resolve().then(() => handler(params as never)), expired]);
      return deliver({ v: MUSE_NATIVE_VERSION, id, ok: true, result: result ?? null });
    } catch (error) {
      if (error instanceof BridgeError) return fail(id, error.code, error.message);
      return fail(id, "failed", "Something went wrong on this device.");
    } finally {
      if (timer) clearTimeout(timer);
      waiting.delete(id);
    }
  }

  return {
    inFlight: () => waiting.size,

    dispose() {
      disposed = true;
    },

    async receive(raw, sourceUrl) {
      if (disposed) return { status: "dropped", reason: "disposed" };
      const origin = originOf(sourceUrl);
      if (!origin || !isAllowedOrigin(origin)) return { status: "dropped", reason: "origin" };
      if (raw.length > MAX_MESSAGE_CHARS) return { status: "dropped", reason: "too_large" };

      const request = parseRequest(raw);
      if (!request || request.v !== MUSE_NATIVE_VERSION) return { status: "dropped", reason: "malformed" };
      if (typeof request.id !== "string" || !ID_PATTERN.test(request.id)) {
        return { status: "dropped", reason: "malformed" };
      }
      if (typeof request.nonce !== "string" || !sameNonce(request.nonce, nonce)) {
        return { status: "dropped", reason: "nonce" };
      }
      // A second reply with the same id would settle the wrong promise on the page.
      if (waiting.has(request.id)) return { status: "dropped", reason: "duplicate" };

      const { id, method } = request;
      if (typeof method !== "string" || !BRIDGE_METHODS.includes(method as BridgeMethod)) {
        return fail(id, "unsupported", "This app can't do that.");
      }
      const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined;
      if (!handler) return fail(id, "unsupported", "This app can't do that.");
      if (waiting.size >= maxInFlight) return fail(id, "busy", "Too much is happening. Please try again.");
      if (isLimited(method)) return fail(id, "rate_limited", "That was too many times. Please wait a minute.");

      const check = validateParams(method, request.params);
      if (!check.ok) return fail(id, "bad_request", check.message);

      return run(id, method, handler, check.params);
    },
  };
}
