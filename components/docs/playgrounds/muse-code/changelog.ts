import { swapEmDashes, swapEmDashesAfterCode } from "@/lib/docs/markdown-text";

/**
 * Muse Code's changelog (content/meta-docs/pages/muse-code/changelog.md, 240 KB) as data: releases newest first, each
 * with its New, Improvements, Fixes and Performance sections, plus the "Also delivered in ... patches" notes. It reads
 * either the mirror's Markdown (with {#id} anchors) or the copy route's (/docs/md/..., anchors removed), and works the
 * anchors out the same way the page has them, so every result links to its place on the page. The page gives no
 * release dates, so versions are the timeline.
 */

export type ItemType = "New" | "Improvements" | "Fixes" | "Performance" | "Notes";

export const ITEM_TYPES: readonly ItemType[] = ["New", "Improvements", "Fixes", "Performance", "Notes"];

export interface Section {
  type: ItemType;
  anchor: string;
  items: string[];
}

export interface Release {
  version: string;
  anchor: string;
  sections: Section[];
}

const HEADING = /^(#{2,3})\s+(.*?)\s*(?:\{#([^}\s]+)\})?\s*$/;
const KNOWN: Record<string, ItemType> = { new: "New", improvements: "Improvements", fixes: "Fixes", performance: "Performance" };

/**
 * Meta's prose uses em dashes; Muse Muse shows none, so they're swapped outside code spans the way the mirror and its
 * copy route do (lib/docs/markdown-text): ", " in prose, ": " right after a code span. Code spans keep theirs.
 */
export function cleanText(text: string): string {
  return text
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : i > 0 ? swapEmDashesAfterCode(part) : swapEmDashes(part)))
    .join("")
    .trim();
}

export function versionAnchor(version: string): string {
  return `v${version.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  const seen: Record<string, number> = {};
  let release: Release | null = null;
  let section: Section | null = null;
  const notes = (r: Release): Section => {
    let s = r.sections.find((x) => x.type === "Notes");
    if (!s) {
      s = { type: "Notes", anchor: r.anchor, items: [] };
      r.sections.push(s);
    }
    return s;
  };
  for (const raw of md.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const h = HEADING.exec(line);
    if (h) {
      const text = h[2];
      if (h[1] === "##") {
        release = { version: text, anchor: h[3] ?? versionAnchor(text), sections: [] };
        releases.push(release);
        section = null;
      } else if (release) {
        const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const n = seen[slug] ?? 0;
        seen[slug] = n + 1;
        section = { type: KNOWN[slug] ?? "Notes", anchor: h[3] ?? (n ? `${slug}-${n}` : slug), items: [] };
        release.sections.push(section);
      }
      continue;
    }
    if (!release) continue;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      (section ?? notes(release)).items.push(cleanText(bullet[1]));
      continue;
    }
    if (!line.trim()) continue;
    const target = section ?? notes(release);
    // A continuation line of the bullet above, or a paragraph of its own (the "Also delivered in" notes).
    if (/^\s{2,}\S/.test(raw) && target.items.length) target.items[target.items.length - 1] += ` ${cleanText(line)}`;
    else target.items.push(cleanText(line));
  }
  return releases;
}

export function isSecurity(item: string): boolean {
  return /^\*\*Security:?\*\*/i.test(item);
}

export interface Filter {
  /** Indexes into the releases array (0 is the newest), inclusive. */
  newest: number;
  oldest: number;
  types: readonly ItemType[];
  securityOnly: boolean;
  query: string;
}

export interface FilteredRelease {
  release: Release;
  sections: Array<{ section: Section; items: string[] }>;
  count: number;
}

/** Plain text for matching: no backticks, bold markers or link targets. */
export function plain(item: string): string {
  return item
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .toLowerCase();
}

export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

export function filterChangelog(releases: readonly Release[], f: Filter): { results: FilteredRelease[]; total: number } {
  const words = queryWords(f.query);
  const lo = Math.max(0, Math.min(f.newest, f.oldest));
  const hi = Math.min(releases.length - 1, Math.max(f.newest, f.oldest));
  const results: FilteredRelease[] = [];
  let total = 0;
  for (let i = lo; i <= hi; i++) {
    const release = releases[i];
    const sections = release.sections
      .filter((s) => f.types.includes(s.type))
      .map((section) => ({
        section,
        items: section.items.filter((item) => (!f.securityOnly || isSecurity(item)) && words.every((w) => plain(item).includes(w))),
      }))
      .filter((s) => s.items.length);
    const count = sections.reduce((n, s) => n + s.items.length, 0);
    if (count) {
      results.push({ release, sections, count });
      total += count;
    }
  }
  return { results, total };
}

/** The filtered results as Markdown, to paste into an issue or hand to a coding agent. */
export function toMarkdown(results: readonly FilteredRelease[], pageUrl = "https://dev.meta.ai/docs/muse-code/changelog"): string {
  const out: string[] = [];
  for (const r of results) {
    out.push(`## ${r.release.version} (${pageUrl}#${r.release.anchor})`, "");
    for (const s of r.sections) {
      out.push(`### ${s.section.type}`, "", ...s.items.map((i) => `- ${i}`), "");
    }
  }
  return out.join("\n").trim();
}

export type Inline = { kind: "text" | "code" | "strong"; text: string } | { kind: "link"; text: string; href: string };

/** Inline Markdown in an item: `code`, **bold** and [links](url). Everything else is text. */
export function inlineParts(item: string): Inline[] {
  const parts: Inline[] = [];
  const re = /(`+)([^`]+?)\1|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (let m = re.exec(item); m; m = re.exec(item)) {
    if (m.index > at) parts.push({ kind: "text", text: item.slice(at, m.index) });
    if (m[2] !== undefined) parts.push({ kind: "code", text: m[2] });
    else if (m[3] !== undefined) parts.push({ kind: "strong", text: m[3] });
    else parts.push({ kind: "link", text: m[4], href: m[5] });
    at = m.index + m[0].length;
  }
  if (at < item.length) parts.push({ kind: "text", text: item.slice(at) });
  return parts;
}
