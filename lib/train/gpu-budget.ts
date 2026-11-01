/**
 * The lifetime limits on Lambda GPU spend (docs/TRAINING.md "Limits"): TRAIN_USER_LIMIT_USD for one person and
 * TRAIN_TOTAL_LIMIT_USD for everyone. Pure. The totals come from training_jobs, the one way a Lambda GPU starts (a hosted
 * endpoint on Lambda and a demo window are serve jobs there too), so nothing extra has to be kept in step. A row is
 * never deleted, so a job's money stays counted for good.
 */
import { usd } from "@/lib/format";
import { estimateCostUsd, MIN_MAX_USD } from "@/lib/train/logic";
import { isTrainTerminal, type TrainStatus } from "@/lib/train/types";

export interface GpuSpendRow {
  status: TrainStatus;
  priceCentsPerHour: number;
  maxUsd: number;
  launchedAt: Date | null;
  terminatedAt: Date | null;
  costUsd: number;
  createdBy?: string | null;
}

/**
 * What one job holds: an unfinished job its full dollar limit (or its estimate, once that is higher), an ended job with
 * its GPU not confirmed down its running estimate, and any other its final cost.
 */
export function jobHoldUsd(row: GpuSpendRow, now: Date): number {
  if (!isTrainTerminal(row.status)) return Math.max(row.maxUsd, estimateCostUsd(row, now));
  return row.terminatedAt ? row.costUsd : estimateCostUsd(row, now);
}

export interface GpuBudget {
  userUsedUsd: number;
  userLimitUsd: number;
  /** Rounded down to whole cents, never below 0. */
  userLeftUsd: number;
  totalUsedUsd: number;
  totalLimitUsd: number;
  totalLeftUsd: number;
  /** The smaller of the two. */
  leftUsd: number;
  /** Which limit that is. */
  scope: "user" | "total";
}

const micro = (n: number) => Math.round(n * 1e6) / 1e6;
const leftOf = (limit: number, used: number) => Math.max(0, Math.floor((limit - used) * 100 + 1e-6) / 100);

/** The two limits as they stand. A job with no created_by counts only toward the total. */
export function gpuBudget(rows: readonly GpuSpendRow[], userId: string, limits: { userUsd: number; totalUsd: number }, now: Date): GpuBudget {
  let user = 0;
  let total = 0;
  for (const row of rows) {
    const hold = jobHoldUsd(row, now);
    total += hold;
    if (row.createdBy === userId) user += hold;
  }
  const userLeftUsd = leftOf(limits.userUsd, user);
  const totalLeftUsd = leftOf(limits.totalUsd, total);
  return {
    userUsedUsd: micro(user),
    userLimitUsd: limits.userUsd,
    userLeftUsd,
    totalUsedUsd: micro(total),
    totalLimitUsd: limits.totalUsd,
    totalLeftUsd,
    leftUsd: Math.min(userLeftUsd, totalLeftUsd),
    scope: totalLeftUsd < userLeftUsd ? "total" : "user",
  };
}

/**
 * A job's dollar limit held to what is left of both limits, or null when what's left is under the smallest limit a job
 * can have. `held` says the limit came down, so a job that then can't fit is refused for the money, not for its size.
 */
export function holdToBudget(maxUsd: number, budget: GpuBudget): { maxUsd: number; held: boolean } | null {
  if (budget.leftUsd < MIN_MAX_USD) return null;
  return budget.leftUsd < maxUsd ? { maxUsd: budget.leftUsd, held: true } : { maxUsd, held: false };
}

/** True when either limit has been passed: what a start checks again once its own row counts. */
export function budgetPassed(b: GpuBudget): boolean {
  return b.userUsedUsd > b.userLimitUsd + 1e-6 || b.totalUsedUsd > b.totalLimitUsd + 1e-6;
}

function leftText(b: GpuBudget): string {
  return b.scope === "total"
    ? `The platform has ${usd(b.totalLeftUsd)} left of its ${usd(b.totalLimitUsd)} GPU budget.`
    : `You have ${usd(b.userLeftUsd)} left of your ${usd(b.userLimitUsd)} GPU limit.`;
}

/** Why a start was refused, with what's left. Running jobs hold their full limit, so ending one can give some back. */
export function budgetRefusalText(b: GpuBudget): string {
  return `${leftText(b)} That isn't enough for this job, and jobs still running count at their full dollar limit.`;
}

/** For a start that backed out because another took the same money at the same moment. */
export function budgetRaceText(b: GpuBudget): string {
  return `Another job started at the same moment and the two together would pass the GPU limit, so this one didn't start. ${leftText(b)}`;
}
