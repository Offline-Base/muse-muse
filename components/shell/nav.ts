import type { IconName } from "@/components/icons";

export const DISCLAIMER = "Independent concept built on Meta's Model API. Not an official Meta product.";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Other path prefixes that light this row up, such as /b/ for Builds. */
  also?: string[];
  /** Opens another site in a new tab, with the open-in-new icon at the end of the row. */
  external?: boolean;
  /** One short line under the label in the top bar's menus. */
  blurb?: string;
}

/** A top bar entry that opens a small menu of links, like the developer site's "Products" and "Resources". */
export interface NavGroup {
  label: string;
  items: NavItem[];
}

const DASHBOARD: NavItem = { href: "/dashboard", label: "Dashboard", icon: "dashboard" };
const MAKE: NavItem = { href: "/", label: "Make", icon: "sparkle" };
const BUILDS: NavItem = {
  href: "/builds",
  label: "Builds",
  icon: "layers",
  also: ["/b/"],
  blurb: "Every muse you've sent",
};
const REBUILDS: NavItem = { href: "/rebuilds", label: "Rebuilds", icon: "rebuild", blurb: "Meta's demos, rebuilt" };
const GALLERY: NavItem = {
  href: "/gallery",
  label: "Gallery",
  icon: "image",
  also: ["/p/"],
  blurb: "Every product that shipped",
};
const USAGE: NavItem = { href: "/usage", label: "Usage", icon: "usage" };
const FINE_TUNING: NavItem = { href: "/fine-tuning", label: "Fine-tuning", icon: "tune", also: ["/orders/"] };
const HOW: NavItem = { href: "/how-it-works", label: "How it works", icon: "book", blurb: "The pipeline, checks and costs" };
const DOCS: NavItem = {
  href: "https://dev.meta.ai/docs/overview",
  label: "Model API docs",
  icon: "doc",
  external: true,
  blurb: "Meta's own documentation",
};

/** The phone menu's groups, in the order the old sidebar had them (docs/UI_PATTERNS.md "Muse Muse mapping"). */
export const NAV_GROUPS: NavItem[][] = [[DASHBOARD], [MAKE, BUILDS, REBUILDS, GALLERY], [USAGE, FINE_TUNING], [HOW, DOCS]];

/** The desktop top bar: plain links, and small chevron menus where a group has more than fits. */
export const TOP_NAV: Array<NavItem | NavGroup> = [
  DASHBOARD,
  MAKE,
  { label: "Products", items: [BUILDS, REBUILDS, GALLERY] },
  USAGE,
  FINE_TUNING,
  { label: "Resources", items: [HOW, DOCS] },
];

export function isGroup(entry: NavItem | NavGroup): entry is NavGroup {
  return "items" in entry;
}

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.external) return false;
  if (item.href === "/") return pathname === "/";
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  return (item.also ?? []).some((prefix) => pathname.startsWith(prefix));
}

/** A group lights up when the page is one of its links. */
export function isGroupActive(group: NavGroup, pathname: string): boolean {
  return group.items.some((item) => isActive(item, pathname));
}
