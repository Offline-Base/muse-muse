/**
 * What the token counting demo counts (token-counting page): a question, a question with instructions, a tool
 * conversation, a question with the web_search tool (whose scaffolding the count includes), an image, and a long
 * document, each as the body `POST /v1/responses/input_tokens` or the Anthropic-shaped `POST /v1/messages/count_tokens`
 * takes. Counts are measured against the 1,048,576-token context window every Muse Spark version and Muse Wonder has
 * (models page).
 */

type Json = Record<string, unknown>;

export type CountEndpoint = "responses/input_tokens" | "messages/count_tokens";
export type CountCase = "text" | "instructions" | "conversation" | "web_search" | "image" | "document";

export const CONTEXT_WINDOW = 1_048_576;

export const COUNT_CASES: ReadonlyArray<{ id: CountCase; label: string; about: string }> = [
  { id: "text", label: "A question", about: "The page's own example: one short question." },
  { id: "instructions", label: "With instructions", about: "The same question with developer instructions." },
  { id: "conversation", label: "Tool conversation", about: "A get_weather call, its result, an answer and a follow-up, with the tool's definition." },
  { id: "web_search", label: "With web search", about: "The same question with the web_search tool, whose scaffolding the model receives too." },
  { id: "image", label: "An image", about: "A sample image and a question. Resolution changes the count." },
  { id: "document", label: "A long document", about: "Three chapters of a public-domain book as instructions." },
];

export const QUESTION = "What is the capital of France?";
export const TUTOR = "You are a concise geography tutor. Answer in one sentence.";

export interface CaseExtras {
  /** For "image": the image as a data URL. */
  imageDataUrl?: string;
  /** For "document": the text. */
  document?: string;
}

const WEATHER_PARAMS = {
  type: "object",
  properties: { location: { type: "string", description: "City name" } },
  required: ["location"],
  additionalProperties: false,
};

function dataUrlParts(url: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { mime: m[1], data: m[2] } : null;
}

/** The count request's body for a case. */
export function countBody(endpoint: CountEndpoint, kind: CountCase, model: string, extras: CaseExtras = {}): Json {
  const messagesApi = endpoint === "messages/count_tokens";
  switch (kind) {
    case "text":
      return messagesApi ? { model, messages: [{ role: "user", content: QUESTION }] } : { model, input: QUESTION };
    case "instructions":
      return messagesApi ? { model, system: TUTOR, messages: [{ role: "user", content: QUESTION }] } : { model, instructions: TUTOR, input: QUESTION };
    case "conversation":
      if (messagesApi) {
        return {
          model,
          tools: [{ name: "get_weather", description: "Return current weather for the given location.", input_schema: WEATHER_PARAMS }],
          messages: [
            { role: "user", content: "What is the weather in Seattle?" },
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "Seattle" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"temperature":"15°C","condition":"Cloudy"}' }] },
            { role: "assistant", content: "It's 15°C and cloudy in Seattle." },
            { role: "user", content: "And in Tokyo?" },
          ],
        };
      }
      return {
        model,
        tools: [{ type: "function", name: "get_weather", description: "Return current weather for the given location.", parameters: WEATHER_PARAMS }],
        input: [
          { role: "user", content: "What is the weather in Seattle?" },
          { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"location":"Seattle"}' },
          { type: "function_call_output", call_id: "call_1", output: '{"temperature":"15°C","condition":"Cloudy"}' },
          { role: "assistant", content: [{ type: "output_text", text: "It's 15°C and cloudy in Seattle." }] },
          { role: "user", content: "And in Tokyo?" },
        ],
      };
    case "web_search":
      return messagesApi
        ? { model, tools: [{ type: "web_search" }], messages: [{ role: "user", content: QUESTION }] }
        : { model, tools: [{ type: "web_search" }], input: QUESTION };
    case "image": {
      const url = extras.imageDataUrl ?? "";
      const question = "What does this image show?";
      if (messagesApi) {
        const parts = dataUrlParts(url);
        return {
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: parts?.mime ?? "image/png", data: parts?.data ?? "" } },
                { type: "text", text: question },
              ],
            },
          ],
        };
      }
      return {
        model,
        input: [{ role: "user", content: [{ type: "input_text", text: question }, { type: "input_image", image_url: url }] }],
      };
    }
    case "document": {
      const system = `Answer questions about the book below.\n\n${extras.document ?? ""}`;
      const question = "Who is the first character Alice follows?";
      return messagesApi ? { model, system, messages: [{ role: "user", content: question }] } : { model, instructions: system, input: question };
    }
  }
}

/**
 * The generation request a count stands for, so "Send it" can compare the preflight count with the reply's usage:
 * the same body plus an output limit and low effort to keep it cheap. Messages needs max_tokens.
 */
export function sendBodyFor(endpoint: CountEndpoint, body: Json): { path: "responses" | "messages"; body: Json } {
  if (endpoint === "messages/count_tokens") return { path: "messages", body: { ...body, max_tokens: 400 } };
  return { path: "responses", body: { ...body, reasoning: { effort: "low" }, max_output_tokens: 400 } };
}

/**
 * What a count was taken of: the endpoint and the exact body. "Send it and compare" pairs a reply's usage with a count
 * only when the keys match, so a count of one case is never set against another case's reply.
 */
export function countKey(endpoint: CountEndpoint, body: Json): string {
  return `${endpoint} ${JSON.stringify(body)}`;
}

/** The share of the context window a count fills, 0 to 1. */
export function windowShare(tokens: number, window = CONTEXT_WINDOW): number {
  return window > 0 ? Math.min(1, Math.max(0, tokens / window)) : 0;
}

/** "0.02%" or "12.4%": small shares keep two decimals so a short prompt doesn't read as 0%. */
export function shareLabel(share: number): string {
  const pct = share * 100;
  if (pct === 0) return "0%";
  if (pct < 0.01) return "under 0.01%";
  if (pct < 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(1)}%`;
}

/** The count a reply carries: `input_tokens` from either endpoint. */
export function countOf(json: unknown): number | null {
  const o = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  return typeof o?.input_tokens === "number" ? o.input_tokens : null;
}

/** A long body's base64 shortened for display: the count body is shown, not the megabytes inside it. */
export function displayCountBody(body: unknown): unknown {
  if (typeof body === "string") {
    if (/^data:[^;,]+;base64,/.test(body) && body.length > 200) return `${body.slice(0, body.indexOf(",") + 1)}<BASE64>`;
    if (body.length > 600 && /^[A-Za-z0-9+/=]+$/.test(body)) return "<BASE64>";
    return body.length > 1200 ? `${body.slice(0, 400)}... (${(body.length - 400).toLocaleString("en-US")} more characters)` : body;
  }
  if (Array.isArray(body)) return body.map(displayCountBody);
  if (body && typeof body === "object") return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, displayCountBody(v)]));
  return body;
}
