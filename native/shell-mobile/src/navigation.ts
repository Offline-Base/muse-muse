// Decides what the WebView may load. Only the product's own origin stays in the app.

import { originOf } from "./bridge/router";

export type NavigationDecision = "allow" | "external" | "block";

/** Links the system can open safely. Anything else (intent:, file:, custom app schemes) goes nowhere. */
const EXTERNAL_SCHEMES = new Set(["https:", "http:", "mailto:", "tel:", "sms:"]);

/** Phone and text links can start a call or a message, so they get a stricter rule. See mayOpenExternally. */
const PHONE_SCHEMES = new Set(["tel:", "sms:"]);

/** A page that keeps navigating away can't open more than this. */
export const EXTERNAL_OPEN_LIMIT = { max: 3, perMs: 10_000 };
/** A page that keeps escaping the product stops getting put back after this many tries. */
export const REPIN_LIMIT = { max: 3, perMs: 30_000 };

/** Inner frames can use these without leaving the page. Each one is its own opaque origin. */
const INNER_FRAME_SCHEMES = new Set(["about:", "blob:", "data:", "https:", "http:"]);

function protocolOf(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/** True when going from one URL to the other only moves within a page, so the page keeps running. */
export function isSamePageJump(from: string | null | undefined, to: string): boolean {
  if (!from || from === to) return false;
  return from.split("#")[0] === to.split("#")[0];
}

/** The product's own pages stay in the app, and anything else goes to the system browser or is refused. */
export function decideNavigation(input: { url: string; productOrigin: string; isTopFrame?: boolean }): NavigationDecision {
  const { url, productOrigin, isTopFrame = true } = input;
  const protocol = protocolOf(url);
  if (!protocol) return "block";

  if (!isTopFrame) return INNER_FRAME_SCHEMES.has(protocol) ? "allow" : "block";

  // The empty page a WebView starts on, before the product loads.
  if (url === "about:blank") return "allow";
  if (originOf(url) === productOrigin) return "allow";
  return EXTERNAL_SCHEMES.has(protocol) ? "external" : "block";
}

/** The backstop for a top-level load that already started. Only a real URL off the product counts. */
export function leftTheProduct(url: unknown, productOrigin: string): boolean {
  return typeof url === "string" && url !== "" && decideNavigation({ url, productOrigin }) !== "allow";
}

/**
 * tel: and sms: links open only from a real click, so a page's script can't start them. iOS says how a navigation
 * started. Android always says "other", so there it's the rate limit that holds them back.
 */
export function mayOpenExternally(input: { url: string; navigationType?: string; gestureKnown: boolean }): boolean {
  const protocol = protocolOf(input.url);
  if (!protocol || !PHONE_SCHEMES.has(protocol) || !input.gestureKnown) return true;
  return input.navigationType === "click";
}

/** Says yes at most `max` times in any `perMs`. */
export function createRateLimiter(
  { max, perMs }: { max: number; perMs: number } = EXTERNAL_OPEN_LIMIT,
  now: () => number = Date.now,
): () => boolean {
  const times: number[] = [];
  return () => {
    const cutoff = now() - perMs;
    while (times.length > 0 && times[0] <= cutoff) times.shift();
    if (times.length >= max) return false;
    times.push(now());
    return true;
  };
}
