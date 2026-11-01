import { PRICES } from "@/lib/meta/pricing";

/**
 * The media cap's limits (docs/CAPABILITIES.md, section 14). The template's platform files carry the same numbers
 * (template/caps/media/files/lib/platform/*.ts), and lib/caps/media/__tests__/media.test.ts keeps the two in step.
 *
 * SAM is billed per photo and per video frame, with a 50-frame minimum per clip, out of the product's own daily budget
 * (at least $3, lib/gateway/policy.ts). So tiles and chunks are capped per run, and the product shows the cap as a limit:
 *   a photo: at most 16 tiles, about $0.04
 *   a clip:  at most 900 frames sent in all, about $0.18, in chunks of at most 300 frames
 */
export const MEDIA_LIMITS = {
  /** Pictures in one video. */
  videoFramesMax: 120,
  /** The longest side of a made video, in pixels. */
  videoSideMax: 1280,
  /** Characters read aloud in one speak() call. */
  speechCharsMax: 600,
  /** Notes in one tune. */
  notesMax: 2000,
  /** SAM calls (tiles) for one photo. */
  samTilesMax: 16,
  /** SAM calls (tiles) the smoke test may make in all. */
  samTilesSmoke: 4,
  /** The most objects SAM returns for one call: a tile with this many is split again when the tile budget allows. */
  samObjectsPerCall: 16,
  /** Video frames sent to SAM in one run, over every chunk. */
  samVideoFramesMax: 900,
  /** Frames in one chunk. */
  samChunkFramesMax: 300,
  /** Frames a second kept from a long clip before it is chunked. */
  samSampleFps: 5,
} as const;

const SAM = PRICES["sam-3.1"];

/** What one photo split into this many tiles costs at SAM's price. */
export function samPhotoCostUsd(tiles: number): number {
  return Math.max(0, tiles) * SAM.perImage;
}

/** What these chunks cost at SAM's price: each clip is billed for at least 50 frames. */
export function samVideoCostUsd(chunkFrames: readonly number[]): number {
  return chunkFrames.reduce((sum, f) => sum + Math.max(SAM.minVideoFrames, f) * SAM.perVideoFrame, 0);
}
