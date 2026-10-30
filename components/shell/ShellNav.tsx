"use client";

import { usePathname } from "next/navigation";
import { DocsNav } from "@/components/shell/DocsNav";
import { NavLinks } from "@/components/shell/NavLinks";
import { isDocsPath } from "@/components/shell/nav";
import type { LocalNavSection } from "@/lib/docs/pages";

/**
 * The sidebar's navigation: the docs sidebar on /docs/* (as dev.meta.ai swaps its dashboard nav for the docs nav),
 * the platform's rows everywhere else. The root layout doesn't re-render on client navigation, so the switch happens
 * here, from the pathname.
 */
export function ShellNav({ docsNav, onNavigate }: { docsNav: LocalNavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname() ?? "/";
  return isDocsPath(pathname) ? <DocsNav nav={docsNav} onNavigate={onNavigate} /> : <NavLinks onNavigate={onNavigate} />;
}
