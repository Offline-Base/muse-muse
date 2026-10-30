import { buildSearchIndex } from "@/lib/docs/search";
import { DOCS_PAGES, docsMarkdown, docsNav } from "@/lib/docs/pages";

// Built once at build time from the mirror; it only changes when `npm run docs:sync` does.
export const dynamic = "force-static";

/** The docs search index the palette loads: titles, sidebar labels, descriptions, sections and H2/H3 anchors. */
export function GET() {
  return Response.json(buildSearchIndex({ pages: DOCS_PAGES, nav: docsNav(), markdown: docsMarkdown }));
}
