import Link from "next/link";
import { SearchDocsButton } from "@/components/docs/page/SearchDocsButton";
import { DOCS_HOME } from "@/lib/docs/pages";

/**
 * An unknown /docs/<slug> (the page calls notFound()). It renders inside the docs layout, so the docs sidebar keeps
 * its styles and the search palette is there to find the page that was meant.
 */
export default function DocsNotFound() {
  return (
    <div className="docs-grid">
      <article className="docs-article">
        <h1 className="docs-h1">Page not found</h1>
        <p className="docs-p">
          There&apos;s no mirrored docs page at this address. The link may have a typo, or the page may have moved on
          dev.meta.ai since the last sync.
        </p>
        <div className="docs-actions">
          <Link className="docs-btn docs-btn-primary" href={DOCS_HOME}>
            Go to the overview
          </Link>
          <SearchDocsButton />
        </div>
      </article>
    </div>
  );
}
