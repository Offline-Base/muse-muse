/**
 * Browser image resize. Photos larger than 1600 px on the long side are redrawn as JPEG so uploads stay small and
 * Spark reads them quickly. EXIF orientation is applied while decoding.
 */
export const MAX_IMAGE_SIDE = 1600;

/** Types every model call and browser handles as is. Others (HEIC, TIFF, BMP) are converted to JPEG when possible. */
const WEB_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface ImageResult {
  blob: Blob;
  contentType: string;
  width: number;
  height: number;
  changed: boolean;
}

async function decode(
  file: Blob,
): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // Fall through to an <img>, which some browsers decode more formats with (Safari and HEIC).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("Couldn't read that image.");
  }
}

/**
 * Returns the file unchanged when it's a web format within MAX_IMAGE_SIDE. Otherwise returns a JPEG whose long side
 * is at most `maxSide`. If the browser can't decode the image, the original is returned so the server can decide.
 */
export async function prepareImage(file: Blob, maxSide = MAX_IMAGE_SIDE, quality = 0.86): Promise<ImageResult> {
  let decoded: Awaited<ReturnType<typeof decode>>;
  try {
    decoded = await decode(file);
  } catch {
    return { blob: file, contentType: file.type || "application/octet-stream", width: 0, height: 0, changed: false };
  }
  try {
    const { width, height } = decoded;
    const longest = Math.max(width, height);
    if (longest <= maxSide && WEB_TYPES.has(file.type)) {
      return { blob: file, contentType: file.type, width, height, changed: false };
    }
    const scale = Math.min(1, maxSide / longest);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const blob = await drawJpeg(decoded.source, w, h, quality);
    return { blob, contentType: "image/jpeg", width: w, height: h, changed: true };
  } finally {
    decoded.close();
  }
}

async function drawJpeg(source: CanvasImageSource, w: number, h: number, quality: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      paint(ctx, source, w, h);
      return canvas.convertToBlob({ type: "image/jpeg", quality });
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't resize that image.");
  paint(ctx, source, w, h);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't resize that image."))), "image/jpeg", quality),
  );
}

function paint(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  w: number,
  h: number,
) {
  // JPEG has no alpha, so transparent PNGs get a white background instead of black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
}
