import type { IconName } from "@/components/icons";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Other path prefixes that light this row up, such as /b/ for Builds. */
  also?: string[];
  /** Opens another site in a new tab, with the open-in-new icon at the end of the row. */
  external?: boolean;
}

/** Sidebar groups, laid out like the Meta Model API dashboard's (docs/UI_PATTERNS.md "Muse Muse mapping"). */
export const NAV_GROUPS: NavItem[][] = [
  [{ href: "/dashboard", label: "Dashboard", icon: "dashboard" }],
  [
    { href: "/", label: "Make", icon: "sparkle" },
    { href: "/builds", label: "Builds", icon: "layers", also: ["/b/"] },
    { href: "/rebuilds", label: "Rebuilds", icon: "rebuild" },
    { href: "/gallery", label: "Gallery", icon: "image", also: ["/p/"] },
  ],
  [
    { href: "/usage", label: "Usage", icon: "usage" },
    { href: "/fine-tuning", label: "Fine-tuning", icon: "tune" },
  ],
  [
    { href: "/how-it-works", label: "How it works", icon: "book" },
    { href: "https://dev.meta.ai/docs/overview", label: "Model API docs", icon: "doc", external: true },
  ],
];

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.external) return false;
  if (item.href === "/") return pathname === "/";
  if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return true;
  return (item.also ?? []).some((prefix) => pathname.startsWith(prefix));
}
