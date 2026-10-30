import type { DocsEndpoint } from "@/lib/docs/proxy/endpoints";
import { WEB_SEARCH_USD_PER_QUERY } from "@/lib/docs/proxy/policy";
import {
  asrUsage,
  minimalUsage,
  SseParser,
  sseUsageCollector,
  usageFromJson,
  type SseEvent,
} from "@/lib/gateway/meter";
import { usageCost } from "@/lib/meta/pricing";
import type { ModelUsage } from "@/lib/types";

/**
 * Reads what a docs call used from Meta's reply. Responses, images and transcription reuse the gateway's meters
 * (lib/gateway/meter.ts); this adds Chat Completions and Messages, plain and streamed, web search queries, and the
 * response id a Responses stream announces in response.created, so the visitor owns it before the stream ends.
 */

/** What a cut-off reply records when it showed no usage, as the gateway does, so its spend is never left out. */
const MIN_INPUT_TOKENS = 1_000;
const MIN_OUTPUT_TOKENS = 1_000;
const CHARS_PER_TOKEN = 4;
const RESPONSE_FINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parse(data: string): Json | null {
  try {
    const value = JSON.parse(data) as unknown;
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function eventType(e: SseEvent, json: Json | null): string | null {
  return e.event ?? (typeof json?.type === "string" ? json.type : null);
}

/** Adds Meta's web search charge ($2.50 per 1,000 queries) to a token-billed item. */
export function withSearches(item: ModelUsage, searches: number): ModelUsage {
  return searches > 0 ? { ...item, costUsd: item.costUsd + searches * WEB_SEARCH_USD_PER_QUERY } : item;
}

/** Queries one web_search_call item ran: its search action's queries, or one when it doesn't list them. */
function searchItemQueries(item: Json): number {
  const action = isObject(item.action) ? item.action : null;
  if (action && action.type !== undefined && action.type !== "search") return 0;
  return Math.max(1, Array.isArray(action?.queries) ? action.queries.length : 0);
}

/** Web search queries in a Responses result's output. Opening or searching within a page isn't a query. */
export function responsesSearches(response: Json | null | undefined): number {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.reduce<number>(
    (n, item) => n + (isObject(item) && item.type === "web_search_call" ? searchItemQueries(item) : 0),
    0,
  );
}

/** Searches in a Messages reply: its server_tool_use blocks for web_search (protocols/messages, "Response"). */
export function messagesSearches(message: Json | null | undefined): number {
  const content = Array.isArray(message?.content) ? message.content : [];
  const isSearch = (b: unknown) =>
    isObject(b) && b.type === "server_tool_use" && String(b.name ?? "").startsWith("web_search");
  return content.filter(isSearch).length;
}

/** Usage from a Chat Completions usage object: prompt_tokens include the cached ones, as in the Responses API. */
export function chatUsage(model: string, usage: unknown): ModelUsage | null {
  if (!isObject(usage)) return null;
  const details = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const item = {
    model,
    inputTokens: num(usage.prompt_tokens),
    cachedInputTokens: num(details.cached_tokens),
    outputTokens: num(usage.completion_tokens),
  };
  return { ...item, costUsd: usageCost(item) };
}

/**
 * Usage from a Messages usage object. Anthropic's input_tokens leave out the cache reads and writes, which come as
 * their own counts, so all three are added up. If Meta's input_tokens already include the cache, this errs high by the
 * cached tokens, the safe side for a budget.
 */
export function messagesUsage(model: string, usage: unknown, searches = 0): ModelUsage | null {
  if (!isObject(usage)) return null;
  const cached = num(usage.cache_read_input_tokens);
  const item = {
    model,
    inputTokens: num(usage.input_tokens) + cached + num(usage.cache_creation_input_tokens),
    cachedInputTokens: cached,
    outputTokens: num(usage.output_tokens),
  };
  return withSearches({ ...item, costUsd: usageCost(item) }, searches);
}

/** A token-billed reply cut off before it showed usage: at least the gateway's minimum, more if more was seen. */
function minimalTokens(model: string | null, outputChars: number, inputTokens = MIN_INPUT_TOKENS): ModelUsage[] {
  if (!model) return [];
  const item = {
    model,
    inputTokens: Math.max(inputTokens, MIN_INPUT_TOKENS),
    cachedInputTokens: 0,
    outputTokens: Math.max(MIN_OUTPUT_TOKENS, Math.ceil(outputChars / CHARS_PER_TOKEN)),
  };
  return [{ ...item, costUsd: usageCost(item) }];
}

/** Usage from a complete, non-streamed JSON reply. */
export function docsUsageFromJson(endpoint: DocsEndpoint, model: string | null, body: unknown): ModelUsage[] {
  if (!model || !isObject(body)) return [];
  switch (endpoint.meter) {
    case "responses": {
      const [item] = usageFromJson("responses", model, body);
      return item ? [withSearches(item, responsesSearches(body))] : [];
    }
    case "chat": {
      const item = chatUsage(model, body.usage);
      return item ? [item] : [];
    }
    case "messages": {
      const item = messagesUsage(model, body.usage, messagesSearches(body));
      return item ? [item] : [];
    }
    case "images":
      return usageFromJson(endpoint.gateway ?? "images/generations", model, body);
    case "asr":
      return usageFromJson("asr/transcribe", model, body);
    default:
      return [];
  }
}

/** What a reply that couldn't be read records. `audioMs` is the transcription's WAV length. */
export function docsMinimalUsage(endpoint: DocsEndpoint, model: string | null, audioMs?: number | null): ModelUsage[] {
  if (!model) return [];
  switch (endpoint.meter) {
    case "responses":
      return minimalUsage("responses", model);
    case "images":
      return minimalUsage(endpoint.gateway ?? "images/generations", model);
    case "asr":
      return audioMs ? [asrUsage(model, audioMs)] : minimalUsage("asr/transcribe", model);
    case "chat":
    case "messages":
      return minimalTokens(model, 0);
    default:
      return [];
  }
}

/** An incremental meter for a server-sent events reply. */
export interface StreamMeter {
  push(text: string): void;
  /** The stream ended: what it used. */
  finish(): ModelUsage[];
  /** The stream broke off: what was seen so far, and at least a minimal charge. */
  partial(): ModelUsage[];
  /**
   * True once the stream showed everything it used (its final usage). A stream that ends without it was cut off, and
   * what it saw undercounts: the input especially, which only the final usage reports.
   */
  complete(): boolean;
}

/** Keys in a delta that label it rather than carry generated text. */
const LABEL_KEYS = new Set(["type", "role", "id", "index"]);

/** Characters of generated text in a chunk's delta (content, reasoning, tool-call arguments), for a cut-off stream. */
function deltaChars(value: unknown, depth = 0): number {
  if (typeof value === "string") return value.length;
  if (depth > 8 || !value || typeof value !== "object") return 0;
  return Object.entries(value).reduce<number>((n, [k, v]) => n + (LABEL_KEYS.has(k) ? 0 : deltaChars(v, depth + 1)), 0);
}

/** Chat Completions: usage comes on the last chunk because the proxy turns on stream_options.include_usage. */
function chatStreamMeter(model: string | null): StreamMeter {
  let final: ModelUsage | null = null;
  let chars = 0;
  const parser = new SseParser((e) => {
    if (e.data === "[DONE]" || !model) return;
    const chunk = parse(e.data);
    if (!chunk) return;
    if (isObject(chunk.usage)) final = chatUsage(model, chunk.usage) ?? final;
    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      if (isObject(choice)) chars += deltaChars(choice.delta);
    }
  });
  const partial = () => (final ? [final] : minimalTokens(model, chars));
  return {
    push: (text) => parser.push(text),
    finish() {
      parser.end();
      // A stream that closed without its usage chunk was cut off.
      return partial();
    },
    partial,
    complete: () => final !== null,
  };
}

/** Messages: input counts arrive in message_start, the running output count in each message_delta. */
function messagesStreamMeter(model: string | null): StreamMeter {
  let start: Json | null = null;
  let latest: Json | null = null;
  let chars = 0;
  let searches = 0;
  /** The message's last delta (it names the stop reason) or message_stop arrived, so the counts are final. */
  let stopped = false;
  const parser = new SseParser((e) => {
    if (!model) return;
    const data = parse(e.data);
    switch (eventType(e, data)) {
      case "message_start": {
        const message = isObject(data?.message) ? data.message : null;
        if (isObject(message?.usage)) start = message.usage;
        break;
      }
      case "message_delta":
        // Counts here are cumulative; later API versions repeat the input counts too.
        if (isObject(data?.usage)) latest = { ...latest, ...data.usage };
        if (isObject(data?.delta) && data.delta.stop_reason != null && latest) stopped = true;
        break;
      case "message_stop":
        if (latest) stopped = true;
        break;
      case "content_block_start": {
        const block = isObject(data?.content_block) ? data.content_block : null;
        if (block?.type === "server_tool_use" && String(block.name ?? "").startsWith("web_search")) searches++;
        break;
      }
      case "content_block_delta":
        chars += deltaChars(data?.delta);
        break;
    }
  });
  const merged = (): ModelUsage | null =>
    model && (start || latest) ? messagesUsage(model, { ...start, ...latest }, searches) : null;
  const partial = (): ModelUsage[] => {
    const item = latest ? merged() : null;
    if (item) return [item];
    // Cut off before any message_delta: message_start's input counts, and the output seen so far.
    const input = start ? (messagesUsage(model ?? "", start)?.inputTokens ?? 0) : 0;
    return minimalTokens(model, chars, input).map((u) => withSearches(u, searches));
  };
  return {
    push: (text) => parser.push(text),
    finish() {
      parser.end();
      return partial();
    },
    partial,
    complete: () => stopped,
  };
}

/**
 * Responses: the gateway's collector reads the usage; a second, light parser reads the lifecycle events for the
 * response id (reported once, as soon as response.created arrives) and the web search queries.
 */
function responsesStreamMeter(model: string | null, onResponseId?: (id: string) => void): StreamMeter {
  const usage = sseUsageCollector("responses", model);
  let reported = false;
  let finalSearches: number | null = null;
  /** A final event (completed, incomplete or failed) carried the response's usage. */
  let finalUsage = false;
  /** Queries per finished web_search_call item, by id, for a stream cut off before its final event. */
  const searchItems = new Map<string, number>();
  let anonymousSearches = 0;
  const wanted = (name: string | null) =>
    name === null ||
    name === "response.created" ||
    name === "response.output_item.done" ||
    RESPONSE_FINAL_EVENTS.has(name);
  const lifecycle = new SseParser((e) => {
    const data = parse(e.data);
    const type = eventType(e, data);
    if (type === "response.created" && !reported) {
      const id = isObject(data?.response) ? data.response.id : null;
      if (typeof id === "string" && id) {
        reported = true;
        onResponseId?.(id);
      }
    } else if (type === "response.output_item.done") {
      const item = isObject(data?.item) ? data.item : null;
      if (item?.type === "web_search_call") {
        if (typeof item.id === "string") searchItems.set(item.id, searchItemQueries(item));
        else anonymousSearches += searchItemQueries(item);
      }
    } else if (type && RESPONSE_FINAL_EVENTS.has(type)) {
      const response = isObject(data?.response) ? data.response : null;
      if (response) finalSearches = responsesSearches(response);
      if (isObject(response?.usage)) finalUsage = true;
    }
  }, wanted);
  const searches = () => finalSearches ?? [...searchItems.values()].reduce((n, q) => n + q, anonymousSearches);
  const addSearches = (items: ModelUsage[]) =>
    items.length ? [withSearches(items[0], searches()), ...items.slice(1)] : items;
  return {
    push(text) {
      usage.push(text);
      lifecycle.push(text);
    },
    finish() {
      lifecycle.end();
      return addSearches(usage.finish());
    },
    partial: () => addSearches(usage.partial()),
    complete: () => finalUsage,
  };
}

/**
 * Transcription as server-sent events (asr/transcribe with Accept: text/event-stream): billed by the audio processed,
 * the largest audioProcessedMs any event reports, or the WAV's length when none does. A stream that failed before any
 * transcript isn't billed (speech-to-text, "Pricing").
 */
function asrStreamMeter(model: string | null, audioMs: number | null | undefined): StreamMeter {
  let processed = 0;
  let transcribed = false;
  let failed = false;
  const parser = new SseParser((e) => {
    const data = parse(e.data);
    if (!data) return;
    processed = Math.max(processed, num(data.audioProcessedMs));
    const type = eventType(e, data);
    if (type === "transcript" || type === "speechComplete") transcribed = true;
    if (type === "error") failed = true;
  });
  const billed = (cutOff: boolean): ModelUsage[] => {
    if (!model) return [];
    if (processed > 0) return [asrUsage(model, cutOff ? Math.max(processed, audioMs ?? 0) : processed)];
    if (failed && !transcribed) return [];
    return audioMs ? [asrUsage(model, audioMs)] : minimalUsage("asr/transcribe", model);
  };
  return {
    push: (text) => parser.push(text),
    finish() {
      parser.end();
      return billed(false);
    },
    partial: () => billed(true),
    // Billed by the audio, which the WAV's own length bounds, so a stream that ended is never short.
    complete: () => true,
  };
}

/** The meter for a streamed reply from this endpoint. */
export function docsStreamMeter(
  endpoint: DocsEndpoint,
  model: string | null,
  hooks: { onResponseId?: (id: string) => void; audioMs?: number | null } = {},
): StreamMeter {
  switch (endpoint.meter) {
    case "responses":
      return responsesStreamMeter(model, hooks.onResponseId);
    case "chat":
      return chatStreamMeter(model);
    case "messages":
      return messagesStreamMeter(model);
    case "asr":
      return asrStreamMeter(model, hooks.audioMs);
    case "images": {
      const collector = sseUsageCollector(endpoint.gateway ?? "images/generations", model);
      // Each image comes with its own completed event, so a stream that ended counted them all.
      return { push: collector.push, finish: collector.finish, partial: collector.partial, complete: () => true };
    }
    default:
      return { push: () => {}, finish: () => [], partial: () => [], complete: () => true };
  }
}

/**
 * Reads one branch of a tee'd stream to the end through `meter`, and says whether the stream showed all it used.
 * Never throws: a stream that is cut off (the upstream timeout, a reset) or can't be read returns what was seen, with
 * at least a minimal charge, and complete: false.
 */
export async function readMetered(
  meter: StreamMeter,
  body: ReadableStream<Uint8Array>,
): Promise<{ items: ModelUsage[]; complete: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      meter.push(decoder.decode(value, { stream: true }));
    }
    meter.push(decoder.decode());
    const items = meter.finish();
    return { items, complete: meter.complete() };
  } catch (err) {
    console.warn("[docs] stream cut off, recording what was seen:", err instanceof Error ? err.message : err);
    return { items: meter.partial(), complete: false };
  } finally {
    reader.releaseLock();
  }
}

/** readMetered's usage alone. */
export async function meterStream(meter: StreamMeter, body: ReadableStream<Uint8Array>): Promise<ModelUsage[]> {
  return (await readMetered(meter, body)).items;
}

/**
 * Whether a complete JSON reply says what its call used. One that doesn't (a Responses reply without usage, say)
 * can't be metered from, so the call keeps its estimate instead of settling at nothing.
 */
export function usageShown(endpoint: DocsEndpoint, body: unknown): boolean {
  if (!isObject(body)) return false;
  switch (endpoint.meter) {
    case "responses":
      return isObject(body.usage) || (Array.isArray(body.output) && body.output.some((o) => isObject(o) && o.type === "image_generation_call"));
    case "chat":
    case "messages":
      return isObject(body.usage);
    case "images":
      // The images themselves are the bill: an empty list means none came back, which Meta doesn't charge for.
      return Array.isArray(body.data);
    case "asr":
      return typeof body.audioDurationMs === "number";
    default:
      return true;
  }
}
