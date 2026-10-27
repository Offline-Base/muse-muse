export interface ResizeOptions {
  /** Longest side in pixels. Default 1600. */
  maxSide?: number;
  /** JPEG quality from 0 to 1. Default 0.85. */
  quality?: number;
}

/**
 * Resizes a photo in the browser and returns a JPEG blob, so uploads stay well under the 4.5 MB function body limit.
 * Respects EXIF orientation (phone photos come out the right way up). Never upscales. Browser only.
 */
export async function resizeImage(file: Blob, opts: ResizeOptions = {}): Promise<Blob> {
  const maxSide = opts.maxSide ?? 1600;
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't resize images.");
    ctx.fillStyle = "#ffffff"; // JPEG has no alpha, so transparent PNGs get a white background
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image."))), "image/jpeg", opts.quality ?? 0.85),
    );
  } finally {
    bitmap.close();
  }
}

/** Reads a blob as a base64 data URL, for sending a resized photo to an action route as JSON. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsDataURL(blob);
  });
}
