/**
 * Reads a dropped folder or zip in the browser (TUNE_FOLDER): only files the rules allow, within the size limits, as text.
 * Raw files never leave the browser. The zip and PDF libraries load on first use. Exported pieces take plain bytes, so the
 * tests run them on made-up files.
 */
import { classifyFile, FOLDER_LIMITS, looksBinary, normalPath, type FolderUpload, type SkippedFile } from "@/lib/train/tune/folder";

/** One file before it's read: a browser File, or an entry from a zip. */
export interface DroppedFile {
  path: string;
  size: number;
  bytes: () => Promise<Uint8Array>;
}

const isZip = (path: string) => /\.zip$/i.test(path);

/** A zip's entries that the rules allow, unpacked. Sizes come from the zip's own listing, checked before unpacking. */
export async function zipEntries(data: Uint8Array, prefix = ""): Promise<{ files: DroppedFile[]; skipped: SkippedFile[] }> {
  const { unzip } = await import("fflate");
  const skipped: SkippedFile[] = [];
  let planned = 0;
  let seen = 0;
  const unpacked = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(
      data,
      {
        filter: (file) => {
          if (file.name.endsWith("/")) return false;
          const path = `${prefix}${normalPath(file.name)}`;
          const kind = classifyFile(path, file.originalSize);
          if (!kind.ok) {
            skipped.push({ path, reason: kind.reason });
            return false;
          }
          seen++;
          if (seen > FOLDER_LIMITS.files) {
            skipped.push({ path, reason: "too_many" });
            return false;
          }
          // A zip can claim far less than it holds or expand to far more than it weighs, so this counts what's claimed
          // and the limit on what it may unpack to is the same as a folder's.
          if (planned + file.originalSize > FOLDER_LIMITS.totalBytes) {
            skipped.push({ path, reason: "too_big" });
            return false;
          }
          planned += file.originalSize;
          return true;
        },
      },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
  });
  const files = Object.entries(unpacked).map(([name, bytes]) => ({ path: `${prefix}${normalPath(name)}`, size: bytes.length, bytes: async () => bytes }));
  return { files, skipped };
}

/** A PDF's text. Throws when it can't be read. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(doc, { mergePages: true });
  return text;
}

/** Text from one allowed file, or null when it's a binary with a text file's name. */
async function textOf(file: DroppedFile, kind: string): Promise<string | null> {
  const bytes = await file.bytes();
  if (kind === "pdf") return pdfText(bytes);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return looksBinary(text) ? null : text;
}

/** Everything dropped, as the upload for POST /api/train/folder: what was read, and what was skipped and why. */
export async function readDropped(dropped: DroppedFile[], onProgress?: (done: number, total: number) => void): Promise<FolderUpload> {
  const skipped: SkippedFile[] = [];
  const queue: DroppedFile[] = [];
  for (const file of dropped) {
    const path = normalPath(file.path);
    if (!isZip(path)) {
      queue.push({ ...file, path });
      continue;
    }
    if (file.size > FOLDER_LIMITS.zipBytes) {
      skipped.push({ path, reason: "too_big" });
      continue;
    }
    try {
      const inside = await zipEntries(await file.bytes(), `${path}/`);
      queue.push(...inside.files);
      skipped.push(...inside.skipped);
    } catch {
      skipped.push({ path, reason: "unreadable" });
    }
  }
  const files: FolderUpload["files"] = [];
  let bytes = 0;
  let chars = 0;
  let done = 0;
  for (const file of queue) {
    onProgress?.(++done, queue.length);
    const kind = classifyFile(file.path, file.size);
    if (!kind.ok) {
      skipped.push({ path: file.path, reason: kind.reason });
      continue;
    }
    if (files.length >= FOLDER_LIMITS.files) {
      skipped.push({ path: file.path, reason: "too_many" });
      continue;
    }
    if (bytes + file.size > FOLDER_LIMITS.totalBytes) {
      skipped.push({ path: file.path, reason: "too_big" });
      continue;
    }
    bytes += file.size;
    let text: string | null;
    try {
      text = await textOf(file, kind.kind);
    } catch {
      skipped.push({ path: file.path, reason: "unreadable" });
      continue;
    }
    if (text === null) {
      skipped.push({ path: file.path, reason: "not_text" });
      continue;
    }
    const kept = text.slice(0, FOLDER_LIMITS.textChars);
    if (chars + kept.length > FOLDER_LIMITS.totalChars) {
      skipped.push({ path: file.path, reason: "too_big" });
      continue;
    }
    chars += kept.length;
    files.push({ path: file.path, text: kept });
  }
  return { files, skipped };
}
