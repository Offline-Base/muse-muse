// The extension's popup: a starting point. Make it do what brief.md's "Browser extension" section says, in plain DOM
// code (no React, no packages). Network calls go only through productAction() from ./platform.js.
import { currentPage, productAction, ProductError, type PageInfo } from "./platform.js";

/** The product's action this popup runs. Replace it with one from musemuse.json. */
const ACTION = "replace_with_action";

const app = document.getElementById("app") as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(page: PageInfo | null): void {
  app.replaceChildren();
  app.append(el("h1", "title", document.title));
  const where = el("p", "hint", page ? page.title || page.url : "Open a web page, then click the extension again.");
  app.append(where);
  const button = el("button", "btn primary", "Run on this page");
  button.type = "button";
  button.disabled = !page;
  const out = el("div", "result");
  const note = el("p", "note", "Sends this page's title and address when you click. Nothing else on the page is read.");
  button.addEventListener("click", async () => {
    if (!page) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Working...";
    out.replaceChildren();
    try {
      const reply = await productAction<Record<string, unknown>>(ACTION, { url: page.url, title: page.title });
      // Show the reply's fields as words, never as raw JSON.
      const text = Object.values(reply ?? {}).find((v): v is string => typeof v === "string");
      out.append(el("p", "", text ?? "Done."));
    } catch (err) {
      out.append(el("p", "error", err instanceof ProductError ? err.message : "Something went wrong. Try again."));
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Run on this page";
    }
  });
  app.append(button, out, note);
}

render(await currentPage().catch(() => null));
