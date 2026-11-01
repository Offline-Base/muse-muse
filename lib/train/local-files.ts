/**
 * The device-sized GGUF files a glimmer-quantize job made from a judged adapter (docs/VIBE_TUNING.md, Feature 2). The
 * run-locally page, the device picker and drive orders read them through localFilesFor, never the job row directly.
 * This file holds only the types and QUANT_LEVELS, so client components import it too; localFilesFor reads the
 * database and lives in lib/train/local-files-server.ts, which only server code imports.
 */

/** The three builds every model gets, smallest first. */
export type QuantLevel = "Q3_K_M" | "Q4_K_M" | "Q6_K";
export const QUANT_LEVELS: readonly QuantLevel[] = ["Q3_K_M", "Q4_K_M", "Q6_K"];

/**
 * One-bit Muse Glimmer, for a Jetson Orin Nano (QUANT_TARGETS, lib/train/quant-targets.ts). It isn't a QuantLevel: the
 * run-locally guide and drive orders never offer it, and it reaches a page only through LocalFiles.lowBit.
 */
export const LOW_BIT_LEVEL = "IQ1_S";
export type BuildLevel = QuantLevel | typeof LOW_BIT_LEVEL;
/** Every build a glimmer-quantize job can make, smallest first. */
export const BUILD_LEVELS: readonly BuildLevel[] = [LOW_BIT_LEVEL, ...QUANT_LEVELS];

export interface LocalFile {
  level: QuantLevel;
  /** The file's name on the Hub, "muse-glimmer-30b-<slug>-<LEVEL>.gguf". */
  name: string;
  bytes: number;
  sha256: string;
}

export type LowBitFile = Omit<LocalFile, "level"> & { level: typeof LOW_BIT_LEVEL };

export interface LocalFiles {
  /** The glimmer-lora job whose adapter was merged, and the glimmer-quantize job that made the files. */
  adapterJobId: string;
  quantJobId: string;
  /** "<namespace>/<repo>" on the Hugging Face Hub and the commit holding the files. Null until published. */
  repo: string | null;
  commit: string | null;
  /**
   * True once the GGUF repo is public and its adapter is too: only then may pages link it or drives be ordered. An
   * adapter made private takes its files' pages and orders with it, even before their repo is made private as well.
   */
  public: boolean;
  /** Only the builds that passed their file checks, smallest first. */
  files: LocalFile[];
  /** The system message the model was trained with, exactly: "You are <role>.\n\nReasoning strength: low." */
  systemLine: string;
  /** An adapter trained before trainChannel needs tuned.jinja from the repo to answer in stock apps. */
  needsTunedTemplate: boolean;
  /** The model's title and slug, as its Hub repos name it. */
  title: string;
  slug: string;
  /**
   * True for a Derivative of Muse Spark Open (lib/train/base.ts: files merged into r30b). Pages that offer the files
   * then show "Built with Muse Spark Open" and the Usage Policy's points, and a drive ships its license files.
   */
  sparkOpen?: boolean;
  /** The one-bit build, when the job made one and it passed. Never in `files`. */
  lowBit?: LowBitFile | null;
  /** The small base these files merged into (QUANT_BASES in lib/train/quant-targets.ts). Absent or null for r30b. */
  quantBase?: string | null;
}
