import { env } from "@/lib/env";

/**
 * Local runs (`npm run dev:local`) have no Vercel Blob store, so files are kept in .data/files and served by
 * app/api/files/[...key]. That happens whenever BLOB_READ_WRITE_TOKEN is unset outside Vercel. The URLs use
 * PLATFORM_URL, which dev:local points at its tunnel, so Meta and the build sandbox can fetch them.
 */
export function localFilesEnabled(): boolean {
  return !process.env.BLOB_READ_WRITE_TOKEN && !process.env.VERCEL;
}

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
