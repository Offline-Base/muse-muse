// Forces the repair retry in respondStructured: the extra check rejects the first reply, so the second call must send
// the model its JSON plus the problem and get a corrected reply.
import { z } from "zod";
import { textPart } from "@/lib/brief/media";
import { respondStructured } from "@/lib/brief/structured";
import { printUsage, timed } from "./brief-common";

let calls = 0;
const result = await timed("respondStructured forced retry", () =>
  respondStructured({
    model: "muse-spark-1.3-contributor",
    instructions: "Suggest a name for a product.",
    content: [textPart("A tool that counts birds at a feeder.")],
    schema: z.object({ name: z.string().min(1), slug: z.string() }),
    schemaName: "probe",
    effort: "low",
    check: (d) => (calls++ === 0 ? [`name must start with the word "Feeder" (it was "${d.name}")`] : []),
  }),
);
console.log("result:", JSON.stringify(result.data), "attempts", result.attempts, "issues", result.issues);
printUsage(result.usage, result.usage.reduce((s, u) => s + u.costUsd, 0));
console.log("CHECK retried and fixed:", result.attempts === 2 && /^feeder/i.test(result.data.name) ? "ok" : "FAIL");
