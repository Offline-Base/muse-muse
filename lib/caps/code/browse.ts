import { isIP } from "node:net";
import { capError } from "@/lib/caps/gate";
import { BROWSE_LIMITS } from "@/lib/caps/code/limits";
import type { CodeSession } from "@/lib/caps/code/session";
import { isPublicHttpUrl, urlsInInput } from "@/lib/tools/args";

/**
 * What {GATEWAY_URL}/browse opens and how (docs/CAPABILITIES.md, section 15): one page whose address appears in what the
 * person typed (`input`, the person's own words), in a sandbox whose firewall reaches only that host
 * (lib/caps/code/policy.ts browsePolicy). It returns the page's title, its text and a screenshot. It never logs in:
 * typing into a password, one-time code or card field is refused, and so is a page that is an IP address, a private
 * address, another port, or an address with a user name in it.
 */

export type BrowseAction = { type: "click"; selector: string } | { type: "type"; selector: string; text: string } | { type: "wait"; ms: number };

export interface BrowseArgs {
  url: string;
  host: string;
  actions: BrowseAction[];
}

export interface BrowsePage {
  url: string;
  title: string;
  text: string;
  /** A data: URL, a JPEG of the page (a sample's is an SVG). */
  screenshot: string;
}

/** What the person typed must have this address in it, with or without its scheme, the same way the tool gateway reads it. */
export function typedByPerson(url: string, input: string): boolean {
  const [want] = [...urlsInInput(url)];
  return Boolean(want) && urlsInInput(input).has(want!);
}

/** Field names that mean signing in or paying, in a selector or a typed field's attributes. */
const SECRET_FIELD = /pass(word)?|pwd|otp|one-?time|2fa|totp|cc-|card|cvc|cvv|secret|token|login|signin|sign-in/i;

function readAction(raw: unknown): BrowseAction | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Each action is {type, ...}.";
  const a = raw as Record<string, unknown>;
  const keys = Object.keys(a);
  const selector = (k = "selector") => (typeof a[k] === "string" && (a[k] as string).trim() && (a[k] as string).length <= BROWSE_LIMITS.selectorMaxChars ? (a[k] as string) : null);
  if (a.type === "click") {
    if (keys.some((k) => !["type", "selector"].includes(k))) return "A click has a selector and nothing else.";
    const s = selector();
    return s ? { type: "click", selector: s } : `A click needs a selector of up to ${BROWSE_LIMITS.selectorMaxChars} characters.`;
  }
  if (a.type === "type") {
    if (keys.some((k) => !["type", "selector", "text"].includes(k))) return "A type action has a selector and text and nothing else.";
    const s = selector();
    if (!s) return `A type action needs a selector of up to ${BROWSE_LIMITS.selectorMaxChars} characters.`;
    if (SECRET_FIELD.test(s)) return "Browsing never signs in, so it doesn't type into password, code or card fields.";
    if (typeof a.text !== "string" || a.text.length > BROWSE_LIMITS.typeMaxChars) return `A type action's text is up to ${BROWSE_LIMITS.typeMaxChars} characters.`;
    return { type: "type", selector: s, text: a.text };
  }
  if (a.type === "wait") {
    if (keys.some((k) => !["type", "ms"].includes(k))) return "A wait has ms and nothing else.";
    return Number.isInteger(a.ms) && (a.ms as number) >= 0 && (a.ms as number) <= BROWSE_LIMITS.waitMaxMs ? { type: "wait", ms: a.ms as number } : `A wait is 0 to ${BROWSE_LIMITS.waitMaxMs} ms.`;
  }
  return "An action's type is click, type or wait.";
}

/** The request's arguments, checked, before any lookup. The host's addresses are checked after (publicHost). */
export function readBrowseArgs(body: Record<string, unknown>): BrowseArgs | Response {
  const extra = Object.keys(body).filter((k) => !["url", "input", "actions"].includes(k));
  if (extra.length) return capError("invalid_arguments", `Unknown ${extra.length === 1 ? "field" : "fields"}: ${extra.slice(0, 5).join(", ")}.`);
  if (typeof body.url !== "string" || !body.url || body.url.length > BROWSE_LIMITS.urlMaxChars) return capError("invalid_arguments", "Send the page's address as url.");
  if (typeof body.input !== "string" || !body.input.trim() || body.input.length > BROWSE_LIMITS.inputMaxChars) {
    return capError("invalid_arguments", `Send what the person typed as input, up to ${BROWSE_LIMITS.inputMaxChars} characters.`);
  }
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(body.url) ? body.url : `https://${body.url}`);
  } catch {
    return capError("invalid_arguments", "That isn't a web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return capError("invalid_arguments", "Only http and https pages can be opened.");
  if (url.username || url.password) return capError("invalid_arguments", "Browsing never signs in, so an address can't carry a user name or password.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, ""))) return capError("invalid_arguments", "Open a site by its name, not an IP address.");
  if (url.port && !(url.protocol === "https:" ? ["443"] : ["80"]).includes(url.port)) return capError("invalid_arguments", "Only a site's usual port can be opened.");
  if (!isPublicHttpUrl(url.href)) return capError("invalid_arguments", "That address isn't a public website.");
  if (!typedByPerson(url.href, body.input)) return capError("invalid_arguments", "Only a page whose address the person typed can be opened. Its address must be in input.");
  const actions: BrowseAction[] = [];
  if (body.actions !== undefined && body.actions !== null) {
    if (!Array.isArray(body.actions) || body.actions.length > BROWSE_LIMITS.actionsMax) return capError("invalid_arguments", `actions is a list of at most ${BROWSE_LIMITS.actionsMax} clicks, types or waits.`);
    for (const raw of body.actions) {
      const a = readAction(raw);
      if (typeof a === "string") return capError("invalid_arguments", a);
      actions.push(a);
    }
  }
  url.hash = "";
  return { url: url.href, host, actions };
}

/** The script the browse sandbox runs, from the builder snapshot's Playwright. It reads its arguments from a file. */
export const BROWSE_DIR = "/tmp/mm-browse";
export const BROWSE_SCRIPT = String.raw`
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const args = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { chromium } = createRequire("/vercel/app/package.json")("@playwright/test");
const SECRET = new RegExp(args.secretField, "i");
const out = { ok: false };
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: "block" });
  const page = await context.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
  for (const a of args.actions) {
    if (a.type === "wait") await page.waitForTimeout(a.ms);
    else if (a.type === "click") await page.locator(a.selector).first().click({ timeout: 3000 });
    else if (a.type === "type") {
      const field = page.locator(a.selector).first();
      const kind = [await field.getAttribute("type"), await field.getAttribute("name"), await field.getAttribute("autocomplete"), await field.getAttribute("id")].filter(Boolean).join(" ");
      if (SECRET.test(kind)) throw new Error("secret-field");
      await field.fill(a.text, { timeout: 3000 });
    }
  }
  const shot = await page.screenshot({ type: "jpeg", quality: 55 });
  out.ok = true;
  out.url = page.url();
  out.title = (await page.title()).slice(0, args.titleMax);
  out.text = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).slice(0, args.textMax);
  out.screenshot = shot.length <= args.shotMax ? shot.toString("base64") : "";
} catch (err) {
  out.error = String((err && err.message) || err).slice(0, 300);
} finally {
  await browser.close().catch(() => {});
  writeFileSync(args.out, JSON.stringify(out));
}
`;

export interface BrowseOutcome {
  ok: boolean;
  page?: BrowsePage;
  /** Plain words for the person. */
  problem?: string;
}

/** Opens the page in a session that is already up, with only the page's host reachable. */
export async function runBrowse(session: CodeSession, args: BrowseArgs): Promise<BrowseOutcome> {
  const config = {
    url: args.url,
    actions: args.actions,
    secretField: SECRET_FIELD.source,
    titleMax: BROWSE_LIMITS.titleMaxChars,
    textMax: BROWSE_LIMITS.textMaxChars,
    shotMax: BROWSE_LIMITS.screenshotMaxBytes,
    out: `${BROWSE_DIR}/out.json`,
  };
  await session.writeFiles([
    { path: `${BROWSE_DIR}/browse.mjs`, content: Buffer.from(BROWSE_SCRIPT, "utf8") },
    { path: `${BROWSE_DIR}/args.json`, content: Buffer.from(JSON.stringify(config), "utf8") },
  ]);
  await session.run("node", [`${BROWSE_DIR}/browse.mjs`, `${BROWSE_DIR}/args.json`], { timeoutMs: BROWSE_LIMITS.seconds * 1000 });
  return browseOutcomeOf(await session.readFile(`${BROWSE_DIR}/out.json`), args.host);
}

/** The reply from the script's file, checked again here: the page must still be on the host the person typed. */
export function browseOutcomeOf(raw: Buffer | null, host: string): BrowseOutcome {
  let out: { ok?: unknown; url?: unknown; title?: unknown; text?: unknown; screenshot?: unknown; error?: unknown } | null = null;
  try {
    out = raw ? JSON.parse(raw.toString("utf8")) : null;
  } catch {
    out = null;
  }
  if (!out) return { ok: false, problem: `The page didn't open within ${BROWSE_LIMITS.seconds} seconds.` };
  if (out.ok !== true) {
    const error = typeof out.error === "string" ? out.error : "";
    if (error === "secret-field") return { ok: false, problem: "Browsing never signs in, so it doesn't type into password, code or card fields." };
    if (/timeout/i.test(error)) return { ok: false, problem: "The page or one of its steps took too long." };
    if (/net::|ERR_/i.test(error)) return { ok: false, problem: "That site couldn't be reached." };
    return { ok: false, problem: "That page couldn't be opened." };
  }
  let finalHost = "";
  try {
    finalHost = new URL(String(out.url)).hostname.toLowerCase();
  } catch {
    finalHost = "";
  }
  if (finalHost !== host) return { ok: false, problem: "That page sent the browser to another site, which browsing doesn't follow." };
  const screenshot = typeof out.screenshot === "string" && /^[A-Za-z0-9+/]+=*$/.test(out.screenshot) ? `data:image/jpeg;base64,${out.screenshot}` : "";
  return {
    ok: true,
    page: {
      url: String(out.url),
      title: typeof out.title === "string" ? out.title.slice(0, BROWSE_LIMITS.titleMaxChars) : "",
      text: typeof out.text === "string" ? out.text.slice(0, BROWSE_LIMITS.textMaxChars) : "",
      screenshot,
    },
  };
}
