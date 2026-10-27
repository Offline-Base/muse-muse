import OpenAI from "openai";

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
