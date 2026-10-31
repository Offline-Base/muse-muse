/**
 * The drive's image (docs/VIBE_TUNING.md, Feature 6, "What goes on the drive"): every file on the stick but the model
 * files, for one model. It is put together from the model's local files (localFilesFor, or an order's saved copy of
 * them), the launchers and pages in drive/, one pinned llama.cpp build for macOS arm64 and Windows x64, Meta's license
 * and Usage Policy (verbatim, pinned), the GGUF repo's model card at the files' commit, and CHANGES.md. Every download
 * is checked against its pinned sha256 before it is used, and the launchers never download anything themselves.
 * scripts/drive-image.ts and scripts/drive-bench.ts call it; lib/drive/__tests__/image.test.ts fakes its downloads.
 *
 * Since drive export (docs/DRIVE_EXPORT.md), the image is the kit (lib/drive/kit.ts) and a plan (lib/drive/plan.ts)
 * written into a folder, the same layout a board writes onto a stick. A bench drive comes out byte for byte as it did
 * before the split: lib/drive/__tests__/plan.test.ts checks it against golden/bench-image.json.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { collectKit, listFiles, sha256File, systemExtract, type Extract, type FetchLike } from "@/lib/drive/kit";
import { META_FILES, modelPath, RUNTIME_PIN, sha256Sums, type ImageManifest, type ImageModel, type PinnedText, type RuntimePin } from "@/lib/drive/layout";
import { DRIVE_SOURCE_DIR, orderModel, planDriveImage, readDriveTemplates, writePlan } from "@/lib/drive/plan";

export {
  buildForText,
  changesText,
  contactText,
  launcherTable,
  META_FILES,
  modelPageUrl,
  modelPath,
  RUNTIME_PIN,
  runtimeUrl,
  sha256Sums,
  type ImageManifest,
  type ImageModel,
  type RuntimePin,
} from "@/lib/drive/layout";
export { fetchPinned, listFiles, sha256File, systemExtract, type Extract, type FetchLike } from "@/lib/drive/kit";
export { DRIVE_SOURCE_DIR } from "@/lib/drive/plan";

/** Text from the Hub at the files' commit, which needs no token since the repo is public. */
async function fetchText(fetchImpl: FetchLike, url: string): Promise<string> {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Couldn't read ${url}: HTTP ${res.status}.`);
  return res.text();
}

export interface ImageOptions {
  /** An empty or missing folder to fill. */
  outDir: string;
  /** Where downloads are kept between images, so each is fetched once. */
  cacheDir: string;
  sourceDir?: string;
  fetchImpl?: FetchLike;
  extract?: Extract;
  pin?: RuntimePin;
  metaFiles?: ReadonlyArray<PinnedText>;
  log?: (line: string) => void;
  /** Where the buyer writes about the drive (DRIVE_CONTACT_EMAIL), or null: the drive then says to reply to the invoice. */
  contact?: string | null;
}

/**
 * Builds the image of one model into `outDir`: Start Here.html, the launchers and verify scripts, support/ (the build
 * table, the file list and the model's facts), model/ without the GGUF files (the system message, the chat's preset
 * settings, tuned.jinja for an old adapter), runtime/ (llama.cpp for macOS arm64, Windows Vulkan and Windows CPU, each
 * with its license), licenses/, MODEL_CARD.md and README.txt. Returns the manifest the bench writes PROVENANCE.json and
 * SHA256SUMS from.
 */
export async function buildDriveImage(model: ImageModel, opts: ImageOptions): Promise<ImageManifest> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pin = opts.pin ?? RUNTIME_PIN;
  const out = opts.outDir;
  if ((await fs.stat(out).then(() => true, () => false)) && (await fs.readdir(out)).length) {
    throw new Error(`${out} isn't empty. The image goes into an empty folder.`);
  }
  if (!model.files.length) throw new Error("The order has no model files.");
  await fs.mkdir(out, { recursive: true });

  const { kit, fileOf } = await collectKit({
    cacheDir: opts.cacheDir,
    fetchImpl,
    extract: opts.extract ?? systemExtract,
    pin,
    metaFiles: opts.metaFiles ?? META_FILES,
    families: ["glimmer"],
    log: opts.log,
  });

  // From the GGUF repo at the files' commit: the card, and tuned.jinja for an adapter trained before trainChannel.
  const raw = (name: string) => `https://huggingface.co/${model.repo}/raw/${model.commit}/${name}`;
  const card = await fetchText(fetchImpl, raw("README.md"));
  const tuned = model.needsTunedTemplate ? await fetchText(fetchImpl, raw("tuned.jinja")) : null;

  const templates = await readDriveTemplates(opts.sourceDir ?? DRIVE_SOURCE_DIR);
  const plan = planDriveImage(orderModel(model, card, tuned, opts.contact, pin), kit, templates);
  await writePlan(plan.files, out, { kitFile: fileOf });

  const files: ImageManifest["files"] = [];
  for (const rel of await listFiles(out)) {
    const full = path.join(out, rel);
    files.push({ path: rel, bytes: (await fs.stat(full)).size, sha256: await sha256File(full) });
  }
  return {
    imageVersion: plan.imageVersion,
    model: { title: model.title, slug: model.slug, adapterJobId: model.adapterJobId, quantJobId: model.quantJobId, repo: model.repo, commit: model.commit },
    runtime: kit.runtime,
    sources: plan.sources,
    files,
  };
}

// ---------- PROVENANCE.json and SHA256SUMS ----------

/**
 * PROVENANCE.json for one stick: its serial, the image, and where every file came from (the GGUF repo and commit of each
 * model file with its sha256, the llama.cpp build and its assets' sha256, Meta's files, the card).
 */
export function provenanceOf(manifest: ImageManifest, model: ImageModel, serial: string, madeAt: Date): string {
  const doc = {
    serial,
    madeAt: madeAt.toISOString(),
    imageVersion: manifest.imageVersion,
    model: manifest.model,
    files: model.files.map((f) => ({
      path: modelPath(f),
      bytes: f.bytes,
      sha256: f.sha256,
      source: `https://huggingface.co/${model.repo}/resolve/${model.commit}/${f.name}`,
    })),
    runtime: manifest.runtime,
    sources: manifest.sources,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Writes PROVENANCE.json and SHA256SUMS into a folder that holds the image and the model files (a stick, or a folder
 * standing in for one). Every file is listed: the image's, the model files with the order's sha256, and PROVENANCE.json.
 * Returns the sha256 of SHA256SUMS, which the bench reports.
 */
export async function writeManifestFiles(
  dir: string,
  manifest: ImageManifest,
  model: ImageModel,
  serial: string,
  madeAt = new Date(),
): Promise<{ manifestSha256: string; entries: Array<{ path: string; sha256: string; bytes: number }> }> {
  const provenance = provenanceOf(manifest, model, serial, madeAt);
  await fs.writeFile(path.join(dir, "PROVENANCE.json"), provenance);
  const entries = [
    ...manifest.files,
    ...model.files.map((f) => ({ path: modelPath(f), bytes: f.bytes, sha256: f.sha256 })),
    { path: "PROVENANCE.json", bytes: Buffer.byteLength(provenance), sha256: createHash("sha256").update(provenance).digest("hex") },
  ];
  const sums = sha256Sums(entries);
  await fs.writeFile(path.join(dir, "SHA256SUMS"), sums);
  return { manifestSha256: createHash("sha256").update(sums).digest("hex"), entries };
}
