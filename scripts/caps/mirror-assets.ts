/**
 * Mirrors the vetted large files in lib/caps/assets.json to Blob, so GET {GATEWAY_URL}/assets/<sha256> can serve them
 * (docs/CAPABILITIES.md, section 14).
 *
 *   npx tsx scripts/caps/mirror-assets.ts                      check every source: download, size, sha256 (no upload)
 *   npx tsx --env-file=.env.local scripts/caps/mirror-assets.ts --apply
 *     --from DIR    read files from DIR/<name> instead of downloading them (each is still checked)
 *     --only NAME   one file
 *     --apply       upload each checked file to Blob at assets/<sha256> and write its URL into lib/caps/assets.json as
 *                   mirror (commit that change). With no Blob store (a local run) the files go to .data/files instead,
 *                   where the local gateway serves them, and the list is left as it is.
 *
 * A source ending in "#package/<path>" is a file inside an npm tarball. A file whose size or sha256 doesn't match the
 * list is never uploaded. Blob credentials come from the env as lib/storage.ts reads them; nothing secret is printed.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { assetBlobPath, vettedAssets, type VettedAsset } from "@/lib/caps/media/assets";
import { env } from "@/lib/env";
import { localFilesEnabled } from "@/lib/local-files";
import { localFilePaths, putBlobAt } from "@/lib/storage";

const LIST = path.join(process.cwd(), "lib/caps/assets.json");

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
}

/** One file out of a .tgz, by its path inside the tarball (ustar, as npm packs). */
export function fileFromTarball(tgz: Buffer, inner: string): Buffer | null {
  const tar = gunzipSync(tgz);
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, len: number) => header.toString("utf8", start, start + len).replace(/\0.*$/s, "");
    const name = `${field(345, 155) ? `${field(345, 155)}/` : ""}${field(0, 100)}`;
    const size = parseInt(field(124, 12).trim() || "0", 8);
    if (name === inner) return Buffer.from(tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function bytesFor(asset: VettedAsset, from: string | undefined): Promise<Buffer> {
  if (from) return readFileSync(path.join(from, asset.name));
  const [url, inner] = asset.source.split("#");
  const body = await download(url!);
  if (!inner) return body;
  const file = fileFromTarball(body, inner);
  if (!file) throw new Error(`${inner} isn't in ${url}`);
  return file;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const from = arg("--from");
  const only = arg("--only");
  const raw = JSON.parse(readFileSync(LIST, "utf8")) as { assets: VettedAsset[] };
  const assets = vettedAssets(raw).filter((a) => !only || a.name === only);
  if (!assets.length) throw new Error(only ? `No asset named ${only}.` : "The list is empty.");
  const local = localFilesEnabled();
  if (apply && !local && !env.blobConfigured) throw new Error("No Blob store is configured, so nothing can be uploaded.");
  let failed = 0;
  for (const a of assets) {
    try {
      const bytes = await bytesFor(a, from);
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== a.bytes || sha !== a.sha256) throw new Error(`got ${bytes.length} bytes with sha256 ${sha}, the list says ${a.bytes} and ${a.sha256}`);
      if (!apply) {
        console.log(`ok      ${a.name} (${(a.bytes / 1e6).toFixed(1)} MB, ${a.license})`);
        continue;
      }
      if (local) {
        const { file, type } = localFilePaths(assetBlobPath(a.sha256));
        mkdirSync(path.dirname(file), { recursive: true });
        mkdirSync(path.dirname(type), { recursive: true });
        writeFileSync(file, bytes);
        writeFileSync(type, a.contentType);
        console.log(`local   ${a.name} -> .data/files/data/${assetBlobPath(a.sha256)}`);
      } else {
        const url = await putBlobAt(assetBlobPath(a.sha256), bytes, a.contentType);
        const entry = raw.assets.find((x) => x.sha256 === a.sha256)!;
        entry.mirror = url;
        console.log(`mirror  ${a.name} -> ${url}`);
      }
    } catch (err) {
      failed++;
      console.error(`FAILED  ${a.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (apply && !local) {
    writeFileSync(LIST, `${JSON.stringify(raw, null, 2)}\n`);
    console.log("Wrote the mirror URLs into lib/caps/assets.json. Commit it with the deploy that serves them.");
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
