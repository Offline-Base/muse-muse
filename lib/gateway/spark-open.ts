import { inputTokensOf, outputCeiling } from "@/lib/gateway/estimate";
import type { ParsedRequest } from "@/lib/gateway/extract";
import { SseParser, type MeteredReply } from "@/lib/gateway/meter";
import {
  SPARK_OPEN_MODEL,
  SPARK_OPEN_PROVIDERS,
  sparkOpenCost,
  sparkOpenProviderFrom,
  type SparkOpenPrice,
  type SparkOpenProvider,
  type SparkOpenProviderInfo,
} from "@/lib/meta/spark-open";
import type { ModelUsage } from "@/lib/types";

/**
 * The gateway's Muse Spark Open path (SPARK_OPEN_PRODUCTS): POST {GATEWAY_URL}/v1/chat/completions with model muse-spark-open
 * and the product's own token. handleGateway runs it through the same checks as a Meta call (allowlist, rate limits, in-flight
 * slots, run caps, the token's daily budget, the platform's daily cap, a reservation, then the metered usage) and forwards it to
 * the provider SPARK_OPEN_PROVIDER names, with the platform's key for it. The body stays in Chat Completions shape both ways,
 * since every provider serves that, so nothing is translated: only the model id, max_tokens and stream_options change. With the
 * flag off, handleGateway never sees this endpoint.
 */

export const SPARK_OPEN_ENDPOINT = "chat/completions" as const;
export type SparkOpenEndpoint = typeof SPARK_OPEN_ENDPOINT;

/** The one model this endpoint takes. */
export const SPARK_OPEN_ENDPOINT_MODELS: readonly string[] = [SPARK_OPEN_MODEL];

/** Where a call goes, with the key, read per call. Never in a reply, a header or a log. */
export interface SparkOpenUpstream extends SparkOpenProviderInfo {
  provider: SparkOpenProvider;
  key: string;
}

export function parseSparkOpenEndpoint(path: readonly string[]): SparkOpenEndpoint | null {
  return path.join("/") === SPARK_OPEN_ENDPOINT ? SPARK_OPEN_ENDPOINT : null;
}

/** The provider and its key, per call so a test can set them. Null when the provider is unknown or its key is missing. */
export function sparkOpenUpstream(source: Record<string, string | undefined> = process.env): SparkOpenUpstream | null {
  const provider = sparkOpenProviderFrom(source);
  if (!provider) return null;
  const info = SPARK_OPEN_PROVIDERS[provider];
  const key = source[info.keyEnv]?.trim();
  return key ? { ...info, provider, key } : null;
}

/** Fields a product may send. Anything else is refused rather than dropped, since some (a service tier, best_of) change the bill. */
const KNOWN_FIELDS = new Set([
  "model",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stop",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "response_format",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "stream_options",
  "reasoning_effort",
  "n",
  "logprobs",
  "top_logprobs",
  "user",
  "safety_identifier",
  "metadata",
  "store",
]);

/** Taken, then left out: names for a person, and fields only OpenAI keeps. The provider needs none of them. */
const DROPPED_FIELDS = ["user", "safety_identifier", "metadata", "store"];

const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const PART_TYPES = new Set(["text", "image_url"]);
export const SPARK_OPEN_MAX_MESSAGES = 256;

export interface SparkOpenRefusal {
  status: number;
  code: string;
  message: string;
}

export interface SparkOpenRequest {
  /** The body the provider gets. */
  json: Record<string, unknown>;
  notes: string[];
  refusal: SparkOpenRefusal | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function messagesProblem(messages: unknown): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return '"messages" must be a list with at least one message.';
  if (messages.length > SPARK_OPEN_MAX_MESSAGES) return `Send at most ${SPARK_OPEN_MAX_MESSAGES} messages.`;
  for (const m of messages) {
    if (!isObject(m) || typeof m.role !== "string" || !ROLES.has(m.role)) return "Each message needs a role: system, developer, user, assistant or tool.";
    const content = m.content;
    if (content === undefined || content === null || typeof content === "string") continue;
    if (!Array.isArray(content)) return "A message's content is a string or a list of parts.";
    for (const part of content) {
      const type = isObject(part) ? part.type : undefined;
      if (typeof type !== "string" || !PART_TYPES.has(type)) {
        return `Muse Spark Open takes text and images here (parts of type text and image_url), not ${JSON.stringify(type ?? null).slice(0, 40)}.`;
      }
    }
  }
  return null;
}

/**
 * The body a provider gets for a product's call, or why it can't run. One reply per call (n 1), function tools only, text and
 * image parts only. max_tokens is always set, to what was asked (max_completion_tokens counts too) up to the gateway's ceiling,
 * or to the ceiling's default, so the estimate is a true ceiling on the output, reasoning included. A stream always asks for its
 * usage, which the meter reads.
 */
export function sparkOpenRequest(parsed: ParsedRequest, upstream: Pick<SparkOpenUpstream, "model">): SparkOpenRequest {
  const refuse = (code: string, message: string, status = 400): SparkOpenRequest => ({ json: {}, notes: [], refusal: { status, code, message } });
  if (parsed.kind !== "json") return refuse("invalid_body", "/v1/chat/completions takes a JSON body.");
  const input = parsed.json;
  const unknown = Object.keys(input).find((k) => !KNOWN_FIELDS.has(k));
  if (unknown) return refuse("invalid_arguments", `Muse Spark Open's route doesn't take "${unknown.slice(0, 40)}".`);
  const problem = messagesProblem(input.messages);
  if (problem) return refuse("invalid_arguments", problem);
  if (input.n !== undefined && input.n !== null && input.n !== 1) return refuse("invalid_arguments", "Ask for one reply at a time: n must be 1.");
  if (input.tools !== undefined && input.tools !== null) {
    if (!Array.isArray(input.tools) || input.tools.some((t) => !isObject(t) || t.type !== "function")) {
      return refuse("invalid_arguments", "Muse Spark Open takes function tools only here. It has no web search.");
    }
  }
  const json: Record<string, unknown> = { ...input, model: upstream.model };
  for (const field of DROPPED_FIELDS) delete json[field];
  const notes: string[] = [];
  const asked = input.max_completion_tokens ?? input.max_tokens;
  const ceiling = outputCeiling(asked);
  delete json.max_completion_tokens;
  json.max_tokens = ceiling;
  if (asked !== ceiling) {
    notes.push(
      asked === undefined || asked === null
        ? `Set max_tokens to ${ceiling}: every Muse Spark Open call has a ceiling, and its reasoning counts toward it.`
        : `Set max_tokens to ${ceiling}: that is the most one Muse Spark Open call may ask for here.`,
    );
  }
  if (json.stream === true) json.stream_options = { include_usage: true };
  else delete json.stream_options;
  return { json, notes, refusal: null };
}

/**
 * Input tokens the chat template adds to every call, before any message. The Nov 2 smoke call on Baseten billed 152 prompt
 * tokens for a 27-character question.
 */
export const SPARK_OPEN_TEMPLATE_TOKENS = 200;

/** A conservative cost for the call before it's forwarded: the input as the gateway counts it, the template's, and max_tokens of output. */
export function sparkOpenEstimate(parsed: ParsedRequest, price: SparkOpenPrice): number {
  if (parsed.kind !== "json") return 0;
  const json = parsed.json;
  const inputTokens = SPARK_OPEN_TEMPLATE_TOKENS + inputTokensOf(json.messages, json.tools, json.response_format);
  return sparkOpenCost(price, { inputTokens, cachedInputTokens: 0, outputTokens: outputCeiling(json.max_tokens) });
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);

/** A ModelUsage from a Chat Completions usage object, or null when there is none. */
export function usageFromChat(usage: unknown, price: SparkOpenPrice): ModelUsage | null {
  if (!isObject(usage) || (typeof usage.prompt_tokens !== "number" && typeof usage.completion_tokens !== "number")) return null;
  const details = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const item = {
    model: SPARK_OPEN_MODEL,
    inputTokens: count(usage.prompt_tokens),
    cachedInputTokens: count(details?.cached_tokens),
    outputTokens: count(usage.completion_tokens),
  };
  return { ...item, costUsd: sparkOpenCost(price, item) };
}

/** Largest non-streamed reply the meter buffers. Bigger ones keep their reservation. */
const MAX_METER_JSON_BYTES = 32 * 1024 * 1024;
const CHARS_PER_TOKEN = 4;

/**
 * Reads one branch of a tee'd reply to the end. With usage seen, the call is metered on it and builtInCalls is 0 (this route
 * runs no built-in tools). Without it (a stream cut off, a body too big or unreadable), the item counts only the text seen and
 * builtInCalls is null, which tells handleGateway the bill wasn't read, so the call keeps its whole reservation. Never throws.
 */
export async function meterSparkOpen(contentType: string | null, body: ReadableStream<Uint8Array>, price: SparkOpenPrice): Promise<MeteredReply> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let usage: ModelUsage | null = null;
  let chars = 0;
  const unread = (): MeteredReply => {
    const item = { model: SPARK_OPEN_MODEL, inputTokens: 0, cachedInputTokens: 0, outputTokens: Math.ceil(chars / CHARS_PER_TOKEN) };
    return { items: [{ ...item, costUsd: sparkOpenCost(price, item) }], builtInCalls: null };
  };
  const done = (): MeteredReply => (usage ? { items: [usage], builtInCalls: 0 } : unread());
  try {
    if ((contentType ?? "").split(";")[0].trim().toLowerCase() === "text/event-stream") {
      const parser = new SseParser((e) => {
        if (e.data.trim() === "[DONE]") return;
        try {
          const chunk = JSON.parse(e.data) as { usage?: unknown; choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }> };
          usage = usageFromChat(chunk.usage, price) ?? usage;
          for (const choice of chunk.choices ?? []) {
            for (const text of [choice.delta?.content, choice.delta?.reasoning_content]) if (typeof text === "string") chars += text.length;
          }
        } catch {
          // Not JSON: nothing to count.
        }
      });
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.end();
      return done();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      size += value.byteLength;
      if (size > MAX_METER_JSON_BYTES) {
        await reader.cancel().catch(() => {});
        return unread();
      }
      chunks.push(value);
    }
    const reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { usage?: unknown } | null;
    usage = usageFromChat(reply?.usage, price);
    return done();
  } catch (err) {
    console.warn("[gateway] Muse Spark Open reply cut off or unreadable, keeping its reservation:", err instanceof Error ? err.message : err);
    return done();
  } finally {
    reader.releaseLock();
  }
}
