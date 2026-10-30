import { swapEmDashes } from "@/lib/docs/markdown-text";

/**
 * The little Markdown the schemas pages' cells and descriptions use (code spans, bold, links, backslash escapes), as
 * tokens the explorer renders itself, plus the blocks a description splits into (paragraphs and "- " lists). Raw
 * HTML never gets in: text stays text. Em dashes in Meta's prose are swapped as the mirror does; code is left alone.
 */

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: InlineToken[] }
  | { kind: "link"; href: string; children: InlineToken[] };

export type Block = { kind: "p"; tokens: InlineToken[] } | { kind: "ul"; items: InlineToken[][] };

function unescape(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
}

function pushText(out: InlineToken[], text: string) {
  if (!text) return;
  const t = swapEmDashes(unescape(text));
  const last = out[out.length - 1];
  if (last?.kind === "text") last.text += t;
  else out.push({ kind: "text", text: t });
}

/** Finds the bracket that closes the one at `open`, skipping code spans and escapes. */
function closingBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") {
      const end = s.indexOf("`", i + 1);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]" && --depth === 0) return i;
  }
  return -1;
}

export function inlineTokens(md: string): InlineToken[] {
  const out: InlineToken[] = [];
  let i = 0;
  let text = "";
  const flush = () => {
    pushText(out, text);
    text = "";
  };
  while (i < md.length) {
    const ch = md[i];
    if (ch === "\\" && i + 1 < md.length) {
      text += md.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = md.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ kind: "code", text: md.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "*" && md.startsWith("**", i)) {
      const end = md.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "strong", children: inlineTokens(md.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "[") {
      const close = closingBracket(md, i);
      if (close > i && md[close + 1] === "(") {
        const end = md.indexOf(")", close + 2);
        if (end > close) {
          flush();
          out.push({ kind: "link", href: md.slice(close + 2, end).trim(), children: inlineTokens(md.slice(i + 1, close)) });
          i = end + 1;
          continue;
        }
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** A description's paragraphs and lists. Lines that start with "- " inside a paragraph are list items. */
export function blocks(md: string): Block[] {
  const out: Block[] = [];
  for (const para of md.split(/\n{2,}/)) {
    const lines = para.split("\n");
    let prose: string[] = [];
    let items: string[] = [];
    const flushProse = () => {
      if (prose.length) out.push({ kind: "p", tokens: inlineTokens(prose.join(" ")) });
      prose = [];
    };
    const flushItems = () => {
      if (items.length) out.push({ kind: "ul", items: items.map(inlineTokens) });
      items = [];
    };
    for (const line of lines) {
      const item = /^\s*[-*]\s+(.*)$/.exec(line);
      if (item) {
        flushProse();
        items.push(item[1]);
      } else if (line.trim()) {
        flushItems();
        prose.push(line.trim());
      }
    }
    flushProse();
    flushItems();
  }
  return out;
}

/** Where a link in Meta's Markdown should go here: a schema on this page, a mirrored docs page, or out. */
export function linkTarget(href: string, pagePath: string): { kind: "schema"; anchor: string } | { kind: "docs"; href: string } | { kind: "external"; href: string } {
  const m = /^(?:https:\/\/dev\.meta\.ai)?\/docs\/([^#?]*)(?:#([^?]*))?$/.exec(href);
  if (m) {
    if (m[1] === pagePath && m[2]) return { kind: "schema", anchor: m[2] };
    return { kind: "docs", href: `/docs/${m[1]}${m[2] ? `#${m[2]}` : ""}` };
  }
  if (href.startsWith("#")) return { kind: "schema", anchor: href.slice(1) };
  return { kind: "external", href };
}

/** The plain text of tokens, for labels and search. */
export function plainText(tokens: readonly InlineToken[]): string {
  return tokens.map((t) => (t.kind === "text" || t.kind === "code" ? t.text : plainText(t.children))).join("");
}
