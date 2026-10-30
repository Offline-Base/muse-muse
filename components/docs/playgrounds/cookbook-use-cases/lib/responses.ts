import { estimateCost } from "@/lib/docs/client/cost";

/**
 * Small readers for whole Responses API objects (the JSON a non-streamed POST /v1/responses returns), shared by the
 * recipe demos: the function calls the model asked for, its visible text (Muse Spark sends a short "commentary"
 * message before a tool call, marked phase: "commentary"), web searches, and an estimated cost from its usage.
 */

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export interface FnCall {
  /** The output item id (fc_...). */
  id: string;
  /** What function_call_output answers with. */
  callId: string;
  name: string;
  /** Arguments as the JSON text the model wrote. */
  arguments: string;
}

/** The output items of a response. */
export function outputItems(resp: unknown): Json[] {
  return arr(obj(resp)?.output)
    .map(obj)
    .filter((x): x is Json => !!x);
}

/** Every function_call in the response, in order. */
export function functionCalls(resp: unknown): FnCall[] {
  return outputItems(resp)
    .filter((it) => it.type === "function_call")
    .map((it, i) => ({
      id: String(it.id ?? `fc_${i}`),
      callId: String(it.call_id ?? it.id ?? `call_${i}`),
      name: String(it.name ?? ""),
      arguments: typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? {}),
    }));
}

function messageTexts(resp: unknown, phase: "commentary" | "final" | "any"): string[] {
  const out: string[] = [];
  for (const it of outputItems(resp)) {
    if (it.type !== "message") continue;
    const isCommentary = it.phase === "commentary";
    if (phase === "commentary" && !isCommentary) continue;
    if (phase === "final" && isCommentary) continue;
    let text = "";
    for (const part of arr(it.content)) {
      const p = obj(part);
      if (p?.type === "output_text" && typeof p.text === "string") text += p.text;
    }
    if (text.trim()) out.push(text.trim());
  }
  return out;
}

/** The visible text of a response: its final message(s), or its commentary when that's all it has. */
export function responseText(resp: unknown): string {
  const finals = messageTexts(resp, "final");
  return (finals.length ? finals : messageTexts(resp, "any")).join("\n\n");
}

/** The short note Muse Spark writes before a tool call ("I'll fill out the form..."). */
export function commentaryText(resp: unknown): string {
  return messageTexts(resp, "commentary").join("\n\n");
}

/** How many web searches the response ran (billed per query). */
export function webSearchCount(resp: unknown): number {
  return outputItems(resp).filter((it) => it.type === "web_search_call").length;
}

/** The response's status, and why it stopped early when it did ("max_output_tokens"). */
export function responseStatus(resp: unknown): { status: string; reason: string | null } {
  const r = obj(resp);
  return { status: String(r?.status ?? "unknown"), reason: (obj(r?.incomplete_details)?.reason as string | undefined) ?? null };
}

/** Estimated USD for one reply, 0 when it has no usage or no price. */
export function replyUsd(model: string | null | undefined, resp: unknown): number {
  const r = obj(resp);
  if (!r) return 0;
  const est = estimateCost(model ?? (r.model as string | undefined), r.usage, { webSearches: webSearchCount(r) });
  return est?.usd ?? 0;
}

/** Parses tool-call arguments, returning {} for empty or broken JSON (the error says why). */
export function parseArguments(text: string): { value: Json; error: string | null } {
  if (!text.trim()) return { value: {}, error: null };
  try {
    const v = JSON.parse(text) as unknown;
    return obj(v) ? { value: v as Json, error: null } : { value: {}, error: "The arguments aren't a JSON object." };
  } catch (err) {
    return { value: {}, error: `The arguments aren't valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}
