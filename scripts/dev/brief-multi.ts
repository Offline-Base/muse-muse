// A muse with three references of mixed kinds (photo, UI screenshot, voice memo), to check that
// inspiration.references has one entry per reference with the right 0-based index and kind.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeBrief } from "@/lib/brief/write";
import { assertBrief, cachedImage, excerpt, MEDIA_DIR, printUsage, ref, timed } from "./brief-common";

const feeder = await cachedImage("bird-feeder", "unused, cached");
const ui = await cachedImage("shot-good-start", "unused, cached", "1024x1536");
const wav = readFileSync(join(MEDIA_DIR, "memo.wav"));
const references = [
  ref("image", "ui-i-like.jpg", "image/jpeg", ui),
  ref("audio", "memo.wav", "audio/wav", wav),
  ref("image", "feeder.jpg", "image/jpeg", feeder),
];
const result = await timed("writeBrief multi", () =>
  writeBrief({ note: "Ignore the garden idea in the memo. Use the look of the first screenshot for a bird counter for the third photo.", references }),
);
assertBrief(result.brief);
excerpt(result.brief);
printUsage(result.usage, result.costUsd);
const refs = result.brief.inspiration.references;
console.log(
  "CHECK one entry per reference with matching kinds:",
  refs.length === 3 && refs.every((r, i) => r.index === i && r.kind === references[i].kind) ? "ok" : `FAIL ${JSON.stringify(refs.map((r) => [r.index, r.kind]))}`,
);
console.log("CHECK note wins (bird counter, not garden):", /bird/i.test(result.brief.name + result.brief.tagline) ? "ok" : "FAIL");

// The user sample must be the feeder photo (index 2), not the UI screenshot (index 0).
const { prepareFixtures } = await import("@/lib/brief/write");
const prepared = await prepareFixtures({
  buildId: "test-multi",
  brief: result.brief,
  references,
  store: async (fileName) => `memory://${fileName}`,
});
console.log("fixtures:", prepared.fixtures.map((f) => f.fileName), "referenceIndex from brief:", result.brief.fixtures.map((f) => f.referenceIndex));
const sample = prepared.fixtures.find((f) => f.url.startsWith("data:"));
console.log("CHECK user sample is the feeder photo:", sample?.fileName === "feeder.jpg" ? "ok" : `FAIL (${sample?.fileName})`);
