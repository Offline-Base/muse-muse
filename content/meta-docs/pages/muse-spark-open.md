# Muse Spark Open {#muse-spark-open}

Muse Spark Open is the open-weight release of Muse Spark, Meta's agentic and coding model. Run it two ways:

- **Self-host:** download a checkpoint and serve it on your own GPUs with SGLang, vLLM, or another [runtime](https://dev.meta.ai/docs/muse-spark-open/deploy#self-host), so every prompt and response stays inside your infrastructure.
- **Hosted provider:** call it through a [hosted provider's](https://dev.meta.ai/docs/muse-spark-open/deploy#hosted-providers) API, with no GPUs to provision.

## Model variants {#model-variants}

| Model           | Parameters             | Architecture                                                                             | Context window   |
| --------------- | ---------------------- | ---------------------------------------------------------------------------------------- | ---------------- |
| Muse Spark Open | 816B total, 42B active | Sparse mixture of experts, multimodal (text, image, audio, and video input; text output) | 1,048,576 tokens |

## Architecture {#architecture}

Muse Spark Open is a sparse mixture-of-experts transformer with built-in perception encoders. Each token routes to a small subset of experts, so per-token compute tracks the 42B active parameters. Serving still loads the full 816B weights into VRAM, which sets the hardware footprint.

## Supported languages {#supported-languages}

Muse Spark Open was trained on data from more than 100 languages.

## Checkpoints and hardware {#checkpoints}

Muse Spark Open ships in two checkpoint formats:

- **BF16:** the full-precision reference, about 1.65 TB of weights. Serves on eight GPUs, such as 8 × B300.
- **NVFP4:** stores most weights in 4-bit and keeps some layers in BF16, about 537 GB of weights. Serves on a single 4-GPU NVIDIA Blackwell node.

Serving needs memory beyond the weights for the key-value cache, activations, and runtime overhead: budget roughly 2 TB of VRAM for BF16. [Get the model](https://dev.meta.ai/docs/muse-spark-open/get-the-model) has the download, and [Hardware platforms](https://dev.meta.ai/docs/muse-spark-open/hardware-platforms) covers the NVIDIA, AMD, and Intel configurations, with sample commands.

## License {#license}

Muse Spark Open is released under the [Muse Model License](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B/blob/main/LICENSE.md). Use is also subject to the [Acceptable Use Policy](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B/blob/main/USE_POLICY.md).

## Launch partners {#launch-partners}

The Muse Spark Open launch ecosystem includes:

- **Model catalogs:** Amazon SageMaker AI, Google Cloud Model Garden, and Microsoft Foundry Model Catalog
- **Inference platforms:** Baseten, Fireworks AI, Groq, Modal, Nebius, and Together AI
- **Tooling:** Hugging Face, llama.cpp, MLX, NVIDIA TensorRT-LLM, SGLang and RadixArk, Unsloth, and vLLM and Inferact
- **Silicon:** AMD, Apple, Intel, and NVIDIA
- **Gateway:** OpenRouter

## Get started {#get-started}

- [Get the model](https://dev.meta.ai/docs/muse-spark-open/get-the-model): Download the weights from Meta or Hugging Face and verify your setup.
- [Prompting guide](https://dev.meta.ai/docs/muse-spark-open/prompting): Examples for chat, system prompts, reasoning, tool calling, and image, video, and audio input.
- [Run inference](https://dev.meta.ai/docs/muse-spark-open/deploy): Self-host with SGLang, vLLM, or another runtime, or call a hosted provider.

## Next steps {#next-steps}

Now that you know what the open-weight release offers, [pick a checkpoint and download the weights](https://dev.meta.ai/docs/muse-spark-open/get-the-model). When you're ready to serve, [choose a runtime](https://dev.meta.ai/docs/muse-spark-open/deploy), then tune throughput and output quality with the [recommended settings](https://dev.meta.ai/docs/muse-spark-open/settings).
