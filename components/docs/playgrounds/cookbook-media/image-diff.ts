/**
 * Where an edited image differs from its source, for the editing recipe's check ("compare the output with the source
 * image to identify changes in other areas"). Both images are drawn to the same size first; this compares their
 * pixels: luminance, a 3 x 3 box blur so resampling noise and texture don't count, then a threshold. The heat map
 * marks what changed. Pure (RGBA arrays in and out), so it's tested without a canvas.
 */

export interface DiffResult {
  /** Pixels whose blurred luminance moved more than the threshold. */
  changed: number;
  total: number;
  /** changed / total, 0 to 1. */
  share: number;
  /** RGBA overlay: red where it changed, stronger for bigger changes; transparent elsewhere. */
  heat: Uint8ClampedArray<ArrayBuffer>;
  /** The smallest box around every changed pixel, or null when nothing changed. */
  bounds: { x1: number; y1: number; x2: number; y2: number } | null;
}

function luminance(rgba: ArrayLike<number>, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) out[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  return out;
}

function blur(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += src[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = sum / n;
    }
  }
  return out;
}

/** Compares two same-size RGBA images. `threshold` is in luminance steps (0 to 255); 32 ignores re-render noise. */
export function diffImages(a: ArrayLike<number>, b: ArrayLike<number>, width: number, height: number, threshold = 32): DiffResult {
  const total = width * height;
  if (a.length < total * 4 || b.length < total * 4) throw new Error("Both images need width * height RGBA pixels.");
  const la = blur(luminance(a, total), width, height);
  const lb = blur(luminance(b, total), width, height);
  const heat = new Uint8ClampedArray(total * 4);
  let changed = 0;
  let x1 = width;
  let y1 = height;
  let x2 = -1;
  let y2 = -1;
  for (let i = 0; i < total; i++) {
    const d = Math.abs(la[i] - lb[i]);
    if (d <= threshold) continue;
    changed++;
    const x = i % width;
    const y = (i - x) / width;
    if (x < x1) x1 = x;
    if (y < y1) y1 = y;
    if (x > x2) x2 = x;
    if (y > y2) y2 = y;
    const o = i * 4;
    heat[o] = 235;
    heat[o + 1] = 48;
    heat[o + 2] = 64;
    heat[o + 3] = Math.min(220, 90 + Math.round(d));
  }
  return { changed, total, share: total ? changed / total : 0, heat, bounds: changed ? { x1, y1, x2, y2 } : null };
}

/** The size both images are compared at: the source's shape, at most `maxSide` on its long side. */
export function compareSize(source: { width: number; height: number }, maxSide = 480): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  return { width: Math.max(1, Math.round(source.width * scale)), height: Math.max(1, Math.round(source.height * scale)) };
}

/** True when two images' shapes differ by more than `tolerance` (2 percent), so a pixel compare would be skewed. */
export function aspectDiffers(a: { width: number; height: number }, b: { width: number; height: number }, tolerance = 0.02): boolean {
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  return Math.abs(ra - rb) / ra > tolerance;
}
