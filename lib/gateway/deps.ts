import { liveCaptionDeps } from "@/lib/caps/live/caption-deps";
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
    platformSpendToday,
    dailySpendCapUsd: env.dailySpendCapUsd,
    fitOutputToBudget: env.engineFitOutput,
    // Wave 3, unit 1 (docs/CAPABILITIES.md, section 7): only with their flags on, so the deps are today's without them.
    ...trustDeps(),
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
    buildTestModel: testModel(),
    upstreamBaseUrl: UPSTREAM_BASE_URL,
    gatewayUrl: env.gatewayUrl,
    defer,
  };
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
