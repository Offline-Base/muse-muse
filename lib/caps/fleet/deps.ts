import type { FleetDeps } from "@/lib/caps/fleet/handler";
import { fleetSettings } from "@/lib/caps/fleet/settings";
import { capProduct, capToken } from "@/lib/caps/store";
import { env } from "@/lib/env";
import { acquireInFlight, hitRateLimits, releaseInFlight } from "@/lib/gateway/store";
import { recordUsage } from "@/lib/usage";

export function fleetDeps(): FleetDeps {
  return {
    on: () => env.fleetProducts,
    allProducts: () => env.fleetAllProducts,
    settings: () => fleetSettings(),
    adminEmails: env.adminEmails,
    findToken: capToken,
    product: capProduct,
    hitRateLimits,
    acquireInFlight,
    releaseInFlight,
    recordUsage,
    fetch: (url, init) => fetch(url, init),
  };
}
