/**
 * Partner evals (PARTNER_EVALS, docs/TRAINING.md "Evaluate on a partner"): the pure half. Whether a tuned job may be
 * evaluated on a partner and for how long, what one costs at most, and what a finished one says. No I/O, so the steps,
 * the room's view and the tests share it.
 *
 * Why these partners: Fireworks refuses r30b adapters (it has no r30b base) and regex target modules, and its account
 * answered 412 on Nov 2, so it isn't offered. Lambda isn't a partner here: it is the lab's own GPU, where the job's own
 * answers came from. Baseten is the default (docs/BUILD_LOG.md, Nov 3, "partner evals" has the evidence), Modal the other.
 */
import { summarizeJudgements, type JudgedItem } from "@/lib/train/logic";
import { MIN_RUN_MINUTES, START_TIMEOUT_MINUTES } from "@/lib/train/host/limits";
import type { HostFacts, HostPrice } from "@/lib/train/host/types";
import type { PartnerEvalBody, PartnerEvalScore, PartnerLatency, PartnerProvider } from "@/lib/train/types";

export const PARTNER_PROVIDERS: readonly PartnerProvider[] = ["baseten", "modal"];
export const PARTNER_LABEL: Record<PartnerProvider, string> = { baseten: "Baseten", modal: "Modal" };

/** Held-out prompts sent at most: the overnight cold-room run has 20. */
export const PARTNER_MAX_ITEMS = 40;
/** Answers asked at once: one replica, and vLLM batches them. */
export const PARTNER_CONCURRENCY = 4;
/** Room kept before the endpoint's stop time for judging and the stop itself. */
export const PARTNER_TAIL_MINUTES = 5;
/** A "started" this old with no ending is a run that died: a new one may start (the hosting sweep stopped its GPU). */
export const PARTNER_STALE_MS = 3 * 60 * 60_000;
/** Same as the lab's MAX_NEW_TOKENS for eval answers (lib/train/recipes/glimmer.ts). */
export const PARTNER_MAX_TOKENS = 1024;
/** How much of a provider's or a step's words a reason keeps. */
const REASON_MAX = 300;

export function isPartnerProvider(v: unknown): v is PartnerProvider {
  return typeof v === "string" && (PARTNER_PROVIDERS as readonly string[]).includes(v);
}

export interface PartnerSettings {
  provider: PartnerProvider | null;
  hostOn: boolean;
  maxUsd: number;
  maxMinutes: number;
}

export type PartnerBudget = { ok: true; minutes: number; maxUsd: number } | { ok: false; reason: string };

const money = (usd: number) => `$${usd.toFixed(2)}`;
const roundUsd = (usd: number) => Math.round(usd * 1e4) / 1e4;

/**
 * How long the endpoint may live, so its whole time at the list price fits PARTNER_EVAL_MAX_USD: the stop time is set from
 * this, and the hosting sweep stops it there whatever happens to the workflow. Refused when that leaves less than the
 * hosting code's own minimum (30 minutes), since it could spend it all starting.
 */
export function partnerBudget(price: HostPrice, s: Pick<PartnerSettings, "maxUsd" | "maxMinutes">): PartnerBudget {
  if (!(s.maxUsd > 0)) return { ok: false, reason: "PARTNER_EVAL_MAX_USD is 0, so partner evals are paused." };
  if (!(price.hourlyUsd > 0)) return { ok: false, reason: "The partner's price isn't known, so it wasn't started." };
  const minutes = Math.min(Math.floor(s.maxMinutes), Math.floor((s.maxUsd / price.hourlyUsd) * 60));
  if (minutes < MIN_RUN_MINUTES) {
    return { ok: false, reason: `At ${money(price.hourlyUsd)} an hour, ${money(s.maxUsd)} buys under ${MIN_RUN_MINUTES} minutes, too little to start a ${price.gpu}.` };
  }
  return { ok: true, minutes, maxUsd: roundUsd((minutes / 60) * price.hourlyUsd) };
}

/** How long to wait for it to answer ready: the hosting code's start timeout, and enough time left to answer and judge. */
export function readyWindowMinutes(minutes: number): number {
  return Math.max(1, Math.min(START_TIMEOUT_MINUTES, minutes - PARTNER_TAIL_MINUTES - 10));
}

/**
 * Why this job can't be evaluated on this partner now, or null. `results` are the job's partner_eval events for it,
 * oldest first. `refusal` is the hosting code's own (missing keys, no pinned base, not on the Hub). `again` lets an admin
 * run a finished one once more.
 */
export function partnerProblem(input: {
  facts: HostFacts;
  refusal: string | null;
  items: number;
  results: PartnerEvalBody[];
  judgeReady: string | null;
  again?: boolean;
  now: Date;
}): string | null {
  if (input.facts.problem) return input.facts.problem;
  if (input.refusal) return input.refusal;
  if (!input.items) return "This job has no held-out prompts to answer.";
  if (input.judgeReady) return input.judgeReady;
  const last = [...input.results].reverse().find((r) => r.status !== "skipped");
  if (last?.status === "started" && input.now.getTime() - Date.parse(last.startedAt ?? "") < PARTNER_STALE_MS) return "A partner eval of this model is already running.";
  if (last?.status === "done" && !input.again) return "This model was already evaluated on this partner.";
  return null;
}

/** Median and 90th percentile, nearest rank. Null with no answers. */
export function latencyOf(ms: number[]): PartnerLatency | null {
  const sorted = ms.filter((m) => Number.isFinite(m) && m >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  return { answers: sorted.length, medianMs: Math.round(rank(0.5)), p90Ms: Math.round(rank(0.9)) };
}

/** A reason as the log keeps it: one line, short, never a URL. */
export function reasonText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "[address]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REASON_MAX);
}

export interface PartnerAnswer {
  index: number;
  variant: "base" | "tuned";
  ms: number;
}

/** What a finished partner eval records: its scores beside the GPU's cost and the answers' latency. */
export function partnerSummary(input: {
  provider: PartnerProvider;
  verdicts: Array<JudgedItem & { index: number }>;
  asked: number;
  answers: PartnerAnswer[];
  judgeModel: string;
  coldStartSeconds: number | null;
  costUsd: number | null;
  stopped: boolean;
  price: HostPrice;
  minutes: number;
  maxUsd: number;
  startedAt: string;
  endedAt: string;
  failed: string | null;
}): PartnerEvalBody {
  const s = summarizeJudgements(input.verdicts);
  const scores: PartnerEvalScore[] = input.verdicts.map((v) => ({ index: v.index, baseScore: v.baseScore, tunedScore: v.tunedScore, better: v.better }));
  const done = !input.failed && input.verdicts.length > 0;
  return {
    type: "partner_eval",
    provider: input.provider,
    status: done ? "done" : "failed",
    ...(done ? {} : { reason: reasonText(input.failed ?? "No prompt was judged.") }),
    gpu: input.price.gpu,
    hourlyUsd: input.price.hourlyUsd,
    minutes: input.minutes,
    maxUsd: input.maxUsd,
    asked: input.asked,
    items: s.items,
    tunedWins: s.tunedWins,
    baseWins: s.baseWins,
    ties: s.ties,
    avgBaseScore: s.avgBaseScore,
    avgTunedScore: s.avgTunedScore,
    judgeModel: input.judgeModel,
    judgeCostUsd: s.judgeCostUsd,
    latency: {
      base: latencyOf(input.answers.filter((a) => a.variant === "base").map((a) => a.ms)),
      tuned: latencyOf(input.answers.filter((a) => a.variant === "tuned").map((a) => a.ms)),
    },
    coldStartSeconds: input.coldStartSeconds,
    costUsd: input.costUsd === null ? null : roundUsd(input.costUsd),
    costSource: "clock",
    stopped: input.stopped,
    scores,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  };
}

/** The room's card. Pure words and numbers: nothing about where the endpoint was. */
export interface PartnerEvalView {
  provider: PartnerProvider;
  label: string;
  status: PartnerEvalBody["status"];
  /** "Evaluated on Baseten", or what happened instead. */
  title: string;
  words: string;
  costUsd: number | null;
  at: string | null;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * The newest partner eval that says something: done or failed outrank a started one only when they came after it. With
 * `now`, a "started" older than PARTNER_STALE_MS is a run that died, and is said so, not "Evaluating".
 */
export function partnerEvalView(results: PartnerEvalBody[], judgeLabel: (id: string) => string, now?: Date): PartnerEvalView | null {
  const last = [...results].reverse().find((r) => r.status !== "skipped") ?? results[results.length - 1];
  if (!last) return null;
  const label = PARTNER_LABEL[last.provider] ?? last.provider;
  const base = { provider: last.provider, label, status: last.status, costUsd: last.costUsd ?? null, at: last.endedAt ?? last.startedAt ?? null };
  if (last.status === "started" && now && now.getTime() - Date.parse(last.startedAt ?? "") >= PARTNER_STALE_MS) {
    return { ...base, status: "failed", title: `Evaluation on ${label} didn't finish`, words: `It stopped without recording a result. The hosting sweep stops its ${last.gpu ?? "GPU"} at its stop time.` };
  }
  if (last.status === "started") {
    return { ...base, title: `Evaluating on ${label}`, words: `The same held-out prompts are being answered on a ${last.gpu ?? "GPU"} at ${label}, by the model it started from and the tuned one. It stops itself within ${last.minutes ?? "its"} minutes, at most ${money(last.maxUsd ?? 0)}.` };
  }
  if (last.status === "skipped") return { ...base, title: `Not evaluated on ${label}`, words: last.reason ?? "It wasn't started." };
  const cost = last.costUsd === null || last.costUsd === undefined ? "" : ` The ${last.gpu ?? "GPU"} cost ${money(last.costUsd)} by the clock at list price, an upper bound.`;
  if (last.status === "failed") {
    const partial = last.items ? ` ${last.items} of ${last.asked} prompts were judged before it stopped.` : "";
    return { ...base, title: `Evaluation on ${label} didn't finish`, words: `${last.reason ?? "It stopped partway."}${partial}${cost}${last.stopped === false ? " Its stop wasn't confirmed yet: the hosting sweep keeps trying." : ""}` };
  }
  const t = last.latency?.tuned;
  const b = last.latency?.base;
  const speed = t && b ? ` Median answer ${secs(t.medianMs)} tuned, ${secs(b.medianMs)} base (90th percentile ${secs(t.p90Ms)} and ${secs(b.p90Ms)}).` : "";
  const cold = typeof last.coldStartSeconds === "number" ? ` It took ${Math.round(last.coldStartSeconds / 60)} minutes to start.` : "";
  return {
    ...base,
    title: `Evaluated on ${label}`,
    words:
      `On ${label}'s ${last.gpu ?? "GPU"}, the tuned model was better on ${last.tunedWins} of ${last.items} held-out prompts, the model it started from on ${last.baseWins}, ${last.ties} tied. ` +
      `Average score ${last.avgTunedScore} tuned, ${last.avgBaseScore} base, judged by ${judgeLabel(last.judgeModel ?? "")}.${speed}${cold}${cost}` +
      ` Answered greedily from the 16-bit base with the adapter loaded, so the numbers can differ a little from the lab's own, which ran on the 4-bit training copy.`,
  };
}
