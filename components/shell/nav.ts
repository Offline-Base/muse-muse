import type { IconName } from "@/components/icons";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /**
   * Other paths that light this row up. One ending in "/" is a prefix, such as /b/ for Builds. One without lights the
   * row on that path and the paths under it, such as /device for Gadgets, but not on /devices.
   */
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
    { href: "/demos", label: "Demos", icon: "video" },
  ],
  [
    { href: "/usage", label: "Usage", icon: "usage" },
    // Models after Usage, as in Meta's dashboard; Fine-tuning next, since it makes models; Gadgets, the hardware, last.
    { href: "/models", label: "Models", icon: "cube" },
    { href: "/fine-tuning", label: "Fine-tuning", icon: "tune" },
    // /device is the admins' page for the board, so it lights Gadgets.
    { href: "/gadgets", label: "Gadgets", icon: "chip", also: ["/device"] },
    // Muse Privacy (privacy/), which runs on the person's own hardware, so it sits with Gadgets.
    { href: "/private", label: "Muse Privacy", icon: "shield" },
  ],
  [
    { href: "/how-it-works", label: "How it works", icon: "book" },
    // The mirrored Model API docs (app/docs). On /docs/* the sidebar becomes the docs sidebar (components/shell/DocsNav).
    { href: "/docs", label: "Docs", icon: "doc" },
  ],
];

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
