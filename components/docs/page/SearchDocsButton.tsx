"use client";

import { SearchIcon } from "@/components/docs/page/icons";
import { openDocsSearch, preloadDocsSearch } from "@/components/docs/page/search-events";

/** Opens the docs search palette (mounted by app/docs/layout.tsx) from inside a page, such as the docs 404. */
export function SearchDocsButton() {
  return (
    <button
      type="button"
      className="docs-btn docs-btn-secondary"
      onClick={openDocsSearch}
      onPointerEnter={preloadDocsSearch}
      onFocus={preloadDocsSearch}
      aria-keyshortcuts="Meta+K Control+K"
    >
      <SearchIcon size={16} />
      <span>Search the docs</span>
    </button>
  );
}
