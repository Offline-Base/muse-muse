import type OpenAI from "openai";
import { metaClient, type RequestLike } from "./client";
import { plain } from "./text";

/**
 * Muse Spark Open, Meta's open-weight model, through this product's gateway address and token. The platform runs it on a
 * hosted provider and holds the provider's key, so this code never has one. Server only. Use it only when the brief lists
 * muse-spark-open: the gateway refuses it for any other product.
 */

/** The id the brief lists. The gateway serves it at /v1/chat/completions. */
export const SPARK_OPEN_MODEL = "muse-spark-open";

/** Show this in the footer of every product that uses Muse Spark Open, word for word. Its license asks for it. */
export const SPARK_OPEN_CREDIT = "Built with Muse Spark Open. For people 18 and over only.";

/** The reply header the gateway sets to the provider that ran the call. */
const HOST_HEADER = "x-musemuse-served-on";
const HOSTS = ["Baseten", "Fireworks"];

/** The label beside an answer: "Muse Spark Open, on Baseten", or "Muse Spark Open" when the gateway didn't say where. */
export function sparkOpenLabel(host: string | null | undefined): string {
  return host && HOSTS.includes(host) ? `Muse Spark Open, on ${host}` : "Muse Spark Open";
}

/** Its reasoning counts toward maxTokens, so leave room for it before the answer. */
export const SPARK_OPEN_DEFAULTS = { maxTokens: 2_000, reasoning: "low" } as const;

/**
 * An answer can take half a minute to start (the Nov 2 smoke call on Baseten: 33 s), so a call waits longer than metaClient's
 * 90 s, inside a route's maxDuration of 120. No retry: a call that timed out may still have run and been billed, so the page
 * offers its own retry instead.
 */
const REQUEST = { timeout: 115_000, maxRetries: 0 } as const;

export type SparkOpenPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type SparkOpenMessage = { role: "user"; content: string | SparkOpenPart[] } | { role: "assistant"; content: string };

export interface SparkOpenOptions {
  /** What it does and how it answers. Server only, so visitors can't change it. */
  instructions?: string;
  /** Oldest first, ending with the visitor's message. Images go in as `{ type: "image_url", image_url: { url } }` parts. */
  messages: SparkOpenMessage[];
  /** The most tokens one reply may use, reasoning included. */
  maxTokens?: number;
  /** How much it reasons first. "low" suits most steps; more reasoning is slower and costs more. */
  reasoning?: "low" | "medium" | "high";
  /** Ask for a JSON object. Parse and check it yourself (zod), and handle a reply that doesn't parse. */
  json?: boolean;
}

export interface SparkOpenAnswer {
  /** The answer, with em dashes taken out. */
  text: string;
  /** Show it with the answer, word for word. */
  label: string;
}

function params(options: SparkOpenOptions) {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    ...(options.instructions ? [{ role: "system" as const, content: options.instructions }] : []),
    ...options.messages,
  ];
  return {
    model: SPARK_OPEN_MODEL,
    messages,
    max_tokens: options.maxTokens ?? SPARK_OPEN_DEFAULTS.maxTokens,
    reasoning_effort: options.reasoning ?? SPARK_OPEN_DEFAULTS.reasoning,
    ...(options.json ? { response_format: { type: "json_object" as const } } : {}),
  };
}

/**
 * One whole answer. Throws when the call fails or no answer came back, for example when the reasoning used all of maxTokens:
 * catch it in the route and show a plain error with a retry.
 */
export async function askSparkOpen(request: RequestLike | null | undefined, options: SparkOpenOptions): Promise<SparkOpenAnswer> {
  const { data, response } = await metaClient(request).chat.completions.create({ ...params(options), stream: false }, REQUEST).withResponse();
  const choice = data.choices[0];
  const text = choice?.message?.content?.trim();
  if (!text) {
    throw new Error(
      choice?.finish_reason === "length"
        ? "Muse Spark Open reasoned through all of maxTokens and gave no answer. Raise maxTokens or lower reasoning."
        : "Muse Spark Open gave no answer.",
    );
  }
  return { text: plain(text), label: sparkOpenLabel(response.headers.get(HOST_HEADER)) };
}

/**
 * The answer as plain text, as it's written, and its label. Return the stream from a route:
 * `new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "x-label": label } })`.
 * Only the answer streams, never the reasoning.
 */
export async function sparkOpenStream(request: RequestLike | null | undefined, options: SparkOpenOptions): Promise<{ stream: ReadableStream<Uint8Array>; label: string }> {
  const { data: chunks, response } = await metaClient(request).chat.completions.create({ ...params(options), stream: true }, REQUEST).withResponse();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of chunks) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) controller.enqueue(encoder.encode(delta.replace(/\u2014/g, ", ")));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return { stream, label: sparkOpenLabel(response.headers.get(HOST_HEADER)) };
}
