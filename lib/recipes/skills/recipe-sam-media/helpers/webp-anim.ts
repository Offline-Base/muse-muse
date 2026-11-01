/**
 * Builds an animated WebP from still WebP frames, the sticker format the video-to-sticker-pack recipe exports. The
 * browser encodes each frame (canvas.toBlob("image/webp")); this only rewraps them in the RIFF container's animation
 * chunks (Google's WebP container spec): VP8X with the animation and alpha flags, ANIM with the loop count, then one
 * ANMF per frame holding that frame's own ALPH and VP8 (or VP8L) chunks. No pixels are re-encoded.
 */

const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function u24(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
}

function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function chunk(fourcc: string, payload: Uint8Array): Uint8Array {
  const padded = payload.length + (payload.length & 1);
  const out = new Uint8Array(8 + padded);
  out.set(text(fourcc), 0);
  out.set(u32(payload.length), 4);
  out.set(payload, 8);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface WebpChunk {
  fourcc: string;
  /** The payload without its header or padding. */
  data: Uint8Array;
}

/** The chunks of a still WebP file, or throws when it isn't one. */
export function readWebp(bytes: Uint8Array): WebpChunk[] {
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WEBP") throw new Error("That isn't a WebP file.");
  const chunks: WebpChunk[] = [];
  let at = 12;
  while (at + 8 <= bytes.length) {
    const fourcc = tag(at);
    const size = bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24);
    if (size < 0 || at + 8 + size > bytes.length) throw new Error(`The ${fourcc} chunk runs past the end of the file.`);
    chunks.push({ fourcc, data: bytes.subarray(at + 8, at + 8 + size) });
    at += 8 + size + (size & 1);
  }
  return chunks;
}

/** True when the frame carries image data a muxer can use (lossy with or without ALPH, or lossless). */
export function hasImageData(chunks: readonly WebpChunk[]): boolean {
  return chunks.some((c) => c.fourcc === "VP8 " || c.fourcc === "VP8L");
}

export interface AnimatedWebpInput {
  width: number;
  height: number;
  /** Each frame as a still WebP file the size of the canvas. */
  frames: readonly Uint8Array[];
  /** Per frame, or one value for all, in milliseconds. */
  durationMs: number | readonly number[];
  /** 0 loops forever. */
  loops?: number;
}

/** The animated WebP file. Every frame covers the whole canvas, replacing it (no blending), so transparency stays exact. */
export function buildAnimatedWebp(r: AnimatedWebpInput): Uint8Array {
  if (!r.frames.length) throw new Error("An animation needs at least one frame.");
  if (r.width < 1 || r.height < 1 || r.width > 16384 || r.height > 16384) throw new Error("WebP canvases are 1 to 16384 pixels a side.");
  let alpha = false;
  const anmf = r.frames.map((file, i) => {
    const chunks = readWebp(file).filter((c) => c.fourcc === "ALPH" || c.fourcc === "VP8 " || c.fourcc === "VP8L");
    if (!hasImageData(chunks)) throw new Error(`Frame ${i + 1} has no image data.`);
    // VP8L always has an alpha channel; lossy frames have it when they carry ALPH.
    if (chunks.some((c) => c.fourcc === "ALPH" || c.fourcc === "VP8L")) alpha = true;
    const duration = Math.max(1, Math.min(0xffffff, Math.round(Array.isArray(r.durationMs) ? (r.durationMs[i] ?? 100) : (r.durationMs as number))));
    const header = Uint8Array.from([
      ...u24(0), // x / 2
      ...u24(0), // y / 2
      ...u24(r.width - 1),
      ...u24(r.height - 1),
      ...u24(duration),
      0b10, // blending: don't blend; disposal: none
    ]);
    return chunk("ANMF", concat([header, ...chunks.map((c) => chunk(c.fourcc, c.data))]));
  });
  const vp8x = chunk("VP8X", Uint8Array.from([(alpha ? 0x10 : 0) | 0x02, 0, 0, 0, ...u24(r.width - 1), ...u24(r.height - 1)]));
  // Background (BGRA, transparent) and loop count.
  const anim = chunk("ANIM", Uint8Array.from([0, 0, 0, 0, (r.loops ?? 0) & 0xff, ((r.loops ?? 0) >> 8) & 0xff]));
  const body = concat([text("WEBP"), vp8x, anim, ...anmf]);
  return concat([text("RIFF"), Uint8Array.from(u32(body.length)), body]);
}

/** Frame count, canvas size, loop count and durations of an animated WebP, read back for checks and tests. */
export function describeAnimatedWebp(bytes: Uint8Array): { width: number; height: number; frames: number; durations: number[]; loops: number; alpha: boolean } {
  const chunks = readWebp(bytes);
  const vp8x = chunks.find((c) => c.fourcc === "VP8X");
  const anim = chunks.find((c) => c.fourcc === "ANIM");
  if (!vp8x || !(vp8x.data[0] & 0x02) || !anim) throw new Error("That WebP isn't animated.");
  const r24 = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8) | (d[at + 2] << 16);
  const frames = chunks.filter((c) => c.fourcc === "ANMF");
  return {
    width: r24(vp8x.data, 4) + 1,
    height: r24(vp8x.data, 7) + 1,
    frames: frames.length,
    durations: frames.map((f) => r24(f.data, 12)),
    loops: anim.data[4] | (anim.data[5] << 8),
    alpha: !!(vp8x.data[0] & 0x10),
  };
}
