import { after } from "next/server";
import { docsDeps } from "@/lib/docs/proxy/deps";
import { handleDocsAsk, type DocsPages } from "@/lib/docs/proxy/handler";
import { docsMarkdown, docsPage } from "@/lib/docs/pages";

// "Ask about this page": a streamed Responses call grounded in the page's Markdown (lib/docs/proxy/ask.ts). The same
// 300 s as the proxy, whose upstream deadline (290 s) it shares, so a slow answer is still metered.
export const runtime = "nodejs";
export const maxDuration = 300;

const pages: DocsPages = {
  page(slug) {
    const page = docsPage(slug);
    return page ? { title: page.title, markdown: docsMarkdown(slug) } : null;
  },
};

export async function POST(req: Request) {
  return handleDocsAsk(req, docsDeps((task) => after(task)), pages);
}
