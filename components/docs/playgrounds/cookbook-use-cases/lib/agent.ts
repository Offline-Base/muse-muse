import type { DocsError } from "@/lib/docs/client/api";
import type { Effort } from "@/lib/docs/client/models";
import { functionCalls, outputItems, responseText, type FnCall } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";

/**
 * The agent loop the recipes run (OpenCode, Hermes, the sandbox scaffold, metacua), as plain data and one async
 * function, so every demo in this group drives Muse Spark the same way on the Responses API: send instructions,
 * tools and input; run each function_call the reply asks for; send the results back; repeat until the model answers
 * in text or a guard fires. State is either server-managed (previous_response_id, the default) or a stateless replay
 * (store: false, the full history every turn, with encrypted reasoning so the model keeps its chain of thought).
 */

type Json = Record<string, unknown>;

export interface FnToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Json;
  strict?: boolean;
}

export interface AgentDef {
  /** The agent's id in the timeline ("triage", "pm", "bugfix"). */
  name: string;
  model: string;
  instructions: string;
  tools: FnToolDef[];
  /** Built-in tools sent as they are, such as { type: "web_search" }. */
  builtinTools?: Json[];
  effort?: Effort | null;
  maxOutputTokens?: number;
  /** Most model calls before the loop gives up. Default 8. */
  maxCalls?: number;
  parallelToolCalls?: boolean;
  /** text.format for structured output. */
  textFormat?: Json;
  /** "server" (previous_response_id) or "replay" (store: false). Default "server". */
  state?: "server" | "replay";
  /** tool_choice. Meta's API takes only "auto" (Oct 30, 2026): leave tools out for a text-only answer instead. */
  toolChoice?: "auto";
}

export interface ToolOutcome {
  /** What goes back in function_call_output: text, or content parts (input_text and input_image). */
  output: string | Json[];
  /** What the timeline shows instead of the raw output, when it differs. */
  display?: string;
  status?: "done" | "error" | "denied";
  /** A short badge for the timeline: "allowed by gh issue edit*", "simulated". */
  note?: string;
  /** Items to send after the tool outputs (a user message with a screenshot, say). */
  after?: Json[];
}

export interface ModelReply {
  ok: boolean;
  json: Json | null;
  error: DocsError | null;
  aborted: boolean;
}

export interface LoopRuntime {
  callModel(agent: AgentDef, body: Json, info: { depth: number; call: number }): Promise<ModelReply>;
  runTool(agent: AgentDef, call: FnCall, info: { depth: number }): Promise<ToolOutcome>;
  stopped(): boolean;
}

export interface LoopResult {
  text: string;
  stoppedBy: "answer" | "limit" | "error" | "stopped";
  response: Json | null;
  calls: number;
  error?: DocsError | null;
  /** Replay mode: the whole conversation so far, to continue it with another agent (LoopOptions.history). */
  history?: Json[];
}

export const DEFAULT_MAX_CALLS = 8;

/** The fields every call of an agent sends, before its input. */
export function agentBase(agent: AgentDef): Json {
  const tools = [
    ...agent.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.strict !== undefined ? { strict: t.strict } : {}),
    })),
    ...(agent.builtinTools ?? []),
  ];
  return {
    model: agent.model,
    ...(agent.instructions.trim() ? { instructions: agent.instructions.trim() } : {}),
    ...(tools.length ? { tools } : {}),
    ...(agent.toolChoice ? { tool_choice: agent.toolChoice } : {}),
    ...(agent.parallelToolCalls !== undefined && tools.length ? { parallel_tool_calls: agent.parallelToolCalls } : {}),
    ...(agent.effort ? { reasoning: { effort: agent.effort } } : {}),
    ...(agent.maxOutputTokens ? { max_output_tokens: agent.maxOutputTokens } : {}),
    ...(agent.textFormat ? { text: { format: agent.textFormat } } : {}),
  };
}

/** A string input as the one user message a stateless replay starts from. */
export function inputItems(input: string | Json[]): Json[] {
  return typeof input === "string" ? [{ role: "user", content: input }] : input;
}

/** The function_call_output items for a batch of calls and their outcomes, then anything they add after. */
export function outputsFor(calls: FnCall[], outcomes: ToolOutcome[]): Json[] {
  const items: Json[] = calls.map((c, i) => ({ type: "function_call_output", call_id: c.callId, output: outcomes[i]?.output ?? "" }));
  for (const o of outcomes) if (o?.after?.length) items.push(...o.after);
  return items;
}

/**
 * Output items as a stateless replay sends them back. A computer_call goes back exactly as it came: Meta answers a
 * replayed computer_call without its status with 400 "missing field `status`" (seen Oct 30, 2026), and the guide says
 * to copy each meta_safety_replay_receipt unchanged. The other items (reasoning with its encrypted content, messages,
 * function calls) replay without the per-item status, which is how the function-tool demos have always run; the API
 * takes them with it too (checked the same day), so this is a choice, not a requirement.
 */
export function replayItems(resp: unknown): Json[] {
  return outputItems(resp).map((item) => {
    if (item.type === "computer_call") return { ...item };
    const copy = { ...item };
    delete copy.status;
    return copy;
  });
}

export interface LoopOptions {
  /** Continue an earlier response chain (server state), as OpenCode does when it switches agents mid-session. */
  previousResponseId?: string | null;
  /** Continue an earlier conversation in replay mode: its items go before this input. */
  history?: Json[] | null;
}

/** Runs one agent to its answer. Tool calls in one reply run in order; the runtime decides what each one does. */
export async function runAgentLoop(agent: AgentDef, input: string | Json[], rt: LoopRuntime, depth = 0, opts: LoopOptions = {}): Promise<LoopResult> {
  const replay = agent.state === "replay";
  const history: Json[] = replay ? [...(opts.history ?? []), ...inputItems(input)] : [];
  let previousId: string | null = replay ? null : (opts.previousResponseId ?? null);
  let first = true;
  let pending: Json[] = [];
  const max = agent.maxCalls ?? DEFAULT_MAX_CALLS;
  let last: Json | null = null;

  for (let call = 1; call <= max; call++) {
    if (rt.stopped()) return { text: "", stoppedBy: "stopped", response: last, calls: call - 1, ...(replay ? { history } : {}) };
    const body: Json = { ...agentBase(agent) };
    if (replay) {
      body.store = false;
      body.include = ["reasoning.encrypted_content"];
      body.input = [...history];
    } else if (previousId) {
      body.previous_response_id = previousId;
      body.input = first ? input : pending;
    } else {
      body.input = input;
    }
    first = false;

    const reply = await rt.callModel(agent, body, { depth, call });
    if (!reply.ok || !reply.json) {
      return { text: "", stoppedBy: reply.aborted ? "stopped" : "error", response: last, calls: call, error: reply.error, ...(replay ? { history } : {}) };
    }
    last = reply.json;
    previousId = typeof reply.json.id === "string" ? reply.json.id : previousId;
    if (replay) history.push(...replayItems(reply.json));

    const calls = functionCalls(reply.json);
    if (!calls.length) return { text: responseText(reply.json), stoppedBy: "answer", response: reply.json, calls: call, ...(replay ? { history } : {}) };

    const outcomes: ToolOutcome[] = [];
    for (const c of calls) {
      if (rt.stopped()) return { text: "", stoppedBy: "stopped", response: last, calls: call, ...(replay ? { history } : {}) };
      outcomes.push(await rt.runTool(agent, c, { depth }));
    }
    const outputs = outputsFor(calls, outcomes);
    if (replay) history.push(...outputs);
    else pending = outputs;
  }
  return { text: last ? responseText(last) : "", stoppedBy: "limit", response: last, calls: max, ...(replay ? { history } : {}) };
}

/** A JSON Schema object with the given properties, all required unless listed as optional. */
export function objectSchema(properties: Record<string, Json>, optional: string[] = []): Json {
  return {
    type: "object",
    properties,
    required: Object.keys(properties).filter((k) => !optional.includes(k)),
    additionalProperties: false,
  };
}
