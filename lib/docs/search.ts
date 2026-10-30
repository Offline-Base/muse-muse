import { swapEmDashes } from "@/lib/docs/markdown-text";

/**
 * The docs search: an index of every mirrored page (title, sidebar label, description, section, and its H2 and H3
 * headings with their anchors) that app/docs/search.json serves, and the fuzzy-ish matcher the search palette runs on
 * it in the browser. Pure: the index builder takes the pages, the nav and a Markdown reader as arguments, so this
 * module never touches the filesystem and is safe to import from client code.
 */

export interface SearchHeading {
  id: string;
  text: string;
  depth: 2 | 3;
}

export interface SearchPage {
  slug: string;
  /** /docs/<slug> */
  href: string;
  title: string;
  /** The page's label in the sidebar when it differs from its title ("Choosing an API" for "Protocols"). */
  navLabel?: string;
  description: string;
  /** The sidebar section ("Capabilities", "API reference"), or the llms.txt section for pages not in the sidebar. */
  section: string;
  headings: SearchHeading[];
}

export interface SearchIndex {
  version: 1;
  pages: SearchPage[];
}

export interface SearchHit {
  kind: "page" | "heading";
  href: string;
  /** The page title, or the heading text for a heading hit. */
  title: string;
  /** Where it lives: "Capabilities" for a page, "Capabilities · Tool calling" for a heading. */
  context: string;
  description?: string;
  score: number;
}

interface IndexInput {
  pages: readonly { slug: string; title: string; description: string; listSection: string }[];
  nav: readonly { title: string; items: readonly ({ label: string; href: string } | { label: string; items: readonly { label: string; href: string }[] })[] }[];
  markdown: (slug: string) => string;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{2,3})\s+(.+?)\s*\{#([^}\s]+)\}\s*$/;

/** Heading text without Markdown: links keep their text, code and emphasis markers go, escapes resolve. */
function headingText(md: string): string {
  // Escaped characters (\_ in "reasoning\_effort") are set aside first so the emphasis pass can't eat them.
  const kept: string[] = [];
  const plain = md
    .replace(/\\([\\`*_{}[\]()#+\-.!&|<>])/g, (_, ch: string) => `\u0000${kept.push(ch) - 1}\u0000`)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|\*|_)(?=\S)([^*_]+?)\1/g, "$2")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)])
    .trim();
  return swapEmDashes(plain, "heading");
}

/** The H2 and H3 headings of a mirrored page that carry an {#id} anchor, skipping fenced code. */
export function headingsFromMarkdown(md: string): SearchHeading[] {
  const out: SearchHeading[] = [];
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    const f = line.match(FENCE);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const m = line.match(HEADING);
    if (m) out.push({ id: m[3], text: headingText(m[2]), depth: m[1].length as 2 | 3 });
  }
  return out;
}

/** Builds the index the palette loads from /docs/search.json. */
export function buildSearchIndex({ pages, nav, markdown }: IndexInput): SearchIndex {
  const navInfo = new Map<string, { label: string; section: string }>();
  for (const section of nav) {
    for (const entry of section.items) {
      const links = "items" in entry ? entry.items : [entry];
      for (const link of links) {
        const slug = link.href.match(/^\/docs\/([^#?]+)/)?.[1];
        if (slug && !navInfo.has(slug)) navInfo.set(slug, { label: link.label, section: section.title });
      }
    }
  }
  return {
    version: 1,
    pages: pages.map((p) => {
      const info = navInfo.get(p.slug);
      const page: SearchPage = {
        slug: p.slug,
        href: `/docs/${p.slug}`,
        title: swapEmDashes(p.title, "heading"),
        description: swapEmDashes(p.description),
        section: info?.section ?? p.listSection,
        headings: headingsFromMarkdown(markdown(p.slug)),
      };
      if (info && info.label !== p.title) page.navLabel = info.label;
      return page;
    }),
  };
}

// ---------- Matching ----------

export function normalizeQuery(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The query's letters appear in order in the text: "tlcl" in "tool calling". Scores tighter matches higher. */
function subsequence(query: string, text: string): number {
  const q = query.replace(/ /g, "");
  if (q.length < 3) return 0;
  let at = -1;
  let gaps = 0;
  for (const ch of q) {
    const next = text.indexOf(ch, at + 1);
    if (next < 0) return 0;
    if (at >= 0) gaps += next - at - 1;
    at = next;
  }
  return Math.max(1, 14 - Math.min(13, Math.floor(gaps / 2)));
}

/**
 * How well one piece of text matches the query, 0 for no match: the whole query as a word-start prefix beats it
 * anywhere in the text, which beats every query word starting a word, which beats the letters in order.
 */
export function matchScore(query: string, text: string): number {
  const q = normalizeQuery(query);
  const t = normalizeQuery(text);
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 90 - Math.min(20, (t.length - q.length) / 4);
  const at = t.indexOf(q);
  if (at >= 0) return (t[at - 1] === " " ? 75 : 60) - Math.min(15, at / 8);
  const words = t.split(" ");
  const terms = q.split(" ");
  if (terms.every((term) => words.some((w) => w.startsWith(term)))) return 50 + Math.min(10, terms.length * 2);
  if (terms.every((term) => t.includes(term))) return 35;
  return subsequence(q, t);
}

/** The best hits for a query: pages by title, sidebar label and description, and headings by their text. */
export function searchDocs(index: SearchIndex, query: string, limit = 20): SearchHit[] {
  if (!normalizeQuery(query)) return [];
  const hits: SearchHit[] = [];
  for (const page of index.pages) {
    const titleScore = Math.max(matchScore(query, page.title), page.navLabel ? matchScore(query, page.navLabel) : 0);
    const descScore = matchScore(query, page.description);
    // Descriptions only count for real word matches, not scattered letters.
    const pageScore = Math.max(titleScore * 1.2, descScore >= 35 ? descScore * 0.6 : 0);
    if (pageScore > 0) {
      hits.push({
        kind: "page",
        href: page.href,
        title: page.title,
        context: page.section,
        description: page.description,
        score: pageScore + (titleScore >= 90 ? 10 : 0),
      });
    }
    for (const h of page.headings) {
      const s = matchScore(query, h.text);
      if (s >= 20) {
        hits.push({
          kind: "heading",
          href: `${page.href}#${h.id}`,
          title: h.text,
          context: `${page.section} · ${page.title}`,
          score: s * (h.depth === 2 ? 0.95 : 0.9),
        });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || a.title.length - b.title.length);
  const seen = new Set<string>();
  return hits.filter((h) => !seen.has(h.href) && Boolean(seen.add(h.href))).slice(0, limit);
}
