import { del, list, put } from "@vercel/blob";
import { env } from "@/lib/env";

/**
 * Vercel Blob paths, by prefix:
 *   inspo/<userId>/...        user references. Kept while the product exists.
 *   uploads/<productId>/...   files products upload through the gateway. Deleted after 24 hours by the cleanup cron.
 *   screens/<buildId>/...     judge screenshots. Deleted after 7 days.
 *   demos/<buildId>/...       recorded demo MP4s. Kept.
 *   transcripts/<buildId>/... redacted Muse Code session exports. Kept.
 *   fixtures/<buildId>/...    sample inputs the platform made for a build (Muse Image pictures, text files). Kept.
 */
export type BlobPrefix = "inspo" | "uploads" | "screens" | "demos" | "transcripts" | "fixtures";

export async function putFile(
  prefix: BlobPrefix,
  path: string,
  body: Buffer | Blob | ReadableStream | string,
  contentType: string,
): Promise<string> {
  const blob = await put(`${prefix}/${path}`, body, {
    access: "public",
    contentType,
    addRandomSuffix: true,
    token: env.blobToken,
  });
  return blob.url;
}

/** Deletes blobs under a prefix uploaded before `olderThan`. Returns how many were deleted. */
export async function deleteOlderThan(prefix: BlobPrefix, olderThan: Date): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await list({ prefix: `${prefix}/`, cursor, limit: 1000, token: env.blobToken });
    const stale = page.blobs.filter((b) => b.uploadedAt < olderThan).map((b) => b.url);
    if (stale.length) {
      await del(stale, { token: env.blobToken });
      deleted += stale.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

/** Downloads a public blob (or any URL) into memory. */
export async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
