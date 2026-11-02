import { randomUUID } from "node:crypto";
import { dayWindow, type CapProduct, type CapToken } from "@/lib/caps/gate";
import { FLEET_BRIEF_MODEL, FLEET_CANNED_USAGE, FLEET_MARKER } from "@/lib/caps/fleet/marker";
import type { FleetSettings } from "@/lib/caps/fleet/settings";
import { gatewayError } from "@/lib/gateway/errors";
import { clientIpKey, parseBearer } from "@/lib/gateway/extract";
import { CLIENT_IP_HEADER } from "@/lib/gateway/policy";
import { chatMessagesProblem, type ChatMessage } from "@/lib/train/glimmer-serving";
import { builderTier, tierMayUseBuilderCaps } from "@/lib/trust/tiers";
import type { ModelUsage } from "@/lib/types";
import type { UsageContext } from "@/lib/usage";

/**
 * POST {GATEWAY_URL}/fleet/v1/chat/completions (docs/CAPABILITIES.md, 17b): one OpenAI-shaped chat answer from the Jetson
 * fleet's boards, for a token with the `fleet` marker. A build token gets a labeled simulated reply and never reaches the
 * fleet. The model is the server's setting, always a plain name, so there is no cloud path, and a reply served from the cloud
 * is an error anyway.
 *
 * Refusals: 404 unknown_endpoint with the flag off, and nothing is touched. 503 fleet_closed with a setting missing or
 * refused, 409 busy, 429 rate_limited, 504 timeout, 502 fleet_unavailable, 400 for the caller's own mistakes. askFleetOrMessage
 * (template/lib/meta/fleet.ts) turns every one of them into fixed words. The messages are never logged or stored, and the
 * fleet's address and error text never reach the caller. Each answer is a `fleet` usage row with one unit at $0.
 */

export const FLEET_ENDPOINT = "/fleet/v1/chat/completions";

export const FLEET_LIMITS = {
  perProductPerDay: 100,
  perIpPerMinute: 10,
  /** At once: a product's own, and the whole platform's. The boards are few, and answer at about 13 to 15 tokens a second. */
  inFlightPerProduct: 1,
  inFlightAll: 2,
  /** Characters of content, across the messages. */
  chars: 8000,
  maxTokens: 1024,
  /** 8000 characters of messages, JSON escaped at worst, and little else. */
  bodyBytes: 64 * 1024,
} as const;

/** Under the route's maxDuration (120 s), so the slots are given back. 1024 tokens take about 80 s at the speed above. */
export const FLEET_TIMEOUT_MS = 100_000;

/** A build's stand-in. It says what it is, so nobody takes it for a board's answer. */
export const FLEET_SIMULATED_REPLY = "Simulated reply: this is a test build, so no board and no model wrote this.";

/** Anything else is refused, not dropped. Sampling isn't taken: the fleet's defaults are used. */
const KNOWN_KEYS = new Set(["model", "messages", "max_tokens", "max_completion_tokens", "stream"]);

const ALL_SLOT = "fleet:flight:all";

export interface FleetDeps {
  on(): boolean;
  allProducts(): boolean;
  /** Null when a setting is missing or refused (fleetSettings). */
  settings(): FleetSettings | null;
  adminEmails: readonly string[];
  findToken(raw: string): Promise<CapToken | null>;
  product(productId: string): Promise<CapProduct | null>;
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  acquireInFlight(key: string, limit: number, now: Date): Promise<Date | null>;
  releaseInFlight(key: string, bucket: Date): Promise<void>;
  recordUsage(ctx: UsageContext, items: ModelUsage[]): Promise<void>;
  fetch: typeof fetch;
  now?(): Date;
}

const bad = (code: string, message: string) => gatewayError(400, "invalid_request_error", code, message, { retry: false });

const usage = (model: string): ModelUsage => ({ model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd: 0 });

function meter(deps: FleetDeps, token: CapToken, model: string): Promise<void> {
  const ctx: UsageContext = { source: "fleet", endpoint: FLEET_ENDPOINT, productId: token.productId, tokenId: token.id, buildId: token.buildId };
  return deps.recordUsage(ctx, [usage(model)]).catch(() => console.error("[fleet] metering failed"));
}

interface FleetCall {
  messages: ChatMessage[];
  maxTokens: number;
}

/** An image or audio part, or a field that could carry one: only a role and plain text go on. */
function notPlainText(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const { role: _role, content, ...rest } = message as Record<string, unknown>;
  return (content !== null && typeof content === "object") || Object.keys(rest).length > 0;
}

async function readCall(req: Request): Promise<FleetCall | Response> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return bad("invalid_body", "The request body couldn't be read.");
  }
  if (Buffer.byteLength(text) > FLEET_LIMITS.bodyBytes) {
    return gatewayError(413, "invalid_request_error", "too_large", `Keep the request under ${FLEET_LIMITS.bodyBytes / 1024} KB.`, { retry: false });
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
  if (unknown) return bad("invalid_arguments", `The Jetson fleet's endpoint doesn't take "${unknown.slice(0, 40)}".`);
  if (body.stream !== undefined && body.stream !== false) return bad("invalid_arguments", "The Jetson fleet's endpoint answers whole replies only: leave stream off.");
  if (body.model !== undefined && body.model !== FLEET_BRIEF_MODEL) return bad("invalid_model", `model must be "${FLEET_BRIEF_MODEL}". The platform chooses what runs on the boards.`);
  if (Array.isArray(body.messages) && body.messages.some(notPlainText)) return bad("text_only", "The Jetson fleet takes text only: each message is a role and plain text, with no images or audio.");
  const problem = chatMessagesProblem(body.messages);
  if (problem) return bad("invalid_arguments", problem);
  const messages = body.messages as ChatMessage[];
  if (messages.reduce((n, m) => n + m.content.length, 0) > FLEET_LIMITS.chars) return bad("too_long", `Keep the messages under ${FLEET_LIMITS.chars} characters in all.`);
  const rawMax = body.max_completion_tokens ?? body.max_tokens;
  if (rawMax !== undefined && rawMax !== null && (!Number.isInteger(rawMax) || (rawMax as number) < 1)) return bad("invalid_arguments", "max_tokens must be a whole number from 1.");
  return { messages: messages.map((m) => ({ role: m.role, content: m.content })), maxTokens: Math.min(typeof rawMax === "number" ? rawMax : FLEET_LIMITS.maxTokens, FLEET_LIMITS.maxTokens) };
}

function completion(text: string, finish: "stop" | "length", tokens: { input: number; output: number }, extra: Record<string, unknown>, now: Date): Response {
  return Response.json(
    {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(now.getTime() / 1000),
      model: FLEET_BRIEF_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish }],
      usage: { prompt_tokens: tokens.input, completion_tokens: tokens.output, total_tokens: tokens.input + tokens.output },
      ...extra,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/** A product's answers today, counted just before an answer: a try that then fails still spends one of the fleet's requests. */
async function overDay(token: CapToken, deps: FleetDeps, now: Date): Promise<Response | null> {
  const dayKey = `fleet:product:${token.productId}`;
  const day = await deps.hitRateLimits([dayKey], dayWindow(now));
  if ((day[dayKey] ?? 0) <= FLEET_LIMITS.perProductPerDay) return null;
  const retry = Math.max(1, Math.ceil((dayWindow(now).getTime() - now.getTime()) / 1000));
  return gatewayError(429, "rate_limit_error", "rate_limited", `This product has used its ${FLEET_LIMITS.perProductPerDay} Jetson fleet answers for today.`, { headers: { "retry-after": String(retry) }, retry: false });
}

async function overIpMinute(req: Request, token: CapToken, deps: FleetDeps, now: Date): Promise<Response | null> {
  const ip = clientIpKey(req.headers.get(CLIENT_IP_HEADER));
  if (!ip) return null;
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const ipKey = `fleet:ip:${token.productId}:${ip}`;
  const counts = await deps.hitRateLimits([ipKey], minute);
  if ((counts[ipKey] ?? 0) <= FLEET_LIMITS.perIpPerMinute) return null;
  const retry = Math.max(1, Math.ceil((minute.getTime() + 60_000 - now.getTime()) / 1000));
  return gatewayError(429, "rate_limit_error", "rate_limited", `Too many questions: the limit is ${FLEET_LIMITS.perIpPerMinute} a minute. Try again in ${retry} s.`, { headers: { "retry-after": String(retry) } });
}

/** Holds a product's slot and one of the platform's for `run`, and always gives them back. A crash's stop counting within 20 minutes (acquireInFlight). */
async function inSlots(productId: string, deps: FleetDeps, now: Date, run: () => Promise<Response>): Promise<Response> {
  const busy = () => gatewayError(409, "rate_limit_error", "busy", "The Jetson fleet is answering someone else. Try again in a moment.", { headers: { "retry-after": "30" }, retry: false });
  const ownSlot = `fleet:flight:${productId}`;
  const own = await deps.acquireInFlight(ownSlot, FLEET_LIMITS.inFlightPerProduct, now);
  if (!own) return busy();
  try {
    const all = await deps.acquireInFlight(ALL_SLOT, FLEET_LIMITS.inFlightAll, now);
    if (!all) return busy();
    try {
      return await run();
    } finally {
      await deps.releaseInFlight(ALL_SLOT, all).catch(() => undefined);
    }
  } finally {
    await deps.releaseInFlight(ownSlot, own).catch(() => undefined);
  }
}

class FleetFailure extends Error {
  constructor(readonly code: "fleet_unavailable" | "fleet_cloud_answer") {
    super(code);
  }
}

interface FleetReply {
  text: string;
  finish: "stop" | "length";
  input: number;
  output: number;
}

const count = (n: unknown) => (Number.isInteger(n) && (n as number) >= 0 ? (n as number) : 0);

/** The one call to the fleet. Only this body and these headers go out, and only the reply's text and counts come back. */
async function askFleet(settings: FleetSettings, call: FleetCall, deps: FleetDeps, signal: AbortSignal): Promise<FleetReply> {
  const res = await deps.fetch(`${settings.url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${settings.key}`, "content-type": "application/json", "x-jcp-route": "local" },
    body: JSON.stringify({ model: settings.model, messages: call.messages, max_tokens: call.maxTokens, stream: false }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(FLEET_TIMEOUT_MS)]),
  });
  // A plain model's answer has no such header, and a board's says local. Anything else isn't an answer.
  const servedBy = res.headers.get("x-jcp-served-by")?.trim().toLowerCase();
  if (servedBy && servedBy !== "local") {
    await res.body?.cancel().catch(() => undefined);
    throw new FleetFailure("fleet_cloud_answer");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new FleetFailure("fleet_unavailable");
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null;
  const choice = data?.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new FleetFailure("fleet_unavailable");
  return { text, finish: choice?.finish_reason === "length" ? "length" : "stop", input: count(data?.usage?.prompt_tokens), output: count(data?.usage?.completion_tokens) };
}

function failure(err: unknown): Response {
  const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
  const code = timedOut ? "timeout" : err instanceof FleetFailure ? err.code : "fleet_unavailable";
  // Only the code: never the messages, and never the fleet's address or words, which an error's own message can carry.
  console.error("[fleet]", code);
  if (timedOut) return gatewayError(504, "server_error", "timeout", "The Jetson fleet didn't answer in time. Try again.", { retry: false });
  return gatewayError(502, "server_error", "fleet_unavailable", "The Jetson fleet didn't answer. Try again in a moment.", { retry: false });
}

export async function handleFleetChat(req: Request, deps: FleetDeps): Promise<Response> {
  if (!deps.on()) return gatewayError(404, "not_found_error", "unknown_endpoint", `The gateway does not serve ${FLEET_ENDPOINT}.`, { retry: false });
  if (req.method !== "POST") return gatewayError(405, "invalid_request_error", "method_not_allowed", `Use POST for ${FLEET_ENDPOINT}.`, { retry: false, headers: { allow: "POST" } });
  try {
    const raw = parseBearer(req.headers.get("authorization"));
    const token = raw ? await deps.findToken(raw) : null;
    if (!token) return gatewayError(401, "authentication_error", "invalid_token", 'Send the product\'s token as "Authorization: Bearer <PRODUCT_TOKEN>".', { retry: false });
    const product = await deps.product(token.productId);
    if (!product || product.status === "disabled" || product.status === "failed" || product.takenDownAt || product.ownerBannedAt) {
      return gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.", { retry: false });
    }
    if (!token.allowedModels.includes(FLEET_MARKER)) {
      return gatewayError(403, "permission_error", "fleet_not_allowed", "This product's brief doesn't use the Jetson fleet.", { retry: false });
    }
    const now = deps.now?.() ?? new Date();
    const over = await overIpMinute(req, token, deps, now);
    if (over) return over;
    const call = await readCall(req);
    if (call instanceof Response) return call;

    if (token.scope === "build") {
      // No buildId is needed: a brief with no cap blocks gets a build token without one (provisionStep), and this touches
      // no build namespace. The row records a null buildId then.
      const spent = await overDay(token, deps, now);
      if (spent) return spent;
      await meter(deps, token, FLEET_CANNED_USAGE);
      return completion(FLEET_SIMULATED_REPLY, "stop", { input: 0, output: 0 }, { simulated: true }, now);
    }
    if (token.scope !== "live") return gatewayError(403, "permission_error", "cap_not_allowed", "Only a product's own token can use this.", { retry: false });

    const tier = builderTier({ email: product.ownerEmail, isAdmin: product.ownerIsAdmin && deps.adminEmails.includes(product.ownerEmail), bannedAt: product.ownerBannedAt });
    if (!tierMayUseBuilderCaps(tier)) return gatewayError(403, "permission_error", "sign_in_required", "The Jetson fleet needs a product made by someone signed in to Muse Muse.", { retry: false });
    if (tier !== "admin" && !deps.allProducts()) return gatewayError(403, "permission_error", "fleet_not_allowed", "The Jetson fleet is open only to the platform's own products for now.", { retry: false });

    const settings = deps.settings();
    if (!settings) return gatewayError(503, "server_error", "fleet_closed", "The Jetson fleet isn't open to products right now.", { retry: false });

    return await inSlots(token.productId, deps, now, async () => {
      const spent = await overDay(token, deps, now);
      if (spent) return spent;
      const got = await askFleet(settings, call, deps, req.signal);
      await meter(deps, token, FLEET_BRIEF_MODEL);
      return completion(got.text, got.finish, { input: got.input, output: got.output }, {}, now);
    });
  } catch (err) {
    return failure(err);
  }
}
