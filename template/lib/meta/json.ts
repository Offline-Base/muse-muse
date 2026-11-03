import OpenAI from "openai";
import type { Response, ResponseInput } from "openai/resources/responses/responses";
import { z } from "zod";
import { metaClient, testModelFor, type RequestLike } from "./client";
import { checkImageUrls } from "./parts";
import { plainDeep } from "./text";

export type JsonReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface RespondJsonOptions<T> {
  /**
   * Default "muse-wonder-1.0", the model for a product's own text and vision calls. Muse Muse never uses Spark 1.3. A
   * test build may run it on Spark 1.3 Contributor instead (testModelFor), which the product's code never chooses.
   */
  model?: "muse-wonder-1.0";
  schema: z.ZodType<T>;
  /** Letters, digits, _ and -. Sent as the json_schema name. */
  schemaName: string;
  instructions?: string;
  /** A string, or Responses API input items (messages with input_text, input_image, input_file, input_video parts). */
  input: string | unknown[];
  /** Default "low". Even trivial answers use 150 to 400 reasoning tokens at low. */
  reasoningEffort?: JsonReasoningEffort;
  /** Reasoning tokens count against it, so keep it at the answer's size plus room for reasoning, never below 600. */
  maxOutputTokens?: number;
  /** The incoming request, or `await headers()` in a server action, so the gateway can rate limit each visitor. */
  request?: RequestLike | null;
  /** Defaults to metaClient(request), the gateway client. */
  client?: OpenAI;
}

/** The model's reply never matched the schema, even after one retry. */
export class RespondJsonError extends Error {
  /** zod's readable list of what didn't match. */
  readonly issues: string;
  /** The model's last reply text. */
  readonly raw: string;
  constructor(message: string, issues: string, raw: string) {
    super(message);
    this.name = "RespondJsonError";
    this.issues = issues;
    this.raw = raw;
  }
}

type Json = Record<string, unknown>;
type Mode = "strict" | "loose" | "instructions";

/**
 * Asks a Muse model for JSON that matches `schema` and returns it typed.
 *
 * Uses the Responses API's native structured output (text.format json_schema, strict: true). The zod schema is
 * converted with z.toJSONSchema and made strict-compatible: every object gets additionalProperties: false and lists
 * every property in required, and optional properties become nullable (null comes back as a missing key, so zod sees
 * the shape it expects). If Meta rejects the schema (HTTP 400 on `schema`, for example a recursive schema or a
 * z.record), it falls back to non-strict json_schema, then to JSON described in the instructions.
 *
 * The reply is validated with zod. On a mismatch it retries once, feeding the validation error back.
 * Other API errors (401, 429, media_url_origin_error) are thrown unchanged for the caller to handle.
 * The instructions always ask for no em dashes, and every string in the reply goes through plain().
 */
export async function respondJson<T>(opts: RespondJsonOptions<T>): Promise<T> {
  const client = opts.client ?? metaClient(opts.request);
  const generated = z.toJSONSchema(opts.schema, { unrepresentable: "any", io: "output" }) as Json;
  delete generated.$schema;
  // Structured output needs an object at the root, so arrays and scalars travel as { value }.
  const wrapped = generated.type !== "object" && !isObject(generated.properties);
  const { $defs, ...inner } = generated;
  const plain: Json = wrapped
    ? { type: "object", properties: { value: inner }, required: ["value"], additionalProperties: false, ...($defs ? { $defs } : {}) }
    : generated;
  const strict = toStrictSchema(plain);
  const unwrap = (v: unknown) => (wrapped && isObject(v) && "value" in v ? v.value : v);

  const modes: Mode[] = strict.ok ? ["strict", "loose", "instructions"] : ["loose", "instructions"];
  let mode = 0;
  // An image part built by hand, not with imagePart(), gets the same check: an SVG throws here, not after a refused call.
  if (typeof opts.input !== "string") checkImageUrls(opts.input);
  let input: ResponseInput = typeof opts.input === "string" ? [{ role: "user", content: opts.input }] : (opts.input as ResponseInput);
  let lastIssues = "";
  let lastRaw = "";

  for (let attempt = 0; attempt < 2; ) {
    const current = modes[mode];
    let res: Response;
    try {
      res = await client.responses.create({
        // metaClient makes this swap too. This covers a client passed in, which may not.
        model: testModelFor(opts.model ?? "muse-wonder-1.0"),
        instructions: instructionsFor(current, opts.instructions, plain),
        input,
        reasoning: { effort: opts.reasoningEffort ?? "low" },
        ...(opts.maxOutputTokens ? { max_output_tokens: opts.maxOutputTokens } : {}),
        ...(current === "instructions"
          ? {}
          : {
              text: {
                format: {
                  type: "json_schema" as const,
                  name: opts.schemaName,
                  strict: current === "strict",
                  schema: current === "strict" ? strict.schema : plain,
                },
              },
            }),
      });
    } catch (err) {
      if (current !== "instructions" && isSchemaRejection(err) && mode < modes.length - 1) {
        mode++;
        continue;
      }
      throw err;
    }

    const raw = res.output_text ?? "";
    const parsed = parseJsonText(raw);
    const result =
      parsed === undefined
        ? null
        : opts.schema.safeParse(unwrap(strict.repair(parsed)));
    if (result?.success) return plainDeep(result.data);

    lastRaw = raw;
    lastIssues = result ? z.prettifyError(result.error) : "The reply was not valid JSON.";
    attempt++;
    input = [
      ...input,
      { role: "assistant", content: raw || "(empty reply)" },
      {
        role: "user",
        content: `That reply did not match the JSON schema:\n${lastIssues}\nReply again with only the corrected JSON.`,
      },
    ];
  }
  throw new RespondJsonError(`The model's JSON did not match "${opts.schemaName}" after a retry.`, lastIssues, lastRaw);
}

/** Every call asks for copy without em dashes, so plain() on the reply is only a fallback. */
export const NO_EM_DASHES = "Never use em dashes in the text you write. Use a comma, colon or period instead.";

function instructionsFor(mode: Mode, base: string | undefined, schema: Json): string {
  const parts = [base, NO_EM_DASHES];
  if (mode === "instructions") {
    parts.push("Reply with only one JSON value that matches this JSON Schema. No prose, no code fences.\n" + JSON.stringify(schema));
  }
  return parts.filter(Boolean).join("\n\n");
}

function isSchemaRejection(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError) || err.status !== 400) return false;
  const body = (err.error ?? {}) as { param?: unknown; message?: unknown };
  const text = `${String(body.param ?? "")} ${String(body.message ?? err.message)}`;
  return /schema|json|text\.format|strict/i.test(text);
}

/** Parses model text as JSON, tolerating code fences and stray prose around one object or array. */
export function parseJsonText(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

interface StrictSchema {
  /** False when the schema can't be strict (a record or other open object): skip straight to loose mode. */
  ok: boolean;
  schema: Json;
  /** Turns null back into a missing key for properties that were optional but not nullable. */
  repair: (value: unknown) => unknown;
}

/** Makes a JSON Schema from z.toJSONSchema strict-compatible (OpenAI-style strict mode, which Meta follows). */
export function toStrictSchema(source: Json): StrictSchema {
  const optionalKeys = new WeakMap<Json, Set<string>>();
  let ok = true;

  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!isObject(node)) return node;
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === "properties" && isObject(v) ? mapValues(v, visit) : k === "$defs" && isObject(v) ? mapValues(v, visit) : visit(v);
    }
    if (Array.isArray(out.oneOf) && !out.anyOf) {
      // Strict mode documents anyOf only. zod emits oneOf for discriminated unions, whose branches never overlap.
      out.anyOf = out.oneOf;
      delete out.oneOf;
    }
    const isObjectNode = out.type === "object" || isObject(out.properties);
    if (!isObjectNode) return out;
    if (isObject(out.additionalProperties) || out.patternProperties || out.propertyNames) {
      ok = false;
      return out;
    }
    const props = (isObject(out.properties) ? out.properties : {}) as Record<string, Json>;
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    const optional = new Set<string>();
    for (const key of Object.keys(props)) {
      if (required.has(key)) continue;
      if (!acceptsNull(props[key])) optional.add(key);
      props[key] = nullable(props[key]);
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
    optionalKeys.set(out, optional);
    return out;
  };

  const schema = visit(source) as Json;

  const resolve = (node: Json): Json => {
    const ref = node.$ref;
    if (typeof ref !== "string") return node;
    if (ref === "#") return schema;
    const name = ref.replace(/^#\/\$defs\//, "");
    const defs = schema.$defs as Record<string, Json> | undefined;
    return defs?.[name] ?? {};
  };

  const repair = (node: Json, value: unknown, depth: number): unknown => {
    if (depth > 64 || value === null || value === undefined) return value;
    const n = resolve(node);
    if (Array.isArray(n.anyOf)) {
      const branch = pickBranch(n.anyOf as Json[], value, resolve);
      return branch ? repair(branch, value, depth + 1) : value;
    }
    if (Array.isArray(value)) {
      if (Array.isArray(n.prefixItems)) return value.map((v, i) => repair(((n.prefixItems as Json[])[i] ?? {}) as Json, v, depth + 1));
      return isObject(n.items) ? value.map((v) => repair(n.items as Json, v, depth + 1)) : value;
    }
    if (isObject(value) && isObject(n.properties)) {
      const props = n.properties as Record<string, Json>;
      const optional = optionalKeys.get(n);
      const out: Json = {};
      for (const [k, v] of Object.entries(value)) {
        if (v === null && optional?.has(k)) continue;
        out[k] = props[k] ? repair(props[k], v, depth + 1) : v;
      }
      return out;
    }
    return value;
  };

  return { ok, schema, repair: (value) => repair(schema, value, 0) };
}

function nullable(prop: Json): Json {
  if (acceptsNull(prop)) return prop;
  if (typeof prop.type === "string" && !prop.$ref && !prop.anyOf && !("const" in prop)) {
    const out: Json = { ...prop, type: [prop.type, "null"] };
    if (Array.isArray(prop.enum)) out.enum = [...prop.enum, null];
    return out;
  }
  const { description, ...rest } = prop;
  return { ...(description ? { description } : {}), anyOf: [rest, { type: "null" }] };
}

function acceptsNull(prop: Json): boolean {
  if (prop.type === "null") return true;
  if (Array.isArray(prop.type) && prop.type.includes("null")) return true;
  return Array.isArray(prop.anyOf) && (prop.anyOf as Json[]).some((b) => isObject(b) && acceptsNull(b));
}

/** Picks the anyOf branch a value belongs to: by JSON type, then by const discriminators and known keys. */
function pickBranch(branches: Json[], value: unknown, resolve: (n: Json) => Json): Json | undefined {
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const typed = branches.map(resolve).filter((b) => {
    const t = b.type ?? (isObject(b.properties) ? "object" : b.items ? "array" : undefined);
    if (t === undefined) return true;
    const types = Array.isArray(t) ? t : [t];
    return types.some((x) => x === kind || (kind === "number" && x === "integer"));
  });
  if (kind !== "object" || typed.length < 2) return typed[0];
  const obj = value as Json;
  return (
    typed.find((b) => {
      const props = (b.properties ?? {}) as Record<string, Json>;
      const constsMatch = Object.entries(props).every(([k, p]) => !("const" in p) || obj[k] === p.const);
      return constsMatch && Object.keys(obj).every((k) => k in props);
    }) ?? typed[0]
  );
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mapValues(obj: Json, fn: (v: unknown) => unknown): Json {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}
