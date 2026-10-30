import { tokenUsage } from "@/lib/docs/client/cost";
import { EFFORTS, effortsFor, type Effort } from "@/lib/docs/client/models";

/**
 * The reasoning page's demo as data: one prompt at several effort levels (`reasoning.effort` on Responses, the
 * top-level `reasoning_effort` on Chat Completions), what each run spent (reasoning tokens are part of the output
 * tokens and billed the same), the reasoning summary when Responses was asked for one, and the two ways the page
 * gives to carry reasoning into a follow-up: previous_response_id, or a stateless replay of the encrypted reasoning.
 */

type Json = Record<string, unknown>;

export type EffortProtocol = "responses" | "chat";
/** An effort level, or "default": the field left out, so the model picks (the reply then says which it used). */
export type EffortChoice = Effort | "default";

export const EFFORT_CHOICES: readonly EffortChoice[] = ["default", ...EFFORTS];

export const SUMMARY_PROFILES = ["auto", "concise", "detailed"] as const;
export type SummaryProfile = (typeof SUMMARY_PROFILES)[number];

export interface EffortRequest {
  model: string;
  prompt: string;
  effort: EffortChoice;
  /** Responses only. */
  summary: SummaryProfile | null;
  maxOutputTokens: number | null;
}

/** The choices a model takes: "default", then the levels it accepts ("max" only on Muse Wonder and Muse Spark 1.3). */
export function choicesFor(model: string): EffortChoice[] {
  return ["default", ...effortsFor(model)];
}

/** One run's request body. */
export function effortBody(protocol: EffortProtocol, r: EffortRequest): Json {
  const effort = r.effort === "default" ? null : r.effort;
  if (protocol === "chat") {
    return {
      model: r.model,
      ...(effort ? { reasoning_effort: effort } : {}),
      messages: [{ role: "user", content: r.prompt }],
      ...(r.maxOutputTokens ? { max_completion_tokens: r.maxOutputTokens } : {}),
    };
  }
  const reasoning = { ...(effort ? { effort } : {}), ...(r.summary ? { summary: r.summary } : {}) };
  return {
    model: r.model,
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
    input: r.prompt,
    ...(r.maxOutputTokens ? { max_output_tokens: r.maxOutputTokens } : {}),
  };
}

export interface EffortResult {
  id: string | null;
  /** completed, or incomplete when the output limit ran out. */
  status: string;
  /** Why it stopped early ("max_output_tokens"), or null. */
  incomplete: string | null;
  input: number;
  output: number;
  reasoning: number;
  /** Output tokens the reader sees: output minus reasoning. */
  visible: number;
  /** The reasoning summary's parts (Responses), in order. Empty when none came back, which the page allows. */
  summary: string[];
  answer: string;
  /** The effort the reply says it ran at (Responses echoes `reasoning.effort`), for "default" runs. */
  ranAt: string | null;
  /** Chat Completions: whether reasoning_content came back with anything in it (it is redacted for API keys). */
  reasoningContent: "absent" | "empty" | "present" | null;
}

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

/** What one run spent and said, from its whole reply. */
export function effortResult(protocol: EffortProtocol, json: unknown): EffortResult {
  const r = obj(json) ?? {};
  const t = tokenUsage(r.usage);
  const usage = { input: t?.input ?? 0, output: t?.output ?? 0, reasoning: t?.reasoning ?? 0 };
  if (protocol === "chat") {
    const choice = obj(Array.isArray(r.choices) ? r.choices[0] : null);
    const message = obj(choice?.message);
    const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
    const rc = message && "reasoning_content" in message ? (typeof message.reasoning_content === "string" && message.reasoning_content ? "present" : "empty") : "absent";
    return {
      id: typeof r.id === "string" ? r.id : null,
      status: finish === "length" ? "incomplete" : "completed",
      incomplete: finish === "length" ? "max_completion_tokens" : null,
      ...usage,
      visible: Math.max(0, usage.output - usage.reasoning),
      summary: [],
      answer: typeof message?.content === "string" ? message.content : "",
      ranAt: null,
      reasoningContent: rc,
    };
  }
  const output = Array.isArray(r.output) ? (r.output as unknown[]).map(obj).filter((x): x is Json => !!x) : [];
  const summary = output
    .filter((o) => o.type === "reasoning")
    .flatMap((o) => (Array.isArray(o.summary) ? (o.summary as unknown[]) : []))
    .map((s) => (typeof obj(s)?.text === "string" ? (obj(s)!.text as string) : ""))
    .filter(Boolean);
  const answer = output
    .filter((o) => o.type === "message")
    .flatMap((o) => (Array.isArray(o.content) ? (o.content as unknown[]) : []))
    .map((c) => (obj(c)?.type === "output_text" && typeof obj(c)?.text === "string" ? (obj(c)!.text as string) : ""))
    .join("");
  const ranAt = obj(r.reasoning)?.effort;
  return {
    id: typeof r.id === "string" ? r.id : null,
    status: typeof r.status === "string" ? r.status : "completed",
    incomplete: typeof obj(r.incomplete_details)?.reason === "string" ? (obj(r.incomplete_details)!.reason as string) : null,
    ...usage,
    visible: Math.max(0, usage.output - usage.reasoning),
    summary,
    answer,
    ranAt: typeof ranAt === "string" ? ranAt : null,
    reasoningContent: null,
  };
}

/** What a preset may set; anything it leaves out falls back to the demo's defaults. */
export interface EffortPresetLike {
  prompt: string;
  followUp?: string;
  model?: string;
  efforts?: EffortChoice[];
  maxOutputTokens?: number;
}

export interface EffortSetup {
  prompt: string;
  followUp: string;
  model: string;
  efforts: EffortChoice[];
  maxOutputTokens: number;
}

/**
 * The whole setup a preset picks. A preset is complete: what it leaves out goes back to the defaults instead of
 * keeping the last preset's, so "Max on Muse Wonder" can't carry Muse Wonder and its efforts into a preset whose cost
 * line promises Spark 1.3 Contributor.
 */
export function presetSetup(p: EffortPresetLike, defaults: EffortSetup): EffortSetup {
  return {
    prompt: p.prompt,
    followUp: p.followUp ?? defaults.followUp,
    model: p.model ?? defaults.model,
    efforts: p.efforts ?? defaults.efforts,
    maxOutputTokens: p.maxOutputTokens ?? defaults.maxOutputTokens,
  };
}

export type FollowUpMethod = "previous" | "replay";

/** A follow-up that continues a stored response: the server keeps the reasoning (reasoning, "Multi-turn reasoning"). */
export function previousFollowUp(first: Json, firstId: string, followUp: string): Json {
  const { input: _input, ...rest } = first;
  void _input;
  return { ...rest, previous_response_id: firstId, input: followUp };
}

/** The first turn again, asking for the encrypted reasoning and storing nothing, so it can be replayed by hand. */
export function replayFirstTurn(first: Json): Json {
  const include = Array.isArray(first.include) ? (first.include as unknown[]) : [];
  return { ...first, include: [...new Set([...include, "reasoning.encrypted_content"])], store: false };
}

/**
 * The stateless follow-up: the first question, every output item of the first turn (the reasoning items carry
 * `encrypted_content`), then the new question. Nothing depends on stored state.
 */
export function replayFollowUp(firstTurn: Json, firstResponse: unknown, followUp: string): Json {
  const out = obj(firstResponse);
  const items = Array.isArray(out?.output) ? (out!.output as unknown[]) : [];
  const question = typeof firstTurn.input === "string" ? firstTurn.input : "";
  return {
    ...firstTurn,
    input: [{ role: "user", content: question }, ...items, { role: "user", content: followUp }],
  };
}

/** How many reasoning items in a reply carry encrypted content, the part a stateless replay needs. */
export function encryptedItems(response: unknown): number {
  const out = obj(response);
  const items = Array.isArray(out?.output) ? (out!.output as unknown[]) : [];
  return items.filter((x) => obj(x)?.type === "reasoning" && typeof obj(x)?.encrypted_content === "string" && (obj(x)!.encrypted_content as string).length > 0).length;
}

/** Runs several requests with at most `limit` in flight at once, keeping their order in the results. */
export async function runLimited<T>(tasks: ReadonlyArray<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return results;
}
