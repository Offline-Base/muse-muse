# Get the model {#get-the-model}

Download Muse Spark Open from Meta or Hugging Face and pick the checkpoint that matches your hardware. Everything runs offline once the weights land: there's no API key.

## Prerequisites {#prerequisites}

- Python 3.10 or later
- Transformers, to check the tokenizer: `pip install -U "transformers>=5.19"`
- Enough local disk for the checkpoint you're downloading. See [Choose a checkpoint](https://dev.meta.ai/docs/muse-spark-open/get-the-model#checkpoints) for the footprint of each.

## Choose a checkpoint {#checkpoints}

Muse Spark Open has two checkpoint formats, and each ships as its own repository with the tokenizer, chat template, and processor config:

- BF16 is the full-precision reference.
- NVFP4 stores most weights in 4-bit and keeps some layers in BF16, which cuts the weight footprint to about a third.

| Checkpoint | Repository                                                                                                          | Weight footprint | Serving recipes     |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------- |
| BF16       | [`meta-models/Muse-Spark-Open-816B-A42B`](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B)             | About 1.65 TB    | TP8/EP8 on 8 × B300 |
| NVFP4      | [`meta-models/Muse-Spark-Open-816B-A42B-NVFP4`](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B-NVFP4) | About 537 GB     | TP4/EP4 on 4 × B300 |

The weight footprint doesn't include the key-value cache, activations, or runtime overhead. The GPU count you need depends on accelerator memory, interconnect, context length, parallelism strategy, and the runtime.

## Download {#download}

Meta and Hugging Face serve the same files for each checkpoint. Download from Meta in your browser, or use the Hugging Face CLI to script the download or resume an interrupted one.

### Download from Meta {#download-from-meta}

1. Sign in and open the [Muse Spark Open download page](https://dev.meta.ai/platform/models/download/muse-spark-open).
2. Under **Choose a checkpoint**, select **BF16 checkpoint** or **NVFP4 checkpoint**.
3. Under **Licensing Terms**, select **License and Terms** and scroll to the end of the license to accept it. **Accepted** appears next to **Licensing Terms**.
4. In the **Files** list, select the download icon next to each file. Download every file in the list: the weight shards, `LICENSE.md`, and the config, tokenizer, and chat template files.
5. Save the files to one folder, such as `./muse-spark-open` for BF16 or `./muse-spark-open-nvfp4` for NVFP4. Keep the original file names. When you run the model, pass this folder path wherever a command uses the Hugging Face repository ID.

> **NOTE: Download every file**
>
> Your browser downloads each file separately: BF16 has 65 weight shards and NVFP4 has 127. A runtime can't load the checkpoint if any file is missing or renamed, so check that the folder holds every file in the list before you continue.

### Download from Hugging Face {#download-from-hugging-face}

Install the Hugging Face CLI:

**bash**

```bash
pip install -U huggingface_hub
```

The BF16 checkpoint:

**bash**

```bash
hf download meta-models/Muse-Spark-Open-816B-A42B --local-dir ./muse-spark-open
```

The NVFP4 checkpoint:

**bash**

```bash
hf download meta-models/Muse-Spark-Open-816B-A42B-NVFP4 --local-dir ./muse-spark-open-nvfp4
```

## Check the tokenizer {#tokenizer}

The repository ships the tokenizer, the chat template, `config.json`, and the processor config, so it carries everything a runtime needs to frame prompts. Load the tokenizer from the downloaded folder and render a prompt to confirm the download is usable. For the NVFP4 checkpoint, use `./muse-spark-open-nvfp4`:

**Python**

```python
from transformers import AutoTokenizer

tok = AutoTokenizer.from_pretrained("./muse-spark-open")

messages = [{"role": "user", "content": "In one sentence, what is Muse Spark good at?"}]
print(tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False))
```

Each message in the rendered prompt starts with `<|start|>` and its role, its content follows `<|message|>`, and it ends with `<|eot|>`. For how to frame requests against a running server, see the [prompting guide](https://dev.meta.ai/docs/muse-spark-open/prompting).

## Next steps {#next-steps}

With the weights downloaded, read the [prompting guide](https://dev.meta.ai/docs/muse-spark-open/prompting) to frame requests correctly, then [pick a runtime](https://dev.meta.ai/docs/muse-spark-open/deploy) and serve the model.
