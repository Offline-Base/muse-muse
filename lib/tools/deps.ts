import { env } from "@/lib/env";
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
import { classifyFailure, composioApi, type ComposioApi } from "@/lib/tools/composio/client";
import type { ToolsDeps } from "@/lib/tools/handler";
import {
  activeConnections,
  buildFixtures,
  connectionsOfOffProducts,
  findToolSession,
  markConnectionRevoked,
  productInfo,
  revokeConnection,
  saveConnection,
  saveToolSession,
  toolsSpendToday,
} from "@/lib/tools/store";
import { platformSpendToday, recordUsage, tokenSpendToday } from "@/lib/usage";

/** One client per instance, built on first use, so the SDK only loads when a live tool runs. */
let client: ComposioApi | null = null;

function composio(): ComposioApi | null {
  if (!env.composioConfigured) return null;
  return (client ??= composioApi(() => env.composioApiKey));
}

/** The real wiring: Postgres, the platform's Composio key and the flags, read per request. */
export function toolsDeps(): ToolsDeps {
  return {
    agentsEnabled: env.agentsEnabled,
    personalEnabled: env.composioPersonalEnabled,
    findToken,
    productStatus: productStatusById,
    productInfo,
    hitRateLimits,
    acquireInFlight,
    releaseInFlight,
    reserveCounter,
    adjustCounter,
    counterValue,
    tokenSpendToday,
    platformSpendToday,
    toolsSpendToday,
    dailySpendCapUsd: env.dailySpendCapUsd,
    toolsDailySpendCapUsd: env.toolsDailySpendCapUsd,
    toolsDailyCalls: env.toolsDailyCalls,
    reserveSpend,
    settleSpend,
    recordUsage,
    buildFixtures,
    findToolSession,
    saveToolSession,
    activeConnections,
    saveConnection,
    revokeConnection,
    composio,
    platformUrl: env.platformUrl,
  };
}

/** The hourly cleanup's task: a product that is off keeps no account connected. Returns how many it revoked. */
export async function revokeDisabledProductConnections(): Promise<number> {
  // With no key there is no reaching the accounts, so the rows stay and a later run tries again.
  const api = composio();
  if (!api) return 0;
  let revoked = 0;
  for (const row of await connectionsOfOffProducts()) {
    try {
      await api.deleteConnection(row.connectedAccountId);
    } catch (err) {
      const failure = classifyFailure(err);
      if (!(failure.kind === "refused" && failure.status === 404)) {
        console.error("[tools] revoking a connection failed, so the next run tries again.");
        continue;
      }
    }
    await markConnectionRevoked(row.id);
    revoked += 1;
  }
  return revoked;
}
