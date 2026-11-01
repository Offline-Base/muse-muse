import { JOB_HEADER } from "@/lib/caps/principal";
import { JOBS_LIMITS } from "@/lib/caps/jobs/limits";
import { readJobToken } from "@/lib/caps/jobs/token";
import { dayWindow } from "@/lib/caps/gate";
import { gatewayError } from "@/lib/gateway/errors";
import type { RunLimitReason, RunLimits } from "@/lib/gateway/runs";

/**
 * A job's model calls (docs/CAPABILITIES.md, section 12). A call with x-musemuse-job holds and settles its run's dollars
 * through lib/gateway/runs.ts, as an agent run's do, on top of the token's daily budget. Two differences:
 *
 * - The counters are keyed by product and run and pinned to one window, past the run's age limit, because a job's ticks
 *   can span hours, a redeploy's new token and the hourly turnover an agent run's counters follow.
 * - A run really out of dollars or turns stops for good, and it tells the owner. What was held isn't spent, so a call that
 *   doesn't fit next to other calls' holds, or asks for more than what's left, is only refused, and can ask for less.
 *
 * JOBS_DAILY_USD is what all job runs on the platform may spend in a UTC day. A call starts only with some left, so
 * the most it can go over is what the calls already running cost, each within its run's dollars.
 */
export interface JobCall {
  runId: string;
  limits: RunLimits;
  /** holdRun's clock, so the counters stay in one window for the run's whole life. */
  windowAt: Date;
  /** The key the run's counters go under. */
  counterKey: string;
  /** holdRun refused this call, because of this limit. */
  refused(reason: RunLimitReason): Promise<void>;
  /** What one call really cost. */
  spent(usd: number): Promise<void>;
}

export interface JobCallDeps {
  getRun(runId: string): Promise<{ id: string; productId: string; namespace: string; status: string; budgetUsd: number; costUsd: number; createdAt: Date } | null>;
  addRunCost(runId: string, usd: number): Promise<void>;
  stopRun(runId: string, now: Date, why?: string): Promise<boolean>;
  addNotice(input: { productId: string; namespace: string; kind: "job_failed"; title: string; body: string }): Promise<unknown>;
  dailyUsd(): number;
  counterValue(key: string, windowStart: Date): Promise<number>;
  adjustCounter(key: string, windowStart: Date, delta: number): Promise<void>;
}

const DAILY_KEY = "jobs-usd";

const refuse = (status: number, type: "permission_error" | "insufficient_quota" | "server_error", code: string, message: string) => gatewayError(status, type, code, message, { retry: false });

/** The job a model call belongs to, null when it names none, or the refusal. */
export async function jobCallOf(req: Request, token: { productId: string; scope: string; buildId?: string | null }, deps: JobCallDeps, now: Date): Promise<JobCall | Response | null> {
  const header = req.headers.get(JOB_HEADER);
  if (header === null) return null;
  const read = readJobToken(header, token, now);
  if (!read) return refuse(403, "permission_error", "invalid_job_token", "That job token isn't good any more. A job's calls have to happen during its tick.");
  const run = await deps.getRun(read.runId);
  const namespace = token.scope === "build" ? `b:${token.buildId}` : "live";
  if (!run || run.productId !== token.productId || run.namespace !== namespace) return refuse(403, "permission_error", "invalid_job_token", "That job token isn't for this product.");
  if (run.status !== "running") return gatewayError(429, "rate_limit_error", "run_limit", `This job run is ${run.status}, so it can't make more model calls.`, { retry: false });
  const daily = deps.dailyUsd();
  if (daily === 0) return refuse(503, "server_error", "caps_paused", "Background jobs are paused on Muse Muse today.");
  const day = dayWindow(now);
  if (token.scope !== "build" && (await deps.counterValue(DAILY_KEY, day)) / 1e6 >= daily) return refuse(429, "insufficient_quota", "budget_exceeded", "Background jobs have used their daily budget on Muse Muse. It resets at 00:00 UTC.");
  return {
    runId: run.id,
    limits: { turns: JOBS_LIMITS.runTurns, toolCalls: JOBS_LIMITS.runToolCalls, usd: run.budgetUsd },
    windowAt: new Date(run.createdAt.getTime() + JOBS_LIMITS.runMaxAgeMs),
    counterKey: run.productId,
    async refused(reason) {
      // Built-in tool calls can be left out of the next call, and the refusal says so.
      if (reason === "tool_calls") return;
      // Holds aren't spending. While settled money plus the smallest useful call fits, the run isn't over: the call only
      // has to wait for another to finish, or ask for fewer tokens, as its refusal says.
      if (reason === "usd" && run.costUsd + JOBS_LIMITS.smallestCallUsd <= run.budgetUsd) return;
      const turns = reason === "turns";
      if (!(await deps.stopRun(run.id, now, turns ? `It used all of its ${JOBS_LIMITS.runTurns} model calls.` : undefined))) return;
      if (run.namespace !== "live") return;
      await deps.addNotice(
        turns
          ? { productId: run.productId, namespace: run.namespace, kind: "job_failed", title: "A job used all of its model calls", body: `A run stopped after ${JOBS_LIMITS.runTurns} model calls. What it saved so far is kept.` }
          : { productId: run.productId, namespace: run.namespace, kind: "job_failed", title: "A job stopped at its dollar limit", body: `A run stopped at its limit of $${run.budgetUsd.toFixed(2)}. What it saved so far is kept.` },
      );
    },
    async spent(usd) {
      await deps.addRunCost(run.id, usd);
      if (token.scope !== "build" && usd > 0) await deps.adjustCounter(DAILY_KEY, day, Math.ceil(usd * 1e6));
    },
  };
}
