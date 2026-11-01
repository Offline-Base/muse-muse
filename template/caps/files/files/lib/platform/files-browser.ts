// Platform file (Muse Muse platform services). Don't edit: call it from client components.
//
// uploadFile(file, { scope }) keeps a file the person picked, in three steps: this product's /api/musemuse/files route
// gets a ticket from the gateway, the browser sends the bytes straight to storage at the ticket's URL (so the 4.5 MB
// request limit doesn't apply), and /api/musemuse/files/done has the gateway check what arrived. It returns the stored
// file, with a link good for an hour. Pictures, audio, video, PDF and plain text (txt, csv, md, json), up to 25 MB.

export type FileScope = "shared" | "visitor" | "owner" | "user";

export interface UploadedFile {
  id: string;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string | null;
  scope: FileScope;
  createdAt: string;
  url: string;
  expiresAt: string;
}

/** Types a product may keep. Others are refused here, before anything is sent. */
export const KEEPABLE_TYPES = [
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
  "audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm", "audio/flac",
  "video/mp4", "video/webm", "video/quicktime",
  "application/pdf", "text/plain", "text/csv", "text/markdown", "application/json",
] as const;

/** What uploadFile throws, with the gateway's code and its plain message. */
export class UploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

const BY_EXTENSION: Record<string, string> = { md: "text/markdown", csv: "text/csv", txt: "text/plain", json: "application/json" };

/** A file's type as the gateway wants it: the browser's, or from its name for text files browsers leave blank. */
export function typeOf(file: { name: string; type: string }): string {
  const given = file.type.split(";")[0]!.trim().toLowerCase();
  if (given) return given;
  return BY_EXTENSION[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {
    throw new UploadError("unreachable", "The upload couldn't start. Check the connection and try again.");
  });
  const reply = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!res.ok) throw new UploadError(reply?.code ?? "upload_failed", reply?.error ?? "The upload didn't work this time. Try again.");
  return reply as T;
}

/** Keeps one file. Throws UploadError with a message to show next to the upload button. */
export async function uploadFile(file: File, opts: { scope?: FileScope; signal?: AbortSignal } = {}): Promise<UploadedFile> {
  const contentType = typeOf(file);
  if (!(KEEPABLE_TYPES as readonly string[]).includes(contentType)) {
    throw new UploadError("invalid_arguments", "This kind of file can't be kept. Pictures, audio, video, PDF and plain text can.");
  }
  const ticket = await post<{ id: string; upload: { url: string; method: "PUT"; headers: Record<string, string> } }>("/api/musemuse/files", {
    name: file.name,
    contentType,
    bytes: file.size,
    ...(opts.scope ? { scope: opts.scope } : {}),
  });
  const put = await fetch(ticket.upload.url, { method: "PUT", headers: ticket.upload.headers, body: file, signal: opts.signal }).catch(() => null);
  if (!put || !put.ok) throw new UploadError("upload_failed", "The file didn't finish uploading. Try again.");
  return post<UploadedFile>("/api/musemuse/files/done", { id: ticket.id, ...(opts.scope ? { scope: opts.scope } : {}) });
}
