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
