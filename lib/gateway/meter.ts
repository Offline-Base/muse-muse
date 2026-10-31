import { builtInCalls, isBuiltInCall, responsesSearches, withSearches } from "@/lib/gateway/search";
import { fromResponsesUsage, PRICES, usageCost } from "@/lib/meta/pricing";
import type { GatewayEndpoint, ModelUsage } from "@/lib/types";

/** Largest non-streamed body the meter will buffer to read usage from. Bigger bodies record minimalUsage. */
const MAX_METER_JSON_BYTES = 256 * 1024 * 1024;

/** Events that carry a final Responses usage object. */
const RESPONSE_FINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);
/** Muse Image streaming events, one per finished image (catalog/meta-models.json). */
const IMAGE_DONE_EVENTS = new Set(["image_generation.completed", "image_edit.completed"]);
/** The event that finishes one output item, which is how a stream cut off early still shows the searches it ran. */
const OUTPUT_ITEM_DONE = "response.output_item.done";
/** What a cut-off or unreadable reply records when it showed no usage, so its spend never goes unrecorded. */
const MIN_INPUT_TOKENS = 1_000;
const MIN_OUTPUT_TOKENS = 1_000;
const MIN_AUDIO_MS = 60_000;
const CHARS_PER_TOKEN = 4;

export interface SseEvent {
  event: string | null;
  data: string;
}

/**
 * Incremental server-sent events parser. Feed it decoded text in any chunking; it calls `onEvent` for each event.
 * `wants` lets the caller skip buffering data for events it doesn't care about (SAM deltas can be large).
 */
export class SseParser {
  private buffer = "";
  private event: string | null = null;
  private data: string[] = [];
  private skipping = false;

  constructor(
    private readonly onEvent: (e: SseEvent) => void,
    private readonly wants: (event: string | null) => boolean = () => true,
  ) {}

  push(text: string): void {
    this.buffer += text;
    let idx: number;
    while ((idx = this.nextLineBreak()) >= 0) {
      const line = this.buffer.slice(0, idx);
      const breakLen = this.buffer[idx] === "\r" && this.buffer[idx + 1] === "\n" ? 2 : 1;
      this.buffer = this.buffer.slice(idx + breakLen);
      this.line(line);
    }
  }

  end(): void {
    if (this.buffer) this.line(this.buffer);
    this.buffer = "";
    this.line("");
  }

  private nextLineBreak(): number {
    const n = this.buffer.indexOf("\n");
    const r = this.buffer.indexOf("\r");
    // A trailing "\r" might be the first half of "\r\n": wait for more text.
    if (r === this.buffer.length - 1 && n < 0) return -1;
    if (n < 0) return r;
    if (r < 0) return n;
    return Math.min(n, r);
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length && !this.skipping) this.onEvent({ event: this.event, data: this.data.join("\n") });
      this.event = null;
      this.data = [];
      this.skipping = false;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      this.event = value;
      this.skipping = !this.wants(value);
    } else if (field === "data" && !this.skipping) {
      this.data.push(value);
    }
  }
}

type UsageObject = Record<string, unknown> & {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  images_processed?: number;
};

/** The largest numeric *frames* field in a usage object (SAM video), or 0. Max, not sum, to avoid double counting. */
export function framesFromUsage(usage: Record<string, unknown> | null | undefined): number {
  let frames = 0;
  for (const [key, value] of Object.entries(usage ?? {})) {
    if (/frames/i.test(key) && typeof value === "number" && Number.isFinite(value)) frames = Math.max(frames, value);
  }
  return frames;
}

/** Usage for one Responses API result (the JSON body, or the `response` of a final stream event). */
export function usageFromResponse(model: string, response: Record<string, unknown> | null | undefined): ModelUsage | null {
  if (!response) return null;
  const usage = (response.usage ?? null) as UsageObject | null;
  const item = fromResponsesUsage(model, usage);
  const frames = framesFromUsage(usage);
  if (frames) item.videoFrames = frames;
  if (model === "muse-image-1.0" && Array.isArray(response.output)) {
    item.images = response.output.filter(
      (o) => o && typeof o === "object" && (o as { type?: unknown }).type === "image_generation_call",
    ).length;
  }
  if (!usage && !item.images) return null;
  item.costUsd = usageCost(item);
  return item;
}

/** Muse Image is billed per returned image ($0.01 each). Its token counts are ignored (docs/SPIKES.md). */
export function imageUsage(count: number): ModelUsage {
  const item = { model: "muse-image-1.0", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: count };
  return { ...item, costUsd: usageCost(item) };
}

/** Voice Transcribe is billed by audioDurationMs. */
export function asrUsage(model: string, audioDurationMs: number): ModelUsage {
  const item = { model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, audioSeconds: audioDurationMs / 1000 };
  return { ...item, costUsd: usageCost(item) };
}

/**
 * Adds Meta's fee for `searches` web search queries to a text model's usage, with the query count as its units. Muse
 * Image's own searches are part of its per-image price, and SAM has none (pricing-rate-limits).
 */
function chargeSearches(model: string, item: ModelUsage, searches: number): ModelUsage {
  return searches > 0 && tokenPriced(model) ? { ...withSearches(item, searches), units: searches } : item;
}

/** Usage from a complete, non-streamed JSON reply. Responses replies include their web search fees. */
export function usageFromJson(endpoint: GatewayEndpoint, model: string | null, body: unknown): ModelUsage[] {
  if (!body || typeof body !== "object" || !model) return [];
  const obj = body as Record<string, unknown>;
  switch (endpoint) {
    case "responses": {
      const item = usageFromResponse(model, obj);
      return item ? [chargeSearches(model, item, responsesSearches(obj))] : [];
    }
    case "images/generations":
    case "images/edits": {
      const count = Array.isArray(obj.data) ? obj.data.length : 0;
      return count ? [imageUsage(count)] : [];
    }
    case "asr/transcribe": {
      const ms = typeof obj.audioDurationMs === "number" ? obj.audioDurationMs : 0;
      return ms > 0 ? [asrUsage(model, ms)] : [];
    }
    case "files":
      return [];
  }
}

function tokenPriced(model: string | null): boolean {
  const price = model ? (PRICES as Record<string, { input?: number }>)[model] : undefined;
  return !!price?.input;
}

/**
 * The usage to record for a reply that was cut off (timeout, reset) or couldn't be read: what was seen, and at least
 * a minimal charge. Meta bills a call it started, so recording nothing would hide real spend.
 */
export function minimalUsage(
  endpoint: GatewayEndpoint,
  model: string | null,
  seen: { outputTokens?: number; images?: number } = {},
): ModelUsage[] {
  if (!model) return [];
  switch (endpoint) {
    case "responses": {
      if (model === "muse-image-1.0") return [imageUsage(Math.max(1, seen.images ?? 0))];
      if (!tokenPriced(model)) {
        const item = { model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images: 1 };
        return [{ ...item, costUsd: usageCost(item) }];
      }
      const item = {
        model,
        inputTokens: MIN_INPUT_TOKENS,
        cachedInputTokens: 0,
        outputTokens: Math.max(MIN_OUTPUT_TOKENS, seen.outputTokens ?? 0),
      };
      return [{ ...item, costUsd: usageCost(item) }];
    }
    case "images/generations":
    case "images/edits":
      return [imageUsage(Math.max(1, seen.images ?? 0))];
    case "asr/transcribe":
      return [asrUsage(model, MIN_AUDIO_MS)];
    case "files":
      return [];
  }
}

function eventType(e: SseEvent): string | null {
  if (e.event) return e.event;
  const match = e.data.match(/"type"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Usage from a server-sent events stream (Responses or Muse Image streaming). `finish` is for a stream that ended;
 * `partial` for one that broke off, from the deltas seen so far (token-billed models only, so SAM's large mask deltas
 * are never buffered). Web search fees are read from the final response's output and from each finished output item,
 * so a stream cut off before its final event still pays for the searches it showed. `searches: false` leaves them out,
 * for the docs proxy, which adds its own.
 */
export function sseUsageCollector(endpoint: GatewayEndpoint, model: string | null, opts: { searches?: boolean } = {}) {
  let final: ModelUsage | null = null;
  let images = 0;
  let deltaChars = 0;
  const countDeltas = endpoint === "responses" && tokenPriced(model);
  const countSearches = countDeltas && opts.searches !== false;
  /** The final response's built-in calls and queries, once a final event showed its output. */
  let finalOutput: { calls: number; queries: number } | null = null;
  /** Built-in call items finished so far, by id when they have one. */
  const callItems = new Map<string, unknown>();
  const anonymousCalls: unknown[] = [];
  const wanted = (name: string | null) =>
    name === null ||
    RESPONSE_FINAL_EVENTS.has(name) ||
    IMAGE_DONE_EVENTS.has(name) ||
    (countDeltas && name.endsWith(".delta")) ||
    (countSearches && name === OUTPUT_ITEM_DONE);
  const parser = new SseParser((e) => {
    const type = eventType(e);
    if (!type) return;
    if (IMAGE_DONE_EVENTS.has(type)) {
      images++;
      return;
    }
    if (countDeltas && type.endsWith(".delta")) {
      try {
        const delta = (JSON.parse(e.data) as { delta?: unknown }).delta;
        if (typeof delta === "string") deltaChars += delta.length;
      } catch {
        // Not JSON: nothing to count.
      }
      return;
    }
    if (type === OUTPUT_ITEM_DONE) {
      if (!countSearches) return;
      try {
        const item = (JSON.parse(e.data) as { item?: { id?: unknown; type?: unknown; action?: unknown } }).item;
        if (!isBuiltInCall(item)) return;
        // Only what the count needs: results can be long.
        const kept = { type: item?.type, action: item?.action };
        if (typeof item?.id === "string") callItems.set(item.id, kept);
        else anonymousCalls.push(kept);
      } catch {
        // Not JSON: the final event's output still counts it.
      }
      return;
    }
    if (!RESPONSE_FINAL_EVENTS.has(type) || !model || endpoint !== "responses") return;
    try {
      const parsed = JSON.parse(e.data) as { response?: Record<string, unknown> };
      final = usageFromResponse(model, parsed.response) ?? final;
      if (countSearches && Array.isArray(parsed.response?.output)) {
        finalOutput = { calls: builtInCalls(parsed.response), queries: responsesSearches(parsed.response) };
      }
    } catch {
      // A malformed final event falls back to the estimate rather than failing the stream.
    }
  }, wanted);
  /** What the finished items showed, or the final output when it shows more: the count errs on the side of the bill. */
  const seen = () => {
    const output = [...callItems.values(), ...anonymousCalls];
    const shown: { calls: number; queries: number } = finalOutput ?? { calls: 0, queries: 0 };
    return {
      calls: Math.max(shown.calls, output.length),
      queries: Math.max(shown.queries, responsesSearches({ output })),
    };
  };
  const partial = (): ModelUsage[] => {
    const items = final ? [final] : minimalUsage(endpoint, model, { outputTokens: Math.ceil(deltaChars / CHARS_PER_TOKEN), images });
    return countSearches && model && items.length ? [chargeSearches(model, items[0], seen().queries), ...items.slice(1)] : items;
  };
  return {
    push: (text: string) => parser.push(text),
    finish(): ModelUsage[] {
      parser.end();
      if (endpoint === "images/generations" || endpoint === "images/edits") return images ? [imageUsage(images)] : [];
      // A Responses stream that closed without a final event was cut off.
      return endpoint === "responses" ? partial() : final ? [final] : [];
    },
    partial,
    /** Built-in tool calls the stream ran, or null when it never reached a final event, so it may have run more. */
    builtInCalls: (): number | null => (final || finalOutput ? seen().calls : null),
  };
}

function isEventStream(contentType: string | null): boolean {
  return (contentType ?? "").split(";")[0].trim().toLowerCase() === "text/event-stream";
}

/** What a reply used. `builtInCalls` is null when the reply was cut off or unreadable, so the count isn't known. */
export interface MeteredReply {
  items: ModelUsage[];
  builtInCalls: number | null;
}

/**
 * Reads one branch of a tee'd upstream body to the end and returns what it consumed. Never throws: when the body is
 * cut off (the upstream timeout, a reset) or can't be read, it logs and returns what it saw, or minimalUsage.
 */
export async function meterReply(
  endpoint: GatewayEndpoint,
  model: string | null,
  contentType: string | null,
  body: ReadableStream<Uint8Array>,
): Promise<MeteredReply> {
  if (endpoint === "files") {
    await body.cancel().catch(() => {});
    return { items: [], builtInCalls: 0 };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const collector = isEventStream(contentType) ? sseUsageCollector(endpoint, model) : null;
  try {
    if (collector) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        collector.push(decoder.decode(value, { stream: true }));
      }
      collector.push(decoder.decode());
      const items = collector.finish();
      return { items, builtInCalls: collector.builtInCalls() };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METER_JSON_BYTES) {
        console.warn(`[gateway] ${endpoint} reply over ${MAX_METER_JSON_BYTES} bytes, recording an estimate`);
        await reader.cancel().catch(() => {});
        return { items: minimalUsage(endpoint, model), builtInCalls: null };
      }
      chunks.push(value);
    }
    const reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> | null;
    return { items: usageFromJson(endpoint, model, reply), builtInCalls: endpoint === "responses" ? builtInCalls(reply) : 0 };
  } catch (err) {
    console.warn(`[gateway] ${endpoint} reply cut off or unreadable, recording an estimate:`, err instanceof Error ? err.message : err);
    return { items: collector ? collector.partial() : minimalUsage(endpoint, model), builtInCalls: collector?.builtInCalls() ?? null };
  } finally {
    reader.releaseLock();
  }
}

/** meterReply's usage alone. */
export async function meterBody(
  endpoint: GatewayEndpoint,
  model: string | null,
  contentType: string | null,
  body: ReadableStream<Uint8Array>,
): Promise<ModelUsage[]> {
  return (await meterReply(endpoint, model, contentType, body)).items;
}
