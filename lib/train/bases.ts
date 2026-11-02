/**
 * Any Meta base (TUNE_ANY_BASE, docs/TRAINING.md "Any Meta base"): the rules for which Hugging Face repos a job may train
 * on. Muse Glimmer builds only, with nothing else offered or accepted anywhere. Pure, so the picker, the routes, launchJob
 * and the tests share them; lib/train/base-check.ts reads the Hub and hands its facts to checkFacts.
 *
 * The organizers ruled on Nov 2 that Llama doesn't count as a Meta model in this hackathon, however it is run, so no Llama
 * repo is offered or accepted here (docs/MESSAGING.md, the rules section). Only r30b and the original Muse Glimmer 30B
 * (MEASURED) have run on a GPU here.
 */
import { familyOfRepo, isR30bRepo, LAB_BASE_MODEL, LAB_BASE_REVISION, licenseDuties, PLAIN_GLIMMER_MODEL, PLAIN_GLIMMER_REVISION, type BaseFamily, type LicenseDuties } from "@/lib/train/base";

export const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;

/** The sentence for a gated repo the Hub won't open for HF_TOKEN. */
export const GATED_REFUSAL = "Hugging Face won't give this token that gated model. Accept the license on the model's Hugging Face page, and check that HF_TOKEN has access to it.";

/** The one thing the picker says about untried bases. */
export const NEVER_RUN_TEXT = "This base has never been run on a GPU here, so its template, cost and time are from public documentation and estimates. The first run may fail, and the job's limits still hold.";

/** The sentence for any repo that isn't a Muse Glimmer build. */
export const GLIMMER_ONLY_REFUSAL = "Only Muse Glimmer trains here, from a build by unsloth or OfflineBase. Llama and other model families aren't offered.";

/** Why a pasted repo id isn't accepted, before anything asks the Hub. Null when it names a Muse Glimmer build from an allowed org. */
export function repoProblem(id: unknown): string | null {
  if (typeof id !== "string" || !REPO_ID_RE.test(id) || id.includes("..")) return "Paste a Hugging Face repo id, like unsloth/Muse-Glimmer-30B-unsloth-bnb-4bit.";
  const [org, name] = id.split("/") as [string, string];
  if (!["unsloth", "OfflineBase"].includes(org)) return GLIMMER_ONLY_REFUSAL;
  if (/-(gguf|lora)$|-gguf-|-lora-/i.test(name)) return "That repo holds GGUF files or an adapter, and training needs safetensors weights.";
  return familyOfRepo(id) === "glimmer" ? null : GLIMMER_ONLY_REFUSAL;
}

/** Architectures a picked base may have, each with its family. Glimmer's alone: the recipe's Llama families take no new job. */
const ARCHITECTURES: Readonly<Record<string, BaseFamily>> = {
  MuseGlimmerForConditionalGeneration: "glimmer",
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

/** The pickable repos that have run on a GPU here, at the commits they ran. The Nov 1 Llama harness tune isn't one: Llama isn't offered. */
const MEASURED: Readonly<Record<string, string>> = {
  [LAB_BASE_MODEL]: LAB_BASE_REVISION,
  [PLAIN_GLIMMER_MODEL]: PLAIN_GLIMMER_REVISION,
};

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
  if (!family) return no(`Its architecture (${f.architectures.join(", ") || "none listed"}) isn't Muse Glimmer's, and only Muse Glimmer trains here.`);
  if (family !== familyOfRepo(f.id)) return no("Its name and its architecture don't agree, so it isn't accepted.");
  const license = f.license?.toLowerCase() ?? null;
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

/** Muse Glimmer builds only: every row here must pass repoProblem, and a test keeps it so. */
export const CURATED_BASES: readonly CuratedBase[] = [
  { repo: PLAIN_GLIMMER_MODEL, revision: PLAIN_GLIMMER_REVISION, label: "Muse Glimmer 30B (original)", note: "Meta's, in 4-bit. Has run on a GPU here. Apache 2.0." },
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
