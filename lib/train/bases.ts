/**
 * Any Meta base (TUNE_ANY_BASE, docs/TRAINING.md "Any Meta base"): the rules for which Hugging Face repos a job may train
 * on. Llama and Glimmer only, with nothing else offered or accepted anywhere. Pure, so the picker, the routes, launchJob
 * and the tests share them; lib/train/base-check.ts reads the Hub and hands its facts to checkFacts.
 *
 * Only r30b and the original Muse Glimmer 30B have ever run on a GPU here. Every Llama path comes from Unsloth's and the
 * Hub's public pages, and the plan says so.
 */
import { familyOfRepo, isR30bRepo, LAB_BASE_MODEL, LAB_BASE_REVISION, licenseDuties, PLAIN_GLIMMER_MODEL, PLAIN_GLIMMER_REVISION, type BaseFamily, type LicenseDuties } from "@/lib/train/base";

export const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;

/** The sentence for a gated repo the Hub won't open for HF_TOKEN. */
export const GATED_REFUSAL = "Hugging Face won't give this token that gated model. Accept the license on the model's Hugging Face page, and check that HF_TOKEN has access to it.";

/** The one thing the picker says about untried bases. */
export const NEVER_RUN_TEXT = "This base has never been run on a GPU here, so its template, cost and time are from public documentation and estimates. The first run may fail, and the job's limits still hold.";

const ALLOWED_LLAMA = /^llama-(3\.[123]|4)-/i;
const LLAMA_NOT_TEXT = /guard|vision|prompt/i;

/** Why a pasted repo id isn't accepted, before anything asks the Hub. Null when its org and name are on the allowlist. */
export function repoProblem(id: unknown): string | null {
  if (typeof id !== "string" || !REPO_ID_RE.test(id) || id.includes("..")) return "Paste a Hugging Face repo id, like unsloth/Llama-3.2-3B-Instruct-bnb-4bit.";
  const [org, name] = id.split("/") as [string, string];
  const orgs = ["meta-llama", "unsloth", "OfflineBase"];
  const refuse = "Only Meta's models train here: Llama or Muse Glimmer builds from meta-llama, unsloth or OfflineBase.";
  if (!orgs.includes(org)) return refuse;
  if (/-(gguf|lora)$|-gguf-|-lora-/i.test(name)) return "That repo holds GGUF files or an adapter, and training needs safetensors weights.";
  if (/^llama-/i.test(name)) {
    if (LLAMA_NOT_TEXT.test(name)) return "Llama Guard, Prompt Guard and the Llama vision models don't fit this recipe's chat training.";
    if (!ALLOWED_LLAMA.test(name)) return "Only Llama 3.1, 3.2, 3.3 and 4 are mapped to their templates and licenses here.";
    return null;
  }
  if (org !== "meta-llama" && familyOfRepo(id) === "glimmer") return null;
  return refuse;
}

/** Architectures the recipe trains, each with its family (FAMILIES in the recipe, plus Glimmer's own markers). */
const ARCHITECTURES: Readonly<Record<string, BaseFamily>> = {
  MuseGlimmerForConditionalGeneration: "glimmer",
  LlamaForCausalLM: "llama3",
  Llama4ForConditionalGeneration: "llama4",
};

/** The recipe's GPUs, smallest memory first, in GB. */
export const BASE_GPUS: readonly { instanceType: string; memoryGb: number }[] = [
  { instanceType: "gpu_1x_a100_sxm4", memoryGb: 40 },
  { instanceType: "gpu_1x_h100_pcie", memoryGb: 80 },
  { instanceType: "gpu_1x_h100_sxm5", memoryGb: 80 },
];

/** Bytes per parameter of an nf4 build, from the Hub's own sizes: Llama 3.3 70B at 39.5 GB, Scout at 60.4 GB. */
const NF4_BYTES_PER_PARAM = 0.56;
/** Peak memory over the 4-bit files: Unsloth's 71 GB for Scout's 60.4 GB. r30b measured 1.08, so this is on the safe side. */
const TRAIN_MEMORY_FACTOR = 1.18;
/** What a card keeps free. */
const MEMORY_MARGIN = 0.95;
/** The largest 16-bit repo the recipe downloads to quantize as it loads. Past this, use a 4-bit build. */
export const MAX_UNQUANTIZED_BYTES = 65e9;
/** r30b's parameters: the step time the estimates scale from. */
const R30B_PARAMS = 29_776_626_688;
/** Smaller bases aren't counted as faster than half r30b's measured step: nothing has measured them. */
const MIN_SCALE = 0.5;

/** The repos that have run on a GPU here, at the commits they ran. */
const MEASURED: Readonly<Record<string, string>> = { [LAB_BASE_MODEL]: LAB_BASE_REVISION, [PLAIN_GLIMMER_MODEL]: PLAIN_GLIMMER_REVISION };

/** True when this repo at this commit has run on a GPU here. */
export function baseMeasured(repo: string, revision: string): boolean {
  return MEASURED[repo] === revision;
}

/** What the Hub says about a repo at a commit. */
export interface HubFacts {
  id: string;
  sha: string;
  gated: boolean;
  private: boolean;
  license: string | null;
  architectures: string[];
  quantized: boolean;
  /** Total parameters, from the Hub's safetensors summary. */
  params: number;
  /** The safetensors files' bytes. */
  bytes: number;
}

/** A base that passed every check, as it goes to the plan, the launch and the GPU. */
export interface ResolvedBase {
  repo: string;
  /** Its 40-hex commit. */
  revision: string;
  family: BaseFamily;
  gated: boolean;
  quantized: boolean;
  license: string | null;
  bytes: number;
  /** Peak GPU memory, in GB: an estimate from its size. */
  memoryGb: number;
  /** Step time over r30b's. */
  scale: number;
  /** The GPUs it fits, in the order to ask for them. */
  gpus: string[];
  /** True when this repo at this commit has run on a GPU here. */
  measured: boolean;
  /** Whether decide mode and local files work for it, with the reason when they don't. */
  decide: boolean;
  localFiles: string;
  duties: LicenseDuties;
}

export type BaseCheck = { ok: true; base: ResolvedBase } | { ok: false; error: string };

const no = (error: string): BaseCheck => ({ ok: false, error });

/** Every check on the Hub's facts: the allowlist again on the Hub's own id, the commit, license, architecture and fit. */
export function checkFacts(f: HubFacts): BaseCheck {
  const problem = repoProblem(f.id);
  if (problem) return no(problem);
  if (!COMMIT_RE.test(f.sha)) return no("The Hub didn't give a full commit for that repo, so it can't be pinned.");
  if (f.private) return no("That repo is private, so a run couldn't be repeated from it.");
  const family = f.architectures.map((a) => ARCHITECTURES[a]).find(Boolean);
  if (!family) return no(`Its architecture (${f.architectures.join(", ") || "none listed"}) isn't one the training script supports: Llama 3, Llama 4 or Muse Glimmer.`);
  if (family !== familyOfRepo(f.id)) return no("Its name and its architecture don't agree, so it isn't accepted.");
  const license = f.license?.toLowerCase() ?? null;
  if (family === "llama3" && !license?.startsWith("llama3")) return no(`Its Hub page says the license is ${license ?? "unknown"}, not a Llama license.`);
  if (family === "llama4" && license !== "other" && !license?.startsWith("llama4")) return no(`Its Hub page says the license is ${license ?? "unknown"}, not a Llama license.`);
  // Only r30b's builds carry the Muse Spark Open duties, so any other Glimmer has to be what the plain duties say it is.
  if (family === "glimmer" && !isR30bRepo(f.id) && license !== "apache-2.0") return no(`Its Hub page says the license is ${license ?? "unknown"}, and a Muse Glimmer build here is r30b or Apache 2.0.`);
  if (!f.bytes || !f.params) return no("It has no safetensors weights, and training needs them.");
  if (!f.quantized && f.bytes > MAX_UNQUANTIZED_BYTES) {
    return no(`Its 16-bit weights are ${Math.round(f.bytes / 1e9)} GB, too large to download and quantize on a job. Pick its 4-bit build.`);
  }
  const loaded = f.quantized ? f.bytes : f.params * NF4_BYTES_PER_PARAM;
  const memoryGb = Math.ceil((loaded * TRAIN_MEMORY_FACTOR) / 1e9);
  const gpus = BASE_GPUS.filter((g) => memoryGb <= g.memoryGb * MEMORY_MARGIN).map((g) => g.instanceType);
  if (!gpus.length) return no(`It needs about ${memoryGb} GB of GPU memory to train in 4-bit, and the largest GPU here has ${BASE_GPUS[BASE_GPUS.length - 1]!.memoryGb} GB.`);
  const measured = baseMeasured(f.id, f.sha);
  const glimmer = family === "glimmer";
  return {
    ok: true,
    base: {
      repo: f.id,
      revision: f.sha,
      family,
      gated: f.gated,
      quantized: f.quantized,
      license: f.license,
      bytes: f.bytes,
      memoryGb,
      scale: Math.max(MIN_SCALE, Math.round((f.params / R30B_PARAMS) * 100) / 100),
      gpus,
      measured,
      decide: glimmer && f.quantized,
      localFiles: "Local files (GGUF) only merge into the 2026 Glimmer (r30b), so this base can't make them.",
      duties: licenseDuties({ adapterBase: f.id }),
    },
  };
}

/** One line of the picker. `repo` is what goes to the check; the default sends no base at all, so it is exactly today's job. */
export interface CuratedBase {
  repo: string;
  /** The commit to pin, or null for the repo's head at check time. */
  revision: string | null;
  label: string;
  note: string;
}

export const CURATED_BASES: readonly CuratedBase[] = [
  { repo: PLAIN_GLIMMER_MODEL, revision: PLAIN_GLIMMER_REVISION, label: "Muse Glimmer 30B (original)", note: "Meta's, in 4-bit. Has run on a GPU here. Apache 2.0." },
  { repo: "unsloth/Llama-3.2-3B-Instruct-bnb-4bit", revision: null, label: "Llama 3.2 3B Instruct", note: "Unsloth's 4-bit build, no gate. Never run here." },
  { repo: "meta-llama/Llama-3.2-3B-Instruct", revision: null, label: "Llama 3.2 3B Instruct (Meta's repo)", note: "Gated: needs HF_TOKEN's access. Never run here." },
  { repo: "unsloth/Llama-3.1-8B-Instruct-bnb-4bit", revision: null, label: "Llama 3.1 8B Instruct", note: "Unsloth's 4-bit build, no gate. Never run here." },
  { repo: "meta-llama/Llama-3.1-8B-Instruct", revision: null, label: "Llama 3.1 8B Instruct (Meta's repo)", note: "Gated: needs HF_TOKEN's access. Never run here." },
  { repo: "unsloth/Llama-3.3-70B-Instruct-bnb-4bit", revision: null, label: "Llama 3.3 70B Instruct", note: "H100 only, and costs more. Never run here." },
  { repo: "unsloth/Llama-4-Scout-17B-16E-Instruct-unsloth-bnb-4bit", revision: null, label: "Llama 4 Scout", note: "H100 only, about 71 GB of its 80. Text only. Never run here." },
];

/** A body's `base`, as {repo, revision?}, or the sentence that refuses it. Undefined when there is none. */
export function askedBase(raw: unknown): { ok: true; value: { repo: string; revision: string | null } | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const b = raw as { repo?: unknown; revision?: unknown };
  const problem = repoProblem(b.repo);
  if (problem) return { ok: false, error: problem };
  if (b.revision !== undefined && b.revision !== null && (typeof b.revision !== "string" || !COMMIT_RE.test(b.revision))) {
    return { ok: false, error: "A base's revision must be a 40-character commit." };
  }
  return { ok: true, value: { repo: b.repo as string, revision: (b.revision as string | null | undefined) ?? null } };
}

/** The params launchJob writes for a checked base, which the recipe reads (use_base). No caller can send them. */
export function baseParams(b: ResolvedBase): Record<string, string | number> {
  return {
    baseModel: b.repo,
    baseRevision: b.revision,
    baseFamily: b.family,
    baseGated: b.gated ? 1 : 0,
    baseQuantized: b.quantized ? 1 : 0,
    baseScale: b.scale,
    baseBytes: b.bytes,
  };
}

/** The plan's words on a base: which model, its license duties, and what has never been tried. */
export function baseDutiesText(b: Pick<ResolvedBase, "duties" | "measured">): string {
  const d = b.duties;
  return [
    d.line ? `${d.line}.` : "",
    d.license,
    d.namePrefix ? `Its name on Hugging Face starts with ${d.namePrefix}.` : "",
    ...d.points,
    b.measured ? "" : NEVER_RUN_TEXT,
  ]
    .filter(Boolean)
    .join(" ");
}

/** A checked base as a run's settings keep it. */
export function tuneBaseOf(b: ResolvedBase): { repo: string; revision: string; scale: number; bytes: number; dutiesText: string } {
  return { repo: b.repo, revision: b.revision, scale: b.scale, bytes: b.bytes, dutiesText: baseDutiesText(b) };
}
