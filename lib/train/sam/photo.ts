import { imageType } from "@/lib/pipeline/plan-art";
import { SAM_TUNE_LIMITS, type SamDistractor, type SamPhoto } from "@/lib/train/sam/types";

/**
 * One photo the person sends for their own object (POST /api/train/sam/[id]/photos): a JPEG, PNG or WebP, at most
 * 1024 px on its longest side and SAM_TUNE_LIMITS.uploadMaxBytes. The page shrinks it first (lib/docs/media/downscale.ts);
 * the server checks the bytes again, reading the size from the file's own header, never trusting what the page says.
 */

export const SAM_PHOTO_MAX_SIDE = 1024;

export type PhotoProblem = "not_base64" | "too_large" | "not_image" | "no_size" | "too_wide";

export interface CheckedPhoto {
  bytes: Buffer;
  contentType: string;
  ext: string;
  width: number;
  height: number;
}

/** A data URL or bare base64 as bytes, or null when it isn't base64. */
export function decodeBase64Image(input: string): Buffer | null {
  const m = /^data:[a-z0-9.+/-]+;base64,(.*)$/is.exec(input.trim());
  const b64 = (m ? m[1] : input).replace(/\s+/g, "");
  if (!b64 || b64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const bytes = Buffer.from(b64, "base64");
  return bytes.length ? bytes : null;
}

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

/** Width and height from a JPEG's SOF segment, a PNG's IHDR or a WebP's VP8, VP8L or VP8X chunk; null when unread. */
export function imageDims(bytes: Uint8Array, contentType: string): { width: number; height: number } | null {
  if (contentType === "image/png") {
    if (bytes.length < 24) return null;
    return { width: be32(bytes, 16), height: be32(bytes, 20) };
  }
  if (contentType === "image/webp") {
    if (bytes.length < 30) return null;
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8X") return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 };
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff };
    }
    return null;
  }
  if (contentType === "image/jpeg") {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = be16(bytes, i + 2);
      // SOF0 to SOF15, leaving out DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: be16(bytes, i + 7), height: be16(bytes, i + 5) };
      }
      if (length < 2) return null;
      i += 2 + length;
    }
    return null;
  }
  return null;
}

/** The photo's bytes, type and size, or why it can't be used. */
export function checkPhoto(input: string, maxBytes: number = SAM_TUNE_LIMITS.uploadMaxBytes): CheckedPhoto | { problem: PhotoProblem } {
  const bytes = decodeBase64Image(input);
  if (!bytes) return { problem: "not_base64" };
  if (bytes.length > maxBytes) return { problem: "too_large" };
  const type = imageType(bytes);
  if (!type) return { problem: "not_image" };
  const dims = imageDims(bytes, type.contentType);
  if (!dims || !(dims.width > 0) || !(dims.height > 0)) return { problem: "no_size" };
  if (Math.max(dims.width, dims.height) > SAM_PHOTO_MAX_SIDE) return { problem: "too_wide" };
  return { bytes, contentType: type.contentType, ext: type.ext, ...dims };
}

/** What each problem says to the person. */
export function photoProblemText(problem: PhotoProblem): string {
  switch (problem) {
    case "not_base64":
      return "Send the photo as a base64 data URL.";
    case "too_large":
      return `Each photo can be at most ${Math.round(SAM_TUNE_LIMITS.uploadMaxBytes / 1000)} KB.`;
    case "not_image":
      return "Send a JPEG, PNG or WebP photo.";
    case "no_size":
      return "Couldn't read that photo's size. Try saving it as a JPEG.";
    case "too_wide":
      return `Each photo can be at most ${SAM_PHOTO_MAX_SIDE} px on its longest side.`;
  }
}

/**
 * Which set a new photo or look-alike goes in, by its place in the list: every third is held out, so 12 photos give the
 * 4 held (SAM_TUNE_LIMITS.heldMin) and 16 look-alikes give 5. Placeholder until U1's splitBySeed is merged; Start
 * should re-split with the run's seed before the board claims it.
 */
export function splitFor(index: number): "train" | "held" {
  return index % 3 === 2 ? "held" : "train";
}

/** Whether the run's uploads are ready for Start, and what's missing, in the page's words. */
export function uploadsProblems(photos: readonly SamPhoto[], distractors: readonly SamDistractor[]): string[] {
  const L = SAM_TUNE_LIMITS;
  const out: string[] = [];
  const usable = photos.filter((p) => p.box && !p.skipped);
  const unlabeled = photos.filter((p) => !p.box && !p.skipped).length;
  if (unlabeled) out.push(`${unlabeled} ${unlabeled === 1 ? "photo has" : "photos have"} no box yet.`);
  if (usable.length < L.photosMin) out.push(`Needs at least ${L.photosMin} photos with a box (has ${usable.length}).`);
  const held = usable.filter((p) => p.split === "held").length;
  if (held < L.heldMin) out.push(`Needs at least ${L.heldMin} held-out photos with a box (has ${held}).`);
  const kept = distractors.filter((d) => d.kept).length;
  if (kept < L.distractorsMin) out.push(`Needs at least ${L.distractorsMin} look-alikes (has ${kept}).`);
  return out;
}
