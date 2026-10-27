import OpenAI from "openai";

/**
 * OpenAI SDK client pointed at the Muse Muse gateway.
 *
 * The gateway mirrors the Meta Model API paths (https://api.meta.ai/v1) and adds the real key on the server,
 * so product code never holds a Meta key. Server code only: GATEWAY_URL and PRODUCT_TOKEN don't exist in the browser.
 */
export function metaClient(): OpenAI {
  const gateway = process.env.GATEWAY_URL;
  const token = process.env.PRODUCT_TOKEN;
  if (!gateway || !token) {
    throw new Error("GATEWAY_URL and PRODUCT_TOKEN must be set on the server.");
  }
  return new OpenAI({ baseURL: `${gateway.replace(/\/$/, "")}/v1`, apiKey: token });
}
