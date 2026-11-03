/**
 * Partner evals (PARTNER_EVALS, docs/TRAINING.md "Evaluate on a partner"): the pure half. Whether a tuned job may be
 * evaluated on a partner and for how long, what one costs at most, and what a finished one says. No I/O, so the steps,
 * the room's view and the tests share it.
 *
 * Why these partners: Baseten is the default (docs/BUILD_LOG.md, Nov 3, "partner evals" has the evidence), Modal the
 * other. Fireworks only for a tune it can serve (fireworksPartnerProblem): one trained on Fireworks (FIREWORKS_TUNE), whose
 * adapter is already on the account, or a plain Glimmer adapter that lists its target modules. It refuses r30b adapters
 * (no r30b base) and regex target modules, and its account answered 412 on Nov 2, so it is offered only when
 * PARTNER_EVALS names it or says "all". Fireworks hosts only the tuned model, so its base answers are the job's own.
 * Lambda isn't a partner here: it is the lab's own GPU, where the job's own answers came from.
 */
import { summarizeJudgements, type JudgedItem } from "@/lib/train/logic";
import { MIN_RUN_MINUTES, START_TIMEOUT_MINUTES } from "@/lib/train/host/limits";
import { fireworksConfigProblem } from "@/lib/train/host/fireworks-config";
import type { HostFacts, HostPrice } from "@/lib/train/host/types";
import type { PartnerEvalBody, PartnerEvalScore, PartnerLatency, PartnerProvider } from "@/lib/train/types";

export const PARTNER_PROVIDERS: readonly PartnerProvider[] = ["baseten", "modal", "fireworks"];
export const PARTNER_LABEL: Record<PartnerProvider, string> = { baseten: "Baseten", modal: "Modal", fireworks: "Fireworks" };

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
  /** The automatic one, after training. Null: PARTNER_EVALS is off. */
  provider: PartnerProvider | null;
  /** Every partner an admin may pick, the automatic one first. Left out: Baseten and Modal. */
  providers?: PartnerProvider[];
  hostOn: boolean;
  maxUsd: number;
  maxMinutes: number;
  /** PARTNER_EVAL_RUN_MAX_USD: what a run of several partners may cost in all. Left out: no total beyond each one's. */
  runMaxUsd?: number;
}

/** The partners an admin may pick under these settings. */
export function allowedPartners(s: Pick<PartnerSettings, "provider" | "providers">): PartnerProvider[] {
  if (!s.provider) return [];
  return s.providers?.length ? s.providers : [s.provider, ...(["baseten", "modal"] as const).filter((p) => p !== s.provider)];
}

/** Fireworks answers only the tuned model on a deployment, so the base answers are the job's own, recorded in the lab or on Fireworks. */
export function baseFromJob(provider: PartnerProvider): boolean {
  return provider === "fireworks";
}

export type PartnerChoice = { ok: true; providers: PartnerProvider[] } | { ok: false; reason: string };

/**
 * An admin's pick: `providers` as "all" or a list, else one `provider`, else the automatic one. Kept in the order the
 * allowed list has it, each once. "all" is every allowed partner; one this job can't go to is recorded as skipped, with why.
 */
export function partnerChoice(body: { provider?: unknown; providers?: unknown }, allowed: readonly PartnerProvider[]): PartnerChoice {
  const names = allowed.map((p) => p).join(", ");
  if (!allowed.length) return { ok: false, reason: "PARTNER_EVALS is off." };
  let asked: unknown[];
  if (body.providers === "all") asked = [...allowed];
  else if (Array.isArray(body.providers)) asked = body.providers;
  else if (body.providers !== undefined) return { ok: false, reason: `providers is "all" or a list of ${names}.` };
  else if (body.provider !== undefined) asked = [body.provider];
  else asked = [allowed[0]];
  if (!asked.length) return { ok: false, reason: "Pick at least one partner." };
  for (const p of asked) {
    if (!isPartnerProvider(p)) return { ok: false, reason: `A partner is one of ${names}.` };
    if (!allowed.includes(p)) return { ok: false, reason: `PARTNER_EVALS doesn't include ${PARTNER_LABEL[p]}. Set it to "all" or name it to offer it.` };
  }
  return { ok: true, providers: allowed.filter((p) => asked.includes(p)) };
}

/**
 * Whether Fireworks can serve this tune, before anything is created, or why not. Trained on Fireworks: yes, the adapter
 * is on the account. Trained in the lab: the hosting checks (r30b, rank, the Hub, the final channel) come first, through
 * the adapter's cantServe; then its adapter_config.json must list its target modules, which Glimmer training's pattern
 * doesn't. `config` is that file, read from the Hub, or null when it couldn't be.
 */
export function fireworksPartnerProblem(facts: Pick<HostFacts, "fireworksModel" | "hubRepo" | "hubCommit">, config: { r?: unknown; target_modules?: unknown } | null): string | null {
  if (facts.fireworksModel) return null;
  if (!facts.hubRepo || !facts.hubCommit) return null; // cantServe says it first: publish it.
  return fireworksConfigProblem(config);
}

/** What is left of a run's total for the next partner, after what the earlier ones cost (their upper bound when unknown). */
export function runLeftUsd(runMaxUsd: number | undefined, spentUsd: number): number {
  if (runMaxUsd === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((runMaxUsd - spentUsd) * 1e4) / 1e4);
}

/** What one ended partner eval counts against its run: the GPU's cost, else its whole allowance, and its judging. */
export function spentOf(body: Pick<PartnerEvalBody, "status" | "costUsd" | "maxUsd" | "judgeCostUsd">): number {
  if (body.status === "skipped") return 0;
  const gpu = typeof body.costUsd === "number" ? body.costUsd : (body.maxUsd ?? 0);
  return gpu + (Number(body.judgeCostUsd) || 0);
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
  baseFrom?: "job";
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
    ...(input.baseFrom ? { baseFrom: input.baseFrom } : {}),
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
    const who = last.baseFrom === "job" ? "by the tuned model, beside the job's own base answers" : "by the model it started from and the tuned one";
    return { ...base, title: `Evaluating on ${label}`, words: `The same held-out prompts are being answered on a ${last.gpu ?? "GPU"} at ${label}, ${who}. It stops itself within ${last.minutes ?? "its"} minutes, at most ${money(last.maxUsd ?? 0)}.` };
  }
  if (last.status === "skipped") return { ...base, title: `Not evaluated on ${label}`, words: last.reason ?? "It wasn't started." };
  const cost = last.costUsd === null || last.costUsd === undefined ? "" : ` The ${last.gpu ?? "GPU"} cost ${money(last.costUsd)} by the clock at list price, an upper bound.`;
  if (last.status === "failed") {
    const partial = last.items ? ` ${last.items} of ${last.asked} prompts were judged before it stopped.` : "";
    return { ...base, title: `Evaluation on ${label} didn't finish`, words: `${last.reason ?? "It stopped partway."}${partial}${cost}${last.stopped === false ? " Its stop wasn't confirmed yet: the hosting sweep keeps trying." : ""}` };
  }
  const t = last.latency?.tuned;
  const b = last.latency?.base;
  const speed = t && b ? ` Median answer ${secs(t.medianMs)} tuned, ${secs(b.medianMs)} base (90th percentile ${secs(t.p90Ms)} and ${secs(b.p90Ms)}).` : t ? ` Median answer ${secs(t.medianMs)} tuned (90th percentile ${secs(t.p90Ms)}).` : "";
  const how =
    last.baseFrom === "job"
      ? ` Only the tuned model answered on ${label}, greedily, with the adapter loaded; the base answers are the job's own, so the speed is the tuned model's alone.`
      : ` Answered greedily from the 16-bit base with the adapter loaded, so the numbers can differ a little from the lab's own, which ran on the 4-bit training copy.`;
  const cold = typeof last.coldStartSeconds === "number" ? ` It took ${Math.round(last.coldStartSeconds / 60)} minutes to start.` : "";
  return {
    ...base,
    title: `Evaluated on ${label}`,
    words:
      `On ${label}'s ${last.gpu ?? "GPU"}, the tuned model was better on ${last.tunedWins} of ${last.items} held-out prompts, the model it started from on ${last.baseWins}, ${last.ties} tied. ` +
      `Average score ${last.avgTunedScore} tuned, ${last.avgBaseScore} base, judged by ${judgeLabel(last.judgeModel ?? "")}.${speed}${cold}${cost}${how}`,
  };
}

/** One card per partner that has anything recorded, in PARTNER_PROVIDERS order: "Evaluated on Baseten", "Evaluated on Modal", ... */
export function partnerEvalViews(results: PartnerEvalBody[], judgeLabel: (id: string) => string, now?: Date): PartnerEvalView[] {
  const out: PartnerEvalView[] = [];
  for (const provider of PARTNER_PROVIDERS) {
    const mine = results.filter((r) => r.provider === provider);
    const view = mine.length ? partnerEvalView(mine, judgeLabel, now) : null;
    if (view) out.push(view);
  }
  return out;
}

/** What an admin sees per partner before starting: whether it can go, why not, and what it would cost at most. */
export interface PartnerOffer {
  provider: PartnerProvider;
  label: string;
  available: boolean;
  reason: string | null;
  /** Already evaluated there: picking it runs it again. */
  done: boolean;
  gpu: string | null;
  hourlyUsd: number | null;
  /** Its stop time and that time's cost at list price, on its own (a run of several may give a later one less). */
  minutes: number | null;
  maxUsd: number | null;
  /** The job's own base answers are used: the partner answers only the tuned model. */
  baseFromJob: boolean;
}

export interface PartnerOffers {
  offers: PartnerOffer[];
  /** Each one's most, and a run's most in all. */
  maxUsd: number;
  runMaxUsd: number | null;
}

/** Pure: one partner's offer from the same checks the plan step makes (with again, so a finished one can be picked). */
export function partnerOffer(input: {
  provider: PartnerProvider;
  facts: HostFacts;
  refusal: string | null;
  fireworks: string | null;
  price: HostPrice;
  settings: Pick<PartnerSettings, "hostOn" | "maxUsd" | "maxMinutes">;
  items: number;
  results: PartnerEvalBody[];
  judgeReady: string | null;
  now: Date;
}): PartnerOffer {
  const label = PARTNER_LABEL[input.provider];
  const mine = input.results.filter((r) => r.provider === input.provider);
  const done = [...mine].reverse().find((r) => r.status !== "skipped")?.status === "done";
  const budget = partnerBudget(input.price, input.settings);
  const reason =
    (input.settings.hostOn ? null : "HOST_TUNED is off, and partner evals need its 5-minute sweep as the backstop that stops a GPU.") ??
    partnerProblem({ facts: input.facts, refusal: input.refusal ?? input.fireworks, items: input.items, results: mine, judgeReady: input.judgeReady, again: true, now: input.now }) ??
    (budget.ok ? null : budget.reason);
  return {
    provider: input.provider,
    label,
    available: !reason,
    reason,
    done,
    gpu: input.price.gpu || null,
    hourlyUsd: input.price.hourlyUsd > 0 ? input.price.hourlyUsd : null,
    minutes: budget.ok ? budget.minutes : null,
    maxUsd: budget.ok ? budget.maxUsd : null,
    baseFromJob: baseFromJob(input.provider),
  };
}

/** The most a run of these picks may cost in all, one after another, each held to what the run has left. */
export function runEstimateUsd(offers: readonly Pick<PartnerOffer, "available" | "maxUsd">[], runMaxUsd: number | null): number {
  let total = 0;
  for (const o of offers) {
    if (!o.available || o.maxUsd === null) continue;
    const left = runMaxUsd === null ? Number.POSITIVE_INFINITY : runMaxUsd - total;
    total += Math.min(o.maxUsd, Math.max(0, left));
  }
  return Math.round(total * 100) / 100;
}
