/**
 * The open-weight pages' own numbers, in one place, so every builder and calculator in this folder says the same
 * thing the mirrored text does (content/meta-docs/pages/muse-spark-open/*.md, muse-glimmer/*.md and the cookbook
 * recipes). Each value names the page it comes from. Anything a builder works out from these (a per-GPU share, a
 * per-slot context) is computed where it's used and labeled as derived there.
 */

export type OpenModel = "spark" | "glimmer";

export const MODEL_NAME: Record<OpenModel, string> = { spark: "Muse Spark Open", glimmer: "Muse Glimmer" };

/** The docs pages for each model, as our own /docs paths. */
export const PAGE: Record<OpenModel, Record<string, string>> = {
  spark: {
    overview: "/docs/muse-spark-open",
    get: "/docs/muse-spark-open/get-the-model",
    prompting: "/docs/muse-spark-open/prompting",
    settings: "/docs/muse-spark-open/settings",
    deploy: "/docs/muse-spark-open/deploy",
    hardware: "/docs/muse-spark-open/hardware-platforms",
    training: "/docs/muse-spark-open/post-training",
  },
  glimmer: {
    overview: "/docs/muse-glimmer",
    get: "/docs/muse-glimmer/get-the-model",
    prompting: "/docs/muse-glimmer/prompting",
    quantization: "/docs/muse-glimmer/quantization",
    specDecode: "/docs/muse-glimmer/spec-decode",
    deploy: "/docs/muse-glimmer/deploy",
    hardware: "/docs/muse-glimmer/hardware-platforms",
    training: "/docs/muse-glimmer/post-training",
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Muse Spark Open (muse-spark-open, get-the-model, settings, hardware-platforms)

export const SPARK = {
  params: "816B total, 42B active",
  architecture: "Sparse mixture of experts with built-in perception encoders",
  inputs: "Text, image, audio and video in; text out",
  contextTokens: 1_048_576,
  languages: "Trained on data from more than 100 languages",
  license: "Muse Model License, plus the Acceptable Use Policy",
  licenseUrl: "https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B/blob/main/LICENSE.md",
  policyUrl: "https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B/blob/main/USE_POLICY.md",
  /** settings, "Context length". */
  layers: { total: 62, sliding: 46, full: 16, window: 2048 },
  /** hardware-platforms, NVIDIA: "the 256 routed experts sharded 4-way". */
  routedExperts: 256,
  /** muse-spark-open, "Checkpoints and hardware": "budget roughly 2 TB of VRAM for BF16". */
  bf16VramBudgetGb: 2000,
  knowledgeCutoff: "2026-01-04",
  /** get-the-model prerequisites and deploy, Transformers. */
  transformers: "5.19",
  /** cookbook/muse-spark-open-torchtitan-sft: "step-1 loss should be near ln(202,048) = 12.2". */
  vocabSize: 202_048,
} as const;

export type SparkCheckpoint = "bf16" | "nvfp4";

export interface SparkCheckpointFacts {
  id: SparkCheckpoint;
  label: string;
  repo: string;
  /** get-the-model, "Choose a checkpoint". */
  footprint: string;
  footprintGb: number;
  recipe: string;
  tp: number;
  ep: number;
  gpus: number;
  /** get-the-model, "Download every file": BF16 has 65 weight shards and NVFP4 has 127. */
  shards: number;
  localDir: string;
  what: string;
}

export const SPARK_CHECKPOINTS: Record<SparkCheckpoint, SparkCheckpointFacts> = {
  bf16: {
    id: "bf16",
    label: "BF16",
    repo: "meta-models/Muse-Spark-Open-816B-A42B",
    footprint: "About 1.65 TB",
    footprintGb: 1650,
    recipe: "TP8/EP8 on 8 × B300",
    tp: 8,
    ep: 8,
    gpus: 8,
    shards: 65,
    localDir: "./muse-spark-open",
    what: "The full-precision reference.",
  },
  nvfp4: {
    id: "nvfp4",
    label: "NVFP4",
    repo: "meta-models/Muse-Spark-Open-816B-A42B-NVFP4",
    footprint: "About 537 GB",
    footprintGb: 537,
    recipe: "TP4/EP4 on 4 × B300",
    tp: 4,
    ep: 4,
    gpus: 4,
    shards: 127,
    localDir: "./muse-spark-open-nvfp4",
    what: "Most weights in 4-bit, some layers kept in BF16: about a third of the BF16 footprint. Serves on a single 4-GPU NVIDIA Blackwell node.",
  },
};

/** settings, "Reasoning strength": the level a request names and the number the template writes. */
export const SPARK_REASONING = [
  { effort: "low", strength: 8, use: "Classification, extraction, straightforward questions, and short tool loops" },
  { effort: "medium", strength: 32, use: "General agentic work" },
  { effort: "high", strength: 256, use: "Multi-step reasoning, hard debugging, and long tool loops" },
  { effort: "xhigh", strength: 512, use: "Problems where depth matters more than latency (the default)" },
] as const;

export type OpenEffort = "low" | "medium" | "high" | "xhigh";
export const OPEN_EFFORTS: readonly OpenEffort[] = ["low", "medium", "high", "xhigh"];

export function sparkStrength(effort: OpenEffort): number {
  return SPARK_REASONING.find((r) => r.effort === effort)?.strength ?? 512;
}

/** settings, "Stop tokens", and muse-glimmer/deploy, "Stop tokens" (the same ids). */
export const STOP_TOKENS = [
  { token: "<|begin_of_text|>", id: 200000, role: "bos_token_id", stop: false },
  { token: "<|end_of_text|>", id: 200001, role: "End of text, in eos_token_id", stop: true },
  { token: "<|eom|>", id: 200007, role: "Ends a message while the turn continues. Not in eos_token_id", stop: false },
  { token: "<|eot|>", id: 200008, role: "Ends the turn, in eos_token_id", stop: true },
  { token: "<|finetune_right_pad|>", id: 200018, role: "pad_token_id", stop: false },
] as const;

export const EOS_TOKEN_IDS = [200001, 200008] as const;
export const EOM_ID = 200007;

/** settings, "Parallelism": parser flags per runtime. */
export const SPARK_PARSER_FLAGS = {
  sglang: "--reasoning-parser muse --tool-call-parser muse",
  vllm: "--reasoning-parser muse --tool-call-parser muse --enable-auto-tool-choice",
  trtllm: "--reasoning_parser musespark --tool_parser musespark",
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Muse Glimmer (muse-glimmer, get-the-model, quantization, spec-decode, deploy, hardware-platforms)

export const GLIMMER = {
  params: "30B, dense",
  architecture: "Dense decoder-only multimodal transformer with a built-in vision encoder, distilled from Muse Spark",
  inputs: "Text and image in; text out",
  contextTokens: 131_072,
  contextNote: "128K tokens by default; longer contexts supported",
  languages: "Trained on data from more than 100 languages",
  license: "Apache License 2.0",
  licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
  /** deploy: "The bf16 weights are around 60 GB and need about 72 GB of VRAM to serve". */
  bf16WeightsGb: 60,
  bf16ServeGb: 72,
  transformers: "5.15",
  llamaCpp: "b10353",
  ollama: "0.32.7",
  /** prompting, "Temperature and sampling". */
  sampling: { temperature: 1.0, top_p: 0.95, top_k: 64 },
  /** quantization, "Budget your GPU memory": GQA with 2 KV heads, sliding windows on three of every four layers. */
  kvHeads: 2,
} as const;

export const GLIMMER_REPOS = {
  bf16: "meta-models/Muse-Glimmer-30B",
  gguf: "meta-models/Muse-Glimmer-30B-GGUF",
  assistant: "meta-models/Muse-Glimmer-30B-assistant",
  pte: "meta-models/Muse-Glimmer-30B-ExecuTorch-PTE",
} as const;

export type GgufFileId = "kquant17" | "dynamic" | "mmproj" | "dflash";

export interface GgufFile {
  id: GgufFileId;
  file: string;
  what: string;
  /** quantization, "Choose a checkpoint" (download size). */
  downloadGb: number;
  /** quantization, "Budget your GPU memory", where the page measured it. */
  vramGib: number | null;
}

export const GGUF_FILES: Record<GgufFileId, GgufFile> = {
  kquant17: {
    id: "kquant17",
    file: "Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf",
    what: "Text model, fixed K-quant. Start here: fits under 24 GB of VRAM.",
    downloadGb: 16.8,
    vramGib: 15.6,
  },
  dynamic: {
    id: "dynamic",
    file: "Muse-Glimmer-30B-KQuant-Dynamic-Q4_K_XL.gguf",
    what: "Text model, dynamic K-quant. Higher quality, more memory: for 32 GB of VRAM.",
    downloadGb: 19.7,
    vramGib: null,
  },
  mmproj: {
    id: "mmproj",
    file: "mmproj-Muse-Glimmer-30B-Q4_K_M.gguf",
    what: "Vision projector, required for image input.",
    downloadGb: 1.4,
    vramGib: 1.3,
  },
  dflash: {
    id: "dflash",
    file: "dflash-Muse-Glimmer-30B-Q4_K_M.gguf",
    what: "DFlash speculative-decoding draft model, optional.",
    downloadGb: 1.6,
    vramGib: 1.5,
  },
};

/** quantization, "Budget your GPU memory": K-Quant-17GB with the projector at 131,072 tokens measures 19.0 GiB. */
export const GLIMMER_MEASURED = { textGib: 15.6, mmprojGib: 1.3, kvAndBuffersGib: 2.1, contextTokens: 131_072, totalGib: 19.0, dflashGib: 1.5 } as const;

export const GLIMMER_REASONING = ["low", "medium", "high", "xhigh"] as const;
/** prompting, "Reasoning and chain-of-thought": reasoning_strength defaults to high. */
export const GLIMMER_DEFAULT_STRENGTH: OpenEffort = "high";

/** deploy, ExecuTorch "Download a prebuilt export": sizes in GB by directory. */
export type PteQuant = "k-quant-17G" | "k-quant-dynamic";
export type PteModality = "text" | "text-image";
export type PteDecoding = "solo" | "dflash";
export type PteBackend = "metal" | "sm80+ptx";

const PTE_SIZES: Record<PteQuant, Record<PteModality, Record<PteDecoding, Record<PteBackend, number>>>> = {
  "k-quant-17G": {
    text: { solo: { metal: 17.9, "sm80+ptx": 19.8 }, dflash: { metal: 19.6, "sm80+ptx": 27.2 } },
    "text-image": { solo: { metal: 19.4, "sm80+ptx": 21.2 }, dflash: { metal: 21.1, "sm80+ptx": 28.6 } },
  },
  "k-quant-dynamic": {
    text: { solo: { metal: 20.7, "sm80+ptx": 22.6 }, dflash: { metal: 22.4, "sm80+ptx": 30.0 } },
    "text-image": { solo: { metal: 22.2, "sm80+ptx": 24.0 }, dflash: { metal: 23.8, "sm80+ptx": 31.5 } },
  },
};

/** `muse-glimmer-<quantization>-128K-<modality>-<decoding>-<backend>`, and its size. */
export function pteExport(q: PteQuant, m: PteModality, d: PteDecoding, b: PteBackend): { dir: string; sizeGb: number } {
  return { dir: `muse-glimmer-${q}-128K-${m}-${d}-${b}`, sizeGb: PTE_SIZES[q][m][d][b] };
}

export const PTE_REPO_GB = 372;

// ---------------------------------------------------------------------------------------------------------------
// Small formatting helpers shared by the builders

/** "1,048,576". */
export function n(value: number): string {
  return value.toLocaleString("en-US");
}

/** "131K" style for context sizes that are powers of two, else the full number. */
export function tokensLabel(value: number): string {
  if (value >= 1024 && value % 1024 === 0) {
    const k = value / 1024;
    return k >= 1024 && k % 1024 === 0 ? `${k / 1024}M` : `${k}K`;
  }
  return n(value);
}

/** One decimal place, dropping a trailing .0: 19.0 becomes "19", 15.62 becomes "15.6". */
/** A phrase set inside a sentence: "About 537 GB" as "about 537 GB", the unit keeping its capitals. */
export function inSentence(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function gb(value: number, digits = 1): string {
  const fixed = value.toFixed(digits);
  return fixed.replace(/\.0+$/, "");
}
