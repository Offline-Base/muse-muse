import { lookup } from "node:dns/promises";
import { getSessionUser } from "@/lib/auth";
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
import { composioApi, type ComposioApi } from "@/lib/tools/composio/client";
import { clearOffProductAccounts, revokeConnections, type ToolsDeps } from "@/lib/tools/handler";
import {
  activeConnections,
  buildFixtures,
  connectionsOfOffProducts,
  deleteToolSession,
  findToolSession,
  markConnectionRevoked,
  ownerSessionsOfOffProducts,
  productInfo,
  revokeConnection,
  saveConnection,
  saveToolSession,
  toolsSpendToday,
} from "@/lib/tools/store";
import { trustCheck, trustGatewayDeps } from "@/lib/trust/gateway";
import { platformSpendToday, recordUsage, tokenSpendToday } from "@/lib/usage";

/** One client per instance, built on first use, so the SDK only loads when a live tool runs. */
let client: ComposioApi | null = null;

function composio(): ComposioApi | null {
  if (!env.composioConfigured) return null;
  return (client ??= composioApi(() => env.composioApiKey));
}

/** The real wiring: Postgres, the platform's Composio key and the flags, read per request. */
export function toolsDeps(): ToolsDeps {
  // Wave 3, unit 1 (docs/CAPABILITIES.md, section 7): only with TRUST_REPORTS or TRUST_SIGNED_IN_CAPS on.
  const trust = trustGatewayDeps();
  return {
    ...(trust ? { trustCheck: (token: Parameters<NonNullable<ToolsDeps["trustCheck"]>>[0]) => trustCheck(token, trust) } : {}),
    agentsEnabled: env.agentsEnabled,
    personalEnabled: env.composioPersonalEnabled,
    // Wave 3, unit 3: the owner pass for products that save data. False with the data cap off.
    // Wave 3, unit 4: and for products that keep files, while the files cap is served.
    // Unit 9 (15b): and for products that run Muse Code sessions, which are owner-only. False with MUSE_CODE_ENABLED off.
    // Unit 13: and for board tools, which only the owner reaches unless the owner opens the board to visitors.
    ownerPassForCaps: env.servedCaps.includes("data") || env.servedCaps.includes("files") || (env.servedCaps.includes("code") && env.museCodeEnabled) || (env.servedCaps.includes("hardware") && env.hardwareBoardToolsUsable),
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
    platformUserId: async () => (await getSessionUser())?.id ?? null,
    lookupHost: async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
  };
}

/** Enough for one run to stay well inside the cron route's time. The rest wait for the next hour. */
const OFF_SESSIONS_PER_RUN = 50;

/** The hourly cleanup's task: a product that is off keeps no account connected. Returns how many it revoked. */
export async function revokeDisabledProductConnections(): Promise<number> {
  // With no key there is no reaching the accounts, so the rows stay and a later run tries again.
  const api = composio();
  if (!api) return 0;
  const revoked = await revokeConnections(api, await connectionsOfOffProducts(), markConnectionRevoked);
  return revoked + (await clearOffProductAccounts(api, await ownerSessionsOfOffProducts(OFF_SESSIONS_PER_RUN), deleteToolSession));
}
