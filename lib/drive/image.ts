/**
 * The drive's image (docs/VIBE_TUNING.md, Feature 6, "What goes on the drive"): every file on the stick but the model
 * files, for one model. It is put together from the model's local files (localFilesFor, or an order's saved copy of
 * them), the launchers and pages in drive/, one pinned llama.cpp build for macOS arm64 and Windows x64, Meta's license
 * and Usage Policy (verbatim, pinned), the GGUF repo's model card at the files' commit, and CHANGES.md. Every download
 * is checked against its pinned sha256 before it is used, and the launchers never download anything themselves.
 * scripts/drive-image.ts and scripts/drive-bench.ts call it; lib/drive/__tests__/image.test.ts fakes its downloads.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DRIVE_IMAGE_VERSION, minimumSpecText, type DriveRuntime } from "@/lib/drive/logic";
import type { DriveFile, DriveModel } from "@/lib/drive/types";
import { MUSE_MUSE_SITE } from "@/lib/train/hub-cards";
import { QUANT_LEVELS, type LocalFile, type QuantLevel } from "@/lib/train/local-files";
import { MAC_MEMORY_SIZES, PC_MEMORY_SIZES, VRAM_SIZES, minimumSpec, pickBuild, type DeviceProfile } from "@/lib/vibe/device";

const run = promisify(execFile);

/**
 * The llama.cpp build on every drive: release b11669, which llama.cpp also published as v0.7.0 (Oct 15, 2026), and the
 * build the owner's Mac runs from Homebrew, so the launchers' flags were read from its own --help. Glimmer runs from
 * b10353. The names, sizes and sha256 are the GitHub release API's, and the three files were downloaded and checked
 * against them on Oct 28.
 */
export const RUNTIME_PIN = {
  build: "b11669",
  version: "0.7.0",
  commit: "620d2225cc436ab0b001e3200e590e3b286ef9ab",
  assets: [
    {
      runtime: "macos-arm64",
      name: "llama-b11669-bin-macos-arm64.tar.gz",
      bytes: 12_191_582,
      sha256: "dbed55493d72bc1ba2babc8770d669c2289b5bc4ee9fb2a4dfc158d45b7d13fd",
    },
    {
      runtime: "windows-x64-vulkan",
      name: "llama-b11669-bin-win-vulkan-x64.zip",
      bytes: 32_182_350,
      sha256: "2c07574e7bde71321cb785282b20cc821e951132149eeceeea32ddebdbf0598e",
    },
    {
      runtime: "windows-x64-cpu",
      name: "llama-b11669-bin-win-cpu-x64.zip",
      bytes: 19_537_886,
      sha256: "37b3efcf962847ca869745fd4ccf7f5e7e8dacfeff9fa3523b4ca8cdc66d632b",
    },
  ],
} as const satisfies RuntimePin;

export interface RuntimePin {
  build: string;
  version: string;
  commit: string;
  assets: ReadonlyArray<{ runtime: DriveRuntime; name: string; bytes: number; sha256: string }>;
}

export function runtimeUrl(pin: RuntimePin, name: string): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${pin.build}/${name}`;
}

/**
 * Meta's text that ships verbatim (Apache 2.0 section 4(a), and the Usage Policy the 18+ box points at), from Meta's
 * GGUF repo at a pinned commit. Their git blob ids matched that commit's tree on Oct 28; the sha256 is of the same bytes.
 */
export const META_FILES: ReadonlyArray<{ path: string; url: string; sha256: string }> = [
  {
    path: "licenses/Apache-2.0.txt",
    url: "https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF/raw/b44f1072cf75e918a1b82a3a17b45c4389b076e7/LICENSE",
    sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  },
  {
    path: "licenses/USAGE_POLICY.md",
    url: "https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF/raw/b44f1072cf75e918a1b82a3a17b45c4389b076e7/USAGE_POLICY.md",
    sha256: "98a14dab9fd97de1666dc8589d399efab1e7fc3ba4e6230d037d6637ba9481d3",
  },
];

/** The repo's drive/ folder: the launchers, Start Here.html and the README, as they were written. */
export const DRIVE_SOURCE_DIR = fileURLToPath(new URL("../../drive", import.meta.url));

/** What the image needs to know about the model: an order's saved copy of its local files. */
export interface ImageModel extends DriveModel {
  adapterJobId: string;
  repo: string;
  commit: string;
  files: DriveFile[];
}

/** The files a llama.cpp archive keeps on the drive: the server, the libraries it loads, and the licenses. */
function keepFromArchive(runtime: DriveRuntime, name: string): boolean {
  if (runtime === "macos-arm64") {
    // The binaries load @rpath/libX.0.dylib, which the archive has as symlinks. exFAT has no symlinks, so each is kept
    // as a copy of its target under that name, and the other names are left out.
    return name === "llama-server" || name === "libllama-server-impl.dylib" || /^lib[a-z-]+\.0\.dylib$/.test(name) || name === "LICENSE";
  }
  return name === "llama-server.exe" || name.toLowerCase().endsWith(".dll") || name.startsWith("LICENSE");
}

// ---------- The launchers' table ----------

const sorted = (levels: Iterable<QuantLevel>) => [...levels].sort((a, b) => QUANT_LEVELS.indexOf(a) - QUANT_LEVELS.indexOf(b));

function macProfile(memoryGb: number): DeviceProfile {
  return { kind: "mac", chip: null, memoryGb, gpu: null };
}

function pcProfile(memoryGb: number, vramGb: number): DeviceProfile {
  return { kind: "windows", chip: null, memoryGb, gpu: vramGb ? { vendor: "nvidia", model: null, vramGb } : null };
}

/**
 * support/builds.tsv: the device picker's own verdict (lib/vibe/device.ts pickBuild) for every Mac memory size, and for
 * every PC memory and graphics card size, with the drive's files. Both launchers find the row for the sizes the machine
 * has at least, so the drive picks what the website would. A "-" level means nothing on the drive fits.
 */
export function launcherTable(files: readonly LocalFile[]): string {
  const lines = ["kind\tmemory_gb\tvram_gb\tlevel\truntime\tfit\twhere"];
  for (const memory of MAC_MEMORY_SIZES) {
    const v = pickBuild(macProfile(memory), files);
    lines.push(["mac", memory, 0, v?.file?.level ?? "-", "macos-arm64", v?.file ? v.fit : "no", v?.file ? (v.where ?? "gpu") : "-"].join("\t"));
  }
  for (const memory of PC_MEMORY_SIZES) {
    for (const vram of [0, ...VRAM_SIZES]) {
      const v = pickBuild(pcProfile(memory, vram), files);
      const runtime: DriveRuntime = v?.where === "cpu" ? "windows-x64-cpu" : "windows-x64-vulkan";
      lines.push(["pc", memory, vram, v?.file?.level ?? "-", v?.file ? runtime : "-", v?.file ? v.fit : "no", v?.file ? (v.where ?? "-") : "-"].join("\t"));
    }
  }
  return `${lines.join("\n")}\n`;
}

function sizesText(sizes: number[], all: readonly number[], unit = "GB"): string {
  if (!sizes.length) return "";
  if (sizes.length > 1 && sizes[sizes.length - 1] === all[all.length - 1]) return `${sizes[0]} ${unit} or more`;
  if (sizes.length === 1) return `${sizes[0]} ${unit}`;
  return `${sizes.slice(0, -1).join(", ")} or ${sizes[sizes.length - 1]} ${unit}`;
}

/** Start Here's "For" column for one build, read off the launchers' table. */
export function buildForText(table: string, level: QuantLevel): string {
  const rows = table
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.split("\t"))
    .filter((r) => r[3] === level)
    .map(([kind, memory, vram, , , , where]) => ({ kind, memory: Number(memory), vram: Number(vram), where }));
  const unique = (ns: number[]) => [...new Set(ns)].sort((a, b) => a - b);
  const parts: string[] = [];
  const macs = unique(rows.filter((r) => r.kind === "mac").map((r) => r.memory));
  if (macs.length) parts.push(`a Mac with ${sizesText(macs, MAC_MEMORY_SIZES)}`);
  const cards = unique(rows.filter((r) => r.kind === "pc" && r.where === "gpu").map((r) => r.vram));
  if (cards.length) parts.push(`a PC with a graphics card of ${sizesText(cards, VRAM_SIZES)}`);
  const split = rows.filter((r) => r.where === "split");
  if (split.length) {
    parts.push(`a PC with a ${Math.min(...split.map((r) => r.vram))} GB card and ${Math.min(...split.map((r) => r.memory))} GB of memory, slowly`);
  }
  const cpu = rows.filter((r) => r.where === "cpu");
  if (cpu.length) parts.push(`a PC with ${Math.min(...cpu.map((r) => r.memory))} GB of memory and no big graphics card, slowly`);
  return parts.length ? parts.join("; ") : "A computer this drive's table doesn't list";
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

/** Text from the Hub at the files' commit, which needs no token since the repo is public. */
async function fetchText(fetchImpl: FetchLike, url: string): Promise<string> {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Couldn't read ${url}: HTTP ${res.status}.`);
  return res.text();
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A template from drive/ with every {{KEY}} filled. A key left over is a mistake, so it throws. */
function fill(template: string, values: Record<string, string>): string {
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => (key in values ? values[key] : m));
  const left = out.match(/\{\{[A-Z_]+\}\}/);
  if (left) throw new Error(`drive/ template has no value for ${left[0]}.`);
  return out;
}

/** Windows' cmd.exe reads batch files line by line and misreads labels without CRLF, so its files get CRLF. */
const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

/** CHANGES.md, as Apache 2.0 section 4(b) asks: what was changed in Meta's work. */
export function changesText(model: ImageModel, pin: RuntimePin): string {
  const levels = model.files.map((f) => f.level).join(", ");
  return [
    "# Changes",
    "",
    "This drive holds a modified version of Meta's Muse Glimmer 30B, which Meta licenses under the Apache License 2.0",
    "(licenses/Apache-2.0.txt). As section 4(b) of that license asks, this is what was changed:",
    "",
    `- Muse Muse fine-tuned it with a LoRA adapter (training job ${model.adapterJobId}).`,
    "- The adapter was merged into Meta's bf16 weights.",
    `- The merged model was converted to GGUF and quantized to ${levels} with llama.cpp (job ${model.quantJobId}).`,
    `- The files are the ones in https://huggingface.co/${model.repo} at commit ${model.commit}.`,
    "",
    `The llama.cpp runtime (MIT, licenses/llama.cpp-LICENSE.txt) is release ${pin.build} (${pin.version}), unchanged. Only`,
    "the server and the libraries it loads are on the drive.",
    "",
    "Muse Glimmer is Meta's model. This fine-tune wasn't made, reviewed or endorsed by Meta.",
    "",
  ].join("\n");
}

export interface ImageManifest {
  imageVersion: string;
  model: { title: string; slug: string; adapterJobId: string; quantJobId: string; repo: string; commit: string };
  runtime: { build: string; version: string; commit: string; assets: Array<{ name: string; sha256: string; url: string }> };
  sources: Array<{ path: string; url: string; sha256: string }>;
  /** Every file of the image, relative to it, with its size and sha256. The model files aren't among them. */
  files: Array<{ path: string; bytes: number; sha256: string }>;
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
  metaFiles?: typeof META_FILES;
  log?: (line: string) => void;
  /** Where the buyer writes about the drive (DRIVE_CONTACT_EMAIL), or null: the drive then says to reply to the invoice. */
  contact?: string | null;
}

/** The model's public page, which the drive names for Try it live and its eval. */
export function modelPageUrl(adapterJobId: string): string {
  return `${MUSE_MUSE_SITE}/fine-tuning/${adapterJobId}`;
}

/** Where the drive tells its buyer to write, in plain words: the contact address, or the invoice's email. */
export function contactText(contact: string | null | undefined): string {
  return contact ? `write to ${contact}` : "reply to the email your invoice came from";
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
  const extract = opts.extract ?? systemExtract;
  const pin = opts.pin ?? RUNTIME_PIN;
  const metaFiles = opts.metaFiles ?? META_FILES;
  const source = opts.sourceDir ?? DRIVE_SOURCE_DIR;
  const log = opts.log ?? (() => {});
  const out = opts.outDir;
  if ((await exists(out)) && (await fs.readdir(out)).length) throw new Error(`${out} isn't empty. The image goes into an empty folder.`);
  if (!model.files.length) throw new Error("The order has no model files.");
  await fs.mkdir(out, { recursive: true });
  const write = async (rel: string, data: string | Buffer, mode?: number) => {
    const file = path.join(out, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
    if (mode) await fs.chmod(file, mode);
  };
  const sources: ImageManifest["sources"] = [];

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
        await fs.mkdir(path.join(out, "runtime", asset.runtime), { recursive: true });
        await fs.copyFile(real, path.join(out, "runtime", asset.runtime, name));
        kept.push(name);
      }
      const server = asset.runtime === "macos-arm64" ? "llama-server" : "llama-server.exe";
      if (!kept.includes(server)) throw new Error(`${asset.name} has no ${server}.`);
      if (asset.runtime === "macos-arm64") await fs.chmod(path.join(out, "runtime", asset.runtime, server), 0o755);
    } finally {
      await fs.rm(unpacked, { recursive: true, force: true });
    }
    sources.push({ path: `runtime/${asset.runtime}/`, url, sha256: asset.sha256 });
  }
  const mit = licenses.LICENSE;
  if (!mit) throw new Error(`llama.cpp ${pin.build}'s macOS archive has no LICENSE.`);
  for (const asset of pin.assets) await write(`runtime/${asset.runtime}/LICENSE`, mit);
  await write("licenses/llama.cpp-LICENSE.txt", mit);
  if (licenses["LICENSE-LLVM-OpenMP"]) {
    // The Windows builds load LLVM's OpenMP library, whose license travels with it.
    await write("licenses/LLVM-OpenMP-LICENSE.txt", licenses["LICENSE-LLVM-OpenMP"]);
    for (const asset of pin.assets) {
      if (asset.runtime !== "macos-arm64") await write(`runtime/${asset.runtime}/LICENSE-LLVM-OpenMP`, licenses["LICENSE-LLVM-OpenMP"]);
    }
  }

  // Meta's license and Usage Policy, verbatim.
  for (const m of metaFiles) {
    const cached = path.join(opts.cacheDir, "meta", m.sha256);
    await fetchPinned(fetchImpl, m.url, m.sha256, cached);
    await write(m.path, await fs.readFile(cached));
    sources.push(m);
  }

  // From the GGUF repo at the files' commit: the card, and tuned.jinja for an adapter trained before trainChannel.
  const raw = (name: string) => `https://huggingface.co/${model.repo}/raw/${model.commit}/${name}`;
  const card = await fetchText(fetchImpl, raw("README.md"));
  await write("MODEL_CARD.md", card);
  sources.push({ path: "MODEL_CARD.md", url: raw("README.md"), sha256: createHash("sha256").update(card).digest("hex") });
  if (model.needsTunedTemplate) {
    const tuned = await fetchText(fetchImpl, raw("tuned.jinja"));
    await write("model/tuned.jinja", tuned);
    sources.push({ path: "model/tuned.jinja", url: raw("tuned.jinja"), sha256: createHash("sha256").update(tuned).digest("hex") });
  }

  // What the launchers read, and the chat's preset settings (llama-server --ui-config-file).
  const localFiles: LocalFile[] = sorted(model.files.map((f) => f.level)).map((level) => model.files.find((f) => f.level === level)!);
  const table = launcherTable(localFiles);
  await write("support/builds.tsv", table);
  await write("support/files.tsv", `level\tname\tbytes\n${localFiles.map((f) => `${f.level}\t${f.name}\t${f.bytes}`).join("\n")}\n`);
  // The launchers print the model's page (Try it live) and where to write (a drive that fails Verify) from here.
  const page = modelPageUrl(model.adapterJobId);
  const contact = opts.contact && !/[\s<>"'`$\\]/.test(opts.contact) ? opts.contact : null;
  await write(
    "support/model.tsv",
    `title\t${model.title.replace(/[\t\r\n]+/g, " ")}\nslug\t${model.slug}\npage\t${page}\ncontact\t${contactText(contact)}\n`,
  );
  await write("model/system.txt", `${model.systemLine}\n`);
  await write("model/ui-config.json", `${JSON.stringify({ systemMessage: model.systemLine, temperature: 0 }, null, 2)}\n`);

  // The pages and launchers, written fresh in drive/.
  const spec = minimumSpecText(minimumSpec(localFiles));
  const rows = localFiles
    .map((f) => `        <tr><td>${f.level}</td><td class="num">${(f.bytes / 1e9).toFixed(1)} GB</td><td>${escapeHtml(buildForText(table, f.level))}</td></tr>`)
    .join("\n");
  const tunedNote = model.needsTunedTemplate
    ? `<p>This model was trained before it learned to open its own answers, so the launchers start it with <span class="file">model/tuned.jinja</span> from its repo.</p>`
    : "";
  const values = {
    TITLE: escapeHtml(model.title),
    MIN_SPEC: escapeHtml(spec),
    BUILD_ROWS: rows,
    SYSTEM_LINE: escapeHtml(model.systemLine),
    TUNED_NOTE: tunedNote,
    REPO: escapeHtml(model.repo),
    COMMIT_SHORT: model.commit.slice(0, 12),
    RUNTIME: `${pin.build} (${pin.version})`,
    IMAGE_VERSION: DRIVE_IMAGE_VERSION,
    PAGE_URL: escapeHtml(page),
    CONTACT_HTML: contact ? `Write to <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>` : "Reply to the email your invoice came from",
  };
  const read = (name: string) => fs.readFile(path.join(source, name), "utf8");
  await write("Start Here.html", fill(await read("Start Here.html"), values));
  await write(
    "README.txt",
    crlf(fill(await read("README.txt"), { TITLE: model.title, MIN_SPEC: spec, RUNTIME: values.RUNTIME, PAGE_URL: page, CONTACT_TEXT: contactText(contact) })),
  );
  await write("Start (Mac).command", await read("Start (Mac).command"), 0o755);
  await write("Verify (Mac).command", await read("Verify (Mac).command"), 0o755);
  await write("Start (Windows).cmd", crlf(await read("Start (Windows).cmd")));
  await write("Verify (Windows).cmd", crlf(await read("Verify (Windows).cmd")));
  await write("support/start-windows.ps1", crlf(await read("support/start-windows.ps1")));
  await write("support/verify-windows.ps1", crlf(await read("support/verify-windows.ps1")));
  await write("licenses/CHANGES.md", changesText(model, pin));

  const files: ImageManifest["files"] = [];
  for (const rel of await listFiles(out)) {
    const full = path.join(out, rel);
    files.push({ path: rel, bytes: (await fs.stat(full)).size, sha256: await sha256File(full) });
  }
  return {
    imageVersion: DRIVE_IMAGE_VERSION,
    model: { title: model.title, slug: model.slug, adapterJobId: model.adapterJobId, quantJobId: model.quantJobId, repo: model.repo, commit: model.commit },
    runtime: {
      build: pin.build,
      version: pin.version,
      commit: pin.commit,
      assets: pin.assets.map((a) => ({ name: a.name, sha256: a.sha256, url: runtimeUrl(pin, a.name) })),
    },
    sources,
    files,
  };
}

// ---------- PROVENANCE.json and SHA256SUMS ----------

/** The model files' place on the drive. */
export const modelPath = (f: Pick<DriveFile, "name">) => `model/${f.name}`;

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

/** SHA256SUMS in shasum's format ("<sha256>  <path>"), sorted by path. `shasum -a 256 -c` reads it as it is. */
export function sha256Sums(entries: ReadonlyArray<{ path: string; sha256: string }>): string {
  return [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.sha256}  ${e.path}`)
    .join("\n")
    .concat("\n");
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
