// Test (a): a photo muse. A bird-feeder photo made with Muse Image, passed as a data: URL, with the note
// "Count them for me". Then prepareFixtures on the brief (with a local store, since Blob isn't set up) and the
// rendered build prompt.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderBuildPrompt, briefToMarkdown } from "@/lib/brief/render";
import { prepareFixtures, writeBrief } from "@/lib/brief/write";
import { assertBrief, cachedImage, excerpt, MEDIA_DIR, printUsage, ref, saveJson, timed } from "./brief-common";

const photo = await cachedImage(
  "bird-feeder",
  "A phone photo of a backyard bird feeder hanging from a tree branch in morning light, with four small songbirds: two house finches on the perches, one chickadee on the roof, one sparrow on the ground tray. Slightly off-center, natural colors.",
);
const references = [ref("image", "IMG_2041.jpg", "image/jpeg", photo)];

const result = await timed("writeBrief photo", () => writeBrief({ note: "Count them for me", references }));
assertBrief(result.brief);
excerpt(result.brief);
printUsage(result.usage, result.costUsd);
saveJson("brief-photo", { brief: result.brief, references: references.map((r) => ({ ...r, url: r.url.slice(0, 40) })) });

const saved: string[] = [];
const fixtures = await timed("prepareFixtures", () =>
  prepareFixtures({
    buildId: "test-photo",
    brief: result.brief,
    references,
    store: async (fileName, body) => {
      const path = join(MEDIA_DIR, `fixture-${fileName}`);
      writeFileSync(path, body);
      saved.push(path);
      return `file://${path}`;
    },
  }),
);
console.log("fixtures:", fixtures.fixtures.map((f) => ({ ...f, url: f.url.slice(0, 60) })));
printUsage(fixtures.usage, fixtures.costUsd);
console.log("saved locally:", saved);

const prompt = renderBuildPrompt(result.brief, {
  inspoFiles: ["img-2041.jpg"],
  fixtures: fixtures.fixtures.map((f) => ({ fileName: f.fileName, description: f.description })),
  maxModelSteps: 200,
});
writeFileSync(join(MEDIA_DIR, "brief-photo.md"), prompt);
writeFileSync(join(MEDIA_DIR, "brief-photo.page.md"), briefToMarkdown(result.brief));
console.log(`build prompt: ${prompt.length} chars, written to ${join(MEDIA_DIR, "brief-photo.md")}`);
