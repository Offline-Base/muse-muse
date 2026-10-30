import type { Effort } from "@/lib/docs/client/models";

/**
 * Request bodies for Meta's three text protocols, built from one neutral description of a turn. The playgrounds keep
 * their state in this neutral shape, so switching between Responses, Chat Completions and Messages is a matter of
 * which builder runs. Field names and placement follow the mirrored protocol pages:
 *
 * - Responses: `instructions`, `input`, `reasoning.effort`, `max_output_tokens`, flat function tools, `text.format`.
 * - Chat Completions: a `developer` message, `reasoning_effort`, `max_completion_tokens`, tools nested under
 *   `function`, `response_format`, and `stream_options.include_usage` so a stream ends with usage.
 * - Messages (Anthropic shape): `system`, the required `max_tokens`, `thinking` plus `output_config.effort`,
 *   `input_schema` tools, `output_config.format`.
 */

export type Protocol = "responses" | "chat" | "messages";

export const PROTOCOLS: readonly Protocol[] = ["responses", "chat", "messages"];

/** Meta's path for each protocol, as docsCall takes it. */
export const PROTOCOL_PATH: Record<Protocol, string> = {
  responses: "responses",
  chat: "chat/completions",
  messages: "messages",
};

export const PROTOCOL_LABEL: Record<Protocol, string> = {
  responses: "Responses",
  chat: "Chat Completions",
  messages: "Messages",
};

/** Messages requires max_tokens. This is what a demo sends when the page sets none. */
export const MESSAGES_DEFAULT_MAX_TOKENS = 4096;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the arguments. */
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface OutputSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface NeutralRequest {
  model: string;
  /** Behavior instructions: `instructions` (Responses), a developer message (Chat), `system` (Messages). */
  system?: string;
  /** The conversation so far, ending with the user turn to answer. */
  messages: ChatTurn[];
  maxOutputTokens?: number;
  /** Left out when null or undefined, so the model reasons at its own default level. */
  effort?: Effort | null;
  /** Responses only: ask for a reasoning summary. */
  summary?: "auto" | "concise" | "detailed" | null;
  tools?: ToolDef[];
  /** parallel_tool_calls. Left out when undefined (the API default is true). */
  parallelToolCalls?: boolean;
  /** Structured output: the reply must match this JSON Schema. */
  schema?: OutputSchema;
  stream?: boolean;
  /** Responses only: continue a stored response, so only the newest user turn is sent. */
  previousResponseId?: string | null;
}

type Json = Record<string, unknown>;

function clean(text: string | undefined): string {
  return (text ?? "").trim();
}

/** `strict` only when the page set it: the API's default is false (structured-output, "Enforce strict mode"). */
function strictOf(schema: OutputSchema): Json {
  return schema.strict === undefined ? {} : { strict: schema.strict };
}

function lastUserText(messages: ChatTurn[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

/** Function tools in the flat Responses shape. */
export function responsesTools(tools: ToolDef[]): Json[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    ...(t.parameters ? { parameters: t.parameters } : {}),
    ...(t.strict !== undefined ? { strict: t.strict } : {}),
  }));
}

/** Function tools in the nested Chat Completions shape. */
export function chatTools(tools: ToolDef[]): Json[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.parameters ? { parameters: t.parameters } : {}),
      ...(t.strict !== undefined ? { strict: t.strict } : {}),
    },
  }));
}

/** Custom tools in the Anthropic shape: the schema goes in `input_schema`, which Messages requires. */
export function messagesTools(tools: ToolDef[]): Json[] {
  return tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    input_schema: t.parameters ?? { type: "object", properties: {} },
  }));
}

/** The Responses `input`: a plain string for a single question, typed items once there is history to replay. */
function responsesInput(n: NeutralRequest): unknown {
  if (n.previousResponseId) return lastUserText(n.messages);
  if (n.messages.length === 1 && n.messages[0].role === "user") return n.messages[0].content;
  return n.messages.map((m) =>
    m.role === "user"
      ? { role: "user", content: m.content }
      : // Prior assistant turns are replayed as output_text, as the Responses page recommends.
        { role: "assistant", content: [{ type: "output_text", text: m.content }] },
  );
}

export function responsesBody(n: NeutralRequest): Json {
  const body: Json = { model: n.model };
  const system = clean(n.system);
  if (system) body.instructions = system;
  body.input = responsesInput(n);
  if (n.previousResponseId) body.previous_response_id = n.previousResponseId;
  if (n.effort || n.summary) {
    body.reasoning = { ...(n.effort ? { effort: n.effort } : {}), ...(n.summary ? { summary: n.summary } : {}) };
  }
  if (n.tools?.length) body.tools = responsesTools(n.tools);
  if (n.parallelToolCalls !== undefined && n.tools?.length) body.parallel_tool_calls = n.parallelToolCalls;
  if (n.schema) {
    body.text = { format: { type: "json_schema", name: n.schema.name, schema: n.schema.schema, ...strictOf(n.schema) } };
  }
  if (n.maxOutputTokens) body.max_output_tokens = n.maxOutputTokens;
  if (n.stream) body.stream = true;
  return body;
}

export function chatBody(n: NeutralRequest): Json {
  const system = clean(n.system);
  const messages: Json[] = [
    ...(system ? [{ role: "developer", content: system }] : []),
    ...n.messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  return chatBodyWith(n, messages);
}

/**
 * A Chat Completions body around messages the caller already built, such as a tool loop's assistant tool_calls and
 * tool results. Everything else comes from the neutral request.
 */
export function chatBodyWith(n: NeutralRequest, messages: Json[]): Json {
  const body: Json = { model: n.model, messages };
  if (n.effort) body.reasoning_effort = n.effort;
  if (n.tools?.length) body.tools = chatTools(n.tools);
  if (n.parallelToolCalls !== undefined && n.tools?.length) body.parallel_tool_calls = n.parallelToolCalls;
  if (n.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: n.schema.name, schema: n.schema.schema, ...strictOf(n.schema) },
    };
  }
  if (n.maxOutputTokens) body.max_completion_tokens = n.maxOutputTokens;
  if (n.stream) {
    body.stream = true;
    // Without this a streamed chat completion never reports usage, so the demo couldn't show tokens or cost.
    body.stream_options = { include_usage: true };
  }
  return body;
}

export function messagesBody(n: NeutralRequest): Json {
  const body: Json = { model: n.model, max_tokens: n.maxOutputTokens || MESSAGES_DEFAULT_MAX_TOKENS };
  const system = clean(n.system);
  if (system) body.system = system;
  body.messages = n.messages.map((m) => ({ role: m.role, content: m.content }));
  const outputConfig: Json = {};
  if (n.effort) {
    // Messages takes low through max; "minimal" has no Anthropic equivalent, so it runs as the closest, "low".
    outputConfig.effort = n.effort === "minimal" ? "low" : n.effort;
    body.thinking = { type: "adaptive" };
  }
  if (n.schema) outputConfig.format = { type: "json_schema", schema: n.schema.schema };
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  if (n.tools?.length) {
    body.tools = messagesTools(n.tools);
    if (n.parallelToolCalls === false) body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
  }
  if (n.stream) body.stream = true;
  return body;
}

export function buildBody(protocol: Protocol, n: NeutralRequest): Json {
  if (protocol === "chat") return chatBody(n);
  if (protocol === "messages") return messagesBody(n);
  return responsesBody(n);
}

function isPlainObject(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Keys whose arrays add up instead of replacing: a page's extra tools join the playground's own. */
const CONCAT_KEYS = new Set(["tools", "include"]);

/**
 * `extra` merged into `base`: objects merge key by key, `tools` and `include` arrays are joined (include without
 * repeats), anything else in `extra` wins. Undefined values in `extra` are skipped. Neither input is changed.
 */
export function mergeBody(base: Json, extra: Json | null | undefined): Json {
  if (!extra) return { ...base };
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    const current = out[key];
    if (CONCAT_KEYS.has(key) && Array.isArray(current) && Array.isArray(value)) {
      const joined = [...current, ...value];
      out[key] = key === "include" ? [...new Set(joined)] : joined;
    } else if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = mergeBody(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
