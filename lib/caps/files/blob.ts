import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { BlobNotFoundError, del, get, head, issueSignedToken, parseStoreIdFromDelegationToken, presignUrl, type BlobAccessType } from "@vercel/blob";
import { env } from "@/lib/env";
import { localFilesEnabled } from "@/lib/local-files";
import { blobAuth, localFilePaths } from "@/lib/storage";

/**
 * Where the files cap keeps bytes (docs/CAPABILITIES.md, section 10, decision 14). Three modes, picked per call:
 *
 *   private  FILES_BLOB_STORE_ID names a private Vercel Blob store, reached with the deployment's OIDC token. Uploads
 *            are presigned PUTs; every read goes through the gateway, which redirects to a presigned GET good for five
 *            minutes. Nobody holds a lasting URL to a file.
 *   public   no private store is set up: the platform's own public store (lib/storage.ts blobAuth), with an unguessable
 *            suffix in every path. The gateway still hands out only its own signed URLs, but its redirect shows the
 *            blob's public URL, which then works for anyone who has it until the file is deleted. Decision 14's
 *            fallback: the privacy page has to say so.
 *   local    a local run with no Blob store: .data/files, written by the gateway's own signed upload route.
 *
 * Nothing secret leaves this file: an upload gets a delegation scoped to one pathname, one content type and its size.
 */
export type FilesBlobMode = "private" | "public" | "local";

export interface UploadTarget {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
}

export interface BlobFacts {
  bytes: number;
  contentType: string;
}

export interface FilesBlob {
  mode(): FilesBlobMode;
  /** A presigned PUT for exactly `pathname`, `contentType` and at most `bytes`, or null in local mode. */
  uploadTarget(pathname: string, contentType: string, bytes: number, validUntil: number): Promise<UploadTarget | null>;
  /** The stored size and type, or null when nothing was uploaded there. */
  facts(pathname: string): Promise<BlobFacts | null>;
  /** The SHA-256 of the stored bytes, read as a stream. */
  sha256(pathname: string): Promise<string>;
  /** Where a read is redirected to (private: a presigned GET; public: the blob's URL), or null in local mode. */
  readUrl(pathname: string, opts: { download: boolean; validUntil: number }): Promise<string | null>;
  /** Local mode: the stored bytes, or null. */
  localStream?(pathname: string): Promise<{ stream: ReadableStream; bytes: number } | null>;
  /** Local mode: writes the bytes the signed upload route received. */
  writeLocal?(pathname: string, body: Buffer, contentType: string): Promise<void>;
  /** Deletes blobs; a path that is already gone is fine. */
  remove(pathnames: string[]): Promise<void>;
}

/**
 * The Blob API version the SDK's own presigned upload sends (BLOB_API_VERSION in @vercel/blob 2.8.2). A browser PUT
 * sends the same headers the SDK's uploadPresigned would, so the gateway names them for the product's helper.
 */
export const BLOB_API_VERSION = "13";

const access = (mode: FilesBlobMode): BlobAccessType => (mode === "private" ? "private" : "public");

function auth(mode: FilesBlobMode): { token?: string; storeId?: string } {
  if (mode === "private") return { storeId: env.filesBlobStoreId! };
  return blobAuth();
}

function localPath(pathname: string): string {
  return localFilePaths(pathname).file;
}

/** The real backend: the private store when FILES_BLOB_STORE_ID is set, else the platform's, else .data/files. */
export const filesBlob: FilesBlob = {
  mode() {
    if (env.filesBlobStoreId && process.env.VERCEL) return "private";
    return localFilesEnabled() ? "local" : "public";
  },
  async uploadTarget(pathname, contentType, bytes, validUntil) {
    const mode = this.mode();
    if (mode === "local") return null;
    const limits = { allowedContentTypes: [contentType], maximumSizeInBytes: bytes };
    const token = await issueSignedToken({ pathname, operations: ["put"], validUntil, ...limits, ...auth(mode) });
    const { presignedUrl } = await presignUrl(token, { operation: "put", pathname, access: access(mode), validUntil, ...limits, addRandomSuffix: false, allowOverwrite: false });
    return {
      url: presignedUrl,
      method: "PUT",
      headers: {
        "x-vercel-blob-access": access(mode),
        "x-content-type": contentType,
        "x-api-version": BLOB_API_VERSION,
        "x-vercel-blob-store-id": parseStoreIdFromDelegationToken(token.delegationToken),
      },
    };
  },
  async facts(pathname) {
    const mode = this.mode();
    if (mode === "local") {
      const file = localPath(pathname);
      if (!existsSync(file)) return null;
      const type = localFilePaths(pathname).type;
      return { bytes: (await stat(file)).size, contentType: existsSync(type) ? (await readFile(type, "utf8")).trim() : "application/octet-stream" };
    }
    try {
      const h = await head(pathname, auth(mode));
      return { bytes: h.size, contentType: h.contentType };
    } catch (err) {
      if (err instanceof BlobNotFoundError) return null;
      throw err;
    }
  },
  async sha256(pathname) {
    const mode = this.mode();
    const hash = createHash("sha256");
    if (mode === "local") {
      await pipeline(createReadStream(localPath(pathname)), hash);
      return hash.digest("hex");
    }
    const got = await get(pathname, { access: access(mode), useCache: false, ...auth(mode) });
    if (!got || got.statusCode !== 200) throw new Error("The uploaded file couldn't be read back.");
    await pipeline(Readable.fromWeb(got.stream as WebReadableStream), hash);
    return hash.digest("hex");
  },
  async readUrl(pathname, opts) {
    const mode = this.mode();
    if (mode === "local") return null;
    let url: string;
    if (mode === "private") {
      const token = await issueSignedToken({ pathname, operations: ["get"], validUntil: opts.validUntil, ...auth(mode) });
      url = (await presignUrl(token, { operation: "get", pathname, access: "private", validUntil: opts.validUntil })).presignedUrl;
    } else {
      url = (await head(pathname, auth(mode))).url;
    }
    if (!opts.download) return url;
    // Blob answers ?download=1 with Content-Disposition: attachment. It isn't part of a presigned URL's signature.
    const u = new URL(url);
    u.searchParams.set("download", "1");
    return u.toString();
  },
  async localStream(pathname) {
    const file = localPath(pathname);
    if (!existsSync(file)) return null;
    return { stream: Readable.toWeb(createReadStream(file)) as ReadableStream, bytes: (await stat(file)).size };
  },
  async writeLocal(pathname, body, contentType) {
    const { file, type } = localFilePaths(pathname);
    await mkdir(path.dirname(file), { recursive: true });
    await mkdir(path.dirname(type), { recursive: true });
    await writeFile(file, body);
    await writeFile(type, contentType);
  },
  async remove(pathnames) {
    if (!pathnames.length) return;
    const mode = this.mode();
    if (mode === "local") {
      for (const p of pathnames) {
        const { file, type } = localFilePaths(p);
        await rm(file, { force: true });
        await rm(type, { force: true });
      }
      return;
    }
    // del takes pathnames with the store's credential, and ignores ones that are gone.
    await del(pathnames, auth(mode));
  },
};
