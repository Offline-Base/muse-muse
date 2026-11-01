/**
 * POST {GATEWAY_URL}/hosted/v1/chat/completions: an OpenAI-shaped answer from a hosted tuned model. Authenticated by the
 * owner token shown once at deploy (mmh_...), or by a live product token whose product owns the model. Whole replies only.
 * Each answer is a `hosted` usage row with its tokens at $0: the money is the endpoint's reservation. The messages are
 * never logged or stored. Refusals: 404 with the flag off, touching nothing.
 */
import { randomUUID } from "node:crypto";
import { derivativeNote } from "@/lib/caps/gpu/general";
import { dayWindow } from "@/lib/docs/proxy/limits";
import { gatewayError, type GatewayErrorType } from "@/lib/gateway/errors";
import { parseBearer } from "@/lib/gateway/extract";
import { chatMessagesProblem, glimmerStops, type ChatMessage } from "@/lib/train/glimmer-serving";
import { HostError, type HostEndpoint } from "@/lib/train/host/types";
import type { HostChatDeps } from "@/lib/train/host/service";
import { chatOnEndpoint } from "@/lib/train/host/service";
import type { CapProduct, CapToken } from "@/lib/caps/gate";
import type { ModelUsage } from "@/lib/types";
import type { UsageContext } from "@/lib/usage";

export const HOSTED_ENDPOINT = "/hosted/v1/chat/completions";
export const HOSTED_LIMITS = { perTokenPerMinute: 30, perEndpointPerDay: 2000, bodyBytes: 256 * 1024 } as const;
const KNOWN_KEYS = new Set(["model", "messages", "max_tokens", "max_completion_tokens", "stop", "stream", "temperature", "top_p", "top_k"]);

export interface HostedGatewayDeps extends HostChatDeps {
  byOwnerTokenHash(hash: string): Promise<HostEndpoint | null>;
  byModel(adapterJobId: string): Promise<HostEndpoint | null>;
  findToken(raw: string): Promise<CapToken | null>;
  product(productId: string): Promise<CapProduct | null>;
  /** True when this product trained the model, or its owner did. */
  productOwnsModel(productId: string, adapterJobId: string): Promise<boolean>;
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  recordUsage(ctx: UsageContext, items: ModelUsage[]): Promise<void>;
  now?(): Date;
}

const bad = (message: string, code = "invalid_arguments") => gatewayError(400, "invalid_request_error", code, message, { retry: false });
const denied = (message: string) => gatewayError(401, "authentication_error", "invalid_token", message, { retry: false });
const ERROR_TYPE: Record<number, GatewayErrorType> = { 400: "invalid_request_error", 409: "rate_limit_error", 429: "insufficient_quota" };

export interface HostedCall {
  model: string | null;
  messages: ChatMessage[];
  stop: string[];
  maxTokens?: number;
}

/** A chat request's body, checked. Sampling is taken and ignored, as on the Glimmer endpoint. */
export function readHostedCall(text: string): HostedCall | Response {
  if (Buffer.byteLength(text) > HOSTED_LIMITS.bodyBytes) return gatewayError(413, "invalid_request_error", "too_large", "Keep the request under 256 KB.", { retry: false });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return bad("The request body is not a JSON object.", "invalid_body");
  }
  const unknownKey = Object.keys(body).find((k) => !KNOWN_KEYS.has(k));
  if (unknownKey) return bad(`This endpoint doesn't take "${unknownKey.slice(0, 40)}".`);
  if (body.stream !== undefined && body.stream !== false) return bad("This endpoint answers whole replies only: leave stream off.");
  const problem = chatMessagesProblem(body.messages);
  if (problem) return bad(problem);
  const rawMax = body.max_completion_tokens ?? body.max_tokens;
  if (rawMax !== undefined && rawMax !== null && (!Number.isInteger(rawMax) || (rawMax as number) < 1)) return bad("max_tokens must be a whole number from 1.");
  if (body.stop !== undefined && body.stop !== null && typeof body.stop !== "string" && !Array.isArray(body.stop)) return bad("stop must be text or a list of text.");
  const stop = glimmerStops(body.stop === null ? undefined : (body.stop as string | string[] | undefined));
  if (stop === null) return bad("Send at most 4 stops, each of up to 64 characters.");
  return {
    model: typeof body.model === "string" && body.model.trim() ? body.model.trim().toLowerCase() : null,
    messages: (body.messages as ChatMessage[]).map((m) => ({ role: m.role, content: m.content })),
    stop,
    ...(typeof rawMax === "number" ? { maxTokens: rawMax } : {}),
  };
}

export function hostErrorResponse(err: unknown): Response {
  if (!(err instanceof HostError)) {
    console.error("[hosted]", err instanceof Error ? err.name : "error");
    return gatewayError(502, "server_error", "endpoint_unavailable", "The model's endpoint didn't answer. Try again soon.", { retry: false });
  }
  const retry = err.retryAfterSeconds;
  return gatewayError(err.status, ERROR_TYPE[err.status] ?? "server_error", err.code, err.message, { retry: false, ...(retry ? { headers: { "retry-after": String(retry) } } : {}) });
}

export async function handleHostedChat(req: Request, deps: HostedGatewayDeps): Promise<Response> {
  if (!deps.on()) return gatewayError(404, "not_found_error", "unknown_endpoint", `The gateway does not serve ${HOSTED_ENDPOINT}.`, { retry: false });
  if (req.method !== "POST") return gatewayError(405, "invalid_request_error", "method_not_allowed", `Use POST for ${HOSTED_ENDPOINT}.`, { retry: false, headers: { allow: "POST" } });
  try {
    const raw = parseBearer(req.headers.get("authorization"));
    if (!raw) return denied('Send a token as "Authorization: Bearer <token>".');
    const now = deps.now?.() ?? new Date();
    const call = readHostedCall(await req.text());
    if (call instanceof Response) return call;

    const ctx: UsageContext = { source: "hosted", endpoint: HOSTED_ENDPOINT };
    let endpoint: HostEndpoint | null;
    let limiter: string;
    if (raw.startsWith("mmh_")) {
      endpoint = await deps.byOwnerTokenHash(deps.hashToken(raw));
      if (!endpoint) return denied("That token doesn't match a running endpoint.");
      if (call.model && call.model !== endpoint.adapterJobId) return bad("That token belongs to another model.", "invalid_model");
      limiter = `hosted:owner:${endpoint.id}`;
    } else {
      const token = await deps.findToken(raw);
      if (!token) return denied("That token isn't valid here.");
      const product = await deps.product(token.productId);
      if (!product || product.status === "disabled" || product.status === "failed" || product.takenDownAt || product.ownerBannedAt) {
        return gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.", { retry: false });
      }
      // A build's tests never reach a GPU the platform pays for.
      if (token.scope !== "live") return gatewayError(403, "permission_error", "cap_not_allowed", "Only a product's live token can use this.", { retry: false });
      if (!call.model) return bad('Set "model" to the tuned model\'s id.', "invalid_model");
      if (!(await deps.productOwnsModel(token.productId, call.model))) return gatewayError(403, "permission_error", "model_not_allowed", "This product doesn't own that model.", { retry: false });
      endpoint = await deps.byModel(call.model);
      if (!endpoint) return gatewayError(503, "server_error", "endpoint_closed", "That model isn't running right now.", { retry: false });
      limiter = `hosted:token:${token.id}`;
      ctx.productId = token.productId;
      ctx.tokenId = token.id;
    }

    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const perMinute = await deps.hitRateLimits([limiter], minute);
    if ((perMinute[limiter] ?? 0) > HOSTED_LIMITS.perTokenPerMinute) return gatewayError(429, "rate_limit_error", "rate_limited", `The limit is ${HOSTED_LIMITS.perTokenPerMinute} questions a minute.`, { headers: { "retry-after": "60" } });
    // The end of the day, not its start: the hourly prune deletes windows that began over an hour ago.
    const day = dayWindow(now);
    const dayKey = `hosted:endpoint:${endpoint.id}`;
    const perDay = await deps.hitRateLimits([dayKey], day);
    if ((perDay[dayKey] ?? 0) > HOSTED_LIMITS.perEndpointPerDay) return gatewayError(429, "rate_limit_error", "rate_limited", `This endpoint has used its ${HOSTED_LIMITS.perEndpointPerDay} answers for today.`, { retry: false });

    const reply = await chatOnEndpoint(endpoint, { messages: call.messages, stop: call.stop, maxTokens: call.maxTokens, signal: req.signal }, deps, now);
    const model = `hosted-${endpoint.provider}`;
    await deps
      .recordUsage(ctx, [{ model, inputTokens: reply.usage.input, cachedInputTokens: 0, outputTokens: reply.usage.output, units: 1, costUsd: 0 }])
      .catch((err) => console.error("[hosted] metering failed:", err instanceof Error ? err.name : "error"));
    // The base's license line, for whoever builds on this answer: Muse Spark Open's, or Llama's.
    const note = derivativeNote(endpoint.ref?.sparkOpen === "1") ?? endpoint.ref?.note ?? null;
    return Response.json(
      {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(now.getTime() / 1000),
        model: endpoint.adapterJobId,
        choices: [{ index: 0, message: { role: "assistant", content: reply.text }, finish_reason: reply.finish }],
        usage: { prompt_tokens: reply.usage.input, completion_tokens: reply.usage.output, total_tokens: reply.usage.input + reply.usage.output },
        ...(note ? { note } : {}),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return hostErrorResponse(err);
  }
}
