import { randomUUID } from "node:crypto";
import { cannedGlimmerReply } from "@/lib/caps/gpu/canned";
import { derivativeNote } from "@/lib/caps/gpu/general";
import { GLIMMER_BRIEF_MODEL, GLIMMER_CANNED_USAGE, GLIMMER_CLOSED_USAGE, GLIMMER_MARKER } from "@/lib/caps/gpu/marker";
import type { GlimmerWindow, OwnModel } from "@/lib/caps/gpu/types";
import { dayWindow, type CapProduct, type CapToken } from "@/lib/caps/gate";
import { gatewayError, type GatewayErrorType } from "@/lib/gateway/errors";
import { clientIpKey, parseBearer } from "@/lib/gateway/extract";
import { CLIENT_IP_HEADER } from "@/lib/gateway/policy";
import { chatMessagesProblem, glimmerErrorReply, glimmerStops, type ChatMessage, type GlimmerChatBackend } from "@/lib/train/glimmer-serving";
import { ServeError } from "@/lib/train/serve";
import { builderTier, tierMayUseBuilderCaps } from "@/lib/trust/tiers";
import type { ModelUsage } from "@/lib/types";
import type { UsageContext } from "@/lib/usage";

/**
 * POST {GATEWAY_URL}/glimmer/v1/chat/completions (docs/CAPABILITIES.md, section 17): one OpenAI-shaped chat answer from the
 * hosted Muse Glimmer, for a token with the `glimmer` marker. A build token gets a sample reply. A live token reaches a GPU
 * only during an open demo window: the window's glimmer-serve job, through General's GlimmerChatBackend, which always sends
 * Meta's sampling and owns the stops. `model` is "muse-glimmer" (base Glimmer) or "own" (the product's own tuned model).
 *
 * Refusals: 404 unknown_endpoint with the flag off, and nothing is touched. 503 glimmer_closed, 503 glimmer_starting
 * {retryAfterSeconds}, 404 own_model_not_ready, 409 busy, 504 timeout, 502 glimmer_unavailable, 400 for the caller's own
 * mistakes. askGlimmer (template/lib/meta/glimmer.ts) falls back to Muse Wonder on anything but a 400. The messages are
 * never logged or stored. Each answer is a `glimmer` usage row with one unit at $0: the window's GPU money is reserved
 * when it opens.
 */

export const GLIMMER_OWN_MODEL = "own";
/** The only stand-in a build's test may ask for: this header's value makes the build's call answer as a closed window would. */
export const GLIMMER_TEST_HEADER = "x-musemuse-glimmer-test";
export const GLIMMER_ENDPOINT = "/glimmer/v1/chat/completions";

export const GLIMMER_LIMITS = {
  perProductPerDay: 200,
  perIpPerMinute: 10,
  /** 32,000 characters of messages, JSON escaped at worst, and little else. */
  bodyBytes: 256 * 1024,
} as const;

/** What the OpenAI SDK may send. Sampling is taken and ignored: Meta's is always used. Anything else is refused, not dropped. */
const KNOWN_KEYS = new Set(["model", "messages", "max_tokens", "max_completion_tokens", "stop", "stream", "temperature", "top_p", "top_k"]);

export interface GlimmerDeps {
  on(): boolean;
  /** GPU_GLIMMER_DAILY_USD is 0. */
  paused(): boolean;
  allProducts(): boolean;
  adminEmails: readonly string[];
  findToken(raw: string): Promise<CapToken | null>;
  product(productId: string): Promise<CapProduct | null>;
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  /** The open demo window, or null. */
  openWindow(now: Date): Promise<GlimmerWindow | null>;
  ownModel(productId: string, now: Date): Promise<OwnModel | null>;
  /** A window's serve job while it boots: seconds until it should answer. Null once it is live or gone. */
  startingFor(window: GlimmerWindow, now: Date): Promise<number | null>;
  /** serveJobChatBackend on the window's adapter. */
  backend(adapterJobId: string, now: Date): Promise<GlimmerChatBackend | null>;
  recordUsage(ctx: UsageContext, items: ModelUsage[]): Promise<void>;
  now?(): Date;
}

const closed = (why: string) => gatewayError(503, "server_error", "glimmer_closed", why, { retry: false });
const CLOSED = "Muse Glimmer isn't open right now: it runs only during demo windows.";
const bad = (code: string, message: string) => gatewayError(400, "invalid_request_error", code, message, { retry: false });

const usage = (model: string): ModelUsage => ({ model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd: 0 });

function meter(deps: GlimmerDeps, token: CapToken, model: string): Promise<void> {
  const ctx: UsageContext = { source: "glimmer", endpoint: GLIMMER_ENDPOINT, productId: token.productId, tokenId: token.id, buildId: token.buildId };
  return deps.recordUsage(ctx, [usage(model)]).catch((err) => console.error("[glimmer] metering failed:", err instanceof Error ? err.message : err));
}

interface GlimmerCall {
  model: string;
  own: boolean;
  messages: ChatMessage[];
  maxTokens?: number;
  stop: string[];
}

async function readCall(req: Request): Promise<GlimmerCall | Response> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return bad("invalid_body", "The request body couldn't be read.");
  }
  if (Buffer.byteLength(text) > GLIMMER_LIMITS.bodyBytes) {
    return gatewayError(413, "invalid_request_error", "too_large", `Keep the request under ${GLIMMER_LIMITS.bodyBytes / 1024} KB.`, { retry: false });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return bad("invalid_body", "The request body is not a JSON object.");
  }
  const unknown = Object.keys(body).find((k) => !KNOWN_KEYS.has(k));
  if (unknown) return bad("invalid_arguments", `Muse Glimmer's endpoint doesn't take "${unknown.slice(0, 40)}".`);
  if (body.stream !== undefined && body.stream !== false) return bad("invalid_arguments", "Muse Glimmer's endpoint answers whole replies only: leave stream off.");
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : GLIMMER_BRIEF_MODEL;
  if (model !== GLIMMER_BRIEF_MODEL && model !== GLIMMER_OWN_MODEL) {
    return bad("invalid_model", `model must be "${GLIMMER_BRIEF_MODEL}", or "${GLIMMER_OWN_MODEL}" for this product's own tuned model.`);
  }
  const problem = chatMessagesProblem(body.messages);
  if (problem) return bad("invalid_arguments", problem);
  const rawMax = body.max_completion_tokens ?? body.max_tokens;
  if (rawMax !== undefined && rawMax !== null && (!Number.isInteger(rawMax) || (rawMax as number) < 1)) return bad("invalid_arguments", "max_tokens must be a whole number from 1.");
  const stop = glimmerStops(body.stop === null ? undefined : (body.stop as string | string[] | undefined));
  if (stop === null) return bad("invalid_arguments", "Send at most 4 stops, each of up to 64 characters.");
  const messages = (body.messages as ChatMessage[]).map((m) => ({ role: m.role, content: m.content }));
  return { model, own: model === GLIMMER_OWN_MODEL, messages, stop, ...(typeof rawMax === "number" ? { maxTokens: rawMax } : {}) };
}

function completion(model: string, text: string, finish: "stop" | "length", tokens: { input: number; output: number }, extra: Record<string, unknown>, note: string | null, now: Date): Response {
  return Response.json(
    {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(now.getTime() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish }],
      usage: { prompt_tokens: tokens.input, completion_tokens: tokens.output, total_tokens: tokens.input + tokens.output },
      ...extra,
      ...(note ? { note } : {}),
    },
    { headers: { "cache-control": "no-store", ...(note ? { "x-musemuse-note": note } : {}) } },
  );
}

async function limited(req: Request, token: CapToken, deps: GlimmerDeps, now: Date): Promise<Response | null> {
  const dayKey = `glimmer:product:${token.productId}`;
  const day = await deps.hitRateLimits([dayKey], dayWindow(now));
  if ((day[dayKey] ?? 0) > GLIMMER_LIMITS.perProductPerDay) {
    const retry = Math.max(1, Math.ceil((dayWindow(now).getTime() - now.getTime()) / 1000));
    return gatewayError(429, "rate_limit_error", "rate_limited", `This product has used its ${GLIMMER_LIMITS.perProductPerDay} Muse Glimmer answers for today.`, { headers: { "retry-after": String(retry) }, retry: false });
  }
  const ip = clientIpKey(req.headers.get(CLIENT_IP_HEADER));
  if (!ip) return null;
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const ipKey = `glimmer:ip:${token.productId}:${ip}`;
  const counts = await deps.hitRateLimits([ipKey], minute);
  if ((counts[ipKey] ?? 0) <= GLIMMER_LIMITS.perIpPerMinute) return null;
  const retry = Math.max(1, Math.ceil((minute.getTime() + 60_000 - now.getTime()) / 1000));
  return gatewayError(429, "rate_limit_error", "rate_limited", `Too many questions: the limit is ${GLIMMER_LIMITS.perIpPerMinute} a minute. Try again in ${retry} s.`, { headers: { "retry-after": String(retry) } });
}

const ERROR_TYPE: Record<number, GatewayErrorType> = { 400: "invalid_request_error", 409: "rate_limit_error" };

function serveFailure(err: unknown): Response {
  const reply = err instanceof ServeError ? glimmerErrorReply(err) : { status: 502, code: "glimmer_unavailable" };
  // Only the code: never the messages, and never the GPU's address.
  console.error("[glimmer]", reply.code);
  const words: Record<string, string> = {
    busy: "Muse Glimmer is answering someone else, one at a time. Try again in a moment.",
    glimmer_closed: "Muse Glimmer's demo window is closing.",
    timeout: "Muse Glimmer didn't answer in time. Try again.",
    bad_request: err instanceof Error ? err.message : "Muse Glimmer can't take that request.",
    glimmer_unavailable: "Muse Glimmer didn't answer. Try again in a moment.",
  };
  return gatewayError(reply.status, ERROR_TYPE[reply.status] ?? "server_error", reply.code, words[reply.code] ?? words.glimmer_unavailable!, { retry: reply.status === 409 ? undefined : false });
}

export async function handleGlimmerChat(req: Request, deps: GlimmerDeps): Promise<Response> {
  if (!deps.on()) return gatewayError(404, "not_found_error", "unknown_endpoint", `The gateway does not serve ${GLIMMER_ENDPOINT}.`, { retry: false });
  if (req.method !== "POST") return gatewayError(405, "invalid_request_error", "method_not_allowed", `Use POST for ${GLIMMER_ENDPOINT}.`, { retry: false, headers: { allow: "POST" } });
  try {
    const raw = parseBearer(req.headers.get("authorization"));
    const token = raw ? await deps.findToken(raw) : null;
    if (!token) return gatewayError(401, "authentication_error", "invalid_token", 'Send the product\'s token as "Authorization: Bearer <PRODUCT_TOKEN>".', { retry: false });
    const product = await deps.product(token.productId);
    if (!product || product.status === "disabled" || product.status === "failed" || product.takenDownAt || product.ownerBannedAt) {
      return gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.", { retry: false });
    }
    if (!token.allowedModels.includes(GLIMMER_MARKER)) {
      return gatewayError(403, "permission_error", "glimmer_not_allowed", "This product's brief doesn't use the hosted Muse Glimmer.", { retry: false });
    }
    const now = deps.now?.() ?? new Date();
    const over = await limited(req, token, deps, now);
    if (over) return over;
    const call = await readCall(req);
    if (call instanceof Response) return call;

    if (token.scope === "build") {
      if (!token.buildId) return gatewayError(403, "permission_error", "cap_not_allowed", "This build token isn't tied to a build.", { retry: false });
      if (req.headers.get(GLIMMER_TEST_HEADER) === "closed") {
        await meter(deps, token, GLIMMER_CLOSED_USAGE);
        return closed(CLOSED);
      }
      await meter(deps, token, GLIMMER_CANNED_USAGE);
      const words = cannedGlimmerReply({ model: call.model, messages: call.messages });
      return completion(call.model, words, "stop", { input: 0, output: 0 }, { simulated: true }, null, now);
    }
    if (token.scope !== "live") return gatewayError(403, "permission_error", "cap_not_allowed", "Only a product's own token can use this.", { retry: false });

    const tier = builderTier({ email: product.ownerEmail, isAdmin: product.ownerIsAdmin && deps.adminEmails.includes(product.ownerEmail), bannedAt: product.ownerBannedAt });
    if (!tierMayUseBuilderCaps(tier)) return gatewayError(403, "permission_error", "sign_in_required", "The hosted Muse Glimmer needs a product made by someone signed in to Muse Muse.", { retry: false });
    if (tier !== "admin" && !deps.allProducts()) return gatewayError(403, "permission_error", "glimmer_not_allowed", "The hosted Muse Glimmer is open only to the platform's own products for now.", { retry: false });

    if (deps.paused()) return closed(CLOSED);
    const window = await deps.openWindow(now);
    if (!window) return closed(CLOSED);
    let adapter: string | null = null;
    if (call.own) {
      const own = await deps.ownModel(token.productId, now);
      if (!own) return gatewayError(404, "not_found_error", "own_model_not_ready", "This product doesn't have its own tuned model that passed yet.", { retry: false });
      if (own.adapterJobId !== window.adapterJobId) return closed("This demo window is serving a different model.");
      adapter = own.adapterJobId;
    }
    const starting = await deps.startingFor(window, now);
    if (starting !== null) {
      return Response.json(
        { error: { type: "server_error", code: "glimmer_starting", message: "Muse Glimmer's GPU is still starting.", param: null }, retryAfterSeconds: starting },
        { status: 503, headers: { "x-should-retry": "false", "retry-after": String(starting) } },
      );
    }
    const backend = await deps.backend(window.adapterJobId, now);
    if (!backend) return closed(CLOSED);
    const got = await backend.chat({ messages: call.messages, adapter, maxTokens: call.maxTokens, stop: call.stop, signal: req.signal });
    await meter(deps, token, call.own ? "muse-glimmer-own" : GLIMMER_BRIEF_MODEL);
    return completion(call.model, got.text, got.finish, got.usage, {}, derivativeNote(window.sparkOpen), now);
  } catch (err) {
    return serveFailure(err);
  }
}
