import OpenAI from "openai";
import { clientIpHeaders, type RequestLike } from "./client";

/** Show this with every answer, word for word. */
export const FLEET_LABEL = "Answered on boards we run, with no cloud model. Your text passes through this product's server, Muse Muse, ngrok and our lead board, so don't send private things.";
/** What `text` holds when the boards can't answer. */
export const FLEET_OFFLINE = "The Jetson fleet is offline or busy right now, so there's no answer. Try again in a few minutes.";

export interface FleetMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface FleetAnswer {
  /** The boards' answer, or FLEET_OFFLINE. Always something to show. */
  text: string;
  /** False when `text` is FLEET_OFFLINE. */
  answered: boolean;
  /** FLEET_LABEL with an answer, null without one. */
  label: string | null;
}

/** Longer than the gateway's slowest answer. */
const FLEET_TIMEOUT_MS = 115_000;
/** The platform chooses what runs on the boards, so this only names the endpoint's one choice. */
const FLEET_MODEL = "jetson-fleet";

/**
 * One whole answer from the Jetson fleet, through this product's gateway address and token. Server only. It never throws, and
 * on any failure it gives the fixed words in FLEET_OFFLINE: no other model ever answers in its place.
 *
 * Pass the incoming request (or `await headers()`), so the gateway can rate limit each visitor.
 */
export async function askFleetOrMessage(input: { messages: FleetMessage[]; request?: RequestLike | null }): Promise<FleetAnswer> {
  try {
    const gateway = process.env.GATEWAY_URL?.trim().replace(/\/+$/, "");
    if (!gateway) throw new Error("no gateway");
    const client = new OpenAI({ baseURL: `${gateway}/fleet/v1`, apiKey: process.env.PRODUCT_TOKEN || "none" });
    // Only a role and text: the gateway refuses any other field, such as a chat UI's own id.
    const messages = input.messages.map(({ role, content }) => ({ role, content }));
    const data = await client.chat.completions.create(
      { model: FLEET_MODEL, messages },
      { headers: clientIpHeaders(input.request), timeout: FLEET_TIMEOUT_MS, maxRetries: 0 },
    );
    const text = data.choices[0]?.message?.content?.trim();
    if (text) return { text, answered: true, label: FLEET_LABEL };
  } catch (err) {
    // Every failure gives the same words below, so nothing about the fleet reaches a page. The log says why, with only the
    // status and the gateway's code (a 400 text_only is this code's mistake), never the messages or an error's text.
    const { status, code } = (err ?? {}) as { status?: unknown; code?: unknown };
    console.error("[fleet]", typeof status === "number" ? status : "no answer", ...(typeof code === "string" ? [code.slice(0, 40)] : []));
  }
  return { text: FLEET_OFFLINE, answered: false, label: null };
}
