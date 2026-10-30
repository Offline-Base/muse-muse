import type { SseEvent } from "@/lib/docs/client/api";

/**
 * What the streaming-responses recipe watches in a Chat Completions stream, worked out from the chunks as they
 * arrived: when the first chunk and the first visible token came (reasoning happens before the first delta), the
 * guarded text (skip chunks with no choices or no delta.content), the chunk that carries finish_reason, the one that
 * carries usage (with stream_options.include_usage), and where the recipe's naive `text += delta.content` would crash.
 */

export interface TimedEvent {
  /** Milliseconds since the request was sent. */
  at: number;
  event: SseEvent;
}

export type ChunkKind = "content" | "empty" | "finish" | "usage" | "done" | "other";

export interface ChunkInfo {
  index: number;
  at: number;
  kind: ChunkKind;
  /** delta.content: a string, null when the key is there but empty of text, undefined when it's missing. */
  content: string | null | undefined;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
  /** How many choices the chunk had (0 on a usage-only chunk). */
  choices: number;
  role: string | null;
}

export interface NaiveRun {
  /** Where `text += chunk.choices[0].delta.content` stops, or null when it gets through. */
  crashIndex: number | null;
  /** The error Python would raise there. */
  error: string | null;
  /** What it had collected before the crash. */
  collected: string;
}

export interface StreamAnalysis {
  chunks: ChunkInfo[];
  firstChunkMs: number | null;
  firstTokenMs: number | null;
  lastTokenMs: number | null;
  endMs: number | null;
  contentChunks: number;
  /** The text with the recipe's guard: only chunks that have choices and a delta.content string. */
  text: string;
  finishReason: string | null;
  finishIndex: number | null;
  usage: Record<string, unknown> | null;
  usageIndex: number | null;
  sawDone: boolean;
  naive: NaiveRun;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

export function chunkInfo(index: number, e: TimedEvent): ChunkInfo {
  const base: ChunkInfo = { index, at: e.at, kind: "other", content: undefined, finishReason: null, usage: null, choices: 0, role: null };
  if (e.event.data.trim() === "[DONE]") return { ...base, kind: "done" };
  const json = e.event.json;
  if (!json) return base;
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const choice = obj(choices[0]);
  const delta = obj(choice?.delta);
  const usage = obj(json.usage);
  const content = delta && "content" in delta ? (typeof delta.content === "string" ? delta.content : null) : undefined;
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  const kind: ChunkKind = typeof content === "string" && content.length ? "content" : finishReason ? "finish" : usage ? "usage" : "empty";
  return {
    ...base,
    kind,
    content,
    finishReason,
    usage,
    choices: choices.length,
    role: typeof delta?.role === "string" ? delta.role : null,
  };
}

/** The recipe's first accumulation loop, which assumes every chunk has a choice with a content string. */
export function naiveAccumulate(chunks: readonly ChunkInfo[]): NaiveRun {
  let collected = "";
  for (const c of chunks) {
    // The SDK ends iteration at [DONE]; that marker is never a chunk.
    if (c.kind === "done") break;
    if (c.choices === 0) return { crashIndex: c.index, error: "IndexError: list index out of range", collected };
    if (typeof c.content !== "string") {
      return { crashIndex: c.index, error: 'TypeError: can only concatenate str (not "NoneType") to str', collected };
    }
    collected += c.content;
  }
  return { crashIndex: null, error: null, collected };
}

export function analyzeStream(events: readonly TimedEvent[]): StreamAnalysis {
  const chunks = events.map((e, i) => chunkInfo(i, e));
  let text = "";
  let firstTokenMs: number | null = null;
  let lastTokenMs: number | null = null;
  let contentChunks = 0;
  let finishReason: string | null = null;
  let finishIndex: number | null = null;
  let usage: Record<string, unknown> | null = null;
  let usageIndex: number | null = null;
  for (const c of chunks) {
    // The recipe's guard: skip any chunk whose choices is empty or whose delta.content is None.
    if (c.choices > 0 && typeof c.content === "string" && c.content) {
      text += c.content;
      contentChunks++;
      if (firstTokenMs === null) firstTokenMs = c.at;
      lastTokenMs = c.at;
    }
    if (c.finishReason && finishIndex === null) {
      finishReason = c.finishReason;
      finishIndex = c.index;
    }
    if (c.usage) {
      usage = c.usage;
      usageIndex = c.index;
    }
  }
  const sawDone = chunks.some((c) => c.kind === "done");
  return {
    chunks,
    firstChunkMs: chunks.length ? chunks[0].at : null,
    firstTokenMs,
    lastTokenMs,
    endMs: chunks.length ? chunks[chunks.length - 1].at : null,
    contentChunks,
    text,
    finishReason,
    finishIndex,
    usage,
    usageIndex,
    sawDone,
    naive: naiveAccumulate(chunks),
  };
}

/** Visible tokens a second once text started: output tokens less reasoning, over the time the text took. */
export function visibleTokensPerSecond(a: StreamAnalysis): number | null {
  const u = a.usage;
  if (!u || a.firstTokenMs === null || a.lastTokenMs === null) return null;
  const out = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
  const details = obj(u.completion_tokens_details);
  const reasoning = typeof details?.reasoning_tokens === "number" ? details.reasoning_tokens : 0;
  const visible = out - reasoning;
  const seconds = (a.lastTokenMs - a.firstTokenMs) / 1000;
  if (visible <= 1 || seconds <= 0.05) return null;
  return visible / seconds;
}

/** A chunk's delta as the inspector shows it: the content quoted, or what the chunk carries instead. */
export function chunkLabel(c: ChunkInfo): string {
  if (c.kind === "done") return "[DONE]";
  const parts: string[] = [];
  if (c.role) parts.push(`role: ${c.role}`);
  if (typeof c.content === "string") parts.push(JSON.stringify(c.content));
  else if (c.choices > 0) parts.push(c.content === null ? "content: null" : "no content");
  else parts.push("choices: []");
  if (c.finishReason) parts.push(`finish_reason: ${c.finishReason}`);
  if (c.usage) parts.push("usage");
  return parts.join(", ");
}
