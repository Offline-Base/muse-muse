/**
 * The error-handling-retry recipe's client logic, in TypeScript: which failures to retry (429, 5xx, timeouts and
 * dropped connections) and which to surface at once (400, 401, 404 and the other 4xx), exponential backoff with
 * jitter (delay * 2^attempt + uniform(0, 0.5) s), the capped retry loop, and the circuit breaker. Pure, with the
 * clock, the randomness and the sleep passed in, so the demo can run it live and the tests can run it instantly.
 */

/** What a call ended with: an HTTP status, or a transport failure. */
export type Failure = { kind: "status"; status: number; message?: string } | { kind: "timeout" } | { kind: "connection" };

export interface Classified {
  retry: boolean;
  /** The OpenAI SDK's exception for it, as the recipe's table names them. */
  exception: string;
  why: string;
}

/** The recipe's "Which errors to retry" table. */
export function classify(f: Failure): Classified {
  if (f.kind === "timeout") return { retry: true, exception: "APITimeoutError", why: "Timeouts are transient: retry with backoff." };
  if (f.kind === "connection") return { retry: true, exception: "APIConnectionError", why: "A dropped connection is transient: retry with backoff." };
  const s = f.status;
  if (s === 429) return { retry: true, exception: "RateLimitError", why: "Over the rate limit for now: back off and retry." };
  if (s >= 500) return { retry: true, exception: "APIStatusError", why: "A server error is usually transient: retry with backoff." };
  if (s === 400) return { retry: false, exception: "BadRequestError", why: "The request is malformed: fix it, retrying can't help." };
  if (s === 401) return { retry: false, exception: "AuthenticationError", why: "The key is wrong: fix the key." };
  if (s === 404) return { retry: false, exception: "NotFoundError", why: "The model or path is wrong: fix it." };
  return { retry: false, exception: "APIStatusError", why: `HTTP ${s} is a client error: surface it.` };
}

export interface Backoff {
  /** Seconds before the first retry, doubled each attempt. The recipe uses 0.5. */
  delay: number;
  /** Jitter: uniform(0, jitter) seconds on top. The recipe uses 0.5. */
  jitter: number;
}

export const RECIPE_BACKOFF: Backoff = { delay: 0.5, jitter: 0.5 };

/** The wait after a failed attempt (0-based), in seconds: delay * 2^attempt + uniform(0, jitter). */
export function backoffSeconds(attempt: number, b: Backoff = RECIPE_BACKOFF, random: () => number = Math.random): number {
  return b.delay * 2 ** attempt + random() * b.jitter;
}

/** The waits a run of max_retries attempts can make: one after every attempt but the last. */
export function backoffSchedule(maxRetries: number, b: Backoff = RECIPE_BACKOFF): Array<{ attempt: number; min: number; max: number }> {
  return Array.from({ length: Math.max(0, maxRetries - 1) }, (_, attempt) => ({
    attempt: attempt + 1,
    min: b.delay * 2 ** attempt,
    max: b.delay * 2 ** attempt + b.jitter,
  }));
}

export type AttemptOutcome<T> = { ok: true; value: T } | { ok: false; failure: Failure };

export interface RetryEvent {
  attempt: number;
  outcome: "ok" | "retry" | "raise";
  failure?: Failure;
  classified?: Classified;
  /** Seconds waited before the next attempt, for "retry". */
  wait?: number;
}

export interface RetryResult<T> {
  ok: boolean;
  value?: T;
  failure?: Failure;
  attempts: number;
  events: RetryEvent[];
}

/**
 * The recipe's complete_with_retry: up to maxRetries attempts; a retryable failure waits and tries again unless it was
 * the last attempt, and anything else is raised at once. `naive` is the recipe's "retry every exception" loop.
 */
export async function withRetry<T>(
  send: (attempt: number) => Promise<AttemptOutcome<T>>,
  opts: {
    maxRetries: number;
    backoff?: Backoff;
    random?: () => number;
    sleep?: (seconds: number) => Promise<void>;
    naive?: boolean;
    /** Stops the loop between attempts (the demo's Stop). */
    cancelled?: () => boolean;
    onEvent?: (e: RetryEvent) => void;
  },
): Promise<RetryResult<T>> {
  if (opts.maxRetries < 1) throw new RangeError("maxRetries must be at least 1");
  const events: RetryEvent[] = [];
  const emit = (e: RetryEvent) => {
    events.push(e);
    opts.onEvent?.(e);
  };
  const sleep = opts.sleep ?? ((s: number) => new Promise<void>((r) => setTimeout(r, s * 1000)));
  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    const out = await send(attempt);
    if (out.ok) {
      emit({ attempt: attempt + 1, outcome: "ok" });
      return { ok: true, value: out.value, attempts: attempt + 1, events };
    }
    const classified = classify(out.failure);
    const last = attempt === opts.maxRetries - 1;
    if ((classified.retry || opts.naive) && !last && !opts.cancelled?.()) {
      const wait = opts.naive ? 0.3 : backoffSeconds(attempt, opts.backoff, opts.random);
      emit({ attempt: attempt + 1, outcome: "retry", failure: out.failure, classified, wait });
      await sleep(wait);
      if (opts.cancelled?.()) return { ok: false, failure: out.failure, attempts: attempt + 1, events };
      continue;
    }
    emit({ attempt: attempt + 1, outcome: "raise", failure: out.failure, classified });
    return { ok: false, failure: out.failure, attempts: attempt + 1, events };
  }
  // Unreachable: the last attempt always returns above.
  return { ok: false, attempts: opts.maxRetries, events };
}

export type BreakerState = "closed" | "open" | "half-open";

/**
 * The recipe's CircuitBreaker: open after `threshold` consecutive failures; after `cooldown` seconds one trial call is
 * allowed (half-open). The failure count stays at the threshold, so a failed trial opens it again at once, and a
 * success resets it. Times are in seconds from `now()`.
 */
export class CircuitBreaker {
  failures = 0;
  openedAt: number | null = null;

  constructor(
    readonly threshold = 3,
    readonly cooldown = 30,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {}

  allow(): boolean {
    if (this.openedAt === null) return true;
    if (this.now() - this.openedAt >= this.cooldown) {
      this.openedAt = null;
      return true;
    }
    return false;
  }

  record(ok: boolean): void {
    if (ok) this.failures = 0;
    else {
      this.failures++;
      if (this.failures >= this.threshold) this.openedAt = this.now();
    }
  }

  state(): BreakerState {
    if (this.openedAt === null) return this.failures >= this.threshold ? "half-open" : "closed";
    return this.now() - this.openedAt >= this.cooldown ? "half-open" : "open";
  }
}

/** One line of the recipe's breaker demo: "call 2: ok=False -> failures=2, circuit open" or "call 3: circuit open -> skipped". */
export function breakerCall(breaker: CircuitBreaker, label: string, ok: boolean): string {
  if (!breaker.allow()) return `${label}: circuit open -> skipped`;
  breaker.record(ok);
  return `${label}: ok=${ok ? "True" : "False"} -> failures=${breaker.failures}, circuit ${breaker.openedAt !== null ? "open" : "closed"}`;
}
