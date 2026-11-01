/**
 * A small animated GIF encoder for the sticker recipe's "browser-friendly transparent previews". GIF holds 256 colors
 * and one-bit transparency, so one palette is built for the whole animation (median cut over 5-bit color buckets,
 * 255 colors plus a transparent index), pixels map to their nearest entry, and each frame is LZW-coded (GIF89a, with
 * the NETSCAPE2.0 loop extension). Pure: RGBA frames in, file bytes out.
 */

export interface GifFrame {
  /** width * height * 4 bytes of RGBA. */
  rgba: ArrayLike<number>;
  /** Display time in milliseconds; GIF stores hundredths of a second. */
  delayMs: number;
}

const TRANSPARENT = 255;

interface Bucket {
  r: number;
  g: number;
  b: number;
  n: number;
}

/** Counts colors in 5-bit buckets, sampling every `stride`-th opaque pixel across all frames. */
function histogram(frames: readonly GifFrame[], stride: number): Bucket[] {
  const counts = new Map<number, Bucket>();
  for (const f of frames) {
    const px = f.rgba;
    for (let i = 0; i < px.length; i += 4 * stride) {
      if (px[i + 3] < 128) continue;
      const key = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
      const b = counts.get(key);
      if (b) {
        b.r += px[i];
        b.g += px[i + 1];
        b.b += px[i + 2];
        b.n++;
      } else counts.set(key, { r: px[i], g: px[i + 1], b: px[i + 2], n: 1 });
    }
  }
  return [...counts.values()].map((b) => ({ r: b.r / b.n, g: b.g / b.n, b: b.b / b.n, n: b.n }));
}

/** Median cut: split the box with the widest channel range at its weighted median until there are `max` boxes. */
export function medianCut(buckets: readonly Bucket[], max = 255): Array<[number, number, number]> {
  if (!buckets.length) return [[0, 0, 0]];
  type Box = Bucket[];
  const range = (box: Box, ch: "r" | "g" | "b") => {
    let lo = 255;
    let hi = 0;
    for (const c of box) {
      if (c[ch] < lo) lo = c[ch];
      if (c[ch] > hi) hi = c[ch];
    }
    return hi - lo;
  };
  const boxes: Box[] = [[...buckets]];
  while (boxes.length < max) {
    let pick = -1;
    let widest = 0;
    let channel: "r" | "g" | "b" = "r";
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (const ch of ["r", "g", "b"] as const) {
        const w = range(box, ch);
        if (w > widest) {
          widest = w;
          pick = i;
          channel = ch;
        }
      }
    });
    if (pick < 0 || widest === 0) break;
    const box = boxes[pick].sort((a, b) => a[channel] - b[channel]);
    const total = box.reduce((n, c) => n + c.n, 0);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].n;
      if (acc >= total / 2) {
        cut = i + 1;
        break;
      }
      cut = i + 1;
    }
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => {
    const n = box.reduce((s, c) => s + c.n, 0) || 1;
    return [
      Math.round(box.reduce((s, c) => s + c.r * c.n, 0) / n),
      Math.round(box.reduce((s, c) => s + c.g * c.n, 0) / n),
      Math.round(box.reduce((s, c) => s + c.b * c.n, 0) / n),
    ];
  });
}

/** Maps RGBA pixels to palette indexes (TRANSPARENT where alpha is under half), nearest color by squared distance, cached by 5-bit bucket. */
export function indexPixels(rgba: ArrayLike<number>, palette: ReadonlyArray<[number, number, number]>, cache = new Int16Array(32768).fill(-1)): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    if (rgba[i + 3] < 128) {
      out[p] = TRANSPARENT;
      continue;
    }
    const key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    let idx = cache[key];
    if (idx < 0) {
      let best = Infinity;
      idx = 0;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      for (let c = 0; c < palette.length; c++) {
        const d = (palette[c][0] - r) ** 2 + (palette[c][1] - g) ** 2 + (palette[c][2] - b) ** 2;
        if (d < best) {
          best = d;
          idx = c;
        }
      }
      cache[key] = idx;
    }
    out[p] = idx;
  }
  return out;
}

/** LZW-codes palette indexes the way GIF wants: variable-width codes packed least significant bit first, in sub-blocks. */
export function lzwEncode(indexes: Uint8Array, minCodeSize = 8): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  let size = minCodeSize + 1;
  const emit = (code: number) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      bytes.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  };
  let dict = new Map<number, number>();
  let next = eoi + 1;
  emit(clear);
  let prefix = indexes.length ? indexes[0] : -1;
  for (let i = 1; i < indexes.length; i++) {
    const k = indexes[i];
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(clear);
      dict = new Map();
      next = eoi + 1;
      size = minCodeSize + 1;
    }
    prefix = k;
  }
  if (prefix >= 0) emit(prefix);
  emit(eoi);
  if (bits > 0) bytes.push(acc & 0xff);
  // Sub-blocks of up to 255 bytes, then a zero-length terminator.
  const out: number[] = [minCodeSize];
  for (let i = 0; i < bytes.length; i += 255) {
    const block = bytes.slice(i, i + 255);
    out.push(block.length, ...block);
  }
  out.push(0);
  return Uint8Array.from(out);
}

/** The whole GIF89a file: one global palette, looping forever, each frame replacing the last (disposal: restore to background). */
export function encodeGif(width: number, height: number, frames: readonly GifFrame[], opts: { loops?: number; sampleStride?: number } = {}): Uint8Array {
  if (!frames.length) throw new Error("A GIF needs at least one frame.");
  for (const f of frames) if (f.rgba.length !== width * height * 4) throw new Error("Every frame needs width * height RGBA pixels.");
  const palette = medianCut(histogram(frames, opts.sampleStride ?? 3), 255);
  while (palette.length < 256) palette.push([0, 0, 0]);
  const out: number[] = [];
  const word = (n: number) => out.push(n & 0xff, (n >> 8) & 0xff);
  out.push(...Array.from("GIF89a", (c) => c.charCodeAt(0)));
  word(width);
  word(height);
  out.push(0xf7, TRANSPARENT, 0); // global color table of 256, background = the transparent index
  for (const [r, g, b] of palette) out.push(r, g, b);
  const loops = opts.loops ?? 0;
  out.push(0x21, 0xff, 0x0b, ...Array.from("NETSCAPE2.0", (c) => c.charCodeAt(0)), 0x03, 0x01, loops & 0xff, (loops >> 8) & 0xff, 0x00);
  const cache = new Int16Array(32768).fill(-1);
  for (const f of frames) {
    const delay = Math.max(2, Math.round(f.delayMs / 10));
    out.push(0x21, 0xf9, 0x04, 0x09, delay & 0xff, (delay >> 8) & 0xff, TRANSPARENT, 0x00);
    out.push(0x2c);
    word(0);
    word(0);
    word(width);
    word(height);
    out.push(0x00);
    const data = lzwEncode(indexPixels(f.rgba, palette, cache));
    for (let i = 0; i < data.length; i++) out.push(data[i]);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}
