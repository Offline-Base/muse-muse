/**
 * The drive plan (docs/DRIVE_EXPORT.md, "The drive plan"): every file of a drive as data, so the bench's image and a
 * board's export come from one layout. planDriveImage lays out the image of one model: the pages and launchers from
 * drive/, filled in; the kit's runtime and license files by sha256; the support tables; the card and CHANGES.md.
 * exportPlan adds the model files, PROVENANCE.json and SHA256SUMS, and names the folder on the drive, which is what a
 * board's export_model takes (muse-device/drive.py writes it without knowing what any file means). writePlan writes a
 * plan into a folder, checking every file's sha256 as it goes: the bench's image (lib/drive/image.ts) is exactly that.
 *
 * Who the drive is from changes some of its words (DriveWords): a bench drive is an order, so it names the invoice and
 * the model's public page; a drive the owner made from a board or the lab says to ask whoever gave it, and links the
 * Muse Muse site. The base's family decides the license and the notice: Meta's Apache 2.0 for Muse Glimmer, the Llama 3.2
 * license for a board's Llama 3.2 1B, never the other's.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BaseFamily, DriveKit } from "@/lib/drive/kit";
import {
  buildForText,
  changesText,
  contactText,
  crlf,
  DERIVATIVE_DRIVE_FILES,
  escapeHtml,
  fill,
  launcherTable,
  modelPageUrl,
  LLAMA_BOARD_BASE,
  sha256Sums,
  sortedBuilds,
  sparkOpenText,
  type ImageManifest,
  type ImageModel,
  type RuntimePin,
} from "@/lib/drive/layout";
import { minimumSpecText } from "@/lib/drive/logic";
import { BUILT_WITH_SPARK_OPEN, USAGE_POINTS } from "@/lib/train/base";
import { MUSE_MUSE_SITE } from "@/lib/train/hub-cards";
import { DERIVATIVE_FILES } from "@/lib/train/licenses";
import type { LocalFile } from "@/lib/train/local-files";
import { minimumSpec } from "@/lib/vibe/device";

export const PLAN_FORMAT = "muse-drive-plan/1";
/** The board refuses a plan with more files than this (muse-device/drive.py MAX_PLAN_FILES). */
export const MAX_PLAN_FILES = 400;
/** The largest file FAT32 holds. A plan with a bigger one needs an exFAT drive. */
export const FAT32_MAX_FILE_BYTES = 4_294_967_295;
/** The board takes 1 MiB a body (MAX_BODY_BYTES in server.py). This leaves room for the JSON-RPC call around a plan. */
export const MAX_PLAN_CALL_BYTES = 1024 * 1024 - 16 * 1024;
/** An export's id names its folder on the board and the end of its folder's name on the drive. */
export const EXPORT_ID = /^exp_[0-9a-f]{12}$/;

export function newExportId(): string {
  return `exp_${randomBytes(6).toString("hex")}`;
}

interface FileFacts {
  /** Relative to the drive's folder, with forward slashes. */
  path: string;
  bytes: number;
  sha256: string;
  /** Runs when started: the macOS server and the .command launchers. */
  exec?: true;
}

/** One file of a plan, from exactly one place: inline text, the kit (by sha256), the board's ~/models, or a URL. */
export type PlanFile = FileFacts & ({ text: string } | { kit: true } | { board: string } | { url: true });

export interface ImagePlan {
  imageVersion: string;
  /** Sorted by path, as a listing of the written folder is. */
  files: PlanFile[];
  sources: ImageManifest["sources"];
}

export interface DrivePlan {
  format: typeof PLAN_FORMAT;
  export: string;
  /** Where the files go on the drive: MuseMuse/<slug>-<4 hex of the export>. */
  folder: string;
  imageVersion: string;
  /** What it was made from, so the platform can sign fresh URLs: "board:<run>", "lab:<jobId>:<build>" or "url". */
  source: string;
  /** True when a file is over FAT32's limit, so only an exFAT drive takes it. */
  needsLargeFiles: boolean;
  files: PlanFile[];
}

// ---------- The templates in drive/ ----------

/**
 * The repo's drive/ folder: the launchers, Start Here.html and the README, as they were written. From the project root, as
 * next.config.ts traces it. Not new URL(literal, import.meta.url): Next's bundler reads that as importing a file, and a
 * folder fails the build.
 */
export const DRIVE_SOURCE_DIR = path.join(process.cwd(), "drive");

export const TEMPLATE_NAMES = [
  "Start Here.html",
  "README.txt",
  "Start (Mac).command",
  "Verify (Mac).command",
  "Start (Windows).cmd",
  "Verify (Windows).cmd",
  "support/start-windows.ps1",
  "support/verify-windows.ps1",
] as const;
export type DriveTemplates = Record<(typeof TEMPLATE_NAMES)[number], string>;

export async function readDriveTemplates(dir: string = DRIVE_SOURCE_DIR): Promise<DriveTemplates> {
  const out = {} as DriveTemplates;
  for (const name of TEMPLATE_NAMES) out[name] = await fs.readFile(path.join(dir, name), "utf8");
  return out;
}

const BLOCK_OPEN = /^[ \t]*# >>> adapter\n/gm;
const BLOCK_CLOSE = /^[ \t]*# <<< adapter\n/gm;

/**
 * The launchers' adapter blocks, between "# >>> adapter" and "# <<< adapter" lines. A drive with an adapter keeps what
 * is inside and loses the marker lines; any other drive loses the whole block, so a bench drive's launchers are byte for
 * byte what they were before blocks existed.
 */
export function adapterBlocks(text: string, adapter: boolean): string {
  const opens = text.match(BLOCK_OPEN)?.length ?? 0;
  if (opens !== (text.match(BLOCK_CLOSE)?.length ?? 0)) throw new Error("A drive/ launcher has an adapter block that isn't closed.");
  if (adapter) return text.replace(BLOCK_OPEN, "").replace(BLOCK_CLOSE, "");
  return text.replace(/^[ \t]*# >>> adapter\n[\s\S]*?^[ \t]*# <<< adapter\n/gm, "");
}

// ---------- The model, and what the drive says ----------

/** One GGUF build of the model. A board's base can be any quant, so its level is any name. */
export interface ModelBuild {
  level: string;
  name: string;
  bytes: number;
  sha256: string;
  /** For an export: where the board gets it, and how PROVENANCE.json names it (never with a query string). */
  from?: "board" | "url";
  source?: string;
}

export type ModelAdapter = Omit<ModelBuild, "level">;

/** The words that change with who made the drive. Each is filled into a page as it is. */
export interface DriveWords {
  /** support/model.tsv: where the launchers say to go, and whom to write. */
  page: string;
  contact: string;
  /** README.txt, after "The drive doesn't run on Linux or on a Mac with an Intel chip. " */
  readmePage: string;
  /** README.txt's last paragraph, before " The runtime is llama.cpp ... (MIT)." */
  readmeNotice: string;
  /** Start Here.html, after "The drive doesn't run on Linux or on a Mac with an Intel chip." */
  elsewhereHtml: string;
  /** Start Here.html, after "and changes nothing." */
  checksumsNote: string;
  /** Start Here.html's "About this drive" items before the runtime's, and after it. */
  aboutHtml: string;
  aboutMoreHtml: string;
}

export interface PlanModel {
  title: string;
  slug: string;
  systemLine: string;
  family: BaseFamily;
  builds: ModelBuild[];
  /** A LoRA adapter GGUF the launchers load on top of the build (--lora), as a board ran it. */
  adapter: ModelAdapter | null;
  /** MODEL_CARD.md. */
  card: string;
  /** model/tuned.jinja, for a lab adapter trained before trainChannel. */
  tuned: string | null;
  /** licenses/CHANGES.md. */
  changes: string;
  /** Where the card and tuned.jinja came from, after the kit's sources. */
  sources: ImageManifest["sources"];
  words: DriveWords;
  /**
   * Set for a Derivative of Muse Spark Open: its license duties, which exportPlan checks. Linked for the owner's own
   * knowledge-run file; inline for files merged into r30b (an order's or a lab model's), which also puts
   * DERIVATIVE_DRIVE_FILES on the drive and "Built with Muse Spark Open" with the Usage Policy's points on its pages.
   */
  derivative?: SparkDerivative;
}

// ---------- Derivatives of Muse Spark Open ----------

/**
 * The knowledge run's models are Derivatives under the Muse Model License: Muse Spark Open wrote part of their first
 * stage's training data (the training session's license review, Oct 31; the owner later dropped the non-commercial terms,
 * so Muse Muse's changes are Apache 2.0). A drive of one must carry the Muse Model License, its Usage Policy, the release's
 * NOTICE and Meta's Apache 2.0 license with the modified-weights notice; show "Built with Muse Spark Open" where people
 * look first; and tell them the Usage Policy's points and the known dangers (docs/DRIVE_EXPORT.md, "Derivatives of Muse
 * Spark Open"). The owner's own file (urlModel) gets the texts from its release folder, next to its GGUF, by URL and
 * sha256, with that model's own honesty numbers. A lab model trained on r30b (isSparkOpenDerivative, lib/train/base.ts) is
 * a Derivative too: its texts are inline from lib/train/licenses at DERIVATIVE_DRIVE_FILES' paths, beside the kit's Apache
 * 2.0 and Usage Policy (the same bytes as r30b's), and it states no numbers, since a lab tune has no held-out honesty
 * test of its own. A lab model from before r30b, and a board's fine-tune of Llama, aren't Derivatives.
 */
export const SPARK_DERIVATIVE_FILES = {
  license: "licenses/MUSE_MODEL_LICENSE.md",
  usagePolicy: "licenses/MUSE_USAGE_POLICY.md",
  /** The release's NOTICE for its Apache 2.0 part, which section 4(d) says goes with every copy. */
  notice: "licenses/NOTICE",
} as const;
export type SparkDerivativeFile = keyof typeof SPARK_DERIVATIVE_FILES;
export const SPARK_DERIVATIVE_KEYS = Object.keys(SPARK_DERIVATIVE_FILES) as SparkDerivativeFile[];

export const BUILT_WITH = BUILT_WITH_SPARK_OPEN;

/** The owner's own file: each text by bytes and sha256 from the release folder, and the model's measured dangers. */
export interface LinkedSparkDerivative {
  files: Record<SparkDerivativeFile, { bytes: number; sha256: string }>;
  /** The held-out honesty test, in percent: answers made up, answers honest, and false premises gone along with. */
  dangers: { madeUpPct: number; honestPct: number; falsePremisePct: number };
}

/** Files merged into r30b: the texts inline, from lib/train/licenses, and no numbers. */
export interface InlineSparkDerivative {
  inline: ReadonlyArray<{ path: string; text: string }>;
}

export type SparkDerivative = LinkedSparkDerivative | InlineSparkDerivative;

const licenseOf = (from: string) => DERIVATIVE_FILES.find((f) => f.path === from)!;

/** The duties of files merged into r30b, as a plan carries them. */
export function inlineSparkDerivative(): InlineSparkDerivative {
  return { inline: DERIVATIVE_DRIVE_FILES.map((d) => ({ path: d.path, text: licenseOf(d.from).text })) };
}

const isInline = (d: SparkDerivative): d is InlineSparkDerivative => "inline" in d;

/**
 * A knowledge-run model's file name or slug: r30b (any quant), stage-b, stage 2 or "knowledge". Stage 2 shares the run's
 * first stage, so it counts until the training session says otherwise. None of them goes on a drive without the duties.
 */
export const KNOWLEDGE_RUN_NAME = /(^|[-_.\s])(r30b|stage-?b|stage-?2|knowledge)([-_.\s]|$)/i;

export function isKnowledgeRunName(...names: string[]): boolean {
  return names.some((n) => KNOWLEDGE_RUN_NAME.test(n));
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Throws unless a Derivative's duties are whole: inline, each text exactly as lib/train/licenses has it; linked, as below. */
export function checkSparkDerivative(d: SparkDerivative | undefined | null): asserts d is SparkDerivative {
  if (d && isInline(d)) {
    for (const want of DERIVATIVE_DRIVE_FILES) {
      if (d.inline.find((f) => f.path === want.path)?.text !== licenseOf(want.from).text) {
        throw new Error(`A Derivative of Muse Spark Open can't go on a drive without ${want.path}.`);
      }
    }
    return;
  }
  checkLinkedDerivative(d);
}

/** Throws unless a linked Derivative's duties are whole: every text by bytes and sha256, and the three numbers. */
function checkLinkedDerivative(d: SparkDerivative | undefined | null): asserts d is LinkedSparkDerivative {
  if (!d) throw new Error(`A Derivative of Muse Spark Open needs its license duties (docs/DRIVE_EXPORT.md, "Derivatives of Muse Spark Open").`);
  for (const key of SPARK_DERIVATIVE_KEYS) {
    const f = (d as LinkedSparkDerivative).files?.[key];
    if (!f || !Number.isSafeInteger(f.bytes) || f.bytes <= 0 || !SHA256_HEX.test(f.sha256)) {
      throw new Error(`A Derivative of Muse Spark Open can't go on a drive without ${SPARK_DERIVATIVE_FILES[key]}.`);
    }
  }
  const { dangers } = d as LinkedSparkDerivative;
  const nums = [dangers?.madeUpPct, dangers?.honestPct, dangers?.falsePremisePct];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100)) {
    throw new Error("A Derivative of Muse Spark Open needs its honesty numbers (made up, honest, false premises), in percent.");
  }
}

const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

/** MODEL_CARD.md's opening line and its "Use it safely" section, from the Usage Policy's points. */
function derivativeCard(d: LinkedSparkDerivative): { head: string; safety: string } {
  return {
    head: `**${BUILT_WITH}.** This model is a Derivative of Muse Spark Open under the Muse Model License.`,
    safety: [
      "## Use it safely",
      "",
      "Muse Spark Open's Usage Policy applies to this model (licenses/MUSE_USAGE_POLICY.md):",
      "",
      "- It is for people 18 and over only.",
      "- Never present its answers as written by a person.",
      `- It makes up answers. On a held-out test of hard questions it made up an answer ${pct(d.dangers.madeUpPct)} of the time and was honest ${pct(d.dangers.honestPct)} of the time. Check anything that matters.`,
      `- It goes along with false premises about ${pct(d.dangers.falsePremisePct)} of the time: a question that assumes something untrue usually gets an answer that accepts it.`,
      "",
      "## Licenses",
      "",
      "- The Muse Model License: licenses/MUSE_MODEL_LICENSE.md, with its Usage Policy in licenses/MUSE_USAGE_POLICY.md.",
      "- The Muse Model License's own conditions apply as well: read them before you offer this model as a service.",
      "- Meta's Apache License 2.0 for Muse Glimmer 30B: licenses/Apache-2.0.txt, with the release's licenses/NOTICE. The weights were modified; licenses/CHANGES.md says how.",
      "",
    ].join("\n"),
  };
}

/** The drive's words for a Derivative: the owner's Glimmer words, with the duties first. */
function derivativeWords(base: DriveWords, d: LinkedSparkDerivative): DriveWords {
  return {
    ...base,
    readmeNotice: [
      `${BUILT_WITH}. This model is a Derivative of Muse Spark Open under the Muse`,
      "Model License (licenses/MUSE_MODEL_LICENSE.md) and its Usage Policy",
      "(licenses/MUSE_USAGE_POLICY.md). It is for people 18 and over only. Never",
      `present its answers as written by a person. It makes up answers (${pct(d.dangers.madeUpPct)} of hard`,
      `questions on a held-out test) and goes along with false premises about ${pct(d.dangers.falsePremisePct)} of`,
      "the time: MODEL_CARD.md has more.",
      "",
      base.readmeNotice,
    ].join("\n"),
    aboutHtml: [
      `    <li><strong>${BUILT_WITH}.</strong> This model is a Derivative of Muse Spark Open under the Muse Model License: <span class="file">licenses/MUSE_MODEL_LICENSE.md</span>, with its Usage Policy in <span class="file">licenses/MUSE_USAGE_POLICY.md</span>.</li>`,
      base.aboutHtml,
    ].join("\n"),
  };
}

/** Start Here's note under "Chat with it" for a Derivative. */
function derivativeNote(d: LinkedSparkDerivative): string {
  return [
    `<p><strong>${BUILT_WITH}.</strong> It is for people 18 and over only, and its answers must never be presented as written by a person.`,
    `It makes up answers: on a held-out test of hard questions it made one up ${escapeHtml(pct(d.dangers.madeUpPct))} of the time, and it goes along with a false premise about ${escapeHtml(pct(d.dangers.falsePremisePct))} of the time.`,
    `Check anything that matters. <span class="file">MODEL_CARD.md</span> has more.</p>`,
  ].join(" ");
}

/**
 * A lab model's MODEL_CARD.md: its repo's card as it is when that already says "Built with Muse Spark Open" with the Usage
 * Policy's points (every card written since the switch does), else the card with them under its title.
 */
function labDerivativeCard(card: string): string {
  if (card.includes(BUILT_WITH) && USAGE_POINTS.every((p) => card.includes(p))) return card;
  const block = [
    `**${BUILT_WITH}.** This model is a Derivative of Muse Spark Open under the Muse Model License (licenses/MUSE_MODEL_LICENSE.md), and its Usage Policy applies (licenses/USAGE_POLICY.md):`,
    "",
    ...USAGE_POINTS.map((p) => `- ${p}`),
    "",
    "",
  ].join("\n");
  // After the card's YAML front matter and its title, when it has them.
  const head = /^(---\n[\s\S]*?\n---\n+)?(# [^\n]*\n+)?/.exec(card)![0];
  return `${head}${block}${card.slice(head.length)}`;
}

/** Throws unless a Derivative's plan carries every duty. exportPlan calls it, so no plan can leave one out. */
function checkDerivativePlan(files: readonly PlanFile[], title: string, d: SparkDerivative): void {
  const byPath = new Map(files.map((f) => [f.path, f]));
  // Inline, the kit's Usage Policy is the Muse Usage Policy's bytes, so there is no second copy of it.
  const own = isInline(d) ? DERIVATIVE_DRIVE_FILES.map((f) => f.path) : Object.values(SPARK_DERIVATIVE_FILES);
  for (const p of [...own, "licenses/Apache-2.0.txt", "licenses/USAGE_POLICY.md", "licenses/CHANGES.md"]) {
    if (!byPath.has(p)) throw new Error(`A Derivative of Muse Spark Open can't go on a drive without ${p}.`);
  }
  if (isInline(d)) {
    for (const want of DERIVATIVE_DRIVE_FILES) {
      if (byPath.get(want.path)?.sha256 !== licenseOf(want.from).sha256) throw new Error(`A Derivative's ${want.path} must be the release's own text.`);
    }
  }
  const text = (p: string) => {
    const f = byPath.get(p);
    return f && "text" in f ? f.text : "";
  };
  if (!title.includes(BUILT_WITH)) throw new Error(`A Derivative's title must say "${BUILT_WITH}".`);
  for (const p of ["README.txt", "Start Here.html", "MODEL_CARD.md", "support/model.tsv"]) {
    if (!text(p).includes(BUILT_WITH)) throw new Error(`A Derivative's ${p} must say "${BUILT_WITH}".`);
  }
  for (const p of ["README.txt", "Start Here.html", "MODEL_CARD.md"]) {
    const page = text(p);
    if (!/18 and over/.test(page) || !/as written by a person/.test(page) || !/false premises?/.test(page)) {
      throw new Error(`A Derivative's ${p} must carry the Usage Policy's points.`);
    }
  }
  if (!/modified/i.test(text("licenses/CHANGES.md")) || !/Derivative of Muse Spark Open/.test(text("licenses/CHANGES.md"))) {
    throw new Error("A Derivative's licenses/CHANGES.md must say the weights were modified and what it derives from.");
  }
}

const SITE_LINK = `<a href="${escapeHtml(MUSE_MUSE_SITE)}">${escapeHtml(MUSE_MUSE_SITE)}</a>`;

const GLIMMER_README_NOTICE = [
  "Fine-tuned from Meta's Muse Glimmer 30B (Apache 2.0). Not made, reviewed or",
  "endorsed by Meta. What was changed is in licenses/CHANGES.md. Meta's Usage Policy",
  "applies, and Muse Glimmer is not intended for anyone under 18",
  "(licenses/USAGE_POLICY.md).",
].join("\n");

const GLIMMER_ABOUT = [
  `    <li>Fine-tuned from Meta's Muse Glimmer 30B (Apache 2.0). Not made, reviewed or endorsed by Meta. <span class="file">licenses/CHANGES.md</span> says what was changed.</li>`,
  `    <li>Meta's Usage Policy applies to how you use it, and Muse Glimmer is not intended for anyone under 18: <span class="file">licenses/USAGE_POLICY.md</span>.</li>`,
];

const filesFromHtml = (repo: string, commit: string) =>
  `    <li>The model card is <span class="file">MODEL_CARD.md</span>. The files come from <span class="file">${escapeHtml(repo)}</span> at commit <span class="file">${commit.slice(0, 12)}</span>, and <span class="file">PROVENANCE.json</span> lists where every file came from.</li>`;

const OWNER_CONTACT = "ask whoever gave you this drive";
const OWNER_README_PAGE = `Muse Muse, which\nmade it, is at ${MUSE_MUSE_SITE}`;
const OWNER_ABOUT_MORE = [
  `    <li>Made with Muse Muse: ${SITE_LINK}.</li>`,
  "    <li>A file that doesn't match its checksum? Ask whoever gave you this drive for a new one.</li>",
].join("\n");

/** A drive the bench makes for an order: the invoice's words and the model's public page, as bench drives always said. */
export function orderWords(model: Pick<ImageModel, "adapterJobId" | "repo" | "commit">, contactRaw: string | null | undefined): DriveWords {
  const page = modelPageUrl(model.adapterJobId);
  const contact = contactRaw && !/[\s<>"'`$\\]/.test(contactRaw) ? contactRaw : null;
  const contactHtml = contact ? `Write to <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>` : "Reply to the email your invoice came from";
  const pageHtml = escapeHtml(page);
  return {
    page,
    contact: contactText(contact),
    readmePage: `The model's page,\nwith its eval and Try it live, is ${page}`,
    readmeNotice: GLIMMER_README_NOTICE,
    elsewhereHtml: ` On those, the same files are free on <a href="https://huggingface.co/${escapeHtml(model.repo)}">Hugging Face</a>, and the model's page is <a href="${pageHtml}">${pageHtml}</a>.`,
    checksumsNote: " The same checksums are on the model's Hugging Face page.",
    aboutHtml: [...GLIMMER_ABOUT, filesFromHtml(model.repo, model.commit)].join("\n"),
    aboutMoreHtml: [
      `    <li>The model's eval, and Try it live while a demo runs, are on its page: <a href="${pageHtml}">${pageHtml}</a>.</li>`,
      `    <li>A drive that arrived broken, or a file that doesn't match its checksum? ${contactHtml} for a replacement or a refund.</li>`,
    ].join("\n"),
  };
}

/**
 * A drive the owner made, of Muse Glimmer: from a lab model's GGUF repo (`repo`, public or not), or from the owner's own
 * private copy (no repo). Meta's notice, and no order's words.
 */
export function ownerGlimmerWords(repo: { repo: string; commit: string; public: boolean } | null): DriveWords {
  const hub = repo?.public ? `https://huggingface.co/${escapeHtml(repo.repo)}` : null;
  return {
    page: MUSE_MUSE_SITE,
    contact: OWNER_CONTACT,
    readmePage: OWNER_README_PAGE,
    readmeNotice: GLIMMER_README_NOTICE,
    elsewhereHtml: hub ? ` On those, the same files are free on <a href="${hub}">Hugging Face</a>.` : "",
    checksumsNote: hub ? " The same checksums are on the model's Hugging Face page." : "",
    aboutHtml: [
      ...GLIMMER_ABOUT,
      repo
        ? filesFromHtml(repo.repo, repo.commit)
        : `    <li>The model card is <span class="file">MODEL_CARD.md</span>, and <span class="file">PROVENANCE.json</span> lists where every file came from.</li>`,
    ].join("\n"),
    aboutMoreHtml: OWNER_ABOUT_MORE,
  };
}

/** A drive the owner made from a board's fine-tune of a Llama base: the Llama license and "Built with Llama", never Muse Glimmer's. */
export function ownerLlamaWords(base: string): DriveWords {
  return {
    page: MUSE_MUSE_SITE,
    contact: OWNER_CONTACT,
    readmePage: OWNER_README_PAGE,
    readmeNotice: [
      `Built with Llama. Fine-tuned from ${base} on a Jetson. Not made, reviewed or`,
      "endorsed by Meta. What was changed is in licenses/CHANGES.md, and its license",
      "is licenses/LLAMA_3.2_LICENSE.txt.",
    ].join("\n"),
    elsewhereHtml: "",
    checksumsNote: "",
    aboutHtml: [
      `    <li>Built with Llama. Fine-tuned from ${escapeHtml(base)} on an NVIDIA Jetson, with Muse Muse. Not made, reviewed or endorsed by Meta. <span class="file">licenses/CHANGES.md</span> says what was changed, and <span class="file">licenses/LLAMA_3.2_LICENSE.txt</span> is its license.</li>`,
      `    <li>The model card is <span class="file">MODEL_CARD.md</span>, and <span class="file">PROVENANCE.json</span> lists where every file came from.</li>`,
    ].join("\n"),
    aboutMoreHtml: OWNER_ABOUT_MORE,
  };
}

/** The bench's model, as every bench drive has had it: the order's files, the card and tuned.jinja from its repo. */
export function orderModel(model: ImageModel, card: string, tuned: string | null, contact: string | null | undefined, pin: RuntimePin): PlanModel {
  const raw = (name: string) => `https://huggingface.co/${model.repo}/raw/${model.commit}/${name}`;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  return {
    title: model.title,
    slug: model.slug,
    systemLine: model.systemLine,
    family: "glimmer",
    builds: model.files.map((f) => ({ level: f.level, name: f.name, bytes: f.bytes, sha256: f.sha256 })),
    adapter: null,
    card,
    tuned,
    changes: changesText(model, pin),
    sources: [
      // A Derivative's license and r30b's notice: the GGUF repo at the files' commit carries the same bytes (lib/train/hub-steps.ts).
      ...(model.sparkOpen ? DERIVATIVE_DRIVE_FILES.map((d) => ({ path: d.path, url: raw(d.from), sha256: licenseOf(d.from).sha256 })) : []),
      { path: "MODEL_CARD.md", url: raw("README.md"), sha256: sha(card) },
      ...(tuned === null ? [] : [{ path: "model/tuned.jinja", url: raw("tuned.jinja"), sha256: sha(tuned) }]),
    ],
    words: orderWords(model, contact),
    ...(model.sparkOpen ? { derivative: inlineSparkDerivative() } : {}),
  };
}

// ---------- The image ----------

function textFile(rel: string, text: string, exec = false): PlanFile {
  return { path: rel, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), text, ...(exec ? { exec: true as const } : {}) };
}

/**
 * Lays out the image of one model: every file on the drive but the model files and the two manifests. Pure: the kit
 * names its files by sha256, and the templates come in already read.
 */
export function planDriveImage(model: PlanModel, kit: DriveKit, templates: DriveTemplates): ImagePlan {
  if (!model.builds.length) throw new Error("The order has no model files.");
  const files: PlanFile[] = [];
  for (const k of kit.files) {
    if (k.family === "common" || k.family === model.family) {
      files.push({ path: k.path, bytes: k.bytes, sha256: k.sha256, kit: true, ...(k.exec ? { exec: true as const } : {}) });
    }
  }
  const add = (rel: string, text: string, exec = false) => files.push(textFile(rel, text, exec));

  add("MODEL_CARD.md", model.card);
  const inline = model.derivative && isInline(model.derivative) ? model.derivative.inline : [];
  for (const f of inline) add(f.path, f.text);
  const sparkOpen = sparkOpenText({ sparkOpen: inline.length > 0 });
  if (model.tuned !== null) add("model/tuned.jinja", model.tuned);

  // What the launchers read, and the chat's preset settings (llama-server --ui-config-file).
  const builds = sortedBuilds(model.builds);
  // pickBuild reads only the level as a name and the bytes, so a board's Q8_0 or a stage 2 IQ1_S rates like any build.
  const localFiles = builds as unknown as LocalFile[];
  const table = launcherTable(localFiles);
  add("support/builds.tsv", table);
  add("support/files.tsv", `level\tname\tbytes\n${builds.map((f) => `${f.level}\t${f.name}\t${f.bytes}`).join("\n")}\n`);
  // The launchers print the page (Try it live, or the site) and whom to write (a drive that fails Verify) from here.
  const words = model.words;
  add(
    "support/model.tsv",
    `title\t${model.title.replace(/[\t\r\n]+/g, " ")}\nslug\t${model.slug}\npage\t${words.page}\ncontact\t${words.contact}\n${model.adapter ? `adapter\t${model.adapter.name}\n` : ""}`,
  );
  add("model/system.txt", `${model.systemLine}\n`);
  add("model/ui-config.json", `${JSON.stringify({ systemMessage: model.systemLine, temperature: 0 }, null, 2)}\n`);

  // The pages and launchers, from drive/.
  const spec = minimumSpecText(minimumSpec(localFiles));
  const rows = builds
    .map((f) => `        <tr><td>${escapeHtml(f.level)}</td><td class="num">${(f.bytes / 1e9).toFixed(1)} GB</td><td>${escapeHtml(buildForText(table, f.level))}</td></tr>`)
    .join("\n");
  const notes: string[] = [];
  if (model.tuned !== null) {
    notes.push(`<p>This model was trained before it learned to open its own answers, so the launchers start it with <span class="file">model/tuned.jinja</span> from its repo.</p>`);
  }
  if (model.adapter) {
    notes.push(
      `<p>It is the base model with the adapter <span class="file">model/${escapeHtml(model.adapter.name)}</span> on top, as it ran on the board where it was tuned. The launchers load both.</p>`,
    );
  }
  if (model.derivative && !isInline(model.derivative)) notes.push(derivativeNote(model.derivative));
  const runtime = `${kit.runtime.build} (${kit.runtime.version})`;
  const values = {
    TITLE: escapeHtml(model.title),
    MIN_SPEC: escapeHtml(spec),
    BUILD_ROWS: rows,
    SYSTEM_LINE: escapeHtml(model.systemLine),
    TUNED_NOTE: notes.join("\n  "),
    ELSEWHERE_HTML: words.elsewhereHtml,
    CHECKSUMS_NOTE: words.checksumsNote,
    ABOUT_HTML: words.aboutHtml,
    ABOUT_MORE_HTML: words.aboutMoreHtml,
    RUNTIME: runtime,
    IMAGE_VERSION: kit.imageVersion,
    SPARK_OPEN_HTML: sparkOpen.html,
  };
  const adapter = model.adapter !== null;
  add("Start Here.html", fill(templates["Start Here.html"], values));
  add(
    "README.txt",
    crlf(
      fill(templates["README.txt"], {
        TITLE: model.title,
        SPARK_OPEN_TEXT: sparkOpen.text,
        MIN_SPEC: spec,
        RUNTIME: runtime,
        PAGE_TEXT: words.readmePage,
        NOTICE_TEXT: words.readmeNotice,
        CONTACT_TEXT: words.contact,
      }),
    ),
  );
  add("Start (Mac).command", adapterBlocks(templates["Start (Mac).command"], adapter), true);
  add("Verify (Mac).command", templates["Verify (Mac).command"], true);
  add("Start (Windows).cmd", crlf(templates["Start (Windows).cmd"]));
  add("Verify (Windows).cmd", crlf(templates["Verify (Windows).cmd"]));
  add("support/start-windows.ps1", crlf(adapterBlocks(templates["support/start-windows.ps1"], adapter)));
  add("support/verify-windows.ps1", crlf(templates["support/verify-windows.ps1"]));
  add("licenses/CHANGES.md", model.changes);

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let i = 1; i < files.length; i++) {
    if (files[i].path === files[i - 1].path) throw new Error(`The drive's layout has ${files[i].path} twice.`);
  }
  const sources = [...kit.sources.filter((s) => s.family === "common" || s.family === model.family).map(({ path: p, url, sha256 }) => ({ path: p, url, sha256 })), ...model.sources];
  return { imageVersion: kit.imageVersion, files, sources };
}

// ---------- An export: the image, the model files, PROVENANCE.json and SHA256SUMS ----------

export interface ExportFacts {
  exportId: string;
  madeAt: Date;
  /** "board:<run>", "lab:<jobId>:<build>" or "url". */
  source: string;
  /** Where the model was tuned, for PROVENANCE.json: { where: "board" | "cloud", base, ... }. */
  tuned: Record<string, unknown>;
  /** The board writing it, by its hardware and server version only: never a hostname, an address or a token. */
  madeBy: { board: string | null; museDevice: string | null };
}

export const exportFolder = (slug: string, exportId: string) => `MuseMuse/${slug}-${exportId.slice(4, 8)}`;

/** PROVENANCE.json for a drive the board writes: what the bench writes, plus where the model was tuned. */
export function exportProvenance(
  facts: ExportFacts,
  image: Pick<ImagePlan, "imageVersion" | "sources">,
  runtime: DriveKit["runtime"],
  modelFiles: ReadonlyArray<{ path: string; bytes: number; sha256: string; source: string }>,
): string {
  const doc = {
    export: facts.exportId,
    madeAt: facts.madeAt.toISOString(),
    imageVersion: image.imageVersion,
    madeBy: facts.madeBy,
    tuned: facts.tuned,
    files: modelFiles.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256, source: f.source })),
    runtime,
    sources: image.sources,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * The plan a board's export_model takes: the image, then the model files (from the board's ~/models or by URL), then
 * PROVENANCE.json and SHA256SUMS last, so a drive is complete only once its checksums are on it.
 */
export function exportPlan(model: PlanModel, kit: DriveKit, templates: DriveTemplates, facts: ExportFacts): DrivePlan {
  if (!EXPORT_ID.test(facts.exportId)) throw new Error(`${facts.exportId} isn't an export id.`);
  const image = planDriveImage(model, kit, templates);
  const modelFiles = [...sortedBuilds(model.builds), ...(model.adapter ? [model.adapter] : [])].map((f) => {
    if (!f.from || !f.source) throw new Error(`${f.name} has no source to export it from.`);
    return { path: `model/${f.name}`, bytes: f.bytes, sha256: f.sha256, from: f.from, source: f.source, name: f.name };
  });
  if (model.derivative) checkSparkDerivative(model.derivative);
  const linked = model.derivative && !isInline(model.derivative) ? model.derivative : null;
  const licenseFiles = linked
    ? SPARK_DERIVATIVE_KEYS.map((k) => ({ path: SPARK_DERIVATIVE_FILES[k], bytes: linked.files[k].bytes, sha256: linked.files[k].sha256.toLowerCase(), source: "the model's release folder" }))
    : [];
  const provenance = textFile("PROVENANCE.json", exportProvenance(facts, image, kit.runtime, [...modelFiles, ...licenseFiles]));
  const files: PlanFile[] = [
    ...image.files,
    ...modelFiles.map((f): PlanFile => (f.from === "board" ? { path: f.path, bytes: f.bytes, sha256: f.sha256, board: f.name } : { path: f.path, bytes: f.bytes, sha256: f.sha256, url: true })),
    ...licenseFiles.map((f): PlanFile => ({ path: f.path, bytes: f.bytes, sha256: f.sha256, url: true })),
    provenance,
  ];
  if (model.derivative) checkDerivativePlan(files, model.title, model.derivative);
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) throw new Error(`The drive's layout has ${f.path} twice.`);
    seen.add(f.path);
  }
  files.push(textFile("SHA256SUMS", sha256Sums(files)));
  if (files.length > MAX_PLAN_FILES) throw new Error(`The plan has ${files.length} files, and a board takes at most ${MAX_PLAN_FILES}.`);
  return {
    format: PLAN_FORMAT,
    export: facts.exportId,
    folder: exportFolder(model.slug, facts.exportId),
    imageVersion: image.imageVersion,
    source: facts.source,
    needsLargeFiles: files.some((f) => f.bytes > FAT32_MAX_FILE_BYTES),
    files,
  };
}

/** The sha256 of a plan's SHA256SUMS, which the read-back on the drive must end with. */
export function planManifestSha256(plan: Pick<DrivePlan, "files">): string | null {
  return plan.files.find((f) => f.path === "SHA256SUMS")?.sha256 ?? null;
}

/** All the bytes a plan puts on a drive. */
export const planBytes = (plan: Pick<DrivePlan, "files">) => plan.files.reduce((n, f) => n + f.bytes, 0);

// ---------- Writing a plan into a folder ----------

export interface PlanSources {
  /** The cached copy of a kit file, by sha256. */
  kitFile?: (sha256: string) => string;
  /** A file in the board's ~/models, by name. Only tests and a folder standing in for a drive use it. */
  boardFile?: (name: string) => string;
  /** A local copy of a file the board would download. */
  urlFile?: (file: PlanFile) => string;
}

async function copyChecked(from: string, to: string, sha256: string): Promise<void> {
  const hash = createHash("sha256");
  const tap = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(createReadStream(from, { highWaterMark: 4 * 1024 * 1024 }), tap, createWriteStream(to));
  if (hash.digest("hex") !== sha256) {
    await fs.rm(to, { force: true });
    throw new Error(`${path.basename(to)} didn't match its sha256 in the plan, so it wasn't kept.`);
  }
}

/** Writes every file of a plan into `dir`, checking each one's sha256. Inline text is checked before it is written. */
export async function writePlan(files: readonly PlanFile[], dir: string, from: PlanSources = {}): Promise<void> {
  for (const f of files) {
    const dest = path.join(dir, ...f.path.split("/"));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if ("text" in f) {
      if (createHash("sha256").update(f.text).digest("hex") !== f.sha256) throw new Error(`${f.path}'s text doesn't match its sha256.`);
      await fs.writeFile(dest, f.text);
    } else {
      const source = "kit" in f ? from.kitFile?.(f.sha256) : "board" in f ? from.boardFile?.(f.board) : from.urlFile?.(f);
      if (!source) throw new Error(`Nothing gives ${f.path} here.`);
      await copyChecked(source, dest, f.sha256);
    }
    if (f.exec) await fs.chmod(dest, 0o755);
  }
}

// ---------- A board's fine-tune ----------

/** What a board's export_source answers for a finished run (muse-device/server.py). */
export interface BoardSource {
  run: string;
  adapter: { name: string; bytes: number; sha256: string };
  bases: Array<{ name: string; level: string; bytes: number; sha256: string; source: { url: string } | null }>;
  config: { base: string; dataset: string; steps: number; rank: number; lr: number; max_length: number };
  status: { examples?: number | null; skipped?: number | null; loss?: number | null; seconds?: number | null; peak_gpu_gib?: number | null };
  base_revision: string | null;
  system: string | null;
  converter: string;
  board: { model: string | null; muse_device: string | null };
}

/** The base repos the kit has licenses for, by the name the board trains them under. */
export const BOARD_BASES: Record<string, { family: BaseFamily; repo: string; revision: string }> = {
  "Llama-3.2-1B-Instruct": { family: "llama", repo: LLAMA_BOARD_BASE.repo, revision: LLAMA_BOARD_BASE.revision },
};

/** A slug for a run's name: lower case letters, digits and dashes, as a folder on any drive takes it. */
export function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "model";
}

const queryless = (url: string) => url.split(/[?#]/)[0];

/** Why a board run can't be exported, in a sentence, or null when it can. */
export function boardSourceProblem(src: BoardSource): string | null {
  if (!BOARD_BASES[src.config.base]) {
    return `Run ${src.run} was tuned on ${src.config.base}, and the drive kit only has licenses for ${Object.keys(BOARD_BASES).join(", ")}. It can't go on a drive yet.`;
  }
  if (!src.bases.length) return `This board has no GGUF of ${src.config.base} for the adapter to load on.`;
  return null;
}

/** The model of a board's fine-tune: its base builds and adapter, a short card, and its CHANGES.md. */
export function boardModel(src: BoardSource, pin: RuntimePin, build?: string): PlanModel {
  const problem = boardSourceProblem(src);
  if (problem) throw new Error(problem);
  const base = BOARD_BASES[src.config.base];
  const bases = build ? src.bases.filter((b) => b.level === build) : src.bases;
  if (!bases.length) throw new Error(`This board has no ${build} build of ${src.config.base}.`);
  const builds: ModelBuild[] = bases.map((b) => ({
    level: b.level,
    name: b.name,
    bytes: b.bytes,
    sha256: b.sha256,
    from: "board",
    source: `board: ~/models/${b.name}, ${b.source?.url ? `downloaded from ${queryless(b.source.url)}` : "installed by hand"}`,
  }));
  const s = src.status;
  const facts = [
    `- Base: ${src.config.base}, https://huggingface.co/${base.repo}${src.base_revision ? ` at revision ${src.base_revision}` : ""}`,
    `- Base builds on this drive: ${builds.map((b) => b.name).join(", ")}`,
    `- Adapter: ${src.adapter.name}, from ${src.converter}`,
    `- Dataset: ${src.config.dataset}${typeof s.examples === "number" ? `, ${s.examples} examples` : ""}${s.skipped ? ` (${s.skipped} left out as too long)` : ""}`,
    `- Training: ${src.config.steps} steps, rank ${src.config.rank}, learning rate ${src.config.lr}, examples up to ${src.config.max_length} tokens`,
    ...(typeof s.loss === "number" ? [`- Final loss ${s.loss}${typeof s.seconds === "number" ? `, after ${s.seconds} seconds` : ""}${typeof s.peak_gpu_gib === "number" ? `, at most ${s.peak_gpu_gib} GiB of GPU memory` : ""}`] : []),
  ];
  const card = [
    `# ${src.run}`,
    "",
    `A LoRA adapter fine-tuned with Muse Muse on an NVIDIA Jetson Orin Nano, on top of ${src.config.base}.`,
    "",
    ...facts,
    "",
    "## License",
    "",
    "Built with Llama.",
    "",
    `${src.config.base} is licensed under the Llama 3.2 Community License (licenses/LLAMA_3.2_LICENSE.txt), and its`,
    "Acceptable Use Policy is licenses/LLAMA_3.2_USE_POLICY.md. This fine-tune wasn't made, reviewed or endorsed by Meta.",
    "What was changed is in licenses/CHANGES.md.",
    "",
  ].join("\n");
  const changes = [
    "# Changes",
    "",
    `This drive holds a modified version of ${src.config.base}, which Meta licenses under the Llama 3.2 Community License`,
    "(licenses/LLAMA_3.2_LICENSE.txt). This is what was changed:",
    "",
    `- Muse Muse fine-tuned a LoRA adapter on it on an NVIDIA Jetson Orin Nano (run ${src.run}: ${src.config.steps} steps, rank ${src.config.rank}, from the dataset ${src.config.dataset}).`,
    `- ${src.converter} turned the adapter into model/${src.adapter.name}.`,
    `- The base model's weights aren't changed. ${builds.map((b) => `model/${b.name}`).join(" and ")} ${builds.length > 1 ? "are GGUF builds" : "is a GGUF build"} of them, and the adapter loads on top.`,
    "",
    `The llama.cpp runtime (MIT, licenses/llama.cpp-LICENSE.txt) is release ${pin.build} (${pin.version}), unchanged. Only`,
    "the server and the libraries it loads are on the drive.",
    "",
    `Built with Llama. ${src.config.base} is Meta's model. This fine-tune wasn't made, reviewed or endorsed by Meta.`,
    "",
  ].join("\n");
  return {
    // The license (1.b.i) asks that a model made from Llama carries "Llama" at the start of its name.
    title: `Llama ${src.run}`,
    slug: slugOf(src.run),
    systemLine: src.system ?? "",
    family: base.family,
    builds,
    adapter: { ...src.adapter, from: "board", source: `board: ~/models/${src.adapter.name}, made by training run ${src.run}` },
    card,
    tuned: null,
    changes,
    sources: [],
    words: ownerLlamaWords(src.config.base),
  };
}

/** PROVENANCE.json's "tuned" block for a board run. */
export function boardTuned(src: BoardSource): Record<string, unknown> {
  const base = BOARD_BASES[src.config.base];
  return {
    where: "board",
    base: src.config.base,
    baseSource: base ? `https://huggingface.co/${base.repo}` : null,
    baseRevision: src.base_revision,
    run: src.run,
    dataset: src.config.dataset,
    examples: src.status.examples ?? null,
    skipped: src.status.skipped ?? null,
    steps: src.config.steps,
    rank: src.config.rank,
    lr: src.config.lr,
    maxLength: src.config.max_length,
    loss: src.status.loss ?? null,
    seconds: src.status.seconds ?? null,
    converter: src.converter,
  };
}

// ---------- A lab model, or the owner's own file ----------

/** A lab model's checked local files, as localFilesFor has them, with its card and tuned.jinja from the repo. */
export interface LabSource {
  title: string;
  slug: string;
  systemLine: string;
  adapterJobId: string;
  quantJobId: string;
  repo: string;
  commit: string;
  public: boolean;
  files: Array<{ level: string; name: string; bytes: number; sha256: string }>;
  card: string;
  tuned: string | null;
  /** True for files merged into r30b (LocalFiles.sparkOpen, isSparkOpenDerivative): a Derivative of Muse Spark Open. */
  sparkOpen?: boolean;
}

export function labModel(src: LabSource, pin: RuntimePin): PlanModel {
  const order = orderModel(
    {
      title: src.title,
      slug: src.slug,
      systemLine: src.systemLine,
      needsTunedTemplate: src.tuned !== null,
      quantJobId: src.quantJobId,
      adapterJobId: src.adapterJobId,
      repo: src.repo,
      commit: src.commit,
      files: src.files as ImageModel["files"],
      ...(src.sparkOpen ? { sparkOpen: true } : {}),
    },
    src.card,
    src.tuned,
    null,
    pin,
  );
  return {
    ...order,
    builds: order.builds.map((b) => ({ ...b, from: "url", source: `https://huggingface.co/${src.repo}/resolve/${src.commit}/${b.name}` })),
    words: ownerGlimmerWords({ repo: src.repo, commit: src.commit, public: src.public }),
    ...(src.sparkOpen
      ? {
          title: src.title.includes(BUILT_WITH) ? src.title : `${src.title} (${BUILT_WITH})`,
          // Its source in PROVENANCE.json stays the repo's card, by that file's own sha256.
          card: labDerivativeCard(src.card),
        }
      : {}),
  };
}

/** A tuned Glimmer file the owner keeps privately (stage 2 in S3), with the facts the owner's script gives. */
export interface UrlSource {
  title: string;
  slug: string;
  systemLine: string;
  file: { level: string; name: string; bytes: number; sha256: string };
  /** What was done to Meta's model, one sentence each, for CHANGES.md and the card. */
  changes: string[];
  /** A knowledge-run model's duties. Required when its file name or slug is a knowledge run's (KNOWLEDGE_RUN_NAME). */
  derivative?: LinkedSparkDerivative;
}

export function urlModel(src: UrlSource, pin: RuntimePin): PlanModel {
  if (src.derivative || isKnowledgeRunName(src.file.name, src.slug, src.title)) checkLinkedDerivative(src.derivative);
  const d = src.derivative;
  const changes = [
    "# Changes",
    "",
    "This drive holds a modified version of Meta's Muse Glimmer 30B, which Meta licenses under the Apache License 2.0",
    "(licenses/Apache-2.0.txt). As section 4(b) of that license asks, this is what was changed:",
    "",
    ...src.changes.map((c) => `- ${c}`),
    `- The file is model/${src.file.name}, from the owner's private copy.`,
    "",
    `The llama.cpp runtime (MIT, licenses/llama.cpp-LICENSE.txt) is release ${pin.build} (${pin.version}), unchanged. Only`,
    "the server and the libraries it loads are on the drive.",
    "",
    "Muse Glimmer is Meta's model. This fine-tune wasn't made, reviewed or endorsed by Meta.",
    "",
    ...(d
      ? [
          "It is also a Derivative of Muse Spark Open under the Muse Model License: Muse Spark Open wrote part of the first",
          "stage's training data. Its terms are licenses/MUSE_MODEL_LICENSE.md and licenses/MUSE_USAGE_POLICY.md. Muse Muse's",
          "own changes are released under the Apache License 2.0 (licenses/NOTICE).",
          "",
        ]
      : []),
  ].join("\n");
  const title = d && !src.title.includes(BUILT_WITH) ? `${src.title} (${BUILT_WITH})` : src.title;
  const extra = d ? derivativeCard(d) : null;
  const card = [
    `# ${title}`,
    "",
    ...(extra ? [extra.head, ""] : []),
    "A fine-tune of Meta's Muse Glimmer 30B, made with Muse Muse.",
    "",
    ...src.changes.map((c) => `- ${c}`),
    "",
    ...(extra ? [extra.safety] : []),
    "See licenses/CHANGES.md and PROVENANCE.json.",
    "",
  ].join("\n");
  const words = ownerGlimmerWords(null);
  return {
    title,
    slug: slugOf(src.slug),
    systemLine: src.systemLine,
    family: "glimmer",
    builds: [{ ...src.file, from: "url", source: "the owner's private copy" }],
    adapter: null,
    card,
    tuned: null,
    changes,
    sources: [],
    words: d ? derivativeWords(words, d) : words,
    ...(d ? { derivative: d } : {}),
  };
}
