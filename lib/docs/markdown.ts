import { Lexer, type Token, type Tokens } from "marked";
import { requestFromCode, type ParsedRequest } from "@/lib/docs/curl";
import { decodeEntities, DOCS_ORIGIN } from "@/lib/docs/mirror-parse";
import { slugifyHeading, swapEmDashes, swapEmDashesAfterCode } from "@/lib/docs/markdown-text";
import { docsHref } from "@/lib/docs/pages";

/**
 * Meta's Markdown (content/meta-docs/pages) as a plain, JSON-safe model the docs page renders: the H1, the lead, the
 * body blocks and the "On this page" headings. It follows the mirror's conventions (docs/DOCS_MIRROR.md, "Content"):
 * bold-only labels before fences become code tabs, "> **NOTE: Title**" blockquotes become callouts, link lists whose
 * items read "[Title](url): Description" become cards, an empty header row means a table without a head, and raw
 * HTML stays text. Em dashes in prose become ", " (": " in headings); code is never touched. lib/docs/markdown-react
 * adds highlighting and turns the model into React.
 */

export type Inline =
  | { k: "text"; text: string }
  | { k: "strong" | "em" | "del"; children: Inline[] }
  | { k: "code"; text: string }
  | { k: "link"; href: string; external: boolean; title?: string; children: Inline[] }
  | { k: "image"; src: string; alt: string; title?: string }
  | { k: "br" }
  | { k: "checkbox"; checked: boolean };

export interface CodeTab {
  /** The bold label written before the fence, such as "Python (OpenAI SDK)"; null for a plain fence. */
  label: string | null;
  /** The fence's language, "" when it has none. */
  lang: string;
  code: string;
  /** Highlighted HTML, filled in by lib/docs/markdown-react (shiki). */
  html?: string;
  /** The API request this block makes, when it's a runnable call to https://api.meta.ai/v1. */
  request: ParsedRequest | null;
}

export type CalloutKind = "note" | "tip" | "warning" | "important" | "caution";

export interface CardItem {
  href: string;
  external: boolean;
  title: Inline[];
  description: Inline[];
}

export type Block =
  | { k: "heading"; depth: 2 | 3 | 4 | 5 | 6; id: string; text: string; children: Inline[] }
  | { k: "paragraph"; children: Inline[] }
  /** The text of a tight list item: inline content without a paragraph around it. */
  | { k: "inline"; children: Inline[] }
  | { k: "figure"; src: string; alt: string; title?: string }
  | { k: "list"; ordered: boolean; start: number | null; items: Block[][] }
  | { k: "cards"; items: CardItem[] }
  | {
      k: "table";
      align: ("left" | "center" | "right" | null)[];
      /** Null when the Markdown's header row is empty, like the "At a glance" tables. */
      head: Inline[][] | null;
      rows: Inline[][][];
    }
  | { k: "callout"; kind: CalloutKind; title: Inline[]; children: Block[] }
  | { k: "quote"; children: Block[] }
  | { k: "code"; tabs: CodeTab[] }
  | { k: "diagram"; text: string }
  | { k: "hr" }
  /** Raw HTML from the Markdown, shown as text and never injected. */
  | { k: "raw"; text: string };

export interface TocItem {
  id: string;
  text: string;
  depth: 2 | 3;
}

export interface DocsDoc {
  title: Inline[];
  titleText: string;
  titleId: string;
  /** Everything before the first H2 (or the opening paragraphs when a page has no H2): it sits above "Try it live". */
  lead: Block[];
  body: Block[];
  /** H2 and H3 headings, for "On this page". */
  toc: TocItem[];
}

export interface ParseOptions {
  /** Maps a link from the Markdown to where it goes here. Defaults to docsHref (dev.meta.ai docs stay in /docs). */
  mapHref?: (href: string) => { href: string; external: boolean };
  /** Finds the runnable API call in a code block, given its fence language. Defaults to requestFromCode. */
  requestOf?: (code: string, lang: string) => ParsedRequest | null;
}

type Mode = "prose" | "heading";

const CALLOUT = /^(NOTE|TIP|WARNING|IMPORTANT|CAUTION):\s*/;
const ANCHOR_SUFFIX = /\s*\{#([^}\s]+)\}\s*$/;

/** The text an inline list reads as, for ids, labels and search. */
export function plainText(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.k) {
        case "text":
        case "code":
          return n.text;
        case "image":
          return n.alt;
        case "br":
          return " ";
        case "checkbox":
          return "";
        default:
          return plainText(n.children);
      }
    })
    .join("");
}

/** The plain text of marked's inline tokens, before any em dash swap. */
function tokenText(tokens: Token[] | undefined): string {
  return (tokens ?? [])
    .map((t) => {
      if (t.type === "codespan" || t.type === "escape") return (t as Tokens.Codespan).text;
      if (t.type === "text") return t.tokens?.length ? tokenText(t.tokens) : (t as Tokens.Text).text;
      if ("tokens" in t && t.tokens) return tokenText(t.tokens);
      return "text" in t && typeof t.text === "string" ? t.text : "";
    })
    .join("");
}

class Builder {
  private ids = new Set<string>();
  private mapHref: (href: string) => { href: string; external: boolean };
  private requestOf: (code: string, lang: string) => ParsedRequest | null;

  constructor(options: ParseOptions) {
    this.mapHref = options.mapHref ?? docsHref;
    this.requestOf = options.requestOf ?? requestFromCode;
  }

  /** A unique id: the heading's own {#id} when it has one, otherwise a slug of its text. */
  uniqueId(wanted: string | null, text: string): string {
    const base = wanted ?? slugifyHeading(text);
    let id = base;
    for (let n = 1; this.ids.has(id); n++) id = `${base}-${n}`;
    this.ids.add(id);
    return id;
  }

  inlines(tokens: Token[] | undefined, mode: Mode): Inline[] {
    const out: Inline[] = [];
    const text = (value: string) => {
      if (!value) return;
      const last = out[out.length - 1];
      if (last?.k === "text") last.text += value;
      else out.push({ k: "text", text: value });
    };
    for (const t of tokens ?? []) {
      switch (t.type) {
        case "text":
          if (!t.tokens?.length) {
            const raw = decodeEntities((t as Tokens.Text).text);
            // Right after a code span, a dash introduces what the code means: "HTTP 200: OK".
            text(mode === "prose" && out[out.length - 1]?.k === "code" ? swapEmDashesAfterCode(raw) : swapEmDashes(raw, mode));
          } else
            for (const n of this.inlines(t.tokens, mode)) {
              if (n.k === "text") text(n.text);
              else out.push(n);
            }
          break;
        case "escape":
          text((t as Tokens.Escape).text);
          break;
        case "strong":
        case "em":
        case "del":
          out.push({ k: t.type as "strong" | "em" | "del", children: this.inlines((t as Tokens.Strong).tokens, mode) });
          break;
        case "codespan":
          out.push({ k: "code", text: (t as Tokens.Codespan).text });
          break;
        case "br":
          out.push({ k: "br" });
          break;
        case "link": {
          const link = t as Tokens.Link;
          const mapped = this.mapHref(link.href);
          const node: Inline = { k: "link", href: mapped.href, external: mapped.external, children: this.inlines(link.tokens, mode) };
          if (link.title) node.title = swapEmDashes(link.title);
          out.push(node);
          break;
        }
        case "image": {
          const image = t as Tokens.Image;
          const node: Inline = { k: "image", src: absoluteSrc(image.href), alt: swapEmDashes(image.text) };
          if (image.title) node.title = swapEmDashes(image.title);
          out.push(node);
          break;
        }
        case "html":
          text((t as Tokens.HTML).raw);
          break;
        case "checkbox":
          out.push({ k: "checkbox", checked: (t as Tokens.Checkbox).checked });
          break;
        default:
          if ("text" in t && typeof t.text === "string") text(t.text);
      }
    }
    return out;
  }

  /** The bold-only paragraph before a fence that names its tab, or null. "Prompt:"-style labels stay prose. */
  tabLabel(t: Token | undefined): string | null {
    if (t?.type !== "paragraph") return null;
    const tokens = (t as Tokens.Paragraph).tokens.filter((x) => !(x.type === "text" && !(x as Tokens.Text).text.trim()));
    if (tokens.length !== 1 || tokens[0].type !== "strong") return null;
    const inner = (tokens[0] as Tokens.Strong).tokens;
    if (!inner.every((x) => x.type === "text" || x.type === "codespan" || x.type === "escape")) return null;
    const label = swapEmDashes(tokenText(inner).trim());
    return label && !label.endsWith(":") ? label : null;
  }

  codeTab(t: Tokens.Code, label: string | null): CodeTab {
    const lang = (t.lang ?? "").trim().split(/\s+/)[0].toLowerCase();
    return { label, lang, code: t.text, request: lang === "diagram" ? null : this.requestOf(t.text, lang) };
  }

  heading(t: Tokens.Heading): { id: string; text: string; children: Inline[] } {
    const tokens = [...t.tokens];
    let wanted: string | null = null;
    const last = tokens[tokens.length - 1];
    if (last?.type === "text") {
      const m = (last as Tokens.Text).text.match(ANCHOR_SUFFIX);
      if (m) {
        wanted = m[1];
        const rest = (last as Tokens.Text).text.slice(0, m.index);
        tokens[tokens.length - 1] = { ...(last as Tokens.Text), text: rest, raw: rest, tokens: undefined };
      }
    }
    const children = this.inlines(tokens, "heading");
    const text = plainText(children).trim();
    return { id: this.uniqueId(wanted, text), text, children };
  }

  callout(t: Tokens.Blockquote): Block | null {
    const tokens = t.tokens.filter((x) => x.type !== "space");
    const first = tokens[0];
    if (first?.type !== "paragraph") return null;
    const para = first as Tokens.Paragraph;
    const strong = para.tokens[0];
    if (strong?.type !== "strong") return null;
    const kind = tokenText((strong as Tokens.Strong).tokens).match(CALLOUT);
    if (!kind) return null;
    // Drop "NOTE: " from the bold text; what's left is the callout's title.
    const inner = [...(strong as Tokens.Strong).tokens];
    let cut = kind[0].length;
    while (cut > 0 && inner.length) {
      const head = inner[0];
      const value = head.type === "text" || head.type === "escape" ? (head as Tokens.Text).text : "";
      if (value.length <= cut) {
        cut -= value.length;
        inner.shift();
      } else {
        inner[0] = { ...(head as Tokens.Text), text: value.slice(cut), raw: value.slice(cut), tokens: undefined };
        cut = 0;
      }
    }
    const children: Block[] = [];
    const after = para.tokens.slice(1).filter((x) => !(x.type === "text" && !(x as Tokens.Text).text.trim()));
    if (after.length) children.push({ k: "paragraph", children: this.inlines(after, "prose") });
    children.push(...this.blocks(tokens.slice(1)));
    return {
      k: "callout",
      kind: kind[1].toLowerCase() as CalloutKind,
      title: this.inlines(inner, "heading"),
      children,
    };
  }

  /**
   * A list renders as cards when every item is one link, ": ", and a description that starts with a capital letter.
   * dev.meta.ai draws "Explore the docs" and the cookbook indexes as cards but keeps lowercase "See also" lists as
   * lists (checked against the live pages on Oct 30, 2026), so the capital is the tell.
   */
  cards(t: Tokens.List): CardItem[] | null {
    if (t.ordered || t.items.length === 0) return null;
    const items: CardItem[] = [];
    for (const item of t.items) {
      const parts = item.tokens.filter((x) => x.type !== "space");
      if (parts.length !== 1 || (parts[0].type !== "text" && parts[0].type !== "paragraph")) return null;
      const inline = ((parts[0] as Tokens.Text).tokens ?? []) as Token[];
      const [link, sep, ...rest] = inline;
      if (link?.type !== "link" || sep?.type !== "text") return null;
      const sepText = (sep as Tokens.Text).text;
      const m = sepText.match(/^:\s+/);
      if (!m) return null;
      const description = [{ ...(sep as Tokens.Text), text: sepText.slice(m[0].length), raw: sepText.slice(m[0].length), tokens: undefined }, ...rest];
      if (!/^[A-Z]/.test(tokenText(description))) return null;
      const mapped = this.mapHref((link as Tokens.Link).href);
      items.push({
        href: mapped.href,
        external: mapped.external,
        title: this.inlines((link as Tokens.Link).tokens, "heading"),
        description: this.inlines(description as Token[], "prose"),
      });
    }
    return items;
  }

  listItem(item: Tokens.ListItem): Block[] {
    const out = this.blocks(item.tokens);
    // A task item's checkbox arrives as its own token; fold it into the item's first line.
    const box = out.findIndex((b) => b.k === "inline" && b.children.length === 1 && b.children[0].k === "checkbox");
    if (box >= 0 && out[box + 1] && (out[box + 1].k === "inline" || out[box + 1].k === "paragraph")) {
      const next = out[box + 1] as { children: Inline[] };
      next.children.unshift(...(out[box] as { children: Inline[] }).children, { k: "text", text: " " });
      out.splice(box, 1);
    }
    return out;
  }

  blocks(tokens: Token[]): Block[] {
    const list = tokens.filter((t) => t.type !== "space" && t.type !== "def");
    const out: Block[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (this.tabLabel(t) !== null && isFence(list[i + 1])) {
        const tabs: CodeTab[] = [];
        let j = i;
        for (; j + 1 < list.length; j += 2) {
          const label = this.tabLabel(list[j]);
          if (label === null || !isFence(list[j + 1])) break;
          tabs.push(this.codeTab(list[j + 1] as Tokens.Code, label));
        }
        out.push({ k: "code", tabs });
        i = j - 1;
        continue;
      }
      switch (t.type) {
        case "heading": {
          const h = this.heading(t as Tokens.Heading);
          const depth = Math.min(6, Math.max(2, (t as Tokens.Heading).depth)) as 2 | 3 | 4 | 5 | 6;
          out.push({ k: "heading", depth, ...h });
          break;
        }
        case "paragraph": {
          const p = t as Tokens.Paragraph;
          const parts = p.tokens.filter((x) => !(x.type === "text" && !(x as Tokens.Text).text.trim()));
          if (parts.length === 1 && parts[0].type === "image") {
            const img = parts[0] as Tokens.Image;
            const figure: Block = { k: "figure", src: absoluteSrc(img.href), alt: swapEmDashes(img.text) };
            if (img.title) figure.title = swapEmDashes(img.title);
            out.push(figure);
          } else {
            out.push({ k: "paragraph", children: this.inlines(p.tokens, "prose") });
          }
          break;
        }
        case "text":
          out.push({ k: "inline", children: this.inlines((t as Tokens.Text).tokens ?? [t], "prose") });
          break;
        case "checkbox":
          out.push({ k: "inline", children: [{ k: "checkbox", checked: (t as Tokens.Checkbox).checked }] });
          break;
        case "code": {
          const code = t as Tokens.Code;
          if ((code.lang ?? "").trim().toLowerCase() === "diagram") out.push({ k: "diagram", text: code.text });
          else out.push({ k: "code", tabs: [this.codeTab(code, null)] });
          break;
        }
        case "blockquote":
          out.push(this.callout(t as Tokens.Blockquote) ?? { k: "quote", children: this.blocks((t as Tokens.Blockquote).tokens) });
          break;
        case "list": {
          const l = t as Tokens.List;
          const cards = this.cards(l);
          if (cards) out.push({ k: "cards", items: cards });
          else
            out.push({
              k: "list",
              ordered: l.ordered,
              start: l.ordered && typeof l.start === "number" ? l.start : null,
              items: l.items.map((item) => this.listItem(item)),
            });
          break;
        }
        case "table": {
          const table = t as Tokens.Table;
          const emptyHead = table.header.every((c) => !c.text.trim());
          out.push({
            k: "table",
            align: table.align,
            head: emptyHead ? null : table.header.map((c) => this.inlines(c.tokens, "prose")),
            rows: table.rows.map((row) => row.map((c) => this.inlines(c.tokens, "prose"))),
          });
          break;
        }
        case "hr":
          out.push({ k: "hr" });
          break;
        case "html":
          if ((t as Tokens.HTML).raw.trim()) out.push({ k: "raw", text: (t as Tokens.HTML).raw.trim() });
          break;
        default:
          if ("text" in t && typeof t.text === "string" && t.text.trim()) out.push({ k: "paragraph", children: [{ k: "text", text: t.text }] });
      }
    }
    return out;
  }
}

function isFence(t: Token | undefined): boolean {
  return t?.type === "code" && (t as Tokens.Code).lang?.trim().toLowerCase() !== "diagram";
}

function absoluteSrc(src: string): string {
  return src.startsWith("/") ? `${DOCS_ORIGIN}${src}` : src;
}

/** Parses one mirrored page. */
export function parseDocsMarkdown(md: string, options: ParseOptions = {}): DocsDoc {
  const builder = new Builder(options);
  const tokens = new Lexer({ gfm: true }).lex(md);
  const h1Index = tokens.findIndex((t) => t.type === "heading" && (t as Tokens.Heading).depth === 1);
  let title: Inline[] = [];
  let titleText = "";
  let titleId = "";
  if (h1Index >= 0) {
    const h = builder.heading(tokens[h1Index] as Tokens.Heading);
    title = h.children;
    titleText = h.text;
    titleId = h.id;
  }
  const blocks = builder.blocks(tokens.filter((_, i) => i !== h1Index));
  const firstH2 = blocks.findIndex((b) => b.k === "heading" && b.depth === 2);
  let split = firstH2;
  if (split < 0) {
    split = blocks.findIndex((b) => b.k !== "paragraph" && b.k !== "figure");
    if (split < 0) split = blocks.length;
  }
  const toc: TocItem[] = [];
  for (const b of blocks) {
    if (b.k === "heading" && (b.depth === 2 || b.depth === 3)) toc.push({ id: b.id, text: b.text, depth: b.depth });
  }
  return { title, titleText, titleId, lead: blocks.slice(0, split), body: blocks.slice(split), toc };
}

/** Every code tab in a list of blocks, nested ones included, for highlighting. */
export function codeTabsOf(blocks: Block[]): CodeTab[] {
  const out: CodeTab[] = [];
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.k === "code") out.push(...b.tabs);
      else if (b.k === "list") b.items.forEach(walk);
      else if (b.k === "callout" || b.k === "quote") walk(b.children);
    }
  };
  walk(blocks);
  return out;
}
