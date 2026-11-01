import { z } from "zod";

/**
 * The media cap's brief block (docs/CAPABILITIES.md, section 14): media made in the product's page, in the browser, with
 * no model call of its own. Four parts, each behind its own flag (MEDIA_SPEECH, MEDIA_VIDEO, MEDIA_MUSIC,
 * MEDIA_SAM_TILING) on top of MEDIA_ENABLED:
 *   speech     speak(text): an open-weights speech model (SpeechT5, MIT) in the page, else the browser's own voice
 *   video      imagesToVideo(frames): a real MP4 video from a sequence of pictures, made with WebCodecs
 *   music      toMidi(notes) and playNotes(notes), and notesFromAudio for a hummed tune
 *   samTiling  findAll(image, phrase): SAM 3.1 on overlapping tiles, so a photo can hold more than 16 matches, and
 *              videoChunks(file) for clips longer than SAM takes
 * The contract named only the four switches. `why` was added (as the other caps have one) so the build prompt can say
 * what the media is for.
 */

export const MEDIA_PARTS = ["speech", "video", "music", "samTiling"] as const;
export type MediaPart = (typeof MEDIA_PARTS)[number];

export const MediaBriefBlock = z.object({
  /** What the product makes with media, in one plain sentence. */
  why: z.string().min(1).max(200),
  speech: z.boolean(),
  video: z.boolean(),
  music: z.boolean(),
  samTiling: z.boolean(),
});

export type MediaBrief = z.infer<typeof MediaBriefBlock>;

/** What each part is called in the build prompt, the catalog and the product's page. */
export const MEDIA_PART_LABEL: Record<MediaPart, string> = {
  speech: "speech read aloud in the browser",
  video: "videos made from pictures",
  music: "music as MIDI",
  samTiling: "counting past 16 objects with SAM",
};

/** The media block of a brief, or null. */
export function mediaBlock(brief: object): MediaBrief | null {
  return ((brief as { media?: MediaBrief | null }).media ?? null) as MediaBrief | null;
}

/** The parts a block turns on, in MEDIA_PARTS order. */
export function mediaPartsOf(block: MediaBrief | null | undefined): MediaPart[] {
  return block ? MEDIA_PARTS.filter((p) => block[p] === true) : [];
}

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "").trim() || s.slice(0, max));

function bool(v: unknown): unknown {
  if (v === "true" || v === "yes") return true;
  if (v === "false" || v === "no" || v === null || v === undefined) return false;
  return v;
}

/**
 * The writer's raw media block, cleaned before zod (normalizeRawBrief): string booleans as booleans, a missing part as
 * false, `why` clipped, and every part whose flag is off set to false, so a brief never asks for a part this platform
 * doesn't offer. A block with no part left isn't a media block, so it becomes null.
 */
export function normalizeMediaBlock(raw: unknown, partsOn: readonly MediaPart[]): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const b = { ...(raw as Record<string, unknown>) };
  for (const p of MEDIA_PARTS) {
    b[p] = bool(b[p]);
    if (!partsOn.includes(p)) b[p] = false;
  }
  if (typeof b.why === "string") b.why = clip(b.why.trim(), 200);
  if (MEDIA_PARTS.every((p) => b[p] === false)) return null;
  return b;
}

const RULE: Record<MediaPart, string> = {
  speech:
    "media.speech: true when the product reads text aloud (a story read to a child, directions spoken while cooking). The voice is an open model that runs in the page, in English only, and sounds plain; the browser's own voice is the fallback. Never for a voice conversation.",
  video:
    "media.video: true when the product turns pictures into a short video the user can play and save (a slideshow, a flipbook, a time-lapse from Muse Image frames). No sound track, at most 120 frames, made in the browser.",
  music:
    "media.music: true when the product writes or plays a tune: a melody as notes saved as a MIDI file and played with simple built-in tones, or a hummed or sung tune turned into notes. Not recorded songs, lyrics sung by a voice, or mixing audio.",
  samTiling:
    "media.samTiling: true when the product counts or finds many small things in one photo (a crowd, birds on a wire, cells, parked cars) or tracks objects through a clip over about 20 seconds. SAM finds at most 16 objects per call, so the photo is split into overlapping tiles, each tile is one SAM call, and the results are merged. Pick sam-3.1 in models too.",
};

/**
 * The writer's rules for the block (lib/caps/brief-fields.ts, CAP_WRITER_RULES), naming only the parts that are on. A
 * part that is off isn't offered.
 */
export function mediaWriterRules(partsOn: readonly MediaPart[]): readonly string[] {
  const on = MEDIA_PARTS.filter((p) => partsOn.includes(p));
  if (!on.length) return [];
  return [
    `media: fill it only when the product makes speech, video, music or many-object counts in the page, with the helpers below. Otherwise null. Set each part true only when the product's main flow needs it, and every other part false.${on.length < MEDIA_PARTS.length ? ` Only ${on.map((p) => `media.${p}`).join(", ")} can be true here; leave the others false.` : ""}`,
    "media.why: what the product makes with media, in one plain sentence, like \"Turns the four comic panels into a short video to share\".",
    ...on.map((p) => RULE[p]),
  ];
}
