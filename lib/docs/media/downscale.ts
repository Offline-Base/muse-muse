import { dataUrlLength, sniffMime } from "@/lib/docs/media/base64";

/**
 * Image downscaling for inline sends. Demos put images in the request body as data URLs, so each one is kept under
 * about 1.5 MB of base64 (several fit under the proxy's 4.5 MB body cap) and its longest side under 1600 px, which is
 * plenty for Muse Spark and SAM and keeps token counts low. The size math is pure; downscaleImage uses the browser.
 */

export const MAX_IMAGE_DATA_URL = 1.5 * 1024 * 1024;
export const DEFAULT_MAX_SIDE = 1600;
/** Types every Meta endpoint takes as is (file-handling, Supported file types). Others are re-encoded. */
export const SENDABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** The size that fits `width` x `height` inside a `maxSide` square, keeping the aspect ratio. Never upscales. */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height);
  if (!(longest > 0)) return { width: 0, height: 0, scale: 1 };
  const scale = Math.min(1, maxSide / longest);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

export interface DownscaleStep {
  maxSide: number;
  quality: number;
}

/**
 * The encodes to try, in order, until one fits: the target side at falling quality, then smaller sides. Pure, so the
 * sequence is tested; the browser loop stops at the first result under the limit.
 */
export function downscalePlan(width: number, height: number, maxSide = DEFAULT_MAX_SIDE): DownscaleStep[] {
  const start = Math.min(maxSide, Math.max(width, height));
  const steps: DownscaleStep[] = [];
  for (let side = start, round = 0; side >= 256 && round < 6; side = Math.round(side * 0.75), round++) {
    for (const quality of round === 0 ? [0.86, 0.76, 0.66] : [0.8, 0.68]) steps.push({ maxSide: side, quality });
  }
  if (!steps.length) steps.push({ maxSide: start, quality: 0.8 });
  return steps;
}

/** True when an image can be sent unchanged: a sendable type, small enough as a data URL, and within the side limit. */
export function keepsOriginal(
  info: { mime: string; bytes: number; width: number; height: number },
  limits: { maxSide?: number; maxDataUrl?: number } = {},
): boolean {
  const maxSide = limits.maxSide ?? DEFAULT_MAX_SIDE;
  const maxDataUrl = limits.maxDataUrl ?? MAX_IMAGE_DATA_URL;
  return (
    SENDABLE_IMAGE_TYPES.has(info.mime) &&
    Math.max(info.width, info.height) <= maxSide &&
    dataUrlLength(info.bytes, info.mime) <= maxDataUrl
  );
}

export interface DownscaledImage {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  /** The original's size, before any change. */
  originalWidth: number;
  originalHeight: number;
  changed: boolean;
}

export interface DownscaleOptions {
  maxSide?: number;
  maxDataUrl?: number;
  /** The re-encode type. JPEG by default; WebP keeps transparency. */
  type?: "image/jpeg" | "image/webp";
}

async function decode(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // Some formats decode only through an <img> (HEIC in Safari).
    }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("Couldn't read that image. Try a JPEG, PNG or WebP.");
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

function encode(source: CanvasImageSource, w: number, h: number, type: string, quality: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Couldn't resize that image."));
  if (type === "image/jpeg") {
    // JPEG has no alpha: transparent areas become white instead of black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't resize that image."))), type, quality),
  );
}

/**
 * Returns the image unchanged when it already fits, or re-encoded at the first step of downscalePlan whose data URL
 * fits. EXIF orientation is applied while decoding, so the pixels sent match what the reader sees.
 */
export async function downscaleImage(blob: Blob, opts: DownscaleOptions = {}): Promise<DownscaledImage> {
  const maxSide = opts.maxSide ?? DEFAULT_MAX_SIDE;
  const maxDataUrl = opts.maxDataUrl ?? MAX_IMAGE_DATA_URL;
  const type = opts.type ?? "image/jpeg";
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const mime = blob.type || sniffMime(head) || "";
  const decoded = await decode(blob);
  try {
    const { width, height } = decoded;
    if (keepsOriginal({ mime, bytes: blob.size, width, height }, { maxSide, maxDataUrl })) {
      return { blob, mime, width, height, originalWidth: width, originalHeight: height, changed: false };
    }
    let last: DownscaledImage | null = null;
    for (const step of downscalePlan(width, height, maxSide)) {
      const size = fitWithin(width, height, step.maxSide);
      const out = await encode(decoded.source, size.width, size.height, type, step.quality);
      last = { blob: out, mime: type, width: size.width, height: size.height, originalWidth: width, originalHeight: height, changed: true };
      if (dataUrlLength(out.size, type) <= maxDataUrl) return last;
    }
    if (last) return last;
    throw new Error("Couldn't shrink that image enough to send.");
  } finally {
    decoded.close();
  }
}

/** An image's pixel size in the browser, for prompts that need it (SAM's w and h). */
export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const decoded = await decode(blob);
  try {
    return { width: decoded.width, height: decoded.height };
  } finally {
    decoded.close();
  }
}
