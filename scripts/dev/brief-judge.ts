// Test (f): judgeBuild on generated "screenshots" for the photo brief (run brief-photo.ts first), once where they
// match the brief and once where they obviously don't. Plus the no-screenshot short circuit.
import type { Brief } from "@/lib/brief/schema";
import { judgeBuild } from "@/lib/judge";
import { cachedImage, dataUrl, loadJson, printUsage, ref, timed } from "./brief-common";

const saved = loadJson<{ brief: Brief }>("brief-photo");
if (!saved) throw new Error("Run scripts/dev/brief-photo.ts first");
const brief = saved.brief;
const feeder = await cachedImage("bird-feeder", "unused, cached");
const references = [ref("image", "IMG_2041.jpg", "image/jpeg", feeder)];

const shots = {
  goodStart: await cachedImage(
    "shot-good-start",
    `A clean mobile web app screenshot, phone portrait. Header text "${brief.name}". A large dashed upload box with the label "Photo of your feeder" and a blue "Count birds" button. Light grey background, white card, simple sans-serif type. Footer small text "Built with Muse Muse. Not an official Meta product."`,
    "1024x1536",
  ),
  goodResult: await cachedImage(
    "shot-good-result",
    `A clean mobile web app screenshot, phone portrait. Header text "${brief.name}". A photo of a backyard bird feeder with four small birds, each bird inside a numbered blue box 1 to 4. Below it a big result line "4 birds found" and a short list: "Bird 1 on the roof, Bird 2 left perch, Bird 3 right perch, Bird 4 seed tray". A note "Counts are estimates." Footer small text "Built with Muse Muse. Not an official Meta product."`,
    "1024x1536",
  ),
  badStart: await cachedImage(
    "shot-bad-start",
    "A mobile web app screenshot, phone portrait, of a pasta recipe app home page with a grid of pasta dish photos and a search bar that says Search recipes.",
    "1024x1536",
  ),
  badResult: await cachedImage(
    "shot-bad-result",
    "A mobile web app screenshot, phone portrait, showing a centered loading spinner and below it a red error box that says Something went wrong. Please try again. Mostly empty white page.",
    "1024x1536",
  ),
};
const url = (b: Buffer) => dataUrl(b, "image/jpeg");

const good = await timed("judge matching", () =>
  judgeBuild({
    brief,
    references,
    screenshots: [
      { url: url(shots.goodStart), caption: "01-start: Open the bird counter" },
      { url: url(shots.goodResult), caption: "02-result: Count the birds in the sample photo" },
    ],
  }),
);
console.log("matching verdict:", JSON.stringify(good.verdict, null, 2));
printUsage(good.usage, good.costUsd);

const bad = await timed("judge mismatching", () =>
  judgeBuild({
    brief,
    references,
    screenshots: [
      { url: url(shots.badStart), caption: "01-start: Open the bird counter" },
      { url: url(shots.badResult), caption: "02-result: Count the birds in the sample photo" },
    ],
  }),
);
console.log("mismatching verdict:", JSON.stringify(bad.verdict, null, 2));
printUsage(bad.usage, bad.costUsd);

const none = await judgeBuild({ brief, references, screenshots: [] });
console.log("no screenshots:", JSON.stringify(none.verdict), "cost", none.costUsd);

console.log("CHECK matching passes:", good.verdict.pass ? "ok" : "FAIL");
console.log("CHECK mismatching fails:", !bad.verdict.pass ? "ok" : "FAIL");
console.log("CHECK no screenshots fails without a call:", !none.verdict.pass && none.usage.length === 0 ? "ok" : "FAIL");
