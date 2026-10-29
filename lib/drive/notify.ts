/**
 * Tells the owner about a new drive request (docs/VIBE_TUNING.md, Feature 6, "The request"): one line POSTed to
 * DRIVE_NOTIFY_URL, a Slack or Discord webhook. The line is ownerSummary's, which never holds the buyer's name, email
 * or address. A model's title is in it, and a vibe run's title comes from what someone typed, so the line can never
 * mention anyone: Slack's copy has its control characters escaped, and Discord is told to parse no mentions. Best
 * effort: it never throws, and the webhook's URL, a secret of its own, is never logged.
 */
import { env } from "@/lib/env";

const NOTIFY_TIMEOUT_MS = 5_000;

/** Slack's escaping of "&", "<" and ">", so "<!channel>" or "<@U123>" in a title is text, not a mention or a link. */
export function slackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The webhook's body: Slack reads "text" (escaped), Discord reads "content" with no mentions parsed (an "@everyone" stays text). */
export function notifyBody(text: string): string {
  return JSON.stringify({ text: slackText(text), content: text, allowed_mentions: { parse: [] } });
}

export async function notifyOwner(
  text: string,
  url: string | null = env.driveNotifyUrl,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!url) return false;
  try {
    // Slack reads "text" and Discord reads "content"; each ignores the other.
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: notifyBody(text),
      redirect: "error",
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) console.error("[drive] the notify webhook answered", res.status);
    return res.ok;
  } catch (err) {
    console.error("[drive] the notify webhook didn't answer:", err instanceof Error ? err.name : "error");
    return false;
  }
}
