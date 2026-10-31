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
  const missing = (["GATEWAY_URL", "PRODUCT_TOKEN"] as const).filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(" and ")} on the server. The Muse Muse platform sets both when it deploys the product.`);
  }
  const base = new URL(process.env.GATEWAY_URL as string);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/v1`;
  return { baseURL: base.href, apiKey: process.env.PRODUCT_TOKEN as string };
}

/**
 * OpenAI SDK client pointed at the Muse Muse gateway.
 *
 * The gateway mirrors the Meta Model API paths (https://api.meta.ai/v1) and adds the real key on the server,
 * so product code never holds a Meta key. Server code only: GATEWAY_URL and PRODUCT_TOKEN don't exist in the browser.
 *
 * Always pass the incoming request (or `await headers()` in a server action) so every call carries the visitor's IP.
 *
 * On a test build that calls Meta directly (TEST_MODEL set, see testModelFor), every request that names Muse Wonder
 * goes out naming Spark 1.3 Contributor instead. Product code never sees or chooses that.
 */
export function metaClient(request?: RequestLike | null): OpenAI {
  return new OpenAI({
    ...gatewayEnv(),
    defaultHeaders: clientIpHeaders(request),
    ...(isTestBuild() ? { fetch: testModelFetch } : {}),
  });
}

/** The only model TEST_MODEL may name. */
export const TEST_MODEL = "muse-spark-1.3-contributor";

/** The model a test build swaps for TEST_MODEL: Muse Wonder, the model for a product's own calls. */
const WONDER = "muse-wonder-1.0";

/**
 * True on a test build whose calls go straight to Meta. There the Muse Muse platform writes
 * TEST_MODEL=muse-spark-1.3-contributor into .env.local, since those calls skip the gateway and its swap. Any other value
 * is ignored. A live product never has it, since .env files are never deployed.
 */
function isTestBuild(): boolean {
  return process.env.TEST_MODEL?.trim() === TEST_MODEL;
}

/** The model a call runs on: `model`, except Muse Wonder runs on Spark 1.3 Contributor on a test build. */
export function testModelFor(model: string): string {
  return model === WONDER && isTestBuild() ? TEST_MODEL : model;
}

/**
 * fetch for a test build's client. A JSON body whose `model` is exactly Muse Wonder goes out naming TEST_MODEL, on any
 * endpoint, streaming or not. Every other request, and every other byte of that one, goes out as it came.
 */
const testModelFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => fetch(input, swapModel(init));

function swapModel(init: RequestInit | undefined): RequestInit | undefined {
  const body = init?.body;
  if (typeof body !== "string" || !body.includes(WONDER)) return init;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return init;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return init;
  const json = parsed as Record<string, unknown>;
  if (json.model !== WONDER) return init;
  const headers = new Headers(init?.headers);
  headers.delete("content-length");
  return { ...init, headers, body: JSON.stringify({ ...json, model: TEST_MODEL }) };
}
