import { blobToDataUrl, resizeImage } from "@/lib/client/resize";
import { toWav16k } from "@/lib/client/wav";

/**
 * Platform file: don't edit. The sample view: photos and a spoken question from the product's own public/samples/, for
 * visitors with no glasses and no camera. Browser only.
 */

export interface GlassesSamples {
  /** URLs like "/samples/pov-1.jpg", each taken from the wearer's eye level. Captures go through them in order. */
  photos: string[];
  /** A URL like "/samples/question.wav". Without one, the sample view listens with this device's microphone. */
  question?: string;
}

export interface PhotoData {
  dataUrl: string;
  width: number;
  height: number;
}

/** A JPEG of at most maxSize px on its long side, as a data URL with its size. */
export async function photoFromBlob(blob: Blob, maxSize = 1600): Promise<PhotoData> {
  const jpeg = await resizeImage(blob, { maxSide: maxSize });
  const bitmap = await createImageBitmap(jpeg);
  try {
    return { dataUrl: await blobToDataUrl(jpeg), width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/** How long a WAV from toWav16k is, in seconds: 44 header bytes, then 32,000 bytes a second. */
export function wavSeconds(wav: Blob): number {
  return Math.round((Math.max(0, wav.size - 44) / 32000) * 10) / 10;
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load ${url} (HTTP ${res.status}).`);
  return res.blob();
}

export async function samplePhoto(url: string, maxSize?: number): Promise<PhotoData> {
  return photoFromBlob(await fetchBlob(url), maxSize);
}

export async function sampleQuestion(url: string): Promise<{ wavDataUrl: string; seconds: number }> {
  const wav = await toWav16k(await fetchBlob(url));
  return { wavDataUrl: await blobToDataUrl(wav), seconds: wavSeconds(wav) };
}
