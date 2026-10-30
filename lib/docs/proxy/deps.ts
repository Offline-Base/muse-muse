import { env } from "@/lib/env";
import { deleteUpstreamObject, retrieveUpstreamResponse, type DocsCleanupDeps } from "@/lib/docs/proxy/cleanup";
import {
  adjustCounter,
  claimDocsHold,
  counterValue,
  forgetDocsObject,
  forgetDocsObjects,
  ownedDocsIds,
  pendingDocsHold,
  pendingDocsHolds,
  recordDocsObject,
  reserveCounter,
  staleDocsObjects,
  visitorDocsObjects,
} from "@/lib/docs/proxy/store";
import type { DocsConfig, DocsDeps } from "@/lib/docs/proxy/types";
import { newVisitorId } from "@/lib/docs/proxy/visitor";
import { UPSTREAM_BASE_URL } from "@/lib/gateway/policy";
import { acquireInFlight, hitRateLimits, releaseInFlight, reserveSpend, settleSpend } from "@/lib/gateway/store";
import { docsSpendToday, platformSpendToday, recordUsage } from "@/lib/usage";

/** The limits as the environment sets them now (lib/env.ts), so a deploy or a test server can change them. */
export function docsConfig(): DocsConfig {
  return {
    live: env.docsLive,
    perIpRequestsPerMinute: env.docsIpRequestsPerMinute,
    perIpRequestsPerDay: env.docsIpRequestsPerDay,
    perIpInFlight: env.docsIpInFlight,
    perIpDailyUsd: env.docsIpDailyUsd,
    docsDailyCapUsd: env.docsDailySpendCapUsd,
    platformDailyCapUsd: env.dailySpendCapUsd,
  };
}

/** The real docs proxy wiring: Postgres, the docs key, the platform fetch. `defer` is Next's after(). */
export function docsDeps(defer: DocsDeps["defer"]): DocsDeps {
  return {
    config: docsConfig(),
    hitRateLimits,
    acquireInFlight,
    releaseInFlight,
    reserveCounter,
    adjustCounter,
    counterValue,
    docsSpendToday,
    platformSpendToday,
    reserveSpend,
    settleSpend,
    recordUsage,
    recordObject: recordDocsObject,
    pendingHold: pendingDocsHold,
    claimHold: claimDocsHold,
    ownedIds: ownedDocsIds,
    visitorObjects: visitorDocsObjects,
    forgetObject: forgetDocsObject,
    fetch: (input, init) => fetch(input, init),
    upstreamKey: () => env.docsModelApiKey,
    upstreamBaseUrl: UPSTREAM_BASE_URL,
    defer,
    newVisitorId,
  };
}

/**
 * The hourly cleanup's docs step: settles finished background responses from Meta's usage, then deletes at Meta with
 * the docs key, then here.
 */
export function docsCleanupDeps(): DocsCleanupDeps {
  return {
    stale: staleDocsObjects,
    deleteUpstream: (kind, id) => deleteUpstreamObject(fetch, UPSTREAM_BASE_URL, env.docsModelApiKey, kind, id),
    forget: forgetDocsObjects,
    pendingHolds: pendingDocsHolds,
    retrieveResponse: (id) => retrieveUpstreamResponse(fetch, UPSTREAM_BASE_URL, env.docsModelApiKey, id),
    claimHold: claimDocsHold,
    settleSpend,
    recordUsage,
    adjustCounter,
  };
}
