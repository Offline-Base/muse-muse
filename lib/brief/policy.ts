import { z } from "zod";
import { textPart } from "@/lib/brief/media";
import { cleanStrings } from "@/lib/brief/normalize";
import { respondStructured } from "@/lib/brief/structured";
import { env } from "@/lib/env";
import { changeCheckInstructions, changeCheckText } from "@/lib/prompts/brief";
import type { ModelUsage, Reference } from "@/lib/types";

/**
 * The refinement gate. A change request never passes through the brief writer, so before a refinement resumes Muse
 * Code, Muse Spark 1.3 checks the message and the new files' names against the same refusal policy. Throws a
 * StructuredOutputError (with its usage) when no valid reply comes back, so the change is never let through unchecked.
 */

/** Field order puts the reasoning before the decision. */
const ChangeCheckSchema = z.object({
  reason: z.string().min(1),
  refuse: z.boolean(),
  refusal: z.string().nullable(),
});

export const DEFAULT_CHANGE_REFUSAL = "Muse Muse can't make this change.";

/** The message for the person: null when the change is allowed, else the refusal (with a fallback when it's blank). */
export function changeRefusal(data: z.infer<typeof ChangeCheckSchema>): string | null {
  if (!data.refuse) return null;
  return data.refusal?.trim() || DEFAULT_CHANGE_REFUSAL;
}

export async function checkChange(input: {
  message: string;
  references: Pick<Reference, "kind" | "fileName">[];
}): Promise<{ refusal: string | null; usage: ModelUsage[] }> {
  const result = await respondStructured({
    model: env.briefModel,
    instructions: changeCheckInstructions(),
    content: [textPart(changeCheckText(input.message, input.references))],
    schema: ChangeCheckSchema,
    schemaName: "change_check",
    effort: "low",
    normalize: (raw) => cleanStrings(raw),
  });
  return { refusal: changeRefusal(result.data), usage: result.usage };
}
