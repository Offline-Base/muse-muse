# Fine-tune Muse Spark Open with TorchTitan {#fine-tune-muse-spark-open-with-torchtitan}

This recipe shows how to run supervised fine-tuning (SFT) of Muse Spark Open on your own conversations -- first text, then images and audio. It uses [TorchTitan](https://github.com/pytorch/torchtitan), PyTorch's native training framework, which provides a [Muse Spark Open recipe](https://github.com/pytorch/torchtitan/tree/main/torchtitan_recipes/models/muse_spark.py). The SFT code is one file, [`sft.py`](https://github.com/meta-models/meta-oss-cookbook/blob/main/muse-spark/post-training/sft/torchtitan/sft.py), which you import rather than edit.

This recipe is a starting point, not a tuned result. SFT outcomes depend mostly on the data -- which conversations, how many, how clean -- so the parts you change are the dataset and, with it, the learning rate and number of steps. The public datasets here are stand-ins that show the wiring end to end; swap in your own and the rest of the recipe stays the same. What to expect to change with your data:

- **Size:** small datasets overfit fast. Watch held-out loss and stop when it flattens, even if training loss is still falling.
- **Mix:** mixing text, image, and audio conversations changes what the model gets better at; the files can be combined freely.

| Section                                                                                                          | What it covers                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [1. The idea](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-sft#1-the-idea)                       | What SFT changes in a pretraining recipe, and what it leaves alone |
| [2. Install](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-sft#2-install)                         | TorchTitan, the checkpoint, and this directory                     |
| [3. Your data](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-sft#3-your-data)                     | The one format to bring, and the public datasets used here         |
| [4. What gets trained](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-sft#4-what-gets-trained)     | Which tokens carry loss, and why                                   |
| [5. Text SFT](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-sft#5-text-sft)                       | The recipe and how to run it                                       |
| [6. Image and audio SFT](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-sft#6-image-and-audio-sft) | What a new modality swaps                                          |
| [7. Checking it works](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-sft#7-checking-it-works)     | The numbers to expect                                              |
| [8. References](https://dev.meta.ai/docs/cookbook/muse-spark-open-torchtitan-sft#8-references)                   | Code, model, datasets, and further reading                         |

## 1. The idea {#1-the-idea}

Pretraining and SFT run the same model, optimizer, parallelism, and checkpoint. Two things differ: the data is conversations instead of raw documents, and only the assistant's replies are learned. The prompt is context; training on it would teach the model to write questions.

In TorchTitan's data pipeline that is a change to two stages:

```text
source -> processor -> packing -> collator -> trainer
          ^^^^^^^^^    ^^^^^^^
          conversation -> tokens + labels; whole conversations per row
```

`sft_recipe` takes TorchTitan's Muse Spark Open recipe and swaps exactly those, plus the learning rate if you ask. Everything else is inherited, so any change in behavior comes from SFT, not from configuration drift.

## 2. Install {#2-install}

Clone TorchTitan and install it as its README describes, then the extra packages this recipe uses for media and data preparation:

```bash
git clone https://github.com/pytorch/torchtitan && cd torchtitan
pip install -r requirements.txt
pip install transformers soundfile
```

Download the checkpoint into TorchTitan's default assets path, or anywhere and point `MUSE_SPARK_HF_ASSETS_PATH` at it. The one-GPU smoke tests need only the tokenizer and chat template from it.

```bash
hf download meta-models/Muse-Spark-Open-816B-A42B --local-dir ./assets/hf/Muse-Spark-Open-816B-A42B
```

Put this directory on `PYTHONPATH` so TorchTitan can load `sft.py` as a recipe module:

```bash
export PYTHONPATH=$PYTHONPATH:/path/to/meta-oss-cookbook/muse-spark/post-training/sft/torchtitan
```

## 3. Your data {#3-your-data}

One JSON object per line, a list of chat messages. Images and audio are message parts that point at a file:

```json
{"messages": [{"role": "user", "content": "What is 2+2?"}, {"role": "assistant", "content": "4"}]}
{"messages": [{"role": "user", "content": [{"type": "image", "path": "/data/img/1.jpg"}, {"type": "text", "text": "What color is the horse?"}]}, {"role": "assistant", "content": "Brown."}]}
{"messages": [{"role": "user", "content": [{"type": "audio", "path": "/data/wav/1.wav"}, {"type": "text", "text": "Transcribe this audio."}]}, {"role": "assistant", "content": "He was in a fevered state of mind."}]}
```

Any number of turns; system prompts optional. Images can be any format PIL reads; audio is 16-bit PCM WAV, mono, any sample rate. If your rows look different, convert them once, or pass your own `messages_fn` to the processor. [`sample.jsonl`](https://github.com/meta-models/meta-oss-cookbook/blob/main/muse-spark/post-training/sft/torchtitan/sample.jsonl) holds six short conversations for a first run.

This recipe uses three public datasets. [`prepare_data.py`](https://github.com/meta-models/meta-oss-cookbook/blob/main/muse-spark/post-training/sft/torchtitan/prepare_data.py) converts each to the format above, writing images and clips to files:

| Modality | Dataset                                                                                                          | Turned into                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Text     | [`databricks/databricks-dolly-15k`](https://huggingface.co/datasets/databricks/databricks-dolly-15k)             | single-turn chats                                |
| Image    | [`HuggingFaceH4/llava-instruct-mix-vsft`](https://huggingface.co/datasets/HuggingFaceH4/llava-instruct-mix-vsft) | multi-turn chats about photos, charts, documents |
| Audio    | [`openslr/librispeech_asr`](https://huggingface.co/datasets/openslr/librispeech_asr)                             | "Transcribe this audio." chats                   |

```bash
python prepare_data.py dolly /data/dolly
python prepare_data.py llava /data/llava
python prepare_data.py librispeech /data/librispeech
```

## 4. What gets trained {#4-what-gets-trained}

Only what the model generates when it answers:

```text
<|start|>system<|message|>You are terse.<|eot|>        masked
<|start|>user<|message|>What is 2+2?<|eot|>            masked
<|start|>assistant to=user<|message|>4<|eot|>          " to=user<|message|>4<|eot|>" trains
```

The `to=user` recipient is trained -- Muse Spark chooses who it is talking to,
and that choice is part of the answer. `<|start|>assistant` is not: at inference
the prompt supplies it. Media tokens are never trained.

Text conversations are rendered by Muse Spark's renderer through TorchTitan's `ChatProcessor`, which reports exactly these tokens. The renderer is text-only, so conversations with media are rendered by the checkpoint's chat template, which marks assistant turns with Jinja `generation` blocks; `sft.py` trims that mask to the same tokens. On text conversations both paths give identical tokens and labels.

Both pin the date and reasoning effort they write into the system prompt. Otherwise the date is today's, and the tokens -- and your loss -- change daily.

## 5. Text SFT {#5-text-sft}

```python
def my_text_sft() -> Trainer.Config:
    return sft_recipe(
        _muse_spark_816b_a42b(),              # TorchTitan's Muse Spark Open recipe
        data=("/data/dolly/train.jsonl",),
        processor=ChatProcessor.Config(
            messages_fn=chat_messages,
            renderer=MuseSparkRendererConfig(current_date="2026-01-15", reasoning_effort="xhigh"),
        ),
        lr=1e-5,
    )
```

Setting `lr` moves every optimizer group together, so the router keeps training at 0.125x the base rate. Put the function in any importable module; TorchTitan loads recipes by module path and function name. `sft.py` ships it as `muse_spark_816b_a42b_sft`, reading the data path from the environment because the launcher calls recipes with no arguments. Run from the TorchTitan checkout:

```bash
# One GPU, random-weight debug model, bundled sample conversations
NGPU=1 MODULE=sft CONFIG=muse_spark_debugmodel_sft ./run_train.sh

# The full model, starting from the released weights
export MUSE_SPARK_SFT_DATA="/data/dolly/train.jsonl"
MODULE=sft CONFIG=muse_spark_816b_a42b_sft ./run_train.sh
```

The 816B recipes inherit that recipe's layout: 128 GPUs, data parallel 16 x tensor parallel 8, experts split 32 ways. Change `config.parallelism` to fit your cluster.

## 6. Image and audio SFT {#6-image-and-audio-sft}

The supervision is unchanged; what is new is media the model must see. Text stays as it was, and three things change:

|           | Text                    | Image and audio                                             |
| --------- | ----------------------- | ----------------------------------------------------------- |
| processor | `ChatProcessor`         | `MediaChatSFTProcessor`: same tokens trained, plus media    |
| packing   | `FirstFitPackingConfig` | `MMSamplePackingConfig`: media stay with their conversation |
| model     | `816B-A42B`             | `816B-A42B_mm`: adds the vision and audio encoders          |

**The one new idea.** The template writes one placeholder per media part,
`<|patch|>` or `<|audio|>`, but the encoder produces many embeddings per image or
clip, and each needs its own position. So the processor loads the media, counts the embeddings the encoder will emit, and expands the placeholder to match:

```text
rendered:  <|start|>user<|message|><|patch|>What color is the horse?<|eot|>
expanded:  <|start|>user<|message|><|image_start|><|patch|> x 60 <|image_end|>What color...
```

One `<|patch|>` per 2x2 group of 14-pixel patches; one `<|audio|>` per 1920
samples at 24 kHz. The count must match the encoder exactly, so `sft.py` reads this geometry from the model config rather than repeating it.

```python
def my_media_sft() -> Trainer.Config:
    config = _muse_spark_816b_a42b()
    config.model = build_model_config("816B-A42B_mm", parallelism=config.parallelism)
    config.model.dataset_modalities = ("vision", "audio")
    return sft_recipe(
        config,
        data=("/data/llava/train.jsonl", "/data/librispeech/train.jsonl"),
        processor=MediaChatSFTProcessor.Config(...),  # geometry from config.model
        packing=MMSamplePackingConfig,
        lr=1e-5,
    )
```

`dataset_modalities` declares what the data contains. When one GPU's batch has no image (or no audio), that encoder runs on a dummy input, so every GPU still joins the same collectives. Image, audio, and text-only conversations can share the same files.

```bash
export MUSE_SPARK_SFT_DATA="/data/llava/train.jsonl,/data/librispeech/train.jsonl"
NGPU=1 MODULE=sft CONFIG=muse_spark_debugmodel_media_sft ./run_train.sh
MODULE=sft CONFIG=muse_spark_816b_a42b_media_sft ./run_train.sh
```

The debug model caps images at 64 tokens to fit its 512-token context. Image training cannot use `--debug.deterministic`: the vision encoder's `grid_sample` has no deterministic backward on GPU, so fix the seed and compare curves instead.

**Another modality**, such as video, follows the same path: a processor that loads it and expands its placeholder, packing that keeps it with its conversation, and its modality added to `dataset_modalities`.

## 7. Checking it works {#7-checking-it-works}

On the smoke run, step-1 loss should be near `ln(202,048) = 12.2`. From the released checkpoint, starting loss on the held-out sets is about:

| Data                                    | Loss per trained token |
| --------------------------------------- | ---------------------- |
| Dolly                                   | 1.80                   |
| LLaVA (correct / mismatched image)      | 0.86 / 1.04            |
| LibriSpeech (correct / mismatched clip) | 0.40 / 2.22            |

## 8. References {#8-references}

**Code and model**

- TorchTitan, the training framework: [github.com/pytorch/torchtitan](https://github.com/pytorch/torchtitan)
- Muse Spark Open recipes in TorchTitan: [torchtitan\_recipes/models/muse\_spark.py](https://github.com/pytorch/torchtitan/tree/main/torchtitan_recipes/models/muse_spark.py)
- Muse Spark Open model code in TorchTitan, including the renderer: [torchtitan/models/muse\_spark](https://github.com/pytorch/torchtitan/tree/main/torchtitan/models/muse_spark)
- TorchTitan's data pipeline -- sources, processors, packing, collators, checkpointing and resumption: [torchtitan/components/data](https://github.com/pytorch/torchtitan/tree/main/torchtitan/components/data)
- The released checkpoint, tokenizer, and chat template: [meta-models/Muse-Spark-Open-816B-A42B](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B)
- Chat templates and the assistant-token mask (`generation` blocks, `return_assistant_tokens_mask`): [Hugging Face Transformers chat templating](https://huggingface.co/docs/transformers/en/chat_templating)

**Datasets** (check each dataset card for its license and terms)

- Dolly: Conover et al., *Free Dolly: Introducing the World's First Truly Open Instruction-Tuned LLM*, Databricks, 2023. [databricks/databricks-dolly-15k](https://huggingface.co/datasets/databricks/databricks-dolly-15k)
- LLaVA-Instruct: Liu et al., *Visual Instruction Tuning*, NeurIPS 2023, [arXiv:2304.08485](https://arxiv.org/abs/2304.08485). [HuggingFaceH4/llava-instruct-mix-vsft](https://huggingface.co/datasets/HuggingFaceH4/llava-instruct-mix-vsft)
- LibriSpeech: Panayotov et al., *Librispeech: An ASR Corpus Based on Public Domain Audio Books*, ICASSP 2015. [openslr/librispeech\_asr](https://huggingface.co/datasets/openslr/librispeech_asr)
