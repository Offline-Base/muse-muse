import { AsrInputError, asrJsonToForm } from "@/lib/gateway/asr";
import { gatewayError } from "@/lib/gateway/errors";
import {
  BadRequestError,
  modelAllowed,
  parseBearer,
  parseEndpoint,
  parseGatewayRequest,
  type ParsedRequest,
} from "@/lib/gateway/extract";
import { meterBody } from "@/lib/gateway/meter";
import { CLIENT_IP_HEADER, DEFAULT_LIMITS, ENDPOINT_MODELS, GATEWAY_ENDPOINTS, UPSTREAM_BASE_URL } from "@/lib/gateway/policy";
import type { GatewayTokenRow } from "@/lib/gateway/tokens";
import type { UsageContext } from "@/lib/usage";
import type { ModelUsage, ProductStatus } from "@/lib/types";

/** The token fields the gateway needs. findToken's row satisfies it. */
export type GatewayToken = Pick<GatewayTokenRow, "id" | "productId" | "scope" | "allowedModels" | "dailyBudgetUsd">;

/** Everything the gateway touches outside the request, injected so tests can run it without a database. */
export interface GatewayDeps {
  findToken(token: string): Promise<GatewayToken | null>;
  productStatus(productId: string): Promise<ProductStatus | null>;
  tokenSpendToday(tokenId: string): Promise<number>;
  platformSpendToday(): Promise<number>;
  dailySpendCapUsd: number;
  /** Increments each key's counter for the window and returns the new counts, keyed like the input. */
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  recordUsage(ctx: UsageContext, items: ModelUsage[]): Promise<void>;
  /** Used for the upstream call and for asr audioUrl downloads. */
  fetch: typeof fetch;
  upstreamKey(): string;
  upstreamBaseUrl?: string;
  /** Public {PLATFORM_URL}/api/gateway, for error messages that point at /uploads. */
  gatewayUrl: string;
  /** Keeps work alive after the response (Next's after()). The promise is already running when it's passed. */
  defer(task: () => Promise<unknown>): void;
  now?(): Date;
}

/** Response headers worth passing back. Encoding and length are dropped because fetch already decoded the body. */
const PASS_HEADERS = ["content-type", "retry-after", "x-request-id", "request-id", "openai-processing-ms"];

function clientIp(req: Request): string | null {
  const raw = req.headers.get(CLIENT_IP_HEADER)?.trim();
  if (!raw) return null;
  return raw.slice(0, 64).replace(/[^0-9a-fA-F:.]/g, "") || null;
}

async function checkRateLimits(
  req: Request,
  token: GatewayToken,
  deps: GatewayDeps,
  now: Date,
): Promise<Response | null> {
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const limits: Record<string, number> = { [`token:${token.id}`]: DEFAULT_LIMITS.perTokenRequestsPerMinute };
  const ip = clientIp(req);
  if (ip) limits[`ip:${token.productId}:${ip}`] = DEFAULT_LIMITS.perIpRequestsPerMinute;
  const counts = await deps.hitRateLimits(Object.keys(limits), windowStart);
  const over = Object.entries(limits).find(([key, limit]) => (counts[key] ?? 0) > limit);
  if (!over) return null;
  const retryAfter = Math.max(1, Math.ceil((windowStart.getTime() + 60_000 - now.getTime()) / 1000));
  const who = over[0].startsWith("ip:") ? "this user" : "this product";
  return gatewayError(
    429,
    "rate_limit_error",
    "rate_limited",
    `Too many requests from ${who}: the limit is ${over[1]} per minute. Try again in ${retryAfter} s.`,
    { headers: { "retry-after": String(retryAfter) } },
  );
}

/**
 * The Meta gateway for products: GATEWAY_CHECKS in lib/gateway/policy.ts, in order. The route stays a thin wrapper.
 */
export async function handleGateway(req: Request, path: readonly string[], deps: GatewayDeps): Promise<Response> {
  try {
    return await handle(req, path, deps);
  } catch (err) {
    console.error("[gateway] unexpected error:", err);
    return gatewayError(500, "server_error", "gateway_error", "The gateway hit an unexpected error. Try again.");
  }
}

async function handle(req: Request, path: readonly string[], deps: GatewayDeps): Promise<Response> {
  const endpoint = parseEndpoint(path);
  if (!endpoint) {
    return gatewayError(
      404,
      "not_found_error",
      "unknown_endpoint",
      `The gateway does not serve /v1/${path.join("/")}. It serves ${GATEWAY_ENDPOINTS.map((e) => `/v1/${e}`).join(", ")}.`,
      { retry: false },
    );
  }
  if (req.method !== "POST") {
    return gatewayError(405, "invalid_request_error", "method_not_allowed", `Use POST for /v1/${endpoint}.`, {
      retry: false,
      headers: { allow: "POST" },
    });
  }

  const bearer = parseBearer(req.headers.get("authorization"));
  const token = bearer ? await deps.findToken(bearer) : null;
  if (!token) {
    return gatewayError(401, "authentication_error", "invalid_token", "Missing, unknown, revoked or expired product token.", {
      retry: false,
    });
  }

  const status = await deps.productStatus(token.productId);
  if (!status || status === "disabled" || status === "failed") {
    return gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.", {
      retry: false,
    });
  }

  const tooLarge = () =>
    gatewayError(
      413,
      "invalid_request_error",
      "body_too_large",
      `Request bodies over 4.5 MB can't pass through the gateway. Upload the file to ${deps.gatewayUrl}/uploads ` +
        "(Vercel Blob client upload) and send its public URL instead.",
      { retry: false },
    );
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DEFAULT_LIMITS.requestBodyMaxBytes) return tooLarge();
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > DEFAULT_LIMITS.requestBodyMaxBytes) return tooLarge();

  const contentType = req.headers.get("content-type");
  let parsed: ParsedRequest;
  try {
    parsed = await parseGatewayRequest(endpoint, contentType, body);
  } catch (err) {
    if (err instanceof BadRequestError) {
      return gatewayError(400, "invalid_request_error", "invalid_body", err.message, { retry: false });
    }
    throw err;
  }
  const model = parsed.model;
  if (endpoint !== "files") {
    if (!model) {
      return gatewayError(400, "invalid_request_error", "missing_model", `/v1/${endpoint} needs a "model".`, {
        retry: false,
      });
    }
    if (!modelAllowed(endpoint, model, token.allowedModels, ENDPOINT_MODELS[endpoint])) {
      const allowed = token.allowedModels.filter((m) => (ENDPOINT_MODELS[endpoint] as readonly string[]).includes(m));
      return gatewayError(
        404,
        "invalid_request_error",
        "model_not_found",
        `The model "${model}" isn't available to this product on /v1/${endpoint}. ` +
          (allowed.length ? `Allowed: ${allowed.join(", ")}.` : "No models are allowed here for this product."),
        { retry: false },
      );
    }
  }

  const [spent, platformSpent] = await Promise.all([deps.tokenSpendToday(token.id), deps.platformSpendToday()]);
  if (spent >= token.dailyBudgetUsd) {
    return gatewayError(
      429,
      "insufficient_quota",
      "budget_exceeded",
      `This product used its $${token.dailyBudgetUsd.toFixed(2)} daily Meta budget. It resets at 00:00 UTC.`,
      { retry: false },
    );
  }
  if (platformSpent >= deps.dailySpendCapUsd) {
    return gatewayError(503, "server_error", "platform_paused", "Muse Muse paused Meta calls for today. Try again tomorrow.", {
      retry: false,
    });
  }

  const now = deps.now?.() ?? new Date();
  const limited = await checkRateLimits(req, token, deps, now);
  if (limited) return limited;

  // asr/transcribe JSON extension: download the WAV and send Meta the multipart request.
  let upstreamBody: BodyInit = body;
  let upstreamContentType: string | null = contentType;
  if (endpoint === "asr/transcribe" && parsed.kind === "json") {
    try {
      upstreamBody = await asrJsonToForm(parsed.json, deps.fetch);
      upstreamContentType = null; // fetch sets multipart/form-data with its boundary
    } catch (err) {
      if (err instanceof AsrInputError) {
        return gatewayError(err.status, "invalid_request_error", err.code, err.message, { retry: false });
      }
      throw err;
    }
  }

  const headers: Record<string, string> = { authorization: `Bearer ${deps.upstreamKey()}` };
  if (upstreamContentType) headers["content-type"] = upstreamContentType;
  const accept = req.headers.get("accept");
  if (accept) headers.accept = accept;

  let upstream: Response;
  try {
    upstream = await deps.fetch(`${deps.upstreamBaseUrl ?? UPSTREAM_BASE_URL}/${endpoint}`, {
      method: "POST",
      headers,
      body: upstreamBody,
      signal: AbortSignal.timeout(DEFAULT_LIMITS.upstreamTimeoutMs),
    });
  } catch (err) {
    console.error(`[gateway] upstream ${endpoint} failed:`, err instanceof Error ? err.message : err);
    return gatewayError(502, "server_error", "upstream_unreachable", "Couldn't reach the Meta Model API. Try again.");
  }

  const outHeaders = new Headers();
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) outHeaders.set(name, value);
  }
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType?.startsWith("text/event-stream")) {
    outHeaders.set("cache-control", "no-cache, no-transform");
    outHeaders.set("x-accel-buffering", "no");
  }

  if (!upstream.ok || !upstream.body || endpoint === "files") {
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  }

  // Tee the body: one branch streams to the product untouched, the other is read now for usage.
  const [toClient, toMeter] = upstream.body.tee();
  const ctx: UsageContext = { source: "gateway", productId: token.productId, tokenId: token.id, endpoint };
  const metering = meterBody(endpoint, model, upstreamType, toMeter)
    .then((items) => (items.length ? deps.recordUsage(ctx, items) : undefined))
    .catch((err) => console.error(`[gateway] recording usage for ${endpoint} failed:`, err));
  deps.defer(() => metering);

  return new Response(toClient, { status: upstream.status, headers: outHeaders });
}
