import { jsonGet } from "@/lib/docs/client/pointer";

/**
 * A small JSON Schema checker for the structured-output demo: it tells the reader which fields of the model's reply
 * match the schema they sent. It covers the keywords structured output uses (type, properties, required,
 * additionalProperties, items, prefixItems, enum, const, anyOf, oneOf, allOf, local $ref, string, number and array
 * bounds, pattern) and skips the rest (format, if/then/else, dependencies), which only ever makes it lenient.
 */

export interface SchemaIssue {
  /** A JSON Pointer into the value, "" for the whole value. */
  path: string;
  message: string;
}

export interface FieldCheck {
  path: string;
  ok: boolean;
  /** What the schema asks for there: "string", "integer", "one of "CA", "NY"", "array of object". */
  expected: string;
  /** Why it failed, or "optional, left out". */
  note?: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: SchemaIssue[];
  /** One line per declared field, in schema order, for the pass and fail list. */
  fields: FieldCheck[];
}

type Json = Record<string, unknown>;

const MAX_DEPTH = 40;
const MAX_FIELDS = 200;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameJson(x, bb[i]));
  }
  const ka = Object.keys(a as Json);
  const kb = Object.keys(b as Json);
  return ka.length === kb.length && ka.every((k) => sameJson((a as Json)[k], (b as Json)[k]));
}

function esc(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function short(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

/** A short description of what a schema asks for. */
export function describeSchema(schema: unknown, root: unknown = schema, depth = 0): string {
  if (schema === true || schema === undefined) return "anything";
  if (schema === false) return "nothing";
  if (!isObj(schema) || depth > 5) return "anything";
  const s = resolve(schema, root);
  if (Array.isArray(s.enum)) return `one of ${s.enum.map(short).join(", ")}`;
  if ("const" in s) return `exactly ${short(s.const)}`;
  const branches = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null) as unknown[] | null;
  if (branches) return branches.map((b) => describeSchema(b, root, depth + 1)).join(" or ");
  const types = Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === "string" ? [s.type] : [];
  if (!types.length) return isObj(s.properties) ? "object" : s.items ? "array" : "anything";
  return types
    .map((t) => (t === "array" && s.items && !Array.isArray(s.items) ? `array of ${describeSchema(s.items, root, depth + 1)}` : t))
    .join(" or ");
}

/** Follows a local $ref ("#/$defs/Address", "#/definitions/x", "#"). Unknown or remote refs resolve to {}. */
function resolve(schema: Json, root: unknown, seen = 0): Json {
  const ref = schema.$ref;
  if (typeof ref !== "string" || seen > 20) return schema;
  if (!ref.startsWith("#")) return {};
  let target: unknown;
  try {
    target = jsonGet(root, decodeURIComponent(ref.slice(1)));
  } catch {
    target = undefined;
  }
  if (!isObj(target)) return {};
  // Keywords next to a $ref still apply (2019-09 and later), so merge them over the target.
  const { $ref: _ref, ...rest } = schema;
  void _ref;
  return resolve({ ...target, ...rest }, root, seen + 1);
}

class Checker {
  issues: SchemaIssue[] = [];
  fields: FieldCheck[] = [];

  constructor(private readonly root: unknown) {}

  private issue(path: string, message: string) {
    this.issues.push({ path, message });
  }

  private field(f: FieldCheck) {
    if (this.fields.length < MAX_FIELDS) this.fields.push(f);
  }

  /** True when `value` passes `schema`, recording what failed. */
  check(schema: unknown, value: unknown, path: string, depth: number): boolean {
    if (depth > MAX_DEPTH) return true;
    if (schema === true || schema === undefined || schema === null) return true;
    if (schema === false) {
      this.issue(path, "No value is allowed here.");
      return false;
    }
    if (!isObj(schema)) return true;
    const s = resolve(schema, this.root);
    const before = this.issues.length;

    if (Array.isArray(s.allOf)) for (const sub of s.allOf) this.check(sub, value, path, depth + 1);
    if (Array.isArray(s.anyOf)) this.branches(s.anyOf, value, path, depth, "any");
    if (Array.isArray(s.oneOf)) this.branches(s.oneOf, value, path, depth, "one");

    if (Array.isArray(s.enum) && !s.enum.some((e) => sameJson(e, value))) {
      this.issue(path, `${short(value)} isn't one of ${s.enum.map(short).join(", ")}.`);
    }
    if ("const" in s && !sameJson(s.const, value)) this.issue(path, `Expected exactly ${short(s.const)}, got ${short(value)}.`);

    const types = Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === "string" ? [s.type] : null;
    const actual = typeOf(value);
    if (types && !types.some((t) => t === actual || (t === "number" && actual === "integer"))) {
      this.issue(path, `Expected ${types.join(" or ")}, got ${actual === "integer" ? "number" : actual}.`);
      return false;
    }

    if (typeof value === "string") this.string(s, value, path);
    else if (typeof value === "number") this.number(s, value, path);
    else if (Array.isArray(value)) this.array(s, value, path, depth);
    else if (isObj(value)) this.object(s, value, path, depth);

    return this.issues.length === before;
  }

  private branches(list: unknown[], value: unknown, path: string, depth: number, mode: "any" | "one") {
    const passing = list.filter((b) => {
      const trial = new Checker(this.root);
      return trial.check(b, value, path, depth + 1);
    });
    if (mode === "any" && passing.length === 0) this.issue(path, "Doesn't match any of the allowed shapes.");
    else if (mode === "one" && passing.length !== 1) {
      this.issue(path, passing.length ? "Matches more than one of the allowed shapes." : "Doesn't match any of the allowed shapes.");
    }
    // Record the field checks of the branch that matched, so nested fields still get a pass or fail line.
    if (passing.length) {
      const trial = new Checker(this.root);
      trial.check(passing[0], value, path, depth + 1);
      for (const f of trial.fields) this.field(f);
    }
  }

  private string(s: Json, value: string, path: string) {
    const length = [...value].length;
    if (typeof s.minLength === "number" && length < s.minLength) this.issue(path, `Shorter than ${s.minLength} characters.`);
    if (typeof s.maxLength === "number" && length > s.maxLength) this.issue(path, `Longer than ${s.maxLength} characters.`);
    if (typeof s.pattern === "string") {
      let re: RegExp | null = null;
      try {
        re = new RegExp(s.pattern, "u");
      } catch {
        re = null;
      }
      if (re && !re.test(value)) this.issue(path, `Doesn't match the pattern ${s.pattern}.`);
    }
  }

  private number(s: Json, value: number, path: string) {
    if (typeof s.minimum === "number" && value < s.minimum) this.issue(path, `Less than the minimum, ${s.minimum}.`);
    if (typeof s.maximum === "number" && value > s.maximum) this.issue(path, `More than the maximum, ${s.maximum}.`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) this.issue(path, `Must be more than ${s.exclusiveMinimum}.`);
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) this.issue(path, `Must be less than ${s.exclusiveMaximum}.`);
    if (typeof s.multipleOf === "number" && s.multipleOf > 0) {
      const q = value / s.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9) this.issue(path, `Not a multiple of ${s.multipleOf}.`);
    }
  }

  private array(s: Json, value: unknown[], path: string, depth: number) {
    if (typeof s.minItems === "number" && value.length < s.minItems) this.issue(path, `Fewer than ${s.minItems} items.`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) this.issue(path, `More than ${s.maxItems} items.`);
    if (s.uniqueItems === true && value.some((x, i) => value.findIndex((y) => sameJson(x, y)) !== i)) this.issue(path, "Items repeat.");
    const prefix = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : [];
    const rest = Array.isArray(s.items) ? s.additionalItems : s.items;
    value.forEach((item, i) => {
      const sub = i < prefix.length ? prefix[i] : rest;
      if (sub !== undefined) this.check(sub, item, `${path}/${i}`, depth + 1);
    });
  }

  private object(s: Json, value: Json, path: string, depth: number) {
    const props = isObj(s.properties) ? s.properties : {};
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    for (const [key, sub] of Object.entries(props)) {
      const at = `${path}/${esc(key)}`;
      const expected = describeSchema(sub, this.root);
      if (!(key in value)) {
        if (required.has(key)) {
          this.issue(at, "Required, but missing.");
          this.field({ path: at, ok: false, expected, note: "missing" });
        } else {
          this.field({ path: at, ok: true, expected, note: "optional, left out" });
        }
        continue;
      }
      const before = this.issues.length;
      const index = this.fields.length;
      this.check(sub, value[key], at, depth + 1);
      const own = this.issues.slice(before).find((x) => x.path === at);
      // The field's own line goes before its nested fields' lines.
      const line: FieldCheck = { path: at, ok: this.issues.length === before, expected, ...(own ? { note: own.message } : {}) };
      if (this.fields.length < MAX_FIELDS) this.fields.splice(index, 0, line);
    }
    for (const key of required) {
      if (!(key in props) && !(key in value)) this.issue(`${path}/${esc(key)}`, "Required, but missing.");
    }
    const extra = Object.keys(value).filter((k) => !(k in props));
    if (s.additionalProperties === false) {
      for (const key of extra) {
        const at = `${path}/${esc(key)}`;
        this.issue(at, "Not in the schema, which allows no other fields.");
        this.field({ path: at, ok: false, expected: "nothing (no other fields)", note: "not in the schema" });
      }
    } else if (isObj(s.additionalProperties)) {
      for (const key of extra) this.check(s.additionalProperties, value[key], `${path}/${esc(key)}`, depth + 1);
    }
    const count = Object.keys(value).length;
    if (typeof s.minProperties === "number" && count < s.minProperties) this.issue(path, `Fewer than ${s.minProperties} fields.`);
    if (typeof s.maxProperties === "number" && count > s.maxProperties) this.issue(path, `More than ${s.maxProperties} fields.`);
  }
}

/** Checks `value` against `schema`. */
export function validateJson(schema: unknown, value: unknown): ValidationReport {
  const checker = new Checker(schema);
  checker.check(schema, value, "", 0);
  return { valid: checker.issues.length === 0, issues: checker.issues, fields: checker.fields };
}

/**
 * What a schema breaks of Meta's strict subset (structured-output, "Enforce strict mode"), which `strict: true`
 * enforces with HTTP 400: a plain object root, no allOf or oneOf, additionalProperties: false on every object, and
 * every property listed in required.
 */
export function strictSubsetProblems(schema: unknown): string[] {
  const problems: string[] = [];
  if (!isObj(schema)) return ["The schema must be a JSON object."];
  for (const k of ["anyOf", "oneOf", "allOf", "enum", "not"]) {
    if (k in schema) problems.push(`The root can't use ${k}; make it a plain object.`);
  }
  if (schema.type !== "object") problems.push('The root must be "type": "object".');
  const walk = (s: unknown, at: string, depth: number) => {
    if (!isObj(s) || depth > MAX_DEPTH) return;
    for (const k of ["allOf", "oneOf"]) if (k in s) problems.push(`${at || "/"} uses ${k}, which strict mode doesn't support.`);
    const isObject = s.type === "object" || (Array.isArray(s.type) && s.type.includes("object")) || isObj(s.properties);
    if (isObject && !s.$ref) {
      if (s.additionalProperties !== false) problems.push(`${at || "/"} needs "additionalProperties": false.`);
      const keys = Object.keys(isObj(s.properties) ? s.properties : {});
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
      const missing = keys.filter((k) => !required.has(k));
      if (missing.length) problems.push(`${at || "/"} must list every property in required (missing: ${missing.join(", ")}).`);
    }
    if (isObj(s.properties)) for (const [k, sub] of Object.entries(s.properties)) walk(sub, `${at}/properties/${esc(k)}`, depth + 1);
    if (s.items) walk(s.items, `${at}/items`, depth + 1);
    if (Array.isArray(s.anyOf)) s.anyOf.forEach((b, i) => walk(b, `${at}/anyOf/${i}`, depth + 1));
    for (const defs of ["$defs", "definitions"]) {
      const d = s[defs];
      if (isObj(d)) for (const [k, sub] of Object.entries(d)) walk(sub, `${at}/${defs}/${esc(k)}`, depth + 1);
    }
  };
  walk(schema, "", 0);
  return problems;
}
