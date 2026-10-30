import { GGUF_FILES, GLIMMER, GLIMMER_REPOS, n, pteExport, type PteBackend, type PteDecoding, type PteModality, type PteQuant } from "@/components/docs/playgrounds/open-weights/facts";
import { blocks, command } from "@/components/docs/playgrounds/open-weights/shell";
import { bool, emptyPlan, num, str, type ClientSpec, type DeployPlan, type RuntimeDef, type Values } from "@/components/docs/playgrounds/open-weights/deploy";
import { ggufDraftDownload } from "@/components/docs/playgrounds/open-weights/gguf";

/**
 * Muse Glimmer's runtimes, as muse-glimmer/deploy lays them out: vLLM (Docker), SGLang (bf16, GGUF, NVFP4 and MLX,
 * with DFlash), llama.cpp (the GGUF builds, slots, reasoning_strength, DFlash), ExecuTorch (export or a prebuilt
 * .pte), Transformers, Ollama, LM Studio, Unsloth, and Together AI. Defaults reproduce the page's commands; the
 * checks are the page's own troubleshooting rows.
 */

const STRENGTH_CHOICES = [
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
];

const TOOL_CHECK = (base: string, extraHeader = "") =>
  [
    `curl -s${base.includes("127.0.0.1:8080") ? " --noproxy '*'" : ""} ${base}/chat/completions \\`,
    `  -H "Content-Type: application/json"${extraHeader ? ` ${extraHeader}` : ""} \\`,
    `  -d '{"model":"muse-glimmer","messages":[{"role":"user","content":"What is the weather in Paris in celsius? Use the tool."}],`,
    '       "tools":[{"type":"function","function":{',
    '         "name":"get_weather","description":"Get current weather for a city.",',
    '         "parameters":{"type":"object","properties":{',
    '           "city":{"type":"string"},"units":{"type":"string","enum":["celsius","fahrenheit"]}},',
    '           "required":["city"]}}}],',
    '       "tool_choice":"auto"}\'',
  ].join("\n");

function glimmerClient(baseUrl: string, extra: Partial<ClientSpec> = {}): ClientSpec {
  return {
    baseUrl,
    model: "muse-glimmer",
    keyEnv: null,
    keyPlaceholder: "unused",
    reasoningFields: ["reasoning_content"],
    extra: {},
    maxTokens: 2048,
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------------------------

const vllm: RuntimeDef = {
  id: "vllm",
  label: "vLLM",
  group: "self-host",
  bestFor: "Production serving on NVIDIA GPUs",
  anchor: "#vllm",
  options: [
    {
      id: "weights",
      label: "Weights",
      kind: "segmented",
      choices: [
        { value: "hub", label: "From the Hub (cached)" },
        { value: "local", label: "Already downloaded" },
      ],
      default: "hub",
    },
    { id: "path", label: "Path to the weights", kind: "text", default: "/path/to/Muse-Glimmer-30B", when: (v) => str(v, "weights") === "local" },
    { id: "tp", label: "GPUs (--tensor-parallel-size)", kind: "number", default: 1, min: 1, max: 8 },
    {
      id: "memory",
      label: "Memory",
      kind: "segmented",
      choices: [
        { value: "standard", label: "Standard" },
        { value: "tight", label: "Tight (less throughput and context)" },
      ],
      default: "standard",
    },
    { id: "maxLen", label: "--max-model-len (0 to leave it out)", kind: "number", default: 0, min: 0, max: 1_048_576, step: 1024, when: (v) => str(v, "memory") !== "tight" },
  ],
  build(v) {
    const plan = emptyPlan();
    const local = str(v, "weights") === "local";
    const tp = Math.max(1, Math.round(num(v, "tp", 1)));
    const tight = str(v, "memory") === "tight";
    const maxLen = num(v, "maxLen", 0);
    plan.steps.push({ title: "Pull the image (about 10.5 GB, linux/amd64 and linux/arm64)", lang: "bash", code: "docker pull vllm/vllm-openai:muse-glimmer" });
    const serve = command("docker run --rm --gpus all --ipc=host", [
      "-p 8000:8000",
      local ? `-v ${str(v, "path", "/path/to/Muse-Glimmer-30B")}:/model` : "-v ~/.cache/huggingface:/root/.cache/huggingface",
      "vllm/vllm-openai:muse-glimmer",
      local ? "/model" : GLIMMER_REPOS.bf16,
      "--served-model-name muse-glimmer",
      tight ? "--gpu-memory-utilization 0.9 --max-model-len 8300 --enforce-eager" : `--tensor-parallel-size ${tp}`,
      tight && tp > 1 && `--tensor-parallel-size ${tp}`,
      !tight && maxLen > 0 && `--max-model-len ${maxLen}`,
      "--enable-auto-tool-choice",
      "--tool-call-parser muse_glimmer",
      "--reasoning-parser muse_glimmer",
      "--generation-config auto",
    ]);
    plan.steps.push({
      title: "Start the server",
      lang: "bash",
      code: serve,
      note: "The image's entrypoint is vllm serve, so the model and flags follow the image name directly.",
    });
    plan.steps.push({ title: "Check tool calling", lang: "bash", code: TOOL_CHECK("http://localhost:8000/v1").replace("curl -s ", "curl "), note: 'Expect get_weather(city="Paris", units="celsius"), with the reasoning under message.reasoning.' });
    if (!local) plan.notes.push("Mounting ~/.cache/huggingface stops the container from downloading about 60 GB of weights on every start.");
    plan.notes.push(`Budget ${GLIMMER.bf16ServeGb} GB of VRAM${tp > 1 ? `, about ${Math.ceil(GLIMMER.bf16ServeGb / tp)} GB on each of ${tp} GPUs` : ""}: the bf16 weights are about 60 GB and the rest goes to KV cache, activations and CUDA overhead.`);
    plan.notes.push("Parser names use underscores (muse_glimmer); the served name muse-glimmer is a label you choose.");
    plan.notes.push("--generation-config auto applies the published sampling (temperature 1.0, top_p 0.95, top_k 64) and stop tokens. Don't send temperature 0.");
    plan.client = glimmerClient("http://localhost:8000/v1", { reasoningFields: ["reasoning"], examplePrompt: "Write a Python function to compute Fibonacci numbers." });
    return plan;
  },
};

type SglangFormat = "bf16" | "gguf" | "nvfp4" | "mlx";
type SglangHardware = "datacenter" | "rtx5090" | "dgx" | "apple";

const SGLANG_LISTS: Record<SglangFormat, string> = {
  bf16: "B300, B200, H200, RTX PRO 6000 (96 GB), DGX Spark",
  gguf: "B300, RTX 5090 (32 GB)",
  nvfp4: "B300, B200, RTX 5090, RTX PRO 6000, DGX Spark",
  mlx: "Apple silicon, 48 GB or more of unified memory",
};

const SGLANG_OK: Record<SglangFormat, SglangHardware[]> = {
  bf16: ["datacenter", "dgx"],
  gguf: ["datacenter", "rtx5090"],
  nvfp4: ["datacenter", "rtx5090", "dgx"],
  mlx: ["apple"],
};

/** muse-glimmer/deploy, "Memory and parallelism". DFlash lowers DGX Spark's values. */
export function sglangMemFraction(format: SglangFormat, hw: SglangHardware, dflash: boolean): number {
  if (format === "mlx") return 0.85;
  if (hw === "dgx") {
    if (format === "nvfp4") return dflash ? 0.38 : 0.4;
    return dflash ? 0.65 : 0.75;
  }
  if (hw === "rtx5090" && format === "nvfp4") return 0.9;
  return 0.85;
}

const sglang: RuntimeDef = {
  id: "sglang",
  label: "SGLang",
  group: "self-host",
  bestFor: "High-throughput serving for concurrent users on NVIDIA GPUs or Apple silicon",
  anchor: "#sglang",
  options: [
    {
      id: "format",
      label: "Checkpoint",
      kind: "segmented",
      choices: [
        { value: "bf16", label: "bf16 · text and image" },
        { value: "gguf", label: "GGUF Q4_K_M" },
        { value: "nvfp4", label: "NVFP4" },
        { value: "mlx", label: "MLX" },
      ],
      default: "bf16",
    },
    {
      id: "hardware",
      label: "Hardware",
      kind: "select",
      choices: [
        { value: "datacenter", label: "B300, B200, H200 or RTX PRO 6000" },
        { value: "rtx5090", label: "RTX 5090 (32 GB)" },
        { value: "dgx", label: "DGX Spark (128 GB unified)" },
        { value: "apple", label: "Apple silicon" },
      ],
      default: "datacenter",
    },
    {
      id: "install",
      label: "Install",
      kind: "segmented",
      choices: [
        { value: "docker", label: "Docker image" },
        { value: "source", label: "From source" },
      ],
      default: "docker",
    },
    { id: "dflash", label: "DFlash speculative decoding", kind: "toggle", default: false, when: (v) => str(v, "format") !== "mlx" },
    {
      id: "draft",
      label: "Draft model",
      kind: "segmented",
      choices: [
        { value: "assistant", label: "Muse-Glimmer-30B-assistant" },
        { value: "gguf", label: "GGUF draft" },
      ],
      default: "assistant",
      when: (v) => str(v, "format") !== "mlx" && bool(v, "dflash"),
    },
    { id: "block", label: "--speculative-dflash-block-size", kind: "number", default: 5, min: 2, max: 16, when: (v) => str(v, "format") !== "mlx" && bool(v, "dflash") },
    {
      id: "languageOnly",
      label: "Skip the vision tower (--language-model-only)",
      kind: "toggle",
      default: false,
      hint: "Frees memory for KV cache; image requests then fail.",
      when: (v) => str(v, "format") === "bf16",
    },
  ],
  build(v) {
    const plan = emptyPlan();
    const format = (["bf16", "gguf", "nvfp4", "mlx"].includes(str(v, "format")) ? str(v, "format") : "bf16") as SglangFormat;
    const hw = (["datacenter", "rtx5090", "dgx", "apple"].includes(str(v, "hardware")) ? str(v, "hardware") : "datacenter") as SglangHardware;
    const dflash = format !== "mlx" && bool(v, "dflash");
    const draft = str(v, "draft", "assistant");
    const block = Math.round(num(v, "block", 5));
    const languageOnly = format === "nvfp4" || (format === "bf16" && bool(v, "languageOnly"));

    if (!SGLANG_OK[format].includes(hw)) {
      plan.warnings.push(`SGLang lists ${format === "mlx" ? "MLX" : format === "bf16" ? "bf16" : format.toUpperCase()} for ${SGLANG_LISTS[format]}, not this hardware.`);
    }
    if (format === "nvfp4" && hw === "datacenter") plan.notes.push("SGLang doesn't list NVFP4 for H200.");
    if (hw === "datacenter" && format === "gguf") plan.notes.push("Of the data-center GPUs, SGLang verified GGUF on B300.");

    plan.steps.push(
      str(v, "install") === "source"
        ? {
            title: "Install SGLang from source",
            lang: "bash",
            code: ["pip install --upgrade pip", "pip install uv", "git clone https://github.com/sgl-project/sglang.git", "cd sglang", "uv pip install -e python"].join("\n"),
          }
        : { title: "Pull the image (multi-arch: amd64 or arm64)", lang: "bash", code: "docker pull lmsysorg/sglang:dev-muse-glimmer", note: "dev-muse-glimmer-amd64 and dev-muse-glimmer-arm64 pin one architecture." },
    );

    const fraction = sglangMemFraction(format, hw, dflash);
    const modelPath =
      format === "gguf"
        ? `${GLIMMER_REPOS.gguf}/${GGUF_FILES.kquant17.file}`
        : format === "nvfp4"
          ? "RadixArk/Muse-Glimmer-NVFP4"
          : format === "mlx"
            ? "RadixArk/Muse-Glimmer-q4km-gs128-MLX"
            : GLIMMER_REPOS.bf16;
    const draftPath = draft === "gguf" ? `${GLIMMER_REPOS.gguf}/${GGUF_FILES.dflash.file}` : GLIMMER_REPOS.assistant;
    const head = format === "mlx" ? "SGLANG_USE_MLX=1 SGLANG_MLX_CACHE_LIMIT_GB=8 \\\nsglang serve" : "sglang serve";
    plan.steps.push({
      title: "Start the server",
      lang: "bash",
      code: command(head, [
        `--model-path ${modelPath}`,
        "--served-model-name muse-glimmer",
        format === "mlx" && "--trust-remote-code",
        "--reasoning-parser muse",
        "--tool-call-parser muse",
        languageOnly && "--language-model-only",
        format === "nvfp4" && "--kv-cache-dtype fp8_e4m3",
        format === "mlx" && "--disable-radix-cache",
        `--mem-fraction-static ${fraction}`,
        ...(dflash
          ? [
              "--speculative-algorithm DFLASH",
              `--speculative-draft-model-path ${draftPath}`,
              `--speculative-dflash-block-size ${block}`,
              format === "gguf" && "--speculative-draft-load-format auto",
              draft === "gguf" ? "--speculative-draft-model-quantization gguf" : format === "nvfp4" && "--speculative-draft-model-quantization fp8",
            ]
          : []),
        "--host 0.0.0.0 --port 30000",
      ]),
      note: "python -m sglang.launch_server with the same flags is the long form.",
    });
    if (format === "gguf") plan.notes.push("--model-path points at the file, not the repository. The GGUF path is text only (no mmproj support), and SGLang warns at startup that it isn't optimized.");
    if (format === "nvfp4") plan.notes.push("--language-model-only is required: the NVFP4 checkpoint ships no vision weights. --kv-cache-dtype fp8_e4m3 roughly doubles the KV pool on 32 GB cards (57K to 115K tokens on an RTX 5090).");
    if (format === "mlx") plan.notes.push("The radix cache must be off for the sliding-window layers, and SGLANG_MLX_CACHE_LIMIT_GB=8 stops the MLX buffer cache from growing under concurrent load. -q4-MLX is the fastest swap and -q4k-dynamic-MLX the most faithful. MLX is text only, with no speculative decoding.");
    if (format !== "bf16" || languageOnly) plan.notes.push("Image requests need the bf16 checkpoint served without --language-model-only.");
    if (dflash && draft === "gguf" && format === "nvfp4") plan.warnings.push("The page verified the GGUF draft on B300 and pairs NVFP4 with --speculative-draft-model-quantization fp8 for the assistant draft; this mix is unverified.");
    if (dflash && draft === "gguf") plan.notes.push("Without --speculative-draft-model-quantization gguf, the GGUF draft is built unquantized from random weights: speculation runs, nothing errors, and the accept length stays at 1.0.");
    if (dflash && hw === "dgx") plan.notes.push("DFlash needs room for the draft, so DGX Spark drops to 0.65 for bf16 and 0.38 for NVFP4.");
    if (hw === "dgx") plan.notes.push("DGX Spark's 128 GB is shared with the OS and your clients: a discrete-GPU value around 0.85 runs the whole machine out of memory during load.");
    plan.notes.push("Every combination SGLang verified runs on a single accelerator; treat multi-GPU serving as untested.");
    plan.steps.push({ title: "Check tool calling", lang: "bash", code: TOOL_CHECK("http://localhost:30000/v1").replace('"tool_choice":"auto"}\'', '"tool_choice":"auto","temperature":1}\''), note: 'A working parser returns tool_calls with get_weather(city="Paris", units="celsius") and the thinking under reasoning_content.' });
    plan.steps.push({
      title: "Measure throughput",
      lang: "bash",
      code: command("python3 -m sglang.bench_serving", [
        "--backend sglang --host localhost --port 30000",
        "--model meta-models/Muse-Glimmer-30B",
        "--dataset-name random --random-input-len 1024 --random-output-len 512",
        "--num-prompts 128 --max-concurrency 64 --flush-cache",
      ]),
    });
    plan.client = glimmerClient("http://localhost:30000/v1", { maxTokens: 512, examplePrompt: "What is the capital of France?" });
    return plan;
  },
};

const llamacpp: RuntimeDef = {
  id: "llamacpp",
  label: "llama.cpp",
  group: "self-host",
  bestFor: "Local and mixed CPU and GPU inference, including laptops",
  anchor: "#llama-cpp",
  options: [
    {
      id: "file",
      label: "Text model",
      kind: "segmented",
      choices: [
        { value: "kquant17", label: "K-Quant-17GB (Q4_K_M)" },
        { value: "dynamic", label: "Dynamic (Q4_K_XL)" },
      ],
      default: "kquant17",
    },
    { id: "ctx", label: "Total context (-c)", kind: "number", default: 131072, min: 2048, max: 1_048_576, step: 1024 },
    { id: "np", label: "Slots (-np)", kind: "number", default: 1, min: 1, max: 64 },
    { id: "strength", label: "reasoning_strength", kind: "segmented", choices: STRENGTH_CHOICES, default: "low" },
    { id: "vision", label: "Vision projector (image input)", kind: "toggle", default: true },
    { id: "dflash", label: "DFlash speculative decoding (-md)", kind: "toggle", default: false },
    { id: "draftMax", label: "--spec-draft-n-max", kind: "number", default: 4, min: 1, max: 16, when: (v) => bool(v, "dflash") },
    { id: "apiKey", label: "Gate endpoints with --api-key", kind: "toggle", default: true },
    { id: "inline", label: "Keep thinking inline in content (--reasoning-format none)", kind: "toggle", default: false },
  ],
  build(v) {
    const plan = emptyPlan();
    const file = str(v, "file") === "dynamic" ? GGUF_FILES.dynamic : GGUF_FILES.kquant17;
    const ctx = Math.round(num(v, "ctx", 131072));
    const np = Math.max(1, Math.round(num(v, "np", 1)));
    const key = bool(v, "apiKey");
    const dflash = bool(v, "dflash");
    const inline = bool(v, "inline");
    plan.steps.push({ title: "Install (Linux; on macOS or Windows use the Llama app)", lang: "bash", code: "curl -LsSf https://llama.app/install.sh | sh", note: `Muse Glimmer needs llama.cpp ${GLIMMER.llamaCpp} or newer: older builds fail with unknown model architecture: 'muse-glimmer'.` });
    if (dflash) {
      plan.steps.push({
        title: "Download the DFlash draft",
        lang: "bash",
        code: ggufDraftDownload(),
      });
    }
    plan.steps.push({
      title: "Start the server",
      lang: "bash",
      code: command(`llama serve -hf ${GLIMMER_REPOS.gguf}`, [
        `--hf-file ${file.file}`,
        "-a muse-glimmer",
        `-ngl 99 -c ${ctx} -np ${np}`,
        `--host 127.0.0.1 --port 8080${key ? ' --api-key "$LLAMA_API_KEY"' : ""}`,
        !bool(v, "vision") && "--no-mmproj",
        dflash && `-md ${GGUF_FILES.dflash.file} --spec-type draft-dflash`,
        dflash && `-ngld 99 --spec-draft-n-max ${Math.round(num(v, "draftMax", 4))}`,
        inline && "--reasoning-format none",
        `--chat-template-kwargs '{"reasoning_strength":"${str(v, "strength", "low")}"}'`,
      ]),
    });
    const perSlot = Math.floor(ctx / np);
    plan.steps.push({
      title: "The startup log should report the slot size",
      lang: "text",
      code: `srv load_model: initializing, n_slots = ${np}, n_ctx_slot = ${perSlot}, kv_unified = 'false'`,
      note: "If it says exceeds the training context ... - capping, the GGUF's context_length metadata is stale. Fix it with: python gguf-py/gguf/scripts/gguf_set_metadata.py <model>.gguf muse-glimmer.context_length 131072",
    });
    plan.steps.push({
      title: "Smoke test",
      lang: "bash",
      code: `curl -s --noproxy '*' http://127.0.0.1:8080/v1/chat/completions \\\n  -H "Content-Type: application/json"${key ? ' -H "Authorization: Bearer $LLAMA_API_KEY"' : ""} \\\n  -d '{"model":"muse-glimmer","messages":[{"role":"user","content":"What is 17 * 23?"}]}'`,
    });
    plan.steps.push({ title: "Check tool calling", lang: "bash", code: TOOL_CHECK("http://127.0.0.1:8080/v1", key ? '-H "Authorization: Bearer $LLAMA_API_KEY"' : "") });
    plan.steps.push({
      title: "Or run once in the terminal, without the server",
      lang: "bash",
      code: `llama cli -hf ${GLIMMER_REPOS.gguf} \\\n  --hf-file ${file.file} \\\n  -ngl 99 -c 32768 -st`,
      note: "-st answers once and exits; without it llama cli waits on stdin, which reads as a hang. The CLI prints the thinking inline.",
    });
    plan.notes.push(`-c is the total context and -np divides it: ${n(ctx)} / ${np} = ${n(perSlot)} tokens per generation (n_ctx_slot).`);
    if (perSlot <= 32768) plan.warnings.push("Muse Glimmer reasons at length: one generation can approach a 32,768-token slot on its own, and running out of room fails quietly, with no answer and no error. Scale -c with -np instead.");
    if (ctx > 131072 && np === 1) plan.notes.push("The native context is 131,072 tokens; beyond that the server may cap the slot to the GGUF's trained context.");
    plan.notes.push("Use reasoning_strength through chat_template_kwargs: llama.cpp doesn't implement reasoning_effort. Reasoning can't be turned off; --reasoning-budget N hard-caps it.");
    if (!bool(v, "vision")) plan.notes.push("--no-mmproj skips the vision projector: text only.");
    if (dflash) plan.notes.push("A [spec] failed to measure draft model memory warning at startup is harmless.");
    if (key) plan.notes.push("--api-key guards the inference endpoints only; /health and /v1/models still answer without it.");
    plan.notes.push("Don't pass --chat-template-file: llama.cpp uses the template embedded in the GGUF, and detects it to pick the ATEM tool-call parser.");
    plan.client = glimmerClient("http://127.0.0.1:8080/v1", {
      keyEnv: key ? "LLAMA_API_KEY" : null,
      noProxy: true,
      examplePrompt: "What is 17 * 23?",
      reasoningFields: inline ? [] : ["reasoning_content"],
      notes: ['Per request: "chat_template_kwargs": {"reasoning_strength": "low"}. A request that hits max_tokens mid-thought returns empty content with finish_reason length.'],
    });
    return plan;
  },
};

const executorch: RuntimeDef = {
  id: "executorch",
  label: "ExecuTorch",
  group: "self-host",
  bestFor: "Ahead-of-time export for CUDA or Apple silicon",
  anchor: "#executorch",
  options: [
    {
      id: "source",
      label: "Program",
      kind: "segmented",
      choices: [
        { value: "prebuilt", label: "Download a prebuilt export" },
        { value: "export", label: "Export it yourself" },
      ],
      default: "prebuilt",
    },
    {
      id: "backend",
      label: "Backend",
      kind: "segmented",
      choices: [
        { value: "cuda", label: "CUDA (SM80 and newer)" },
        { value: "mlx", label: "Apple silicon" },
      ],
      default: "cuda",
    },
    {
      id: "quant",
      label: "Quantization",
      kind: "segmented",
      choices: [
        { value: "k-quant-17G", label: "k-quant-17G · 24 GB" },
        { value: "k-quant-dynamic", label: "k-quant-dynamic · 32 GB" },
      ],
      default: "k-quant-17G",
      when: (v) => str(v, "source") !== "export",
    },
    {
      id: "modality",
      label: "Modality",
      kind: "segmented",
      choices: [
        { value: "text", label: "Text" },
        { value: "text-image", label: "Text and image" },
      ],
      default: "text",
    },
    {
      id: "decoding",
      label: "Decoding",
      kind: "segmented",
      choices: [
        { value: "solo", label: "Solo" },
        { value: "dflash", label: "DFlash" },
      ],
      default: "solo",
    },
  ],
  build(v) {
    const plan = emptyPlan();
    const prebuilt = str(v, "source") !== "export";
    const cuda = str(v, "backend") !== "mlx";
    const vision = str(v, "modality") === "text-image";
    const dflash = str(v, "decoding") === "dflash";
    const worker = "cmake-out/examples/models/muse-glimmer/muse_glimmer_worker";
    const runner = {
      title: "Build the runner",
      lang: "bash" as const,
      code: `(cd examples/models/muse-glimmer && cmake --workflow --preset ${cuda ? "muse-glimmer-cuda" : "muse-glimmer-mlx"})`,
      note: "A .pte is a model program, not a runtime. The server needs muse_glimmer_worker from cmake-out/examples/models/muse-glimmer/.",
    };
    if (prebuilt) {
      const e = pteExport(str(v, "quant") as PteQuant, (vision ? "text-image" : "text") as PteModality, (dflash ? "dflash" : "solo") as PteDecoding, (cuda ? "sm80+ptx" : "metal") as PteBackend);
      plan.steps.push({
        title: `Download one export (${e.sizeGb} GB)`,
        lang: "bash",
        code: [
          `EXPORT_DIR=${e.dir}`,
          "",
          `hf download ${GLIMMER_REPOS.pte} \\`,
          '  --include "$EXPORT_DIR/*" \\',
          "  --include tokenizer.json --include tokenizer_config.json --include chat_template.jinja \\",
          "  --local-dir exports",
        ].join("\n"),
        note: "Download a single directory with --include: the repository holds 16 exports and is 372 GB.",
      });
      plan.steps.push(runner);
      plan.steps.push({
        title: "Serve the model",
        lang: "bash",
        code: command("python -m executorch.examples.models.muse_glimmer.serving.serve", [
          '--model-path "exports/$EXPORT_DIR/$EXPORT_DIR.pte"',
          cuda && '--data-path "exports/$EXPORT_DIR/$EXPORT_DIR.ptd"',
          vision && '--pos-embed-path "exports/$EXPORT_DIR/pos_embed.bin"',
          "--tokenizer-path exports/tokenizer.json",
          "--hf-tokenizer exports",
          `--worker-bin ${worker}`,
          "--model-id muse-glimmer-30B",
          "--tool-parser atem",
          "--host 127.0.0.1 --port 8000",
        ]),
        note: "A prebuilt directory names its artifacts after itself: there's no model.pte or aoti_cuda_blob.ptd in a download.",
      });
      if (cuda) plan.notes.push("On CUDA the weights live in the .ptd and the .pte is only tens of megabytes, so both files are required.");
    } else {
      plan.steps.push({
        title: "Download the GGUF checkpoints and the tokenizer metadata",
        lang: "bash",
        code: [
          `hf download ${GLIMMER_REPOS.gguf} --local-dir assets/quant \\`,
          `  --include '${GGUF_FILES.kquant17.file}' \\`,
          `  --include '${GGUF_FILES.dflash.file}' \\`,
          `  --include '${GGUF_FILES.mmproj.file}'`,
          "",
          `hf download ${GLIMMER_REPOS.bf16} \\`,
          "  tokenizer.json chat_template.jinja config.json processor_config.json \\",
          "  --local-dir assets/hf",
        ].join("\n"),
        note: "Keep chat_template.jinja beside the tokenizer metadata: the server renders prompts and tool definitions with it.",
      });
      plan.steps.push({
        title: "Set the paths",
        lang: "bash",
        code: [
          `TARGET=assets/quant/${GGUF_FILES.kquant17.file}`,
          `DRAFT=assets/quant/${GGUF_FILES.dflash.file}`,
          `MMPROJ=assets/quant/${GGUF_FILES.mmproj.file}`,
          `BACKEND=${cuda ? "cuda" : "mlx"}`,
        ].join("\n"),
      });
      const dir = dflash ? "exports/dflash" : "exports/solo";
      plan.steps.push({
        title: dflash ? "DFlash export (target and draft in one program)" : "Target-only export",
        lang: "bash",
        code: dflash
          ? command("python -m executorch.examples.models.muse_glimmer.export.export_dflash", ['--target-gguf "$TARGET"', '--draft-gguf "$DRAFT"', vision && '--mmproj "$MMPROJ"', '--backend "$BACKEND"', `--output-dir ${dir}`])
          : command("python -m executorch.examples.models.muse_glimmer.export.export_solo", ['--gguf "$TARGET"', vision && '--mmproj "$MMPROJ"', '--backend "$BACKEND"', `--output-dir ${dir}`]),
        note: cuda ? "A CUDA export autotunes Triton kernels on the GPU it runs on, so export on the architecture you'll serve from." : undefined,
      });
      plan.steps.push(runner);
      plan.steps.push({
        title: "Serve the model",
        lang: "bash",
        code: command("python -m executorch.examples.models.muse_glimmer.serving.serve", [
          `--model-path ${dir}/model.pte`,
          cuda && `--data-path ${dir}/aoti_cuda_blob.ptd`,
          vision && `--pos-embed-path ${dir}/pos_embed.bin`,
          "--tokenizer-path assets/hf/tokenizer.json",
          "--hf-tokenizer assets/hf",
          `--worker-bin ${worker}`,
          "--model-id muse-glimmer-30B",
          "--tool-parser atem",
          "--host 127.0.0.1 --port 8000",
        ]),
      });
      if (vision) plan.notes.push("A vision export also writes pos_embed.bin beside model.pte.");
    }
    if (dflash) plan.notes.push(`Block length is picked at serve time within the exported range: ${cuda ? "[2, 4] on CUDA, where the draft count is also capped at 3" : "[2, 16] on MLX"}.`);
    plan.notes.push("Limits: text and images only, one image per request; one request at a time (--num-runners must be 1); no prefix sharing across sessions. For concurrent throughput, serve with vLLM.");
    plan.warnings.push("The server rejects reasoning_effort and tool_choice=\"required\" with a 400. Control reasoning with the template's reasoning_strength; tool_choice none, auto or unset are fine.");
    plan.client = glimmerClient("http://127.0.0.1:8000/v1", { model: "muse-glimmer-30B", reasoningFields: [], maxTokens: 512, examplePrompt: "What is the capital of France?", notes: ["The page's example sends max_tokens 32; a reasoning model needs more room before it answers. --max-context bounds the window, and longer prompts get a 400."] });
    return plan;
  },
};

const transformers: RuntimeDef = {
  id: "transformers",
  label: "Transformers",
  group: "self-host",
  bestFor: "Learning the generation loop in plain Python",
  anchor: "#transformers",
  options: [{ id: "maxNewTokens", label: "max_new_tokens", kind: "number", default: 128, min: 16, step: 64 }],
  build(v) {
    const plan = emptyPlan();
    plan.steps.push({ title: "Install", lang: "bash", code: 'pip install "transformers>=5.15" accelerate torch', note: "Earlier versions lack the native Muse Glimmer path and prompt for trust_remote_code." });
    plan.steps.push({
      title: "Run the model",
      lang: "python",
      code: [
        "import torch",
        "from transformers import AutoTokenizer, AutoModelForCausalLM",
        "",
        'model_id = "meta-models/Muse-Glimmer-30B"',
        "tok = AutoTokenizer.from_pretrained(model_id)",
        'model = AutoModelForCausalLM.from_pretrained(model_id, dtype=torch.bfloat16, device_map="auto")',
        "",
        'messages = [{"role": "user", "content": "In one sentence, what is Muse Glimmer good at?"}]',
        "enc = tok.apply_chat_template(messages, add_generation_prompt=True,",
        '                              return_tensors="pt", return_dict=True).to(model.device)',
        `out = model.generate(**enc, max_new_tokens=${Math.round(num(v, "maxNewTokens", 128))}, do_sample=True, temperature=1.0, top_p=0.95,`,
        '                     eos_token_id=[tok.convert_tokens_to_ids("<|eot|>"),',
        '                                   tok.convert_tokens_to_ids("<|end_of_text|>")])',
        'print(tok.decode(out[0][enc["input_ids"].shape[-1]:], skip_special_tokens=True))',
      ].join("\n"),
    });
    plan.notes.push("The bf16 weights are about 60 GB, so device_map=\"auto\" spreads them across your GPUs. Never add <|eom|> to eos_token_id.");
    return plan;
  },
};

const ollama: RuntimeDef = {
  id: "ollama",
  label: "Ollama",
  group: "self-host",
  bestFor: "One command to a local model",
  anchor: "#ollama",
  options: [
    {
      id: "tag",
      label: "Engine",
      kind: "segmented",
      choices: [
        { value: "muse-glimmer", label: "Default" },
        { value: "muse-glimmer:30b-mlx", label: "MLX (Apple silicon)" },
      ],
      default: "muse-glimmer",
    },
    {
      id: "agent",
      label: "Coding agent",
      kind: "select",
      choices: [
        { value: "", label: "None" },
        { value: "claude", label: "claude" },
        { value: "pi", label: "pi" },
        { value: "opencode", label: "opencode" },
        { value: "hermes", label: "hermes" },
        { value: "openclaw", label: "openclaw" },
      ],
      default: "",
    },
  ],
  build(v) {
    const plan = emptyPlan();
    const tag = str(v, "tag", "muse-glimmer");
    plan.steps.push({ title: `Check the version (${GLIMMER.ollama} or later)`, lang: "bash", code: "ollama --version" });
    plan.steps.push({ title: "Run the model", lang: "bash", code: `ollama run ${tag}` });
    if (str(v, "agent")) plan.steps.push({ title: "Launch a coding agent on it", lang: "bash", code: `ollama launch ${str(v, "agent")} --model muse-glimmer` });
    plan.steps.push({
      title: "Native chat API (no key)",
      lang: "bash",
      code: [
        "curl http://localhost:11434/api/chat -d '{",
        `  "model": "${tag}",`,
        '  "stream": false,',
        '  "messages": [',
        '    {"role": "user", "content": "In one sentence, what is Muse Glimmer good at?"}',
        "  ]",
        "}'",
      ].join("\n"),
    });
    plan.notes.push("The Ollama library page lists every published tag. OpenAI clients use /v1 with ollama as a placeholder key.");
    plan.client = glimmerClient("http://localhost:11434/v1", { model: tag, keyPlaceholder: "ollama", reasoningFields: [], maxTokens: null, examplePrompt: "In one sentence, what is Muse Glimmer good at?" });
    return plan;
  },
};

const lmstudio: RuntimeDef = {
  id: "lmstudio",
  label: "LM Studio",
  group: "self-host",
  bestFor: "A desktop app with a built-in agent",
  anchor: "#lm-studio",
  options: [{ id: "port", label: "Port", kind: "number", default: 1234, min: 1, max: 65535 }],
  build(v) {
    const plan = emptyPlan();
    const port = Math.round(num(v, "port", 1234));
    plan.steps.push({
      title: "In LM Studio Bionic",
      lang: "text",
      code: [
        "1. Settings > Explore: select Muse Glimmer and download the recommended file for your hardware.",
        "2. Create a project. Turn on Allow Coding to let Bionic run commands in your folders.",
        "3. Pick Muse Glimmer in the model picker and give it a task.",
      ].join("\n"),
    });
    plan.steps.push({ title: "Start the local API server", lang: "bash", code: port === 1234 ? "lms server start" : `lms server start --port ${port}` });
    plan.notes.push("Query GET /v1/models and copy the exact model id: a different name returns model not found.");
    plan.notes.push("Q4_K_M measured about 24.1 GiB at one request and 16K context, so leave room for the OS and Bionic.");
    plan.client = glimmerClient(`http://localhost:${port}/v1`, { model: null, keyPlaceholder: "lm-studio", reasoningFields: [], maxTokens: null });
    return plan;
  },
};

const unsloth: RuntimeDef = {
  id: "unsloth",
  label: "Unsloth",
  group: "self-host",
  bestFor: "Local inference through a desktop app on macOS, Windows, Linux, and WSL",
  anchor: "#unsloth",
  options: [
    {
      id: "access",
      label: "Who can reach it",
      kind: "segmented",
      choices: [
        { value: "local", label: "This machine" },
        { value: "lan", label: "LAN (0.0.0.0)" },
        { value: "secure", label: "HTTPS tunnel" },
      ],
      default: "local",
    },
    { id: "port", label: "Port", kind: "number", default: 8888, min: 1, max: 65535 },
    { id: "agent", label: "Launch a coding agent with a Dynamic quant", kind: "toggle", default: false },
    { id: "quant", label: "Quant (:suffix)", kind: "text", default: "UD-Q4_K_XL", when: (v) => bool(v, "agent"), hint: "Dynamic quants from UD-IQ2_XXS through UD-Q8_K_XL." },
    { id: "ctx", label: "--context-length", kind: "number", default: 131072, min: 2048, step: 1024, when: (v) => bool(v, "agent") },
  ],
  build(v) {
    const plan = emptyPlan();
    const port = Math.round(num(v, "port", 8888));
    const access = str(v, "access", "local");
    plan.steps.push({ title: "Install (macOS, Linux, WSL)", lang: "bash", code: "curl -fsSL https://unsloth.ai/install.sh | sh", note: "Windows PowerShell: irm https://unsloth.ai/install.ps1 | iex" });
    plan.steps.push({
      title: "Start Unsloth Studio",
      lang: "bash",
      code: access === "lan" ? `unsloth studio -H 0.0.0.0 -p ${port}` : access === "secure" ? `unsloth studio --secure -p ${port}` : `unsloth studio -p ${port}`,
      note: "Then search for Muse Glimmer, download a build, and create an API key under Settings > API.",
    });
    if (bool(v, "agent")) {
      plan.steps.push({
        title: "Launch a coding agent",
        lang: "bash",
        code: `unsloth start claude \\\n  --model unsloth/Muse-Glimmer-30B-GGUF:${str(v, "quant", "UD-Q4_K_XL") || "UD-Q4_K_XL"} \\\n  --context-length ${Math.round(num(v, "ctx", 131072))}`,
        note: "If Unsloth isn't running, --model starts a temporary server that stops when the agent exits.",
      });
    }
    if (access !== "local") plan.warnings.push("Keep API keys private and review the enabled tools before you expose the server beyond localhost.");
    plan.notes.push("Check which stop tokens Unsloth applies before long agentic turns: stopping on <|eom|> truncates tool calling.");
    plan.client = glimmerClient(`http://localhost:${port}/v1`, { model: "default", keyEnv: "UNSLOTH_STUDIO_AUTH_TOKEN", reasoningFields: [], maxTokens: null, notes: ["Replace default with the id from /v1/models."] });
    return plan;
  },
};

const together: RuntimeDef = {
  id: "together",
  label: "Together AI",
  group: "hosted",
  bestFor: "A managed API: no weights, runtime or GPU to own",
  anchor: "#together-ai",
  options: [],
  build() {
    const plan = emptyPlan();
    plan.steps.push({
      title: "Export your key and check the model is visible",
      lang: "bash",
      code: [
        "export TOGETHER_API_KEY=...   # https://api.together.xyz/settings/api-keys",
        "",
        "curl -s https://api.together.xyz/v1/models \\",
        "  -H \"Authorization: Bearer $TOGETHER_API_KEY\" | grep -o 'meta-models/Muse-Glimmer-30B'",
      ].join("\n"),
    });
    plan.notes.push("Together publishes $0.35 per 1M input tokens ($0.04 cached) and $1.50 per 1M output, with a 128K+ context.");
    plan.notes.push("Generation is capped at 32,768 output tokens per request. Don't set temperature 0: greedy decoding loops on this model.");
    plan.client = {
      baseUrl: "https://api.together.xyz/v1",
      model: "meta-models/Muse-Glimmer-30B",
      keyEnv: "TOGETHER_API_KEY",
      keyPlaceholder: "",
      reasoningFields: [],
      extra: {},
      maxTokens: null,
      examplePrompt: "What are some fun things to do in New York?",
    };
    return plan;
  },
};

export const GLIMMER_RUNTIMES: RuntimeDef[] = [vllm, sglang, llamacpp, executorch, transformers, ollama, lmstudio, unsloth, together];

export function glimmerRuntime(id: string): RuntimeDef {
  return GLIMMER_RUNTIMES.find((r) => r.id === id) ?? vllm;
}

export function defaultGlimmerPlan(id: string): DeployPlan {
  const r = glimmerRuntime(id);
  return r.build(Object.fromEntries(r.options.map((o) => [o.id, o.default])) as Values);
}

/** The SGLang memory table, for the hardware page's calculator. */
export type { SglangFormat, SglangHardware };

/** A plan's text, for tests: every step's code joined. */
export function planText(plan: DeployPlan): string {
  return blocks(...plan.steps.map((s) => s.code));
}
