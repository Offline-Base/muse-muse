// Forces a zod-only refinement so the first reply fails validation and respondJson must retry with feedback.
import OpenAI from "openai";
import { z } from "zod";
const { respondJson } = await import("../../template/lib/meta/json");
const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY! });
const orig = client.responses.create.bind(client.responses);
let calls = 0;
(client.responses as unknown as { create: unknown }).create = async (body: Record<string, unknown>) => {
  calls++;
  const res = await orig(body as never);
  console.log(`call ${calls}: input items=${(body.input as unknown[]).length} format=${JSON.stringify((body.text as { format?: { strict?: boolean } })?.format?.strict)} ->`, (res as unknown as { output_text: string }).output_text);
  return res;
};
const S = z.object({ word: z.string().refine((s) => s.toUpperCase() === s && s.startsWith("Z"), "word must be ALL CAPS and start with Z") });
const t0 = Date.now();
try {
  console.log("OK", JSON.stringify(await respondJson({ schema: S, schemaName: "word", input: "Give me one lowercase word for a small songbird.", client: client as never })), Date.now() - t0, "ms");
} catch (e) {
  console.log("FAIL", (e as Error).name, (e as Error).message, Date.now() - t0, "ms");
}
