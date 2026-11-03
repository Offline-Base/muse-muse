/**
 * The steps of a partner eval (lib/train/partner/workflow.ts). Each reads what it needs again, so a retried step does
 * no harm: the plan records "started" once it has checked everything, the deploy finds its own endpoint again after a
 * crash, and the stop is the hosting code's, which is safe to repeat. Every provider call goes through
 * lib/train/host/service.ts, so the hosting limits, the reservation and the 5-minute sweep hold here as they do for Run it.
 */
import { judgeModelOf, UNRECORDED_MODEL } from "@/lib/train/models";
import { defaultModel } from "@/lib/meta/spark";
import { ADAPTER_RECIPE, CHAT_MODE, EVAL_TEXT_MAX, jobMode } from "@/lib/train/logic";
import { checkSetOf } from "@/lib/train/general-checks";
import { hostFacts } from "@/lib/train/host/facts";
import { STOP_WORDS } from "@/lib/train/host/limits";
import { chatOnEndpoint, deployEndpoint, providerRefusal, refreshEndpoint, stopEndpoint } from "@/lib/train/host/service";
import { HostError, type HostEndpoint } from "@/lib/train/host/types";
import { currentPartnerDeps as deps, type PartnerDeps } from "@/lib/train/partner/deps";
import {
  allowedPartners,
  baseFromJob,
  fireworksPartnerProblem,
  PARTNER_LABEL,
  PARTNER_MAX_ITEMS,
  PARTNER_MAX_TOKENS,
  partnerBudget,
  partnerProblem,
  readyWindowMinutes,
  reasonText,
  runLeftUsd,
} from "@/lib/train/partner/logic";
import type { JudgedItem } from "@/lib/train/logic";
import type { PartnerEvalBody, PartnerProvider } from "@/lib/train/types";


export interface PartnerEvalInput {
  jobId: string;
  /** Left out: PARTNER_EVALS picks. An admin's start may name the other partner. */
  provider?: PartnerProvider;
  /** An admin's start: run a finished one again. */
  again?: boolean;
  /** Started by the training workflow for every job that succeeded: one that was never a tuned chat model is passed over without a word. */
  auto?: boolean;
  /** An admin's run of several partners, one after another: what the earlier ones cost, held to PARTNER_EVAL_RUN_MAX_USD. */
  run?: { spentUsd: number };
}

export interface PartnerPlan {
  action: "go";
  provider: PartnerProvider;
  startedAt: string;
  minutes: number;
  maxUsd: number;
  hourlyUsd: number;
  gpu: string;
  indexes: number[];
  task: string | null;
  judgeModel: string;
  system: string | null;
  baseRepo: string | null;
  readyMinutes: number;
  /** The partner answers only the tuned model; the base answers are the job's own (Fireworks). */
  baseFromJob: boolean;
}

export type PartnerPlanResult = PartnerPlan | { action: "skip"; reason: string | null };

/** Records a skip, unless the last thing recorded for this partner already says the same. */
async function skip(d: PartnerDeps, jobId: string, provider: PartnerProvider, reason: string, results: PartnerEvalBody[]): Promise<PartnerPlanResult> {
  const text = reasonText(reason);
  const last = results.filter((r) => r.provider === provider).pop();
  if (!(last?.status === "skipped" && last.reason === text)) {
    await d.record(jobId, { type: "partner_eval", provider, status: "skipped", reason: text, endedAt: d.now().toISOString() });
  }
  return { action: "skip", reason: text };
}

/**
 * Whether to go, and with what. Nothing is recorded when PARTNER_EVALS is off. Otherwise a reason not to go is recorded
 * as "skipped" (the room shows it), and a go is recorded as "started" with its limits.
 */
export async function partnerPlanStep(input: PartnerEvalInput): Promise<PartnerPlanResult> {
  "use step";
  const d = deps();
  const s = d.settings();
  if (!s.provider) return { action: "skip", reason: null };
  const provider = input.provider ?? s.provider;
  const allowed = allowedPartners(s);
  const source = await d.source(input.jobId);
  if (!source) return { action: "skip", reason: "There is no such job." };
  // A quantize, publish or serve job, a decide job or a dry run succeeds too: nothing to evaluate, and nothing on its log.
  if (input.auto && (source.job.recipe !== ADAPTER_RECIPE || jobMode(source.job.params) !== CHAT_MODE || Number(source.job.params?.dryRun) >= 1)) {
    return { action: "skip", reason: null };
  }
  const all = await d.results(input.jobId);
  const results = all.filter((r) => r.provider === provider);
  if (!allowed.includes(provider)) return skip(d, input.jobId, provider, `PARTNER_EVALS doesn't include ${PARTNER_LABEL[provider]}, so it wasn't offered.`, all);
  if (!s.hostOn) return skip(d, input.jobId, provider, "HOST_TUNED is off, and partner evals need its 5-minute sweep as the backstop that stops a GPU.", all);

  const facts = hostFacts(source.job, source.metrics);
  const host = d.host();
  const adapter = host.adapter(provider);
  const indexes = (await d.evalIndexes(input.jobId)).filter((i) => checkSetOf(i) === null).slice(0, PARTNER_MAX_ITEMS);
  const now = d.now();
  let refusal = providerRefusal(facts, adapter);
  // Fireworks: a lab adapter's adapter_config.json must list its target modules. Read (free) before anything is created.
  if (!refusal && provider === "fireworks" && !facts.fireworksModel && facts.hubRepo && facts.hubCommit) {
    refusal = fireworksPartnerProblem(facts, await d.adapterConfig(facts.hubRepo, facts.hubCommit));
  }
  const problem = partnerProblem({ facts, refusal, items: indexes.length, results, judgeReady: await d.judgeReady(), again: input.again, now });
  if (problem) return skip(d, input.jobId, provider, problem, all);

  const price = adapter.price(facts);
  // In a run of several, this one gets at most what the run has left.
  const left = input.run ? runLeftUsd(s.runMaxUsd, input.run.spentUsd) : Number.POSITIVE_INFINITY;
  if (input.run && !(left > 0)) return skip(d, input.jobId, provider, "This run of partner evals has used PARTNER_EVAL_RUN_MAX_USD, so it stopped before this one.", all);
  const budget = partnerBudget(price, { maxUsd: Math.min(s.maxUsd, left), maxMinutes: s.maxMinutes });
  if (!budget.ok) return skip(d, input.jobId, provider, left < s.maxUsd ? `What this run has left of PARTNER_EVAL_RUN_MAX_USD is too little. ${budget.reason}` : budget.reason, all);

  const recorded = judgeModelOf(source.job);
  // A job judged before judge_model was saved: today's judge (JUDGE_MODEL in lib/train/judge.ts is defaultModel()).
  const judgeModel = recorded && recorded !== UNRECORDED_MODEL ? recorded : defaultModel();
  const datasetId = typeof source.job.params?.datasetId === "string" ? source.job.params.datasetId : null;
  const recordedSystem = typeof source.metrics?.system === "string" && source.metrics.system.trim() ? source.metrics.system : null;
  // Read before "started" is recorded: a retry after a failure here would otherwise find its own "started" and stop.
  const task = datasetId ? await d.datasetTask(datasetId) : null;
  // A Fireworks run records no done metrics: its system message is the one it trained under, rebuilt from the dataset.
  const system = recordedSystem ?? (facts.fireworksModel && datasetId ? await d.fireworksSystem(datasetId) : null);
  const fromJob = baseFromJob(provider);
  const startedAt = now.toISOString();
  await d.record(input.jobId, {
    type: "partner_eval",
    provider,
    status: "started",
    gpu: price.gpu,
    hourlyUsd: price.hourlyUsd,
    minutes: budget.minutes,
    maxUsd: budget.maxUsd,
    asked: indexes.length,
    judgeModel,
    ...(fromJob ? { baseFrom: "job" as const } : {}),
    startedAt,
  });
  return {
    action: "go",
    provider,
    startedAt,
    minutes: budget.minutes,
    maxUsd: budget.maxUsd,
    hourlyUsd: price.hourlyUsd,
    gpu: price.gpu,
    indexes,
    task,
    judgeModel,
    system,
    baseRepo: facts.servingBase?.repo ?? null,
    readyMinutes: readyWindowMinutes(budget.minutes),
    baseFromJob: fromJob,
  };
}
partnerPlanStep.maxRetries = 2;

/** This eval's own endpoint: the adapter's, started since the plan. */
function ownRow(rows: HostEndpoint[], jobId: string, provider: PartnerProvider, since: string): HostEndpoint | null {
  const from = Date.parse(since) - 1_000;
  return rows.filter((e) => e.adapterJobId === jobId && e.provider === provider && e.createdAt.getTime() >= from).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

export type PartnerDeployResult = { ok: true; endpointId: string } | { ok: false; reason: string; costUsd: number | null };

/**
 * Starts the endpoint through the hosting code, with the stop time this eval's budget allows. A retry after a crash finds
 * the endpoint the first try made, by the adapter and the plan's start, and goes on with it.
 */
export async function partnerDeployStep(input: { jobId: string; plan: PartnerPlan }): Promise<PartnerDeployResult> {
  "use step";
  const d = deps();
  const { plan } = input;
  const host = d.host({ maxMinutes: plan.minutes });
  const now = d.now();
  const mine = ownRow(await host.rows(now), input.jobId, plan.provider, plan.startedAt);
  if (mine && (mine.status === "starting" || mine.status === "live")) return { ok: true, endpointId: mine.id };
  if (mine) return { ok: false, reason: mine.stopReason ? STOP_WORDS[mine.stopReason] : "It stopped while it was starting.", costUsd: mine.costUsd };
  const source = await d.source(input.jobId);
  if (!source) return { ok: false, reason: "The job is gone.", costUsd: 0 };
  try {
    const { endpoint } = await deployEndpoint({ provider: plan.provider, facts: hostFacts(source.job, source.metrics), callerId: source.job.createdBy ?? null }, host, now);
    return { ok: true, endpointId: endpoint.id };
  } catch (err) {
    const after = ownRow(await host.rows(d.now()).catch(() => []), input.jobId, plan.provider, plan.startedAt);
    if (err instanceof HostError && err.code === "already_hosted" && !after) {
      return { ok: false, reason: "This model already has a hosted endpoint open, so the eval didn't start another. Stop it first.", costUsd: 0 };
    }
    const words = err instanceof HostError ? err.message : `${PARTNER_LABEL[plan.provider]} couldn't deploy it.`;
    return { ok: false, reason: words, costUsd: after?.costUsd ?? (after ? null : 0) };
  }
}
partnerDeployStep.maxRetries = 1;

export type PartnerWait = { state: "live" | "starting" } | { state: "gone"; reason: string };

/** Asks the provider how a starting endpoint is doing (the hosting code's refresh, which stops one that failed). */
export async function partnerWaitStep(input: { endpointId: string }): Promise<PartnerWait> {
  "use step";
  const d = deps();
  const host = d.host();
  const now = d.now();
  const row = (await host.rows(now)).find((e) => e.id === input.endpointId);
  if (!row) return { state: "gone", reason: "Its endpoint's record is gone." };
  const current = await refreshEndpoint(row, host, now);
  if (current.status === "live") return { state: "live" };
  if (current.status === "starting") return { state: "starting" };
  return { state: "gone", reason: current.stopReason ? STOP_WORDS[current.stopReason] : "Its endpoint stopped." };
}
partnerWaitStep.maxRetries = 3;

export type PartnerAnswerResult =
  | { ok: true; text: string; ms: number }
  /** retry: waking, try again after afterSeconds. stop: the endpoint is closed or out of budget, so nothing else can be asked. */
  | { ok: false; retry: boolean; stop: boolean; afterSeconds: number; reason: string };

const RETRY_CODES = new Set(["endpoint_waking", "endpoint_starting"]);
const STOP_CODES = new Set(["endpoint_closed", "budget_exceeded", "cant_host"]);

/** One held-out prompt answered on the partner, by the base or the tuned model, under the job's own system message, greedily. */
export async function partnerAnswerStep(input: { jobId: string; endpointId: string; index: number; variant: "base" | "tuned"; system: string | null; baseRepo: string | null }): Promise<PartnerAnswerResult> {
  "use step";
  const d = deps();
  const item = await d.evalItem(input.jobId, input.index);
  if (!item) return { ok: false, retry: false, stop: false, afterSeconds: 0, reason: "The held-out prompt is gone." };
  const host = d.host();
  const now = d.now();
  const row = (await host.rows(now)).find((e) => e.id === input.endpointId);
  if (!row) return { ok: false, retry: false, stop: true, afterSeconds: 0, reason: "Its endpoint's record is gone." };
  const messages = [...(input.system ? [{ role: "system" as const, content: input.system }] : []), { role: "user" as const, content: item.prompt }];
  const t0 = d.clock();
  try {
    const reply = await chatOnEndpoint(row, { messages, stop: [], maxTokens: PARTNER_MAX_TOKENS, variant: input.variant, baseRepo: input.baseRepo, greedy: true }, host, now);
    return { ok: true, text: reply.text.slice(0, EVAL_TEXT_MAX), ms: Math.round(d.clock() - t0) };
  } catch (err) {
    if (!(err instanceof HostError)) return { ok: false, retry: false, stop: false, afterSeconds: 0, reason: "The answer failed." };
    return { ok: false, retry: RETRY_CODES.has(err.code), stop: STOP_CODES.has(err.code), afterSeconds: err.retryAfterSeconds ?? 30, reason: err.message };
  }
}
partnerAnswerStep.maxRetries = 1;

/**
 * The partner's two answers to one prompt, judged blind by the job's own judge against the reference. A null base is the
 * job's own recorded base answer (a partner that hosts only the tuned model). Null when it fails or there is none.
 */
export async function partnerJudgeStep(input: { jobId: string; index: number; base: string | null; tuned: string; judgeModel: string; task: string | null }): Promise<(JudgedItem & { index: number }) | null> {
  "use step";
  const d = deps();
  const item = await d.evalItem(input.jobId, input.index);
  if (!item) return null;
  const base = input.base ?? (item.base?.trim() ? item.base : null);
  if (base === null) return null;
  try {
    const v = await d.judge({ model: input.judgeModel, task: input.task, index: input.index, prompt: item.prompt, reference: item.reference, base, tuned: input.tuned });
    return { index: input.index, baseScore: v.baseScore, tunedScore: v.tunedScore, better: v.better, costUsd: v.costUsd };
  } catch {
    return null;
  }
}
partnerJudgeStep.maxRetries = 1;

/** Tears the endpoint down (the hosting code's stop, safe to repeat). done false: not confirmed, and the sweep keeps trying. */
export async function partnerStopStep(input: { endpointId: string }): Promise<{ done: boolean; costUsd: number | null }> {
  "use step";
  const d = deps();
  const host = d.host();
  const now = d.now();
  const row = (await host.rows(now)).find((e) => e.id === input.endpointId);
  if (!row) return { done: true, costUsd: null };
  if (row.status === "stopped" || row.status === "failed") return { done: true, costUsd: row.costUsd };
  try {
    const after = await stopEndpoint(row, "person", host, now);
    const done = after.status === "stopped" || after.status === "failed";
    return { done, costUsd: done ? after.costUsd : null };
  } catch {
    return { done: false, costUsd: null };
  }
}
partnerStopStep.maxRetries = 2;

/** The ending, on the job's log. */
export async function partnerSaveStep(input: { jobId: string; body: PartnerEvalBody }): Promise<void> {
  "use step";
  await deps().record(input.jobId, input.body);
}
partnerSaveStep.maxRetries = 10;
