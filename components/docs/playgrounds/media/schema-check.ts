import { findSchema, typeLabel, type FieldType, type SchemaDoc, type SchemaField } from "@/components/docs/playgrounds/media/schema-tables";

/**
 * Checks a JSON value against a schema from an API reference "Schemas" page (schema-tables.ts), the way the schema
 * explorer and the Files console use it: a request body before it's sent (missing required fields, wrong types,
 * values out of range, fields the schema doesn't have, and the rules the pages state in prose, below) and a real reply
 * after it comes back (does it carry what the page documents). It follows the images endpoints' rules from
 * image-generation, "Errors": in a JSON body an unknown top-level field or an unknown member of an array item
 * (images[i].detail) is refused with 400, while unknown keys inside other nested objects are ignored. A multipart body
 * (a schema with a file field) isn't refused for a field Meta doesn't read, except the ones a rule names. Pure, so
 * it's tested on saved replies.
 */

export type CheckMode = "request" | "reply";
export type Severity = "ok" | "error" | "warning" | "info";

export interface CheckRow {
  /** Where in the value: "n", "tool_enablement.enable_shell", "data[0].b64_json". */
  path: string;
  severity: Severity;
  message: string;
  /** The schema field the row is about (none for a field the schema doesn't have). */
  field?: SchemaField;
  /** The value found there, for display. */
  value?: unknown;
}

export interface CheckReport {
  /** True when nothing is an error. */
  ok: boolean;
  errors: number;
  warnings: number;
  rows: CheckRow[];
  /** For a one-of schema, the option the value matched best. */
  matched?: string;
}

type Json = Record<string, unknown>;
type Where = "top" | "item" | "nested";

const MAX_DEPTH = 6;
/** Array items checked in full; later items only report problems, so a list of 20 files stays readable. */
const FULL_ITEMS = 3;
const MAX_ITEMS = 50;

function isObject(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ---- What the pages document beyond their tables ------------------------------------------------------------------

/** Marks the field at `path` as refused, with the reason. */
type Flag = (path: string, message: string) => void;

interface BodyRules {
  /** Fields refused whatever the table says, with the reason: a multipart edit's mask, input_fidelity and partial_images. */
  refused?: Readonly<Record<string, string>>;
  /** Fields the table marks optional that a request still needs, so every example carries them. */
  example?: readonly string[];
  /** Checks on the whole body that a table can't express. */
  check?(body: Json, flag: Flag): void;
}

const MUSE_IMAGE = "muse-image-1.0";
const MAX_EDIT_IMAGES = 10;

/**
 * Null when Meta takes the size: "auto", or "WxH" (either case of x) with both sides above 0 and at most 16:1 apart.
 * Each case was confirmed through the docs proxy: "banana" and "0x100" are 400s, "1024X1024" and "auto" run.
 */
export function sizeProblem(size: string): string | null {
  if (size === "auto") return null;
  const m = /^(\d+)[xX](\d+)$/.exec(size);
  const w = m ? Number(m[1]) : 0;
  const h = m ? Number(m[2]) : 0;
  if (!w || !h) return `Not width x height: Meta answers 400 "Invalid size format, expected 'WxH'" (param: size).`;
  const ratio = Math.max(w, h) / Math.min(w, h);
  return ratio > 16 ? `An aspect ratio of ${Math.round(ratio * 10) / 10}:1, beyond 16:1: refused with 400 (param: size).` : null;
}

/** The checks every images request shares (image-generation, "Errors"). */
function imageRequest(body: Json, flag: Flag) {
  if (typeof body.model === "string" && !body.model.trim()) flag("model", "Empty: refused with 400 (param: model).");
  if (typeof body.prompt === "string" && !body.prompt.trim()) {
    flag("prompt", 'Empty: Meta answers 400 "prompt must not be empty" (param: prompt) before anything runs.');
  }
  if (body.moderation !== undefined) {
    if (body.model === MUSE_IMAGE || body.model === undefined) {
      flag("moderation", "Not enabled on muse-image-1.0, so any value is a 400 (code: unsupported_parameter). Leaving it out is always valid.");
    } else if (body.moderation !== "auto" && body.moderation !== "low") {
      flag("moderation", "Takes auto or low on a model that has it; anything else is a 400.");
    }
  }
  if (typeof body.size === "string") {
    const problem = sizeProblem(body.size);
    if (problem) flag("size", problem);
  }
}

/** output_format, where the table has it. "JPEG" and "jpg" run too (checked live); "gif" is a 400. */
function outputFormat(body: Json, flag: Flag) {
  if (typeof body.output_format === "string" && !/^(png|jpe?g|webp)$/i.test(body.output_format)) {
    flag("output_format", "Takes png, jpeg (or jpg) or webp; any other value is refused with 400.");
  }
}

/** The JSON edit's images: 1 to 10 items (the table says only the 1), each exactly one of image_url or file_id. */
function editImages(body: Json, flag: Flag) {
  const images = body.images;
  if (!Array.isArray(images)) return;
  if (images.length > MAX_EDIT_IMAGES) {
    flag("images", `${images.length} items: an edit takes 1 to 10, so Meta answers 400 "images must contain at most 10 items".`);
  }
  images.slice(0, MAX_ITEMS).forEach((item, i) => {
    if (!isObject(item)) return;
    const set = ["image_url", "file_id"].filter((k) => item[k] !== undefined && item[k] !== null);
    if (set.length !== 1) {
      flag(`images[${i}]`, `Has ${set.length ? "both image_url and file_id" : "neither image_url nor file_id"}: each item takes exactly one, or Meta answers 400.`);
    }
  });
}

/** The multipart edit's file parts: image (repeated) or image[0], image[1], ... numbered from 0, never both. */
function multipartImages(body: Json, flag: Flag) {
  const numbered = Object.keys(body).filter((k) => /^image\[\d+\]$/.test(k));
  if (body.image !== undefined && numbered.length) {
    flag("image", "image and image[N] are two spellings of one field and can't be mixed (400). Use image, or image[0], image[1], ... throughout.");
  } else if (body.image === undefined && !numbered.length) {
    flag("image", 'No image part: Meta answers 400 "at least one image is required" (param: image).');
  }
  const indexes = numbered.map((k) => Number(k.slice(6, -1))).sort((a, b) => a - b);
  const gap = indexes.findIndex((v, i) => v !== i);
  if (gap >= 0) flag(`image[${indexes[gap]}]`, `Out of order: image parts are numbered from 0 with no gaps, so Meta expects image[${gap}] here (400).`);
  if (numbered.length > MAX_EDIT_IMAGES) flag("image", `${numbered.length} image parts: an edit takes 1 to 10 (400).`);
}

const MULTIPART_EDIT_REFUSED = (field: string) => `A multipart edit refuses it: Meta answers 400 "${field} is not a supported image edit field" (unsupported_parameter).`;

/**
 * The rules by schema name, from image-generation ("Errors") and api-reference/images/schemas, each one confirmed
 * against the live API through the docs proxy. Schemas without an entry get the table checks only.
 */
const RULES: Readonly<Record<string, BodyRules>> = {
  CreateImageRequest: {
    check(body, flag) {
      imageRequest(body, flag);
      outputFormat(body, flag);
    },
  },
  EditImageBodyJsonParam: {
    check(body, flag) {
      imageRequest(body, flag);
      outputFormat(body, flag);
      editImages(body, flag);
    },
  },
  CreateImageEditRequest: {
    // The table lists partial_images ("Accepted but ignored"), but the multipart edit answers 400 for it.
    refused: { mask: MULTIPART_EDIT_REFUSED("mask"), input_fidelity: MULTIPART_EDIT_REFUSED("input_fidelity"), partial_images: MULTIPART_EDIT_REFUSED("partial_images") },
    example: ["image"],
    check(body, flag) {
      imageRequest(body, flag);
      multipartImages(body, flag);
    },
  },
};

/** A schema whose request carries a file part travels as multipart/form-data. */
function isMultipart(schema: SchemaDoc): boolean {
  return schema.fields.some((f) => !f.name.includes(".") && f.type.kind === "binary");
}

/** The value at a rule's path: a field ("size"), a multipart name ("image[1]") or an array item ("images[0]"). */
function valueAt(body: Json, path: string): unknown {
  if (path in body) return body[path];
  const m = /^(\w+)\[(\d+)\]$/.exec(path);
  const list = m ? body[m[1]] : undefined;
  return m && Array.isArray(list) ? list[Number(m[2])] : undefined;
}

function join(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "number") return Number.isInteger(v) ? "an integer" : "a number";
  return typeof v === "object" ? "an object" : `a ${typeof v}`;
}

/** Whether a value has the type's outer shape (objects and arrays without their contents). */
export function shapeMatches(type: FieldType, v: unknown): boolean {
  switch (type.kind) {
    case "string":
    case "binary":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "object":
    case "ref":
      return isObject(v);
    case "enum":
      return typeof v === "string" && type.values.includes(v);
    case "array":
      return Array.isArray(v);
    case "union":
      return type.options.some((o) => shapeMatches(o, v));
  }
}

function expected(type: FieldType): string {
  switch (type.kind) {
    case "enum":
      return `one of ${type.values.map((x) => `"${x}"`).join(", ")}`;
    case "ref":
      return `an object (${type.name})`;
    case "array":
      return "an array";
    case "union":
      return type.options.map(expected).join(" or ");
    case "binary":
      return "a file";
    case "integer":
      return "an integer";
    case "object":
      return "an object";
    default:
      return `a ${type.kind}`;
  }
}

class Checker {
  rows: CheckRow[] = [];

  constructor(
    private readonly schemas: readonly SchemaDoc[],
    private readonly mode: CheckMode,
  ) {}

  push(row: CheckRow, quiet: boolean) {
    if (quiet && row.severity === "ok") return;
    this.rows.push(row);
  }

  /** One object against one schema; a one-of schema takes the option with the fewest errors. */
  object(schema: SchemaDoc, value: unknown, prefix: string, depth: number, where: Where, quiet: boolean): string | undefined {
    if (schema.oneOf?.length) {
      let best: { rows: CheckRow[]; errors: number; name: string } | null = null;
      for (const option of schema.oneOf) {
        const target = findSchema(this.schemas, option.id);
        if (!target) continue;
        const sub = new Checker(this.schemas, this.mode);
        sub.object(target, value, prefix, depth + 1, where, quiet);
        const errors = sub.rows.filter((r) => r.severity === "error").length;
        if (!best || errors < best.errors) best = { rows: sub.rows, errors, name: target.name };
      }
      if (best) {
        this.rows.push(...best.rows);
        return best.name;
      }
      return undefined;
    }
    if (!isObject(value)) {
      this.push({ path: prefix || "(body)", severity: "error", message: `Expected an object (${schema.name}), got ${describe(value)}.`, value }, false);
      return undefined;
    }
    const top = schema.fields.filter((f) => !f.name.includes("."));
    const known = new Set(top.map((f) => f.name));
    // The page's own rules apply to the body itself; nested objects get the table checks.
    const refused = where === "top" && this.mode === "request" ? (RULES[schema.name]?.refused ?? {}) : {};
    const multipart = where === "top" && this.mode === "request" && isMultipart(schema);
    for (const f of top) {
      const path = join(prefix, f.name);
      if (!(f.name in value) || value[f.name] === undefined) {
        if (f.required) {
          this.push(
            {
              path,
              field: f,
              severity: this.mode === "request" ? "error" : "warning",
              message: this.mode === "request" ? "Required, and missing." : "Required by the schema, but not in this reply.",
            },
            false,
          );
        }
        continue;
      }
      if (refused[f.name]) {
        this.push({ path, field: f, severity: "error", message: refused[f.name], value: value[f.name] }, false);
        continue;
      }
      this.value(f.type, value[f.name], path, f, depth, quiet);
      if (f.type.kind === "object" && isObject(value[f.name])) this.children(schema, f, value[f.name] as Json, path, quiet);
    }
    for (const key of Object.keys(value)) {
      if (known.has(key)) continue;
      const path = join(prefix, key);
      // A numbered file part (image[0], image[1]) is the file field it numbers.
      const filePart = multipart ? top.find((f) => f.type.kind === "binary" && key.startsWith(f.name) && /^\[\d+\]$/.test(key.slice(f.name.length))) : undefined;
      if (refused[key]) {
        this.push({ path, severity: "error", message: refused[key], value: value[key] }, false);
      } else if (filePart) {
        this.value(filePart.type, value[key], path, filePart, depth, quiet);
      } else if (this.mode === "reply") {
        this.push({ path, severity: "info", message: "Not in the schema.", value: value[key] }, false);
      } else if (multipart) {
        this.push({ path, severity: "info", message: "Not in the schema. A multipart body isn't refused for a field Meta doesn't read.", value: value[key] }, false);
      } else if (where === "nested") {
        this.push({ path, severity: "info", message: "Not in the schema. Unknown keys inside nested objects are ignored.", value: value[key] }, false);
      } else {
        this.push(
          {
            path,
            severity: "error",
            message:
              where === "top"
                ? "Not in the schema. An unknown top-level field is refused with HTTP 400."
                : "Not in the schema. An unknown member of an array item is refused with HTTP 400.",
            value: value[key],
          },
          false,
        );
      }
    }
    return undefined;
  }

  /** The dotted fields under an object field, such as input_tokens_details.image_tokens. */
  children(schema: SchemaDoc, parent: SchemaField, value: Json, path: string, quiet: boolean) {
    const kids = schema.fields.filter((f) => f.name.startsWith(`${parent.name}.`) && !f.name.slice(parent.name.length + 1).includes("."));
    if (!kids.length) return;
    const names = new Set(kids.map((k) => k.name.slice(parent.name.length + 1)));
    for (const k of kids) {
      const key = k.name.slice(parent.name.length + 1);
      if (!(key in value) || value[key] === undefined) {
        if (k.required) this.push({ path: join(path, key), field: k, severity: this.mode === "request" ? "error" : "warning", message: "Required, and missing." }, false);
        continue;
      }
      this.value(k.type, value[key], join(path, key), k, 0, quiet);
    }
    for (const key of Object.keys(value)) {
      if (!names.has(key)) this.push({ path: join(path, key), severity: "info", message: "Not in the schema.", value: value[key] }, false);
    }
  }

  value(type: FieldType, v: unknown, path: string, field: SchemaField | undefined, depth: number, quiet: boolean) {
    if (type.kind === "union") {
      const option = type.options.find((o) => shapeMatches(o, v));
      if (!option) {
        this.push({ path, field, severity: "error", message: `Expected ${expected(type)}, got ${describe(v)}.`, value: v }, false);
        return;
      }
      this.value(option, v, path, field, depth, quiet);
      return;
    }
    if (type.kind === "binary") {
      // A file travels as a multipart part, never as JSON; a placeholder string stands for it in a JSON view.
      if (typeof v === "string") this.push({ path, field, severity: "ok", message: "A file, sent as a multipart part.", value: v }, quiet);
      else this.push({ path, field, severity: "error", message: "Expected a file (a multipart part).", value: v }, false);
      return;
    }
    if (v === null && !shapeMatches(type, null) && this.mode === "reply") {
      // A reply can carry null where the table documents a value (an empty list's first_id): worth a note, not a fail.
      this.push({ path, field, severity: "warning", message: `null, where the schema documents ${expected(type)}.`, value: v }, false);
      return;
    }
    if (!shapeMatches(type, v)) {
      this.push({ path, field, severity: "error", message: `Expected ${expected(type)}, got ${typeof v === "string" ? `"${v}"` : describe(v)}.`, value: v }, false);
      return;
    }
    const c = field?.constraints ?? {};
    if (typeof v === "number") {
      if (c.minimum !== undefined && v < c.minimum) {
        this.push({ path, field, severity: "error", message: `Must be at least ${c.minimum}.`, value: v }, false);
        return;
      }
      if (c.maximum !== undefined && v > c.maximum) {
        this.push({ path, field, severity: "error", message: `Must be at most ${c.maximum}.`, value: v }, false);
        return;
      }
    }
    if (type.kind === "ref") {
      const target = findSchema(this.schemas, type.ref);
      if (!target || depth >= MAX_DEPTH) {
        this.push({ path, field, severity: "ok", message: `An object (${type.name}).`, value: v }, quiet);
        return;
      }
      this.push({ path, field, severity: "ok", message: `An object (${type.name}).` }, quiet);
      this.object(target, v, path, depth + 1, "nested", quiet);
      return;
    }
    if (type.kind === "array") {
      const list = v as unknown[];
      if (c.minItems !== undefined && list.length < c.minItems) {
        this.push({ path, field, severity: "error", message: `Needs at least ${c.minItems} item${c.minItems === 1 ? "" : "s"}.`, value: v }, false);
        return;
      }
      if (c.maxItems !== undefined && list.length > c.maxItems) {
        this.push({ path, field, severity: "error", message: `Takes at most ${c.maxItems} items.`, value: v }, false);
        return;
      }
      this.push({ path, field, severity: "ok", message: `An array of ${list.length} item${list.length === 1 ? "" : "s"}.` }, quiet);
      list.slice(0, MAX_ITEMS).forEach((item, i) => {
        const itemPath = `${path}[${i}]`;
        const itemQuiet = quiet || i >= FULL_ITEMS;
        if (type.items.kind === "ref") {
          const target = findSchema(this.schemas, type.items.ref);
          if (target && depth < MAX_DEPTH) {
            if (!isObject(item)) this.push({ path: itemPath, severity: "error", message: `Expected an object (${type.items.name}), got ${describe(item)}.`, value: item }, false);
            else this.object(target, item, itemPath, depth + 1, "item", itemQuiet);
            return;
          }
        }
        this.value(type.items, item, itemPath, undefined, depth + 1, itemQuiet);
      });
      return;
    }
    this.push({ path, field, severity: "ok", message: okMessage(type), value: v }, quiet);
  }
}

function okMessage(type: FieldType): string {
  switch (type.kind) {
    case "enum":
      return "One of the allowed values.";
    case "object":
      return "An object.";
    default:
      return `${type.kind === "integer" ? "An" : "A"} ${type.kind}${"format" in type && type.format ? ` (${type.format})` : ""}.`;
  }
}

/** The field a rule's path is about: a top-level field, a numbered file part's field, or an array's item type. */
function fieldAt(schema: SchemaDoc, path: string): SchemaField | undefined {
  const exact = schema.fields.find((f) => f.name === path);
  if (exact) return exact;
  const m = /^(\w+)\[\d+\]$/.exec(path);
  const base = m ? schema.fields.find((f) => f.name === m[1]) : undefined;
  if (!base) return undefined;
  if (base.type.kind !== "array") return base;
  return { name: path, type: base.type.items, typeLabel: typeLabel(base.type.items), required: false, description: "", constraints: {} };
}

/** Checks `value` against the schema with this anchor or name. */
export function checkAgainst(schemas: readonly SchemaDoc[], idOrName: string, value: unknown, mode: CheckMode): CheckReport {
  const schema = findSchema(schemas, idOrName);
  const checker = new Checker(schemas, mode);
  let matched: string | undefined;
  if (!schema) checker.rows.push({ path: "(body)", severity: "warning", message: `No schema named ${idOrName} on this page.` });
  else matched = checker.object(schema, value, "", 0, "top", false);
  const rules = schema && !schema.oneOf?.length ? RULES[schema.name] : undefined;
  if (schema && rules?.check && mode === "request" && isObject(value)) {
    // A rule's problem replaces the row that passed the table check, and never doubles one already flagged.
    rules.check(value, (path, message) => {
      if (checker.rows.some((r) => r.path === path && r.severity === "error")) return;
      checker.rows = checker.rows.filter((r) => !(r.path === path && r.severity === "ok"));
      checker.rows.push({ path, severity: "error", message, field: fieldAt(schema, path), value: valueAt(value, path) });
    });
  }
  const errors = checker.rows.filter((r) => r.severity === "error").length;
  const warnings = checker.rows.filter((r) => r.severity === "warning").length;
  return { ok: errors === 0, errors, warnings, rows: checker.rows, ...(matched ? { matched } : {}) };
}

export interface ExampleOptions {
  /** Include optional fields too, not just the required ones. */
  optional?: boolean;
  /**
   * Values by field name ("prompt") or by "<schema id>.<field>" ("create-image-request.prompt"). Null leaves the
   * field out of the example, for a field that would fail here (moderation on Muse Image).
   */
  hints?: Readonly<Record<string, unknown>>;
}

function hintFor(hints: ExampleOptions["hints"], schemaId: string, field: string): { found: boolean; value?: unknown } {
  if (!hints) return { found: false };
  for (const key of [`${schemaId}.${field}`, field]) if (key in hints) return { found: true, value: hints[key] };
  return { found: false };
}

/** A value of a type, for an example: the default, the minimum, the first enum value, a nested example. */
function sample(schemas: readonly SchemaDoc[], schema: SchemaDoc, field: SchemaField | null, type: FieldType, opts: ExampleOptions, depth: number): unknown {
  const c = field?.constraints ?? {};
  if (c.default !== undefined && shapeMatches(type, c.default)) return c.default;
  switch (type.kind) {
    case "string":
      return "string";
    case "binary":
      return "<file>";
    case "integer":
      return c.minimum ?? 1;
    case "number":
      return c.minimum ?? 0;
    case "boolean":
      return false;
    case "null":
      return null;
    case "enum":
      return type.values[0] ?? "";
    case "object": {
      if (!field) return {};
      const kids = schema.fields.filter((f) => f.name.startsWith(`${field.name}.`) && !f.name.slice(field.name.length + 1).includes("."));
      const out: Json = {};
      for (const k of kids) {
        if (!k.required && !opts.optional) continue;
        const key = k.name.slice(field.name.length + 1);
        const hint = hintFor(opts.hints, schema.id, key);
        if (hint.found && hint.value === null) continue;
        out[key] = hint.found ? hint.value : sample(schemas, schema, k, k.type, opts, depth + 1);
      }
      return out;
    }
    case "ref": {
      const target = findSchema(schemas, type.ref);
      return target && depth < MAX_DEPTH ? exampleFor(schemas, target.id, opts, depth + 1) : {};
    }
    case "array":
      return [sample(schemas, schema, null, type.items, opts, depth + 1)];
    case "union": {
      const option = type.options.find((o) => o.kind !== "null") ?? type.options[0];
      return option ? sample(schemas, schema, field, option, opts, depth) : null;
    }
  }
}

/**
 * An example object for a schema: its required fields (and the optional ones when asked), filled from hints. It
 * leaves out what the page's rules refuse and keeps what they need, so an example passes its own check.
 */
export function exampleFor(schemas: readonly SchemaDoc[], idOrName: string, opts: ExampleOptions = {}, depth = 0): Json {
  const schema = findSchema(schemas, idOrName);
  if (!schema) return {};
  if (schema.oneOf?.length) return exampleFor(schemas, schema.oneOf[schema.oneOf.length - 1].id, opts, depth + 1);
  const rules = depth === 0 ? RULES[schema.name] : undefined;
  const out: Json = {};
  for (const f of schema.fields) {
    if (f.name.includes(".")) continue;
    if (rules?.refused?.[f.name]) continue;
    if (!f.required && !opts.optional && !rules?.example?.includes(f.name)) continue;
    const hint = hintFor(opts.hints, schema.id, f.name);
    if (hint.found && hint.value === null) continue;
    out[f.name] = hint.found ? hint.value : sample(schemas, schema, f, f.type, opts, depth);
  }
  return out;
}

/**
 * A multipart body from a JSON object, the way Meta reads bracketed names: nested objects become
 * expires_after[anchor] and expires_after[seconds], files stay files, everything else is a string. Order is kept,
 * with file parts last (file-handling, "Upload and reference a file": purpose and expires_after first, the file last).
 */
export function formFieldsFrom(body: Json, files: Readonly<Record<string, Blob & { name?: string }>>): Array<[string, string | Blob]> {
  const scalars: Array<[string, string | Blob]> = [];
  const parts: Array<[string, string | Blob]> = [];
  const add = (name: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (isObject(value)) {
      for (const [k, v] of Object.entries(value)) add(`${name}[${k}]`, v);
      return;
    }
    scalars.push([name, typeof value === "string" ? value : JSON.stringify(value)]);
  };
  for (const [name, value] of Object.entries(body)) {
    const file = files[name];
    if (file) parts.push([name, file]);
    else add(name, value);
  }
  return [...scalars, ...parts];
}

/** The rows to show first: problems, then the fields that passed. */
export function sortRows(rows: readonly CheckRow[]): CheckRow[] {
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2, ok: 3 };
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank[a.r.severity] - rank[b.r.severity] || a.i - b.i)
    .map((x) => x.r);
}
