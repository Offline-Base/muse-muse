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

/** What to tell the user when the token route answers `status` with error `code`. */
export function uploadFailureMessage(status: number, code: string | undefined): string {
  if (status === 401) return "Upload wasn't allowed. Sign in again, then retry.";
  if (status === 429 || code === "upload_limit") return "Too many uploads from here in the last hour. Try again later.";
  if (status === 503 || code === "uploads_unavailable") return "File uploads aren't set up on this site yet.";
  return "Upload failed. Check your connection and retry.";
}

/** The Blob client reports every token route failure as "client token", so this asks the route once more for why. */
async function tokenFailureMessage(pathname: string): Promise<string> {
  try {
    const res = await fetch(INSPO_UPLOAD_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "blob.generate-client-token", payload: { pathname, clientPayload: null, multipart: false } }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return uploadFailureMessage(res.ok ? 0 : res.status, body.error);
  } catch {
    return uploadFailureMessage(0, undefined);
  }
}

/** Local runs (`npm run dev:local`) have no Blob store: the file goes to /api/files/upload in one request. */
async function uploadLocal(
  file: PreparedFile,
  pathname: string,
  opts: { onProgress?: (percent: number) => void; signal?: AbortSignal },
): Promise<Reference> {
  const form = new FormData();
  form.append("pathname", pathname);
  form.append("file", new File([file.blob], file.fileName, { type: file.contentType }));
  let res: Response;
  try {
    res = await fetch("/api/files/upload", { method: "POST", body: form, signal: opts.signal });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new UploadError("Upload failed. Check your connection and retry.");
  }
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !body.url) throw new UploadError(body.error ?? "Upload failed. Try again.");
  opts.onProgress?.(100);
  return { url: body.url, kind: file.kind, fileName: file.fileName, contentType: file.contentType, size: file.blob.size };
}

/**
 * Uploads one prepared file straight to Vercel Blob through the platform's token route, at
 * "inspo/<uuid>-<safe name>", and returns the Reference to send with POST /api/inspirations.
 */
export async function uploadInspo(
  file: PreparedFile,
  opts: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
): Promise<Reference> {
  const pathname = `inspo/${uuid()}-${safeFileName(file.fileName)}`;
  if (process.env.NEXT_PUBLIC_LOCAL_FILES === "1") return uploadLocal(file, pathname, opts);
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
    if (/client token/i.test(message)) throw new UploadError(await tokenFailureMessage(pathname));
    throw new UploadError("Upload failed. Check your connection and retry.");
  }
}
