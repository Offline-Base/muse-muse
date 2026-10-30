"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Tabs } from "@/components/docs/kit/Tabs";
import styles from "@/components/docs/playgrounds/start/start.module.css";

export interface Section {
  id: string;
  label: string;
  content: ReactNode;
}

/** The edges of a tab row that hide tabs right now. */
export type TabFade = "start" | "end" | "both" | null;

/** Which edges hide tabs, from a scrolling row's measurements: a 1 px slack absorbs subpixel widths. */
export function fadeFor(scrollLeft: number, scrollWidth: number, clientWidth: number): TabFade {
  const max = scrollWidth - clientWidth;
  if (max <= 1) return null;
  if (scrollLeft <= 1) return "end";
  if (scrollLeft >= max - 1) return "start";
  return "both";
}

/**
 * Watches the tab row inside `ref` (the kit's role="tablist", which scrolls sideways with its scrollbar hidden) and
 * says which edges hide tabs, so the row can fade there. Nothing fades while every tab fits.
 */
function useTabFade(ref: RefObject<HTMLDivElement | null>): TabFade {
  const [fade, setFade] = useState<TabFade>(null);
  useEffect(() => {
    const row = ref.current?.querySelector<HTMLElement>('[role="tablist"]');
    if (!row) return;
    const update = () => setFade(fadeFor(row.scrollLeft, row.scrollWidth, row.clientWidth));
    update();
    row.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(row);
    return () => {
      row.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [ref]);
  return fade;
}

/**
 * The kit's underline tabs over a demo's sections, with one difference from TabPanel: a section stays mounted once
 * it has been opened, so a reply, a picked file or a half-typed prompt is still there after a look at another tab.
 * Sections that were never opened render nothing, so a tab's playground (and any lazy chunk it needs) loads on first
 * open. Pass `value` and `onChange` to switch tabs from inside a section. On a narrow screen the row fades at an edge
 * that hides tabs, and a tab picked at the edge scrolls fully into view.
 */
export function SectionTabs({
  label,
  sections,
  initial,
  value,
  onChange,
}: {
  label: string;
  sections: Section[];
  initial?: string;
  value?: string;
  onChange?(id: string): void;
}) {
  const idBase = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  const fade = useTabFade(rowRef);
  const first = sections.some((s) => s.id === (value ?? initial)) ? (value ?? initial)! : (sections[0]?.id ?? "");
  const [own, setOwn] = useState(first);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set([first]));
  const active = value ?? own;
  if (!opened.has(active)) setOpened(new Set([...opened, active]));

  const open = (id: string) => {
    setOwn(id);
    onChange?.(id);
    // Only on a pick, never on mount: scrolling into view there could move the page to the demo.
    document.getElementById(`${idBase}-tab-${id}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  return (
    <div className={styles.stack}>
      <div ref={rowRef} className={styles.tabRow} data-fade={fade ?? undefined}>
        <Tabs label={label} idBase={idBase} tabs={sections.map((s) => ({ id: s.id, label: s.label }))} value={active} onChange={open} />
      </div>
      {sections.map((s) => (
        <div
          key={s.id}
          role="tabpanel"
          id={`${idBase}-panel-${s.id}`}
          aria-labelledby={`${idBase}-tab-${s.id}`}
          hidden={s.id !== active}
          tabIndex={0}
          className="pg-panel"
        >
          {opened.has(s.id) || s.id === active ? s.content : null}
        </div>
      ))}
    </div>
  );
}
