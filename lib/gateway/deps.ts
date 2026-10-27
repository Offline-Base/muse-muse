import { env } from "@/lib/env";
import type { GatewayDeps } from "@/lib/gateway/handler";
import { UPSTREAM_BASE_URL } from "@/lib/gateway/policy";
import { hitRateLimits, productStatusById } from "@/lib/gateway/store";
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
    hitRateLimits,
    recordUsage,
    fetch: (input, init) => fetch(input, init),
    upstreamKey: () => env.modelApiKey,
    upstreamBaseUrl: UPSTREAM_BASE_URL,
    gatewayUrl: env.gatewayUrl,
    defer,
  };
}
