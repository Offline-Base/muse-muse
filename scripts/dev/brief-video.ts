// A short video muse: a 3-second MP4 (a slow zoom on the bird-feeder photo, made with ffmpeg) as a data: URL.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeBrief } from "@/lib/brief/write";
import { assertBrief, excerpt, MEDIA_DIR, printUsage, ref, timed } from "./brief-common";

const mp4 = readFileSync(join(MEDIA_DIR, "feeder-clip.mp4"));
const references = [ref("video", "feeder-clip.mp4", "video/mp4", mp4)];
const result = await timed("writeBrief video", () => writeBrief({ note: "I film my feeder every morning. Tell me who visited.", references }));
assertBrief(result.brief);
excerpt(result.brief);
printUsage(result.usage, result.costUsd);
console.log("CHECK video described:", /bird|feeder/i.test(result.brief.inspiration.references[0]?.describes ?? "") ? "ok" : "FAIL");
