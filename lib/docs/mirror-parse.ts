/**
 * Parsing for the dev.meta.ai docs mirror (scripts/docs/sync-meta-docs.ts). Pure functions, no I/O, so they're tested
 * on saved pages.
 */

export const DOCS_ORIGIN = "https://dev.meta.ai";

export interface LlmsEntry {
  /** The llms.txt heading the page sits under: Guides, Protocols, API reference, Cookbook, Muse Code, ... */
  section: string;
  title: string;
  url: string;
  description: string;
}

export interface NavLink {
  label: string;
  /** A dev.meta.ai path such as /docs/tool-calling, /platform or /help. */
  href: string;
}

export interface NavGroup {
  label: string;
  items: NavLink[];
}

export type NavEntry = NavLink | NavGroup;

export interface NavSection {
  title: string;
  items: NavEntry[];
}

export interface HtmlHeading {
  level: number;
  id: string;
  text: string;
}

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return "items" in entry;
}

/** Markdown escapes llms.txt uses in titles and descriptions, such as "Q\&A" and "reasoning\_effort". */
function unescapeMd(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!&|<>])/g, "$1").trim();
}

/** The "- [Title](url): Description" entries of llms.txt, with the "## Section" each one sits under. */
export function parseLlmsTxt(text: string): LlmsEntry[] {
  const out: LlmsEntry[] = [];
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1];
      continue;
    }
    const entry = line.match(/^- \[(.+?)\]\((\S+?)\)(?::\s*(.*))?$/);
    if (entry) out.push({ section, title: unescapeMd(entry[1]), url: entry[2], description: unescapeMd(entry[3] ?? "") });
  }
  return out;
}

/** The docs slug of a dev.meta.ai docs URL: https://dev.meta.ai/docs/sam/overview.md is "sam/overview". */
export function slugOfDocsUrl(url: string): string | null {
  const match = url.match(/^https:\/\/dev\.meta\.ai\/docs\/([^?#]+?)(?:\.md)?(?:[?#].*)?$/);
  return match ? match[1].replace(/\/+$/, "") : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

function attr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match ? decodeEntities(match[1]) : undefined;
}

interface OpenTag {
  tag: string;
  role?: "title" | "item" | "children";
  href?: string;
  controls?: string;
  id?: string;
}

/**
 * The docs sidebar from a server-rendered dev.meta.ai docs page: its sections (Start here, Capabilities, ...), their
 * links, and the collapsible groups (a button whose aria-controls names the element holding the group's links).
 */
export function parseSideNav(html: string): NavSection[] {
  const sections: NavSection[] = [];
  const groups = new Map<string, NavGroup>();
  const stack: OpenTag[] = [];
  const childContainers: NavGroup[] = [];
  let text = "";
  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  const capturing = () => stack.some((t) => t.role === "title" || t.role === "item");
  const section = () => sections[sections.length - 1];
  const target = (): NavEntry[] | null => {
    const group = childContainers[childContainers.length - 1];
    if (group) return group.items;
    return section()?.items ?? null;
  };

  while ((match = token.exec(html))) {
    const [, closing, rawTag, attrs = "", selfClosing, data] = match;
    if (data !== undefined) {
      if (capturing()) text += decodeEntities(data);
      continue;
    }
    if (!rawTag) continue; // a comment
    const tag = rawTag.toLowerCase();
    if (!closing) {
      const cls = attr(attrs, "class") ?? "";
      const id = attr(attrs, "id");
      const open: OpenTag = { tag, id };
      if (cls.split(/\s+/).includes("astryx-side-nav-section")) sections.push({ title: "", items: [] });
      if (tag === "span" && id?.endsWith("-title") && sections.length && !section().title) {
        open.role = "title";
        text = "";
      } else if (cls.split(/\s+/).includes("astryx-side-nav-item")) {
        open.role = "item";
        open.href = attr(attrs, "href");
        open.controls = attr(attrs, "aria-controls");
        text = "";
      } else if (id && groups.has(id)) {
        open.role = "children";
        childContainers.push(groups.get(id) as NavGroup);
      }
      if (!VOID_TAGS.has(tag) && !selfClosing) stack.push(open);
      continue;
    }
    // A closing tag: pop to the matching open tag, finishing whatever it held.
    const at = stack.map((t) => t.tag).lastIndexOf(tag);
    if (at < 0) continue;
    while (stack.length > at) {
      const done = stack.pop() as OpenTag;
      if (done.role === "title") {
        if (sections.length) section().title = text.replace(/\s+/g, " ").trim();
        text = "";
      } else if (done.role === "item") {
        const label = text.replace(/\s+/g, " ").trim();
        text = "";
        const list = target();
        if (!label || !list) continue;
        if (done.href) list.push({ label, href: done.href });
        else if (done.controls) {
          const group: NavGroup = { label, items: [] };
          groups.set(done.controls, group);
          list.push(group);
        }
      } else if (done.role === "children") {
        childContainers.pop();
      }
    }
  }
  // Pages render the sidebar once for wide screens and again in the mobile drawer: keep the first copy of each title.
  const seen = new Set<string>();
  return sections.filter((s) => s.title && s.items.length && !seen.has(s.title) && Boolean(seen.add(s.title)));
}

/**
 * The article's headings with their anchor ids, h1 to h6: deep pages such as muse-glimmer/deploy link to their H5s.
 * React's generated ids (they start with "_") belong to dialogs.
 */
export function htmlHeadings(html: string): HtmlHeading[] {
  const out: HtmlHeading[] = [];
  const re = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const id = attr(match[2], "id");
    if (!id || id.startsWith("_")) continue;
    const text = decodeEntities(match[3].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    out.push({ level: Number(match[1]), id, text });
  }
  return out;
}

/** Heading text reduced to lowercase words, so Markdown and HTML copies of a heading compare equal. */
export function normalizeHeading(text: string): string {
  return decodeEntities(text)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_\\]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const MD_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Adds the live page's anchor to each Markdown heading as a trailing "{#id}", matching headings in order by their
 * text, so links like /docs/tool-calling#chat-completions-tool-calling land where they do on dev.meta.ai.
 */
export function injectHeadingIds(md: string, headings: HtmlHeading[]): { md: string; matched: number; total: number } {
  const lines = md.split("\n");
  let fence: string | null = null;
  let next = 0;
  let matched = 0;
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = lines[i].match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = lines[i].match(MD_HEADING);
    if (!heading || /\{#[^}]+\}$/.test(heading[2])) continue;
    total++;
    const want = normalizeHeading(heading[2]);
    for (let k = next; k < Math.min(headings.length, next + 8); k++) {
      if (normalizeHeading(headings[k].text) === want) {
        lines[i] = `${heading[1]} ${heading[2]} {#${headings[k].id}}`;
        next = k + 1;
        matched++;
        break;
      }
    }
  }
  return { md: lines.join("\n"), matched, total };
}
