import type { ClientSpec } from "@/components/docs/playgrounds/open-weights/deploy";
import { fitEffort, type Effort } from "@/lib/docs/client/models";

/**
 * The requests the live stand-ins send (StandIn.tsx): an open-weight server's Chat Completions body, re-aimed at
 * hosted Muse Spark through the docs proxy. Fields only a self-hosted server takes (chat_template_kwargs, Unsloth's
 * min_p and enable_tools) are mapped or dropped, and the caller shows which. Pure, so tests can pin the exact bodies
 * the demos send and the curl checks can replay them.
 */

export type ChatMessageJson = Record<string, unknown>;

export interface StandInRequest {
  messages: ChatMessageJson[];
  /** Replaces the last user message's text when set (the stand-in's prompt box). */
  prompt?: string;
  tools?: unknown[];
  parallelToolCalls?: boolean;
  extra?: Record<string, unknown>;
}

export function standInBody(p: StandInRequest, model: string, effort: Effort | null, maxTokens: number, stream: boolean): Record<string, unknown> {
  let messages = p.messages;
  if (p.prompt !== undefined) {
    const last = [...messages].reverse().findIndex((m) => m.role === "user");
    const at = last < 0 ? -1 : messages.length - 1 - last;
    messages = at < 0 ? [...messages, { role: "user", content: p.prompt }] : messages.map((m, i) => (i === at ? { role: "user", content: p.prompt } : m));
  }
  const fitted = fitEffort(model, effort);
  return {
    model,
    messages,
    ...(fitted ? { reasoning_effort: fitted } : {}),
    max_tokens: maxTokens,
    ...(p.tools?.length ? { tools: p.tools, tool_choice: "auto" } : {}),
    ...(p.tools?.length && p.parallelToolCalls === false ? { parallel_tool_calls: false } : {}),
    ...(p.extra ?? {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

/** A sensible output budget for the level: reasoning comes out of the same max_tokens as the answer. */
export function budgetFor(effort: Effort | null): number {
  return effort === "high" || effort === "xhigh" ? 4000 : effort === "medium" ? 2500 : 1500;
}

/** A deploy client's request as hosted Muse Spark takes it: Muse-specific template fields mapped or dropped, and why. */
export function hostedFromClient(c: ClientSpec): { extra: Record<string, unknown>; effort: Effort | null; dropped: string[] } {
  const extra: Record<string, unknown> = {};
  const dropped: string[] = [];
  let effort: Effort | null = "low";
  for (const [k, v] of Object.entries(c.extra)) {
    if (k === "reasoning_effort" && typeof v === "string") effort = v as Effort;
    else if (k === "chat_template_kwargs" && v && typeof v === "object") {
      const kw = v as Record<string, unknown>;
      const level = kw.reasoning_effort ?? kw.reasoning_strength;
      if (typeof level === "string") effort = level as Effort;
      dropped.push("chat_template_kwargs (mapped to reasoning_effort)");
    } else if (k === "temperature" || k === "top_p" || k === "response_format") extra[k] = v;
    else dropped.push(`${k} (${k === "min_p" || k === "enable_tools" ? "an Unsloth extension" : "a server extension"})`);
  }
  return { extra, effort, dropped };
}
