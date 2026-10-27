import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { z } from "zod";
import { type ContentPart, type MediaSource, withMediaFallback } from "@/lib/brief/media";
import { nullsToOptional, strictJsonSchema } from "@/lib/brief/strict-schema";
import { metaPlatform } from "@/lib/meta/platform";
import { fromResponsesUsage } from "@/lib/meta/pricing";
import type { ModelUsage } from "@/lib/types";

/**
 * One structured-output call on the Responses API (docs/SPIKES.md: text.format json_schema, strict), validated with
 * zod, with one repair retry that shows the model its JSON and the validation errors.
 */
export interface StructuredOptions<T> {
  model: string;
  instructions: string;
  content: ContentPart[];
  /** Remote media parts by content index, inlined if Meta can't fetch them. */
  sources?: Map<number, MediaSource>;
  schema: z.ZodType<T>;
  schemaName: string;
  effort: "low" | "medium" | "high";
  /** Cleans the parsed JSON before zod sees it (trim, slugify, clamp). */
  normalize?: (raw: unknown) => unknown;
  /** Extra checks after zod passes. Each string is a problem to repair. */
  check?: (data: T) => string[];
}

export interface StructuredResult<T> {
  data: T;
  usage: ModelUsage[];
  /** Problems from `check` that the retry didn't fix, for the caller to patch. */
  issues: string[];
  attempts: number;
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

export async function respondStructured<T>(opts: StructuredOptions<T>): Promise<StructuredResult<T>> {
  const meta = metaPlatform();
  const format = { type: "json_schema" as const, name: opts.schemaName, strict: true, schema: strictJsonSchema(opts.schema) };
  const usage: ModelUsage[] = [];
  let content = opts.content;

  const call = async (extra: ResponseInputItem[]) => {
    const res = await withMediaFallback(content, opts.sources ?? new Map(), async (parts) => {
      const r = await meta.responses.create({
        model: opts.model,
        instructions: opts.instructions,
        input: [{ role: "user", content: parts } as unknown as ResponseInputItem, ...extra],
        reasoning: { effort: opts.effort },
        text: { format },
      });
      // Keep the inlined parts so the retry doesn't hit the same origin error again.
      content = parts;
      return r;
    });
    usage.push(fromResponsesUsage(opts.model, res.usage));
    return res.output_text ?? "";
  };

  const evaluate = (text: string): { data?: T; problems: string[]; zodFailed: boolean } => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { problems: ["The reply was not valid JSON."], zodFailed: true };
    }
    const cleaned = opts.normalize ? opts.normalize(nullsToOptional(raw, opts.schema)) : nullsToOptional(raw, opts.schema);
    const parsed = opts.schema.safeParse(cleaned);
    if (!parsed.success) return { problems: zodIssues(parsed.error), zodFailed: true };
    return { data: parsed.data, problems: opts.check?.(parsed.data) ?? [], zodFailed: false };
  };

  const firstText = await call([]);
  const first = evaluate(firstText);
  if (first.data && first.problems.length === 0) return { data: first.data, usage, issues: [], attempts: 1 };

  const repair: ResponseInputItem[] = [
    { role: "assistant", content: firstText || "(empty reply)" },
    {
      role: "user",
      content: `That JSON has these problems:\n${first.problems.map((p) => `- ${p}`).join("\n")}\nReturn the whole corrected JSON. Keep everything that was right.`,
    },
  ];
  const second = evaluate(await call(repair));
  if (second.data) return { data: second.data, usage, issues: second.problems, attempts: 2 };
  // The retry broke the schema but the first reply only failed the extra checks: keep the first.
  if (first.data) return { data: first.data, usage, issues: first.problems, attempts: 2 };
  throw new StructuredOutputError(`${opts.schemaName}: no valid reply after a retry. ${second.problems.slice(0, 5).join("; ")}`, usage);
}

/** Thrown when both attempts fail. Carries the usage so the caller can still record what was spent. */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly usage: ModelUsage[],
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}
