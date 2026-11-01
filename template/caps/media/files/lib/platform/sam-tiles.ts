// Platform file (Muse Muse platform services). Don't edit: products call findAll and videoChunks.
//
// SAM 3.1 returns at most 16 objects a call and takes clips up to 15,000 frames, billed per photo and per frame. So:
//   findAll(image, phrase, { segment })  splits a photo into overlapping tiles, sends each tile to `segment` (the
//     product's own route, which calls samBoxes from lib/platform/sam-boxes.ts), splits a tile again when it comes back
//     full, and merges the boxes so an object on a seam counts once. At most SAM_TILES_MAX calls a photo.
//   videoChunks(file)  keeps SAM_SAMPLE_FPS frames a second of a long clip and cuts it into H.264 MP4 chunks of at
//     most SAM_CHUNK_FRAMES frames, SAM_VIDEO_FRAMES_MAX frames in all, each with its place on the clip's timeline.
// Tile math and merging are plain functions, so they run in Node for tests. findAll and videoChunks run in the browser.
import { MediaError } from "./media-assets";
import { imagesToVideo } from "./video";

export const SAM_OBJECTS_PER_CALL = 16;
export const SAM_TILES_MAX = 16;
export const SAM_TILES_SMOKE = 4;
export const SAM_VIDEO_FRAMES_MAX = 900;
export const SAM_CHUNK_FRAMES = 300;
export const SAM_SAMPLE_FPS = 5;
/** SAM's price: $2.50 per 1,000 photos, $0.20 per 1,000 video frames with at least 50 frames billed a clip. */
export const SAM_PRICE = { perImage: 0.0025, perVideoFrame: 0.0002, minVideoFrames: 50 } as const;

/** A box in pixels: left and top inclusive, right and bottom exclusive. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  confidence?: number;
}

export interface Tile {
  left: number;
  top: number;
  width: number;
  height: number;
  /** How many times this area was split: 0 for the first grid. */
  depth: number;
}

export interface MergedBox extends Box {
  /** How many tiles saw this object. */
  seenIn: number;
}

const area = (b: Box) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);

function intersection(a: Box, b: Box): number {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

/** Intersection over union. */
export function iou(a: Box, b: Box): number {
  const i = intersection(a, b);
  const u = area(a) + area(b) - i;
  return u > 0 ? i / u : 0;
}

/** The grid for about `tiles` tiles over the image, cells close to square, each grown by `overlap` of its size. */
export function tileGrid(width: number, height: number, opts: { tiles?: number; overlap?: number } = {}): Tile[] {
  if (!(width > 0 && height > 0)) throw new MediaError("invalid", "The photo has no size.");
  const want = Math.min(SAM_TILES_MAX, Math.max(1, Math.floor(opts.tiles ?? 4)));
  const overlap = Math.min(0.4, Math.max(0, opts.overlap ?? 0.15));
  // The columns and rows with cells nearest to square, using as many of the `want` tiles as fit (each one left unused
  // costs as much as cells twice as long as they are wide, about).
  let best: [number, number] = [1, 1];
  let bestScore = Infinity;
  for (let cols = 1; cols <= want; cols++) {
    const rows = Math.floor(want / cols);
    if (!rows) continue;
    const ratio = width / cols / (height / rows);
    const score = Math.abs(Math.log(ratio)) + 0.5 * (want - cols * rows);
    if (score < bestScore) {
      bestScore = score;
      best = [cols, rows];
    }
  }
  const [cols, rows] = best;
  return splitArea({ left: 0, top: 0, width, height, depth: -1 }, cols, rows, overlap, width, height);
}

function splitArea(area_: Tile, cols: number, rows: number, overlap: number, imageW: number, imageH: number): Tile[] {
  const cw = area_.width / cols;
  const ch = area_.height / rows;
  const padX = cols > 1 ? cw * overlap : 0;
  const padY = rows > 1 ? ch * overlap : 0;
  const out: Tile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const left = Math.max(0, Math.floor(area_.left + c * cw - padX));
      const top = Math.max(0, Math.floor(area_.top + r * ch - padY));
      const right = Math.min(imageW, Math.ceil(area_.left + (c + 1) * cw + padX));
      const bottom = Math.min(imageH, Math.ceil(area_.top + (r + 1) * ch + padY));
      out.push({ left, top, width: right - left, height: bottom - top, depth: area_.depth + 1 });
    }
  }
  return out;
}

/** A full tile split into four overlapping quarters. */
export function splitTile(tile: Tile, imageW: number, imageH: number, overlap = 0.15): Tile[] {
  return splitArea(tile, 2, 2, overlap, imageW, imageH);
}

/** A box from a tile's own pixels (a crop resized by `scale`) moved onto the whole image. */
export function toImageBox(tile: Tile, box: Box, scale = 1): Box {
  return {
    left: tile.left + box.left / scale,
    top: tile.top + box.top / scale,
    right: tile.left + box.right / scale,
    bottom: tile.top + box.bottom / scale,
    ...(box.confidence !== undefined ? { confidence: box.confidence } : {}),
  };
}

export interface TileResult {
  tile: Tile;
  /** Boxes in the tile's own pixels (the crop as sent, before `scale`). */
  boxes: Box[];
  /** The crop's pixels per image pixel, when the tile was resized before sending. 1 by default. */
  scale?: number;
}

/**
 * Every tile's boxes on the whole image, with an object seen in several overlapping tiles counted once. Two boxes are
 * one object when they overlap by `iou` (0.5) or more, or when one is cut by its tile's edge and mostly lies inside the
 * other, or when both are cut at the seam between their tiles and line up across it. The merged box covers both; the
 * higher confidence is kept.
 */
export function mergeTileBoxes(results: readonly TileResult[], opts: { iou?: number; inside?: number; imageWidth?: number; imageHeight?: number } = {}): MergedBox[] {
  const minIou = opts.iou ?? 0.5;
  const inside = opts.inside ?? 0.6;
  /** Which sides of a box its tile cut: l, t, r, b. */
  type Item = Box & { cut: Set<"l" | "t" | "r" | "b">; tile: number };
  const items: Item[] = results.flatMap((r, t) => r.boxes.filter((b) => area(b) > 0).map((b) => ({ ...toImageBox(r.tile, b, r.scale ?? 1), cut: new Set<"l" | "t" | "r" | "b">(), tile: t })));
  // An object can't be cut at the image's own border: only a tile edge inside the image counts.
  const W = opts.imageWidth ?? Math.max(0, ...results.map((r) => r.tile.left + r.tile.width));
  const H = opts.imageHeight ?? Math.max(0, ...results.map((r) => r.tile.top + r.tile.height));
  const e = 2;
  for (const it of items) {
    const t = results[it.tile]!.tile;
    if (t.left > 0 && it.left - t.left <= e) it.cut.add("l");
    if (t.top > 0 && it.top - t.top <= e) it.cut.add("t");
    if (t.left + t.width < W && t.left + t.width - it.right <= e) it.cut.add("r");
    if (t.top + t.height < H && t.top + t.height - it.bottom <= e) it.cut.add("b");
  }
  const along = (a: Item, b: Item, axis: "x" | "y") =>
    axis === "y"
      ? (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) / Math.min(a.bottom - a.top, b.bottom - b.top)
      : (Math.min(a.right, b.right) - Math.max(a.left, b.left)) / Math.min(a.right - a.left, b.right - b.left);
  /**
   * Two pieces of one object bigger than the overlap: the left one cut on its right by its tile, the right one cut on
   * its left, meeting or overlapping across the seam and lined up along it (and the same for top and bottom).
   */
  const halves = (a: Item, b: Item) => {
    const [l, r] = a.left <= b.left ? [a, b] : [b, a];
    if (l.cut.has("r") && r.cut.has("l") && r.left - l.right <= 3 && l.right < r.right && along(a, b, "y") >= 0.7) return true;
    const [t, u] = a.top <= b.top ? [a, b] : [b, a];
    return t.cut.has("b") && u.cut.has("t") && u.top - t.bottom <= 3 && t.bottom < u.bottom && along(a, b, "x") >= 0.7;
  };
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const same = (a: Item, b: Item) => {
    if (a.tile === b.tile) return false;
    if (iou(a, b) >= minIou) return true;
    if (halves(a, b)) return true;
    // A piece cut by its tile that lies mostly inside a box another tile saw whole.
    const i = intersection(a, b);
    const smaller = area(a) <= area(b) ? a : b;
    return i > 0 && smaller.cut.size > 0 && i / area(smaller) >= inside;
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (same(items[i]!, items[j]!)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Item[]>();
  items.forEach((it, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), it]));
  const merged: MergedBox[] = [...groups.values()].map((g) => {
    const conf = g.map((x) => x.confidence).filter((c): c is number => c !== undefined);
    return {
      left: Math.min(...g.map((x) => x.left)),
      top: Math.min(...g.map((x) => x.top)),
      right: Math.max(...g.map((x) => x.right)),
      bottom: Math.max(...g.map((x) => x.bottom)),
      ...(conf.length ? { confidence: Math.max(...conf) } : {}),
      seenIn: new Set(g.map((x) => x.tile)).size,
    };
  });
  return merged.sort((a, b) => a.top - b.top || a.left - b.left);
}

/** What one photo costs at SAM's price. */
export function samPhotoCostUsd(tiles: number): number {
  return Math.max(0, tiles) * SAM_PRICE.perImage;
}

/** What these chunks cost: each clip is billed for at least 50 frames. */
export function samVideoCostUsd(chunkFrames: readonly number[]): number {
  return chunkFrames.reduce((sum, f) => sum + Math.max(SAM_PRICE.minVideoFrames, f) * SAM_PRICE.perVideoFrame, 0);
}

export type ImageInput = string | Blob | HTMLImageElement | HTMLCanvasElement | ImageBitmap;

export interface FindAllOptions {
  /**
   * Sends one tile to SAM and returns its boxes in the tile's pixels, through the product's own route. `tile` is a JPEG
   * data URL of the crop, at most 1024 px on its long side.
   */
  segment: (tile: string, phrase: string, info: { index: number; width: number; height: number }) => Promise<Box[]>;
  /** Tiles in the first grid, 4 by default. More are made only for tiles that come back full. */
  tiles?: number;
  /** The most SAM calls for this photo, SAM_TILES_MAX at most. */
  maxTiles?: number;
  overlap?: number;
  /** Called after each tile, for a progress line. */
  onTile?: (done: number, planned: number) => void;
}

export interface FindAllResult {
  boxes: MergedBox[];
  /** SAM calls made. */
  tiles: number;
  /** Boxes before merging, over every tile. */
  rawBoxes: number;
  /** Tiles that came back with SAM_OBJECTS_PER_CALL objects. */
  saturated: number;
  /** True when some full tile couldn't be split again within maxTiles, so the count is "at least". */
  capped: boolean;
  costUsd: number;
  width: number;
  height: number;
}

type MediaRecord = { tiles?: { tiles: number; rawBoxes: number; boxes: number; saturated: number; capped: boolean; at: number } };

function record(entry: NonNullable<MediaRecord["tiles"]>) {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __musemuseMedia?: MediaRecord };
  w.__musemuseMedia = { ...(w.__musemuseMedia ?? {}), tiles: entry };
}

async function loadImage(src: ImageInput): Promise<ImageBitmap | HTMLImageElement | HTMLCanvasElement> {
  if (typeof src === "string") {
    const res = await fetch(src).catch(() => null);
    if (!res?.ok) throw new MediaError("invalid", "The photo couldn't be loaded.");
    return createImageBitmap(await res.blob());
  }
  if (src instanceof Blob) return createImageBitmap(src);
  return src;
}

const TILE_SIDE_MAX = 1024;

/** True in a build's own test runs (NEXT_PUBLIC_MUSEMUSE_MEDIA_SMOKE in its .env.local), never on the live product. */
export const SMOKE = process.env.NEXT_PUBLIC_MUSEMUSE_MEDIA_SMOKE === "1";
let smokeTilesUsed = 0;

/**
 * Splits work so a tile that comes back full of objects gets four smaller tiles in its place, until maxTiles calls
 * have been made. `run` is the tile-to-boxes step, so tests pass a fake SAM.
 */
export async function runTiles(width: number, height: number, run: (tile: Tile, index: number) => Promise<TileResult>, opts: { tiles?: number; maxTiles?: number; overlap?: number; onTile?: (done: number, planned: number) => void } = {}): Promise<Omit<FindAllResult, "costUsd" | "width" | "height">> {
  const maxTiles = Math.min(SAM_TILES_MAX, Math.max(1, Math.floor(opts.maxTiles ?? SAM_TILES_MAX)));
  const queue = tileGrid(width, height, { tiles: Math.min(maxTiles, opts.tiles ?? 4), overlap: opts.overlap });
  const done: TileResult[] = [];
  let calls = 0;
  let saturated = 0;
  let capped = false;
  while (queue.length) {
    const tile = queue.shift()!;
    if (calls >= maxTiles) {
      capped = true;
      break;
    }
    const res = await run(tile, calls++);
    opts.onTile?.(calls, Math.min(maxTiles, calls + queue.length));
    if (res.boxes.length >= SAM_OBJECTS_PER_CALL) {
      saturated++;
      // Room for four more calls after the ones already planned: split it, else keep what it found and say so.
      if (calls + queue.length + 4 <= maxTiles && tile.width >= 64 && tile.height >= 64) {
        queue.push(...splitTile(tile, width, height, opts.overlap));
        continue;
      }
      capped = true;
    }
    done.push(res);
  }
  const boxes = mergeTileBoxes(done, { imageWidth: width, imageHeight: height });
  return { boxes, tiles: calls, rawBoxes: done.reduce((n, r) => n + r.boxes.length, 0), saturated, capped };
}

/** Every match for `phrase` in a photo, past SAM's 16 a call. Browser only. */
export async function findAll(image: ImageInput, phrase: string, opts: FindAllOptions): Promise<FindAllResult> {
  if (!phrase.trim()) throw new MediaError("invalid", "Say what to look for.");
  // Under the platform's tests the page gets SAM_TILES_SMOKE calls in all, however often it runs findAll.
  const smokeLeft = SAM_TILES_SMOKE - smokeTilesUsed;
  if (SMOKE && smokeLeft <= 0) throw new MediaError("too_large", `The test run already used its ${SAM_TILES_SMOKE} photo pieces.`);
  const maxTiles = SMOKE ? Math.min(smokeLeft, opts.maxTiles ?? SAM_TILES_MAX) : opts.maxTiles;
  const img = await loadImage(image);
  const width = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
  const height = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const result = await runTiles(
    width,
    height,
    async (tile, index) => {
      const scale = Math.min(1, TILE_SIDE_MAX / Math.max(tile.width, tile.height));
      canvas.width = Math.max(1, Math.round(tile.width * scale));
      canvas.height = Math.max(1, Math.round(tile.height * scale));
      ctx.drawImage(img, tile.left, tile.top, tile.width, tile.height, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", 0.9);
      if (SMOKE) smokeTilesUsed++;
      const boxes = await opts.segment(url, phrase.trim(), { index, width: canvas.width, height: canvas.height });
      return { tile, boxes: Array.isArray(boxes) ? boxes : [], scale };
    },
    { ...opts, maxTiles },
  );
  const out = { ...result, costUsd: samPhotoCostUsd(result.tiles), width, height };
  record({ tiles: out.tiles, rawBoxes: out.rawBoxes, boxes: out.boxes.length, saturated: out.saturated, capped: out.capped, at: Date.now() });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Long clips

export interface ChunkPlan {
  index: number;
  startMs: number;
  endMs: number;
  frames: number;
}

/**
 * The chunks for a clip: SAM_SAMPLE_FPS frames a second (or the clip's own rate when lower), chunks of at most
 * `chunkFrames`, and no more than `maxFrames` in all; the rest of a longer clip is left out and `capped` says so.
 */
export function planVideoChunks(durationMs: number, opts: { sampleFps?: number; chunkFrames?: number; maxFrames?: number } = {}): { chunks: ChunkPlan[]; capped: boolean; costUsd: number; fps: number } {
  if (!(durationMs > 0)) throw new MediaError("invalid", "The clip has no length.");
  const fps = Math.min(30, Math.max(0.5, opts.sampleFps ?? SAM_SAMPLE_FPS));
  const per = Math.min(SAM_CHUNK_FRAMES, Math.max(SAM_PRICE.minVideoFrames, Math.floor(opts.chunkFrames ?? SAM_CHUNK_FRAMES)));
  const max = Math.min(SAM_VIDEO_FRAMES_MAX, Math.max(1, Math.floor(opts.maxFrames ?? SAM_VIDEO_FRAMES_MAX)));
  const total = Math.max(1, Math.floor((durationMs / 1000) * fps));
  const kept = Math.min(total, max);
  const chunks: ChunkPlan[] = [];
  for (let first = 0; first < kept; first += per) {
    const frames = Math.min(per, kept - first);
    chunks.push({ index: chunks.length, startMs: Math.round((first / fps) * 1000), endMs: Math.round(((first + frames) / fps) * 1000), frames });
  }
  return { chunks, capped: kept < total, costUsd: samVideoCostUsd(chunks.map((c) => c.frames)), fps };
}

export interface VideoChunk extends ChunkPlan {
  /** The chunk as an H.264 MP4, ready for uploadMedia. */
  blob: Blob;
}

/** A clip cut into SAM-sized MP4 chunks at a lower frame rate. Browser only; needs H.264 encoding. */
export async function videoChunks(file: Blob, opts: { sampleFps?: number; chunkFrames?: number; maxFrames?: number; maxSide?: number; onProgress?: (done: number) => void } = {}): Promise<{ chunks: VideoChunk[]; capped: boolean; costUsd: number }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new MediaError("invalid", "That clip couldn't be opened in this browser."));
    });
    const plan = planVideoChunks(video.duration * 1000, opts);
    const side = Math.min(opts.maxSide ?? 960, 1280);
    const scale = Math.min(1, side / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.max(2, Math.round((video.videoWidth * scale) / 2) * 2);
    const h = Math.max(2, Math.round((video.videoHeight * scale) / 2) * 2);
    const total = plan.chunks.reduce((n, c) => n + c.frames, 0);
    let grabbed = 0;
    const out: VideoChunk[] = [];
    for (const c of plan.chunks) {
      const frames: HTMLCanvasElement[] = [];
      for (let i = 0; i < c.frames; i++) {
        const t = c.startMs / 1000 + i / plan.fps;
        await new Promise<void>((resolve) => {
          video.onseeked = () => resolve();
          video.currentTime = Math.min(t, Math.max(0, video.duration - 0.001));
        });
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d")!.drawImage(video, 0, 0, w, h);
        frames.push(canvas);
        opts.onProgress?.(++grabbed / total / 2);
      }
      const made = await imagesToVideo(frames, { fps: plan.fps, width: w, height: h, codec: "avc" });
      URL.revokeObjectURL(made.url);
      out.push({ ...c, blob: made.blob });
      opts.onProgress?.(0.5 + out.length / plan.chunks.length / 2);
    }
    return { chunks: out, capped: plan.capped, costUsd: plan.costUsd };
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
}
