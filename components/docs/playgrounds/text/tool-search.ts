import { itemsOf, type OutputItem } from "@/components/docs/playgrounds/text/items";
import {
  CLIENT_SEARCH_TOOL,
  functionTool,
  hostedTools,
  runLibraryCall,
  searchLibrary,
  type LibraryNamespace,
  type SearchHit,
} from "@/components/docs/playgrounds/text/tool-library";

/**
 * The tool search loop as plain data (tool-search page), so Step and Run all share one sequence:
 *
 * - Hosted: the request carries the namespaces with their functions deferred plus `{"type": "tool_search"}`. The API
 *   searches and loads in the same response (tool_search_call, tool_search_output), the model calls a function,
 *   the page runs it, and the result goes back with previous_response_id, as in ordinary tool calling.
 * - Client-executed: the request carries only a `tool_search` tool with `execution: "client"`. The model emits a
 *   tool_search_call and stops; the page searches its own library and returns a tool_search_output with the same
 *   call_id. That turn is replayed statelessly, as the page's example does, but with the user's message first: the
 *   page's example replays only `first.output`, and without the question the model asks what it was asked (we
 *   checked). Function results then go back with previous_response_id.
 */

type Json = Record<string, unknown>;

export type SearchMode = "hosted" | "client";

export interface TsBase {
  model: string;
  prompt: string;
  effort: string | null;
  namespaces: readonly LibraryNamespace[];
  /** Hosted only: leave the namespace functions marked alwaysLoaded callable up front. */
  keepLoaded: boolean;
}

export interface TsModelStep {
  kind: "model";
  /** Which model call this is, from 1. */
  n: number;
  body: Json;
  response: Json | null;
  items: OutputItem[];
  status?: number;
  model?: string | null;
  elapsedMs?: number;
  error: { code: string | null; message: string } | null;
  done: boolean;
}

export interface TsSearchStep {
  kind: "search";
  callId: string;
  goal: string;
  hits: SearchHit[];
  /** The tools the app loads, as sent in tool_search_output. */
  loaded: Json[];
}

export interface TsToolResult {
  callId: string;
  name: string;
  namespace: string | null;
  arguments: string;
  run: { ok: boolean; output: string; value: unknown; matched: string | null } | null;
}

export interface TsToolsStep {
  kind: "tools";
  results: TsToolResult[];
}

export type TsStep = TsModelStep | TsSearchStep | TsToolsStep;

export type TsAction = "model" | "search" | "tools" | "done" | "limit" | "busy";

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** A model step built from a whole reply. */
export function modelStepFrom(n: number, body: Json, response: unknown, extra: Partial<TsModelStep> = {}): TsModelStep {
  const r = obj(response);
  const err = obj(r?.error);
  return {
    kind: "model",
    n,
    body,
    response: r,
    items: itemsOf(r),
    error: err && typeof err.message === "string" ? { code: str(err.code) ?? null, message: err.message } : null,
    done: true,
    ...extra,
  };
}

/** The tool_search_call items of a step that the app must answer (client-executed ones). */
export function clientSearches(step: TsModelStep): OutputItem[] {
  return step.items.filter((x) => x.type === "tool_search_call" && str(x.raw.execution) === "client");
}

/** The function calls of a step, in order. */
export function functionCalls(step: TsModelStep): OutputItem[] {
  return step.items.filter((x) => x.type === "function_call" && str(x.raw.name));
}

/**
 * The goal a client tool_search_call asks for. The page's schema gives `{"goal": ...}`; the model was also seen
 * wrapping it as `{"arguments": "{\"goal\": ...}"}`, so that is unwrapped too.
 */
export function goalOf(item: OutputItem): string {
  const args = item.raw.arguments;
  const parsed = typeof args === "string" ? safeJson(args) : args;
  const o = obj(parsed);
  if (typeof o?.goal === "string") return o.goal;
  if (typeof o?.arguments === "string") return goalOf({ ...item, raw: { ...item.raw, arguments: o.arguments } });
  if (obj(o?.arguments)) return goalOf({ ...item, raw: { ...item.raw, arguments: o!.arguments } });
  return typeof args === "string" ? args : JSON.stringify(args ?? "");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function lastModel(steps: readonly TsStep[]): TsModelStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === "model") return s;
  }
  return null;
}

export function modelCalls(steps: readonly TsStep[]): number {
  return steps.filter((s) => s.kind === "model").length;
}

/** What the loop does next. */
export function nextTsAction(steps: readonly TsStep[], maxCalls: number): TsAction {
  const last = steps[steps.length - 1];
  if (!last) return "model";
  if (last.kind === "model") {
    if (!last.done) return "busy";
    if (last.error || (last.status !== undefined && last.status >= 400)) return "done";
    if (clientSearches(last).length) return "search";
    if (functionCalls(last).length) return "tools";
    return "done";
  }
  if (last.kind === "tools" && last.results.some((r) => !r.run)) return "busy";
  return modelCalls(steps) >= maxCalls ? "limit" : "model";
}

/** Runs the app's side of a client search: the library search and the tool_search_output it sends. */
export function searchStepFor(item: OutputItem, namespaces: readonly LibraryNamespace[], limit = 3): TsSearchStep {
  const goal = goalOf(item);
  const hits = searchLibrary(goal, namespaces, limit);
  return { kind: "search", callId: str(item.raw.call_id) ?? "", goal, hits, loaded: hits.map((h) => functionTool(h.fn, true)) };
}

export function toolSearchOutput(step: TsSearchStep): Json {
  return { type: "tool_search_output", execution: "client", call_id: step.callId, status: "completed", tools: step.loaded };
}

/** Runs each function call of a model step against the library. */
export function toolsStepFor(model: TsModelStep): TsToolsStep {
  return {
    kind: "tools",
    results: functionCalls(model).map((c) => {
      const name = str(c.raw.name) ?? "";
      const namespace = str(c.raw.namespace) ?? null;
      const args = str(c.raw.arguments) ?? "";
      return { callId: str(c.raw.call_id) ?? "", name, namespace, arguments: args, run: runLibraryCall(name, namespace, args) };
    }),
  };
}

function reasoningOf(effort: string | null): Json {
  return effort ? { reasoning: { effort } } : {};
}

/** The first request: the whole deferred library (hosted) or only the client tool_search tool. */
export function firstTsBody(mode: SearchMode, base: TsBase): Json {
  return {
    model: base.model,
    input: base.prompt,
    tools: mode === "hosted" ? hostedTools(base.namespaces, base.keepLoaded) : [CLIENT_SEARCH_TOOL],
    parallel_tool_calls: false,
    ...reasoningOf(base.effort),
  };
}

/** Every item so far, for a stateless replay: the user's message, each reply's output, and what the app sent back. */
export function replayInput(prompt: string, steps: readonly TsStep[]): Json[] {
  const input: Json[] = [{ role: "user", content: prompt }];
  for (const s of steps) {
    if (s.kind === "model") input.push(...(s.response && Array.isArray(s.response.output) ? (s.response.output as Json[]) : []));
    else if (s.kind === "search") input.push(toolSearchOutput(s));
    else for (const r of s.results) input.push({ type: "function_call_output", call_id: r.callId, output: r.run?.output ?? "" });
  }
  return input;
}

/** The body of the next model call, given what has happened. */
export function nextTsBody(mode: SearchMode, base: TsBase, steps: readonly TsStep[]): Json {
  const last = steps[steps.length - 1];
  if (!last) return firstTsBody(mode, base);
  if (last.kind === "search") {
    // The page's second request: everything so far, the loaded tools in a tool_search_output, and no tools array.
    return { model: base.model, input: replayInput(base.prompt, steps), ...reasoningOf(base.effort) };
  }
  if (last.kind === "tools") {
    const prev = lastModel(steps);
    const id = str(prev?.response?.id);
    const outputs = last.results.map((r) => ({ type: "function_call_output", call_id: r.callId, output: r.run?.output ?? "" }));
    if (!id) return { model: base.model, input: [...replayInput(base.prompt, steps.slice(0, -1)), ...outputs], ...reasoningOf(base.effort) };
    return {
      model: base.model,
      previous_response_id: id,
      input: outputs,
      // Tools don't carry over with previous_response_id, so hosted mode sends the deferred library again.
      ...(mode === "hosted" ? { tools: hostedTools(base.namespaces, base.keepLoaded), parallel_tool_calls: false } : {}),
      ...reasoningOf(base.effort),
    };
  }
  return firstTsBody(mode, base);
}

/** The final answer: the last model step's answer text. */
export function tsFinalAnswer(steps: readonly TsStep[]): string {
  const m = lastModel(steps);
  if (!m) return "";
  return m.items
    .filter((x) => x.type === "message" && x.phase !== "commentary")
    .map((x) => x.text)
    .join("\n\n")
    .trim();
}

export interface LoadedGroup {
  /** The namespace, or null for a plain function. */
  namespace: string | null;
  functions: string[];
}

/** What a tool_search_output loaded, grouped by namespace. */
export function loadedGroups(item: OutputItem): LoadedGroup[] {
  const tools = Array.isArray(item.raw.tools) ? (item.raw.tools as unknown[]) : [];
  const groups: LoadedGroup[] = [];
  for (const t of tools) {
    const o = obj(t);
    if (!o) continue;
    if (o.type === "namespace") {
      const inner = Array.isArray(o.tools) ? (o.tools as unknown[]).map((x) => str(obj(x)?.name)).filter((x): x is string => !!x) : [];
      groups.push({ namespace: str(o.name) ?? null, functions: inner });
    } else if (str(o.name)) {
      groups.push({ namespace: null, functions: [o.name as string] });
    }
  }
  return groups;
}

/** The paths (hosted) or goal (client) a tool_search_call searched, for display. */
export function searchedFor(item: OutputItem): { paths: string[]; goal: string | null } {
  const args = obj(typeof item.raw.arguments === "string" ? safeJson(item.raw.arguments) : item.raw.arguments);
  const paths = Array.isArray(args?.paths) ? (args.paths as unknown[]).filter((p): p is string => typeof p === "string") : [];
  return { paths, goal: paths.length ? null : goalOf(item) };
}

/** Tokens saved up front by deferring, from two counts. Negative when deferral costs more (a small library). */
export function savings(deferred: number, loaded: number): { tokens: number; share: number } {
  const tokens = loaded - deferred;
  return { tokens, share: loaded > 0 ? tokens / loaded : 0 };
}

/**
 * The request as recorded for "Copy prompt for your coding agent": the library's 37 schemas would crowd out the rest
 * of the prompt, so the namespaces are summed up in one line; tool_search and every other field stay as sent.
 */
export function recordBody(body: Json): Json {
  if (!Array.isArray(body.tools)) return body;
  const all = body.tools as unknown[];
  const spaces = all.map((t) => obj(t)).filter((t): t is Json => !!t && t.type === "namespace" && Array.isArray(t.tools));
  if (!spaces.length) return body;
  const fns = spaces.flatMap((ns) => (ns.tools as unknown[]).map((f) => obj(f)).filter((f): f is Json => !!f));
  const deferred = fns.filter((f) => f.defer_loading === true).length;
  const summary = `${spaces.length} namespaces (${spaces.map((ns) => String(ns.name)).join(", ")}) with ${fns.length} functions, ${deferred} of them defer_loading: true`;
  return { ...body, tools: [summary, ...all.filter((t) => obj(t)?.type !== "namespace")] };
}
