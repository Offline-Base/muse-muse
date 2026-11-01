/**
 * Checks, and with --apply mirrors to Blob, the files cap's vetted sets (docs/CAPABILITIES.md, section 10):
 *   - the public datasets in lib/caps/files/datasets.json, to datasets/<id>/<file>, which GET {GATEWAY_URL}/datasets
 *     serves; their Blob URLs are written back into the list as `mirror`
 *   - the CC0 3D set in lib/caps/files/models3d.json ("CC0 asset manifest, v1", agreed with tg-3d), to the paths it
 *     names under 3d/, then 3d/manifest.json (the list without its download addresses)
 *
 *   npx tsx scripts/caps/mirror-datasets.ts                     check every file: download, size, sha256, the 3D rules
 *   npx tsx --env-file=.env.local scripts/caps/mirror-datasets.ts --apply
 *     --from DIR    read files from DIR/<dataset id>/<file> or DIR/<3d path> instead of downloading them
 *     --only ID     one dataset or 3D asset
 *     --apply       upload what passed. With no Blob store (a local run) the files go to .data/files instead, where the
 *                   local gateway serves them, and the lists are left as they are
 *
 * Nothing that fails a check is uploaded, and an upload happens only with --apply. Blob credentials come from the env as
 * lib/storage.ts reads them; nothing secret is printed.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { datasetBlobPath, vettedDatasets, type Dataset } from "@/lib/caps/files/datasets";
import { assetFileProblems, publishedManifest, vetted3dAssets, type Asset3d, type AssetFile } from "@/lib/caps/files/models3d";
import { env } from "@/lib/env";
import { localFilesEnabled } from "@/lib/local-files";
import { localFilePaths, putBlobAt } from "@/lib/storage";

const DATASETS = path.join(process.cwd(), "lib/caps/files/datasets.json");
const MODELS = path.join(process.cwd(), "lib/caps/files/models3d.json");
const MANIFEST_PATH = "3d/manifest.json";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const TYPES: Record<string, string> = { glb: "model/gltf-binary", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", hdr: "image/vnd.radiance" };
const typeOf3d = (p: string) => TYPES[p.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

/** Puts one file where the gateway reads it: Blob at exactly `pathname`, or .data/files on a local run. */
async function store(pathname: string, bytes: Buffer, contentType: string, local: boolean): Promise<string> {
  if (local) {
    const { file, type } = localFilePaths(pathname);
    mkdirSync(path.dirname(file), { recursive: true });
    mkdirSync(path.dirname(type), { recursive: true });
    writeFileSync(file, bytes);
    writeFileSync(type, contentType);
    return `.data/files/data/${pathname}`;
  }
  return putBlobAt(pathname, bytes, contentType);
}

export async function checkDataset(d: Dataset, from: string | undefined): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const f of d.files) {
    const bytes = from ? readFileSync(path.join(from, d.id, f.name)) : await download(f.download);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== f.bytes || sha !== f.sha256) throw new Error(`${f.name}: got ${bytes.length} bytes with sha256 ${sha}, the list says ${f.bytes} and ${f.sha256}`);
    out.set(f.name, bytes);
  }
  return out;
}

export async function check3d(a: Asset3d, from: string | undefined): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const read = async (f: AssetFile) => {
    const bytes = from ? readFileSync(path.join(from, f.path)) : await download(f.download!);
    out.set(f.path, bytes);
    return bytes;
  };
  const problems = await assetFileProblems(a, read);
  if (problems.length) throw new Error(problems.join(" "));
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const from = arg("--from");
  const only = arg("--only");
  const rawDatasets = JSON.parse(readFileSync(DATASETS, "utf8")) as { datasets: Dataset[] };
  const rawModels = JSON.parse(readFileSync(MODELS, "utf8")) as { assets: Asset3d[] };
  const datasets = vettedDatasets(rawDatasets).filter((d) => !only || d.id === only);
  const assets = vetted3dAssets(rawModels).filter((a) => !only || a.id === only);
  if (!datasets.length && !assets.length) throw new Error(only ? `No dataset or 3D asset called ${only}.` : "Both lists are empty.");
  const local = localFilesEnabled();
  if (apply && !local && !env.blobConfigured) throw new Error("No Blob store is configured, so nothing can be uploaded.");
  let failed = 0;
  for (const d of datasets) {
    try {
      const files = await checkDataset(d, from);
      if (!apply) {
        console.log(`ok      dataset ${d.id} (${d.files.length} file${d.files.length === 1 ? "" : "s"}, ${d.license.spdx})`);
        continue;
      }
      for (const f of d.files) {
        const where = await store(datasetBlobPath(d.id, f.name), files.get(f.name)!, f.contentType, local);
        if (!local) rawDatasets.datasets.find((x) => x.id === d.id)!.files.find((x) => x.name === f.name)!.mirror = where;
        console.log(`${local ? "local " : "mirror"}  ${d.id}/${f.name} -> ${where}`);
      }
    } catch (err) {
      failed++;
      console.error(`FAILED  dataset ${d.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const passed: Asset3d[] = [];
  for (const a of assets) {
    try {
      const files = await check3d(a, from);
      passed.push(a);
      if (!apply) {
        console.log(`ok      3d ${a.id} (${a.kind}, ${a.files.length} files, CC0)`);
        continue;
      }
      for (const f of a.files) console.log(`${local ? "local " : "mirror"}  ${f.path} -> ${await store(f.path, files.get(f.path)!, typeOf3d(f.path), local)}`);
    } catch (err) {
      failed++;
      console.error(`FAILED  3d ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (apply) {
    // The manifest lists only what is up, and only a whole run's: with --only it keeps the assets already listed.
    if (assets.length && !failed && !only) {
      const manifest = `${JSON.stringify(publishedManifest(passed), null, 2)}\n`;
      console.log(`${local ? "local " : "mirror"}  ${MANIFEST_PATH} -> ${await store(MANIFEST_PATH, Buffer.from(manifest), "application/json", local)}`);
    }
    if (!local && datasets.length) {
      writeFileSync(DATASETS, `${JSON.stringify(rawDatasets, null, 2)}\n`);
      console.log("Wrote the mirror URLs into lib/caps/files/datasets.json. Commit it with the deploy that serves them.");
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
