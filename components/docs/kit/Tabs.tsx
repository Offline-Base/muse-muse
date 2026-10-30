"use client";

import type { KeyboardEvent, ReactNode } from "react";

/**
 * Underline tabs like dev.meta.ai's (role="tablist", arrow keys and Home/End move between tabs). The panel for each
 * tab is a TabPanel with the same `idBase`; only the active one renders its children, so a big JSON view costs
 * nothing until it's opened.
 */

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  /** A small count after the label, such as the number of headers. */
  count?: number;
}

export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  idBase,
  className,
}: {
  label: string;
  /** The tab ids' type comes from `value` alone, so `onChange={setState}` works with a union-typed state. */
  tabs: ReadonlyArray<TabItem<NoInfer<T>>>;
  value: T;
  onChange(id: NoInfer<T>): void;
  idBase: string;
  className?: string;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = tabs.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === "ArrowRight") next = (at + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (at - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].id);
    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className={`pg-tabs${className ? ` ${className}` : ""}`} role="tablist" aria-label={label}>
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
            className="pg-tab"
            onClick={() => onChange(t.id)}
            onKeyDown={onKeyDown}
          >
            {t.label}
            {t.count !== undefined ? <span className="pg-tab-count">{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idBase, id, active, children, className }: { idBase: string; id: string; active: boolean; children: ReactNode; className?: string }) {
  return (
    <div
      role="tabpanel"
      id={`${idBase}-panel-${id}`}
      aria-labelledby={`${idBase}-tab-${id}`}
      hidden={!active}
      tabIndex={0}
      className={`pg-panel${className ? ` ${className}` : ""}`}
    >
      {active ? children : null}
    </div>
  );
}
