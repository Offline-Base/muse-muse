import { after } from "next/server";
import { docsDeps } from "@/lib/docs/proxy/deps";
import { handleDocsAssistant, type DocsPages } from "@/lib/docs/proxy/handler";
import { DOCS_PAGES, docsMarkdown, docsPage } from "@/lib/docs/pages";

// The docs sidebar: one round of the assistant's loop, a streamed Responses call with its tools (lib/docs/proxy/
// assistant.ts). 300 s as the proxy, whose upstream deadline (290 s) it shares, so a slow answer is still metered.
export const runtime = "nodejs";
export const maxDuration = 300;

const pages: DocsPages = {
  page(slug) {
    const page = docsPage(slug);
    return page ? { title: page.title, markdown: docsMarkdown(slug) } : null;
  },
  catalog: () => DOCS_PAGES.map((p) => `${p.slug}: ${p.title}`).join("\n"),
};

export async function POST(req: Request) {
  return handleDocsAssistant(req, docsDeps((task) => after(task)), pages);
}
