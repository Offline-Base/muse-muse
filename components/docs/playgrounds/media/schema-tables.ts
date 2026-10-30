import { swapEmDashes, swapEmDashesAfterCode } from "@/lib/docs/markdown-text";

/**
 * Reads the schema tables on Meta's API reference "Schemas" pages (api-reference/images/schemas,
 * api-reference/files/schemas) into data the schema explorer can show, link and check bodies against. Each schema
 * is a "### Title {#anchor}" heading with an optional paragraph and a Field | Type | Required | Description table, or
 * a "Type: [`A`](...) | [`B`](...)" line for a schema that is one of several. Pure, so lib/docs/demos/media.ts runs it
 * on the mirrored Markdown on the server and hands the result to the explorer as plain JSON, and tests run it on the
 * same files. Parsing the page itself keeps the explorer in step with the page after every docs sync.
 */

export type FieldType =
  | { kind: "string" | "integer" | "number" | "boolean" | "object" | "binary" | "null"; format?: string }
  | { kind: "enum"; values: string[] }
  | { kind: "ref"; ref: string; name: string }
  | { kind: "array"; items: FieldType }
  | { kind: "union"; options: FieldType[] };

export interface FieldConstraints {
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: string | number | boolean;
}

export interface SchemaField {
  /** As the table writes it: "n", or a nested field such as "input_tokens_details.image_tokens". */
  name: string;
  type: FieldType;
  /** The type in words, without Markdown: "array of ImageInputItem", "integer (int64) | null". */
  typeLabel: string;
  required: boolean;
  /** The description without its "(minimum: 1, maximum: 10, default: 1)" suffix, inline code still in backticks. */
  description: string;
  constraints: FieldConstraints;
}

export interface SchemaRef {
  id: string;
  name: string;
}

export interface SchemaDoc {
  /** The heading's anchor, such as "create-image-request". Links on the page point at it. */
  id: string;
  /** The heading: "Create Image Request". */
  title: string;
  /** The name the page's links use: "CreateImageRequest". */
  name: string;
  description: string;
  fields: SchemaField[];
  /** For a schema that is one of several ("Type: A | B"), the schemas it can be. */
  oneOf?: SchemaRef[];
}

/**
 * Meta's prose with its em dashes swapped the way the page renderer does it (lib/docs/markdown-text.ts): ", " in
 * prose, ": " right after an inline code span, and never inside code. Muse Muse shows no em dash anywhere.
 */
export function proseWithoutEmDashes(text: string): string {
  return text
    .split(/(`[^`]*`)/g)
    .map((part, i, all) => (part.startsWith("`") ? part : i > 0 && all[i - 1].startsWith("`") ? swapEmDashesAfterCode(part) : swapEmDashes(part)))
    .join("");
}

/** Markdown escapes the mirror keeps in table cells and headings (b64\_json, file\_id). */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1");
}

/** Splits a table row on the pipes that aren't escaped (a type cell can hold "`integer` \| `null`"). */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      cell += "\\|";
      i++;
    } else if (ch === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  // A row starts and ends with a pipe, which leaves an empty cell at each end.
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map((c) => c.trim());
}

const REF = /^\[`?([A-Za-z0-9_]+)`?\]\([^)#]*#([a-z0-9-]+)\)$/;
const CODE = /^`([^`]+)`$/;

/** One type cell, or one part of a union. */
export function parseType(cell: string): FieldType {
  const parts = splitUnion(cell.trim());
  if (parts.length > 1) return { kind: "union", options: parts.map(parseOne) };
  return parseOne(parts[0] ?? "");
}

function splitUnion(cell: string): string[] {
  return cell
    .split(/\s*\\\|\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function parseOne(raw: string): FieldType {
  const text = raw.trim();
  const array = /^array of\s+(.+)$/i.exec(text);
  if (array) return { kind: "array", items: parseOne(array[1]) };
  const ref = REF.exec(text);
  if (ref) return { kind: "ref", name: ref[1], ref: ref[2] };
  const code = CODE.exec(text);
  const inner = unescapeMarkdown(code ? code[1] : text).trim();
  const enumMatch = /^enum\s*\((.*)\)$/i.exec(inner);
  if (enumMatch) {
    const values = [...enumMatch[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    return { kind: "enum", values };
  }
  const base = /^(string|integer|number|boolean|object|null)(?:\s*\(([^)]+)\))?$/i.exec(inner);
  if (base) {
    const kind = base[1].toLowerCase() as "string" | "integer" | "number" | "boolean" | "object" | "null";
    const format = base[2]?.trim();
    if (kind === "string" && format === "binary") return { kind: "binary", format };
    return format ? { kind, format } : { kind };
  }
  return { kind: "string" };
}

/** The type in words for display: "array of ImageInputItem", "integer (int64) | null", "enum: url, b64_json". */
export function typeLabel(type: FieldType): string {
  switch (type.kind) {
    case "ref":
      return type.name;
    case "array":
      return `array of ${typeLabel(type.items)}`;
    case "union":
      return type.options.map(typeLabel).join(" | ");
    case "enum":
      return `enum: ${type.values.join(", ")}`;
    case "binary":
      return "string (binary)";
    default:
      return type.format ? `${type.kind} (${type.format})` : type.kind;
  }
}

const CONSTRAINT_KEYS = ["minimum", "maximum", "minItems", "maxItems", "default"] as const;
const CONSTRAINT_TAIL = /\s*\(((?:minimum|maximum|minItems|maxItems|default)\s*:[^()]*)\)\s*$/;

function constraintValue(raw: string): string | number | boolean {
  const v = unescapeMarkdown(raw.trim());
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  if (v === "true" || v === "false") return v === "true";
  return v;
}

/** Splits "Range: 1-10. Defaults to 1. (minimum: 1, maximum: 10, default: 1)" into the prose and its constraints. */
export function splitConstraints(description: string): { description: string; constraints: FieldConstraints } {
  const m = CONSTRAINT_TAIL.exec(description);
  if (!m) return { description: description.trim(), constraints: {} };
  const constraints: FieldConstraints = {};
  for (const pair of m[1].split(/,\s*/)) {
    const at = pair.indexOf(":");
    if (at < 0) continue;
    const key = pair.slice(0, at).trim() as (typeof CONSTRAINT_KEYS)[number];
    if (!CONSTRAINT_KEYS.includes(key)) continue;
    const value = constraintValue(pair.slice(at + 1));
    if (key === "default") constraints.default = value;
    else if (typeof value === "number") constraints[key] = value;
  }
  return { description: description.slice(0, m.index).trim(), constraints };
}

/** "Create Image Request" becomes "CreateImageRequest", the name the page's links use. */
export function schemaName(title: string): string {
  return title.replace(/[^A-Za-z0-9]+/g, "");
}

const HEADING = /^###\s+(.+?)\s*\{#([a-z0-9-]+)\}\s*$/;

/** Every schema on a "Schemas" page, in page order. A page without tables gives an empty list. */
export function parseSchemaPage(md: string): SchemaDoc[] {
  const lines = md.split(/\r?\n/);
  const out: SchemaDoc[] = [];
  let current: SchemaDoc | null = null;
  let prose: string[] = [];

  const flushProse = () => {
    if (current && prose.length && !current.description) current.description = proseWithoutEmDashes(unescapeMarkdown(prose.join(" ").trim()));
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = HEADING.exec(line);
    if (heading) {
      flushProse();
      const title = swapEmDashes(unescapeMarkdown(heading[1]), "heading");
      current = { id: heading[2], title, name: schemaName(title), description: "", fields: [] };
      out.push(current);
      continue;
    }
    if (/^#{1,2}\s/.test(line)) {
      flushProse();
      current = null;
      continue;
    }
    if (!current) continue;

    const union = /^Type:\s*(.+)$/.exec(line.trim());
    if (union) {
      flushProse();
      current.oneOf = union[1]
        .split(/\s+\|\s+/)
        .map((p) => REF.exec(p.trim()))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ name: m[1], id: m[2] }));
      continue;
    }

    if (/^\|\s*Field\s*\|/.test(line)) {
      flushProse();
      // Header, then the --- row, then the fields until the table ends.
      let j = i + 1;
      if (j < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[j])) j++;
      for (; j < lines.length && lines[j].trim().startsWith("|"); j++) {
        const [nameCell = "", typeCell = "", requiredCell = "", descCell = ""] = splitRow(lines[j]);
        const name = unescapeMarkdown(nameCell.replace(/`/g, "")).trim();
        if (!name) continue;
        const type = parseType(typeCell);
        const { description, constraints } = splitConstraints(proseWithoutEmDashes(unescapeMarkdown(descCell)));
        current.fields.push({ name, type, typeLabel: typeLabel(type), required: /^yes$/i.test(requiredCell.trim()), description, constraints });
      }
      i = j - 1;
      continue;
    }

    if (line.trim()) prose.push(line.trim());
    else flushProse();
  }
  flushProse();
  return out;
}

/** The schema with this anchor or name. */
export function findSchema(schemas: readonly SchemaDoc[], idOrName: string): SchemaDoc | null {
  return schemas.find((s) => s.id === idOrName || s.name === idOrName) ?? null;
}
