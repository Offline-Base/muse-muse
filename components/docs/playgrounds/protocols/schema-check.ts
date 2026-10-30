import { describeValue } from "@/components/docs/playgrounds/protocols/flow";
import { describeType, parseTypeExpr, type SchemaDef, type SchemaPage, type TypeAlt } from "@/components/docs/playgrounds/protocols/schema-parse";

/**
 * A real request or reply held up against one schema's table on a schemas page: is each field there, is it the type
 * the table says, are the required ones present, and what else came back that the table doesn't list. Union members
 * are told apart by their `type` field when the table pins it to one value (OutputItem's members are message,
 * function_call, reasoning, ...), the way the API itself tells them apart. Pure, so the explorer's live checks are
 * tested on saved replies.
 */

export type FieldStatus = "ok" | "mismatch" | "missing" | "absent";

export interface FieldCheck {
  field: string;
  required: boolean;
  /** The table's type in words. */
  expected: string;
  status: FieldStatus;
  /** What came back, in a few words. */
  actual: string;
}

export interface SchemaCheck {
  fields: FieldCheck[];
  /** Top-level keys the value has that the table doesn't list. */
  extra: string[];
  /** For a union, enum or alias: does the value fit the Type line. Null for a table. */
  fits: boolean | null;
  /** One line for the result: "12 fields match, 1 required field missing". */
  summary: string;
  /** For a union: the member the value turned out to be, whose fields `fields` checks. */
  member?: string;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const MAX_DEPTH = 4;

/** Fields that tell a union's members apart: OutputItem's by type, ChatCompletionRequestMessage's by role. */
const TAGS = ["type", "role", "object"] as const;

/**
 * The values a table's tag fields are pinned to: type "message" for OutputMessage, role "developer" for a developer
 * message, type one of web_search and its dated names for the web search tool. Only enum-typed tags count.
 */
function discriminators(def: SchemaDef): Array<{ field: string; values: string[]; required: boolean }> {
  const out: Array<{ field: string; values: string[]; required: boolean }> = [];
  for (const tag of TAGS) {
    const f = def.fields.find((x) => x.name === tag);
    if (!f) continue;
    const alts = parseTypeExpr(f.type);
    const en = alts.length === 1 && alts[0].kind === "enum" ? alts[0] : null;
    if (en) out.push({ field: tag, values: en.values, required: f.required });
  }
  return out;
}

function resolveRef(alt: Extract<TypeAlt, { kind: "ref" }>, page: SchemaPage): SchemaDef | null {
  const anchor = alt.anchor ?? page.codeToAnchor[alt.code] ?? null;
  return anchor ? (page.byAnchor[anchor] ?? null) : null;
}

/** True when the value fits one alternative. Schemas named by reference are followed a few levels deep. */
export function fitsAlt(alt: TypeAlt, v: unknown, page: SchemaPage, depth = 0): boolean {
  switch (alt.kind) {
    case "any":
      return true;
    case "string":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "object":
      return isObject(v);
    case "null":
      return v === null;
    case "enum":
      return (typeof v === "string" || typeof v === "boolean" || typeof v === "number") && alt.values.includes(String(v));
    case "array":
      return Array.isArray(v) && (depth >= MAX_DEPTH || v.every((item) => alt.of.some((a) => fitsAlt(a, item, page, depth + 1))));
    case "ref": {
      const def = resolveRef(alt, page);
      if (!def || depth >= MAX_DEPTH) return true;
      return fitsSchema(def, v, page, depth + 1);
    }
  }
}

/** True when a value fits a schema as a whole: its table (with its `type` pinned) or its Type line. */
export function fitsSchema(def: SchemaDef, v: unknown, page: SchemaPage, depth = 0): boolean {
  if (def.fields.length) {
    if (!isObject(v)) return false;
    // A member whose tag doesn't match, or that requires a tag the value lacks, isn't this one.
    for (const d of discriminators(def)) {
      const tag = v[d.field];
      if (tag === undefined ? d.required : !d.values.includes(String(tag))) return false;
    }
    return true;
  }
  if (!def.typeLine) return true;
  return parseTypeExpr(def.typeLine, page.codeToAnchor).some((a) => fitsAlt(a, v, page, depth));
}

/** The values a field row names: "a.b" steps into objects, "items[].x" into each item of an array. */
function valuesAt(root: unknown, name: string): { parentMissing: boolean; values: unknown[] } {
  const parts = name.split(".");
  let parents: unknown[] = [root];
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const each = part.endsWith("[]");
    const key = each ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const p of parents) {
      if (!isObject(p)) continue;
      const v = p[key];
      if (each) {
        if (Array.isArray(v)) next.push(...v);
      } else if (v !== undefined && v !== null) next.push(v);
    }
    parents = next;
    if (!parents.length) return { parentMissing: true, values: [] };
  }
  const last = parts[parts.length - 1].replace(/\[\]$/, "");
  return { parentMissing: false, values: parents.map((p) => (isObject(p) ? p[last] : undefined)) };
}

/** What a value is, in a word or two, for a mismatch: "null", "a string", "an array of 2". */
function typeWord(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? `an array of ${v.length}` : "an empty array";
  if (typeof v === "number") return Number.isInteger(v) ? `the integer ${v}` : `the number ${v}`;
  if (typeof v === "string") return `the string ${describeValue(v, 40)}`;
  if (typeof v === "boolean") return String(v);
  if (isObject(v)) return typeof v.type === "string" ? `an object of type "${v.type}"` : "an object";
  return typeof v;
}

function cap(text: string): string {
  return text.replace(/^./, (c) => c.toUpperCase());
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Holds a value up against one schema. */
export function checkSchema(def: SchemaDef, value: unknown, page: SchemaPage, depth = 0): SchemaCheck {
  if (!def.fields.length) {
    const alts = parseTypeExpr(def.typeLine ?? "", page.codeToAnchor);
    if (value === undefined) return { fields: [], extra: [], fits: false, summary: "Nothing at this spot in the example to check." };
    // A union of schemas: find the member the value is (told apart by type), then check it field by field.
    const members = alts.filter((a): a is Extract<TypeAlt, { kind: "ref" }> => a.kind === "ref");
    if (members.length > 1 && depth < 2) {
      const member = members.map((m) => resolveRef(m, page)).find((m): m is SchemaDef => !!m && fitsSchema(m, value, page));
      if (member) {
        const inner = checkSchema(member, value, page, depth + 1);
        return { ...inner, member: member.anchor, summary: `Matches ${member.code}, one of the ${members.length} alternatives. ${inner.summary}` };
      }
      return { fields: [], extra: [], fits: false, summary: `${cap(typeWord(value))} matches none of the ${members.length} alternatives.` };
    }
    const fits = alts.some((a) => fitsAlt(a, value, page));
    const named = describeType(alts);
    const shown = named.length > 160 ? `${named.slice(0, 157).replace(/,[^,]*$/, "")}, ...` : named;
    return { fields: [], extra: [], fits, summary: `${cap(typeWord(value))} ${fits ? "fits" : "doesn't fit"} ${shown}.` };
  }

  const fields: FieldCheck[] = def.fields.map((f) => {
    const alts = parseTypeExpr(f.type, page.codeToAnchor);
    const expected = describeType(alts);
    const { parentMissing, values } = valuesAt(value, f.name);
    const base = { field: f.name, required: f.required, expected };
    if (parentMissing || !values.length) return { ...base, status: "absent" as const, actual: "not here" };
    const present = values.filter((v) => v !== undefined);
    if (present.length < values.length) {
      if (f.required) return { ...base, status: "missing" as const, actual: present.length ? `missing in ${values.length - present.length} of ${values.length}` : "missing" };
      if (!present.length) return { ...base, status: "absent" as const, actual: "not sent" };
    }
    const bad = present.find((v) => !alts.some((a) => fitsAlt(a, v, page)));
    if (bad !== undefined) return { ...base, status: "mismatch" as const, actual: typeWord(bad) };
    return { ...base, status: "ok" as const, actual: present.length === 1 ? describeValue(present[0], 48) : `${present.length} values` };
  });

  const listed = new Set(def.fields.map((f) => f.name.split(".")[0].replace(/\[\]$/, "")));
  const extra = isObject(value) ? Object.keys(value).filter((k) => !listed.has(k)) : [];
  const ok = fields.filter((f) => f.status === "ok").length;
  const mismatch = fields.filter((f) => f.status === "mismatch").length;
  const missing = fields.filter((f) => f.status === "missing").length;
  // An object that carries none of the table's fields (all optional) fits, but there's nothing to hold up to it.
  if (isObject(value) && !ok && !mismatch && !missing) {
    return { fields, extra, fits: null, summary: "None of this table's fields are in this example. They're all optional, so there's nothing to check here." };
  }
  const parts = [
    isObject(value) ? `${plural(ok, "field")} ${ok === 1 ? "matches" : "match"} the table` : `Expected an object, got ${typeWord(value)}`,
    ...(mismatch ? [`${plural(mismatch, "field")} of another type`] : []),
    ...(missing ? [`${plural(missing, "required field")} missing`] : []),
  ];
  return { fields, extra, fits: null, summary: `${parts.join(", ")}.` };
}
