/**
 * Saved versions of a product's source (docs/VERSIONS.md). Files live in storage by content, under
 * source/<productId>/<sha>, so a file that didn't change is stored once. The list of files per build is a database row.
 */
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { fetchBytes, putExactFile } from "@/lib/storage";
import { makeZip, type ZipEntry } from "@/lib/outputs/zip";
import { holdsSecret, isHiddenPath, visibleFiles, isText, sha1, type CommitBuild, type VersionFile } from "@/lib/versions/policy";

/** The deploy limit already bounds these; this is for a tree that grew strange, which then goes unsaved. */
const MAX_FILES = 3000;
const PARALLEL = 8;

export const SOURCE_ZIP_MAX_BYTES = 4 * 1024 * 1024;
/** What makeZip takes in one zip (lib/outputs/zip.ts), with room for LEFT_OUT.txt. */
const ZIP_MAX_FILES = 1000;
const ZIP_MAX_UNPACKED = 15 * 1024 * 1024;
/** What a person reads or compares in the page. Bigger files show their size and are in the zip. */
export const VIEW_MAX_BYTES = 512 * 1024;

export interface CaptureFile {
  file: string;
  sha: string;
  size: number;
  content: Buffer;
}

export interface CaptureDeps {
  knownFiles(productId: string): Promise<VersionFile[]>;
  put(key: string, content: Buffer): Promise<string>;
  saveVersion(row: { buildId: string; productId: string; files: VersionFile[]; bytes: number; restoredFrom: string | null }): Promise<void>;
}

const liveCaptureDeps: CaptureDeps = {
  knownFiles: async (productId) => {
    const rows = await db().select({ files: schema.productVersions.files }).from(schema.productVersions).where(eq(schema.productVersions.productId, productId));
    return rows.flatMap((r) => r.files);
  },
  put: (key, content) => putExactFile(key, content, "application/octet-stream"),
  saveVersion: async (row) => {
    await db()
      .insert(schema.productVersions)
      .values(row)
      .onConflictDoUpdate({ target: schema.productVersions.buildId, set: { files: row.files, bytes: row.bytes, restoredFrom: row.restoredFrom } });
  },
};

/**
 * Saves what is about to deploy as this build's version. Stored files are written first and the row last, so a row never
 * names a file that isn't there, and a retry overwrites the same row. Never throws: a version going unsaved must not
 * stop a deploy, and its commit then says the source wasn't kept.
 */
export async function captureVersion(
  input: { buildId: string; productId: string; files: readonly CaptureFile[]; restoredFrom?: string | null },
  deps: CaptureDeps = liveCaptureDeps,
): Promise<boolean> {
  try {
    const kept = input.files.filter((f) => !isHiddenPath(f.file));
    if (kept.length > MAX_FILES) throw new Error(`${kept.length} files, more than ${MAX_FILES}`);
    const known = new Map((await deps.knownFiles(input.productId)).filter((f) => f.url).map((f) => [f.sha, f.url as string]));
    const list: VersionFile[] = [];
    const queue = [...kept];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        if (holdsSecret(f.content)) {
          list.push({ path: f.file, sha: f.sha, size: f.size, held: true });
          continue;
        }
        let url = known.get(f.sha);
        if (!url) {
          url = await deps.put(`source/${input.productId}/${f.sha}`, f.content);
          known.set(f.sha, url);
        }
        list.push({ path: f.file, sha: f.sha, size: f.size, url });
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    list.sort((a, b) => a.path.localeCompare(b.path));
    await deps.saveVersion({ buildId: input.buildId, productId: input.productId, files: list, bytes: list.reduce((s, f) => s + f.size, 0), restoredFrom: input.restoredFrom ?? null });
    return true;
  } catch (err) {
    console.error(`[versions] build ${input.buildId} wasn't saved:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** A saved file's bytes, checked against its SHA-1 and for secrets again, or null when it can't be shown. */
export async function readVersionFile(file: VersionFile): Promise<Buffer | null> {
  if (file.held || !file.url || isHiddenPath(file.path)) return null;
  const content = await fetchBytes(file.url);
  if (sha1(content) !== file.sha) throw new Error(`${file.path} doesn't match its saved SHA-1`);
  return holdsSecret(content) ? null : content;
}

/** A saved file as text to show, or why it can't be. */
export async function readVersionText(file: VersionFile): Promise<{ text: string } | { why: "held" | "big" | "binary" }> {
  if (file.held) return { why: "held" };
  if (file.size > VIEW_MAX_BYTES) return { why: "big" };
  const content = await readVersionFile(file);
  if (!content) return { why: "held" };
  return isText(content) ? { text: content.toString("utf8") } : { why: "binary" };
}

/** Every build of a product, for its commit list. Only what the product page's Versions list and /b already show. */
export async function productCommitBuilds(productId: string): Promise<CommitBuild[]> {
  return db()
    .select({
      id: schema.builds.id,
      kind: schema.builds.kind,
      status: schema.builds.status,
      message: schema.builds.message,
      startedAt: schema.builds.startedAt,
      costUsd: schema.builds.costUsd,
    })
    .from(schema.builds)
    .where(eq(schema.builds.productId, productId))
    .orderBy(asc(schema.builds.startedAt));
}

export interface SavedVersion {
  buildId: string;
  files: VersionFile[];
  bytes: number;
  restoredFrom: string | null;
}

/** The builds of a product that have saved source. */
export async function keptBuildIds(productId: string): Promise<Set<string>> {
  const rows = await db().select({ id: schema.productVersions.buildId }).from(schema.productVersions).where(eq(schema.productVersions.productId, productId));
  return new Set(rows.map((r) => r.id));
}

export async function versionOf(productId: string, buildId: string): Promise<SavedVersion | null> {
  const [row] = await db()
    .select({ buildId: schema.productVersions.buildId, files: schema.productVersions.files, bytes: schema.productVersions.bytes, restoredFrom: schema.productVersions.restoredFrom })
    .from(schema.productVersions)
    .where(and(eq(schema.productVersions.productId, productId), eq(schema.productVersions.buildId, buildId)))
    .limit(1);
  return row ?? null;
}

/**
 * A version's files as one zip, under what a function's response can carry. Held files and whatever doesn't fit (biggest
 * first) are left out and named in LEFT_OUT.txt, so a download is never silently short.
 */
export async function versionZip(files: readonly VersionFile[]): Promise<Buffer> {
  const wanted = visibleFiles(files).sort((a, b) => a.size - b.size);
  const entries: ZipEntry[] = [];
  const leftOut: string[] = [];
  let total = 0;
  const reading: VersionFile[] = [];
  for (const f of wanted) {
    if (f.held) leftOut.push(`${f.path} (looks like it holds a secret)`);
    else if (reading.length >= ZIP_MAX_FILES || total + f.size > ZIP_MAX_UNPACKED) leftOut.push(`${f.path} (too big for one download)`);
    else {
      total += f.size;
      reading.push(f);
    }
  }
  const queue = [...reading];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const content = await readVersionFile(f);
      if (content) entries.push({ path: f.path, content });
      else leftOut.push(`${f.path} (looks like it holds a secret)`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const build = () => makeZip(leftOut.length ? [...entries, { path: "LEFT_OUT.txt", content: `Left out of this download:\n${leftOut.join("\n")}\n` }] : entries);
  const sizes = new Map(reading.map((f) => [f.path, f.size]));
  let zip = build();
  while (zip.length > SOURCE_ZIP_MAX_BYTES && entries.length) {
    // Drop the biggest file, or a quarter of them when far over, then make it again.
    const over = zip.length > SOURCE_ZIP_MAX_BYTES * 2;
    entries.sort((a, b) => (sizes.get(a.path) ?? 0) - (sizes.get(b.path) ?? 0));
    for (const e of entries.splice(over ? -Math.ceil(entries.length / 4) : -1)) leftOut.push(`${e.path} (too big for one download)`);
    zip = build();
  }
  return zip;
}
