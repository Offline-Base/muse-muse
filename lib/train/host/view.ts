/**
 * What the Run it section shows. Built field by field, so an inference URL, a provider ref or a token hash can't reach a
 * browser. Pure.
 */
import { accruedUsd, STOP_WORDS, type HostLimits } from "@/lib/train/host/limits";
import { providerRefusal } from "@/lib/train/host/service";
import type { LicenseDuties } from "@/lib/train/base";
import type { HostAdapter, HostEndpoint, HostFacts, HostProvider, HostStatus } from "@/lib/train/host/types";

export interface HostChoiceView {
  id: HostProvider;
  label: string;
  available: boolean;
  reason: string | null;
  hourlyUsd: number;
  gpu: string;
}

export interface HostEndpointView {
  id: string;
  provider: HostProvider;
  label: string;
  status: HostStatus;
  note: string | null;
  stopsAt: string;
  costSoFarUsd: number;
}

export interface HostView {
  problem: string | null;
  choices: HostChoiceView[];
  endpoint: HostEndpointView | null;
  duties: LicenseDuties;
  limits: HostLimits;
  gatewayPath: string;
}

export const HOSTED_GATEWAY_PATH = "/api/gateway/hosted/v1";

export function hostView(facts: HostFacts, adapters: readonly HostAdapter[], rows: readonly HostEndpoint[], limits: HostLimits, now: Date): HostView {
  const open = rows.find((e) => e.adapterJobId === facts.adapterJobId && (e.status === "starting" || e.status === "live" || e.status === "stopping"));
  const label = (id: HostProvider) => adapters.find((a) => a.id === id)?.label ?? id;
  return {
    problem: facts.problem,
    choices: adapters.map((a) => {
      const reason = providerRefusal(facts, a);
      const price = a.price(facts);
      return { id: a.id, label: a.label, available: !reason && !facts.problem, reason: reason ?? facts.problem, hourlyUsd: price.hourlyUsd, gpu: price.gpu };
    }),
    endpoint: open
      ? { id: open.id, provider: open.provider, label: label(open.provider), status: open.status, note: open.stopReason ? STOP_WORDS[open.stopReason] : null, stopsAt: open.stopsAt.toISOString(), costSoFarUsd: Math.round(accruedUsd(open, now) * 100) / 100 }
      : null,
    duties: facts.duties,
    limits,
    gatewayPath: HOSTED_GATEWAY_PATH,
  };
}
