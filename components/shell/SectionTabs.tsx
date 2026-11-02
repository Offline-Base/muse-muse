"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SECTION_TABS, currentTab, type SectionTabSet } from "@/components/shell/nav";

/**
 * The tabs over the pages one sidebar row gathers, such as Gallery and Meta demos under Inspiration. Links, not a tab
 * widget: each tab is its own page, and the open one is marked aria-current. Drawn only on the set's own pages, so a
 * run page under /fine-tuning, say, shows none. Used from each route's layout.tsx, above the page.
 */
export function SectionTabs({ set }: { set: SectionTabSet }) {
  const pathname = usePathname() ?? "/";
  const here = currentTab(set, pathname);
  if (!here) return null;
  const { label, tabs } = SECTION_TABS[set];
  return (
    <div className="section-tabs">
      <nav className="segmented" aria-label={label}>
        {tabs.map((tab) => (
          <Link key={tab.href} href={tab.href} aria-current={tab.href === here.href ? "page" : undefined}>
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
