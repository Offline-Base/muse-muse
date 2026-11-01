/**
 * The drive kit (docs/DRIVE_EXPORT.md, "The drive plan"): the files every drive of an image version shares, whatever the
 * model. That is llama.cpp's server and the libraries it loads for macOS arm64, Windows Vulkan and Windows CPU, each with
 * llama.cpp's MIT license, LLVM's OpenMP license beside the Windows builds, and the base model's license by family:
 * Meta's Apache 2.0 text and Usage Policy for Muse Glimmer, the Llama 3.2 license and policy for the board's Llama 3.2 1B.
 *
 * collectKit downloads each pinned file once, checks its sha256, unpacks the archives and keeps one copy of every file
 * under <cache>/kit/<sha256>. The bench writes its drives from there (lib/drive/image.ts). scripts/drive-kit.ts lists the
 * same files in lib/drive/kit-files.json and puts them on public Blob under drive-kit/<sha256>, where a board fetches each
 * one once per image version. Every file in the kit is public material, so its URLs are no secret.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { DRIVE_IMAGE_VERSION } from "@/lib/drive/logic";
import { keepFromArchive, META_FILES, LLAMA_FILES, RUNTIME_PIN, runtimeUrl, type ImageManifest, type PinnedText, type RuntimePin } from "@/lib/drive/layout";

const run = promisify(execFile);

/** Whose license a kit file is. "common" goes on every drive; the others only beside a model of that family. */
export type BaseFamily = "glimmer" | "llama";
export type KitFamily = "common" | BaseFamily;

export interface KitFile {
  /** Where it goes on the drive, relative to the drive's folder. */
  path: string;
  bytes: number;
  sha256: string;
  family: KitFamily;
  /** The macOS server, which has to run. */
  exec?: true;
}

/** Where a kit file's bytes came from, for PROVENANCE.json: the release archive or the license at its commit. */
export interface KitSource {
  path: string;
  url: string;
  sha256: string;
  family: KitFamily;
}

export interface DriveKit {
  imageVersion: string;
  runtime: ImageManifest["runtime"];
  files: KitFile[];
  sources: KitSource[];
  /**
   * The public Blob folder the kit was uploaded to, ending in "drive-kit/", or null before scripts/drive-kit.ts --upload
   * has run. A kit file's URL is this plus its sha256.
   */
  baseUrl: string | null;
}

// ---------- Files ----------

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Downloads `url` to `dest` unless `dest` already holds the pinned bytes, checking the sha256 as it streams. A download
 * that doesn't match is deleted, never used.
 */
export async function fetchPinned(fetchImpl: FetchLike, url: string, sha256: string, dest: string): Promise<void> {
  if ((await exists(dest)) && (await sha256File(dest)) === sha256) return;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Couldn't download ${url}: HTTP ${res.status}.`);
  const part = `${dest}.part`;
  const hash = createHash("sha256");
  const tap = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), tap, createWriteStream(part));
  const got = hash.digest("hex");
  if (got !== sha256) {
    await fs.rm(part, { force: true });
    throw new Error(`The download of ${url} didn't match its pinned sha256 (got ${got.slice(0, 12)}), so it wasn't used.`);
  }
  await fs.rename(part, dest);
}

export type Extract = (archive: string, intoDir: string) => Promise<void>;

/** The bench's Mac: its tar (bsdtar) unpacks the .tar.gz and the .zip archives alike, refusing paths outside intoDir. */
export const systemExtract: Extract = async (archive, intoDir) => {
  await run("/usr/bin/tar", ["-xf", archive, "-C", intoDir]);
};

/** Every file under `dir`, as paths relative to it with forward slashes, sorted. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string) {
    for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else out.push(child);
    }
  }
  await walk("");
  return out.sort();
}

// ---------- Collecting the kit ----------

export interface KitOptions {
  /** Where downloads and the kit's files are kept between images, so each is fetched once. */
  cacheDir: string;
  fetchImpl?: FetchLike;
  extract?: Extract;
  pin?: RuntimePin;
  metaFiles?: ReadonlyArray<PinnedText>;
  llamaFiles?: ReadonlyArray<PinnedText>;
  /** The license families to bring besides the runtime. The bench needs only Glimmer's. */
  families?: readonly BaseFamily[];
  log?: (line: string) => void;
}

export interface CollectedKit {
  kit: DriveKit;
  /** The cached copy of a kit file, by its sha256. */
  fileOf: (sha256: string) => string;
}

/**
 * Downloads, checks and unpacks every file of the kit into `<cacheDir>/kit/<sha256>`. The runtime comes first, archive
 * by archive, then each family's licenses, the same order and the same errors the bench always had.
 */
export async function collectKit(opts: KitOptions): Promise<CollectedKit> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const extract = opts.extract ?? systemExtract;
  const pin = opts.pin ?? RUNTIME_PIN;
  const families = opts.families ?? ["glimmer"];
  const log = opts.log ?? (() => {});
  const store = path.join(opts.cacheDir, "kit");
  const fileOf = (sha256: string) => path.join(store, sha256);
  await fs.mkdir(store, { recursive: true });
  const files: KitFile[] = [];
  const sources: KitSource[] = [];

  const keep = async (rel: string, data: Buffer, family: KitFamily, exec = false) => {
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (!(await exists(fileOf(sha256)))) {
      const part = `${fileOf(sha256)}.part`;
      await fs.writeFile(part, data);
      await fs.rename(part, fileOf(sha256));
    }
    files.push({ path: rel, bytes: data.length, sha256, family, ...(exec ? { exec: true as const } : {}) });
  };

  // The runtime: each archive checked against its pin, unpacked, and only what the server needs kept.
  const licenses: Record<string, Buffer> = {};
  for (const asset of pin.assets) {
    const url = runtimeUrl(pin, asset.name);
    const archive = path.join(opts.cacheDir, "llama.cpp", pin.build, asset.name);
    log(`llama.cpp ${pin.build}: ${asset.name}`);
    await fetchPinned(fetchImpl, url, asset.sha256, archive);
    const unpacked = await fs.mkdtemp(path.join(opts.cacheDir, "unpack-"));
    try {
      await extract(archive, unpacked);
      const root = await fs.realpath(unpacked);
      const kept: string[] = [];
      for (const rel of await listFiles(unpacked)) {
        const name = path.basename(rel);
        if (!keepFromArchive(asset.runtime, name)) continue;
        const real = await fs.realpath(path.join(unpacked, rel));
        if (!real.startsWith(root + path.sep) || !(await fs.stat(real)).isFile()) throw new Error(`${asset.name} has ${rel} pointing outside it.`);
        if (name.startsWith("LICENSE")) {
          licenses[name] = await fs.readFile(real);
          continue;
        }
        const server = name === "llama-server" && asset.runtime === "macos-arm64";
        await keep(`runtime/${asset.runtime}/${name}`, await fs.readFile(real), "common", server);
        kept.push(name);
      }
      const server = asset.runtime === "macos-arm64" ? "llama-server" : "llama-server.exe";
      if (!kept.includes(server)) throw new Error(`${asset.name} has no ${server}.`);
    } finally {
      await fs.rm(unpacked, { recursive: true, force: true });
    }
    sources.push({ path: `runtime/${asset.runtime}/`, url, sha256: asset.sha256, family: "common" });
  }
  const mit = licenses.LICENSE;
  if (!mit) throw new Error(`llama.cpp ${pin.build}'s macOS archive has no LICENSE.`);
  for (const asset of pin.assets) await keep(`runtime/${asset.runtime}/LICENSE`, mit, "common");
  await keep("licenses/llama.cpp-LICENSE.txt", mit, "common");
  if (licenses["LICENSE-LLVM-OpenMP"]) {
    // The Windows builds load LLVM's OpenMP library, whose license travels with it.
    await keep("licenses/LLVM-OpenMP-LICENSE.txt", licenses["LICENSE-LLVM-OpenMP"], "common");
    for (const asset of pin.assets) {
      if (asset.runtime !== "macos-arm64") await keep(`runtime/${asset.runtime}/LICENSE-LLVM-OpenMP`, licenses["LICENSE-LLVM-OpenMP"], "common");
    }
  }

  // Each family's license text, verbatim, from its repo at the pinned commit.
  const pinned: Record<BaseFamily, ReadonlyArray<PinnedText>> = { glimmer: opts.metaFiles ?? META_FILES, llama: opts.llamaFiles ?? LLAMA_FILES };
  for (const family of families) {
    for (const m of pinned[family]) {
      const cached = path.join(opts.cacheDir, family === "glimmer" ? "meta" : family, m.sha256);
      await fetchPinned(fetchImpl, m.url, m.sha256, cached);
      await keep(m.path, await fs.readFile(cached), family);
      sources.push({ ...m, family });
    }
  }

  return {
    kit: {
      imageVersion: DRIVE_IMAGE_VERSION,
      runtime: {
        build: pin.build,
        version: pin.version,
        commit: pin.commit,
        assets: pin.assets.map((a) => ({ name: a.name, sha256: a.sha256, url: runtimeUrl(pin, a.name) })),
      },
      files,
      sources,
      baseUrl: null,
    },
    fileOf,
  };
}

// ---------- The kit a board fetches ----------

/** lib/drive/kit-files.json, which scripts/drive-kit.ts writes. */
export const KIT_FILES_JSON = path.join(process.cwd(), "lib", "drive", "kit-files.json");

/** The Blob path of a kit file. Named by its sha256, so a file is uploaded once and any drive of any version can use it. */
export const kitBlobPath = (sha256: string) => `drive-kit/${sha256}`;

/** A kit file's public URL, or null when the kit isn't uploaded yet. */
export function kitFileUrl(kit: Pick<DriveKit, "baseUrl">, sha256: string): string | null {
  return kit.baseUrl ? `${kit.baseUrl}${sha256}` : null;
}

/** Why a kit can't be used for an export, in a sentence for the card, or null when it can. */
export function kitProblem(kit: DriveKit | null): string | null {
  if (!kit || !kit.files.length) return "The drive kit hasn't been built. Run scripts/drive-kit.ts, then scripts/drive-kit.ts --upload.";
  if (kit.imageVersion !== DRIVE_IMAGE_VERSION) return `The drive kit is for image ${kit.imageVersion}, and this site writes ${DRIVE_IMAGE_VERSION}. Run scripts/drive-kit.ts again.`;
  if (!kit.baseUrl || !/^https:\/\/[^/?#\s]+\/(.+\/)?drive-kit\/$/.test(kit.baseUrl)) return "The drive kit isn't uploaded yet. Run scripts/drive-kit.ts --upload.";
  return null;
}

/** The kit the site was deployed with, or null when kit-files.json is missing or unreadable. */
export async function loadKit(file = KIT_FILES_JSON): Promise<DriveKit | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as DriveKit;
  } catch {
    return null;
  }
}
