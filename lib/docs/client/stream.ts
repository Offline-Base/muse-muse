import type { SseEvent } from "@/lib/docs/client/api";
import type { Protocol } from "@/lib/docs/client/body";

/**
 * Readers for the three text protocols' replies, streamed or whole, into one shape the playgrounds render: the
 * visible text, the reasoning summary, tool calls with their (streamed) arguments, web searches and citations,
 * generated images, usage and the reply's id. Event names and fields follow the mirrored API references:
 *
 * - Responses: `response.*` events (api-reference/responses/schemas), ending with `response.completed`,
 *   `response.incomplete` or `response.failed`, which carry the whole final response.
 * - Chat Completions: `chat.completion.chunk` deltas, tool calls accumulated by `index`, a usage chunk at the end
 *   when `stream_options.include_usage` is set, then `[DONE]`.
 * - Messages: Anthropic's `message_start`, `content_block_*`, `message_delta` and `message_stop`.
 *
 * Each collector also accepts a whole JSON reply as one event (docsStream hands over a JSON answer to a stream
 * request that way), so a playground can read streamed and plain replies with the same code.
 */

export interface Citation {
  url: string;
  title: string;
  /** Character offsets into the text, when the API gave them (Responses url_citation). */
  start?: number;
  end?: number;
  /** The cited passage, when the API gave it (Messages). */
  quote?: string;
}

export interface ToolCall {
  /** The call's own id: a function_call item id (Responses), the tool call id (Chat), the tool_use id (Messages). */
  id: string;
  /** What a result is sent back with: call_id on Responses, the tool call id on Chat, tool_use_id on Messages. */
  callId: string;
  name: string;
  /** The arguments as JSON text, growing while they stream. */
  arguments: string;
  done: boolean;
  /** "custom" for Responses freeform tools, whose input is plain text. */
  kind: "function" | "custom";
}

export interface SearchResult {
  url: string;
  title?: string;
  snippet?: string;
}

export interface SearchCall {
  id: string;
  status: string;
  query?: string;
  results?: SearchResult[];
}

export interface GeneratedImage {
  id: string;
  /** Base64 image bytes. */
  b64: string;
  /** image/webp, image/png, image/jpeg or image/gif, read from the bytes. */
  mime: string;
  /** True while only a partial preview has arrived. */
  partial?: boolean;
}

export interface Collected {
  protocol: Protocol;
  /** resp_..., chatcmpl-..., msg_... */
  id: string | null;
  model: string | null;
  /** Responses status (in_progress, completed, incomplete, failed), or "completed" once a stream ends. */
  status: string | null;
  text: string;
  /** The reasoning summary (Responses), thinking (Messages) or reasoning_content (Chat), when there is one. */
  reasoning: string;
  refusal: string;
  toolCalls: ToolCall[];
  citations: Citation[];
  searches: SearchCall[];
  images: GeneratedImage[];
  /** The usage object in its protocol's own shape (lib/docs/client/cost.ts reads all three). */
  usage: Record<string, unknown> | null;
  /** finish_reason (Chat), stop_reason (Messages), incomplete_details.reason (Responses). */
  finishReason: string | null;
  /** An error the reply carried: a failed response, an `error` event, an error chunk. */
  error: { code: string | null; message: string } | null;
  /** The whole reply object: the final response (Responses) or one rebuilt from the deltas (Chat, Messages). */
  final: Record<string, unknown> | null;
  /** How many events were read. */
  events: number;
  /** True once the reply says it's finished. */
  done: boolean;
}

export interface Collector {
  /** Feeds one server-sent event, or a parsed JSON object (a chunk, an event, or a whole reply). */
  push(e: SseEvent | Record<string, unknown>): void;
  /** What has been read so far. Fresh arrays every time, so it can go straight into React state. */
  snapshot(): Collected;
}

type Json = Record<string, unknown>;

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

/** The JSON of an event, whichever form it came in. Returns null for "[DONE]" and other non-JSON data. */
function payload(e: SseEvent | Json): { json: Json | null; data: string | null; event: string | null } {
  if ("data" in e && typeof e.data === "string" && ("json" in e || "event" in e)) {
    const sse = e as SseEvent;
    return { json: sse.json, data: sse.data, event: sse.event };
  }
  return { json: e as Json, data: null, event: null };
}

/** Reads an image's type from its first bytes, since the API returns bare base64. */
export function imageMime(b64: string): string {
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

function citationFrom(a: unknown): Citation | null {
  const o = obj(a);
  if (!o) return null;
  // Chat Completions nests the details under url_citation; Responses and Messages put them on the annotation.
  const inner = obj(o.url_citation) ?? o;
  const url = str(inner.url);
  if (!url) return null;
  return {
    url,
    title: str(inner.title) ?? url,
    start: num(inner.start_index),
    end: num(inner.end_index),
    quote: str(inner.cited_text),
  };
}

function addCitation(list: Citation[], c: Citation | null) {
  if (!c) return;
  if (list.some((x) => x.url === c.url && x.start === c.start && x.end === c.end && x.quote === c.quote)) return;
  list.push(c);
}

function searchResults(v: unknown): SearchResult[] | undefined {
  const list = arr(v)
    .map((r) => obj(r))
    .filter((r): r is Json => !!r && typeof r.url === "string")
    .map((r) => ({ url: r.url as string, title: str(r.title), snippet: str(r.snippet) ?? str(r.page_age) }));
  return list.length ? list : undefined;
}

function errorFrom(v: unknown): { code: string | null; message: string } | null {
  const o = obj(v);
  if (!o) return null;
  const message = str(o.message);
  if (!message) return null;
  return { code: str(o.code) ?? str(o.type) ?? null, message };
}

function emptyCollected(protocol: Protocol): Collected {
  return {
    protocol,
    id: null,
    model: null,
    status: null,
    text: "",
    reasoning: "",
    refusal: "",
    toolCalls: [],
    citations: [],
    searches: [],
    images: [],
    usage: null,
    finishReason: null,
    error: null,
    final: null,
    events: 0,
    done: false,
  };
}

function copy(c: Collected): Collected {
  return {
    ...c,
    toolCalls: c.toolCalls.map((t) => ({ ...t })),
    citations: c.citations.map((x) => ({ ...x })),
    searches: c.searches.map((s) => ({ ...s, results: s.results?.map((r) => ({ ...r })) })),
    images: c.images.map((i) => ({ ...i })),
    usage: c.usage ? { ...c.usage } : null,
  };
}

/** Text kept per output item and content part, joined in order of first appearance. */
class TextSlots {
  private order: string[] = [];
  private byKey = new Map<string, { item: string; text: string }>();

  private slot(item: string, part: number | string) {
    const key = `${item}#${part}`;
    let s = this.byKey.get(key);
    if (!s) {
      s = { item, text: "" };
      this.byKey.set(key, s);
      this.order.push(key);
    }
    return s;
  }

  append(item: string, part: number | string, delta: string) {
    this.slot(item, part).text += delta;
  }

  set(item: string, part: number | string, text: string) {
    this.slot(item, part).text = text;
  }

  /** Parts of one item run together; separate items get a blank line between them. */
  join(): string {
    let out = "";
    let lastItem: string | null = null;
    for (const key of this.order) {
      const s = this.byKey.get(key)!;
      if (!s.text) continue;
      if (out && lastItem !== s.item) out += "\n\n";
      out += s.text;
      lastItem = s.item;
    }
    return out;
  }

  get empty(): boolean {
    return this.order.every((k) => !this.byKey.get(k)!.text);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Responses

/** A whole Responses object (a plain reply, or the response a terminal event carries) read into Collected. */
export function collectResponseObject(resp: Json): Collected {
  const c = emptyCollected("responses");
  c.id = str(resp.id) ?? null;
  c.model = str(resp.model) ?? null;
  c.status = str(resp.status) ?? null;
  c.usage = obj(resp.usage);
  c.error = errorFrom(resp.error);
  c.finishReason = str(obj(resp.incomplete_details)?.reason) ?? null;
  const texts: string[] = [];
  const summaries: string[] = [];
  for (const raw of arr(resp.output)) {
    const item = obj(raw);
    if (!item) continue;
    const type = str(item.type);
    if (type === "message") {
      let text = "";
      for (const part of arr(item.content)) {
        const p = obj(part);
        if (!p) continue;
        if (p.type === "output_text") {
          text += str(p.text) ?? "";
          for (const a of arr(p.annotations)) addCitation(c.citations, citationFrom(a));
        } else if (p.type === "refusal") {
          c.refusal += str(p.refusal) ?? "";
        }
      }
      if (text) texts.push(text);
    } else if (type === "reasoning") {
      for (const s of arr(item.summary)) {
        const t = str(obj(s)?.text);
        if (t) summaries.push(t);
      }
    } else if (type === "function_call" || type === "custom_tool_call") {
      c.toolCalls.push({
        id: str(item.id) ?? str(item.call_id) ?? `call_${c.toolCalls.length}`,
        callId: str(item.call_id) ?? str(item.id) ?? "",
        name: str(item.name) ?? "",
        arguments: (type === "custom_tool_call" ? str(item.input) : str(item.arguments)) ?? "",
        done: item.status !== "in_progress",
        kind: type === "custom_tool_call" ? "custom" : "function",
      });
    } else if (type === "web_search_call") {
      const action = obj(item.action);
      c.searches.push({
        id: str(item.id) ?? `ws_${c.searches.length}`,
        status: str(item.status) ?? "completed",
        query: str(action?.query),
        results: searchResults(item.results),
      });
    } else if (type === "image_generation_call") {
      const b64 = str(item.result);
      if (b64) c.images.push({ id: str(item.id) ?? `ig_${c.images.length}`, b64, mime: imageMime(b64) });
    }
  }
  c.text = texts.join("\n\n");
  c.reasoning = summaries.join("\n\n");
  c.final = resp;
  c.done = c.status !== "in_progress" && c.status !== "queued";
  return c;
}

const RESPONSE_TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed"]);

/** The final response's view of a search, filled in with what only the stream saw. */
function mergeSearch(live: SearchCall[], fin: SearchCall): SearchCall {
  const seen = live.find((x) => x.id === fin.id);
  return { id: fin.id, status: fin.status, query: fin.query ?? seen?.query, results: fin.results ?? seen?.results };
}

export function responsesCollector(): Collector {
  const c = emptyCollected("responses");
  const text = new TextSlots();
  const summary = new TextSlots();
  const tools = new Map<string, ToolCall>();
  let final: Collected | null = null;

  const meta = (resp: unknown) => {
    const r = obj(resp);
    if (!r) return;
    c.id = str(r.id) ?? c.id;
    c.model = str(r.model) ?? c.model;
    c.status = str(r.status) ?? c.status;
  };

  const toolFor = (itemId: string): ToolCall => {
    let t = tools.get(itemId);
    if (!t) {
      t = { id: itemId, callId: itemId, name: "", arguments: "", done: false, kind: "function" };
      tools.set(itemId, t);
    }
    return t;
  };

  const searchFor = (itemId: string): SearchCall => {
    let s = c.searches.find((x) => x.id === itemId);
    if (!s) {
      s = { id: itemId, status: "in_progress" };
      c.searches.push(s);
    }
    return s;
  };

  const item = (raw: unknown, done: boolean) => {
    const it = obj(raw);
    if (!it) return;
    const id = str(it.id) ?? "";
    const type = str(it.type);
    if (type === "function_call" || type === "custom_tool_call") {
      const t = toolFor(id);
      t.callId = str(it.call_id) ?? t.callId;
      t.name = str(it.name) ?? t.name;
      t.kind = type === "custom_tool_call" ? "custom" : "function";
      const args = type === "custom_tool_call" ? str(it.input) : str(it.arguments);
      if (args && (done || !t.arguments)) t.arguments = args;
      if (done) t.done = true;
    } else if (type === "web_search_call") {
      const s = searchFor(id);
      s.status = str(it.status) ?? s.status;
      s.query = str(obj(it.action)?.query) ?? s.query;
      s.results = searchResults(it.results) ?? s.results;
    } else if (type === "image_generation_call") {
      const b64 = str(it.result);
      if (b64) upsertImage(id, b64, false);
    } else if (type === "message" && done) {
      arr(it.content).forEach((part, i) => {
        const p = obj(part);
        if (p?.type === "output_text") {
          if (typeof p.text === "string" && p.text) text.set(id, i, p.text);
          for (const a of arr(p.annotations)) addCitation(c.citations, citationFrom(a));
        }
      });
    } else if (type === "reasoning" && done) {
      arr(it.summary).forEach((s, i) => {
        const t = str(obj(s)?.text);
        if (t) summary.set(id, i, t);
      });
    }
  };

  const upsertImage = (id: string, b64: string, partial: boolean) => {
    const existing = c.images.find((i) => i.id === id);
    if (existing) {
      existing.b64 = b64;
      existing.mime = imageMime(b64);
      existing.partial = partial;
    } else {
      c.images.push({ id, b64, mime: imageMime(b64), ...(partial ? { partial } : {}) });
    }
  };

  const push = (e: SseEvent | Json) => {
    const { json } = payload(e);
    c.events++;
    if (!json) return;
    const type = str(json.type) ?? "";
    const itemId = str(json.item_id) ?? `#${num(json.output_index) ?? 0}`;
    switch (type) {
      case "response.created":
      case "response.in_progress":
      case "response.queued":
        meta(json.response);
        return;
      case "response.output_item.added":
        item(json.item, false);
        return;
      case "response.output_item.done":
        item(json.item, true);
        return;
      case "response.output_text.delta":
        text.append(itemId, num(json.content_index) ?? 0, str(json.delta) ?? "");
        return;
      case "response.output_text.done":
        if (typeof json.text === "string") text.set(itemId, num(json.content_index) ?? 0, json.text);
        return;
      case "response.output_text.annotation.added":
        addCitation(c.citations, citationFrom(json.annotation));
        return;
      case "response.content_part.done": {
        const part = obj(json.part);
        if (part?.type === "output_text") {
          if (typeof part.text === "string" && part.text) text.set(itemId, num(json.content_index) ?? 0, part.text);
          for (const a of arr(part.annotations)) addCitation(c.citations, citationFrom(a));
        }
        return;
      }
      case "response.refusal.delta":
        c.refusal += str(json.delta) ?? "";
        return;
      case "response.refusal.done":
        c.refusal = str(json.refusal) ?? c.refusal;
        return;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        summary.append(itemId, num(json.summary_index) ?? num(json.content_index) ?? 0, str(json.delta) ?? "");
        return;
      case "response.reasoning_summary_text.done":
      case "response.reasoning_text.done":
        if (typeof json.text === "string") {
          summary.set(itemId, num(json.summary_index) ?? num(json.content_index) ?? 0, json.text);
        }
        return;
      case "response.reasoning_summary_part.done": {
        const t = str(obj(json.part)?.text);
        if (t) summary.set(itemId, num(json.summary_index) ?? 0, t);
        return;
      }
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta":
        toolFor(itemId).arguments += str(json.delta) ?? "";
        return;
      case "response.function_call_arguments.done":
      case "response.custom_tool_call_input.done": {
        const t = toolFor(itemId);
        const done = str(json.arguments) ?? str(json.input);
        if (done !== undefined) t.arguments = done;
        t.name = str(json.name) ?? t.name;
        t.done = true;
        return;
      }
      case "response.web_search_call.in_progress":
      case "response.web_search_call.searching":
      case "response.web_search_call.completed":
        searchFor(itemId).status = type.slice("response.web_search_call.".length);
        return;
      case "response.image_generation_call.partial_image": {
        const b64 = str(json.partial_image_b64);
        if (b64) upsertImage(itemId, b64, true);
        return;
      }
      case "error":
        c.error = errorFrom(json) ?? errorFrom(json.error) ?? { code: null, message: "The stream reported an error." };
        return;
      case "keepalive":
        return;
      default:
        if (RESPONSE_TERMINAL.has(type)) {
          const resp = obj(json.response);
          if (resp) final = collectResponseObject(resp);
          c.done = true;
          if (!resp) c.status = type.slice("response.".length);
          return;
        }
        // A whole response handed over as one event.
        if (json.object === "response") {
          final = collectResponseObject(json);
          c.done = final.done;
        }
    }
  };

  const snapshot = (): Collected => {
    const live: Collected = {
      ...c,
      text: text.join(),
      reasoning: summary.join(),
      toolCalls: [...tools.values()],
    };
    if (!final) return copy(live);
    // The terminal event carries the whole response. It wins wherever it has something, so a missed delta can't
    // leave the text short; what only the stream had (a partial image, a citation event) is kept.
    return copy({
      ...live,
      id: final.id ?? live.id,
      model: final.model ?? live.model,
      status: final.status ?? live.status,
      text: final.text || live.text,
      reasoning: final.reasoning || live.reasoning,
      refusal: final.refusal || live.refusal,
      toolCalls: final.toolCalls.length ? final.toolCalls : live.toolCalls,
      citations: final.citations.length ? final.citations : live.citations,
      searches: final.searches.length ? final.searches.map((s) => mergeSearch(live.searches, s)) : live.searches,
      images: final.images.length ? final.images : live.images,
      usage: final.usage ?? live.usage,
      finishReason: final.finishReason ?? live.finishReason,
      error: final.error ?? live.error,
      final: final.final,
      done: true,
    });
  };

  return { push, snapshot };
}

// ---------------------------------------------------------------------------------------------------------------
// Chat Completions

/** A whole chat.completion read into Collected. */
export function collectChatObject(resp: Json): Collected {
  const c = emptyCollected("chat");
  c.id = str(resp.id) ?? null;
  c.model = str(resp.model) ?? null;
  c.usage = obj(resp.usage);
  c.error = errorFrom(resp.error);
  const choice = obj(arr(resp.choices)[0]);
  const message = obj(choice?.message);
  c.text = str(message?.content) ?? "";
  c.reasoning = str(message?.reasoning_content) ?? "";
  c.refusal = str(message?.refusal) ?? "";
  c.finishReason = str(choice?.finish_reason) ?? null;
  for (const a of arr(message?.annotations)) addCitation(c.citations, citationFrom(a));
  arr(message?.tool_calls).forEach((raw, i) => {
    const t = obj(raw);
    const fn = obj(t?.function);
    const id = str(t?.id) ?? `call_${i}`;
    c.toolCalls.push({ id, callId: id, name: str(fn?.name) ?? "", arguments: str(fn?.arguments) ?? "", done: true, kind: "function" });
  });
  c.final = resp;
  c.status = "completed";
  c.done = true;
  return c;
}

export function chatCollector(): Collector {
  const c = emptyCollected("chat");
  const calls = new Map<number, ToolCall>();
  let whole: Collected | null = null;
  let created: number | undefined;

  const push = (e: SseEvent | Json) => {
    const { json, data } = payload(e);
    c.events++;
    if (data !== null && data.trim() === "[DONE]") {
      c.done = true;
      c.status = "completed";
      return;
    }
    if (!json) return;
    if (json.object === "chat.completion") {
      whole = collectChatObject(json);
      return;
    }
    const err = errorFrom(json.error);
    if (err) {
      c.error = err;
      return;
    }
    c.id = str(json.id) ?? c.id;
    c.model = str(json.model) ?? c.model;
    created = num(json.created) ?? created;
    const usage = obj(json.usage);
    if (usage) c.usage = usage;
    const choice = obj(arr(json.choices)[0]);
    if (!choice) return;
    const delta = obj(choice.delta);
    if (delta) {
      c.text += str(delta.content) ?? "";
      c.reasoning += str(delta.reasoning_content) ?? "";
      c.refusal += str(delta.refusal) ?? "";
      for (const a of arr(delta.annotations)) addCitation(c.citations, citationFrom(a));
      for (const raw of arr(delta.tool_calls)) {
        const t = obj(raw);
        if (!t) continue;
        const index = num(t.index) ?? calls.size;
        let call = calls.get(index);
        if (!call) {
          call = { id: "", callId: "", name: "", arguments: "", done: false, kind: "function" };
          calls.set(index, call);
        }
        const id = str(t.id);
        if (id) {
          call.id = id;
          call.callId = id;
        }
        const fn = obj(t.function);
        // The name arrives once, with the first chunk of a call; the arguments arrive in pieces.
        const name = str(fn?.name);
        if (name && !call.name) call.name = name;
        call.arguments += str(fn?.arguments) ?? "";
      }
    }
    const finish = str(choice.finish_reason);
    if (finish) {
      c.finishReason = finish;
      for (const call of calls.values()) call.done = true;
    }
  };

  const snapshot = (): Collected => {
    if (whole) return copy(whole);
    const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
    const live: Collected = { ...c, toolCalls };
    const message: Json = { role: "assistant", content: c.text || null };
    if (c.reasoning) message.reasoning_content = c.reasoning;
    if (toolCalls.length) {
      message.tool_calls = toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } }));
    }
    live.final = {
      id: c.id,
      object: "chat.completion",
      ...(created !== undefined ? { created } : {}),
      model: c.model,
      choices: [{ index: 0, message, finish_reason: c.finishReason }],
      ...(c.usage ? { usage: c.usage } : {}),
    };
    return copy(live);
  };

  return { push, snapshot };
}

// ---------------------------------------------------------------------------------------------------------------
// Messages

interface MessagesBlock {
  type: string;
  text: string;
  thinking: string;
  /** tool_use / server_tool_use: the input as it streamed (partial JSON), and the input the block started with. */
  partial: string;
  startInput: unknown;
  id?: string;
  name?: string;
  citations: Citation[];
  raw: Json;
  done: boolean;
}

function blockFrom(raw: Json): MessagesBlock {
  return {
    type: str(raw.type) ?? "text",
    text: str(raw.text) ?? "",
    thinking: str(raw.thinking) ?? "",
    partial: "",
    startInput: raw.input,
    id: str(raw.id),
    name: str(raw.name),
    citations: arr(raw.citations)
      .map(citationFrom)
      .filter((x): x is Citation => !!x),
    raw,
    done: false,
  };
}

function blockInput(b: MessagesBlock): string {
  if (b.partial) return b.partial;
  const start = obj(b.startInput);
  return start ? JSON.stringify(start) : "{}";
}

function fromBlocks(c: Collected, blocks: MessagesBlock[]) {
  let text = "";
  let gap = false;
  const thoughts: string[] = [];
  c.toolCalls = [];
  c.searches = [];
  c.citations = [];
  for (const b of blocks) {
    if (b.type === "text") {
      // Text blocks next to each other are one passage (Anthropic splits text at citations); a tool call or other
      // block in between starts a new paragraph.
      if (text && gap) text += "\n\n";
      text += b.text;
      gap = false;
      for (const x of b.citations) addCitation(c.citations, x);
      continue;
    }
    gap = true;
    if (b.type === "thinking" && b.thinking) thoughts.push(b.thinking);
    else if (b.type === "tool_use") {
      c.toolCalls.push({
        id: b.id ?? `toolu_${c.toolCalls.length}`,
        callId: b.id ?? "",
        name: b.name ?? "",
        arguments: blockInput(b),
        done: b.done,
        kind: "function",
      });
    } else if (b.type === "server_tool_use") {
      let query: string | undefined;
      try {
        query = str(obj(JSON.parse(blockInput(b)))?.query);
      } catch {
        query = undefined;
      }
      c.searches.push({ id: b.id ?? `srvtoolu_${c.searches.length}`, status: b.done ? "completed" : "in_progress", query });
    } else if (b.type === "web_search_tool_result") {
      const results = searchResults(b.raw.content);
      const toolUseId = str(b.raw.tool_use_id);
      const call = c.searches.find((s) => s.id === toolUseId) ?? c.searches[c.searches.length - 1];
      if (call && results) call.results = results;
    }
  }
  c.text = text;
  c.reasoning = thoughts.join("\n\n");
}

/** A whole Anthropic message read into Collected. */
export function collectMessagesObject(msg: Json): Collected {
  const c = emptyCollected("messages");
  c.id = str(msg.id) ?? null;
  c.model = str(msg.model) ?? null;
  c.usage = obj(msg.usage);
  c.finishReason = str(msg.stop_reason) ?? null;
  c.error = errorFrom(msg.error);
  const blocks = arr(msg.content)
    .map((b) => obj(b))
    .filter((b): b is Json => !!b)
    .map((b) => ({ ...blockFrom(b), done: true }));
  fromBlocks(c, blocks);
  c.final = msg;
  c.status = "completed";
  c.done = true;
  return c;
}

export function messagesCollector(): Collector {
  const c = emptyCollected("messages");
  const blocks = new Map<number, MessagesBlock>();
  let whole: Collected | null = null;

  const push = (e: SseEvent | Json) => {
    const { json, event } = payload(e);
    c.events++;
    if (!json) return;
    const type = str(json.type) ?? event ?? "";
    switch (type) {
      case "message_start": {
        const m = obj(json.message);
        c.id = str(m?.id) ?? c.id;
        c.model = str(m?.model) ?? c.model;
        const usage = obj(m?.usage);
        if (usage) c.usage = { ...usage };
        c.status = "in_progress";
        return;
      }
      case "content_block_start": {
        const raw = obj(json.content_block);
        if (raw) blocks.set(num(json.index) ?? blocks.size, blockFrom(raw));
        return;
      }
      case "content_block_delta": {
        const index = num(json.index) ?? blocks.size - 1;
        let b = blocks.get(index);
        if (!b) {
          b = blockFrom({ type: "text" });
          blocks.set(index, b);
        }
        const d = obj(json.delta);
        const kind = str(d?.type);
        if (kind === "text_delta") b.text += str(d?.text) ?? "";
        else if (kind === "thinking_delta") b.thinking += str(d?.thinking) ?? "";
        else if (kind === "input_json_delta") b.partial += str(d?.partial_json) ?? "";
        else if (kind === "citations_delta") addCitation(b.citations, citationFrom(d?.citation));
        return;
      }
      case "content_block_stop": {
        const b = blocks.get(num(json.index) ?? -1);
        if (b) b.done = true;
        return;
      }
      case "message_delta": {
        const d = obj(json.delta);
        c.finishReason = str(d?.stop_reason) ?? c.finishReason;
        const usage = obj(json.usage);
        // message_delta's usage holds the final output count (and any fields message_start lacked).
        if (usage) c.usage = { ...(c.usage ?? {}), ...usage };
        return;
      }
      case "message_stop":
        c.done = true;
        c.status = "completed";
        return;
      case "error":
        c.error = errorFrom(json.error) ?? { code: null, message: "The stream reported an error." };
        return;
      case "ping":
        return;
      default:
        if (json.type === "message" && Array.isArray(json.content)) whole = collectMessagesObject(json);
    }
  };

  const snapshot = (): Collected => {
    if (whole) return copy(whole);
    const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const live: Collected = { ...c };
    fromBlocks(live, ordered);
    live.final = {
      id: c.id,
      type: "message",
      role: "assistant",
      model: c.model,
      content: ordered.map((b) => {
        if (b.type === "text") return { type: "text", text: b.text, ...(b.citations.length ? { citations: b.citations } : {}) };
        if (b.type === "thinking") return { type: "thinking", thinking: b.thinking };
        if (b.type === "tool_use" || b.type === "server_tool_use") {
          let input: unknown = {};
          try {
            input = JSON.parse(blockInput(b));
          } catch {
            input = blockInput(b);
          }
          return { type: b.type, id: b.id, name: b.name, input };
        }
        return b.raw;
      }),
      stop_reason: c.finishReason,
      ...(c.usage ? { usage: c.usage } : {}),
    };
    return copy(live);
  };

  return { push, snapshot };
}

// ---------------------------------------------------------------------------------------------------------------

export function collectorFor(protocol: Protocol): Collector {
  if (protocol === "chat") return chatCollector();
  if (protocol === "messages") return messagesCollector();
  return responsesCollector();
}

/** A whole reply (not streamed) read into Collected. */
export function collectReply(protocol: Protocol, json: unknown): Collected {
  const o = obj(json);
  if (!o) return emptyCollected(protocol);
  if (protocol === "chat") return collectChatObject(o);
  if (protocol === "messages") return collectMessagesObject(o);
  return collectResponseObject(o);
}

/** Which protocol a reply is, by its shape, or null for anything else (files, models, images, transcripts). */
export function protocolOfReply(json: unknown): Protocol | null {
  const o = obj(json);
  if (!o) return null;
  if (o.object === "response") return "responses";
  if (o.object === "chat.completion" || o.object === "chat.completion.chunk") return "chat";
  if (o.type === "message" && Array.isArray(o.content)) return "messages";
  return null;
}

/** Which protocol a Meta path speaks, for the text endpoints. */
export function protocolOfPath(path: string): Protocol | null {
  const p = path.replace(/^\/+/, "").replace(/^v1\//, "").replace(/[?#].*$/, "");
  if (p === "responses") return "responses";
  if (p === "chat/completions") return "chat";
  if (p === "messages") return "messages";
  return null;
}
