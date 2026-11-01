import type { CapCatalogEntry } from "@/lib/caps/catalog";
import { MEDIA_PARTS, type MediaPart } from "@/lib/caps/media/brief";
import { MEDIA_LIMITS } from "@/lib/caps/media/limits";
import { mediaPartsFromEnv } from "@/lib/caps/media/parts";

/**
 * The brief writer's catalog section for the media cap (docs/CAPABILITIES.md, section 14), naming only the parts whose
 * flags are on. It also replaces two of the catalog's "Not available on the Model API yet" workarounds while their part
 * is on (CAP_WORKAROUNDS in lib/caps/catalog.ts): speech in the browser, and video from pictures.
 */

const NAME: Record<MediaPart, string> = {
  speech: "speech",
  video: "video from pictures",
  music: "MIDI music",
  samTiling: "SAM counts past 16 objects",
};

const LINE: Record<MediaPart, string> = {
  speech: `  speech: an open speech model (SpeechT5, MIT license) reads up to ${MEDIA_LIMITS.speechCharsMax} characters aloud in the page, in English, with the browser's own voice as the fallback. It downloads about 190 MB once, then works offline. Plain voice, no voice choice, no conversation.`,
  video: `  video: up to ${MEDIA_LIMITS.videoFramesMax} pictures (from muse-image-1.0 or the user's photos) become a real MP4 video in the browser, which plays in the page and can be saved. No sound track, at most ${MEDIA_LIMITS.videoSideMax} px on the long side.`,
  music: "  music: a tune as notes, saved as a standard MIDI file and played in the page with simple built-in tones; a hummed or sung tune can be turned into notes. No recorded instruments or sung lyrics.",
  samTiling: `  samTiling: SAM 3.1 returns at most ${MEDIA_LIMITS.samObjectsPerCall} objects a call, so a photo is split into up to ${MEDIA_LIMITS.samTilesMax} overlapping tiles (one call each, about $0.04 for a photo) and the matches are merged, for counts of crowds, birds, cells or cars. A long clip is sampled at ${MEDIA_LIMITS.samSampleFps} frames a second and sent in chunks, at most ${MEDIA_LIMITS.samVideoFramesMax} frames a run (about $0.18). Counts are estimates.`,
};

/** The parts whose flags are on, in plan order (env.mediaParts reads the same). */
export function mediaPartsOn(): MediaPart[] {
  return mediaPartsFromEnv().filter((p): p is MediaPart => (MEDIA_PARTS as readonly string[]).includes(p));
}

export function mediaCatalog(parts: readonly MediaPart[]): CapCatalogEntry {
  const on = MEDIA_PARTS.filter((p) => parts.includes(p));
  const names = on.map((p) => NAME[p]);
  return {
    name: `media made in the browser (${names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`})`,
    block: [
      "- media (made in the browser, no extra cost unless SAM is used): helpers the product's page runs itself. Each part only when the product's main flow needs it:",
      ...on.map((p) => LINE[p]),
    ].join("\n"),
  };
}

/** Read when the catalog is built, so it names the parts on at the time. */
export const MEDIA_CATALOG: CapCatalogEntry = {
  get name() {
    return mediaCatalog(mediaPartsOn()).name;
  },
  get block() {
    return mediaCatalog(mediaPartsOn()).block;
  },
};

/** The catalog's workaround lines this cap replaces while its part is on, by the key lib/prompts/catalog.ts uses. */
export function mediaWorkarounds(parts: readonly MediaPart[]): Partial<Record<"speech" | "video", string>> {
  return {
    ...(parts.includes("speech") ? { speech: "- Text-to-speech: the media service's open speech model in the page (English), with the browser's built-in speech as its fallback." } : {}),
    ...(parts.includes("video") ? { video: "- Video generation: frames from muse-image-1.0 made into a real MP4 video in the browser by the media service. The frames are pictures, so motion is a slideshow or a flipbook." } : {}),
  };
}
