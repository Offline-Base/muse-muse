// Platform file (Muse Muse platform services). Don't edit: call it from route handlers and server actions.
//
// Opens one web page for the product's owner ({GATEWAY_URL}/browse) and returns its title, its text and a screenshot.
// `input` is exactly what the person typed, and the address must be in it: the gateway refuses any other page. The page
// opens in a sandbox that reaches only that one site. It follows no link to another site, never signs in, and never types
// into a password, code or card field. At most 5 click, type or wait steps, 30 seconds, and 5 pages a day per person.
// Anyone but the owner gets CapError sign_in_required. In a build it returns a recorded sample page with
// `simulated: true`, whatever the address: show it as you would a real one.
import type { RequestLike } from "@/lib/meta/client";
import { codeCall } from "@/lib/platform/exec";

export { CapError } from "@/lib/platform/exec";

export type PageStep = { type: "click"; selector: string } | { type: "type"; selector: string; text: string } | { type: "wait"; ms: number };

export interface OpenedPage {
  url: string;
  title: string;
  /** The page's visible text, up to 20,000 characters. */
  text: string;
  /** A data: URL for an <img>, or "" when the page was too big to picture. */
  screenshot: string;
  /** True for a build's sample page. */
  simulated?: boolean;
}

export async function openPage(request: RequestLike | null | undefined, page: { url: string; input: string; actions?: PageStep[] }): Promise<OpenedPage> {
  const reply = await codeCall<OpenedPage>(request, "/browse", { url: page.url, input: page.input, ...(page.actions?.length ? { actions: page.actions } : {}) }, "Opening pages");
  return { url: reply.url, title: reply.title ?? "", text: reply.text ?? "", screenshot: reply.screenshot ?? "", ...(reply.simulated ? { simulated: true } : {}) };
}
