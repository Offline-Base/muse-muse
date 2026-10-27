// Generates the example product's fixture photo with Muse Image (one image, $0.01). Usage: tsx template-make-bird-fixture.ts <out.jpg>
import { writeFileSync } from "node:fs";
import OpenAI from "openai";
const meta = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY! });
const t0 = Date.now();
const out = await meta.images.generate({
  model: "muse-image-1.0",
  prompt: "A realistic garden photo of a wooden bird feeder with exactly three small brown sparrows perched on it, morning light, shallow depth of field",
  n: 1,
  size: "1024x768",
  output_format: "jpeg",
} as never);
const b64 = (out as { data?: Array<{ b64_json?: string }> }).data?.[0]?.b64_json;
if (!b64) throw new Error("no image");
writeFileSync(process.argv[2], Buffer.from(b64, "base64"));
console.log("wrote", process.argv[2], Buffer.from(b64, "base64").length, "bytes in", Date.now() - t0, "ms", JSON.stringify((out as { usage?: unknown }).usage));
