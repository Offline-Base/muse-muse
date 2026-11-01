// Platform file (Muse Muse platform services). Don't edit: import these in popup.ts, background.ts and a side panel.
//
// productAction is the only way the extension reaches the network: it POSTs to one of the product's own actions on its
// live link, which the platform writes into config.js when it packages the extension. The extension's content security
// policy allows only that link, so a call anywhere else fails in the browser as well as in verify's check.
/// <reference types="chrome" />
import { PRODUCT_ORIGIN } from "./config.js";

/** A failed action call, with a message to show the person as it is. */
export class ProductError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProductError";
  }
}

const ACTION = /^[a-z][a-z0-9_]{0,59}$/;

/**
 * Calls the product's action `name` (POST /api/actions/<name>) with JSON and returns its JSON reply. Throws ProductError
 * with plain words when it can't be reached, takes too long, or answers with an error.
 */
export async function productAction<T = unknown>(name: string, input: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  if (!ACTION.test(name)) throw new ProductError("That isn't one of this product's actions.", 0);
  let res: Response;
  try {
    res = await fetch(`${PRODUCT_ORIGIN}/api/actions/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-musemuse-client": "extension" },
      body: JSON.stringify(input ?? {}),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    throw new ProductError(timedOut ? "It took too long to answer. Try again." : "Couldn't reach it. Check your connection and try again.", 0);
  }
  const reply = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok) {
    const said = reply && typeof (reply as { error?: unknown }).error === "string" ? String((reply as { error: string }).error).slice(0, 300) : "";
    throw new ProductError(said || (res.status === 429 ? "It's busy right now. Try again in a minute." : "Something went wrong. Try again."), res.status);
  }
  if (reply === undefined) throw new ProductError("It answered with something this extension can't read.", res.status);
  return reply as T;
}

/** The page the person is on. */
export interface PageInfo {
  url: string;
  title: string;
}

/**
 * The address and title of the page the person is on. With activeTab, Chrome shares them only once the person has
 * clicked the extension, so call this from the popup or a click. Null when the browser doesn't share them, as for its
 * own pages. When the extension's own page is the active tab (it was opened as a tab), this is the tab used before it.
 */
export async function currentPage(): Promise<PageInfo | null> {
  const own = (t: chrome.tabs.Tab) => !t.url || t.url.startsWith(`${location.origin}/`);
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab: chrome.tabs.Tab | undefined = active && !own(active) ? active : undefined;
  if (!tab) {
    const others = (await chrome.tabs.query({ currentWindow: true })).filter((t) => !own(t));
    tab = others.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  }
  if (!tab?.url || !/^https?:/.test(tab.url)) return null;
  return { url: tab.url, title: (tab.title ?? "").slice(0, 300) };
}

/** The product's own link, for a "Open <product>" link in the popup. */
export const productOrigin = PRODUCT_ORIGIN;
