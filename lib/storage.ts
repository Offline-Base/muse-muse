import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { del, list, put } from "@vercel/blob";
import { env } from "@/lib/env";
import { isSafeFileKey, LOCAL_FILES_DIR, localFileKey, localFilesEnabled, localFileUrl, type StoredPrefix } from "@/lib/local-files";

/**
 * Vercel Blob paths, by prefix:
 *   inspo/<userId>/...        user references. Kept while the product exists.
 *   uploads/<productId>/...   files products upload through the gateway. Deleted after 24 hours by the cleanup cron.
 *   screens/<buildId>/...     judge screenshots. Deleted after 7 days.
 *   demos/<buildId>/...       recorded demo MP4s. Kept.
 *   transcripts/<buildId>/... redacted Muse Code session exports. Kept.
 *   fixtures/<buildId>/...    sample inputs the platform made for a build (Muse Image pictures, text files). Kept.
 *   native/...                shell templates, per-product packages and lab results (docs/NATIVE.md, "Blob").
 *   clips/<productId>/...     clips of a product on a real device that its owner uploaded. Kept.
 *   assets/<sha256>           vetted large files products' pages load (lib/caps/assets.json, scripts/caps/mirror-assets.ts). Kept.
 *
 * Local runs keep the same paths in .data/files instead (lib/local-files.ts).
 */
export type BlobPrefix = StoredPrefix;

async function toBuffer(body: Buffer | Blob | ReadableStream | string): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  return Buffer.from(await new Response(body).arrayBuffer());
}

/** The file and its content-type sidecar for a stored key, under `dir` (this run's .data/files by default). */
export function localFilePaths(key: string, dir: string = LOCAL_FILES_DIR): { file: string; type: string } {
  const root = path.resolve(dir);
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

/**
 * The credential part of a @vercel/blob call: `{ token }` with BLOB_READ_WRITE_TOKEN when it is set, otherwise `{}`,
 * which makes @vercel/blob sign in with the OIDC token (VERCEL_OIDC_TOKEN, or the request's on Vercel) and
 * BLOB_STORE_ID. Throws when neither credential is set, so a misconfigured deploy fails with a clear message.
 */
export function blobAuth(): { token?: string } {
  if (!env.blobConfigured) {
    throw new Error("No Blob store: set BLOB_STORE_ID (with an OIDC token) or BLOB_READ_WRITE_TOKEN. See .env.example.");
  }
  const token = env.blobReadWriteToken;
  return token ? { token } : {};
}

export async function putFile(
  prefix: BlobPrefix,
  path: string,
  body: Buffer | Blob | ReadableStream | string,
  contentType: string,
): Promise<string> {
  if (localFilesEnabled()) return putLocal(`${prefix}/${path}`, body, contentType);
  // Server-side put takes addRandomSuffix with either credential (it's a request header, not part of the token).
  const blob = await put(`${prefix}/${path}`, body, {
    access: "public",
    contentType,
    addRandomSuffix: true,
    ...blobAuth(),
  });
  return blob.url;
}

/** Uploads bigger than this go in parts, which @vercel/blob sends in parallel and retries one at a time. */
const MULTIPART_BYTES = 16 * 1024 * 1024;

/**
 * Uploads to exactly `pathname` (no random suffix), replacing any blob already there, and returns its URL. For moving
 * a local run's files to the same paths in a Blob store (scripts/promote-local.ts), so a path with a build id in it
 * stays that build's. Signs in with blobAuth(), as putFile does.
 */
export async function putBlobAt(pathname: string, body: Buffer, contentType: string): Promise<string> {
  if (!isSafeFileKey(pathname)) throw new Error(`Not a stored file's path: ${pathname}`);
  const blob = await put(pathname, body, {
    access: "public",
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
    multipart: body.length > MULTIPART_BYTES,
    ...blobAuth(),
  });
  return blob.url;
}

/** Deletes blobs under a prefix uploaded before `olderThan`. Returns how many were deleted. Local runs keep files. */
export async function deleteOlderThan(prefix: BlobPrefix, olderThan: Date): Promise<number> {
  if (localFilesEnabled()) return 0;
  const auth = blobAuth();
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await list({ prefix: `${prefix}/`, cursor, limit: 1000, ...auth });
    const stale = page.blobs.filter((b) => b.uploadedAt < olderThan).map((b) => b.url);
    if (stale.length) {
      await del(stale, auth);
      deleted += stale.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

/**
 * Downloads a public blob (or any URL) into memory. A file this platform stores locally is read from disk. `signal`
 * can cut a slow download short.
 */
export async function fetchBytes(url: string, opts: { signal?: AbortSignal } = {}): Promise<Buffer> {
  const key = localFileKey(url);
  if (key) return readFile(localFilePaths(key).file);
  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The SHA-256 of a public blob, read as a stream, so a file of hundreds of MB doesn't sit in memory. */
export async function sha256OfUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const hash = createHash("sha256");
  await pipeline(Readable.fromWeb(res.body as WebReadableStream), hash);
  return hash.digest("hex");
}
