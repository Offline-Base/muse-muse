"use client";

import { ChatPlayground, type ChatPlaygroundProps } from "@/components/docs/playgrounds/common/ChatPlayground";
import { StructuredOutputPlayground, type StructuredOutputPlaygroundProps } from "@/components/docs/playgrounds/common/StructuredOutputPlayground";
import { RequestShowcase, type RequestShowcaseProps } from "@/components/docs/playgrounds/cookbook-fundamentals/RequestShowcase";
import { StatelessCompare, type StatelessCompareProps } from "@/components/docs/playgrounds/cookbook-fundamentals/StatelessCompare";
import { DemoTabs } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";

/**
 * Several demos under one set of tabs, each named by kind with plain JSON props, so a page's DemoSpec can put the
 * kit's ChatPlayground beside this group's request showcase (and the rest) without a component of its own. Every
 * tab stays mounted, so a run in one keeps its result while you look at another.
 */

export type TabSpec =
  | { id: string; label: string; kind: "chat"; props: Omit<ChatPlaygroundProps, "slug"> }
  | { id: string; label: string; kind: "structured"; props: Omit<StructuredOutputPlaygroundProps, "slug"> }
  | { id: string; label: string; kind: "showcase"; props: RequestShowcaseProps }
  | { id: string; label: string; kind: "stateless"; props: StatelessCompareProps };

export interface TabbedDemoProps {
  slug: string;
  /** The tab list's accessible name. */
  label: string;
  tabs: TabSpec[];
}

function TabBody({ slug, tab }: { slug: string; tab: TabSpec }) {
  switch (tab.kind) {
    case "chat":
      return <ChatPlayground slug={slug} {...tab.props} />;
    case "structured":
      return <StructuredOutputPlayground slug={slug} {...tab.props} />;
    case "showcase":
      return <RequestShowcase {...tab.props} />;
    case "stateless":
      return <StatelessCompare {...tab.props} />;
  }
}

export function TabbedDemo({ slug, label, tabs }: TabbedDemoProps) {
  return <DemoTabs label={label} tabs={tabs.map((t) => ({ id: t.id, label: t.label, content: <TabBody slug={slug} tab={t} /> }))} />;
}
