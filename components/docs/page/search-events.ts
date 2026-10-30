/**
 * The docs search palette lives in app/docs/layout.tsx while its Search buttons live in the shell's sidebar and
 * mobile drawer, so the buttons ask for it with a window event instead of sharing React state across the two trees.
 */
export const DOCS_SEARCH_EVENT = "muse:docs-search";

export function openDocsSearch(): void {
  window.dispatchEvent(new CustomEvent(DOCS_SEARCH_EVENT));
}

/** Starts loading the search index before the palette opens (on hover or focus of a Search button). */
export const DOCS_SEARCH_PRELOAD_EVENT = "muse:docs-search-preload";

export function preloadDocsSearch(): void {
  window.dispatchEvent(new CustomEvent(DOCS_SEARCH_PRELOAD_EVENT));
}
