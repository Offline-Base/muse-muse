import type { DocsError, DocsResult } from "@/lib/docs/client/api";
import { errorKind } from "@/lib/docs/client/errors";
import { docsPacer, sleepUnlessStopped, type Pacer } from "@/components/docs/playgrounds/cookbook-use-cases/lib/pace";

/**
 * Retries for the multi-step demos. A long agent run shouldn't die on one transient upstream error or on the live
 * demos' rate limit. Meta answered 503 "persistence service error" now and then while these demos were built (Oct 30,
 * 2026): those get two more tries with a backoff. A 429 from the proxy's per-minute limits (20 runs a minute per
 * network, every reader's runs on one model, calls in flight) says in retry-after when the window opens, at most a
 * minute away since the window is a calendar minute: the call waits that long and goes again, up to three times.
 * Everything else comes back at once, as the error-handling recipe advises: a 400, a stop, a budget or a pause, and a
 * 429 that asks for longer than a minute (the day's 400 runs, an hour's uploads). Every call is also paced
 * (lib/pace.ts), so a run on its own stays under the limit.
 */

export const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);
export const RETRY_WAITS_MS = [1500, 4000];
/** The longest rate-limit wait a call sits out. */
export const MAX_RATE_WAIT_SEC = 60;
/** Rate-limit waits one call sits out before it gives up. */
export const RATE_RETRIES = 3;
/** The wait for a 429 that gives no retry-after (Meta's own, say). */
const DEFAULT_RATE_WAIT_SEC = 5;

/** What a call stopped during a wait reports, the same code as the kit's stopped run (isAborted is true for it). */
export const STOPPED_ERROR: DocsError = { type: "aborted", code: "aborted", message: "Stopped before the reply finished." };

export type RetryKind = "transient" | "rate_limit";

export interface RetryPlan {
  kind: RetryKind;
  waitMs: number;
}

type Outcome = Pick<DocsResult, "ok" | "status" | "error">;

/** What to do about a failed call: wait and retry, or null to give up. `done` counts the retries of each kind so far. */
export function retryPlan(result: Outcome, done: Record<RetryKind, number> = { transient: 0, rate_limit: 0 }, waits = RETRY_WAITS_MS): RetryPlan | null {
  if (result.ok || !result.error) return null;
  const kind = errorKind(result.error);
  if (kind === "aborted" || kind === "budget" || kind === "paused") return null;
  if (TRANSIENT_STATUS.has(result.status)) return done.transient < waits.length ? { kind: "transient", waitMs: waits[done.transient] } : null;
  if (result.status !== 429 || done.rate_limit >= RATE_RETRIES) return null;
  const after = result.error.retryAfterSec ?? DEFAULT_RATE_WAIT_SEC;
  if (after > MAX_RATE_WAIT_SEC) return null;
  // A little past the time it names, so the retry lands in the next window rather than at its edge.
  return { kind: "rate_limit", waitMs: Math.round(Math.max(1, after) * 1000 + 400) };
}

export interface RetryNote extends RetryPlan {
  /** 1 for the first retry of this kind. */
  attempt: number;
  /** The most retries of this kind. */
  of: number;
  status: number;
  message: string;
}

export interface RetryOptions {
  /** Hears about each wait before it starts, for a timeline note or a status line. */
  onRetry?(note: RetryNote): void;
  /** Called when a wait is over, just before the call goes again (to clear a status line). */
  onResume?(): void;
  /** True once the reader pressed Stop: a wait ends early and no new call goes out. */
  stopped?(): boolean;
  /** The pacer spacing calls to the per-minute limit; false for none. Defaults to the tab's. */
  pace?: Pacer | false;
  waits?: number[];
  sleep?(ms: number, stopped?: () => boolean): Promise<void>;
}

/** The note a demo shows for a wait. */
export function retryText(n: RetryNote): string {
  if (n.kind === "rate_limit") {
    const said = n.message.trim().replace(/([^.!?])$/, "$1.");
    return `${said} Waiting ${Math.ceil(n.waitMs / 1000)} s for the limit, then the same call goes again (wait ${n.attempt} of ${n.of}).`;
  }
  return `Meta answered ${n.status} (${n.message}); retrying in ${(n.waitMs / 1000).toFixed(1)} s, try ${n.attempt + 1} of ${n.of + 1}.`;
}

function stoppedLike<R extends Outcome>(r: R | null): R {
  const base = { ok: false, status: 0, json: null, text: "", blob: null, headers: {}, model: null, note: null, elapsedMs: 0 };
  return { ...base, ...(r ?? {}), ok: false, error: STOPPED_ERROR } as unknown as R;
}

/** Runs `call`, paced, retrying transient failures and short rate limits. A stop during a wait returns a stopped result. */
export async function withRetries<R extends Outcome>(call: () => Promise<R>, opts: RetryOptions = {}): Promise<R> {
  const done: Record<RetryKind, number> = { transient: 0, rate_limit: 0 };
  const waits = opts.waits ?? RETRY_WAITS_MS;
  const pacer = opts.pace === false ? null : (opts.pace ?? docsPacer);
  const sleep = opts.sleep ?? sleepUnlessStopped;
  let last: R | null = null;
  for (;;) {
    if (pacer) await pacer.next(opts.stopped);
    if (opts.stopped?.()) return stoppedLike(last);
    const r = await call();
    const plan = retryPlan(r, done, waits);
    if (!plan) return r;
    last = r;
    done[plan.kind]++;
    opts.onRetry?.({ ...plan, attempt: done[plan.kind], of: plan.kind === "transient" ? waits.length : RATE_RETRIES, status: r.status, message: r.error?.message ?? `HTTP ${r.status}` });
    await sleep(plan.waitMs, opts.stopped);
    if (opts.stopped?.()) return stoppedLike(r);
    opts.onResume?.();
  }
}
