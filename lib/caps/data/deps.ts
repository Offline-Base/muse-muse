import { dataBlock } from "@/lib/caps/data/brief";
import type { DataDeps } from "@/lib/caps/data/handler";
import type { PasskeyDeps } from "@/lib/caps/data/passkeys";
import { dataStore, liveBrief } from "@/lib/caps/data/store";
import { createEndUser, findPasskey, productForSignIn, usePasskey } from "@/lib/caps/data/users";
import { collectionRules, narrowCollectionRules } from "@/lib/caps/data/types";
import { buildBrief, capProduct, capToken, productSlug } from "@/lib/caps/store";
import { env } from "@/lib/env";
import { acquireInFlight, hitRateLimits, releaseInFlight, reserveCounter } from "@/lib/gateway/store";

/**
 * The data cap's real wiring: Postgres and the flags, read per request. Data spends nothing at Meta, so the gate's
 * money deps aren't wired: rows count in rate_limits day windows and product_data_counts instead.
 */
export function dataDeps(): DataDeps {
  return {
    servedCaps: () => env.servedCaps,
    findToken: capToken,
    product: capProduct,
    adminEmails: env.adminEmails,
    hitRateLimits,
    acquireInFlight,
    releaseInFlight,
    reserveCounter,
    store: dataStore,
    quotas: () => ({ productRows: env.dataProductRows, productBytes: env.dataProductMb * 1024 * 1024, dailyWrites: env.dataDailyWrites }),
    signInOn: () => env.dataSignIn,
    async rules(token, product) {
      // A build follows its own brief. A live product follows the brief it shipped with, which the platform wrote, and
      // its manifest (which the product wrote) can only narrow that: never add a collection, change a scope or widen
      // who writes, whatever verify said (docs/CAPABILITIES.md, 9a).
      if (token.scope === "build") return token.buildId ? collectionRules(dataBlock((await buildBrief(token.buildId)) as object | null)) : null;
      return narrowCollectionRules(collectionRules(dataBlock((await liveBrief(token.productId)) as object | null)), collectionRules((product.manifest as { data?: unknown } | null)?.data));
    },
    platformUrl: env.platformUrl,
    productSlug,
  };
}

/** The passkey routes' wiring. The relying party is the platform's own host. */
export function passkeyDeps(): PasskeyDeps {
  const platform = new URL(env.platformUrl);
  return {
    enabled: () => env.servedCaps.includes("data") && env.dataSignIn,
    origin: platform.origin,
    rpId: platform.hostname,
    productForSignIn,
    reserveCounter,
    hitRateLimits,
    createEndUser,
    findPasskey,
    usePasskey,
  };
}
