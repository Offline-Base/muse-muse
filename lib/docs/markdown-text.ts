/**
 * Small text helpers for the docs mirror that are safe on both server and client (no fs, no marked): the em dash
 * swap, heading slugs, and the copy-ready Markdown for "Copy page".
 */

import { DOCS_ORIGIN } from "@/lib/docs/mirror-parse";

const EM_DASH = /\s*\u2014\s*/g;

/**
 * Muse Muse never shows an em dash (docs/DOCS_MIRROR.md). Meta's prose uses them, so the mirror swaps each one, with
 * the spaces around it, for ", " in prose and ": " in headings, where "Step 1", a dash, "Connect" reads
 * "Step 1: Connect". Never run this on code.
 */
export function swapEmDashes(text: string, mode: "prose" | "heading" = "prose"): string {
  if (!text.includes("\u2014")) return text;
  const sep = mode === "heading" ? ": " : ", ";
  return text.replace(EM_DASH, sep).replace(/([,:;])\s*([,:]) /g, "$1 ");
}

const DASH_FIRST = /^\s*\u2014\s*/;

/**
 * The em dash swap for prose that comes right after an inline code span. A dash there introduces what the code means
 * ("`HTTP 200`", a dash, "OK"), so it becomes ": " and reads "HTTP 200: OK"; ", " beside a code chip's padding reads
 * as a stray comma.
 */
export function swapEmDashesAfterCode(text: string): string {
  return DASH_FIRST.test(text) ? `: ${swapEmDashes(text.replace(DASH_FIRST, ""))}` : swapEmDashes(text);
}

/** A GitHub-style anchor for a heading that has no {#id} of its own: lowercase words joined by hyphens. */
export function slugifyHeading(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-");
  return slug || "section";
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_ANCHOR = /^(#{1,6}\s.*?)\s*\{#[^}\s]+\}\s*$/;

/** Swaps em dashes in one line of Markdown prose, leaving `inline code` alone. */
function swapOutsideCodeSpans(line: string, mode: "prose" | "heading"): string {
  if (!line.includes("\u2014")) return line;
  // Split on backtick runs: even parts are prose, odd parts are code spans.
  const parts = line.split(/(`+[^`]*`+)/);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : i > 0 && mode === "prose" ? swapEmDashesAfterCode(part) : swapEmDashes(part, mode)))
    .join("");
}

/**
 * The page's Markdown as "Copy page" hands it to a reader or their coding agent: the {#id} anchors the mirror adds to
 * headings are removed, links and images that point at a path or an #anchor become absolute dev.meta.ai URLs, and em
 * dashes in prose are swapped like the rendered page. Code fences and code spans are copied exactly.
 */
export function markdownForCopy(md: string, slug: string): string {
  const pageUrl = `${DOCS_ORIGIN}/docs/${slug}`;
  let fence: string | null = null;
  return md
    .split("\n")
    .map((line) => {
      const fenceMatch = line.match(FENCE);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      if (fence) return line;
      const heading = line.match(HEADING_ANCHOR);
      const text = heading ? heading[1] : line;
      const linked = text
        .replace(/\]\((\/[^)\s]*)/g, `](${DOCS_ORIGIN}$1`)
        .replace(/\]\((#[^)\s]*)/g, `](${pageUrl}$1`);
      return swapOutsideCodeSpans(linked, /^#{1,6}\s/.test(linked) ? "heading" : "prose");
    })
    .join("\n");
}

/** "Oct 30, 2026" from an ISO time, read in UTC so the server and the browser agree. */
export function syncedDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
