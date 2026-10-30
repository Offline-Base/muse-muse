# Post-training {#post-training}

Adapt Muse Glimmer to your task with an open-source training framework on your own GPUs. There are two training objectives. Use **supervised fine-tuning (SFT)** when you have examples of the response you want, and **reinforcement learning (RL)** when you can check success automatically but can't fully demonstrate it.

| Option                                                                 | Objective              | Methods                                                                                                                                           |
| ---------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Axolotl](https://dev.meta.ai/docs/muse-glimmer/post-training#axolotl) | Supervised fine-tuning | Quantized low-rank adaptation (QLoRA), bf16 low-rank adaptation (LoRA) with Fully Sharded Data Parallel 2 (FSDP2), full-parameter bf16 with FSDP2 |
| [TRL](https://dev.meta.ai/docs/muse-glimmer/post-training#trl-sft)     | Supervised fine-tuning | LoRA, QLoRA                                                                                                                                       |
| [TitanRL](https://dev.meta.ai/docs/muse-glimmer/post-training#titanrl) | Reinforcement learning | Group Relative Policy Optimization (GRPO) with a verifiable reward                                                                                |
| [TRL](https://dev.meta.ai/docs/muse-glimmer/post-training#trl-rl)      | Reinforcement learning | Direct Preference Optimization (DPO), GRPO                                                                                                        |

## Choose the training signal {#choose-the-training-signal}

Start with **SFT** when you have target responses. It's the direct route for teaching a new output format, tone, domain pattern, or visual task. Most projects start, and often stop, at SFT.

Use **RL** when the model can already attempt the task and success is cheap to check, but the behavior is unreliable. RL is a good fit when:

- The model can do the task but does it unreliably: the wrong format, giving up after an error, or never producing the required output.
- Success is cheap and objective to check: a file exists, a number matches, a test passes. If a human or an LLM has to judge each attempt, expect noise and reward hacking.
- You have a measured baseline, so "better" is a number.

RL shapes behavior. It doesn't teach the model facts it lacks. Start with SFT for that, then add RL for the remaining failures that have an objective reward. RL is also more stable from an SFT checkpoint that already produces well-formatted, on-task outputs.

| Stage                                                                             | When to use                                              | Data you need                                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| [Supervised fine-tuning](https://dev.meta.ai/docs/muse-glimmer/post-training#sft) | Domain adaptation, style, format, instruction following  | Prompt and response pairs in chat format                 |
| [Reinforcement learning](https://dev.meta.ai/docs/muse-glimmer/post-training#rl)  | Preference alignment, tool-use success, agentic behavior | Preference pairs, a reward model, or a verifiable reward |

## Size the hardware {#hardware}

Post-training a 30B dense model is much heavier than quantized inference. The SFT methods trade memory for how much of the model can change:

| SFT method                | What stays in memory                            |
| ------------------------- | ----------------------------------------------- |
| QLoRA                     | 4-bit frozen base plus trainable adapters       |
| LoRA                      | bf16 frozen base plus trainable adapters        |
| Full-parameter with FSDP2 | Sharded weights, gradients, and optimizer state |

QLoRA is the lowest-memory first experiment. Try LoRA when you want an unquantized frozen base, and use full-parameter training only when adapters are a measured capacity bottleneck.

For full-parameter bf16 training, SFT or RL, with the model sharded N ways, the parameter state per GPU starts at:

|                           | Per GPU at 30B   |
| ------------------------- | ---------------- |
| bf16 weights              | About 60 GB / N  |
| bf16 gradients            | About 60 GB / N  |
| fp32 Adam state (m and v) | About 240 GB / N |

These figures exclude activations, temporary buffers, and the generator that RL keeps loaded.

> **WARNING: Size for the second optimizer step**
>
> Size memory for the step after the first `optimizer.step()`. Adam allocates its state on the first step, so memory jumps between step 1 and step 2, and a run that looks comfortable during step 1 can fail right after.

## Supervised fine-tuning {#sft}

SFT teaches Muse Glimmer from demonstrations: a prompt and the response the model should learn to produce.

### Axolotl {#axolotl}

Fine-tune Muse Glimmer on text, single-image, and multi-image demonstrations with [Axolotl](https://github.com/axolotl-ai-cloud/axolotl). The recipe starts with QLoRA, compares it with bf16 LoRA, and uses full-parameter FSDP2 only when adapters don't provide enough capacity. It ships the configs, data preparation script, tests, and measured results.

|                      |                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------- |
| Precision            | bf16 compute; QLoRA loads the frozen base in 4-bit                                    |
| Trainer              | [Axolotl 0.19.0](https://github.com/axolotl-ai-cloud/axolotl/releases/tag/v0.19.0)    |
| Model                | `meta-models/Muse-Glimmer-30B` at revision `a4e59da52a7bc87ae7251dd5545c0dd437c44b68` |
| Hardware verified on | 8 × H100 for all methods; QLoRA also on 1 × H100                                      |
| Max VRAM observed    | 97,340 MiB per GPU, during the full FSDP2 final save                                  |
| Experiment tracking  | Weights & Biases (W\&B)                                                               |

#### Links {#axolotl-links}

- [Axolotl SFT recipe in the Muse Glimmer cookbook](https://github.com/meta-models/meta-oss-cookbook/tree/main/post-training/sft/axolotl)
- [Axolotl's Muse Glimmer model guide](https://docs.axolotl.ai/docs/models/muse-glimmer.html)
- Axolotl's upstream [QLoRA](https://github.com/axolotl-ai-cloud/axolotl/blob/v0.19.0/examples/muse-glimmer/qlora.yaml) and [vision QLoRA](https://github.com/axolotl-ai-cloud/axolotl/blob/v0.19.0/examples/muse-glimmer/qlora-vision.yaml) configs

#### Install {#axolotl-install}

Clone the cookbook and run these commands from `post-training/sft/axolotl/`, in a dedicated environment so the CUDA and compiled-extension pins don't leak into another project:

**bash**

```bash
uv venv --python 3.12 .venv
source .venv/bin/activate

export UV_TORCH_BACKEND=cu130
uv pip install "torch==2.12.1" "torchvision==0.27.1"
uv pip install "axolotl==0.19.0"
uv pip install "pytest==9.1.1" "matplotlib==3.11.2"

CUDA_HOME=/usr/local/cuda-13.0 \
CC=/usr/bin/gcc \
CXX=/usr/bin/g++ \
TORCH_CUDA_ARCH_LIST=9.0 \
  uv pip install --no-build-isolation "flash-attn==2.8.3"

CCE_REPOSITORY=https://github.com/axolotl-ai-cloud/ml-cross-entropy.git
CCE_REVISION=4dfa52212d0552805aec5a6a2176c0abbea277d2
CUDA_HOME=/usr/local/cuda-13.0 \
CC=/usr/bin/gcc \
CXX=/usr/bin/g++ \
TORCH_CUDA_ARCH_LIST=9.0 \
  uv pip install --no-build-isolation \
  "cut-cross-entropy[transformers] @ git+${CCE_REPOSITORY}@${CCE_REVISION}"

uv pip check
pytest -q tests
```

Don't install the `deepspeed` extra. The configs use FSDP2, and its optional `deepspeed-kernels` dependency has no compatible Python 3.12 wheel. Keep the CUDA toolkit, PyTorch backend, and H100 architecture settings together when you rebuild either compiled extension.

Authenticate W\&B with `wandb login` rather than putting a credential in YAML or shell history. On a disconnected training node, cache the model and dataset first, set `wandb_mode: offline` in a copy of the config, and run `wandb sync <run-directory>` from a connected host afterward.

#### Prepare your data {#axolotl-prepare-your-data}

Axolotl consumes OpenAI-style `messages`. Text content can be a string. Multimodal user content is an ordered list of typed image and text parts, with each image placed before the question it belongs to:

**JSON**

```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "image", "path": "images/page-01.png"},
        {"type": "image", "path": "images/page-02.png"},
        {"type": "text", "text": "Compare the totals on both pages."}
      ]
    },
    {"role": "assistant", "content": "The second total is 18 percent higher."}
  ]
}
```

The configs train on the `circuit` subset of [CoSyn-400K](https://huggingface.co/datasets/allenai/CoSyn-400K/tree/86e46e1fd5e754d056169f0fb38f06c6997ff7de). The preparation script emits one conversation per question and answer pair and writes a manifest with source revisions, content hashes, and data statistics:

**bash**

```bash
python scripts/prepare_dataset.py cosyn-circuit \
  --tokenizer-model meta-models/Muse-Glimmer-30B \
  --tokenizer-revision a4e59da52a7bc87ae7251dd5545c0dd437c44b68 \
  --max-tokens 4096
```

The same script prepares a text-only set from [Tulu 3 SFT Personas](https://huggingface.co/datasets/allenai/tulu-3-sft-personas-instruction-following/tree/fe0c7d350c9b4542b8d829a6f1daa1c259f0ba0e) (`tulu`) and a multi-image set from [Docmatix](https://huggingface.co/datasets/HuggingFaceM4/Docmatix/tree/0725b65616e0e5f6024be10e38ddf8d8c48664fd) (`docmatix`). Add `--max-examples-per-split 16 --output-root data/smoke` for a quick pipeline check.

> **WARNING: Put images inline, and keep packing off**
>
> Put every image inline in `messages[*].content`, not in a top-level `images` column. Axolotl 0.19.0 keeps only the first image from that column. Keep `sample_packing: false` and `eval_sample_packing: false`, because packing breaks the mapping between image tokens and pixels.

The configs set `skip_prepare_dataset: true`, so `axolotl preprocess` doesn't exercise the multimodal path. Run the processor preflight in the recipe as well as the training smoke run below.

#### Start training {#axolotl-start-training}

Three configs share the same prepared data and a global batch of 32 on eight GPUs:

| Config                             | Method                                                    | When to use                                                       |
| ---------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| `muse-glimmer-30b-qlora.yaml`      | LoRA adapters over a 4-bit frozen base                    | The first run and fast iteration                                  |
| `muse-glimmer-30b-lora-fsdp2.yaml` | LoRA adapters over a bf16 frozen base, sharded with FSDP2 | Adapters without base quantization                                |
| `muse-glimmer-30b-full-fsdp2.yaml` | Every parameter, with FSDP2 sharding the training state   | Only after an evaluation shows adapter capacity is the bottleneck |

Both adapter configs target the language projections and keep the vision tower, adapter, and projection frozen.

Start with a bounded run that crosses two optimizer steps, skips validation, and writes a checkpoint at step 2:

**bash**

```bash
CUDA_VISIBLE_DEVICES=0,1,2,3,4,5,6,7 \
  axolotl train configs/muse-glimmer-30b-qlora.yaml \
  --max-steps 2 --gradient-accumulation-steps 1 \
  --eval-strategy no --save-strategy steps --save-steps 2 \
  --launcher torchrun -- --nproc_per_node=8 --nnodes=1
```

Swap in either FSDP2 config for the other methods. The full-parameter smoke run needs about 222 GB of disk for one sharded training checkpoint plus its consolidated model. Once the smoke run passes, drop the overrides to train for the config's one epoch with validation and an epoch checkpoint.

The full-parameter path uses `adamw_torch_fused`. Avoid a bitsandbytes 8-bit optimizer with FSDP2 unless you have validated that combination for this model and Axolotl release.

#### Results {#axolotl-results}

The recipe ran five controlled one-epoch runs on eight H100s with seed 42 and a 4,096-token limit. CoSyn and Tulu used 2,048 training and 256 validation examples over 64 steps; Docmatix used 256 training and 36 validation documents over 32 steps. These are bounded slice results, not production benchmarks:

| Dataset  | Method          | Validation loss, step 0 to final | Trainer runtime | Peak MiB per GPU |
| -------- | --------------- | -------------------------------- | --------------- | ---------------- |
| CoSyn    | QLoRA           | 2.9434 to 0.8655                 | 320.4 s         | 27,011           |
| CoSyn    | bf16 LoRA FSDP2 | 2.8341 to 0.8968                 | 651.1 s         | 41,094           |
| CoSyn    | Full bf16 FSDP2 | 2.8341 to 0.8717                 | 1,105 s         | 97,340           |
| Tulu     | QLoRA           | 1.1078 to 0.7973                 | 327.2 s         | 29,401           |
| Docmatix | QLoRA           | 1.0974 to 0.7187                 | 80.81 s         | 28,052           |

Full FSDP2 reached 97,340 MiB while consolidating its final checkpoint, which leaves almost no margin on an H100. The [recipe's results](https://github.com/meta-models/meta-oss-cookbook/tree/main/post-training/sft/axolotl#controlled-quality-runs) include the W\&B runs, held-out base-versus-tuned generation metrics, and plots.

#### Use the tuned model {#axolotl-use-the-tuned-model}

Adapter runs gather a final PEFT adapter, and full-parameter training gathers the full state. To reload a QLoRA adapter through Transformers, pass `dtype=torch.bfloat16` to `from_pretrained` and set `bnb_4bit_quant_storage=torch.bfloat16` in `BitsAndBytesConfig`. Without both, the vision path loads in byte dtype.

For bf16 LoRA, keep FSDP2 `activation_checkpointing: false`. With Axolotl 0.19.0, activation checkpointing leaks wrapper names into the gathered adapter, and PEFT skips those weights on reload.

Serve the result with any runtime on [Run inference](https://dev.meta.ai/docs/muse-glimmer/deploy).

#### Troubleshooting {#axolotl-troubleshooting}

| Symptom                                | Cause                                               | Fix                                                 |
| -------------------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| Only the first page reaches the model  | Top-level image list                                | Put images inline and in order.                     |
| Image and text mismatch                | Packing or content order                            | Turn packing off and preserve order.                |
| Out of memory after step one           | Adam state allocates on the first step              | Size for step two, or shorten inputs.               |
| Only one worker starts                 | Launcher arguments in the wrong place               | Put them after `--`.                                |
| W\&B creates no run                    | No login, or the network is blocked                 | Run `wandb login`, or use offline mode.             |
| QLoRA reload has `Byte` vision tensors | Missing load dtype                                  | Use bf16 model dtype and 4-bit storage.             |
| FSDP2 LoRA reload skips trained keys   | Activation checkpointing wrappers leaked into names | Set `activation_checkpointing: false`.              |
| FSDP2 save fails                       | Version or state mismatch                           | Use the pinned versions and require a reload check. |
| DeepSpeed install fails                | Unneeded kernels                                    | Leave out the DeepSpeed extra.                      |

### TRL {#trl-sft}

Fine-tune Muse Glimmer with [TRL](https://huggingface.co/docs/trl) and [PEFT](https://huggingface.co/docs/peft) on your own labeled examples. Low-rank adaptation (LoRA) is the recommended approach: it trains a small set of adapter weights while keeping the base model frozen, reducing GPU memory requirements by an order of magnitude.

#### Choose an approach {#trl-sft-choose-an-approach}

| Method         | Relative training cost          | When to use                                           |
| -------------- | ------------------------------- | ----------------------------------------------------- |
| LoRA           | Low                             | Domain adaptation, style transfer, instruction tuning |
| QLoRA          | Low (slower steps, less memory) | Same use cases as LoRA, with a quantized base model   |
| Full fine-tune | High                            | Maximum quality when compute is not a constraint      |

#### Prepare your data {#trl-sft-prepare-data}

Format your training data as JSONL with the chat format Muse Glimmer expects:

**JSON**

```json
{"messages": [{"role": "system", "content": "You are a medical assistant."}, {"role": "user", "content": "What are the symptoms of type 2 diabetes?"}, {"role": "assistant", "content": "Common symptoms include increased thirst, frequent urination, fatigue, and blurred vision."}]}
{"messages": [{"role": "system", "content": "You are a medical assistant."}, {"role": "user", "content": "How is hypertension diagnosed?"}, {"role": "assistant", "content": "Hypertension is diagnosed by measuring blood pressure. A reading consistently at or above 130/80 mmHg indicates hypertension."}]}
```

- One conversation per line.
- Include a system prompt in every example if you want the model to follow a consistent persona.
- Aim for at least a few hundred (roughly 500+) high-quality examples for meaningful adaptation; several thousand (5,000–10,000+) for strong domain performance. Quality and consistency matter more than raw count.

> **NOTE: Train on reasoning traces**
>
> Muse Glimmer is a reasoning model. If you want it to keep reasoning on your task, include the reasoning trace in your training targets (via `reasoning_content`); if you fine-tune only on final answers, you may suppress the model's chain-of-thought. Match your training data to the behavior you want at inference.

#### LoRA fine-tuning {#trl-sft-lora}

**Python**

```python
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
from peft import LoraConfig, get_peft_model
from trl import SFTTrainer

model_name = "meta-models/Muse-Glimmer-30B"

model = AutoModelForCausalLM.from_pretrained(
    model_name,
    dtype="auto",
    device_map="auto",
)
tokenizer = AutoTokenizer.from_pretrained(model_name)

lora_config = LoraConfig(
    r=16,
    lora_alpha=32,
    target_modules=["q_proj", "v_proj", "k_proj", "o_proj"],
    lora_dropout=0.05,
    task_type="CAUSAL_LM",
)

model = get_peft_model(model, lora_config)

training_args = TrainingArguments(
    output_dir="./muse-glimmer-lora",
    num_train_epochs=3,
    per_device_train_batch_size=4,
    gradient_accumulation_steps=4,
    learning_rate=2e-4,
    bf16=True,
    logging_steps=10,
    save_strategy="epoch",
)

trainer = SFTTrainer(
    model=model,
    args=training_args,
    train_dataset=train_dataset,  # your loaded dataset
    processing_class=tokenizer,
)

trainer.train()
trainer.save_model("./muse-glimmer-lora")
```

#### QLoRA fine-tuning {#trl-sft-qlora}

QLoRA loads the base model in 4-bit precision with `bitsandbytes`, then trains LoRA adapters on top. This cuts GPU memory requirements substantially compared to standard LoRA.

**Python**

```python
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainingArguments
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from trl import SFTTrainer
import torch

model_name = "meta-models/Muse-Glimmer-30B"

bnb_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.bfloat16,
    bnb_4bit_use_double_quant=True,
)

model = AutoModelForCausalLM.from_pretrained(
    model_name, quantization_config=bnb_config, device_map="auto"
)
model = prepare_model_for_kbit_training(model)
tokenizer = AutoTokenizer.from_pretrained(model_name)

lora_config = LoraConfig(
    r=16,
    lora_alpha=32,
    target_modules=["q_proj", "v_proj", "k_proj", "o_proj"],
    lora_dropout=0.05,
    task_type="CAUSAL_LM",
)
model = get_peft_model(model, lora_config)

trainer = SFTTrainer(
    model=model,
    args=TrainingArguments(
        output_dir="./muse-glimmer-qlora",
        num_train_epochs=3,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=16,
        learning_rate=2e-4,
        bf16=True,
        logging_steps=10,
        save_strategy="epoch",
    ),
    train_dataset=train_dataset,
    processing_class=tokenizer,
)
trainer.train()
trainer.save_model("./muse-glimmer-qlora")
```

#### Hyperparameter guidance {#trl-sft-hyperparameters}

| Parameter                | Recommended range               | Notes                                                                                                           |
| ------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Learning rate            | 1e-4 – 3e-4 (LoRA or QLoRA)     | Lower for larger datasets; full fine-tunes use \~1e-5                                                           |
| LoRA rank (`r`)          | 8 – 32                          | Higher rank = more capacity, more memory                                                                        |
| LoRA alpha               | 2× rank                         | Standard scaling                                                                                                |
| Batch size               | 4 – 16 (effective)              | Use gradient accumulation to reach this                                                                         |
| Epochs                   | 2 – 5                           | Watch for overfitting on small datasets                                                                         |
| Model context window     | 128K tokens (131,072)           | Model capacity, not a recommended per-example training length                                                   |
| Training sequence length | Dataset- and hardware-dependent | Start with shorter sequences to reduce memory, and increase only after validating quality and hardware headroom |

#### Evaluate after fine-tuning {#trl-sft-evaluate}

Compare your fine-tuned model against the base model on a held-out test set before deploying. Track both your task metric and a general-capability benchmark so you catch regressions from over-fitting.

Load the base model with the adapter you trained. Swap `./muse-glimmer-lora` for `./muse-glimmer-qlora` if you took the QLoRA path, or point `from_pretrained` at the merged directory once you have run [Merge adapters](https://dev.meta.ai/docs/muse-glimmer/post-training#trl-sft-merge-adapters) below.

**Python**

```python
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

base_model = AutoModelForCausalLM.from_pretrained(
    "meta-models/Muse-Glimmer-30B",
    dtype="auto",
    device_map="auto",
)
model = PeftModel.from_pretrained(base_model, "./muse-glimmer-lora")
tokenizer = AutoTokenizer.from_pretrained("meta-models/Muse-Glimmer-30B")

correct = 0
for example in test_set:  # each has .messages (prompt) and .expected
    prompt = tokenizer.apply_chat_template(example.messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    output = model.generate(**inputs, max_new_tokens=512, do_sample=True, temperature=1.0, top_p=0.95)
    answer = tokenizer.decode(output[0][inputs.input_ids.shape[1]:], skip_special_tokens=True)
    correct += int(example.expected in answer)

print(f"accuracy: {correct / len(test_set):.1%}")
```

If your fine-tune improves the task metric but drops general capability, reduce epochs, lower the learning rate, or add more diverse data.

#### Merge adapters {#trl-sft-merge-adapters}

Merge LoRA adapters back into the base model for deployment without the PEFT library:

**Python**

```python
from peft import PeftModel
from transformers import AutoModelForCausalLM

base_model = AutoModelForCausalLM.from_pretrained(
    "meta-models/Muse-Glimmer-30B",
    dtype="auto",
    device_map="auto",
)
model = PeftModel.from_pretrained(base_model, "./muse-glimmer-lora")
merged = model.merge_and_unload()
merged.save_pretrained("./muse-glimmer-30b-merged")
```

The merged model can be served with any runtime (vLLM, llama.cpp) without adapter overhead.

## Reinforcement learning {#rl}

Reinforcement learning optimizes Muse Glimmer against a reward signal rather than fixed target outputs. Use it when you can score an output but can't fully demonstrate it: aligning to human preferences, rewarding successful tool calls, or shaping multi-step agentic behavior. Start RL from a [supervised fine-tuned](https://dev.meta.ai/docs/muse-glimmer/post-training#sft) checkpoint.

### TitanRL {#titanrl}

[TitanRL](https://github.com/pytorch/torchtitan/tree/main/torchtitan/rl) is TorchTitan's reinforcement-learning stack. It uses the same TorchTitan model definition in the trainer and its vLLM generator, so the training and serving implementations can't silently disagree.

The data-analyst recipe teaches Muse Glimmer to compute a number from a CSV or log file and write it to the file it was asked for, using GRPO with a deterministic reward. It needs no LLM judge, no labeled dataset, and no external services.

|                      |                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------- |
| Precision            | bf16                                                                                |
| Model server         | vLLM, as TitanRL's in-process generator                                             |
| Offline              | Yes, after the one-time checkpoint download                                         |
| Hardware verified on | 8 × H100 95 GB, single node                                                         |
| Max VRAM observed    | About 93 GiB of 95 GiB on the busiest trainer GPU; about 88 to 90 GiB on the others |
| Requires             | TorchTitan `main` with TitanRL (Monarch, TorchStore, vLLM, FlashAttention-3)        |

#### Links {#titanrl-links}

- [TitanRL data-analyst recipe in the Muse Glimmer cookbook](https://github.com/meta-models/meta-oss-cookbook/tree/main/post-training/rl/titanrl/data-analyst)
- [TitanRL docs](https://github.com/pytorch/torchtitan/tree/main/torchtitan/rl)
- [`search_r1`](https://github.com/pytorch/torchtitan/tree/main/torchtitan/rl/examples/search_r1), the multi-turn retrieval recipe this one is modeled on

#### Install {#titanrl-install}

Clone TorchTitan and create an environment:

**bash**

```bash
COOKBOOK=/absolute/path/to/meta-oss-cookbook
git clone https://github.com/pytorch/torchtitan.git
cd torchtitan
pip install uv
uv venv --python 3.12 glimmer-rl
source glimmer-rl/bin/activate
```

Install TorchTitan and TitanRL. Install vLLM last:

**bash**

```bash
uv pip install -r requirements.txt
uv pip install -r torchtitan/rl/requirements.txt
uv pip install --no-deps "git+https://github.com/meta-pytorch/torchstore.git@main"
uv pip install flash-attn-3 --extra-index-url=https://download.pytorch.org/whl/test/cu130
uv pip install torch torchvision vllm --pre \
  --extra-index-url https://download.pytorch.org/whl/nightly/cu130 \
  --index-strategy unsafe-best-match
```

The last command leaves out `torchcomms`, which TitanRL's quick start also lists. A single node doesn't need it, and including it makes the install fail.

Copy the recipe into the TorchTitan checkout and run its tests, which need no GPU:

**bash**

```bash
cp -R "$COOKBOOK/post-training/rl/titanrl/data-analyst/titanrl_files" \
  torchtitan/rl/examples/glimmer_data_analyst

export PYTHONPATH="$PWD:${PYTHONPATH:-}"
uv pip install pytest
pytest torchtitan/rl/examples/glimmer_data_analyst/tests/ -v
```

Download the checkpoint, around 60 GB, once:

**bash**

```bash
python scripts/download_hf_assets.py \
  --repo_id meta-models/Muse-Glimmer-30B \
  --local_dir torchtitan/rl/example_checkpoint \
  --all
```

Before each run, activate the environment, export `PYTHONPATH` (the workers Monarch spawns import from it), and run `wandb login`, or pass `--metrics.no-enable-wandb`.

#### Start training {#titanrl-start-training}

Run the 10-step smoke config first. It takes about 30 minutes on 8 × H100:

**bash**

```bash
python -m torchtitan.rl.train \
  --module torchtitan.rl.examples.glimmer_data_analyst \
  --config rl_grpo_muse_glimmer_30b_data_analyst_smoke \
  --dump-folder outputs/rl/glimmer_data_analyst_smoke
```

The full config takes about 75 minutes:

**bash**

```bash
python -m torchtitan.rl.train \
  --module torchtitan.rl.examples.glimmer_data_analyst \
  --config rl_grpo_muse_glimmer_30b_data_analyst \
  --dump-folder outputs/rl/glimmer_data_analyst
```

Plot your run and print the before-and-after numbers:

**bash**

```bash
uv pip install matplotlib
python "$COOKBOOK/post-training/rl/titanrl/data-analyst/scripts/plot_results.py" \
  outputs/rl/glimmer_data_analyst
```

The recipe uses trainer FSDP 3 × TP 2 on six GPUs and generator TP 2 on two. Muse Glimmer's two KV heads cap generator tensor parallelism at 2. A longer context, a larger microbatch, or a bigger batch needs more GPUs.

#### How the reward works {#titanrl-reward}

Each rollout is one generated task. The model gets a scratch directory with a `data.csv` or `access.log`, a question with a single numeric answer, and one tool: `bash`. Four templates (CSV sum, CSV group-by-max, log count, and log top-status) generate endless, seeded, fully offline tasks, with the golden answer computed at generation time. The reward is graded:

| Outcome                                  | Reward |
| ---------------------------------------- | ------ |
| Correct number in `answer.json`          | 1.0    |
| Well-formed file, wrong number           | 0.25   |
| File written but malformed               | 0.15   |
| At least one command ran successfully    | 0.05   |
| Nothing                                  | 0.0    |
| Each repeat of an already-failed command | −0.05  |

GRPO learns from differences between rollouts of the same prompt. If every attempt scores 0, the group has no variance and the batch is discarded. The tiers rank a partially competent attempt above one that makes no progress, while keeping a correct answer strictly on top.

#### Results {#titanrl-results}

On the public 30B checkpoint, with 8 prompts × 8 samples per step, mean rollout reward rose from 0.21 at step 1 to 0.98 at step 15. Rollouts that ran out of tokens mid-answer fell from 48% to 0%, and completed rollouts rose from 20% to 70%. Across the first and last 128 training rollouts:

|                                                   | Before | After |
| ------------------------------------------------- | ------ | ----- |
| Rollouts with the correct answer in `answer.json` | 52%    | 100%  |
| Rollouts making zero tool calls                   | 26%    | 0%    |
| Median tool calls per rollout                     | 5      | 4     |

The run stops at step 15 because the task saturates. Every rollout in a group scores 1.0, GRPO has no reward variance left, and TitanRL stops with `10 consecutive untrainable batches`. RL sampling is random, so compare the shape of your curve rather than exact values.

#### Make it yours {#titanrl-make-it-yours}

- **Swap in your own task.** Add a template to `data.py` that returns a `GlimmerDataAnalystSample`: the prompt, the input filename and contents, and the golden value. The environment, reward, and config work unchanged.
- **Make the tasks harder.** Add instances the model can't solve in one command, such as multi-step aggregations, joins across columns, or malformed rows. A difficulty curriculum keeps the reward variance GRPO needs.
- **Change what gets rewarded.** The tiers in `rubric.py` are config fields. Set `file_exists_credit=0.0` and `file_parses_credit=0.0` for a strict 0 or 1 reward, or raise `repeated_failing_command_penalty`.
- **Tune the rollout budget** in `config_registry.py`. If you widen `max_num_turns` or the generator's `max_tokens`, raise `max_rollout_tokens` and the trainer's `max_context_length` to match. A rollout that outgrows its budget ends as `truncated_prompt_too_long`, which looks like the model failing.

#### Troubleshooting {#titanrl-troubleshooting}

| Symptom                                                                             | Cause                                                                                                  | Fix                                                                                                             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `vllm==0.2.5` builds from source and fails with a CUDA version mismatch             | uv couldn't find matching nightly `torch` and `vllm` wheels, usually because `torchcomms` was included | Install `torch torchvision vllm` together without `torchcomms`.                                                 |
| ``TypeAttr `__ffi_repr__` is already registered``                                   | A package installed after vLLM upgraded `apache-tvm-ffi` past the version vLLM needs                   | Re-run the last install command so vLLM restores its dependencies.                                              |
| Out of memory in `_split_w13_on_save` during weight sync                            | Your TorchTitan checkout predates the fix                                                              | Pull the latest `main`.                                                                                         |
| The generator is silent for a few minutes on the first run                          | FlashInfer is compiling its sampling kernels                                                           | Expected once; later runs use the cache.                                                                        |
| `ModuleNotFoundError` for `grain`, `datasets`, `tyro`, `attn_gym`, or `torch_remat` | TorchTitan's own dependencies are missing                                                              | Run `uv pip install -r requirements.txt`, then re-run the last install command.                                 |
| `num_tokens_per_microbatch_per_dp_rank must be divisible by max_context_length`     | The two are set independently                                                                          | Make the microbatch budget a multiple of the context length.                                                    |
| Most rollouts end `truncated_prompt_too_long`                                       | Per-turn generation budget × turns exceeds the rollout token budget                                    | Shrink `sampling.max_tokens` or `max_num_turns`, or raise `max_rollout_tokens` and the context length together. |
| Repeated `Consecutive untrainable batches` warnings early in a run                  | Every rollout in a group scored the same                                                               | Use a graded reward, and check whether rollouts are truncated before they can succeed.                          |

### TRL {#trl-rl}

Optimize Muse Glimmer against preference pairs or a programmatic reward with [TRL](https://huggingface.co/docs/trl).

#### Choose a method {#trl-rl-choose-a-method}

| Method                                    | Reward source                          | Cost                                       | When to use                                                                             |
| ----------------------------------------- | -------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| DPO (Direct Preference Optimization)      | Preference pairs (chosen vs. rejected) | Low: offline, no reward model, no sampling | You have pairwise preference data and want alignment without standing up a reward model |
| GRPO (Group Relative Policy Optimization) | A programmatic or model-based reward   | Higher: online sampling during training    | You have a verifiable reward (unit tests pass, answer matches, tool call succeeds)      |
| PPO                                       | A trained reward model                 | Highest: reward model + online sampling    | Classic RLHF when you have (or train) a scalar reward model                             |

For most teams, **DPO is the fastest path**: it needs only preference pairs and trains offline like SFT. Use **GRPO** when your task has a checkable, programmatic reward (common for reasoning and tool-use). **PPO** is the most general reinforcement learning from human feedback (RLHF) method but needs the most infrastructure.

#### Preference optimization with DPO {#trl-rl-dpo}

DPO trains directly on preference pairs, with no separate reward model and no online sampling. Format your data as a prompt with a `chosen` and a `rejected` completion:

**JSON**

```json
{"prompt": [{"role": "user", "content": "Explain a mutex to a new engineer."}], "chosen": [{"role": "assistant", "content": "A mutex is a lock that lets only one thread into a critical section at a time..."}], "rejected": [{"role": "assistant", "content": "A mutex is when the CPU mutexes the threads."}]}
```

**Python**

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import DPOConfig, DPOTrainer

model_name = "meta-models/Muse-Glimmer-30B"

model = AutoModelForCausalLM.from_pretrained(model_name, dtype="auto")
tokenizer = AutoTokenizer.from_pretrained(model_name)

config = DPOConfig(
    output_dir="./muse-glimmer-dpo",
    beta=0.1,                 # KL penalty strength; higher = stays closer to the reference
    learning_rate=5e-7,       # DPO uses a much lower LR than SFT
    per_device_train_batch_size=2,
    gradient_accumulation_steps=8,
    num_train_epochs=1,
    bf16=True,
    logging_steps=10,
)

trainer = DPOTrainer(
    model=model,
    args=config,
    train_dataset=preference_dataset,  # your loaded dataset with prompt/chosen/rejected
    processing_class=tokenizer,
)

trainer.train()
trainer.save_model("./muse-glimmer-dpo")
```

DPO keeps a frozen reference copy of the model and penalizes the policy for drifting too far from it (the `beta` term). Start with `beta=0.1` and a learning rate around `5e-7`. RL-family objectives are far more sensitive to learning rate than SFT.

#### Online RL with a programmatic reward (GRPO) {#trl-rl-grpo}

When your task has a reward you can *compute*, such as code that passes tests, a math answer that matches, or a tool call that succeeds, GRPO optimizes against it directly. GRPO samples a group of completions per prompt and reinforces the ones that score above the group average, which removes the need for a separate value (critic) network.

**Python**

```python
from trl import GRPOConfig, GRPOTrainer

def reward_fn(completions, **kwargs):
    # Return one scalar reward per completion. Example: reward a parseable final answer.
    # Replace this example with your task's verifiable reward.
    return [1.0 if "<answer>" in c else 0.0 for c in completions]

config = GRPOConfig(
    output_dir="./muse-glimmer-grpo",
    learning_rate=1e-6,
    per_device_train_batch_size=1,
    num_generations=8,         # group size sampled per prompt
    max_completion_length=4096,  # allow room for Muse Glimmer's long reasoning traces
    bf16=True,
)

trainer = GRPOTrainer(
    model="meta-models/Muse-Glimmer-30B",  # Start from your SFT checkpoint.
    reward_funcs=reward_fn,
    args=config,
    train_dataset=prompt_dataset,  # prompts only; completions are sampled online
)

trainer.train()
```

> **NOTE: Size completion length for reasoning**
>
> Muse Glimmer generates long chain-of-thought before its final answer. Set `max_completion_length` high enough to fit the reasoning trace (Muse Glimmer's context window is 128K tokens), and design rewards that score the **final answer**, not the reasoning tokens, unless you specifically want to shape the reasoning.

#### Hyperparameter guidance {#trl-rl-hyperparameters}

| Parameter                      | DPO          | GRPO and PPO        | Notes                                                  |
| ------------------------------ | ------------ | ------------------- | ------------------------------------------------------ |
| Learning rate                  | 1e-7 – 1e-6  | 1e-6 – 3e-6         | Orders of magnitude lower than SFT                     |
| KL penalty (`beta`)            | 0.1 – 0.5    | KL coeff 0.01 – 0.1 | Higher keeps the policy closer to the reference        |
| Epochs or steps                | 1 – 2 epochs | Step-based          | RL overfits fast; watch reward and a held-out eval     |
| Group size (`num_generations`) | Not used     | 4 – 16              | Larger groups give a lower-variance advantage estimate |

#### Guard against reward hacking {#trl-rl-reward-hacking}

RL optimizes exactly what you reward, including unintended shortcuts. Protect against drift:

- **Keep a KL penalty** to the reference (SFT) model so the policy can't collapse into degenerate outputs that game the reward.
- **Hold out an eval set** the reward never sees, and track general capability on a domain benchmark alongside reward. If reward climbs while eval quality drops, the model is hacking the reward.
- **Inspect samples**, not just scalars. Read generations at each checkpoint; reward hacking is usually obvious to a human before it shows up in aggregate metrics.

#### Evaluate and deploy {#trl-rl-evaluate}

Compare the RL checkpoint against both the base and the SFT checkpoint on a held-out test set before shipping. When it wins, [merge any adapters](https://dev.meta.ai/docs/muse-glimmer/post-training#trl-sft-merge-adapters) and serve it with any [runtime](https://dev.meta.ai/docs/muse-glimmer/deploy).

## Next steps {#next-steps}

Serve the tuned model with a runtime from [Run inference](https://dev.meta.ai/docs/muse-glimmer/deploy), using the chat format in the [prompting guide](https://dev.meta.ai/docs/muse-glimmer/prompting). To convert it for local inference, see [quantization](https://dev.meta.ai/docs/muse-glimmer/quantization).
