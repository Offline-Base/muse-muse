/**
 * The media cap's parts and their switches (docs/CAPABILITIES.md, section 14), read the way lib/env.ts's flag() reads a
 * switch. A plain file with no imports, like lib/caps/ids.ts, so lib/env.ts and the cap registries can both read it
 * without an import cycle (lib/env.ts imports lib/brief/schema.ts, which reads the registries at load).
 */
// No speech part: it read text aloud with SpeechT5, which isn't a Meta model, and the organizers ruled on Nov 2 that every
// model a project calls must be Meta's. MEDIA_SPEECH turns nothing on. The browser's own voice stays the catalog's line.
export const MEDIA_PART_FLAGS = [
  ["video", "MEDIA_VIDEO"],
  ["music", "MEDIA_MUSIC"],
  ["samTiling", "MEDIA_SAM_TILING"],
] as const;

export type MediaPartId = (typeof MEDIA_PART_FLAGS)[number][0];

/** The parts whose switches are on, in plan order. */
export function mediaPartsFromEnv(source: Record<string, string | undefined> = process.env): MediaPartId[] {
  const on = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
  return MEDIA_PART_FLAGS.filter(([, name]) => on(source[name])).map(([part]) => part);
}
