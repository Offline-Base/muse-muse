import { dataDeps } from "@/lib/caps/data/deps";
import type { LiveDeps } from "@/lib/caps/live/handler";
import { buildPreviewOrigin, liveChanges } from "@/lib/caps/live/store";
import { env } from "@/lib/env";
import { adjustCounter } from "@/lib/gateway/store";

/** The live routes' real wiring: the data cap's (who may read what comes from there), and the flags, read per request. */
export function liveDeps(): LiveDeps {
  const data = dataDeps();
  return {
    servedCaps: data.servedCaps,
    findToken: data.findToken,
    product: data.product,
    adminEmails: data.adminEmails,
    hitRateLimits: data.hitRateLimits,
    acquireInFlight: data.acquireInFlight!,
    releaseInFlight: data.releaseInFlight!,
    adjustCounter,
    rules: data.rules,
    updatesOn: () => env.liveUpdates,
    changes: liveChanges,
    buildPreviewOrigin,
  };
}
