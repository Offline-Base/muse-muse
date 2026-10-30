import { readFileSync } from "node:fs";
import path from "node:path";
import navJson from "@/content/meta-docs/nav.json";
import pagesJson from "@/content/meta-docs/pages.json";
import sourceJson from "@/content/meta-docs/source.json";
import { DOCS_ORIGIN, isNavGroup, slugOfDocsUrl, type NavSection } from "@/lib/docs/mirror-parse";

/**
 * The mirrored Meta docs (content/meta-docs, refreshed with `npm run docs:sync`). Server only: it reads the Markdown
 * from disk. next.config.ts traces content/meta-docs/pages into the functions that call docsMarkdown.
 */

export interface DocsPage {
  slug: string;
  /** The page's H1. */
  title: string;
  /** The page's title in llms.txt, often longer than the H1. */
  listTitle: string;
  description: string;
  /** The llms.txt section: Guides, Protocols, API reference, Cookbook, Muse Code, Open-weight models. */
  listSection: string;
  /** https://dev.meta.ai/docs/<slug> */
  sourceUrl: string;
  /** https://dev.meta.ai/docs/<slug>.md, the Markdown copy a coding agent can read. */
  markdownUrl: string;
  headingsWithIds: number;
  headings: number;
}

export interface LocalNavLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface LocalNavGroup {
  label: string;
  items: LocalNavLink[];
}

export type LocalNavEntry = LocalNavLink | LocalNavGroup;

export interface LocalNavSection {
  title: string;
  items: LocalNavEntry[];
}

export const DOCS_PAGES: readonly DocsPage[] = pagesJson as DocsPage[];
export const DOCS_SOURCE = sourceJson as { source: string; index: string; syncedAt: string; pages: number };
export const DOCS_HOME = "/docs/overview";

const bySlug = new Map(DOCS_PAGES.map((p) => [p.slug, p]));

export function docsPage(slug: string): DocsPage | null {
  return bySlug.get(slug) ?? null;
}

const PAGES_DIR = path.join(process.cwd(), "content/meta-docs/pages");
const markdownCache = new Map<string, string>();

/** The page's Markdown as mirrored, headings carrying "{#id}" anchors. Throws for a slug that isn't mirrored. */
export function docsMarkdown(slug: string): string {
  const cached = markdownCache.get(slug);
  if (cached !== undefined) return cached;
  if (!bySlug.has(slug)) throw new Error(`No mirrored docs page "${slug}".`);
  const md = readFileSync(path.join(PAGES_DIR, `${slug}.md`), "utf8");
  markdownCache.set(slug, md);
  return md;
}

/** Our URL for a mirrored page: /docs/<slug>. */
export function docsPath(slug: string): string {
  return `/docs/${slug}`;
}

/**
 * Where a link in the mirrored docs should point here. Mirrored pages (absolute https://dev.meta.ai/docs/... or a
 * /docs/... path) stay inside /docs with their #anchor; the dev.meta.ai dashboard (/platform) becomes Muse Muse's
 * /dashboard; anything else on dev.meta.ai, and every other site, stays an external link.
 */
export function docsHref(href: string): { href: string; external: boolean } {
  const absolute = href.startsWith("/") ? `${DOCS_ORIGIN}${href}` : href;
  const slug = slugOfDocsUrl(absolute.replace(/#.*$/, ""));
  const hash = absolute.includes("#") ? absolute.slice(absolute.indexOf("#")) : "";
  if (slug && bySlug.has(slug)) return { href: `${docsPath(slug)}${hash}`, external: false };
  if (absolute === `${DOCS_ORIGIN}/docs` || absolute === `${DOCS_ORIGIN}/docs/`) return { href: DOCS_HOME, external: false };
  if (absolute === `${DOCS_ORIGIN}/platform` || absolute.startsWith(`${DOCS_ORIGIN}/platform/`)) {
    return { href: "/dashboard", external: false };
  }
  return { href: absolute, external: /^https?:\/\//.test(absolute) };
}

/** The docs sidebar with every href mapped by docsHref. The "Product" section (Meta's dashboard link) is left out. */
export function docsNav(): LocalNavSection[] {
  const map = (href: string, label: string): LocalNavLink => {
    const mapped = docsHref(href);
    return mapped.external ? { label, href: mapped.href, external: true } : { label, href: mapped.href };
  };
  return (navJson as NavSection[])
    .filter((section) => section.title !== "Product")
    .map((section) => ({
      title: section.title,
      items: section.items.map((entry) =>
        isNavGroup(entry)
          ? { label: entry.label, items: entry.items.map((item) => map(item.href, item.label)) }
          : map(entry.href, entry.label),
      ),
    }));
}
