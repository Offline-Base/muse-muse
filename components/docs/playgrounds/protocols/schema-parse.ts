import { slugifyHeading } from "@/lib/docs/markdown-text";

/**
 * The API reference's schemas pages (api-reference/responses/schemas, chat-completions/schemas, messages/schemas) as
 * data: one entry per "### Name {#anchor}" section with its description, its "Type:" line (unions, enums, aliases)
 * or its field table, and the schemas it points at. The explorer reads the page's Markdown from /docs/md/<slug>,
 * which drops the {#id} anchors, so an anchor comes from the heading the way the mirror makes them (slugifyHeading,
 * which matches every anchor on these pages; the tests check that against the raw files). Pure and fast: the
 * Responses page (146 schemas, 226 KB) parses in a few milliseconds.
 */

export interface SchemaField {
  /** "usage", or a nested row such as "input_tokens_details.cached_tokens" or "annotations[].type". */
  name: string;
  /** The type cell's Markdown, escaped pipes restored: "`string` | `null`", "array of [`OutputItem`](...#output-item)". */
  type: string;
  required: boolean;
  /** The description cell's Markdown. */
  description: string;
}

export interface SchemaDef {
  /** The heading: "Create Response". */
  name: string;
  anchor: string;
  /** The name the page's links use: "CreateResponse". */
  code: string;
  /** The text between the heading and the table or Type line, paragraphs split by blank lines. */
  description: string;
  /** The "Type:" line's Markdown, for unions, enums and aliases. */
  typeLine: string | null;
  fields: SchemaField[];
  /** Anchors of the schemas this one's types point at, each once, in order. */
  refs: string[];
}

export interface SchemaPage {
  title: string;
  intro: string;
  schemas: SchemaDef[];
  byAnchor: Record<string, SchemaDef>;
  /** The schemas whose types point at each anchor. */
  usedBy: Record<string, string[]>;
  /** Link name to anchor, as the page's own links pair them. */
  codeToAnchor: Record<string, string>;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*(?:\{#([^}\s]+)\})?\s*$/;
/** A link to a schema on a schemas page: [`Name`](https://dev.meta.ai/docs/api-reference/x/schemas#anchor). */
const SCHEMA_LINK = /\[`?([^`\]]+?)`?\]\((?:https:\/\/dev\.meta\.ai)?(?:\/docs\/[^)#\s]*\/schemas)?#([a-z0-9-]+)\)/g;

/** Splits a table row at the pipes that aren't escaped, and restores the escaped ones. */
export function tableCells(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === "\\" && row[i + 1] === "|") {
      current += "|";
      i++;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else current += ch;
  }
  cells.push(current.trim());
  // A row starts and ends with a pipe: drop the empty edges.
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function unwrapCode(text: string): string {
  const m = /^`([^`]*)`$/.exec(text.trim());
  return m ? m[1] : text.trim();
}

/** Anchors a piece of Markdown links to on a schemas page, each once. */
export function linkedAnchors(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(SCHEMA_LINK)) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

export function parseSchemaPage(md: string): SchemaPage {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let title = "";
  const intro: string[] = [];
  const schemas: SchemaDef[] = [];
  let current: (SchemaDef & { paras: string[][]; inTable: boolean; header: boolean }) | null = null;
  let seenH2 = false;

  const finish = () => {
    if (!current) return;
    const { paras, inTable: _t, header: _h, ...def } = current;
    def.description = paras
      .filter((p) => p.length)
      .map((p) => p.reduce((acc, line) => (!acc ? line : /^\s*[-*] /.test(line) ? `${acc}\n${line}` : `${acc} ${line}`), ""))
      .join("\n\n");
    const refs = [def.typeLine ?? "", ...def.fields.map((f) => f.type)].flatMap(linkedAnchors);
    def.refs = refs.filter((a, i) => refs.indexOf(a) === i && a !== def.anchor);
    schemas.push(def);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      if (level === 1 && !title) title = h[2];
      if (level <= 2) {
        finish();
        if (level === 2) seenH2 = true;
        continue;
      }
      if (level === 3) {
        finish();
        const name = h[2];
        const anchor = h[3] ?? slugifyHeading(name);
        current = { name, anchor, code: name.replace(/\s+/g, ""), description: "", typeLine: null, fields: [], refs: [], paras: [[]], inTable: false, header: false };
        continue;
      }
    }
    if (!current) {
      if (!seenH2 && title && line.trim()) intro.push(line.trim());
      continue;
    }
    if (line.trim().startsWith("|")) {
      const cells = tableCells(line.trim());
      if (!current.inTable) {
        current.inTable = true;
        current.header = true;
        continue;
      }
      if (current.header && isSeparator(cells)) {
        current.header = false;
        continue;
      }
      const [field = "", type = "", required = "", ...rest] = cells;
      const name = unwrapCode(field);
      if (name) current.fields.push({ name, type, required: /^yes$/i.test(required.trim()), description: rest.join(" | ") });
      continue;
    }
    current.inTable = false;
    if (/^Type:\s/.test(line.trim())) {
      current.typeLine = line.trim().replace(/^Type:\s*/, "");
      continue;
    }
    if (!line.trim()) {
      if (current.paras[current.paras.length - 1].length) current.paras.push([]);
      continue;
    }
    current.paras[current.paras.length - 1].push(line.trim());
  }
  finish();

  const byAnchor: Record<string, SchemaDef> = {};
  for (const s of schemas) byAnchor[s.anchor] = s;

  // The page's own links pair each schema's code name with its anchor; a schema nothing links to keeps its heading.
  const codeToAnchor: Record<string, string> = {};
  for (const m of md.matchAll(SCHEMA_LINK)) {
    if (byAnchor[m[2]] && !codeToAnchor[m[1]]) codeToAnchor[m[1]] = m[2];
  }
  for (const [code, anchor] of Object.entries(codeToAnchor)) {
    const s = byAnchor[anchor];
    if (s && s.code === s.name.replace(/\s+/g, "")) s.code = code;
  }
  for (const s of schemas) if (!codeToAnchor[s.code]) codeToAnchor[s.code] = s.anchor;

  // Some cells name schemas in code rather than as links ("`array of InputTextContentParam | InputFileContentParam`",
  // "`array of ChatCompletionTool`"): with every code name known now, those count as references too.
  for (const s of schemas) {
    const named = [s.typeLine ?? "", ...s.fields.map((f) => f.type)].flatMap((cell) => refAnchors(parseTypeExpr(cell, codeToAnchor)));
    for (const a of named) if (a !== s.anchor && byAnchor[a] && !s.refs.includes(a)) s.refs.push(a);
  }

  const usedBy: Record<string, string[]> = {};
  for (const s of schemas) {
    for (const r of s.refs) (usedBy[r] ??= []).push(s.anchor);
  }

  return { title, intro: intro.join(" "), schemas, byAnchor, usedBy, codeToAnchor };
}

// ---------- Types ----------

/** One alternative of a type cell or Type line. */
export type TypeAlt =
  | { kind: "string" | "integer" | "number" | "boolean" | "object" | "null" | "any" }
  | { kind: "enum"; values: string[] }
  | { kind: "array"; of: TypeAlt[] }
  | { kind: "ref"; code: string; anchor: string | null };

/** Splits a type at the pipes outside code spans, links and parentheses: "`string` | `null`" is two alternatives. */
function splitAlternatives(md: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let code = false;
  let current = "";
  for (const ch of md) {
    if (ch === "`") code = !code;
    if (!code && (ch === "[" || ch === "(")) depth++;
    if (!code && (ch === "]" || ch === ")")) depth = Math.max(0, depth - 1);
    if (ch === "|" && !code && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  out.push(current.trim());
  return out.filter((s) => s.length);
}

const PRIMITIVE = /^(string|integer|number|boolean|object|null)\b/;

/**
 * The inside of a code span: "string (uri)", "enum ('a', 'b')", "array of object", a schema's code name, or several
 * of those joined by pipes ("array of InputTextContentParam | InputFileContentParam").
 */
function parseCodeType(inner: string, codeToAnchor: Readonly<Record<string, string>>): TypeAlt[] {
  const t = inner.trim();
  const arr = /^array of (.+)$/s.exec(t);
  if (arr) return [{ kind: "array", of: parseCodeType(arr[1], codeToAnchor) }];
  const parts = splitAlternatives(t);
  if (parts.length > 1) return parts.flatMap((p) => parseCodeType(p, codeToAnchor));
  const en = /^enum \((.*)\)$/s.exec(t);
  if (en) return [{ kind: "enum", values: [...en[1].matchAll(/'([^']*)'/g)].map((m) => m[1]) }];
  const prim = PRIMITIVE.exec(t);
  if (prim) return [{ kind: prim[1] as "string" }];
  if (/^[A-Za-z][\w-]*$/.test(t)) return [{ kind: "ref", code: t, anchor: codeToAnchor[t] ?? null }];
  return [{ kind: "any" }];
}

function parseAlternative(alt: string, codeToAnchor: Readonly<Record<string, string>>): TypeAlt[] {
  const s = alt.trim();
  const arr = /^array of (.+)$/s.exec(s);
  if (arr) return [{ kind: "array", of: parseTypeExpr(arr[1], codeToAnchor) }];
  const link = /^\[`?([^`\]]+?)`?\]\(([^)]*)\)$/.exec(s);
  if (link) {
    const hash = link[2].includes("#") ? link[2].slice(link[2].indexOf("#") + 1) : null;
    return [{ kind: "ref", code: link[1], anchor: hash ?? codeToAnchor[link[1]] ?? null }];
  }
  const code = /^`([^`]*)`$/.exec(s);
  if (code) return parseCodeType(code[1], codeToAnchor);
  return [{ kind: "any" }];
}

/** The anchors a parsed type points at, arrays' items included, in order. */
function refAnchors(alts: readonly TypeAlt[]): string[] {
  return alts.flatMap((a) => (a.kind === "ref" ? (a.anchor ? [a.anchor] : []) : a.kind === "array" ? refAnchors(a.of) : []));
}

/** A type cell or Type line as its alternatives. An empty cell is "any". */
export function parseTypeExpr(md: string, codeToAnchor: Readonly<Record<string, string>> = {}): TypeAlt[] {
  const alts = splitAlternatives(md.trim());
  return alts.length ? alts.flatMap((a) => parseAlternative(a, codeToAnchor)) : [{ kind: "any" }];
}

/** A type in words: "string or null", "one of 'auto', 'none'", "array of OutputItem". */
export function describeType(alts: readonly TypeAlt[]): string {
  const one = (a: TypeAlt): string => {
    switch (a.kind) {
      case "enum":
        return a.values.length === 1 ? `'${a.values[0]}'` : `one of ${a.values.map((v) => `'${v}'`).join(", ")}`;
      case "array":
        return `array of ${a.of.map(one).join(" or ")}`;
      case "ref":
        return a.code;
      case "any":
        return "any value";
      default:
        return a.kind;
    }
  };
  return alts.map(one).join(" or ");
}

/** What kind of schema this is, for the explorer's badges and filters. */
export type SchemaKind = "object" | "event" | "union" | "enum" | "alias";

export function schemaKind(s: SchemaDef): SchemaKind {
  if (/ Event$/.test(s.name)) return "event";
  if (s.fields.length) return "object";
  const alts = parseTypeExpr(s.typeLine ?? "").filter((a) => a.kind !== "null");
  if (alts.length === 1 && alts[0].kind === "enum") return "enum";
  if (alts.length > 1) return "union";
  return "alias";
}

/** Lowercased text the search box matches against: names, field names and descriptions. */
export function searchText(s: SchemaDef): { name: string; fields: string; body: string } {
  return {
    name: `${s.name} ${s.code} ${s.anchor}`.toLowerCase(),
    fields: s.fields.map((f) => f.name).join(" ").toLowerCase(),
    body: `${s.description} ${s.typeLine ?? ""} ${s.fields.map((f) => `${f.type} ${f.description}`).join(" ")}`.toLowerCase(),
  };
}
