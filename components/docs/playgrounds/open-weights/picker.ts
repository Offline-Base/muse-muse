import { GGUF_FILES, GLIMMER, GLIMMER_REPOS, PAGE, SPARK_CHECKPOINTS } from "@/components/docs/playgrounds/open-weights/facts";
import { amdCommand } from "@/components/docs/playgrounds/open-weights/hardware";

/**
 * Which open-weight model fits a reader's hardware and needs (open-weight-models), from the two models' own pages:
 * Muse Spark Open's checkpoints and platforms (816B, NVFP4 on a 4-GPU Blackwell node, BF16 on 8 × B300, AMD, Intel
 * Xeon, two or four Mac Studios) and Muse Glimmer's (30B: 17 to 20 GB GGUFs, 72 GB to serve bf16, MLX, DGX Spark,
 * CPU). Each verdict says which page fact decided it and hands over the first command from that page.
 */

export type HardwareId =
  | "gpu24"
  | "gpu32"
  | "mac64"
  | "gpu96"
  | "dgx"
  | "b300x1"
  | "blackwell4"
  | "b300x8"
  | "amd8"
  | "xeon"
  | "macs"
  | "none";

export interface Hardware {
  id: HardwareId;
  label: string;
  detail: string;
}

export const HARDWARE: Hardware[] = [
  { id: "gpu24", label: "A 24 GB GPU", detail: "A desktop or workstation card" },
  { id: "gpu32", label: "A 32 GB GPU", detail: "Such as an RTX 5090" },
  { id: "mac64", label: "A Mac with 48 to 128 GB", detail: "Apple silicon, unified memory" },
  { id: "gpu96", label: "One 80 to 96 GB GPU", detail: "Such as an H100 or RTX PRO 6000" },
  { id: "dgx", label: "DGX Spark", detail: "128 GB of unified memory" },
  { id: "b300x1", label: "One B300", detail: "288 GB of HBM3e" },
  { id: "blackwell4", label: "A 4-GPU Blackwell node", detail: "4 × B300 or GB300" },
  { id: "b300x8", label: "8 × B300", detail: "About 2.3 TB of HBM3e" },
  { id: "amd8", label: "8 × AMD Instinct", detail: "MI355X or MI350X" },
  { id: "xeon", label: "An Intel Xeon 6 server", detail: "CPU only, such as the 6980P" },
  { id: "macs", label: "Two or four Mac Studios", detail: "M5 Ultra, 512 GB or 256 GB each" },
  { id: "none", label: "No GPUs to run it on", detail: "Use a hosted provider" },
];

export interface Needs {
  /** Audio or video input: only Muse Spark Open takes them. */
  audioVideo: boolean;
  /** Images in: both models. */
  images: boolean;
  /** Contexts past 128K tokens, up to 1,048,576. */
  longContext: boolean;
  /** An Apache 2.0 license (Muse Glimmer); Muse Spark Open is under the Muse Model License. */
  apache: boolean;
}

export type FitLevel = "fits" | "limited" | "no";

export interface Verdict {
  model: "spark" | "glimmer";
  level: FitLevel;
  headline: string;
  why: string[];
  checkpoint?: string;
  runtime?: string;
  command?: string;
  link: { href: string; label: string };
}

const GLIMMER_LLAMA = `llama serve -hf ${GLIMMER_REPOS.gguf} \\\n  --hf-file ${GGUF_FILES.kquant17.file} \\\n  --port 8080`;
const GLIMMER_VLLM = [
  "docker run --rm --gpus all --ipc=host \\",
  "  -p 8000:8000 \\",
  "  -v ~/.cache/huggingface:/root/.cache/huggingface \\",
  "  vllm/vllm-openai:muse-glimmer \\",
  "  meta-models/Muse-Glimmer-30B \\",
  "  --served-model-name muse-glimmer \\",
  "  --tensor-parallel-size 1 \\",
  "  --enable-auto-tool-choice \\",
  "  --tool-call-parser muse_glimmer \\",
  "  --reasoning-parser muse_glimmer \\",
  "  --generation-config auto",
].join("\n");

function glimmerVerdict(hw: HardwareId, needs: Needs): Verdict {
  const link = { href: PAGE.glimmer.get, label: "Get Muse Glimmer" };
  const base: Pick<Verdict, "model" | "link"> = { model: "glimmer", link };
  const blockers: string[] = [];
  if (needs.audioVideo) blockers.push("Muse Glimmer reads text and images only: no audio or video input.");
  const ctxNote = needs.longContext ? ["Its default context is 128K tokens; longer contexts are supported but not the 1M window Muse Spark Open has."] : [];
  const visionNote = (fmt: string) => (needs.images && fmt !== "bf16" && fmt !== "gguf" ? [`Images need the bf16 checkpoint or the GGUF vision projector; the ${fmt} path is text only.`] : []);
  if (blockers.length) return { ...base, level: "no", headline: "Doesn't cover what you need", why: blockers };

  switch (hw) {
    case "gpu24":
      return {
        ...base,
        level: "fits",
        headline: "Fits: the 17 GB GGUF with the vision projector",
        why: ["K-Quant-17GB with the projector and the full 131,072-token context measures 19.0 GiB, which fits a 24 GiB card with headroom.", ...ctxNote],
        checkpoint: GGUF_FILES.kquant17.file,
        runtime: "llama.cpp (b10353 or newer)",
        command: GLIMMER_LLAMA,
      };
    case "gpu32":
      return {
        ...base,
        level: "fits",
        headline: "Fits: the dynamic K-quant, or NVFP4 on SGLang",
        why: ["The dynamic K-quant (19.7 GB download) is the higher-quality build for 32 GB of VRAM. SGLang verified Q4_K_M and NVFP4 on an RTX 5090.", ...visionNote("NVFP4"), ...ctxNote],
        checkpoint: GGUF_FILES.dynamic.file,
        runtime: "llama.cpp or SGLang",
        command: GLIMMER_LLAMA.replace(GGUF_FILES.kquant17.file, GGUF_FILES.dynamic.file),
      };
    case "mac64":
      return {
        ...base,
        level: "fits",
        headline: "Fits: Ollama's MLX engine, or SGLang's MLX repacks",
        why: ["SGLang lists its MLX Q4 builds for Apple silicon with 48 GB or more of unified memory (verified on an M5 Pro with 64 GB); llama.cpp runs the GGUFs with Metal.", ...visionNote("MLX"), ...ctxNote],
        checkpoint: "muse-glimmer:30b-mlx (Ollama)",
        runtime: "Ollama 0.32.7 or later",
        command: "ollama run muse-glimmer:30b-mlx",
      };
    case "gpu96":
      return {
        ...base,
        level: "fits",
        headline: "Fits: the full bf16 checkpoint on vLLM",
        why: [`The bf16 weights are about ${GLIMMER.bf16WeightsGb} GB and the vLLM recipe asks for ${GLIMMER.bf16ServeGb} GB of VRAM to serve, on one card or several.`, ...ctxNote],
        checkpoint: GLIMMER_REPOS.bf16,
        runtime: "vLLM (Docker)",
        command: GLIMMER_VLLM,
      };
    case "dgx":
      return {
        ...base,
        level: "fits",
        headline: "Fits: bf16 or NVFP4 on SGLang, with DGX Spark's memory fractions",
        why: ["SGLang verified bf16 and NVFP4 on DGX Spark. Its 128 GB is shared with the OS, so use --mem-fraction-static 0.75 for bf16 (0.40 for NVFP4), not 0.85.", ...ctxNote],
        checkpoint: GLIMMER_REPOS.bf16,
        runtime: "SGLang",
        command: "sglang serve \\\n  --model-path meta-models/Muse-Glimmer-30B \\\n  --served-model-name muse-glimmer \\\n  --reasoning-parser muse \\\n  --tool-call-parser muse \\\n  --mem-fraction-static 0.75 \\\n  --host 0.0.0.0 --port 30000",
      };
    case "b300x1":
    case "blackwell4":
    case "b300x8":
      return {
        ...base,
        level: "fits",
        headline: "Fits on a single GPU: bf16 on vLLM",
        why: ["The bf16 weights fit on a single B300, so --tensor-parallel-size 1 is right on a multi-GPU node too (NVIDIA verified this on B300).", ...ctxNote],
        checkpoint: GLIMMER_REPOS.bf16,
        runtime: "vLLM",
        command: GLIMMER_VLLM,
      };
    case "amd8":
      return {
        ...base,
        level: "limited",
        headline: "Not covered for AMD",
        why: ["The Muse Glimmer pages publish no ROCm image or AMD-verified path (vLLM's image is CUDA only). llama.cpp's GGUFs run on ROCm."],
        checkpoint: GGUF_FILES.kquant17.file,
        runtime: "llama.cpp",
        command: GLIMMER_LLAMA,
      };
    case "xeon":
      return {
        ...base,
        level: "fits",
        headline: "Fits: bf16 on vLLM's CPU build",
        why: ["Intel verified bf16 with vLLM on a Xeon 6 6980P, with more than 512 GB of DDR5 suggested."],
        checkpoint: GLIMMER_REPOS.bf16,
        runtime: "vLLM (CPU container)",
        command: 'vllm serve ./muse-glimmer-bf16 \\\n    --served-model-name muse-glimmer \\\n    -tp "<TP_SIZE>" \\\n    --dtype=bfloat16 \\\n    --trust-remote-code --enable-auto-tool-choice \\\n    --tool-call-parser muse_glimmer \\\n    --reasoning-parser muse_glimmer \\\n    --generation-config auto',
      };
    case "macs":
      return {
        ...base,
        level: "fits",
        headline: "Fits on one of them",
        why: ["One Mac Studio is far more than Muse Glimmer needs: run it with Ollama's MLX engine on any one Mac."],
        checkpoint: "muse-glimmer:30b-mlx (Ollama)",
        runtime: "Ollama",
        command: "ollama run muse-glimmer:30b-mlx",
      };
    case "none":
      return {
        ...base,
        level: "limited",
        headline: "Call it hosted: Together AI",
        why: ["Together AI serves the open weights as meta-models/Muse-Glimmer-30B, at $0.35 per 1M input tokens and $1.50 per 1M output."],
        runtime: "Together AI",
        command: 'curl -X POST "https://api.together.xyz/v1/chat/completions" \\\n  -H "Authorization: Bearer $TOGETHER_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model": "meta-models/Muse-Glimmer-30B", "messages": [{"role": "user", "content": "Hello"}]}\'',
        link: { href: `${PAGE.glimmer.deploy}#hosted-providers`, label: "Hosted providers" },
      };
  }
}

function sparkVerdict(hw: HardwareId, needs: Needs): Verdict {
  const link = { href: PAGE.spark.get, label: "Get Muse Spark Open" };
  const base: Pick<Verdict, "model" | "link"> = { model: "spark", link };
  if (needs.apache) {
    return { ...base, level: "no", headline: "Different license", why: ["Muse Spark Open is released under the Muse Model License and its Acceptable Use Policy, not Apache 2.0."] };
  }
  const tooSmall = (what: string): Verdict => ({
    ...base,
    level: "no",
    headline: "Too big for this hardware",
    why: [
      `${what} Serving loads all 816B weights: about 537 GB in NVFP4 (a 4-GPU Blackwell node) and about 1.65 TB in BF16 (8 × B300, roughly 2 TB of VRAM all told).`,
    ],
  });
  switch (hw) {
    case "gpu24":
    case "gpu32":
    case "gpu96":
    case "mac64":
      return tooSmall("One card or one Mac can't hold it.");
    case "dgx":
      return tooSmall("128 GB is a quarter of the NVFP4 weights alone.");
    case "b300x1":
      return tooSmall("One B300's 288 GB is about half the NVFP4 weights.");
    case "blackwell4":
      return {
        ...base,
        level: "fits",
        headline: "Fits: NVFP4 on one 4-GPU node",
        why: ["The NVFP4 checkpoint (about 537 GB) serves at TP4/EP4 on 4 × B300, about 134 GB of weights per GPU. On GB300 (SM103), TensorRT-LLM needs an FP8 KV cache with chunked prefill or block reuse."],
        checkpoint: SPARK_CHECKPOINTS.nvfp4.repo,
        runtime: "SGLang, vLLM, TensorRT-LLM or Dynamo",
        command: "sglang serve \\\n  --model-path meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \\\n  --tp-size 4 \\\n  --ep-size 4 \\\n  --quantization modelopt_fp4 \\\n  --moe-runner-backend flashinfer_trtllm \\\n  --mem-fraction-static 0.8 \\\n  --host 0.0.0.0 \\\n  --port 30000 \\\n  --reasoning-parser muse \\\n  --tool-call-parser muse",
      };
    case "b300x8":
      return {
        ...base,
        level: "fits",
        headline: "Fits: BF16 at TP8/EP8",
        why: ["The full-precision BF16 checkpoint (about 1.65 TB) serves on 8 × B300; budget roughly 2 TB of VRAM with the KV cache and activations. NVFP4 also fits, on half the GPUs."],
        checkpoint: SPARK_CHECKPOINTS.bf16.repo,
        runtime: "SGLang or vLLM",
        command: "vllm serve meta-models/Muse-Spark-Open-816B-A42B \\\n    --tensor-parallel-size 8 \\\n    --enable-expert-parallel \\\n    --reasoning-parser muse \\\n    --tool-call-parser muse \\\n    --enable-auto-tool-choice",
      };
    case "amd8":
      return {
        ...base,
        level: "fits",
        headline: "Fits: BF16, MXFP4 or FP8 on vLLM",
        why: ["AMD's MI355X and MI350X serve the BF16 checkpoint at TP8, and AMD's Quark MXFP4 and PTPC-FP8 checkpoints at TP8+EP8, all with vLLM."],
        checkpoint: "amd/Muse-Spark-Open-816B-A42B-Quark-MXFP4",
        runtime: "vLLM (ROCm)",
        // The whole block from the hardware page: the AITER exports, then COMMON_ARGS and CG, which the serve line expands.
        command: amdCommand("mxfp4"),
        link: { href: `${PAGE.spark.hardware}#amd`, label: "AMD commands" },
      };
    case "xeon":
      return {
        ...base,
        level: "fits",
        headline: "Runs: the INT4 checkpoint on SGLang",
        why: ["Intel publishes an INT4 checkpoint for Xeon 6 with P-cores, served by SGLang with --quantization gptq."],
        checkpoint: "intel-ai/Muse-Spark-Open-816B-A42B-INT4",
        runtime: "SGLang",
        command: "python -m sglang.launch_server \\\n  --model-path intel-ai/Muse-Spark-Open-816B-A42B-INT4 \\\n  --quantization gptq \\\n  --tp-size 2 \\\n  --reasoning-parser muse --tool-call-parser muse",
        link: { href: `${PAGE.spark.hardware}#intel`, label: "Intel setup" },
      };
    case "macs":
      return {
        ...base,
        level: "fits",
        headline: "Fits: NVFP4 split across the Macs with MLX",
        why: ["MLX splits the NVFP4 checkpoint over RDMA on Thunderbolt 5: two Mac Studios with 512 GB each, or four with 256 GB (four serve fastest). Every Mac needs macOS 26.2 or later and a direct link to every other."],
        checkpoint: SPARK_CHECKPOINTS.nvfp4.repo,
        runtime: "mlx-lm (MLX 0.30.1 or later)",
        command: "mlx.launch --hostfile hostfile.json --backend jaccl --env MLX_METAL_FAST_SYNCH=1 -- \\\n  mlx_lm.server --model meta-models/Muse-Spark-Open-816B-A42B-NVFP4 --port 8080",
        link: { href: "/docs/cookbook/muse-spark-open-mac", label: "Mac Studio recipe" },
      };
    case "none":
      return {
        ...base,
        level: "limited",
        headline: "Call it hosted: Together, Fireworks, Baseten, Groq or Nebius",
        why: ["Each serves the open weights over an OpenAI-compatible API (model string meta-models/muse-spark-open on most). Or call Meta Model API's hosted Muse Spark, which isn't the open-weight release."],
        runtime: "A hosted provider",
        command: 'curl https://api.together.xyz/v1/chat/completions \\\n  -H "Authorization: Bearer $TOGETHER_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model": "meta-models/muse-spark-open", "messages": [{"role": "user", "content": "Explain mixture-of-experts models in two sentences."}]}\'',
        link: { href: `${PAGE.spark.deploy}#hosted-providers`, label: "Hosted providers" },
      };
  }
}

export interface Recommendation {
  spark: Verdict;
  glimmer: Verdict;
  /** The one to start with. */
  pick: "spark" | "glimmer" | "neither";
  reason: string;
}

/** Both verdicts and the one to start with: the bigger model when it fits and nothing rules it out, else Glimmer. */
export function recommend(hw: HardwareId, needs: Needs): Recommendation {
  const spark = sparkVerdict(hw, needs);
  const glimmer = glimmerVerdict(hw, needs);
  if (spark.level === "fits" && glimmer.level !== "fits") return { spark, glimmer, pick: "spark", reason: "Only Muse Spark Open covers this." };
  if (glimmer.level === "fits" && spark.level !== "fits") return { spark, glimmer, pick: "glimmer", reason: "Muse Glimmer fits this hardware; Muse Spark Open doesn't." };
  if (spark.level === "fits" && glimmer.level === "fits") {
    return {
      spark,
      glimmer,
      pick: "spark",
      reason: "Both fit. Muse Spark Open (816B, 42B active) is the stronger agentic and coding model; Muse Glimmer (30B) is lighter, faster per request and Apache 2.0.",
    };
  }
  if (hw === "none") {
    // Hosted for both, so a need decides: never pick a model whose own verdict rules it out (a license, a modality).
    const sparkOk = spark.level !== "no";
    const glimmerOk = glimmer.level !== "no";
    const pick = sparkOk && glimmerOk ? (needs.audioVideo ? "spark" : "glimmer") : sparkOk ? "spark" : glimmerOk ? "glimmer" : "neither";
    if (pick === "neither") return { spark, glimmer, pick, reason: "Neither model covers this combination, hosted or not. Drop a need." };
    return { spark, glimmer, pick, reason: "Without GPUs, a hosted provider serves the same open weights." };
  }
  return { spark, glimmer, pick: "neither", reason: "Neither model covers this combination. Drop a need, or call a hosted provider." };
}
