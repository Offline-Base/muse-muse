// Platform file (Muse Muse platform services). Don't edit: fetch-public.ts, secrets.ts and send.ts use it.
//
// The one way this product talks to the gateway's outside services. Server code only: GATEWAY_URL and PRODUCT_TOKEN
// exist on the server, and the browser never calls the gateway. Every call forwards who is asking (the visitor's
// cookie id, the owner's session, the client's IP), so the gateway can decide.
import { clientIpHeaders, type RequestLike } from "@/lib/meta/client";
import { OWNER_HEADER, VISITOR_HEADER, ownerSession, visitorId } from "@/lib/platform/identity";

/** What every connect helper throws: a code, an HTTP status the route can answer with, and a plain message. */
export class CapError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "CapError";
    this.code = code;
    this.status = status;
  }
}

function settings(): { base: string; token: string } {
  const base = process.env.GATEWAY_URL?.replace(/\/+$/, "");
  const token = process.env.PRODUCT_TOKEN;
  if (!base || !token) throw new CapError("not_configured", 500, "Outside services aren't set up on this server. The Muse Muse platform sets them when it deploys the product.");
  return { base, token };
}

/** One gateway call. A refusal becomes a CapError with the gateway's own plain message. */
export async function gatewayCall<T>(from: RequestLike | null | undefined, method: string, path: string, body?: unknown): Promise<T> {
  const { base, token } = settings();
  const visitor = visitorId(from);
  const owner = ownerSession(from);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...clientIpHeaders(from),
      ...(visitor ? { [VISITOR_HEADER]: visitor } : {}),
      ...(owner ? { [OWNER_HEADER]: owner } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new CapError("unreachable", 502, "That service is unreachable right now. Try again in a minute.");
  });
  const reply = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
  if (res.status === 404 && reply?.error?.code === "unknown_endpoint") throw new CapError("switched_off", 404, "This part of the product is switched off on Muse Muse right now.");
  if (!res.ok) throw new CapError(reply?.error?.code ?? "cap_failed", res.status, reply?.error?.message ?? "That didn't work this time. Try again.");
  return reply as T;
}
