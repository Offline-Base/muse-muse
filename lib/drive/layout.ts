/**
 * The pure parts of a drive's layout (docs/VIBE_TUNING.md, Feature 6, and docs/DRIVE_EXPORT.md): the pinned runtime and
 * license files, the launchers' build table, and the text helpers the pages are filled with. No file or network access
 * here, so the bench's image (lib/drive/image.ts) and a board's export plan (lib/drive/plan.ts) share one layout and
 * can't drift. Moved out of image.ts unchanged when drive export split it; image.ts re-exports all of it.
 */
import type { DriveRuntime } from "@/lib/drive/logic";
import type { DriveFile, DriveModel } from "@/lib/drive/types";
import { BUILT_WITH_SPARK_OPEN, R30B_REPO, USAGE_POINTS } from "@/lib/train/base";
import { MUSE_MUSE_SITE } from "@/lib/train/hub-cards";
import { QUANT_LEVELS, type LocalFile, type QuantLevel } from "@/lib/train/local-files";
import { MAC_MEMORY_SIZES, PC_MEMORY_SIZES, VRAM_SIZES, pickBuild, type DeviceProfile } from "@/lib/vibe/device";

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

/** A license file that ships verbatim, from its repo at a pinned commit, checked against its sha256. */
export interface PinnedText {
  path: string;
  url: string;
  sha256: string;
}

/**
 * Meta's text that ships verbatim (Apache 2.0 section 4(a), and the Usage Policy the 18+ box points at), from Meta's
 * GGUF repo at a pinned commit. Their git blob ids matched that commit's tree on Oct 28; the sha256 is of the same bytes.
 */
export const META_FILES: ReadonlyArray<PinnedText> = [
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

/**
 * What a Derivative's drive adds to META_FILES (whose Apache 2.0 and Usage Policy are the same bytes as r30b's): the Muse
 * Model License and r30b's NOTICE, from lib/train/licenses.
 */
export const DERIVATIVE_DRIVE_FILES: ReadonlyArray<{ path: string; from: string }> = [
  { path: "licenses/MUSE_MODEL_LICENSE.md", from: "MUSE_MODEL_LICENSE.md" },
  { path: "licenses/NOTICE", from: "NOTICE" },
];

/** The revision of unsloth/Llama-3.2-1B-Instruct that muse-device/setup-train.sh downloads for board training. */
export const LLAMA_BOARD_BASE = { repo: "unsloth/Llama-3.2-1B-Instruct", revision: "5a8abab4a5d6f164389b1079fb721cfab8d7126c" } as const;

/** Meta's commit of meta-llama/llama-models the two texts below were read from on Nov 1, 2026. The Hub repos above hold no license file. */
const LLAMA_MODELS_COMMIT = "0e0b8c519242d5833d8c11bffc1232b77ad7f301";

/** The Llama 3.2 Community License and Acceptable Use Policy, for board fine-tunes. The license's section 1.b.i asks for a copy on every drive. */
export const LLAMA_FILES: ReadonlyArray<PinnedText> = [
  {
    path: "licenses/LLAMA_3.2_LICENSE.txt",
    url: `https://raw.githubusercontent.com/meta-llama/llama-models/${LLAMA_MODELS_COMMIT}/models/llama3_2/LICENSE`,
    sha256: "8cc15535a8a34b41888f644b339a1a9eb428af793a4f5e24df58a3e5b1487d74",
  },
  {
    path: "licenses/LLAMA_3.2_USE_POLICY.md",
    url: `https://raw.githubusercontent.com/meta-llama/llama-models/${LLAMA_MODELS_COMMIT}/models/llama3_2/USE_POLICY.md`,
    sha256: "40e2777d7faa6beaf98400654170f414d8ab29b921b5163ad4ea0a1d39894201",
  },
];

/** What the image needs to know about the model: an order's saved copy of its local files. */
export interface ImageModel extends DriveModel {
  adapterJobId: string;
  repo: string;
  commit: string;
  files: DriveFile[];
}

export interface ImageManifest {
  imageVersion: string;
  model: { title: string; slug: string; adapterJobId: string; quantJobId: string; repo: string; commit: string };
  runtime: { build: string; version: string; commit: string; assets: Array<{ name: string; sha256: string; url: string }> };
  sources: Array<{ path: string; url: string; sha256: string }>;
  /** Every file of the image, relative to it, with its size and sha256. The model files aren't among them. */
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

/** The files a llama.cpp archive keeps on the drive: the server, the libraries it loads, and the licenses. */
export function keepFromArchive(runtime: DriveRuntime, name: string): boolean {
  if (runtime === "macos-arm64") {
    // The binaries load @rpath/libX.0.dylib, which the archive has as symlinks. exFAT has no symlinks, so each is kept
    // as a copy of its target under that name, and the other names are left out.
    return name === "llama-server" || name === "libllama-server-impl.dylib" || /^lib[a-z-]+\.0\.dylib$/.test(name) || name === "LICENSE";
  }
  return name === "llama-server.exe" || name.toLowerCase().endsWith(".dll") || name.startsWith("LICENSE");
}

// ---------- The launchers' table ----------

/**
 * Builds smallest first. A lab model's three levels go in QUANT_LEVELS order, as they always have. A board base can be
 * any quant (Q8_0, BF16) and stage 2 is IQ1_S, so once a level isn't one of those three, the files go by size instead.
 */
export function sortedBuilds<T extends { level: string; bytes: number }>(files: readonly T[]): T[] {
  const known = files.every((f) => (QUANT_LEVELS as readonly string[]).includes(f.level));
  if (known) {
    const byLevel = [...new Set(files.map((f) => f.level as QuantLevel))].sort((a, b) => QUANT_LEVELS.indexOf(a) - QUANT_LEVELS.indexOf(b));
    return byLevel.map((level) => files.find((f) => f.level === level)!);
  }
  return [...files].sort((a, b) => a.bytes - b.bytes);
}

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
export function buildForText(table: string, level: string): string {
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

// ---------- Text ----------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A template from drive/ with every {{KEY}} filled. A key left over is a mistake, so it throws. */
export function fill(template: string, values: Record<string, string>): string {
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => (key in values ? values[key] : m));
  const left = out.match(/\{\{[A-Z_]+\}\}/);
  if (left) throw new Error(`drive/ template has no value for ${left[0]}.`);
  return out;
}

/** Windows' cmd.exe reads batch files line by line and misreads labels without CRLF, so its files get CRLF. */
export const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

/** CHANGES.md, as Apache 2.0 section 4(b) asks: what was changed in Meta's work. */
export function changesText(model: ImageModel, pin: RuntimePin): string {
  const levels = model.files.map((f) => f.level).join(", ");
  const steps = model.sparkOpen
    ? [
        `- Muse Muse fine-tuned it with 2026 knowledge as ${R30B_REPO} (licenses/NOTICE says how).`,
        `- Then fine-tuned that with a LoRA adapter (training job ${model.adapterJobId}).`,
        `- The adapter was merged into ${R30B_REPO}'s bf16 weights.`,
      ]
    : [`- Muse Muse fine-tuned it with a LoRA adapter (training job ${model.adapterJobId}).`, "- The adapter was merged into Meta's bf16 weights."];
  return [
    "# Changes",
    "",
    "This drive holds a modified version of Meta's Muse Glimmer 30B, which Meta licenses under the Apache License 2.0",
    "(licenses/Apache-2.0.txt). As section 4(b) of that license asks, this is what was changed:",
    "",
    ...steps,
    `- The merged model was converted to GGUF and quantized to ${levels} with llama.cpp (job ${model.quantJobId}).`,
    `- The files are the ones in https://huggingface.co/${model.repo} at commit ${model.commit}.`,
    "",
    `The llama.cpp runtime (MIT, licenses/llama.cpp-LICENSE.txt) is release ${pin.build} (${pin.version}), unchanged. Only`,
    "the server and the libraries it loads are on the drive.",
    "",
    "Muse Glimmer is Meta's model. This fine-tune wasn't made, reviewed or endorsed by Meta.",
    ...(model.sparkOpen
      ? [
          "",
          `${BUILT_WITH_SPARK_OPEN}. Muse Spark Open wrote part of ${R30B_REPO}'s training data, so this model is a`,
          "Derivative of Muse Spark Open under the Muse Model License (licenses/MUSE_MODEL_LICENSE.md, with its Usage Policy",
          "as Exhibit A).",
        ]
      : []),
    "",
  ].join("\n");
}

/** The pages' "Built with Muse Spark Open" for a Derivative's drive, or nothing: Start Here.html's, then README.txt's. */
export function sparkOpenText(model: Pick<ImageModel, "sparkOpen">): { html: string; text: string } {
  if (!model.sparkOpen) return { html: "", text: "" };
  return {
    html: `<p><strong>${BUILT_WITH_SPARK_OPEN}.</strong> ${escapeHtml(USAGE_POINTS.join(" "))} The Muse Model License is in <span class="file">licenses/MUSE_MODEL_LICENSE.md</span>.</p>`,
    text: `\n${BUILT_WITH_SPARK_OPEN}. ${USAGE_POINTS.join(" ")}\nThe Muse Model License is in licenses/MUSE_MODEL_LICENSE.md.\n`,
  };
}

/** The model's public page, which the drive names for Try it live and its eval. */
export function modelPageUrl(adapterJobId: string): string {
  return `${MUSE_MUSE_SITE}/fine-tuning/${adapterJobId}`;
}

/** Where the drive tells its buyer to write, in plain words: the contact address, or the invoice's email. */
export function contactText(contact: string | null | undefined): string {
  return contact ? `write to ${contact}` : "reply to the email your invoice came from";
}

/** The model files' place on the drive. */
export const modelPath = (f: Pick<DriveFile, "name">) => `model/${f.name}`;

/** SHA256SUMS in shasum's format ("<sha256>  <path>"), sorted by path. `shasum -a 256 -c` reads it as it is. */
export function sha256Sums(entries: ReadonlyArray<{ path: string; sha256: string }>): string {
  return [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.sha256}  ${e.path}`)
    .join("\n")
    .concat("\n");
}
