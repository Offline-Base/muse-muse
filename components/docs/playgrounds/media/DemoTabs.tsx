"use client";

import { Children, useId, useState, type ReactNode } from "react";
import { Tabs } from "@/components/docs/kit/Tabs";

export interface DemoTab {
  id: string;
  label: string;
}

/**
 * The kit's underline tabs for a demo with several parts (image-generation's conversation, stateless turns, options
 * and errors). Unlike the kit's TabPanel, a panel stays mounted once it has been opened and is only hidden after
 * that, so a generated image or an uploaded file is still there when the reader comes back to its tab.
 */
export function DemoTabs({ label, tabs, initial, children }: { label: string; tabs: readonly DemoTab[]; initial?: string; children: ReactNode }) {
  const idBase = useId();
  const start = tabs.some((t) => t.id === initial) ? (initial as string) : (tabs[0]?.id ?? "");
  const [tab, setTab] = useState(start);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set([start]));
  const panels = Children.toArray(children);

  const open = (id: string) => {
    setTab(id);
    setOpened((s) => (s.has(id) ? s : new Set([...s, id])));
  };

  return (
    <div className="pg">
      <Tabs label={label} idBase={idBase} tabs={tabs} value={tab} onChange={open} />
      {tabs.map((t, i) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${idBase}-panel-${t.id}`}
          aria-labelledby={`${idBase}-tab-${t.id}`}
          hidden={tab !== t.id}
          className="pg-panel"
        >
          {opened.has(t.id) ? panels[i] : null}
        </div>
      ))}
    </div>
  );
}
