import { DOCS_MODELS } from "@/lib/docs/client/models";

/**
 * The docs' cost guard for Muse Wonder. Every paid Muse Wonder request this group's demos send carries an output cap
 * of 800 tokens, so a run stays around a cent ($20 per 1M output tokens, reasoning included) instead of the proxy's
 * 4,096-token limit, about 8 cents. The cap is part of the request, so the code views show it too.
 */

export const WONDER_MODEL = "muse-wonder-1.0";

/** Output tokens a Muse Wonder demo may use, reasoning included. */
export const WONDER_OUTPUT_CAP = 800;

/** Each endpoint's name for the output limit: Responses, Chat Completions, Messages. */
export type OutputLimitField = "max_output_tokens" | "max_completion_tokens" | "max_tokens";

/** The body with Muse Wonder's cap under the endpoint's own field. Other models, and a body that sets a limit, pass through. */
export function capWonder<T extends Record<string, unknown>>(body: T, field: OutputLimitField = "max_output_tokens"): T {
  if (body.model !== WONDER_MODEL || body[field] !== undefined) return body;
  return { ...body, [field]: WONDER_OUTPUT_CAP };
}

/** The cost line a demo shows next to Run while Muse Wonder is picked. */
export const WONDER_COST_NOTE = `Muse Wonder is capped at ${WONDER_OUTPUT_CAP} output tokens here, about a cent a run.`;

/** The text models other than Muse Wonder, in the kit's menu order: for demos whose code can't carry the cap. */
export const SPARK_TEXT_MODELS: readonly string[] = DOCS_MODELS.text.map((m) => m.id).filter((id) => id !== WONDER_MODEL);
