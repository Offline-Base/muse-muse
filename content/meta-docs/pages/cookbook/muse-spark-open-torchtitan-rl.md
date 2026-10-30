# Train Muse Spark Open with reinforcement learning in TorchTitan {#train-muse-spark-open-with-reinforcement-learning-in-torchtitan}

This recipe shows how to post-train Muse Spark Open with reinforcement learning (RL) on a task whose answers can be checked automatically. It uses the RL stack of [TorchTitan](https://github.com/pytorch/torchtitan) (TitanRL), which provides a [Muse Spark Open DAPO-Math recipe](https://github.com/pytorch/torchtitan/blob/main/torchtitan_recipes/rl/dapo_math.py). The Muse Spark Open setup -- models, parallelism, trainer, generator -- is taken from that recipe unchanged; what you plug in is the task. The code is two files: [`rl.py`](https://github.com/meta-models/meta-oss-cookbook/blob/main/muse-spark/post-training/rl/torchtitan/rl.py) for the recipes and [`qa_task.py`](https://github.com/meta-models/meta-oss-cookbook/blob/main/muse-spark/post-training/rl/torchtitan/qa_task.py), a task template to copy.

This recipe is a starting point, not a tuned result. RL outcomes depend mostly on the task: which prompts, how the reward is computed, and how hard the task is for the model. The shipped task and the template show the wiring end to end; swap in your own and the rest of the recipe stays the same. What to expect to change with your task:

- **Reward spread:** GRPO learns from differences between samples of the same prompt. If every sample in a group gets the same reward, that group teaches nothing. Prompts the model sometimes solves, or graded rewards, keep the signal alive.
- **Length:** the token budget covers prompt and response together. Reasoning tasks need far more than short-answer tasks, and the budget sets the memory each step needs.

| Section                                                                                             | What it covers                                 |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| [1. The idea](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-rl#1-the-idea)           | One Muse Spark Open system, pluggable tasks    |
| [2. Install](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-rl#2-install)             | TorchTitan, the checkpoint, and this directory |
| [3. DAPO-Math](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-rl#3-dapo-math)         | The shipped task, and how to run it            |
| [4. Your own task](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-rl#4-your-own-task) | The three pieces a task is made of             |
| [5. A longer run](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-rl#5-a-longer-run)   | From the five-step bring-up to a training run  |
| [6. References](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-rl#6-references)       | Code, model, datasets, and further reading     |

## 1. The idea {#1-the-idea}

An RL recipe has two halves. The **system** is the model, how it is sharded across GPUs, the trainer, the generator that samples responses, and the loss. The **task** is what the model is trained to do. They are independent, so `rl.py` takes the system from TorchTitan once and swaps only the task:

```text
TorchTitan's Muse Spark Open recipe     system: models, parallelism, loss, generator
  with_task(config, task)
    task = Rollouter.Config(
        dataset  -> one sample per prompt           RLDataset
        env      -> sample -> conversation          MessageEnv
        reward   -> finished rollout -> score       RewardFn, inside a Rubric
    )
```

TorchTitan supplies everything around the three task pieces: sampling groups of responses, scoring them, computing group-relative advantages (GRPO), the DAPO loss, and syncing weights from the trainer to the generator. `with_task` also sets the task's token budget to the trainer's context length, so rollouts are never cut off.

## 2. Install {#2-install}

Clone TorchTitan and install it with its RL dependencies, as its [RL README](https://github.com/pytorch/torchtitan/tree/main/torchtitan/rl) describes. The Muse Spark Open recipe also needs the optional [Dist-MoE](https://github.com/meta-pytorch/dist_moe) package for its mixture-of-experts layers.

```bash
git clone https://github.com/pytorch/torchtitan && cd torchtitan
pip install -r requirements.txt -r torchtitan/rl/requirements.txt
pip install "git+https://github.com/meta-pytorch/dist_moe.git@main"
```

Download the checkpoint into TorchTitan's default assets path, or anywhere and point `MUSE_SPARK_HF_ASSETS_PATH` at it:

```bash
hf download meta-models/Muse-Spark-Open-816B-A42B --local-dir ./assets/hf/Muse-Spark-Open-816B-A42B
```

Put this directory on `PYTHONPATH` so TorchTitan can load `rl.py` as a recipe module:

```bash
export PYTHONPATH=$PYTHONPATH:/path/to/meta-oss-cookbook/muse-spark/post-training/rl/torchtitan
```

## 3. DAPO-Math {#3-dapo-math}

The shipped task is single-turn math with a binary reward:

```text
user: math problem  ->  assistant: reasoning + "Answer: \boxed{...}"  ->  reward 0 or 1
```

| Piece   | TorchTitan class                                                                                                                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dataset | `DapoMathDataset` ([DAPO-Math-17k, filtered](https://huggingface.co/datasets/hamishivi/DAPO-Math-17k-Processed_filtered)); validation `AIME2025Dataset` ([AIME 2025](https://huggingface.co/datasets/opencompass/AIME2025)) |
| Env     | `DapoMathEnv`: one user message, done after one reply                                                                                                                                                                       |
| Reward  | `RewardMathVerify`: 1 if the last `\boxed{}` matches the answer, using [Math-Verify](https://github.com/huggingface/Math-Verify)                                                                                            |

`muse_spark_dapo_math` is TorchTitan's recipe as published:

|           |                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------ |
| Algorithm | GRPO with the DAPO loss (asymmetric clip, no KL)                                                 |
| Trainer   | 256 GPUs: FSDP 64 x tensor parallel 4, experts split 4 ways; fp32 master weights, bf16 forward   |
| Generator | 16 GPUs: data parallel 4 x tensor parallel 4, experts split 16 ways; bf16, vLLM with CUDA graphs |
| Tokens    | 65,536 per rollout, up to 63,488 of them generated                                               |
| Run       | Five on-policy steps of 8 prompts x 8 samples; no validation, no checkpoint saves                |

The run is a bring-up: it confirms the trainer and generator agree before you spend a long run. [A longer run](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-rl#5-a-longer-run) shows what to change.

```bash
python -m torchtitan.rl.train --module rl --config muse_spark_dapo_math
```

Datasets download from Hugging Face. On clusters without network access, set `MUSE_SPARK_DAPO_MATH_REPO_ID` and `MUSE_SPARK_AIME2025_REPO_ID` to local copies.

## 4. Your own task {#4-your-own-task}

Copy the template and change its three pieces. Each subclasses a TorchTitan base class, so you write only what is specific to your task:

```bash
cp qa_task.py my_task.py
```

| Piece   | In `qa_task.py`                                              | Change it to                                                                              |
| ------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Sample  | `QASample(question, answer)`                                 | Whatever your env and reward need                                                         |
| Dataset | `QADataset`: reads JSONL, cycles, resumes after a checkpoint | Load your rows; keep the base class for shuffling and resume                              |
| Env     | `QAEnv`: one user message, ends after one reply              | Return tools from `init`, answer tool calls in `step`, return `done=False` for more turns |
| Reward  | `RewardExactMatch`: 1 if the reply equals the answer         | Any `async (rollout, sample) -> float`; list several in the `Rubric` with weights         |

Then run it on the Muse Spark Open system with `with_task`, as `rl.py` does for the template:

```python
def muse_spark_my_task() -> Controller.Config:
    return with_task(
        muse_spark_dapo_math(),
        my_task(train_path="/data/train.jsonl", validation_path="/data/val.jsonl"),
        dump_folder="outputs/rl/muse_spark_my_task",
    )
```

```bash
python -m torchtitan.rl.train --module rl --config muse_spark_qa   # the template, on qa_sample.jsonl
```

Tasks TorchTitan already ships plug in the same way: its alphabet-sorting (`_alphabet_sort_rollouter_config` in `torchtitan_recipes/rl/alphabet_sort.py`) and Search-R1 tool-use (`_search_r1_rollouter_config` in `torchtitan_recipes/rl/search_r1.py`) tasks are built from the same three pieces.

## 5. A longer run {#5-a-longer-run}

Start from the bring-up and change only what differs:

```python
def muse_spark_dapo_math_train() -> Controller.Config:
    config = muse_spark_dapo_math()
    config.async_loop = replace(
        config.async_loop,
        num_training_steps=150,
        target_offpolicy_steps=4,            # overlap generation and training
        validation=ValidationConfig(steps=30),
        batcher=Batcher.Config(),            # drop groups whose rewards are all equal
    )
    config.trainer.checkpointer = replace(
        config.trainer.checkpointer, load_only=False, interval=50, keep_latest_k=3
    )
    return config
```

The step count and off-policy depth follow TorchTitan's smaller DAPO-Math recipes; tune them for your task. To fit fewer GPUs, change the trainer and generator parallelism together with the token budget, which sets the memory each step needs.

## 6. References {#6-references}

**Code and model**

- TitanRL, TorchTitan's RL stack -- rollouters, environments, rubrics, and the async controller: [torchtitan/rl](https://github.com/pytorch/torchtitan/tree/main/torchtitan/rl)
- Muse Spark Open DAPO-Math recipe in TorchTitan: [torchtitan\_recipes/rl/dapo\_math.py](https://github.com/pytorch/torchtitan/blob/main/torchtitan_recipes/rl/dapo_math.py)
- The DAPO-Math task, with its smaller-model reference results: [torchtitan/rl/examples/dapo\_math](https://github.com/pytorch/torchtitan/tree/main/torchtitan/rl/examples/dapo_math)
- The released checkpoint, tokenizer, and chat template: [meta-models/Muse-Spark-Open-816B-A42B](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B)

**Methods and data**

- GRPO: Shao et al., *DeepSeekMath: Pushing the Limits of Mathematical Reasoning in Open Language Models*, 2024, [arXiv:2402.03300](https://arxiv.org/abs/2402.03300).
- DAPO: Yu et al., *DAPO: An Open-Source LLM Reinforcement Learning System at Scale*, 2025, [arXiv:2503.14476](https://arxiv.org/abs/2503.14476).
- DAPO-Math-17k: [hamishivi/DAPO-Math-17k-Processed\_filtered](https://huggingface.co/datasets/hamishivi/DAPO-Math-17k-Processed_filtered); AIME 2025: [opencompass/AIME2025](https://huggingface.co/datasets/opencompass/AIME2025) (check each dataset card for its license and terms).
