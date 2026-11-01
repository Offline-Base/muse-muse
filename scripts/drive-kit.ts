/**
 * Builds the drive kit (lib/drive/kit.ts) a board writes onto every drive it exports, and lists it in
 * lib/drive/kit-files.json: llama.cpp's server and libraries for macOS arm64 and Windows, its MIT license, LLVM's OpenMP
 * license, Meta's license and Usage Policy, and Qwen's license, each checked against its pin. It downloads only public
 * files, about 64 MB once, into a cache (~/MuseMuseDrives by default, as the bench does).
 *
 * With --upload it also puts every file on public Blob under drive-kit/<sha256>, skipping any already there, and records
 * the folder's URL in kit-files.json, which is what a board's export fetches the kit from. That writes to the site's Blob
 * store, so the owner runs it, once per image version:
 *
 *   npx tsx scripts/drive-kit.ts [--cache <folder>]
 *   npx tsx --env-file-if-exists=.env.local scripts/drive-kit.ts --upload
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { head, put } from "@vercel/blob";
import { collectKit, KIT_FILES_JSON, kitBlobPath, type DriveKit } from "@/lib/drive/kit";
import { blobAuth } from "@/lib/storage";

async function upload(kit: DriveKit, fileOf: (sha256: string) => string): Promise<string> {
  let base: string | null = null;
  const unique = [...new Map(kit.files.map((f) => [f.sha256, f])).values()];
  for (const [i, f] of unique.entries()) {
    const pathname = kitBlobPath(f.sha256);
    const existing = await head(pathname, blobAuth()).catch(() => null);
    const url =
      existing?.url ??
      (
        await put(pathname, await fs.readFile(fileOf(f.sha256)), {
          access: "public",
          addRandomSuffix: false,
          contentType: "application/octet-stream",
          ...blobAuth(),
        })
      ).url;
    const folder = url.slice(0, url.length - f.sha256.length);
    if (!url.endsWith(`/drive-kit/${f.sha256}`) || (base && folder !== base)) throw new Error(`Blob put ${pathname} somewhere unexpected.`);
    base = folder;
    console.log(`${i + 1}/${unique.length} ${existing ? "already there" : "uploaded"}: ${f.path}`);
  }
  if (!base) throw new Error("The kit has no files.");
  return base;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { cache: { type: "string" }, upload: { type: "boolean", default: false } } });
  const cacheDir = values.cache ?? path.join(os.homedir(), "MuseMuseDrives");
  const { kit, fileOf } = await collectKit({ cacheDir, families: ["glimmer", "qwen"], log: (line) => console.log(line) });
  const previous = JSON.parse(await fs.readFile(KIT_FILES_JSON, "utf8").catch(() => "null")) as DriveKit | null;
  const baseUrl = values.upload ? await upload(kit, fileOf) : previous?.imageVersion === kit.imageVersion ? previous.baseUrl : null;
  await fs.writeFile(KIT_FILES_JSON, `${JSON.stringify({ ...kit, baseUrl }, null, 2)}\n`);
  const bytes = [...new Map(kit.files.map((f) => [f.sha256, f.bytes])).values()].reduce((n, b) => n + b, 0);
  console.log(`Wrote ${path.relative(process.cwd(), KIT_FILES_JSON)}: ${kit.files.length} files, ${(bytes / 1e6).toFixed(1)} MB once each, image ${kit.imageVersion}.`);
  console.log(baseUrl ? `Uploaded to ${baseUrl}` : "Not uploaded: run it again with --upload before a board can export.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
