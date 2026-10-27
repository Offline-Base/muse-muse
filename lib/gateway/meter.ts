import { fromResponsesUsage, usageCost } from "@/lib/meta/pricing";
import type { GatewayEndpoint, ModelUsage } from "@/lib/types";

/** Largest non-streamed body the meter will buffer to read usage from. Bigger bodies pass through unmetered. */
const MAX_METER_JSON_BYTES = 256 * 1024 * 1024;

/** Events that carry a final Responses usage object. */
const RESPONSE_FINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);
/** Muse Image streaming events, one per finished image (catalog/meta-models.json). */
const IMAGE_DONE_EVENTS = new Set(["image_generation.completed", "image_edit.completed"]);

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

/** Usage from a complete, non-streamed JSON reply. */
export function usageFromJson(endpoint: GatewayEndpoint, model: string | null, body: unknown): ModelUsage[] {
  if (!body || typeof body !== "object" || !model) return [];
  const obj = body as Record<string, unknown>;
  switch (endpoint) {
    case "responses": {
      const item = usageFromResponse(model, obj);
      return item ? [item] : [];
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

function eventType(e: SseEvent): string | null {
  if (e.event) return e.event;
  const match = e.data.match(/"type"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

/** Usage from a server-sent events stream (Responses or Muse Image streaming). */
export function sseUsageCollector(endpoint: GatewayEndpoint, model: string | null) {
  let final: ModelUsage | null = null;
  let images = 0;
  const wanted = (name: string | null) =>
    name === null || RESPONSE_FINAL_EVENTS.has(name) || IMAGE_DONE_EVENTS.has(name);
  const parser = new SseParser((e) => {
    const type = eventType(e);
    if (!type) return;
    if (IMAGE_DONE_EVENTS.has(type)) {
      images++;
      return;
    }
    if (!RESPONSE_FINAL_EVENTS.has(type) || !model || endpoint !== "responses") return;
    try {
      const parsed = JSON.parse(e.data) as { response?: Record<string, unknown> };
      final = usageFromResponse(model, parsed.response) ?? final;
    } catch {
      // A malformed final event leaves usage unrecorded rather than failing the stream.
    }
  }, wanted);
  return {
    push: (text: string) => parser.push(text),
    finish(): ModelUsage[] {
      parser.end();
      if (endpoint === "images/generations" || endpoint === "images/edits") return images ? [imageUsage(images)] : [];
      return final ? [final] : [];
    },
  };
}

function isEventStream(contentType: string | null): boolean {
  return (contentType ?? "").split(";")[0].trim().toLowerCase() === "text/event-stream";
}

/**
 * Reads one branch of a tee'd upstream body to the end and returns what it consumed. Never throws: metering
 * problems are logged and the call goes unmetered rather than breaking the product.
 */
export async function meterBody(
  endpoint: GatewayEndpoint,
  model: string | null,
  contentType: string | null,
  body: ReadableStream<Uint8Array>,
): Promise<ModelUsage[]> {
  if (endpoint === "files") {
    await body.cancel().catch(() => {});
    return [];
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    if (isEventStream(contentType)) {
      const collector = sseUsageCollector(endpoint, model);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        collector.push(decoder.decode(value, { stream: true }));
      }
      collector.push(decoder.decode());
      return collector.finish();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METER_JSON_BYTES) {
        console.warn(`[gateway] ${endpoint} reply over ${MAX_METER_JSON_BYTES} bytes, not metered`);
        await reader.cancel().catch(() => {});
        return [];
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return usageFromJson(endpoint, model, JSON.parse(text));
  } catch (err) {
    console.warn(`[gateway] could not meter ${endpoint}:`, err instanceof Error ? err.message : err);
    return [];
  } finally {
    reader.releaseLock();
  }
}
