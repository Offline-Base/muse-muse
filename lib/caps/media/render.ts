import type { Brief } from "@/lib/brief/schema";
import { MEDIA_PART_LABEL, mediaBlock, mediaPartsOf, type MediaPart } from "@/lib/caps/media/brief";
import { MEDIA_LIMITS } from "@/lib/caps/media/limits";
import type { CapRenderEntry } from "@/lib/caps/render";

/**
 * The media cap's part of the prompts (docs/CAPABILITIES.md, 2.6 and section 14). Its text names the platform files in
 * template/caps/media: the skill, the helpers in lib/platform/, tests/caps/media.ts and public/notices/media.txt.
 */

const HELPERS: Record<MediaPart, string[]> = {
  speech: [
    `- Speech: \`speak(text)\` from \`lib/platform/speech.ts\` (browser only) reads up to ${MEDIA_LIMITS.speechCharsMax} characters aloud with an open model in the page, and falls back to the browser's own voice. It answers \`{ by: "model" | "browser" | "none", durationMs }\`. Call \`prepareSpeech()\` on the first tap so the model's one download (about 190 MB, kept by the browser) shows progress with \`onProgress\`. Show a Stop button (\`stopSpeech()\`), and say in one line when it fell back to the browser's voice. English only.`,
  ],
  video: [
    `- Video: \`imagesToVideo(frames, { fps })\` from \`lib/platform/video.ts\` (browser only) makes an MP4 from up to ${MEDIA_LIMITS.videoFramesMax} pictures (image URLs, data URLs, Blobs, canvases or bitmaps), at most ${MEDIA_LIMITS.videoSideMax} px on the long side. It answers \`{ blob, url, mimeType, durationMs, width, height, frames }\`. Show it in a \`<video controls playsInline>\` with a Save link (\`download="name.mp4"\`). No sound track.`,
  ],
  music: [
    "- Music: `toMidi(notes, { bpm })` from `lib/platform/midi.ts` writes a standard MIDI file (a `Uint8Array`, `midiBlob()` for a download), `playNotes(notes)` plays them with simple built-in tones and returns a `stop()`, and `notesFromAudio(samples, sampleRate)` turns a hummed or sung recording into notes. A note is `{ pitch, startBeat, beats, velocity? }` with `pitch` a MIDI number (60 is middle C); `noteName(pitch)` gives \"C4\".",
  ],
  samTiling: [
    `- Many objects in one photo: \`findAll(image, phrase, { tiles, segment })\` from \`lib/platform/sam-tiles.ts\` (browser) splits the photo into overlapping tiles, sends each to \`segment\`, and merges the boxes so an object on a seam counts once. A tile that comes back with ${MEDIA_LIMITS.samObjectsPerCall} objects is split again while tiles are left. It answers \`{ boxes, tiles, saturated, capped, costUsd }\`; when \`capped\` is true, say the count is "at least".`,
    "- `segment` posts one tile to the product's own action route, which calls `samBoxes(request, tile, phrase)` from `lib/platform/sam-boxes.ts` (server only, SAM 3.1 through `metaClient`) and returns its boxes. The meta-sam skill's rules hold: one short noun phrase, no lists.",
    `- Long clips: \`videoChunks(file)\` from \`lib/platform/sam-tiles.ts\` keeps ${MEDIA_LIMITS.samSampleFps} frames a second and cuts the clip into H.264 MP4 chunks of at most ${MEDIA_LIMITS.samChunkFramesMax} frames, ${MEDIA_LIMITS.samVideoFramesMax} frames in all. Each chunk goes to SAM on its own (upload it with \`uploadMedia\`), and \`chunk.startMs\` puts its frames back on the clip's timeline. A browser that can't make H.264 throws a \`MediaError\` saying so: show it as a limit and offer a shorter clip.`,
  ],
};

const LIMITS: Record<MediaPart, string> = {
  speech: "the voice is plain and English only, and the first use downloads the model",
  video: `videos have no sound and at most ${MEDIA_LIMITS.videoFramesMax} pictures`,
  music: "music plays with simple tones, not real instruments",
  samTiling: `one photo uses at most ${MEDIA_LIMITS.samTilesMax} SAM calls and one clip at most ${MEDIA_LIMITS.samVideoFramesMax} frames, so very crowded photos give "at least" counts`,
};

const SMOKE: Record<MediaPart, string> = {
  speech: "`expectSpeech(page, { click })`: clicks the button that reads aloud and checks audio was made (by the model, or the browser's voice when the model isn't reachable)",
  video: "`expectVideoPlays(page, { make, video })`: clicks the button that makes the video, then checks the `<video>` has a duration over 0 and plays, and saves the file for the platform's check",
  music: "`expectMidi(page, { click })`: clicks the button that saves the MIDI file and checks it starts with `MThd` and has notes, and saves it for the platform's check",
  samTiling: `\`expectTiles(page)\`: reads what the last \`findAll\` did (more than one tile, merged without duplicates). The smoke test may run at most ${MEDIA_LIMITS.samTilesSmoke} tiles in all (\`findAll\` holds itself to that in a build), so test one sample photo with \`{ tiles: ${MEDIA_LIMITS.samTilesSmoke} }\``,
};

export const MEDIA_RENDER: CapRenderEntry = {
  title: "Media in the browser",
  build(brief: Brief) {
    const media = mediaBlock(brief);
    const parts = mediaPartsOf(media);
    if (!media || !parts.length) return [];
    return [
      `The brief asks for ${parts.map((p) => MEDIA_PART_LABEL[p]).join(", ")}: ${media.why}`,
      "",
      `- Media parts: ${parts.join(", ")}`,
      "- Read `.agents/skills/muse-media/SKILL.md` first.",
      ...parts.flatMap((p) => HELPERS[p]),
      "- Each helper throws a `MediaError` with plain words. Show its message, never a raw error.",
      `- Privacy: ${parts.includes("samTiling") ? "only SAM's tiles leave the page, as the meta-sam skill says; " : ""}speech, video and music are made in the page and nothing is uploaded for them. Don't store what the user makes beyond the browser.`,
      `- Limits the user sees, each once: ${parts.map((p) => LIMITS[p]).join("; ")}.`,
      "- Large files (the speech model and its runtime) come from the Muse Muse gateway's `/assets`, checked by sha256 before use. Never load a model, wasm or script from another site, and don't copy those files into the product.",
      "- No stand-in: these run for real in the test browser. Keep test media small: a few frames, a few notes, one short sentence.",
      `- Smoke test, from \`tests/caps/media.ts\`: ${parts.map((p) => SMOKE[p]).join("; ")}. Take a judge screenshot of each result with a plain caption.`,
      "- `template/AGENTS.md` says the build machine reaches only npm, the Meta API and the Muse Muse gateway: the media files come from the gateway, so that holds.",
      "- `lib/platform/speech.ts`, `video.ts`, `mp4.ts`, `midi.ts`, `sam-tiles.ts`, `sam-boxes.ts`, `media-assets.ts`, `public/notices/media.txt`, `tests/caps/media.ts` and `scripts/caps/media.mjs` are platform files. Leave them as they are. Link \"Open source notices\" to `/notices/media.txt` from the page.",
    ];
  },
  refine(brief: Brief) {
    const parts = mediaPartsOf(mediaBlock(brief));
    if (!parts.length) return [];
    return [`- The product makes ${parts.map((p) => MEDIA_PART_LABEL[p]).join(", ")} with the media helpers (\`.agents/skills/muse-media/SKILL.md\`). Keep their checks in the smoke test passing.`];
  },
  markdown(brief: Brief) {
    const media = mediaBlock(brief);
    const parts = mediaPartsOf(media);
    if (!media || !parts.length) return [];
    return [`${media.why}`, "", ...parts.map((p) => `- ${MEDIA_PART_LABEL[p][0]!.toUpperCase()}${MEDIA_PART_LABEL[p].slice(1)}`)];
  },
};
