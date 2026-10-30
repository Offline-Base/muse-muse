import { estimateCost, tokenUsage } from "@/lib/docs/client/cost";

/**
 * The prompt caching demo as data (prompt-caching page): a long stable prefix (instructions plus a public-domain book)
 * sent twice with a different question at the end, so the second call reports `cached_tokens`; and the page's two
 * ways to lose the cache, volatile content first and an edit partway through.
 *
 * Three things we saw on the live API shape the defaults (Oct 30, 2026):
 * - Without `prompt_cache_key`, a second call can land on another backend and miss; with one, the hit is steady.
 * - A brand-new prefix starts cold, so each pair can begin with a random tag to make call 1 a true miss.
 * - Matching is not always token by token: after an edit the hit fell to zero or to the part before the change, so
 *   the demo promises only what the page does: a changed prefix lowers cached_tokens.
 */

type Json = Record<string, unknown>;

export type CacheProtocol = "responses" | "chat";
export type CacheScenario = "same" | "timestamp" | "edit";
export type BookPart = "chapter-1" | "chapters-1-3";

export const CACHE_INSTRUCTIONS = "You answer questions about the book below. Reply in one short sentence.";
export const DEFAULT_CACHE_KEY = "muse-docs-prompt-caching";
export const EDIT_NOTE = "[Editor's note: this part of the text was revised today.]";

export interface CacheSetup {
  protocol: CacheProtocol;
  model: string;
  /** The whole sample text. */
  book: string;
  part: BookPart;
  scenario: CacheScenario;
  /** A random tag at the very start, fresh for each pair, so the first call can't hit an older cache. */
  tag: string | null;
  questions: [string, string];
  /** prompt_cache_key, or null to leave it out. */
  cacheKey: string | null;
  /** Responses only: prompt_cache_retention. */
  retention: "in_memory" | "24h" | null;
  /** Responses only: store. Caching works either way (the page's "Caching is independent of store"). */
  store: boolean;
  effort: string | null;
  maxOutputTokens: number;
}

/** The part of the book a run sends: chapter I only, or all three chapters. */
export function bookPart(book: string, part: BookPart): string {
  if (part === "chapters-1-3") return book;
  const at = book.indexOf("CHAPTER II.");
  return at > 0 ? book.slice(0, at).trimEnd() : book;
}

/** The book with a note put in at the paragraph break nearest its middle, for the "edit the middle" scenario. */
export function editedMiddle(text: string): string {
  const mid = Math.floor(text.length / 2);
  const before = text.lastIndexOf("\n\n", mid);
  const after = text.indexOf("\n\n", mid);
  const at = before < 0 ? after : after < 0 ? before : mid - before <= after - mid ? before : after;
  if (at < 0) return `${text.slice(0, mid)}\n\n${EDIT_NOTE}\n\n${text.slice(mid)}`;
  return `${text.slice(0, at)}\n\n${EDIT_NOTE}${text.slice(at)}`;
}

/** A short random tag, such as "Session 482913.", that makes a fresh prefix. */
export function freshTag(random: () => number = Math.random): string {
  return `Session ${100000 + Math.floor(random() * 900000)}.`;
}

/**
 * The stable part of call `call` (1 or 2): what goes in `instructions` (Responses) or the developer message (Chat).
 * In "timestamp" it opens with the current time to the millisecond, the volatile-first mistake; in "edit" call 2's
 * book has a note put in partway through.
 */
export function prefixFor(setup: CacheSetup, call: 1 | 2, now: Date): string {
  const text = bookPart(setup.book, setup.part);
  const book = setup.scenario === "edit" && call === 2 ? editedMiddle(text) : text;
  const lead = setup.scenario === "timestamp" ? `Current time: ${now.toISOString()}.` : (setup.tag ?? "");
  return `${lead ? `${lead} ` : ""}${CACHE_INSTRUCTIONS}\n\n${book}`;
}

/** Call `call`'s request body: the stable prefix first, the question last. */
export function cacheBody(setup: CacheSetup, call: 1 | 2, now: Date): Json {
  const prefix = prefixFor(setup, call, now);
  const question = setup.questions[call - 1].trim();
  const key = setup.cacheKey?.trim() ? { prompt_cache_key: setup.cacheKey.trim() } : {};
  if (setup.protocol === "chat") {
    return {
      model: setup.model,
      ...key,
      messages: [
        { role: "developer", content: prefix },
        { role: "user", content: question },
      ],
      ...(setup.effort ? { reasoning_effort: setup.effort } : {}),
      max_completion_tokens: setup.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
  }
  return {
    model: setup.model,
    ...key,
    ...(setup.retention ? { prompt_cache_retention: setup.retention } : {}),
    ...(setup.store ? {} : { store: false }),
    instructions: prefix,
    input: question,
    ...(setup.effort ? { reasoning: { effort: setup.effort } } : {}),
    max_output_tokens: setup.maxOutputTokens,
    stream: true,
  };
}

export interface CacheRun {
  call: 1 | 2;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  /** Milliseconds to the first visible text. */
  ttftMs: number | null;
  totalMs: number;
  /** Estimated cost as billed, with the cached tokens at the cached rate. */
  usd: number;
  /** The same tokens with nothing cached. */
  usdUncached: number;
}

/** One call's numbers, from its usage (either protocol's shape) and its timing. */
export function cacheRunFrom(call: 1 | 2, model: string, usage: unknown, ttftMs: number | null, totalMs: number): CacheRun {
  const t = tokenUsage(usage);
  const input = t?.input ?? 0;
  const cached = t?.cached ?? 0;
  const output = t?.output ?? 0;
  return {
    call,
    input,
    cached,
    output,
    reasoning: t?.reasoning ?? 0,
    ttftMs,
    totalMs,
    usd: inputCost(model, input, cached) + outputCost(model, output),
    usdUncached: inputCost(model, input, 0) + outputCost(model, output),
  };
}

/** The input side of the bill: the uncached part at the input rate, the cached part at the cached rate. */
export function inputCost(model: string, input: number, cached: number): number {
  return estimateCost(model, { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: 0 })?.usd ?? 0;
}

function outputCost(model: string, output: number): number {
  return estimateCost(model, { input_tokens: 0, output_tokens: output })?.usd ?? 0;
}

/** About how many input tokens each prefix is (the lab's prefix menu says the same), for the estimate before a run. */
export const PREFIX_TOKENS: Record<BookPart, number> = { "chapter-1": 3000, "chapters-1-3": 8300 };

/**
 * What a pair of calls can cost on a model before it runs, with each reply at its output cap: `hit` when call 2 reuses
 * the prefix (all but about 120 tokens cached, as measured), `miss` when it doesn't. Upper bounds, since replies here
 * are one sentence.
 */
export function pairCost(model: string, part: BookPart, maxOutputTokens = 400): { hit: number; miss: number } {
  const input = PREFIX_TOKENS[part];
  const first = inputCost(model, input, 0);
  const output = outputCost(model, 2 * maxOutputTokens);
  return { hit: first + inputCost(model, input, Math.max(0, input - 120)) + output, miss: 2 * first + output };
}

/** The share of input tokens served from cache, 0 to 1. */
export function cachedShare(run: Pick<CacheRun, "input" | "cached">): number {
  return run.input > 0 ? Math.min(1, run.cached / run.input) : 0;
}

/**
 * What the page says a run's cached_tokens means (prompt-caching, "Check cache performance"). A few percent is still a
 * miss: Meta's own scaffolding comes before your prefix and is often cached (about 113 tokens in our checks).
 */
export function cacheReading(run: Pick<CacheRun, "input" | "cached">): "hit" | "partial" | "miss" {
  const share = cachedShare(run);
  if (share < 0.05) return "miss";
  return share >= 0.8 ? "hit" : "partial";
}

/** A body with its long prefix cut for the code view, so a 32 KB book doesn't fill the screen. */
export function shortenForCode(body: Json, max = 600): Json {
  const cut = (text: string) => (text.length > max ? `${text.slice(0, max)}... <${(text.length - max).toLocaleString("en-US")} more characters of the book>` : text);
  const out: Json = { ...body };
  if (typeof out.instructions === "string") out.instructions = cut(out.instructions);
  if (Array.isArray(out.messages)) {
    out.messages = (out.messages as Json[]).map((m) => (typeof m.content === "string" ? { ...m, content: cut(m.content) } : m));
  }
  return out;
}
