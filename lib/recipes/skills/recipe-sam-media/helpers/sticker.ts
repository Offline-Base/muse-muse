/**
 * The deterministic half of the video-to-sticker-pack recipe (cookbook/video-to-sticker-pack): pick the longest-lived
 * SAM track, crop around it with smoothed motion, cap the frame rate, score frame-to-frame motion on the cutout, and
 * choose the highest-motion window in each third of the clip. SAM supplies the object identity and the masks; none
 * of this calls another model. The demo does the pixel work (seeking frames, applying masks, encoding) in a canvas.
 */

export interface TrackInfo {
  id: string;
  /** Frames the object appears in. */
  frames: number;
  first: number;
  last: number;
  /** Mean box area, to break ties between tracks seen in as many frames. */
  meanArea: number;
}

interface RecordLike {
  objectId: string;
  frame: number;
  box: { x1: number; y1: number; x2: number; y2: number; w: number; h: number };
}

/** Every track, longest-lived first (most frames; ties go to the bigger subject, then the lower id). */
export function tracksOf(records: readonly RecordLike[]): TrackInfo[] {
  const byId = new Map<string, { frames: Set<number>; area: number; n: number }>();
  for (const r of records) {
    const cur = byId.get(r.objectId) ?? { frames: new Set<number>(), area: 0, n: 0 };
    cur.frames.add(r.frame);
    cur.area += (r.box.x2 - r.box.x1 + 1) * (r.box.y2 - r.box.y1 + 1);
    cur.n++;
    byId.set(r.objectId, cur);
  }
  return [...byId.entries()]
    .map(([id, v]) => ({ id, frames: v.frames.size, first: Math.min(...v.frames), last: Math.max(...v.frames), meanArea: v.area / v.n }))
    .sort((a, b) => b.frames - a.frames || b.meanArea - a.meanArea || Number(a.id) - Number(b.id));
}

export interface Crop {
  frame: number;
  /** Center and side of a square crop in source pixels. It may reach past the frame: that part is transparent. */
  cx: number;
  cy: number;
  side: number;
}

/**
 * A square crop per frame around one track's box, padded, with its center and size averaged over `smooth` frames
 * each side so the sticker doesn't shake with the mask (the recipe's "smooths crop motion").
 */
export function smoothCrops(records: readonly RecordLike[], objectId: string, opts: { pad?: number; smooth?: number } = {}): Crop[] {
  const pad = opts.pad ?? 0.12;
  const radius = opts.smooth ?? 4;
  const raw = records
    .filter((r) => r.objectId === objectId)
    .sort((a, b) => a.frame - b.frame)
    .map((r) => {
      const w = r.box.x2 - r.box.x1 + 1;
      const h = r.box.y2 - r.box.y1 + 1;
      return { frame: r.frame, cx: r.box.x1 + w / 2, cy: r.box.y1 + h / 2, side: Math.max(w, h) * (1 + pad * 2) };
    });
  // One record per frame (a later line for a frame replaces an earlier one).
  const byFrame = new Map(raw.map((c) => [c.frame, c]));
  const list = [...byFrame.values()];
  return list.map((c, i) => {
    let cx = 0;
    let cy = 0;
    let side = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(list.length - 1, i + radius); j++) {
      cx += list[j].cx;
      cy += list[j].cy;
      side = Math.max(side, list[j].side);
      n++;
    }
    return { frame: c.frame, cx: cx / n, cy: cy / n, side: Math.round(side) };
  });
}

/** Keeps every k-th frame so the rate stays at or under maxFps: 24 fps capped at 15 keeps every 2nd frame, 12 fps. */
export function capFrameRate(frames: readonly number[], sourceFps: number, maxFps = 15): { frames: number[]; fps: number; step: number } {
  const step = Math.max(1, Math.ceil(sourceFps / maxFps));
  return { frames: frames.filter((_, i) => i % step === 0), fps: sourceFps / step, step };
}

/**
 * How much a cutout changed from one frame to the next: the mean absolute RGBA difference over the pixels either
 * frame covers, 0 to 255. Both frames are the same small size.
 */
export function motionBetween(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (!a[i + 3] && !b[i + 3]) continue;
    sum += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3])) / 4;
    n++;
  }
  return n ? sum / n : 0;
}

export interface StickerWindow {
  /** Index range [start, end) into the kept frames. */
  start: number;
  end: number;
  motion: number;
  third: number;
}

/**
 * At most this share of a third goes to one sticker, so every third keeps a choice of windows to score. It is the
 * recipe's own ratio: 2.5 s stickers from the thirds of its 10 s clip.
 */
export const WINDOW_SHARE = 0.75;

/**
 * How many kept frames each sticker gets: `maxSeconds` at the sticker frame rate (the recipe's 2.5 s), but never more
 * than WINDOW_SHARE of a third of the clip. Without that cap a short clip's window fills its whole third and the motion
 * score has nothing left to pick: the sample's 5 s clip keeps 60 frames at 12 fps, so a 2.5 s window (30 frames) would
 * be cut to the 20-frame third. Capped, it gets 15 frames and 6 windows to choose from in each third. `shortened` says
 * the clip was too short for full-length stickers.
 */
export function stickerLength(keptFrames: number, fps: number, maxSeconds: number, count = 3): { frames: number; shortened: boolean } {
  const wanted = Math.max(2, Math.round(maxSeconds * fps));
  const room = Math.max(2, Math.floor((keptFrames / count) * WINDOW_SHARE));
  return { frames: Math.min(wanted, room), shortened: room < wanted };
}

/**
 * The highest-motion window of `length` frames in each of `count` equal parts of the clip, so the poses are spread
 * across it rather than clustered. scores[i] is the motion from frame i - 1 to frame i (scores[0] is 0).
 */
export function pickWindows(scores: readonly number[], count: number, length: number): StickerWindow[] {
  const n = scores.length;
  const out: StickerWindow[] = [];
  for (let k = 0; k < count; k++) {
    const lo = Math.floor((k * n) / count);
    const hi = Math.floor(((k + 1) * n) / count);
    const len = Math.max(1, Math.min(length, hi - lo));
    let best = { start: lo, motion: -1 };
    for (let s = lo; s + len <= hi; s++) {
      let m = 0;
      for (let i = s + 1; i < s + len; i++) m += scores[i] ?? 0;
      if (m > best.motion) best = { start: s, motion: m };
    }
    if (hi > lo) out.push({ start: best.start, end: best.start + len, motion: Math.max(0, best.motion), third: k });
  }
  return out;
}

/** The WhatsApp-style manifest the recipe writes as contents.json. */
export function packManifest(r: { name: string; stickers: Array<{ file: string; emojis?: string[] }>; tray: string }) {
  return {
    identifier: r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sticker-pack",
    name: r.name,
    publisher: "Muse Muse docs demo",
    tray_image_file: r.tray,
    animated_sticker_pack: true,
    stickers: r.stickers.map((s) => ({ image_file: s.file, emojis: s.emojis ?? ["🐶"] })),
  };
}
