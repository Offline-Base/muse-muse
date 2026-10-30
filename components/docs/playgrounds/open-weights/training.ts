import type { CodeStep } from "@/components/docs/playgrounds/open-weights/deploy";
import { n } from "@/components/docs/playgrounds/open-weights/facts";
import { ANALYST_TIERS, type AnalystTiers } from "@/components/docs/playgrounds/open-weights/rewards";

/**
 * Training configs from the post-training pages, as builders: TRL's SFTTrainer on Muse Spark Open (fsdp_size and
 * ep_size, LoRA, Slurm), Miles' GRPO recipe, Fireworks' serverless LoRA, Axolotl's three Muse Glimmer configs, TRL's
 * LoRA, QLoRA, DPO and GRPO on Muse Glimmer, TitanRL's data-analyst recipe, and the TorchTitan cookbook recipes.
 * Each builder writes the page's code with the reader's numbers and checks them against the page's own guidance.
 */

export interface TrainingPlan {
  steps: CodeStep[];
  notes: string[];
  warnings: string[];
  errors: string[];
  /** One line for the status region: tokens per step, memory per GPU, storage. */
  summary: string;
}

function plan(): TrainingPlan {
  return { steps: [], notes: [], warnings: [], errors: [], summary: "" };
}

function sci(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return String(x);
  const exp = Math.floor(Math.log10(x));
  const mant = Math.round((x / 10 ** exp) * 100) / 100;
  return `${mant}e${exp}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Muse Spark Open: TRL SFT with LoRA (muse-spark-open/post-training, "TRL")

export interface SparkTrlOptions {
  nodes: number;
  gpusPerNode: number;
  epSize: number;
  maxSteps: number;
  maxLength: number;
  rank: number;
  alpha: number;
  saveSteps: number;
  dataset: "tulu" | "local";
}

export const SPARK_TRL_DEFAULTS: SparkTrlOptions = { nodes: 8, gpusPerNode: 8, epSize: 8, maxSteps: 500, maxLength: 2048, rank: 16, alpha: 32, saveSteps: 50, dataset: "tulu" };

/**
 * The page's Slurm script for the TRL run, whole: sbatch needs the #!/bin/bash line, and torchrun's rendezvous needs
 * MASTER_IP, which the script reads from the first node. The builder, the copy prompt and the cookbook card share it.
 */
export function sparkTrlLaunch(nodes = SPARK_TRL_DEFAULTS.nodes, gpusPerNode = SPARK_TRL_DEFAULTS.gpusPerNode): string {
  return [
    "#!/bin/bash",
    `#SBATCH --nodes=${nodes}`,
    `#SBATCH --gres=gpu:${gpusPerNode}`,
    "#SBATCH --ntasks-per-node=1",
    "#SBATCH --mem=0",
    "",
    'MASTER=$(scontrol show hostnames "$SLURM_JOB_NODELIST" | head -1)',
    "MASTER_IP=$(getent ahostsv4 \"$MASTER\" | awk 'NR==1{print $1}')",
    "",
    "srun torchrun \\",
    '    --nnodes "$SLURM_NNODES" \\',
    `    --nproc_per_node ${gpusPerNode} \\`,
    "    --rdzv_backend c10d \\",
    '    --rdzv_endpoint "$MASTER_IP:29700" \\',
    "    sft_muse_spark_open.py",
  ].join("\n");
}

export function sparkTrl(o: SparkTrlOptions): TrainingPlan {
  const p = plan();
  const world = o.nodes * o.gpusPerNode;
  if (world % o.epSize !== 0) p.errors.push(`ep_size ${o.epSize} must divide the ${world} GPUs the model is sharded over, so the experts split into equal groups of ranks.`);
  if (o.alpha !== o.rank * 2) p.notes.push(`The recipe pairs r=16 with lora_alpha=32 (twice the rank); this config uses ${o.alpha} for r=${o.rank}.`);
  p.steps.push({ title: "Install", lang: "bash", code: 'pip install trl peft "transformers>=5.19"' });
  const data =
    o.dataset === "tulu"
      ? 'train_dataset = load_dataset("allenai/tulu-3-sft-mixture", split="train[:500000]")'
      : 'train_dataset = load_dataset("json", data_files="train.jsonl", split="train")';
  p.steps.push({
    title: "sft_muse_spark_open.py",
    lang: "python",
    code: [
      "from datasets import load_dataset",
      "from peft import LoraConfig",
      "from transformers.distributed import DistributedConfig",
      "",
      "from trl import SFTConfig, SFTTrainer",
      "",
      data,
      "",
      "training_args = SFTConfig(",
      '    output_dir="muse-spark-open-sft",',
      "    model_init_kwargs={",
      '        "dtype": "auto",  # keep the checkpoint\'s bf16 weights',
      `        "distributed_config": DistributedConfig(fsdp_size=${world}, ep_size=${o.epSize}),  # shard over ${world} GPUs, experts split ${o.epSize} ways`,
      "    },",
      "    per_device_train_batch_size=1,",
      `    max_steps=${o.maxSteps},`,
      `    max_length=${o.maxLength},`,
      "    dataset_num_proc=32,",
      "    packing=True,  # packs several examples per sequence so almost no token is padding",
      "    logging_steps=1,",
      "    save_only_model=True,  # required: the optimizer state of a model sharded at load time cannot be checkpointed",
      `    save_steps=${o.saveSteps},`,
      ")",
      "trainer = SFTTrainer(",
      '    model="meta-models/Muse-Spark-Open-816B-A42B",',
      "    args=training_args,",
      "    train_dataset=train_dataset,",
      `    peft_config=LoraConfig(r=${o.rank}, lora_alpha=${o.alpha}, target_modules=["q_proj", "k_proj", "v_proj", "o_proj"]),`,
      ")",
      "trainer.train()",
    ].join("\n"),
  });
  p.steps.push({
    title: `Launch with torchrun on ${o.nodes} node${o.nodes === 1 ? "" : "s"} (Slurm)`,
    lang: "bash",
    code: sparkTrlLaunch(o.nodes, o.gpusPerNode),
  });
  const tokens = world * o.maxLength;
  p.notes.push("fsdp_size is the number of GPUs the model is sharded over and ep_size the number of groups the experts are split into; the model's expert plan selects token dispatch.");
  p.notes.push(`On 64 H100s the page's recipe runs 14.2 s a step with 131k tokens per step and 40.2 GB per GPU, writing the 194 MB adapter every 50 steps.`);
  if (o.maxLength > 2048) p.notes.push("max_length 2048 fits 96% of Tulu 3 conversations; longer ones are truncated. A longer limit needs more memory per GPU.");
  p.notes.push("To use it, load the base model sharded with DistributedConfig and attach the adapter with PeftModel.from_pretrained, launched with torchrun the same way.");
  p.summary = `${world} GPUs, ${n(tokens)} tokens per step (${world} × 1 × ${n(o.maxLength)}), ${n(o.maxSteps)} steps, ${Math.floor(o.maxSteps / Math.max(1, o.saveSteps))} adapter saves of about 194 MB.`;
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Muse Spark Open: Miles GRPO (muse-spark-open/post-training, "Miles")

export interface MilesOptions {
  mode: "math" | "vlm";
  dynamicFilter: boolean;
  effort: "low" | "medium" | "high" | "xhigh";
  evalInterval: number;
  saveInterval: number;
  runId: string;
  customData: boolean;
  dataPath: string;
  optimizer: "adam" | "muon";
}

export const MILES_DEFAULTS: MilesOptions = { mode: "math", dynamicFilter: false, effort: "xhigh", evalInterval: 0, saveInterval: 0, runId: "muse-dapo", customData: false, dataPath: "/root/datasets/train.jsonl", optimizer: "adam" };

export function milesPlan(o: MilesOptions): TrainingPlan {
  const p = plan();
  p.steps.push({
    title: "1. Start the container on every node",
    lang: "bash",
    code: [
      "docker run -d --name miles --gpus all --network host --ipc host --shm-size 512g \\",
      "  --ulimit memlock=-1 --ulimit stack=67108864 --device /dev/infiniband \\",
      "  -v /path/to/shared/models:/root/models \\",
      "  -v /path/to/shared/datasets:/root/datasets \\",
      "  -v /path/to/shared/outputs:/root/shared_data \\",
      "  -v /path/to/local/nvme:/scratch \\",
      "  radixark/miles:muse-spark-open sleep infinity",
      "docker exec -it miles bash",
    ].join("\n"),
  });
  p.steps.push({
    title: "2. One Ray cluster across the 8 nodes",
    lang: "bash",
    code: ["# On node 0:", "ray start --head --port 6379 --num-gpus 8", "", "# On nodes 1 to 7:", "ray start --address <node-0-address>:6379 --num-gpus 8", "", "# Then check that it reports 64 GPUs:", "ray status"].join("\n"),
  });
  const args = [
    o.mode === "vlm" && "--vlm",
    (o.dynamicFilter || o.mode === "vlm") && "--use-dynamic-sampling-filter",
    o.effort !== "xhigh" && `--reasoning-effort ${o.effort}`,
    o.evalInterval > 0 && `--eval-interval ${o.evalInterval}`,
    o.saveInterval > 0 && `--save-interval ${o.saveInterval} --run-id ${o.runId || "muse-dapo"}`,
    o.optimizer === "muon" && "--optimizer muon",
    o.customData && `--extra-args "--prompt-data ${o.dataPath}"`,
  ].filter((a): a is string => typeof a === "string");
  p.steps.push({
    title: "3. Train, on node 0 from /root/miles",
    lang: "bash",
    code: args.length ? `MILES_SCRIPT_EXTERNAL_RAY=1 python scripts/run_muse_spark_64xh200.py \\\n  ${args.join(" ")}` : "MILES_SCRIPT_EXTERNAL_RAY=1 python scripts/run_muse_spark_64xh200.py",
    note: "Export WANDB_API_KEY first to log to Weights & Biases. All options: python scripts/run_muse_spark_64xh200.py --help",
  });
  if (o.saveInterval > 0) {
    const run = o.runId || "muse-dapo";
    const step = o.saveInterval;
    p.steps.push({
      title: `4. Convert the save after step ${step} to a Hugging Face checkpoint`,
      lang: "bash",
      code: [
        "python tools/convert_muse_spark_torch_dist_to_hf.py \\",
        `  --input-dir /root/shared_data/${run}/checkpoints/iter_${String(step - 1).padStart(7, "0")} \\`,
        "  --hf-checkpoint /root/models/Muse-Spark-Open-816B-A42B \\",
        `  --output-dir /root/shared_data/${run}/hf-step-${step}`,
      ].join("\n"),
      note: "Save directories count steps from 0, so the save after step 10 is iter_0000009. The recipe converts the last save itself, into /root/shared_data/<run>/hf.",
    });
    p.notes.push("Each save and each conversion takes about 1.6 TB on the shared storage.");
  }
  if (o.mode === "vlm") {
    p.notes.push("Geometry3K diagrams and questions. The vision tower and its projection stay frozen; only the language model trains. The dynamic sampling filter discards prompts whose samples all get the same reward and keeps sampling until 32 prompts remain, so rollouts take 8 to 14 minutes.");
    if (o.evalInterval > 0) p.notes.push(`--eval-interval ${o.evalInterval} scores the Geometry3K test split (601 problems, 4 samples each) before training, every ${o.evalInterval} steps and after the last.`);
    if (o.effort === "xhigh") p.warnings.push("The image-grounded runs used --reasoning-effort medium to keep responses short.");
  }
  if (o.customData) p.notes.push(`Rows for ${o.mode === "vlm" ? "--vlm: messages (one <image> per image), images and label" : "math: prompt (a string or chat messages) and label"}. The reward is 1 when the final \\boxed{} answer matches label.`);
  p.notes.push("Needs 8 nodes of 8 H200 on InfiniBand, about 1.6 TB each for the BF16 checkpoint and its Megatron copy on shared storage, and about 1.2 TB free on each node's /scratch for Adam state.");
  p.notes.push("Healthy runs: train/train_rollout_logprob_abs_diff near 0.007 (math) or 0.013 (image); reward about 0.65 to 0.75 at first, 0.8 to 0.95 within 10 steps for math.");
  p.summary = `GRPO on 64 H200: 32 prompts × 16 samples per step, 4,096-token responses in an 8,192-token context; ${o.mode === "vlm" ? "rollouts 8 to 14 min" : "rollouts 2 to 5.5 min"}, training ${o.mode === "vlm" ? "about 5 min" : "3 to 5.5 min"}, weight sync about 50 s per step.`;
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Muse Spark Open: Fireworks serverless LoRA

export interface FireworksOptions {
  rank: number;
  outputModelId: string;
  samplerName: string;
}

export const FIREWORKS_DEFAULTS: FireworksOptions = { rank: 64, outputModelId: "muse-spark-my-lora", samplerName: "final" };

export function fireworksPlan(o: FireworksOptions): TrainingPlan {
  const p = plan();
  if (!Number.isInteger(o.rank) || o.rank < 1 || o.rank > 64) p.errors.push("rank can be any positive integer up to 64 on the serverless pool.");
  if (!/^[a-z0-9-]{1,63}$/.test(o.outputModelId)) p.errors.push("output_model_id is 1 to 63 characters: lowercase letters, digits and hyphens.");
  if (!o.samplerName || o.samplerName.length > 17) p.errors.push("Keep the name passed to save_weights_for_sampler at 17 characters or fewer.");
  p.steps.push({ title: "Install the training SDK and export the key", lang: "bash", code: 'pip install "fireworks-ai[training]"\nexport FIREWORKS_API_KEY="fw_..."' });
  p.steps.push({
    title: "Attach to the serverless pool",
    lang: "python",
    code: [
      "import os",
      "from fireworks.training.sdk import FiretitanServiceClient",
      "",
      "service = FiretitanServiceClient(",
      '    api_key=os.environ["FIREWORKS_API_KEY"],',
      '    base_url="https://api.fireworks.ai/training/v1/serverless",',
      ")",
      "",
      'base_model = "accounts/fireworks/models/muse-spark-open-nvfp4"',
      "training_client = service.create_lora_training_client(",
      "    base_model=base_model,",
      `    rank=${o.rank},`,
      ")",
      'print(f"session={service.training_session_id} run={training_client.run_id}")',
    ].join("\n"),
    note: "A session id that starts with ts- means the client attached to the pool.",
  });
  p.steps.push({
    title: "Run the serverless RL example",
    lang: "bash",
    code: [
      "git clone https://github.com/fw-ai/cookbook",
      "cd cookbook/training",
      "pip install -e .",
      'export FIREWORKS_API_KEY="fw_..."',
      "python -m examples.serverless_rl.countdown_rl \\",
      "  --base-model accounts/fireworks/models/muse-spark-open-nvfp4 \\",
      "  --tokenizer-model meta-models/Muse-Spark-Open-816B-A42B-NVFP4",
    ].join("\n"),
  });
  p.steps.push({
    title: "Sample the adapter, then promote it to serve after the session",
    lang: "python",
    code: [
      "from transformers import AutoTokenizer",
      "",
      'tokenizer = AutoTokenizer.from_pretrained("meta-models/Muse-Spark-Open-816B-A42B-NVFP4")',
      `snapshot = training_client.save_weights_for_sampler(${JSON.stringify(o.samplerName)}).result().path`,
      "sampler = service.create_sampling_client(model_path=snapshot, tokenizer=tokenizer)",
      "",
      "# Before the session is deleted:",
      "import os",
      "from datetime import datetime",
      "from fireworks.training.sdk import FireworksClient",
      "",
      'fw = FireworksClient(api_key=os.environ["FIREWORKS_API_KEY"])',
      "rows = fw.list_training_session_checkpoints(service.training_session_name)",
      "target = max(",
      '    (row for row in rows if row.get("promotable")),',
      '    key=lambda row: datetime.fromisoformat(row["createTime"].replace("Z", "+00:00")),',
      ")",
      "model = fw.promote_session_checkpoint(",
      '    name=target["name"],',
      `    output_model_id=${JSON.stringify(o.outputModelId)},`,
      '    base_model="accounts/fireworks/models/muse-spark-open-nvfp4",',
      ")",
    ].join("\n"),
  });
  p.notes.push("Each optimizer step is forward_backward(...).result() then optim_step(...).result(): call .result() on every remote operation so failures aren't dropped.");
  p.notes.push("save_state writes a training checkpoint (adapter and optimizer state, for resume); save_weights_for_sampler writes a sampler checkpoint (adapter only, for sampling and deployment). Neither does the other's job.");
  p.notes.push("Keep every rendered example at or under 262,144 tokens, and load the tokenizer from meta-models/Muse-Spark-Open-816B-A42B-NVFP4 so it matches the base model.");
  p.summary = `Serverless LoRA, rank ${o.rank} (up to 64), sequences up to 262,144 tokens; the promoted model deploys as accounts/<account-id>/models/${o.outputModelId}.`;
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Muse Glimmer: memory for full-parameter training (muse-glimmer/post-training, "Size the hardware")

export function fullParamMemory(shards: number): { weights: number; grads: number; adam: number; total: number } {
  const s = Math.max(1, shards);
  return { weights: 60 / s, grads: 60 / s, adam: 240 / s, total: 360 / s };
}

// ---------------------------------------------------------------------------------------------------------------
// Muse Glimmer: Axolotl

export type AxolotlConfig = "qlora" | "lora-fsdp2" | "full-fsdp2";

export interface AxolotlOptions {
  config: AxolotlConfig;
  gpus: number;
  smoke: boolean;
  dataset: "cosyn-circuit" | "tulu" | "docmatix";
  smokeData: boolean;
}

export const AXOLOTL_DEFAULTS: AxolotlOptions = { config: "qlora", gpus: 8, smoke: true, dataset: "cosyn-circuit", smokeData: false };

const AXOLOTL_FILE: Record<AxolotlConfig, string> = {
  qlora: "configs/muse-glimmer-30b-qlora.yaml",
  "lora-fsdp2": "configs/muse-glimmer-30b-lora-fsdp2.yaml",
  "full-fsdp2": "configs/muse-glimmer-30b-full-fsdp2.yaml",
};

export function axolotlPlan(o: AxolotlOptions): TrainingPlan {
  const p = plan();
  if (o.config !== "qlora" && o.gpus < 8) p.warnings.push("The page verified the FSDP2 configs on 8 × H100; only QLoRA was also verified on a single H100.");
  if (o.gpus < 1) p.errors.push("Pick at least one GPU.");
  p.steps.push({
    title: "Install, in a dedicated environment (from post-training/sft/axolotl/)",
    lang: "bash",
    code: [
      "uv venv --python 3.12 .venv",
      "source .venv/bin/activate",
      "",
      "export UV_TORCH_BACKEND=cu130",
      'uv pip install "torch==2.12.1" "torchvision==0.27.1"',
      'uv pip install "axolotl==0.19.0"',
      'uv pip install "pytest==9.1.1" "matplotlib==3.11.2"',
      "",
      "CUDA_HOME=/usr/local/cuda-13.0 \\",
      "CC=/usr/bin/gcc \\",
      "CXX=/usr/bin/g++ \\",
      "TORCH_CUDA_ARCH_LIST=9.0 \\",
      '  uv pip install --no-build-isolation "flash-attn==2.8.3"',
      "",
      "CCE_REPOSITORY=https://github.com/axolotl-ai-cloud/ml-cross-entropy.git",
      "CCE_REVISION=4dfa52212d0552805aec5a6a2176c0abbea277d2",
      "CUDA_HOME=/usr/local/cuda-13.0 \\",
      "CC=/usr/bin/gcc \\",
      "CXX=/usr/bin/g++ \\",
      "TORCH_CUDA_ARCH_LIST=9.0 \\",
      "  uv pip install --no-build-isolation \\",
      '  "cut-cross-entropy[transformers] @ git+${CCE_REPOSITORY}@${CCE_REVISION}"',
      "",
      "uv pip check",
      "pytest -q tests",
    ].join("\n"),
    note: "Don't install the deepspeed extra: the configs use FSDP2, and deepspeed-kernels has no Python 3.12 wheel.",
  });
  p.steps.push({
    title: "Prepare the data",
    lang: "bash",
    code: [
      `python scripts/prepare_dataset.py ${o.dataset} \\`,
      "  --tokenizer-model meta-models/Muse-Glimmer-30B \\",
      "  --tokenizer-revision a4e59da52a7bc87ae7251dd5545c0dd437c44b68 \\",
      `  --max-tokens 4096${o.smokeData ? " \\\n  --max-examples-per-split 16 --output-root data/smoke" : ""}`,
    ].join("\n"),
  });
  const devices = Array.from({ length: Math.max(1, o.gpus) }, (_, i) => i).join(",");
  p.steps.push({
    title: o.smoke ? "Smoke run: two optimizer steps, a checkpoint at step 2" : "Train for the config's one epoch, with validation",
    lang: "bash",
    code: o.smoke
      ? `CUDA_VISIBLE_DEVICES=${devices} \\\n  axolotl train ${AXOLOTL_FILE[o.config]} \\\n  --max-steps 2 --gradient-accumulation-steps 1 \\\n  --eval-strategy no --save-strategy steps --save-steps 2 \\\n  --launcher torchrun -- --nproc_per_node=${o.gpus} --nnodes=1`
      : `CUDA_VISIBLE_DEVICES=${devices} \\\n  axolotl train ${AXOLOTL_FILE[o.config]} \\\n  --launcher torchrun -- --nproc_per_node=${o.gpus} --nnodes=1`,
    note: "Launcher arguments go after --; put them before it and only one worker starts.",
  });
  p.warnings.push("Put every image inline in messages[*].content and keep sample_packing: false and eval_sample_packing: false: packing breaks the mapping between image tokens and pixels.");
  if (o.config === "full-fsdp2") {
    p.notes.push("Use it only after an evaluation shows adapter capacity is the bottleneck. The full smoke run needs about 222 GB of disk for one sharded checkpoint plus its consolidated model, and peaked at 97,340 MiB per GPU while consolidating: almost no margin on an H100.");
    p.notes.push("It uses adamw_torch_fused; avoid a bitsandbytes 8-bit optimizer with FSDP2 unless you've validated it.");
  }
  if (o.config === "lora-fsdp2") p.notes.push("Keep FSDP2 activation_checkpointing: false: with Axolotl 0.19.0 it leaks wrapper names into the gathered adapter, and PEFT skips those weights on reload.");
  if (o.config === "qlora") p.notes.push("To reload a QLoRA adapter, pass dtype=torch.bfloat16 and set bnb_4bit_quant_storage=torch.bfloat16; without both the vision path loads in byte dtype.");
  const peak: Record<AxolotlConfig, string> = { qlora: "27,011 MiB", "lora-fsdp2": "41,094 MiB", "full-fsdp2": "97,340 MiB" };
  const runtime: Record<AxolotlConfig, string> = { qlora: "320.4 s", "lora-fsdp2": "651.1 s", "full-fsdp2": "1,105 s" };
  p.summary = `${o.config === "qlora" ? "QLoRA" : o.config === "lora-fsdp2" ? "bf16 LoRA with FSDP2" : "Full bf16 with FSDP2"}: on CoSyn the page measured ${runtime[o.config]} for one epoch and ${peak[o.config]} peak per GPU on 8 × H100, global batch 32.`;
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Muse Glimmer: TRL SFT (LoRA, QLoRA)

export interface GlimmerTrlOptions {
  method: "lora" | "qlora";
  rank: number;
  alpha: number;
  lr: number;
  epochs: number;
  batch: number;
  gradAcc: number;
}

export const GLIMMER_TRL_DEFAULTS: Record<"lora" | "qlora", GlimmerTrlOptions> = {
  lora: { method: "lora", rank: 16, alpha: 32, lr: 2e-4, epochs: 3, batch: 4, gradAcc: 4 },
  qlora: { method: "qlora", rank: 16, alpha: 32, lr: 2e-4, epochs: 3, batch: 1, gradAcc: 16 },
};

export function glimmerTrl(o: GlimmerTrlOptions): TrainingPlan {
  const p = plan();
  const effective = o.batch * o.gradAcc;
  if (o.lr < 1e-4 || o.lr > 3e-4) p.warnings.push(`The page recommends 1e-4 to 3e-4 for LoRA or QLoRA (full fine-tunes use about 1e-5); this is ${sci(o.lr)}.`);
  if (o.rank < 8 || o.rank > 32) p.warnings.push(`The page recommends a LoRA rank of 8 to 32; this is ${o.rank}.`);
  if (o.alpha !== o.rank * 2) p.notes.push(`LoRA alpha is usually twice the rank (${o.rank * 2} for r=${o.rank}).`);
  if (effective < 4 || effective > 16) p.warnings.push(`Effective batch ${effective} (${o.batch} × ${o.gradAcc}) is outside the page's 4 to 16; reach it with gradient accumulation.`);
  if (o.epochs < 2 || o.epochs > 5) p.warnings.push(`The page suggests 2 to 5 epochs; watch for overfitting on small datasets.`);
  const q = o.method === "qlora";
  const out = q ? "./muse-glimmer-qlora" : "./muse-glimmer-lora";
  const lines = q
    ? [
        "from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainingArguments",
        "from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training",
        "from trl import SFTTrainer",
        "import torch",
        "",
        'model_name = "meta-models/Muse-Glimmer-30B"',
        "",
        "bnb_config = BitsAndBytesConfig(",
        "    load_in_4bit=True,",
        '    bnb_4bit_quant_type="nf4",',
        "    bnb_4bit_compute_dtype=torch.bfloat16,",
        "    bnb_4bit_use_double_quant=True,",
        ")",
        "",
        "model = AutoModelForCausalLM.from_pretrained(",
        '    model_name, quantization_config=bnb_config, device_map="auto"',
        ")",
        "model = prepare_model_for_kbit_training(model)",
        "tokenizer = AutoTokenizer.from_pretrained(model_name)",
      ]
    : [
        "from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments",
        "from peft import LoraConfig, get_peft_model",
        "from trl import SFTTrainer",
        "",
        'model_name = "meta-models/Muse-Glimmer-30B"',
        "",
        "model = AutoModelForCausalLM.from_pretrained(",
        "    model_name,",
        '    dtype="auto",',
        '    device_map="auto",',
        ")",
        "tokenizer = AutoTokenizer.from_pretrained(model_name)",
      ];
  p.steps.push({
    title: q ? "QLoRA fine-tuning" : "LoRA fine-tuning",
    lang: "python",
    code: [
      ...lines,
      "",
      "lora_config = LoraConfig(",
      `    r=${o.rank},`,
      `    lora_alpha=${o.alpha},`,
      '    target_modules=["q_proj", "v_proj", "k_proj", "o_proj"],',
      "    lora_dropout=0.05,",
      '    task_type="CAUSAL_LM",',
      ")",
      "model = get_peft_model(model, lora_config)",
      "",
      "trainer = SFTTrainer(",
      "    model=model,",
      "    args=TrainingArguments(",
      `        output_dir="${out}",`,
      `        num_train_epochs=${o.epochs},`,
      `        per_device_train_batch_size=${o.batch},`,
      `        gradient_accumulation_steps=${o.gradAcc},`,
      `        learning_rate=${sci(o.lr)},`,
      "        bf16=True,",
      "        logging_steps=10,",
      '        save_strategy="epoch",',
      "    ),",
      "    train_dataset=train_dataset,  # your loaded dataset",
      "    processing_class=tokenizer,",
      ")",
      "trainer.train()",
      `trainer.save_model("${out}")`,
    ].join("\n"),
  });
  p.steps.push({
    title: "Merge the adapter for serving without PEFT",
    lang: "python",
    code: [
      "from peft import PeftModel",
      "from transformers import AutoModelForCausalLM",
      "",
      "base_model = AutoModelForCausalLM.from_pretrained(",
      '    "meta-models/Muse-Glimmer-30B",',
      '    dtype="auto",',
      '    device_map="auto",',
      ")",
      `model = PeftModel.from_pretrained(base_model, "${out}")`,
      "merged = model.merge_and_unload()",
      'merged.save_pretrained("./muse-glimmer-30b-merged")',
    ].join("\n"),
  });
  p.notes.push("Aim for at least a few hundred good examples (roughly 500+), several thousand for strong domain performance. To keep the model reasoning on your task, include the trace in reasoning_content.");
  p.summary = `${q ? "QLoRA (4-bit nf4 base)" : "LoRA (bf16 base)"}, r=${o.rank}, alpha ${o.alpha}, effective batch ${effective}, ${o.epochs} epochs at ${sci(o.lr)}.`;
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Muse Glimmer: TRL DPO and GRPO

export interface DpoOptions {
  beta: number;
  lr: number;
  batch: number;
  gradAcc: number;
  epochs: number;
}

export const DPO_DEFAULTS: DpoOptions = { beta: 0.1, lr: 5e-7, batch: 2, gradAcc: 8, epochs: 1 };

export function dpoPlan(o: DpoOptions): TrainingPlan {
  const p = plan();
  if (o.beta < 0.1 || o.beta > 0.5) p.warnings.push(`The page recommends beta 0.1 to 0.5 for DPO; this is ${o.beta}.`);
  if (o.lr < 1e-7 || o.lr > 1e-6) p.warnings.push(`DPO learning rates run 1e-7 to 1e-6 on the page, orders of magnitude lower than SFT; this is ${sci(o.lr)}.`);
  if (o.epochs < 1 || o.epochs > 2) p.warnings.push("The page suggests 1 to 2 epochs: RL-family objectives overfit fast.");
  p.steps.push({
    title: "DPO on preference pairs",
    lang: "python",
    code: [
      "from transformers import AutoModelForCausalLM, AutoTokenizer",
      "from trl import DPOConfig, DPOTrainer",
      "",
      'model_name = "meta-models/Muse-Glimmer-30B"',
      "",
      'model = AutoModelForCausalLM.from_pretrained(model_name, dtype="auto")',
      "tokenizer = AutoTokenizer.from_pretrained(model_name)",
      "",
      "config = DPOConfig(",
      '    output_dir="./muse-glimmer-dpo",',
      `    beta=${o.beta},                 # KL penalty strength; higher = stays closer to the reference`,
      `    learning_rate=${sci(o.lr)},       # DPO uses a much lower LR than SFT`,
      `    per_device_train_batch_size=${o.batch},`,
      `    gradient_accumulation_steps=${o.gradAcc},`,
      `    num_train_epochs=${o.epochs},`,
      "    bf16=True,",
      "    logging_steps=10,",
      ")",
      "",
      "trainer = DPOTrainer(",
      "    model=model,",
      "    args=config,",
      "    train_dataset=preference_dataset,  # prompt, chosen, rejected",
      "    processing_class=tokenizer,",
      ")",
      "",
      "trainer.train()",
      'trainer.save_model("./muse-glimmer-dpo")',
    ].join("\n"),
  });
  p.notes.push("DPO keeps a frozen reference copy and penalizes drift from it (beta). It needs no reward model and no sampling: it trains offline like SFT.");
  p.summary = `DPO: beta ${o.beta}, learning rate ${sci(o.lr)}, effective batch ${o.batch * o.gradAcc}, ${o.epochs} epoch${o.epochs === 1 ? "" : "s"}.`;
  return p;
}

export interface GrpoOptions {
  lr: number;
  numGenerations: number;
  maxCompletion: number;
}

export const GRPO_DEFAULTS: GrpoOptions = { lr: 1e-6, numGenerations: 8, maxCompletion: 4096 };

export function grpoPlan(o: GrpoOptions): TrainingPlan {
  const p = plan();
  if (o.lr < 1e-6 || o.lr > 3e-6) p.warnings.push(`The page recommends 1e-6 to 3e-6 for GRPO; this is ${sci(o.lr)}.`);
  if (o.numGenerations < 4 || o.numGenerations > 16) p.warnings.push(`Group sizes of 4 to 16 give a usable advantage estimate; this is ${o.numGenerations}.`);
  if (o.maxCompletion < 4096) p.warnings.push("Muse Glimmer reasons at length: a short max_completion_length cuts reasoning off before the final answer, and those rollouts score as failures.");
  p.steps.push({
    title: "GRPO with a programmatic reward",
    lang: "python",
    code: [
      "from trl import GRPOConfig, GRPOTrainer",
      "",
      "def reward_fn(completions, **kwargs):",
      "    # Return one scalar reward per completion. Example: reward a parseable final answer.",
      "    # Replace this example with your task's verifiable reward.",
      '    return [1.0 if "<answer>" in c else 0.0 for c in completions]',
      "",
      "config = GRPOConfig(",
      '    output_dir="./muse-glimmer-grpo",',
      `    learning_rate=${sci(o.lr)},`,
      "    per_device_train_batch_size=1,",
      `    num_generations=${o.numGenerations},         # group size sampled per prompt`,
      `    max_completion_length=${o.maxCompletion},  # allow room for Muse Glimmer's long reasoning traces`,
      "    bf16=True,",
      ")",
      "",
      "trainer = GRPOTrainer(",
      '    model="meta-models/Muse-Glimmer-30B",  # Start from your SFT checkpoint.',
      "    reward_funcs=reward_fn,",
      "    args=config,",
      "    train_dataset=prompt_dataset,  # prompts only; completions are sampled online",
      ")",
      "",
      "trainer.train()",
    ].join("\n"),
  });
  p.notes.push("Score the final answer, not the reasoning tokens, unless you mean to shape the reasoning. Keep a KL penalty to the reference, hold out an eval set the reward never sees, and read samples at each checkpoint.");
  p.summary = `GRPO: ${o.numGenerations} completions per prompt, up to ${n(o.maxCompletion)} tokens each, learning rate ${sci(o.lr)}.`;
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Muse Glimmer: TitanRL data-analyst recipe

export interface TitanRlOptions {
  run: "smoke" | "full";
  tiers: AnalystTiers;
  generatorTp: number;
}

export const TITANRL_DEFAULTS: TitanRlOptions = { run: "smoke", tiers: ANALYST_TIERS, generatorTp: 2 };

export function titanRlPlan(o: TitanRlOptions): TrainingPlan {
  const p = plan();
  if (o.generatorTp > 2) p.errors.push("Muse Glimmer's two KV heads cap generator tensor parallelism at 2.");
  p.steps.push({
    title: "Install TorchTitan and TitanRL (vLLM last)",
    lang: "bash",
    code: [
      "COOKBOOK=/absolute/path/to/meta-oss-cookbook",
      "git clone https://github.com/pytorch/torchtitan.git",
      "cd torchtitan",
      "pip install uv",
      "uv venv --python 3.12 glimmer-rl",
      "source glimmer-rl/bin/activate",
      "",
      "uv pip install -r requirements.txt",
      "uv pip install -r torchtitan/rl/requirements.txt",
      'uv pip install --no-deps "git+https://github.com/meta-pytorch/torchstore.git@main"',
      "uv pip install flash-attn-3 --extra-index-url=https://download.pytorch.org/whl/test/cu130",
      "uv pip install torch torchvision vllm --pre \\",
      "  --extra-index-url https://download.pytorch.org/whl/nightly/cu130 \\",
      "  --index-strategy unsafe-best-match",
    ].join("\n"),
    note: "Leave torchcomms out: a single node doesn't need it, and including it makes the install fail.",
  });
  p.steps.push({
    title: "Copy the recipe in, run its GPU-free tests, download the checkpoint once",
    lang: "bash",
    code: [
      'cp -R "$COOKBOOK/post-training/rl/titanrl/data-analyst/titanrl_files" \\',
      "  torchtitan/rl/examples/glimmer_data_analyst",
      "",
      'export PYTHONPATH="$PWD:${PYTHONPATH:-}"',
      "uv pip install pytest",
      "pytest torchtitan/rl/examples/glimmer_data_analyst/tests/ -v",
      "",
      "python scripts/download_hf_assets.py \\",
      "  --repo_id meta-models/Muse-Glimmer-30B \\",
      "  --local_dir torchtitan/rl/example_checkpoint \\",
      "  --all",
    ].join("\n"),
  });
  const smoke = o.run === "smoke";
  p.steps.push({
    title: smoke ? "Smoke config: 10 steps, about 30 minutes on 8 × H100" : "Full config: about 75 minutes on 8 × H100",
    lang: "bash",
    code: [
      "python -m torchtitan.rl.train \\",
      "  --module torchtitan.rl.examples.glimmer_data_analyst \\",
      `  --config rl_grpo_muse_glimmer_30b_data_analyst${smoke ? "_smoke" : ""} \\`,
      `  --dump-folder outputs/rl/glimmer_data_analyst${smoke ? "_smoke" : ""}`,
    ].join("\n"),
    note: "Before each run: activate the environment, export PYTHONPATH (Monarch's workers import from it), and run wandb login or pass --metrics.no-enable-wandb.",
  });
  const t = o.tiers;
  const changed = (Object.keys(ANALYST_TIERS) as (keyof AnalystTiers)[]).filter((k) => t[k] !== ANALYST_TIERS[k]);
  if (changed.length) {
    p.steps.push({
      title: "Your reward tiers (rubric.py config fields)",
      lang: "python",
      code: [
        `file_exists_credit=${t.malformed},`,
        `file_parses_credit=${t.wrongNumber},`,
        `repeated_failing_command_penalty=${t.repeatPenalty},`,
      ].join("\n"),
      note: "The page names these three fields; set file_exists_credit=0.0 and file_parses_credit=0.0 for a strict 0 or 1 reward. Which tier each field maps to is our reading of the table.",
    });
  }
  p.notes.push("The recipe uses trainer FSDP 3 × TP 2 on six GPUs and generator TP 2 on two. A longer context, a larger microbatch or a bigger batch needs more GPUs.");
  p.notes.push("If you widen max_num_turns or the generator's max_tokens, raise max_rollout_tokens and the trainer's max_context_length to match: a rollout that outgrows its budget ends as truncated_prompt_too_long, which looks like the model failing.");
  p.summary = `GRPO with a graded, deterministic reward: 8 prompts × 8 samples per step. On the public checkpoint mean reward rose from 0.21 at step 1 to 0.98 at step 15, when the task saturates.`;
  return p;
}
