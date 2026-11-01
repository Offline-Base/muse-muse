/**
 * Builds a flash drive's image for one model (docs/VIBE_TUNING.md, Feature 6, "What goes on the drive"): Start Here.html,
 * the launchers, the pinned llama.cpp runtime for macOS arm64 and Windows, the licenses, CHANGES.md and the model card,
 * from the model's local files. The bench script builds one for every stick on its own; this is for looking at an image,
 * or for trying a whole drive from a folder on a real Mac or PC before any stick is bought.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/drive-image.ts --job <training job id> --out <empty folder>
 *   npx tsx scripts/drive-image.ts --from <local files .json> --out <empty folder> [--build all|Q3_K_M|Q4_K_M|Q6_K]
 *       [--models <folder holding the GGUF files>] [--serial <text>] [--cache <folder>]
 *
 * --job reads the model's local files from the database (localFilesFor, so DATABASE_URL); --from reads the same shape
 * from a JSON file. With --models it also copies the GGUF files in, each checked against its sha256, and writes
 * PROVENANCE.json and SHA256SUMS, so the folder is a whole drive. Downloads (llama.cpp from GitHub, Meta's license and
 * Usage Policy and the model card from Hugging Face, public and with no token) are checked against their pins and kept
 * in the cache (~/MuseMuseDrives by default).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { copyWithProgress } from "@/lib/drive/bench";
import { buildDriveImage, modelPath, sha256File, writeManifestFiles, type ImageModel } from "@/lib/drive/image";
import { filesForBuild, gb, isDriveBuild } from "@/lib/drive/logic";
import { env } from "@/lib/env";
import type { LocalFiles } from "@/lib/train/local-files";

async function localFiles(job: string | undefined, from: string | undefined): Promise<LocalFiles> {
  if (from) return JSON.parse(await fs.readFile(from, "utf8")) as LocalFiles;
  if (!job) throw new Error("Pass --job <training job id> or --from <local files .json>.");
  const { localFilesFor } = await import("@/lib/train/local-files-server");
  const files = await localFilesFor(job);
  if (!files) throw new Error(`Training job ${job} has no local files that passed their checks.`);
  return files;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      job: { type: "string" },
      from: { type: "string" },
      out: { type: "string" },
      build: { type: "string", default: "all" },
      models: { type: "string" },
      serial: { type: "string", default: "TEST" },
      cache: { type: "string" },
    },
  });
  if (!values.out) throw new Error("Pass --out <empty folder>.");
  if (!isDriveBuild(values.build)) throw new Error("--build is all, Q3_K_M, Q4_K_M or Q6_K.");
  const lf = await localFiles(values.job, values.from);
  if (!lf.repo || !lf.commit) throw new Error("These local files aren't on Hugging Face at a commit yet.");
  const files = filesForBuild(lf.files, values.build);
  if (!files) throw new Error(`The ${values.build} build didn't pass its checks for this model.`);
  const model: ImageModel = {
    title: lf.title,
    slug: lf.slug,
    systemLine: lf.systemLine,
    needsTunedTemplate: lf.needsTunedTemplate,
    quantJobId: lf.quantJobId,
    ...(lf.sparkOpen ? { sparkOpen: true } : {}),
    adapterJobId: lf.adapterJobId,
    repo: lf.repo,
    commit: lf.commit,
    files,
  };
  const out = path.resolve(values.out);
  const cacheDir = values.cache ? path.resolve(values.cache) : path.join(os.homedir(), "MuseMuseDrives");
  const manifest = await buildDriveImage(model, { outDir: out, cacheDir, log: (l) => console.log(l), contact: env.driveContactEmail });
  const imageBytes = manifest.files.reduce((n, f) => n + f.bytes, 0);
  console.log(`The image is in ${out}: ${manifest.files.length} files, ${gb(imageBytes)}, image ${manifest.imageVersion}.`);

  if (!values.models) {
    console.log("Add --models <folder> to copy the GGUF files in too and write PROVENANCE.json and SHA256SUMS.");
    return;
  }
  for (const f of files) {
    const from = path.join(path.resolve(values.models), f.name);
    console.log(`Checking ${f.name} against its sha256.`);
    if ((await sha256File(from)) !== f.sha256) throw new Error(`${from} doesn't match the sha256 its repo lists.`);
    await copyWithProgress(from, path.join(out, modelPath(f)));
  }
  const { manifestSha256 } = await writeManifestFiles(out, manifest, model, values.serial);
  console.log(`A whole drive is in ${out}. SHA256SUMS sha256 ${manifestSha256}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
