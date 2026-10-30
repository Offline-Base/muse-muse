import type { SseEvent } from "@/lib/docs/client/api";

/**
 * A compact log of a stream's events for StreamView: runs of the same event type fold into one line with a count
 * ("response.output_text.delta x 132"), and the log stops growing after a few hundred lines, so a long stream
 * never piles up memory in React state.
 */

export interface EventLogEntry {
  type: string;
  count: number;
  /** The first event's data, shortened, so the log shows what a type looks like. */
  sample: string;
}

const MAX_ENTRIES = 300;
const SAMPLE_MAX = 240;

/** The event's type: the SSE event name, or the JSON's own `type` (Responses and Messages put it there). */
export function eventType(e: SseEvent): string {
  const t = e.json && typeof e.json.type === "string" ? e.json.type : null;
  if (e.event && e.event !== "message") return e.event;
  if (t) return t;
  if (e.data.trim() === "[DONE]") return "[DONE]";
  if (e.json && e.json.object === "chat.completion.chunk") return "chat.completion.chunk";
  return e.event ?? "message";
}

function sampleOf(data: string): string {
  // Base64 payloads (images, masks) would fill the log; show their size instead.
  const squashed = data.replace(/"([A-Za-z0-9+/=]{200,})"/g, (_m, b64: string) => `"<${Math.round((b64.length * 3) / 4 / 1024)} KB base64>"`);
  return squashed.length > SAMPLE_MAX ? `${squashed.slice(0, SAMPLE_MAX - 3)}...` : squashed;
}

/** The log with one more event: a new line, or a higher count on the last one. Returns a new array. */
export function logEvent(log: readonly EventLogEntry[], e: SseEvent): EventLogEntry[] {
  const type = eventType(e);
  const last = log[log.length - 1];
  if (last && last.type === type) return [...log.slice(0, -1), { ...last, count: last.count + 1 }];
  if (log.length >= MAX_ENTRIES) {
    const tail = log[log.length - 1];
    return tail.type === "..." ? [...log.slice(0, -1), { ...tail, count: tail.count + 1 }] : [...log, { type: "...", count: 1, sample: "More events than the log keeps." }];
  }
  return [...log, { type, count: 1, sample: sampleOf(e.data) }];
}
