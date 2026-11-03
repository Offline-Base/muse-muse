import OpenAI from "openai";
import { clientIpHeaders, metaClient, type RequestLike } from "./client";

/**
 * A self-hosted Muse Glimmer endpoint (vLLM, SGLang or a llama.cpp server). Glimmer is open weights and isn't on the
 * Meta Model API, so this is null unless GLIMMER_URL is set. GLIMMER_MODEL names the served model (a fine-tune's
 * name, for example) and GLIMMER_API_KEY is only needed when the server asks for one.
 */
export function glimmer(): { client: OpenAI; model: string } | null {
  const baseURL = process.env.GLIMMER_URL?.trim().replace(/\/+$/, "");
  if (!baseURL) return null;
  // The SDK refuses an empty key, and keyless servers ignore whatever is sent.
  const client = new OpenAI({ baseURL, apiKey: process.env.GLIMMER_API_KEY || "none" });
  return { client, model: process.env.GLIMMER_MODEL?.trim() || "muse-glimmer" };
}

/**
 * GLIMMER_SHARED=1: Muse Muse's hosted Glimmer, through this product's own gateway address and token. Only askGlimmer uses
 * this, since it runs only during demo windows and askGlimmer handles the rest. glimmer() stays null, so code that calls it
 * directly keeps falling to Muse Wonder.
 */
function hostedGlimmer(): { client: OpenAI; model: string } | null {
  const gateway = process.env.GLIMMER_SHARED === "1" ? process.env.GATEWAY_URL?.trim().replace(/\/+$/, "") : "";
  if (!gateway) return glimmer();
  return { client: new OpenAI({ baseURL: `${gateway}/glimmer/v1`, apiKey: process.env.PRODUCT_TOKEN || "none" }), model: process.env.GLIMMER_MODEL?.trim() || "muse-glimmer" };
}

export interface GlimmerMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GlimmerAnswer {
  text: string;
  /** Who answered: this product's own tuned model, base Muse Glimmer, or Muse Wonder when neither was available. */
  by: "own" | "glimmer" | "wonder";
  /** One line to show next to the answer, or null. */
  note: string | null;
}

/** Longer than the gateway's slowest answer: a GPU takes a minute or more, one question at a time. */
const GLIMMER_TIMEOUT_MS = 170_000;
const TEST_HEADER = "x-musemuse-glimmer-test";
const WONDER = "muse-wonder-1.0";

/** The model that really answers a muse-wonder-1.0 call: the platform names a stand-in in NEXT_PUBLIC_MUSE_WONDER_SERVED_BY, like ModelChip. */
function wonderName(): string {
  return process.env.NEXT_PUBLIC_MUSE_WONDER_SERVED_BY === "muse-spark-1.3-contributor" ? "Muse Spark 1.3 Contributor" : "Muse Wonder";
}

function testHeaders(from?: RequestLike | null): Record<string, string> {
  if (!from) return {};
  const headers = "get" in from && typeof from.get === "function" ? from : (from as { headers: { get(name: string): string | null } }).headers;
  const value = headers.get(TEST_HEADER);
  return value ? { [TEST_HEADER]: value } : {};
}

/**
 * One answer from the hosted Muse Glimmer, or from Muse Wonder when it can't answer. Server only. Glimmer runs only during
 * demo windows, so a product must expect Muse Wonder most of the time and show `note`. `own: true` asks for this product's
 * own tuned model. Anything but a 400 (the request itself is wrong, and that throws) falls back: a closed window, a GPU
 * still starting or busy, no passing model yet, a timeout, or no Glimmer at all.
 *
 * Pass the incoming request (or `await headers()`), so the gateway can rate limit each visitor.
 */
export async function askGlimmer(input: { messages: GlimmerMessage[]; own?: boolean; request?: RequestLike | null }): Promise<GlimmerAnswer> {
  const own = input.own === true;
  const hosted = hostedGlimmer();
  if (hosted) {
    try {
      const { data, response } = await hosted.client.chat.completions
        .create(
          { model: own ? "own" : hosted.model, messages: input.messages },
          { headers: { ...clientIpHeaders(input.request), ...testHeaders(input.request) }, timeout: GLIMMER_TIMEOUT_MS, maxRetries: 0 },
        )
        .withResponse();
      const text = data.choices[0]?.message?.content?.trim();
      if (text) return { text, by: own ? "own" : "glimmer", note: response.headers.get("x-musemuse-note") };
    } catch (err) {
      if ((err as { status?: unknown }).status === 400) throw err;
    }
  }
  const res = await metaClient(input.request).responses.create({ model: WONDER, input: input.messages });
  return {
    text: res.output_text,
    by: "wonder",
    note: own ? `Answered by ${wonderName()} while this app's own model is off.` : `Answered by ${wonderName()} while Muse Glimmer is off.`,
  };
}
