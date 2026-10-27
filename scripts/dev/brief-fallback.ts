// Test (g): the media_url_origin_error fallback, end to end against api.meta.ai.
// The content part points at a Wikimedia URL Meta's fetcher can't download (it returns media_url_origin_error), and
// the fallback source points at a URL Node can download, so respondStructured must catch the real error, inline the
// image as a data URL and succeed on the retry.
import { z } from "zod";
import { imagePart, textPart } from "@/lib/brief/media";
import { respondStructured } from "@/lib/brief/structured";
import { printUsage, timed } from "./brief-common";

const blocked =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Eopsaltria_australis_-_Mogo_Campground.jpg/640px-Eopsaltria_australis_-_Mogo_Campground.jpg";
const fetchable =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Eopsaltria_australis_-_Mogo_Campground.jpg/500px-Eopsaltria_australis_-_Mogo_Campground.jpg";

const result = await timed("respondStructured with an unfetchable image", () =>
  respondStructured({
    model: "muse-spark-1.3",
    instructions: "Describe the image briefly.",
    content: [textPart("What animal is in this photo, and what colors is it?"), imagePart(blocked)],
    sources: new Map([[1, { url: fetchable, kind: "image" as const, contentType: "image/jpeg", fileName: "robin.jpg" }]]),
    schema: z.object({ animal: z.string(), colors: z.array(z.string()) }),
    schemaName: "probe",
    effort: "low",
  }),
);
console.log("result:", JSON.stringify(result.data), "attempts", result.attempts);
printUsage(result.usage, result.usage.reduce((s, u) => s + u.costUsd, 0));
console.log("CHECK fallback answered about a bird:", /bird|robin/i.test(result.data.animal) ? "ok" : "FAIL");
