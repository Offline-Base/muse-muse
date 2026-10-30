import { SPARK_CHECKPOINTS, n, type SparkCheckpoint } from "@/components/docs/playgrounds/open-weights/facts";
import { blocks, command, exports } from "@/components/docs/playgrounds/open-weights/shell";
import { amdCommand } from "@/components/docs/playgrounds/open-weights/hardware";
import { bool, emptyPlan, num, str, type ClientSpec, type DeployPlan, type RuntimeDef, type Values } from "@/components/docs/playgrounds/open-weights/deploy";

/**
 * Muse Spark Open's runtimes, as muse-spark-open/deploy lays them out: SGLang (with DFlash2, HiCache, MegaMoE and
 * prefill/decode disaggregation), vLLM (with DSpark), TensorRT-LLM (serve_config.yaml), NVIDIA Dynamo, Hugging Face
 * Transformers (torchrun under Slurm), llama.cpp, Unsloth, MLX, and the hosted providers. Defaults reproduce the
 * page's commands exactly; each option is one of the variations the page describes.
 */

const CTX_CHOICES = [
  { value: "default", label: "Server default" },
  { value: "32768", label: "32,768" },
  { value: "131072", label: "131,072" },
  { value: "262144", label: "262,144" },
  { value: "524288", label: "524,288" },
  { value: "1048576", label: "1,048,576" },
];

const CHECKPOINT_CHOICES = [
  { value: "nvfp4", label: "NVFP4 · 4 GPUs" },
  { value: "bf16", label: "BF16 · 8 GPUs" },
];

const EFFORT_CHOICES = [
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
];

const ckpt = (v: Values): SparkCheckpoint => (str(v, "checkpoint", "nvfp4") === "bf16" ? "bf16" : "nvfp4");

const SPEC_FLAGS = [
  "--speculative-algorithm DFLASH",
  "--speculative-draft-model-path RadixArk/Muse-Spark-Open-DFlash2",
  "--speculative-draft-attention-backend fa4",
  "--speculative-num-draft-tokens 8",
];

function sparkClient(baseUrl: string, extra: Partial<ClientSpec> = {}): ClientSpec {
  return {
    baseUrl,
    model: null,
    keyEnv: null,
    keyPlaceholder: "null",
    reasoningFields: ["reasoning_content"],
    extra: { temperature: 1.0, top_p: 1.0, reasoning_effort: "high" },
    maxTokens: 16384,
    timeoutSec: 600,
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------------------------

const sglang: RuntimeDef = {
  id: "sglang",
  label: "SGLang",
  group: "self-host",
  bestFor: "High-throughput serving for concurrent users",
  anchor: "#sglang",
  options: [
    { id: "checkpoint", label: "Checkpoint", kind: "segmented", choices: CHECKPOINT_CHOICES, default: "nvfp4" },
    {
      id: "mode",
      label: "Serving",
      kind: "segmented",
      choices: [
        { value: "single", label: "One server" },
        { value: "pd", label: "Prefill and decode servers" },
      ],
      default: "single",
      hint: "Disaggregation runs prefill and decode as two NVFP4 servers on four GPUs each, with a router in front.",
      when: (v) => ckpt(v) === "nvfp4",
    },
    {
      id: "pdHardware",
      label: "Hardware",
      kind: "segmented",
      choices: [
        { value: "b300", label: "B300: one 8-GPU node" },
        { value: "gb300", label: "GB300: two 4-GPU nodes" },
      ],
      default: "b300",
      when: (v) => ckpt(v) === "nvfp4" && str(v, "mode") === "pd",
    },
    { id: "spec", label: "DFlash2 speculative decoding", kind: "toggle", default: true, hint: "The four --speculative-* flags; a block of eight draft tokens per step." },
    { id: "hicache", label: "HiCache (KV cache in pinned host memory)", kind: "toggle", default: true },
    { id: "hicacheSize", label: "Host memory per tensor-parallel rank (GB)", kind: "number", default: 200, min: 1, step: 10, when: (v) => bool(v, "hicache") },
    {
      id: "layernormSp",
      label: "Sequence-parallel prefill with MegaMoE",
      kind: "toggle",
      default: true,
      when: (v) => !(ckpt(v) === "nvfp4" && str(v, "mode") === "pd"),
    },
    {
      id: "tune",
      label: "Prefill tuning (trtllm_mha, page size 128, MegaMoE token limit)",
      kind: "toggle",
      default: false,
      when: (v) => ckpt(v) === "nvfp4" && str(v, "mode") !== "pd",
    },
    { id: "megaMoeTokens", label: "MegaMoE max tokens per rank", kind: "number", default: 8192, min: 512, step: 512, when: (v) => ckpt(v) === "nvfp4" && bool(v, "tune") && str(v, "mode") !== "pd" },
    { id: "context", label: "Context length (--context-length)", kind: "select", choices: CTX_CHOICES, default: "default", when: (v) => str(v, "mode") !== "pd" || ckpt(v) === "bf16" },
    { id: "port", label: "Port", kind: "number", default: 30000, min: 1, max: 65535, when: (v) => str(v, "mode") !== "pd" || ckpt(v) === "bf16" },
  ],
  build(v) {
    const plan = emptyPlan();
    const c = SPARK_CHECKPOINTS[ckpt(v)];
    const pd = c.id === "nvfp4" && str(v, "mode") === "pd";
    const spec = bool(v, "spec");
    const hicache = bool(v, "hicache");
    const hicacheSize = num(v, "hicacheSize", 200);
    plan.steps.push({ title: "Pull the image", lang: "bash", code: "docker pull lmsysorg/sglang:dev-muse-spark-open" });

    if (pd) {
      const gb300 = str(v, "pdHardware") === "gb300";
      const envPrefill = gb300
        ? exports({ NCCL_NVLS_ENABLE: 1, NCCL_MNNVL_ENABLE: 1, NCCL_CUMEM_ENABLE: 1, SGLANG_MOONCAKE_CUSTOM_MEM_POOL: "NVLINK", MC_FORCE_MNNVL: 1 })
        : exports({ MC_INTRANODE_NVLINK: "true", MC_TCP_ENABLE_CONNECTION_POOL: "true", SGLANG_MOONCAKE_CUSTOM_MEM_POOL: "INTRA_NODE_NVLINK", CUDA_VISIBLE_DEVICES: "0,1,2,3" });
      const envDecode = gb300 ? envPrefill : envPrefill.replace("CUDA_VISIBLE_DEVICES=0,1,2,3", "CUDA_VISIBLE_DEVICES=4,5,6,7");
      const shared = [
        `--model-path ${c.repo}`,
        "--quantization modelopt_fp4",
        "--moe-runner-backend flashinfer_trtllm",
        "--tp-size 4 --ep-size 4",
        "--attention-backend trtllm_mha --page-size 128",
        "--mem-fraction-static 0.8",
        "--reasoning-parser muse --tool-call-parser muse",
      ];
      plan.steps.push({
        title: gb300 ? "Environment, on the prefill node and the decode node" : "Environment, in the prefill terminal",
        lang: "bash",
        code: envPrefill,
      });
      plan.steps.push({
        title: "Prefill server (MegaMoE, sequence parallelism and HiCache) on port 30001",
        lang: "bash",
        code: command("sglang serve", [
          ...shared,
          "--enable-layernorm-sp --enable-megamoe-for-layernorm-sp",
          hicache && `--enable-hierarchical-cache --hicache-size ${hicacheSize}`,
          ...(spec ? SPEC_FLAGS : []),
          "--disaggregation-mode prefill",
          "--disaggregation-transfer-backend mooncake",
          "--host 0.0.0.0 --port 30001",
        ]),
      });
      if (!gb300) plan.steps.push({ title: "Environment, in the decode terminal", lang: "bash", code: envDecode });
      plan.steps.push({
        title: `Decode server (TensorRT-LLM MoE kernel${spec ? " and DFlash2" : ""}) on port 30002${gb300 ? ", on the decode node" : ", in a second terminal"}`,
        lang: "bash",
        code: command("sglang serve", [
          ...shared,
          ...(spec ? SPEC_FLAGS : []),
          "--disaggregation-mode decode",
          "--disaggregation-transfer-backend mooncake",
          "--host 0.0.0.0 --port 30002",
        ]),
      });
      const host = (h: string) => (gb300 ? `<${h}-host>` : "127.0.0.1");
      plan.steps.push({
        title: "Router, once both servers are up",
        lang: "bash",
        code: command("sglang-router launch", ["--pd-disaggregation", `--prefill http://${host("prefill")}:30001 8998`, `--decode http://${host("decode")}:30002`, "--host 0.0.0.0 --port 8000"]),
        note: "8998 after the prefill URL is the prefill server's bootstrap port. Send client requests to the router on port 8000.",
      });
      if (gb300) plan.notes.push("Replace <prefill-host> and <decode-host> with addresses the router can reach.");
      if (hicache) plan.notes.push(`HiCache on the prefill server pins ${n(hicacheSize * 4)} GB of host memory (${hicacheSize} GB per rank, 4 ranks).`);
      plan.client = sparkClient("http://127.0.0.1:8000/v1", { examplePrompt: "Briefly explain: what is SGLang?" });
      return plan;
    }

    const ranks = c.tp;
    const tune = c.id === "nvfp4" && bool(v, "tune");
    const ctx = str(v, "context", "default");
    const port = num(v, "port", 30000);
    const head = c.id === "nvfp4"
      ? [`--model-path ${c.repo}`, "--tp-size 4", "--ep-size 4", "--quantization modelopt_fp4", "--moe-runner-backend flashinfer_trtllm", tune && "--attention-backend trtllm_mha", tune && "--page-size 128", "--mem-fraction-static 0.8"]
      : [`--model-path ${c.repo}`, "--tp-size 8", "--ep-size 8", "--dtype bfloat16", "--mem-fraction-static 0.85"];
    const serve = command("sglang serve", [
      ...head,
      ctx !== "default" && `--context-length ${ctx}`,
      "--host 0.0.0.0",
      `--port ${port}`,
      bool(v, "layernormSp") && "--enable-layernorm-sp",
      bool(v, "layernormSp") && "--enable-megamoe-for-layernorm-sp",
      ...(spec ? SPEC_FLAGS : []),
      "--mm-feature-transport cpu",
      hicache && "--enable-hierarchical-cache",
      hicache && `--hicache-size ${hicacheSize}`,
      "--reasoning-parser muse",
      "--tool-call-parser muse",
    ]);
    plan.steps.push({
      title: `Start the server (${c.label} on ${c.gpus} × B300)`,
      lang: "bash",
      code: blocks(tune && exports({ SGLANG_OPT_DEEPGEMM_MEGA_MOE_NUM_MAX_TOKENS_PER_RANK: num(v, "megaMoeTokens", 8192) }), serve),
    });
    if (hicache) {
      plan.notes.push(
        `--hicache-size is pinned host memory per tensor-parallel rank: this command pins ${n(hicacheSize * ranks)} GB (${hicacheSize} GB × ${ranks} ranks). --hicache-ratio N sizes it against the device KV pool instead.`,
      );
    }
    if (tune) plan.notes.push("SGLANG_OPT_DEEPGEMM_MEGA_MOE_NUM_MAX_TOKENS_PER_RANK sets the most tokens that trigger MegaMoE. Raising it can speed up prefill at larger batch sizes but uses more device memory.");
    if (!bool(v, "layernormSp") && c.id === "nvfp4") plan.notes.push("Without --enable-layernorm-sp and --enable-megamoe-for-layernorm-sp, prefill runs without sequence parallelism and MegaMoE, which the page recommends for the best NVFP4 prefill.");
    if (ctx !== "default") plan.notes.push("KV memory grows with context on the 16 full-attention layers, so set the context to what your workload needs (Recommended settings).");
    plan.client = sparkClient(`http://127.0.0.1:${port}/v1`, { examplePrompt: "Briefly explain: what is SGLang?" });
    return plan;
  },
};

const vllm: RuntimeDef = {
  id: "vllm",
  label: "vLLM",
  group: "self-host",
  bestFor: "Production serving, high throughput",
  anchor: "#vllm",
  options: [
    { id: "checkpoint", label: "Checkpoint", kind: "segmented", choices: CHECKPOINT_CHOICES, default: "nvfp4" },
    {
      id: "vendor",
      label: "GPUs",
      kind: "segmented",
      choices: [
        { value: "nvidia", label: "NVIDIA" },
        { value: "amd", label: "AMD" },
      ],
      default: "nvidia",
    },
    { id: "maxModelLen", label: "--max-model-len", kind: "select", choices: CTX_CHOICES.filter((c) => c.value !== "default"), default: "1048576" },
    { id: "spec", label: "DSpark speculative decoding", kind: "toggle", default: true },
    { id: "rust", label: "Rust frontend (VLLM_USE_RUST_FRONTEND=1)", kind: "toggle", default: true },
  ],
  build(v) {
    const plan = emptyPlan();
    const c = SPARK_CHECKPOINTS[ckpt(v)];
    const amd = str(v, "vendor") === "amd";
    plan.steps.push({ title: "Pull the image", lang: "bash", code: `docker pull ${amd ? "vllm/vllm-openai-rocm:muse-spark-open" : "vllm/vllm-openai:muse-spark-open"}` });
    if (amd) {
      // AMD runs its own flags (hardware-platforms, AMD): AITER, ROCm attention, CUDA graph mode, and its own checkpoints.
      if (c.id === "nvfp4") {
        plan.errors.push("NVFP4 is NVIDIA Blackwell's format. On AMD Instinct, serve BF16, or AMD's Quark MXFP4 or PTPC-FP8 checkpoints (Hardware platforms).");
      }
      plan.steps.push({
        title: c.id === "bf16" ? "Start the server (BF16 on 8 × MI355X or MI350X, TP8)" : "Or AMD's MXFP4 checkpoint (8 × MI355X or MI350X, TP8+EP8)",
        lang: "bash",
        code: amdCommand(c.id === "bf16" ? "bf16" : "mxfp4"),
        note: "The Hardware platforms page also has the online-MXFP4, throughput, lowest-latency and FP8 variants; its builder writes each.",
      });
      plan.client = sparkClient("http://127.0.0.1:8006/v1", { model: "musespark", keyPlaceholder: "unused", examplePrompt: "Refactor this module.", reasoningFields: ["reasoning", "reasoning_content"], extra: { reasoning_effort: "xhigh" }, maxTokens: null });
      plan.client.notes = ["AMD's commands serve on 127.0.0.1:8006 with --served-model-name musespark."];
      return plan;
    }
    const serve = command(
      `vllm serve ${c.repo}`,
      [
        `--tensor-parallel-size ${c.tp}`,
        "--enable-expert-parallel",
        `--max-model-len ${str(v, "maxModelLen", "1048576")}`,
        "--reasoning-parser muse",
        "--tool-call-parser muse",
        "--enable-auto-tool-choice",
        bool(v, "spec") &&
          `--speculative-config '{"method":"dspark","model": "Inferact/Muse-Spark-Open-DSpark","num_speculative_tokens":7,"draft_sample_method":"probabilistic","rejection_sample_method":"block","enable_adaptive_verification":true}'`,
      ],
      { indent: "    " },
    );
    plan.steps.push({
      title: `Start the server (${c.label} on ${c.gpus} × B300${bool(v, "spec") ? ", with DSpark speculative decoding" : ""})`,
      lang: "bash",
      code: blocks(bool(v, "rust") && "export VLLM_USE_RUST_FRONTEND=1", serve),
    });
    if (c.id === "bf16") plan.notes.push("For BF16 the page serves meta-models/Muse-Spark-Open-816B-A42B with --tensor-parallel-size 8 on 8 × B300 and keeps the other flags.");
    if (str(v, "maxModelLen") === "1048576") plan.notes.push("--max-model-len 1048576 serves the full context window. KV memory on the full-attention layers grows with it, so lower it if your workload needs less.");
    plan.notes.push("Stop on <|eot|> and the end-of-text token. Never stop on <|eom|>, which ends a message while the turn continues.");
    plan.steps.push({
      title: "Send image, video and audio",
      lang: "bash",
      code: [
        "curl http://localhost:8000/v1/chat/completions \\",
        "  -H 'Content-Type: application/json' \\",
        "  -d '{",
        `    "model": "${c.repo}",`,
        '    "messages": [{"role": "user", "content": [',
        '      {"type": "image_url", "image_url": {"url": "https://example.com/screenshot.png"}},',
        '      {"type": "video_url", "video_url": {"url": "https://example.com/demo.mp4"}},',
        '      {"type": "audio_url", "audio_url": {"url": "https://example.com/clip.wav"}},',
        '      {"type": "text",      "text": "What is happening here, and when?"}',
        "    ]}]",
        "  }'",
      ].join("\n"),
    });
    plan.client = sparkClient("http://localhost:8000/v1", {
      model: c.repo,
      keyPlaceholder: "unused",
      examplePrompt: "Refactor this module.",
      reasoningFields: ["reasoning", "reasoning_content"],
      extra: { reasoning_effort: "xhigh" },
      maxTokens: null,
      notes: ["The Spark Open vLLM section says reasoning comes back separately from content without naming the field, so this code reads message.reasoning (vLLM's name for it on Muse Glimmer) or reasoning_content."],
    });
    return plan;
  },
};

const trtllm: RuntimeDef = {
  id: "trtllm",
  label: "TensorRT-LLM",
  group: "self-host",
  bestFor: "Optimized serving on NVIDIA Blackwell, on a single 4-GPU node",
  anchor: "#tensorrt-llm",
  options: [
    {
      id: "gpu",
      label: "GPUs",
      kind: "segmented",
      choices: [
        { value: "gb300", label: "GB300 (SM103)" },
        { value: "b300", label: "B300 (SM100)" },
      ],
      default: "gb300",
    },
    { id: "maxBatch", label: "max_batch_size", kind: "number", default: 256, min: 1, step: 16 },
    { id: "maxNumTokens", label: "max_num_tokens", kind: "number", default: 8192, min: 256, step: 256 },
    { id: "maxSeqLen", label: "max_seq_len", kind: "number", default: 49152, min: 1024, max: 1_048_576, step: 1024, hint: "49,152 is the validated window; the model supports up to 1M." },
    { id: "chunked", label: "Chunked prefill", kind: "toggle", default: true },
    { id: "reuse", label: "KV-cache block reuse", kind: "toggle", default: true },
    {
      id: "kvDtype",
      label: "KV cache dtype",
      kind: "segmented",
      choices: [
        { value: "fp8", label: "fp8" },
        { value: "auto", label: "16-bit" },
      ],
      default: "fp8",
    },
    { id: "freeMem", label: "free_gpu_memory_fraction", kind: "number", default: 0.8, min: 0.1, max: 0.95, step: 0.05 },
    { id: "remote", label: "Reachable from other hosts (--host 0.0.0.0 --port 8000)", kind: "toggle", default: false },
    { id: "json", label: "Send a JSON-mode request", kind: "toggle", default: false },
  ],
  build(v) {
    const plan = emptyPlan();
    const gb300 = str(v, "gpu") === "gb300";
    const chunked = bool(v, "chunked");
    const reuse = bool(v, "reuse");
    const fp8 = str(v, "kvDtype") === "fp8";
    const maxBatch = num(v, "maxBatch", 256);
    const maxSeq = num(v, "maxSeqLen", 49152);
    if (gb300 && (chunked || reuse) && !fp8) {
      plan.errors.push(
        "A 16-bit KV cache with chunked prefill or block reuse is refused at startup on GB300 (SM103): for this model's head dimension (64), the fused paged-context attention kernel exists only for FP8.",
      );
    }
    if (maxSeq > 49152) plan.warnings.push(`max_seq_len ${n(maxSeq)} is past the validated 49,152-token window. Longer windows need proportionally more KV-cache memory.`);
    plan.steps.push({
      title: "Install from the feat/musespark-open branch",
      lang: "bash",
      code: [
        "git clone --branch feat/musespark-open https://github.com/NVIDIA/TensorRT-LLM.git",
        "cd TensorRT-LLM",
        "git lfs pull",
        "",
        "# Inside the TensorRT-LLM development container, targeting Blackwell:",
        'python3 scripts/build_wheel.py --use_ccache -a "100-real" \\',
        "    --skip_building_wheel --linking_install_binary",
        "pip install -e .",
      ].join("\n"),
      note: "No pre-built release container or wheel includes Muse Spark Open support.",
    });
    const yaml = [
      "tensor_parallel_size: 4",
      "moe_expert_parallel_size: 4",
      "enable_attention_dp: false",
      `max_batch_size: ${maxBatch}`,
      `max_num_tokens: ${num(v, "maxNumTokens", 8192)}`,
      `max_seq_len: ${maxSeq}`,
      "trust_remote_code: true",
      `enable_chunked_prefill: ${chunked}`,
      "disable_overlap_scheduler: false",
      "attn_backend: TRTLLM",
      "allreduce_strategy: NCCL",
      "guided_decoding_backend: xgrammar",
      "cuda_graph_config:",
      `  max_batch_size: ${maxBatch}`,
      "  enable_padding: true",
      "moe_config:",
      "  backend: TRTLLM",
      "kv_cache_config:",
      ...(fp8 ? ["  # FP8 KV cache is required on GB300 (SM103) when chunked prefill or", "  # block reuse is enabled.", "  dtype: fp8"] : ["  dtype: auto"]),
      `  enable_block_reuse: ${reuse}`,
      `  enable_partial_reuse: ${reuse}`,
      `  free_gpu_memory_fraction: ${num(v, "freeMem", 0.8)}`,
    ].join("\n");
    plan.steps.push({ title: "serve_config.yaml", lang: "yaml", code: yaml });
    plan.steps.push({
      title: "Start the server",
      lang: "bash",
      code: command(
        `trtllm-serve ${SPARK_CHECKPOINTS.nvfp4.repo}`,
        ["--config serve_config.yaml", "--custom_tokenizer musespark_open", "--tool_parser musespark", "--reasoning_parser musespark", bool(v, "remote") && "--host 0.0.0.0 --port 8000"],
        { indent: "    " },
      ),
      note: "Ready when the log shows Application startup complete; the first query can take longer while it warms up.",
    });
    plan.notes.push("On out-of-memory errors, lower kv_cache_config.free_gpu_memory_fraction, max_batch_size or max_seq_len.");
    plan.notes.push("Reasoning and the answer share max_tokens: too small a budget is spent on reasoning and returns empty content with finish_reason length.");
    plan.client = sparkClient("http://localhost:8000/v1", {
      model: SPARK_CHECKPOINTS.nvfp4.repo,
      keyPlaceholder: "unused",
      timeoutSec: undefined,
      examplePrompt: bool(v, "json") ? "Give me a city and its country as JSON." : "Where is New York?",
      extra: bool(v, "json") ? { response_format: { type: "json_object" } } : {},
      maxTokens: 16384,
    });
    return plan;
  },
};

const dynamo: RuntimeDef = {
  id: "dynamo",
  label: "NVIDIA Dynamo",
  group: "self-host",
  bestFor: "Disaggregated serving and KV-aware routing",
  anchor: "#dynamo",
  options: [],
  build() {
    const plan = emptyPlan();
    plan.steps.push({
      title: "Follow the model recipe",
      lang: "text",
      code: [
        "Install:   https://docs.nvidia.com/dynamo/cli/installation/install-dynamo",
        "Recipe:    https://docs.nvidia.com/dynamo/recipes/Muse-Spark-Open",
        "Quickstart: https://docs.nvidia.com/dynamo/cli/getting-started/quickstart",
        "Recipes:   https://github.com/ai-dynamo/dynamo/tree/main/recipes",
      ].join("\n"),
      note: "The page defers launch commands and backend settings to the recipe: use its Muse Spark Open-enabled image and checkpoint, with the latest tokenizer, processor and chat template. Dynamo uses TensorRT-LLM as its backend engine.",
    });
    plan.notes.push("Chat completions separate reasoning_content from content and return structured tool_calls when tools are supplied.");
    plan.client = sparkClient("http://localhost:8000/v1", { model: SPARK_CHECKPOINTS.nvfp4.repo, keyPlaceholder: "unused", timeoutSec: undefined, extra: {} });
    plan.client.notes = ["The port is the Dynamo frontend's; check the recipe for the one it uses."];
    return plan;
  },
};

const transformers: RuntimeDef = {
  id: "transformers",
  label: "Transformers",
  group: "self-host",
  bestFor: "Native Python implementation for research and custom pipelines",
  anchor: "#transformers",
  options: [
    { id: "checkpoint", label: "Checkpoint", kind: "segmented", choices: [{ value: "bf16", label: "BF16" }, { value: "nvfp4", label: "NVFP4" }], default: "bf16" },
    { id: "nodes", label: "Nodes (Slurm)", kind: "number", default: 2, min: 1, max: 64 },
    { id: "gpusPerNode", label: "GPUs per node", kind: "number", default: 8, min: 1, max: 16 },
    { id: "effort", label: "reasoning_effort", kind: "segmented", choices: EFFORT_CHOICES, default: "low" },
    { id: "maxNewTokens", label: "max_new_tokens", kind: "number", default: 512, min: 16, step: 128 },
  ],
  build(v) {
    const plan = emptyPlan();
    const c = SPARK_CHECKPOINTS[ckpt(v)];
    const nodes = num(v, "nodes", 2);
    const per = num(v, "gpusPerNode", 8);
    plan.steps.push({
      title: "Install",
      lang: "bash",
      code:
        c.id === "nvfp4"
          ? "# NVFP4 needs Transformers from the NVFP4 pull request branch:\npip install git+https://github.com/huggingface/transformers.git@finegrained-per-scheme-demo"
          : 'pip install -U "transformers>=5.19"',
    });
    plan.steps.push({
      title: "run_muse_spark_open.py",
      lang: "python",
      code: [
        "import os",
        "",
        "from transformers import AutoModelForMultimodalLM, AutoProcessor, DistributedConfig",
        "",
        "distributed_config = DistributedConfig(",
        '    tp_size=int(os.environ["WORLD_SIZE"]),',
        '    ep_size=int(os.environ["WORLD_SIZE"]),',
        ")",
        "",
        `processor = AutoProcessor.from_pretrained("${c.repo}")`,
        "model = AutoModelForMultimodalLM.from_pretrained(",
        `    "${c.repo}",`,
        "    distributed_config=distributed_config,",
        ")",
        "",
        "messages = [",
        '    {"role": "user", "content": "Explain in one sentence why the sky is usually blue."},',
        "]",
        "inputs = processor.apply_chat_template(",
        "    messages,",
        `    reasoning_effort="${str(v, "effort", "low")}",  # default: xhigh, options: low/medium/high/xhigh`,
        "    add_generation_prompt=True,",
        "    tokenize=True,",
        "    return_dict=True,",
        '    return_tensors="pt",',
        ").to(model.device).to(model.dtype)",
        'input_len = inputs["input_ids"].shape[-1]',
        "",
        `outputs = model.generate(**inputs, max_new_tokens=${num(v, "maxNewTokens", 512)})`,
        "print(processor.decode(outputs[0][input_len:], skip_special_tokens=False))",
      ].join("\n"),
    });
    plan.steps.push({
      title: "Launch with torchrun on every node (Slurm)",
      lang: "bash",
      code: [
        "#!/bin/bash",
        "#SBATCH --job-name=muse-spark-open",
        `#SBATCH --nodes=${nodes}`,
        "#SBATCH --ntasks-per-node=1",
        `#SBATCH --gpus-per-node=${per}`,
        "",
        'export MASTER_ADDR=$(scontrol show hostnames "$SLURM_JOB_NODELIST" | head -n 1)',
        "export MASTER_PORT=29500",
        "",
        "srun bash -c 'torchrun \\",
        "    --nnodes=$SLURM_NNODES \\",
        `    --nproc-per-node=${per} \\`,
        "    --node-rank=$SLURM_NODEID \\",
        "    --master-addr=$MASTER_ADDR \\",
        "    --master-port=$MASTER_PORT \\",
        "    run_muse_spark_open.py'",
      ].join("\n"),
    });
    const world = nodes * per;
    plan.notes.push(`torchrun sets WORLD_SIZE = ${nodes} × ${per} = ${world}, so the dense layers shard ${world} ways (tp_size) and the experts spread over ${world} devices (ep_size).`);
    plan.notes.push("The decoded output keeps special tokens: reasoning comes first as a to=self message, then <|eom|><|start|>assistant to=user<|message|> and the answer.");
    return plan;
  },
};

const llamacpp: RuntimeDef = {
  id: "llamacpp",
  label: "llama.cpp",
  group: "self-host",
  bestFor: "Portable inference across Metal, CUDA, ROCm, Vulkan, and CPU",
  anchor: "#llama-cpp",
  options: [
    {
      id: "quant",
      label: "Quantization",
      kind: "segmented",
      choices: [
        { value: "", label: "Default" },
        { value: "Q4_K_S", label: "Q4_K_S" },
        { value: "Q8_0", label: "Q8_0" },
        { value: "Q2_K", label: "Q2_K" },
      ],
      default: "",
    },
    { id: "alias", label: "API alias (-a muse-spark-open)", kind: "toggle", default: true },
    { id: "effort", label: "reasoning_effort (server-wide)", kind: "segmented", choices: EFFORT_CHOICES, default: "low" },
    { id: "ctx", label: "Total context (-c, 0 for the default)", kind: "number", default: 0, min: 0, max: 1_048_576, step: 1024 },
    { id: "np", label: "Slots (-np)", kind: "number", default: 1, min: 1, max: 64 },
    { id: "apiKey", label: "Gate endpoints with --api-key", kind: "toggle", default: true },
  ],
  build(v) {
    const plan = emptyPlan();
    const quant = str(v, "quant");
    const ctx = num(v, "ctx", 0);
    const np = Math.max(1, Math.round(num(v, "np", 1)));
    const alias = bool(v, "alias");
    const key = bool(v, "apiKey");
    const repo = `ggml-org/Muse-Spark-Open-816B-A42B-GGUF${quant ? `:${quant}` : ""}`;
    plan.steps.push({ title: "Install the prebuilt llama binary", lang: "bash", code: "curl -LsSf https://llama.app/install.sh | sh" });
    plan.steps.push({
      title: "Serve (downloads, caches and serves in one command)",
      lang: "bash",
      code: command(`llama serve -hf ${repo}`, [
        alias && "-a muse-spark-open",
        ctx > 0 && `-c ${ctx}`,
        np > 1 && `-np ${np}`,
        key && '--api-key "$LLAMA_API_KEY"',
        `--chat-template-kwargs '{"reasoning_effort":"${str(v, "effort", "low")}"}'`,
      ]),
      note: "Open http://localhost:8080 for the Llama WebUI, which takes images, audio and MCP tools.",
    });
    if (ctx > 0 && np > 1) {
      const per = Math.floor(ctx / np);
      plan.notes.push(`-c is the total context, shared by the slots: ${n(ctx)} / ${np} = ${n(per)} tokens per generation. Check n_ctx_slot in the startup log.`);
      if (per < 32768) plan.warnings.push("A generation that outgrows its slot can return neither an answer nor an error. Long-context agents should use -np 1, or raise -c in proportion to -np.");
    } else if (np > 1) {
      plan.notes.push(`With -np ${np}, the context is divided across ${np} slots. Raise -c in proportion to -np to keep each slot's limit (-c 524288 -np 2 gives 262,144 per slot).`);
    }
    plan.notes.push("Reasoning can't be turned off: the template rejects reasoning_effort none and --reasoning off leaves the output unchanged. Use low to spend fewer thinking tokens.");
    if (key) plan.notes.push("--api-key gates the inference endpoints; /health and /v1/models still answer without it.");
    plan.steps.push({ title: "Or chat in the terminal", lang: "bash", code: `llama cli -hf ggml-org/Muse-Spark-Open-816B-A42B-GGUF${quant ? `:${quant}` : ""} -c 32768`, note: "Use /image image.png or /audio clip.mp3 in the CLI to pass media, then type the prompt." });
    plan.client = sparkClient("http://127.0.0.1:8080/v1", {
      model: alias ? "muse-spark-open" : null,
      keyEnv: key ? "LLAMA_API_KEY" : null,
      examplePrompt: "What is 17 * 23?",
      keyPlaceholder: "unused",
      extra: { temperature: 1.0 },
      maxTokens: null,
      noProxy: true,
      timeoutSec: undefined,
      notes: ['Per request, send "chat_template_kwargs": {"reasoning_effort": "low"} to change the level for one call.'],
    });
    return plan;
  },
};

const UNSLOTH_MEMORY = [
  { bits: "2-bit", gb: "300-315 GB" },
  { bits: "3-bit", gb: "365-390 GB" },
  { bits: "4-bit", gb: "470-500 GB" },
  { bits: "6-bit", gb: "670-700 GB" },
  { bits: "8-bit", gb: "870-950 GB" },
];

const unsloth: RuntimeDef = {
  id: "unsloth",
  label: "Unsloth",
  group: "self-host",
  bestFor: "Local inference on macOS, Windows, Linux, and WSL",
  anchor: "#unsloth",
  options: [
    {
      id: "quant",
      label: "Dynamic GGUF",
      kind: "segmented",
      choices: [
        { value: "UD-Q2_K_XL", label: "UD-Q2_K_XL · 2-bit" },
        { value: "UD-Q4_K_XL", label: "UD-Q4_K_XL · 4-bit" },
      ],
      default: "UD-Q2_K_XL",
    },
    { id: "context", label: "--context-length", kind: "number", default: 32768, min: 2048, max: 1_048_576, step: 2048 },
    { id: "effort", label: "--reasoning-effort", kind: "segmented", choices: EFFORT_CHOICES, default: "medium" },
    { id: "port", label: "Port", kind: "number", default: 8888, min: 1, max: 65535 },
    { id: "agent", label: "Also connect a coding agent (unsloth start claude)", kind: "toggle", default: false },
  ],
  build(v) {
    const plan = emptyPlan();
    const quant = str(v, "quant", "UD-Q2_K_XL");
    const ctx = num(v, "context", 32768);
    const effort = str(v, "effort", "medium");
    const port = num(v, "port", 8888);
    const runArgs = [
      `--model unsloth/Muse-Spark-Open-816B-A42B-GGUF:${quant}`,
      "-H 127.0.0.1",
      `-p ${port}`,
      `--context-length ${ctx}`,
      "--temperature 1.0",
      "--top-p 1.0",
      "--min-p 0.0",
      `--reasoning-effort ${effort}`,
    ];
    plan.steps.push({ title: "Install (macOS, Linux, WSL)", lang: "bash", code: "curl -fsSL https://unsloth.ai/install.sh | sh", note: "Windows PowerShell: irm https://unsloth.ai/install.ps1 | iex" });
    plan.steps.push({ title: "Load the model and start its API", lang: "bash", code: command("unsloth run", runArgs), note: "Unsloth prints the endpoint URL and API key. Keep this terminal running." });
    plan.steps.push({
      title: "In a second terminal: the base URL, the key and the loaded model's id",
      lang: "bash",
      code: [
        `export UNSLOTH_BASE_URL="http://127.0.0.1:${port}"`,
        'export UNSLOTH_API_KEY="paste-your-unsloth-api-key-here"',
        "",
        'UNSLOTH_MODEL_ID="$(',
        '  curl --fail-with-body "${UNSLOTH_BASE_URL}/v1/models" \\',
        '    -H "Authorization: Bearer ${UNSLOTH_API_KEY}" |',
        "    python3 -c '",
        "import json",
        "import sys",
        "",
        "models = [",
        "    model",
        '    for model in json.load(sys.stdin)["data"]',
        '    if model.get("loaded") is True',
        '    and "muse-spark-open" in model["id"].lower()',
        "]",
        "if len(models) != 1:",
        '    raise SystemExit("Load exactly one Muse Spark Open model and retry.")',
        'print(models[0]["id"])',
        "'",
        ')" && export UNSLOTH_MODEL_ID',
      ].join("\n"),
    });
    if (bool(v, "agent")) plan.steps.push({ title: "Connect a coding agent", lang: "bash", code: command("unsloth start claude", runArgs.filter((a) => !a.startsWith("-H") && !a.startsWith("-p"))) });
    const row = UNSLOTH_MEMORY.find((r) => r.bits === (quant === "UD-Q4_K_XL" ? "4-bit" : "2-bit"));
    plan.notes.push(`Plan for about ${row?.gb} of system RAM plus VRAM (or unified memory) for the ${row?.bits} quant, before the OS, runtime and KV cache. Longer contexts need more.`);
    if (ctx > 32768) plan.notes.push("A larger context means a larger KV cache. The model's 1,048,576-token maximum isn't a recommended allocation for every machine.");
    plan.client = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: null,
      modelEnv: "UNSLOTH_MODEL_ID",
      keyEnv: "UNSLOTH_API_KEY",
      keyPlaceholder: "",
      reasoningFields: [],
      extra: { temperature: 1.0, top_p: 1.0, min_p: 0.0, reasoning_effort: effort, enable_tools: false },
      maxTokens: 8192,
      examplePrompt: "Explain mixture-of-experts models in three sentences.",
      notes: ["min_p and enable_tools are Unsloth extensions. enable_tools: false keeps the request as text generation, with Unsloth's own server-side tools off."],
    };
    return plan;
  },
};

const mlx: RuntimeDef = {
  id: "mlx",
  label: "MLX",
  group: "self-host",
  bestFor: "Inference on Apple silicon, across two or four Mac Studio computers",
  anchor: "#mlx",
  options: [
    {
      id: "macs",
      label: "Mac Studios (M5 Ultra)",
      kind: "segmented",
      choices: [
        { value: "2", label: "Two with 512 GB" },
        { value: "4", label: "Four with 256 GB" },
      ],
      default: "4",
    },
    { id: "maxTokens", label: "--max-tokens (generate)", kind: "number", default: 4096, min: 256, step: 256 },
  ],
  build(v) {
    const plan = emptyPlan();
    const macs = str(v, "macs", "4") === "2" ? 2 : 4;
    const hosts = Array.from({ length: macs }, (_, i) => `mac-studio-${i + 1}.local`);
    plan.steps.push({
      title: "From the primary, check passwordless SSH to every other Mac",
      lang: "bash",
      code: hosts.slice(1).map((h) => `ssh ${h} 'echo ok'`).join("\n"),
      note: "If one prompts for a password: ssh-keygen -t ed25519, then ssh-copy-id for that host.",
    });
    plan.steps.push({ title: "Install mlx-lm on each Mac", lang: "bash", code: "pip install -U mlx-lm" });
    plan.steps.push({
      title: "Start the server on the primary (OpenAI-compatible, port 8080)",
      lang: "bash",
      code: "mlx.launch --hostfile hostfile.json --backend jaccl --env MLX_METAL_FAST_SYNCH=1 -- \\\n  mlx_lm.server --model meta-models/Muse-Spark-Open-816B-A42B-NVFP4 --port 8080",
      note: `hostfile.json lists all ${macs} Macs (${hosts.join(", ")}) with their Thunderbolt IPs and RDMA devices; mlx.distributed_config can generate it (MLX distributed docs).`,
    });
    plan.steps.push({
      title: "Or generate from the command line",
      lang: "bash",
      code: [
        "mlx.launch --hostfile hostfile.json --backend jaccl --env MLX_METAL_FAST_SYNCH=1 -- \\",
        "  mlx_lm.generate \\",
        "    --model meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \\",
        '    --prompt "Give me a one-sentence summary of what you can do." \\',
        `    --max-tokens ${num(v, "maxTokens", 4096)} \\`,
        "    --temp 1.0 \\",
        "    --top-p 1.0",
      ].join("\n"),
    });
    plan.notes.push("Every Mac needs macOS 26.2 or later with RDMA on, MLX 0.30.1 or later, a direct Thunderbolt 5 link to every other Mac (two cables per pair doubles the bandwidth), and disk for the full NVFP4 checkpoint.");
    plan.client = sparkClient("http://127.0.0.1:8080/v1", {
      model: SPARK_CHECKPOINTS.nvfp4.repo,
      reasoningFields: [],
      extra: { temperature: 1.0, top_p: 1.0 },
      maxTokens: 4096,
      timeoutSec: 600,
      examplePrompt: "Give me a one-sentence summary of what you can do.",
    });
    plan.client.notes = ["The page doesn't say how mlx_lm.server returns the reasoning; the template defaults to xhigh, so leave room for reasoning tokens before the answer."];
    return plan;
  },
};

const PROVIDERS = {
  together: { label: "Together AI", base: "https://api.together.xyz/v1", model: "meta-models/muse-spark-open", key: "TOGETHER_API_KEY", max: null as number | null, effort: null as string | null, prompt: "Explain mixture-of-experts models in two sentences." },
  fireworks: { label: "Fireworks AI", base: "https://api.fireworks.ai/inference/v1", model: "accounts/fireworks/models/muse-spark-open", key: "FIREWORKS_API_KEY", max: 4096, effort: null, prompt: "Explain mixture-of-experts models in two sentences." },
  baseten: { label: "Baseten", base: "https://inference.baseten.co/v1", model: "meta-models/muse-spark-open", key: "BASETEN_API_KEY", max: null, effort: null, prompt: "Explain what a stack trace is in two sentences." },
  groq: { label: "Groq", base: "https://api.groq.com/openai/v1", model: "meta-models/muse-spark-open", key: "GROQ_API_KEY", max: null, effort: "medium", prompt: "What is the capital of France?" },
  nebius: { label: "Nebius Token Factory", base: "https://api.tokenfactory.us-north1.nebius.com/v1/", model: "meta-models/muse-spark-open", key: "NEBIUS_API_KEY", max: 16384, effort: null, prompt: "Say hello in one sentence." },
} as const;

type ProviderId = keyof typeof PROVIDERS;

const PROVIDER_NOTES: Record<ProviderId, string[]> = {
  together: ["Serverless and on-demand dedicated endpoints through an OpenAI-compatible API."],
  fireworks: [
    "Serverless, billed per token, 1,048,576-token context, text and images, tool calling.",
    "reasoning_effort takes low, medium, high or xhigh (the default); none is rejected. Reasoning comes back in reasoning_content.",
  ],
  baseten: ["Full 1,048,576-token context with text, image, video and audio input. Send media over about 74 MB by URL; video by URL up to 200 MB."],
  groq: ["GroqCloud access needs approval for your organization. The model has a 131,072-token context there.", "reasoning_effort takes low, medium, high or xhigh, and defaults to xhigh."],
  nebius: ["The model id is case-sensitive. Check that your key can list it with GET /v1/models first."],
};

const hosted: RuntimeDef = {
  id: "hosted",
  label: "Hosted provider",
  group: "hosted",
  bestFor: "Calling the open weights without provisioning GPUs",
  anchor: "#hosted-providers",
  options: [
    {
      id: "provider",
      label: "Provider",
      kind: "select",
      choices: (Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({ value: id, label: PROVIDERS[id].label })),
      default: "fireworks",
    },
  ],
  build(v) {
    const plan = emptyPlan();
    const id = (Object.keys(PROVIDERS) as ProviderId[]).includes(str(v, "provider") as ProviderId) ? (str(v, "provider") as ProviderId) : "fireworks";
    const p = PROVIDERS[id];
    plan.steps.push({ title: `Export your ${p.label} key`, lang: "bash", code: `export ${p.key}="YOUR_API_KEY"` });
    plan.notes.push(...PROVIDER_NOTES[id]);
    plan.client = {
      baseUrl: p.base,
      model: p.model,
      keyEnv: p.key,
      keyPlaceholder: "",
      reasoningFields: id === "fireworks" ? ["reasoning_content"] : [],
      extra: p.effort ? { reasoning_effort: p.effort } : {},
      maxTokens: p.max,
      examplePrompt: p.prompt,
    };
    return plan;
  },
};

export const SPARK_RUNTIMES: RuntimeDef[] = [sglang, vllm, trtllm, dynamo, transformers, llamacpp, unsloth, mlx, hosted];

export function sparkRuntime(id: string): RuntimeDef {
  return SPARK_RUNTIMES.find((r) => r.id === id) ?? sglang;
}

export { UNSLOTH_MEMORY };

/** Tests and the copy prompt read the default plan of a runtime. */
export function defaultSparkPlan(id: string): DeployPlan {
  const r = sparkRuntime(id);
  return r.build(Object.fromEntries(r.options.map((o) => [o.id, o.default])));
}
