# Post-training {#post-training}

Fine-tune Muse Spark Open with an open-source training framework on your own GPUs, or with a hosted service that runs the job for you. Each option has its own section below.

| Option                                                                                           | Type                  | Methods                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [TorchTitan](https://dev.meta.ai/docs/muse-spark-open/post-training#torchtitan)                  | Open-source framework | SFT with LoRA, or full-parameter on text, image, and audio; RL with DAPO and vLLM rollouts                                                                |
| [Miles](https://dev.meta.ai/docs/muse-spark-open/post-training#miles)                            | Open-source framework | Reinforcement learning (RL) with Group Relative Policy Optimization (GRPO) on 64 GPUs, with SGLang rollouts                                               |
| [NVIDIA NeMo AutoModel](https://dev.meta.ai/docs/muse-spark-open/post-training#nemo-automodel)   | Open-source framework | Full-parameter supervised fine-tuning (SFT) and low-rank adaptation (LoRA)                                                                                |
| [NVIDIA Megatron Bridge](https://dev.meta.ai/docs/muse-spark-open/post-training#megatron-bridge) | Open-source framework | Megatron-based training, with Hugging Face checkpoint conversion                                                                                          |
| [TRL](https://dev.meta.ai/docs/muse-spark-open/post-training#trl)                                | Open-source framework | SFT with LoRA                                                                                                                                             |
| [Together AI](https://dev.meta.ai/docs/muse-spark-open/post-training#together-ai)                | Hosted service        | SFT and RL (GRPO)                                                                                                                                         |
| [Fireworks AI](https://dev.meta.ai/docs/muse-spark-open/post-training#fireworks-ai)              | Hosted service        | Serverless LoRA: SFT, Direct Preference Optimization (DPO), Odds Ratio Preference Optimization (ORPO), distillation, RL; full-parameter on dedicated GPUs |

## Open-source frameworks {#open-source-frameworks}

### TorchTitan fine-tuning {#torchtitan}

[TorchTitan](https://github.com/pytorch/torchtitan) provides PyTorch-native training for Muse Spark Open, and [TitanRL](https://github.com/pytorch/torchtitan/tree/main/torchtitan/rl) is its reinforcement-learning (RL) library. The trainer and vLLM generators share TorchTitan model definitions. Monarch orchestrates training and rollouts, and TorchStore transfers updated weights to the generators.

TorchTitan ships reference recipes for the BF16 checkpoint on NVIDIA Blackwell GPUs (SM100 or newer):

- **SFT with LoRA:** `muse_spark_816b_a42b_ultradata_lora_sft_cp16_128k` trains a rank-8 LoRA adapter on agent conversations with a 131,072-token context, on 16 GB300 GPUs.
- **RL with DAPO:** `muse_spark_816b_a42b_dapo_math_gb300_config` trains on math reasoning with vLLM rollouts, on 256 trainer GPUs plus 16 generator GPUs. It needs a cluster launcher that places the trainer and the generator on separate hosts.

The cookbook has step-by-step recipes for both: [full-parameter SFT on your own text, image, and audio conversations](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-sft), and [RL on a task you plug in](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-rl), starting from the DAPO-Math recipe.

#### Links {#torchtitan-links}

- [Muse Spark Open model guide in TorchTitan](https://github.com/pytorch/torchtitan/blob/main/torchtitan/models/muse_spark/README.md): setup, checkpoint download, and the SFT recipes
- [Muse Spark Open DAPO-Math RL configuration](https://github.com/pytorch/torchtitan/blob/main/torchtitan_recipes/rl/dapo_math.py)
- [TitanRL setup and experiment guide](https://github.com/pytorch/torchtitan/blob/main/torchtitan/rl/README.md)

### Miles {#miles}

[Miles](https://dev.meta.ai/docs/muse-spark-open/post-training#miles-links) is an open-source framework for large-scale reinforcement learning (RL) post-training. This guide runs GRPO on Muse Spark Open with a ready-made recipe on 64 GPUs, in one of two modes:

- **Math reasoning** (default): DAPO-Math-17k prompts, rewarded by matching the final `\boxed{}` answer.
- **Image-grounded math** (`--vlm`): Geometry3K diagrams and questions. The vision tower and its projection layers stay frozen; only the language model is trained.

#### Links {#miles-links}

- [Miles guide for Muse Spark Open](https://miles.radixark.com/docs/models/muse-spark/muse-spark-open)
- Miles: [radixark/miles, branch `muse-spark-open`](https://github.com/radixark/miles/tree/muse-spark-open)
- SGLang for Miles: [sgl-project/sglang, branch `sglang-miles-muse-spark-open`](https://github.com/sgl-project/sglang/tree/sglang-miles-muse-spark-open)
- Container image: `radixark/miles:muse-spark-open`
- Recipe: `scripts/run_muse_spark_64xh200.py` in the Miles repository
- Muse Spark Open checkpoint (BF16): [meta-models/Muse-Spark-Open-816B-A42B](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B)

#### Install {#miles-install}

**Hardware.** The recipe needs 8 nodes with 8 NVIDIA H200 GPUs each, connected by InfiniBand. The full recipe is validated on H200. Blackwell GPUs (B200, B300) also run RL weight updates. You also need:

- storage visible to every node at `/root/models` and `/root/datasets` (or pass `--model-dir` and `--data-dir`) for the BF16 checkpoint, its Megatron copy (about 1.6 TB each), and the training data; the recipe downloads and converts the checkpoint there on its first run;
- local NVMe on every node at `/scratch` (or pass `--offload-train-disk-dir`) with about 1.2 TB free: the recipe streams Adam optimizer state there;
- to save the tuned model, storage visible to every node at `/root/shared_data` (or pass `--output-dir`); see [Use the tuned model](https://dev.meta.ai/docs/muse-spark-open/post-training#miles-use-the-tuned-model).

**1. Start the environment on every node.** Start one container per node with the GPUs, the InfiniBand devices, the host network, the shared storage, and the local NVMe:

**bash**

```bash
docker run -d --name miles --gpus all --network host --ipc host --shm-size 512g \
  --ulimit memlock=-1 --ulimit stack=67108864 --device /dev/infiniband \
  -v /path/to/shared/models:/root/models \
  -v /path/to/shared/datasets:/root/datasets \
  -v /path/to/shared/outputs:/root/shared_data \
  -v /path/to/local/nvme:/scratch \
  radixark/miles:muse-spark-open sleep infinity
docker exec -it miles bash
```

The image contains Miles and SGLang from the branches under [Links](https://dev.meta.ai/docs/muse-spark-open/post-training#miles-links), with Miles at `/root/miles`. Run the commands below inside the container.

**2. Start one Ray cluster across the 8 nodes.** On node 0, run `ray start --head --port 6379 --num-gpus 8`; on nodes 1–7, run `ray start --address <node-0-address>:6379 --num-gpus 8`. Check that `ray status` reports 64 GPUs.

#### Prepare your data {#miles-prepare-your-data}

By default the recipe downloads DAPO-Math-17k, or Geometry3K with `--vlm`, to `/root/datasets` (or pass `--data-dir`). You can train on your own dataset: download it as a JSONL file to `/root/datasets` and pass its path with `--extra-args "--prompt-data /root/datasets/train.jsonl"`. Each line is one prompt with these fields:

| Mode                          | Row fields                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| Math reasoning                | `prompt` (a string or a list of chat messages), `label`                                               |
| Image-grounded math (`--vlm`) | `messages` (the user turn, with one `<image>` placeholder per image), `images` (image paths), `label` |

`label` is the reference answer. The reward is 1 when the final `\boxed{}` answer in the response matches it and 0 otherwise, so ask for the final answer in `\boxed{}` in the prompt, as DAPO-Math-17k does.

#### Start training {#miles-start-training}

Run the recipe on node 0 from `/root/miles`. `MILES_SCRIPT_EXTERNAL_RAY=1` tells it to use the Ray cluster from step 2. To log to Weights & Biases, also export `WANDB_API_KEY`.

**Math reasoning:**

**bash**

```bash
MILES_SCRIPT_EXTERNAL_RAY=1 python scripts/run_muse_spark_64xh200.py
```

**Image-grounded math:**

**bash**

```bash
MILES_SCRIPT_EXTERNAL_RAY=1 python scripts/run_muse_spark_64xh200.py \
  --vlm --use-dynamic-sampling-filter --reasoning-effort medium --eval-interval 5
```

`--eval-interval 5` scores the Geometry3K test split (601 problems, 4 samples each) before training, every 5 steps, and after the last step.

What the recipe runs:

| Setting              | Value                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Algorithm            | GRPO, no KL penalty, clip 0.2 / 0.28, rollout routing replay for the MoE layers                                           |
| Batch                | 32 prompts × 16 samples per step (512 rollouts), one update per step                                                      |
| Lengths              | 4096-token responses, 8192-token context                                                                                  |
| Optimizer            | Adam, learning rate 1e-6, state streamed to local disk; `--optimizer muon` switches to Muon, with its state in CPU memory |
| Training parallelism | tensor 8 × pipeline 8, expert 8, sequence parallelism, packed sequences in THD format, full recomputation                 |
| Rollout engines      | 4 SGLang engines with 16 GPUs each, BF16 KV cache, up to 64 concurrent requests per engine                                |
| Reasoning effort     | `xhigh` by default; the image-grounded math runs used `medium` to reduce response length                                  |

Change these with the flags listed by `python scripts/run_muse_spark_64xh200.py --help` (for example `--num-rollout`, `--rollout-batch-size`, `--n-samples-per-prompt`, `--learning-rate`).

**What to expect.** Time per step on 64 H200 GPUs:

| Mode                | Rollout   | Training    | Weight sync |
| ------------------- | --------- | ----------- | ----------- |
| Math reasoning      | 2–5.5 min | 3–5.5 min   | about 50 s  |
| Image-grounded math | 8–14 min  | about 5 min | about 50 s  |

Image-grounded math rollouts take longer because `--use-dynamic-sampling-filter` discards prompts whose samples all get the same reward and keeps sampling until 32 prompts remain.

Healthy signs in the logs or in Weights & Biases:

- the mean absolute difference between rollout and training log-probabilities (`train/train_rollout_logprob_abs_diff`) stays around 0.007 (math reasoning) or 0.013 (image-grounded math);
- the reward is about 0.65–0.75 in the first steps; for math reasoning it reached 0.8–0.95 within 10 steps in RadixArk's runs, while the mean response length fell from about 2,600 to 800–1,900 tokens;
- with `--vlm`, Geometry3K accuracy started near 0.87 and passed 0.93 within 5 steps in RadixArk's runs.

#### Use the tuned model {#miles-use-the-tuned-model}

Pass `--save-interval` when you start training, with a run ID so you know where the outputs go:

**bash**

```bash
MILES_SCRIPT_EXTERNAL_RAY=1 python scripts/run_muse_spark_64xh200.py --save-interval 10 --run-id muse-dapo
```

The recipe saves the weights, without optimizer state, every 10 steps and after the last step to `/root/shared_data/muse-dapo/checkpoints`, then converts the last save into a Hugging Face checkpoint at `/root/shared_data/muse-dapo/hf` in the layout of `meta-models/Muse-Spark-Open-816B-A42B`. Each save and each conversion takes about 1.6 TB.

To convert another save, for example the one after step 10 (save directories count steps from 0, so it is `iter_0000009`):

**bash**

```bash
python tools/convert_muse_spark_torch_dist_to_hf.py \
  --input-dir /root/shared_data/muse-dapo/checkpoints/iter_0000009 \
  --hf-checkpoint /root/models/Muse-Spark-Open-816B-A42B \
  --output-dir /root/shared_data/muse-dapo/hf-step-10
```

#### More {#miles-more}

- All recipe options: `python scripts/run_muse_spark_64xh200.py --help`
- Miles documentation: [miles.radixark.com/docs](https://miles.radixark.com/docs)

### NVIDIA NeMo AutoModel {#nemo-automodel}

[NVIDIA NeMo AutoModel](https://github.com/NVIDIA-NeMo/Automodel) is a post-training library built on PyTorch DTensor that loads Hugging Face checkpoints directly, with no conversion. See the [Muse Spark Open guide in NeMo AutoModel](https://github.com/NVIDIA-NeMo/Automodel/blob/main/docs/model-coverage/vlm/meta-models/muse_spark_open.mdx) for setup and training recipes.

### NVIDIA Megatron Bridge {#megatron-bridge}

[NVIDIA Megatron Bridge](https://github.com/NVIDIA-NeMo/Megatron-Bridge) is a training library for Megatron-based models that converts checkpoints to and from Hugging Face format. See the [Muse Spark Open example in Megatron Bridge](https://github.com/NVIDIA-NeMo/Megatron-Bridge/tree/main/examples/models/muse_spark_open) for setup and training recipes.

### TRL {#trl}

[TRL](https://github.com/huggingface/trl) is Hugging Face's post-training library. Its `SFTTrainer` fine-tunes Muse Spark Open (816B parameters, 42B active) on a multi-node cluster: Transformers shards the model across the GPUs while loading it, the experts are split across groups of ranks with token dispatch, and a LoRA adapter is trained on top. The recipe below runs on 8 nodes of 8 H100s and trains 500 steps of supervised fine-tuning.

#### Links {#trl-links}

- Recipe: [examples/sft\_muse\_spark\_open](https://github.com/huggingface/trl/tree/main/examples/sft_muse_spark_open) in the TRL repository (training script and Slurm launcher)
- [SFTTrainer documentation](https://huggingface.co/docs/trl/sft_trainer)
- [Distributing training](https://huggingface.co/docs/trl/distributing_training) and the [PEFT integration](https://huggingface.co/docs/trl/peft_integration)

#### Install {#trl-install}

TRL brings datasets and the other training dependencies; PEFT provides the LoRA adapter; Muse Spark Open needs Transformers 5.19 or later.

**bash**

```bash
pip install trl peft "transformers>=5.19"
```

#### Prepare your data {#trl-prepare-your-data}

Format your training data as JSONL in the chat format, one conversation per line:

**JSONL**

```json
{"messages": [{"role": "system", "content": "You are a medical assistant."}, {"role": "user", "content": "What are the symptoms of type 2 diabetes?"}, {"role": "assistant", "content": "Common symptoms include increased thirst, frequent urination, fatigue, and blurred vision."}]}
{"messages": [{"role": "system", "content": "You are a medical assistant."}, {"role": "user", "content": "How is hypertension diagnosed?"}, {"role": "assistant", "content": "Hypertension is diagnosed by measuring blood pressure. A reading consistently at or above 130/80 mmHg indicates hypertension."}]}
```

`SFTTrainer` applies the model's chat template for you. Load the file with `datasets`, or use any Hub dataset in this format; the recipe uses [allenai/tulu-3-sft-mixture](https://huggingface.co/datasets/allenai/tulu-3-sft-mixture):

**Python**

```python
from datasets import load_dataset

train_dataset = load_dataset("json", data_files="train.jsonl", split="train")
# or
train_dataset = load_dataset("allenai/tulu-3-sft-mixture", split="train[:500000]")
```

See [dataset formats](https://huggingface.co/docs/trl/dataset_formats) for the other accepted layouts.

#### Start training {#trl-start-training}

The whole parallelism configuration is two numbers passed to Transformers when the model is loaded: `fsdp_size`, the number of GPUs the model is sharded over, and `ep_size`, the number of groups the experts are split into. The model's own expert plan selects token dispatch.

**Python**

```python
from datasets import load_dataset
from peft import LoraConfig
from transformers.distributed import DistributedConfig

from trl import SFTConfig, SFTTrainer

train_dataset = load_dataset("allenai/tulu-3-sft-mixture", split="train[:500000]")

training_args = SFTConfig(
    output_dir="muse-spark-open-sft",
    model_init_kwargs={
        "dtype": "auto",  # keep the checkpoint's bf16 weights
        "distributed_config": DistributedConfig(fsdp_size=64, ep_size=8),  # shard over 64 GPUs, experts split 8 ways
    },
    per_device_train_batch_size=1,
    max_steps=500,
    max_length=2048,  # 96% of Tulu 3 conversations fit; longer ones are truncated
    dataset_num_proc=32,  # preprocesses the dataset with 32 workers instead of one
    packing=True,  # packs several examples per sequence so almost no token is padding
    logging_steps=1,
    save_only_model=True,  # required: the optimizer state of a model sharded at load time cannot be checkpointed
    save_steps=50,  # the adapter is 194 MB, so saving is cheap
)
trainer = SFTTrainer(
    model="meta-models/Muse-Spark-Open-816B-A42B",
    args=training_args,
    train_dataset=train_dataset,
    peft_config=LoraConfig(r=16, lora_alpha=32, target_modules=["q_proj", "k_proj", "v_proj", "o_proj"]),
)
trainer.train()
```

Launch it with `torchrun` on every node, 8 processes per node. With Slurm:

**bash**

```bash
#!/bin/bash
#SBATCH --nodes=8
#SBATCH --gres=gpu:8
#SBATCH --ntasks-per-node=1
#SBATCH --mem=0

MASTER=$(scontrol show hostnames "$SLURM_JOB_NODELIST" | head -1)
MASTER_IP=$(getent ahostsv4 "$MASTER" | awk 'NR==1{print $1}')

srun torchrun \
    --nnodes "$SLURM_NNODES" \
    --nproc_per_node 8 \
    --rdzv_backend c10d \
    --rdzv_endpoint "$MASTER_IP:29700" \
    sft_muse_spark_open.py
```

On 64 H100s this runs at 14.2 s per step with 131k tokens per step, using 40.2 GB per GPU. A checkpoint of the adapter (194 MB) is written every 50 steps.

#### Use the tuned model {#trl-use-the-tuned-model}

Training saves the LoRA adapter only, 194 MB per checkpoint. The base weights are about 1.65 TB in bf16, so the adapter is used the same way the base model is run: load the model sharded across your GPUs with `DistributedConfig`, as in [Hugging Face Transformers](https://dev.meta.ai/docs/muse-spark-open/deploy#transformers), then attach the adapter with PEFT. Save the script and launch it with `torchrun` on every node, with the same Slurm script as in that section.

**Python**

```python
import os

import torch
from peft import PeftModel
from transformers import AutoModelForMultimodalLM, AutoProcessor, DistributedConfig

model_id = "meta-models/Muse-Spark-Open-816B-A42B"
distributed_config = DistributedConfig(
    tp_size=int(os.environ["WORLD_SIZE"]),
    ep_size=int(os.environ["WORLD_SIZE"]),
)
processor = AutoProcessor.from_pretrained(model_id)
model = AutoModelForMultimodalLM.from_pretrained(model_id, distributed_config=distributed_config)
model.requires_grad_(False)  # inference: no parameter is trained
model = PeftModel.from_pretrained(model, "muse-spark-open-sft/checkpoint-500")

messages = [{"role": "user", "content": "What is the capital of France?"}]
inputs = processor.apply_chat_template(
    messages, reasoning_effort="low", add_generation_prompt=True, tokenize=True, return_dict=True, return_tensors="pt"
).to(model.device)
outputs = model.generate(**inputs, max_new_tokens=512)
if int(os.environ["RANK"]) == 0:
    print(processor.decode(outputs[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True))
```

The adapter alone can also be shared: `trainer.push_to_hub()` uploads it, and anyone with the base model can attach it the same way.

#### More {#trl-more}

- `SFTTrainer` also supports full fine-tuning, vision-language data, and continued pre-training; see the [SFTTrainer documentation](https://huggingface.co/docs/trl/sft_trainer).
- TRL also provides preference and reinforcement-learning trainers (DPO, GRPO); see the [TRL documentation](https://huggingface.co/docs/trl).
- To run on managed hardware, see [training on Hugging Face Jobs](https://huggingface.co/docs/trl/jobs_training).
- Questions and issues: [github.com/huggingface/trl/issues](https://github.com/huggingface/trl/issues).

## Hosted services {#hosted-services}

### Together AI {#together-ai}

Adapt Muse Spark Open to your data with SFT and RL on Together AI's post-training service. Together AI manages the infrastructure and performance optimizations; you control the training loop. Muse Spark Open support on Together Post-Training is in preview, so the service and its limits can change.

#### Links {#together-ai-links}

- [GRPO quickstart](https://docs.together.ai/docs/post-training/quickstart-rl) and [SFT quickstart](https://docs.together.ai/docs/post-training/quickstart-sft) run ready-made recipes on Together Post-Training.
- [Post-training cookbook](https://github.com/togethercomputer/post-training-cookbook) has the recipes the quickstarts use.

#### Get access {#together-ai-get-access}

To get started with Together Post-Training:

1. Create a [Together AI account](https://api.together.ai/) and add credit to it.
2. Create an [API key](https://api.together.ai/settings/api-keys) and export it as `TOGETHER_API_KEY`.
3. Clone the [post-training cookbook](https://github.com/togethercomputer/post-training-cookbook), which installs the Together Python SDK.
4. Follow a quickstart from [Links](https://dev.meta.ai/docs/muse-spark-open/post-training#together-ai-links), with `meta-models/Muse-Spark-Open-816B-A42B` as the base model.

#### Prepare your data {#together-ai-prepare-your-data}

Read Together AI's guides on [preparing SFT data](https://docs.together.ai/docs/post-training/sft#prepare-your-data), [writing reward functions](https://docs.together.ai/docs/post-training/reward-functions), and [training in multi-turn environments](https://docs.together.ai/docs/post-training/multi-turn-environments).

#### Use the tuned model {#together-ai-use-the-tuned-model}

Learn how to deploy a post-trained model for inference with these guides:

1. [Deploy a checkpoint](https://docs.together.ai/docs/post-training/deployment)
2. [Multi-LoRA deployment](https://docs.together.ai/docs/post-training/multi-lora-deployment)
3. [Prepare for FP4 inference](https://docs.together.ai/docs/post-training/prepare-for-fp4-inference)

### Fireworks AI {#fireworks-ai}

Fireworks post-trains Muse Spark Open with serverless LoRA on a shared trainer. You write the training loop in Python. Fireworks runs the forward pass, backward pass, and optimizer on remote GPUs, then serves the current adapter for sampling in the same session. There is no trainer job or inference deployment to provision.

The base model is `accounts/fireworks/models/muse-spark-open-nvfp4` (Muse Spark Open 816B-A42B, NVFP4 open weights). Serverless training is LoRA only. The production pool supports LoRA rank up to 64 and sequences up to 262,144 tokens. Supervised fine-tuning, DPO, ORPO, distillation, and reinforcement learning all run on that pool. Full-parameter training uses dedicated GPUs.

#### Links {#fireworks-ai-links}

- [Serverless training](https://docs.fireworks.ai/fine-tuning/training-api/serverless) covers setup, checkpoints, promotion, and pricing.
- [Fireworks cookbook](https://github.com/fw-ai/cookbook) has runnable SFT, DPO, and RL recipes, including the [serverless RL example](https://github.com/fw-ai/cookbook/tree/main/training/examples/serverless_rl).
- [Muse Spark Open weights](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B-NVFP4) is the checkpoint and tokenizer the training client must match.

#### Get access {#fireworks-ai-get-access}

1. Create a Fireworks account at [fireworks.ai](https://fireworks.ai/).
2. Create an API key in the dashboard.
3. Install the training SDK and export the key:

**bash**

```bash
pip install "fireworks-ai[training]"
export FIREWORKS_API_KEY="fw_..."
```

Serverless training does not require reserved GPUs. If `create_lora_training_client` reports that Muse Spark Open is not available on the account, contact Fireworks to enable it.

#### Prepare your data {#fireworks-ai-prepare-your-data}

Keep every rendered example at or under 262,144 tokens. The open checkpoint's native context is 1,048,576 tokens. The serverless pool trains up to 262,144.

**Supervised fine-tuning.** One JSONL conversation per line, in the OpenAI chat format. A message with `"weight": 0` is left out of the loss. The cookbook `sft_loop` recipe reads this file.

**JSONL**

```json
{"messages": [{"role": "system", "content": "You are a helpful assistant."}, {"role": "user", "content": "What is the capital of France?"}, {"role": "assistant", "content": "Paris."}]}
```

**Preference optimization.** Chosen and rejected responses for the same prompt. Use the cookbook DPO recipe for the row schema.

**Reinforcement learning.** Prompts plus a reward function you score locally. The serverless RL example uses rows of `{"messages": [...], "ground_truth": "{\"numbers\": [...], \"target\": N}"}`. `ground_truth` is a JSON string. Labeled assistant answers are not required.

Load the tokenizer from `meta-models/Muse-Spark-Open-816B-A42B-NVFP4`. It has to match the base model. Muse Spark Open is a mixture-of-experts model. Use the cookbook recipes so router replay stays enabled.

#### Start a job {#fireworks-ai-start-a-job}

**Python**

```python
import os
from fireworks.training.sdk import FiretitanServiceClient

service = FiretitanServiceClient(
    api_key=os.environ["FIREWORKS_API_KEY"],
    base_url="https://api.fireworks.ai/training/v1/serverless",
)

base_model = "accounts/fireworks/models/muse-spark-open-nvfp4"
training_client = service.create_lora_training_client(
    base_model=base_model,
    rank=64,
)
print(f"session={service.training_session_id} run={training_client.run_id}")
```

A session ID that starts with `ts-` means the client attached to the pool. `rank` can be any positive integer up to 64.

For a full loop, clone the cookbook and start from the serverless RL example:

**bash**

```bash
git clone https://github.com/fw-ai/cookbook
cd cookbook/training
pip install -e .
export FIREWORKS_API_KEY="fw_..."
python -m examples.serverless_rl.countdown_rl \
  --base-model accounts/fireworks/models/muse-spark-open-nvfp4 \
  --tokenizer-model meta-models/Muse-Spark-Open-816B-A42B-NVFP4
```

Each optimizer step is `forward_backward(...).result()` followed by `optim_step(...).result()`. Call `.result()` on every remote operation so failures are not dropped. If the pool is full, retry, or switch to dedicated training.

`save_state` writes a training checkpoint (adapter weights and optimizer state) for resume. `save_weights_for_sampler` writes a sampler checkpoint (adapter weights only) for sampling and deployment. A training checkpoint cannot be served. A sampler checkpoint cannot resume the optimizer.

#### Use the tuned model {#fireworks-ai-use-the-tuned-model}

While the session is open, sample the current adapter directly. This continues the session from [Start a job](https://dev.meta.ai/docs/muse-spark-open/post-training#fireworks-ai-start-a-job), using its `service` and `training_client`:

**Python**

```python
from transformers import AutoTokenizer

tokenizer = AutoTokenizer.from_pretrained("meta-models/Muse-Spark-Open-816B-A42B-NVFP4")
snapshot = training_client.save_weights_for_sampler("final").result().path
sampler = service.create_sampling_client(model_path=snapshot, tokenizer=tokenizer)
```

Keep the name passed to `save_weights_for_sampler` at 17 characters or fewer.

To serve after the session ends, promote the sampler checkpoint to a model, then deploy it. This also uses the `service` from [Start a job](https://dev.meta.ai/docs/muse-spark-open/post-training#fireworks-ai-start-a-job). Promote before the session is deleted. After that, the checkpoints are no longer reachable through this API.

**Python**

```python
import os
from datetime import datetime

from fireworks.training.sdk import FireworksClient

fw = FireworksClient(api_key=os.environ["FIREWORKS_API_KEY"])
rows = fw.list_training_session_checkpoints(service.training_session_name)
target = max(
    (row for row in rows if row.get("promotable")),
    key=lambda row: datetime.fromisoformat(row["createTime"].replace("Z", "+00:00")),
)
model = fw.promote_session_checkpoint(
    name=target["name"],
    output_model_id="muse-spark-my-lora",
    base_model="accounts/fireworks/models/muse-spark-open-nvfp4",
)
```

`output_model_id` is 1–63 characters: lowercase letters, digits, and hyphens.

Deploy the promoted LoRA with the Python SDK. `deployment_shape="default"` makes the server pick a validated shape for that model. No CLI is required.

**Python**

```python
from fireworks import Fireworks

client = Fireworks()
client.deployments.create(
    base_model="accounts/<account-id>/models/muse-spark-my-lora",
    deployment_shape="default",
)
response = client.chat.completions.create(
    model="accounts/<account-id>/models/muse-spark-my-lora",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

A trained LoRA is served on a dedicated deployment. Fireworks does not serve a private trained adapter on per-token serverless inference.

#### More {#fireworks-ai-more}

- Full-parameter training, and any run that needs its own GPUs for the whole job, uses [dedicated training](https://docs.fireworks.ai/fine-tuning/training-api/dedicated).
- Serverless training is billed per token on three meters: prefill, sample, and train. Cached prefill is discounted. Current rates are on the [serverless training](https://docs.fireworks.ai/fine-tuning/training-api/serverless) page.
- Checkpoint storage for serverless runs is included.
- The default concurrent-run quota is 8. Slots free when a run becomes terminal after the session expires.

## Next steps {#next-steps}

Serve the tuned model with a runtime from [Run inference](https://dev.meta.ai/docs/muse-spark-open/deploy), using the [recommended settings](https://dev.meta.ai/docs/muse-spark-open/settings) and the chat format in the [prompting guide](https://dev.meta.ai/docs/muse-spark-open/prompting).
