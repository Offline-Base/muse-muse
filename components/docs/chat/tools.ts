import { writeComposerDraft } from "@/components/composer/Composer";
import { docsCommand } from "@/components/docs/kit/DocsPageContext";
import { CHAT_IMAGES_PER_STEP, clipResult, isChatImageSrc, matchLabel, readerOnlyReason } from "@/lib/docs/client/assistant";
import { searchDocs, type SearchIndex } from "@/lib/docs/search";

/**
 * The docs assistant's tools, carried out on the page itself: what they do is what a reader could do by hand, so a
 * demo's own limits, notices and errors all still apply. They read and press what's visible, so they work on every
 * demo without each one having to expose anything. Each returns the text the model reads next, and throws a ToolError
 * when the model should hear why it couldn't.
 */

export class ToolError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | null | undefined | false, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(120);
  }
}

let index: Promise<SearchIndex> | null = null;

function searchIndex(): Promise<SearchIndex> {
  index ??= fetch("/docs/search.json").then((res) => {
    if (!res.ok) throw new ToolError("The docs search isn't available right now.");
    return res.json() as Promise<SearchIndex>;
  });
  index.catch(() => (index = null));
  return index;
}

const visible = (el: Element): boolean => (el as HTMLElement).offsetParent !== null;

export function currentSlug(): string | null {
  const match = /^\/docs\/(.+?)\/?$/.exec(window.location.pathname);
  return match ? match[1] : null;
}

/** The open panel's visible demo. Opens the panel, and waits for the demo to mount. */
async function demoPanel(): Promise<HTMLElement> {
  if (!currentSlug()) throw new ToolError("The reader isn't on a docs page. Open one first.");
  const panel = () => document.querySelector<HTMLElement>("#try-it-live");
  if (await waitFor(panel, 4_000)) {
    docsCommand("open-try", { tab: "demo" });
    const found = await waitFor(() => {
      const open = panel();
      if (!open || open.hidden) return null;
      const body = open.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
      return body && !body.querySelector(".pg-ask") && body.querySelector("button, input, select, textarea") ? body : null;
    }, 8_000);
    if (found) return found;
  }
  throw new ToolError("This page has no live demo. It still has the chat under Try it live, and you can answer from the page.");
}

function fieldLabel(el: HTMLElement): string {
  const named = el.getAttribute("aria-label") ?? (el as HTMLInputElement).labels?.[0]?.innerText ?? el.closest("label")?.innerText;
  return (named || (el as HTMLInputElement).placeholder || el.getAttribute("name") || el.tagName.toLowerCase()).replace(/\s+/g, " ").trim().slice(0, 80);
}

function fields(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("input, select, textarea")].filter((el) => visible(el) && (el as HTMLInputElement).type !== "file" && (el as HTMLInputElement).type !== "hidden");
}

function buttons(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].filter((b) => visible(b) && b.innerText.trim() && !b.closest(".md-code-head"));
}

const buttonLabel = (b: HTMLButtonElement) => b.innerText.replace(/\s+/g, " ").trim();

/** Sets a field the way typing does, so React's own handlers see it. */
function setValue(el: HTMLElement, value: string): void {
  if (el instanceof HTMLSelectElement) {
    const option = matchLabel([...el.options].map((o) => o.text), value);
    const chosen = [...el.options].find((o) => o.text === option || o.value === value);
    if (!chosen) throw new ToolError(`That dropdown has no "${value}". Its options: ${[...el.options].map((o) => o.text).join(", ")}.`);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(el, chosen.value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    if (el.checked !== /^(true|yes|on|1)$/i.test(value)) el.click();
    return;
  }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** The demo as text: its fields, its buttons, and what it has shown so far. */
function describeDemo(root: HTMLElement): string {
  const fieldLines = fields(root).map((el) => {
    const input = el as HTMLInputElement;
    if (el instanceof HTMLSelectElement) return `- ${fieldLabel(el)} (dropdown: ${[...el.options].map((o) => o.text).join(", ")}): ${el.selectedOptions[0]?.text ?? ""}`;
    if (input.type === "checkbox" || input.type === "radio") return `- ${fieldLabel(el)} (${input.type}): ${input.checked}`;
    return `- ${fieldLabel(el)}: ${input.value.slice(0, 300)}`;
  });
  const out = demoOutput(root);
  return clipResult(
    [
      `Page: ${currentSlug()}`,
      fieldLines.length ? `Fields:\n${fieldLines.join("\n")}` : "No fields.",
      `Buttons: ${[...new Set(buttons(root).map(buttonLabel))].slice(0, 30).join(" | ") || "none"}`,
      out ? `Output:\n${out}` : "No output yet.",
    ].join("\n\n"),
  );
}

function demoOutput(root: HTMLElement): string {
  const parts = [...root.querySelectorAll<HTMLElement>(".pg-error, .pg-response, .pg-final, .pg-transcript, .pg-reply")].filter(
    (el, _, all) => visible(el) && !all.some((other) => other !== el && other.contains(el)),
  );
  const images = demoImages(root).length;
  const text = parts.map((el) => el.innerText.trim()).filter(Boolean).join("\n\n");
  return [text, images ? `(${images} image${images === 1 ? "" : "s"} shown in the panel and in the chat)` : ""].filter(Boolean).join("\n");
}

/** The images a demo has generated, newest last: its output, not the samples and uploads it takes as input. */
function demoImages(root: HTMLElement): string[] {
  const shown = [...root.querySelectorAll<HTMLImageElement>("figure img, .pg-response img, .pg-final img")].filter((img) => visible(img) && isChatImageSrc(img.src));
  return [...new Set(shown.map((img) => img.src))].slice(-CHAT_IMAGES_PER_STEP);
}

const BUSY = '.pg-stop, .pg-run[aria-busy="true"], .pg-status-busy, .pg-wait, .md[data-streaming], [aria-busy="true"], .spinner';

/** Waits until the demo stops working, for at most `ms`. True when it finished. */
async function settled(root: HTMLElement, ms: number, signal: AbortSignal): Promise<boolean> {
  await sleep(900);
  const deadline = Date.now() + ms;
  let quiet = 0;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      root.querySelector<HTMLButtonElement>(".pg-stop")?.click();
      return true;
    }
    // A demo stopped on an approval has finished as far as the assistant goes: only the reader can move it on.
    const waiting = buttons(root).some((b) => /^\d+\)\s|acknowledge|approve/i.test(buttonLabel(b)));
    quiet = root.querySelector(BUSY) && !waiting ? 0 : quiet + 1;
    if (quiet >= 3) return true;
    await sleep(400);
  }
  return false;
}

export type ToolContext = {
  signal: AbortSignal;
  /** Client-side navigation, from the sidebar's router. */
  navigate: (href: string) => void;
  /** Shows what a demo generated in the chat. */
  showImages: (srcs: string[]) => void;
};

/** Runs one tool. Returns what the model reads next. */
export async function runTool(name: string, args: Record<string, string>, ctx: ToolContext): Promise<string> {
  switch (name) {
    case "search_docs": {
      const hits = searchDocs(await searchIndex(), args.query ?? "", 8);
      if (!hits.length) return `Nothing matched "${args.query}". Try other words, or look through the page list.`;
      return hits.map((h) => `${h.href.replace(/^\/docs\//, "")}: ${h.title}${h.context ? ` (${h.context})` : ""}`).join("\n");
    }
    case "read_page": {
      const res = await fetch(`/docs/md/${(args.slug ?? "").replace(/^\/?(docs\/)?/, "")}`);
      if (!res.ok) throw new ToolError(`No docs page "${args.slug}". Use search_docs to find its slug.`);
      return clipResult(await res.text());
    }
    case "open_page": {
      const slug = (args.slug ?? "").replace(/^\/?(docs\/)?/, "").replace(/#.*$/, "");
      const { pages } = await searchIndex();
      if (!pages.some((p) => p.slug === slug)) throw new ToolError(`No docs page "${slug}". Use search_docs to find its slug.`);
      if (currentSlug() !== slug) {
        ctx.navigate(`/docs/${slug}`);
        const arrived = await waitFor(() => currentSlug() === slug && document.querySelector(".docs-article h1"), 15_000);
        if (!arrived) throw new ToolError("The page didn't open in time.");
        await sleep(300);
      }
      if (!args.section) return `The reader now sees ${slug}.`;
      const headings = [...document.querySelectorAll<HTMLElement>(".docs-article :is(h2, h3, h4)")];
      const label = matchLabel(headings.map((h) => h.innerText.replace(/#\s*$/, "").trim()), args.section);
      const heading = headings.find((h) => h.innerText.replace(/#\s*$/, "").trim() === label);
      if (!heading) return `The reader now sees ${slug}, but it has no section called "${args.section}".`;
      heading.scrollIntoView({ block: "start", behavior: "smooth" });
      return `The reader now sees ${slug}, at "${label}".`;
    }
    case "open_demo": {
      const root = await demoPanel();
      return describeDemo(root);
    }
    case "read_demo": {
      const root = await demoPanel();
      ctx.showImages(demoImages(root));
      return describeDemo(root);
    }
    case "set_demo_field": {
      const root = await demoPanel();
      const all = fields(root);
      const label = matchLabel(all.map(fieldLabel), args.label ?? "");
      const field = all.find((el) => fieldLabel(el) === label);
      if (!field) throw new ToolError(`No field called "${args.label}". Fields: ${all.map(fieldLabel).join(", ") || "none"}.`);
      setValue(field, args.value ?? "");
      return `Set ${label}.`;
    }
    case "run_demo": {
      const root = await demoPanel();
      if (args.prompt) {
        const box = fields(root).find((el) => el instanceof HTMLTextAreaElement);
        if (!box) throw new ToolError("This demo has no text box to fill. Call read_demo to see what it has.");
        setValue(box, args.prompt);
        await sleep(150);
      }
      const all = buttons(root);
      const wanted = args.button ? matchLabel(all.map(buttonLabel), args.button) : null;
      if (args.button && !wanted) throw new ToolError(`No button called "${args.button}". Buttons: ${all.map(buttonLabel).join(" | ")}.`);
      const button = wanted ? all.find((b) => buttonLabel(b) === wanted) : (root.querySelector<HTMLButtonElement>(".pg-run:not(.pg-stop)") ?? all.find((b) => /^(run|send|generate|start|try)\b/i.test(buttonLabel(b))));
      if (!button) throw new ToolError(`This demo has no Run button. Buttons: ${all.map(buttonLabel).join(" | ") || "none"}.`);
      const blocked = readerOnlyReason(buttonLabel(button));
      if (blocked) throw new ToolError(blocked);
      if (button.disabled) throw new ToolError(`"${buttonLabel(button)}" is disabled right now. Call read_demo to see why.`);
      button.scrollIntoView({ block: "center" });
      button.click();
      const finished = await settled(root, 120_000, ctx.signal);
      ctx.showImages(demoImages(root));
      const after = describeDemo(root);
      return finished ? after : `The demo is still running after two minutes. Tell the reader it continues in the panel.\n\n${after}`;
    }
    case "open_build": {
      const slug = currentSlug();
      if (!slug) throw new ToolError("Open a docs page first: a build starts from a page.");
      if (args.idea) writeComposerDraft(`docs:${slug}`, args.idea.slice(0, 2_000));
      docsCommand("open-build");
      return "The build box is open, filled in. Nothing has started: the reader reads it and presses send.";
    }
    default:
      throw new ToolError(`There is no tool called ${name}.`);
  }
}
