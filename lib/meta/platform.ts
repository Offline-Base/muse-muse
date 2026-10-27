import OpenAI from "openai";
import { env } from "@/lib/env";
import { UPSTREAM_BASE_URL } from "@/lib/gateway/policy";

let cached: OpenAI | null = null;

/**
 * OpenAI SDK client for the platform's own Meta calls (brief writer, judge). Uses the master key, so server only.
 * Products never get this: they call the gateway with a product token.
 */
export function metaPlatform(): OpenAI {
  if (!cached) cached = new OpenAI({ baseURL: UPSTREAM_BASE_URL, apiKey: env.modelApiKey, maxRetries: 2, timeout: 120_000 });
  return cached;
}
