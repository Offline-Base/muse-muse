import { gatewayError } from "@/lib/gateway/errors";
import { hasAgentMarker, hasLongAgentMarker } from "@/lib/gateway/policy";

/**
 * Per-run caps. A product names a run with x-musemuse-run-id (template/lib/agent/run.ts sends it), and every model call
 * and tool in that run share its turns, built-in tool calls and dollars, so one runaway loop stops long before the
 * token's daily budget. The counters live in rate_limits with one-hour windows, keyed by token and run, and each call
 * holds what it may use and is settled to what it did, the way spend reservations work.
 *
 * The header is cooperative: a request without it isn't part of a run. Live tokens without the agent marker have no
 * run caps at all, so today's products behave as they did.
 */

export interface RunLimits {
  turns: number;
  toolCalls: number;
  usd: number;
}

export const RUN_LIMITS = {
  build: { turns: 6, toolCalls: 8, usd: 0.4 },
  /**
   * A build's own test of a long-run recipe's product (AGENT_LONG_RUNS). A long agent can't reach a stop, an answer and its
   * end in 6 turns, so the build's smoke test could only fake them. All of a build's tests still share its token's budget.
   */
  buildLong: { turns: 30, toolCalls: 30, usd: 1.5 },
  liveAgent: { turns: 10, toolCalls: 12, usd: 0.75 },
  /**
   * A long-run recipe's product (AGENT_LONG_RUNS). These reset with RUN_WINDOW_MS like the others, so a run past an hour
   * starts fresh counters: the product adds up its own cost and stops at its own ceiling, and the token's daily budget
   * (AGENT_LONG_DAILY_USD) is the real backstop.
   */
  longAgent: { turns: 80, toolCalls: 120, usd: 15 },
} as const satisfies Record<string, RunLimits>;

/** How long a run's counters last. A run still going after the hour turns over starts fresh counters. */
export const RUN_WINDOW_MS = 3_600_000;

const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The run a request names, or null when the header is missing or malformed. */
export function parseRunId(header: string | null): string | null {
  return header !== null && RUN_ID.test(header) ? header : null;
}

/** This token's run caps, or null when it has none. */
export function runLimitsFor(token: { scope: string; allowedModels: readonly string[] }): RunLimits | null {
  if (token.scope === "build") return hasLongAgentMarker(token.allowedModels) ? RUN_LIMITS.buildLong : RUN_LIMITS.build;
  if (hasLongAgentMarker(token.allowedModels)) return RUN_LIMITS.longAgent;
  return hasAgentMarker(token.allowedModels) ? RUN_LIMITS.liveAgent : null;
}

/** The counters holdRun and settleRun use, from lib/gateway/store.ts. */
export interface RunCounters {
  reserveCounter(key: string, windowStart: Date, amount: number, limit: number): Promise<number | null>;
  adjustCounter(key: string, windowStart: Date, delta: number): Promise<void>;
  counterValue(key: string, windowStart: Date): Promise<number>;
}

/** What one call holds in its run, for settleRun or releaseRun. */
export interface RunHold {
  window: Date;
  turnsKey: string;
  callsKey: string;
  usdKey: string;
  turns: number;
  toolCalls: number;
  micros: number;
}

export type RunLimitReason = "turns" | "tool_calls" | "usd";

export type RunHoldResult = { ok: true; hold: RunHold; toolCalls: number } | { ok: false; reason: RunLimitReason; response: Response };

function micros(usd: number): number {
  return Math.ceil(usd * 1e6);
}

function runWindow(now: Date): Date {
  return new Date(Math.floor(now.getTime() / RUN_WINDOW_MS) * RUN_WINDOW_MS);
}

function runLimit(message: string): Response {
  return gatewayError(429, "rate_limit_error", "run_limit", message, { retry: false });
}

/**
 * Holds one call's share of its run: `turns` model turns, up to `toolCalls` built-in tool calls, and `usd` dollars.
 * When fewer tool calls are left than asked for, it holds what's left and says so in `toolCalls`, so the caller can
 * lower max_tool_calls and let the turn run. `usd` can be a function of the tool calls held, since an estimate counts
 * them: when the dollars don't cover that many, it holds as many as they do, and refuses only if one doesn't fit.
 * Going over a limit returns a 429 run_limit and holds nothing.
 */
export async function holdRun(
  deps: RunCounters,
  opts: { tokenId: string; runId: string; limits: RunLimits; turns?: number; toolCalls?: number; usd?: number | ((toolCalls: number) => number); now: Date },
): Promise<RunHoldResult> {
  const { tokenId, runId, limits } = opts;
  const window = runWindow(opts.now);
  const hold: RunHold = {
    window,
    turnsKey: `run-turns:${tokenId}:${runId}`,
    callsKey: `run-calls:${tokenId}:${runId}`,
    usdKey: `run-usd:${tokenId}:${runId}`,
    turns: 0,
    toolCalls: 0,
    micros: 0,
  };
  const turns = opts.turns ?? 1;
  if (turns > 0) {
    if ((await deps.reserveCounter(hold.turnsKey, window, turns, limits.turns)) === null) {
      return { ok: false, reason: "turns", response: runLimit(`This run reached its limit of ${limits.turns} model turns. Finish with what it has, or start a new run.`) };
    }
    hold.turns = turns;
  }
  const asked = opts.toolCalls ?? 0;
  if (asked > 0) {
    let calls = asked;
    let total = await deps.reserveCounter(hold.callsKey, window, calls, limits.toolCalls);
    if (total === null) {
      calls = limits.toolCalls - (await deps.counterValue(hold.callsKey, window));
      total = calls >= 1 ? await deps.reserveCounter(hold.callsKey, window, calls, limits.toolCalls) : null;
    }
    if (total === null) {
      await releaseRun(deps, hold);
      return {
        ok: false,
        reason: "tool_calls",
        response: runLimit(
          `This run has none of its ${limits.toolCalls} built-in tool calls left, counting calls still running. Wait for them to finish, send the next turn without built-in tools, or start a new run.`,
        ),
      };
    }
    hold.toolCalls = calls;
  }
  const usd = opts.usd;
  const amountFor = (calls: number) => micros(typeof usd === "function" ? usd(calls) : (usd ?? 0));
  const fewest = typeof usd === "function" ? Math.min(1, hold.toolCalls) : hold.toolCalls;
  let calls = hold.toolCalls;
  let amount = amountFor(calls);
  while (amount > 0 && (await deps.reserveCounter(hold.usdKey, window, amount, micros(limits.usd))) === null) {
    if (calls <= fewest) {
      await releaseRun(deps, hold);
      return {
        ok: false,
        reason: "usd",
        response: runLimit(
          `This call could take this run past its $${limits.usd.toFixed(2)} limit. Ask for fewer output tokens, send it without built-in tools, finish with what it has, or start a new run.`,
        ),
      };
    }
    calls -= 1;
    amount = amountFor(calls);
  }
  if (calls < hold.toolCalls) {
    await deps.adjustCounter(hold.callsKey, window, calls - hold.toolCalls);
    hold.toolCalls = calls;
  }
  hold.micros = amount;
  return { ok: true, hold, toolCalls: hold.toolCalls };
}

/**
 * Replaces a hold with what the call used. A null `toolCalls` means the reply didn't show them (it was cut off), so
 * the call keeps what it held. Its turn stays spent.
 */
export async function settleRun(deps: RunCounters, hold: RunHold, used: { toolCalls: number | null; usd: number }): Promise<void> {
  const callsDelta = used.toolCalls === null ? 0 : used.toolCalls - hold.toolCalls;
  const usdDelta = micros(used.usd) - hold.micros;
  await Promise.all([
    callsDelta ? deps.adjustCounter(hold.callsKey, hold.window, callsDelta) : null,
    usdDelta ? deps.adjustCounter(hold.usdKey, hold.window, usdDelta) : null,
  ]);
}

/** Gives a whole hold back, for a call Meta never ran or never billed. */
export async function releaseRun(deps: RunCounters, hold: RunHold): Promise<void> {
  await Promise.all([
    hold.turns ? deps.adjustCounter(hold.turnsKey, hold.window, -hold.turns) : null,
    hold.toolCalls ? deps.adjustCounter(hold.callsKey, hold.window, -hold.toolCalls) : null,
    hold.micros ? deps.adjustCounter(hold.usdKey, hold.window, -hold.micros) : null,
  ]);
}
