"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRightIcon, ChevronDownIcon, ExternalIcon, HomeIcon, SearchIcon } from "@/components/docs/page/icons";
import { openDocsSearch, preloadDocsSearch } from "@/components/docs/page/search-events";
import type { LocalNavGroup, LocalNavLink, LocalNavSection } from "@/lib/docs/pages";

function isCurrent(link: LocalNavLink, pathname: string): boolean {
  return !link.external && link.href.split("#")[0] === pathname;
}

function NavLink({ link, pathname, onNavigate }: { link: LocalNavLink; pathname: string; onNavigate?: () => void }) {
  if (link.external) {
    return (
      <a href={link.href} className="docs-nav-link" target="_blank" rel="noopener noreferrer">
        <span className="docs-nav-label">{link.label}</span>
        <ExternalIcon size={16} className="docs-nav-ext" />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  const current = isCurrent(link, pathname);
  return (
    <Link href={link.href} className="docs-nav-link" aria-current={current ? "page" : undefined} onClick={onNavigate}>
      <span className="docs-nav-label">{link.label}</span>
    </Link>
  );
}

/** A collapsible group such as Cookbook > Meta Model API. It opens on its own when it holds the page being read. */
function NavGroup({ group, pathname, onNavigate }: { group: LocalNavGroup; pathname: string; onNavigate?: () => void }) {
  const id = useId();
  const holdsCurrent = group.items.some((link) => isCurrent(link, pathname));
  const [open, setOpen] = useState(holdsCurrent);
  useEffect(() => {
    if (holdsCurrent) setOpen(true);
  }, [holdsCurrent]);
  return (
    <li>
      <button
        type="button"
        className="docs-nav-link docs-nav-group"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="docs-nav-label">{group.label}</span>
        <ChevronDownIcon size={16} className="docs-nav-chevron" />
      </button>
      <ul id={id} className="docs-nav-children" hidden={!open}>
        {group.items.map((link) => (
          <li key={link.href}>
            <NavLink link={link} pathname={pathname} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * The sidebar on /docs/*, like dev.meta.ai's docs sidebar: a Search box (also Cmd/Ctrl+K), a Dashboard row back to
 * the platform, then the mirrored sections with uppercase titles. `nav` comes from docsNav() on the server.
 */
export function DocsNav({ nav, onNavigate }: { nav: LocalNavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname() ?? "/docs";
  const scroller = useRef<HTMLElement>(null);

  // Bring the current page's row into view, as dev.meta.ai does when you land deep in the API reference. Only the
  // nav scrolls: scrollIntoView would move the page too.
  useEffect(() => {
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !box) return;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += r.top - b.top - (b.height - r.height) / 2;
  }, [pathname]);

  return (
    <div className="docs-nav">
      <div className="docs-nav-top">
        <button
          type="button"
          className="docs-nav-search"
          onClick={() => {
            onNavigate?.();
            openDocsSearch();
          }}
          onPointerEnter={preloadDocsSearch}
          onFocus={preloadDocsSearch}
          aria-keyshortcuts="Meta+K Control+K"
          title="Search the docs (Cmd+K or Ctrl+K)"
        >
          <SearchIcon size={18} />
          <span>Search</span>
        </button>
        <Link href="/dashboard" className="docs-nav-link docs-nav-home" onClick={onNavigate}>
          <HomeIcon size={22} />
          <span className="docs-nav-label">Dashboard</span>
          <ArrowUpRightIcon size={20} className="docs-nav-ext" />
        </Link>
      </div>
      <nav className="docs-nav-scroll" aria-label="Docs" ref={scroller}>
        {nav.map((section) => (
          <div key={section.title} className="docs-nav-section">
            <p className="docs-nav-title">
              <span>{section.title}</span>
            </p>
            <ul className="docs-nav-list">
              {section.items.map((entry) =>
                "items" in entry ? (
                  <NavGroup key={entry.label} group={entry} pathname={pathname} onNavigate={onNavigate} />
                ) : (
                  <li key={entry.href}>
                    <NavLink link={entry} pathname={pathname} onNavigate={onNavigate} />
                  </li>
                ),
              )}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
