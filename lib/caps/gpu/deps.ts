import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { GlimmerDeps } from "@/lib/caps/gpu/handler";
import { ownModelFor } from "@/lib/caps/gpu/own-model";
import { attachServeJob, getGlimmerWindow, glimmerReservedToday, insertGlimmerWindow, moveGlimmerWindow, openGlimmerWindow, unsettledGlimmerWindows } from "@/lib/caps/gpu/store";
import type { WindowDeps } from "@/lib/caps/gpu/windows";
import { capProduct, capToken } from "@/lib/caps/store";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { hitRateLimits, reserveSpend, settleSpend } from "@/lib/gateway/store";
import { limitCeilings } from "@/lib/train/gate";
import { serveJobChatBackend } from "@/lib/train/glimmer-serving";
import { launchJob } from "@/lib/train/launch";
import { SERVE_ADAPTER_PARAM, SERVE_BOOT_MINUTES, SERVE_RECIPE } from "@/lib/train/logic";
import { TRAIN_TERMINAL } from "@/lib/train/types";
import { getAdapterSource, getLiveDemo, requestStop } from "@/lib/train/store";
import { platformSpendToday, recordUsage } from "@/lib/usage";

export function glimmerDeps(): GlimmerDeps {
  return {
    on: () => env.gpuGlimmerShared,
    paused: () => env.gpuGlimmerDailyUsd <= 0,
    allProducts: () => env.gpuGlimmerAllProducts,
    adminEmails: env.adminEmails,
    findToken: capToken,
    product: capProduct,
    hitRateLimits,
    openWindow: openGlimmerWindow,
    ownModel: ownModelFor,
    async startingFor(window, now) {
      const demo = await getLiveDemo(window.adapterJobId, now);
      if (demo?.state !== "starting") return null;
      const bootedBy = window.createdAt.getTime() + SERVE_BOOT_MINUTES * 60_000;
      return Math.max(15, Math.ceil((bootedBy - now.getTime()) / 1000));
    },
    backend: (adapterJobId, now) => serveJobChatBackend(adapterJobId, now),
    recordUsage,
  };
}

export function windowDeps(): WindowDeps {
  return {
    dailyUsd: () => env.gpuGlimmerDailyUsd,
    dailySpendCapUsd: () => env.dailySpendCapUsd,
    jobCeilings: limitCeilings,
    platformSpendToday,
    reservedToday: glimmerReservedToday,
    adapter: getAdapterSource as WindowDeps["adapter"],
    insert: insertGlimmerWindow,
    get: getGlimmerWindow,
    unsettled: unsettledGlimmerWindows,
    attach: attachServeJob,
    move: moveGlimmerWindow,
    reserveSpend,
    settleSpend,
    launch: launchJob,
    async job(id) {
      const jobs = schema.trainingJobs;
      const [row] = await db()
        .select({ status: jobs.status, costUsd: jobs.costUsd, instanceId: jobs.instanceId, terminatedAt: jobs.terminatedAt, stopRequested: jobs.stopRequested })
        .from(jobs)
        .where(eq(jobs.id, id))
        .limit(1);
      return row ?? null;
    },
    stop: requestStop,
    async serveJobOf(adapterJobId) {
      const jobs = schema.trainingJobs;
      const [row] = await db()
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.recipe, SERVE_RECIPE), sql`${jobs.params}->>${SERVE_ADAPTER_PARAM} = ${adapterJobId}`, isNull(jobs.terminatedAt), notInArray(jobs.status, [...TRAIN_TERMINAL])))
        .orderBy(desc(jobs.createdAt))
        .limit(1);
      return row?.id ?? null;
    },
  };
}
