import { CAP_NEEDS_BUILDER, type CapId } from "@/lib/caps/ids";
import { allowedCapIds } from "@/lib/caps/manifest";
import { resolveCapCaller, type CapCaller } from "@/lib/caps/principal";
import { buildNamespace } from "@/lib/caps/proof";
import { gatewayError, type GatewayErrorType } from "@/lib/gateway/errors";
import { parseBearer } from "@/lib/gateway/extract";
import { builderTier, tierMayUseBuilderCaps } from "@/lib/trust/tiers";
import type { UsageContext } from "@/lib/usage";
import type { ModelUsage, ProductStatus } from "@/lib/types";

/**
 * The cap gate (docs/CAPABILITIES.md, 2.4): every wave 3 cap route runs its checks, in this order, before its own work.
 * Deps are injected like GatewayDeps (lib/gateway/handler.ts) and built from the same store (lib/gateway/store.ts), so
 * tests need no database. A route describes itself as a CapRoute; runCapGate does the rest.
 *
 *    1. flag        the cap isn't served (its flag off, or CAP_READY false), or the route's own switch is off: 404
 *                   unknown_endpoint, and nothing else is touched
 *    2. token       bearer, by hash; the product isn't disabled, failed or taken down, and its owner isn't banned
 *    3. marker      the token has cap:<id>, and the product's manifest allows it (allowedCapIds)
 *    4. builder     a cap that needs a signed-in builder (CAP_NEEDS_BUILDER): the product's owner is one, not the shared
 *                   guest and not banned
 *    5. principal   who is asking (lib/caps/principal.ts), and whether the route lets them. A build token with no build
 *                   is refused here rather than falling back to live rows
 *    6. arguments   size, known keys only (others refused, not dropped), no private or localhost URLs
 *    7. rate        hitRateLimits per token, per IP (x-musemuse-client-ip), per subject, by minute or by UTC day
 *    8. in flight   acquireInFlight, for a call that holds something (a sandbox, a stream)
 *    9. quota       rows, bytes, files, daily counts
 *   10. budget      the token's daily spend, the cap's own daily dollars, the builder's (unit 1), DAILY_SPEND_CAP_USD
 *   11. reserve     reserveSpend writes the worst case as a usage row first, for a route that costs money
 *   12. work        in the build namespace b:<buildId> for a build token, `live` for a live one
 *   13. settle      settleSpend with what it really cost, the in-flight slot given back, then the answer
 */
export const CAP_CHECKS = ["flag", "token", "marker", "builder", "principal", "arguments", "rate", "in_flight", "quota", "budget", "reserve", "work", "settle"] as const;
export type CapCheck = (typeof CAP_CHECKS)[number];

/** The refusals cap routes give, with their status, in the tool gateway's shape (TOOL_ERRORS). */
export const CAP_ERRORS = {
  invalid_arguments: 400,
  cap_not_allowed: 403,
  sign_in_required: 403,
  rate_limited: 429,
  quota_exceeded: 429,
  budget_exceeded: 429,
  run_limit: 429,
  cap_failed: 502,
  caps_paused: 503,
} as const;
export type CapErrorCode = keyof typeof CAP_ERRORS;

const ERROR_TYPES: Record<CapErrorCode, GatewayErrorType> = {
  invalid_arguments: "invalid_request_error",
  cap_not_allowed: "permission_error",
  sign_in_required: "permission_error",
  rate_limited: "rate_limit_error",
  quota_exceeded: "insufficient_quota",
  budget_exceeded: "insufficient_quota",
  run_limit: "rate_limit_error",
  cap_failed: "server_error",
  caps_paused: "server_error",
};

export function capError(code: CapErrorCode, message: string, headers?: Record<string, string>): Response {
  return gatewayError(CAP_ERRORS[code], ERROR_TYPES[code], code, message, { retry: code === "rate_limited" || code === "cap_failed" ? undefined : false, headers });
}

export const unknownEndpoint = (what: string) => gatewayError(404, "not_found_error", "unknown_endpoint", `The gateway does not serve ${what}.`, { retry: false });

/** The token fields the gate needs. findToken's row has them. */
export interface CapToken {
  id: string;
  productId: string;
  scope: string;
  allowedModels: string[];
  dailyBudgetUsd: number;
  buildId: string | null;
}

/** The product behind a token, in one read: what checks 2 to 4 need. */
export interface CapProduct {
  status: ProductStatus;
  manifest: unknown;
  liveUrl: string | null;
  takenDownAt: Date | null;
  ownerId: string;
  ownerEmail: string;
  ownerIsAdmin: boolean;
  ownerBannedAt: Date | null;
}

export interface CapGateDeps {
  /** env.servedCaps: ready and switched on. */
  servedCaps(): readonly CapId[];
  findToken(token: string): Promise<CapToken | null>;
  product(productId: string): Promise<CapProduct | null>;
  adminEmails: readonly string[];
  hitRateLimits(keys: string[], windowStart: Date): Promise<Record<string, number>>;
  acquireInFlight?(key: string, limit: number, now: Date): Promise<Date | null>;
  releaseInFlight?(key: string, slot: Date): Promise<void>;
  /** For routes that spend (check 10). */
  tokenSpendToday?(tokenId: string): Promise<number>;
  platformSpendToday?(): Promise<number>;
  builderSpendToday?(userId: string): Promise<number>;
  dailySpendCapUsd?: number;
  /** TRUST_SIGNED_IN_CAPS's TRUST_BUILDER_DAILY_USD, when that flag is on. */
  builderDailyUsd?: number | null;
  reserveSpend?(ctx: UsageContext, model: string | null, costUsd: number): Promise<string>;
  settleSpend?(reservationId: string, item: ModelUsage | null): Promise<void>;
  now?(): Date;
}

/** One rate limit: `window` minute or UTC day. `who` says in the refusal whose limit it is. */
export interface CapLimit {
  key: string;
  limit: number;
  window: "minute" | "day";
  who: string;
}

export interface CapContext<A> {
  req: Request;
  token: CapToken;
  product: CapProduct;
  caller: CapCaller;
  args: A;
  /** b:<buildId> for a build token, `live` for a live one. */
  namespace: string;
  now: Date;
}

export type CapStage = Pick<CapContext<unknown>, "req" | "token" | "product" | "caller" | "now">;

export interface CapSpend {
  source: string;
  endpoint: string;
  model: string | null;
  worstCaseUsd(ctx: CapContext<unknown>): number;
  /** The cap's own daily dollars and what it has spent today. 0 pauses it (caps_paused). */
  capDailyUsd?: number;
  capSpendToday?(): Promise<number>;
}

export interface CapWorkResult {
  response: Response;
  /** What the call really cost, for settleSpend. Null or absent removes the reservation. */
  usage?: ModelUsage | null;
}

export interface CapRoute<A> {
  cap: CapId;
  /** What the 404 names, like "/data". */
  what: string;
  /** A switch of the route's own on top of the cap's flag (DATA_SIGN_IN for the sign-in routes). */
  enabled?(): boolean;
  /** Token scopes the route takes. Both by default. */
  scopes?: readonly ("build" | "live")[];
  /** Check 5. Null lets the caller on. */
  allow?(stage: CapStage): Response | null;
  /** Check 6: the request's arguments, checked, or the refusal. */
  args(stage: CapStage): Promise<A | Response>;
  /** Check 7. */
  limits?(stage: CapStage & { args: A }): CapLimit[];
  /** Check 8. */
  inFlight?(stage: CapStage & { args: A }): { key: string; limit: number } | null;
  /** Check 9. */
  quota?(ctx: CapContext<A>): Promise<Response | null>;
  /** Checks 10, 11 and 13, for a route that costs money. */
  spend?: CapSpend;
  /** Check 12. */
  work(ctx: CapContext<A>): Promise<Response | CapWorkResult>;
}

const minuteWindow = (now: Date) => new Date(Math.floor(now.getTime() / 60_000) * 60_000);
/** A day counter's window ends at the next UTC midnight: the cleanup cron deletes windows that started over an hour ago. */
export const dayWindow = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

const productDisabled = () => gatewayError(403, "permission_error", "product_disabled", "This product is turned off on Muse Muse.", { retry: false });

/** Runs CAP_CHECKS for one call. Every refusal is the gateway's JSON error; an unexpected failure is a 500, never a stack. */
export async function runCapGate<A>(req: Request, deps: CapGateDeps, route: CapRoute<A>): Promise<Response> {
  // 1. flag
  if (!deps.servedCaps().includes(route.cap) || (route.enabled && !route.enabled())) return unknownEndpoint(route.what);
  let release: (() => Promise<void>) | null = null;
  try {
    // 2. token
    const raw = parseBearer(req.headers.get("authorization"));
    const token = raw ? await deps.findToken(raw) : null;
    if (!token) {
      return gatewayError(401, "authentication_error", "invalid_token", 'Send the product\'s token as "Authorization: Bearer <PRODUCT_TOKEN>".', { retry: false });
    }
    if (route.scopes && !route.scopes.includes(token.scope as "build" | "live")) {
      return capError("cap_not_allowed", token.scope === "build" ? "A build can't use this. Its tests have their own route." : "Only a build's own token can use this.");
    }
    const product = await deps.product(token.productId);
    if (!product || product.status === "disabled" || product.status === "failed" || product.takenDownAt || product.ownerBannedAt) return productDisabled();
    // 3. marker
    if (!allowedCapIds(token, product.manifest).includes(route.cap)) {
      return capError("cap_not_allowed", `This product wasn't built with the ${route.cap} service.`);
    }
    // 4. builder
    if (CAP_NEEDS_BUILDER[route.cap]) {
      const tier = builderTier({ email: product.ownerEmail, isAdmin: product.ownerIsAdmin && deps.adminEmails.includes(product.ownerEmail), bannedAt: product.ownerBannedAt });
      if (!tierMayUseBuilderCaps(tier)) return capError("sign_in_required", "This service needs a product made by someone signed in to Muse Muse.");
    }
    // 5. principal
    const now = deps.now?.() ?? new Date();
    if (token.scope === "build" && !token.buildId) return capError("cap_not_allowed", "This build token isn't tied to a build, so it has no test space to use.");
    const caller = resolveCapCaller(req, token, now);
    const stage: CapStage = { req, token, product, caller, now };
    const refused = route.allow?.(stage);
    if (refused) return refused;
    // 6. arguments
    const args = await route.args(stage);
    if (args instanceof Response) return args;
    // 7. rate
    const limits = route.limits?.({ ...stage, args }) ?? [];
    if (limits.length) {
      const over = await limitHit(limits, deps, now);
      if (over) return over;
    }
    // 8. in flight
    const slot = route.inFlight?.({ ...stage, args });
    if (slot && deps.acquireInFlight && deps.releaseInFlight) {
      const held = await deps.acquireInFlight(slot.key, slot.limit, now);
      if (!held) return capError("rate_limited", `Too many of these are running at once: at most ${slot.limit}. Try again in a minute.`, { "retry-after": "30" });
      const releaseInFlight = deps.releaseInFlight;
      release = () => releaseInFlight(slot.key, held);
    }
    const ctx: CapContext<A> = { ...stage, args, namespace: token.scope === "build" ? buildNamespace(token.buildId!) : "live" };
    // 9. quota
    const full = await route.quota?.(ctx);
    if (full) return full;
    // 10. budget, 11. reserve
    let reservation: string | null = null;
    if (route.spend) {
      const over = await budgetRefusal(ctx as CapContext<unknown>, route.spend, deps);
      if (over) return over;
      if (deps.reserveSpend) {
        const usage: UsageContext = { source: route.spend.source as UsageContext["source"], endpoint: route.spend.endpoint, productId: token.productId, buildId: token.buildId, tokenId: token.id };
        reservation = await deps.reserveSpend(usage, route.spend.model, route.spend.worstCaseUsd(ctx as CapContext<unknown>));
      }
    }
    // 12. work
    let result: Response | CapWorkResult;
    try {
      result = await route.work(ctx);
    } catch (err) {
      if (reservation && deps.settleSpend) await deps.settleSpend(reservation, null).catch(() => undefined);
      throw err;
    }
    // 13. settle
    const done = result instanceof Response ? { response: result } : result;
    if (reservation && deps.settleSpend) await deps.settleSpend(reservation, done.usage ?? null);
    return done.response;
  } catch (err) {
    console.error(`[caps] ${route.cap} ${route.what} failed:`, err instanceof Error ? err.message : "unknown");
    return capError("cap_failed", "The platform service hit an unexpected error. Try again.");
  } finally {
    if (release) await release().catch(() => undefined);
  }
}

async function limitHit(limits: CapLimit[], deps: CapGateDeps, now: Date): Promise<Response | null> {
  for (const window of ["minute", "day"] as const) {
    const these = limits.filter((l) => l.window === window);
    if (!these.length) continue;
    const start = window === "minute" ? minuteWindow(now) : dayWindow(now);
    const counts = await deps.hitRateLimits(these.map((l) => l.key), start);
    const over = these.find((l) => (counts[l.key] ?? 0) > l.limit);
    if (!over) continue;
    const retry = window === "minute" ? Math.max(1, Math.ceil((start.getTime() + 60_000 - now.getTime()) / 1000)) : Math.max(60, Math.ceil((start.getTime() - now.getTime()) / 1000));
    return capError(
      "rate_limited",
      window === "minute" ? `Too many requests from ${over.who}: the limit is ${over.limit} a minute. Try again in ${retry} s.` : `${over.who[0]!.toUpperCase()}${over.who.slice(1)} reached today's limit of ${over.limit}. It resets at 00:00 UTC.`,
      { "retry-after": String(retry) },
    );
  }
  return null;
}

async function budgetRefusal(ctx: CapContext<unknown>, spend: CapSpend, deps: CapGateDeps): Promise<Response | null> {
  if (spend.capDailyUsd === 0) return capError("caps_paused", "This service is paused on Muse Muse today.");
  const worst = spend.worstCaseUsd(ctx);
  if (spend.capDailyUsd !== undefined && spend.capSpendToday && (await spend.capSpendToday()) + worst > spend.capDailyUsd) {
    return capError("budget_exceeded", "This service has used its daily budget on Muse Muse. It resets at 00:00 UTC.");
  }
  if (deps.tokenSpendToday && (await deps.tokenSpendToday(ctx.token.id)) + worst > ctx.token.dailyBudgetUsd) {
    return capError("budget_exceeded", "This product has used its daily budget. It resets at 00:00 UTC.");
  }
  if (deps.builderDailyUsd !== undefined && deps.builderDailyUsd !== null && deps.builderSpendToday && ctx.token.scope === "live") {
    if ((await deps.builderSpendToday(ctx.product.ownerId)) + worst > deps.builderDailyUsd) {
      return capError("budget_exceeded", "The person who made this product has used their daily budget across their products. It resets at 00:00 UTC.");
    }
  }
  if (deps.platformSpendToday && deps.dailySpendCapUsd !== undefined && (await deps.platformSpendToday()) + worst > deps.dailySpendCapUsd) {
    return capError("budget_exceeded", "Muse Muse has reached its daily budget. Try again tomorrow.");
  }
  return null;
}

/** Reads a JSON object body of at most `max` bytes, or the refusal. */
export async function readJsonBody(req: Request, max: number): Promise<Record<string, unknown> | Response> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return capError("invalid_arguments", "The request is too big.");
  const raw = await req.arrayBuffer();
  if (raw.byteLength > max) return capError("invalid_arguments", "The request is too big.");
  if (!raw.byteLength) return {};
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Falls through to the same answer.
  }
  return capError("invalid_arguments", "The request body must be a JSON object.");
}

/** Refuses keys a route doesn't know, by name, rather than dropping them. */
export function unknownKeys(body: Record<string, unknown>, known: readonly string[]): Response | null {
  const extra = Object.keys(body).filter((k) => !known.includes(k));
  return extra.length ? capError("invalid_arguments", `Unknown ${extra.length === 1 ? "field" : "fields"}: ${extra.slice(0, 5).join(", ")}.`) : null;
}

/** True for a URL a cap must never be pointed at: not https or http, or a private, loopback or link-local host. */
export function privateUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return true;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return true;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  if (host === "::1" || host === "::" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host) || host.startsWith("::ffff:")) return true;
  return false;
}
