// prepareFixtures on the saved WhatsApp rebuild brief (run brief-rebuild.ts first): one generated Muse Image picture,
// one text file, and an audio fixture that must be skipped. Files are written locally because Blob isn't set up.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Brief } from "@/lib/brief/schema";
import { prepareFixtures, safeFileName } from "@/lib/brief/write";
import { loadJson, MEDIA_DIR, printUsage, timed } from "./brief-common";

const brief = loadJson<Brief>("brief-rebuild-whatsapp-multimodal-chatbot");
if (!brief) throw new Error("Run scripts/dev/brief-rebuild.ts first");
console.log("brief fixtures:", brief.fixtures.map((f) => `${f.kind} sample=${f.fromUserSample}`));

const result = await timed("prepareFixtures", () =>
  prepareFixtures({
    buildId: "test-rebuild",
    brief,
    references: [],
    store: async (fileName, body) => {
      const path = join(MEDIA_DIR, `fixture-${fileName}`);
      writeFileSync(path, body);
      return `file://${path}`;
    },
  }),
);
for (const f of result.fixtures) console.log(`  ${f.fileName} -> ${f.url}\n    ${f.description}`);
printUsage(result.usage, result.costUsd);
const txt = result.fixtures.find((f) => f.fileName.endsWith(".txt"));
if (txt) console.log("  text file content:", JSON.stringify(readFileSync(txt.url.replace("file://", ""), "utf8")));
console.log("CHECK one image generated:", result.fixtures.filter((f) => f.fileName.endsWith(".jpg")).length === 1 ? "ok" : "FAIL");
console.log("CHECK audio skipped:", !result.fixtures.some((f) => f.fileName.endsWith(".wav")) ? "ok" : "FAIL");

// File name sanitizing.
for (const [name, type] of [
  ["IMG 2041 (1).JPEG", "image/jpeg"],
  ["../../etc/passwd", "application/pdf"],
  ["Café menü.png", "image/png"],
  ["voice memo", "audio/x-wav"],
  ["clip.MOV", "video/quicktime"],
  ["", "image/webp"],
] as const) {
  console.log(`  safeFileName(${JSON.stringify(name)}, ${type}) = ${safeFileName(name, type, "sample-1")}`);
}
