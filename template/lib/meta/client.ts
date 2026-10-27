import OpenAI from "openai";

/** Carries the end user's IP to the gateway, which rate limits each visitor so one person can't spend the day's budget. */
export const CLIENT_IP_HEADER = "x-musemuse-client-ip";

interface HeaderReader {
  get(name: string): string | null;
}

/** A route handler's `request`, or `await headers()` from next/headers in a server action. */
export type RequestLike = { headers: HeaderReader } | HeaderReader;

/**
 * The visitor's IP from the incoming request: the first x-forwarded-for entry, else x-real-ip (Vercel sets both).
 * Undefined for loopback addresses, which are tests and scripts on the same machine, not visitors.
 */
export function clientIp(from?: RequestLike | null): string | undefined {
  if (!from) return undefined;
  // Check for get() first: Next's headers() object also has a private `headers` field.
  const headers = "get" in from && typeof from.get === "function" ? from : (from as { headers: HeaderReader }).headers;
  const raw = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim();
  const ip = raw?.slice(0, 64).replace(/[^0-9a-fA-F:.]/g, "");
  if (!ip || ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.")) return undefined;
  return ip;
}

/** `{ "x-musemuse-client-ip": ip }` for a gateway call, or `{}` when the request has no visitor IP. */
export function clientIpHeaders(from?: RequestLike | null): Record<string, string> {
  const ip = clientIp(from);
  return ip ? { [CLIENT_IP_HEADER]: ip } : {};
}

/**
 * The gateway's /v1 base URL and this product's token. The platform writes GATEWAY_URL and PRODUCT_TOKEN into the
 * product's env; they exist on the server only. Throws when either is missing.
 */
export function gatewayEnv(): { baseURL: string; apiKey: string } {
  const { GATEWAY_URL: url, PRODUCT_TOKEN: token } = process.env;
  if (url && token) return { baseURL: new URL("v1", url.endsWith("/") ? url : `${url}/`).href, apiKey: token };
  throw new Error("GATEWAY_URL and PRODUCT_TOKEN aren't set. The Muse Muse platform writes both into the server env.");
}

/**
 * OpenAI SDK client pointed at the Muse Muse gateway.
 *
 * The gateway mirrors the Meta Model API paths (https://api.meta.ai/v1) and adds the real key on the server,
 * so product code never holds a Meta key. Server code only: GATEWAY_URL and PRODUCT_TOKEN don't exist in the browser.
 *
 * Always pass the incoming request (or `await headers()` in a server action) so every call carries the visitor's IP.
 */
export function metaClient(request?: RequestLike | null): OpenAI {
  return new OpenAI({ ...gatewayEnv(), defaultHeaders: clientIpHeaders(request) });
}
