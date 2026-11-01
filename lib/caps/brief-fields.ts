import type { z } from "zod";
import { DataBriefBlock, dataWriterBlock, dataWriterRules } from "@/lib/caps/data/brief";
import type { CapId } from "@/lib/caps/ids";
import { EXTENSION_WRITER_RULES, ExtensionBriefBlock } from "@/lib/caps/extension/brief";
import { GAMES_WRITER_RULES, GamesBriefBlock } from "@/lib/caps/games/brief";
import { MediaBriefBlock, mediaWriterRules } from "@/lib/caps/media/brief";
import { mediaPartsOn } from "@/lib/caps/media/catalog";
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
  media: MediaBriefBlock,
  runtime: RuntimeBriefBlock,
  extension: ExtensionBriefBlock,
  games: GamesBriefBlock,
} as const satisfies Partial<Record<CapId, z.ZodTypeAny>>;

export type CapBriefKey = keyof typeof CAP_BRIEF_FIELDS;

/** The caps a brief has a block for, in plan order. A brief with none gives []. */
export function briefCaps(brief: object): CapId[] {
  const record = brief as Record<string, unknown>;
  return (Object.keys(CAP_BRIEF_FIELDS) as CapId[]).filter((id) => record[id] !== null && record[id] !== undefined);
}

/**
 * The brief writer's rules for each cap, from lib/caps/<id>/brief.ts: plain bullet lines saying when to fill its block
 * and how, or a function giving them when they follow a setting (read per call). One line per cap, in plan order.
 */
export const CAP_WRITER_RULES: Partial<Record<CapId, readonly string[] | (() => readonly string[])>> = {
  // Unit 3: they follow DATA_SIGN_IN.
  data: () => dataWriterRules(),
  // Unit 8: the media cap names only the parts whose flags are on, read when the instructions are built.
  media: () => mediaWriterRules(mediaPartsOn()),
  runtime: RUNTIME_WRITER_RULES,
  extension: EXTENSION_WRITER_RULES,
  games: GAMES_WRITER_RULES,
};

/** The writer's rules for the enabled caps, as a section for its instructions. Empty when none has rules. */
export function capsWriterRules(enabled: readonly CapId[]): string {
  const lines = enabled.flatMap((id) => {
    const rules = CAP_WRITER_RULES[id];
    return (typeof rules === "function" ? rules() : rules) ?? [];
  });
  if (!lines.length) return "";
  return `\n\nPlatform services\n${lines.map((l) => (l.startsWith("- ") ? l : `- ${l}`)).join("\n")}`;
}

/**
 * A cap whose writer's block differs from its stored one while some setting is off: `writer()` replaces `stored`
 * (read per call) only while CAP_BRIEF_FIELDS still holds that same `stored` block. The stored BriefSchema always takes
 * CAP_BRIEF_FIELDS.
 */
const CAP_WRITER_BRIEF_FIELDS: Partial<Record<CapId, { stored: z.ZodTypeAny; writer: () => z.ZodTypeAny }>> = {
  // Unit 3: with DATA_SIGN_IN off, no user collections and no sign-in.
  data: { stored: DataBriefBlock, writer: () => dataWriterBlock() },
};

/** The block the brief writer answers in for a cap (newBriefSchemaFor), or undefined when it has none. */
export function writerBriefField(cap: CapId): z.ZodTypeAny | undefined {
  const stored = (CAP_BRIEF_FIELDS as Partial<Record<CapId, z.ZodTypeAny>>)[cap];
  const variant = CAP_WRITER_BRIEF_FIELDS[cap];
  return variant && stored === variant.stored ? variant.writer() : stored;
}
