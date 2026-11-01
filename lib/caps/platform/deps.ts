import { and, eq, isNull } from "drizzle-orm";
import { start } from "workflow/api";
import { museCodeDeps } from "@/lib/caps/code/musecode/deps";
import { powerChildMark, powerParentOf, isPowerChild } from "@/lib/caps/platform/child";
import { platformBlock } from "@/lib/caps/platform/brief";
import type { PlatformDeps } from "@/lib/caps/platform/handler";
import { capProduct, capToken } from "@/lib/caps/store";
import { db, schema } from "@/lib/db/client";
import { DEFAULT_PLATFORM_MODEL, env, testModel } from "@/lib/env";
import { adjustCounter, counterValue, hitRateLimits, reserveCounter } from "@/lib/gateway/store";
import { hashToken } from "@/lib/gateway/tokens";
import { buildProduct } from "@/lib/pipeline/workflow";
import { attachRun, insertBuild, markStartFailed } from "@/lib/pipeline/records";
import { checkBuildAllowed } from "@/lib/quota";
import { platformSpendToday } from "@/lib/usage";


export const POWER_KEY_SCOPE = "power_key";

/** Platform powers' real wiring (docs/PLATFORM_POWERS.md), per request. */
export function platformDeps(): PlatformDeps {
  return {
    servedCaps: () => env.servedCaps,
    findToken: capToken,
    product: capProduct,
    adminEmails: env.adminEmails,
    hitRateLimits,
    platformSpendToday,
    dailySpendCapUsd: env.dailySpendCapUsd,
    productDailyUsd: env.powersProductDailyUsd,
    allDailyUsd: env.powersAllDailyUsd,
    keyMaxUsd: env.powersKeyMaxUsd,
    buildUsd: env.powersBuildUsd,
    reserveCounter,
    adjustCounter,
    counterValue,
    sessions: museCodeDeps,
    keyModel: () => testModel() ?? DEFAULT_PLATFORM_MODEL,
    briefPowers: async (token) => {
      const [row] = await db().select({ brief: schema.builds.brief }).from(schema.builds).where(eq(schema.builds.productId, token.productId)).orderBy(schema.builds.startedAt).limit(1);
      return platformBlock(row?.brief);
    },
    isChildProduct: async (productId) => {
      const [row] = await db().select({ rebuildOf: schema.builds.rebuildOf }).from(schema.builds).where(eq(schema.builds.productId, productId)).orderBy(schema.builds.startedAt).limit(1);
      return isPowerChild(row?.rebuildOf);
    },
    storeKey: async (opts) => {
      const [row] = await db()
        .insert(schema.gatewayTokens)
        .values({ productId: opts.productId, tokenHash: hashToken(opts.token), scope: POWER_KEY_SCOPE as "live", allowedModels: [opts.model], dailyBudgetUsd: opts.budgetUsd, expiresAt: opts.expiresAt })
        .returning({ id: schema.gatewayTokens.id });
      return { id: row!.id };
    },
    revokeKey: async (productId, id, now) => {
      const rows = await db()
        .update(schema.gatewayTokens)
        .set({ revokedAt: now })
        .where(and(eq(schema.gatewayTokens.id, id), eq(schema.gatewayTokens.productId, productId), eq(schema.gatewayTokens.scope, POWER_KEY_SCOPE as "live"), isNull(schema.gatewayTokens.revokedAt)))
        .returning({ id: schema.gatewayTokens.id });
      return rows.length > 0;
    },
    startBuild: async ({ ownerId, productId, note }) => {
      const [owner] = await db().select({ id: schema.users.id, email: schema.users.email, isAdmin: schema.users.isAdmin }).from(schema.users).where(eq(schema.users.id, ownerId)).limit(1);
      if (!owner) return { ok: false, status: 503, error: "no_owner" };
      const allowed = await checkBuildAllowed({ ...owner, isAdmin: owner.isAdmin && env.adminEmails.includes(owner.email) });
      if (!allowed.ok) return { ok: false, status: allowed.status, error: allowed.error };
      const { buildId } = await insertBuild({ userId: owner.id, note, references: [], rebuildOf: powerChildMark(productId) });
      try {
        const run = await start(buildProduct, [{ buildId }]);
        await attachRun(buildId, run.runId).catch((err) => console.error("[powers] attachRun", err));
      } catch (err) {
        await markStartFailed(buildId, err);
        throw err;
      }
      return { ok: true, buildId };
    },
    childBuild: async (productId, buildId) => {
      const [row] = await db()
        .select({ status: schema.builds.status, rebuildOf: schema.builds.rebuildOf, costUsd: schema.builds.costUsd, error: schema.builds.error, liveUrl: schema.products.liveUrl })
        .from(schema.builds)
        .leftJoin(schema.products, eq(schema.builds.productId, schema.products.id))
        .where(eq(schema.builds.id, buildId))
        .limit(1);
      if (!row || powerParentOf(row.rebuildOf) !== productId) return null;
      return { status: row.status, liveUrl: row.liveUrl ?? null, costUsd: row.costUsd, error: row.error };
    },
  };
}
