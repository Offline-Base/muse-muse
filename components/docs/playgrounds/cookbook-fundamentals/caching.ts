import { tokenUsage } from "@/lib/docs/client/cost";

/**
 * The prompt-caching recipe's requests: a long, stable developer prompt (its Acme support knowledge base) sent with
 * a question, in the three layouts the recipe compares. Caching is automatic and matches from the first token
 * forward, so a per-request value before the stable prefix (volatile first) breaks every hit, and the same value at
 * the end (volatile last) keeps them. prompt_cache_key is optional: it routes same-prefix requests to the same server.
 */

export const ACME_SENTENCE =
  "You are a support agent for the Acme Cloud platform. Be concise, cite the relevant runbook section, never invent product names, and escalate billing disputes to tier 2. ";

/** The recipe's DEVELOPER_PROMPT: a header, then the sentence 120 times (about 4,500 tokens). */
export function acmePrefix(repeats = 120): string {
  return `ACME SUPPORT KNOWLEDGE BASE\n${ACME_SENTENCE.repeat(repeats)}`;
}

export type CacheLayout = "stable" | "volatile-first" | "volatile-last";

export const LAYOUT_LABEL: Record<CacheLayout, string> = {
  stable: "Stable prefix",
  "volatile-first": "Volatile first",
  "volatile-last": "Volatile last",
};

/** The recipe's questions, then a few more for further calls. */
export const CACHE_QUESTIONS = [
  "How do I reset a password?",
  "How do I add a teammate?",
  "How do I delete a project?",
  "Can I export invoices as CSV?",
  "How do I rotate an API key?",
  "Why was my card declined?",
];

export interface CacheCall {
  model: string;
  layout: CacheLayout;
  question: string;
  prefix: string;
  /** A per-request id (the recipe uses a uuid4) for the volatile layouts. */
  requestId: string;
  /** Left out when empty: caching works without one. */
  cacheKey?: string;
  retention?: "in_memory" | "24h" | null;
  effort?: string | null;
}

/** The Chat Completions body for one call, laid out as the recipe's three variants are. */
export function cacheBody(c: CacheCall): Record<string, unknown> {
  const developer = c.layout === "volatile-first" ? `Request ID: ${c.requestId}\n${c.prefix}` : c.prefix;
  const user = c.layout === "volatile-last" ? `${c.question} (request ${c.requestId})` : c.question;
  const body: Record<string, unknown> = {
    model: c.model,
    messages: [
      { role: "developer", content: developer },
      { role: "user", content: user },
    ],
  };
  if (c.cacheKey) body.prompt_cache_key = c.cacheKey;
  if (c.retention) body.prompt_cache_retention = c.retention;
  if (c.effort) body.reasoning_effort = c.effort;
  return body;
}

/** A random id like the recipe's uuid4().hex[:8], for cache keys and request ids. */
export function shortId(random: () => number = Math.random, length = 8): string {
  let out = "";
  for (let i = 0; i < length; i++) out += Math.floor(random() * 16).toString(16);
  return out;
}

/** A uuid4-shaped id for the volatile layouts. */
export function requestUuid(random: () => number = Math.random): string {
  const h = () => shortId(random, 4);
  return `${h()}${h()}-${h()}-4${shortId(random, 3)}-${"89ab"[Math.floor(random() * 4)]}${shortId(random, 3)}-${h()}${h()}${h()}`;
}

export interface CacheStat {
  prompt: number;
  cached: number;
  /** cached / prompt, the number the recipe says to watch. */
  ratio: number;
}

/** Prompt and cached tokens from a reply's usage (Chat's prompt_tokens_details.cached_tokens). */
export function cacheStat(usage: unknown): CacheStat | null {
  const t = tokenUsage(usage);
  if (!t) return null;
  return { prompt: t.input, cached: t.cached, ratio: t.input ? t.cached / t.input : 0 };
}
