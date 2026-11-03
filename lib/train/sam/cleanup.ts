import { del, list } from "@vercel/blob";
import { localFilesEnabled } from "@/lib/local-files";
import { blobAuth } from "@/lib/storage";

/** How long a SAM tune run's own photos and look-alikes are kept: 7 days. Its report/ files are kept. */
export const SAM_UPLOAD_KEEP_MS = 7 * 24 * 3_600_000;

/** True for a stored path the sweep keeps: a run's report files, samtune/<runId>/report/... */
export function isSamReportPath(pathname: string): boolean {
  const parts = pathname.replace(/^\/+/, "").split("/");
  return parts[0] === "samtune" && parts[2] === "report";
}

export interface SamBlobLister {
  list(cursor: string | undefined): Promise<{ blobs: { url: string; pathname: string; uploadedAt: Date }[]; cursor?: string; hasMore: boolean }>;
  del(urls: string[]): Promise<void>;
}

/** The Vercel Blob lister for samtune/, signed in as putFile is (blobAuth). */
export function blobLister(): SamBlobLister {
  const auth = blobAuth();
  return {
    list: (cursor) => list({ prefix: "samtune/", cursor, limit: 1000, ...auth }),
    del: (urls) => del(urls, auth),
  };
}

/**
 * Deletes samtune/ blobs uploaded before `olderThan` (the person's photos, labels and look-alikes), keeping every
 * report/ file a shown report links. Returns how many were deleted. Local runs keep their files, as deleteOlderThan does.
 */
export async function deleteSamTuneUploads(olderThan: Date, lister: SamBlobLister | null = null): Promise<number> {
  if (!lister && localFilesEnabled()) return 0;
  const from = lister ?? blobLister();
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await from.list(cursor);
    const stale = page.blobs.filter((b) => b.uploadedAt < olderThan && !isSamReportPath(b.pathname)).map((b) => b.url);
    if (stale.length) {
      await from.del(stale);
      deleted += stale.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}
