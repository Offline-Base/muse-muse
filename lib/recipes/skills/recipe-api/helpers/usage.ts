/** Token counts from a Responses reply's `usage`, added up across calls. Pure, with no imports. */
export interface Tokens {
  input: number;
  output: number;
  /** Input tokens read from the cache. A subset of input, never extra. */
  cached: number;
  /** Reasoning tokens. A subset of output, billed as output. */
  reasoning: number;
}

export const NO_TOKENS: Tokens = { input: 0, output: 0, cached: 0, reasoning: 0 };

type RawUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  input_tokens_details?: { cached_tokens?: number | null } | null;
  output_tokens_details?: { reasoning_tokens?: number | null } | null;
} | null | undefined;

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** A missing usage reads as zeros, never as a guess. */
export function readTokens(usage: RawUsage): Tokens {
  return {
    input: n(usage?.input_tokens),
    output: n(usage?.output_tokens),
    cached: n(usage?.input_tokens_details?.cached_tokens),
    reasoning: n(usage?.output_tokens_details?.reasoning_tokens),
  };
}

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached, reasoning: a.reasoning + b.reasoning };
}

/** Dollars per million tokens. Pass the product's own prices: cached input bills at its own, lower rate. */
export interface Prices {
  input: number;
  cachedInput: number;
  output: number;
}

/** Cost from real counts only. Reasoning is already inside output, so it isn't added again. */
export function costUsd(t: Tokens, p: Prices): number {
  const uncached = Math.max(0, t.input - t.cached);
  return (uncached * p.input + t.cached * p.cachedInput + t.output * p.output) / 1_000_000;
}

/**
 * One plain line about the cache for one call. The first call with a new prefix reads 0 by design, so it says so,
 * and a repeat that still reads 0 says that too, instead of showing a saving that didn't happen.
 */
export function cacheLine(t: Tokens, opts: { firstCallWithThisPrefix: boolean }): string {
  if (t.cached > 0) return `${t.cached.toLocaleString("en-US")} of ${t.input.toLocaleString("en-US")} input tokens came from the cache (${Math.round((100 * t.cached) / Math.max(1, t.input))}%).`;
  if (opts.firstCallWithThisPrefix) return "0 from the cache: the first call with a new document always reads 0. Ask again to reuse it.";
  return "No cache hit on this call. The server keeps a prefix only for a while and may drop it under load.";
}
