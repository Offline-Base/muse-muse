import OpenAI from "openai";

/**
 * Client for a self-hosted Muse Glimmer endpoint (vLLM, SGLang or llama.cpp server).
 * Glimmer is open weights and isn't on the Meta Model API, so this returns null unless GLIMMER_URL is set.
 */
export function glimmerClient(): OpenAI | null {
  const baseURL = process.env.GLIMMER_URL?.trim().replace(/\/+$/, "");
  // Self-hosted servers often run without a key, but the SDK needs a non-empty one.
  return baseURL ? new OpenAI({ baseURL, apiKey: process.env.GLIMMER_API_KEY || "none" }) : null;
}
