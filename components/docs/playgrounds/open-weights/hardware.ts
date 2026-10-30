import { GLIMMER, GLIMMER_MEASURED, GGUF_FILES, SPARK, SPARK_CHECKPOINTS, gb, n, type SparkCheckpoint } from "@/components/docs/playgrounds/open-weights/facts";
import { command } from "@/components/docs/playgrounds/open-weights/shell";

/**
 * The hardware pages' tables as calculators (muse-spark-open/hardware-platforms, muse-glimmer/hardware-platforms):
 * what each platform runs, the sample commands the pages print, and what fits. Weight shares are the checkpoint's
 * footprint split evenly over the GPUs, which is how expert and tensor parallelism spread an MoE model's weights;
 * the pages give the footprints and the GPU counts, and the split is ours, labeled as an estimate where it's shown.
 */

// ---------------------------------------------------------------------------------------------------------------
// Muse Spark Open

/** B300's 288 GB of HBM3e per GPU (muse-glimmer/hardware-platforms, B300). GB300's Blackwell Ultra GPUs carry the same. */
export const B300_GB = 288;

export interface SparkFit {
  perGpuGb: number;
  freeGb: number;
  fits: boolean;
  expertsPerGpu: number;
  /** The page's own recipe for this checkpoint, or null when this GPU count isn't one. */
  recipe: string | null;
  summary: string;
}

/** Weights per GPU for a checkpoint spread over `gpus` GPUs of `memGb` each, and what's left for KV cache. */
export function sparkFit(checkpoint: SparkCheckpoint, gpus: number, memGb = B300_GB): SparkFit {
  const c = SPARK_CHECKPOINTS[checkpoint];
  const perGpuGb = c.footprintGb / gpus;
  const freeGb = memGb - perGpuGb;
  const fits = freeGb > memGb * 0.1;
  const recipe = gpus === c.gpus ? `TP${c.tp}/EP${c.ep}, the page's recipe` : null;
  const summary = fits
    ? `${c.label} on ${gpus} GPUs: about ${gb(perGpuGb, 0)} GB of weights per GPU, leaving about ${gb(freeGb, 0)} GB each for the KV cache, activations and runtime.`
    : `${c.label} on ${gpus} GPUs: about ${gb(perGpuGb, 0)} GB of weights per GPU, more than a ${memGb} GB GPU can hold with room to serve.`;
  return { perGpuGb, freeGb, fits, expertsPerGpu: SPARK.routedExperts / gpus, recipe, summary };
}

export type AmdVariant = "bf16" | "bf16-online-mxfp4" | "mxfp4" | "mxfp4-throughput" | "mxfp4-latency" | "fp8";

export const AMD_VARIANTS: { id: AmdVariant; label: string; checkpoint: string; parallelism: string }[] = [
  { id: "bf16", label: "BF16", checkpoint: "meta-models/Muse-Spark-Open-816B-A42B", parallelism: "TP8" },
  { id: "bf16-online-mxfp4", label: "BF16 with online MXFP4 experts", checkpoint: "meta-models/Muse-Spark-Open-816B-A42B", parallelism: "TP8" },
  { id: "mxfp4", label: "MXFP4", checkpoint: "amd/Muse-Spark-Open-816B-A42B-Quark-MXFP4", parallelism: "TP8+EP8" },
  { id: "mxfp4-throughput", label: "MXFP4, throughput mode", checkpoint: "amd/Muse-Spark-Open-816B-A42B-Quark-MXFP4", parallelism: "TP8+EP8" },
  { id: "mxfp4-latency", label: "MXFP4, lowest latency (DSpark)", checkpoint: "amd/Muse-Spark-Open-816B-A42B-Quark-MXFP4", parallelism: "TP8+EP8" },
  { id: "fp8", label: "FP8 (PTPC)", checkpoint: "amd/Muse-Spark-Open-816B-A42B-Quark-PTPC-FP8", parallelism: "TP8+EP8" },
];

function amdCommon(batched: number, mem: string): string {
  return [
    'COMMON_ARGS="--host 127.0.0.1 --port 8006 --served-model-name musespark \\',
    "  --tokenizer-mode hf --config-format auto --load-format safetensors --generation-config vllm \\",
    "  --language-model-only --dtype bfloat16 \\",
    "  --tensor-parallel-size 8 --distributed-executor-backend mp --attention-backend ROCM_AITER_FA \\",
    `  --max-model-len 32768 --max-num-batched-tokens ${batched} --gpu-memory-utilization ${mem} \\`,
    "  --enable-chunked-prefill \\",
    '  --reasoning-parser muse --tool-call-parser muse --enable-auto-tool-choice"',
    "",
    "CG='--compilation-config {\"cudagraph_mode\":\"FULL_AND_PIECEWISE\"}'",
  ].join("\n");
}

/** The AMD sample commands from muse-spark-open/hardware-platforms, verbatim. */
export function amdCommand(variant: AmdVariant): string {
  const envBf16 = "export VLLM_ROCM_USE_AITER=1\nexport VLLM_ROCM_MUSE_MOE_REDUCE_DTYPE=bf16";
  switch (variant) {
    case "bf16":
      return `${envBf16}\n\n${amdCommon(4096, "0.95")}\n\nvllm serve meta-models/Muse-Spark-Open-816B-A42B \\\n  $COMMON_ARGS $CG --moe-backend triton --max-num-seqs 32`;
    case "bf16-online-mxfp4":
      return `${envBf16}\n\n${amdCommon(8192, "0.90")}\n\nVLLM_ROCM_MUSE_MOE_ONLINE_QUANT=mxfp4 vllm serve meta-models/Muse-Spark-Open-816B-A42B \\\n  $COMMON_ARGS $CG --max-num-seqs 128`;
    case "mxfp4":
      return `${envBf16}\n\n${amdCommon(8192, "0.90")}\n\nvllm serve amd/Muse-Spark-Open-816B-A42B-Quark-MXFP4 \\\n  $COMMON_ARGS $CG --max-num-seqs 128`;
    case "mxfp4-throughput":
      return `${envBf16}\n\n${amdCommon(8192, "0.90")}\n\nvllm serve amd/Muse-Spark-Open-816B-A42B-Quark-MXFP4 \\\n  $COMMON_ARGS $CG --max-num-seqs 128 --enable-expert-parallel`;
    case "mxfp4-latency":
      return `${envBf16}\n\n${amdCommon(8192, "0.90")}\n\nVLLM_KV_CACHE_LAYOUT=LBHNC vllm serve amd/Muse-Spark-Open-816B-A42B-Quark-MXFP4 \\\n  $COMMON_ARGS $CG --max-num-seqs 32 \\\n  --speculative-config '{"method":"dspark","model":"Inferact/Muse-Spark-Open-DSpark","num_speculative_tokens":7}'`;
    case "fp8":
      return `export VLLM_ROCM_USE_AITER=1\nexport SAFETENSORS_FAST_GPU=1\n\n${amdCommon(8192, "0.90")}\n\nvllm serve amd/Muse-Spark-Open-816B-A42B-Quark-PTPC-FP8 \\\n  $COMMON_ARGS $CG \\\n  --max-num-seqs 128 \\\n  --enable-expert-parallel \\\n  --moe-backend triton`;
  }
}

export const INTEL_COMMAND = command("python -m sglang.launch_server", [
  "--model-path intel-ai/Muse-Spark-Open-816B-A42B-INT4",
  "--quantization gptq",
  "--tp-size 2",
  "--reasoning-parser muse --tool-call-parser muse",
]);

export const MLX_COMMAND =
  "mlx.launch --hostfile hostfile.json --backend jaccl --env MLX_METAL_FAST_SYNCH=1 -- \\\n  mlx_lm.server --model meta-models/Muse-Spark-Open-816B-A42B-NVFP4 --port 8080";

/** Each Mac's share of the NVFP4 weights (two with 512 GB, or four with 256 GB). */
export function macShare(macs: 2 | 4): { perMacGb: number; memGb: number; percent: number } {
  const memGb = macs === 2 ? 512 : 256;
  const perMacGb = SPARK_CHECKPOINTS.nvfp4.footprintGb / macs;
  return { perMacGb, memGb, percent: Math.round((perMacGb / memGb) * 100) };
}

// ---------------------------------------------------------------------------------------------------------------
// Muse Glimmer

export type GlimmerPlatformId = "arc" | "xeon" | "b300" | "b200" | "h200" | "rtxpro" | "dgx" | "rtx5090" | "apple";

export interface GlimmerPlatform {
  id: GlimmerPlatformId;
  label: string;
  vendor: "Intel" | "NVIDIA" | "Apple";
  memory: string;
  memoryGb: number;
  /** Who verified it: the partner (this page's table) or SGLang's team (deploy, "Choose a checkpoint"). */
  verifiedBy: string;
  precisions: string;
  runtime: string;
  anchor: string;
}

export const GLIMMER_PLATFORMS: GlimmerPlatform[] = [
  { id: "arc", label: "Intel Arc Pro B70 × 2 (server)", vendor: "Intel", memory: "32 GB GDDR6 per card", memoryGb: 64, verifiedBy: "Intel, 2026-08-09", precisions: "bf16", runtime: "vLLM main, XPU container", anchor: "#intel-arc-pro-server" },
  { id: "xeon", label: "Intel Xeon 6 6980P (CPU only)", vendor: "Intel", memory: "More than 512 GB DDR5 suggested", memoryGb: 512, verifiedBy: "Intel, 2026-08-09", precisions: "bf16", runtime: "vLLM main, CPU container", anchor: "#intel-xeon-6" },
  { id: "b300", label: "NVIDIA B300", vendor: "NVIDIA", memory: "288 GB HBM3e per GPU", memoryGb: 288, verifiedBy: "NVIDIA for bf16 on vLLM; SGLang for bf16, nvfp4 and q4_k_m; both 2026-08-10", precisions: "bf16, nvfp4, q4_k_m", runtime: "vLLM (NVIDIA), SGLang", anchor: "#nvidia-b300" },
  { id: "b200", label: "NVIDIA B200", vendor: "NVIDIA", memory: "192 GB HBM3e", memoryGb: 192, verifiedBy: "SGLang, 2026-08-09", precisions: "bf16, nvfp4", runtime: "SGLang", anchor: "" },
  { id: "h200", label: "NVIDIA H200", vendor: "NVIDIA", memory: "141 GB HBM3e", memoryGb: 141, verifiedBy: "SGLang, 2026-08-09", precisions: "bf16", runtime: "SGLang", anchor: "" },
  { id: "rtxpro", label: "NVIDIA RTX PRO 6000", vendor: "NVIDIA", memory: "96 GB GDDR7", memoryGb: 96, verifiedBy: "SGLang, 2026-08-09", precisions: "bf16, nvfp4", runtime: "SGLang", anchor: "" },
  { id: "dgx", label: "NVIDIA DGX Spark (GB10)", vendor: "NVIDIA", memory: "128 GB unified", memoryGb: 128, verifiedBy: "SGLang, 2026-08-09", precisions: "bf16, nvfp4", runtime: "SGLang", anchor: "" },
  { id: "rtx5090", label: "NVIDIA RTX 5090", vendor: "NVIDIA", memory: "32 GB GDDR7", memoryGb: 32, verifiedBy: "SGLang, 2026-08-09", precisions: "q4_k_m, nvfp4", runtime: "SGLang", anchor: "" },
  { id: "apple", label: "Mac with M5 Pro (48 GB minimum)", vendor: "Apple", memory: "64 GB unified", memoryGb: 64, verifiedBy: "SGLang, 2026-08-09", precisions: "q4_k_m, q4, q4k-dynamic", runtime: "SGLang (MLX)", anchor: "" },
];

/** The page's command for a platform, verbatim where it prints one. */
export function glimmerPlatformCommand(id: GlimmerPlatformId): string {
  switch (id) {
    case "arc":
      return [
        "git clone https://github.com/vllm-project/vllm.git",
        "cd vllm",
        "docker build -f docker/Dockerfile.xpu -t vllm-xpu-env --shm-size=4g .",
        "docker run -it --rm --network=host --ipc=host --privileged \\",
        "                 --device /dev/dri:/dev/dri \\",
        "                 -v /dev/dri/by-path:/dev/dri/by-path \\",
        "                 --entrypoint bash \\",
        "                 vllm-xpu-env",
        "",
        "# Inside the container:",
        "hf download meta-models/Muse-Glimmer-30B --local-dir ./muse-glimmer-bf16",
        "",
        "ZE_AFFINITY_MASK=0,1  \\",
        "python -m vllm.entrypoints.openai.api_server \\",
        "  --model ./muse-glimmer-bf16 \\",
        "  --served-model-name muse-glimmer \\",
        "  --reasoning-parser muse_glimmer \\",
        "  --enforce-eager \\",
        "  --tensor-parallel-size 2",
      ].join("\n");
    case "xeon":
      return [
        "git clone https://github.com/vllm-project/vllm.git",
        "cd vllm",
        "docker build -f docker/Dockerfile.cpu \\",
        "        --tag vllm-cpu-env \\",
        "        --target vllm-openai .",
        "docker run -it --rm \\",
        "            --privileged \\",
        "            --shm-size=4g \\",
        "            --entrypoint bash \\",
        "            --name vllm-cpu-env \\",
        "            vllm-cpu-env",
        "",
        "# Inside the container:",
        "hf download meta-models/Muse-Glimmer-30B --local-dir ./muse-glimmer-bf16",
        "",
        "vllm serve ./muse-glimmer-bf16 \\",
        "    --served-model-name muse-glimmer \\",
        '    -tp "<TP_SIZE>" \\',
        "    --dtype=bfloat16 \\",
        "    --trust-remote-code --enable-auto-tool-choice \\",
        "    --tool-call-parser muse_glimmer \\",
        "    --reasoning-parser muse_glimmer \\",
        "    --generation-config auto",
      ].join("\n");
    case "b300":
      return [
        "hf download meta-models/Muse-Glimmer-30B --local-dir ./muse-glimmer-bf16",
        "",
        "docker run --rm --gpus all --ipc=host \\",
        "  -p 8000:8000 \\",
        '  -v "$PWD/muse-glimmer-bf16:/model" \\',
        "  vllm/vllm-openai:muse-glimmer \\",
        "  /model \\",
        "  --served-model-name muse-glimmer \\",
        "  --tensor-parallel-size 1 \\",
        "  --enable-auto-tool-choice \\",
        "  --tool-call-parser muse_glimmer \\",
        "  --reasoning-parser muse_glimmer \\",
        "  --generation-config auto",
      ].join("\n");
    case "dgx":
      return command("sglang serve", ["--model-path meta-models/Muse-Glimmer-30B", "--served-model-name muse-glimmer", "--reasoning-parser muse", "--tool-call-parser muse", "--mem-fraction-static 0.75", "--host 0.0.0.0 --port 30000"]);
    case "rtx5090":
      return command("sglang serve", [
        "--model-path RadixArk/Muse-Glimmer-NVFP4",
        "--served-model-name muse-glimmer",
        "--reasoning-parser muse",
        "--tool-call-parser muse",
        "--language-model-only",
        "--kv-cache-dtype fp8_e4m3",
        "--mem-fraction-static 0.90",
        "--host 0.0.0.0 --port 30000",
      ]);
    case "apple":
      return [
        "SGLANG_USE_MLX=1 SGLANG_MLX_CACHE_LIMIT_GB=8 \\",
        "sglang serve \\",
        "  --model-path RadixArk/Muse-Glimmer-q4km-gs128-MLX \\",
        "  --served-model-name muse-glimmer \\",
        "  --trust-remote-code \\",
        "  --reasoning-parser muse \\",
        "  --tool-call-parser muse \\",
        "  --disable-radix-cache \\",
        "  --mem-fraction-static 0.85 \\",
        "  --host 0.0.0.0 --port 30000",
      ].join("\n");
    default:
      return command("sglang serve", ["--model-path meta-models/Muse-Glimmer-30B", "--served-model-name muse-glimmer", "--reasoning-parser muse", "--tool-call-parser muse", "--mem-fraction-static 0.85", "--host 0.0.0.0 --port 30000"]);
  }
}

export type GlimmerFormat = "bf16" | "kquant17" | "dynamic" | "nvfp4" | "mlx";

export interface FormatFit {
  format: GlimmerFormat;
  label: string;
  needGb: number | null;
  /** How the need was found: measured on the page, the page's stated requirement, or derived from a file size. */
  basis: string;
  fits: boolean | null;
  images: boolean;
}

/** GiB as the page measures VRAM, from GB as sizes are listed. */
export function gbToGib(gbValue: number): number {
  return (gbValue * 1e9) / 2 ** 30;
}

/** The precisions a platform's row lists, as the formats in the fit table. */
function verifiedFormats(p: GlimmerPlatform): Set<GlimmerFormat> {
  const out = new Set<GlimmerFormat>();
  for (const raw of p.precisions.split(",").map((x) => x.trim())) {
    if (raw === "bf16") out.add("bf16");
    else if (raw === "nvfp4") out.add("nvfp4");
    else if (raw === "q4_k_m") out.add(p.vendor === "Apple" ? "mlx" : "kquant17");
    else if (raw === "q4" || raw === "q4k-dynamic") out.add("mlx");
  }
  return out;
}

/**
 * What each format needs at the full 131,072-token context, against a platform's memory. A precision the platform's
 * own row lists as verified fits by definition (Intel serves bf16 on two 32 GB Arc cards, under vLLM's 72 GB budget,
 * with tensor parallelism and eager mode); formats tied to one vendor (NVFP4 to NVIDIA, MLX to Apple silicon) don't
 * apply elsewhere.
 */
export function glimmerFits(memoryGb: number, vision = true, platform: GlimmerPlatform | null = null): FormatFit[] {
  const dynamicText = gbToGib(GGUF_FILES.dynamic.downloadGb);
  const ggufTotal = (text: number) => text + (vision ? GLIMMER_MEASURED.mmprojGib : 0) + GLIMMER_MEASURED.kvAndBuffersGib;
  const verified = platform ? verifiedFormats(platform) : new Set<GlimmerFormat>();
  const vendor = platform?.vendor ?? null;
  const rows: FormatFit[] = [
    { format: "bf16", label: "bf16 (vLLM, SGLang)", needGb: GLIMMER.bf16ServeGb, basis: "the vLLM recipe's 72 GB serving budget", fits: memoryGb >= GLIMMER.bf16ServeGb, images: true },
    {
      format: "kquant17",
      label: "GGUF K-Quant-17GB",
      needGb: ggufTotal(GLIMMER_MEASURED.textGib),
      basis: vision ? "measured: 15.6 + 1.3 + 2.1 GiB at 131,072 tokens" : "measured, without the 1.3 GiB projector",
      fits: memoryGb >= ggufTotal(GLIMMER_MEASURED.textGib),
      images: vision,
    },
    {
      format: "dynamic",
      label: "GGUF Dynamic Q4_K_XL",
      needGb: ggufTotal(dynamicText),
      basis: `estimate: its 19.7 GB file is about ${gb(dynamicText)} GiB loaded, plus the same projector and KV cache`,
      fits: memoryGb >= ggufTotal(dynamicText),
      images: vision,
    },
    { format: "nvfp4", label: "NVFP4 (SGLang)", needGb: null, basis: "not given; SGLang verified it on a 32 GB RTX 5090 with an FP8 KV cache", fits: memoryGb >= 32 ? true : null, images: false },
    { format: "mlx", label: "MLX Q4 (SGLang on Apple silicon)", needGb: 48, basis: "SGLang's minimum: 48 GB of unified memory", fits: memoryGb >= 48, images: false },
  ];
  return rows.map((r) => {
    if (verified.has(r.format)) return { ...r, fits: true, basis: `verified on this platform (${platform!.verifiedBy})` };
    if (r.format === "nvfp4" && vendor && vendor !== "NVIDIA") return { ...r, fits: false, basis: "NVIDIA GPUs only" };
    if (r.format === "nvfp4" && platform?.id === "h200") return { ...r, fits: false, basis: "SGLang doesn't list NVFP4 for H200" };
    if (r.format === "mlx" && vendor && vendor !== "Apple") return { ...r, fits: false, basis: "Apple silicon only" };
    if (r.format === "bf16" && vendor === "Apple") return { ...r, fits: false, basis: "no Apple silicon path for bf16 on these pages: SGLang uses MLX repacks there" };
    return r;
  });
}

/** NVIDIA's single-B300 sweep (muse-glimmer/hardware-platforms, B300): 2,048 in, 256 out, 32,768-token prefix cache. */
export const B300_SWEEP = [
  { concurrency: 1, ttftMs: 215.6, perRequest: 85.76, total: 76.83 },
  { concurrency: 2, ttftMs: 307.3, perRequest: 84.44, total: 148.81 },
  { concurrency: 4, ttftMs: 395.3, perRequest: 81.99, total: 280.96 },
  { concurrency: 8, ttftMs: 618.7, perRequest: 77.37, total: 503.27 },
  { concurrency: 16, ttftMs: 979.7, perRequest: 67.26, total: 830.71 },
  { concurrency: 32, ttftMs: 1747.9, perRequest: 53.29, total: 1224.67 },
  { concurrency: 64, ttftMs: 2760.0, perRequest: 36.53, total: 1632.21 },
  { concurrency: 128, ttftMs: 3432.2, perRequest: 19.69, total: 1912.99 },
  { concurrency: 256, ttftMs: 2790.0, perRequest: 9.88, total: 2093.52 },
] as const;

/** The aiperf command that reproduces the sweep, for any list of concurrencies (10 requests per unit of concurrency). */
export function aiperfCommand(concurrencies: number[]): string {
  const list = concurrencies.length ? concurrencies : B300_SWEEP.map((r) => r.concurrency);
  return [
    "aiperf profile --model '/model' --tokenizer '/model' --url 'http://localhost:8000' \\",
    "  --endpoint-type 'chat' --streaming \\",
    "  --num-prefix-prompts 1 --prefix-prompt-length 32768 \\",
    "  --num-dataset-entries 10240 --dataset-sampling-strategy 'shuffle' --random-seed 7 \\",
    "  --isl 2048 --isl-stddev 0 --osl 256 --osl-stddev 0 \\",
    `  --concurrency '${list.join(",")}' \\`,
    `  --request-count '${list.map((c) => c * 10).join(",")}' \\`,
    "  --sweep-type 'zip' --warmup-request-count 3 --num-profile-runs 1 \\",
    "  --use-server-token-count --use-legacy-max-tokens \\",
    "  --extra-inputs 'max_tokens:256' --extra-inputs 'min_tokens:256' \\",
    "  --extra-inputs 'ignore_eos:true' --extra-inputs 'temperature:0'",
  ].join("\n");
}

export const GLIMMER_TROUBLESHOOTING = [
  {
    symptom: "Tool calls returned as plain text",
    cause: "Parser not enabled",
    fix: "Pass both --enable-auto-tool-choice and --tool-call-parser muse_glimmer. The chat template ships with the checkpoint, so no --chat-template flag is needed.",
  },
  { symptom: "Generation never stops", cause: "The runtime overrode the stop tokens", fix: "Confirm <|eom|> isn't in eos_token_id, and serve with --generation-config auto." },
  { symptom: "Out of memory at large batch sizes", cause: "KV cache exhausted", fix: "Lower --max-num-seqs or --max-model-len." },
];

export function describeSweepRow(c: (typeof B300_SWEEP)[number]): string {
  return `At ${c.concurrency} concurrent request${c.concurrency === 1 ? "" : "s"}: first token in ${n(c.ttftMs)} ms (p50), ${c.perRequest} tokens/s per request, ${n(c.total)} tokens/s in total.`;
}
