/**
 * Hosting a tuned model on a provider the platform pays for (docs/TRAINING.md, "Run it on a hosted GPU"). Types only.
 * Provider keys, inference URLs and the HF token never appear in anything a browser gets: see view.ts.
 */
import type { BaseFamily, LicenseDuties } from "@/lib/train/base";
import type { ChatMessage, GlimmerChatReply } from "@/lib/train/glimmer-serving";

export const HOST_PROVIDERS = ["fireworks", "modal", "baseten", "lambda"] as const;
export type HostProvider = (typeof HOST_PROVIDERS)[number];

export type HostStatus = "starting" | "live" | "stopping" | "stopped" | "failed";
export const HOST_OPEN: readonly HostStatus[] = ["starting", "live", "stopping"];

export type StopReason =
  | "person"
  | "idle"
  | "max_time"
  | "start_timeout"
  | "daily_cap"
  | "too_many"
  | "flag_off"
  | "cant_check"
  | "provider_failed"
  | "deploy_failed";

/** What a job's record says about hosting it, from hostFacts. */
export interface HostFacts {
  adapterJobId: string;
  family: BaseFamily;
  sparkOpen: boolean;
  /** The adapter's rank, or null when the job didn't record one. */
  rank: number | null;
  /** The adapter's model repo and the commit that published it. Private repos count: the platform's HF token reads them. */
  hubRepo: string | null;
  hubCommit: string | null;
  /** 0: trained before trainChannel, so it answers on a final channel the prompt must open. Glimmer only. */
  trainChannel: 0 | 1;
  /** The full weights an adapter loads onto outside the lab, pinned, or null when the job didn't record them. */
  servingBase: { repo: string; revision: string } | null;
  /** Why the lab's own glimmer-serve job can't load it (adapterProblem), or null. */
  lambdaProblem: string | null;
  /** The base's license duties. Always shown beside the choices. */
  duties: LicenseDuties;
  /** Why this model can't be hosted at all, or null: it must have passed. */
  problem: string | null;
}

/** What a provider left behind to find its endpoint again. Server only. */
export type HostRef = Record<string, string>;

export interface HostPrice {
  hourlyUsd: number;
  gpu: string;
  /** A provider whose job carries its own dollar limit: this is reserved, and maxMinutes holds, whatever the rate says. */
  capUsd?: number;
  maxMinutes?: number;
}

export interface HostChatInput {
  messages: ChatMessage[];
  family: BaseFamily;
  adapterJobId: string;
  /** Glimmer only: 0 opens the final channel and stops as the lab's server does. Left out, it reasons first. */
  trainChannel?: 0 | 1;
  maxTokens?: number;
  stop: string[];
  signal?: AbortSignal;
  /** "base": the same GPU answers without the adapter, for a side-by-side try. Left out, the tuned model answers. */
  variant?: "tuned" | "base";
  /** What vLLM on Modal calls the base: the repo it was started with. Read from the job on the server, never from a request. */
  baseRepo?: string | null;
}

export type HostChatReply = Omit<GlimmerChatReply, "ms">;

export type HostHealth = "starting" | "ready" | "failed";

export interface HostDeployInput {
  /** Every provider resource is named this, so a crash before the ref is saved can still be stopped. */
  name: string;
  endpointId: string;
  facts: HostFacts;
  minutes: number;
  /** A provider with its own job limits: what was reserved. */
  capUsd?: number;
  /** Null for a visitor's wake on the public Try box (lib/train/host/try.ts), which has no account. */
  callerId: string | null;
}

/** One provider. Each stays small: everything about limits and money lives in service.ts. */
export interface HostAdapter {
  id: HostProvider;
  label: string;
  /** The env names this provider needs that aren't set. Names only, never values. */
  missingKeys(): string[];
  /** Why this provider can't serve this model, or null. */
  cantServe(facts: HostFacts): string | null;
  price(facts: HostFacts): HostPrice;
  deploy(input: HostDeployInput): Promise<HostRef>;
  status(ref: HostRef, name: string): Promise<HostHealth>;
  /** Idempotent, and works from the name alone. done: the provider will bill no more. costUsd: what it really cost, when it says. */
  stop(ref: HostRef, name: string): Promise<{ done: boolean; costUsd?: number }>;
  /** The OpenAI-compatible base URL, or null for a target that isn't a plain URL (Lambda's is TLS-pinned). */
  inferenceUrl(ref: HostRef): string | null;
  chat(ref: HostRef, input: HostChatInput): Promise<HostChatReply>;
  /** Names of the "mm-host-" resources the provider holds, for finding what no row knows about. Absent when listing isn't practical. */
  listOwned?(): Promise<string[]>;
}

/** A hosted_endpoints row, as the service uses it. */
export interface HostEndpoint {
  id: string;
  adapterJobId: string;
  provider: HostProvider;
  status: HostStatus;
  slot: number;
  name: string;
  ref: HostRef | null;
  hourlyUsd: number;
  reservedUsd: number;
  costUsd: number | null;
  reservationId: string | null;
  ownerTokenHash: string;
  createdBy: string | null;
  stopReason: StopReason | null;
  stopsAt: Date;
  readyAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  stoppedAt: Date | null;
}

/** A refusal or failure a route can answer as it is. Its message is safe to show: no URL, no key. */
export class HostError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "HostError";
  }
}
