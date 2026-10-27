// Probe: does Meta's strict structured output accept zod's constraint keywords (pattern, minLength, maxItems...)?
import { metaPlatform } from "@/lib/meta/platform";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { BriefSchema } from "@/lib/brief/schema";
import { z } from "zod";

async function tryCall(label: string, schema: Record<string, unknown>) {
  const t = Date.now();
  try {
    const res = await metaPlatform().responses.create({
      model: "muse-spark-1.3",
      reasoning: { effort: "low" },
      input: "Make a tiny brief for a tip calculator app. Fill every field.",
      text: { format: { type: "json_schema", name: "probe", strict: true, schema } },
    });
    console.log(label, "OK", Date.now() - t, "ms", res.output_text.slice(0, 300), JSON.stringify(res.usage));
  } catch (e) {
    const err = e as { status?: number; error?: unknown; message?: string };
    console.log(label, "FAIL", err.status, JSON.stringify(err.error ?? err.message).slice(0, 500));
  }
}

const small = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(40),
  name: z.string().min(1).max(60),
  steps: z.array(z.string().min(1)).min(1).max(3),
  n: z.number().int().nonnegative(),
  extra: z.string().optional(),
});
console.log(JSON.stringify(strictJsonSchema(small)));
await tryCall("small-constraints", strictJsonSchema(small));
await tryCall("full-brief", strictJsonSchema(BriefSchema));
