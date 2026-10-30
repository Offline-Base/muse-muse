import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocsPageProvider, type DocsPageInfo } from "@/components/docs/kit/DocsPageContext";
import { PageActions } from "@/components/docs/page/PageActions";
import { Pager } from "@/components/docs/page/Pager";
import { neighbors, pageSequence } from "@/components/docs/page/sequence";
import { Toc, TocToggle, type TocEntry } from "@/components/docs/page/Toc";
import { TryItLive } from "@/components/docs/page/TryItLive";
import { DOCS_NAV } from "@/components/shell/docs-nav";
import { demoFor } from "@/lib/docs/demos";
import { loadDocsDoc, renderBlocks, renderInlines } from "@/lib/docs/markdown-react";
import { swapEmDashes, syncedDate } from "@/lib/docs/markdown-text";
import { DOCS_PAGES, DOCS_SOURCE, docsPage } from "@/lib/docs/pages";

// Every mirrored page and nothing else: an unknown slug is a 404 (docs/DOCS_MIRROR.md, "Routes"). The page calls
// notFound() itself rather than setting dynamicParams = false, so the 404 renders inside the docs layout
// (app/docs/not-found.tsx, with docs.css for the docs sidebar and the search palette) instead of bare.
export function generateStaticParams() {
  return DOCS_PAGES.map((p) => ({ slug: p.slug.split("/") }));
}

interface Props {
  params: Promise<{ slug: string[] }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = docsPage((await params).slug.join("/"));
  if (!page) return { title: "Page not found" };
  return { title: swapEmDashes(page.title, "heading"), description: swapEmDashes(page.description) };
}

/** Reading order for Previous and Next: the sidebar, then the pages it doesn't list. */
const SEQUENCE = pageSequence(DOCS_NAV, DOCS_PAGES);

/**
 * One mirrored page (docs/DOCS_MIRROR.md, "Page layout"). The reading column is Meta's page as it is: the H1, the text
 * with Run buttons on its API calls, previous and next, and the mirror credit. What Muse Muse adds sits beside it: under
 * "On this page" on wide screens, the actions (Try it live, Copy prompt, Copy page, View on dev.meta.ai) and, on
 * narrower screens, a row of them under the H1 with a "Table of contents" pill. "Try it live" opens the page's demo and
 * chat in a side panel, so a reader can keep the text in view.
 */
export default async function DocsPage({ params }: Props) {
  const slug = (await params).slug.join("/");
  const page = docsPage(slug);
  if (!page) notFound();

  const doc = await loadDocsDoc(slug);
  const demo = demoFor(slug);
  const info: DocsPageInfo = {
    slug,
    title: swapEmDashes(page.title, "heading"),
    description: swapEmDashes(page.description),
    sourceUrl: page.sourceUrl,
    markdownUrl: page.markdownUrl,
  };
  const { prev, next } = neighbors(SEQUENCE, slug);
  const toc: TocEntry[] = doc.toc;
  const Demo = demo?.Component;

  return (
    <DocsPageProvider page={info}>
      <div className="docs-grid">
        <article className="docs-article">
          <h1 id={doc.titleId || undefined} className="docs-h1">
            {doc.title.length ? renderInlines(doc.title, "title") : info.title}
          </h1>
          <div className="docs-narrow-only">
            <PageActions page={info} spec={demo?.agentPrompt ?? null} variant="inline" />
            <TocToggle items={toc} />
          </div>
          {renderBlocks(doc.lead, "lead", { slug })}
          {renderBlocks(doc.body, "body", { slug })}
          <Pager prev={prev} next={next} />
          <p className="docs-credit">
            Mirrored from{" "}
            <a href={page.sourceUrl} target="_blank" rel="noopener noreferrer">
              dev.meta.ai/docs/{slug}
            </a>{" "}
            (synced {syncedDate(DOCS_SOURCE.syncedAt)}). Text and examples © Meta. Live demos run on Muse Muse&apos;s key.
          </p>
        </article>
        <aside className="docs-aside">
          <Toc items={toc} />
          <PageActions page={info} spec={demo?.agentPrompt ?? null} variant="rail" />
        </aside>
      </div>
      <TryItLive slug={slug} title={demo?.title} blurb={demo?.blurb}>
        {Demo ? <Demo {...demo.props} slug={slug} /> : undefined}
      </TryItLive>
    </DocsPageProvider>
  );
}
