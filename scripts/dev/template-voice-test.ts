// Exercises template/lib/meta/voice.ts multipart path against the real Meta API.
import { readFileSync } from "node:fs";
process.env.GATEWAY_URL = "https://api.meta.ai";
process.env.PRODUCT_TOKEN = process.env.MODEL_API_KEY;
const { transcribeFile } = await import("../../template/lib/meta/voice");
const wav = readFileSync(process.argv[2]);
let t0 = Date.now();
console.log("bytes:", JSON.stringify(await transcribeFile({ bytes: wav })), Date.now() - t0, "ms");
t0 = Date.now();
console.log("data url:", JSON.stringify(await transcribeFile({ url: `data:audio/wav;base64,${wav.toString("base64")}` })), Date.now() - t0, "ms");
try {
  await transcribeFile({ bytes: Buffer.from("ID3 not a wav file at all, just some text padding padding padding") });
} catch (e) {
  console.log("non-wav rejected:", (e as Error).message);
}
