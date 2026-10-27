import { upload } from "@vercel/blob/client";
import type { Reference } from "@/lib/types";
import type { PreparedFile } from "@/lib/client/prepare";

/** The platform's Vercel Blob client-upload route (handleUpload). Needs a session. */
export const INSPO_UPLOAD_URL = "/api/inspirations/upload";

/** Files at or over this size go up in parallel parts with retries. */
const MULTIPART_BYTES = 8 * 1024 * 1024;

/** A file name that is safe in a Blob pathname: letters, digits, dot, dash and underscore, at most 80 chars. */
export function safeFileName(raw: string): string {
  const name = raw.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  const ext =
    dot > 0
      ? name
          .slice(dot + 1)
          .replace(/[^a-z0-9]/gi, "")
          .slice(0, 8)
          .toLowerCase()
      : "";
  const base = (dot > 0 ? name.slice(0, dot) : name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 70);
  return `${base || "file"}${ext ? `.${ext}` : ""}`;
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export class UploadError extends Error {}

/**
 * Uploads one prepared file straight to Vercel Blob through the platform's token route, at
 * "inspo/<uuid>-<safe name>", and returns the Reference to send with POST /api/inspirations.
 */
export async function uploadInspo(
  file: PreparedFile,
  opts: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
): Promise<Reference> {
  const pathname = `inspo/${uuid()}-${safeFileName(file.fileName)}`;
  try {
    const blob = await upload(pathname, file.blob, {
      access: "public",
      handleUploadUrl: INSPO_UPLOAD_URL,
      contentType: file.contentType,
      multipart: file.blob.size >= MULTIPART_BYTES,
      abortSignal: opts.signal,
      onUploadProgress: opts.onProgress ? (e) => opts.onProgress?.(Math.round(e.percentage)) : undefined,
    });
    return {
      url: blob.url,
      kind: file.kind,
      fileName: file.fileName,
      contentType: file.contentType,
      size: file.blob.size,
    };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // The token route answers 401 when the session is gone; the Blob client only reports "client token".
    if (/client token/i.test(message)) {
      throw new UploadError("Upload wasn't allowed. Sign in again, then retry.");
    }
    throw new UploadError("Upload failed. Check your connection and retry.");
  }
}
