import { z } from "zod";
import { dataBlock } from "@/lib/caps/data/brief";
import { liveUpdatesOn } from "@/lib/caps/live/parts";
import { COLLECTION_NAME } from "@/lib/caps/data/types";

/**
 * The live cap's brief block (docs/CAPABILITIES.md, section 13):
 *   captions  near-live captions from the visitor's microphone, sent in pieces of 2 to 3 seconds
 *   updates   a collection of the data block whose changes show in every open browser with no reload
 * Two-way realtime voice isn't here: it waits for Meta.
 */
export const LiveBriefBlock = z.object({
  captions: z.boolean(),
  updates: z.object({ collection: z.string().min(1).max(32) }).nullable(),
});

export type LiveBrief = z.infer<typeof LiveBriefBlock>;

/** What captions call: the token needs it, so allowedModelsFor adds it whatever capabilities says. */
export const LIVE_CAPTION_MODEL = "muse-voice-transcribe-1.0";

const listed = (brief: object | null | undefined, collection: string) => (dataBlock(brief)?.collections ?? []).some((c) => c.name === collection);

/**
 * The brief's live block as this platform can serve it, or null. Updates read saved rows, so they go when LIVE_UPDATES
 * is off, or when the brief's data block doesn't list the collection, which is also how a dropped data cap takes them
 * away. Every step reads this, so the prompt, the judge and the checks never ask for a stream that answers 404. A block
 * left with nothing is null, and capsForBuild drops the cap.
 */
export function liveBlock(brief: object | null | undefined, updatesOn: boolean = liveUpdatesOn()): LiveBrief | null {
  const parsed = LiveBriefBlock.safeParse((brief as { live?: unknown } | null | undefined)?.live);
  if (!parsed.success) return null;
  const updates = parsed.data.updates && updatesOn && listed(brief, parsed.data.updates.collection) ? parsed.data.updates : null;
  return parsed.data.captions || updates ? { captions: parsed.data.captions, updates } : null;
}

/** The collection's scope in the brief's data block, for the build prompt. */
export function liveCollectionScope(brief: object, collection: string): string {
  return dataBlock(brief)?.collections.find((c) => c.name === collection)?.scope ?? "shared";
}

/**
 * The writer's raw live block, cleaned before zod (normalizeRawBrief), given the data block already cleaned: string
 * booleans as booleans, `updates` kept only for a collection that block lists and only while LIVE_UPDATES is on. A block
 * that asks for nothing isn't a live block, so it becomes null. Anything else is left for zod to report.
 */
export function normalizeLiveBlock(raw: unknown, data: unknown, updatesOn: boolean = liveUpdatesOn()): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const b = { ...(raw as Record<string, unknown>) };
  if (typeof b.captions === "string") b.captions = ["true", "yes", "1"].includes(b.captions.trim().toLowerCase());
  if (b.captions === null || b.captions === undefined) b.captions = false;
  const updates = b.updates;
  const name = typeof updates === "string" ? updates.trim() : updates && typeof updates === "object" ? (updates as { collection?: unknown }).collection : null;
  b.updates = updatesOn && typeof name === "string" && COLLECTION_NAME.test(name) && listed({ data }, name) ? { collection: name } : null;
  if (b.captions === false && b.updates === null) return null;
  return b;
}

/** The writer's rules for the block (lib/caps/brief-fields.ts, CAP_WRITER_RULES), naming updates only while they're on. */
export function liveWriterRules(updatesOn: boolean = liveUpdatesOn()): readonly string[] {
  return [
    "live: fill it only when text appearing as someone speaks, or changes showing at once in other people's open browsers, is the product's main work. Otherwise null.",
    "live.captions: true when the product shows what is being said while it is said (lecture captions, a meeting's running notes). The text appears a few seconds behind, in English or the speaker's language, with no speaker names. Never for a voice conversation: nothing talks back. Pick muse-voice-transcribe-1.0 in capabilities too. Say in limits that text runs a few seconds behind, that audio goes to Muse Voice Transcribe, and that each person gets a limited number of minutes a day.",
    updatesOn
      ? "live.updates: {collection} when other people's open browsers must show a change with no reload (a shared scoreboard, a live poll, a queue). The collection must be listed in the data block, usually shared with writes anyone or signed_in. Otherwise null. A change shows within a few seconds, for at most 20 people watching one product at once: say so in limits."
      : "live.updates: always null. Live shared updates aren't available.",
    "Two-way voice isn't available: no spoken replies, no calls.",
  ];
}
