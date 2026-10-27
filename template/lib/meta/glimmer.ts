import OpenAI from "openai";

/**
 * Client for a self-hosted Muse Glimmer endpoint (vLLM, SGLang or llama.cpp server).
 * Glimmer is open weights and isn't on the Meta Model API, so this returns null unless GLIMMER_URL is set.
 */
export function glimmerClient(): OpenAI | null {
  const url = process.env.GLIMMER_URL;
  if (!url) return null;
  return new OpenAI({ baseURL: url, apiKey: process.env.GLIMMER_API_KEY ?? "not-needed" });
}
