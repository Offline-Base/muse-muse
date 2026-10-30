import { markdownForCopy } from "@/lib/docs/markdown-text";
import { DOCS_PAGES, docsMarkdown, docsPage } from "@/lib/docs/pages";

// The copy-ready Markdown behind "Copy page", fetched on click so pages don't carry their Markdown twice.
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS_PAGES.map((p) => ({ slug: p.slug.split("/") }));
}

/** A mirrored page's Markdown with the {#id} anchors removed and links made absolute (lib/docs/markdown-text). */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const slug = (await params).slug.join("/");
  if (!docsPage(slug)) return new Response("No such docs page.", { status: 404 });
  return new Response(markdownForCopy(docsMarkdown(slug), slug), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
