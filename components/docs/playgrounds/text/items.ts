import type { SseEvent } from "@/lib/docs/client/api";

/**
 * A Responses reply as its ordered output items, streamed or whole. The kit's collector (lib/docs/client/stream) folds
 * a reply into one text with the citations pooled, which is right for a chat bubble but loses what the search
 * grounding and tool search pages teach: which message is a preamble (`phase: "commentary"`) and which is the answer,
 * whose citation offsets point into which text, and the order of tool_search_call, tool_search_output and
 * function_call items. This keeps each item whole, so those pages can render them one by one.
 */

type Json = Record<string, unknown>;

export interface UrlAnnotation {
  url: string;
  title: string;
  /** Offsets into this text block, as the API sent them (code points). */
  start: number;
  end: number;
}

export interface OutputItem {
  id: string;
  type: string;
  /** Position in `output`. */
  index: number;
  status: string;
  /** "commentary" for a preamble the model writes before a tool call; null for the answer. */
  phase: string | null;
  /** A message's text, all its output_text parts joined. */
  text: string;
  /** A message's url_citation annotations, with offsets into `text`. */
  annotations: UrlAnnotation[];
  /** The item as the API sent it (the latest version seen). */
  raw: Json;
}

export interface ItemsSnapshot {
  items: OutputItem[];
  /** The response object: the final one once the stream ends, else what response.created carried. */
  response: Json | null;
  usage: Json | null;
  error: { code: string | null; message: string } | null;
  done: boolean;
}

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function annotationOf(raw: unknown): UrlAnnotation | null {
  const a = obj(raw);
  if (!a || (a.type !== undefined && a.type !== "url_citation")) return null;
  const url = str(a.url);
  if (!url) return null;
  return { url, title: str(a.title) || url, start: num(a.start_index) ?? 0, end: num(a.end_index) ?? 0 };
}

/** The text and annotations of a message's content parts. Annotation offsets are per part, so later parts shift. */
function messageText(content: unknown): { text: string; annotations: UrlAnnotation[] } {
  let text = "";
  const annotations: UrlAnnotation[] = [];
  for (const raw of arr(content)) {
    const part = obj(raw);
    if (!part || part.type !== "output_text") continue;
    const shift = [...text].length;
    for (const a of arr(part.annotations)) {
      const ann = annotationOf(a);
      if (ann) annotations.push({ ...ann, start: ann.start + shift, end: ann.end + shift });
    }
    text += str(part.text) ?? "";
  }
  return { text, annotations };
}

/** One output item from the API's JSON. */
export function itemOf(raw: Json, index: number): OutputItem {
  const type = str(raw.type) ?? "unknown";
  const base: OutputItem = {
    id: str(raw.id) ?? `#${index}`,
    type,
    index,
    status: str(raw.status) ?? "completed",
    phase: str(raw.phase) ?? null,
    text: "",
    annotations: [],
    raw,
  };
  if (type === "message") Object.assign(base, messageText(raw.content));
  return base;
}

/** Every output item of a whole Responses object, in order. */
export function itemsOf(response: unknown): OutputItem[] {
  return arr(obj(response)?.output)
    .map((x) => obj(x))
    .filter((x): x is Json => !!x)
    .map((x, i) => itemOf(x, i));
}

function errorOf(v: unknown): { code: string | null; message: string } | null {
  const o = obj(v);
  const message = str(o?.message);
  return message ? { code: str(o?.code) ?? str(o?.type) ?? null, message } : null;
}

const TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed"]);

/**
 * Reads a Responses stream (or a whole reply handed over as one event) into ordered items. Items appear as
 * `response.output_item.added` announces them, grow with text deltas and annotation events, and are replaced by the
 * final response's own items when the stream ends, since those are complete.
 */
export function itemsReader() {
  const byId = new Map<string, OutputItem>();
  const order: string[] = [];
  let response: Json | null = null;
  let usage: Json | null = null;
  let error: { code: string | null; message: string } | null = null;
  let done = false;
  let final: OutputItem[] | null = null;

  const upsert = (raw: Json, index: number) => {
    const next = itemOf(raw, index);
    const id = next.id;
    const prev = byId.get(id);
    if (!prev) order.push(id);
    // An item announced empty keeps the text its deltas built until its done event brings the whole of it.
    byId.set(id, prev && next.type === "message" && !next.text ? { ...next, text: prev.text, annotations: prev.annotations } : next);
  };

  const itemFor = (json: Json): OutputItem | undefined => {
    const id = str(json.item_id);
    if (id && byId.has(id)) return byId.get(id);
    const index = num(json.output_index);
    return index === undefined ? undefined : [...byId.values()].find((x) => x.index === index);
  };

  const push = (e: SseEvent | Json) => {
    const json = "data" in e && typeof (e as SseEvent).data === "string" && "json" in e ? (e as SseEvent).json : (e as Json);
    if (!json) return;
    const type = str(json.type) ?? "";
    if (json.object === "response") {
      response = json;
      usage = obj(json.usage) ?? usage;
      error = errorOf(json.error) ?? error;
      final = itemsOf(json);
      done = json.status !== "in_progress" && json.status !== "queued";
      return;
    }
    switch (type) {
      case "response.created":
      case "response.in_progress":
      case "response.queued":
        response = obj(json.response) ?? response;
        return;
      case "response.output_item.added":
      case "response.output_item.done": {
        const raw = obj(json.item);
        if (raw) upsert(raw, num(json.output_index) ?? order.length);
        return;
      }
      case "response.output_text.delta": {
        const it = itemFor(json);
        if (it) it.text += str(json.delta) ?? "";
        return;
      }
      case "response.output_text.annotation.added": {
        const it = itemFor(json);
        const ann = annotationOf(json.annotation);
        if (it && ann && !it.annotations.some((a) => a.start === ann.start && a.end === ann.end && a.url === ann.url)) it.annotations.push(ann);
        return;
      }
      case "response.web_search_call.in_progress":
      case "response.web_search_call.searching":
      case "response.web_search_call.completed": {
        const it = itemFor(json);
        if (it) it.status = type.slice("response.web_search_call.".length);
        return;
      }
      case "error":
        error = errorOf(json) ?? errorOf(json.error) ?? { code: null, message: "The stream reported an error." };
        return;
      default:
        if (TERMINAL.has(type)) {
          const resp = obj(json.response);
          if (resp) {
            response = resp;
            usage = obj(resp.usage) ?? usage;
            error = errorOf(resp.error) ?? error;
            final = itemsOf(resp);
          }
          done = true;
        }
    }
  };

  const snapshot = (): ItemsSnapshot => {
    const items = final && final.length ? final : order.map((id) => byId.get(id)!).sort((a, b) => a.index - b.index);
    return {
      items: items.map((x) => ({ ...x, annotations: x.annotations.map((a) => ({ ...a })) })),
      response,
      usage,
      error,
      done,
    };
  };

  return { push, snapshot };
}

/** The message items that answer, leaving out the commentary preambles. */
export function answerItems(items: readonly OutputItem[]): OutputItem[] {
  return items.filter((x) => x.type === "message" && x.phase !== "commentary");
}

/** The preambles the model wrote before its tool calls, in order. */
export function commentaryItems(items: readonly OutputItem[]): OutputItem[] {
  return items.filter((x) => x.type === "message" && x.phase === "commentary" && x.text.trim());
}
