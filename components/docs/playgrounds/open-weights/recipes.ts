import { sparkTrlLaunch } from "@/components/docs/playgrounds/open-weights/training";

/**
 * The cookbook's two open-weight sections as browsable cards (cookbook/run-locally, cookbook/post-training): the
 * section's own recipes first, then the related step-by-step guides on the model pages, each with what it needs, how
 * long the page says it takes, and its first command, so a reader can filter by the machine or cluster they have.
 */

export interface RecipeCard {
  id: string;
  title: string;
  href: string;
  /** Listed on the cookbook section page itself, rather than a related guide. */
  inSection: boolean;
  model: "Muse Spark Open" | "Muse Glimmer";
  /** Filter tags. */
  tags: string[];
  needs: string;
  time?: string;
  what: string;
  command: string;
}

export interface RecipeCollection {
  id: "run-locally" | "post-training";
  filters: { id: string; label: string }[];
  cards: RecipeCard[];
}

export const RUN_LOCALLY: RecipeCollection = {
  id: "run-locally",
  filters: [
    { id: "all", label: "Everything" },
    { id: "mac", label: "Macs" },
    { id: "gpu", label: "One GPU" },
    { id: "cpu", label: "CPU only" },
    { id: "cluster", label: "GPU servers" },
  ],
  cards: [
    {
      id: "mac",
      title: "Muse Spark Open on Mac",
      href: "/docs/cookbook/muse-spark-open-mac",
      inSection: true,
      model: "Muse Spark Open",
      tags: ["mac"],
      needs: "Two Mac Studios (M5 Ultra, 512 GB) or four (256 GB), macOS 26.2+, Thunderbolt 5 between every pair",
      time: "About 4 hours",
      what: "mlx.launch starts mlx-lm on every Mac over SSH; the Macs share the NVFP4 model over RDMA with MLX's jaccl backend.",
      command: "mlx.launch --hostfile hostfile.json --backend jaccl --env MLX_METAL_FAST_SYNCH=1 -- \\\n  mlx_lm.server --model meta-models/Muse-Spark-Open-816B-A42B-NVFP4 --port 8080",
    },
    {
      id: "glimmer-llama",
      title: "Muse Glimmer with llama.cpp",
      href: "/docs/muse-glimmer/deploy#llama-cpp",
      inSection: false,
      model: "Muse Glimmer",
      tags: ["gpu", "mac", "cpu"],
      needs: "About 19 GiB for the 17 GB GGUF with images at 131K context: a 24 GB card, a Mac, or CPU and RAM",
      what: "Serves the published GGUF with the vision projector, ATEM tool calls and optional DFlash, on Metal, CUDA, ROCm, Vulkan or CPU.",
      command: "llama serve -hf meta-models/Muse-Glimmer-30B-GGUF \\\n  --hf-file Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf \\\n  -a muse-glimmer \\\n  -ngl 99 -c 131072 -np 1 \\\n  --host 127.0.0.1 --port 8080",
    },
    {
      id: "glimmer-ollama",
      title: "Muse Glimmer with Ollama",
      href: "/docs/muse-glimmer/deploy#ollama",
      inSection: false,
      model: "Muse Glimmer",
      tags: ["gpu", "mac"],
      needs: "Ollama 0.32.7 or later",
      what: "One command to a local model, with an MLX engine on Apple silicon and ollama launch for coding agents.",
      command: "ollama run muse-glimmer\n# on Apple silicon:\nollama run muse-glimmer:30b-mlx",
    },
    {
      id: "glimmer-sglang-mlx",
      title: "Muse Glimmer on SGLang's MLX backend",
      href: "/docs/muse-glimmer/deploy#sglang",
      inSection: false,
      model: "Muse Glimmer",
      tags: ["mac"],
      needs: "Apple silicon with 48 GB or more of unified memory",
      what: "Text only, with the radix cache off for the sliding-window layers and an 8 GB MLX cache limit.",
      command: "SGLANG_USE_MLX=1 SGLANG_MLX_CACHE_LIMIT_GB=8 \\\nsglang serve \\\n  --model-path RadixArk/Muse-Glimmer-q4km-gs128-MLX \\\n  --served-model-name muse-glimmer \\\n  --trust-remote-code \\\n  --reasoning-parser muse \\\n  --tool-call-parser muse \\\n  --disable-radix-cache \\\n  --mem-fraction-static 0.85 \\\n  --host 0.0.0.0 --port 30000",
    },
    {
      id: "glimmer-vllm",
      title: "Muse Glimmer with vLLM",
      href: "/docs/muse-glimmer/deploy#vllm",
      inSection: false,
      model: "Muse Glimmer",
      tags: ["gpu", "cluster"],
      needs: "72 GB of VRAM for the bf16 weights, on one card or several",
      what: "Production serving with continuous batching, the muse_glimmer tool-call and reasoning parsers, and the published sampling.",
      command: "docker run --rm --gpus all --ipc=host \\\n  -p 8000:8000 \\\n  -v ~/.cache/huggingface:/root/.cache/huggingface \\\n  vllm/vllm-openai:muse-glimmer \\\n  meta-models/Muse-Glimmer-30B \\\n  --served-model-name muse-glimmer \\\n  --tensor-parallel-size 1 \\\n  --enable-auto-tool-choice \\\n  --tool-call-parser muse_glimmer \\\n  --reasoning-parser muse_glimmer \\\n  --generation-config auto",
    },
    {
      id: "glimmer-xeon",
      title: "Muse Glimmer on a Xeon 6, CPU only",
      href: "/docs/muse-glimmer/hardware-platforms#intel-xeon-6",
      inSection: false,
      model: "Muse Glimmer",
      tags: ["cpu", "cluster"],
      needs: "Intel Xeon 6 6980P, more than 512 GB of DDR5 suggested",
      what: "Intel's verified bf16 path on vLLM's CPU container.",
      command: 'vllm serve ./muse-glimmer-bf16 \\\n    --served-model-name muse-glimmer \\\n    -tp "<TP_SIZE>" \\\n    --dtype=bfloat16 \\\n    --trust-remote-code --enable-auto-tool-choice \\\n    --tool-call-parser muse_glimmer \\\n    --reasoning-parser muse_glimmer \\\n    --generation-config auto',
    },
    {
      id: "spark-sglang",
      title: "Muse Spark Open with SGLang",
      href: "/docs/muse-spark-open/deploy#sglang",
      inSection: false,
      model: "Muse Spark Open",
      tags: ["cluster"],
      needs: "NVFP4 on 4 × B300, or BF16 on 8 × B300",
      what: "High-throughput serving with DFlash2 speculative decoding, HiCache and MegaMoE prefill.",
      command: "sglang serve \\\n  --model-path meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \\\n  --tp-size 4 \\\n  --ep-size 4 \\\n  --quantization modelopt_fp4 \\\n  --moe-runner-backend flashinfer_trtllm \\\n  --mem-fraction-static 0.8 \\\n  --host 0.0.0.0 \\\n  --port 30000 \\\n  --reasoning-parser muse \\\n  --tool-call-parser muse",
    },
    {
      id: "spark-unsloth",
      title: "Muse Spark Open with Unsloth",
      href: "/docs/muse-spark-open/deploy#unsloth",
      inSection: false,
      model: "Muse Spark Open",
      tags: ["cpu", "mac", "cluster"],
      needs: "300 to 315 GB of RAM plus VRAM (or unified memory) for the Dynamic 2-bit GGUF",
      what: "A desktop app and CLI on macOS, Windows, Linux and WSL, with an authenticated API and coding-agent launchers.",
      command: "unsloth run \\\n  --model unsloth/Muse-Spark-Open-816B-A42B-GGUF:UD-Q2_K_XL \\\n  -H 127.0.0.1 \\\n  -p 8888 \\\n  --context-length 32768 \\\n  --temperature 1.0 \\\n  --top-p 1.0 \\\n  --min-p 0.0 \\\n  --reasoning-effort medium",
    },
  ],
};

export const POST_TRAINING: RecipeCollection = {
  id: "post-training",
  filters: [
    { id: "all", label: "Everything" },
    { id: "sft", label: "SFT" },
    { id: "rl", label: "RL" },
    { id: "small", label: "1 to 8 GPUs" },
    { id: "large", label: "64+ GPUs" },
    { id: "hosted", label: "Hosted" },
  ],
  cards: [
    {
      id: "torchtitan-rl",
      title: "RL with TorchTitan",
      href: "/docs/cookbook/muse-spark-open-torchtitan-rl",
      inSection: true,
      model: "Muse Spark Open",
      tags: ["rl", "large"],
      needs: "256 trainer GPUs plus 16 generator GPUs for the published recipe",
      what: "GRPO with the DAPO loss on a task you plug in (dataset, env, reward), starting from DAPO-Math's five-step bring-up.",
      command: "python -m torchtitan.rl.train --module rl --config muse_spark_dapo_math",
    },
    {
      id: "torchtitan-sft",
      title: "SFT with TorchTitan",
      href: "/docs/cookbook/muse-spark-open-torchtitan-sft",
      inSection: true,
      model: "Muse Spark Open",
      tags: ["sft", "large", "small"],
      needs: "One GPU for the debug smoke test; 128 GPUs for the 816B recipe",
      what: "Full-parameter SFT on your own text, image and audio conversations; only the assistant's replies carry loss.",
      command: "NGPU=1 MODULE=sft CONFIG=muse_spark_debugmodel_sft ./run_train.sh",
    },
    {
      id: "miles",
      title: "GRPO with Miles",
      href: "/docs/muse-spark-open/post-training#miles",
      inSection: false,
      model: "Muse Spark Open",
      tags: ["rl", "large"],
      needs: "8 nodes of 8 H200 on InfiniBand",
      what: "Math reasoning on DAPO-Math-17k, or image-grounded math on Geometry3K with --vlm, with SGLang rollouts.",
      command: "MILES_SCRIPT_EXTERNAL_RAY=1 python scripts/run_muse_spark_64xh200.py",
    },
    {
      id: "trl-spark",
      title: "LoRA SFT with TRL",
      href: "/docs/muse-spark-open/post-training#trl",
      inSection: false,
      model: "Muse Spark Open",
      tags: ["sft", "large"],
      needs: "8 nodes of 8 H100 (14.2 s a step, 40.2 GB per GPU)",
      what: "SFTTrainer shards the model at load time (fsdp_size 64, ep_size 8) and trains a 194 MB LoRA adapter.",
      // The whole Slurm script: sbatch needs its #!/bin/bash line, and the rendezvous needs the MASTER_IP it sets.
      command: sparkTrlLaunch(),
    },
    {
      id: "fireworks",
      title: "Serverless LoRA on Fireworks",
      href: "/docs/muse-spark-open/post-training#fireworks-ai",
      inSection: false,
      model: "Muse Spark Open",
      tags: ["sft", "rl", "hosted"],
      needs: "A Fireworks account; no GPUs to reserve",
      what: "SFT, DPO, ORPO, distillation and RL with LoRA up to rank 64 and sequences up to 262,144 tokens.",
      command: 'pip install "fireworks-ai[training]"',
    },
    {
      id: "together",
      title: "SFT and GRPO on Together AI",
      href: "/docs/muse-spark-open/post-training#together-ai",
      inSection: false,
      model: "Muse Spark Open",
      tags: ["sft", "rl", "hosted"],
      needs: "A Together AI account with credit (preview)",
      what: "Ready-made recipes from Together's post-training cookbook, with meta-models/Muse-Spark-Open-816B-A42B as the base.",
      command: "git clone https://github.com/togethercomputer/post-training-cookbook",
    },
    {
      id: "axolotl",
      title: "QLoRA, LoRA or full SFT with Axolotl",
      href: "/docs/muse-glimmer/post-training#axolotl",
      inSection: false,
      model: "Muse Glimmer",
      tags: ["sft", "small"],
      needs: "8 × H100 for every method; QLoRA also on 1 × H100",
      what: "Text, single-image and multi-image demonstrations; QLoRA first, full-parameter FSDP2 only when adapters fall short.",
      command: "axolotl train configs/muse-glimmer-30b-qlora.yaml \\\n  --max-steps 2 --gradient-accumulation-steps 1 \\\n  --eval-strategy no --save-strategy steps --save-steps 2 \\\n  --launcher torchrun -- --nproc_per_node=8 --nnodes=1",
    },
    {
      id: "titanrl",
      title: "Data-analyst RL with TitanRL",
      href: "/docs/muse-glimmer/post-training#titanrl",
      inSection: false,
      model: "Muse Glimmer",
      tags: ["rl", "small"],
      needs: "8 × H100 95 GB, one node (about 30 minutes for the smoke config)",
      what: "GRPO with a graded, deterministic reward: compute a number from a CSV or log and write it to answer.json with a bash tool.",
      command: "python -m torchtitan.rl.train \\\n  --module torchtitan.rl.examples.glimmer_data_analyst \\\n  --config rl_grpo_muse_glimmer_30b_data_analyst_smoke \\\n  --dump-folder outputs/rl/glimmer_data_analyst_smoke",
    },
    {
      id: "trl-glimmer",
      title: "LoRA, DPO and GRPO with TRL",
      href: "/docs/muse-glimmer/post-training#trl-sft",
      inSection: false,
      model: "Muse Glimmer",
      tags: ["sft", "rl", "small"],
      needs: "GPUs for a 30B model with device_map=\"auto\" (QLoRA needs the least)",
      what: "PEFT adapters on your own examples, preference pairs with DPO, or a programmatic reward with GRPO.",
      command: "pip install trl peft",
    },
  ],
};

export function collectionFor(id: string): RecipeCollection {
  return id === "post-training" ? POST_TRAINING : RUN_LOCALLY;
}

export function filterCards(c: RecipeCollection, filter: string, model: "all" | RecipeCard["model"] = "all"): RecipeCard[] {
  return c.cards.filter((card) => (filter === "all" || card.tags.includes(filter)) && (model === "all" || card.model === model));
}
