/**
 * The retry rules from the error-handling page ("Retry strategy", "503 Service Unavailable", "504 Gateway Timeout")
 * and the pricing page ("Retry on 429 responses"), as a pure planner the simulator draws:
 *
 * - Retry 429, 500 and 503 (and a mid-stream server_shutting_down: replay the whole request).
 * - Never retry 400, 401, 402, 403, 404 or 413 unchanged: they need a fixed request.
 * - Don't simply retry a 504: stream it or run it in the background instead.
 * - Exponential backoff with jitter: start short (500 ms), double after each retry, add random jitter (0 to 1 s), and
 *   stop after a few attempts (3 to 5). A Retry-After header is a floor: wait at least that long.
 *
 * The jitter comes from a seeded generator, so a timeline is the same on every render and in tests.
 */

export interface SimOutcome {
  status: number;
  code?: string | null;
  /** The Retry-After header, in seconds. Never on a mid-stream error: its headers went out with the 200. */
  retryAfterSec?: number;
  /** A terminal error event on a stream that had started with HTTP 200. */
  midStream?: boolean;
}

export interface RetryPolicy {
  /** First backoff delay. The page suggests 500 ms to 1 s. */
  baseMs: number;
  /** Growth per retry. The page doubles. */
  factor: number;
  /** Most random jitter added to each delay. The page suggests up to 1 s. */
  jitterMs: number;
  /** Attempts in all, the first one included. The page suggests 3 to 5. */
  maxAttempts: number;
  /** Wait at least Retry-After when the reply has one. */
  honorRetryAfter: boolean;
}

export const PAGE_POLICY: RetryPolicy = { baseMs: 500, factor: 2, jitterMs: 1000, maxAttempts: 4, honorRetryAfter: true };

export type Verdict = "success" | "retry" | "fix" | "rethink";

/** What to do about one outcome, by the page's rules, and why. */
export function verdictFor(outcome: SimOutcome): { verdict: Verdict; reason: string } {
  const { status, code } = outcome;
  if (outcome.midStream) {
    return { verdict: "retry", reason: `A terminal error event (${code ?? "server_error"}) arrived mid-stream: retry the full request.` };
  }
  if (status >= 200 && status < 300) return { verdict: "success", reason: "Success." };
  if (status === 429) {
    return {
      verdict: "retry",
      reason: outcome.retryAfterSec
        ? "Rate limited: wait at least Retry-After, then retry."
        : "Rate limited, with no Retry-After: back off exponentially with jitter, then retry.",
    };
  }
  if (status === 503) {
    return {
      verdict: "retry",
      reason: `${code ?? "Service unavailable"}: always retryable. Honor Retry-After, else your own backoff.`,
    };
  }
  if (status === 500) return { verdict: "retry", reason: "A transient server error: retry with exponential backoff." };
  if (status === 504) {
    return {
      verdict: "rethink",
      reason: "Gateway timeout: the same request usually times out again. Stream it, run it with background: true, or make it smaller.",
    };
  }
  if ([400, 401, 402, 403, 404, 413].includes(status)) {
    return { verdict: "fix", reason: `HTTP ${status} needs a fixed request: don't retry it unchanged.` };
  }
  return status >= 500
    ? { verdict: "retry", reason: "A server error: retry with backoff." }
    : { verdict: "fix", reason: `HTTP ${status}: read the error message before trying again.` };
}

export interface TimelineStep {
  attempt: number;
  /** When this attempt was sent, from the first one. */
  atMs: number;
  outcome: SimOutcome;
  verdict: Verdict;
  reason: string;
  /** The wait before the next attempt, when there is one. */
  wait?: { backoffMs: number; jitterMs: number; retryAfterMs: number; totalMs: number; byRetryAfter: boolean };
  /** Set on the last step when the attempts ran out. */
  gaveUp?: boolean;
}

export interface Timeline {
  steps: TimelineStep[];
  /** From the first attempt to the last one. */
  totalMs: number;
  result: "success" | "gave_up" | "fix" | "rethink";
}

/** The delay before retry number `retry` (1 for the first retry): base x factor^(retry - 1), before jitter. */
export function backoffMs(policy: RetryPolicy, retry: number): number {
  return policy.baseMs * Math.pow(policy.factor, Math.max(0, retry - 1));
}

/**
 * Plays the outcomes against the policy. Attempts past the end of the list repeat its last outcome, so "a server
 * that keeps failing" is one item. `random` returns numbers in [0, 1).
 */
export function planRetries(outcomes: readonly SimOutcome[], policy: RetryPolicy, random: () => number): Timeline {
  const steps: TimelineStep[] = [];
  const attempts = Math.max(1, Math.floor(policy.maxAttempts));
  let at = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const outcome = outcomes[Math.min(attempt - 1, outcomes.length - 1)] ?? { status: 200 };
    const { verdict, reason } = verdictFor(outcome);
    const step: TimelineStep = { attempt, atMs: at, outcome, verdict, reason };
    steps.push(step);
    if (verdict === "success") return { steps, totalMs: at, result: "success" };
    if (verdict === "fix" || verdict === "rethink") return { steps, totalMs: at, result: verdict };
    if (attempt === attempts) {
      step.gaveUp = true;
      return { steps, totalMs: at, result: "gave_up" };
    }
    const backoff = backoffMs(policy, attempt);
    const jitter = Math.round(random() * policy.jitterMs);
    // A stream that failed mid-way already sent its headers with the 200, so only the backoff decides its wait.
    const retryAfterMs = policy.honorRetryAfter && outcome.retryAfterSec && !outcome.midStream ? outcome.retryAfterSec * 1000 : 0;
    const totalMs = Math.max(backoff + jitter, retryAfterMs);
    step.wait = { backoffMs: backoff, jitterMs: jitter, retryAfterMs, totalMs, byRetryAfter: retryAfterMs > backoff + jitter };
    at += totalMs;
  }
  return { steps, totalMs: at, result: "gave_up" };
}

/** A small seeded generator (mulberry32): the same seed gives the same jitter. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RetryScenario {
  id: string;
  label: string;
  /** One line on what the server does. */
  story: string;
  outcomes: SimOutcome[];
}

/** What a server can do, in the error-handling page's words. */
export const RETRY_SCENARIOS: readonly RetryScenario[] = [
  {
    id: "rate-limit",
    label: "429, then success",
    story: "Your team is over its requests per minute. The 429 carries Retry-After: 15, as in the page's example.",
    outcomes: [{ status: 429, code: "rate_limit_exceeded", retryAfterSec: 15 }, { status: 200 }],
  },
  {
    id: "rate-limit-backoff",
    label: "Two 429s, no Retry-After",
    story: "Two rate-limit responses in a row without a Retry-After header: the backoff alone decides, doubling from 500 ms with jitter.",
    outcomes: [{ status: 429, code: "rate_limit_exceeded" }, { status: 429, code: "rate_limit_exceeded" }, { status: 200 }],
  },
  {
    id: "rolling-deploy",
    label: "Rolling deploy",
    story: "The instance you reached is draining: 503 server_shutting_down with a short Retry-After of a few seconds.",
    outcomes: [{ status: 503, code: "server_shutting_down", retryAfterSec: 2 }, { status: 200 }],
  },
  {
    id: "overloaded",
    label: "Overloaded backend",
    story: "The backend is at its active request limit: 503 service_overloaded with Retry-After: 60, twice.",
    outcomes: [
      { status: 503, code: "service_overloaded", retryAfterSec: 60 },
      { status: 503, code: "service_overloaded", retryAfterSec: 60 },
      { status: 200 },
    ],
  },
  {
    id: "flaky",
    label: "Two 500s",
    story: "Model output parsing failed twice (not caused by your input), then the third try works. No Retry-After.",
    outcomes: [{ status: 500, code: null }, { status: 500, code: null }, { status: 200 }],
  },
  {
    id: "persistent",
    label: "500s that persist",
    story: "Every attempt fails. After the last one, check the API status page or contact support.",
    outcomes: [{ status: 500, code: null }],
  },
  {
    id: "mid-stream",
    label: "Shutdown mid-stream",
    story:
      "A stream starts with HTTP 200, then a terminal error event with code server_shutting_down arrives. Its headers went out with the 200, so there's no Retry-After: the backoff alone decides when to send the whole request again.",
    outcomes: [{ status: 200, code: "server_shutting_down", midStream: true }, { status: 200 }],
  },
  {
    id: "bad-request",
    label: "400 Bad Request",
    story: "A parameter is invalid (top_p over 1). Retrying the same body fails the same way.",
    outcomes: [{ status: 400, code: null }],
  },
  {
    id: "timeout",
    label: "504 Gateway Timeout",
    story: "A non-streaming request ran past the server's time limit: gateway_timeout.",
    outcomes: [{ status: 504, code: "gateway_timeout" }],
  },
];

/** What to do once the attempts run out, by the last failure: a 429 needs less traffic, a 5xx a look at the service. */
export function gaveUpAdvice(last: SimOutcome): string {
  if (last.status === 429 && !last.midStream) {
    return "Still rate limited: slow down instead of retrying harder. Watch x-ratelimit-remaining-requests and x-ratelimit-remaining-tokens, and spread the load under your team's limits.";
  }
  if (last.midStream || last.status === 503) return "The service is still unavailable: check the API status page (GET /v1/status) before sending more.";
  return "If 500s persist, check the API status page or contact support.";
}

/** The verdict under a timeline, by the page's rules. */
export function timelineVerdict(t: Timeline): string {
  const last = t.steps[t.steps.length - 1];
  if (t.result === "success") return `Succeeded on attempt ${last.attempt}, ${secondsLabel(t.totalMs)} after the first try.`;
  if (t.result === "fix") return "Not retried: this status needs a fixed request. Read message and param.";
  if (t.result === "rethink") return "Not retried as is: stream the request, run it with background: true, or make it smaller.";
  return `Gave up after ${last.attempt} ${last.attempt === 1 ? "attempt" : "attempts"}. ${gaveUpAdvice(last.outcome)}`;
}

/** "0 s", "40 ms", "1.5 s", "15 s", "1 min 2 s": short waits in milliseconds, so jitter never reads as zero. */
export function secondsLabel(ms: number): string {
  if (ms <= 0) return "0 s";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
}

/**
 * The policy as code to copy, honoring Retry-After as a floor. The OpenAI SDK retries twice on its own by default,
 * so the Python version turns that off (max_retries=0) to keep this loop the only one; TypeScript uses fetch, where
 * the status and headers are plain to read.
 */
export function retryCode(policy: RetryPolicy, language: "python" | "typescript", model: string): string {
  const base = policy.baseMs / 1000;
  const jitter = policy.jitterMs / 1000;
  if (language === "python") {
    return `import os
import random
import time

from openai import APIStatusError, OpenAI

# The SDK retries twice by itself; max_retries=0 leaves retrying to this loop.
client = OpenAI(
    api_key=os.environ["MODEL_API_KEY"],
    base_url="https://api.meta.ai/v1",
    max_retries=0,
)

RETRYABLE = {429, 500, 503}  # never retry 400, 401, 402, 403, 404 or 413 unchanged


def create_with_retry(max_attempts=${policy.maxAttempts}, base=${base}, factor=${policy.factor}, jitter=${jitter}, **request):
    for attempt in range(1, max_attempts + 1):
        try:
            return client.responses.create(**request)
        except APIStatusError as e:
            if e.status_code not in RETRYABLE or attempt == max_attempts:
                raise
            delay = base * factor ** (attempt - 1) + random.uniform(0, jitter)
${policy.honorRetryAfter ? `            retry_after = e.response.headers.get("retry-after")
            if retry_after and retry_after.isdigit():
                delay = max(delay, float(retry_after))  # wait at least Retry-After
` : ""}            time.sleep(delay)


response = create_with_retry(model="${model}", input="Hello!")
print(response.output_text)`;
  }
  return `const RETRYABLE = new Set([429, 500, 503]); // never retry 400, 401, 402, 403, 404 or 413 unchanged

async function createWithRetry(body: unknown, maxAttempts = ${policy.maxAttempts}, baseMs = ${policy.baseMs}, factor = ${policy.factor}, jitterMs = ${policy.jitterMs}) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch("https://api.meta.ai/v1/responses", {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${process.env.MODEL_API_KEY}\`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (response.ok) return response.json();
    if (!RETRYABLE.has(response.status) || attempt >= maxAttempts) {
      throw new Error(\`HTTP \${response.status}: \${await response.text()}\`);
    }
    let delay = baseMs * factor ** (attempt - 1) + Math.random() * jitterMs;
${policy.honorRetryAfter ? `    const retryAfter = Number(response.headers.get("retry-after"));
    if (retryAfter > 0) delay = Math.max(delay, retryAfter * 1000); // wait at least Retry-After
` : ""}    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

const reply = await createWithRetry({ model: "${model}", input: "Hello!" });
console.log(JSON.stringify(reply, null, 2));`;
}
