import type { IconName } from "@/components/icons";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Other path prefixes that light this row up, such as /b/ for Builds. */
  also?: string[];
}

/** Sidebar groups, per docs/UI_PATTERNS.md "Muse Muse mapping". */
export const NAV_GROUPS: NavItem[][] = [
  [{ href: "/", label: "Make", icon: "sparkle" }],
  [
    { href: "/builds", label: "Builds", icon: "layers", also: ["/b/"] },
    { href: "/rebuilds", label: "Rebuilds", icon: "rebuild" },
    { href: "/gallery", label: "Gallery", icon: "grid", also: ["/p/"] },
  ],
  [{ href: "/usage", label: "Usage", icon: "chart" }],
  [{ href: "/#how-it-works", label: "How it works", icon: "book" }],
];

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.href.includes("#")) return false;
  if (item.href === "/") return pathname === "/";
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  return (item.also ?? []).some((prefix) => pathname.startsWith(prefix));
}
