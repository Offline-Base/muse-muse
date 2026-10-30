import { estimateCost } from "@/lib/docs/client/cost";

/**
 * The long-context recipe's arithmetic: Muse Spark's 1,048,576-token window is shared by the input and the output you
 * ask for, so a request is measured before it is sent (POST /v1/responses/input_tokens), priced, and checked against
 * the window. Also the recipe's stand-in document and summary, and a dense filler that can push a request past the
 * window to show the API's 400 (no server-side truncation).
 */

export const CONTEXT_WINDOW = 1_048_576;

/** The recipe's stand-in for a large file: one sentence repeated 800 times. */
export const STAND_IN_SENTENCE = "The service uses a sharded datastore with async replication. ";

export function standInDocument(times = 800): string {
  return STAND_IN_SENTENCE.repeat(times);
}

/** The recipe's summary of that document, for "Full files or summaries?". */
export const STAND_IN_SUMMARY =
  "Summary: the service uses a sharded datastore with async replication; key decisions are shard-by-tenant, eventual consistency, and read replicas.";

export interface WindowCheck {
  input: number;
  output: number;
  total: number;
  fits: boolean;
  /** Tokens over the window, 0 when it fits. */
  over: number;
  /** Share of the window used, 0 to 1 (can pass 1). */
  share: number;
}

export function windowCheck(inputTokens: number, plannedOutput: number, window = CONTEXT_WINDOW): WindowCheck {
  const total = inputTokens + plannedOutput;
  return { input: inputTokens, output: plannedOutput, total, fits: total <= window, over: Math.max(0, total - window), share: total / window };
}

/** What a call would cost before it's sent: the counted input plus the output you plan for, at the model's prices. */
export function costBeforeSending(model: string, inputTokens: number, plannedOutput: number): number | null {
  const est = estimateCost(model, { prompt_tokens: inputTokens, completion_tokens: plannedOutput });
  return est?.priced ? est.usd : null;
}

/** `text` repeated `times`, with a header per copy so each reads as its own file (repo-scale context, simulated). */
export function repeatDocument(text: string, times: number, name = "document"): string {
  if (times <= 1) return text;
  return Array.from({ length: times }, (_, i) => `=== ${name}, copy ${i + 1} of ${times} ===\n${text}`).join("\n\n");
}

/**
 * Random three-digit numbers separated by spaces: about one token per two characters, so 2.2 MB passes the window
 * while staying under the live docs' 4.5 MB body limit. Seeded, so a run is repeatable.
 */
export function denseFiller(characters: number, seed = 1): string {
  let x = seed >>> 0 || 1;
  const next = () => {
    // xorshift32: fast, and good enough for filler.
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
  // Each number and its space is four characters; one more word covers the last partial one.
  const words = Math.ceil(characters / 4) + 1;
  const parts = new Array<string>(words);
  for (let i = 0; i < words; i++) parts[i] = String(100 + (next() % 900));
  return parts.join(" ").slice(0, characters);
}

/** "1.1M", "8,421", for token counts in tight spaces. */
export function tokensLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/0$/, "")}M`;
  return n.toLocaleString("en-US");
}

/** Bytes of a string as UTF-8, for the body-size check before a big request. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** The live docs' body limit (docs/DOCS_MIRROR.md, "Limits"). */
export const MAX_BODY_BYTES = 4.5 * 1024 * 1024;
