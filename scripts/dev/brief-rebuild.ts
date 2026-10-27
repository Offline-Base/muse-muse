// Test (b): the WhatsApp chatbot rebuild from catalog/meta-resources.json. Text only. Must come back "partly" with
// the WhatsApp limit stated.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import resources from "@/catalog/meta-resources.json";
import { renderBuildPrompt } from "@/lib/brief/render";
import { writeBrief } from "@/lib/brief/write";
import type { RebuildTarget } from "@/lib/types";
import { assertBrief, excerpt, MEDIA_DIR, printUsage, saveJson, timed } from "./brief-common";

const id = process.argv[2] ?? "whatsapp-multimodal-chatbot";
const target = (resources.videos as RebuildTarget[]).find((v) => v.id === id);
if (!target) throw new Error(`No video ${id}`);

const result = await timed(`writeBrief rebuild ${id}`, () => writeBrief({ note: null, references: [], rebuildOf: target }));
assertBrief(result.brief);
excerpt(result.brief);
printUsage(result.usage, result.costUsd);
saveJson(`brief-rebuild-${id}`, result.brief);

const b = result.brief;
const fitLimit = b.limits.find((l) => /rebuild fit/i.test(l));
const whatsapp = b.limits.find((l) => /whatsapp/i.test(l));
console.log("CHECK verdict partly:", b.verdict === "partly" ? "ok" : `FAIL (${b.verdict})`);
console.log("CHECK fit limit:", fitLimit ? `ok: ${fitLimit}` : "FAIL");
console.log("CHECK WhatsApp limit:", whatsapp ? `ok: ${whatsapp}` : "FAIL");
console.log("CHECK no references:", b.inspiration.references.length === 0 ? "ok" : "FAIL");

const prompt = renderBuildPrompt(b, { inspoFiles: [], fixtures: [], maxModelSteps: 200, rebuildOf: target });
writeFileSync(join(MEDIA_DIR, `brief-rebuild-${id}.md`), prompt);
console.log(prompt.split("## Rebuild")[1]?.split("## Sample")[0]);
