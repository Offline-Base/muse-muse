// respondJson with non-object roots (array, enum) against the real Meta API.
import { z } from "zod";
process.env.GATEWAY_URL = "https://api.meta.ai";
process.env.PRODUCT_TOKEN = process.env.MODEL_API_KEY;
const { respondJson } = await import("../../template/lib/meta/json");
for (const [label, schema, input] of [
  ["array", z.array(z.object({ name: z.string(), note: z.string().optional() })).max(3), "List 3 garden birds."],
  ["enum", z.enum(["yes", "no"]), "Is a sparrow a bird?"],
] as const) {
  const t0 = Date.now();
  try {
    console.log("OK", label, JSON.stringify(await respondJson({ schema: schema as z.ZodType<unknown>, schemaName: label, input })), Date.now() - t0, "ms");
  } catch (e) {
    console.log("FAIL", label, (e as Error).message);
  }
}
