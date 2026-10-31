"use client";

import type { KeyboardEvent, ReactNode } from "react";

export interface SegmentedTab<T extends string = string> {
  id: T;
  label: ReactNode;
}

/** The tab a key moves to from tab `at` of `count`: the arrows wrap around, Home and End go to the ends. Else -1. */
export function nextTab(key: string, at: number, count: number): number {
  if (key === "ArrowRight") return (at + 1) % count;
  if (key === "ArrowLeft") return (at - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return -1;
}

/**
 * The steps panel's segmented tabs (docs/UI_MUSE_APP.md, "The steps panel", "Tabs"): a gray rounded track with the
 * chosen tab as a white segment that doesn't slide. A tablist: arrow keys, Home and End move between the tabs, and only
 * the chosen one is in the tab order. Each tab's panel is a SegmentedTabPanel with the same `idBase`.
 */
export function SegmentedTabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  idBase,
}: {
  label: string;
  /** The ids' type comes from `value` alone, so `onChange={setState}` works with a union-typed state. */
  tabs: ReadonlyArray<SegmentedTab<NoInfer<T>>>;
  value: T;
  onChange(id: NoInfer<T>): void;
  idBase: string;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextTab(e.key, tabs.findIndex((t) => t.id === value), tabs.length);
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].id);
    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className="chat-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.id}`}
            aria-selected={on}
            aria-controls={`${idBase}-panel-${t.id}`}
            tabIndex={on ? 0 : -1}
            className="chat-tab"
            onClick={() => onChange(t.id)}
            onKeyDown={onKeyDown}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** The panel a SegmentedTabs tab controls. Only the chosen one renders its children. */
export function SegmentedTabPanel({
  idBase,
  id,
  active,
  className,
  children,
}: {
  idBase: string;
  id: string;
  active: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idBase}-panel-${id}`}
      aria-labelledby={`${idBase}-tab-${id}`}
      hidden={!active}
      tabIndex={0}
      className={className}
    >
      {active ? children : null}
    </div>
  );
}
