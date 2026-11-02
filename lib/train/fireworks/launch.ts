/**
 * Starting a Fireworks job: the live quote, then the limits every job passes (TRAIN_MAX_ACTIVE, TRAIN_USER_LIMIT_USD,
 * TRAIN_TOTAL_LIMIT_USD, TRAIN_DAILY_USD), with the job's hold written on its row, so Fireworks' money counts where Lambda's
 * does. A Lambda job's sweep and capacity checks don't apply: there is no instance of ours to leave billing.
 */
import { env } from "@/lib/env";
import { budgetPassed, budgetRaceText, budgetRefusalText, holdToBudget, type GpuBudget } from "@/lib/train/gpu-budget";
import { BASE_MODEL_PARAM } from "@/lib/train/base";
import { ADAPTER_RECIPE, type TrainJobRow } from "@/lib/train/logic";
import { FW_BASE_MODEL, holdFor, type FireworksQuote } from "@/lib/train/fireworks/quote";

export const FW_INSTANCE_TYPE = "fireworks-managed-sft";
export const FW_TRAINER = "fireworks";
export const FW_EPOCHS = 1;

export type FwLaunchResult = { ok: true; job: TrainJobRow } | { ok: false; status: number; code: string; body?: Record<string, unknown> };

export interface FwPlan {
  scoring: boolean;
  evalMaxUsd: number;
  holdUsd: number;
  ratePerMTokens: number;
}

export interface FwLaunchDeps {
  activeJobCount(): Promise<number>;
  gpuBudgetFor(userId: string): Promise<GpuBudget>;
  trainingCommittedToday(): Promise<number>;
  createJob(input: Parameters<typeof import("@/lib/train/store").createJob>[0]): Promise<TrainJobRow>;
  setStatus(jobId: string, status: "failed", opts: { message: string; set: { error: string } }): Promise<unknown>;
  attachRun(jobId: string, runId: string): Promise<void>;
  startWorkflow(jobId: string): Promise<string>;
}

async function defaultDeps(): Promise<FwLaunchDeps> {
  const store = await import("@/lib/train/store");
  return {
    activeJobCount: store.activeJobCount,
    gpuBudgetFor: store.gpuBudgetFor,
    trainingCommittedToday: store.trainingCommittedToday,
    createJob: store.createJob,
    setStatus: store.setStatus,
    attachRun: store.attachRun,
    async startWorkflow(jobId) {
      const [{ start }, { fireworksTrain }] = await Promise.all([import("workflow/api"), import("@/lib/train/fireworks/workflow")]);
      return (await start(fireworksTrain, [{ jobId }])).runId;
    },
  };
}

/** The run's plan from a live quote, or the refusal: a job whose cost Fireworks' pages don't confirm never starts. */
export function planFromQuote(quote: FireworksQuote, evalItems: number): { ok: true; plan: FwPlan } | { ok: false; status: number; code: string; body: Record<string, unknown> } {
  if (!env.fireworksTune) return { ok: false, status: 404, code: "fireworks_off", body: {} };
  if (!quote.ok) return { ok: false, status: 503, code: "fireworks_cost_unconfirmed", body: { reason: quote.reason } };
  return { ok: true, plan: { ...holdFor(evalItems, quote.ratePerMTokens, env.fireworksEvalMaxUsd), ratePerMTokens: quote.ratePerMTokens } };
}

function limitRefusal(budget: GpuBudget, raced = false): FwLaunchResult {
  return { ok: false, status: 429, code: "gpu_limit", body: { reason: raced ? budgetRaceText(budget) : budgetRefusalText(budget), scope: budget.scope, leftUsd: budget.leftUsd, ...(raced ? { raced: true } : {}) } };
}

export async function launchFireworksJob(
  input: { datasetId: string; title: string; loraRank: number; learningRate: number; maxMinutes: number; plan: FwPlan },
  caller: { userId: string },
  given?: FwLaunchDeps,
): Promise<FwLaunchResult> {
  if (!env.fireworksTune) return { ok: false, status: 404, code: "fireworks_off" };
  if (!process.env.FIREWORKS_API_KEY?.trim()) return { ok: false, status: 503, code: "fireworks_not_configured" };
  const deps = given ?? (await defaultDeps());
  const { plan } = input;
  if ((await deps.activeJobCount()) >= env.trainMaxActive) return { ok: false, status: 409, code: "too_many_active", body: { max: env.trainMaxActive } };
  const budget = await deps.gpuBudgetFor(caller.userId);
  const held = holdToBudget(plan.holdUsd, budget);
  // The hold is what the job can cost, so it can't come down to fit, as a GPU's limit can.
  if (!held || held.held) return limitRefusal(budget);
  const daily = () => ({ ok: false as const, status: 503, code: "daily_cap", body: { dailyUsd: env.trainDailyUsd, jobMaxUsd: plan.holdUsd } });
  if ((await deps.trainingCommittedToday()) + plan.holdUsd > env.trainDailyUsd) return daily();

  const job = await deps.createJob({
    recipe: ADAPTER_RECIPE,
    title: input.title,
    params: {
      datasetId: input.datasetId,
      trainer: FW_TRAINER,
      [BASE_MODEL_PARAM]: FW_BASE_MODEL,
      epochs: FW_EPOCHS,
      loraRank: input.loraRank,
      learningRate: input.learningRate,
      studentPrompt: "short",
      publish: 0,
      fwScoring: plan.scoring ? 1 : 0,
      fwEvalMaxUsd: plan.evalMaxUsd,
      fwRate: plan.ratePerMTokens,
    },
    instanceType: FW_INSTANCE_TYPE,
    region: "fireworks",
    priceCentsPerHour: 0,
    maxMinutes: input.maxMinutes,
    maxUsd: plan.holdUsd,
    createdBy: caller.userId,
  });
  const backOut = (why: string) => deps.setStatus(job.id, "failed", { message: why, set: { error: why } });
  // Two starts at once each count the other once its row is saved, as launchJob's do.
  const tooMany = (await deps.activeJobCount()) > env.trainMaxActive;
  const after = await deps.gpuBudgetFor(caller.userId);
  const over = budgetPassed(after);
  if (tooMany || over || (await deps.trainingCommittedToday()) > env.trainDailyUsd) {
    await backOut("Another job started at the same moment, so this one was not started.");
    if (tooMany) return { ok: false, status: 409, code: "too_many_active", body: { max: env.trainMaxActive } };
    return over ? limitRefusal(after, true) : daily();
  }
  let runId: string;
  try {
    runId = await deps.startWorkflow(job.id);
  } catch (err) {
    console.error("[train/fireworks] start", err instanceof Error ? err.message : "unknown");
    await backOut("The job's workflow could not start, so nothing was sent to Fireworks.").catch(() => undefined);
    return { ok: false, status: 500, code: "start_failed" };
  }
  await deps.attachRun(job.id, runId).catch((err) => console.error("[train/fireworks] attachRun", err));
  return { ok: true, job };
}
