import { ANTHROPIC_BASE_URL, API_BASE_URL } from "@/components/docs/playgrounds/start/facts";

/**
 * The clients the SDKs page covers, each as the code a reader writes, the request it puts on the wire, and the
 * part of the reply it prints. The OpenAI SDK (Python and TypeScript) calls the Responses API and Chat Completions;
 * the Anthropic SDK calls Messages, with base_url https://api.meta.ai and the key as auth_token (a bearer token);
 * OpenAI-compatible clients (LiteLLM, LangChain, LlamaIndex, the Vercel AI SDK) take the base URL, the key and a
 * model id. None of them reads MODEL_API_KEY on its own, so every snippet passes it. Code uses the model the demo
 * runs; the copy prompt and the code views say what Contributor mode means.
 */

export type ClientProtocol = "responses" | "chat" | "messages";

export interface SdkClient {
  id: string;
  label: string;
  language: "python" | "typescript";
  install: string;
  protocol: ClientProtocol;
  /** The page has this exact example; otherwise it is written the page's way for a client the page names. */
  onPage: boolean;
  /** What the code prints from the reply. */
  reads: string;
  /** A line on what's particular about it. */
  note: string;
  code(model: string, prompt: string): string;
}

const py = (s: string) => JSON.stringify(s);
const ts = (s: string) => JSON.stringify(s);

export const SDK_CLIENTS: readonly SdkClient[] = [
  {
    id: "openai-python",
    label: "OpenAI SDK, Python",
    language: "python",
    install: "pip install openai",
    protocol: "responses",
    onPage: true,
    reads: "response.output_text",
    note: "client.responses.create() calls the Responses API. Pass api_key: the SDK looks for OPENAI_API_KEY, not MODEL_API_KEY.",
    code: (model, prompt) => `import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["MODEL_API_KEY"],
    base_url="${API_BASE_URL}",
)

response = client.responses.create(
    model=${py(model)},
    input=${py(prompt)},
)
print(response.output_text)`,
  },
  {
    id: "openai-typescript",
    label: "OpenAI SDK, TypeScript",
    language: "typescript",
    install: "npm install openai",
    protocol: "responses",
    onPage: true,
    reads: "response.output_text",
    note: "The same Responses call from Node.js 18+. Pass apiKey explicitly.",
    code: (model, prompt) => `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.MODEL_API_KEY,
  baseURL: "${API_BASE_URL}",
});

const response = await client.responses.create({
  model: ${ts(model)},
  input: ${ts(prompt)},
});
console.log(response.output_text);`,
  },
  {
    id: "openai-chat",
    label: "OpenAI SDK, Chat Completions",
    language: "python",
    install: "pip install openai",
    protocol: "chat",
    onPage: false,
    reads: "response.choices[0].message.content",
    note: "client.chat.completions.create() calls the OpenAI-compatible messages-array endpoint.",
    code: (model, prompt) => `import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["MODEL_API_KEY"],
    base_url="${API_BASE_URL}",
)

response = client.chat.completions.create(
    model=${py(model)},
    messages=[{"role": "user", "content": ${py(prompt)}}],
)
print(response.choices[0].message.content)`,
  },
  {
    id: "anthropic-python",
    label: "Anthropic SDK, Python",
    language: "python",
    install: "pip install anthropic",
    protocol: "messages",
    onPage: true,
    reads: 'the "text" blocks of message.content',
    note: "base_url is https://api.meta.ai (the SDK appends /v1/messages) and the key goes in auth_token. content starts with a redacted_thinking block, so don't read content[0].",
    code: (model, prompt) => `import os
from anthropic import Anthropic

client = Anthropic(
    base_url="${ANTHROPIC_BASE_URL}",
    auth_token=os.environ["MODEL_API_KEY"],
)

message = client.messages.create(
    model=${py(model)},
    max_tokens=1024,
    messages=[{"role": "user", "content": ${py(prompt)}}],
)
print("".join(block.text for block in message.content if block.type == "text"))`,
  },
  {
    id: "anthropic-typescript",
    label: "Anthropic SDK, TypeScript",
    language: "typescript",
    install: "npm install @anthropic-ai/sdk",
    protocol: "messages",
    onPage: false,
    reads: 'the "text" blocks of message.content',
    note: "baseURL https://api.meta.ai and authToken, the TypeScript names for the same two settings.",
    code: (model, prompt) => `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "${ANTHROPIC_BASE_URL}",
  authToken: process.env.MODEL_API_KEY,
});

const message = await client.messages.create({
  model: ${ts(model)},
  max_tokens: 1024,
  messages: [{ role: "user", content: ${ts(prompt)} }],
});
console.log(message.content.map((block) => (block.type === "text" ? block.text : "")).join(""));`,
  },
  {
    id: "litellm",
    label: "LiteLLM",
    language: "python",
    install: "pip install litellm",
    protocol: "chat",
    onPage: true,
    reads: "response.choices[0].message.content",
    note: "LiteLLM reaches Model API through its OpenAI provider: prefix the model id with openai/. It sends the id without the prefix.",
    code: (model, prompt) => `import os
import litellm

response = litellm.completion(
    model=${py(`openai/${model}`)},
    api_base="${API_BASE_URL}",
    api_key=os.environ["MODEL_API_KEY"],
    messages=[{"role": "user", "content": ${py(prompt)}}],
)
print(response.choices[0].message.content)`,
  },
  {
    id: "langchain",
    label: "LangChain",
    language: "python",
    install: "pip install langchain-openai",
    protocol: "chat",
    onPage: false,
    reads: "reply.content",
    note: "ChatOpenAI with a custom base_url speaks Chat Completions. Any OpenAI-compatible client works this way: base URL, key, model id.",
    code: (model, prompt) => `import os
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model=${py(model)},
    base_url="${API_BASE_URL}",
    api_key=os.environ["MODEL_API_KEY"],
)

reply = llm.invoke(${py(prompt)})
print(reply.content)`,
  },
  {
    id: "llamaindex",
    label: "LlamaIndex",
    language: "python",
    install: "pip install llama-index-llms-openai-like",
    protocol: "chat",
    onPage: false,
    reads: "the completion's text",
    note: "OpenAILike points LlamaIndex at any OpenAI-compatible base URL; is_chat_model=True sends Chat Completions.",
    code: (model, prompt) => `import os
from llama_index.llms.openai_like import OpenAILike

llm = OpenAILike(
    model=${py(model)},
    api_base="${API_BASE_URL}",
    api_key=os.environ["MODEL_API_KEY"],
    is_chat_model=True,
)

print(llm.complete(${py(prompt)}))`,
  },
  {
    id: "vercel-ai",
    label: "Vercel AI SDK",
    language: "typescript",
    install: "npm install ai @ai-sdk/openai",
    protocol: "responses",
    onPage: false,
    reads: "text",
    note: "@ai-sdk/openai targets the Responses API. It sends the prompt as a one-message input list; the request here sends it as a string, which the API reads the same way.",
    code: (model, prompt) => `import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const meta = createOpenAI({
  baseURL: "${API_BASE_URL}",
  apiKey: process.env.MODEL_API_KEY,
});

const { text } = await generateText({
  model: meta(${ts(model)}),
  prompt: ${ts(prompt)},
});
console.log(text);`,
  },
];

export function sdkClient(id: string): SdkClient | null {
  return SDK_CLIENTS.find((c) => c.id === id) ?? null;
}

export const PROTOCOL_PATHS: Record<ClientProtocol, string> = {
  responses: "responses",
  chat: "chat/completions",
  messages: "messages",
};

/** The request a client sends for one prompt: Meta's path and the JSON body, as the docs proxy forwards it. */
export function wireRequest(protocol: ClientProtocol, model: string, prompt: string): { path: string; body: Record<string, unknown> } {
  if (protocol === "messages") {
    return { path: PROTOCOL_PATHS.messages, body: { model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] } };
  }
  if (protocol === "chat") return { path: PROTOCOL_PATHS.chat, body: { model, messages: [{ role: "user", content: prompt }] } };
  return { path: PROTOCOL_PATHS.responses, body: { model, input: prompt } };
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function list(v: unknown): Json[] {
  return Array.isArray(v) ? v.map(obj).filter((x): x is Json => !!x) : [];
}

/** What a client prints, read the way it reads it. Null when the reply has no text in the expected place. */
export function readReply(protocol: ClientProtocol, reply: unknown): string | null {
  const r = obj(reply);
  if (!r) return null;
  if (protocol === "messages") {
    const texts = list(r.content).filter((b) => b.type === "text" && typeof b.text === "string");
    return texts.length ? texts.map((b) => b.text as string).join("") : null;
  }
  if (protocol === "chat") {
    const content = obj(list(r.choices)[0]?.message)?.content;
    return typeof content === "string" ? content : null;
  }
  // output_text: every output_text part of every message item, joined, as the OpenAI SDK builds it.
  const parts = list(r.output)
    .filter((item) => item.type === "message")
    .flatMap((item) => list(item.content))
    .filter((c) => c.type === "output_text" && typeof c.text === "string")
    .map((c) => c.text as string);
  return parts.length ? parts.join("") : null;
}

/** The content block types of a Messages reply, in order: ["redacted_thinking", "text"]. */
export function messagesBlockTypes(reply: unknown): string[] {
  return list(obj(reply)?.content).map((b) => String(b.type ?? "unknown"));
}
