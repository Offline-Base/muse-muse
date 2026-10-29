// Probes which JSON-schema features Meta's strict structured output accepts. Throwaway.
import OpenAI from "openai";

const meta = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY! });

async function tryFormat(label: string, schema: Record<string, unknown>, strict = true, extra: Record<string, unknown> = {}) {
  const t0 = Date.now();
  try {
    const res = await meta.responses.create({
      model: "muse-spark-1.3-contributor",
      input: "Make up a bird sighting.",
      reasoning: { effort: "low" },
      text: { format: { type: "json_schema", name: "probe", strict, schema } },
      ...extra,
    } as never);
    const r = res as unknown as OpenAI.Responses.Response;
    console.log(`OK   ${label} ${Date.now() - t0}ms ->`, r.output_text.slice(0, 200));
  } catch (e) {
    const err = e as InstanceType<typeof OpenAI.APIError>;
    console.log(`FAIL ${label} ${err.status}`, JSON.stringify(err.error ?? err.message).slice(0, 400));
  }
}

const base = { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false };
const which = process.argv[2] ?? "all";
const cases: Array<[string, Record<string, unknown>, boolean?, Record<string, unknown>?]> = [
  ["base", base],
  ["missing-required", { type: "object", properties: { name: { type: "string" }, n: { type: "number" } }, required: ["name"], additionalProperties: false }],
  ["no-additionalProperties", { type: "object", properties: { name: { type: "string" } }, required: ["name"] }],
  ["int-min-max", { ...base, properties: { name: { type: "string", minLength: 1, description: "bird" }, n: { type: "integer", minimum: 0, maximum: 9007199254740991 } }, required: ["name", "n"] }],
  ["type-array-null", { ...base, properties: { name: { type: ["string", "null"] } } }],
  ["enum-null", { ...base, properties: { name: { type: ["string", "null"], enum: ["a", "b", null] } } }],
  ["anyOf-null", { ...base, properties: { name: { anyOf: [{ type: "string", const: "x" }, { type: "null" }] } } }],
  ["default-kw", { ...base, properties: { name: { type: "string", default: "x" } } }],
  ["maxItems", { ...base, properties: { name: { type: "array", maxItems: 3, items: { type: "string" } } } }],
  ["any-empty", { ...base, properties: { name: {} } }],
  ["ref-root", { type: "object", properties: { name: { type: "string" }, kids: { type: "array", maxItems: 2, items: { $ref: "#" } } }, required: ["name", "kids"], additionalProperties: false }],
  ["record-loose", { type: "object", properties: { m: { type: "object", additionalProperties: { type: "number" } } }, required: ["m"] }, false],
  ["$schema-kw", { $schema: "https://json-schema.org/draft/2020-12/schema", ...base }],
  ["effort-minimal", base, true, { reasoning: { effort: "minimal" } }],
];
for (const [label, schema, strict, extra] of cases) {
  if (which !== "all" && !which.split(",").includes(label)) continue;
  await tryFormat(label, schema, strict ?? true, extra ?? {});
}
