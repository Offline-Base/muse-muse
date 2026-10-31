// Decides what the WebView may load. Only the product's own origin stays in the app.

import { originOf } from "./bridge/router";

export type NavigationDecision = "allow" | "external" | "block";

/** Links the system can open safely. Anything else (intent:, file:, custom app schemes) goes nowhere. */
const EXTERNAL_SCHEMES = new Set(["https:", "http:", "mailto:", "tel:", "sms:"]);

/** Inner frames can use these without leaving the page. Each one is its own opaque origin. */
const INNER_FRAME_SCHEMES = new Set(["about:", "blob:", "data:", "https:", "http:"]);

function protocolOf(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
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
