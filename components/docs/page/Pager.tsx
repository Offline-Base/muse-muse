import Link from "next/link";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/docs/page/icons";
import type { SequenceEntry } from "@/components/docs/page/sequence";
import { swapEmDashes } from "@/lib/docs/markdown-text";

/** Previous and next page at the bottom of a docs page, in sidebar order (components/docs/page/sequence.ts). */
export function Pager({ prev, next }: { prev: SequenceEntry | null; next: SequenceEntry | null }) {
  if (!prev && !next) return null;
  return (
    <nav className="docs-pager" aria-label="Previous and next page">
      {prev ? (
        <Link href={`/docs/${prev.slug}`} className="docs-pager-link" rel="prev">
          <span className="docs-pager-dir">
            <ChevronLeftIcon size={16} />
            Previous
          </span>
          <span className="docs-pager-title">{swapEmDashes(prev.title, "heading")}</span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link href={`/docs/${next.slug}`} className="docs-pager-link is-next" rel="next">
          <span className="docs-pager-dir">
            Next
            <ChevronRightIcon size={16} />
          </span>
          <span className="docs-pager-title">{swapEmDashes(next.title, "heading")}</span>
        </Link>
      ) : null}
    </nav>
  );
}
