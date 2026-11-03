/**
 * The real deps of a partner eval: env, the store, the judge, and the hosting code's service with only the two partners'
 * adapters. Not lib/train/host/deps.ts: that one reaches lib/train/launch for Lambda, which imports the training
 * workflow that starts this one. Keys are read per call inside the adapters, never returned. Server only.
 */
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { hitRateLimits, reserveSpend, settleSpend } from "@/lib/gateway/store";
import { hashToken } from "@/lib/gateway/tokens";
import { spendPaused } from "@/lib/quota";
import { basetenAdapter } from "@/lib/train/host/baseten";
import { sandboxRunner } from "@/lib/train/host/cli-runner";
import { hostKeyFor } from "@/lib/train/host/keys";
import { modalAdapter } from "@/lib/train/host/modal";
import type { HostChatDeps } from "@/lib/train/host/service";
import { hostRows, insertHostEndpoint, patchHostEndpoint, touchHostEndpoint } from "@/lib/train/host/store";
import type { HostAdapter, HostProvider } from "@/lib/train/host/types";
import type { HostLimits } from "@/lib/train/host/limits";
import type { PartnerSettings } from "@/lib/train/partner/logic";
import { getAdapterSource, getDataset, getEvalItem, listEvalIndexes, listPartnerEvals, recordEvent } from "@/lib/train/store";
import type { DoneMetrics, JudgedItem, TrainJobRow } from "@/lib/train/logic";
import type { PartnerEvalBody, TrainEventBody } from "@/lib/train/types";
import { platformSpendToday } from "@/lib/usage";

export interface PartnerDeps {
  settings(): PartnerSettings;
  source(jobId: string): Promise<{ job: TrainJobRow; metrics: DoneMetrics | null } | null>;
  evalIndexes(jobId: string): Promise<number[]>;
  evalItem(jobId: string, index: number): Promise<{ prompt: string; reference: string } | null>;
  datasetTask(datasetId: string): Promise<string | null>;
  results(jobId: string): Promise<PartnerEvalBody[]>;
  record(jobId: string, body: TrainEventBody): Promise<void>;
  /** Why the judge can't run now (no key, the platform's spend cap), or null. Checked before anything is deployed. */
  judgeReady(): Promise<string | null>;
  judge(input: { model: string; task: string | null; index: number; prompt: string; reference: string; base: string; tuned: string }): Promise<JudgedItem & { note: string }>;
  /** The hosting service's deps, with the eval's own limits laid over the hosting ones. */
  host(limits?: Partial<HostLimits>): HostChatDeps;
  now(): Date;
  /** A clock for latency, in milliseconds. */
  clock(): number;
}

const key = (name: string) => () => process.env[name]?.trim() || undefined;

function partnerAdapters(): HostAdapter[] {
  // A read-only HOST_HF_TOKEN is better than the platform's write token: this one is handed to the provider.
  const hfToken = () => key("HOST_HF_TOKEN")() ?? key("HF_TOKEN")();
  return [
    basetenAdapter({ apiKey: key("BASETEN_API_KEY"), hfToken, runner: sandboxRunner }),
    modalAdapter({ tokenId: key("MODAL_TOKEN_ID"), tokenSecret: key("MODAL_TOKEN_SECRET"), hfToken, keyFor: hostKeyFor, runner: sandboxRunner }),
  ];
}

const hostLimits = (): HostLimits => ({ dailyUsd: env.hostTunedDailyUsd, maxLive: env.hostTunedMaxLive, idleMinutes: env.hostTunedIdleMinutes, maxMinutes: env.hostTunedMaxMinutes });

/** One start at a time with the Run it section: the same per-minute key as lib/train/host/deps.ts. */
async function takeDeployLock(now: Date): Promise<boolean> {
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const counts = await hitRateLimits(["hosted-deploy"], minute);
  return (counts["hosted-deploy"] ?? 0) <= 1;
}

export function partnerDeps(): PartnerDeps {
  const adapters = partnerAdapters();
  return {
    settings: () => ({ provider: env.partnerEvalProvider, hostOn: env.hostTuned, maxUsd: env.partnerEvalMaxUsd, maxMinutes: env.partnerEvalMaxMinutes }),
    source: getAdapterSource,
    evalIndexes: listEvalIndexes,
    async evalItem(jobId, index) {
      const item = await getEvalItem(jobId, index);
      return item ? { prompt: item.prompt, reference: item.reference } : null;
    },
    async datasetTask(datasetId) {
      return (await getDataset(datasetId))?.task ?? null;
    },
    results: listPartnerEvals,
    record: recordEvent,
    async judgeReady() {
      if (!process.env.MODEL_API_KEY) return "MODEL_API_KEY isn't set, so the answers couldn't be judged.";
      return (await spendPaused()) ? "The platform's daily spend cap is reached, so the answers couldn't be judged." : null;
    },
    // Imported when used: the training workflow imports this chain, and its tests stand in their own judge module.
    judge: async (input) => (await import("@/lib/train/judge-pair")).judgePair(input),
    host(limits) {
      return {
        on: () => env.hostTuned,
        limits: () => ({ ...hostLimits(), ...limits }),
        platformCapUsd: () => env.dailySpendCapUsd,
        platformSpend: platformSpendToday,
        adapter(provider: HostProvider) {
          const found = adapters.find((a) => a.id === provider);
          if (!found) throw new Error("Partner evals run only on Baseten or Modal.");
          return found;
        },
        adapters: () => adapters,
        rows: hostRows,
        insert: insertHostEndpoint,
        patch: patchHostEndpoint,
        touch: touchHostEndpoint,
        takeDeployLock,
        reserveSpend,
        settleSpend,
        hashToken,
        newId: randomUUID,
      };
    },
    now: () => new Date(),
    clock: () => performance.now(),
  };
}

// Kept here, not in steps.ts: a workflow bundle keeps a steps file's module-level code, and a hook there pulled this
// file (and node:crypto) into the partner workflow, which failed the production build on Nov 3.
let testDeps: PartnerDeps | null = null;

/** Tests only: fakes in place of the database, the providers and the judge. */
export function usePartnerDepsForTests(deps: PartnerDeps | null): void {
  testDeps = deps;
}

/** The deps a step uses: the test fakes when set, else the real ones. Call it inside a step body only. */
export function currentPartnerDeps(): PartnerDeps {
  return testDeps ?? partnerDeps();
}
