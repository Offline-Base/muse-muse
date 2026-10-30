import { readMaskEnvelope, SamMaskError, type SamMask, type SamMaskEncoding } from "@/lib/docs/media/sam";

/**
 * Mask pixels for the SAM overlays. A payload's envelope (marker, base85, length prefix) is documented and checked in
 * lib/docs/media/sam.ts, but the arithmetic coder inside it is not: Meta's docs describe only its result, a row-major
 * H x W raster of 0 and 1 from `decodeMaskToRaster` in `@meta-sam/parser`. So the raster step is pluggable. Until a
 * decoder is registered, overlays draw the exact boxes and say masks are pending.
 *
 * To draw masks with Meta's parser (npm install @meta-sam/parser), register it once in client code:
 *
 *   import { decodeMaskToRaster } from "@meta-sam/parser";
 *   setMaskRasterDecoder((mask) => decodeMaskToRaster(mask));
 */

export interface MaskInput {
  encoding: SamMaskEncoding;
  width: number;
  height: number;
  /** The payload with its encoding character first, exactly as on the wire. */
  payload: string;
}

/** Returns a row-major Uint8Array of 0 and 1 with width * height entries, or throws for a payload it can't read. */
export type MaskRasterDecoder = (mask: MaskInput) => Uint8Array;

let decoder: MaskRasterDecoder | null = null;
const cache = new Map<string, Uint8Array>();
const CACHE_LIMIT = 400; // a 120-frame clip with three objects fits

export function setMaskRasterDecoder(next: MaskRasterDecoder | null): void {
  decoder = next;
  cache.clear();
}

export function hasMaskRasterDecoder(): boolean {
  return decoder !== null;
}

export type MaskRasterResult =
  | { ok: true; raster: Uint8Array }
  | { ok: false; reason: "no_decoder" | "invalid"; message: string };

/** The mask's pixels, decoded once and cached by payload. */
export function decodeMaskRaster(mask: SamMask): MaskRasterResult {
  const key = `${mask.height},${mask.width},${mask.payload}`;
  const hit = cache.get(key);
  if (hit) return { ok: true, raster: hit };
  try {
    readMaskEnvelope(mask);
  } catch (err) {
    return { ok: false, reason: "invalid", message: err instanceof Error ? err.message : "Invalid mask payload." };
  }
  if (!decoder) {
    return { ok: false, reason: "no_decoder", message: "Mask pixels need a SAM mask decoder; boxes are exact." };
  }
  let raster: Uint8Array;
  try {
    raster = decoder({ encoding: mask.encoding, width: mask.width, height: mask.height, payload: mask.payload });
  } catch (err) {
    const message = err instanceof SamMaskError || err instanceof Error ? err.message : "The mask didn't decode.";
    return { ok: false, reason: "invalid", message };
  }
  if (raster.length !== mask.width * mask.height) {
    return { ok: false, reason: "invalid", message: `The mask decoded to ${raster.length} pixels, not ${mask.width * mask.height}.` };
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, raster);
  return { ok: true, raster };
}

/** RGBA pixels for a raster: `color` where the mask is 1, transparent elsewhere. For ImageData. */
export function rasterToRgba(
  raster: Uint8Array,
  width: number,
  height: number,
  color: readonly [number, number, number, number],
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  const [r, g, b, a] = color;
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    if (!raster[i]) continue;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  return out;
}

/** Pixels set in a raster. */
export function rasterArea(raster: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < raster.length; i++) n += raster[i] ? 1 : 0;
  return n;
}
