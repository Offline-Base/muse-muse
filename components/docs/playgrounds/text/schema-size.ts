/**
 * How a JSON Schema measures against the limits Model API checks before decoding starts (structured-output, "Stay
 * within schema constraints"): nesting depth, total properties, total string length, enum values, large string
 * enums and the size once $refs are inlined, plus recursion, which is rejected outright. Pure and local: nothing is
 * sent. The same limits apply to function tools' `parameters`.
 *
 * Depth counts object and array levels on the deepest path, the way the API counted them when we checked: ten nested
 * levels pass and eleven return "exceeds the maximum nesting depth of 10 levels", with arrays counting like objects.
 * A leaf (a string, a number) adds no level, and anyOf, oneOf and allOf branches sit at their parent's level.
 */

type Json = Record<string, unknown>;

export const SCHEMA_LIMITS = {
  depth: 10,
  properties: 5000,
  stringLength: 120_000,
  enumValues: 1000,
  bigEnumValues: 250,
  bigEnumChars: 15_000,
  expandedNodes: 200_000,
} as const;

export interface SchemaStats {
  depth: number;
  properties: number;
  /** Property names, definition names, enum values and const values, combined. */
  stringLength: number;
  enumValues: number;
  /** The string enum with the most values, and its combined length. */
  largestEnum: { values: number; chars: number; path: string } | null;
  /** Schema nodes once every $ref is inlined, or null when the schema is recursive. */
  expandedNodes: number | null;
  recursive: boolean;
  /** Where the recursion is, as the chain of $refs. */
  cycle: string[] | null;
}

export interface LimitCheck {
  id: keyof typeof SCHEMA_LIMITS | "recursive";
  label: string;
  value: number;
  limit: number;
  /** null when the check can't be measured (depth and inlined size of a recursive schema). */
  ok: boolean | null;
  note?: string;
}

function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const CHILD_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const CHILD_ONE = ["items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems"] as const;

function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let at: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(at)) at = at[Number(key)];
    else if (isObj(at)) at = at[key];
    else return undefined;
  }
  return at;
}

/** Whether a schema node is a container level (an object or an array). */
function isLevel(s: Json): boolean {
  const t = s.type;
  const types = Array.isArray(t) ? t : [t];
  return types.includes("object") || types.includes("array") || isObj(s.properties) || s.items !== undefined || Array.isArray(s.prefixItems);
}

/** The $ref chain that loops back on itself, if any, following local refs from the root. */
function findCycle(root: Json): string[] | null {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const walk = (node: unknown, stack: string[]): string[] | null => {
    if (Array.isArray(node)) {
      for (const n of node) {
        const hit = walk(n, stack);
        if (hit) return hit;
      }
      return null;
    }
    if (!isObj(node)) return null;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#")) {
      const ref = node.$ref;
      if (visiting.has(ref)) return [...stack, ref];
      if (!done.has(ref)) {
        visiting.add(ref);
        const hit = walk(resolvePointer(root, ref), [...stack, ref]);
        visiting.delete(ref);
        if (hit) return hit;
        done.add(ref);
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "$defs" || k === "definitions") continue; // reached through the refs that use them
      if (v && typeof v === "object") {
        const hit = walk(v, stack);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(root, []);
}

/** Measures a schema. Safe on recursive schemas: refs are followed only when the schema has no cycle. */
export function schemaStats(schema: unknown): SchemaStats {
  const root = isObj(schema) ? schema : {};
  const cycle = findCycle(root);
  const recursive = cycle !== null;
  let properties = 0;
  let stringLength = 0;
  let enumValues = 0;
  let largestEnum: SchemaStats["largestEnum"] = null;

  // Counts that don't need refs inlined: every property, name and enum written in the schema once.
  const count = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((n, i) => count(n, `${path}/${i}`));
    if (!isObj(node)) return;
    if (isObj(node.properties)) {
      const keys = Object.keys(node.properties);
      properties += keys.length;
      stringLength += keys.reduce((n, k) => n + k.length, 0);
    }
    for (const defs of ["$defs", "definitions"]) {
      if (isObj(node[defs])) stringLength += Object.keys(node[defs] as Json).reduce((n, k) => n + k.length, 0);
    }
    if (Array.isArray(node.enum)) {
      enumValues += node.enum.length;
      const strings = node.enum.filter((v): v is string => typeof v === "string");
      const chars = strings.reduce((n, v) => n + v.length, 0);
      stringLength += chars;
      if (strings.length && (!largestEnum || strings.length > largestEnum.values)) largestEnum = { values: strings.length, chars, path: path || "/" };
    }
    if (typeof node.const === "string") stringLength += node.const.length;
    for (const [k, v] of Object.entries(node)) if (v && typeof v === "object" && k !== "enum" && k !== "const") count(v, `${path}/${k}`);
  };
  count(root, "");

  // Depth and expanded size follow refs, which only terminates without a cycle.
  let expanded = 0;
  const MAX_NODES = SCHEMA_LIMITS.expandedNodes + 1;
  const depthOf = (node: unknown, seen: number): number => {
    if (!isObj(node) || expanded > MAX_NODES || seen > 64) return 0;
    expanded++;
    let target: Json = node;
    if (!recursive && typeof node.$ref === "string") {
      const r = resolvePointer(root, node.$ref);
      if (isObj(r)) target = { ...r, ...Object.fromEntries(Object.entries(node).filter(([k]) => k !== "$ref")) };
    }
    // Children sit one level down: property schemas, items, additionalProperties and the like.
    let child = 0;
    for (const key of CHILD_MAPS) {
      if (key === "$defs" || key === "definitions") continue;
      const m = target[key];
      if (isObj(m)) for (const v of Object.values(m)) child = Math.max(child, depthOf(v, seen + 1));
    }
    for (const key of CHILD_ONE) {
      if (key === "not" || key === "if" || key === "then" || key === "else") continue;
      if (isObj(target[key])) child = Math.max(child, depthOf(target[key], seen + 1));
    }
    if (Array.isArray(target.prefixItems)) for (const v of target.prefixItems) child = Math.max(child, depthOf(v, seen + 1));
    // Branches (anyOf, oneOf, allOf, not, if/then/else) describe this same level.
    let branch = 0;
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const list = target[key];
      if (Array.isArray(list)) for (const b of list) branch = Math.max(branch, depthOf(b, seen + 1));
    }
    for (const key of ["not", "if", "then", "else"] as const) if (isObj(target[key])) branch = Math.max(branch, depthOf(target[key], seen + 1));
    return Math.max(isLevel(target) ? 1 + child : child, branch);
  };
  const depth = recursive ? Infinity : depthOf(root, 0);

  return {
    depth: Number.isFinite(depth) ? depth : 0,
    properties,
    stringLength,
    enumValues,
    largestEnum,
    expandedNodes: recursive ? null : expanded,
    recursive,
    cycle,
  };
}

/** Each limit with the schema's value against it, in the page's order. */
export function limitChecks(stats: SchemaStats, enumAllowance: number = SCHEMA_LIMITS.enumValues): LimitCheck[] {
  const big = stats.largestEnum;
  const checks: LimitCheck[] = [
    { id: "recursive", label: "Recursion", value: stats.recursive ? 1 : 0, limit: 0, ok: !stats.recursive, note: stats.recursive ? `Refers to itself through ${stats.cycle?.join(" then ")}. Flatten it into a fixed depth.` : "No $ref cycles." },
    { id: "depth", label: "Nesting depth", value: stats.depth, limit: SCHEMA_LIMITS.depth, ok: stats.recursive ? null : stats.depth <= SCHEMA_LIMITS.depth, note: stats.recursive ? "Unbounded: the schema is recursive." : "Object and array levels on the deepest path." },
    { id: "properties", label: "Total properties", value: stats.properties, limit: SCHEMA_LIMITS.properties, ok: stats.properties <= SCHEMA_LIMITS.properties },
    { id: "stringLength", label: "Total string length", value: stats.stringLength, limit: SCHEMA_LIMITS.stringLength, ok: stats.stringLength <= SCHEMA_LIMITS.stringLength, note: "Property names, definition names, enum values and const values." },
    {
      id: "enumValues",
      label: "Enum values",
      value: stats.enumValues,
      limit: enumAllowance,
      ok: stats.enumValues <= enumAllowance,
      note: enumAllowance === SCHEMA_LIMITS.enumValues ? "1,000 by default across every enum; the limit can be raised per app." : undefined,
    },
    {
      id: "bigEnumChars",
      label: "Largest string enum",
      value: big?.chars ?? 0,
      limit: SCHEMA_LIMITS.bigEnumChars,
      ok: !big || big.values <= SCHEMA_LIMITS.bigEnumValues || big.chars <= SCHEMA_LIMITS.bigEnumChars,
      note: big
        ? big.values > SCHEMA_LIMITS.bigEnumValues
          ? `${big.values.toLocaleString("en-US")} values at ${big.path}: over 250 values, so its strings may total 15,000 characters.`
          : `${big.values.toLocaleString("en-US")} values at ${big.path}: the 15,000-character cap applies only past 250 values.`
        : "No string enums.",
    },
    {
      id: "expandedNodes",
      label: "Size with $refs inlined",
      value: stats.expandedNodes ?? 0,
      limit: SCHEMA_LIMITS.expandedNodes,
      ok: stats.expandedNodes === null ? null : stats.expandedNodes <= SCHEMA_LIMITS.expandedNodes,
      note: stats.expandedNodes === null ? "Can't be inlined: the schema is recursive." : "Schema nodes once every $ref is replaced by what it points to.",
    },
  ];
  return checks;
}

/** Schemas the size checker can build in the page instead of carrying them in props (a big enum is 16 KB of JSON). */
export type GeneratedSchema = "nested-10" | "nested-11" | "nested-arrays-11" | "big-enum" | "many-enums";

function nested(levels: number, arrays: boolean): Json {
  let s: Json = { type: "string" };
  for (let i = levels - 1; i >= 0; i--) {
    s = arrays && i % 2 === 1 ? { type: "array", items: s } : { type: "object", properties: { [`level_${i + 1}`]: s }, required: [`level_${i + 1}`], additionalProperties: false };
  }
  return s;
}

export function generatedSchema(kind: GeneratedSchema): Json {
  switch (kind) {
    case "nested-10":
      return nested(10, false);
    case "nested-11":
      return nested(11, false);
    case "nested-arrays-11":
      return nested(11, true);
    case "big-enum":
      // 260 values of 61 characters: past 250 values, and 15,860 characters against the 15,000 cap.
      return {
        type: "object",
        properties: { sku: { type: "string", enum: Array.from({ length: 260 }, (_, i) => `SKU-${String(i).padStart(4, "0")}-${"x".repeat(52)}`) } },
        required: ["sku"],
        additionalProperties: false,
      };
    case "many-enums":
      // 1,500 values over six properties: past the default of 1,000, under the 15,000-character cap per enum.
      return {
        type: "object",
        properties: Object.fromEntries(Array.from({ length: 6 }, (_, k) => [`field_${k + 1}`, { type: "string", enum: Array.from({ length: 250 }, (_, i) => `v${k}_${i}`) }])),
        required: Array.from({ length: 6 }, (_, k) => `field_${k + 1}`),
        additionalProperties: false,
      };
  }
}
