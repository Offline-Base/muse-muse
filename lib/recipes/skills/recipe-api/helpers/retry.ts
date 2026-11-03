/**
 * Retries for gateway calls, with a ledger the page can show. Pure, with no imports.
 *
 * Call the model with `{ maxRetries: 0 }` as the request options inside `withRetries`, so the SDK's own retry doesn't
 * multiply these tries: `withRetries((n) => meta.responses.create(body, { maxRetries: 0 }), { onAttempt })`.
 */
export interface RetryDecision {
  retry: boolean;
  /** Why, in a few plain words for the ledger. */
  reason: string;
  /** Seconds the server asked to wait, when it said. */
  retryAfterS?: number;
}

export interface Attempt {
  n: number;
  status: number;
  code: string | null;
  decision: RetryDecision | null;
  waitedMs: number;
  /** True when a test or a labeled practice switch made this failure. Never counted as a real call or as spend. */
  simulated: boolean;
}

const statusOf = (err: unknown): number => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : 0;
};

const codeOf = (err: unknown): string | null => {
  const e = err as { code?: unknown; error?: { code?: unknown } } | null;
  const c = e?.code ?? e?.error?.code;
  return typeof c === "string" && c ? c : null;
};

function retryAfterOf(err: unknown): number | undefined {
  const h = (err as { headers?: unknown } | null)?.headers;
  const raw = h && typeof (h as { get?: unknown }).get === "function" ? (h as { get(name: string): string | null }).get("retry-after") : null;
  const s = Number(raw);
  return Number.isFinite(s) && s > 0 ? s : undefined;
}

const NEVER_CODES = new Set(["budget_exceeded", "insufficient_quota", "platform_paused", "run_limit"]);

/** The cookbook's table, with the gateway's codes: read the code before the status, since a budget stop is also a 429. */
export function retryDecision(err: unknown): RetryDecision {
  const status = statusOf(err);
  const code = codeOf(err);
  const name = err instanceof Error ? err.name : "";
  if (code && NEVER_CODES.has(code)) {
    return { retry: false, reason: code === "run_limit" ? "this run's call limit is used up" : "today's budget is used up; it resets at 00:00 UTC" };
  }
  if (status === 413) return { retry: false, reason: "the request is too large; send a smaller file" };
  if (status === 429) return { retry: true, reason: "rate limited", retryAfterS: retryAfterOf(err) };
  if (status >= 500 || status === 408) return { retry: true, reason: `server error ${status}` };
  if (status >= 400) return { retry: false, reason: `the request is wrong (HTTP ${status}); retrying sends the same mistake` };
  if (name === "APIConnectionTimeoutError" || name === "TimeoutError" || name === "APIConnectionError" || code === "timeout") {
    return { retry: true, reason: "timed out or couldn't connect" };
  }
  return { retry: false, reason: "unknown error" };
}

/** Exponential backoff with full jitter, or the server's Retry-After when it gave one. */
export function backoffMs(attempt: number, decision: RetryDecision, random: () => number = Math.random, baseMs = 500, capMs = 8_000): number {
  if (decision.retryAfterS) return Math.min(capMs * 4, Math.ceil(decision.retryAfterS * 1000));
  return Math.round(random() * Math.min(capMs, baseMs * 2 ** (attempt - 1)));
}

export interface RetryOptions {
  /** At most this many tries in all. Default 3. Every try can spend money. */
  tries?: number;
  onAttempt?: (a: Attempt) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Marks failures a labeled practice switch made, so the ledger can say "Simulated". */
  simulated?: (err: unknown) => boolean;
}

/** Runs `call` until it succeeds, a failure isn't worth retrying, or the tries run out. Rethrows the last error. */
export async function withRetries<T>(call: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<{ value: T; attempts: Attempt[] }> {
  const tries = Math.max(1, Math.min(opts.tries ?? 3, 5));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts: Attempt[] = [];
  for (let n = 1; ; n++) {
    try {
      const value = await call(n);
      const ok: Attempt = { n, status: 200, code: null, decision: null, waitedMs: 0, simulated: false };
      attempts.push(ok);
      opts.onAttempt?.(ok);
      return { value, attempts };
    } catch (err) {
      const decision = retryDecision(err);
      const last = n >= tries || !decision.retry;
      const waitedMs = last ? 0 : backoffMs(n, decision, opts.random);
      const a: Attempt = { n, status: statusOf(err), code: codeOf(err), decision, waitedMs, simulated: opts.simulated?.(err) ?? false };
      attempts.push(a);
      opts.onAttempt?.(a);
      if (last) throw Object.assign(err instanceof Error ? err : new Error(String(err)), { attempts });
      await sleep(waitedMs);
    }
  }
}
