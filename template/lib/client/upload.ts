import { upload } from "@vercel/blob/client";

export interface UploadedMedia {
  /** Public URL that SAM 3.1, Muse Wonder and Voice Transcribe can read. Expires after 24 hours. */
  url: string;
  contentType: string;
  size: number;
}

/**
 * Uploads a large file (video, long audio, big photos) straight from the browser to Vercel Blob. Browser only.
 *
 * The product's POST /api/upload route forwards the token request to the Muse Muse gateway, which signs it, and the
 * browser then uploads directly to Blob, so the file never passes through a function body. Pass the returned url to
 * the server, which passes it to the model.
 */
export async function uploadMedia(file: Blob, opts: { fileName?: string; onProgress?: (percent: number) => void } = {}): Promise<UploadedMedia> {
  const name = opts.fileName ?? (file instanceof File ? file.name : "file");
  const contentType = file.type || "application/octet-stream";
  const blob = await upload(`uploads/${crypto.randomUUID()}-${safeName(name)}`, file, {
    access: "public",
    handleUploadUrl: "/api/upload",
    contentType,
    onUploadProgress: opts.onProgress ? (e) => opts.onProgress?.(e.percentage) : undefined,
  });
  return { url: blob.url, contentType: blob.contentType || contentType, size: file.size };
}

function safeName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(-80);
  return cleaned || "file";
}
