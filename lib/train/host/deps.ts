/**
 * The real deps: env keys, the store, the Lab's launch. Reaches lib/train/launch and its workflow, so only the routes import
 * this, never a build's steps. Keys are read per call, inside the adapters' closures, and never returned.
 */
import { createHmac, randomUUID } from "node:crypto";
import { capProduct, capToken } from "@/lib/caps/store";
import { env } from "@/lib/env";
import { adjustCounter, counterValue, hitRateLimits, reserveCounter, reserveSpend, settleSpend } from "@/lib/gateway/store";
import { hashToken } from "@/lib/gateway/tokens";
import { limitCeilings } from "@/lib/train/gate";
import { serveJobChatBackend } from "@/lib/train/glimmer-serving";
import { basetenAdapter } from "@/lib/train/host/baseten";
import { sandboxRunner } from "@/lib/train/host/cli-runner";
import { fireworksAdapter } from "@/lib/train/host/fireworks";
import type { HostedGatewayDeps } from "@/lib/train/host/gateway";
import { hubAdapterSource } from "@/lib/train/host/hf-files";
import { LAMBDA_JOB_TITLE, lambdaAdapter } from "@/lib/train/host/lambda";
import { modalAdapter } from "@/lib/train/host/modal";
import { hostByModel, hostByOwnerTokenHash, hostRows, insertHostEndpoint, patchHostEndpoint, productOwnsModel, touchHostEndpoint } from "@/lib/train/host/store";
import type { TryDeps } from "@/lib/train/host/try";
import type { HostAdapter, HostProvider } from "@/lib/train/host/types";
import { HOST_PROVIDERS } from "@/lib/train/host/types";
import { launchJob } from "@/lib/train/launch";
import { getLiveDemo, requestStop } from "@/lib/train/store";
import { db, schema } from "@/lib/db/client";
import { and, desc, eq, gte, isNull, notInArray, sql } from "drizzle-orm";
import { SERVE_ADAPTER_PARAM, SERVE_RECIPE } from "@/lib/train/logic";
import { isTrainTerminal, TRAIN_TERMINAL, type TrainStatus } from "@/lib/train/types";
import { platformSpendToday, recordUsage } from "@/lib/usage";

const key = (name: string) => () => process.env[name]?.trim() || undefined;

/** The key vLLM checks on Modal for one endpoint. Derived, so it is never stored. */
function hostKeyFor(endpointId: string): string {
  return createHmac("sha256", env.sessionSecret).update(`host-endpoint:${endpointId}`).digest("hex");
}

export function hostAdapters(): HostAdapter[] {
  // This one is handed to the providers, so a read-only HOST_HF_TOKEN is better than the platform's write token.
  const hfToken = () => key("HOST_HF_TOKEN")() ?? key("HF_TOKEN")();
  return [
    fireworksAdapter({ apiKey: key("FIREWORKS_API_KEY"), accountId: key("FIREWORKS_ACCOUNT_ID"), source: hubAdapterSource }),
    modalAdapter({ tokenId: key("MODAL_TOKEN_ID"), tokenSecret: key("MODAL_TOKEN_SECRET"), hfToken, keyFor: hostKeyFor, runner: sandboxRunner }),
    basetenAdapter({ apiKey: key("BASETEN_API_KEY"), hfToken, runner: sandboxRunner }),
    lambdaAdapter({
      apiKey: key("LAMBDA_API_KEY"),
      ceilings: limitCeilings,
      launch: launchJob,
      async liveState(adapterJobId) {
        const demo = await getLiveDemo(adapterJobId);
        return demo?.state === "live" || demo?.state === "starting" ? demo.state : null;
      },
      async job(id) {
        const jobs = schema.trainingJobs;
        const [row] = await db().select({ status: jobs.status, costUsd: jobs.costUsd, instanceId: jobs.instanceId, terminatedAt: jobs.terminatedAt }).from(jobs).where(eq(jobs.id, id)).limit(1);
        return row ?? null;
      },
      stopJob: requestStop,
      async serveJobOf(adapterJobId, since) {
        const jobs = schema.trainingJobs;
        // A minute's slack for the two clocks. The title and the adapter are what keep a demo's job out.
        const [row] = await db()
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.recipe, SERVE_RECIPE), eq(jobs.title, LAMBDA_JOB_TITLE), sql`${jobs.params}->>${SERVE_ADAPTER_PARAM} = ${adapterJobId}`, gte(jobs.createdAt, new Date(since.getTime() - 60_000)), isNull(jobs.terminatedAt), notInArray(jobs.status, [...TRAIN_TERMINAL])))
          .orderBy(desc(jobs.createdAt))
          .limit(1);
        return row?.id ?? null;
      },
      backend: (adapterJobId) => serveJobChatBackend(adapterJobId),
      isTerminal: (status) => isTrainTerminal(status as TrainStatus),
    }),
  ];
}

export function hostLimits() {
  return { dailyUsd: env.hostTunedDailyUsd, maxLive: env.hostTunedMaxLive, idleMinutes: env.hostTunedIdleMinutes, maxMinutes: env.hostTunedMaxMinutes };
}

export function hostDeps(): HostedGatewayDeps {
  const adapters = hostAdapters();
  return {
    on: () => env.hostTuned,
    limits: hostLimits,
    platformCapUsd: () => env.dailySpendCapUsd,
    platformSpend: platformSpendToday,
    adapter(provider: HostProvider) {
      if (!HOST_PROVIDERS.includes(provider)) throw new Error("unknown provider");
      return adapters.find((a) => a.id === provider)!;
    },
    adapters: () => adapters,
    rows: hostRows,
    insert: insertHostEndpoint,
    patch: patchHostEndpoint,
    touch: touchHostEndpoint,
    async takeDeployLock(now) {
      const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
      const counts = await hitRateLimits(["hosted-deploy"], minute);
      return (counts["hosted-deploy"] ?? 0) <= 1;
    },
    reserveSpend,
    settleSpend,
    hashToken,
    newId: randomUUID,
    byOwnerTokenHash: hostByOwnerTokenHash,
    byModel: hostByModel,
    findToken: capToken,
    product: capProduct,
    productOwnsModel,
    hitRateLimits,
    recordUsage,
  };
}

/** The public Try box's deps: everything hosting has, its own day's budget, and the atomic counters that hold it. */
export function tryDeps(): TryDeps {
  return {
    ...hostDeps(),
    tryOn: () => env.hostTuned && env.tryTuned,
    tryLimits: () => ({ dailyUsd: Math.min(env.tryTunedDailyUsd, env.hostTunedDailyUsd), wakesPerDay: env.tryTunedWakesPerDay, minutes: Math.min(env.tryTunedMinutes, env.hostTunedMaxMinutes) }),
    reserveCounter,
    adjustCounter,
    counterValue,
  };
}
