import OpenAI from "openai";
import { gatewayEnv } from "@/lib/meta/client";
import { plain } from "@/lib/meta/text";
import type { AgentEvent, AgentSource, AgentStep } from "./events";

/**
 * One streamed call to Muse Wonder: what comes back, as events while it runs and as an outcome at the end. runAgent and
 * deepResearch are loops around this.
 */

export const AGENT_MODEL = "muse-wonder-1.0";
export const RUN_HEADER = "x-musemuse-run-id";
export const NOTE_HEADER = "x-musemuse-note";

/** Muse Wonder's list prices, and Meta's fee per search query. Only used for the estimate a run shows. */
const INPUT_USD_PER_TOKEN = 4 / 1e6;
const CACHED_USD_PER_TOKEN = 0.2 / 1e6;
const OUTPUT_USD_PER_TOKEN = 20 / 1e6;
const SEARCH_USD_PER_QUERY = 0.0025;

/** Each source keeps this much of its page. The page's full text never goes to the screen. */
const SNIPPET_CHARS = 280;
const MOST_SOURCES = 40;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A run's id for x-musemuse-run-id, in the characters and length the gateway takes. */
export function newRunId(): string {
  return `run_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** The gateway client for a run. One retry: the gateway says when a retry won't help. */
export function agentClient(headers: Record<string, string>): OpenAI {
  return new OpenAI({ ...gatewayEnv(), maxRetries: 1, defaultHeaders: headers });
}

function siteOf(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

/** http and https only: a page can put anything in a link, and this one ends up in an href. */
export function safeUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** The run's sources, one per page, with each page cited if any mention of it was. */
export class SourceBook {
  private readonly byKey = new Map<string, AgentSource>();

  constructor(seed: readonly AgentSource[] = []) {
    for (const source of seed) this.byKey.set(source.id, source);
  }

  /** The id a page's URL goes by here, or null for a URL that can't be a source. */
  idOf(value: unknown): string | null {
    const url = safeUrl(value);
    if (!url) return null;
    url.hash = "";
    return url.href.replace(/\/$/, "");
  }

  known(value: unknown): boolean {
    const id = this.idOf(value);
    return !!id && this.byKey.has(id);
  }

  /** The source to tell the page about, or null when this adds nothing new. */
  add(input: { url: unknown; title?: unknown; snippet?: unknown; date?: unknown; cited: boolean }): AgentSource | null {
    const url = safeUrl(input.url);
    const key = this.idOf(input.url);
    if (!url || !key) return null;
    url.hash = "";
    const known = this.byKey.get(key);
    if (!known && this.byKey.size >= MOST_SOURCES) return null;
    const title = typeof input.title === "string" && input.title.trim() ? plain(input.title.trim()).slice(0, 200) : siteOf(url);
    const snippet = typeof input.snippet === "string" && input.snippet.trim() ? plain(input.snippet.trim()).slice(0, SNIPPET_CHARS) : undefined;
    const date = typeof input.date === "string" && input.date.trim() ? input.date.trim().slice(0, 40) : undefined;
    const next: AgentSource = {
      id: key,
      title: known && known.title !== siteOf(url) ? known.title : title,
      href: url.href,
      detail: siteOf(url),
      kind: "web",
      cited: input.cited || (known?.cited ?? false),
      ...((known?.snippet ?? snippet) ? { snippet: known?.snippet ?? snippet } : {}),
      ...((known?.date ?? date) ? { date: known?.date ?? date } : {}),
    };
    this.byKey.set(key, next);
    return known && known.cited === next.cited && known.title === next.title && known.snippet === next.snippet ? null : next;
  }

  list(): AgentSource[] {
    return [...this.byKey.values()];
  }
}

export interface FunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export type TurnOutcome =
  | {
      kind: "completed" | "incomplete";
      responseId: string;
      text: string;
      calls: FunctionCall[];
      /** Built-in tool calls this turn made, which is what the run's tool-call cap counts. */
      builtInCalls: number;
      costUsd: number;
      /** The ids of the sources this turn's text cites. Muse Wonder hasn't sent any so far: see takeSourcesLine. */
      citations: string[];
      /** The ids of the pages this turn's searches returned, in order. */
      results: string[];
    }
  | { kind: "aborted"; responseId: string | null }
  | { kind: "failed"; code: string; status: number | null; message: string };

/** What one response's usage and searches come to, at list price. */
export function turnCostUsd(usage: unknown, searches: number): number {
  const u = isObject(usage) ? usage : {};
  const input = Number(u.input_tokens) || 0;
  const cached = Math.min(input, Number(isObject(u.input_tokens_details) ? u.input_tokens_details.cached_tokens : 0) || 0);
  const output = Number(u.output_tokens) || 0;
  return (input - cached) * INPUT_USD_PER_TOKEN + cached * CACHED_USD_PER_TOKEN + output * OUTPUT_USD_PER_TOKEN + searches * SEARCH_USD_PER_QUERY;
}

function queriesOf(item: Json): string[] {
  const action = isObject(item.action) ? item.action : null;
  const raw = Array.isArray(action?.queries) ? action.queries : typeof action?.query === "string" ? [action.query] : [];
  return raw.filter((q): q is string => typeof q === "string" && !!q.trim());
}

/** Billable queries in one web_search_call. Opening a page or finding text in one isn't a query. */
function billedQueries(item: Json): number {
  const action = isObject(item.action) ? item.action : null;
  if (action && action.type !== undefined && action.type !== "search") return 0;
  return Math.max(1, queriesOf(item).length);
}

function searchStep(item: Json, state: AgentStep["state"], title: string): AgentStep {
  const queries = queriesOf(item);
  const action = isObject(item.action) ? item.action : null;
  const opened = typeof action?.url === "string" ? safeUrl(action.url) : null;
  const description = queries.length ? plain(queries.join(", ")).slice(0, 160) : opened ? siteOf(opened) : undefined;
  return {
    id: String(item.id ?? `search_${title}`),
    title: opened ? "Reading a page" : title,
    state,
    kind: "search",
    ...(description ? { description } : {}),
  };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });

/** The chained response can take a few seconds to be readable: Meta says to retry this 400 with a short wait. */
const CHAIN_RETRIES = 2;
const CHAIN_RETRY_MS = 1500;

function isChainNotReady(err: unknown, body: Json): boolean {
  if (!(err instanceof OpenAI.APIError) || err.status !== 400 || !body.previous_response_id) return false;
  const detail = (err.error ?? {}) as { param?: unknown; message?: unknown };
  return /previous_response/i.test(`${String(detail.param ?? "")} ${String(detail.message ?? err.message)}`);
}

function plainDelta(delta: string): string {
  return delta.replace(/[ \t]*\u2014[ \t]*/g, ", ");
}

export interface TurnOptions {
  client: OpenAI;
  body: Json;
  runId: string;
  signal: AbortSignal;
  turn: number;
  book: SourceBook;
  /** The title a search step shows. */
  searchTitle?: string;
}

/** Streams one response. Yields steps, sources, text and notes, and returns how it went. It never throws. */
export async function* streamTurn(o: TurnOptions): AsyncGenerator<AgentEvent, TurnOutcome> {
  const searchTitle = o.searchTitle ?? "Searching the web";
  let responseId: string | null = null;
  let text = "";
  const citations = new Set<string>();
  const results = new Set<string>();
  const commentary = new Set<string>();
  const cite = (annotation: Json): AgentSource | null => {
    const id = o.book.idOf(annotation.url);
    if (id) citations.add(id);
    return o.book.add({ url: annotation.url, title: annotation.title, cited: true });
  };
  try {
    let opened: Awaited<ReturnType<typeof open>> | null = null;
    for (let attempt = 0; !opened; attempt++) {
      try {
        opened = await open(o);
      } catch (err) {
        if (attempt >= CHAIN_RETRIES || !isChainNotReady(err, o.body)) throw err;
        await sleep(CHAIN_RETRY_MS, o.signal);
      }
    }
    const note = opened.response.headers.get(NOTE_HEADER);
    if (note) yield { type: "note", message: note };

    const seen = new Set<string>();
    const finish = function* (item: Json): Generator<AgentEvent> {
      if (item.type === "web_search_call") {
        const id = String(item.id ?? "");
        if (seen.has(id)) return;
        seen.add(id);
        const hits = Array.isArray(item.results) ? item.results : [];
        // Meta streams a call over max_tool_calls as failed, with no results, then drops it from the final output.
        if (item.status === "failed" && !hits.length) {
          yield { type: "step_gone", id };
          return;
        }
        yield { type: "step", step: searchStep(item, item.status === "failed" ? "failed" : "done", searchTitle) };
        for (const hit of hits) {
          if (!isObject(hit)) continue;
          const hitId = o.book.idOf(hit.url);
          if (hitId) results.add(hitId);
          const source = o.book.add({ url: hit.url, title: hit.title, snippet: hit.snippet, cited: false });
          if (source) yield { type: "source", source };
        }
      } else if (item.type === "tool_search_call") {
        yield { type: "step", step: { id: String(item.id ?? "tool_search"), title: "Picking a tool", state: "done", kind: "tool" } };
      }
    };

    for await (const event of opened.stream as AsyncIterable<Json>) {
      switch (event.type) {
        case "response.created":
        case "response.in_progress":
          if (isObject(event.response) && typeof event.response.id === "string") responseId = event.response.id;
          break;
        case "response.output_item.added": {
          const item = isObject(event.item) ? event.item : {};
          if (item.type === "web_search_call") yield { type: "step", step: searchStep(item, "running", searchTitle) };
          if (item.type === "message" && item.phase === "commentary") commentary.add(String(item.id));
          break;
        }
        case "response.output_item.done":
          if (isObject(event.item)) yield* finish(event.item);
          break;
        case "response.output_text.delta":
          // A preamble before a search or a tool call isn't the answer (protocols/responses, "Message phase").
          if (typeof event.delta === "string" && event.delta && !commentary.has(String(event.item_id))) {
            text += event.delta;
            yield { type: "text", delta: plainDelta(event.delta), turn: o.turn };
          }
          break;
        case "response.output_text.annotation.added": {
          const a = isObject(event.annotation) ? event.annotation : {};
          if (a.type === "url_citation") {
            const source = cite(a);
            if (source) yield { type: "source", source };
          }
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const response = isObject(event.response) ? event.response : {};
          const output = Array.isArray(response.output) ? (response.output as unknown[]).filter(isObject) : [];
          let searches = 0;
          let builtInCalls = 0;
          const calls: FunctionCall[] = [];
          const parts: string[] = [];
          for (const item of output) {
            yield* finish(item);
            if (item.type === "web_search_call") {
              builtInCalls++;
              searches += billedQueries(item);
            } else if (item.type === "tool_search_call") {
              builtInCalls++;
            } else if (item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
              calls.push({ callId: item.call_id, name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "{}" });
            } else if (item.type === "message" && item.phase !== "commentary" && Array.isArray(item.content)) {
              for (const block of item.content) {
                if (!isObject(block) || block.type !== "output_text" || typeof block.text !== "string") continue;
                parts.push(block.text);
                for (const a of Array.isArray(block.annotations) ? block.annotations : []) {
                  if (!isObject(a) || a.type !== "url_citation") continue;
                  const source = cite(a);
                  if (source) yield { type: "source", source };
                }
              }
            }
          }
          return {
            kind: event.type === "response.completed" ? "completed" : "incomplete",
            responseId: typeof response.id === "string" ? response.id : (responseId ?? ""),
            text: parts.length ? parts.join("\n\n") : text,
            calls,
            builtInCalls,
            costUsd: turnCostUsd(response.usage, searches),
            citations: [...citations],
            results: [...results],
          };
        }
        case "response.failed": {
          const response = isObject(event.response) ? event.response : {};
          const error = isObject(response.error) ? response.error : {};
          return { kind: "failed", code: String(error.code ?? "server_error"), status: null, message: String(error.message ?? "The model call failed.") };
        }
        case "error":
          return { kind: "failed", code: String(event.code ?? "server_error"), status: null, message: String(event.message ?? "The model call failed.") };
        default:
          break;
      }
    }
    if (o.signal.aborted) return { kind: "aborted", responseId };
    return { kind: "failed", code: "stream_cut_off", status: null, message: "The model's reply was cut off." };
  } catch (err) {
    if (o.signal.aborted || err instanceof OpenAI.APIUserAbortError) return { kind: "aborted", responseId };
    if (err instanceof OpenAI.APIError) {
      const detail = (err.error ?? {}) as { code?: unknown; message?: unknown };
      return {
        kind: "failed",
        code: String(detail.code ?? err.code ?? "api_error"),
        status: err.status ?? null,
        message: String(detail.message ?? err.message),
      };
    }
    return { kind: "failed", code: "unreachable", status: null, message: err instanceof Error ? err.message : "The model call failed." };
  }
}

const WEB_ADDRESS = /https?:\/\/[^\s<>()[\],]+/g;

/** What an instruction asks for when a run's text should say what it used. See takeSourcesLine. */
export const SOURCES_LINE_RULE = "End with one last line that starts with \"Sources:\" and lists the web addresses you used, separated by spaces.";

/**
 * Pulls the "Sources:" line off the end of an answer. On muse-wonder-1.0 url_citation annotations came back empty in
 * every live run so far (Oct 31), and search results don't say which pages the model used, so the text has to.
 * Only pages this run really saw count: a made-up address is dropped with the rest of the line.
 */
export function takeSourcesLine(text: string, book: SourceBook): { text: string; ids: string[] } {
  const lines = text.trimEnd().split("\n");
  for (let at = lines.length - 1; at >= 0; at--) {
    const line = lines[at];
    if (/^[\s>*_#-]*sources?[*_]*\s*:/i.test(line)) {
      const urls = lines.slice(at).join(" ").match(WEB_ADDRESS) ?? [];
      // "Sources: officials said it would reopen" is a sentence, not this line.
      if (!urls.length && line.length > 60) break;
      const ids = urls.map((u) => (book.known(u) ? book.idOf(u) : null)).filter((id): id is string => !!id);
      return { text: lines.slice(0, at).join("\n").trimEnd(), ids: [...new Set(ids)] };
    }
    // Anything below the line but more addresses means this answer doesn't end in one.
    if (line.trim() && !line.match(WEB_ADDRESS)) break;
  }
  return { text, ids: [] };
}

function open(o: TurnOptions) {
  return o.client.responses
    .create({ ...o.body, stream: true } as never, { signal: o.signal, headers: { [RUN_HEADER]: o.runId } })
    .withResponse()
    .then(({ data, response }) => ({ stream: data as unknown as AsyncIterable<Json>, response }));
}
