import { buildBody, type ChatTurn, type Protocol } from "@/lib/docs/client/body";
import { fitEffort, type Effort } from "@/lib/docs/client/models";

/**
 * The "Choosing an API" comparison as data: what each of the three request formats names the same things (the
 * protocols page's "At a glance" table, plus the field names its three guides use), the bodies one question becomes
 * in each format, turn by turn, and where each reply keeps its text and token counts. The follow-up turn is built the
 * way each guide says to carry a conversation: Responses sends only the new input with previous_response_id, Chat
 * Completions resends the text history (reasoning isn't carried), Messages resends the history with the assistant's
 * content blocks, redacted_thinking included, so the reasoning travels too. Each format's conversation holds only its
 * own replies: a turn whose request failed on one format is left out of that format's history (and Responses chains
 * from its latest stored response), never filled in with another format's answer.
 */

export interface WireFacts {
  endpoint: string;
  /** Where the instructions go. */
  instructions: string;
  /** The output-token limit's name. */
  limit: string;
  reasoning: string;
  /** How the next turn carries the conversation. */
  nextTurn: string;
  /** "Reasoning across turns", from the protocols page's table. */
  carriesReasoning: string;
  /** Which SDK and base URL the guide uses. */
  sdk: string;
  /** Where the reply's text sits, in words. */
  textAt: string;
}

export const WIRE: Record<Protocol, WireFacts> = {
  responses: {
    endpoint: "POST /v1/responses",
    instructions: "instructions",
    limit: "max_output_tokens",
    reasoning: "reasoning.effort",
    nextTurn: "Only the new input, with previous_response_id",
    carriesReasoning: "Yes: previous_response_id, or encrypted replay",
    sdk: "OpenAI SDK, base URL https://api.meta.ai/v1",
    textAt: "output[].content[].text",
  },
  chat: {
    endpoint: "POST /v1/chat/completions",
    instructions: "a developer message",
    limit: "max_completion_tokens",
    reasoning: "reasoning_effort",
    nextTurn: "The whole messages array again",
    carriesReasoning: "No: only the text is resent",
    sdk: "OpenAI SDK, base URL https://api.meta.ai/v1",
    textAt: "choices[0].message.content",
  },
  messages: {
    endpoint: "POST /v1/messages",
    instructions: "system",
    limit: "max_tokens (required)",
    reasoning: "thinking plus output_config.effort",
    nextTurn: "The whole messages array again, thinking blocks included",
    carriesReasoning: "Yes: redacted_thinking is replayed",
    sdk: "Anthropic SDK, base URL https://api.meta.ai",
    textAt: "content[].text",
  },
};

export const COMPARE_PROTOCOLS: readonly Protocol[] = ["responses", "chat", "messages"];

export interface CompareInput {
  model: string;
  system: string;
  question: string;
  effort: Effort | null;
  maxOutputTokens: number;
  stream: boolean;
}

/** One finished turn, as much of it as each format needs to carry the conversation on. */
export interface CompareTurn {
  question: string;
  /** The stored response's id, for previous_response_id. */
  responsesId: string | null;
  /** Chat Completions' reply text. */
  chatText: string | null;
  /** Messages' reply content blocks, thinking included. */
  messagesContent: unknown[] | null;
}

type Json = Record<string, unknown>;

/** The three bodies the next question becomes, given the turns so far. */
export function compareBodies(input: CompareInput, history: readonly CompareTurn[]): Record<Protocol, Json> {
  const base = {
    model: input.model,
    system: input.system,
    effort: fitEffort(input.model, input.effort),
    maxOutputTokens: input.maxOutputTokens,
    stream: input.stream,
  };
  const ask: ChatTurn = { role: "user", content: input.question };

  // Only the new input, chained from the latest response Responses stored. With none (every Responses turn so far
  // failed), the Responses conversation starts over rather than borrowing another format's replies.
  const chain = responsesChain(history);
  const responses = buildBody("responses", { ...base, messages: [ask], previousResponseId: chain?.id ?? null });

  const chatHistory: ChatTurn[] = history.flatMap((t) =>
    t.chatText ? [{ role: "user" as const, content: t.question }, { role: "assistant" as const, content: t.chatText }] : [],
  );
  const chat = buildBody("chat", { ...base, messages: [...chatHistory, ask] });

  const messages = buildBody("messages", { ...base, messages: [ask] });
  messages.messages = [
    ...history.flatMap((t) => (t.messagesContent?.length ? [{ role: "user", content: t.question }, { role: "assistant", content: t.messagesContent }] : [])),
    { role: "user", content: input.question },
  ];

  return { responses, chat, messages };
}

/** The latest turn whose Responses request stored a response: what the next Responses turn chains from. */
export function responsesChain(history: readonly CompareTurn[]): { id: string; turn: number } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const id = history[i].responsesId;
    if (id) return { id, turn: i + 1 };
  }
  return null;
}

/** "2", "2 and 3", "1, 2 and 4". */
function turnList(turns: readonly number[]): string {
  return turns.length > 1 ? `${turns.slice(0, -1).join(", ")} and ${turns[turns.length - 1]}` : String(turns[0] ?? "");
}

/**
 * What the next turn sends in a format, in words, saying so when a turn is left out of that format's conversation
 * because its request failed there (or, on Responses, when there is no stored response left to chain from).
 */
export function nextTurnNote(protocol: Protocol, history: readonly CompareTurn[]): string {
  if (!history.length) return WIRE[protocol].nextTurn;
  if (protocol === "responses") {
    const chain = responsesChain(history);
    if (!chain) return "The new input alone, as a new conversation: no Responses turn stored a response to chain from";
    if (chain.turn === history.length) return WIRE.responses.nextTurn;
    const after = history.slice(chain.turn).map((_t, i) => chain.turn + i + 1);
    return `Only the new input, with previous_response_id from turn ${chain.turn}: turn ${turnList(after)} failed on Responses`;
  }
  const kept = (t: CompareTurn) => (protocol === "chat" ? !!t.chatText : !!t.messagesContent?.length);
  const missing = history.flatMap((t, i) => (kept(t) ? [] : [i + 1]));
  if (!missing.length) return WIRE[protocol].nextTurn;
  return `${WIRE[protocol].nextTurn}, without turn ${turnList(missing)}: it failed on ${protocol === "chat" ? "Chat Completions" : "Messages"}`;
}

function isObject(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Where a reply's visible text is, as a path into its JSON: "output[1].content[0].text". Null when it has none. */
export function textPath(protocol: Protocol, json: unknown): string | null {
  if (!isObject(json)) return null;
  if (protocol === "chat") {
    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    return isObject(choice) && isObject(choice.message) && typeof choice.message.content === "string" ? "choices[0].message.content" : null;
  }
  if (protocol === "messages") {
    const content = Array.isArray(json.content) ? json.content : [];
    const at = content.findIndex((b) => isObject(b) && b.type === "text");
    return at < 0 ? null : `content[${at}].text`;
  }
  const output = Array.isArray(json.output) ? json.output : [];
  // The final answer: the last message (a tool preamble before it carries phase "commentary").
  for (let i = output.length - 1; i >= 0; i--) {
    const item = output[i];
    if (!isObject(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    const j = item.content.findIndex((c) => isObject(c) && c.type === "output_text");
    if (j >= 0) return `output[${i}].content[${j}].text`;
  }
  return null;
}

/** The output item and block types in order, as the reply shape shows them: "reasoning, message". */
export function replyShape(protocol: Protocol, json: unknown): string {
  if (!isObject(json)) return "";
  const types = (list: unknown) => (Array.isArray(list) ? list.map((x) => (isObject(x) && typeof x.type === "string" ? x.type : "?")) : []);
  if (protocol === "chat") {
    const choice = Array.isArray(json.choices) && isObject(json.choices[0]) ? json.choices[0] : null;
    const message = choice && isObject(choice.message) ? choice.message : null;
    const keys = message ? Object.keys(message).filter((k) => message[k] !== null && message[k] !== undefined) : [];
    return `choices[0].message: ${keys.join(", ")}${choice?.finish_reason ? `; finish_reason ${String(choice.finish_reason)}` : ""}`;
  }
  if (protocol === "messages") {
    return `content: ${types(json.content).join(", ")}${json.stop_reason ? `; stop_reason ${String(json.stop_reason)}` : ""}`;
  }
  return `output: ${types(json.output).join(", ")}${json.status ? `; status ${String(json.status)}` : ""}`;
}

/** The usage object's own names and numbers, in the order each format lists them. */
export function usageFields(protocol: Protocol, usage: unknown): Array<[string, number]> {
  if (!isObject(usage)) return [];
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const sub = (k: string, f: string) => (isObject(usage[k]) ? num((usage[k] as Json)[f]) : null);
  const rows: Array<[string, number | null]> =
    protocol === "chat"
      ? [
          ["prompt_tokens", num(usage.prompt_tokens)],
          ["completion_tokens", num(usage.completion_tokens)],
          ["completion_tokens_details.reasoning_tokens", sub("completion_tokens_details", "reasoning_tokens")],
          ["prompt_tokens_details.cached_tokens", sub("prompt_tokens_details", "cached_tokens")],
        ]
      : protocol === "messages"
        ? [
            ["input_tokens", num(usage.input_tokens)],
            ["output_tokens", num(usage.output_tokens)],
            ["output_tokens_details.thinking_tokens", sub("output_tokens_details", "thinking_tokens")],
            ["cache_read_input_tokens", num(usage.cache_read_input_tokens)],
          ]
        : [
            ["input_tokens", num(usage.input_tokens)],
            ["output_tokens", num(usage.output_tokens)],
            ["output_tokens_details.reasoning_tokens", sub("output_tokens_details", "reasoning_tokens")],
            ["input_tokens_details.cached_tokens", sub("input_tokens_details", "cached_tokens")],
          ];
  return rows.filter((r): r is [string, number] => r[1] !== null);
}

/** The size of a JSON body as it goes over the wire, in bytes. */
export function bodyBytes(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

/** "1.2 KB", "640 B". */
export function bytesLabel(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
}

/** Every event type a stream carried, once each in order, with how many came: "response.output_text.delta x12". */
export function eventSummary(types: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([t, n]) => (n > 1 ? `${t} x${n}` : t)).join(", ");
}
