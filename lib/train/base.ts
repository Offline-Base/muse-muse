/**
 * The lab's fine-tuning base, and the one rule for which lab models are Derivatives of Muse Spark Open
 * (docs/TRAINING.md, "The base model").
 *
 * Since Oct 31, 2026 (owner: "Switch outright to r30b") every new glimmer-lora job trains on r30b, Muse Muse's
 * 2026-knowledge Muse Glimmer 30B (OfflineBase/Glimmer-30B-2026-Knowledge, in the nf4 build the recipe loads), and plain
 * Glimmer is no longer offered. Muse Spark Open wrote part of r30b's training data, so r30b, and every model trained
 * from it, is a Derivative under the Muse Model License: wherever such a model is shown or shipped it says "Built with
 * Muse Spark Open", carries the Usage Policy's points (USAGE_POINTS) and ships MUSE_MODEL_LICENSE.md, USAGE_POLICY.md and
 * NOTICE (lib/train/licenses). Jobs from before the switch trained on plain Glimmer and keep their wording.
 *
 * No I/O and no recipe source, so client components import it. GLIMMER_PY and QUANT_PY name the same repos, which
 * lib/train/__tests__/base.test.ts checks.
 */

/** The Hugging Face repo of r30b's merged BF16 weights, and every repo of its builds starts with it. */
export const R30B_REPO = "OfflineBase/Glimmer-30B-2026-Knowledge";
/** r30b's page on the Hugging Face Hub, which the lab's copy links. */
export const R30B_URL = `https://huggingface.co/${R30B_REPO}`;
/** The model glimmer-lora loads and trains on (GLIMMER_PY's MODEL), and its pinned commit (MODEL_REVISION). */
export const LAB_BASE_MODEL = `${R30B_REPO}-unsloth-bnb-4bit`;
export const LAB_BASE_REVISION = "6f12bf5288dd4d83374e1d6cab3b6b80da258eb1";
/** The 16-bit base glimmer-quantize merges into (QUANT_PY's MERGE_BASE), at the commit its shards were listed. */
export const LAB_MERGE_BASE = R30B_REPO;
export const LAB_MERGE_BASE_REVISION = "c06e38ccbb512f350e5c383944f1bbfb96f14248";
/** What every lab job trained on before the switch, at the commit glimmer-lora pinned then. */
export const PLAIN_GLIMMER_MODEL = "unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit";
export const PLAIN_GLIMMER_REVISION = "ecedda395d4d099b477d135a9a573eedaa5a7aad";

/**
 * The param the platform writes on every Glimmer job it creates (the jobs route): the base the job's GPU loads, so a
 * job's base is known from its row before it reports any metrics. Not one of the recipe's fields, so no caller sets it.
 */
export const BASE_MODEL_PARAM = "baseModel";

/** The line the Muse Model License asks for, shown prominently wherever a Derivative is shown or shipped. */
export const BUILT_WITH_SPARK_OPEN = "Built with Muse Spark Open";

/**
 * The Usage Policy's points a person must be told about a Derivative (Muse Model License, Exhibit A, and the Muse
 * Glimmer Usage Policy): who it is for, that its text is never a person's, and its known dangers.
 */
export const USAGE_POINTS: readonly string[] = [
  "For people 18 and over only.",
  "Its answers are written by a model. Never present them as written by a person.",
  "It can make up answers, and it can go along with a false premise in a question. Check what it says before you rely on it.",
];

/** True for r30b's repo or one of its builds (-unsloth-bnb-4bit, -GGUF, -LoRA). */
export function isR30bRepo(id: unknown): boolean {
  return typeof id === "string" && (id === R30B_REPO || id.startsWith(`${R30B_REPO}-`));
}

/**
 * What a job says about its base: its params (BASE_MODEL_PARAM, which the platform writes), its done metrics
 * (base_model, which glimmer-lora records, and merge_base, which glimmer-quantize records), and, where a caller has it,
 * the base its adapter_config.json names.
 */
export interface DerivativeSource {
  params?: Readonly<Record<string, unknown>> | null;
  metrics?: Readonly<Record<string, unknown>> | null;
  adapterBase?: string | null;
}

/**
 * The one rule: a lab model is a Derivative of Muse Spark Open when anything recorded about its base names r30b. A job
 * with no such record trained on plain Glimmer, before the switch.
 */
export function isSparkOpenDerivative(job: DerivativeSource | null | undefined): boolean {
  if (!job) return false;
  return (
    isR30bRepo(job.params?.[BASE_MODEL_PARAM]) ||
    isR30bRepo(job.metrics?.base_model) ||
    isR30bRepo(job.metrics?.merge_base) ||
    isR30bRepo(job.adapterBase)
  );
}

/** What a comparison calls the model a job started from, mid-sentence: r30b for a Derivative, else base Glimmer. */
export function baseName(derivative: boolean): string {
  return derivative ? "the 2026 Glimmer it started from" : "base Glimmer";
}

/** The same as a column or a label's start. */
export function baseLabel(derivative: boolean): string {
  return derivative ? "2026 Glimmer (r30b)" : "Base Glimmer";
}

const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * The 4-bit base a glimmer-lora job trained on, from its record: the baseModel param, else its base_model metric, else
 * plain Glimmer (a job from before either existed). The revision is its base_revision metric, else the commit the
 * recipe pinned for that model, else null. The Hub's checks hold an adapter's config to this, so an adapter from before
 * the switch is still published as what it is.
 */
export function recordedBase(job: Pick<DerivativeSource, "params" | "metrics"> | null | undefined): { model: string; revision: string | null } {
  const named = [job?.params?.[BASE_MODEL_PARAM], job?.metrics?.base_model].find((v): v is string => typeof v === "string" && REPO_ID.test(v));
  const model = named ?? PLAIN_GLIMMER_MODEL;
  const recorded = job?.metrics?.base_revision;
  const pinned = model === LAB_BASE_MODEL ? LAB_BASE_REVISION : model === PLAIN_GLIMMER_MODEL ? PLAIN_GLIMMER_REVISION : null;
  return { model, revision: typeof recorded === "string" && COMMIT.test(recorded) ? recorded : pinned };
}
