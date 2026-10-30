/**
 * Reading order for the previous and next links at the bottom of a docs page: the sidebar's order first (groups
 * included), then every mirrored page the sidebar doesn't list (cookbook recipes and the like) in pages.json order.
 * Pure, so it's tested without the mirror.
 */

interface NavLinkLike {
  label: string;
  href: string;
  external?: boolean;
}

interface NavSectionLike {
  title: string;
  items: readonly (NavLinkLike | { label: string; items: readonly NavLinkLike[] })[];
}

export interface SequenceEntry {
  slug: string;
  title: string;
}

/** The slug of a /docs/<slug> link, or null for anything else (the dashboard, the Help Center). */
function slugOf(href: string): string | null {
  return href.match(/^\/docs\/([^#?]+)/)?.[1] ?? null;
}

export function pageSequence(
  nav: readonly NavSectionLike[],
  pages: readonly { slug: string; title: string }[],
): SequenceEntry[] {
  const titles = new Map(pages.map((p) => [p.slug, p.title]));
  const out: SequenceEntry[] = [];
  const seen = new Set<string>();
  // Titles come from the pages, not the sidebar: several sidebar rows are just "Overview".
  const add = (slug: string | null) => {
    if (!slug || seen.has(slug) || !titles.has(slug)) return;
    seen.add(slug);
    out.push({ slug, title: titles.get(slug) as string });
  };
  for (const section of nav) {
    for (const entry of section.items) {
      if ("items" in entry) for (const link of entry.items) add(slugOf(link.href));
      else add(slugOf(entry.href));
    }
  }
  for (const page of pages) add(page.slug);
  return out;
}

export function neighbors(sequence: readonly SequenceEntry[], slug: string): { prev: SequenceEntry | null; next: SequenceEntry | null } {
  const at = sequence.findIndex((e) => e.slug === slug);
  if (at < 0) return { prev: null, next: null };
  return { prev: sequence[at - 1] ?? null, next: sequence[at + 1] ?? null };
}
