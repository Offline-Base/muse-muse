import { findSessionGatewayToken } from "@/lib/caps/code/musecode/gateway";
import { findPowerKey, isPowerKey } from "@/lib/caps/platform/gateway";
import { sessionSpendUsd } from "@/lib/caps/code/musecode/store";
import { familySpendToday } from "@/lib/caps/code/musecode/store";
import { isSessionToken } from "@/lib/caps/code/musecode/token";
import { jobCallOf } from "@/lib/caps/jobs/budget";
import { jobCallDeps } from "@/lib/caps/jobs/deps";
import { liveCaptionDeps } from "@/lib/caps/live/caption-deps";
import { buildTestModel, contributorBuildsOn, env } from "@/lib/env";
import type { GatewayDeps } from "@/lib/gateway/handler";
import { UPSTREAM_BASE_URL } from "@/lib/gateway/policy";
import {
  acquireInFlight,
  adjustCounter,
  counterValue,
  hitRateLimits,
  productSlugById,
  productStatusById,
  releaseInFlight,
  reserveCounter,
  reserveSpend,
  settleSpend,
} from "@/lib/gateway/store";
import { findToken } from "@/lib/gateway/tokens";
import { trustCheck, trustGatewayDeps } from "@/lib/trust/gateway";
import { platformSpendToday, recordUsage, tokenSpendToday } from "@/lib/usage";

/** The real gateway wiring: Postgres, the master key and the platform fetch. `defer` is Next's after(). */
export function gatewayDeps(defer: GatewayDeps["defer"]): GatewayDeps {
  return {
    findToken,
    productStatus: productStatusById,
    ...(contributorBuildsOn() ? { productSlug: productSlugById } : {}),
    tokenSpendToday,
    // Wave 3, unit 9 (docs/CAPABILITIES.md, 15b): only while MUSE_CODE_ENABLED is on, so the deps are today's without it.
    ...museCodeDeps(),
    // Platform powers (docs/PLATFORM_POWERS.md): only while the cap is served. Last, so it wraps the lookup above.
    ...powerKeyDeps(),
    platformSpendToday,
    dailySpendCapUsd: env.dailySpendCapUsd,
    fitOutputToBudget: env.engineFitOutput,
    // Wave 3, unit 1 (docs/CAPABILITIES.md, section 7): only with their flags on, so the deps are today's without them.
    ...trustDeps(),
    // Wave 3, unit 6 (docs/CAPABILITIES.md, section 12): only while the jobs cap is served.
    ...jobDeps(),
    // Wave 3, unit 7 (docs/CAPABILITIES.md, section 13): only while the live cap is served.
    ...liveDeps(),
    hitRateLimits,
    acquireInFlight,
    releaseInFlight,
    reserveSpend,
    settleSpend,
    recordUsage,
    reserveCounter,
    adjustCounter,
    counterValue,
    fetch: (input, init) => fetch(input, init),
    upstreamKey: () => env.modelApiKey,
    buildTestModel: buildTestModel(),
    contributorRuntime: contributorBuildsOn(),
    upstreamBaseUrl: UPSTREAM_BASE_URL,
    gatewayUrl: env.gatewayUrl,
    defer,
  };
}

/** A job's model calls, only while the jobs cap is served. */
function jobDeps(): Pick<GatewayDeps, "jobCall"> {
  if (!env.servedCaps.includes("jobs")) return {};
  const deps = jobCallDeps();
  return { jobCall: (req, token, now) => jobCallOf(req, { productId: token.productId, scope: token.scope, buildId: (token as { buildId?: string | null }).buildId ?? null }, deps, now) };
}

/** Near-live captions' part of the gateway, only while the live cap is served. */
function liveDeps(): Pick<GatewayDeps, "liveCaptions"> {
  const liveCaptions = liveCaptionDeps();
  return liveCaptions ? { liveCaptions } : {};
}

/** The trust check and the Spark switch, each only while its flag is on. */
function trustDeps(): Pick<GatewayDeps, "trustCheck" | "sparkToWonder"> {
  const trust = trustGatewayDeps();
  return {
    ...(trust ? { trustCheck: (token: Parameters<NonNullable<GatewayDeps["trustCheck"]>>[0]) => trustCheck(token, trust) } : {}),
    ...(env.trustSparkToWonder ? { sparkToWonder: true } : {}),
  };
}

/** Metered keys (scope power_key) have their own lookup, and otherwise the lookup is as it was. */
function powerKeyDeps(): Pick<GatewayDeps, "findToken"> | Record<string, never> {
  if (!env.servedCaps.includes("platform")) return {};
  const before = museCodeDeps().findToken ?? findToken;
  return { findToken: (raw) => (isPowerKey(raw) ? findPowerKey(raw, { total: sessionSpendUsd, today: tokenSpendToday }) : before(raw)) };
}

/**
 * Muse Code sessions' tokens (scope code_session) are found by their own lookup, and a token's spend today counts the
 * sessions it started, so they share its daily budget. findToken never returns a session token, with this on or off.
 */
function museCodeDeps(): Pick<GatewayDeps, "findToken" | "tokenSpendToday"> | Record<string, never> {
  if (!env.museCodeEnabled) return {};
  return {
    findToken: (raw) => (isSessionToken(raw) ? findSessionGatewayToken(raw) : findToken(raw)),
    tokenSpendToday: (tokenId) => familySpendToday(tokenId),
  };
}
