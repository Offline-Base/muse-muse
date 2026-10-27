import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { del, list, put } from "@vercel/blob";
import { env } from "@/lib/env";
import { LOCAL_FILES_DIR, localFileKey, localFilesEnabled, localFileUrl } from "@/lib/local-files";

/**
 * Vercel Blob paths, by prefix:
 *   inspo/<userId>/...        user references. Kept while the product exists.
 *   uploads/<productId>/...   files products upload through the gateway. Deleted after 24 hours by the cleanup cron.
 *   screens/<buildId>/...     judge screenshots. Deleted after 7 days.
 *   demos/<buildId>/...       recorded demo MP4s. Kept.
 *   transcripts/<buildId>/... redacted Muse Code session exports. Kept.
 *   fixtures/<buildId>/...    sample inputs the platform made for a build (Muse Image pictures, text files). Kept.
 *
 * Local runs keep the same paths in .data/files instead (lib/local-files.ts).
 */
export type BlobPrefix = "inspo" | "uploads" | "screens" | "demos" | "transcripts" | "fixtures";

async function toBuffer(body: Buffer | Blob | ReadableStream | string): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  return Buffer.from(await new Response(body).arrayBuffer());
}

/** The file and its content-type sidecar for a stored key. */
export function localFilePaths(key: string): { file: string; type: string } {
  const root = path.resolve(LOCAL_FILES_DIR);
  return { file: path.join(root, "data", key), type: path.join(root, "types", key) };
}

/** Writes under .data/files with a random suffix before the extension, like Blob's addRandomSuffix. */
async function putLocal(key: string, body: Buffer | Blob | ReadableStream | string, contentType: string): Promise<string> {
  const dot = key.lastIndexOf(".");
  const slash = key.lastIndexOf("/");
  const suffix = `-${randomBytes(4).toString("hex")}`;
  const stored = dot > slash ? `${key.slice(0, dot)}${suffix}${key.slice(dot)}` : `${key}${suffix}`;
  const { file, type } = localFilePaths(stored);
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(path.dirname(type), { recursive: true });
  await writeFile(file, await toBuffer(body));
  await writeFile(type, contentType);
  return localFileUrl(stored);
}

export async function putFile(
  prefix: BlobPrefix,
  path: string,
  body: Buffer | Blob | ReadableStream | string,
  contentType: string,
): Promise<string> {
  if (localFilesEnabled()) return putLocal(`${prefix}/${path}`, body, contentType);
  const blob = await put(`${prefix}/${path}`, body, {
    access: "public",
    contentType,
    addRandomSuffix: true,
    token: env.blobToken,
  });
  return blob.url;
}

/** Deletes blobs under a prefix uploaded before `olderThan`. Returns how many were deleted. Local runs keep files. */
export async function deleteOlderThan(prefix: BlobPrefix, olderThan: Date): Promise<number> {
  if (localFilesEnabled()) return 0;
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

/** Downloads a public blob (or any URL) into memory. A file this platform stores locally is read from disk. */
export async function fetchBytes(url: string): Promise<Buffer> {
  const key = localFileKey(url);
  if (key) return readFile(localFilePaths(key).file);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
