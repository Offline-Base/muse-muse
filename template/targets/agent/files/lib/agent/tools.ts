import { gatewayEnv } from "@/lib/meta/client";

/**
 * The tool gateway's client, {GATEWAY_URL}/tools (docs/AGENT_TOOLS.md in the platform). Server only. runAgent is the
 * usual way in. The routes in app/api/musemuse use the connection calls.
 */

/** Keep in step with lib/tools/catalog.source.ts and the enum in musemuse.schema.json. A test checks all three. */
export const AGENT_TOOL_IDS = [
  "web_search",
  "scholar",
  "places",
  "events",
  "read_page",
  "gmail_read",
  "gmail_draft",
  "gmail_send",
  "calendar_read",
  "calendar_add",
  "slack_read",
  "slack_search",
  "slack_send",
] as const;
export type AgentToolId = (typeof AGENT_TOOL_IDS)[number];

export interface ToolFunction {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
  defer_loading?: boolean;
}

export interface ToolNamespace {
  type: "namespace";
  name: string;
  description?: string;
  tools: ToolFunction[];
}

export interface ToolConnection {
  toolkit: string;
  label: string;
  connected: boolean;
  canConnect: boolean;
}

export interface ToolEntry {
  id: string;
  label: string;
  stepTitle: string;
  tier: "public" | "personal";
  access: "read" | "create" | "update";
  builtin?: boolean;
  /** Left out when this person can't use the tool, so the model can't try it. */
  functions?: ToolFunction[];
  /** The name of its group in `namespaces`, when the tools are grouped. */
  namespace?: string;
  connection?: ToolConnection;
  confirm?: boolean;
}

export interface ToolList {
  simulated: boolean;
  principal: string;
  toolSearch: boolean;
  /** Ready for Meta's tools array. Only with toolSearch. */
  namespaces?: ToolNamespace[];
  tools: ToolEntry[];
}

export interface ToolSourceItem {
  url?: unknown;
  title?: unknown;
  snippet?: unknown;
  date?: unknown;
}

export type ExecuteReply =
  | { ok: true; output: unknown; sources?: ToolSourceItem[]; costUsd?: number; simulated?: boolean; truncated?: boolean }
  /** `stale` means the approval sent didn't fit or was already used. Nothing ran, and this is a new one to ask about. */
  | { ok: false; code: "needs_confirmation"; approval: { id: string; title: string; lines?: string[] }; stale?: boolean }
  | { ok: false; code: "needs_connection"; toolkit: string; label: string; canConnect: boolean };

/** A refusal from the tool routes, in the gateway's usual error shape. `code` is one of TOOL_ERRORS. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

interface CallOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function gatewayBase(): { base: string; apiKey: string } {
  const { baseURL, apiKey } = gatewayEnv();
  return { base: baseURL.replace(/\/v1\/?$/, ""), apiKey };
}

async function gatewayCall<T>(method: "GET" | "POST", path: string, body: unknown, opts: CallOptions): Promise<T> {
  const { base, apiKey } = gatewayBase();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...opts.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
  if (!res.ok || !json) {
    throw new ToolError(json?.error?.message ?? `The tool gateway answered HTTP ${res.status}.`, json?.error?.code ?? "tool_failed", res.status);
  }
  return json;
}

/** The tools this product may use, as function definitions for Meta. With `namespaced`, too many of them come grouped for tool search. */
export function listTools(ids: readonly string[], format: "functions" | "namespaced", opts: CallOptions = {}): Promise<ToolList> {
  const query = new URLSearchParams({ ids: ids.join(","), format });
  return gatewayCall("GET", `/tools?${query}`, undefined, opts);
}

/** Runs one tool. needs_confirmation and needs_connection come back as replies, not errors. */
export function executeTool(name: string, args: unknown, opts: CallOptions & { approval?: string; userInput?: string } = {}): Promise<ExecuteReply> {
  return gatewayCall(
    "POST",
    "/tools/execute",
    { name, arguments: args, ...(opts.approval ? { approval: opts.approval } : {}), ...(opts.userInput ? { userInput: opts.userInput } : {}) },
    opts,
  );
}

export function toolConnections(opts: CallOptions = {}): Promise<Record<string, unknown>> {
  return gatewayCall("GET", "/tools/connections", undefined, opts);
}

export function connectTool(toolkit: string, returnTo: string, opts: CallOptions = {}): Promise<Record<string, unknown>> {
  return gatewayCall("POST", "/tools/connect", { toolkit, returnTo }, opts);
}

export function disconnectTool(toolkit: string, opts: CallOptions = {}): Promise<Record<string, unknown>> {
  return gatewayCall("POST", "/tools/disconnect", { toolkit }, opts);
}

/** Trades the one-time owner code in the platform's link for a 12-hour owner session. */
export function exchangeOwnerCode(code: string, opts: CallOptions = {}): Promise<Record<string, unknown>> {
  return gatewayCall("POST", "/identity/owner", { code }, opts);
}
