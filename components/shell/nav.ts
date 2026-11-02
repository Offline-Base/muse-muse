import type { IconName } from "@/components/icons";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /**
   * Other paths that light this row up. One ending in "/" is a prefix, such as /b/ for Musings. One without lights the
   * row on that path and the paths under it, such as /device for Devices, but not on /devices.
   */
  also?: string[];
  /** Opens another site in a new tab, with the open-in-new icon at the end of the row. */
  external?: boolean;
}

/** The sidebar's one creation button, above the rows. It opens the composer on the Make page. */
export const START_MUSING: NavItem = { href: "/", label: "Start musing", icon: "plus" };

/**
 * The sidebar's main rows. Each one is a destination; the pages it also lights sit under it as tabs (SECTION_TABS).
 * The routes behind them are unchanged: /builds and /b/ are still the build list and the build room.
 */
export const NAV_GROUPS: NavItem[][] = [
  [
    { href: "/builds", label: "Musings", icon: "layers", also: ["/b/"] },
    // The gallery and Meta's lessons (app/learn, which the old /rebuilds redirects to), plus every product page.
    { href: "/gallery", label: "Inspiration", icon: "image", also: ["/p/", "/learn", "/rebuilds"] },
    // Fine-tuning makes models, so the Models page sits under it as a tab.
    { href: "/fine-tuning", label: "Fine-tuning", icon: "tune", also: ["/models"] },
    // The boards: Gadgets, the admins' /device page, and Muse Privacy (privacy/), which runs on the person's own hardware.
    { href: "/gadgets", label: "Devices", icon: "chip", also: ["/device", "/private"] },
  ],
];

/** The utilities above the account chip. The old Dashboard is Usage's Overview tab, so /dashboard lights Usage. */
export const USAGE_ITEM: NavItem = { href: "/usage", label: "Usage", icon: "usage", also: ["/dashboard"] };

/** Help's two destinations. The mirrored Model API docs live at /docs (app/docs), where the sidebar becomes the docs nav. */
export const HELP_ITEMS: NavItem[] = [
  { href: "/how-it-works", label: "How it works", icon: "book" },
  { href: "/docs", label: "Model API docs", icon: "doc" },
];

export interface HelpCard {
  href: string;
  title: string;
  text: string;
  icon: IconName;
  /** Another site: opens in a new tab, with the arrow mark instead of the chevron. */
  external?: boolean;
}

/**
 * The Help window (components/shell/HelpDialog.tsx), laid out like meta.ai's Settings: one section per destination in
 * the list on the left, and its cards on the right. Every card goes somewhere real.
 */
export const HELP_SECTIONS: { id: string; item: NavItem; group: string; cards: HelpCard[] }[] = [
  {
    id: "how",
    item: HELP_ITEMS[0]!,
    group: "Muse Muse",
    cards: [
      {
        href: "/how-it-works",
        title: "How it works",
        text: "From an idea to a live product: the plan, the build, the checks, the demo and your own link.",
        icon: "book",
      },
    ],
  },
  {
    id: "docs",
    item: HELP_ITEMS[1]!,
    group: "Meta's Model API",
    cards: [
      {
        href: "/docs",
        title: "Model API docs",
        text: "Meta's Model API docs, mirrored here, with examples you can try.",
        icon: "doc",
      },
      {
        href: "https://dev.meta.ai/docs/overview",
        title: "The docs on dev.meta.ai",
        text: "Meta's own copy, always current.",
        icon: "external",
        external: true,
      },
    ],
  },
];

export interface SectionTab {
  href: string;
  label: string;
}

/** The tabs over the pages a sidebar row gathers. Each set shows only on its own pages (SectionTabs). */
export const SECTION_TABS = {
  inspiration: {
    label: "Inspiration",
    tabs: [
      { href: "/gallery", label: "Gallery" },
      { href: "/learn", label: "Meta demos" },
    ],
  },
  tuning: {
    label: "Fine-tuning",
    tabs: [
      { href: "/fine-tuning", label: "Fine-tuning" },
      { href: "/models", label: "Models" },
    ],
  },
  devices: {
    label: "Devices",
    tabs: [
      { href: "/gadgets", label: "Gadgets" },
      { href: "/private", label: "Muse Privacy" },
    ],
  },
  usage: {
    label: "Usage",
    tabs: [
      { href: "/usage", label: "Usage" },
      { href: "/dashboard", label: "Overview" },
    ],
  },
} satisfies Record<string, { label: string; tabs: SectionTab[] }>;

export type SectionTabSet = keyof typeof SECTION_TABS;

/** The tab a path is on, or null when the path isn't one of the set's pages (a run page under /fine-tuning, say). */
export function currentTab(set: SectionTabSet, pathname: string): SectionTab | null {
  return SECTION_TABS[set].tabs.find((tab) => tab.href === pathname) ?? null;
}

/** The docs mirror's pages, where the sidebar shows the docs navigation instead of the platform's. */
export function isDocsPath(pathname: string): boolean {
  return pathname === "/docs" || pathname.startsWith("/docs/");
}

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.external) return false;
  if (item.href === "/") return pathname === "/";
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  return (item.also ?? []).some((path) =>
    path.endsWith("/") ? pathname.startsWith(path) : pathname === path || pathname.startsWith(`${path}/`),
  );
}

/** True when a Help page is open, so the Help button shows as the current place. */
export function isHelpPath(pathname: string): boolean {
  return HELP_ITEMS.some((item) => isActive(item, pathname));
}
