import { z } from "zod";

/**
 * Turns a zod schema into a JSON schema that Meta's strict structured output accepts (docs/SPIKES.md): no $schema,
 * `additionalProperties: false` on every object, and every property listed in `required`. Optional properties
 * become nullable instead. Use `nullsToOptional` on the reply before validating it with the zod schema.
 */

type Json = Record<string, unknown>;

/** Keywords that only add noise for the model. */
const DROP_KEYS = new Set(["$schema", "$id", "default", "examples"]);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function allowsNull(node: Json): boolean {
  const t = node.type;
  if (t === "null" || (Array.isArray(t) && t.includes("null"))) return true;
  const variants = (node.anyOf ?? node.oneOf) as unknown;
  return Array.isArray(variants) && variants.some((v) => isObject(v) && allowsNull(v));
}

function makeNullable(node: Json): Json {
  if (allowsNull(node)) return node;
  if (typeof node.type === "string" && !node.enum && !node.const) return { ...node, type: [node.type, "null"] };
  if (Array.isArray(node.type) && !node.enum) return { ...node, type: [...node.type, "null"] };
  return { anyOf: [node, { type: "null" }] };
}

function strictNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictNode);
  if (!isObject(node)) return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROP_KEYS.has(key)) continue;
    // zod writes MAX_SAFE_INTEGER bounds for z.number().int(). They say nothing.
    if ((key === "maximum" && value === MAX_SAFE) || (key === "minimum" && value === -MAX_SAFE)) continue;
    if (key === "properties" && isObject(value)) {
      const props: Json = {};
      for (const [name, prop] of Object.entries(value)) props[name] = strictNode(prop);
      out.properties = props;
      continue;
    }
    out[key] = strictNode(value);
  }
  if (out.type === "object" || isObject(out.properties)) {
    const props = (isObject(out.properties) ? out.properties : {}) as Json;
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    for (const name of Object.keys(props)) {
      if (!required.has(name)) props[name] = makeNullable(props[name] as Json);
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

/** The strict JSON schema for a zod schema, ready for `text.format.schema`. */
export function strictJsonSchema(schema: z.ZodType): Json {
  return strictNode(z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" })) as Json;
}

/**
 * Removes nulls the strict schema forced onto optional properties, so zod's `.optional()` accepts the reply. Walks the
 * original (non-strict) JSON schema of the zod type.
 */
export function nullsToOptional(value: unknown, schema: z.ZodType): unknown {
  return walk(value, z.toJSONSchema(schema, { io: "output" }) as Json);
}

function walk(value: unknown, node: Json | undefined): unknown {
  if (!node) return value;
  if (Array.isArray(value)) {
    const items = isObject(node.items) ? node.items : undefined;
    return value.map((v) => walk(v, items));
  }
  if (!isObject(value)) return value;
  const props = isObject(node.properties) ? node.properties : undefined;
  if (!props) {
    const variant = ((node.anyOf ?? node.oneOf) as Json[] | undefined)?.find((v) => isObject(v) && isObject(v.properties));
    return variant ? walk(value, variant) : value;
  }
  const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
  const out: Json = {};
  for (const [key, v] of Object.entries(value)) {
    const prop = props[key] as Json | undefined;
    if (v === null && !required.has(key) && prop && !allowsNull(prop)) continue;
    out[key] = walk(v, prop);
  }
  return out;
}
