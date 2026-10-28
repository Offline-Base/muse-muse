/**
 * The device-sized GGUF files a glimmer-quantize job made from a judged adapter (docs/VIBE_TUNING.md, Feature 2). The
 * run-locally page, the device picker and drive orders read them through localFilesFor, never the job row directly.
 */

/** The three builds every model gets, smallest first. */
export type QuantLevel = "Q3_K_M" | "Q4_K_M" | "Q6_K";
export const QUANT_LEVELS: readonly QuantLevel[] = ["Q3_K_M", "Q4_K_M", "Q6_K"];

export interface LocalFile {
  level: QuantLevel;
  /** The file's name on the Hub, "muse-glimmer-30b-<slug>-<LEVEL>.gguf". */
  name: string;
  bytes: number;
  sha256: string;
}

export interface LocalFiles {
  /** The glimmer-lora job whose adapter was merged, and the glimmer-quantize job that made the files. */
  adapterJobId: string;
  quantJobId: string;
  /** "<namespace>/<repo>" on the Hugging Face Hub and the commit holding the files. Null until published. */
  repo: string | null;
  commit: string | null;
  /** True once the GGUF repo is public: only then may pages link it or drives be ordered. */
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
}

/**
 * The newest glimmer-quantize job's files for this adapter that finished and passed its checks, or null when there is
 * none. Implemented by the quantize work (glimmer-quantize); until then it finds nothing.
 */
export async function localFilesFor(adapterJobId: string): Promise<LocalFiles | null> {
  void adapterJobId;
  return null;
}
