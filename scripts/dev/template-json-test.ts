// Exercises template/lib/meta/json.ts against the real Meta API (GATEWAY_URL pointed straight at api.meta.ai).
import { z } from "zod";
process.env.GATEWAY_URL = "https://api.meta.ai";
process.env.PRODUCT_TOKEN = process.env.MODEL_API_KEY;
const { respondJson, toStrictSchema } = await import("../../template/lib/meta/json");

const Sighting = z.object({
  name: z.string().min(1),
  count: z.number().int().nonnegative(),
  note: z.string().optional(),
  maybe: z.string().nullable(),
  both: z.string().nullish(),
  kind: z.enum(["songbird", "raptor", "waterbird"]).optional(),
  tags: z.array(z.string()).max(4),
  where: z.object({ place: z.string(), lat: z.number().optional() }),
  u: z.discriminatedUnion("t", [z.object({ t: z.literal("seen"), when: z.string().optional() }), z.object({ t: z.literal("heard"), loud: z.boolean() })]),
});
const strict = toStrictSchema(z.toJSONSchema(Sighting) as Record<string, unknown>);
console.log("strict ok:", strict.ok);
console.log("repair:", JSON.stringify(strict.repair({ name: "x", note: null, maybe: null, both: null, kind: null, where: { place: "p", lat: null }, u: { t: "seen", when: null } })));

async function timed<T>(label: string, fn: () => Promise<T>) {
  const t0 = Date.now();
  try {
    const out = await fn();
    console.log(`OK ${label} ${Date.now() - t0}ms`, JSON.stringify(out).slice(0, 300));
  } catch (e) {
    console.log(`FAIL ${label} ${Date.now() - t0}ms`, (e as Error).message, (e as { issues?: string }).issues ?? "");
  }
}
const which = process.argv[2] ?? "all";
if (which === "all" || which === "strict") await timed("strict", () => respondJson({ schema: Sighting, schemaName: "sighting", input: "Make up a bird sighting in a city park. Leave out the note and the latitude." }));
if (which === "all" || which === "record") await timed("record->loose", () => respondJson({ schema: z.object({ counts: z.record(z.string(), z.number().int()) }), schemaName: "counts", input: "Count birds by species for a made-up park survey, 3 species." }));
const Tree: z.ZodType<{ name: string; kids: unknown[] }> = z.lazy(() => z.object({ name: z.string(), kids: z.array(Tree).max(3) }));
if (which === "all" || which === "recursive") await timed("recursive->instructions", () => respondJson({ schema: Tree, schemaName: "tree", input: "A tiny family tree, two levels." }));
if (which === "all" || which === "image") {
  const { imagePart } = await import("../../template/lib/meta/parts");
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await timed("image", () => respondJson({ schema: z.object({ color: z.string() }), schemaName: "color", input: [{ role: "user", content: [{ type: "input_text", text: "What color is this pixel?" }, imagePart(png)] }] }));
}
