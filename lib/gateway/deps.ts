import { findSessionGatewayToken } from "@/lib/caps/code/musecode/gateway";
import { familySpendToday } from "@/lib/caps/code/musecode/store";
import { isSessionToken } from "@/lib/caps/code/musecode/token";
import { env, testModel } from "@/lib/env";
import type { GatewayDeps } from "@/lib/gateway/handler";
import { UPSTREAM_BASE_URL } from "@/lib/gateway/policy";
import {
  acquireInFlight,
  adjustCounter,
  counterValue,
  hitRateLimits,
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
    tokenSpendToday,
    // Wave 3, unit 9 (docs/CAPABILITIES.md, 15b): only while MUSE_CODE_ENABLED is on, so the deps are today's without it.
    ...museCodeDeps(),
    platformSpendToday,
    dailySpendCapUsd: env.dailySpendCapUsd,
    fitOutputToBudget: env.engineFitOutput,
    // Wave 3, unit 1 (docs/CAPABILITIES.md, section 7): only with their flags on, so the deps are today's without them.
    ...trustDeps(),
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
    buildTestModel: testModel(),
    upstreamBaseUrl: UPSTREAM_BASE_URL,
    gatewayUrl: env.gatewayUrl,
    defer,
  };
}

/** The trust check and the Spark switch, each only while its flag is on. */
function trustDeps(): Pick<GatewayDeps, "trustCheck" | "sparkToWonder"> {
  const trust = trustGatewayDeps();
  return {
    ...(trust ? { trustCheck: (token: Parameters<NonNullable<GatewayDeps["trustCheck"]>>[0]) => trustCheck(token, trust) } : {}),
    ...(env.trustSparkToWonder ? { sparkToWonder: true } : {}),
  };
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
