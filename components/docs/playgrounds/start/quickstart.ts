import type { Effort } from "@/lib/docs/client/models";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { API_BASE_URL } from "@/components/docs/playgrounds/start/facts";
import { capWonder, WONDER_OUTPUT_CAP } from "@/components/docs/playgrounds/start/wonder";

/**
 * The quickstart page as data: its first call and what to try next, a reader for the response it explains ("Read the
 * response": the output_text in the message item, the reasoning item, reasoning tokens inside output_tokens), and the
 * coding-agent setup it gives (OpenCode's provider prompt and opencode.json, and the three values any
 * OpenAI-compatible tool asks for). Pure, so the builders are tested directly.
 */

export interface FirstCallOptions {
  model: string;
  prompt: string;
  stream?: boolean;
  /** Null leaves reasoning to the model, which defaults to "high" (the page's sample response shows it). */
  effort?: Effort | null;
  summary?: boolean;
  webSearch?: boolean;
}

/**
 * The Responses body for the quickstart's call: just model and input, plus whatever the reader turned on, and Muse
 * Wonder's output cap (wonder.ts) when it runs on Muse Wonder.
 */
export function firstCallBody(o: FirstCallOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { model: o.model, input: o.prompt };
  if (o.effort || o.summary) body.reasoning = { ...(o.effort ? { effort: o.effort } : {}), ...(o.summary ? { summary: "auto" } : {}) };
  if (o.webSearch) body.tools = [{ type: "web_search" }];
  if (o.stream) body.stream = true;
  return capWonder(body);
}

export interface FirstCallPreset extends Partial<FirstCallOptions> {
  label: string;
  prompt: string;
  /** What this variation shows, under the pills. */
  shows: string;
}

/** "What to try next": each one a working variation the quickstart or its next steps point to. */
export const FIRST_CALL_PRESETS: readonly FirstCallPreset[] = [
  {
    label: "The page's first call",
    prompt: "What is the capital of France?",
    shows: "Exactly the quickstart's request: model and input, nothing else. Reasoning runs at its default, high.",
  },
  {
    label: "Stream it",
    prompt: "Write a four-line poem about Paris in the rain.",
    stream: true,
    shows: 'stream: true sends server-sent events as the answer is written (response.output_text.delta), ending with response.completed.',
  },
  {
    label: "Less reasoning",
    prompt:
      "Ana, Ben, Cal and Dee sit in a row of four seats. Dee sits at the left end, Ana isn't at either end, and Ben sits somewhere to the right of Cal. List every seating that works, one line each.",
    effort: "low",
    shows:
      'reasoning.effort: "low" usually spends fewer reasoning tokens, which count toward output_tokens: about half the default (high) on this puzzle. Set Reasoning to Default and run it again to compare; single runs vary.',
  },
  {
    label: "Reasoning summary",
    prompt: "Is 391 a prime number? Answer in one line.",
    effort: "low",
    summary: true,
    shows: 'reasoning.summary: "auto" fills the reasoning item\'s summary, which is empty by default.',
  },
  {
    label: "Search the web",
    prompt: "What is one piece of news about Paris from this week? Cite the source.",
    effort: "low",
    webSearch: true,
    shows: "A web_search tool adds live results with citations (search grounding). Each search costs $2.50 per 1,000 on top of tokens.",
  },
  {
    label: "Muse Wonder",
    prompt: "What is the capital of France?",
    model: "muse-wonder-1.0",
    effort: "low",
    shows: `The same call on muse-wonder-1.0: in your code only the model id changes. Standard mode; the live docs add max_output_tokens: ${WONDER_OUTPUT_CAP} to keep it around a cent.`,
  },
  {
    label: "Wrong model id",
    prompt: "What is the capital of France?",
    model: "muse-spark-1.0",
    shows: "Troubleshooting: an id that doesn't exist returns 404 with code model_not_found (here from the docs proxy, which checks ids first).",
  },
];

/**
 * The preset the form matches right now, or null once the reader changes anything a preset sets, so the highlighted
 * pill and its line always describe the request Run sends.
 */
export function presetMatching(presets: readonly FirstCallPreset[], o: FirstCallOptions): number | null {
  const i = presets.findIndex(
    (p) =>
      p.prompt === o.prompt.trim() &&
      (p.model ?? DEFAULT_TEXT_MODEL) === o.model &&
      (p.effort ?? null) === (o.effort ?? null) &&
      !!p.summary === !!o.summary &&
      !!p.webSearch === !!o.webSearch &&
      !!p.stream === !!o.stream,
  );
  return i >= 0 ? i : null;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface OutputItemView {
  type: string;
  id: string;
  /** What the item holds, in a line: the text, the summary, the search query. */
  detail: string;
  kind: "message" | "reasoning" | "tool" | "other";
}

export interface ResponseReading {
  id: string;
  status: string;
  model: string;
  /** reasoning.effort as the response reports it (the default when the request set none). */
  effort: string | null;
  /** incomplete_details.reason when the response stopped early, such as "max_output_tokens". */
  incompleteReason: string | null;
  outputText: string;
  items: OutputItemView[];
  usage: { input: number; cached: number; output: number; reasoning: number; total: number } | null;
}

/** The parts of a Responses object the quickstart's "Read the response" section walks through. */
export function readResponse(response: unknown): ResponseReading | null {
  const r = obj(response);
  if (!r || r.object !== "response") return null;
  const output = Array.isArray(r.output) ? r.output.map(obj).filter((x): x is Json => !!x) : [];
  const texts: string[] = [];
  const items: OutputItemView[] = output.map((item) => {
    const type = String(item.type ?? "unknown");
    const id = typeof item.id === "string" ? item.id : "";
    if (type === "message") {
      const parts = (Array.isArray(item.content) ? item.content : []).map(obj).filter((x): x is Json => !!x);
      const text = parts.filter((p) => p.type === "output_text").map((p) => String(p.text ?? "")).join("");
      texts.push(text);
      return { type, id, kind: "message", detail: text ? `output_text: ${text}` : "no output_text" };
    }
    if (type === "reasoning") {
      const summary = (Array.isArray(item.summary) ? item.summary : []).map(obj).map((s) => String(s?.text ?? "")).filter(Boolean);
      const encrypted = typeof item.encrypted_content === "string" ? `; encrypted_content: ${item.encrypted_content.length.toLocaleString("en-US")} characters to replay` : "";
      return {
        type,
        id,
        kind: "reasoning",
        detail: (summary.length ? `summary: ${summary.join(" ")}` : "summary: [] (the reasoning itself isn't returned as text)") + encrypted,
      };
    }
    if (type === "web_search_call") {
      const action = obj(item.action);
      const query = typeof action?.query === "string" ? action.query : "";
      return { type, id, kind: "tool", detail: query ? `searched for: ${query}` : `status: ${String(item.status ?? "")}` };
    }
    return { type, id, kind: type.endsWith("_call") ? "tool" : "other", detail: typeof item.status === "string" ? `status: ${item.status}` : "" };
  });
  const u = obj(r.usage);
  const usage = u
    ? {
        input: num(u.input_tokens),
        cached: num(obj(u.input_tokens_details)?.cached_tokens),
        output: num(u.output_tokens),
        reasoning: num(obj(u.output_tokens_details)?.reasoning_tokens),
        total: num(u.total_tokens),
      }
    : null;
  return {
    id: typeof r.id === "string" ? r.id : "",
    status: typeof r.status === "string" ? r.status : "",
    model: typeof r.model === "string" ? r.model : "",
    effort: typeof obj(r.reasoning)?.effort === "string" ? (obj(r.reasoning)!.effort as string) : null,
    incompleteReason: typeof obj(r.incomplete_details)?.reason === "string" ? (obj(r.incomplete_details)!.reason as string) : null,
    outputText: texts.join(""),
    items,
    usage,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Coding agent setup (quickstart "Use with your coding agent", coding-agents "OpenCode")

export type OpenCodeAdapter = "@ai-sdk/openai" | "@ai-sdk/openai-compatible";

export interface OpenCodeOptions {
  model: string;
  adapter: OpenCodeAdapter;
  effort: Effort;
  summary: boolean;
  /** include ["reasoning.encrypted_content"]: what carries reasoning across turns. Responses adapter only. */
  encryptedReasoning: boolean;
}

export const OPENCODE_DEFAULTS: OpenCodeOptions = {
  model: DEFAULT_TEXT_MODEL,
  adapter: "@ai-sdk/openai",
  effort: "high",
  summary: true,
  encryptedReasoning: true,
};

const LIMIT = { context: 1048576, output: 131072 };
const MODALITIES = { input: ["text", "image", "pdf", "video"], output: ["text"] };

/** The opencode.json block: the Responses adapter (recommended) or the Chat Completions fallback, as the pages give them. */
export function openCodeConfig(o: OpenCodeOptions): Record<string, unknown> {
  const responses = o.adapter === "@ai-sdk/openai";
  const options: Json = { reasoningEffort: o.effort };
  if (o.summary) options.reasoningSummary = "auto";
  if (o.encryptedReasoning) options.include = ["reasoning.encrypted_content"];
  const model: Json = responses
    ? { name: o.model, reasoning: true, limit: LIMIT, modalities: MODALITIES, options }
    : { name: o.model, limit: LIMIT };
  return {
    provider: {
      meta: {
        name: "Meta Model API",
        npm: o.adapter,
        options: { baseURL: API_BASE_URL },
        models: { [o.model]: model },
      },
    },
  };
}

/** The prompt that makes a self-configuring agent (OpenCode, Goose, Roo) register the provider itself. */
export function providerPrompt(o: OpenCodeOptions): string {
  const responses = o.adapter === "@ai-sdk/openai";
  const reasoning = [`reasoningEffort "${o.effort}"`, ...(o.summary ? ['reasoningSummary "auto"'] : [])];
  const reasoningLine = `- Reasoning: true, with ${reasoning.join(", ")}${o.encryptedReasoning ? ', and include ["reasoning.encrypted_content"]' : ""}`;
  return [
    "Add a new provider to my config for Meta Model API:",
    '- Provider key: "meta", display name "Meta Model API"',
    `- npm adapter: "${o.adapter}" (targets the ${responses ? "Responses API" : "Chat Completions API"})`,
    `- Base URL: ${API_BASE_URL}`,
    `- Model: "${o.model}"`,
    ...(responses ? [reasoningLine] : []),
    `- Limits: context ${LIMIT.context}, output ${LIMIT.output}`,
    ...(responses ? ['- Modalities: input ["text", "image", "pdf", "video"], output ["text"]'] : []),
    "- Read the key from the MODEL_API_KEY environment variable",
  ].join("\n");
}

/**
 * A request with the settings the config gives the model, to check they're accepted before an agent session depends
 * on them: Responses with the reasoning options for @ai-sdk/openai, a plain Chat Completions call for the fallback
 * adapter, whose config sets no reasoning options. On Muse Wonder it also carries the docs' output cap (wonder.ts).
 */
export function configCheckRequest(o: OpenCodeOptions): { path: string; body: Record<string, unknown> } {
  const input = "Reply with the single word: connected";
  if (o.adapter === "@ai-sdk/openai-compatible") {
    return { path: "chat/completions", body: capWonder({ model: o.model, messages: [{ role: "user", content: input }] }, "max_completion_tokens") };
  }
  const body: Json = { model: o.model, input, reasoning: { effort: o.effort, ...(o.summary ? { summary: "auto" } : {}) } };
  // The reasoning item then carries encrypted_content, the blob the agent replays on its next turn.
  if (o.encryptedReasoning) body.include = ["reasoning.encrypted_content"];
  return { path: "responses", body: capWonder(body) };
}
