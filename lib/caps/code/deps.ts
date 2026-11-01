import { lookup } from "node:dns/promises";
import type { CodeDeps } from "@/lib/caps/code/handler";
import { launchSession } from "@/lib/caps/code/session";
import { codeSpendToday, recordExecRun } from "@/lib/caps/code/store";
import { capProduct, capToken } from "@/lib/caps/store";
import { env } from "@/lib/env";
import { acquireInFlight, adjustCounter, hitRateLimits, releaseInFlight, reserveCounter, reserveSpend, settleSpend } from "@/lib/gateway/store";
import { buildFixtures } from "@/lib/tools/store";
import { builderSpendToday } from "@/lib/trust/spend";
import { platformSpendToday, tokenSpendToday } from "@/lib/usage";

/** The code cap's real wiring: Postgres, Vercel Sandbox and the flags, read per request. */
export function codeDeps(): CodeDeps {
  return {
    servedCaps: () => env.servedCaps,
    findToken: capToken,
    product: capProduct,
    adminEmails: env.adminEmails,
    hitRateLimits,
    acquireInFlight,
    releaseInFlight,
    reserveCounter,
    adjustCounter,
    tokenSpendToday,
    platformSpendToday,
    builderSpendToday: (userId) => builderSpendToday(userId),
    builderDailyUsd: env.trustSignedInCaps ? env.trustBuilderDailyUsd : null,
    dailySpendCapUsd: env.dailySpendCapUsd,
    reserveSpend,
    settleSpend,
    execOn: () => env.codeExec,
    browseOn: () => env.codeBrowse,
    visitorsOn: () => env.codeExecVisitors,
    execDailyUsd: () => env.codeExecDailyUsd,
    browseDailyUsd: () => env.codeBrowseDailyUsd,
    spendToday: codeSpendToday,
    execSnapshotId: () => env.codeExecSnapshotId,
    browseSnapshotId: () => env.builderSnapshotId ?? null,
    launch: launchSession,
    recordRun: recordExecRun,
    lookupHost: async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
    buildFixtures,
  };
}
