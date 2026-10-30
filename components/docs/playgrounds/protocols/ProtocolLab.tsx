"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Tabs } from "@/components/docs/kit/Tabs";
import { ChatPlayground, type ChatPlaygroundProps } from "@/components/docs/playgrounds/common/ChatPlayground";
import { StructuredOutputPlayground, type StructuredOutputPlaygroundProps } from "@/components/docs/playgrounds/common/StructuredOutputPlayground";
import { ToolLoopPlayground, type ToolLoopPlaygroundProps } from "@/components/docs/playgrounds/common/ToolLoopPlayground";
import { ConsolePresets, type ConsolePresetsProps } from "@/components/docs/playgrounds/protocols/ConsolePresets";
import { FlowRunner, type FlowRunnerProps } from "@/components/docs/playgrounds/protocols/FlowRunner";
import styles from "@/components/docs/playgrounds/protocols/protocols.module.css";

/**
 * A protocol page's demo as underline tabs, one per thing the page teaches, each tab one of the kit's playgrounds or
 * a flow, configured by plain JSON props from the DemoSpec. A tab mounts the first time it opens and stays mounted,
 * so a flow that's running or a conversation in progress survives a look at another tab. With one tab there is no
 * tab bar. When the tabs don't fit the column, the bar scrolls sideways: the edge with more tabs past it fades, and
 * the open tab is scrolled into view (macOS hides the scrollbar, so nothing else says there's more).
 */

type Without<P> = Omit<P, "slug">;

/** Simple view: the tabs past this many wait behind Options, unless one of them is open. */
const SIMPLE_TABS = 5;

export type LabTab = { id: string; label: string; intro?: string } & (
  | { kind: "flow"; props: Without<FlowRunnerProps> }
  | { kind: "chat"; props: Without<ChatPlaygroundProps> }
  | { kind: "console"; props: Without<ConsolePresetsProps> }
  | { kind: "tools"; props: Without<ToolLoopPlaygroundProps> }
  | { kind: "structured"; props: Without<StructuredOutputPlaygroundProps> }
);

export interface ProtocolLabProps {
  slug: string;
  tabs: LabTab[];
  /** The tab that opens first. Default the first. */
  start?: string;
}

function Tab({ tab, slug }: { tab: LabTab; slug: string }) {
  switch (tab.kind) {
    case "flow":
      return <FlowRunner {...tab.props} slug={slug} />;
    case "chat":
      return <ChatPlayground {...tab.props} slug={slug} />;
    case "console":
      return <ConsolePresets {...tab.props} slug={slug} />;
    case "tools":
      return <ToolLoopPlayground {...tab.props} slug={slug} />;
    case "structured":
      return <StructuredOutputPlayground {...tab.props} slug={slug} />;
  }
}

/** The tab list inside the bar (the kit's Tabs renders it). */
function tabList(bar: HTMLElement | null): HTMLElement | null {
  return bar?.querySelector<HTMLElement>('[role="tablist"]') ?? null;
}

export function ProtocolLab({ slug, tabs, start }: ProtocolLabProps) {
  const idBase = useId();
  const first = tabs.some((t) => t.id === start) ? start! : (tabs[0]?.id ?? "");
  const [active, setActive] = useState(first);
  const [opened, setOpened] = useState<string[]>([first]);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState({ left: false, right: false });

  const open = (next: string) => {
    setActive(next);
    setOpened((list) => (list.includes(next) ? list : [...list, next]));
  };

  // The open tab stays in view, when it's picked and when the column narrows: the bar scrolls sideways only (never
  // the page), past the faded edge. Which edges have tabs past them is measured as it scrolls or resizes.
  useEffect(() => {
    const list = tabList(barRef.current);
    if (!list) return;
    const measure = () => {
      const left = list.scrollLeft > 1;
      const right = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      setMore((cur) => (cur.left === left && cur.right === right ? cur : { left, right }));
    };
    const reveal = (smooth: boolean) => {
      const tab = document.getElementById(`${idBase}-tab-${active}`);
      if (!tab || !list.contains(tab)) return;
      const box = list.getBoundingClientRect();
      const at = tab.getBoundingClientRect();
      const pad = 32;
      const by = at.right > box.right - pad ? at.right - box.right + pad : at.left < box.left + pad ? at.left - box.left - pad : 0;
      const still = !smooth || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (Math.abs(by) > 1) list.scrollBy({ left: by, behavior: still ? "auto" : "smooth" });
    };
    reveal(true);
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            reveal(false);
            measure();
          });
    resize?.observe(list);
    return () => {
      list.removeEventListener("scroll", measure);
      resize?.disconnect();
    };
  }, [active, idBase]);

  if (!tabs.length) return null;
  if (tabs.length === 1) {
    const tab = tabs[0];
    return (
      <div className="pg">
        {tab.intro ? <p className={`${styles.labIntro} pg-advanced`}>{tab.intro}</p> : null}
        <Tab tab={tab} slug={slug} />
      </div>
    );
  }

  return (
    <div className="pg">
      <div ref={barRef} className={styles.labBar} data-more-left={more.left || undefined} data-more-right={more.right || undefined}>
        <Tabs
          label="Demos on this page"
          idBase={idBase}
          tabs={tabs.map((t, i) => ({ id: t.id, label: i >= SIMPLE_TABS && t.id !== active ? <span className="pg-advanced">{t.label}</span> : t.label }))}
          value={active}
          onChange={open}
          className={styles.labTabs}
        />
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${idBase}-panel-${tab.id}`}
          aria-labelledby={`${idBase}-tab-${tab.id}`}
          hidden={active !== tab.id}
          tabIndex={0}
          className={styles.labPanel}
        >
          {opened.includes(tab.id) ? (
            <>
              {tab.intro ? <p className={`${styles.labIntro} pg-advanced`}>{tab.intro}</p> : null}
              <Tab tab={tab} slug={slug} />
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}
