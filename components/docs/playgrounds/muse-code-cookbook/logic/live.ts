import { responsesBody, type ToolDef } from "@/lib/docs/client/body";
import { parseJsonText } from "@/lib/docs/client/json";
import { DEFAULT_TEXT_MODEL, fitEffort, type Effort } from "@/lib/docs/client/models";
import type { DocsResult } from "@/lib/docs/client/api";
import { collectReply, type Collected, type ToolCall } from "@/lib/docs/client/stream";

/**
 * Request bodies and reply readers the Muse Code recipe demos share. Every live call is a Responses request through
 * the docs proxy: strict JSON (text.format json_schema, strict: true) when the demo renders the answer as data, and a
 * small tool loop (a function tool, then function_call_output with previous_response_id) when the demo plays the
 * harness around the model. Bodies start on Muse Spark 1.3 Contributor with low reasoning effort, and leave room for
 * reasoning tokens in max_output_tokens.
 */

export type Json = Record<string, unknown>;

export interface StrictJsonRequest {
  model?: string;
  instructions: string;
  input: string | Json[];
  name: string;
  schema: Json;
  maxOutputTokens?: number;
  effort?: Effort | null;
  previousResponseId?: string | null;
}

/** A Responses body whose answer must match the schema exactly. */
export function strictJsonBody(r: StrictJsonRequest): Json {
  const model = r.model ?? DEFAULT_TEXT_MODEL;
  const body = responsesBody({
    model,
    system: r.instructions,
    messages: [{ role: "user", content: typeof r.input === "string" ? r.input : "" }],
    effort: fitEffort(model, r.effort === undefined ? "low" : r.effort),
    maxOutputTokens: r.maxOutputTokens ?? 1200,
    schema: { name: r.name, schema: r.schema, strict: true },
    previousResponseId: r.previousResponseId ?? null,
  });
  if (typeof r.input !== "string") body.input = r.input;
  return body;
}

export type Parsed<T> = { ok: true; value: T; reply: Collected } | { ok: false; message: string; reply: Collected | null };

/** The reply's text parsed as JSON. A reply cut off by max_output_tokens says so instead of failing to parse. */
export function parseStrictReply<T = unknown>(json: unknown): Parsed<T> {
  if (!json || typeof json !== "object") return { ok: false, message: "No reply body.", reply: null };
  const reply = collectReply("responses", json);
  if (reply.error) return { ok: false, message: reply.error.message, reply };
  if (reply.finishReason === "max_output_tokens") return { ok: false, message: "The reply ran out of output tokens before the JSON was complete. Try again, or ask for less.", reply };
  if (reply.refusal) return { ok: false, message: `The model declined: ${reply.refusal}`, reply };
  const text = reply.text.trim();
  if (!text) return { ok: false, message: "The reply had no text.", reply };
  const parsed = parseJsonText(text);
  if (!parsed.ok) return { ok: false, message: `The reply isn't valid JSON: ${parsed.message}`, reply };
  return { ok: true, value: parsed.value as T, reply };
}

export interface ToolLoopRequest {
  model?: string;
  instructions: string;
  input: string;
  tools: ToolDef[];
  maxOutputTokens?: number;
  effort?: Effort | null;
}

/** The first call of a tool loop: the user's turn and the function tools the harness offers. */
export function toolLoopFirstBody(r: ToolLoopRequest): Json {
  const model = r.model ?? DEFAULT_TEXT_MODEL;
  return responsesBody({
    model,
    system: r.instructions,
    messages: [{ role: "user", content: r.input }],
    tools: r.tools,
    parallelToolCalls: false,
    effort: fitEffort(model, r.effort === undefined ? "low" : r.effort),
    maxOutputTokens: r.maxOutputTokens ?? 1200,
  });
}

/**
 * The next call: the tool results as function_call_output items, continuing the stored response. Instructions and
 * tools don't carry over with previous_response_id, so they're sent again.
 */
export function toolLoopNextBody(r: ToolLoopRequest, previousResponseId: string, outputs: ReadonlyArray<{ callId: string; output: string }>): Json {
  const body = toolLoopFirstBody(r);
  body.previous_response_id = previousResponseId;
  body.input = outputs.map((o) => ({ type: "function_call_output", call_id: o.callId, output: o.output }));
  return body;
}

/**
 * Why a tool-loop reply can't stand as the agent's answer: it stopped at the output-token limit (Responses status
 * incomplete, reason max_output_tokens), stopped early for another reason, or failed. Null for a finished reply.
 */
export function unfinishedReply(reply: Collected): string | null {
  if (reply.error) return `The reply failed: ${reply.error.message}`;
  if (reply.finishReason === "max_output_tokens") return "The reply ran out of output tokens before it finished, so this isn't the agent's report. Run again.";
  if (reply.status === "incomplete") return `The reply stopped before it finished (${reply.finishReason ?? "incomplete"}), so this isn't the agent's report. Run again.`;
  return null;
}

/** The function calls a reply asks for, with their arguments parsed (null when they aren't valid JSON). */
export function functionCalls(reply: Collected | null): Array<ToolCall & { args: Json | null }> {
  return (reply?.toolCalls ?? [])
    .filter((t) => t.name && t.kind === "function")
    .map((t) => {
      const parsed = parseJsonText(t.arguments || "{}");
      const args = parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? (parsed.value as Json) : null;
      return { ...t, args };
    });
}

/** The bash tool the harness demos offer the model. */
export const BASH_TOOL: ToolDef = {
  name: "bash",
  description: "Run one bash command in the project workspace and get back its stdout, stderr and exit code.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "The exact command to run." } },
    required: ["command"],
    additionalProperties: false,
  },
  strict: true,
};

/** Muse Code's mediated write tool, as the guardrail demo offers it. */
export const EDIT_FILE_TOOL: ToolDef = {
  name: "edit_file",
  description: "Make a precise edit to a file in the workspace: replace old_text with new_text. An empty old_text appends new_text at the end of the file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file's path, relative to the workspace root." },
      old_text: { type: "string", description: "The exact text to replace, or empty to append." },
      new_text: { type: "string", description: "The text to put in its place." },
    },
    required: ["path", "old_text", "new_text"],
    additionalProperties: false,
  },
  strict: true,
};

/** A short, safe rendering of model text for one line of UI (no newlines, capped). */
export function oneLine(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

const MISSING_PREVIOUS = /referenced response not found/i;

/** The pauses before each retry of a chained turn Meta can't find yet. */
export const CHAIN_RETRY_PAUSES_MS: readonly number[] = [1500, 3000, 5000];

export interface ChainRetryOptions {
  /** How long to wait before each retry. */
  pausesMs?: readonly number[];
  /** Called before each pause, so a demo can say it is retrying instead of showing the error. */
  onRetry?: (retry: number, waitMs: number) => void;
}

/** True for Meta's answer to a previous_response_id it can't find (yet). */
export function isMissingPrevious(result: DocsResult<unknown>): boolean {
  return !result.ok && result.status === 400 && MISSING_PREVIOUS.test(result.error?.message ?? "");
}

/**
 * Meta sometimes answers a fresh previous_response_id with 400 "referenced response not found or expired" for a
 * moment after the response it names finished streaming (seen for up to several seconds). A chained turn (a
 * follow-up, a side-chat branch, a tool result) is retried after 1.5 s, 3 s and 5 s; anything else comes back as it was.
 */
export async function withChainRetry<R extends DocsResult<unknown>>(attempt: () => Promise<R>, body: unknown, options: ChainRetryOptions = {}): Promise<R> {
  const pauses = options.pausesMs ?? CHAIN_RETRY_PAUSES_MS;
  const chained = !!body && typeof body === "object" && typeof (body as { previous_response_id?: unknown }).previous_response_id === "string";
  let result = await attempt();
  for (let i = 0; chained && i < pauses.length && isMissingPrevious(result); i++) {
    options.onRetry?.(i + 1, pauses[i]);
    await new Promise((resolve) => setTimeout(resolve, pauses[i]));
    result = await attempt();
  }
  return result;
}
