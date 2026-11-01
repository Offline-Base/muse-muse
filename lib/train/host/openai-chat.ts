/**
 * One chat answer from an OpenAI-compatible endpoint. Its failures never carry the URL, the key or the provider's body:
 * only a HostError whose words are safe to show. A scaled-to-zero endpoint answers 503 while it wakes.
 */
import { glimmerChatBody, GLIMMER_MAX_TOKENS } from "@/lib/train/glimmer-serving";
import { HostError, type HostChatInput, type HostChatReply } from "@/lib/train/host/types";

export const HOST_CHAT_TIMEOUT_MS = 150_000;
export const WAKE_RETRY_SECONDS = 30;

export type Fetcher = typeof fetch;

export function chatBody(model: string, input: HostChatInput): Record<string, unknown> {
  const maxTokens = Math.min(input.maxTokens ?? GLIMMER_MAX_TOKENS.final, GLIMMER_MAX_TOKENS.cap);
  if (input.family === "glimmer") return glimmerChatBody({ model, messages: input.messages, maxTokens, stop: input.stop });
  return { model, messages: input.messages, max_tokens: maxTokens, ...(input.stop.length ? { stop: input.stop } : {}), stream: false };
}

export async function openAiChat(call: { baseUrl: string; key: string; model: string; input: HostChatInput; fetch?: Fetcher }): Promise<HostChatReply> {
  const signals = [AbortSignal.timeout(HOST_CHAT_TIMEOUT_MS), ...(call.input.signal ? [call.input.signal] : [])];
  let res: Response;
  try {
    res = await (call.fetch ?? fetch)(`${call.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${call.key}`, "content-type": "application/json" },
      body: JSON.stringify(chatBody(call.model, call.input)),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new HostError(504, "endpoint_waking", "The model didn't answer in time. It may still be waking up, so try again soon.", WAKE_RETRY_SECONDS);
    }
    throw new HostError(502, "endpoint_unavailable", "The model's endpoint couldn't be reached. Try again soon.");
  }
  if (res.status === 503 || res.status === 425) {
    throw new HostError(503, "endpoint_waking", "The model is waking up. Try again soon.", WAKE_RETRY_SECONDS);
  }
  if (res.status === 400 || res.status === 422) throw new HostError(400, "bad_request", "The model's endpoint can't take that request.");
  if (!res.ok) throw new HostError(502, "endpoint_unavailable", "The model's endpoint didn't answer. Try again soon.");
  let body: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new HostError(502, "endpoint_unavailable", "The model's endpoint sent a reply that couldn't be read.");
  }
  const choice = body.choices?.[0];
  if (typeof choice?.message?.content !== "string") throw new HostError(502, "endpoint_unavailable", "The model's endpoint sent an empty reply.");
  return {
    text: choice.message.content,
    finish: choice.finish_reason === "length" ? "length" : "stop",
    usage: { input: Number(body.usage?.prompt_tokens) || 0, output: Number(body.usage?.completion_tokens) || 0 },
  };
}
