import { env } from "@/lib/env";

/**
 * Local runs (`npm run dev:local`) have no Vercel Blob store, so files are kept in .data/files and served by
 * app/api/files/[...key]. That happens whenever neither Blob credential (BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID) is set
 * outside Vercel. The URLs use PLATFORM_URL, which dev:local points at its tunnel, so Meta and the build sandbox can
 * fetch them.
 */
export function localFilesEnabled(): boolean {
  return !env.blobConfigured && !process.env.VERCEL;
}

/** True when files have somewhere to go: a Blob store (either credential) or, on a local run, .data/files. */
export function fileStorageAvailable(): boolean {
  return env.blobConfigured || localFilesEnabled();
}

/** The folders every stored file is under, in Blob and in .data/files (lib/storage.ts says what each holds). */
export const STORED_PREFIXES = ["inspo", "uploads", "screens", "demos", "transcripts", "fixtures", "native", "clips", "extensions"] as const;
export type StoredPrefix = (typeof STORED_PREFIXES)[number];

export const LOCAL_FILES_DIR = ".data/files";
export const LOCAL_FILES_ROUTE = "/api/files/";

/** True for a stored key such as "inspo/abc-photo.png": relative, no "..", no empty segments. */
export function isSafeFileKey(key: string): boolean {
  return Boolean(key) && !key.includes("\\") && key.split("/").every((s) => s && s !== "." && s !== "..");
}

export function localFileUrl(key: string): string {
  return `${env.platformUrl}${LOCAL_FILES_ROUTE}${key.split("/").map(encodeURIComponent).join("/")}`;
}

/** The stored key for a URL this platform serves from .data/files, or null for any other URL. */
export function localFileKey(raw: string): string | null {
  if (!localFilesEnabled()) return null;
  const prefix = `${env.platformUrl}${LOCAL_FILES_ROUTE}`;
  if (!raw.startsWith(prefix)) return null;
  let key: string;
  try {
    key = raw
      .slice(prefix.length)
      .split(/[?#]/)[0]
      .split("/")
      .map(decodeURIComponent)
      .join("/");
  } catch {
    return null;
  }
  return isSafeFileKey(key) ? key : null;
}
