import { splitSentences } from "@/lib/knowledge/wikipedia";
import { longDate, PASSAGE_WORDS, type Passage } from "@/lib/knowledge/passages";

/**
 * One document from a source other than Wikipedia, as a collector in scripts/knowledge/sources/ writes it to
 * .data/knowledge/sources/<source>.jsonl. `visibility` says what a release may do with its text: "public" can be
 * published, "private" is training only (docs/KNOWLEDGE_UPDATE.md, Rules).
 */
export interface SourceRecord {
  id: string;
  source: string;
  title: string;
  url: string;
  /** Publish date, YYYY-MM-DD, or null for a living page such as a doc. */
  date: string | null;
  license: string;
  visibility: "public" | "private";
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: ", ", hellip: "...", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Plain text from a blog post's HTML: scripts, styles and figures go, and each block becomes its own paragraph. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|figure|svg|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section)>|<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text).replace(/[ \t]+/g, " ").replace(/\s*\n\s*(\n\s*)+/g, "\n\n").trim();
}

/** Plain text from a Markdown doc: code blocks, images and link targets go, and table rows become lines of text. */
export function markdownToText(md: string): string {
  return md
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, "\n\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "")
    .replace(/^\s*\|(.*)\|\s*$/gm, (_, row: string) => `${row.split("|").map((c) => c.trim()).join(", ")}.\n`)
    .replace(/^#{1,6}\s*(.*)$/gm, "\n\n$1.\n\n")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\.\.$/gm, ".")
    .replace(/\s*\n\s*(\n\s*)+/g, "\n\n")
    .trim();
}

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** The fewest words a passage needs to be worth questions, so headings and link lists aren't sent to the writer. */
export const MIN_PASSAGE_WORDS = 30;

/**
 * Contact details and family or age details of people. A passage holding any of these isn't sent to the writer, so
 * they can't become questions (docs/KNOWLEDGE_UPDATE.md, Rules: no personal data on private individuals).
 */
const PERSONAL_DETAIL = new RegExp(
  [
    String.raw`[\w.+-]+@[\w-]+\.[a-z]{2,}`,
    String.raw`\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b`,
    String.raw`\bfor (further|more) information,? (please )?contact\b`,
    String.raw`\b(media|press|investor)( relations)? (contacts?|inquiries)\b`,
    String.raw`\bproponent of this resolution\b`,
    String.raw`\blives (in .{1,40} )?with (his|her|their) (wife|husband|partner|family)\b`,
    String.raw`\bhas (two|three|four|five|six|\d) (daughters|sons|children)\b`,
    String.raw`\bAge: \d{2}\b`,
  ].join("|"),
  "i",
);

/** A record as passages of at most `max` words, cut between sentences, each with a header naming the source and date. */
export function sourcePassages(r: SourceRecord, asOf: string, max = PASSAGE_WORDS): Passage[] {
  const when = r.date ? `published ${longDate(r.date)}` : `as of ${longDate(asOf)}`;
  const runs: string[] = [];
  let run: string[] = [];
  let words = 0;
  const flush = () => {
    if (run.length) runs.push(run.join(" "));
    run = [];
    words = 0;
  };
  for (const paragraph of r.text.split(/\n\s*\n/)) {
    for (const sentence of splitSentences(paragraph.replace(/\s+/g, " ").trim()).filter(Boolean)) {
      const n = countWords(sentence);
      if (words && words + n > max) flush();
      run.push(sentence);
      words += n;
    }
  }
  flush();
  return runs
    .map((text, i) => ({ text, i }))
    .filter(({ text }) => countWords(text) >= MIN_PASSAGE_WORDS && !PERSONAL_DETAIL.test(text))
    .map(({ text, i }) => ({
      id: `source:${r.id}:${i}`,
      kind: "source" as const,
      header: `${r.source}: ${r.title}, ${when}`,
      text,
      date: r.date,
      url: r.url,
      words: countWords(text),
    }));
}
