import { chatBodyWith, responsesBody, type NeutralRequest } from "@/lib/docs/client/body";
import type { Collected, ToolCall } from "@/lib/docs/client/stream";
import type { ToolRun } from "@/lib/docs/client/tools";

/**
 * The tool-calling loop as plain data, so the playground's Step and Run all share one sequence (tool-calling page):
 * call the model; if it asks for tools, run each one locally; send the results back; repeat until it answers.
 *
 * - Responses: the next call continues with `previous_response_id` and one `function_call_output` per call.
 * - Chat Completions: the next call resends the history with the assistant's `tool_calls` message and one `tool`
 *   message per call, as the API requires.
 */

export type LoopProtocol = "responses" | "chat";

export interface ModelStep {
  kind: "model";
  /** Which model call this is, from 1. */
  call: number;
  body: Record<string, unknown>;
  /** What came back, or null while the call runs. */
  collected: Collected | null;
  status?: number;
  model?: string | null;
  elapsedMs?: number;
}

export interface ToolResult {
  call: ToolCall;
  /** The local run, or null while it runs. */
  run: ToolRun | null;
}

export interface ToolsStep {
  kind: "tools";
  results: ToolResult[];
}

export type LoopStep = ModelStep | ToolsStep;

export type NextAction = "model" | "tools" | "done" | "limit" | "busy";

/** The calls a model step asked for: named, with arguments complete. */
export function requestedCalls(step: ModelStep): ToolCall[] {
  return (step.collected?.toolCalls ?? []).filter((t) => t.name);
}

/** What the loop does next, given what it has done and the most model calls it may make. */
export function nextAction(steps: readonly LoopStep[], maxCalls: number): NextAction {
  const last = steps[steps.length - 1];
  if (!last) return "model";
  if (last.kind === "model") {
    // A reply still streaming isn't an answer yet, even if it already names a tool.
    if (!last.collected || !last.collected.done) return "busy";
    if (last.collected.error || (last.status !== undefined && last.status >= 400)) return "done";
    return requestedCalls(last).length ? "tools" : "done";
  }
  if (last.results.some((r) => !r.run)) return "busy";
  const calls = steps.filter((s) => s.kind === "model").length;
  return calls >= maxCalls ? "limit" : "model";
}

/** The model's final answer, once the loop is done. */
export function finalAnswer(steps: readonly LoopStep[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === "model" && s.collected) return s.collected.text;
  }
  return "";
}

function lastModel(steps: readonly LoopStep[]): ModelStep | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === "model") return s;
  }
  return null;
}

/** The body of the next model call. `base` holds the model, instructions, tools and the user's question. */
export function nextModelBody(protocol: LoopProtocol, base: NeutralRequest, steps: readonly LoopStep[]): Record<string, unknown> {
  if (protocol === "responses") {
    const last = steps[steps.length - 1];
    const prev = lastModel(steps);
    if (!last || last.kind !== "tools" || !prev?.collected?.id) return responsesBody(base);
    const body = responsesBody({ ...base, previousResponseId: prev.collected.id });
    // Instructions and tools don't carry over with previous_response_id (protocols/responses), so they're resent.
    body.input = last.results.map((r) => ({
      type: r.call.kind === "custom" ? "custom_tool_call_output" : "function_call_output",
      call_id: r.call.callId,
      output: r.run?.output ?? "",
    }));
    return body;
  }

  const system = (base.system ?? "").trim();
  const messages: Record<string, unknown>[] = [
    ...(system ? [{ role: "developer", content: system }] : []),
    ...base.messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== "model" || !s.collected) continue;
    const calls = requestedCalls(s);
    const results = steps[i + 1]?.kind === "tools" ? (steps[i + 1] as ToolsStep).results : null;
    if (!calls.length || !results) continue;
    // The whole assistant message, tool_calls included, must precede its tool results or the API returns 400.
    messages.push({
      role: "assistant",
      content: s.collected.text || "",
      tool_calls: calls.map((t) => ({ id: t.callId, type: "function", function: { name: t.name, arguments: t.arguments } })),
    });
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.call.callId, content: r.run?.output ?? "" });
  }
  return chatBodyWith(base, messages);
}
