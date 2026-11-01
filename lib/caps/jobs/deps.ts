import { capProduct, capToken } from "@/lib/caps/store";
import type { JobCallDeps } from "@/lib/caps/jobs/budget";
import type { JobsCronDeps } from "@/lib/caps/jobs/cron";
import type { HookDeps, JobsDeps } from "@/lib/caps/jobs/handler";
import {
  addNoticeOnce,
  addRunCost,
  claimQueued,
  expireStale,
  jobsStore,
  liveTokenOf,
  pauseAbsent,
  queueDueSchedules,
  retryOrFail,
  stopRunForBudget,
} from "@/lib/caps/jobs/store";
import { env } from "@/lib/env";
import { adjustCounter, counterValue, hitRateLimits, reserveCounter } from "@/lib/gateway/store";

/** The jobs cap's real wiring: Postgres, the flags and the outside world, read per request. */
export function jobsDeps(): JobsDeps {
  return {
    servedCaps: () => env.servedCaps,
    findToken: capToken,
    product: capProduct,
    adminEmails: env.adminEmails,
    hitRateLimits,
    store: jobsStore,
    webhooksOn: () => env.jobsWebhooks,
    runUsd: () => env.jobsRunUsd,
    gatewayUrl: env.gatewayUrl,
  };
}

export function hookDeps(): HookDeps {
  return {
    servedCaps: () => env.servedCaps,
    product: capProduct,
    adminEmails: env.adminEmails,
    hitRateLimits,
    store: jobsStore,
    webhooksOn: () => env.jobsWebhooks,
    runUsd: () => env.jobsRunUsd,
    liveToken: liveTokenOf,
  };
}

export function jobCallDeps(): JobCallDeps {
  return {
    getRun: jobsStore.getRun,
    addRunCost,
    stopRun: stopRunForBudget,
    addNotice: jobsStore.addNotice,
    dailyUsd: () => env.jobsDailyUsd,
    counterValue,
    adjustCounter,
  };
}

export function jobsCronDeps(): JobsCronDeps {
  return {
    dailyRuns: () => env.jobsDailyRuns,
    runUsd: () => env.jobsRunUsd,
    pauseDays: () => env.jobsPauseDays,
    pauseAbsent,
    queueDueSchedules,
    expireStale,
    claimQueued,
    retryOrFail,
    addNoticeOnce,
    reserveCounter,
    adjustCounter,
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
  };
}
