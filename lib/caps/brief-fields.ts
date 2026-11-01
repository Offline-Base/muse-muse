import type { z } from "zod";
import { DataBriefBlock, dataWriterBlock, dataWriterRules } from "@/lib/caps/data/brief";
import type { CapId } from "@/lib/caps/ids";
import { RUNTIME_WRITER_RULES, RuntimeBriefBlock } from "@/lib/caps/runtime/brief";

/**
 * Each cap's brief block (docs/CAPABILITIES.md, 2.6), keyed by its cap id, which is also its key in the brief. One line
 * per cap, in plan order. A unit defines its block in lib/caps/<id>/brief.ts and adds it here:
 *
 *   data: DataBriefBlock,
 *
 * lib/brief/schema.ts reads this once: the stored BriefSchema takes every field as optional and nullable, and the
 * writer's schema (newBriefSchemaFor) requires the enabled caps' fields as nullable.
 */
export const CAP_BRIEF_FIELDS = {
  data: DataBriefBlock,
  runtime: RuntimeBriefBlock,
} as const satisfies Partial<Record<CapId, z.ZodTypeAny>>;

export type CapBriefKey = keyof typeof CAP_BRIEF_FIELDS;

/** The caps a brief has a block for, in plan order. A brief with none gives []. */
export function briefCaps(brief: object): CapId[] {
  const record = brief as Record<string, unknown>;
  return (Object.keys(CAP_BRIEF_FIELDS) as CapId[]).filter((id) => record[id] !== null && record[id] !== undefined);
}

/**
 * The brief writer's rules for each cap, from lib/caps/<id>/brief.ts: plain bullet lines saying when to fill its block
 * and how. One line per cap, in plan order.
 */
export const CAP_WRITER_RULES: Partial<Record<CapId, readonly string[]>> = {
  // Unit 3: read per call, since they follow DATA_SIGN_IN.
  get data() {
    return dataWriterRules();
  },
  runtime: RUNTIME_WRITER_RULES,
};

/**
 * A cap whose writer's block differs from its stored one while some setting is off (newBriefSchemaFor reads this
 * first). Read per call. The stored BriefSchema always takes CAP_BRIEF_FIELDS.
 */
export const CAP_WRITER_BRIEF_FIELDS: Partial<Record<CapId, z.ZodTypeAny>> = {
  // Unit 3: DATA_SIGN_IN off means no user collections and no sign-in.
  get data() {
    return dataWriterBlock();
  },
};

/** The writer's rules for the enabled caps, as a section for its instructions. Empty when none has rules. */
export function capsWriterRules(enabled: readonly CapId[]): string {
  const lines = enabled.flatMap((id) => CAP_WRITER_RULES[id] ?? []);
  if (!lines.length) return "";
  return `\n\nPlatform services\n${lines.map((l) => (l.startsWith("- ") ? l : `- ${l}`)).join("\n")}`;
}
