"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * Views of one screen, like "Live", "Checklist" and "Memo". The tabs wrap to a second row on a phone, so all of them
 * show at 390 px; they never scroll sideways or run off the screen. Arrow keys, Home and End move between them, and
 * the current view shows below as a tab panel. Keep labels to a word or two.
 *   <Tabs label="Run views" tabs={[{ id: "live", label: "Live" }, { id: "memo", label: "Memo" }]} value={tab} onChange={setTab}>
 *     {tab === "live" ? <LiveView /> : <MemoView />}
 *   </Tabs>
 * Tests: page.getByRole("tab", { name: "Memo" }).click(), then expect(page.getByRole("tabpanel")).toContainText(...).
 * Views that are their own pages use links instead: <nav className="tab-bar"> with aria-current="page" on the current one.
 */
export function Tabs<T extends string>(props: {
  /** Names the tab list for screen readers, like "Run views". */
  label: string;
  tabs: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
  children?: ReactNode;
}) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const ids = (id: T) => ({ tab: `${base}-tab-${id}`, panel: `${base}-panel-${id}` });
  const current = props.tabs.some((t) => t.id === props.value) ? props.value : props.tabs[0]?.id;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = props.tabs.findIndex((t) => t.id === current);
    const next = tabKeyTarget(e.key, i, props.tabs.length);
    if (next === null) return;
    e.preventDefault();
    const id = props.tabs[next].id;
    props.onChange(id);
    list.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(ids(id).tab)}`)?.focus();
  };

  return (
    <>
      <div className="tab-bar" role="tablist" aria-label={props.label} ref={list} onKeyDown={onKeyDown}>
        {props.tabs.map((t) => {
          const selected = t.id === current;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={ids(t.id).tab}
              aria-selected={selected}
              aria-controls={selected && props.children !== undefined ? ids(t.id).panel : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => props.onChange(t.id)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {current !== undefined && props.children !== undefined ? (
        <div className="tab-panel" role="tabpanel" id={ids(current).panel} aria-labelledby={ids(current).tab} tabIndex={0}>
          {props.children}
        </div>
      ) : null}
    </>
  );
}

/** Where a key moves the focus in a list of `count` tabs from index `i`, or null for a key tabs don't use. */
export function tabKeyTarget(key: string, i: number, count: number): number | null {
  if (count < 1) return null;
  const from = i < 0 ? 0 : i;
  if (key === "ArrowRight" || key === "ArrowDown") return (from + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (from - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
