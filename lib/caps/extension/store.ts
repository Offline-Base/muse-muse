import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BlobNotFoundError, del, head } from "@vercel/blob";
import { extensionZipPath } from "@/lib/caps/extension/paths";
import { localFileUrl, localFilesEnabled } from "@/lib/local-files";
import { blobAuth, localFilePaths, putBlobAt } from "@/lib/storage";

/**
 * Where a product's extension zip is kept: extensions/<productId>/latest.zip on Blob, replaced on each ship, with no
 * table of its own (docs/CAPABILITIES.md, section 20: no migration). A local run keeps the same path in .data/files.
 */

export interface StoredZip {
  url: string;
  bytes: number;
  uploadedAt: Date;
}

/** Saves the zip at its fixed path, replacing the last one. Returns its URL. */
export async function putExtensionZip(productId: string, zip: Buffer): Promise<string> {
  const key = extensionZipPath(productId);
  if (!localFilesEnabled()) return putBlobAt(key, zip, "application/zip");
  const { file, type } = localFilePaths(key);
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(path.dirname(type), { recursive: true });
  await writeFile(file, zip);
  await writeFile(type, "application/zip");
  return localFileUrl(key);
}

/** The product's latest zip, or null when none was made. */
export async function findExtensionZip(productId: string): Promise<StoredZip | null> {
  const key = extensionZipPath(productId);
  if (localFilesEnabled()) {
    const s = await stat(localFilePaths(key).file).catch(() => null);
    return s ? { url: localFileUrl(key), bytes: s.size, uploadedAt: s.mtime } : null;
  }
  try {
    const blob = await head(key, blobAuth());
    return { url: blob.url, bytes: blob.size, uploadedAt: blob.uploadedAt };
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  }
}

/**
 * Takes the product's zip down, when packaging it again failed: the older zip was made from older files, so it may call
 * actions the product no longer has. Returns true when there was one. Never throws for a zip that isn't there.
 */
export async function removeExtensionZip(productId: string): Promise<boolean> {
  const key = extensionZipPath(productId);
  if (localFilesEnabled()) {
    const { file, type } = localFilePaths(key);
    const had = Boolean(await stat(file).catch(() => null));
    await rm(file, { force: true });
    await rm(type, { force: true });
    return had;
  }
  const found = await findExtensionZip(productId);
  if (!found) return false;
  await del(found.url, blobAuth());
  return true;
}

/** Whether the product's zip is there, for the Get it tab. Null when it couldn't be told, so the tab keeps its link. */
export async function extensionZipReady(productId: string): Promise<boolean | null> {
  try {
    return (await findExtensionZip(productId)) !== null;
  } catch (err) {
    console.error("[extension] couldn't look for the zip:", err instanceof Error ? err.message : err);
    return null;
  }
}
