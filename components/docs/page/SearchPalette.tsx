"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { DocIcon, HashIcon, SearchIcon } from "@/components/docs/page/icons";
import { DOCS_SEARCH_EVENT, DOCS_SEARCH_PRELOAD_EVENT } from "@/components/docs/page/search-events";
import { searchDocs, type SearchHit, type SearchIndex } from "@/lib/docs/search";

let indexPromise: Promise<SearchIndex> | null = null;

/** Loads /docs/search.json once per page load; a failed load is retried on the next open. */
function loadIndex(): Promise<SearchIndex> {
  if (!indexPromise) {
    const pending = fetch("/docs/search.json").then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<SearchIndex>;
    });
    pending.catch(() => {
      if (indexPromise === pending) indexPromise = null;
    });
    indexPromise = pending;
  }
  return indexPromise;
}

/** What the palette suggests before anything is typed. */
const STARTERS = ["quickstart", "models", "tool-calling", "image-understanding", "structured-output", "protocols/responses", "speech-to-text", "api-reference"];

/**
 * The docs search palette: opened by the sidebar's Search box or Cmd/Ctrl+K on any docs page, searches page titles,
 * sidebar labels, descriptions and H2/H3 headings (lib/docs/search.ts), arrows move, Enter opens, Escape closes.
 */
export function SearchPalette() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const [index, setIndex] = useState<SearchIndex | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const ensureIndex = useCallback(() => {
    loadIndex().then(
      (loaded) => {
        setIndex(loaded);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, []);

  const open = useCallback(() => {
    const el = dialog.current;
    if (!el || el.open) return;
    ensureIndex();
    el.showModal();
    input.current?.focus();
    input.current?.select();
  }, [ensureIndex]);

  const close = useCallback(() => dialog.current?.close(), []);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (dialog.current?.open) close();
        else open();
      }
    };
    window.addEventListener(DOCS_SEARCH_EVENT, open);
    window.addEventListener(DOCS_SEARCH_PRELOAD_EVENT, ensureIndex);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(DOCS_SEARCH_EVENT, open);
      window.removeEventListener(DOCS_SEARCH_PRELOAD_EVENT, ensureIndex);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close, ensureIndex]);

  const results: SearchHit[] = useMemo(() => {
    if (!index) return [];
    if (query.trim()) return searchDocs(index, query, 24);
    return STARTERS.map((slug) => index.pages.find((p) => p.slug === slug))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => ({ kind: "page" as const, href: p.href, title: p.title, context: p.section, description: p.description, score: 0 }));
  }, [index, query]);

  useEffect(() => setActive(0), [query]);

  // Keep the highlighted result visible by scrolling the list alone.
  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!list || !item) return;
    const r = item.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    if (r.top < box.top) list.scrollTop += r.top - box.top - 6;
    else if (r.bottom > box.bottom) list.scrollTop += r.bottom - box.bottom + 6;
  }, [active]);

  const go = (hit: SearchHit | undefined) => {
    if (!hit) return;
    close();
    router.push(hit.href);
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[active]);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="docs-palette"
      aria-label="Search the docs"
      onClose={() => setQuery("")}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="docs-palette-box">
        <div className="docs-palette-input">
          <SearchIcon size={20} />
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search the docs"
            aria-label="Search the docs"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="docs-kbd">Esc</kbd>
        </div>
        {!index ? (
          <p className="docs-palette-empty">{failed ? "Search didn't load. Close this and try again." : "Loading..."}</p>
        ) : results.length === 0 ? (
          <p className="docs-palette-empty">No pages match &ldquo;{query}&rdquo;.</p>
        ) : (
          <>
            {!query.trim() ? <p className="docs-palette-label">Popular pages</p> : null}
            <ul className="docs-palette-list" id={listId} role="listbox" ref={listRef} aria-label="Results">
              {results.map((hit, i) => (
                <li
                  key={hit.href}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  className="docs-palette-item"
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(hit)}
                >
                  <span className="docs-palette-icon">{hit.kind === "page" ? <DocIcon size={18} /> : <HashIcon size={16} />}</span>
                  <span className="docs-palette-text">
                    <span className="docs-palette-title">{hit.title}</span>
                    <span className="docs-palette-context">{hit.context}</span>
                    {hit.kind === "page" && hit.description ? <span className="docs-palette-desc">{hit.description}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="docs-palette-foot" aria-hidden>
          <span>
            <kbd className="docs-kbd">↑</kbd> <kbd className="docs-kbd">↓</kbd> to move
          </span>
          <span>
            <kbd className="docs-kbd">Enter</kbd> to open
          </span>
        </p>
      </div>
    </dialog>
  );
}
