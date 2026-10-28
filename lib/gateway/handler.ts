import { AsrInputError, asrJsonToForm } from "@/lib/gateway/asr";
import { gatewayError } from "@/lib/gateway/errors";
import { estimateCost } from "@/lib/gateway/estimate";
import {
  BadRequestError,
  clientIpKey,
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
import type { GatewayEndpoint, ModelUsage, ProductStatus } from "@/lib/types";

/** The token fields the gateway needs. findToken's row satisfies it. */
export type GatewayToken = Pick<GatewayTokenRow, "id" | "productId" | "scope" | "allowedModels" | "dailyBudgetUsd">;

/** Everything the gateway touches outside the request, injected so tests can run it without a database. */
export interface GatewayDeps {
  findToken(token: string): Promise<GatewayToken | null>;
  productStatus(productId: string): Promise<ProductStatus | null>;
  /** Spend today, counting the reservations of calls still running. */
  tokenSpendToday(tokenId: string): Promise<number>;
  platformSpendToday(): Promise<number>;
  dailySpendCapUsd: number;
  /** Increments each key's counter for the window and returns the new counts, keyed like the input. */
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  /** Takes one of `limit` slots for the key atomically. Returns the handle releaseInFlight needs, or null when full. */
  acquireInFlight(key: string, limit: number, now: Date): Promise<Date | null>;
  releaseInFlight(key: string, slot: Date): Promise<void>;
  /** Records a call's estimated cost before forwarding it. Returns the reservation's id. */
  reserveSpend(ctx: UsageContext, model: string | null, costUsd: number): Promise<string>;
  /** Replaces the reservation with the metered usage, or removes it when `item` is null. */
  settleSpend(reservationId: string, item: ModelUsage | null): Promise<void>;
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

async function checkRateLimits(
  req: Request,
  token: GatewayToken,
  deps: GatewayDeps,
  now: Date,
): Promise<Response | null> {
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const limits: Record<string, number> = { [`token:${token.id}`]: DEFAULT_LIMITS.perTokenRequestsPerMinute };
  const ip = clientIpKey(req.headers.get(CLIENT_IP_HEADER));
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
  const startedAt = Date.now();
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

  const now = deps.now?.() ?? new Date();
  const limited = await checkRateLimits(req, token, deps, now);
  if (limited) return limited;

  // At most perTokenInFlight calls per token run at once, so a burst can't all pass the budget check before any of
  // them is metered. The slot is given back once the call is metered (or right away when nothing is forwarded).
  const slotKey = `inflight:${token.id}`;
  const slot = await deps.acquireInFlight(slotKey, DEFAULT_LIMITS.perTokenInFlight, now);
  if (!slot) {
    return gatewayError(
      429,
      "rate_limit_error",
      "too_many_in_flight",
      `This product already has ${DEFAULT_LIMITS.perTokenInFlight} Meta calls running. Try again when one finishes.`,
      { headers: { "retry-after": "2" } },
    );
  }
  const releaseSlot = () =>
    deps.releaseInFlight(slotKey, slot).catch((err) => console.error("[gateway] releasing an in-flight slot failed:", err));
  let metering: Promise<void> | null = null;
  try {
    const result = await forward(req, endpoint, token, parsed, body, contentType, deps, startedAt);
    metering = result.metering;
    return result.response;
  } finally {
    const pending = metering;
    if (pending) deps.defer(() => pending.finally(releaseSlot));
    else await releaseSlot();
  }
}

/** Budget check and reservation, then the upstream call. `metering` is set when usage is still being read. */
async function forward(
  req: Request,
  endpoint: GatewayEndpoint,
  token: GatewayToken,
  parsed: ParsedRequest,
  body: Uint8Array<ArrayBuffer>,
  contentType: string | null,
  deps: GatewayDeps,
  startedAt: number,
): Promise<{ response: Response; metering: Promise<void> | null }> {
  const done = (response: Response) => ({ response, metering: null });
  const model = parsed.model;
  const estimate = estimateCost(endpoint, parsed, body.byteLength);
  const [spent, platformSpent] = await Promise.all([deps.tokenSpendToday(token.id), deps.platformSpendToday()]);
  const budget = token.dailyBudgetUsd;
  if (spent >= budget || spent + estimate > budget) {
    // A build token's budget is the whole build's, so waiting for midnight only stalls the build.
    const whose =
      token.scope === "build"
        ? `this build's $${budget.toFixed(2)} Meta budget for tests (calls still running count). It doesn't reset ` +
          "during the build: don't wait or retry. Make the tests' model calls fewer or cheaper (a lower " +
          "max_output_tokens), or stop and say so in BUILD_NOTES.md."
        : `this product's $${budget.toFixed(2)} daily Meta budget (calls still running count). It resets at 00:00 UTC.`;
    return done(
      gatewayError(
        429,
        "insufficient_quota",
        "budget_exceeded",
        spent >= budget && token.scope !== "build"
          ? `This product used its $${budget.toFixed(2)} daily Meta budget. It resets at 00:00 UTC.`
          : spent >= budget
            ? `This call is over ${whose}`
            : `This call is estimated at $${estimate.toFixed(2)}, more than the $${(budget - spent).toFixed(2)} left in ${whose}`,
        { retry: false },
      ),
    );
  }
  if (platformSpent >= deps.dailySpendCapUsd || platformSpent + estimate > deps.dailySpendCapUsd) {
    return done(
      gatewayError(503, "server_error", "platform_paused", "Muse Muse paused Meta calls for today. Try again tomorrow.", {
        retry: false,
      }),
    );
  }

  const upstreamKey = deps.upstreamKey();
  const ctx: UsageContext = { source: "gateway", productId: token.productId, tokenId: token.id, endpoint };
  const reservation = estimate > 0 ? await deps.reserveSpend(ctx, model, estimate) : null;
  const unreserve = async () => {
    if (!reservation) return;
    await deps.settleSpend(reservation, null).catch((err) => console.error("[gateway] removing a reservation failed:", err));
  };

  // asr/transcribe JSON extension: download the WAV and send Meta the multipart request.
  let upstreamBody: BodyInit = body;
  let upstreamContentType: string | null = contentType;
  if (endpoint === "asr/transcribe" && parsed.kind === "json") {
    try {
      upstreamBody = await asrJsonToForm(parsed.json, deps.fetch);
      upstreamContentType = null; // fetch sets multipart/form-data with its boundary
    } catch (err) {
      await unreserve();
      if (err instanceof AsrInputError) {
        return done(gatewayError(err.status, "invalid_request_error", err.code, err.message, { retry: false }));
      }
      throw err;
    }
  }

  const headers: Record<string, string> = { authorization: `Bearer ${upstreamKey}` };
  if (upstreamContentType) headers["content-type"] = upstreamContentType;
  const accept = req.headers.get("accept");
  if (accept) headers.accept = accept;

  // One deadline for the whole call (the asr download included), well inside maxDuration, so after() still has time
  // to record the usage of a stream the timeout cuts off.
  const timeoutMs = Math.max(1_000, startedAt + DEFAULT_LIMITS.upstreamTimeoutMs - Date.now());
  let upstream: Response;
  try {
    upstream = await deps.fetch(`${deps.upstreamBaseUrl ?? UPSTREAM_BASE_URL}/${endpoint}`, {
      method: "POST",
      headers,
      body: upstreamBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    console.error(`[gateway] upstream ${endpoint} failed:`, err instanceof Error ? err.message : err);
    await unreserve();
    return done(gatewayError(502, "server_error", "upstream_unreachable", "Couldn't reach the Meta Model API. Try again."));
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
    await unreserve();
    return done(new Response(upstream.body, { status: upstream.status, headers: outHeaders }));
  }

  // Tee the body: one branch streams to the product untouched, the other is read now for usage, which then replaces
  // the reservation.
  const [toClient, toMeter] = upstream.body.tee();
  const metering = meterBody(endpoint, model, upstreamType, toMeter)
    .then(async (items) => {
      if (reservation) await deps.settleSpend(reservation, items[0] ?? null);
      const rest = reservation ? items.slice(1) : items;
      if (rest.length) await deps.recordUsage(ctx, rest);
    })
    .catch((err) => console.error(`[gateway] recording usage for ${endpoint} failed:`, err));

  return { response: new Response(toClient, { status: upstream.status, headers: outHeaders }), metering };
}
