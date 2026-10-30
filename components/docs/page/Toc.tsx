"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "@/components/docs/page/icons";

export interface TocEntry {
  id: string;
  text: string;
  depth: 2 | 3;
}

/** How far below the top of the window a heading counts as the one being read. */
const READING_LINE = 120;

/** Scrollspy: the id of the heading being read, the last one above the reading line. */
function useActiveHeading(items: TocEntry[]): [string, (id: string) => void] {
  const [active, setActive] = useState(items[0]?.id ?? "");
  useEffect(() => {
    if (!items.length) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      let current = items[0].id;
      for (const item of items) {
        const el = document.getElementById(item.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top - READING_LINE <= 0) current = item.id;
        else break;
      }
      // At the very bottom the last headings can't scroll up to the line; the last one is what's on screen.
      const doc = document.documentElement;
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 4) current = items[items.length - 1].id;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    window.addEventListener("hashchange", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("hashchange", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [items]);
  return [active, setActive];
}

/**
 * The list with its rail and the dark bar beside the heading being read. `center` keeps the active entry near the
 * middle of the scrolling column it sits in (the aside on wide screens), so on long pages it never rides the bottom
 * edge. Only that column scrolls: scrollIntoView would move the page too.
 */
function TocList({
  items,
  active,
  onPick,
  center,
}: {
  items: TocEntry[];
  active: string;
  onPick: (id: string) => void;
  center?: boolean;
}) {
  const [bar, setBar] = useState<{ top: number; height: number } | null>(null);
  const list = useRef<HTMLUListElement>(null);

  useLayoutEffect(() => {
    const link = list.current?.querySelector<HTMLAnchorElement>(`a[data-id="${CSS.escape(active)}"]`);
    if (!link || !link.offsetHeight) {
      setBar(null);
      return;
    }
    setBar({ top: link.offsetTop, height: link.offsetHeight });
    const column = center ? link.closest<HTMLElement>(".docs-toc-scroller") : null;
    if (column && column.scrollHeight > column.clientHeight) {
      const r = link.getBoundingClientRect();
      const box = column.getBoundingClientRect();
      // Re-center once the entry leaves the middle half of the column, not on every step, so the list doesn't jitter.
      if (r.top < box.top + box.height / 4 || r.bottom > box.bottom - box.height / 4) {
        column.scrollTop += r.top - box.top - (box.height - r.height) / 2;
      }
    }
  }, [active, center]);

  return (
    <div className="docs-toc-rail">
      <ul ref={list}>
        {items.map((item) => (
          <li key={item.id} className={item.depth === 3 ? "docs-toc-item is-sub" : "docs-toc-item"}>
            <a
              href={`#${item.id}`}
              data-id={item.id}
              aria-current={item.id === active ? "location" : undefined}
              onClick={() => onPick(item.id)}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
      {bar ? <span className="docs-toc-bar" style={{ top: bar.top, height: bar.height }} aria-hidden /> : null}
    </div>
  );
}

/**
 * "On this page" on wide screens (app/docs/docs.css shows it from 1201 px): the page's H2 and H3 headings with
 * scrollspy. The heading being read is bold with a dark bar on the rail beside it, like dev.meta.ai.
 */
export function Toc({ items }: { items: TocEntry[] }) {
  const [active, setActive] = useActiveHeading(items);
  if (!items.length) return null;
  return (
    <nav className="docs-toc" aria-label="On this page">
      <p className="docs-toc-title">On this page</p>
      <div className="docs-toc-scroller">
        <TocList items={items} active={active} onPick={setActive} center />
      </div>
    </nav>
  );
}

/**
 * The same list for tablets and phones, where the aside is hidden: a "Table of contents" pill under the actions
 * that opens the list in place, as dev.meta.ai does at 1200 px and below. Picking a heading closes it.
 */
export function TocToggle({ items }: { items: TocEntry[] }) {
  const [active, setActive] = useActiveHeading(items);
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!items.length) return null;
  return (
    <nav className="docs-toc docs-toc-inline" aria-label="Table of contents">
      <button
        type="button"
        className="docs-btn docs-btn-secondary docs-toc-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <span>Table of contents</span>
        <ChevronDownIcon size={16} />
      </button>
      <div id={id} className="docs-toc-panel" hidden={!open}>
        {open ? (
          <TocList
            items={items}
            active={active}
            onPick={(picked) => {
              setActive(picked);
              setOpen(false);
            }}
          />
        ) : null}
      </div>
    </nav>
  );
}
